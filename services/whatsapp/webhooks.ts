// I webhook dei provider WhatsApp. Le rotte restano dichiarate in server.ts
// (percorso storico del tenant 1 e gemello col token del ristorante); qui
// c'è il corpo.

import type express from 'express';
import { isFeatureEnabledForTenant } from '../entitlements.js';
import { twilioWebhookAuthToken } from './config.js';
import { processInbound } from './inbound.js';
import { isValidTwilioSignature, parseTwilioInbound } from './providers/twilio.js';

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
