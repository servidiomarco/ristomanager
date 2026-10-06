// Tavoli aperti nella cassa Passepartout, per la sala e la disponibilità del
// CRM (sola lettura).
//
// Il CRM decideva occupazione e disponibilità dalle sole prenotazioni: un
// walk-in aperto in cassa lasciava il tavolo «libero», e Sofia o /prenota
// potevano proporlo. Ogni minuto si leggono le comande aperte (op
// 'comandeAperte', capacità 'tavoli-aperti'), si agganciano ai tavoli
// abbinati e si tengono in passepartout_tavoli_aperti; la sala le riceve
// via socket ('passepartout:tavoli-aperti') e la disponibilità automatica
// le esclude (services/apertiInCassaSql.ts).
//
// Una cassa muta non blocca la sala: le righe non viste all'ultima lettura
// buona spariscono, e ad agente spento spariscono tutte dopo 5 minuti.
// Solo cloud.

import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../db.js';
import { isFeatureEnabledForTenant } from './entitlements.js';
import { callPassepartout, connectedPassepartoutTenants, passepartoutAgentSupports, PassepartoutBridgeError } from './passepartoutBridge.js';
import type { PassepartoutComandaAperta } from './passepartoutService.js';

const TZ_CASSA = 'Europe/Rome';
const CAPACITA = 'tavoli-aperti';
const SCADENZA_MIN = 5;

export interface TavoloApertoInCassa {
    table_id: number;
    coperti: number | null;
    totale_cents: number;
    aperta_da: string | null;
    libero_previsto_at: string;
}

export interface TavoliApertiDeps {
    /** Avvisa i client del ristorante (evento 'passepartout:tavoli-aperti'). */
    broadcast: (tenantId: number, tavoli: TavoloApertoInCassa[]) => void;
}

let deps: TavoliApertiDeps | null = null;

export async function tavoliApertiAccesi(tenantId: number): Promise<boolean> {
    const rs = await queryWithRetry(`SELECT tavoli_aperti_enabled FROM passepartout_config WHERE tenant_id = $1`, [tenantId]);
    return rs.rows[0]?.tavoli_aperti_enabled === true;
}

/** I tavoli aperti in cassa del ristorante, per la sala. Vuoto a
 *  interruttore spento: la sala non deve vedere dati vecchi. */
export async function elencoTavoliAperti(tenantId: number): Promise<TavoloApertoInCassa[]> {
    if (!(await tavoliApertiAccesi(tenantId))) return [];
    const rs = await queryWithRetry(
        `SELECT table_id, coperti, totale_cents, aperta_da, libero_previsto_at
           FROM passepartout_tavoli_aperti
          WHERE tenant_id = $1 AND visto_at > now() - make_interval(mins => ${SCADENZA_MIN})
          ORDER BY table_id`,
        [tenantId]
    );
    return rs.rows.map((r: any) => ({
        table_id: Number(r.table_id),
        coperti: r.coperti == null ? null : Number(r.coperti),
        totale_cents: Number(r.totale_cents) || 0,
        aperta_da: r.aperta_da ? new Date(r.aperta_da).toISOString() : null,
        libero_previsto_at: new Date(r.libero_previsto_at).toISOString(),
    }));
}

const impronta = (t: TavoloApertoInCassa[]) =>
    JSON.stringify(t.map((x) => [x.table_id, x.coperti, x.totale_cents]));
const ultimeImpronte = new Map<number, string>();

/** Una lettura per un ristorante, DENTRO il suo contesto tenant. */
export async function aggiornaTavoliAperti(tenantId: number): Promise<TavoloApertoInCassa[] | null> {
    if (!(await tavoliApertiAccesi(tenantId))) return null;
    if (!(await isFeatureEnabledForTenant(tenantId, 'passepartout'))) return null;
    if (!passepartoutAgentSupports(tenantId, CAPACITA)) return null;
    let aperte: PassepartoutComandaAperta[];
    try {
        aperte = await callPassepartout<PassepartoutComandaAperta[]>(tenantId, 'comandeAperte', {}, 60_000);
    } catch (err) {
        if (!(err instanceof PassepartoutBridgeError)) throw err;
        return null;
    }
    const tav = await queryWithRetry(
        `SELECT table_id, pp_sala, pp_tavolo FROM passepartout_tavoli WHERE tenant_id = $1 AND confermato`,
        [tenantId]
    );
    const perNome = new Map<string, number>();
    const perSoloNome = new Map<string, number[]>();
    for (const r of tav.rows) {
        perNome.set(`${r.pp_sala}\u0000${r.pp_tavolo}`, Number(r.table_id));
        perSoloNome.set(r.pp_tavolo, [...(perSoloNome.get(r.pp_tavolo) ?? []), Number(r.table_id)]);
    }
    const viste: number[] = [];
    for (const c of aperte) {
        // Con la sala si abbina esatto; senza, solo se il nome è univoco.
        const soloNome = perSoloNome.get(c.tavolo) ?? [];
        const tableId = c.sala ? perNome.get(`${c.sala}\u0000${c.tavolo}`) : (soloNome.length === 1 ? soloNome[0] : undefined);
        if (tableId == null) continue;
        viste.push(c.idComanda);
        await queryWithRetry(
            `INSERT INTO passepartout_tavoli_aperti
                (tenant_id, pp_comanda_id, table_id, coperti, totale_cents, aperta_da, libero_previsto_at, visto_at)
             VALUES ($1, $2, $3, $4, $5,
                     CASE WHEN $6::text IS NULL THEN NULL
                          WHEN $6::text ~ '(Z|[+-][0-9]{2}:[0-9]{2})$' THEN $6::timestamptz
                          ELSE ($6::timestamp AT TIME ZONE '${TZ_CASSA}') END,
                     now(), now())
             ON CONFLICT (tenant_id, pp_comanda_id) DO UPDATE SET
                table_id = EXCLUDED.table_id, coperti = EXCLUDED.coperti, totale_cents = EXCLUDED.totale_cents,
                aperta_da = COALESCE(EXCLUDED.aperta_da, passepartout_tavoli_aperti.aperta_da), visto_at = now()`,
            [tenantId, c.idComanda, tableId, c.coperti, Math.round((c.totale || 0) * 100), c.aperta]
        );
    }
    // Liberazione prevista: apertura + durata del turno (90 a pranzo, 120 a
    // cena, come le prenotazioni), mai prima di adesso + 20 minuti — un
    // tavolo oltre la durata è ancora lì, e si libererà a momenti.
    await queryWithRetry(
        `UPDATE passepartout_tavoli_aperti
            SET libero_previsto_at = GREATEST(
                    COALESCE(aperta_da, now()) + make_interval(mins =>
                        CASE WHEN EXTRACT(HOUR FROM COALESCE(aperta_da, now()) AT TIME ZONE '${TZ_CASSA}') < 16 THEN 90 ELSE 120 END),
                    now() + interval '20 minutes')
          WHERE tenant_id = $1`,
        [tenantId]
    );
    // Chiuse in cassa da una lettura all'altra.
    await queryWithRetry(
        `DELETE FROM passepartout_tavoli_aperti WHERE tenant_id = $1 AND NOT (pp_comanda_id = ANY($2::int[]))`,
        [tenantId, viste]
    );
    const elenco = await elencoTavoliAperti(tenantId);
    const imp = impronta(elenco);
    if (ultimeImpronte.get(tenantId) !== imp) {
        ultimeImpronte.set(tenantId, imp);
        deps?.broadcast(tenantId, elenco);
    }
    return elenco;
}

let timer: ReturnType<typeof setInterval> | null = null;
let giroInCorso = false;

export function startPassepartoutTavoliApertiSync(d: TavoliApertiDeps): void {
    deps = d;
    if (timer) return;
    const ms = Number(process.env.PASSEPARTOUT_TAVOLI_SWEEP_MS) || 60_000;
    timer = setInterval(() => {
        void giro().catch((err) => console.error('[passepartout] tavoli aperti in cassa:', err?.message || err));
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
}

async function giro(): Promise<void> {
    if (giroInCorso) return;
    giroInCorso = true;
    try {
        // Righe di agenti spariti: la sala non deve vederle per sempre.
        // rls-bypass: pulizia per età su tutti i ristoranti, nessun dato restituito
        const scadute = await runAsPlatform(() => queryWithRetry(
            `DELETE FROM passepartout_tavoli_aperti WHERE visto_at < now() - make_interval(mins => ${SCADENZA_MIN})
             RETURNING tenant_id`
        ));
        for (const t of new Set(scadute.rows.map((r: any) => Number(r.tenant_id)))) {
            ultimeImpronte.delete(t);
            deps?.broadcast(t, []);
        }
        const pronti = connectedPassepartoutTenants().filter((t) => passepartoutAgentSupports(t, CAPACITA));
        if (pronti.length === 0) return;
        // rls-bypass: solo l'elenco dei ristoranti con i tavoli aperti accesi; ognuno si lavora nel suo contesto tenant
        const rs = await runAsPlatform(() => queryWithRetry(
            `SELECT tenant_id FROM passepartout_config WHERE tavoli_aperti_enabled AND tenant_id = ANY($1::bigint[])`,
            [pronti]
        ));
        for (const row of rs.rows) {
            const tenantId = Number(row.tenant_id);
            await runWithTenantContext(tenantId, () => aggiornaTavoliAperti(tenantId));
        }
    } finally {
        giroInCorso = false;
    }
}
