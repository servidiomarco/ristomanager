// Testa SEO della pagina di prenotazione, resa dal server.
//
// PERCHÉ ESISTE. La pagina /prenota è un file HTML statico servito identico a
// ogni ristorante: il nome del locale lo scriveva il JavaScript dopo il
// caricamento. Per un browser va bene; per la ricerca no. Il risultato era che
// ogni ristorante cliente aveva una pagina con lo stesso titolo generico
// ("Prenota un tavolo"), nessuna descrizione e nessun dato strutturato —
// cioè N pagine gemelle che si facevano concorrenza fra loro.
//
// Conta più di quanto sembri. Misurato su octotable.com, il traffico organico
// di un concorrente diretto NON arriva dalle sue pagine di prodotto: arriva
// dalle pagine di prenotazione che ospita, posizionate sul NOME del ristorante
// ("felice a testaccio roma", 40.500 ricerche/mese). Un solo ristorante
// cliente vale, in volume, più di tutta la categoria software italiana
// ("gestionale ristorante": 720/mese).
//
// Qui la testa viene costruita a server, prima di spedire l'HTML: titolo col
// nome del locale, descrizione, canonical, Open Graph e JSON-LD Restaurant con
// acceptsReservations. Il corpo della pagina resta quello di sempre.

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PrenotaIdentity {
    name: string;
    tagline: string;
    address: string;
    phone: string;
    websiteUrl: string;
    mapsUrl: string;
}

const esc = (v: unknown): string =>
    String(v ?? '').replace(/[&<>"']/g, ch =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] as string));

// Il file cambia solo a ogni deploy: leggerlo a ogni richiesta sarebbe un
// accesso al disco per ogni cliente che apre la pagina.
let cache: string | null = null;
export const invalidatePrenotaCache = (): void => { cache = null; };

const leggiPagina = async (): Promise<string> => {
    if (cache === null) {
        cache = await readFile(path.join(process.cwd(), 'public', 'prenota.html'), 'utf8');
    }
    return cache;
};

/**
 * Titolo. L'ordine non è estetico: il nome del ristorante sta PRIMA perché è
 * la parola per cui la pagina deve essere trovata, e perché Google tronca
 * intorno ai 60 caratteri — quello che sta in fondo può non vedersi mai.
 */
export const buildTitle = (id: PrenotaIdentity): string => {
    const nome = (id.name || '').trim();
    if (!nome) return 'Prenota un tavolo';
    return `${nome} — Prenota un tavolo`;
};

const buildDescription = (id: PrenotaIdentity): string => {
    const nome = (id.name || 'il ristorante').trim();
    const dove = (id.address || '').trim();
    // Una descrizione che dice cosa si fa qui e dove: è il testo che il
    // cliente legge nei risultati, non un contenitore di parole chiave.
    return dove
        ? `Prenota online un tavolo da ${nome}, ${dove}. Conferma immediata, senza chiamare.`
        : `Prenota online un tavolo da ${nome}. Conferma immediata, senza chiamare.`;
};

/**
 * JSON-LD Restaurant con acceptsReservations. È ciò che permette a Google di
 * capire che la pagina PRENOTA da quel ristorante, invece di indovinarlo dal
 * testo — e apre i risultati arricchiti.
 * I campi vuoti si omettono: un `address` a stringa vuota è peggio che assente.
 */
const buildJsonLd = (id: PrenotaIdentity, url: string): string => {
    const dati: Record<string, unknown> = {
        '@context': 'https://schema.org',
        '@type': 'Restaurant',
        name: id.name,
        url,
        acceptsReservations: true,
        potentialAction: {
            '@type': 'ReserveAction',
            target: { '@type': 'EntryPoint', urlTemplate: url, actionPlatform: 'https://schema.org/DesktopWebPlatform' },
            result: { '@type': 'FoodEstablishmentReservation', name: 'Prenotazione tavolo' },
        },
    };
    if (id.tagline?.trim()) dati.description = id.tagline.trim();
    if (id.address?.trim()) dati.address = { '@type': 'PostalAddress', streetAddress: id.address.trim() };
    if (id.phone?.trim()) dati.telephone = id.phone.trim();
    if (id.mapsUrl?.trim()) dati.hasMap = id.mapsUrl.trim();
    if (id.websiteUrl?.trim() && id.websiteUrl.trim() !== url) dati.sameAs = [id.websiteUrl.trim()];
    // </script> dentro una stringa chiuderebbe il blocco: unico carattere da
    // neutralizzare in JSON-LD, il resto è già JSON valido.
    return JSON.stringify(dati).replace(/</g, '\\u003c');
};

/**
 * Restituisce l'HTML della pagina con la testa costruita per questo
 * ristorante. Se qualcosa non torna, si torna alla pagina originale: una
 * prenotazione persa costa più di una testa SEO mancante.
 */
export const renderPrenota = async (id: PrenotaIdentity, canonical: string): Promise<string> => {
    const html = await leggiPagina();
    try {
        const titolo = esc(buildTitle(id));
        const descrizione = esc(buildDescription(id));
        const url = esc(canonical);
        const testa = [
            `<meta name="description" content="${descrizione}" />`,
            `<link rel="canonical" href="${url}" />`,
            `<meta property="og:type" content="restaurant" />`,
            `<meta property="og:title" content="${titolo}" />`,
            `<meta property="og:description" content="${descrizione}" />`,
            `<meta property="og:url" content="${url}" />`,
            `<meta name="twitter:card" content="summary" />`,
            `<script type="application/ld+json">${buildJsonLd(id, canonical)}</script>`,
        ].join('\n    ');

        return html
            .replace('<title>Prenota un tavolo</title>', `<title>${titolo}</title>\n    ${testa}`);
    } catch {
        return html;
    }
};
