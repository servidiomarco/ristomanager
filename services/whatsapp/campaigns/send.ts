// L'invio delle campagne: uno sweep (lock dedicato in server.ts) che manda
// a piccoli gruppi, nella fascia oraria del locale, dentro il tetto di spesa
// del mese. Ogni destinatario si prende in carico prima di mandare, e il
// consenso si ricontrolla all'ultimo momento: chi ha scritto «STOP» un
// minuto dopo la conferma della campagna non riceve niente.
//
// Il messaggio è il template MARKETING del catalogo (CAMPAIGN): {{1}} nome
// del cliente, {{2}} nome del locale, {{3}} il testo della campagna, e il
// tasto «Stop promozioni». Senza template approvato la campagna si mette in
// pausa e lo dice.

import { queryWithRetry, runWithTenantContext } from '../../../db.js';
import { PHONE_MATCH_KEY_SQL } from '../../../utils/text.js';
import { isEnglishGuest } from '../../../utils/language.js';
import { getTenantLocale } from '../../tenantLocale.js';
import { isServiceNode } from '../../topology.js';
import { sendWhatsAppText } from '../outbound.js';
import { pickTemplate } from '../templates/registry.js';
import { getCampaignsPolicy } from '../settings.js';
import { whatsappDeps } from '../deps.js';
import { campaignUnitCostCents } from './pricing.js';

export const CAMPAIGN_KIND = 'campaign';
export const CAMPAIGN_TEMPLATE_KEY = 'TWILIO_WA_CONTENT_SID_CAMPAIGN';
const BATCH = 20;

/** Quello che sta in server.ts. */
export interface CampaignDeps {
    businessName: (tenantId: number) => Promise<string>;
    /** La modalità legale «avanzata»: senza, niente marketing. */
    marketingAllowed: (tenantId: number) => Promise<boolean>;
}
let deps: CampaignDeps | null = null;
export function configureCampaigns(d: CampaignDeps): void {
    deps = d;
}
export const campaignDeps = (): CampaignDeps | null => deps;

/** Il template della campagna c'è per questo locale. */
export const campaignTemplateReady = (tenantId: number): boolean => !!pickTemplate(tenantId, CAMPAIGN_TEMPLATE_KEY, 'it');

/** La spesa delle campagne del mese, stimata dai messaggi partiti. */
export async function monthSpentCents(tenantId: number): Promise<number> {
    const tz = (await getTenantLocale(tenantId)).timezone;
    const r = await queryWithRetry(
        `SELECT count(*)::int AS n FROM campaign_recipients
          WHERE tenant_id = $1 AND status = 'sent'
            AND sent_at >= (date_trunc('month', now() AT TIME ZONE $2) AT TIME ZONE $2)`,
        [tenantId, tz]
    );
    return Math.ceil(Number(r.rows[0]?.n ?? 0) * campaignUnitCostCents());
}

async function pause(campaignId: number, reason: string) {
    await queryWithRetry(`UPDATE campaigns SET status = 'paused', pause_reason = $2 WHERE id = $1 AND status = 'sending'`, [campaignId, reason]);
}

function notify(tenantId: number, campaignId: number) {
    try { whatsappDeps().broadcastToAll(tenantId, 'campaign:updated', { id: campaignId }); } catch { /* best effort */ }
}

/** Lo sweep: tutte le campagne in invio, ognuna nel contesto del suo locale. */
export async function campaignsTick(): Promise<void> {
    if (isServiceNode || !deps) return;
    // Un destinatario rimasto «in invio» (processo riavviato a metà) non si
    // rimanda: meglio un messaggio in meno che uno doppio.
    await queryWithRetry(
        `UPDATE campaign_recipients SET status = 'failed', error = 'invio interrotto'
          WHERE status = 'sending' AND claimed_at < NOW() - interval '10 minutes'`
    );
    const campaigns = await queryWithRetry(`SELECT id, tenant_id FROM campaigns WHERE status = 'sending' ORDER BY id`);
    for (const c of campaigns.rows) {
        await runWithTenantContext(Number(c.tenant_id), () => sendBatch(Number(c.tenant_id), Number(c.id))).catch(err =>
            console.error('[campagne] giro fallito:', err?.message || err));
    }
}

async function sendBatch(tenantId: number, campaignId: number): Promise<void> {
    const policy = await getCampaignsPolicy(tenantId);
    if (!policy.enabled) return pause(campaignId, 'campagne spente nelle Impostazioni');
    const tz = (await getTenantLocale(tenantId)).timezone;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()));
    // Fuori fascia si aspetta, senza fermare la campagna.
    if (hour < policy.send_from_hour || hour >= policy.send_to_hour) return;
    if (!campaignTemplateReady(tenantId)) return pause(campaignId, 'template della campagna non approvato');

    const campaign = (await queryWithRetry(`SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2`, [campaignId, tenantId])).rows[0];
    if (!campaign || campaign.status !== 'sending') return;
    const unit = campaignUnitCostCents();
    let spent = await monthSpentCents(tenantId);
    const budget = policy.monthly_budget_eur * 100;
    if (spent + unit > budget) return pause(campaignId, 'tetto di spesa del mese raggiunto');

    const claimed = await queryWithRetry(
        `UPDATE campaign_recipients SET status = 'sending', claimed_at = NOW()
          WHERE id IN (SELECT id FROM campaign_recipients WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'pending'
                        ORDER BY id LIMIT ${BATCH} FOR UPDATE SKIP LOCKED)
          RETURNING *`,
        [campaignId, tenantId]
    );
    const businessName = await deps!.businessName(tenantId);
    for (const r of claimed.rows) {
        const finish = (status: 'sent' | 'skipped' | 'failed', extra: { reason?: string; error?: string; messageId?: number | null } = {}) =>
            queryWithRetry(
                `UPDATE campaign_recipients SET status = $2::text, skip_reason = $3, error = $4, outbound_message_id = $5,
                        sent_at = CASE WHEN $2::text = 'sent' THEN NOW() ELSE NULL END
                  WHERE id = $1`,
                [r.id, status, extra.reason ?? null, extra.error ?? null, extra.messageId ?? null]
            );
        if (spent + unit > budget) {
            // Il tetto si raggiunge a metà gruppo: chi resta torna in coda.
            await queryWithRetry(`UPDATE campaign_recipients SET status = 'pending', claimed_at = NULL WHERE id = $1`, [r.id]);
            continue;
        }
        // Il consenso adesso, non alla conferma della campagna.
        const ok = await queryWithRetry(
            `SELECT language FROM customers
              WHERE tenant_id = $1 AND ${PHONE_MATCH_KEY_SQL("COALESCE(phone, '')")} = $2
                AND consent_marketing = TRUE AND marketing_opt_out_at IS NULL AND NOT COALESCE(is_blacklisted, false)
              LIMIT 1`,
            [tenantId, r.phone_digits]
        );
        if (!ok.rows[0]) { await finish('skipped', { reason: 'consenso non più valido' }); continue; }
        const recent = await queryWithRetry(
            `SELECT 1 FROM campaign_recipients
              WHERE tenant_id = $1 AND phone_digits = $2 AND status = 'sent' AND id <> $3
                AND sent_at > NOW() - ($4::int * interval '1 day') LIMIT 1`,
            [tenantId, r.phone_digits, r.id, policy.pause_days]
        );
        if (recent.rowCount) { await finish('skipped', { reason: 'già contattato di recente' }); continue; }

        const english = isEnglishGuest(ok.rows[0].language);
        const picked = pickTemplate(tenantId, CAMPAIGN_TEMPLATE_KEY, english ? 'en' : 'it')!;
        const name = String(r.name || '').trim().split(/\s+/)[0] || (picked.english ? 'there' : '');
        try {
            const sent = await sendWhatsAppText(tenantId, r.phone, `${businessName}: ${campaign.message}`, null, {
                contentSid: picked.contentSid,
                contentVariables: { '1': name || '—', '2': businessName || '—', '3': String(campaign.message) },
            }, undefined, CAMPAIGN_KIND);
            let messageId: number | null = null;
            if (sent.sid) {
                messageId = (await queryWithRetry(`SELECT id FROM outbound_messages WHERE tenant_id = $1 AND provider_sid = $2 LIMIT 1`, [tenantId, sent.sid])).rows[0]?.id ?? null;
            }
            await finish('sent', { messageId });
            spent += unit;
        } catch (err: any) {
            await finish('failed', { error: String(err?.message || err).slice(0, 300) });
        }
    }

    const left = await queryWithRetry(
        `SELECT count(*)::int AS n FROM campaign_recipients WHERE campaign_id = $1 AND status IN ('pending', 'sending')`, [campaignId]);
    let changed = claimed.rows.length > 0;
    if (Number(left.rows[0].n) > 0 && spent + unit > budget) {
        await pause(campaignId, 'tetto di spesa del mese raggiunto');
        changed = true;
    } else if (Number(left.rows[0].n) === 0) {
        await queryWithRetry(`UPDATE campaigns SET status = 'done', finished_at = NOW() WHERE id = $1 AND status = 'sending'`, [campaignId]);
        changed = true;
    }
    // Solo quando qualcosa è cambiato: lo sweep gira ogni minuto.
    if (changed) notify(tenantId, campaignId);
}
