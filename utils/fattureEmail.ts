// L'indirizzo email da cui un locale riceve le fatture dei fornitori.
//
// Forma: `<slug>-<token>@<dominio>`, per esempio
// `vecchiofrantoio-7k2p9q4m1x0a@fatture.sympotia.com`. Lo slug serve a chi lo
// legge (il commercialista vede di che locale è); il locale lo trova il
// token, la parte dopo l'ultimo trattino, che è anche l'unica segreta.
// Chi conosce l'indirizzo può mandare fatture «da controllare»: per questo il
// token si può rigenerare.
//
// Funzioni pure: le usano il webhook (services/fattureEmail.ts) e i test.

export const TOKEN_LENGTH = 12;
const TOKEN_RE = /^[a-z0-9]{10,32}$/;

/** Lo slug ridotto a quello che sta bene davanti a una chiocciola. */
export const slugPerIndirizzo = (slug: string | null | undefined): string => {
    const s = String(slug ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 30)
        .replace(/-$/, '');
    return s || 'fatture';
};

export const indirizzoFatture = (slug: string | null | undefined, token: string, dominio: string): string =>
    `${slugPerIndirizzo(slug)}-${token}@${dominio.toLowerCase()}`;

/** «Mollo Ortofrutta <fatture@mollo.it>» → «fatture@mollo.it». */
export const soloIndirizzo = (raw: string): string => {
    const m = String(raw).match(/<([^>]+)>/);
    return (m ? m[1] : String(raw)).trim().toLowerCase();
};

/**
 * I token degli indirizzi del nostro dominio fra i destinatari. Un'email
 * inoltrata a due locali (o a uno solo e a qualcun altro) ne dà uno per locale.
 */
export const tokenDaDestinatari = (destinatari: unknown[], dominio: string): string[] => {
    const dom = dominio.toLowerCase();
    const out = new Set<string>();
    for (const raw of destinatari) {
        if (typeof raw !== 'string') continue;
        const addr = soloIndirizzo(raw);
        const at = addr.lastIndexOf('@');
        if (at < 1 || addr.slice(at + 1) !== dom) continue;
        const local = addr.slice(0, at).split('+')[0];
        const token = local.slice(local.lastIndexOf('-') + 1);
        if (TOKEN_RE.test(token)) out.add(token);
    }
    return [...out];
};

/** Gli allegati che possono essere fatture: si aprono, gli altri si annotano. */
export const allegatoFattura = (nome: string, contentType?: string | null): boolean =>
    /\.(xml|p7m|zip)$/i.test(nome) || /(xml|zip|pkcs7)/i.test(contentType ?? '');
