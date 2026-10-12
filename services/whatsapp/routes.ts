// Le rotte del modulo WhatsApp, montate su /whatsapp: quello che serve alla
// sezione Impostazioni › WhatsApp. Le rotte dell'inbox e dell'agente
// (/messages/*) restano in server.ts finché le fasi dell'agente non le
// spostano qui.

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { authenticate, requirePermission } from '../../auth/authMiddleware.js';
import { isFeatureEnabledForTenant } from '../entitlements.js';
import { envTenantIds, getSender, invalidateSenderCache, isSmsReady, metaGraphBase, twilioEnvSender } from './config.js';
import { metaPhoneInfo, metaSubscribeApp } from './providers/meta.js';
import { encryptSecret, isSecretsConfigured } from '../../utils/secrets.js';
import { tenantWebhookToken } from './callbacks.js';
import { templateStatus } from './templates/status.js';
import { forgetMetaTemplates, provisionMetaTemplates, syncMetaTemplatesIfStale } from './templates/provision.js';
import { runWithTenantContext } from '../../db.js';
import { whatsappUsage } from './usage.js';
import { queryWithRetry } from '../../db.js';
import { phoneDigitsVariants, phoneMatchKey } from '../../utils/text.js';
import {
    getAgentPolicy, normalizeAgentPolicy, saveAgentPolicy,
    getRemindersPolicy, normalizeRemindersPolicy, saveRemindersPolicy,
    getEntryPolicy, normalizeEntryPolicy, saveEntryPolicy,
    getMediaPolicy, normalizeMediaPolicy, saveMediaPolicy,
    getTakeawayPolicy, normalizeTakeawayPolicy, saveTakeawayPolicy,
    getCampaignsPolicy, normalizeCampaignsPolicy, saveCampaignsPolicy,
} from './settings.js';
import { createCampaignsRouter } from './campaigns/routes.js';
import { isTranscriptionConfigured } from './media/transcribe.js';
import { simulateRun } from './agent/queue.js';
import { undoAutoAction, UNDOABLE_TOOLS } from './agent/autonomy.js';
import { whatsappDeps } from './deps.js';
import { LogService, ActivityAction, ResourceType } from '../../activityLogs/logService.js';

// L'add-on WhatsApp, chiuso se non si riesce a leggerlo: queste rotte
// mostrano numeri e costi di un canale che il locale potrebbe non avere.
// Il locale scrive davvero dal numero Twilio in env (il Frantoio): lì il
// numero Meta non serve e getSender non lo userebbe. Un locale elencato ma
// senza mittente in env (i test, un ambiente senza Twilio) può collegarlo.
const writesFromEnvSender = (tenantId: number) => envTenantIds().has(tenantId) && twilioEnvSender() != null;

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
            const sharedEnv = envTenantIds().has(tenantId);
            const meta = sender?.provider === 'meta' ? sender : null;
            res.json({
                connected: sender != null,
                provider: sender?.provider ?? null,
                source: sender?.source ?? null,
                phone: sender ? sender.from.replace(/^whatsapp:/, '') : null,
                shared_env_sender: sharedEnv,
                sms_ready: isSmsReady(tenantId),
                // Il numero Meta del locale: nome mostrato ai clienti, qualità
                // e limite d'invio come li dà Meta al collegamento.
                meta: meta ? {
                    display_name: meta.displayName,
                    quality_rating: meta.qualityRating,
                    messaging_limit: meta.messagingLimit,
                    phone_number_id: meta.phoneNumberId,
                    waba_id: meta.wabaId,
                } : null,
                // Si può collegare un numero Meta: il locale non scrive dal
                // numero in env e il server sa cifrare il token.
                meta_connect_available: !writesFromEnvSender(tenantId) && isSecretsConfigured(),
                // Gli indirizzi Twilio servono solo a chi scrive da Twilio: a un
                // locale senza numero darebbero un'idea sbagliata di dove collegarsi.
                webhooks: meta
                    ? { inbound: `${base}/webhook/meta-whatsapp`, status: `${base}/webhook/meta-whatsapp` }
                    : sharedEnv && token ? {
                        inbound: `${base}/webhook/t/${token}/twilio-whatsapp`,
                        status: `${base}/webhook/t/${token}/twilio-whatsapp-status`,
                    } : null,
            });
        } catch (err: any) {
            console.error('GET /whatsapp/status error:', err);
            res.status(500).json({ error: 'Errore nel leggere lo stato di WhatsApp' });
        }
    });

    // ── Il numero sull'API Cloud di Meta (Fase 12a) ─────────────────────
    //
    // Collegamento a mano: id del numero, id dell'account WhatsApp Business
    // e un token d'accesso (di un utente di sistema), dalla console di Meta.
    // Serve alle demo col numero di prova di Meta e ai primi locali finché
    // l'Embedded Signup (Fase 12c) non lo fa con un clic. Il token si
    // controlla chiedendo a Meta il numero, poi si salva cifrato: non torna
    // mai indietro al browser.

    const manage = [authenticate, requirePermission('settings:full'), requireWhatsApp];

    router.post('/meta/connect', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            if (writesFromEnvSender(tenantId)) {
                return res.status(409).json({ error: 'Questo locale scrive dal numero Twilio principale: il numero Meta non si collega qui' });
            }
            if (!isSecretsConfigured()) {
                return res.status(503).json({ error: 'Il server non ha la chiave per cifrare il token (INTEGRATION_SECRETS_KEY)' });
            }
            const clean = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : '';
            const phoneNumberId = clean(req.body?.phone_number_id, 40);
            const wabaId = clean(req.body?.waba_id, 40);
            const accessToken = clean(req.body?.access_token, 1000);
            if (!/^\d{5,40}$/.test(phoneNumberId) || !/^\d{5,40}$/.test(wabaId)) {
                return res.status(400).json({ error: "Id del numero e dell'account WhatsApp Business: solo cifre, come nella console di Meta" });
            }
            if (accessToken.length < 20) return res.status(400).json({ error: "Manca il token d'accesso" });

            const base = metaGraphBase();
            const info = await metaPhoneInfo(base, phoneNumberId, accessToken);
            if (info.ok === false) {
                return res.status(400).json({ error: `Meta non riconosce numero e token: ${info.error}` });
            }
            // L'iscrizione dell'app all'account fa arrivare i webhook; se Meta
            // la rifiuta il numero manda lo stesso, e la card lo dice.
            const subscribed = await metaSubscribeApp(base, wabaId, accessToken).catch(() => false);
            try {
                await queryWithRetry(
                    `INSERT INTO whatsapp_senders
                        (tenant_id, provider, phone_e164, phone_number_id, waba_id, display_name, quality_rating, messaging_limit, access_token_enc, connected_by_user_id)
                     VALUES ($1, 'meta', $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (tenant_id) DO UPDATE SET
                        phone_e164 = EXCLUDED.phone_e164, phone_number_id = EXCLUDED.phone_number_id, waba_id = EXCLUDED.waba_id,
                        display_name = EXCLUDED.display_name, quality_rating = EXCLUDED.quality_rating,
                        messaging_limit = EXCLUDED.messaging_limit, access_token_enc = EXCLUDED.access_token_enc,
                        connected_by_user_id = EXCLUDED.connected_by_user_id, updated_at = NOW()`,
                    [tenantId, info.phone, phoneNumberId, wabaId, info.displayName, info.quality, info.limit,
                        encryptSecret(accessToken), req.user?.userId ?? null]
                );
            } catch (err: any) {
                // phone_number_id è unico su tutta la piattaforma: il webhook
                // ricava il locale da lì, due locali sullo stesso numero no.
                if (err?.code === '23505') return res.status(409).json({ error: 'Questo numero è già collegato a un altro locale' });
                throw err;
            }
            invalidateSenderCache(tenantId);
            LogService.logActivity(
                tenantId, req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
                ActivityAction.UPDATE, ResourceType.SETTINGS, undefined, 'WhatsApp',
                { whatsapp_meta: 'connect', phone: info.phone, phone_number_id: phoneNumberId, waba_id: wabaId, subscribed }
            ).catch(() => {});
            // I template del catalogo nell'account del locale, in
            // approvazione da Meta: una trentina di chiamate, quindi dopo la
            // risposta. La scheda Template li mostra man mano.
            const sender = await getSender(tenantId);
            if (sender?.provider === 'meta') {
                void runWithTenantContext(tenantId, () => provisionMetaTemplates(tenantId, sender))
                    .then(s => console.log(`[whatsapp] template Meta del tenant ${tenantId}: ${s.created} creati, ${s.existing} già presenti, ${s.failed} non riusciti`))
                    .catch((err: any) => console.error(`[whatsapp] template Meta del tenant ${tenantId} non creati:`, err?.message || err));
            }
            res.json({ ok: true, phone: info.phone, display_name: info.displayName, quality_rating: info.quality, messaging_limit: info.limit, subscribed });
        } catch (err: any) {
            console.error('POST /whatsapp/meta/connect error:', err);
            res.status(500).json({ error: 'Errore nel collegare il numero' });
        }
    });

    router.delete('/meta/connect', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const r = await queryWithRetry(
                `DELETE FROM whatsapp_senders WHERE tenant_id = $1 RETURNING phone_e164`, [tenantId]
            );
            invalidateSenderCache(tenantId);
            await forgetMetaTemplates(tenantId);
            if (r.rowCount) {
                LogService.logActivity(
                    tenantId, req.user?.userId ?? null, req.user?.email ?? '', req.user?.email ?? '',
                    ActivityAction.DELETE, ResourceType.SETTINGS, undefined, 'WhatsApp',
                    { whatsapp_meta: 'disconnect', phone: r.rows[0].phone_e164 }
                ).catch(() => {});
            }
            res.json({ ok: true, removed: (r.rowCount ?? 0) > 0 });
        } catch (err: any) {
            console.error('DELETE /whatsapp/meta/connect error:', err);
            res.status(500).json({ error: 'Errore nello scollegare il numero' });
        }
    });

    /** Il catalogo dei template con lo stato di approvazione. */
    router.get('/templates', ...read, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const sender = await getSender(tenantId);
            const meta = sender?.provider === 'meta' && !writesFromEnvSender(tenantId);
            if (meta && sender?.provider === 'meta') await syncMetaTemplatesIfStale(tenantId, sender);
            res.json({ templates: await templateStatus(tenantId), provider: sender?.provider ?? null });
        } catch (err: any) {
            console.error('GET /whatsapp/templates error:', err);
            res.status(500).json({ error: 'Errore nel leggere i template' });
        }
    });

    /** Manda in approvazione i template che mancano sul numero Meta del
     *  locale (o che non erano arrivati a Meta). */
    router.post('/templates/provision', ...manage, async (req, res) => {
        try {
            const tenantId = req.tenantId!;
            const sender = await getSender(tenantId);
            if (sender?.provider !== 'meta' || writesFromEnvSender(tenantId)) {
                return res.status(409).json({ error: 'I template si mandano a Meta solo per un numero collegato a Meta' });
            }
            const summary = await provisionMetaTemplates(tenantId, sender);
            res.json({ ok: true, ...summary, templates: await templateStatus(tenantId), provider: 'meta' });
        } catch (err: any) {
            console.error('POST /whatsapp/templates/provision error:', err);
            res.status(502).json({ error: err?.message || 'Meta non ha accettato i template' });
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
        const [agent, reminders, entry, media, takeaway, takeawayAddon, campaigns] = await Promise.all([
            getAgentPolicy(tenantId), getRemindersPolicy(tenantId), getEntryPolicy(tenantId), getMediaPolicy(tenantId),
            getTakeawayPolicy(tenantId), isFeatureEnabledForTenant(tenantId, 'takeaway').catch(() => false),
            getCampaignsPolicy(tenantId),
        ]);
        // transcription_ready: c'è la chiave ElevenLabs per trascrivere.
        // takeaway_available: il locale ha l'add-on asporto.
        return { agent, reminders, entry, media, takeaway, campaigns, transcription_ready: isTranscriptionConfigured(), takeaway_available: takeawayAddon };
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
            const campaigns = body.campaigns !== undefined ? normalizeCampaignsPolicy(body.campaigns, await getCampaignsPolicy(tenantId)) : undefined;
            if (agent === null || reminders === null || entry === null || media === null || takeaway === null || campaigns === null) {
                return res.status(400).json({ error: 'invalid_policy', message: 'Valori fuori dai limiti' });
            }
            if (agent) await saveAgentPolicy(tenantId, agent);
            if (reminders) await saveRemindersPolicy(tenantId, reminders);
            if (entry) await saveEntryPolicy(tenantId, entry);
            if (media) await saveMediaPolicy(tenantId, media);
            if (takeaway) await saveTakeawayPolicy(tenantId, takeaway);
            if (campaigns) await saveCampaignsPolicy(tenantId, campaigns);
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

    // Le campagne (services/whatsapp/campaigns/), con lo stesso add-on.
    router.use('/campaigns', createCampaignsRouter(requireWhatsApp));

    return router;
}
