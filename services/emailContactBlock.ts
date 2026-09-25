// Il blocco «Contattaci direttamente» delle email al cliente: telefono,
// WhatsApp e mappa del ristorante, scritti in Impostazioni → Legale.
//
// PERCHÉ È FUORI DA server.ts. Audit M-08 (contesta:N-public-xss): il link
// alla mappa entrava nell'href così com'era salvato, senza escape né
// controllo dello schema — un maps_url con le virgolette usciva
// dall'attributo, uno «javascript:» diventava il link. Qui il blocco è una
// funzione pura, e tests/api/pagine-pubbliche-escape.test.ts la prova senza
// dover spedire una email.

export interface ContactBlockIdentity {
    phone: string;
    whatsapp: string;
    mapsUrl: string;
}

const escapeHtml = (s: unknown): string =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

// Solo URL assoluti http(s). In una email un link relativo non porta da
// nessuna parte (il client non ha una pagina da cui risolverlo), e
// javascript:/data: non devono mai diventare un href. Se il valore non
// passa, il link alla mappa si omette invece di spedirlo rotto.
export const safeHttpUrl = (value: unknown): string | null => {
    const s = String(value ?? '').trim();
    if (!s) return null;
    try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
        return null;
    }
};

// tel:/wa.me a partire dal numero scritto per umani. Regola: se c'è un "+"
// il prefisso internazionale è già nel numero, altrimenti si assume Italia —
// coerente col resto del codebase (normalizeItalianPhone).
export function phoneHref(display: string): string {
    const digits = display.replace(/\D/g, '');
    return `tel:+${display.includes('+') ? digits : `39${digits}`}`;
}
export function whatsappHref(display: string): string {
    const digits = display.replace(/\D/g, '');
    return `https://wa.me/${display.includes('+') ? digits : `39${digits}`}`;
}

// Rendered block with call/WhatsApp CTAs for the customer emails. Kept in one
// place so any future number change lives in a single spot. The WhatsApp link
// uses wa.me (works in Gmail, iOS Mail, most clients); the phone link uses
// tel: so a tap on mobile opens the dialer.
// Ogni valore del tenant passa da escapeHtml, anche gli href costruiti dalle
// sole cifre: il blocco resta sicuro anche se un domani cambiano.
export function renderContactBlockHtml(identity: ContactBlockIdentity, english: boolean): string {
    const mapsUrl = safeHttpUrl(identity.mapsUrl);
    const mapsLink = mapsUrl
        ? `
            &nbsp;·&nbsp;
            📍 <a href="${escapeHtml(mapsUrl)}" style="color:#065f46;text-decoration:none;">${english ? 'Get directions' : 'Come raggiungerci'}</a>`
        : '';
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:0 0 16px;">
        <tr>
          <td style="font-size:13px;line-height:1.6;color:#57534e;padding:8px 12px;border:1px solid #e7e5e4;border-radius:10px;background:#fbf9f4;">
            <strong style="color:#292524;">${english ? 'Contact us directly:' : 'Contattaci direttamente:'}</strong><br>
            📞 <a href="${escapeHtml(phoneHref(identity.phone))}" style="color:#065f46;text-decoration:none;">${escapeHtml(identity.phone)}</a>
            &nbsp;·&nbsp;
            💬 <a href="${escapeHtml(whatsappHref(identity.whatsapp))}" style="color:#065f46;text-decoration:none;">WhatsApp ${escapeHtml(identity.whatsapp)}</a>${mapsLink}
          </td>
        </tr>
      </table>
    `;
}
