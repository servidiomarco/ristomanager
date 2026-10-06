// Conti della cassa Passepartout nel CRM (sola lettura).
//
// Per il CRM i tavoli chiusi solo in cassa non esistevano: niente nei
// report incassi, niente spesa per cliente, e il riscontro CRM↔cassa si
// faceva a mano a fine serata. Qui i conti del giorno si leggono dalla cassa
// (op 'contiGiorno' dell'agente, capacità 'conti') e restano in
// passepartout_conti, col collegamento alla prenotazione (la comanda nata
// dal planning porta il suo id) e al tavolo del CRM (abbinamento).
//
// Un conto del CRM chiuso in cassa (comanda importata, o pagato col tipo
// esterno) è `origine = 'crm'`: è già fra i table_bills, e i totali di cassa
// lo escludono per non contarlo due volte.
//
// Il giro: oggi a ogni passaggio (ogni 10 minuti), e un cursore sui giorni
// passati (conti_completo_fino) che la prima volta riparte da 30 giorni fa
// e avanza di qualche giorno a giro — lo storico arriva da solo in
// un'oretta — e poi tiene ieri completo, riletto dopo le 5 quando la cassa
// ha chiuso tutto. Solo cloud.

import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';
import { isFeatureEnabledForTenant } from './entitlements.js';
import { callPassepartout, connectedPassepartoutTenants, passepartoutAgentSupports, PassepartoutBridgeError } from './passepartoutBridge.js';
import type { PassepartoutContoCassa } from './passepartoutService.js';
import { getDatePartInTz, getTimePartInTz } from '../utils/reservationTime.js';

const TZ_CASSA = 'Europe/Rome';
const CAPACITA = 'conti';
const STORICO_GIORNI = 30;
const GIORNI_PASSATI_PER_GIRO = 5;
/** Ieri si considera chiuso solo da quest'ora di sala: i conti di fine
 *  serata possono chiudersi dopo mezzanotte sul giorno di gestione prima. */
const ORA_GIORNATA_CHIUSA = '05:00';
/** Conti che non sono incasso: annullati, storni, annulli. */
export const STATI_ESCLUSI = ['Annullato'];
export const TIPI_ESCLUSI = ['Annullo', 'Reso'];

export interface ContiCassaDeps {
    /** Il tipo di pagamento «esterno» del ristorante: un conto della cassa
     *  pagato con quello è un conto del CRM chiuso in cassa. */
    tipoPagamentoEsterno: (tenantId: number) => Promise<string | null>;
}

let deps: ContiCassaDeps | null = null;
const inCorso = new Set<number>();

const cents = (v: number | null | undefined) => Math.round((Number(v) || 0) * 100);
const oggiCassa = () => getDatePartInTz(new Date(), TZ_CASSA);
const giornoPrima = (giorno: string, n = 1) => {
    const d = new Date(`${giorno}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
};
const giornoDopo = (giorno: string) => giornoPrima(giorno, -1);

export interface EsitoImport { giorno: string; conti: number; collegati: number; crm: number }

/** Importa (o reimporta) i conti di un giorno. Dentro il contesto tenant. */
export async function importaContiGiorno(tenantId: number, giorno: string): Promise<EsitoImport> {
    const conti = await callPassepartout<PassepartoutContoCassa[]>(tenantId, 'contiGiorno', { giorno }, 120_000);
    const esterno = deps ? await deps.tipoPagamentoEsterno(tenantId) : null;

    const idPren = [...new Set(conti.map((c) => c.idPrenotazione).filter((x): x is number => x != null))];
    const prenRs = idPren.length
        ? await queryWithRetry(
            `SELECT pp_id, reservation_id FROM passepartout_prenotazioni
              WHERE tenant_id = $1 AND pp_id = ANY($2::int[]) AND reservation_id IS NOT NULL`,
            [tenantId, idPren]
        )
        : { rows: [] as any[] };
    const prenotazioni = new Map<number, number>(prenRs.rows.map((r: any) => [Number(r.pp_id), Number(r.reservation_id)]));

    const tavRs = await queryWithRetry(
        `SELECT table_id, pp_sala, pp_tavolo FROM passepartout_tavoli WHERE tenant_id = $1 AND confermato`,
        [tenantId]
    );
    const tavoli = new Map<string, number>(tavRs.rows.map((r: any) => [`${r.pp_sala}\u0000${r.pp_tavolo}`, Number(r.table_id)]));

    const refs = conti.map((c) => c.idComanda).filter((x): x is number => x != null).map((id) => `pp:comanda:${id}`);
    const billRs = refs.length
        ? await queryWithRetry(
            `SELECT id, external_ref FROM table_bills WHERE tenant_id = $1 AND external_ref = ANY($2::text[])`,
            [tenantId, refs]
        )
        : { rows: [] as any[] };
    const bills = new Map<string, number>(billRs.rows.map((r: any) => [String(r.external_ref), Number(r.id)]));

    let collegati = 0;
    let crm = 0;
    for (const c of conti) {
        const billId = c.idComanda != null ? bills.get(`pp:comanda:${c.idComanda}`) ?? null : null;
        const pagatoEsterno = esterno != null && c.pagamenti.some((p) => p.codice === esterno);
        const origine = billId != null || pagatoEsterno ? 'crm' : 'cassa';
        if (origine === 'crm') crm++;
        const reservationId = c.idPrenotazione != null ? prenotazioni.get(c.idPrenotazione) ?? null : null;
        if (reservationId != null) collegati++;
        const tableId = c.sala && c.tavolo ? tavoli.get(`${c.sala}\u0000${c.tavolo}`) ?? null : null;
        await queryWithRetry(
            `INSERT INTO passepartout_conti
                (tenant_id, pp_conto_id, giorno, chiuso_at, pp_comanda_id, pp_prenotazione_id, reservation_id, table_id,
                 tavolo, sala, coperti, totale_cents, pagato_cents, sospeso_cents, stato, tipo_conto, tipo_documento,
                 numero_scontrino, pagamenti, origine, table_bill_id, importato_at)
             VALUES ($1, $2, $3::date,
                     CASE WHEN $4::text IS NULL THEN NULL
                          WHEN $4::text ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN $4::timestamptz
                          ELSE ($4::timestamp AT TIME ZONE '${TZ_CASSA}') END,
                     $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21, now())
             ON CONFLICT (tenant_id, pp_conto_id) DO UPDATE SET
                giorno = EXCLUDED.giorno, chiuso_at = EXCLUDED.chiuso_at, pp_comanda_id = EXCLUDED.pp_comanda_id,
                pp_prenotazione_id = EXCLUDED.pp_prenotazione_id,
                reservation_id = COALESCE(EXCLUDED.reservation_id, passepartout_conti.reservation_id),
                table_id = COALESCE(EXCLUDED.table_id, passepartout_conti.table_id),
                tavolo = EXCLUDED.tavolo, sala = EXCLUDED.sala, coperti = EXCLUDED.coperti,
                totale_cents = EXCLUDED.totale_cents, pagato_cents = EXCLUDED.pagato_cents,
                sospeso_cents = EXCLUDED.sospeso_cents, stato = EXCLUDED.stato, tipo_conto = EXCLUDED.tipo_conto,
                tipo_documento = EXCLUDED.tipo_documento, numero_scontrino = EXCLUDED.numero_scontrino,
                pagamenti = EXCLUDED.pagamenti, origine = EXCLUDED.origine,
                table_bill_id = COALESCE(EXCLUDED.table_bill_id, passepartout_conti.table_bill_id),
                importato_at = now()`,
            [
                tenantId, c.idConto, giorno, c.chiusoAt, c.idComanda, c.idPrenotazione, reservationId, tableId,
                c.tavolo, c.sala, c.coperti, cents(c.totaleDocumento ?? c.totalePagato), cents(c.totalePagato),
                cents(c.sospeso), c.stato, c.tipoConto, c.tipoDocumento, c.numeroScontrino,
                JSON.stringify(c.pagamenti.map((p) => ({ codice: p.codice, categoria: p.categoria, importo_cents: cents(p.importo) }))),
                origine, billId,
            ]
        );
    }
    await queryWithRetry(
        `INSERT INTO passepartout_config (tenant_id, conti_importati_at) VALUES ($1, now())
         ON CONFLICT (tenant_id) DO UPDATE SET conti_importati_at = now()`,
        [tenantId]
    );
    return { giorno, conti: conti.length, collegati, crm };
}

export async function contiCassaAccesi(tenantId: number): Promise<boolean> {
    const rs = await queryWithRetry(`SELECT conti_enabled FROM passepartout_config WHERE tenant_id = $1`, [tenantId]);
    return rs.rows[0]?.conti_enabled === true;
}

/**
 * Un giro per un ristorante, DENTRO il suo contesto tenant: oggi, più i
 * giorni passati che il cursore non ha ancora coperto (al massimo
 * GIORNI_PASSATI_PER_GIRO). `soloOggi` per «Importa adesso».
 */
export async function giroContiCassa(tenantId: number, opts: { soloOggi?: boolean } = {}): Promise<EsitoImport[]> {
    if (!(await contiCassaAccesi(tenantId))) return [];
    if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return [];
    if (!passepartoutAgentSupports(tenantId, CAPACITA)) return [];
    if (inCorso.has(tenantId)) return [];
    inCorso.add(tenantId);
    const esiti: EsitoImport[] = [];
    try {
        const oggi = oggiCassa();
        esiti.push(await importaContiGiorno(tenantId, oggi));
        if (opts.soloOggi) return esiti;
        const cfg = await queryWithRetry(
            `SELECT conti_completo_fino::text AS fino FROM passepartout_config WHERE tenant_id = $1`,
            [tenantId]
        );
        let fino: string = cfg.rows[0]?.fino ?? giornoPrima(oggi, STORICO_GIORNI + 1);
        const ieri = giornoPrima(oggi);
        const giornataChiusa = getTimePartInTz(new Date(), TZ_CASSA) >= ORA_GIORNATA_CHIUSA;
        for (let n = 0; n < GIORNI_PASSATI_PER_GIRO; n++) {
            const prossimo = giornoDopo(fino);
            if (prossimo > ieri || (prossimo === ieri && !giornataChiusa)) break;
            esiti.push(await importaContiGiorno(tenantId, prossimo));
            fino = prossimo;
            await queryWithRetry(
                `UPDATE passepartout_config SET conti_completo_fino = $2::date WHERE tenant_id = $1`,
                [tenantId, fino]
            );
        }
    } catch (err) {
        if (!(err instanceof PassepartoutBridgeError)) throw err;
        console.warn(`[passepartout] conti della cassa, tenant ${tenantId}:`, err.message);
    } finally {
        inCorso.delete(tenantId);
    }
    return esiti;
}

let timer: ReturnType<typeof setInterval> | null = null;
let giroGlobale = false;

export function startPassepartoutContiSync(d: ContiCassaDeps): void {
    deps = d;
    if (timer) return;
    const ms = Number(process.env.PASSEPARTOUT_CONTI_SWEEP_MS) || 10 * 60_000;
    timer = setInterval(() => {
        void giro().catch((err) => console.error('[passepartout] conti della cassa:', err?.message || err));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

async function giro(): Promise<void> {
    const pronti = connectedPassepartoutTenants().filter((t) => passepartoutAgentSupports(t, CAPACITA));
    if (giroGlobale || pronti.length === 0) return;
    giroGlobale = true;
    try {
        // rls-bypass: solo l'elenco dei ristoranti con i conti accesi; ognuno si lavora nel suo contesto tenant
        const rs = await runAsPlatform(() => queryWithRetry(
            `SELECT tenant_id FROM passepartout_config WHERE conti_enabled AND tenant_id = ANY($1::bigint[])`,
            [pronti]
        ));
        for (const row of rs.rows) {
            const tenantId = Number(row.tenant_id);
            await runWithTenantContext(tenantId, () => giroContiCassa(tenantId));
        }
    } finally {
        giroGlobale = false;
    }
}

// ---------------------------------------------------------------------------
// Letture per il CRM
// ---------------------------------------------------------------------------

/** Filtro SQL dei conti che sono incasso della cassa (alias `pc`). */
export const SQL_INCASSO_CASSA = `pc.origine = 'cassa'
    AND COALESCE(pc.stato, '') <> ALL (ARRAY['${STATI_ESCLUSI.join("','")}'])
    AND COALESCE(pc.tipo_conto, '') <> ALL (ARRAY['${TIPI_ESCLUSI.join("','")}'])`;

/** Il conto della cassa di una prenotazione (l'ultimo, se il tavolo ne ha
 *  chiusi più d'uno: conto separato, romana). */
export async function contiCassaPrenotazione(tenantId: number, reservationId: number) {
    const rs = await queryWithRetry(
        `SELECT pc.pp_conto_id, pc.giorno::text AS giorno, pc.chiuso_at, pc.tavolo, pc.sala, pc.coperti,
                pc.totale_cents, pc.pagato_cents, pc.stato, pc.tipo_documento, pc.numero_scontrino, pc.origine
           FROM passepartout_conti pc
          WHERE pc.tenant_id = $1 AND pc.reservation_id = $2
            AND COALESCE(pc.stato, '') <> ALL (ARRAY['${STATI_ESCLUSI.join("','")}'])
          ORDER BY pc.chiuso_at NULLS LAST`,
        [tenantId, reservationId]
    );
    return rs.rows;
}

/**
 * Quanto spende un cliente: i conti CRM chiusi delle sue prenotazioni più i
 * conti della cassa collegati alle sue prenotazioni (solo origine 'cassa':
 * quelli 'crm' sono già i conti CRM). Aggancio cliente↔prenotazione per le
 * ultime 10 cifre del telefono, come il resto della rubrica.
 */
export async function spesaCliente(tenantId: number, phone: string) {
    const rs = await queryWithRetry(
        `WITH pren AS (
            SELECT r.id FROM reservations r
             WHERE r.tenant_id = $1 AND $2 <> ''
               AND right(regexp_replace(COALESCE(r.phone, ''), '\\D', '', 'g'), 10) = $2
         ), crm AS (
            SELECT b.reservation_id AS rid, b.total_cents AS cents, b.covers AS coperti, COALESCE(b.closed_at, b.opened_at) AS quando
              FROM table_bills b
             WHERE b.tenant_id = $1 AND b.status = 'CLOSED' AND b.reservation_id IN (SELECT id FROM pren)
         ), cassa AS (
            SELECT pc.reservation_id AS rid, pc.totale_cents AS cents, pc.coperti, pc.chiuso_at AS quando
              FROM passepartout_conti pc
             WHERE pc.tenant_id = $1 AND pc.reservation_id IN (SELECT id FROM pren) AND ${SQL_INCASSO_CASSA}
         ), tutti AS (SELECT * FROM crm UNION ALL SELECT * FROM cassa)
         SELECT COALESCE(SUM(cents), 0)::bigint AS totale_cents,
                COUNT(DISTINCT rid)::int AS visite,
                COALESCE(SUM(coperti), 0)::int AS coperti,
                MAX(quando) AS ultima_visita,
                (SELECT COUNT(*)::int FROM cassa) AS conti_cassa
           FROM tutti`,
        [tenantId, phone.replace(/\D/g, '').slice(-10)]
    );
    const r = rs.rows[0] ?? {};
    const totale = Number(r.totale_cents) || 0;
    const coperti = Number(r.coperti) || 0;
    return {
        totale_cents: totale,
        visite: Number(r.visite) || 0,
        medio_coperto_cents: coperti > 0 ? Math.round(totale / coperti) : null,
        ultima_visita: r.ultima_visita ?? null,
        conti_cassa: Number(r.conti_cassa) || 0,
    };
}

/** Incassi dei tavoli chiusi solo in cassa, nel periodo (giorni di cassa). */
export async function incassiCassa(tenantId: number, from: string, to: string) {
    const tot = await queryWithRetry(
        `SELECT COALESCE(SUM(pc.totale_cents), 0)::bigint AS totale_cents, COUNT(*)::int AS conti,
                COALESCE(SUM(pc.coperti), 0)::int AS coperti
           FROM passepartout_conti pc
          WHERE pc.tenant_id = $1 AND pc.giorno BETWEEN $2::date AND $3::date AND ${SQL_INCASSO_CASSA}`,
        [tenantId, from, to]
    );
    const metodi = await queryWithRetry(
        `SELECT COALESCE(p->>'codice', '—') AS codice, SUM((p->>'importo_cents')::int)::bigint AS importo_cents
           FROM passepartout_conti pc, jsonb_array_elements(pc.pagamenti) p
          WHERE pc.tenant_id = $1 AND pc.giorno BETWEEN $2::date AND $3::date AND ${SQL_INCASSO_CASSA}
          GROUP BY 1 ORDER BY 2 DESC`,
        [tenantId, from, to]
    );
    const t = tot.rows[0] ?? {};
    return {
        totale_cents: Number(t.totale_cents) || 0,
        conti: Number(t.conti) || 0,
        coperti: Number(t.coperti) || 0,
        per_metodo: metodi.rows.map((m: any) => ({ codice: String(m.codice), importo_cents: Number(m.importo_cents) || 0 })),
    };
}

/**
 * Il riscontro del giorno fra CRM e cassa — il «delta zero» che a fine
 * serata si faceva a mano. Guarda i conti del CRM nati da una comanda della
 * cassa (pp:comanda): ognuno deve avere il suo conto in cassa, con lo
 * stesso importo. E i conti della cassa pagati col tipo esterno devono
 * avere un conto nel CRM.
 */
export async function riscontroGiorno(tenantId: number, giorno: string) {
    const importati = await queryWithRetry(
        `SELECT COUNT(*)::int AS n FROM passepartout_conti WHERE tenant_id = $1 AND giorno = $2::date`,
        [tenantId, giorno]
    );
    const crm = await queryWithRetry(
        `SELECT b.id, b.total_cents, b.external_ref, b.closed_at, t.name AS tavolo,
                pc.pp_conto_id, pc.totale_cents AS cassa_cents, pc.numero_scontrino
           FROM table_bills b
           LEFT JOIN tables t ON t.id = b.table_id AND t.tenant_id = b.tenant_id
           LEFT JOIN passepartout_conti pc
                  ON pc.tenant_id = b.tenant_id AND pc.pp_comanda_id = substring(b.external_ref from 'pp:comanda:(\\d+)')::int
                 AND COALESCE(pc.stato, '') <> ALL (ARRAY['${STATI_ESCLUSI.join("','")}'])
          WHERE b.tenant_id = $1 AND b.status = 'CLOSED' AND b.external_ref LIKE 'pp:comanda:%'
            AND COALESCE(b.service_date, (b.closed_at AT TIME ZONE '${TZ_CASSA}')::date) = $2::date
          ORDER BY b.closed_at`,
        [tenantId, giorno]
    );
    const esterni = await queryWithRetry(
        `SELECT pc.pp_conto_id, pc.tavolo, pc.totale_cents, pc.numero_scontrino, pc.chiuso_at
           FROM passepartout_conti pc
          WHERE pc.tenant_id = $1 AND pc.giorno = $2::date AND pc.origine = 'crm' AND pc.table_bill_id IS NULL
            AND COALESCE(pc.stato, '') <> ALL (ARRAY['${STATI_ESCLUSI.join("','")}'])
          ORDER BY pc.chiuso_at`,
        [tenantId, giorno]
    );
    const cassa = await incassiCassa(tenantId, giorno, giorno);
    const mancanti = crm.rows.filter((r: any) => r.pp_conto_id == null);
    // Più conti per comanda (separati, romana) sommano: si confronta il totale.
    const perBill = new Map<number, { bill: any; cassa: number }>();
    for (const r of crm.rows) {
        if (r.pp_conto_id == null) continue;
        const cur = perBill.get(Number(r.id)) ?? { bill: r, cassa: 0 };
        cur.cassa += Number(r.cassa_cents) || 0;
        perBill.set(Number(r.id), cur);
    }
    const diversi = [...perBill.values()].filter((x) => x.cassa !== Number(x.bill.total_cents));
    const billDistinti = new Set(crm.rows.map((r: any) => Number(r.id))).size;
    return {
        giorno,
        importato: (Number(importati.rows[0]?.n) || 0) > 0,
        conti_crm_da_cassa: billDistinti,
        mancanti_in_cassa: mancanti.map((r: any) => ({ bill_id: Number(r.id), tavolo: r.tavolo, totale_cents: Number(r.total_cents), chiuso_at: r.closed_at })),
        importi_diversi: diversi.map((x) => ({
            bill_id: Number(x.bill.id), tavolo: x.bill.tavolo, crm_cents: Number(x.bill.total_cents), cassa_cents: x.cassa,
        })),
        esterni_senza_crm: esterni.rows.map((r: any) => ({
            pp_conto_id: Number(r.pp_conto_id), tavolo: r.tavolo, totale_cents: Number(r.totale_cents),
            numero_scontrino: r.numero_scontrino, chiuso_at: r.chiuso_at,
        })),
        cassa_solo: cassa,
    };
}
