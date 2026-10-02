// Consumi di Sofia per ristorante: il piano effettivo (default + riga
// voice_plans) e il mese in corso misurato su voice_calls.
//
// Il conto ElevenLabs è unico per tutti i tenant: il consumo del singolo
// ristorante esiste solo qui, sommando le chiamate salvate dal post-call.

import { queryWithRetry } from '../db.js';
import { getTenantLocale, sqlTimeZone } from './tenantLocale.js';
import {
    VOICE_PLAN_DEFAULTS, VOICE_ALERT_PERCENTS_DEFAULT, VOICE_ALERT_PERCENT_OPTIONS,
    BILLABLE_SECONDS_SQL, billableMinutes, extraCharge, estimatedRevenueCents,
    type VoicePlan,
} from './voicePlan.js';
import { USD_EUR } from './aiPricing.js';

export interface EffectiveVoicePlan extends VoicePlan {
    /** true se almeno un valore del listino viene dalla riga voice_plans
     *  del tenant (le soglie degli avvisi non contano: non sono prezzo). */
    custom: boolean;
    /** Percentuali dei minuti inclusi a cui avvisare, crescenti. */
    alertPercents: number[];
}

/** Piano effettivo da una riga voice_plans (o nessuna): NULL = default. */
export function mergeVoicePlan(row: any): EffectiveVoicePlan {
    const pick = (v: unknown, fallback: number) => (v === null || v === undefined ? fallback : Number(v));
    return {
        priceCents: pick(row?.price_cents, VOICE_PLAN_DEFAULTS.priceCents),
        includedMinutes: pick(row?.included_minutes, VOICE_PLAN_DEFAULTS.includedMinutes),
        overageCentsPerMinute: pick(row?.overage_cents_per_minute, VOICE_PLAN_DEFAULTS.overageCentsPerMinute),
        extraCapCents: pick(row?.extra_cap_cents, VOICE_PLAN_DEFAULTS.extraCapCents),
        custom: Boolean(row) && [row.price_cents, row.included_minutes, row.overage_cents_per_minute, row.extra_cap_cents]
            .some(v => v !== null && v !== undefined),
        alertPercents: Array.isArray(row?.alert_percents)
            ? row.alert_percents.map(Number).sort((a: number, b: number) => a - b)
            : [...VOICE_ALERT_PERCENTS_DEFAULT],
    };
}

export async function getVoicePlan(tenantId: number): Promise<EffectiveVoicePlan> {
    const r = await queryWithRetry(
        `SELECT price_cents, included_minutes, overage_cents_per_minute, extra_cap_cents, alert_percents
           FROM voice_plans WHERE tenant_id = $1`,
        [tenantId]
    );
    return mergeVoicePlan(r.rows[0]);
}

export interface VoiceMonthUsage {
    /** Primo giorno del mese nel fuso del ristorante, YYYY-MM-DD. */
    month: string;
    calls: number;
    billable_minutes: number;
    projected_minutes: number;
    extra_minutes: number;
    /** Extra del mese entro il tetto, in centesimi. */
    extra_cents: number;
    /** Gli extra hanno superato il tetto scelto dal ristoratore. */
    over_cap: boolean;
    /** Prenotazioni create da Sofia nel mese (source = VOICE). */
    bookings: number;
    cost_usd: number;
    cost_eur_cents: number;
    priced_calls: number;
    estimated_revenue_cents: number;
    projected_revenue_cents: number;
    daily: { day: string; calls: number; billable_minutes: number }[];
}

export async function getVoiceMonthUsage(tenantId: number, plan?: VoicePlan): Promise<VoiceMonthUsage> {
    const effectivePlan = plan ?? await getVoicePlan(tenantId);
    const TZ = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
    const MONTH_START = `(date_trunc('month', NOW() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;

    const [totals, daily, bookings] = await Promise.all([
        queryWithRetry(
            `SELECT COUNT(*)::int AS calls,
                    COALESCE(SUM(${BILLABLE_SECONDS_SQL}),0)::int AS billable_seconds,
                    COALESCE(SUM(cost_usd),0)::float AS cost_usd,
                    COUNT(cost_usd)::int AS priced_calls,
                    to_char(date_trunc('month', NOW() AT TIME ZONE ${TZ}), 'YYYY-MM-DD') AS month,
                    EXTRACT(DAY FROM (NOW() AT TIME ZONE ${TZ}))::int AS day_of_month,
                    EXTRACT(DAY FROM (date_trunc('month', NOW() AT TIME ZONE ${TZ}) + INTERVAL '1 month - 1 day'))::int AS days_in_month
               FROM voice_calls
              WHERE tenant_id = $1 AND created_at >= ${MONTH_START}`,
            [tenantId]
        ),
        queryWithRetry(
            `SELECT to_char(created_at AT TIME ZONE ${TZ}, 'YYYY-MM-DD') AS day,
                    COUNT(*)::int AS calls,
                    COALESCE(SUM(${BILLABLE_SECONDS_SQL}),0)::int AS billable_seconds
               FROM voice_calls
              WHERE tenant_id = $1 AND created_at >= ${MONTH_START}
              GROUP BY day ORDER BY day`,
            [tenantId]
        ),
        queryWithRetry(
            `SELECT COUNT(*)::int AS n FROM reservations
              WHERE tenant_id = $1 AND source = 'VOICE' AND created_at >= ${MONTH_START}`,
            [tenantId]
        ),
    ]);

    const t = totals.rows[0];
    const minutes = billableMinutes(Number(t.billable_seconds));
    // Proiezione lineare sul ritmo dei giorni trascorsi: a inizio mese è
    // grezza, ma è quella che serve per l'avviso "a questo ritmo sfori".
    const projected = t.day_of_month > 0 ? Math.round(minutes / t.day_of_month * t.days_in_month) : minutes;
    const extra = extraCharge(minutes, effectivePlan);
    const costUsd = Number(t.cost_usd);

    return {
        month: t.month,
        calls: t.calls,
        billable_minutes: minutes,
        projected_minutes: projected,
        extra_minutes: extra.extraMinutes,
        extra_cents: extra.extraCents,
        over_cap: extra.overCap,
        bookings: bookings.rows[0]?.n ?? 0,
        cost_usd: costUsd,
        cost_eur_cents: Math.round(costUsd * USD_EUR * 100),
        priced_calls: t.priced_calls,
        estimated_revenue_cents: estimatedRevenueCents(minutes, effectivePlan),
        projected_revenue_cents: estimatedRevenueCents(projected, effectivePlan),
        daily: daily.rows.map((d: any) => ({
            day: d.day,
            calls: d.calls,
            billable_minutes: billableMinutes(Number(d.billable_seconds)),
        })),
    };
}

// ---------------------------------------------------------------------------
// Avvisi di consumo
// ---------------------------------------------------------------------------

export type VoiceUsageThreshold =
    | `included_${(typeof VOICE_ALERT_PERCENT_OPTIONS)[number]}`
    | 'cap_80' | 'cap_100';

export interface VoiceUsageAlert {
    threshold: VoiceUsageThreshold;
    title: string;
    body: string;
}

const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`;

/** Percentuale di una soglia sui minuti inclusi ('included_90' → 90);
 *  null per quelle sul tetto. */
const includedPercentOf = (threshold: string): number | null => {
    const m = /^included_(\d+)$/.exec(threshold);
    return m ? Number(m[1]) : null;
};

/** Le soglie superate dal mese, dalla più grave: il testo è quello della
 *  notifica al ristoratore. Sui minuti inclusi conta solo la più alta fra
 *  quelle scelte dal ristoratore: una chiamata che porta dal 75% al 95% non
 *  manda due avvisi. */
export function crossedVoiceThresholds(
    usage: VoiceMonthUsage,
    plan: VoicePlan,
    alertPercents: number[] = VOICE_ALERT_PERCENTS_DEFAULT,
): VoiceUsageAlert[] {
    const out: VoiceUsageAlert[] = [];
    const used = usage.billable_minutes;
    const incl = plan.includedMinutes;
    const rawExtraCents = usage.extra_minutes * plan.overageCentsPerMinute;
    if (plan.extraCapCents > 0 && rawExtraCents >= plan.extraCapCents) {
        out.push({
            threshold: 'cap_100',
            title: 'Sofia: tetto dei minuti extra raggiunto',
            body: `Gli extra di questo mese sono arrivati a ${eur(plan.extraCapCents)}, il tetto impostato. Alzalo in Impostazioni → AI → Minuti di Sofia per continuare a ricevere prenotazioni al telefono.`,
        });
    } else if (plan.extraCapCents > 0 && rawExtraCents >= plan.extraCapCents * 0.8) {
        out.push({
            threshold: 'cap_80',
            title: 'Sofia: extra all\'80% del tetto',
            body: `Minuti extra per ${eur(rawExtraCents)} su un tetto di ${eur(plan.extraCapCents)}. Se serve, alzalo in Impostazioni → AI → Minuti di Sofia.`,
        });
    }
    const reached = incl > 0
        ? [...alertPercents].sort((a, b) => b - a).find(p => used * 100 >= incl * p)
        : undefined;
    if (reached === 100) {
        out.push({
            threshold: 'included_100',
            title: 'Sofia: minuti inclusi esauriti',
            body: `Usati ${used} minuti su ${incl} inclusi. Da ora ogni minuto costa ${eur(plan.overageCentsPerMinute)}, fino al tetto di ${eur(plan.extraCapCents)}.`,
        });
    } else if (reached !== undefined) {
        out.push({
            threshold: `included_${reached}` as VoiceUsageThreshold,
            title: `Sofia: ${reached}% dei minuti inclusi`,
            body: `Usati ${used} minuti su ${incl} inclusi questo mese, ne restano ${incl - used}${usage.projected_minutes > incl ? ` — a questo ritmo arrivi a circa ${usage.projected_minutes}` : ''}.`,
        });
    }
    return out;
}

/**
 * Controlla le soglie dopo una chiamata e restituisce SOLO gli avvisi nuovi
 * del mese: la chiave primaria di voice_usage_alerts fa da lucchetto, quindi
 * due post-call quasi simultanei non mandano la stessa notifica due volte.
 */
export async function claimNewVoiceUsageAlerts(tenantId: number): Promise<{ alerts: VoiceUsageAlert[]; usage: VoiceMonthUsage } | null> {
    const plan = await getVoicePlan(tenantId);
    const usage = await getVoiceMonthUsage(tenantId, plan);
    const crossed = crossedVoiceThresholds(usage, plan, plan.alertPercents);
    if (crossed.length === 0) return null;
    // Se a metà mese il ristoratore toglie la soglia già scattata (es. il
    // 90%), la più alta rimasta sotto (l'80%) non deve arrivare dopo: sui
    // minuti inclusi si avvisa solo sopra l'ultimo avviso mandato.
    const sent = await queryWithRetry(
        `SELECT threshold FROM voice_usage_alerts WHERE tenant_id = $1 AND month = $2::date`,
        [tenantId, usage.month]
    );
    const lastIncludedSent = Math.max(0, ...sent.rows.map((r: any) => includedPercentOf(r.threshold) ?? 0));
    const claimed: VoiceUsageAlert[] = [];
    for (const alert of crossed) {
        const pct = includedPercentOf(alert.threshold);
        if (pct !== null && pct <= lastIncludedSent) continue;
        const r = await queryWithRetry(
            `INSERT INTO voice_usage_alerts (tenant_id, month, threshold)
             VALUES ($1, $2::date, $3)
             ON CONFLICT DO NOTHING
             RETURNING threshold`,
            [tenantId, usage.month, alert.threshold]
        );
        if (r.rowCount) claimed.push(alert);
    }
    return claimed.length ? { alerts: claimed, usage } : null;
}
