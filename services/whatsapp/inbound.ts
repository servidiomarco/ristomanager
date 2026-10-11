// Messaggi in arrivo: dal webhook alla riga in outbound_messages.
//
// Il provider (providers/twilio.ts, dalla Fase 12 anche Meta) toglie il suo
// formato e consegna qui un InboundMessage. Qui si scartano i ritentativi, si
// salva la riga agganciata alla prenotazione, si avvisa lo staff e si passa
// il messaggio a chi ne fa qualcosa: oggi l'inbox (evento socket); dalle
// fasi successive l'agente, i tasti del promemoria, l'opt-out delle campagne
// — ognuno si registra con onInbound() invece di allungare il webhook.

import { queryWithRetry } from '../../db.js';
import { sendToRoles as pushSendToRoles } from '../pushService.js';
import { detectLanguageFromPhonePrefix } from '../../utils/language.js';
import { phoneMatchKey, PHONE_MATCH_KEY_SQL } from '../../utils/text.js';
import { whatsappDeps } from './deps.js';
import type { InboundMedia, InboundMessage } from './types.js';

// Etichetta leggibile di un allegato, per la notifica push e per la lista
// conversazioni: "ha inviato una foto" dice più di una riga vuota.
export function describeInboundMedia(media?: Array<{ content_type?: string }> | null): string {
    if (!media || media.length === 0) return '';
    const t = String(media[0]?.content_type || '');
    const n = media.length;
    const kind = t.startsWith('image/') ? (n > 1 ? `${n} foto` : 'una foto')
        : t.startsWith('video/') ? (n > 1 ? `${n} video` : 'un video')
        : t.startsWith('audio/') ? 'un messaggio vocale'
        : t.includes('vcard') || t.includes('contact') ? 'un contatto'
        : t === 'application/pdf' ? 'un PDF'
        : n > 1 ? `${n} allegati` : 'un allegato';
    return `ha inviato ${kind}`;
}

/**
 * Prenotazione a cui appartiene un messaggio in arrivo da `phone`.
 *
 * Un cliente abituale ha più prenotazioni: quella giusta è la più vicina
 * nel tempo al messaggio — chi scrive alle 19 sta parlando della cena di
 * stasera, non di quella di marzo. Le annullate restano candidabili (spesso
 * il messaggio È la disdetta), ma perdono contro una prenotazione viva a
 * parità di distanza.
 *
 * tenantId obbligatorio (quello del messaggio: PUBLIC_TENANT_ID dai webhook,
 * req.tenantId! dalle route autenticate): senza filtro lo stesso numero in
 * due ristoranti aggancerebbe la prenotazione dell'altro.
 */
export async function resolveReservationByPhone(
    tenantId: number,
    phone: string,
    when: Date = new Date()
): Promise<number | null> {
    const key = phoneMatchKey(phone);
    if (key.length < 6) return null;
    try {
        const r = await queryWithRetry(
            `SELECT id
               FROM reservations
              WHERE tenant_id = $3
                AND phone IS NOT NULL AND phone <> ''
                AND ${PHONE_MATCH_KEY_SQL('phone')} = $1
              ORDER BY (reservation_status = 'CANCELLED') ASC,
                       abs(extract(epoch FROM (reservation_time - $2::timestamptz))) ASC
              LIMIT 1`,
            [key, when.toISOString(), tenantId]
        );
        return r.rows[0]?.id ?? null;
    } catch (err: any) {
        console.warn('[inbound-log] lookup prenotazione fallito:', err?.message || err);
        return null;
    }
}

// Gli id dei messaggi appena visti, per le copie che arrivano nello stesso
// istante. Una replica sola (numReplicas=1): basta la memoria del processo.
const recentInboundSids = new Set<string>();
const RECENT_SID_TTL_MS = 10 * 60_000;

/** I campi in più che un provider può portare oltre a testo e allegati. */
export interface InboundExtras {
    profileName?: string | null;
    externalUserId?: string | null;
    buttonPayload?: string | null;
    buttonText?: string | null;
    repliedToSid?: string | null;
    location?: InboundMessage['location'];
}

// Registrazione di SMS/WhatsApp in arrivo. Simmetrica a logOutboundMessage
// ma con from_phone(_digits) per il mittente e to_phone(_digits) per il
// nostro numero. Restituisce la riga inserita, così chi chiama la trasmette
// all'inbox. Gli errori si scrivono nel log e non si lanciano mai: un
// guasto della registrazione non deve inghiottire il messaggio.
export async function logInboundMessage(params: {
    tenantId: number;
    provider: 'twilio' | 'vonage' | 'meta';
    channel: 'sms' | 'whatsapp';
    from: string;
    to: string;
    body: string;
    sid?: string | null;
    media?: InboundMedia[] | null;
    extras?: InboundExtras;
}): Promise<any | null> {
    try {
        const fromDigits = String(params.from).replace(/\D/g, '');
        const toDigits = String(params.to).replace(/\D/g, '');
        // Twilio ritenta il webhook quando la risposta tarda: lo stesso
        // messaggio arrivava due volte, con due notifiche e due bolle (in
        // produzione 2 casi all'11/10/2026). Senza id non si può dire.
        // Due copie arrivate insieme si fermano qui, in memoria (il controllo
        // sul database le vedrebbe entrambe nuove); un ritentativo che arriva
        // dopo lo trova già scritto.
        if (params.sid) {
            const key = `${params.tenantId}:${params.sid}`;
            if (recentInboundSids.has(key)) {
                console.log(`[inbound-log] ${params.sid} già in lavorazione: ritentativo scartato`);
                return null;
            }
            recentInboundSids.add(key);
            setTimeout(() => recentInboundSids.delete(key), RECENT_SID_TTL_MS).unref?.();
            const dup = await queryWithRetry(
                `SELECT 1 FROM outbound_messages
                  WHERE tenant_id = $1 AND direction = 'inbound' AND provider_sid = $2
                  LIMIT 1`,
                [params.tenantId, params.sid]
            );
            if (dup.rowCount && dup.rowCount > 0) {
                console.log(`[inbound-log] ${params.sid} già registrato: ritentativo scartato`);
                return null;
            }
        }
        // Aggancio alla prenotazione: senza, la risposta del cliente resta
        // solo in Inbox e non compare sulla scheda dove il cameriere guarda.
        // Se non c'è nessuna prenotazione (cliente nuovo) resta NULL e il
        // messaggio vive comunque in Inbox — mai un filtro, solo un'aggiunta.
        const reservationId = await resolveReservationByPhone(params.tenantId, params.from);
        const x = params.extras ?? {};
        const result = await queryWithRetry(
            `INSERT INTO outbound_messages
             (tenant_id, provider, channel, direction, from_phone, from_phone_digits,
              to_phone, to_phone_digits, body, status, provider_sid, reservation_id, media,
              profile_name, external_user_id, button_payload, button_text, replied_to_sid, location)
             VALUES ($11, $1, $2, 'inbound', $3, $4, $5, $6, $7, 'received', $8, $9, $10::jsonb,
                     $12, $13, $14, $15, $16, $17::jsonb)
             RETURNING *`,
            [
                params.provider,
                params.channel,
                params.from,
                fromDigits,
                params.to,
                toDigits,
                params.body,
                params.sid ?? null,
                reservationId,
                params.media && params.media.length > 0 ? JSON.stringify(params.media) : null,
                params.tenantId,
                x.profileName ?? null,
                x.externalUserId ?? null,
                x.buttonPayload ?? null,
                x.buttonText ?? null,
                x.repliedToSid ?? null,
                x.location ? JSON.stringify(x.location) : null,
            ]
        );
        const row = result.rows[0] ?? null;

        // Card #32 — un messaggio WhatsApp è il primo segnale di lingua per
        // molti clienti che non passano mai dal booking web o dalla voce.
        // Euristica sul prefisso, solo se il cliente esiste già e non ha
        // ancora una lingua: non deve sovrascrivere un dato più affidabile
        // (selettore esplicito sul widget, o quanto rilevato da ElevenLabs).
        if (params.channel === 'whatsapp') {
            const detectedLanguage = detectLanguageFromPhonePrefix(params.from);
            queryWithRetry(
                `UPDATE customers SET language = $1
                 WHERE tenant_id = $2
                   AND language IS NULL
                   AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $3`,
                [detectedLanguage, params.tenantId, fromDigits]
            ).catch(err => console.warn('[inbound-log] language update failed:', err?.message || err));
        }

        // Sveglia la PWA anche ad app chiusa: senza una push non arriva mai
        // il segnale al service worker, e il badge Inbox non si aggiorna.
        // Best-effort — se la push fallisce la logica del messaggio resta
        // corretta, solo il badge non si aggiorna finché l'utente non apre
        // l'app.
        if (row) {
            const channelLabel = params.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
            const mediaLabel = describeInboundMedia(params.media);
            const preview = String(params.body || '').replace(/\s+/g, ' ').trim().slice(0, 80)
                || mediaLabel;
            // Il nome del profilo WhatsApp dice più del numero a chi legge la
            // notifica a fine servizio; il numero resta se il nome non c'è.
            const fromDisplay = x.profileName || params.from || 'sconosciuto';
            pushSendToRoles(
                params.tenantId,
                ['OWNER', 'GENERAL_MANAGER', 'MANAGER'],
                {
                    category: 'message',
                    title: `Nuovo messaggio ${channelLabel}`,
                    body: preview ? `${fromDisplay}: ${preview}` : `Da ${fromDisplay}`,
                    url: '/?view=MESSAGGI',
                    tag: `msg-inbound-${row.id}`,
                },
                { excludeUserId: null }
            ).catch(err => console.warn('[inbound-log] push failed:', err?.message || err));
        }

        return row;
    } catch (err: any) {
        console.warn('[inbound-log] insert failed:', err?.message || err);
        return null;
    }
}

/** Chi vuole fare qualcosa di un messaggio appena registrato. Gli agganci
 *  girano dopo la risposta al provider e non devono mai lanciare. */
export type InboundHook = (tenantId: number, row: any, message: InboundMessage) => Promise<void> | void;
const hooks: InboundHook[] = [];

export function onInbound(hook: InboundHook): void {
    hooks.push(hook);
}

/** Registra un messaggio in arrivo e lo passa all'inbox e agli agganci. */
export async function processInbound(tenantId: number, message: InboundMessage): Promise<any | null> {
    const row = await logInboundMessage({
        tenantId,
        provider: message.provider,
        channel: message.channel,
        from: message.from,
        to: message.to,
        body: message.body,
        sid: message.sid,
        media: message.media,
        extras: {
            profileName: message.profileName,
            externalUserId: message.externalUserId,
            buttonPayload: message.button?.payload ?? null,
            buttonText: message.button?.text ?? null,
            repliedToSid: message.repliedToSid,
            location: message.location,
        },
    });
    if (!row) return null;
    try {
        whatsappDeps().broadcastToAll(tenantId, 'message:inbound', row);
    } catch (err: any) {
        console.warn('[inbound] broadcast fallito:', err?.message || err);
    }
    for (const hook of hooks) {
        try {
            await hook(tenantId, row, message);
        } catch (err: any) {
            console.warn('[inbound] aggancio fallito:', err?.message || err);
        }
    }
    return row;
}
