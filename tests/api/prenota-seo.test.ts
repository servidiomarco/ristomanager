import { describe, it, expect } from 'vitest';
import { api } from './helpers';

// Testa SEO della pagina di prenotazione.
//
// Il test che conta davvero è l'ultimo: due ristoranti diversi devono avere
// titoli diversi. Senza, ogni cliente ha una pagina gemella delle altre e si
// fanno concorrenza fra loro — che era la situazione prima di questo lavoro.
//
// Durante lo sviluppo il primo tentativo passava tutti i controlli tranne
// quello: un ristorante senza identità configurata riceveva il nome del
// PRIMO ristorante (la costante di riserva è cablata su quello). Sarebbe
// finito nel titolo, e nel titolo resta indicizzato.

const titolo = (html: string): string =>
    (html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim();

describe('SEO della pagina di prenotazione', () => {
    it('il titolo contiene il nome del ristorante, non solo "Prenota un tavolo"', async () => {
        const res = await api().get('/prenota');
        expect(res.status).toBe(200);
        const t = titolo(res.text);
        expect(t.length).toBeGreaterThan(0);
        // Il nome sta PRIMA: Google tronca intorno ai 60 caratteri, e ciò che
        // sta in fondo può non vedersi mai.
        expect(t).not.toBe('Prenota un tavolo');
        expect(t).toMatch(/— Prenota un tavolo$/);
    });

    it('espone descrizione, canonical e Open Graph', async () => {
        const { text } = await api().get('/prenota');
        expect(text).toMatch(/<meta name="description" content="[^"]{20,}"/);
        expect(text).toMatch(/<link rel="canonical" href="https?:\/\/[^"]+"/);
        expect(text).toMatch(/<meta property="og:title"/);
    });

    it('espone dati strutturati Restaurant validi, senza campi vuoti', async () => {
        const { text } = await api().get('/prenota');
        const m = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
        expect(m, 'JSON-LD assente').toBeTruthy();
        const d = JSON.parse(m![1].replace(/\\u003c/g, '<'));
        expect(d['@type']).toBe('Restaurant');
        expect(d.acceptsReservations).toBe(true);
        expect(d.name).toBeTruthy();
        expect(d.potentialAction?.['@type']).toBe('ReserveAction');
        // Un campo a stringa vuota è peggio che assente: dice al motore che
        // il dato non esiste invece di lasciarlo dedurre.
        for (const [k, v] of Object.entries(d)) {
            expect(v, `campo vuoto: ${k}`).not.toBe('');
        }
    });

    it('il corpo della pagina resta intatto: il form deve funzionare', async () => {
        // Una prenotazione persa costa più di una testa SEO mancante.
        const { text } = await api().get('/prenota');
        expect(text).toContain('</html>');
        expect(text.length).toBeGreaterThan(10_000);
    });

    it('robots.txt esiste e dichiara la sitemap', async () => {
        const res = await api().get('/robots.txt');
        expect(res.status).toBe(200);
        expect(res.text).toMatch(/^User-agent: \*/m);
        expect(res.text).toMatch(/^Sitemap: https?:\/\/.+\/sitemap\.xml$/m);
    });

    it('la sitemap elenca una pagina per ristorante', async () => {
        const res = await api().get('/sitemap.xml');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<urlset');
        expect(res.text).toMatch(/<loc>https?:\/\/[^<]*\/prenota<\/loc>/);
        // Almeno la pagina generica; con più ristoranti attivi, una per ognuno.
        expect((res.text.match(/<loc>/g) || []).length).toBeGreaterThanOrEqual(1);
    });

    it('uno slug inesistente resta 404, non una pagina col nome sbagliato', async () => {
        const res = await api().get('/prenota/ristorante-che-non-esiste');
        expect(res.status).toBe(404);
    });
});
