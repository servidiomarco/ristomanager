// Twilio: firma dei webhook, invio dei messaggi, lettura di quelli in arrivo.
//
// Solo il protocollo di Twilio, niente database: chi registra il messaggio,
// a quale ristorante appartiene e cosa farne lo decidono outbound.ts e
// inbound.ts. Il codice viene da server.ts (sendTwilioWhatsApp,
// sendTwilioSms, validateTwilioSignature, il parsing del webhook in arrivo)
// con lo stesso comportamento.

import crypto from 'crypto';
import type express from 'express';
import type { InboundMessage, InboundMedia, InboundLocation, TwilioSender } from '../types.js';

// Twilio firma ogni richiesta: HMAC-SHA1 col token dell'account sull'URL
// pubblico seguito dai parametri ordinati (chiave+valore), in base64. Serve
// trust-proxy=1 (già impostato) perché req.protocol/host siano l'URL che
// Twilio ha configurato, non il loopback che Railway vede dentro.
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
    const data = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ''), url);
    return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

export function isValidTwilioSignature(req: express.Request, authToken: string | null | undefined): boolean {
    if (!authToken) return false;
    const signature = req.header('X-Twilio-Signature');
    if (!signature) return false;
    try {
        const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
        const expected = twilioSignature(authToken, url, (req.body || {}) as Record<string, string>);
        const a = Buffer.from(signature);
        const b = Buffer.from(expected);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch (err) {
        console.error('[Twilio] Signature validation failed:', err);
        return false;
    }
}

export interface TwilioSendRequest {
    /** Destinatario già normalizzato: `whatsapp:+E164` o `+E164` per gli SMS. */
    to: string;
    body?: string;
    contentSid?: string;
    contentVariables?: Record<string, string>;
    mediaUrls?: string[];
    statusCallback?: string | null;
    /** Mittente esplicito (WhatsApp, SMS da numero o alfanumerico). */
    from?: string;
    /** Servizio di messaggistica (SMS col mittente alfanumerico). */
    messagingServiceSid?: string;
}

/** `error` c'è solo quando `ok` è falso. */
export interface TwilioSendOutcome {
    ok: boolean;
    sid?: string;
    error?: string;
}

/** Una POST su Messages.json. Non lancia per un rifiuto di Twilio: lo
 *  restituisce, così chi chiama registra il tentativo fallito. Lancia solo
 *  per gli errori di rete, come la fetch che c'era prima. */
export async function twilioSendMessage(
    creds: { accountSid: string; authToken: string; restBase: string },
    req: TwilioSendRequest
): Promise<TwilioSendOutcome> {
    const form = new URLSearchParams({ To: req.to });
    if (req.messagingServiceSid) form.set('MessagingServiceSid', req.messagingServiceSid);
    else if (req.from) form.set('From', req.from);
    if (req.contentSid) {
        // I messaggi che partono da noi fuori finestra vogliono un template
        // approvato; con ContentSid Twilio ignora il Body.
        form.set('ContentSid', req.contentSid);
        form.set('ContentVariables', JSON.stringify(req.contentVariables ?? {}));
    } else {
        // Con un allegato il testo diventa la didascalia e può mancare:
        // Twilio rifiuta un Body vuoto, quindi lo si mette solo se c'è.
        if (req.body) form.set('Body', req.body);
        for (const url of req.mediaUrls ?? []) form.append('MediaUrl', url);
    }
    if (req.statusCallback) form.set('StatusCallback', req.statusCallback);

    const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64');
    const response = await fetch(`${creds.restBase}/2010-04-01/Accounts/${creds.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });
    const result = await response.json().catch(() => ({} as any)) as { sid?: string };
    if (!response.ok) {
        return { ok: false, error: `${response.status} - ${JSON.stringify(result)}` };
    }
    return { ok: true, sid: result.sid };
}

/** Header per scaricare un allegato da Twilio (gli URL dei media sono
 *  protetti dalle credenziali dell'account). */
export function twilioMediaAuthHeader(sender: TwilioSender): string {
    return `Basic ${Buffer.from(`${sender.accountSid}:${sender.authToken}`).toString('base64')}`;
}

const str = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s : null;
};

/**
 * Il messaggio in arrivo dal corpo del webhook Twilio, o null se non c'è
 * niente da registrare.
 *
 * Oltre a testo e allegati (gli unici campi letti fino all'11/10/2026) si
 * tengono il nome del profilo, l'id utente, il tocco su un bottone di
 * risposta rapida, il messaggio a cui si risponde e la posizione condivisa:
 * una posizione arriva senza Body né allegati, e prima veniva scartata.
 */
export function parseTwilioInbound(params: Record<string, any>): InboundMessage | null {
    const fromRaw = String(params?.From || '');
    const toRaw = String(params?.To || '');
    const from = fromRaw.replace(/^whatsapp:/, '');
    const to = toRaw.replace(/^whatsapp:/, '');
    const channel: 'sms' | 'whatsapp' = fromRaw.startsWith('whatsapp:') ? 'whatsapp' : 'sms';

    const numMedia = Number(params?.NumMedia || 0);
    const media: InboundMedia[] = [];
    for (let i = 0; i < numMedia; i++) {
        const url = String(params?.[`MediaUrl${i}`] || '');
        if (!url) continue;
        media.push({ url, content_type: String(params?.[`MediaContentType${i}`] || 'application/octet-stream') });
    }

    const lat = Number(params?.Latitude);
    const lng = Number(params?.Longitude);
    const location: InboundLocation | null = params?.Latitude != null && params?.Longitude != null
        && Number.isFinite(lat) && Number.isFinite(lng)
        ? { latitude: lat, longitude: lng, label: str(params?.Label), address: str(params?.Address) }
        : null;

    const buttonPayload = str(params?.ButtonPayload);
    const buttonText = str(params?.ButtonText);
    const button = buttonPayload || buttonText
        ? { payload: buttonPayload, text: buttonText, type: str(params?.ButtonType) }
        : null;

    let body = String(params?.Body || '').trim();
    if (!body && location) body = describeLocation(location);
    if (!body && button?.text) body = button.text;

    if (!from || (!body && media.length === 0)) return null;

    return {
        provider: 'twilio',
        channel,
        from,
        to,
        body,
        sid: str(params?.MessageSid) ?? str(params?.SmsMessageSid),
        media,
        profileName: str(params?.ProfileName),
        externalUserId: str(params?.ExternalUserId),
        button,
        repliedToSid: str(params?.OriginalRepliedMessageSid),
        location,
    };
}

/** Il testo che rappresenta una posizione nella conversazione: leggibile
 *  da chi apre l'inbox e da chi la passa all'agente. */
export function describeLocation(loc: InboundLocation): string {
    const where = [loc.label, loc.address].filter(Boolean).join(', ');
    const link = `https://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
    return where ? `📍 ${where} ${link}` : `📍 Posizione ${link}`;
}
