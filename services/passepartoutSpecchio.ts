// Conti del CRM verso la cassa Passepartout (fase 4, «comanda specchio»).
//
// I conti chiusi nel CRM (scontrino dal registratore del CRM) non esistevano
// per la cassa: statistiche per articolo e magazzino del gestionale vedevano
// solo i tavoli battuti lì. In modalità «statistiche» ogni conto del CRM
// chiuso diventa in cassa una comanda sul tavolo scelto in sezione (al
// Frantoio il 29 di DENTRO), senza invio in produzione, chiusa come proforma
// pagata col tipo esterno: nessun documento fiscale dalla cassa, e l'incasso
// esterno non si conta due volte (passepartoutConti la marca «crm»).
//
// Durevole come la chiusura in cassa: la riga di passepartout_specchio nasce
// PENDING nella transazione che chiude il conto (accodaSpecchio), un giro la
// lavora e la porta a CONFIRMED con gli id della cassa, o a FAILED quando
// serve una mano. La comanda porta in nota il tag del conto: un nuovo
// tentativo la ritrova invece di farne un'altra (lato agente, specchioComanda).
// Solo cloud: con i conti in sala (nodo) le chiusure non passano di qui.

import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';
import { isServiceNode } from './topology.js';
import { isFeatureEnabledForTenant } from './entitlements.js';
import { callPassepartout, connectedPassepartoutTenants, passepartoutAgentSupports, PassepartoutBridgeError } from './passepartoutBridge.js';
import type { EsitoSpecchio, ParametriSpecchio, RigaSpecchio } from './passepartoutService.js';

const CAPACITA = 'specchio';
const MAX_TENTATIVI = 8;
/** Oltre, un tavolo specchio sempre occupato o un agente sempre spento
 *  diventano FAILED: qualcuno deve guardarci. */
const ATTESA_MASSIMA_ORE = 24;
// Messaggi che non sono guasti del conto: si aspetta senza contare.
const OCCUPATO = 'tavolo_specchio_occupato';
// Un problema di configurazione non passa ritentando.
const SENZA_ARTICOLO = 'non ha un articolo in cassa';

export interface SpecchioDeps {
    /** Il tipo di pagamento con cui la cassa chiude i conti del CRM
     *  (getPassepartoutChiusuraConfig): senza, niente comanda specchio. */
    tipoPagamentoEsterno: (tenantId: number) => Promise<string | null>;
}

let deps: SpecchioDeps | null = null;

/** La riga in coda, nella transazione che chiude il conto (client del
 *  chiamante). Solo conti del CRM con un totale (non quelli nati da una
 *  comanda della cassa, che in cassa ci sono già, né quelli degli ordini
 *  già scritti nella comanda in cassa del loro tavolo: passepartoutComandeVive),
 *  solo in modalità statistiche e con il tavolo specchio scelto. */
export async function accodaSpecchio(client: any, tenantId: number, billId: number): Promise<boolean> {
    // Lo specchio lo lavora solo il cloud: sul nodo (che ora ha la
    // configurazione della cassa, fase 6 della comanda viva) la coda
    // resterebbe lì per sempre.
    if (isServiceNode) return false;
    const rs = await client.query(
        `INSERT INTO passepartout_specchio (tenant_id, table_bill_id)
         SELECT $1, b.id
           FROM table_bills b
           JOIN passepartout_config pc ON pc.tenant_id = b.tenant_id
          WHERE b.id = $2 AND b.tenant_id = $1 AND b.status = 'CLOSED'
            AND b.takeaway_order_id IS NULL AND b.total_cents > 0
            AND (b.external_ref IS NULL OR b.external_ref NOT LIKE 'pp:comanda:%')
            AND pc.conti_crm_mode = 'statistiche' AND pc.specchio_tavolo IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM orders o
                              JOIN passepartout_comande_vive v ON v.tenant_id = o.tenant_id AND v.order_id = o.id
                             WHERE o.tenant_id = b.tenant_id AND o.table_bill_id = b.id
                               AND v.pp_comanda_id IS NOT NULL)
         ON CONFLICT (tenant_id, table_bill_id) DO NOTHING
         RETURNING table_bill_id`,
        [tenantId, billId]
    );
    return (rs.rowCount ?? 0) > 0;
}

/** Una riga del conto del CRM, come la leggono le righe di order_items. */
export interface RigaContoCrm {
    kind: string;
    qty: number;
    unitCents: number;
    nome: string;
    idArticolo: number | null;
}

/**
 * Le righe per la cassa: la somma è ESATTAMENTE il totale del conto.
 * - Lo sconto del conto (totale sotto la somma delle righe) si spalma sulle
 *   righe in proporzione, come lo spalma un registratore; i centesimi di
 *   resto vanno alle frazioni maggiori. Niente riga negativa: in cassa non
 *   è provata.
 * - Una riga il cui importo non si divide per i pezzi diventa due righe
 *   (pezzi a u e a u+1 centesimi): la cassa ricalcola Prezzo × Pezzi.
 * - Coperti: quelli della riga coperto del CRM, col suo prezzo. Senza
 *   coperto nel CRM, una riga coperto a zero con i coperti del conto: se la
 *   comanda ha coperti e nessuna riga coperto, la cassa aggiunge la sua al
 *   suo prezzo (prova del 06/10) e il totale non tornerebbe più.
 */
export function righeSpecchio(
    righe: RigaContoCrm[],
    totaleCents: number,
    copertiConto: number,
): { righe: RigaSpecchio[]; coperti: number } {
    const base = righe
        .filter((r) => r.qty > 0)
        .map((r) => ({ ...r, lordo: Math.round(r.unitCents * r.qty) }));
    const somma = base.reduce((s, r) => s + r.lordo, 0);
    // Riproporzione al totale (anche verso l'alto, per prudenza).
    const scalate = base.map((r) => {
        const esatto = somma > 0 ? (r.lordo * totaleCents) / somma : 0;
        return { ...r, esatto, cents: Math.floor(esatto) };
    });
    let resto = totaleCents - scalate.reduce((s, r) => s + r.cents, 0);
    for (const r of [...scalate].sort((a, b) => (b.esatto - Math.floor(b.esatto)) - (a.esatto - Math.floor(a.esatto)))) {
        if (resto <= 0) break;
        r.cents += 1;
        resto -= 1;
    }
    const out: RigaSpecchio[] = [];
    let coperti = 0;
    for (const r of scalate) {
        const coperto = r.kind === 'COVER';
        if (coperto) coperti += r.qty;
        const unit = Math.floor(r.cents / r.qty);
        const conUnoInPiu = r.cents - unit * r.qty;
        const voce = (pezzi: number, prezzoCents: number): RigaSpecchio => ({
            idArticolo: coperto ? null : r.idArticolo,
            descrizione: r.nome,
            pezzi,
            prezzoCents,
            ...(coperto ? { coperto: true } : {}),
        });
        if (r.qty - conUnoInPiu > 0) out.push(voce(r.qty - conUnoInPiu, unit));
        if (conUnoInPiu > 0) out.push(voce(conUnoInPiu, unit + 1));
    }
    if (coperti === 0 && copertiConto > 0) {
        coperti = copertiConto;
        out.unshift({ idArticolo: null, descrizione: 'Coperto', pezzi: copertiConto, prezzoCents: 0, coperto: true });
    }
    return { righe: out, coperti };
}

async function configSpecchio(tenantId: number) {
    const rs = await queryWithRetry(
        `SELECT conti_crm_mode, specchio_sala, specchio_tavolo, articolo_generico_id
           FROM passepartout_config WHERE tenant_id = $1`,
        [tenantId]
    );
    return rs.rows[0] ?? null;
}

/** I parametri per l'agente, dal conto chiuso. */
export async function parametriSpecchio(tenantId: number, billId: number, tipoPagamento: string): Promise<ParametriSpecchio | null> {
    const cfg = await configSpecchio(tenantId);
    if (!cfg?.specchio_tavolo) return null;
    const billRs = await queryWithRetry(
        `SELECT id, total_cents, covers FROM table_bills WHERE id = $1 AND tenant_id = $2`,
        [billId, tenantId]
    );
    const bill = billRs.rows[0];
    if (!bill) return null;
    const lineRs = await queryWithRetry(
        `SELECT oi.line_kind, oi.qty, oi.unit_price_cents, oi.modifiers, oi.name_snapshot, d.external_ref
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           LEFT JOIN dishes d ON d.id = oi.dish_id AND d.tenant_id = oi.tenant_id
          WHERE o.table_bill_id = $1 AND o.tenant_id = $2 AND oi.status <> 'VOIDED'
          ORDER BY oi.course_no, oi.id`,
        [billId, tenantId]
    );
    let righe: RigaContoCrm[] = lineRs.rows.map((r: any) => {
        const mods: any[] = Array.isArray(r.modifiers) ? r.modifiers : [];
        const delta = mods.reduce((s, m) => s + Number(m?.price_delta_cents || 0), 0);
        const ref = /^pp:articolo:(\d+)$/.exec(String(r.external_ref ?? ''));
        return {
            kind: String(r.line_kind || 'DISH'),
            qty: Number(r.qty) || 0,
            unitCents: Number(r.unit_price_cents) + delta,
            nome: mods.length > 0 ? `${r.name_snapshot} (${mods.map((m) => m.name).join(', ')})` : String(r.name_snapshot ?? 'Voce'),
            idArticolo: ref ? Number(ref[1]) : null,
        };
    });
    // Un conto aperto a importo, senza comande: una riga sola sull'articolo
    // generico, col totale.
    if (righe.length === 0) {
        righe = [{ kind: 'DISH', qty: 1, unitCents: Number(bill.total_cents), nome: `Conto CRM ${billId}`, idArticolo: null }];
    }
    const { righe: perCassa, coperti } = righeSpecchio(righe, Number(bill.total_cents), Number(bill.covers) || 0);
    return {
        tag: `sympotia-conto:${billId}`,
        sala: String(cfg.specchio_sala ?? ''),
        tavolo: String(cfg.specchio_tavolo),
        coperti,
        righe: perCassa,
        idArticoloGenerico: cfg.articolo_generico_id != null ? Number(cfg.articolo_generico_id) : null,
        tipoPagamento,
        totaleCents: Number(bill.total_cents),
    };
}

/** Una passata sulla coda di un ristorante, DENTRO il suo contesto tenant. */
export async function lavoraSpecchio(tenantId: number, limite = 5): Promise<number> {
    if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return 0;
    if (!passepartoutAgentSupports(tenantId, CAPACITA)) return 0;
    const cfg = await configSpecchio(tenantId);
    if (cfg?.conti_crm_mode !== 'statistiche') return 0;
    const tipoPagamento = deps ? await deps.tipoPagamentoEsterno(tenantId) : null;
    if (!tipoPagamento) return 0;
    const coda = await queryWithRetry(
        `SELECT table_bill_id, attempts, created_at FROM passepartout_specchio
          WHERE tenant_id = $1 AND stato = 'PENDING' AND next_at <= now()
          ORDER BY created_at LIMIT $2`,
        [tenantId, limite]
    );
    let fatti = 0;
    for (const riga of coda.rows) {
        const billId = Number(riga.table_bill_id);
        // Claim: vince chi incrementa per primo (due processi, o un giro
        // lungo che si accavalla al successivo).
        const claim = await queryWithRetry(
            `UPDATE passepartout_specchio SET attempts = attempts + 1, next_at = now() + interval '5 minutes', updated_at = now()
              WHERE tenant_id = $1 AND table_bill_id = $2 AND stato = 'PENDING' AND attempts = $3
              RETURNING attempts`,
            [tenantId, billId, riga.attempts]
        );
        if ((claim.rowCount ?? 0) === 0) continue;
        const tentativi = Number(claim.rows[0].attempts);
        const vecchia = Date.now() - new Date(riga.created_at).getTime() > ATTESA_MASSIMA_ORE * 3_600_000;
        try {
            const params = await parametriSpecchio(tenantId, billId, tipoPagamento);
            if (!params) throw new Error('Conto o tavolo specchio non più disponibili');
            const esito = await callPassepartout<EsitoSpecchio>(tenantId, 'specchio', params as unknown as Record<string, unknown>, 180_000);
            await queryWithRetry(
                `UPDATE passepartout_specchio
                    SET stato = 'CONFIRMED', pp_comanda_id = $3, pp_conto_id = $4, totale_cents = $5,
                        totale_cassa_cents = $6, avviso = $7, error = NULL, updated_at = now()
                  WHERE tenant_id = $1 AND table_bill_id = $2`,
                [tenantId, billId, esito.idComanda, esito.idConto, params.totaleCents, esito.totaleCassaCents, esito.avviso]
            );
            fatti++;
        } catch (err: any) {
            const messaggio = String(err?.message ?? err).slice(0, 500);
            // Tavolo specchio occupato o agente spento: non è colpa del conto,
            // si aspetta senza contare il tentativo.
            const attesa = messaggio.includes(OCCUPATO)
                || (err instanceof PassepartoutBridgeError && (err.kind === 'agent_offline' || err.kind === 'timeout'));
            const fallito = messaggio.includes(SENZA_ARTICOLO) || vecchia || (!attesa && tentativi >= MAX_TENTATIVI);
            const minuti = attesa ? 10 : Math.min(30, 2 ** Math.max(0, tentativi - 1));
            await queryWithRetry(
                `UPDATE passepartout_specchio
                    SET stato = CASE WHEN $3::boolean THEN 'FAILED' ELSE stato END,
                        attempts = CASE WHEN $4::boolean THEN attempts - 1 ELSE attempts END,
                        next_at = now() + make_interval(mins => $5::int),
                        error = $6, updated_at = now()
                  WHERE tenant_id = $1 AND table_bill_id = $2`,
                [tenantId, billId, fallito, attesa && !fallito, minuti, messaggio]
            );
        }
    }
    return fatti;
}

let timer: ReturnType<typeof setInterval> | null = null;
let giroInCorso = false;

export function startPassepartoutSpecchioSync(d: SpecchioDeps): void {
    deps = d;
    if (timer) return;
    const ms = Number(process.env.PASSEPARTOUT_SPECCHIO_SWEEP_MS) || 60_000;
    timer = setInterval(() => {
        void giro().catch((err) => console.error('[passepartout] comanda specchio:', err?.message || err));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

/** Subito dopo la chiusura di un conto: non si aspetta il minuto. */
export function avviaSpecchio(tenantId: number): void {
    setImmediate(() => {
        void runWithTenantContext(tenantId, () => lavoraSpecchio(tenantId))
            .catch((err) => console.error('[passepartout] comanda specchio:', err?.message || err));
    });
}

async function giro(): Promise<void> {
    if (giroInCorso) return;
    giroInCorso = true;
    try {
        const pronti = connectedPassepartoutTenants().filter((t) => passepartoutAgentSupports(t, CAPACITA));
        if (pronti.length === 0) return;
        // rls-bypass: solo l'elenco dei ristoranti con conti in coda; ognuno si lavora nel suo contesto tenant
        const rs = await runAsPlatform(() => queryWithRetry(
            `SELECT DISTINCT tenant_id FROM passepartout_specchio
              WHERE stato = 'PENDING' AND next_at <= now() AND tenant_id = ANY($1::bigint[])`,
            [pronti]
        ));
        for (const row of rs.rows) {
            const tenantId = Number(row.tenant_id);
            await runWithTenantContext(tenantId, () => lavoraSpecchio(tenantId));
        }
    } finally {
        giroInCorso = false;
    }
}
