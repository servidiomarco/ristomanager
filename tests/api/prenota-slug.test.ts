import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api } from './helpers';

// Prenotazioni web per tenant (Fase C3): i path /public/:slug/* e
// /prenota/:slug risolvono il tenant dallo slug, i path storici restano
// sul fallback (tenant 1) e i domini custom passano da tenant_domains.
//
// Il tenant 2 viene provisionato via SQL diretto come in rls.test.ts:
// tenants + tenant_features + opening_hours + legal_config — è la stessa
// sequenza che farà il provisioning D1, e la riga web_booking dimostra che
// il gating C1 è davvero per tenant (senza, l'availability risponde 503).
//
// Data futura fissa come in availability.test.ts: per la data odierna
// l'endpoint scarta gli slot già passati e il test dipenderebbe
// dall'orologio.
const DATA_FUTURA = '2027-03-10';
const DOMINIO_TEST = 'prenota.trattoria-slug.test';

describe('prenotazioni web per tenant (slug e domini, Fase C3)', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL });
        await db.connect();
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (2, 'trattoria-slug', 'Trattoria Slug')
                        ON CONFLICT (id) DO NOTHING`);
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        // Entitlement web_booking (C1): feature assente = non venduta =
        // spenta. Senza questa riga /public/trattoria-slug/availability
        // risponderebbe 503 — inserirla È il provisioning realistico.
        await db.query(`INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES (2, 'web_booking', true)
                        ON CONFLICT (tenant_id, feature) DO NOTHING`);
        // Orari SOLO per il weekday della data fissa: pranzo 12:00-13:00,
        // deliberatamente diverso dal seed del tenant 1 (13:00-14:00) per
        // provare l'isolamento degli orari per tenant.
        const weekday = new Date(DATA_FUTURA + 'T00:00:00').getDay();
        await db.query(
            `INSERT INTO opening_hours (tenant_id, weekday, lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes)
             VALUES (2, $1, '12:00', '13:00', NULL, NULL, 30)
             ON CONFLICT DO NOTHING`,
            [weekday]
        );
        // Branding: business_name in legal_config, la fonte di
        // businessIdentity() servita da /public/:slug/contact.
        await db.query(
            `INSERT INTO app_settings (tenant_id, key, text_value) VALUES (2, 'legal_config', $1)
             ON CONFLICT DO NOTHING`,
            [JSON.stringify({ business_name: 'Trattoria Slug' })]
        );
        // Dominio custom di prova per il redirect della root e il routing
        // per hostname dei path storici.
        await db.query(`INSERT INTO tenant_domains (domain, tenant_id, purpose) VALUES ($1, 2, 'booking')
                        ON CONFLICT DO NOTHING`, [DOMINIO_TEST]);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM tenant_domains WHERE tenant_id = 2`);
        await db.query(`DELETE FROM tenant_features WHERE tenant_id = 2`);
        await db.query(`DELETE FROM app_settings WHERE tenant_id = 2`);
        await db.query(`DELETE FROM opening_hours WHERE tenant_id = 2`);
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = 2`);
        await db.query(`DELETE FROM tenants WHERE id = 2`);
        await db.end();
    });

    it('GET /public/:slug/availability serve gli orari del SUO tenant', async () => {
        const res = await api().get('/public/trattoria-slug/availability').query({ date: DATA_FUTURA });
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(DATA_FUTURA);
        // 12:00-13:00 passo 30': orari del tenant 2, non quelli del seed.
        expect(res.body.lunch.slots).toEqual(['12:00', '12:30', '13:00']);
        expect(res.body.dinner.slots).toEqual([]);
    });

    it('il path storico /public/availability resta sul tenant 1 (fallback)', async () => {
        const res = await api().get('/public/availability').query({ date: DATA_FUTURA });
        expect(res.status).toBe(200);
        expect(res.body.lunch.slots).toEqual(['13:00', '13:30', '14:00']);
    });

    it('GET /public/vecchio-frantoio/contact porta il branding del tenant 1', async () => {
        const res = await api().get('/public/vecchio-frantoio/contact');
        expect(res.status).toBe(200);
        expect(res.body.branding.name).toBe('Il Vecchio Frantoio');
    });

    it('GET /public/trattoria-slug/contact porta il branding del tenant 2', async () => {
        const res = await api().get('/public/trattoria-slug/contact');
        expect(res.status).toBe(200);
        expect(res.body.branding.name).toBe('Trattoria Slug');
    });

    it('slug ignoto → 404, mai il fallback sul tenant 1', async () => {
        const avail = await api().get('/public/ristorante-inesistente/availability').query({ date: DATA_FUTURA });
        expect(avail.status).toBe(404);
        expect(avail.body.error).toBe('unknown_slug');
        const contact = await api().get('/public/ristorante-inesistente/contact');
        expect(contact.status).toBe(404);
    });

    it('GET /prenota/:slug serve la pagina, slug ignoto → 404', async () => {
        const ok = await api().get('/prenota/trattoria-slug');
        expect(ok.status).toBe(200);
        expect(ok.headers['content-type']).toContain('text/html');
        const ko = await api().get('/prenota/ristorante-inesistente');
        expect(ko.status).toBe(404);
    });

    it('il dominio in tenant_domains instrada la root e i path storici', async () => {
        // Root: redirect alla pagina del tenant del dominio.
        const root = await api().get('/').set('Host', DOMINIO_TEST);
        expect(root.status).toBe(301);
        expect(root.headers.location).toBe('/prenota/trattoria-slug');
        // Path storico senza slug: il resolver usa l'hostname prima del
        // fallback, quindi gli orari sono quelli del tenant 2.
        const avail = await api().get('/public/availability')
            .set('Host', DOMINIO_TEST)
            .query({ date: DATA_FUTURA });
        expect(avail.status).toBe(200);
        expect(avail.body.lunch.slots).toEqual(['12:00', '12:30', '13:00']);
    });
});
