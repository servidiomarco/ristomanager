// A chi va una campagna. Solo clienti in rubrica col consenso al marketing,
// senza revoca, non in blacklist, con un cellulare; mai chi ha un no-show
// negli ultimi 90 giorni né chi ha ricevuto una campagna da meno di N
// giorni. Sopra questo, i filtri della campagna: da quanto non torna,
// quante volte è venuto, solo VIP, la lingua.

import { queryWithRetry } from '../../../db.js';
import { PHONE_MATCH_KEY_SQL } from '../../../utils/text.js';

export interface CampaignSegment {
    /** Non torna da almeno N giorni (ed è venuto almeno una volta). */
    last_visit_days_min?: number | null;
    /** Almeno N visite. */
    min_visits?: number | null;
    vip_only?: boolean;
    /** Solo chi ha questa lingua in rubrica (it di serie). */
    language?: 'it' | 'en' | null;
}

const intOrNull = (v: unknown, min: number, max: number): number | null | undefined => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) return undefined;
    return n;
};

/** Il segmento validato; null se un valore è fuori dai limiti. */
export function normalizeSegment(raw: unknown): CampaignSegment | null {
    const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const days = intOrNull(r.last_visit_days_min, 1, 3650);
    const visits = intOrNull(r.min_visits, 1, 1000);
    if (days === undefined || visits === undefined) return null;
    if (r.vip_only !== undefined && typeof r.vip_only !== 'boolean') return null;
    const language = r.language === 'it' || r.language === 'en' ? r.language : null;
    if (r.language !== undefined && r.language !== null && r.language !== '' && language === null) return null;
    return { last_visit_days_min: days, min_visits: visits, vip_only: r.vip_only === true, language };
}

export interface SegmentRecipient {
    customer_id: number;
    name: string | null;
    phone: string;
    phone_digits: string;
}

/** I destinatari del segmento adesso, uno per numero. */
export async function segmentRecipients(tenantId: number, segment: CampaignSegment, pauseDays: number): Promise<SegmentRecipient[]> {
    // Le visite si contano una volta per numero (GROUP BY sulla chiave), non
    // per scheda: un join riga per riga sulla chiave non userebbe indici.
    const r = await queryWithRetry(
        `WITH base AS (
             SELECT c.id, c.name, c.phone, COALESCE(NULLIF(c.language, ''), 'it') AS language, c.is_vip,
                    ${PHONE_MATCH_KEY_SQL('c.phone')} AS k
               FROM customers c
              WHERE c.tenant_id = $1
                AND c.consent_marketing = TRUE
                AND c.marketing_opt_out_at IS NULL
                AND NOT COALESCE(c.is_blacklisted, false)
                AND length(regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g')) >= 8
         ), visite AS (
             SELECT ${PHONE_MATCH_KEY_SQL('r.phone')} AS k,
                    count(*) FILTER (WHERE r.reservation_time < now()
                        AND COALESCE(r.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED', 'NO_SHOW')) AS visits,
                    max(r.reservation_time) FILTER (WHERE r.reservation_time < now()
                        AND COALESCE(r.reservation_status, 'CONFIRMED') NOT IN ('CANCELLED', 'DECLINED', 'NO_SHOW')) AS last_visit,
                    count(*) FILTER (WHERE r.reservation_status = 'NO_SHOW' AND r.reservation_time > now() - interval '90 days') AS no_shows
               FROM reservations r
              WHERE r.tenant_id = $1 AND r.phone IS NOT NULL AND r.phone <> ''
              GROUP BY 1
         )
         SELECT DISTINCT ON (b.k) b.id, b.name, b.phone, b.k
           FROM base b
           LEFT JOIN visite v ON v.k = b.k
          WHERE COALESCE(v.no_shows, 0) = 0
            AND ($2::int IS NULL OR v.last_visit < now() - ($2::int * interval '1 day'))
            AND ($3::int IS NULL OR COALESCE(v.visits, 0) >= $3::int)
            AND (NOT $4::boolean OR b.is_vip)
            AND ($5::text IS NULL OR b.language = $5::text)
            AND NOT EXISTS (
                SELECT 1 FROM campaign_recipients cr
                 WHERE cr.tenant_id = $1 AND cr.phone_digits = b.k AND cr.status = 'sent'
                   AND cr.sent_at > now() - ($6::int * interval '1 day'))
          ORDER BY b.k, b.id`,
        [tenantId, segment.last_visit_days_min ?? null, segment.min_visits ?? null, segment.vip_only === true,
         segment.language ?? null, pauseDays]
    );
    return r.rows.map((x: any) => ({ customer_id: Number(x.id), name: x.name ?? null, phone: String(x.phone), phone_digits: String(x.k) }));
}
