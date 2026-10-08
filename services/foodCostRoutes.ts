// ============================================
// Food cost — schede tecniche, costi degli ingredienti, impostazioni
// ============================================
// Vive fuori da server.ts come l'HACCP: un dominio con le sue regole, che da
// server.ts riceve solo l'entitlement e il socket (FoodCostDeps).
//
// Il conto sta in utils/foodCost.ts ed è lo stesso del client: qui si
// caricano i dati, si validano le scritture e si impediscono i cicli fra
// semilavorati. Gli ingredienti sono i prodotti del magazzino
// (inventory_products) con le colonne di costo; chi ha foodcost:manage li
// può creare da qui anche senza inventory:full, perché nella scheda servono
// al volo.
//
// I costi sono riservati: ogni rotta vuole foodcost:view, e le letture dei
// piatti e del magazzino che arrivano a sala e cucina non li portano.

import express from 'express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { queryWithRetry, withTenant } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { RolePermissionService } from '../auth/permissionService.js';
import { isPlatformScopedSession } from '../auth/authService.js';
import {
    CicloRicettaError,
    RicettaTroppoProfondaError,
    costoPiatto,
    creaCalcolatore,
    creaCiclo,
    foodCostPct,
    isUnitaCosto,
    margineCents,
    type CostoPiatto,
    type IngredienteFc,
    type RigaFc,
    type UnitaCosto,
} from '../utils/foodCost.js';

export interface FoodCostDeps {
    /** requireFeature('food_cost') di server.ts. */
    requireFeature: express.RequestHandler;
    broadcast: (tenantId: number, event: string, data: unknown, excludeSocketId?: string) => void;
}

export interface FoodCostSettings {
    targetPct: number;
    ivaBanchettiPct: number;
    quotaBambiniPct: number;
}

export const FOOD_COST_DEFAULTS: FoodCostSettings = { targetPct: 30, ivaBanchettiPct: 10, quotaBambiniPct: 50 };

const AREE = new Set(['CUCINA', 'SALA', 'BAR']);
const RIGHE_MASSIME = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class FoodCostError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) {
        super(String(body.error));
    }
}

const fail = (res: Response, err: unknown, where: string) => {
    if (err instanceof FoodCostError) return res.status(err.status).json(err.body);
    console.error(`[food-cost] ${where}:`, err);
    return res.status(500).json({ error: 'Internal server error' });
};

const parseId = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
};

const parseNumber = (v: unknown): number | null => {
    if (v === undefined || v === null || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
};

const cleanText = (v: unknown, max: number): string | null => {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    return s ? s.slice(0, max) : null;
};

const num = (v: unknown): number | null => (v == null ? null : Number(v));

// ---- Lettura dei dati di un ristorante -----------------------------------------

interface IngredienteRow {
    id: number;
    area: string;
    nome: string;
    unita: string | null;
    categoriaId: number | null;
    categoria: string | null;
    costoCents: number | null;
    unitaCosto: UnitaCosto | null;
    resaPct: number;
    supplierId: string | null;
    fornitore: string | null;
    costoAggiornatoAt: string | null;
    isPreparazione: boolean;
    resaQuantita: number | null;
}

interface RigaRow {
    id: number;
    dishId: number | null;
    preparazioneId: number | null;
    productId: number;
    quantita: number;
    sortOrder: number;
    note: string | null;
}

interface PiattoFcRow {
    dishId: number;
    porzioni: number;
    costoManualeCents: number | null;
}

export interface DatiFoodCost {
    ingredienti: IngredienteRow[];
    righe: RigaRow[];
    piatti: PiattoFcRow[];
    impostazioni: FoodCostSettings;
}

async function leggiImpostazioni(tenantId: number): Promise<FoodCostSettings> {
    const r = await queryWithRetry(
        `SELECT target_pct, iva_banchetti_pct, quota_bambini_pct FROM food_cost_settings WHERE tenant_id = $1`,
        [tenantId],
    );
    const row = r.rows[0];
    if (!row) return { ...FOOD_COST_DEFAULTS };
    return {
        targetPct: Number(row.target_pct),
        ivaBanchettiPct: Number(row.iva_banchetti_pct),
        quotaBambiniPct: Number(row.quota_bambini_pct),
    };
}

export async function caricaDatiFoodCost(tenantId: number): Promise<DatiFoodCost> {
    const [ing, righe, piatti, impostazioni] = await Promise.all([
        queryWithRetry(
            `SELECT p.id, p.area, p.name, p.unit, p.category_id, c.name AS category_name,
                    p.costo_cents, p.unita_costo, p.resa_pct, p.supplier_id, s.name AS supplier_name,
                    p.costo_aggiornato_at, p.is_preparazione, p.resa_quantita
               FROM inventory_products p
               LEFT JOIN inventory_categories c ON c.id = p.category_id AND c.tenant_id = p.tenant_id
               LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
              WHERE p.tenant_id = $1
              ORDER BY lower(p.name), p.id`,
            [tenantId],
        ),
        queryWithRetry(
            `SELECT id, dish_id, preparazione_id, product_id, quantita, sort_order, note
               FROM food_cost_righe WHERE tenant_id = $1
              ORDER BY sort_order, id`,
            [tenantId],
        ),
        queryWithRetry(
            `SELECT dish_id, porzioni, costo_manuale_cents FROM food_cost_piatti WHERE tenant_id = $1`,
            [tenantId],
        ),
        leggiImpostazioni(tenantId),
    ]);
    return {
        ingredienti: ing.rows.map((r: any): IngredienteRow => ({
            id: r.id,
            area: r.area,
            nome: r.name,
            unita: r.unit,
            categoriaId: r.category_id,
            categoria: r.category_name,
            costoCents: num(r.costo_cents),
            unitaCosto: isUnitaCosto(r.unita_costo) ? r.unita_costo : null,
            resaPct: Number(r.resa_pct),
            supplierId: r.supplier_id,
            fornitore: r.supplier_name,
            costoAggiornatoAt: r.costo_aggiornato_at ? new Date(r.costo_aggiornato_at).toISOString() : null,
            isPreparazione: Boolean(r.is_preparazione),
            resaQuantita: num(r.resa_quantita),
        })),
        righe: righe.rows.map((r: any): RigaRow => ({
            id: r.id,
            dishId: r.dish_id,
            preparazioneId: r.preparazione_id,
            productId: r.product_id,
            quantita: Number(r.quantita),
            sortOrder: Number(r.sort_order),
            note: r.note,
        })),
        piatti: piatti.rows.map((r: any): PiattoFcRow => ({
            dishId: r.dish_id,
            porzioni: Number(r.porzioni),
            costoManualeCents: num(r.costo_manuale_cents),
        })),
        impostazioni,
    };
}

const mappaIngredienti = (dati: DatiFoodCost): Map<number, IngredienteFc> =>
    new Map(dati.ingredienti.map(i => [i.id, {
        id: i.id,
        costoCents: i.costoCents,
        unitaCosto: i.unitaCosto,
        resaPct: i.resaPct,
        isPreparazione: i.isPreparazione,
        resaQuantita: i.resaQuantita,
    }]));

const righePer = (righe: RigaRow[], chiave: 'dishId' | 'preparazioneId'): Map<number, RigaFc[]> => {
    const m = new Map<number, RigaFc[]>();
    for (const r of righe) {
        const k = r[chiave];
        if (k == null) continue;
        const list = m.get(k) ?? [];
        list.push({ productId: r.productId, quantita: r.quantita });
        m.set(k, list);
    }
    return m;
};

/** Il costo di ogni piatto che ha una scheda o un costo a mano. */
export function costiPiatti(dati: DatiFoodCost): Map<number, CostoPiatto> {
    const calc = creaCalcolatore(mappaIngredienti(dati), righePer(dati.righe, 'preparazioneId'));
    const perPiatto = righePer(dati.righe, 'dishId');
    const meta = new Map(dati.piatti.map(p => [p.dishId, p]));
    const ids = new Set<number>([...perPiatto.keys(), ...meta.keys()]);
    const out = new Map<number, CostoPiatto>();
    for (const dishId of ids) {
        const m = meta.get(dishId);
        try {
            out.set(dishId, costoPiatto(calc, perPiatto.get(dishId) ?? [], m?.porzioni ?? 1, m?.costoManualeCents ?? null));
        } catch (err) {
            // Un ciclo nei dati (il salvataggio lo impedisce) non deve far
            // cadere la pagina: il piatto risulta incompleto.
            if (err instanceof CicloRicettaError || err instanceof RicettaTroppoProfondaError) {
                out.set(dishId, { cents: null, stato: 'incompleto', mancanti: [], manuale: false });
            } else {
                throw err;
            }
        }
    }
    return out;
}

// ---- Validazione delle righe ---------------------------------------------------

interface RigaInput {
    productId: number;
    quantita: number;
    note: string | null;
}

const leggiRighe = (v: unknown): RigaInput[] => {
    if (!Array.isArray(v)) throw new FoodCostError(400, { error: 'righe deve essere una lista' });
    if (v.length > RIGHE_MASSIME) throw new FoodCostError(400, { error: `Al massimo ${RIGHE_MASSIME} righe per scheda` });
    return v.map((raw: any) => {
        const productId = parseId(raw?.productId);
        const quantita = parseNumber(raw?.quantita);
        if (!productId) throw new FoodCostError(400, { error: 'Ogni riga vuole un ingrediente' });
        if (quantita == null || quantita <= 0 || quantita > 1_000_000) {
            throw new FoodCostError(400, { error: 'Ogni riga vuole una quantità maggiore di zero', code: 'quantita' });
        }
        return { productId, quantita: Math.round(quantita * 1000) / 1000, note: cleanText(raw?.note, 200) };
    });
};

/** Tutti gli ingredienti delle righe sono di questo ristorante. */
const verificaIngredienti = async (client: PoolClient, tenantId: number, righe: RigaInput[]) => {
    const ids = [...new Set(righe.map(r => r.productId))];
    if (ids.length === 0) return;
    const r = await client.query(
        `SELECT id FROM inventory_products WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [tenantId, ids],
    );
    if (r.rowCount !== ids.length) throw new FoodCostError(400, { error: 'Ingrediente non trovato', code: 'ingrediente' });
};

const scriviRighe = async (
    client: PoolClient,
    tenantId: number,
    owner: { dishId: number } | { preparazioneId: number },
    righe: RigaInput[],
) => {
    if ('dishId' in owner) {
        await client.query(`DELETE FROM food_cost_righe WHERE tenant_id = $1 AND dish_id = $2`, [tenantId, owner.dishId]);
    } else {
        await client.query(`DELETE FROM food_cost_righe WHERE tenant_id = $1 AND preparazione_id = $2`, [tenantId, owner.preparazioneId]);
    }
    for (let i = 0; i < righe.length; i++) {
        const r = righe[i];
        await client.query(
            `INSERT INTO food_cost_righe (tenant_id, dish_id, preparazione_id, product_id, quantita, sort_order, note)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                tenantId,
                'dishId' in owner ? owner.dishId : null,
                'preparazioneId' in owner ? owner.preparazioneId : null,
                r.productId,
                r.quantita,
                i,
                r.note,
            ],
        );
    }
};

// Il nome completo nello storico dei prezzi, non l'email: «chi ha cambiato
// il prezzo del burro» si legge meglio così.
const autore = async (req: Request): Promise<{ id: number | null; name: string | null }> => {
    const id = req.user?.userId ?? null;
    const email = req.user?.email ?? null;
    if (!id) return { id: null, name: email };
    try {
        const r = await queryWithRetry('SELECT full_name FROM users WHERE id = $1', [id]);
        const full = typeof r.rows[0]?.full_name === 'string' ? r.rows[0].full_name.trim() : '';
        return { id, name: full || email };
    } catch {
        return { id, name: email };
    }
};

// ---- Router ----------------------------------------------------------------------

export function createFoodCostRouter(deps: FoodCostDeps): express.Router {
    const router = express.Router();
    const view = [authenticate, deps.requireFeature, requirePermission('foodcost:view')];
    const manage = [authenticate, deps.requireFeature, requirePermission('foodcost:manage')];

    const canManage = async (req: Request): Promise<boolean> => {
        if (!req.user) return false;
        if (isPlatformScopedSession(req.user)) return true;
        return RolePermissionService.hasPermission(req.user.tenantId, req.user.role, 'foodcost:manage');
    };

    const changed = (req: Request, what: string) => {
        try {
            const sid = req.headers['x-socket-id'];
            deps.broadcast(req.tenantId!, 'foodcost:changed', { what }, typeof sid === 'string' && sid ? sid : undefined);
        } catch (err) {
            console.warn('[food-cost] broadcast fallito:', (err as Error)?.message || err);
        }
    };

    // Tutto quello che serve alla pagina e all'editor per fare i conti da
    // soli mentre si scrive: ingredienti, righe di tutte le schede, porzioni.
    router.get('/dati', ...view, async (req, res) => {
        try {
            const dati = await caricaDatiFoodCost(req.tenantId!);
            res.json({ ...dati, canManage: await canManage(req) });
        } catch (err) {
            fail(res, err, 'GET /dati');
        }
    });

    // Costo, food cost e margine di ogni piatto, calcolati qui: li usano il
    // menu (badge) e, nelle fasi dopo, i report sul venduto.
    router.get('/piatti', ...view, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const [dati, dishes] = await Promise.all([
                caricaDatiFoodCost(tenantId),
                queryWithRetry(
                    `SELECT id, name, category, price, vat_rate, sold_by_weight, is_active, crm_enabled
                       FROM dishes WHERE tenant_id = $1 ORDER BY lower(name), id`,
                    [tenantId],
                ),
            ]);
            const costi = costiPiatti(dati);
            const piatti = dishes.rows.map((d: any) => {
                const c = costi.get(d.id) ?? { cents: null, stato: 'senza_scheda' as const, mancanti: [], manuale: false };
                const prezzo = Number(d.price) || 0;
                const iva = d.vat_rate == null ? 10 : Number(d.vat_rate);
                return {
                    id: d.id,
                    nome: d.name,
                    categoria: d.category,
                    prezzo,
                    ivaPct: iva,
                    alPeso: Boolean(d.sold_by_weight),
                    attivo: d.is_active !== false && d.crm_enabled !== false,
                    costoCents: c.cents,
                    stato: c.stato,
                    manuale: c.manuale,
                    mancanti: c.mancanti,
                    foodCostPct: foodCostPct(c.cents, prezzo, iva),
                    margineCents: margineCents(c.cents, prezzo, iva),
                };
            });
            res.json({ piatti, impostazioni: dati.impostazioni });
        } catch (err) {
            fail(res, err, 'GET /piatti');
        }
    });

    // ---- Ingredienti -------------------------------------------------------------

    // Un ingrediente nuovo dalla scheda: va nel magazzino, dove poi si
    // carica e si scarica come gli altri.
    router.post('/ingredienti', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const nome = cleanText(req.body?.nome, 255);
            if (!nome) throw new FoodCostError(400, { error: 'Serve il nome' });
            const area = req.body?.area ?? 'CUCINA';
            if (!AREE.has(area)) throw new FoodCostError(400, { error: 'Area non valida' });
            const unitaCosto = req.body?.unitaCosto;
            if (!isUnitaCosto(unitaCosto)) throw new FoodCostError(400, { error: 'Unità non valida (kg, l o pz)' });
            let costoCents: number | null = null;
            if (req.body?.costoCents != null && req.body.costoCents !== '') {
                const n = parseNumber(req.body.costoCents);
                if (n == null || n < 0 || n > 100_000_000) throw new FoodCostError(400, { error: 'Prezzo non valido' });
                costoCents = Math.round(n);
            }
            const resaPct = req.body?.resaPct == null ? 100 : parseId(req.body.resaPct);
            if (!resaPct || resaPct > 100) throw new FoodCostError(400, { error: 'La resa va da 1 a 100' });
            const isPreparazione = req.body?.isPreparazione === true;
            const chi = await autore(req);

            const creato = await withTenant(tenantId, async client => {
                const r = await client.query(
                    `INSERT INTO inventory_products (tenant_id, area, name, unit, costo_cents, unita_costo, resa_pct,
                                                     costo_aggiornato_at, is_preparazione)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $5::int IS NULL THEN NULL ELSE now() END, $8)
                     RETURNING id`,
                    [tenantId, area, nome, unitaCosto, isPreparazione ? null : costoCents, unitaCosto, resaPct, isPreparazione],
                );
                const id = r.rows[0].id as number;
                if (!isPreparazione && costoCents != null) {
                    await client.query(
                        `INSERT INTO food_cost_prezzi (tenant_id, product_id, costo_cents, unita_costo, fonte, user_id, user_name)
                         VALUES ($1, $2, $3, $4, 'MANUALE', $5, $6)`,
                        [tenantId, id, costoCents, unitaCosto, chi.id, chi.name],
                    );
                }
                return id;
            }).catch((err: any) => {
                if (err?.code === '23505') {
                    throw new FoodCostError(409, { error: 'Esiste già un prodotto con questo nome nel magazzino', code: 'duplicato' });
                }
                throw err;
            });
            const dati = await caricaDatiFoodCost(tenantId);
            changed(req, 'ingredienti');
            res.status(201).json(dati.ingredienti.find(i => i.id === creato));
        } catch (err) {
            fail(res, err, 'POST /ingredienti');
        }
    });

    router.patch('/ingredienti/:id', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FoodCostError(400, { error: 'id non valido' });
            const body = req.body ?? {};
            const chi = await autore(req);

            await withTenant(tenantId, async client => {
                const cur = await client.query(
                    `SELECT costo_cents, unita_costo, resa_pct, supplier_id, is_preparazione, resa_quantita
                       FROM inventory_products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
                    [id, tenantId],
                );
                if (cur.rowCount === 0) throw new FoodCostError(404, { error: 'Ingrediente non trovato' });
                const c = cur.rows[0];
                let costoCents: number | null = num(c.costo_cents);
                let unitaCosto: string | null = c.unita_costo;
                let resaPct: number = Number(c.resa_pct);
                let supplierId: string | null = c.supplier_id;
                let isPreparazione: boolean = Boolean(c.is_preparazione);
                let resaQuantita: number | null = num(c.resa_quantita);

                if ('costoCents' in body) {
                    if (body.costoCents === null || body.costoCents === '') costoCents = null;
                    else {
                        const n = parseNumber(body.costoCents);
                        if (n == null || n < 0 || n > 100_000_000) throw new FoodCostError(400, { error: 'Prezzo non valido' });
                        costoCents = Math.round(n);
                    }
                }
                if ('unitaCosto' in body) {
                    if (body.unitaCosto === null) unitaCosto = null;
                    else if (isUnitaCosto(body.unitaCosto)) unitaCosto = body.unitaCosto;
                    else throw new FoodCostError(400, { error: 'Unità non valida (kg, l o pz)' });
                }
                if ('resaPct' in body) {
                    const n = parseId(body.resaPct);
                    if (!n || n > 100) throw new FoodCostError(400, { error: 'La resa va da 1 a 100' });
                    resaPct = n;
                }
                if ('supplierId' in body) {
                    if (body.supplierId === null || body.supplierId === '') supplierId = null;
                    else {
                        if (typeof body.supplierId !== 'string' || !UUID_RE.test(body.supplierId)) {
                            throw new FoodCostError(400, { error: 'Fornitore non valido' });
                        }
                        const s = await client.query(`SELECT 1 FROM suppliers WHERE id = $1 AND tenant_id = $2`, [body.supplierId, tenantId]);
                        if (s.rowCount === 0) throw new FoodCostError(400, { error: 'Fornitore non trovato' });
                        supplierId = body.supplierId;
                    }
                }
                if ('isPreparazione' in body) {
                    const next = body.isPreparazione === true;
                    if (!next && isPreparazione) {
                        const usate = await client.query(
                            `SELECT 1 FROM food_cost_righe WHERE tenant_id = $1 AND preparazione_id = $2 LIMIT 1`,
                            [tenantId, id],
                        );
                        if ((usate.rowCount ?? 0) > 0) {
                            throw new FoodCostError(409, { error: 'Il semilavorato ha una ricetta: svuotala prima', code: 'ha_righe' });
                        }
                    }
                    isPreparazione = next;
                }
                if ('resaQuantita' in body) {
                    if (body.resaQuantita === null || body.resaQuantita === '') resaQuantita = null;
                    else {
                        const n = parseNumber(body.resaQuantita);
                        if (n == null || n <= 0 || n > 10_000_000) throw new FoodCostError(400, { error: 'Resa non valida' });
                        resaQuantita = Math.round(n * 1000) / 1000;
                    }
                }

                const prezzoCambiato = costoCents !== num(c.costo_cents) || unitaCosto !== c.unita_costo;
                await client.query(
                    `UPDATE inventory_products
                        SET costo_cents = $3, unita_costo = $4, resa_pct = $5, supplier_id = $6,
                            is_preparazione = $7, resa_quantita = $8,
                            costo_aggiornato_at = CASE WHEN $9 THEN now() ELSE costo_aggiornato_at END
                      WHERE id = $1 AND tenant_id = $2`,
                    [id, tenantId, costoCents, unitaCosto, resaPct, supplierId, isPreparazione, resaQuantita, prezzoCambiato],
                );
                if (prezzoCambiato && costoCents != null && unitaCosto && !isPreparazione) {
                    await client.query(
                        `INSERT INTO food_cost_prezzi (tenant_id, product_id, costo_cents, unita_costo, fonte, supplier_id, user_id, user_name)
                         VALUES ($1, $2, $3, $4, 'MANUALE', $5, $6, $7)`,
                        [tenantId, id, costoCents, unitaCosto, supplierId, chi.id, chi.name],
                    );
                }
            });
            const dati = await caricaDatiFoodCost(tenantId);
            changed(req, 'ingredienti');
            res.json(dati.ingredienti.find(i => i.id === id));
        } catch (err) {
            fail(res, err, 'PATCH /ingredienti/:id');
        }
    });

    router.get('/ingredienti/:id/prezzi', ...view, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) throw new FoodCostError(400, { error: 'id non valido' });
            const r = await queryWithRetry(
                `SELECT p.id, p.costo_cents, p.unita_costo, p.fonte, p.documento, p.user_name, p.created_at, s.name AS supplier_name
                   FROM food_cost_prezzi p
                   LEFT JOIN suppliers s ON s.id = p.supplier_id AND s.tenant_id = p.tenant_id
                  WHERE p.tenant_id = $1 AND p.product_id = $2
                  ORDER BY p.created_at DESC, p.id DESC
                  LIMIT 30`,
                [req.tenantId!, id],
            );
            res.json({
                prezzi: r.rows.map((p: any) => ({
                    id: Number(p.id),
                    costoCents: Number(p.costo_cents),
                    unitaCosto: p.unita_costo,
                    fonte: p.fonte,
                    documento: p.documento,
                    fornitore: p.supplier_name,
                    autore: p.user_name,
                    data: new Date(p.created_at).toISOString(),
                })),
            });
        } catch (err) {
            fail(res, err, 'GET /ingredienti/:id/prezzi');
        }
    });

    // ---- Schede ------------------------------------------------------------------

    router.put('/schede/piatto/:dishId', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const dishId = parseId(req.params.dishId);
            if (!dishId) throw new FoodCostError(400, { error: 'id non valido' });
            const righe = leggiRighe(req.body?.righe ?? []);
            const porzioni = req.body?.porzioni == null ? 1 : parseId(req.body.porzioni);
            if (!porzioni || porzioni > 500) throw new FoodCostError(400, { error: 'Le porzioni vanno da 1 a 500' });
            let costoManualeCents: number | null = null;
            if (req.body?.costoManualeCents != null && req.body.costoManualeCents !== '') {
                const n = parseNumber(req.body.costoManualeCents);
                if (n == null || n < 0 || n > 100_000_000) throw new FoodCostError(400, { error: 'Costo non valido' });
                costoManualeCents = Math.round(n);
            }
            const chi = await autore(req);

            await withTenant(tenantId, async client => {
                const d = await client.query(`SELECT 1 FROM dishes WHERE id = $1 AND tenant_id = $2`, [dishId, tenantId]);
                if (d.rowCount === 0) throw new FoodCostError(404, { error: 'Piatto non trovato' });
                await verificaIngredienti(client, tenantId, righe);
                await scriviRighe(client, tenantId, { dishId }, righe);
                if (righe.length === 0 && costoManualeCents == null && porzioni === 1) {
                    await client.query(`DELETE FROM food_cost_piatti WHERE dish_id = $1 AND tenant_id = $2`, [dishId, tenantId]);
                } else {
                    await client.query(
                        `INSERT INTO food_cost_piatti (dish_id, tenant_id, porzioni, costo_manuale_cents, updated_at, updated_by_user_id)
                         VALUES ($1, $2, $3, $4, now(), $5)
                         ON CONFLICT (dish_id) DO UPDATE
                            SET porzioni = EXCLUDED.porzioni,
                                costo_manuale_cents = EXCLUDED.costo_manuale_cents,
                                updated_at = now(),
                                updated_by_user_id = EXCLUDED.updated_by_user_id`,
                        [dishId, tenantId, porzioni, costoManualeCents, chi.id],
                    );
                }
            });
            const dati = await caricaDatiFoodCost(tenantId);
            changed(req, 'schede');
            res.json({
                righe: dati.righe.filter(r => r.dishId === dishId),
                piatto: dati.piatti.find(p => p.dishId === dishId) ?? { dishId, porzioni: 1, costoManualeCents: null },
                costo: costiPiatti(dati).get(dishId) ?? null,
            });
        } catch (err) {
            fail(res, err, 'PUT /schede/piatto/:dishId');
        }
    });

    router.put('/schede/preparazione/:productId', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const productId = parseId(req.params.productId);
            if (!productId) throw new FoodCostError(400, { error: 'id non valido' });
            const righe = leggiRighe(req.body?.righe ?? []);
            if (righe.some(r => r.productId === productId)) {
                throw new FoodCostError(409, { error: 'Un semilavorato non può contenere sé stesso', code: 'ciclo' });
            }
            const resaQuantita = parseNumber(req.body?.resaQuantita);
            if (resaQuantita == null || resaQuantita <= 0 || resaQuantita > 10_000_000) {
                throw new FoodCostError(400, { error: 'Serve quanto rende la ricetta', code: 'resa' });
            }
            const unitaRichiesta = req.body?.unitaCosto;
            if (unitaRichiesta != null && !isUnitaCosto(unitaRichiesta)) {
                throw new FoodCostError(400, { error: 'Unità non valida (kg, l o pz)' });
            }

            await withTenant(tenantId, async client => {
                const p = await client.query(
                    `SELECT unita_costo FROM inventory_products WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
                    [productId, tenantId],
                );
                if (p.rowCount === 0) throw new FoodCostError(404, { error: 'Semilavorato non trovato' });
                const unita = unitaRichiesta ?? p.rows[0].unita_costo;
                if (!isUnitaCosto(unita)) throw new FoodCostError(400, { error: 'Serve l\'unità del semilavorato (kg, l o pz)' });
                await verificaIngredienti(client, tenantId, righe);

                // I cicli si guardano su tutte le ricette dei semilavorati, con
                // quella nuova al posto della vecchia, dentro la transazione.
                const tutte = await client.query(
                    `SELECT preparazione_id, product_id, quantita FROM food_cost_righe
                      WHERE tenant_id = $1 AND preparazione_id IS NOT NULL AND preparazione_id <> $2`,
                    [tenantId, productId],
                );
                const mappa = new Map<number, RigaFc[]>();
                for (const r of tutte.rows) {
                    const list = mappa.get(r.preparazione_id) ?? [];
                    list.push({ productId: r.product_id, quantita: Number(r.quantita) });
                    mappa.set(r.preparazione_id, list);
                }
                if (creaCiclo(productId, righe, mappa)) {
                    throw new FoodCostError(409, { error: 'Questa ricetta finirebbe per contenere sé stessa', code: 'ciclo' });
                }

                await client.query(
                    `UPDATE inventory_products SET is_preparazione = true, resa_quantita = $3, unita_costo = $4
                      WHERE id = $1 AND tenant_id = $2`,
                    [productId, tenantId, Math.round(resaQuantita * 1000) / 1000, unita],
                );
                await scriviRighe(client, tenantId, { preparazioneId: productId }, righe);
            });

            const dati = await caricaDatiFoodCost(tenantId);
            // Il limite di profondità si controlla a scrittura fatta, sul
            // calcolatore vero: è la stessa regola che userà ogni lettura.
            try {
                creaCalcolatore(mappaIngredienti(dati), righePer(dati.righe, 'preparazioneId')).costoUnitario(productId);
            } catch (err) {
                if (err instanceof RicettaTroppoProfondaError) {
                    await withTenant(tenantId, client => scriviRighe(client, tenantId, { preparazioneId: productId }, []));
                    throw new FoodCostError(409, { error: err.message, code: 'troppo_profonda' });
                }
                throw err;
            }
            changed(req, 'schede');
            res.json({
                ingrediente: dati.ingredienti.find(i => i.id === productId),
                righe: dati.righe.filter(r => r.preparazioneId === productId),
            });
        } catch (err) {
            fail(res, err, 'PUT /schede/preparazione/:productId');
        }
    });

    // ---- Impostazioni --------------------------------------------------------------

    router.get('/impostazioni', ...view, async (req, res) => {
        try {
            res.json(await leggiImpostazioni(req.tenantId!));
        } catch (err) {
            fail(res, err, 'GET /impostazioni');
        }
    });

    router.put('/impostazioni', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const cur = await leggiImpostazioni(tenantId);
            const leggi = (k: keyof FoodCostSettings, min: number, max: number): number => {
                if (req.body?.[k] === undefined) return cur[k];
                const n = parseNumber(req.body[k]);
                if (n == null || n < min || n > max || !Number.isInteger(n)) {
                    throw new FoodCostError(400, { error: `${k} va da ${min} a ${max}` });
                }
                return n;
            };
            const next: FoodCostSettings = {
                targetPct: leggi('targetPct', 5, 90),
                ivaBanchettiPct: leggi('ivaBanchettiPct', 0, 30),
                quotaBambiniPct: leggi('quotaBambiniPct', 0, 100),
            };
            await queryWithRetry(
                `INSERT INTO food_cost_settings (tenant_id, target_pct, iva_banchetti_pct, quota_bambini_pct, updated_at)
                 VALUES ($1, $2, $3, $4, now())
                 ON CONFLICT (tenant_id) DO UPDATE
                    SET target_pct = EXCLUDED.target_pct,
                        iva_banchetti_pct = EXCLUDED.iva_banchetti_pct,
                        quota_bambini_pct = EXCLUDED.quota_bambini_pct,
                        updated_at = now()`,
                [tenantId, next.targetPct, next.ivaBanchettiPct, next.quotaBambiniPct],
            );
            changed(req, 'impostazioni');
            res.json(next);
        } catch (err) {
            fail(res, err, 'PUT /impostazioni');
        }
    });

    return router;
}
