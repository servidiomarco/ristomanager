// ============================================
// Fatture fornitori — dall'XML al carico del magazzino
// ============================================
// Vive fuori da server.ts come il food cost: da server.ts riceve solo il
// socket, l'entitlement del food cost e le due cose del magazzino che stanno
// là (la P.IVA del locale, la chiusura delle push «scorta bassa»).
//
// Il giro: si carica un file (XML, p7m o zip) → ogni fattura entra «da
// controllare» con le righe già classificate (utils/fatturaPa.ts) e, dove il
// fornitore e l'articolo sono già noti, già abbinate a un prodotto dalla
// memoria → qualcuno decide le righe nuove (prodotto e confezione, oppure
// «ignora» con una categoria di spesa) → «Carica in magazzino» scrive i
// movimenti, i prezzi del food cost (se il locale ce l'ha) e la memoria, in
// una transazione sola.
//
// Le fatture portano i prezzi d'acquisto: tutte le rotte vogliono
// inventory:invoices, che la cucina non ha anche se carica e scarica.

import express from 'express';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { createHash } from 'node:crypto';
import { queryWithRetry, withTenant } from '../db.js';
import { authenticate, requirePermission } from '../auth/authMiddleware.js';
import {
    FatturaPaError,
    apriFile,
    chiaveArticolo,
    estraiAllegato,
    leggiFatture,
    normalizzaDescrizione,
    type FpFattura,
    type TipoChiave,
} from '../utils/fatturaPa.js';
import { fornitoreSimile } from '../utils/fornitoreSimile.js';

export interface FattureFornitoriDeps {
    broadcast: (tenantId: number, event: string, data: unknown, excludeSocketId?: string) => void;
    /** Il food cost è acceso per il locale: solo allora il carico aggiorna i prezzi. */
    foodCostAttivo: (tenantId: number) => Promise<boolean>;
    /** La P.IVA del locale (Impostazioni › Fiscalità), '' se non c'è. */
    partitaIvaLocale: (tenantId: number) => Promise<string>;
    /** Dopo un carico: le scorte risalite sopra soglia chiudono la loro push. */
    dopoCarico: (tenantId: number, variazioni: { productId: number; prima: number; dopo: number }[]) => Promise<void>;
}

export const CATEGORIE_SPESA = ['cibo', 'bevande', 'pulizia', 'monouso', 'personale', 'servizi', 'altro'] as const;
export type CategoriaSpesa = (typeof CATEGORIE_SPESA)[number];

const UNITA_COSTO = new Set(['kg', 'l', 'pz']);
const AREE = ['CUCINA', 'SALA', 'BAR'] as const;
const UPLOAD_MASSIMO = '40mb';
const FATTORE_MASSIMO = 100_000;

class FattureError extends Error {
    constructor(public status: number, public body: Record<string, unknown>) {
        super(String(body.error));
    }
}

const fail = (res: Response, err: unknown, where: string) => {
    if (err instanceof FattureError) return res.status(err.status).json(err.body);
    if (err instanceof FatturaPaError) return res.status(422).json({ error: err.message, code: 'fattura_illeggibile' });
    console.error(`[fatture-fornitori] ${where}:`, err);
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

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const cents = (euro: number | null): number | null => (euro == null ? null : Math.round(euro * 100));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const autore = async (req: Request): Promise<string | null> => {
    const id = req.user?.userId ?? null;
    const email = req.user?.email ?? null;
    if (!id) return email;
    try {
        const r = await queryWithRetry('SELECT full_name FROM users WHERE id = $1', [id]);
        const full = typeof r.rows[0]?.full_name === 'string' ? r.rows[0].full_name.trim() : '';
        return full || email;
    } catch {
        return email;
    }
};

/** Il fornitore come chiave: la P.IVA, o il codice fiscale, o il nome. */
export function chiaveFornitore(f: Pick<FpFattura, 'cedente'>): string {
    if (f.cedente.piva) return f.cedente.piva.toUpperCase().slice(0, 60);
    if (f.cedente.codiceFiscale) return `CF:${f.cedente.codiceFiscale.toUpperCase()}`.slice(0, 60);
    return `NOME:${normalizzaDescrizione(f.cedente.denominazione)}`.slice(0, 60);
}

const dataItaliana = (iso: string): string => {
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
};

/** «Fattura 4014 del 30/09/2026»: la nota del movimento e il documento del prezzo. */
const nomeDocumento = (f: { tipo_documento: string; numero: string; data: string }): string =>
    `${f.tipo_documento === 'TD04' ? 'Nota di credito' : 'Fattura'} ${f.numero} del ${dataItaliana(f.data)}`;

// ---- Lettura -----------------------------------------------------------------

interface RigaDb {
    id: number;
    numero_linea: number;
    tipo: string;
    descrizione: string;
    ean: string | null;
    codice: string | null;
    chiave_tipo: TipoChiave | null;
    chiave: string | null;
    quantita: string | null;
    unita_misura: string | null;
    prezzo_unitario: string;
    prezzo_totale: string;
    aliquota_iva: string;
    lotto: string | null;
    scadenza: string | null;
    ddt: string | null;
    esito: 'CARICO' | 'IGNORA' | null;
    da_memoria: boolean;
    product_id: number | null;
    fattore_magazzino: string | null;
    fattore_costo: string | null;
    unita_costo: string | null;
    categoria_spesa: string | null;
    movimento_id: number | null;
    prezzo_id: string | null;
    p_name: string | null;
    p_area: string | null;
    p_unit: string | null;
    p_costo_cents: number | null;
    p_unita_costo: string | null;
    p_is_preparazione: boolean | null;
}

const rigaJson = (r: RigaDb) => {
    const quantita = num(r.quantita);
    const prezzoTotale = Number(r.prezzo_totale);
    const fattoreCosto = num(r.fattore_costo);
    const fattoreMagazzino = num(r.fattore_magazzino);
    // Il prezzo per kg, litro o pezzo che questa riga porterebbe nel food cost.
    const costoCents = quantita && quantita > 0 && fattoreCosto && prezzoTotale > 0
        ? Math.round((prezzoTotale * 100) / (quantita * fattoreCosto))
        : null;
    return {
        id: r.id,
        numeroLinea: r.numero_linea,
        tipo: r.tipo,
        descrizione: r.descrizione,
        ean: r.ean,
        codice: r.codice,
        quantita,
        unitaMisura: r.unita_misura,
        prezzoUnitario: Number(r.prezzo_unitario),
        prezzoTotale,
        aliquotaIva: Number(r.aliquota_iva),
        lotto: r.lotto,
        scadenza: r.scadenza,
        ddt: r.ddt,
        esito: r.esito,
        daMemoria: r.da_memoria,
        productId: r.product_id,
        prodotto: r.product_id && r.p_name
            ? {
                id: r.product_id,
                nome: r.p_name,
                area: r.p_area,
                unita: r.p_unit,
                costoCents: r.p_costo_cents,
                unitaCosto: r.p_unita_costo,
                isPreparazione: Boolean(r.p_is_preparazione),
            }
            : null,
        fattoreMagazzino,
        fattoreCosto,
        unitaCosto: r.unita_costo,
        categoriaSpesa: r.categoria_spesa,
        quantitaMagazzino: quantita && fattoreMagazzino ? Math.round(quantita * fattoreMagazzino * 1000) / 1000 : null,
        costoCents,
        caricata: r.movimento_id != null,
        prezzoAggiornato: r.prezzo_id != null,
    };
};

const RIGHE_SQL = `
    SELECT r.*, p.name AS p_name, p.area AS p_area, p.unit AS p_unit, p.costo_cents AS p_costo_cents,
           p.unita_costo AS p_unita_costo, p.is_preparazione AS p_is_preparazione
      FROM fatture_fornitori_righe r
      LEFT JOIN inventory_products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1 AND r.fattura_id = $2
     ORDER BY r.numero_linea, r.id`;

const TESTATA_SQL = `
    SELECT f.*, s.name AS supplier_name,
           (SELECT count(*)::int FROM fatture_fornitori_righe r WHERE r.fattura_id = f.id AND r.tipo = 'merce') AS righe_merce,
           (SELECT count(*)::int FROM fatture_fornitori_righe r WHERE r.fattura_id = f.id AND r.tipo = 'merce' AND r.esito IS NULL) AS righe_da_decidere
      FROM fatture_fornitori f
      LEFT JOIN suppliers s ON s.id = f.supplier_id AND s.tenant_id = f.tenant_id`;

const testataJson = (f: any) => ({
    id: f.id as number,
    fornitore: {
        nome: f.cedente_nome as string,
        piva: f.cedente_piva as string | null,
        supplierId: f.supplier_id as string | null,
        supplierNome: f.supplier_name as string | null,
    },
    tipoDocumento: f.tipo_documento as string,
    notaDiCredito: f.tipo_documento === 'TD04',
    numero: f.numero as string,
    data: f.data as string,
    totaleCents: f.importo_totale_cents as number | null,
    imponibileCents: f.imponibile_cents as number,
    impostaCents: f.imposta_cents as number,
    stato: f.stato as 'DA_CONTROLLARE' | 'CARICATA' | 'IGNORATA',
    origine: f.origine as 'UPLOAD' | 'EMAIL',
    righeMerce: f.righe_merce as number,
    righeDaDecidere: f.righe_da_decidere as number,
    caricataAt: f.caricata_at ? new Date(f.caricata_at).toISOString() : null,
    caricataDa: f.caricata_da as string | null,
    createdAt: new Date(f.created_at).toISOString(),
});

// ---- Memoria degli abbinamenti -------------------------------------------------

interface Memoria {
    chiave_tipo: TipoChiave;
    chiave: string;
    azione: 'CARICO' | 'IGNORA';
    product_id: number | null;
    fattore_magazzino: string | null;
    fattore_costo: string | null;
    unita_costo: string | null;
    categoria_spesa: string | null;
}

/** Le chiavi con cui una riga si può riconoscere, dalla più sicura. */
const chiaviRiga = (r: { ean: string | null; codice: string | null; descrizione: string }): { tipo: TipoChiave; valore: string }[] => {
    const out: { tipo: TipoChiave; valore: string }[] = [];
    if (r.ean) out.push({ tipo: 'ean', valore: r.ean });
    if (r.codice) out.push({ tipo: 'codice', valore: r.codice.toUpperCase().slice(0, 100) });
    const d = normalizzaDescrizione(r.descrizione);
    if (d) out.push({ tipo: 'descrizione', valore: d });
    return out;
};

const trovaInMemoria = (memoria: Map<string, Memoria>, r: { ean: string | null; codice: string | null; descrizione: string }): Memoria | null => {
    for (const k of chiaviRiga(r)) {
        const m = memoria.get(`${k.tipo}|${k.valore}`);
        if (m) return m;
    }
    return null;
};

async function leggiMemoria(client: PoolClient, tenantId: number, chiaveFornitoreValore: string): Promise<Map<string, Memoria>> {
    const r = await client.query(
        `SELECT m.chiave_tipo, m.chiave, m.azione, m.product_id, m.fattore_magazzino, m.fattore_costo, m.unita_costo, m.categoria_spesa
           FROM fornitori_articoli m
          WHERE m.tenant_id = $1 AND m.chiave_fornitore = $2
            AND (m.product_id IS NULL OR EXISTS (SELECT 1 FROM inventory_products p WHERE p.id = m.product_id AND p.tenant_id = m.tenant_id))`,
        [tenantId, chiaveFornitoreValore],
    );
    const map = new Map<string, Memoria>();
    for (const m of r.rows as Memoria[]) map.set(`${m.chiave_tipo}|${m.chiave}`, m);
    return map;
}

// ---- Ingresso di un file ---------------------------------------------------------

export interface EsitoFile {
    file: string;
    esito: 'nuova' | 'doppione' | 'scartato';
    motivo?: string;
    id?: number;
    fornitore?: string;
    numero?: string;
    data?: string;
    /** Righe di merce già riconosciute dalla memoria, su quante. */
    riconosciute?: number;
    righeMerce?: number;
}

/**
 * Salva le fatture di un file già aperto: il file una volta sola, ogni
 * fattura una volta sola, le righe con la memoria applicata. Lo usano
 * l'upload e (dopo) la casella email.
 */
export async function importaXml(
    tenantId: number,
    nomeFile: string,
    xml: string,
    origine: 'UPLOAD' | 'EMAIL',
    creatoDa: string | null,
): Promise<EsitoFile[]> {
    let documenti: FpFattura[];
    try {
        documenti = leggiFatture(xml);
    } catch (err) {
        if (err instanceof FatturaPaError) return [{ file: nomeFile, esito: 'scartato', motivo: err.message }];
        throw err;
    }
    const sha = createHash('sha256').update(xml).digest('hex');

    return withTenant(tenantId, async client => {
        const esiti: EsitoFile[] = [];
        const file = await client.query(
            `INSERT INTO fatture_fornitori_file (tenant_id, nome, sha256, xml)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, sha256) DO UPDATE SET nome = fatture_fornitori_file.nome
             RETURNING id`,
            [tenantId, nomeFile.slice(0, 255), sha, xml],
        );
        const fileId = file.rows[0].id as number;
        const fornitori = (await client.query(`SELECT id, name, vat_number FROM suppliers WHERE tenant_id = $1`, [tenantId])).rows as {
            id: string; name: string; vat_number: string | null;
        }[];

        for (const doc of documenti) {
            const chiave = chiaveFornitore(doc);
            const base = { file: nomeFile, fornitore: doc.cedente.denominazione, numero: doc.numero, data: doc.data };
            const esiste = await client.query(
                `SELECT id FROM fatture_fornitori
                  WHERE tenant_id = $1 AND chiave_fornitore = $2 AND tipo_documento = $3 AND numero = $4 AND data = $5`,
                [tenantId, chiave, doc.tipoDocumento, doc.numero, doc.data],
            );
            if ((esiste.rowCount ?? 0) > 0) {
                esiti.push({ ...base, esito: 'doppione', id: esiste.rows[0].id });
                continue;
            }
            const supplier = doc.cedente.piva
                ? fornitori.find(s => s.vat_number && s.vat_number.toUpperCase() === doc.cedente.piva!.toUpperCase()) ?? null
                : null;
            const dati = {
                codiceDestinatario: doc.codiceDestinatario,
                cessionario: doc.cessionario,
                causale: doc.causale,
                divisa: doc.divisa,
                ddt: doc.ddt,
                riepilogo: doc.riepilogo,
                pagamenti: doc.pagamenti,
                allegati: doc.allegati,
            };
            const testata = await client.query(
                `INSERT INTO fatture_fornitori (tenant_id, file_id, indice_body, supplier_id, chiave_fornitore, cedente_piva,
                                                cedente_nome, cedente, tipo_documento, numero, data, importo_totale_cents,
                                                imponibile_cents, imposta_cents, dati, origine, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                 RETURNING id`,
                [
                    tenantId, fileId, doc.indiceBody, supplier?.id ?? null, chiave, doc.cedente.piva,
                    doc.cedente.denominazione.slice(0, 255), JSON.stringify(doc.cedente), doc.tipoDocumento,
                    doc.numero.slice(0, 40), doc.data, cents(doc.importoTotale), cents(doc.imponibile) ?? 0,
                    cents(doc.imposta) ?? 0, JSON.stringify(dati), origine, creatoDa,
                ],
            );
            const fatturaId = testata.rows[0].id as number;

            // Le note di credito non caricano merce: niente memoria da applicare.
            const memoria = doc.notaDiCredito ? new Map<string, Memoria>() : await leggiMemoria(client, tenantId, chiave);
            let riconosciute = 0;
            let righeMerce = 0;
            for (const r of doc.righe) {
                const k = chiaveArticolo(r);
                const m = r.tipo === 'merce' ? trovaInMemoria(memoria, r) : null;
                if (r.tipo === 'merce') righeMerce++;
                if (m) riconosciute++;
                await client.query(
                    `INSERT INTO fatture_fornitori_righe (tenant_id, fattura_id, numero_linea, tipo, descrizione, ean, codice,
                                                          chiave_tipo, chiave, quantita, unita_misura, prezzo_unitario,
                                                          prezzo_totale, aliquota_iva, lotto, scadenza, ddt, esito, da_memoria,
                                                          product_id, fattore_magazzino, fattore_costo, unita_costo, categoria_spesa)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)`,
                    [
                        tenantId, fatturaId, r.numero, r.tipo, r.descrizione, r.ean, r.codice?.slice(0, 100) ?? null,
                        k?.tipo ?? null, k?.valore ?? null, r.quantita, r.unitaMisura?.slice(0, 20) ?? null, r.prezzoUnitario,
                        r.prezzoTotale, r.aliquotaIva, r.lotto?.slice(0, 100) ?? null, r.scadenza?.slice(0, 30) ?? null,
                        r.ddt?.slice(0, 40) ?? null,
                        m?.azione ?? null, m != null, m?.product_id ?? null, m?.fattore_magazzino ?? null,
                        m?.fattore_costo ?? null, m?.unita_costo ?? null, m?.categoria_spesa ?? null,
                    ],
                );
            }
            esiti.push({ ...base, esito: 'nuova', id: fatturaId, riconosciute, righeMerce });
        }
        return esiti;
    });
}

// ---- Router ------------------------------------------------------------------

export function createFattureFornitoriRouter(deps: FattureFornitoriDeps): express.Router {
    const router = express.Router();
    const guard = [authenticate, requirePermission('inventory:invoices')];

    const changed = (req: Request, what: string, id?: number) => {
        try {
            const sid = req.headers['x-socket-id'];
            deps.broadcast(req.tenantId!, 'fatture:changed', { what, id }, typeof sid === 'string' && sid ? sid : undefined);
        } catch (err) {
            console.warn('[fatture-fornitori] broadcast fallito:', (err as Error)?.message || err);
        }
    };

    const leggiTestata = async (tenantId: number, id: number) => {
        const r = await queryWithRetry(`${TESTATA_SQL} WHERE f.tenant_id = $1 AND f.id = $2`, [tenantId, id]);
        if (r.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
        return r.rows[0];
    };

    const dettaglio = async (tenantId: number, id: number) => {
        const f = await leggiTestata(tenantId, id);
        const [righe, fornitori, ivaLocale] = await Promise.all([
            queryWithRetry(RIGHE_SQL, [tenantId, id]),
            f.supplier_id ? Promise.resolve({ rows: [] as { id: string; name: string }[] })
                : queryWithRetry(`SELECT id, name FROM suppliers WHERE tenant_id = $1`, [tenantId]),
            deps.partitaIvaLocale(tenantId).catch(() => ''),
        ]);
        const foodCost = await deps.foodCostAttivo(tenantId).catch(() => false);
        const unita = foodCost
            ? await queryWithRetry(`SELECT id, unita_costo FROM inventory_products WHERE tenant_id = $1 AND unita_costo IS NOT NULL`, [tenantId])
            : { rows: [] as any[] };
        const dati = f.dati ?? {};
        const suggerito = f.supplier_id ? null : fornitoreSimile(f.cedente_nome, fornitori.rows as { id: string; name: string }[]);
        const ivaCessionario = String(dati.cessionario?.piva ?? '').toUpperCase();
        const ivaMia = ivaLocale.replace(/\s+/g, '').toUpperCase().replace(/^IT/, '');
        return {
            ...testataJson(f),
            cedente: f.cedente ?? {},
            cessionario: dati.cessionario ?? null,
            // La fattura è intestata a un'altra partita IVA: si dice, non si blocca.
            altroDestinatario: Boolean(ivaMia && ivaCessionario && ivaCessionario.replace(/^IT/, '') !== ivaMia),
            causale: dati.causale ?? null,
            ddt: dati.ddt ?? [],
            riepilogo: dati.riepilogo ?? [],
            pagamenti: dati.pagamenti ?? [],
            allegati: (dati.allegati ?? []).map((a: any) => ({ indice: a.indice, nome: a.nome, formato: a.formato, bytes: a.bytes })),
            fornitoreSuggerito: suggerito ? { id: suggerito.id, nome: suggerito.name } : null,
            foodCost,
            // Con che unità il food cost paga ogni prodotto: chi abbina una riga
            // nuova vede subito se il prezzo della fattura ci può andare.
            unitaCostoProdotti: Object.fromEntries(unita.rows.map((p: any) => [p.id, p.unita_costo])),
            righe: (righe.rows as RigaDb[]).map(rigaJson),
        };
    };

    // ---- Elenco --------------------------------------------------------------

    router.get('/', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const stato = typeof req.query.stato === 'string' ? req.query.stato : '';
            const params: unknown[] = [tenantId];
            let where = 'WHERE f.tenant_id = $1';
            if (stato === 'DA_CONTROLLARE' || stato === 'CARICATA' || stato === 'IGNORATA') {
                params.push(stato);
                where += ` AND f.stato = $2`;
            }
            const [r, conta] = await Promise.all([
                queryWithRetry(`${TESTATA_SQL} ${where} ORDER BY f.data DESC, f.id DESC LIMIT 300`, params),
                queryWithRetry(`SELECT count(*)::int AS n FROM fatture_fornitori WHERE tenant_id = $1 AND stato = 'DA_CONTROLLARE'`, [tenantId]),
            ]);
            res.json({ fatture: r.rows.map(testataJson), daControllare: conta.rows[0]?.n ?? 0 });
        } catch (err) {
            fail(res, err, 'GET /');
        }
    });

    // Quante aspettano qualcuno: il numero accanto alla voce del Magazzino.
    router.get('/conteggio', ...guard, async (req, res) => {
        try {
            const r = await queryWithRetry(
                `SELECT count(*)::int AS n FROM fatture_fornitori WHERE tenant_id = $1 AND stato = 'DA_CONTROLLARE'`,
                [req.tenantId!],
            );
            res.json({ daControllare: r.rows[0]?.n ?? 0 });
        } catch (err) {
            fail(res, err, 'GET /conteggio');
        }
    });

    // ---- Caricamento ---------------------------------------------------------
    // Il file arriva com'è (application/octet-stream) e il nome nell'header:
    // uno zip di un mese di fatture con i PDF dentro supera presto gli 8 MB
    // del JSON in base64.

    router.post('/upload', ...guard, express.raw({ type: () => true, limit: UPLOAD_MASSIMO }), async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const buf = req.body;
            if (!Buffer.isBuffer(buf) || buf.length === 0) throw new FattureError(400, { error: 'File vuoto' });
            let nome = 'fattura.xml';
            try {
                nome = decodeURIComponent(String(req.header('X-Nome-File') ?? '')).trim() || nome;
            } catch {
                // nome illeggibile: resta quello di ripiego
            }
            nome = nome.split(/[\\/]/).pop()!.slice(0, 255);

            const { fatture, scartati } = apriFile(buf, nome);
            const chi = await autore(req);
            const esiti: EsitoFile[] = scartati.map(s => ({ file: s.nome, esito: 'scartato' as const, motivo: s.motivo }));
            for (const f of fatture) esiti.push(...await importaXml(tenantId, f.nome, f.xml, 'UPLOAD', chi));
            if (esiti.some(e => e.esito === 'nuova')) changed(req, 'upload');
            res.status(201).json({ esiti });
        } catch (err) {
            fail(res, err, 'POST /upload');
        }
    });

    // ---- Dettaglio -----------------------------------------------------------

    router.get('/:id', ...guard, async (req, res) => {
        try {
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            res.json(await dettaglio(req.tenantId!, id));
        } catch (err) {
            fail(res, err, 'GET /:id');
        }
    });

    // Il PDF di cortesia (o un altro allegato): sta dentro l'XML.
    router.get('/:id/allegati/:indice', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            const indice = Number(req.params.indice);
            if (!id || !Number.isInteger(indice) || indice < 0) throw new FattureError(400, { error: 'Richiesta non valida' });
            const r = await queryWithRetry(
                `SELECT f.indice_body, x.xml FROM fatture_fornitori f
                   JOIN fatture_fornitori_file x ON x.id = f.file_id AND x.tenant_id = f.tenant_id
                  WHERE f.tenant_id = $1 AND f.id = $2`,
                [tenantId, id],
            );
            if (r.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
            const allegato = estraiAllegato(r.rows[0].xml, r.rows[0].indice_body, indice);
            if (!allegato) throw new FattureError(404, { error: 'Allegato non trovato' });
            const pdf = /pdf/i.test(allegato.formato ?? '') || /\.pdf$/i.test(allegato.nome)
                || allegato.dati.subarray(0, 4).toString('latin1') === '%PDF';
            const nomeSicuro = allegato.nome.replace(/[^\w.\- ]+/g, '_');
            res.setHeader('Content-Type', pdf ? 'application/pdf' : 'application/octet-stream');
            res.setHeader('Content-Disposition', `${pdf ? 'inline' : 'attachment'}; filename="${nomeSicuro}"`);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Cache-Control', 'private, max-age=300');
            res.send(allegato.dati);
        } catch (err) {
            fail(res, err, 'GET /:id/allegati/:indice');
        }
    });

    // ---- Fornitore -----------------------------------------------------------
    // Collega la fattura a un fornitore dell'anagrafica (e gli dà la P.IVA,
    // così la prossima si collega da sola) oppure lo crea. Vale per tutte le
    // fatture dello stesso fornitore ancora senza collegamento.

    router.put('/:id/fornitore', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            const body = req.body ?? {};
            await withTenant(tenantId, async client => {
                const f = await client.query(
                    `SELECT chiave_fornitore, cedente_piva, cedente_nome FROM fatture_fornitori WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, id],
                );
                if (f.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
                const { chiave_fornitore: chiave, cedente_piva: piva, cedente_nome: nome } = f.rows[0];
                let supplierId: string;
                if (body.crea === true) {
                    const nuovo = await client.query(
                        `INSERT INTO suppliers (tenant_id, name, categories, vat_number) VALUES ($1, $2, ARRAY['CUCINA']::varchar(20)[], $3)
                         RETURNING id`,
                        [tenantId, String(nome).slice(0, 255), piva],
                    ).catch((err: any) => {
                        if (err?.code === '23505') throw new FattureError(409, { error: 'Un fornitore ha già questa partita IVA', code: 'piva_usata' });
                        throw err;
                    });
                    supplierId = nuovo.rows[0].id;
                } else {
                    if (typeof body.supplierId !== 'string' || !UUID_RE.test(body.supplierId)) {
                        throw new FattureError(400, { error: 'Fornitore non valido' });
                    }
                    const s = await client.query(`SELECT id, vat_number FROM suppliers WHERE tenant_id = $1 AND id = $2`, [tenantId, body.supplierId]);
                    if (s.rowCount === 0) throw new FattureError(404, { error: 'Fornitore non trovato' });
                    supplierId = s.rows[0].id;
                    const ivaAttuale: string | null = s.rows[0].vat_number;
                    if (piva && ivaAttuale && ivaAttuale.toUpperCase() !== String(piva).toUpperCase()) {
                        throw new FattureError(409, { error: 'Quel fornitore ha un\'altra partita IVA', code: 'piva_diversa' });
                    }
                    if (piva && !ivaAttuale) {
                        await client.query(`UPDATE suppliers SET vat_number = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, supplierId, piva])
                            .catch((err: any) => {
                                if (err?.code === '23505') throw new FattureError(409, { error: 'Un altro fornitore ha già questa partita IVA', code: 'piva_usata' });
                                throw err;
                            });
                    }
                }
                await client.query(
                    `UPDATE fatture_fornitori SET supplier_id = $3
                      WHERE tenant_id = $1 AND (id = $2 OR (chiave_fornitore = $4 AND supplier_id IS NULL))`,
                    [tenantId, id, supplierId, chiave],
                );
            });
            changed(req, 'fornitore', id);
            res.json(await dettaglio(tenantId, id));
        } catch (err) {
            fail(res, err, 'PUT /:id/fornitore');
        }
    });

    // ---- Decisione su una riga -----------------------------------------------

    router.put('/:id/righe/:rigaId', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            const rigaId = parseId(req.params.rigaId);
            if (!id || !rigaId) throw new FattureError(400, { error: 'id non valido' });
            const body = req.body ?? {};
            await withTenant(tenantId, async client => {
                const r = await client.query(
                    `SELECT r.tipo, f.stato, f.tipo_documento FROM fatture_fornitori_righe r
                       JOIN fatture_fornitori f ON f.id = r.fattura_id AND f.tenant_id = r.tenant_id
                      WHERE r.tenant_id = $1 AND r.fattura_id = $2 AND r.id = $3`,
                    [tenantId, id, rigaId],
                );
                if (r.rowCount === 0) throw new FattureError(404, { error: 'Riga non trovata' });
                if (r.rows[0].stato !== 'DA_CONTROLLARE') throw new FattureError(409, { error: 'La fattura è già chiusa', code: 'chiusa' });
                if (r.rows[0].tipo !== 'merce') throw new FattureError(400, { error: 'Solo le righe di merce si caricano' });

                const esito = body.esito;
                if (esito === null) {
                    await client.query(
                        `UPDATE fatture_fornitori_righe
                            SET esito = NULL, da_memoria = false, product_id = NULL, fattore_magazzino = NULL,
                                fattore_costo = NULL, unita_costo = NULL, categoria_spesa = NULL
                          WHERE tenant_id = $1 AND id = $2`,
                        [tenantId, rigaId],
                    );
                    return;
                }
                if (esito === 'IGNORA') {
                    const categoria = body.categoriaSpesa ?? 'altro';
                    if (!(CATEGORIE_SPESA as readonly string[]).includes(categoria)) throw new FattureError(400, { error: 'Categoria non valida' });
                    await client.query(
                        `UPDATE fatture_fornitori_righe
                            SET esito = 'IGNORA', da_memoria = false, product_id = NULL, fattore_magazzino = NULL,
                                fattore_costo = NULL, unita_costo = NULL, categoria_spesa = $3
                          WHERE tenant_id = $1 AND id = $2`,
                        [tenantId, rigaId, categoria],
                    );
                    return;
                }
                if (esito !== 'CARICO') throw new FattureError(400, { error: 'Esito non valido' });
                const productId = parseId(body.productId);
                if (!productId) throw new FattureError(400, { error: 'Scegli il prodotto' });
                const p = await client.query(`SELECT id FROM inventory_products WHERE tenant_id = $1 AND id = $2`, [tenantId, productId]);
                if (p.rowCount === 0) throw new FattureError(404, { error: 'Prodotto non trovato' });
                const fattoreMagazzino = parseNumber(body.fattoreMagazzino ?? 1);
                if (fattoreMagazzino == null || fattoreMagazzino <= 0 || fattoreMagazzino > FATTORE_MASSIMO) {
                    throw new FattureError(400, { error: 'Quantità per confezione non valida' });
                }
                let fattoreCosto: number | null = null;
                let unitaCosto: string | null = null;
                if (body.unitaCosto != null && body.unitaCosto !== '') {
                    if (!UNITA_COSTO.has(body.unitaCosto)) throw new FattureError(400, { error: 'Unità non valida (kg, l o pz)' });
                    unitaCosto = body.unitaCosto;
                    fattoreCosto = parseNumber(body.fattoreCosto);
                    if (fattoreCosto == null || fattoreCosto <= 0 || fattoreCosto > FATTORE_MASSIMO) {
                        throw new FattureError(400, { error: 'Contenuto della confezione non valido' });
                    }
                }
                await client.query(
                    `UPDATE fatture_fornitori_righe
                        SET esito = 'CARICO', da_memoria = false, product_id = $3, fattore_magazzino = $4,
                            fattore_costo = $5, unita_costo = $6, categoria_spesa = NULL
                      WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, rigaId, productId, Math.round(fattoreMagazzino * 10000) / 10000,
                        fattoreCosto == null ? null : Math.round(fattoreCosto * 10000) / 10000, unitaCosto],
                );
            });
            const righe = await queryWithRetry(`${RIGHE_SQL.replace('ORDER BY r.numero_linea, r.id', '')} AND r.id = $3`, [tenantId, id, rigaId]);
            res.json(rigaJson(righe.rows[0] as RigaDb));
        } catch (err) {
            fail(res, err, 'PUT /:id/righe/:rigaId');
        }
    });

    // ---- Carico --------------------------------------------------------------

    router.post('/:id/carica', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            const ubicazioni: Record<string, number> = {};
            for (const area of AREE) {
                const v = parseId(req.body?.ubicazioni?.[area]);
                if (v) ubicazioni[area] = v;
            }
            const chi = await autore(req);
            const foodCost = await deps.foodCostAttivo(tenantId).catch(() => false);
            const esito = await caricaFattura(tenantId, id, ubicazioni, chi, req.user?.userId ?? null, req.user?.email ?? null, foodCost);
            await deps.dopoCarico(tenantId, esito.variazioni).catch(err =>
                console.warn('[fatture-fornitori] chiusura scorte basse:', err?.message || err));
            changed(req, 'carico', id);
            if (esito.prezzi > 0) {
                try {
                    deps.broadcast(tenantId, 'foodcost:changed', { what: 'ingredienti' });
                } catch {
                    // il food cost si rilegge alla prossima apertura
                }
            }
            res.json({ caricate: esito.caricate, prezzi: esito.prezzi, avvisi: esito.avvisi, fattura: await dettaglio(tenantId, id) });
        } catch (err) {
            fail(res, err, 'POST /:id/carica');
        }
    });

    // Un carico sbagliato si annulla: la merce esce con una rettifica (lo
    // storico resta), la fattura torna da controllare. I prezzi restano nello
    // storico del food cost: erano comunque i prezzi della fattura.
    router.post('/:id/annulla', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            const chi = await autore(req);
            await withTenant(tenantId, async client => {
                const f = await client.query(
                    `SELECT * FROM fatture_fornitori WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
                    [tenantId, id],
                );
                if (f.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
                if (f.rows[0].stato !== 'CARICATA') throw new FattureError(409, { error: 'La fattura non è caricata', code: 'non_caricata' });
                const doc = nomeDocumento(f.rows[0]);
                const mov = await client.query(
                    `SELECT r.id AS riga_id, m.product_id, m.location_id, m.delta
                       FROM fatture_fornitori_righe r
                       JOIN inventory_movements m ON m.id = r.movimento_id AND m.tenant_id = r.tenant_id
                      WHERE r.tenant_id = $1 AND r.fattura_id = $2`,
                    [tenantId, id],
                );
                for (const m of mov.rows) {
                    const delta = -Number(m.delta);
                    await client.query(
                        `INSERT INTO inventory_stock (tenant_id, product_id, location_id, quantity, updated_at)
                         VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                         ON CONFLICT (product_id, location_id)
                         DO UPDATE SET quantity = inventory_stock.quantity + EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
                        [tenantId, m.product_id, m.location_id, delta],
                    );
                    await client.query(
                        `INSERT INTO inventory_movements (tenant_id, product_id, location_id, delta, reason, notes, user_id, user_name, fattura_riga_id)
                         VALUES ($1, $2, $3, $4, 'RETTIFICA', $5, $6, $7, $8)`,
                        [tenantId, m.product_id, m.location_id, delta, `Annullato il carico: ${doc}`.slice(0, 500),
                            req.user?.userId ?? null, chi, m.riga_id],
                    );
                }
                await client.query(
                    `UPDATE fatture_fornitori_righe SET movimento_id = NULL, prezzo_id = NULL WHERE tenant_id = $1 AND fattura_id = $2`,
                    [tenantId, id],
                );
                await client.query(
                    `UPDATE fatture_fornitori SET stato = 'DA_CONTROLLARE', caricata_at = NULL, caricata_da = NULL
                      WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, id],
                );
            });
            changed(req, 'annullato', id);
            res.json(await dettaglio(tenantId, id));
        } catch (err) {
            fail(res, err, 'POST /:id/annulla');
        }
    });

    // Una fattura che non porta merce da caricare (servizi, una nota di
    // credito) si mette da parte, e si riprende se serve.
    router.put('/:id/stato', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            const nuovo = req.body?.stato;
            if (nuovo !== 'IGNORATA' && nuovo !== 'DA_CONTROLLARE') throw new FattureError(400, { error: 'Stato non valido' });
            const r = await queryWithRetry(
                `UPDATE fatture_fornitori SET stato = $3
                  WHERE tenant_id = $1 AND id = $2 AND stato IN ('DA_CONTROLLARE', 'IGNORATA')
                  RETURNING id`,
                [tenantId, id, nuovo],
            );
            if (r.rowCount === 0) {
                await leggiTestata(tenantId, id);
                throw new FattureError(409, { error: 'Una fattura caricata si annulla, non si mette da parte', code: 'caricata' });
            }
            changed(req, 'stato', id);
            res.json(await dettaglio(tenantId, id));
        } catch (err) {
            fail(res, err, 'PUT /:id/stato');
        }
    });

    // Caricata per sbaglio (un'altra ditta, un doppione col numero scritto
    // diverso): si toglie, purché non abbia mosso il magazzino.
    router.delete('/:id', ...guard, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = parseId(req.params.id);
            if (!id) throw new FattureError(400, { error: 'id non valido' });
            await withTenant(tenantId, async client => {
                const f = await client.query(
                    `SELECT stato, file_id FROM fatture_fornitori WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
                    [tenantId, id],
                );
                if (f.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
                if (f.rows[0].stato === 'CARICATA') throw new FattureError(409, { error: 'Annulla prima il carico', code: 'caricata' });
                await client.query(`DELETE FROM fatture_fornitori WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
                await client.query(
                    `DELETE FROM fatture_fornitori_file x
                      WHERE x.tenant_id = $1 AND x.id = $2
                        AND NOT EXISTS (SELECT 1 FROM fatture_fornitori f WHERE f.file_id = x.id)`,
                    [tenantId, f.rows[0].file_id],
                );
            });
            changed(req, 'eliminata', id);
            res.status(204).send();
        } catch (err) {
            fail(res, err, 'DELETE /:id');
        }
    });

    return router;
}

// ---- Il carico vero ------------------------------------------------------------

export interface EsitoCarico {
    caricate: number;
    prezzi: number;
    avvisi: string[];
    variazioni: { productId: number; prima: number; dopo: number }[];
}

/**
 * Tutto in una transazione: i movimenti di carico, i prezzi del food cost e
 * la memoria degli abbinamenti. Se una riga non va (prodotto sparito, cella
 * dell'area sbagliata) non si carica niente: mezza fattura in magazzino è
 * peggio di nessuna.
 */
export async function caricaFattura(
    tenantId: number,
    id: number,
    ubicazioni: Record<string, number>,
    chi: string | null,
    userId: number | null,
    email: string | null,
    foodCost: boolean,
): Promise<EsitoCarico> {
    return withTenant(tenantId, async client => {
        const fq = await client.query(`SELECT * FROM fatture_fornitori WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [tenantId, id]);
        if (fq.rowCount === 0) throw new FattureError(404, { error: 'Fattura non trovata' });
        const f = fq.rows[0];
        if (f.stato !== 'DA_CONTROLLARE') throw new FattureError(409, { error: 'La fattura è già chiusa', code: 'chiusa' });
        if (f.tipo_documento === 'TD04') throw new FattureError(409, { error: 'Una nota di credito non carica merce', code: 'nota_di_credito' });

        const rq = await client.query(
            `SELECT r.*, p.area AS p_area, p.unita_costo AS p_unita_costo, p.is_preparazione AS p_is_preparazione, p.name AS p_name
               FROM fatture_fornitori_righe r
               LEFT JOIN inventory_products p ON p.id = r.product_id AND p.tenant_id = r.tenant_id
              WHERE r.tenant_id = $1 AND r.fattura_id = $2 AND r.tipo = 'merce'
              ORDER BY r.numero_linea, r.id`,
            [tenantId, id],
        );
        const righe = rq.rows;
        const daDecidere = righe.filter(r => r.esito == null).length;
        if (daDecidere > 0) {
            throw new FattureError(409, { error: `Mancano ${daDecidere} ${daDecidere === 1 ? 'riga' : 'righe'} da decidere`, code: 'righe_da_decidere' });
        }

        // Le celle scelte, una per area: devono essere del ristorante e dell'area.
        const celle = new Map<string, number>();
        const locIds = Object.values(ubicazioni);
        if (locIds.length) {
            const l = await client.query(`SELECT id, area FROM inventory_locations WHERE tenant_id = $1 AND id = ANY($2::int[])`, [tenantId, locIds]);
            for (const [area, locId] of Object.entries(ubicazioni)) {
                const loc = l.rows.find((x: any) => x.id === locId);
                if (!loc || loc.area !== area) throw new FattureError(400, { error: 'Cella non valida', code: 'cella' });
                celle.set(area, locId);
            }
        }

        const doc = nomeDocumento(f);
        const nota = `${doc} · ${f.cedente_nome}`.slice(0, 500);
        const avvisi: string[] = [];
        const totaliPrima = new Map<number, number>();
        const deltaPerProdotto = new Map<number, number>();
        let caricate = 0;

        for (const r of righe) {
            if (r.esito !== 'CARICO') continue;
            if (!r.product_id || !r.p_area) throw new FattureError(409, { error: `Riga ${r.numero_linea}: il prodotto non c'è più`, code: 'prodotto' });
            const cella = celle.get(r.p_area);
            if (!cella) throw new FattureError(400, { error: `Scegli la cella per ${r.p_area.toLowerCase()}`, code: 'cella_mancante', area: r.p_area });
            const delta = Math.round(Number(r.quantita ?? 0) * Number(r.fattore_magazzino ?? 0) * 1000) / 1000;
            if (!(delta > 0)) {
                avvisi.push(`Riga ${r.numero_linea}: quantità zero, non caricata`);
                continue;
            }
            if (!totaliPrima.has(r.product_id)) {
                const t = await client.query(
                    `SELECT COALESCE(SUM(quantity), 0)::float AS total FROM inventory_stock WHERE tenant_id = $1 AND product_id = $2`,
                    [tenantId, r.product_id],
                );
                totaliPrima.set(r.product_id, t.rows[0]?.total ?? 0);
            }
            await client.query(
                `INSERT INTO inventory_stock (tenant_id, product_id, location_id, quantity, updated_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (product_id, location_id)
                 DO UPDATE SET quantity = inventory_stock.quantity + EXCLUDED.quantity, updated_at = CURRENT_TIMESTAMP`,
                [tenantId, r.product_id, cella, delta],
            );
            const mov = await client.query(
                `INSERT INTO inventory_movements (tenant_id, product_id, location_id, delta, reason, notes, user_id, user_name, fattura_riga_id, lotto)
                 VALUES ($1, $2, $3, $4, 'CARICO', $5, $6, $7, $8, $9)
                 RETURNING id`,
                [tenantId, r.product_id, cella, delta, nota, userId, chi ?? email, r.id, r.lotto],
            );
            await client.query(`UPDATE fatture_fornitori_righe SET movimento_id = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, r.id, mov.rows[0].id]);
            deltaPerProdotto.set(r.product_id, (deltaPerProdotto.get(r.product_id) ?? 0) + delta);
            caricate++;
        }

        // Prezzi: per prodotto, la media pesata delle sue righe (lo stesso
        // articolo può stare su due righe a prezzi diversi).
        let prezzi = 0;
        if (foodCost) {
            const perProdotto = new Map<number, { euro: number; quantita: number; unita: string; righe: number[]; nome: string; unitaProdotto: string | null; preparazione: boolean }>();
            for (const r of righe) {
                if (r.esito !== 'CARICO' || !r.product_id || !r.unita_costo || !r.fattore_costo) continue;
                const quantita = Number(r.quantita ?? 0) * Number(r.fattore_costo);
                const euro = Number(r.prezzo_totale);
                if (!(quantita > 0) || !(euro > 0)) continue;
                const acc = perProdotto.get(r.product_id);
                if (acc && acc.unita !== r.unita_costo) {
                    avvisi.push(`${r.p_name}: righe con unità diverse, prezzo non aggiornato`);
                    perProdotto.delete(r.product_id);
                    continue;
                }
                if (acc) {
                    acc.euro += euro;
                    acc.quantita += quantita;
                    acc.righe.push(r.id);
                } else {
                    perProdotto.set(r.product_id, {
                        euro, quantita, unita: r.unita_costo, righe: [r.id], nome: r.p_name,
                        unitaProdotto: r.p_unita_costo, preparazione: Boolean(r.p_is_preparazione),
                    });
                }
            }
            for (const [productId, p] of perProdotto) {
                if (p.preparazione) {
                    avvisi.push(`${p.nome}: è un semilavorato, il costo viene dalla sua ricetta`);
                    continue;
                }
                if (p.unitaProdotto && p.unitaProdotto !== p.unita) {
                    avvisi.push(`${p.nome}: nel food cost si paga a ${p.unitaProdotto}, non a ${p.unita}: prezzo non aggiornato`);
                    continue;
                }
                const costoCents = Math.round((p.euro * 100) / p.quantita);
                await client.query(
                    `UPDATE inventory_products
                        SET costo_cents = $3, unita_costo = $4, costo_aggiornato_at = now(),
                            supplier_id = COALESCE($5, supplier_id)
                      WHERE tenant_id = $1 AND id = $2`,
                    [tenantId, productId, costoCents, p.unita, f.supplier_id],
                );
                const pr = await client.query(
                    `INSERT INTO food_cost_prezzi (tenant_id, product_id, costo_cents, unita_costo, fonte, supplier_id, documento, user_id, user_name)
                     VALUES ($1, $2, $3, $4, 'FATTURA_XML', $5, $6, $7, $8)
                     RETURNING id`,
                    [tenantId, productId, costoCents, p.unita, f.supplier_id, `${doc} · ${f.cedente_nome}`.slice(0, 120), userId, chi ?? email],
                );
                await client.query(
                    `UPDATE fatture_fornitori_righe SET prezzo_id = $3 WHERE tenant_id = $1 AND id = ANY($2::int[])`,
                    [tenantId, p.righe, pr.rows[0].id],
                );
                prezzi++;
            }
        }

        // La memoria: quello che si è deciso oggi vale per la prossima fattura.
        for (const r of righe) {
            if (!r.chiave_tipo || !r.chiave || !r.esito) continue;
            await client.query(
                `INSERT INTO fornitori_articoli (tenant_id, chiave_fornitore, chiave_tipo, chiave, descrizione, azione, product_id,
                                                 fattore_magazzino, fattore_costo, unita_costo, categoria_spesa)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                 ON CONFLICT (tenant_id, chiave_fornitore, chiave_tipo, chiave) DO UPDATE
                    SET descrizione = EXCLUDED.descrizione, azione = EXCLUDED.azione, product_id = EXCLUDED.product_id,
                        fattore_magazzino = EXCLUDED.fattore_magazzino, fattore_costo = EXCLUDED.fattore_costo,
                        unita_costo = EXCLUDED.unita_costo, categoria_spesa = EXCLUDED.categoria_spesa,
                        usi = fornitori_articoli.usi + 1, updated_at = now()`,
                [
                    tenantId, f.chiave_fornitore, r.chiave_tipo, r.chiave, r.descrizione, r.esito,
                    r.esito === 'CARICO' ? r.product_id : null,
                    r.esito === 'CARICO' ? r.fattore_magazzino : null,
                    r.esito === 'CARICO' ? r.fattore_costo : null,
                    r.esito === 'CARICO' ? r.unita_costo : null,
                    r.esito === 'IGNORA' ? (r.categoria_spesa ?? 'altro') : null,
                ],
            );
        }

        await client.query(
            `UPDATE fatture_fornitori SET stato = 'CARICATA', caricata_at = now(), caricata_da = $3 WHERE tenant_id = $1 AND id = $2`,
            [tenantId, id, chi ?? email],
        );

        const variazioni = [...deltaPerProdotto.entries()].map(([productId, delta]) => {
            const prima = totaliPrima.get(productId) ?? 0;
            return { productId, prima, dopo: prima + delta };
        });
        return { caricate, prezzi, avvisi, variazioni };
    });
}
