// Gli allegati dei clienti stanno presso il provider, dietro le credenziali
// del mittente del ristorante. Qui si scaricano: per il proxy dell'Inbox,
// per la trascrizione dei vocali e per le foto che l'agente guarda.

import { getSender, twilioRestBase } from '../config.js';
import { twilioMediaAuthHeader } from '../providers/twilio.js';
import { META_MEDIA_PREFIX, metaFetchMedia } from '../providers/meta.js';

export interface MediaItem {
    url?: string | null;
    content_type?: string | null;
}

export class MediaFetchError extends Error {
    constructor(message: string, public readonly status: number) {
        super(message);
        this.name = 'MediaFetchError';
    }
}

// Oltre i 25 MB non è un vocale né una foto da guardare.
export const MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/** Solo gli host del provider: l'url arriva dal webhook, ma una riga
 *  manomessa non deve trasformare il backend in un proxy aperto. L'host di
 *  TWILIO_REST_URL vale per lo stub dei test. */
function allowedHost(url: string): boolean {
    let host: string;
    try { host = new URL(url).host; } catch { return false; }
    if (/(^|\.)twilio\.com$/.test(host)) return true;
    try { return host === new URL(twilioRestBase()).host; } catch { return false; }
}

/** Il file dell'allegato, con le credenziali del mittente del ristorante. */
export async function fetchInboundMedia(tenantId: number, item: MediaItem): Promise<{ bytes: Buffer; contentType: string }> {
    const url = String(item.url || '');
    if (!url) throw new MediaFetchError('Allegato senza indirizzo', 404);
    // Meta: nel database c'è l'id dell'allegato, l'url si chiede adesso.
    if (url.startsWith(META_MEDIA_PREFIX)) {
        const sender = await getSender(tenantId);
        if (sender?.provider !== 'meta') throw new MediaFetchError('WhatsApp non collegato', 503);
        try {
            const file = await metaFetchMedia(sender, url.slice(META_MEDIA_PREFIX.length));
            if (file.bytes.length > MEDIA_MAX_BYTES) throw new MediaFetchError('Allegato troppo grande', 413);
            return file;
        } catch (err: any) {
            if (err instanceof MediaFetchError) throw err;
            throw new MediaFetchError(err?.message || 'Allegato non recuperabile', 502);
        }
    }
    if (!allowedHost(url)) throw new MediaFetchError('Host non consentito', 400);
    // Un allegato si scarica solo dall'account che l'ha ricevuto.
    const sender = await getSender(tenantId);
    if (sender?.provider !== 'twilio') throw new MediaFetchError('WhatsApp non collegato', 503);
    const upstream = await fetch(url, { headers: { Authorization: twilioMediaAuthHeader(sender) } });
    if (!upstream.ok) throw new MediaFetchError(`Il provider ha risposto ${upstream.status}`, 502);
    const declared = Number(upstream.headers.get('content-length') || 0);
    if (declared > MEDIA_MAX_BYTES) throw new MediaFetchError('Allegato troppo grande', 413);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (bytes.length > MEDIA_MAX_BYTES) throw new MediaFetchError('Allegato troppo grande', 413);
    return { bytes, contentType: upstream.headers.get('content-type') || item.content_type || 'application/octet-stream' };
}
