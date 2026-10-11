// I consumi WhatsApp del mese, per la scheda «Consumi» delle Impostazioni:
// quanti messaggi sono arrivati e partiti, quanti a mano e quanti
// automatici, quanti non sono arrivati, e quanto è costata l'AI.
//
// Il costo dei messaggi non c'è ancora: Twilio non lo manda con l'esito, e
// Meta lo manda solo dalla Fase 12 (campo `pricing` degli stati). Qui si
// contano i messaggi; il prezzo arriva con le campagne (Fase 11).

import { queryWithRetry } from '../../db.js';
import { getTenantLocale, sqlTimeZone } from '../tenantLocale.js';
import { COST_USD_SQL, UNPRICED_SQL, USD_EUR } from '../aiPricing.js';

/** Le funzioni AI che lavorano sui messaggi WhatsApp e SMS. */
export const WHATSAPP_AI_FEATURES = ['whatsapp_agent', 'whatsapp_extract', 'suggest_reply'];

export interface WhatsAppUsage {
    /** Primo giorno del mese, YYYY-MM-DD, nel fuso del locale. */
    month: string;
    whatsapp: {
        inbound: number;
        outboundStaff: number;
        outboundAutomatic: number;
        failed: number;
        /** I messaggi automatici per tipo: confirmation, reminder, review_request… */
        byKind: Record<string, number>;
    };
    sms: { outbound: number; failed: number };
    ai: { runs: number; costUsd: number; costEur: number; unpriced: number };
}

export async function whatsappUsage(tenantId: number): Promise<WhatsAppUsage> {
    const tz = sqlTimeZone((await getTenantLocale(tenantId)).timezone);
    // Il mese si conta nel fuso del ristorante: alle 00:30 del primo del
    // mese a Roma il mese UTC è ancora quello prima.
    const since = `(date_trunc('month', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

    const [msg, kinds, ai, month] = await Promise.all([
        queryWithRetry(
            `SELECT
                count(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'inbound')::int AS wa_in,
                count(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'outbound' AND (kind IS NULL OR kind = 'staff'))::int AS wa_staff,
                count(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'outbound' AND kind IS NOT NULL AND kind <> 'staff')::int AS wa_auto,
                count(*) FILTER (WHERE channel = 'whatsapp' AND direction = 'outbound' AND status IN ('failed', 'undelivered'))::int AS wa_failed,
                count(*) FILTER (WHERE channel = 'sms' AND direction = 'outbound')::int AS sms_out,
                count(*) FILTER (WHERE channel = 'sms' AND direction = 'outbound' AND status IN ('failed', 'undelivered'))::int AS sms_failed
               FROM outbound_messages
              WHERE tenant_id = $1 AND channel IN ('whatsapp', 'sms') AND sent_at >= ${since}`,
            [tenantId]
        ),
        queryWithRetry(
            `SELECT kind, count(*)::int AS n
               FROM outbound_messages
              WHERE tenant_id = $1 AND channel = 'whatsapp' AND direction = 'outbound'
                AND kind IS NOT NULL AND sent_at >= ${since}
              GROUP BY kind`,
            [tenantId]
        ),
        queryWithRetry(
            `SELECT count(*)::int AS runs,
                    COALESCE(sum(${COST_USD_SQL}), 0)::float AS cost_usd,
                    count(*) FILTER (WHERE ${UNPRICED_SQL})::int AS unpriced
               FROM ai_token_usage
              WHERE tenant_id = $1 AND feature = ANY($2::text[]) AND created_at >= ${since}`,
            [tenantId, WHATSAPP_AI_FEATURES]
        ),
        queryWithRetry(`SELECT to_char(date_trunc('month', now() AT TIME ZONE ${tz}), 'YYYY-MM-DD') AS m`),
    ]);
    const m = msg.rows[0] ?? {};
    const a = ai.rows[0] ?? {};
    const costUsd = Number(a.cost_usd) || 0;
    return {
        month: month.rows[0]?.m ?? '',
        whatsapp: {
            inbound: m.wa_in ?? 0,
            outboundStaff: m.wa_staff ?? 0,
            outboundAutomatic: m.wa_auto ?? 0,
            failed: m.wa_failed ?? 0,
            byKind: Object.fromEntries(kinds.rows.map((r: any) => [String(r.kind), Number(r.n)])),
        },
        sms: { outbound: m.sms_out ?? 0, failed: m.sms_failed ?? 0 },
        ai: {
            runs: a.runs ?? 0,
            costUsd: Math.round(costUsd * 100) / 100,
            costEur: Math.round(costUsd * USD_EUR * 100) / 100,
            unpriced: a.unpriced ?? 0,
        },
    };
}
