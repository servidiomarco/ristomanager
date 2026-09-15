import { describe, it, expect, afterAll } from 'vitest';
import { api, ownerToken, bearer } from './helpers';

// Fondamenta della gestione recensioni (piano recensioni, PR A1): add-on
// 'reviews' in tenant_features (acceso per il tenant 1 dalla migration
// richieste-recensione), permessi reviews:view/manage seminati in
// role_permissions, flag operativo review_requests_enabled con default
// false e mascheramento quando l'add-on è spento.
describe('recensioni — fondamenta', () => {
    // Il tenant 1 torna com'era: i file di test girano in sequenza sullo
    // stesso server e i successivi contano sugli add-on attivi.
    afterAll(async () => {
        const token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: true });
        await api().put('/settings/features').set(bearer(token)).send({ review_requests_enabled: false });
    });

    it('il tenant 1 ha l\'add-on reviews e l\'owner i permessi reviews:*', async () => {
        const token = await ownerToken();
        const me = await api().get('/auth/me').set(bearer(token));
        expect(me.status).toBe(200);
        expect(me.body.tenant?.features?.reviews).toBe(true);
        expect(me.body.permissions).toContain('reviews:view');
        expect(me.body.permissions).toContain('reviews:manage');
    });

    it('review_requests_enabled esiste e nasce spento', async () => {
        const token = await ownerToken();
        const res = await api().get('/settings/features').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.review_requests_enabled).toBe(false);
    });

    it('con l\'add-on spento il flag operativo si maschera a false', async () => {
        const token = await ownerToken();

        const flagOn = await api().put('/settings/features').set(bearer(token)).send({ review_requests_enabled: true });
        expect(flagOn.status).toBe(200);

        const off = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: false });
        expect(off.status).toBe(200);

        const masked = await api().get('/settings/features').set(bearer(token));
        expect(masked.status).toBe(200);
        expect(masked.body.review_requests_enabled).toBe(false);

        // Rivenduto: il flag operativo riemerge com'era, senza ritoccarlo.
        const on = await api().put('/settings/entitlements').set(bearer(token)).send({ reviews: true });
        expect(on.status).toBe(200);

        const visible = await api().get('/settings/features').set(bearer(token));
        expect(visible.body.review_requests_enabled).toBe(true);
    });
});
