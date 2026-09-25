import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// L'informativa privacy pubblica (/privacy, /informativa-privacy,
// /privacy/<slug>) si costruisce da Impostazioni → Legale. Fino al
// 25/09/2026 getLegalConfig leggeva app_settings senza contesto tenant:
// in produzione (ruolo non superuser, RLS rigida) la richiesta anonima
// vedeva 0 righe e l'informativa usciva coi segnaposto «[Ragione sociale]»
// al posto dei dati del ristorante. Scoperto durante l'audit isolamento
// tenant (lotto 2, pagine pubbliche). Il file morde con TEST_STRICT_RLS=1:
// da superuser la lettura senza contesto vede comunque la riga.
describe('informativa privacy dai dati di Impostazioni → Legale', () => {
    const RAGIONE_SOCIALE = 'Frantoio Informativa Prova Srl';
    let previous: Record<string, unknown> = {};

    beforeAll(async () => {
        const token = await ownerToken();
        const cur = await api().get('/settings/legal').set(bearer(token));
        expect(cur.status).toBe(200);
        previous = cur.body;
        const put = await api().put('/settings/legal').set(bearer(token)).send({ company_name: RAGIONE_SOCIALE });
        expect(put.status).toBe(200);
    });

    afterAll(async () => {
        const token = await ownerToken();
        await api().put('/settings/legal').set(bearer(token))
            .send({ company_name: typeof previous.company_name === 'string' ? previous.company_name : '' });
    });

    it('la pagina anonima riporta la ragione sociale del ristorante, non il segnaposto', async () => {
        for (const path of ['/privacy', '/informativa-privacy']) {
            const res = await api().get(path);
            expect(res.status, path).toBe(200);
            expect(res.text, path).toContain(RAGIONE_SOCIALE);
            expect(res.text, path).not.toContain('[Ragione sociale]');
        }
    });
});
