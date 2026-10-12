// Messaggi in uscita: WhatsApp e SMS, con la riga in outbound_messages.
//
// Il codice viene da server.ts (sendWhatsAppText, sendTwilioWhatsApp,
// sendTwilioSms, logOutboundMessage) e si comporta allo stesso modo per il
// Frantoio. Cambia una cosa: il mittente è quello del ristorante che manda
// (config.ts), non più il numero del Frantoio per tutti.

import { queryWithRetry } from '../../db.js';
import { isServiceNode } from '../topology.js';
import { getTenantLocale } from '../tenantLocale.js';
import { normalizePhoneE164 } from '../../utils/phone.js';
import { envTenantIds, getSender, getSmsSender } from './config.js';
import { statusCallbackUrl } from './callbacks.js';
import { twilioSendMessage } from './providers/twilio.js';
import { metaSendMessage } from './providers/meta.js';
import { isVonageConfigured, sendVonageWhatsApp } from './providers/vonage.js';
import { buildMetaTemplateMessage, isMetaTemplateSendable, parseMetaTemplateRef, type MetaTemplateMessage } from './templates/meta.js';
import { metaSpec } from './templates/metaCatalog.js';
import type { OutboundConfirmationResult, WhatsAppTemplateOpts } from './types.js';

// Una riga in outbound_messages per ogni invio, così l'operatore vede tutta
// la storia SMS/WhatsApp del cliente senza aprire la console di Twilio. Un
// errore di registrazione non deve mai far fallire l'invio vero: si scrive
// nel log e basta. tenantId obbligatorio e passato lungo tutta la catena
// (sendBookingConfirmation → sendWhatsAppText/sendTwilioSms → qui): la riga
// deve finire nella conversazione del ristorante che ha mandato.
export async function logOutboundMessage(params: {
    tenantId: number;
    provider: 'twilio' | 'vonage' | 'meta';
    channel: 'sms' | 'whatsapp';
    to: string;
    body: string;
    sid?: string | null;
    reservationId?: number | null;
    status?: string | null;
    errorMessage?: string | null;
    /** Che cosa è questo messaggio ('confirmation', 'review_request', …):
     *  NULL = scritto a mano da un operatore, che è il caso normale. Serve
     *  all'inbox per non mostrare gli automatismi — vedi INBOX_HIDDEN_KINDS. */
    kind?: string | null;
}): Promise<void> {
    try {
        const digits = String(params.to).replace(/\D/g, '');
        const status = params.status
            ?? (params.errorMessage ? 'failed' : (params.sid ? 'queued' : 'sent'));
        await queryWithRetry(
            `INSERT INTO outbound_messages
             (tenant_id, provider, channel, to_phone, to_phone_digits, body, status, provider_sid, reservation_id, error_message, failed_at, kind)
             VALUES ($11, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $12)`,
            [
                params.provider,
                params.channel,
                params.to,
                digits,
                params.body,
                status,
                params.sid ?? null,
                params.reservationId ?? null,
                params.errorMessage ?? null,
                params.errorMessage ? new Date() : null,
                params.tenantId,
                params.kind ?? null,
            ]
        );
    } catch (err: any) {
        console.warn('[outbound-log] insert failed:', err?.message || err);
    }
}

/**
 * Manda un WhatsApp dal numero del ristorante: testo libero (dentro la
 * finestra di 24 ore), template approvato, o allegati.
 *
 * Senza un mittente il messaggio non parte e l'errore lo dice: chi chiama
 * in modo interattivo lo mostra, chi chiama senza aspettare lo scrive nel
 * log. Per i ristoranti con le credenziali in env, se Twilio manca si
 * ripiega su Vonage come prima (solo testo).
 */
export async function sendWhatsAppText(
    tenantId: number,
    to: string,
    text: string,
    reservationId?: number | null,
    template?: WhatsAppTemplateOpts,
    mediaUrls?: string[],
    kind?: string | null
): Promise<OutboundConfirmationResult> {
    // Sul nodo di sala non si spedisce niente: l'invio è lavoro del cloud, e
    // un nodo che mandasse WhatsApp dalla propria replica li duplicherebbe.
    // Si lancia (non si finge il successo): i chiamanti fire-and-forget
    // loggano, quelli interattivi mostrano l'errore — che è la verità.
    if (isServiceNode) throw new Error('profilo service-node: gli invii esterni partono solo dal cloud');

    const sender = await getSender(tenantId);
    if (sender?.provider === 'meta') {
        // L'API Cloud di Meta. Il template arriva come riferimento
        // `meta:<chiave>:<lingua>` (templates/registry.ts) con le variabili
        // numerate come per Twilio: qui diventa il template del locale. Uno
        // che non è (più) approvato non parte, e chi chiama ripiega come
        // quando il template non è impostato.
        let metaTemplate: MetaTemplateMessage | undefined;
        if (template) {
            const ref = parseMetaTemplateRef(template.contentSid);
            const spec = ref ? metaSpec(ref.key, ref.language) : undefined;
            if (!ref || !spec || !isMetaTemplateSendable(tenantId, ref.key, ref.language)) {
                throw new Error('Template WhatsApp non approvato sul numero Meta del locale');
            }
            metaTemplate = buildMetaTemplateMessage(spec, ref.language, template.contentVariables);
        }
        const toE164 = normalizePhoneE164(String(to), (await getTenantLocale(tenantId)).dialCode);
        console.log(`[Meta] Sending message to ${toE164} from ${sender.from}${metaTemplate ? ` (template ${metaTemplate.name})` : ''}`);
        const outcome = await metaSendMessage(sender, { to: toE164, body: text, mediaUrls, template: metaTemplate });
        if (!outcome.ok) {
            const message = `Meta API error: ${outcome.error}`;
            console.error('[Meta] ❌ Error sending message:', outcome.error);
            await logOutboundMessage({ tenantId, provider: 'meta', channel: 'whatsapp', to, body: text, reservationId, kind, errorMessage: message });
            throw new Error(message);
        }
        await logOutboundMessage({ tenantId, provider: 'meta', channel: 'whatsapp', to, body: text, sid: outcome.sid, reservationId, kind });
        return { sid: outcome.sid, channel: 'whatsapp' };
    }
    if (sender) {
        // Twilio vuole "whatsapp:+E164" a entrambi i capi. Un numero locale
        // senza prefisso è del paese del ristorante, non per forza italiano:
        // il prefisso di casa arriva da tenantLocale (senza, Twilio
        // rifiutava "+3289630012" come numero belga).
        const formattedTo = `whatsapp:${normalizePhoneE164(String(to), (await getTenantLocale(tenantId)).dialCode)}`;
        console.log(`[Twilio] Sending message to ${formattedTo} from ${sender.from}${template ? ` (template ${template.contentSid})` : ''}`);
        try {
            const outcome = await twilioSendMessage(sender, {
                to: formattedTo,
                from: sender.from,
                body: text,
                contentSid: template?.contentSid,
                contentVariables: template?.contentVariables,
                mediaUrls,
                statusCallback: await statusCallbackUrl(tenantId),
            });
            if (!outcome.ok) {
                const message = `Twilio API error: ${outcome.error}`;
                console.error('[Twilio] ❌ Error sending message:', outcome.error);
                await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'whatsapp', to, body: text, reservationId, kind, errorMessage: message });
                throw new Error(message);
            }
            console.log(`[Twilio] ✅ Message sent to ${to} (sid=${outcome.sid})`);
            await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'whatsapp', to, body: text, sid: outcome.sid, reservationId, kind });
            return { sid: outcome.sid, channel: 'whatsapp' };
        } catch (err: any) {
            if (err?.message && !err.message.startsWith('Twilio API error')) {
                await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'whatsapp', to, body: text, reservationId, kind, errorMessage: err.message });
            }
            throw err;
        }
    }

    if (!envTenantIds().has(tenantId) || !isVonageConfigured()) {
        throw new Error('WhatsApp non collegato per questo locale');
    }
    if (template) throw new Error('WhatsApp template requires Twilio (Vonage unsupported)');
    if (mediaUrls?.length) throw new Error('Gli allegati richiedono Twilio (Vonage non supportato)');
    try {
        await sendVonageWhatsApp(to, text);
        await logOutboundMessage({ tenantId, provider: 'vonage', channel: 'whatsapp', to, body: text, reservationId, kind });
        return { channel: 'whatsapp' };
    } catch (err: any) {
        await logOutboundMessage({
            tenantId, provider: 'vonage', channel: 'whatsapp', to, body: text, reservationId, kind,
            errorMessage: err?.message || String(err),
        });
        throw err;
    }
}

// SMS via Twilio. Il mittente si sceglie in quest'ordine:
//   1) TWILIO_MESSAGING_SERVICE_SID (obbligatorio col mittente alfanumerico
//      «V Frantoio», che vive dentro un servizio di messaggistica)
//   2) TWILIO_SMS_FROM come mittente alfanumerico (se contiene lettere)
//   3) TWILIO_SMS_FROM come numero E.164
// Solo per i ristoranti con le credenziali in env: il mittente porta il
// nome del Frantoio (config.ts).
export async function sendTwilioSms(
    tenantId: number,
    to: string,
    text: string,
    reservationId?: number | null,
    kind?: string | null
): Promise<OutboundConfirmationResult> {
    if (isServiceNode) throw new Error('profilo service-node: gli invii esterni partono solo dal cloud');
    const sender = getSmsSender(tenantId);
    if (!sender) {
        console.error('[Twilio SMS] mittente SMS non disponibile per il tenant', tenantId);
        throw new Error('Twilio SMS not configured');
    }

    // Numero in E.164 col prefisso del paese del ristorante quando manca: un
    // "3289630012" diventerebbe "+3289630012", che Twilio rifiuta come belga.
    const formattedTo = normalizePhoneE164(String(to), (await getTenantLocale(tenantId)).dialCode);
    let from: string | undefined;
    let senderDescription: string;
    if (sender.messagingServiceSid) {
        senderDescription = `service ${sender.messagingServiceSid}`;
    } else {
        const raw = sender.from!;
        from = /[A-Za-z]/.test(raw) ? raw : (raw.startsWith('+') ? raw : `+${raw.replace(/\D/g, '')}`);
        senderDescription = `from ${from}`;
    }
    console.log(`[Twilio SMS] Sending message to ${formattedTo} ${senderDescription}`);

    try {
        const outcome = await twilioSendMessage(sender, {
            to: formattedTo,
            from,
            messagingServiceSid: sender.messagingServiceSid ?? undefined,
            body: text,
            statusCallback: await statusCallbackUrl(tenantId),
        });
        if (!outcome.ok) {
            const message = `Twilio SMS API error: ${outcome.error}`;
            console.error('[Twilio SMS] ❌ Error sending message:', outcome.error);
            await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'sms', to, body: text, reservationId, kind, errorMessage: message });
            throw new Error(message);
        }
        console.log(`[Twilio SMS] ✅ Message sent to ${to} (sid=${outcome.sid})`);
        await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'sms', to, body: text, sid: outcome.sid, reservationId, kind });
        return { sid: outcome.sid, channel: 'sms' };
    } catch (err: any) {
        if (err?.message && !err.message.startsWith('Twilio SMS API error')) {
            await logOutboundMessage({ tenantId, provider: 'twilio', channel: 'sms', to, body: text, reservationId, kind, errorMessage: err.message });
        }
        throw err;
    }
}
