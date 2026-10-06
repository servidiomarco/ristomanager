// Prenotazioni del CRM nel planning della cassa Passepartout, e arrivi
// dalla cassa al CRM.
//
// Andata: ogni prenotazione confermata con un tavolo abbinato diventa una
// prenotazione del gestionale (nome, coperti, telefono, nota, orario e
// durata) — la cassa la vede nel planning, e aprendo il tavolo dalla
// prenotazione trova la comanda già intestata coi coperti. Annullata,
// rifiutata, segnata no-show, senza tavolo o cancellata: in cassa diventa
// «Mancata», l'unico stato che libera il tavolo (il WS non cancella).
//
// Ritorno: quando in cassa il tavolo si apre dalla prenotazione, questa
// passa a «Chiusa»; il CRM la segna «Arrivato» da solo.
//
// La cassa ha l'ultima parola: se lo stato in cassa non è più quello che
// il CRM ha scritto (aperta, mancata, cancellata a mano), il CRM smette di
// scriverla. Il confronto lo fa l'agente nello stesso giro della scrittura.
//
// Non è una coda di eventi ma un riallineamento: a ogni giro si confronta
// lo stato voluto (dalle prenotazioni) con quello scritto (impronta), e si
// scrive solo la differenza. Agente spento per un'ora = al primo giro dopo
// la cassa si rimette in pari, senza eventi persi da rincorrere. Gira solo
// sul cloud, padrone delle prenotazioni.

import crypto from 'crypto';
import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';
import { isFeatureEnabledForTenant } from './entitlements.js';
import { callPassepartout, connectedPassepartoutTenants, passepartoutAgentSupports, PassepartoutBridgeError } from './passepartoutBridge.js';
import type { EsitoPrenotazioneCassa, PassepartoutPrenotazione, PassepartoutSalaPianta } from './passepartoutService.js';
import { getDatePartInTz, getTimePartInTz } from '../utils/reservationTime.js';

/** Il gestionale ragiona nell'ora di sala, e Passepartout è un prodotto
 *  italiano: le date in cassa sono sempre nel fuso di Roma. */
const TZ_CASSA = 'Europe/Rome';
const CAPACITA = 'prenotazioni';
/** Scritture per ristorante a giro: un riallineamento grosso (prima
 *  accensione, agente spento a lungo) si spalma su più giri invece di
 *  tenere occupata la cassa per minuti. */
const SCRITTURE_PER_GIRO = 40;
const ARRIVI_OGNI_MS = 60_000;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

// ---------------------------------------------------------------------------
// Abbinamento tavoli
// ---------------------------------------------------------------------------

export interface TavoloCrm { id: number; name: string; room: string | null }
export interface PropostaAbbinamento {
    table_id: number;
    pp_sala: string | null;
    pp_tavolo: string | null;
    /** sicuro = stesso nome, nella sala dove finisce il resto della stanza;
     *  simile = stesso nome a meno di spazi, maiuscole, punto o trattino in
     *  coda, o stesso nome ma in un'altra sala: va confermato. */
    certezza: 'sicuro' | 'simile' | null;
}

const normalizzaNome = (s: string) => s.toLowerCase().replace(/\s+/g, '').replace(/[.-]+$/, '');

/**
 * Propone, per ogni tavolo del CRM, il tavolo della cassa. In cassa i nomi
 * hanno varianti tipografiche («80-», «24.», «3BIS») e alcuni si ripetono
 * fra sale («23» in FIUME, «23.» in DENTRO): la sala giusta si deduce dalla
 * stanza del CRM, guardando dove finiscono i suoi tavoli dal nome
 * identico e univoco.
 */
export function abbinaTavoli(crm: TavoloCrm[], pianta: PassepartoutSalaPianta[]): PropostaAbbinamento[] {
    const esatti = new Map<string, Array<{ sala: string; nome: string }>>();
    const simili = new Map<string, Array<{ sala: string; nome: string }>>();
    for (const s of pianta) {
        for (const t of s.tavoli) {
            const c = { sala: s.sala, nome: t.nome };
            esatti.set(t.nome, [...(esatti.get(t.nome) ?? []), c]);
            const n = normalizzaNome(t.nome);
            simili.set(n, [...(simili.get(n) ?? []), c]);
        }
    }
    const voti = new Map<string, Map<string, number>>();
    for (const t of crm) {
        const c = esatti.get(t.name.trim()) ?? [];
        if (c.length !== 1 || t.room == null) continue;
        const v = voti.get(t.room) ?? new Map<string, number>();
        v.set(c[0].sala, (v.get(c[0].sala) ?? 0) + 1);
        voti.set(t.room, v);
    }
    const salaDiStanza = (room: string | null): string | null => {
        const v = room == null ? null : voti.get(room);
        if (!v) return null;
        return [...v.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    return crm.map((t) => {
        const sala = salaDiStanza(t.room);
        const ex = esatti.get(t.name.trim()) ?? [];
        const exInSala = sala ? ex.filter((c) => c.sala === sala) : ex;
        const proposta = (c: { sala: string; nome: string }, certezza: 'sicuro' | 'simile'): PropostaAbbinamento =>
            ({ table_id: t.id, pp_sala: c.sala, pp_tavolo: c.nome, certezza });
        if (exInSala.length === 1) return proposta(exInSala[0], 'sicuro');
        const si = simili.get(normalizzaNome(t.name)) ?? [];
        const siInSala = sala ? si.filter((c) => c.sala === sala) : si;
        if (siInSala.length === 1) return proposta(siInSala[0], 'simile');
        if (ex.length === 1) return proposta(ex[0], 'simile');
        if (si.length === 1) return proposta(si[0], 'simile');
        return { table_id: t.id, pp_sala: null, pp_tavolo: null, certezza: null };
    });
}

// ---------------------------------------------------------------------------
// Dalla prenotazione al contratto della cassa
// ---------------------------------------------------------------------------

export interface RigaPrenotazione {
    id: number;
    customer_name: string;
    reservation_time: string | Date;
    shift: string | null;
    guests: number;
    children: number | null;
    duration_minutes: number | null;
    notes: string | null;
    phone: string | null;
}

export interface PrenotazionePerCassa {
    tag: string;
    dataOra: string;
    durata: number;
    sala: string;
    tavoli: string[];
    intestazione: string;
    telefono: string | null;
    note: string;
    numeroPersone: number;
    adulti: number;
    bambini: number;
    stato: 'Confermata';
}

export const tagPrenotazione = (reservationId: number) => `sympotia:${reservationId}`;

export function prenotazionePerCassa(r: RigaPrenotazione, sala: string, tavolo: string): PrenotazionePerCassa {
    const persone = Math.max(1, Math.round(Number(r.guests) || 1));
    const bambini = Math.max(0, Math.min(Math.round(Number(r.children) || 0), persone));
    // Solo la nota della prenotazione (dove la sala scrive allergie e
    // richieste): la scheda in rubrica costerebbe un aggancio per telefono
    // su ogni riga a ogni giro.
    const note = (r.notes ?? '').trim();
    return {
        tag: tagPrenotazione(r.id),
        dataOra: `${getDatePartInTz(r.reservation_time, TZ_CASSA)}T${getTimePartInTz(r.reservation_time, TZ_CASSA)}:00`,
        // Stessa regola del controllo sovrapposizioni: 90 a pranzo, 120 a cena.
        durata: Number(r.duration_minutes) > 0 ? Number(r.duration_minutes) : (r.shift === 'LUNCH' ? 90 : 120),
        sala,
        tavoli: [tavolo],
        intestazione: r.customer_name,
        telefono: r.phone?.trim() || null,
        note,
        numeroPersone: persone,
        adulti: persone - bambini,
        bambini,
        stato: 'Confermata',
    };
}

export const improntaPrenotazione = (p: PrenotazionePerCassa) =>
    crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 40);

// ---------------------------------------------------------------------------
// Il giro
// ---------------------------------------------------------------------------

export interface PrenotazioniCassaDeps {
    /** Segna «Arrivato» la prenotazione aperta in cassa. true se è cambiata. */
    segnaArrivo: (tenantId: number, reservationId: number) => Promise<boolean>;
}

export interface RiepilogoGiro {
    saltato?: 'spento' | 'non_venduto' | 'agente' | 'in_corso';
    scritte: number;
    annullate: number;
    prese_in_cassa: number;
    arrivi: number;
    errori: number;
}

let deps: PrenotazioniCassaDeps | null = null;
const tenantInCorso = new Set<number>();
const ultimiArrivi = new Map<number, number>();

const vuoto = (): RiepilogoGiro => ({ scritte: 0, annullate: 0, prese_in_cassa: 0, arrivi: 0, errori: 0 });

export async function prenotazioniCassaAccese(tenantId: number): Promise<boolean> {
    const rs = await queryWithRetry(
        `SELECT prenotazioni_enabled FROM passepartout_config WHERE tenant_id = $1`,
        [tenantId]
    );
    return rs.rows[0]?.prenotazioni_enabled === true;
}

const prossimoTentativo = (attempts: number) =>
    new Date(Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_MS));

async function registraEsito(
    tenantId: number,
    linkId: number | null,
    reservationId: number | null,
    tag: string,
    campi: {
        pp_id?: number | null;
        pp_giorno?: string | null;
        stato_scritto?: string | null;
        stato_cassa?: string | null;
        impronta?: string | null;
        gestita_in_cassa?: boolean;
        incerta?: boolean;
        arrivo?: boolean;
    },
): Promise<void> {
    const v = [
        campi.pp_id ?? null, campi.pp_giorno ?? null, campi.stato_scritto ?? null, campi.stato_cassa ?? null,
        campi.impronta ?? null, campi.gestita_in_cassa ?? false, campi.incerta ?? false, campi.arrivo ?? false,
    ];
    if (linkId != null) {
        await queryWithRetry(
            `UPDATE passepartout_prenotazioni
                SET pp_id = COALESCE($3, pp_id), pp_giorno = COALESCE($4::date, pp_giorno),
                    stato_scritto = COALESCE($5, stato_scritto), stato_cassa = COALESCE($6, stato_cassa),
                    impronta = $7, gestita_in_cassa = gestita_in_cassa OR $8, incerta = $9,
                    arrivo_riportato_at = CASE WHEN $10 THEN COALESCE(arrivo_riportato_at, now()) ELSE arrivo_riportato_at END,
                    attempts = 0, next_at = NULL, last_error = NULL, synced_at = now()
              WHERE id = $1 AND tenant_id = $2`,
            [linkId, tenantId, ...v]
        );
        return;
    }
    await queryWithRetry(
        `INSERT INTO passepartout_prenotazioni
            (tenant_id, reservation_id, tag, pp_id, pp_giorno, stato_scritto, stato_cassa, impronta,
             gestita_in_cassa, incerta, arrivo_riportato_at, synced_at)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, CASE WHEN $11 THEN now() END, now())
         ON CONFLICT (reservation_id) DO NOTHING`,
        [tenantId, reservationId, tag, ...v]
    );
}

async function registraErrore(
    tenantId: number,
    linkId: number | null,
    reservationId: number | null,
    tag: string,
    attempts: number,
    errore: string,
    creazione: { giorno: string } | null,
): Promise<void> {
    const n = attempts + 1;
    if (linkId != null) {
        await queryWithRetry(
            `UPDATE passepartout_prenotazioni
                SET attempts = $3, next_at = $4, last_error = $5,
                    incerta = incerta OR $6, pp_giorno = COALESCE(pp_giorno, $7::date)
              WHERE id = $1 AND tenant_id = $2`,
            [linkId, tenantId, n, prossimoTentativo(n), errore.slice(0, 500), creazione != null, creazione?.giorno ?? null]
        );
        return;
    }
    await queryWithRetry(
        `INSERT INTO passepartout_prenotazioni
            (tenant_id, reservation_id, tag, pp_giorno, incerta, attempts, next_at, last_error)
         VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8)
         ON CONFLICT (reservation_id) DO NOTHING`,
        [tenantId, reservationId, tag, creazione?.giorno ?? null, creazione != null, n, prossimoTentativo(n), errore.slice(0, 500)]
    );
}

const giornoCassa = (p: PassepartoutPrenotazione | null, ripiego: string | null) =>
    (p?.dataOra ?? '').slice(0, 10) || ripiego;

/**
 * Un giro per un ristorante: va chiamato DENTRO il suo contesto tenant.
 * `forza` ignora le attese fra un tentativo fallito e l'altro (il bottone
 * «Sincronizza ora») e rilegge subito gli arrivi.
 */
export async function sincronizzaPrenotazioniCassa(tenantId: number, opts: { forza?: boolean } = {}): Promise<RiepilogoGiro> {
    const riepilogo = vuoto();
    if (!(await prenotazioniCassaAccese(tenantId))) return { ...riepilogo, saltato: 'spento' };
    if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return { ...riepilogo, saltato: 'non_venduto' };
    if (!passepartoutAgentSupports(tenantId, CAPACITA)) return { ...riepilogo, saltato: 'agente' };
    if (tenantInCorso.has(tenantId)) return { ...riepilogo, saltato: 'in_corso' };
    tenantInCorso.add(tenantId);
    try {
        await andata(tenantId, riepilogo, opts.forza === true);
        await ritorno(tenantId, riepilogo, opts.forza === true);
    } finally {
        tenantInCorso.delete(tenantId);
    }
    return riepilogo;
}

async function andata(tenantId: number, riepilogo: RiepilogoGiro, forza: boolean): Promise<void> {
    // Da oggi (ora di sala) a tre settimane: il planning della cassa serve
    // per i prossimi giorni, e un locale pieno fa migliaia di prenotazioni
    // in due mesi, da riconfrontare a ogni giro. Una prenotazione NUOVA in cassa
    // solo se non è già passata da più di un'ora e l'ospite non è già
    // seduto: alla prima accensione, a servizio iniziato, il pranzo di
    // stamattina non serve al planning.
    const rs = await queryWithRetry(
        `SELECT r.id, r.customer_name, r.reservation_time, r.shift, r.guests, r.children, r.duration_minutes,
                r.table_id, r.notes, r.phone,
                COALESCE(r.reservation_status, 'CONFIRMED') AS reservation_status,
                COALESCE(r.arrival_status, 'WAITING') AS arrival_status,
                (r.reservation_time >= now() - interval '1 hour') AS creabile,
                pt.pp_sala, pt.pp_tavolo,
                l.id AS link_id, l.pp_id, l.pp_giorno::text AS pp_giorno, l.stato_scritto, l.impronta,
                l.gestita_in_cassa, l.incerta, l.attempts, l.next_at
           FROM reservations r
           LEFT JOIN passepartout_tavoli pt
                  ON pt.table_id = r.table_id AND pt.tenant_id = r.tenant_id AND pt.confermato
           LEFT JOIN passepartout_prenotazioni l ON l.reservation_id = r.id AND l.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1
            AND r.reservation_time >= (date_trunc('day', now() AT TIME ZONE '${TZ_CASSA}') AT TIME ZONE '${TZ_CASSA}')
            AND r.reservation_time < now() + interval '21 days'
            AND (l.id IS NOT NULL OR (r.table_id IS NOT NULL AND COALESCE(r.reservation_status, 'CONFIRMED') = 'CONFIRMED'))
          ORDER BY r.reservation_time
          LIMIT 3000`,
        [tenantId]
    );
    // Le prenotazioni cancellate dal CRM: la riga di collegamento resta
    // finché in cassa non è annullata.
    const orfane = await queryWithRetry(
        `SELECT id AS link_id, tag, pp_id, pp_giorno::text AS pp_giorno, stato_scritto, incerta, attempts, next_at
           FROM passepartout_prenotazioni
          WHERE tenant_id = $1 AND reservation_id IS NULL AND NOT gestita_in_cassa
            AND (pp_id IS NOT NULL OR incerta) AND stato_scritto IS DISTINCT FROM 'Mancata'
            AND pp_giorno >= (now() AT TIME ZONE '${TZ_CASSA}')::date
          LIMIT 100`,
        [tenantId]
    );

    let scritture = 0;
    const inAttesa = (row: any) => !forza && row.next_at != null && new Date(row.next_at).getTime() > Date.now();

    const annulla = async (row: any, reservationId: number | null) => {
        try {
            const esito = await callPassepartout<EsitoPrenotazioneCassa>(tenantId, 'prenotazione', {
                azione: 'annulla', tag: row.tag ?? tagPrenotazione(reservationId!), giorno: row.pp_giorno,
                idGestionale: row.pp_id ?? null, statoAtteso: row.stato_scritto ?? null,
            });
            if (esito.esito === 'cambiata_in_cassa') {
                riepilogo.prese_in_cassa++;
                await registraEsito(tenantId, row.link_id, reservationId, row.tag, {
                    stato_cassa: esito.prenotazione?.stato ?? null, gestita_in_cassa: true,
                });
                return;
            }
            riepilogo.annullate++;
            await registraEsito(tenantId, row.link_id, reservationId, row.tag, {
                pp_id: esito.prenotazione?.idGestionale ?? null,
                stato_scritto: 'Mancata', stato_cassa: esito.prenotazione?.stato ?? 'Mancata',
            });
        } catch (err) {
            if (err instanceof PassepartoutBridgeError && err.kind === 'agent_offline') throw err;
            riepilogo.errori++;
            await registraErrore(tenantId, row.link_id, reservationId, row.tag, Number(row.attempts) || 0, (err as Error).message, null);
        }
    };

    try {
        for (const r of rs.rows) {
            if (scritture >= SCRITTURE_PER_GIRO) break;
            if (r.gestita_in_cassa || inAttesa(r)) continue;
            const reservationId = Number(r.id);
            const tag = tagPrenotazione(reservationId);
            const abbinata = r.table_id != null && r.pp_sala && r.pp_tavolo;
            const attiva = r.reservation_status === 'CONFIRMED' && abbinata;

            if (!attiva) {
                // Annullata, rifiutata, no-show, senza tavolo o su un tavolo
                // non abbinato: se il CRM l'aveva scritta, in cassa va tolta.
                if ((r.pp_id != null || r.incerta) && r.stato_scritto !== 'Mancata') {
                    scritture++;
                    await annulla({ ...r, tag, pp_giorno: r.pp_giorno ?? getDatePartInTz(r.reservation_time, TZ_CASSA) }, reservationId);
                }
                continue;
            }
            // Ospite già seduto e mai scritta: niente prenotazione postuma.
            if (r.link_id == null && (!r.creabile || r.arrival_status !== 'WAITING')) continue;
            if (r.pp_id == null && !r.incerta && !r.creabile) continue;

            const payload = prenotazionePerCassa(r, r.pp_sala, r.pp_tavolo);
            const impronta = improntaPrenotazione(payload);
            if (r.pp_id != null && r.stato_scritto === 'Confermata' && r.impronta === impronta) continue;

            scritture++;
            try {
                const esito = await callPassepartout<EsitoPrenotazioneCassa>(tenantId, 'prenotazione', {
                    ...payload, idGestionale: r.pp_id ?? null, statoAtteso: r.pp_id != null ? r.stato_scritto : null,
                });
                if (esito.esito === 'scritta') {
                    riepilogo.scritte++;
                    await registraEsito(tenantId, r.link_id, reservationId, tag, {
                        pp_id: esito.prenotazione?.idGestionale ?? null,
                        pp_giorno: giornoCassa(esito.prenotazione, payload.dataOra.slice(0, 10)),
                        stato_scritto: 'Confermata', stato_cassa: esito.prenotazione?.stato ?? null, impronta,
                    });
                    continue;
                }
                // La cassa l'ha presa in mano (o cancellata): da qui in poi
                // è sua. Se l'ha aperta, l'ospite è arrivato.
                riepilogo.prese_in_cassa++;
                const aperta = esito.prenotazione?.stato === 'Chiusa';
                const arrivo = aperta && deps ? await deps.segnaArrivo(tenantId, reservationId) : false;
                if (arrivo) riepilogo.arrivi++;
                await registraEsito(tenantId, r.link_id, reservationId, tag, {
                    pp_id: esito.prenotazione?.idGestionale ?? null,
                    stato_cassa: esito.prenotazione?.stato ?? 'eliminata',
                    impronta: r.impronta ?? null, gestita_in_cassa: true, arrivo: aperta,
                });
            } catch (err) {
                if (err instanceof PassepartoutBridgeError && err.kind === 'agent_offline') throw err;
                riepilogo.errori++;
                await registraErrore(tenantId, r.link_id, reservationId, tag, Number(r.attempts) || 0, (err as Error).message,
                    r.pp_id == null ? { giorno: payload.dataOra.slice(0, 10) } : null);
            }
        }
        for (const o of orfane.rows) {
            if (scritture >= SCRITTURE_PER_GIRO) break;
            if (inAttesa(o) || !o.pp_giorno) continue;
            scritture++;
            await annulla(o, null);
        }
    } catch (err) {
        // Agente sparito a metà giro: si riprende al prossimo, da dove serve.
        if (err instanceof PassepartoutBridgeError && err.kind === 'agent_offline') return;
        throw err;
    }
}

async function ritorno(tenantId: number, riepilogo: RiepilogoGiro, forza: boolean): Promise<void> {
    if (!deps) return;
    const ultimo = ultimiArrivi.get(tenantId) ?? 0;
    if (!forza && Date.now() - ultimo < ARRIVI_OGNI_MS) return;
    const oggi = getDatePartInTz(new Date(), TZ_CASSA);
    const attese = await queryWithRetry(
        `SELECT id AS link_id, reservation_id, tag, pp_id, stato_scritto
           FROM passepartout_prenotazioni
          WHERE tenant_id = $1 AND pp_giorno = $2::date AND pp_id IS NOT NULL
            AND reservation_id IS NOT NULL AND arrivo_riportato_at IS NULL
            AND stato_scritto = 'Confermata' AND NOT gestita_in_cassa`,
        [tenantId, oggi]
    );
    if (attese.rows.length === 0) return;
    ultimiArrivi.set(tenantId, Date.now());
    let cassa: PassepartoutPrenotazione[];
    try {
        cassa = await callPassepartout<PassepartoutPrenotazione[]>(tenantId, 'prenotazioniGiorno', { giorno: oggi }, 30_000);
    } catch (err) {
        if (!(err instanceof PassepartoutBridgeError)) throw err;
        return;
    }
    const perId = new Map(cassa.map((p) => [p.idGestionale, p]));
    for (const l of attese.rows) {
        const p = perId.get(Number(l.pp_id));
        if (!p || p.stato === l.stato_scritto) continue;
        // Stato diverso da quello scritto: la cassa l'ha presa in mano.
        // «Chiusa» = tavolo aperto dalla prenotazione, l'ospite è arrivato.
        riepilogo.prese_in_cassa++;
        const aperta = p.stato === 'Chiusa';
        const arrivo = aperta ? await deps.segnaArrivo(tenantId, Number(l.reservation_id)) : false;
        if (arrivo) riepilogo.arrivi++;
        await queryWithRetry(
            `UPDATE passepartout_prenotazioni
                SET stato_cassa = $3, gestita_in_cassa = true,
                    arrivo_riportato_at = CASE WHEN $4 THEN now() ELSE arrivo_riportato_at END
              WHERE id = $1 AND tenant_id = $2`,
            [l.link_id, tenantId, p.stato, aperta]
        );
    }
}

let timer: ReturnType<typeof setInterval> | null = null;
let giroInCorso = false;

/** Avvio del giro periodico. Solo sul cloud: le prenotazioni sono sue. */
export function startPassepartoutPrenotazioniSync(d: PrenotazioniCassaDeps): void {
    deps = d;
    if (timer) return;
    const ms = Number(process.env.PASSEPARTOUT_PREN_SWEEP_MS) || 30_000;
    timer = setInterval(() => {
        void giro().catch((err) => console.error('[passepartout] prenotazioni in cassa:', err?.message || err));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

async function giro(): Promise<void> {
    // Solo i ristoranti col loro agente collegato e capace: gli altri non
    // hanno niente da scrivere, e la query sui config non serve.
    const pronti = connectedPassepartoutTenants().filter((t) => passepartoutAgentSupports(t, CAPACITA));
    if (giroInCorso || pronti.length === 0) return;
    giroInCorso = true;
    try {
        // rls-bypass: solo l'elenco dei ristoranti con l'invio acceso; ognuno si lavora nel suo contesto tenant
        const rs = await runAsPlatform(() => queryWithRetry(
            `SELECT tenant_id FROM passepartout_config WHERE prenotazioni_enabled AND tenant_id = ANY($1::bigint[])`,
            [pronti]
        ));
        for (const row of rs.rows) {
            const tenantId = Number(row.tenant_id);
            const r = await runWithTenantContext(tenantId, () => sincronizzaPrenotazioniCassa(tenantId));
            if (r.scritte || r.annullate || r.arrivi || r.errori) {
                console.log(`[passepartout] prenotazioni in cassa, tenant ${tenantId}: ${r.scritte} scritte, ${r.annullate} annullate, ${r.arrivi} arrivi, ${r.errori} errori`);
            }
        }
    } finally {
        giroInCorso = false;
    }
}
