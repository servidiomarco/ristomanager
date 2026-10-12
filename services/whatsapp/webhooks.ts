// I webhook dei provider WhatsApp. Le rotte restano dichiarate in server.ts
// (percorso storico del tenant 1 e gemello col token del ristorante); qui
// c'è il corpo.

import type express from 'express';
import { isFeatureEnabledForTenant } from '../entitlements.js';
import { twilioWebhookAuthToken } from './config.js';
import { processInbound } from './inbound.js';
import { isValidTwilioSignature, parseTwilioInbound } from './providers/twilio.js';
import { queryWithRetry, runAsPlatform, runWithTenantContext } from '../../db.js';
import { whatsappDeps } from './deps.js';
import { isValidMetaSignature, parseMetaTemplateUpdates, parseMetaWebhook, type MetaEcho, type MetaStatus } from './providers/meta.js';
import { applyMetaTemplateUpdates } from './templates/provision.js';
import { logOutboundMessage } from './outbound.js';

/** Firma di un webhook dell'account Twilio principale. */
export function validateTwilioSignature(req: express.Request): boolean {
    return isValidTwilioSignature(req, twilioWebhookAuthToken());
}

// Messaggi WhatsApp (e SMS: il numero Twilio è unico) in arrivo. Salva la
// riga in outbound_messages (direction='inbound') e la trasmette all'inbox in
// tempo reale. Volutamente NESSUNA risposta automatica qui: il vecchio bot
// che cercava «DATA ORA OSPITI NOME» confondeva chi rispondeva a una
// conferma («Ok perfetto») ed è stato ritirato. L'agente WhatsApp, quando
// lavora da solo, si aggancia con onInbound() (inbound.ts).
// Corpo condiviso fra percorso storico (alias tenant 1) e gemello col token.
// La firma Twilio copre l'URL completo (req.originalUrl), quindi vale anche
// sul percorso col token: Twilio firma l'URL che ha configurato, token compreso.
export async function handleTwilioWhatsAppInbound(tenantId: number, req: express.Request, res: express.Response): Promise<void> {
    if (!validateTwilioSignature(req)) {
        console.warn('[Twilio] Inbound: invalid signature, rejecting');
        res.status(403).send();
        return;
    }
    console.log('[Twilio] Incoming message:', req.body);
    // TwiML vuoto: così Twilio non risponde da sé al posto nostro.
    res.set('Content-Type', 'text/xml').status(200).send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

    // Entitlement WhatsApp spento: ack 200 già inviato (Twilio ritenta sui
    // 4xx/5xx e disattiverebbe il webhook dopo troppi errori), ma il
    // messaggio non entra nell'inbox. Copre anche gli SMS inbound: il numero
    // Twilio è unico e fa parte dello stesso add-on messaggistica.
    if (!(await isFeatureEnabledForTenant(tenantId, 'whatsapp'))) {
        console.warn('[Twilio] inbound ignorato: entitlement whatsapp disattivo');
        return;
    }

    try {
        const message = parseTwilioInbound(req.body || {});
        if (!message) {
            console.log('[Twilio] Inbound: missing From or empty message, ignoring');
            return;
        }
        await processInbound(tenantId, message);
    } catch (error) {
        console.error('[Twilio] Error processing inbound:', error);
    }
}

// ---------------------------------------------------------------------------
// Meta (API Cloud, Fase 12a)
// ---------------------------------------------------------------------------
// Un solo indirizzo per tutti i ristoranti, configurato una volta nell'app
// di Sympotia su Meta: /webhook/meta-whatsapp. Il ristorante si ricava da
// metadata.phone_number_id, che whatsapp_senders lega a un tenant solo.


export const metaAppSecret = (env: NodeJS.ProcessEnv = process.env): string | null => (env.META_APP_SECRET || '').trim() || null;
const metaVerifyToken = (env: NodeJS.ProcessEnv = process.env): string | null => (env.META_WEBHOOK_VERIFY_TOKEN || '').trim() || null;

/** La verifica dell'indirizzo che Meta fa quando lo si configura. */
export function handleMetaWebhookVerify(req: express.Request, res: express.Response): void {
    const token = metaVerifyToken();
    if (token && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === token) {
        res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
        return;
    }
    res.status(403).send();
}

/** Il ristorante del numero: whatsapp_senders si legge fuori dal contesto
 *  di un tenant, perché è proprio il tenant che si sta cercando. */
async function tenantForPhoneNumberId(phoneNumberId: string): Promise<number | null> {
    // rls-bypass: webhook di Meta senza JWT, il tenant si ricava da phone_number_id (unico in whatsapp_senders)
    return runAsPlatform(async () => {
        const r = await queryWithRetry(`SELECT tenant_id FROM whatsapp_senders WHERE phone_number_id = $1`, [phoneNumberId]);
        return r.rows[0] ? Number(r.rows[0].tenant_id) : null;
    });
}

async function applyMetaStatus(tenantId: number, s: MetaStatus): Promise<void> {
    if (!s.sid || !s.status) return;
    // Il costo vero, quando Meta lo dice; poi lo stato come per Twilio
    // (inbox, prenotazione, ripieghi), che sta in server.ts.
    if (s.pricingCategory || s.billable != null) {
        await queryWithRetry(
            `UPDATE outbound_messages SET pricing_category = COALESCE($3, pricing_category), billable = COALESCE($4, billable)
              WHERE tenant_id = $1 AND provider_sid = $2`,
            [tenantId, s.sid, s.pricingCategory, s.billable]
        );
    }
    await whatsappDeps().persistDeliveryStatus(tenantId, s.sid, s.status, s.errorCode, s.errorText);
}

/** Coesistenza: un messaggio scritto dall'app WhatsApp Business del locale
 *  entra nella conversazione come scritto dallo staff, così l'agente tace. */
async function applyMetaEcho(tenantId: number, e: MetaEcho): Promise<void> {
    if (!e.to || !e.body) return;
    const seen = e.sid ? await queryWithRetry(`SELECT 1 FROM outbound_messages WHERE tenant_id = $1 AND provider_sid = $2`, [tenantId, e.sid]) : null;
    if (seen?.rowCount) return;
    await logOutboundMessage({ tenantId, provider: 'meta', channel: 'whatsapp', to: e.to, body: e.body, sid: e.sid || null, status: 'sent', kind: 'staff' });
    const row = (await queryWithRetry(`SELECT * FROM outbound_messages WHERE tenant_id = $1 AND provider_sid = $2 LIMIT 1`, [tenantId, e.sid])).rows[0];
    if (row) {
        try { whatsappDeps().broadcastToAll(tenantId, 'message:outbound', row); } catch { /* best effort */ }
    }
}

/** I webhook di Meta: messaggi, stati di consegna, eco della coesistenza,
 *  e lo stato dei template (questo per account WhatsApp, non per numero). */
export async function handleMetaWebhook(req: express.Request, res: express.Response): Promise<void> {
    const secret = metaAppSecret();
    if (!secret) {
        res.status(503).json({ error: 'meta_not_configured' });
        return;
    }
    if (!isValidMetaSignature((req as any).rawBody, req.get('x-hub-signature-256') ?? undefined, secret)) {
        console.warn('[Meta] webhook con firma non valida, scartato');
        res.status(403).send();
        return;
    }
    // Subito 200: Meta ritenta sui ritardi, e i doppioni si scartano per id.
    res.status(200).send();
    for (const change of parseMetaWebhook(req.body)) {
        try {
            const tenantId = await tenantForPhoneNumberId(change.phoneNumberId);
            if (tenantId == null) {
                console.warn(`[Meta] webhook per un numero non collegato (${change.phoneNumberId})`);
                continue;
            }
            await runWithTenantContext(tenantId, async () => {
                if (change.inbound.length && !(await isFeatureEnabledForTenant(tenantId, 'whatsapp'))) return;
                for (const m of change.inbound) await processInbound(tenantId, m);
                for (const s of change.statuses) await applyMetaStatus(tenantId, s);
                for (const e of change.echoes) await applyMetaEcho(tenantId, e);
            });
        } catch (err: any) {
            console.error('[Meta] webhook non lavorato:', err?.message || err);
        }
    }
    try {
        await applyMetaTemplateUpdates(parseMetaTemplateUpdates(req.body));
    } catch (err: any) {
        console.error('[Meta] stato dei template non aggiornato:', err?.message || err);
    }
}
