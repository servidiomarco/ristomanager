// Le rotte delle campagne, sotto /whatsapp/campaigns. Le crea e le manda chi
// ha il permesso campaigns:manage (titolare e direzione); servono la
// modalità legale «avanzata», le campagne accese nelle Impostazioni e il
// template approvato. Il costo si conferma esplicitamente: la conferma porta
// la stima che la persona ha visto, e se nel frattempo è cambiata si rifiuta.

import express from 'express';
import { authenticate, requirePermission } from '../../../auth/authMiddleware.js';
import { queryWithRetry, withTenant } from '../../../db.js';
import { getCampaignsPolicy } from '../settings.js';
import { normalizeSegment, segmentRecipients } from './segments.js';
import { campaignUnitCostCents, estimateCostCents } from './pricing.js';
import { campaignDeps, campaignTemplateReady, monthSpentCents } from './send.js';

const MESSAGE_MAX = 600;

export function createCampaignsRouter(gate: express.RequestHandler): express.Router {
    const router = express.Router();
    const manage = [authenticate, requirePermission('campaigns:manage'), gate];

    /** Cosa manca per poter mandare: la pagina lo dice prima del tasto. */
    const readiness = async (tenantId: number) => {
        const policy = await getCampaignsPolicy(tenantId);
        const deps = campaignDeps();
        return {
            enabled: policy.enabled,
            legal_ok: deps ? await deps.marketingAllowed(tenantId) : false,
            template_ready: campaignTemplateReady(tenantId),
            unit_cost_cents: campaignUnitCostCents(),
            month_spent_cents: await monthSpentCents(tenantId),
            monthly_budget_cents: policy.monthly_budget_eur * 100,
            pause_days: policy.pause_days,
            send_window: [policy.send_from_hour, policy.send_to_hour],
        };
    };

    router.get('/', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const list = await queryWithRetry(
                `SELECT c.id, c.name, c.message, c.segment, c.status, c.pause_reason, c.recipients_count, c.estimated_cost_cents,
                        c.created_at, c.confirmed_at, c.finished_at,
                        count(r.*) FILTER (WHERE r.status = 'sent')::int AS sent,
                        count(r.*) FILTER (WHERE r.status = 'skipped')::int AS skipped,
                        count(r.*) FILTER (WHERE r.status = 'failed')::int AS failed,
                        count(r.*) FILTER (WHERE r.status IN ('pending', 'sending'))::int AS waiting
                   FROM campaigns c LEFT JOIN campaign_recipients r ON r.campaign_id = c.id
                  WHERE c.tenant_id = $1
                  GROUP BY c.id ORDER BY c.created_at DESC LIMIT 50`,
                [tenantId]
            );
            res.json({ campaigns: list.rows, readiness: await readiness(tenantId) });
        } catch (err: any) {
            console.error('GET /whatsapp/campaigns error:', err);
            res.status(500).json({ error: 'Errore nel leggere le campagne' });
        }
    });

    /** Quanti riceverebbero, chi (i primi), quanto costerebbe. */
    router.post('/preview', ...manage, async (req, res) => {
        try {
            const segment = normalizeSegment(req.body?.segment);
            if (!segment) return res.status(400).json({ error: 'invalid_segment' });
            const policy = await getCampaignsPolicy(req.tenantId!);
            const recipients = await segmentRecipients(req.tenantId!, segment, policy.pause_days);
            res.json({
                count: recipients.length,
                sample: recipients.slice(0, 5).map(r => r.name).filter(Boolean),
                estimated_cost_cents: estimateCostCents(recipients.length),
            });
        } catch (err: any) {
            console.error('POST /whatsapp/campaigns/preview error:', err);
            res.status(500).json({ error: "Errore nel calcolare l'anteprima" });
        }
    });

    router.post('/', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 120) : '';
            const message = typeof req.body?.message === 'string' ? req.body.message.replace(/\s+/g, ' ').trim() : '';
            const segment = normalizeSegment(req.body?.segment);
            if (!name) return res.status(400).json({ error: 'missing_name', message: 'Dai un nome alla campagna' });
            if (!message || message.length > MESSAGE_MAX) return res.status(400).json({ error: 'invalid_message', message: `Il testo va da 1 a ${MESSAGE_MAX} caratteri` });
            if (!segment) return res.status(400).json({ error: 'invalid_segment' });
            const policy = await getCampaignsPolicy(tenantId);
            const count = (await segmentRecipients(tenantId, segment, policy.pause_days)).length;
            const r = await queryWithRetry(
                `INSERT INTO campaigns (tenant_id, name, message, segment, recipients_count, estimated_cost_cents, created_by_user_id)
                 VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING *`,
                [tenantId, name, message, JSON.stringify(segment), count, estimateCostCents(count), req.user?.userId ?? null]
            );
            res.status(201).json({ campaign: r.rows[0] });
        } catch (err: any) {
            console.error('POST /whatsapp/campaigns error:', err);
            res.status(500).json({ error: 'Errore nel creare la campagna' });
        }
    });

    /** Il via: destinatari fissati adesso, costo confermato. */
    router.post('/:id/start', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = Number(req.params.id);
            const c = (await queryWithRetry(`SELECT * FROM campaigns WHERE id = $1 AND tenant_id = $2`, [id, tenantId])).rows[0];
            if (!c) return res.status(404).json({ error: 'not_found' });
            if (c.status !== 'draft' && c.status !== 'paused') return res.status(409).json({ error: 'not_startable', status: c.status });
            const ready = await readiness(tenantId);
            if (!ready.legal_ok) return res.status(409).json({ error: 'marketing_disabled', message: 'Serve la modalità legale avanzata (Impostazioni › Privacy).' });
            if (!ready.enabled) return res.status(409).json({ error: 'campaigns_disabled', message: 'Accendi le campagne in Impostazioni › WhatsApp.' });
            if (!ready.template_ready) return res.status(409).json({ error: 'template_missing', message: 'Il template della campagna non è ancora approvato.' });

            if (c.status === 'paused') {
                await queryWithRetry(`UPDATE campaigns SET status = 'sending', pause_reason = NULL WHERE id = $1`, [id]);
                return res.json({ ok: true, resumed: true });
            }
            const policy = await getCampaignsPolicy(tenantId);
            const recipients = await segmentRecipients(tenantId, normalizeSegment(c.segment) ?? {}, policy.pause_days);
            const estimate = estimateCostCents(recipients.length);
            // La persona ha confermato una cifra: se i destinatari sono
            // cambiati da allora, la rivede prima che parta qualcosa.
            if (Number(req.body?.confirm_cost_cents) !== estimate) {
                // La cifra nuova resta sulla bozza: è quella che si conferma al prossimo tocco.
                await queryWithRetry(`UPDATE campaigns SET recipients_count = $2, estimated_cost_cents = $3 WHERE id = $1`, [id, recipients.length, estimate]);
                return res.status(409).json({ error: 'estimate_changed', recipients: recipients.length, estimated_cost_cents: estimate });
            }
            if (recipients.length === 0) return res.status(409).json({ error: 'no_recipients' });
            await withTenant(tenantId, async client => {
                for (const r of recipients) {
                    await client.query(
                        `INSERT INTO campaign_recipients (tenant_id, campaign_id, customer_id, name, phone, phone_digits)
                         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (campaign_id, phone_digits) DO NOTHING`,
                        [tenantId, id, r.customer_id, r.name, r.phone, r.phone_digits]
                    );
                }
                await client.query(
                    `UPDATE campaigns SET status = 'sending', recipients_count = $2, estimated_cost_cents = $3,
                            confirmed_at = NOW(), confirmed_by_user_id = $4
                      WHERE id = $1`,
                    [id, recipients.length, estimate, req.user?.userId ?? null]
                );
            });
            res.json({ ok: true, recipients: recipients.length, estimated_cost_cents: estimate });
        } catch (err: any) {
            console.error('POST /whatsapp/campaigns/start error:', err);
            res.status(500).json({ error: 'Errore nel far partire la campagna' });
        }
    });

    router.post('/:id/cancel', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = Number(req.params.id);
            const upd = await queryWithRetry(
                `UPDATE campaigns SET status = 'cancelled', finished_at = NOW()
                  WHERE id = $1 AND tenant_id = $2 AND status IN ('draft', 'sending', 'paused') RETURNING id`,
                [id, tenantId]
            );
            if (!upd.rowCount) return res.status(409).json({ error: 'not_cancellable' });
            await queryWithRetry(
                `UPDATE campaign_recipients SET status = 'skipped', skip_reason = 'campagna annullata'
                  WHERE campaign_id = $1 AND tenant_id = $2 AND status = 'pending'`,
                [id, tenantId]
            );
            res.json({ ok: true });
        } catch (err: any) {
            console.error('POST /whatsapp/campaigns/cancel error:', err);
            res.status(500).json({ error: "Errore nell'annullare la campagna" });
        }
    });

    return router;
}
