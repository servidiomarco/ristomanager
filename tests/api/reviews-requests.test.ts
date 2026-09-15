import { describe, it, expect } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Registro delle richieste di recensione (pagina Recensioni, PR A4):
// GET /reviews/requests dietro l'add-on 'reviews' e reviews:view.
describe('recensioni — registro richieste', () => {
    it('richiede autenticazione', async () => {
        const res = await api().get('/reviews/requests');
        expect(res.status).toBe(401);
    });

    it('risponde con la forma { total, requests } (vuota su DB pulito)', async () => {
        const token = await ownerToken();
        const res = await api().get('/reviews/requests').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(0);
        expect(res.body.requests).toEqual([]);
    });

    it('senza l\'add-on chiude con 403 feature_not_enabled', async () => {
        const token = await ownerToken();
        const off = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: false });
        expect(off.status).toBe(200);

        const res = await api().get('/reviews/requests').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'feature_not_enabled', feature: 'reviews' });

        const on = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: true });
        expect(on.status).toBe(200);
    });
});
