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
import { queryWithRetry, runWithTenantContext, withTenant } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import { RolePermissionService } from '../auth/permissionService.js';
import { isPlatformScopedSession } from '../auth/authService.js';
import { isAiKeyInvalid } from '../utils/aiErrors.js';
import {
    FOOD_COST_AI_MODEL,
    FoodCostAiError,
    isFoodCostAiConfigured,
    proponiSchede,
    type EsempioScheda,
    type FoodCostAiUsage,
    type IngredienteAi,
    type RichiestaBozza,
} from './foodCostAi.js';
import {
    CicloRicettaError,
    RicettaTroppoProfondaError,
    UNITA_QUANTITA,
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
    /** Chiave Anthropic rifiutata: la risposta che spiega cosa fare (server.ts). */
    onAiKeyInvalid: (res: Response, route: string, err: unknown) => unknown;
    /** Le categorie del menu che sono carta dei vini o bar: niente ricetta da proporre. */
    categorieSenzaRicetta: (tenantId: number) => Promise<string[]>;
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
    /** L'unità che la quantità presuppone, quando l'ingrediente non ne ha ancora una. */
    unita: UnitaCosto | null;
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
        const unita = raw?.unita == null || raw.unita === '' ? null : raw.unita;
        if (unita != null && !isUnitaCosto(unita)) throw new FoodCostError(400, { error: 'Unità non valida (kg, l o pz)', code: 'unita' });
        return { productId, quantita: Math.round(quantita * 1000) / 1000, note: cleanText(raw?.note, 200), unita };
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

/** La prima scheda che usa un ingrediente senza unità gliela fissa: senza,
 *  «200» non si sa se sono grammi o pezzi (il magazzino arriva senza unità di
 *  costo, e la bozza dell'AI la propone). Un'unità diversa da quella già
 *  scritta è un errore di chi compila: non si corregge da sola. */
const fissaUnita = async (client: PoolClient, tenantId: number, righe: RigaInput[]) => {
    const volute = new Map<number, UnitaCosto>();
    for (const r of righe) {
        if (!r.unita) continue;
        const prima = volute.get(r.productId);
        if (prima && prima !== r.unita) throw new FoodCostError(400, { error: 'Lo stesso ingrediente in due unità diverse', code: 'unita' });
        volute.set(r.productId, r.unita);
    }
    if (volute.size === 0) return;
    const r = await client.query(
        `SELECT id, name, unita_costo FROM inventory_products WHERE tenant_id = $1 AND id = ANY($2::int[]) FOR UPDATE`,
        [tenantId, [...volute.keys()]],
    );
    for (const row of r.rows) {
        const voluta = volute.get(row.id)!;
        if (row.unita_costo == null) {
            await client.query(
                `UPDATE inventory_products SET unita_costo = $3 WHERE id = $1 AND tenant_id = $2 AND unita_costo IS NULL`,
                [row.id, tenantId, voluta],
            );
        } else if (row.unita_costo !== voluta) {
            throw new FoodCostError(400, { error: `«${row.name}» si conta a ${row.unita_costo}`, code: 'unita' });
        }
    }
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

// ---- Bozza con l'AI: il contesto ------------------------------------------------

const ESEMPI_MASSIMI = 5;
const INGREDIENTI_PER_AI = 2000;

const ingredientiPerAi = (dati: DatiFoodCost): IngredienteAi[] =>
    dati.ingredienti.slice(0, INGREDIENTI_PER_AI).map(i => ({
        id: i.id,
        nome: i.nome,
        area: i.area,
        unitaCosto: i.unitaCosto,
        isPreparazione: i.isPreparazione,
    }));

/** Fino a cinque schede già salvate, della stessa categoria per prime: dicono
 *  al modello le grammature della casa. Le righe con un ingrediente senza
 *  unità restano fuori, perché non si sa cosa contano. */
const esempiSchede = async (tenantId: number, dati: DatiFoodCost, categoria: string | null): Promise<EsempioScheda[]> => {
    const perPiatto = new Map<number, RigaRow[]>();
    for (const r of dati.righe) {
        if (r.dishId == null) continue;
        const list = perPiatto.get(r.dishId) ?? [];
        list.push(r);
        perPiatto.set(r.dishId, list);
    }
    if (perPiatto.size === 0) return [];
    const d = await queryWithRetry(
        `SELECT id, name, category FROM dishes WHERE tenant_id = $1 AND id = ANY($2::int[])
          ORDER BY (category IS NOT DISTINCT FROM $3) DESC, id DESC`,
        [tenantId, [...perPiatto.keys()], categoria],
    );
    const ingredienti = new Map(dati.ingredienti.map(i => [i.id, i]));
    const porzioni = new Map(dati.piatti.map(p => [p.dishId, p.porzioni]));
    const esempi: EsempioScheda[] = [];
    for (const dish of d.rows) {
        const righe = (perPiatto.get(dish.id) ?? []).flatMap(r => {
            const ing = ingredienti.get(r.productId);
            if (!ing?.unitaCosto) return [];
            return [{ ingrediente: ing.nome, quantita: r.quantita, unita: UNITA_QUANTITA[ing.unitaCosto] }];
        });
        if (righe.length === 0) continue;
        esempi.push({ nome: dish.name, categoria: dish.category ?? null, porzioni: porzioni.get(dish.id) ?? 1, righe });
        if (esempi.length >= ESEMPI_MASSIMI) break;
    }
    return esempi;
};

/** Il consumo in Consumi AI: non fa aspettare la risposta. */
const registraUsoAi = (tenantId: number, userEmail: string | null) => (u: FoodCostAiUsage) => {
    queryWithRetry(
        `INSERT INTO ai_token_usage (provider, feature, model, prompt_tokens, output_tokens, total_tokens, user_email, tenant_id)
         VALUES ('anthropic', 'food_cost_bozza', $1, $2, $3, $4, $5, $6)`,
        [u.model, u.promptTokens, u.outputTokens, u.promptTokens + u.outputTokens, userEmail, tenantId],
    ).catch(err => console.error('[food-cost] ai_token_usage (food_cost_bozza) non scritto:', err?.message || err));
};

/** La richiesta per un piatto, dalla sua riga di dishes. */
const richiestaPiatto = (dish: any, porzioni: number, componenti: string[]): RichiestaBozza => ({
    chiave: `piatto:${dish.id}`,
    tipo: 'piatto',
    nome: dish.name,
    descrizione: cleanText(dish.description, 1000),
    categoria: dish.category ?? null,
    prezzo: Number(dish.price) || 0,
    alPeso: Boolean(dish.sold_by_weight),
    porzioni,
    componenti: componenti.slice(0, 40),
});

const componentiDi = async (tenantId: number, dishIds: number[]): Promise<Map<number, string[]>> => {
    const out = new Map<number, string[]>();
    if (dishIds.length === 0) return out;
    const r = await queryWithRetry(
        `SELECT dish_id, name FROM dish_components WHERE tenant_id = $1 AND dish_id = ANY($2::int[]) ORDER BY sort_order, id`,
        [tenantId, dishIds],
    );
    for (const c of r.rows) {
        if (!c.name) continue;
        const list = out.get(c.dish_id) ?? [];
        list.push(String(c.name));
        out.set(c.dish_id, list);
    }
    return out;
};

// ---- Bozze in blocco ---------------------------------------------------------------

// Un giro non prende più di tanti piatti: un menu vero ne ha 100–150, e
// rilanciare prende quelli che mancano.
const BOZZE_MASSIME = 200;
// Piatti per chiamata: l'elenco ingredienti si paga una volta per lotto (poi
// arriva dalla cache) e la risposta resta sotto il tetto di token.
const LOTTO_BOZZE = 5;

/** I piatti da preparare: attivi, senza scheda né costo a mano, senza bozza,
 *  fuori dalle categorie di vini e bar. */
const CANDIDATI_FROM = `
      FROM dishes d
     WHERE d.tenant_id = $1 AND d.is_active AND d.crm_enabled
       AND NOT (COALESCE(d.category, '') = ANY($2::text[]))
       AND NOT EXISTS (SELECT 1 FROM food_cost_righe r WHERE r.tenant_id = $1 AND r.dish_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM food_cost_piatti p WHERE p.tenant_id = $1 AND p.dish_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM food_cost_bozze b WHERE b.tenant_id = $1 AND b.dish_id = d.id)`;

interface BozzaSalvata {
    dishId: number;
    righe: unknown[];
    avvisi: string[];
    porzioni: number;
    createdAt: string;
}

const leggiBozze = async (tenantId: number): Promise<BozzaSalvata[]> => {
    const r = await queryWithRetry(
        `SELECT dish_id, righe, avvisi, porzioni, created_at FROM food_cost_bozze WHERE tenant_id = $1 ORDER BY dish_id`,
        [tenantId],
    );
    return r.rows.map((b: any) => ({
        dishId: b.dish_id,
        righe: Array.isArray(b.righe) ? b.righe : [],
        avvisi: Array.isArray(b.avvisi) ? b.avvisi : [],
        porzioni: Number(b.porzioni) || 1,
        createdAt: new Date(b.created_at).toISOString(),
    }));
};

export interface StatoGenerazione {
    totali: number;
    fatte: number;
    errori: number;
}

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

    // Le generazioni in blocco in corso, per ristorante: una alla volta. Sta
    // in memoria perché il lavoro gira in questo processo; se il server
    // riparte a metà, le bozze fatte restano e un nuovo giro fa le altre.
    const generazioni = new Map<number, StatoGenerazione>();

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
            const tenantId = req.tenantId!;
            const dati = await caricaDatiFoodCost(tenantId);
            const puoModificare = await canManage(req);
            // Le bozze servono solo a chi può salvarle: le altre letture non le portano.
            let bozze: BozzaSalvata[] = [];
            let bozzeCandidati = 0;
            if (puoModificare) {
                const escluse = await deps.categorieSenzaRicetta(tenantId);
                const [b, c] = await Promise.all([
                    leggiBozze(tenantId),
                    queryWithRetry(`SELECT count(*)::int AS n ${CANDIDATI_FROM}`, [tenantId, escluse]),
                ]);
                bozze = b;
                bozzeCandidati = Math.min(BOZZE_MASSIME, c.rows[0]?.n ?? 0);
            }
            res.json({
                ...dati,
                canManage: puoModificare,
                aiDisponibile: puoModificare && isFoodCostAiConfigured(),
                bozze,
                bozzeCandidati,
                generazione: generazioni.get(tenantId) ?? null,
            });
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
                await fissaUnita(client, tenantId, righe);
                await scriviRighe(client, tenantId, { dishId }, righe);
                // Salvata la scheda, la bozza dell'AI ha fatto il suo lavoro.
                await client.query(`DELETE FROM food_cost_bozze WHERE tenant_id = $1 AND dish_id = $2`, [tenantId, dishId]);
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
                await fissaUnita(client, tenantId, righe);

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

    // ---- Bozza con l'AI --------------------------------------------------------------
    // Propone, non scrive: l'editor mostra le righe, lo chef le corregge e le
    // salva con le rotte delle schede qui sopra. Gli ingredienti nuovi li crea
    // lui, uno per uno, dall'editor.

    router.post('/bozza', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const piattoId = parseId(req.body?.piattoId);
            const preparazioneId = parseId(req.body?.preparazioneId);
            if (!piattoId === !preparazioneId) throw new FoodCostError(400, { error: 'Serve un piatto o un semilavorato' });
            if (!isFoodCostAiConfigured()) {
                throw new FoodCostError(503, { error: 'Bozza con l\'AI non disponibile', code: 'ai_not_configured' });
            }
            const dati = await caricaDatiFoodCost(tenantId);

            let richiesta: RichiestaBozza;
            let categoria: string | null = null;
            if (piattoId) {
                const porzioni = req.body?.porzioni == null ? 1 : parseId(req.body.porzioni);
                if (!porzioni || porzioni > 500) throw new FoodCostError(400, { error: 'Le porzioni vanno da 1 a 500' });
                const [d, comp] = await Promise.all([
                    queryWithRetry(
                        `SELECT id, name, description, category, price, sold_by_weight FROM dishes WHERE id = $1 AND tenant_id = $2`,
                        [piattoId, tenantId],
                    ),
                    componentiDi(tenantId, [piattoId]),
                ]);
                const dish = d.rows[0];
                if (!dish) throw new FoodCostError(404, { error: 'Piatto non trovato' });
                categoria = dish.category ?? null;
                richiesta = richiestaPiatto(dish, porzioni, comp.get(piattoId) ?? []);
            } else {
                const ing = dati.ingredienti.find(i => i.id === preparazioneId);
                if (!ing) throw new FoodCostError(404, { error: 'Semilavorato non trovato' });
                richiesta = { chiave: `semilavorato:${ing.id}`, tipo: 'semilavorato', productId: ing.id, nome: ing.nome, unitaCosto: ing.unitaCosto };
            }

            const bozze = await proponiSchede(
                [richiesta],
                { ingredienti: ingredientiPerAi(dati), esempi: await esempiSchede(tenantId, dati, categoria) },
                registraUsoAi(tenantId, req.user?.email ?? null),
            );
            res.json(bozze.get(richiesta.chiave) ?? {
                righe: [],
                resaQuantita: null,
                resaUnita: null,
                avvisi: ['Nessuna proposta: aggiungi una descrizione al piatto e riprova'],
            });
        } catch (err: any) {
            if (isAiKeyInvalid(err)) return deps.onAiKeyInvalid(res, 'POST /food-cost/bozza', err);
            if (err instanceof FoodCostAiError) {
                const status = err.kind === 'not_configured' ? 503 : err.kind === 'refused' ? 422 : 502;
                return res.status(status).json({
                    error: err.kind === 'not_configured' ? 'Bozza con l\'AI non disponibile' : err.message,
                    code: `ai_${err.kind}`,
                });
            }
            fail(res, err, 'POST /bozza');
        }
    });

    // ---- Bozze in blocco -------------------------------------------------------------
    // Una bozza per ogni piatto senza scheda, in sottofondo. Le bozze stanno in
    // food_cost_bozze e non contano in nessun costo finché lo chef non le apre
    // e le salva come scheda.

    const generaInSottofondo = async (
        tenantId: number,
        piatti: any[],
        stato: StatoGenerazione,
        userEmail: string | null,
    ) => {
        const avvisa = () => {
            try {
                deps.broadcast(tenantId, 'foodcost:changed', { what: 'bozze' });
            } catch (err) {
                console.warn('[food-cost] broadcast fallito:', (err as Error)?.message || err);
            }
        };
        try {
            const dati = await caricaDatiFoodCost(tenantId);
            const contesto = { ingredienti: ingredientiPerAi(dati), esempi: await esempiSchede(tenantId, dati, null) };
            const componenti = await componentiDi(tenantId, piatti.map(d => d.id));
            let modello = FOOD_COST_AI_MODEL;
            const uso = registraUsoAi(tenantId, userEmail);
            for (let i = 0; i < piatti.length; i += LOTTO_BOZZE) {
                const lotto = piatti.slice(i, i + LOTTO_BOZZE);
                try {
                    const bozze = await proponiSchede(
                        lotto.map(d => richiestaPiatto(d, 1, componenti.get(d.id) ?? [])),
                        contesto,
                        u => { modello = u.model; uso(u); },
                    );
                    await withTenant(tenantId, async client => {
                        for (const d of lotto) {
                            const b = bozze.get(`piatto:${d.id}`);
                            if (!b) continue;
                            // Nel frattempo qualcuno può aver scritto la scheda, o
                            // cancellato il piatto: allora la bozza non serve più.
                            await client.query(
                                `INSERT INTO food_cost_bozze (dish_id, tenant_id, righe, avvisi, porzioni, model)
                                 SELECT $1, $2, $3::jsonb, $4::jsonb, 1, $5
                                  WHERE EXISTS (SELECT 1 FROM dishes WHERE id = $1 AND tenant_id = $2)
                                    AND NOT EXISTS (SELECT 1 FROM food_cost_righe WHERE tenant_id = $2 AND dish_id = $1)
                                    AND NOT EXISTS (SELECT 1 FROM food_cost_piatti WHERE tenant_id = $2 AND dish_id = $1)
                                 ON CONFLICT (dish_id) DO NOTHING`,
                                [d.id, tenantId, JSON.stringify(b.righe), JSON.stringify(b.avvisi), modello.slice(0, 64)],
                            );
                        }
                    });
                } catch (err) {
                    stato.errori += lotto.length;
                    console.error('[food-cost] bozze in blocco, lotto fallito:', (err as Error)?.message || err);
                    // Senza chiave buona i lotti dopo fallirebbero uguali: ci si ferma.
                    if (isAiKeyInvalid(err) || (err instanceof FoodCostAiError && err.kind === 'not_configured')) break;
                }
                stato.fatte = Math.min(stato.totali, stato.fatte + lotto.length);
                avvisa();
            }
        } catch (err) {
            console.error('[food-cost] bozze in blocco interrotte:', (err as Error)?.message || err);
        } finally {
            generazioni.delete(tenantId);
            avvisa();
        }
    };

    router.post('/bozze/genera', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            if (!isFoodCostAiConfigured()) {
                throw new FoodCostError(503, { error: 'Bozze con l\'AI non disponibili', code: 'ai_not_configured' });
            }
            const inCorso = generazioni.get(tenantId);
            if (inCorso) throw new FoodCostError(409, { error: 'Le bozze sono già in preparazione', code: 'in_corso', ...inCorso });
            const escluse = await deps.categorieSenzaRicetta(tenantId);
            const r = await queryWithRetry(
                `SELECT d.id, d.name, d.description, d.category, d.price, d.sold_by_weight ${CANDIDATI_FROM}
                  ORDER BY d.category NULLS LAST, d.name, d.id
                  LIMIT ${BOZZE_MASSIME}`,
                [tenantId, escluse],
            );
            if (r.rows.length === 0) return res.json({ daPreparare: 0 });
            // Il blocco si prende prima di rispondere: due tocchi ravvicinati
            // non fanno partire due giri.
            const stato: StatoGenerazione = { totali: r.rows.length, fatte: 0, errori: 0 };
            generazioni.set(tenantId, stato);
            res.status(202).json({ daPreparare: r.rows.length });
            const userEmail = req.user?.email ?? null;
            void runWithTenantContext(tenantId, () => generaInSottofondo(tenantId, r.rows, stato, userEmail));
        } catch (err) {
            fail(res, err, 'POST /bozze/genera');
        }
    });

    router.delete('/bozze/:dishId', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const dishId = parseId(req.params.dishId);
            if (!dishId) throw new FoodCostError(400, { error: 'id non valido' });
            await withTenant(tenantId, client =>
                client.query(`DELETE FROM food_cost_bozze WHERE tenant_id = $1 AND dish_id = $2`, [tenantId, dishId]));
            changed(req, 'bozze');
            res.status(204).end();
        } catch (err) {
            fail(res, err, 'DELETE /bozze/:dishId');
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
