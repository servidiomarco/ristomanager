// «Farsi trovare»: il link wa.me del locale, col testo già scritto, per la
// pagina /prenota, il menu digitale, Google e Instagram. Esiste solo se il
// locale ha un numero WhatsApp collegato (getSender): un link a un numero
// che non risponde è peggio di nessun link.

import { getSender } from './config.js';
import { getEntryPolicy } from './settings.js';

export const DEFAULT_PREFILL_TEXT = 'Ciao! Vorrei prenotare un tavolo.';

/** Il numero del mittente in E.164, senza «whatsapp:». */
export function senderPhone(from: string): string {
    return from.replace(/^whatsapp:/, '');
}

export function waMeUrl(phoneE164: string, text?: string | null): string {
    const digits = phoneE164.replace(/\D/g, '');
    const t = (text ?? '').trim();
    return `https://wa.me/${digits}${t ? `?text=${encodeURIComponent(t)}` : ''}`;
}

/** Il numero com'è scritto per gli umani: +39 389 591 6494. */
export function displayPhone(phoneE164: string): string {
    const m = /^\+39(\d{3})(\d{3})(\d{3,4})$/.exec(phoneE164);
    return m ? `+39 ${m[1]} ${m[2]} ${m[3]}` : phoneE164;
}

/** Il link per una pagina pubblica, se il locale l'ha acceso lì. */
export async function publicWhatsAppLink(tenantId: number, where: 'booking' | 'menu'): Promise<{ url: string; display: string } | null> {
    const policy = await getEntryPolicy(tenantId);
    if (where === 'booking' ? !policy.show_on_booking_page : !policy.show_on_menu) return null;
    const sender = await getSender(tenantId);
    if (!sender) return null;
    const phone = senderPhone(sender.from);
    return { url: waMeUrl(phone, policy.prefill_text || DEFAULT_PREFILL_TEXT), display: displayPhone(phone) };
}
