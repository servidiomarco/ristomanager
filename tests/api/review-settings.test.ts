import { describe, it, expect, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Impostazioni → Recensioni (piano recensioni, PR A3): GET/PUT
// /review-settings dietro l'add-on 'reviews'; il PUT esige reviews:manage.
describe('recensioni — impostazioni', () => {
    // Si riportano i default: i file di test girano in sequenza sullo
    // stesso server e lo sweep legge queste chiavi.
    afterAll(async () => {
        const token = await ownerToken();
        await api().put('/review-settings').set(bearer(token)).send({
            review_requests_enabled: false,
            timing: 'next_morning',
            delay_hours: 2,
            audience: 'consent',
            reply_automation: 'draft',
            google_place_id: null,
        });
        await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: true });
    });

    it('GET richiede autenticazione', async () => {
        const res = await api().get('/review-settings');
        expect(res.status).toBe(401);
    });

    it('GET risponde coi default prudenti', async () => {
        const token = await ownerToken();
        const res = await api().get('/review-settings').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            review_requests_enabled: false,
            timing: 'next_morning',
            delay_hours: 2,
            audience: 'consent',
            reply_automation: 'draft',
            google_place_id: null,
        });
    });

    it('PUT valida i valori', async () => {
        const token = await ownerToken();
        const badTiming = await api().put('/review-settings').set(bearer(token)).send({ timing: 'subito' });
        expect(badTiming.status).toBe(400);
        const badDelay = await api().put('/review-settings').set(bearer(token)).send({ delay_hours: 0 });
        expect(badDelay.status).toBe(400);
        const badAutomation = await api().put('/review-settings').set(bearer(token)).send({ reply_automation: 'sempre' });
        expect(badAutomation.status).toBe(400);
    });

    it('PUT salva e il GET rilegge (Place ID compreso)', async () => {
        const token = await ownerToken();
        const put = await api().put('/review-settings').set(bearer(token)).send({
            review_requests_enabled: true,
            timing: 'delay',
            delay_hours: 3,
            audience: 'all',
            reply_automation: 'auto_positive',
            google_place_id: '  ChIJTest123  ',
        });
        expect(put.status).toBe(200);
        expect(put.body.timing).toBe('delay');
        expect(put.body.delay_hours).toBe(3);
        expect(put.body.google_place_id).toBe('ChIJTest123');

        const get = await api().get('/review-settings').set(bearer(token));
        expect(get.body).toEqual({
            review_requests_enabled: true,
            timing: 'delay',
            delay_hours: 3,
            audience: 'all',
            reply_automation: 'auto_positive',
            google_place_id: 'ChIJTest123',
        });
    });

    it('senza l\'add-on le route chiudono con 403 feature_not_enabled', async () => {
        const token = await ownerToken();
        const off = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: false });
        expect(off.status).toBe(200);

        const res = await api().get('/review-settings').set(bearer(token));
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'feature_not_enabled', feature: 'reviews' });

        const on = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: true });
        expect(on.status).toBe(200);
    });
});
