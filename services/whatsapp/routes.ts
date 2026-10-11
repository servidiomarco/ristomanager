// Le rotte del modulo WhatsApp, montate su /whatsapp: quello che serve alla
// sezione Impostazioni › WhatsApp. Le rotte dell'inbox e dell'agente
// (/messages/*) restano in server.ts finché le fasi dell'agente non le
// spostano qui.

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../auth/authMiddleware.js';
import { isFeatureEnabledForTenant } from '../entitlements.js';
import { envTenantIds, getSender, isSmsReady } from './config.js';
import { tenantWebhookToken } from './callbacks.js';
import { templateStatus } from './templates/status.js';
import { whatsappUsage } from './usage.js';
import { queryWithRetry } from '../../db.js';
import { phoneDigitsVariants, phoneMatchKey } from '../../utils/text.js';
import {
    getAgentPolicy, normalizeAgentPolicy, saveAgentPolicy,
    getRemindersPolicy, normalizeRemindersPolicy, saveRemindersPolicy,
    getEntryPolicy, normalizeEntryPolicy, saveEntryPolicy,
    getMediaPolicy, normalizeMediaPolicy, saveMediaPolicy,
    getTakeawayPolicy, normalizeTakeawayPolicy, saveTakeawayPolicy,
} from './settings.js';
import { isTranscriptionConfigured } from './media/transcribe.js';
import { simulateRun } from './agent/queue.js';
import { undoAutoAction, UNDOABLE_TOOLS } from './agent/autonomy.js';
import { whatsappDeps } from './deps.js';
import { LogService, ActivityAction, ResourceType } from '../../activityLogs/logService.js';

// L'add-on WhatsApp, chiuso se non si riesce a leggerlo: queste rotte
// mostrano numeri e costi di un canale che il locale potrebbe non avere.
const requireWhatsApp = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (await isFeatureEnabledForTenant(req.tenantId!, 'whatsapp')) return next();
    } catch (err: any) {
        console.error('[whatsapp] lettura add-on fallita:', err?.message || err);
    }
    res.status(403).json({ error: 'feature_not_enabled', feature: 'whatsapp' });
};

export function createWhatsAppRouter(): express.Router {
    const router = express.Router();
    const read = [authenticate, requirePermission('settings:view'), requireWhatsApp];

    /** Il numero del ristorante: chi lo gestisce, se manda, dove arrivano i webhook. */
    router.get('/status', ...read, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const sender = await getSender(tenantId);
            const token = await tenantWebhookToken(tenantId);
            // Come /settings/webhook-info: dietro il proxy l'host della
            // richiesta è il dominio del backend che i provider chiamano.
            const base = `${req.protocol}://${req.get('host')}`;
            res.json({
                connected: sender != null,
                provider: sender?.provider ?? null,
                source: sender?.source ?? null,
                phone: sender ? sender.from.replace(/^whatsapp:/, '') : null,
                shared_env_sender: envTenantIds().has(tenantId),
                sms_ready: isSmsReady(tenantId),
                webhooks: token ? {
                    inbound: `${base}/webhook/t/${token}/twilio-whatsapp`,
                    status: `${base}/webhook/t/${token}/twilio-whatsapp-status`,
                } : null,
            });
        } catch (err: any) {
            console.error('GET /whatsapp/status error:', err);
            res.status(500).json({ error: 'Errore nel leggere lo stato di WhatsApp' });
        }
    });

    /** Il catalogo dei template con lo stato di approvazione. */
    router.get('/templates', ...read, async (req, res) => {
        try {
            res.json({ templates: await templateStatus(req.tenantId!) });
        } catch (err: any) {
            console.error('GET /whatsapp/templates error:', err);
            res.status(500).json({ error: 'Errore nel leggere i template' });
        }
    });

    /** Messaggi e spesa AI del mese. */
    router.get('/usage', ...read, async (req, res) => {
        try {
            res.json(await whatsappUsage(req.tenantId!));
        } catch (err: any) {
            console.error('GET /whatsapp/usage error:', err);
            res.status(500).json({ error: 'Errore nel leggere i consumi' });
        }
    });

    // ── L'agente che parte da solo ──────────────────────────────────────

    const allSettings = async (tenantId: number) => {
        const [agent, reminders, entry, media, takeaway, takeawayAddon] = await Promise.all([
            getAgentPolicy(tenantId), getRemindersPolicy(tenantId), getEntryPolicy(tenantId), getMediaPolicy(tenantId),
            getTakeawayPolicy(tenantId), isFeatureEnabledForTenant(tenantId, 'takeaway').catch(() => false),
        ]);
        // transcription_ready: c'è la chiave ElevenLabs per trascrivere.
        // takeaway_available: il locale ha l'add-on asporto.
        return { agent, reminders, entry, media, takeaway, transcription_ready: isTranscriptionConfigured(), takeaway_available: takeawayAddon };
    };

    router.get('/settings', ...read, async (req, res) => {
        try {
            res.json(await allSettings(req.tenantId!));
        } catch (err: any) {
            console.error('GET /whatsapp/settings error:', err);
            res.status(500).json({ error: 'Errore nel leggere le impostazioni' });
        }
    });

    router.put('/settings', authenticate, requirePermission('settings:full'), requireWhatsApp, async (req, res) => {
        try {
            // Ogni sezione si salva solo se c'è: la card dell'agente non
            // tocca i promemoria, e viceversa. Prima si valida tutto.
            const tenantId = req.tenantId!;
            const body = req.body ?? {};
            const agent = body.agent !== undefined ? normalizeAgentPolicy(body.agent, await getAgentPolicy(tenantId)) : undefined;
            const reminders = body.reminders !== undefined ? normalizeRemindersPolicy(body.reminders, await getRemindersPolicy(tenantId)) : undefined;
            const entry = body.entry !== undefined ? normalizeEntryPolicy(body.entry, await getEntryPolicy(tenantId)) : undefined;
            const media = body.media !== undefined ? normalizeMediaPolicy(body.media, await getMediaPolicy(tenantId)) : undefined;
            const takeaway = body.takeaway !== undefined ? normalizeTakeawayPolicy(body.takeaway, await getTakeawayPolicy(tenantId)) : undefined;
            if (agent === null || reminders === null || entry === null || media === null || takeaway === null) {
                return res.status(400).json({ error: 'invalid_policy', message: 'Valori fuori dai limiti' });
            }
            if (agent) await saveAgentPolicy(tenantId, agent);
            if (reminders) await saveRemindersPolicy(tenantId, reminders);
            if (entry) await saveEntryPolicy(tenantId, entry);
            if (media) await saveMediaPolicy(tenantId, media);
            if (takeaway) await saveTakeawayPolicy(tenantId, takeaway);
            res.json(await allSettings(tenantId));
        } catch (err: any) {
            console.error('PUT /whatsapp/settings error:', err);
            res.status(500).json({ error: 'Errore nel salvare le impostazioni' });
        }
    });

    const thread = [authenticate, requirePermission('reservations:view'), requireWhatsApp];
    const threadWrite = [authenticate, requirePermission('reservations:full'), requireWhatsApp];

    /** Lo stato dell'agente su una conversazione: modalità, pausa, bozza
     *  pronta, proposta in attesa, ultimo giro. */
    router.get('/agent/thread/:phoneDigits', ...thread, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const key = phoneMatchKey(String(req.params.phoneDigits || ''));
            if (!key) return res.status(400).json({ error: 'numero non valido' });
            const [policy, state, draft, last, proposal, actions] = await Promise.all([
                getAgentPolicy(tenantId),
                queryWithRetry(`SELECT paused_until, pause_reason FROM agent_conversation_state WHERE tenant_id = $1 AND phone_digits = $2`, [tenantId, key]),
                queryWithRetry(
                    `SELECT id, draft_text, finished_at FROM agent_runs
                      WHERE tenant_id = $1 AND phone_digits = $2 AND draft_state = 'new' AND NOT simulated
                        AND finished_at > NOW() - interval '24 hours'
                      ORDER BY finished_at DESC LIMIT 1`, [tenantId, key]),
                queryWithRetry(
                    `SELECT status, outcome, skip_reason, finished_at FROM agent_runs
                      WHERE tenant_id = $1 AND phone_digits = $2 AND status <> 'pending' AND NOT simulated
                      ORDER BY created_at DESC LIMIT 1`, [tenantId, key]),
                queryWithRetry(
                    `SELECT id, tool, args, summary, suggested_reply, status, expires_at, reservation_id FROM agent_proposals
                      WHERE tenant_id = $1 AND phone_digits = $2 AND status = 'PENDING' AND NOT auto AND expires_at > NOW()
                      ORDER BY created_at DESC LIMIT 1`, [tenantId, key]),
                // Le azioni fatte da sole negli ultimi due giorni, col loro
                // «Annulla» finché la prenotazione è come l'agente l'ha lasciata.
                queryWithRetry(
                    `SELECT id, tool, summary, reservation_id, created_at, undone_at, after_state IS NOT NULL AS has_after
                       FROM agent_proposals
                      WHERE tenant_id = $1 AND phone_digits = $2 AND auto AND created_at > NOW() - interval '48 hours'
                      ORDER BY created_at DESC LIMIT 5`, [tenantId, key]),
            ]);
            const st = state.rows[0];
            const paused = !!st && ((st.paused_until == null && st.pause_reason != null)
                || (st.paused_until != null && new Date(st.paused_until).getTime() > Date.now()));
            res.json({
                mode: policy.mode,
                paused,
                paused_until: paused ? st.paused_until : null,
                pause_reason: paused ? st.pause_reason : null,
                draft: draft.rows[0] ? { run_id: Number(draft.rows[0].id), text: draft.rows[0].draft_text, at: draft.rows[0].finished_at } : null,
                last_run: last.rows[0] ?? null,
                proposal: proposal.rows[0] ?? null,
                actions: actions.rows.map((a: any) => ({
                    id: Number(a.id),
                    tool: a.tool,
                    summary: a.summary,
                    reservation_id: a.reservation_id,
                    at: a.created_at,
                    undone_at: a.undone_at,
                    undoable: !a.undone_at && a.has_after && UNDOABLE_TOOLS.has(a.tool),
                })),
            });
        } catch (err: any) {
            console.error('GET /whatsapp/agent/thread error:', err);
            res.status(500).json({ error: "Errore nel leggere lo stato dell'agente" });
        }
    });

    /** Pausa dell'agente su una conversazione: un'ora, fino a domattina,
     *  sempre; o riattiva. */
    router.post('/agent/thread/:phoneDigits/pause', ...threadWrite, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const key = phoneMatchKey(String(req.params.phoneDigits || ''));
            if (!key) return res.status(400).json({ error: 'numero non valido' });
            const per = String(req.body?.for || '');
            let until: Date | null = null;
            let reason: string | null = 'manual';
            if (per === '1h') until = new Date(Date.now() + 3600_000);
            else if (per === 'tomorrow') {
                // Fino alle 9 di domani: la pausa «per stasera» non deve
                // tenere spento l'agente per il servizio di domani.
                until = new Date(); until.setDate(until.getDate() + 1); until.setHours(9, 0, 0, 0);
            } else if (per === 'always') until = null;
            else if (per === 'resume') reason = null;
            else return res.status(400).json({ error: 'for deve essere 1h, tomorrow, always o resume' });
            await queryWithRetry(
                `INSERT INTO agent_conversation_state (tenant_id, phone_digits, paused_until, pause_reason, paused_by_user_id, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (tenant_id, phone_digits) DO UPDATE
                    SET paused_until = EXCLUDED.paused_until, pause_reason = EXCLUDED.pause_reason,
                        paused_by_user_id = EXCLUDED.paused_by_user_id, updated_at = NOW()`,
                [tenantId, key, until ? until.toISOString() : null, reason, req.user?.userId ?? null]
            );
            try { whatsappDeps().broadcastToAll(tenantId, 'agent:activity', { phone_digits: key }); } catch { /* best effort */ }
            res.json({ ok: true, paused: reason != null, paused_until: until });
        } catch (err: any) {
            console.error('POST /whatsapp/agent/thread/pause error:', err);
            res.status(500).json({ error: 'Errore nel mettere in pausa' });
        }
    });

    /** «Annulla» su un'azione che l'agente ha fatto da solo: la prenotazione
     *  torna com'era, se nessuno l'ha toccata nel frattempo. */
    router.post('/agent/actions/:id/undo', ...threadWrite, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const id = Number(req.params.id);
            if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'id non valido' });
            const actor = req.user ? { user_id: req.user.userId, role: String(req.user.role), channel: 'crm' } : null;
            const out = await undoAutoAction(tenantId, id, req.user?.userId ?? null, actor);
            if (out.ok === false) return res.status(out.status).json({ error: out.error });
            await whatsappDeps().broadcastReservationsUpdatedByIds([out.reservationId]).catch(() => {});
            LogService.logActivity(
                tenantId, req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
                ActivityAction.UPDATE, ResourceType.RESERVATION, out.reservationId, out.customerName,
                { source: 'WHATSAPP', undo_agent_action: id, tool: out.tool }
            ).catch(() => {});
            const r = await queryWithRetry(`SELECT phone_digits FROM agent_proposals WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
            try { whatsappDeps().broadcastToAll(tenantId, 'agent:activity', { phone_digits: r.rows[0]?.phone_digits }); } catch { /* best effort */ }
            res.json({ ok: true, reservation_id: out.reservationId, tool: out.tool });
        } catch (err: any) {
            console.error('POST /whatsapp/agent/actions/undo error:', err);
            res.status(500).json({ error: "Errore nell'annullare l'azione" });
        }
    });

    /** La bozza dell'agente usata o scartata: misura quante vanno bene. */
    router.post('/agent/runs/:id/draft', ...threadWrite, async (req, res) => {
        try {
            const state = req.body?.state === 'used' ? 'used' : req.body?.state === 'discarded' ? 'discarded' : null;
            if (!state) return res.status(400).json({ error: 'state deve essere used o discarded' });
            const r = await queryWithRetry(
                `UPDATE agent_runs SET draft_state = $3 WHERE id = $1 AND tenant_id = $2 AND draft_state = 'new' RETURNING phone_digits`,
                [Number(req.params.id), req.tenantId!, state]
            );
            if (!r.rowCount) return res.status(409).json({ error: 'Bozza non più disponibile' });
            try { whatsappDeps().broadcastToAll(req.tenantId!, 'agent:activity', { phone_digits: r.rows[0].phone_digits }); } catch { /* best effort */ }
            res.json({ ok: true });
        } catch (err: any) {
            console.error('POST /whatsapp/agent/runs/draft error:', err);
            res.status(500).json({ error: 'Errore nel salvare la bozza' });
        }
    });

    // ── Il simulatore ───────────────────────────────────────────────────
    // Un cliente finto (+39 0100 000000) scrive all'agente: tutta la catena
    // gira, nessun messaggio parte. La conversazione resta visibile in
    // Messaggi come quella del simulatore, così si rilegge. Non un numero
    // di soli zeri: phoneMatchKey toglie «00» come prefisso internazionale e
    // lo svuoterebbe.
    const SIM_PHONE = '+390100000000';
    const SIM_DIGITS = '390100000000';
    const SIM_KEY = phoneMatchKey(SIM_PHONE);

    router.post('/agent/simulate', authenticate, requirePermission('settings:full'), requireWhatsApp, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            if (req.body?.reset === true) {
                await queryWithRetry(
                    `DELETE FROM outbound_messages WHERE tenant_id = $1 AND provider = 'simulator'
                        AND (from_phone_digits = ANY($2::text[]) OR to_phone_digits = ANY($2::text[]))`,
                    [tenantId, phoneDigitsVariants(SIM_KEY)]
                );
                await queryWithRetry(`DELETE FROM agent_runs WHERE tenant_id = $1 AND phone_digits = $2 AND simulated`, [tenantId, SIM_KEY]);
                // Anche la pausa (un «risponditore automatico» provato nel
                // simulatore lo metterebbe in pausa per sette giorni) e la
                // conferma d'annullo in attesa.
                await queryWithRetry(`DELETE FROM agent_conversation_state WHERE tenant_id = $1 AND phone_digits = $2`, [tenantId, SIM_KEY]);
                return res.json({ ok: true });
            }
            const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
            if (!text) return res.status(400).json({ error: 'Scrivi un messaggio da provare' });
            const mode = req.body?.mode === 'draft' ? 'draft' : req.body?.mode === 'actions' ? 'actions' : 'reply';
            await queryWithRetry(
                `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, to_phone, to_phone_digits, body, status, profile_name)
                 VALUES ($1, 'simulator', 'whatsapp', 'inbound', $2, $3, 'simulatore', '', $4, 'received', 'Cliente di prova')`,
                [tenantId, SIM_PHONE, SIM_DIGITS, text]
            );
            const outcome = await simulateRun(tenantId, SIM_KEY, mode);
            // La risposta «che sarebbe partita» entra nella conversazione:
            // il messaggio dopo la trova nella storia, come col cliente vero.
            if (outcome.outcome === 'would_reply' && outcome.reply) {
                await queryWithRetry(
                    `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status, kind)
                     VALUES ($1, 'simulator', 'whatsapp', 'outbound', $2, $3, $4, 'simulated', 'agent')`,
                    [tenantId, SIM_PHONE, SIM_DIGITS, outcome.reply]
                );
            }
            res.json({
                outcome: outcome.outcome ?? null,
                status: outcome.status,
                reply: outcome.reply ?? null,
                proposal: outcome.proposals?.[0] ?? null,
                actions: (outcome.actions ?? []).map(a => ({ tool: a.tool, summary: a.summary })),
                skipped: outcome.skipped ?? null,
                note: outcome.skip_reason ?? null,
            });
        } catch (err: any) {
            console.error('POST /whatsapp/agent/simulate error:', err);
            res.status(500).json({ error: 'Errore del simulatore' });
        }
    });

    return router;
}
