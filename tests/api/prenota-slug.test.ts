import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api } from './helpers';

// Prenotazioni web per tenant (Fase C3): i path /public/:slug/* e
// /prenota/:slug risolvono il tenant dallo slug, i path storici restano
// sul fallback (tenant 1) e i domini custom passano da tenant_domains.
//
// Il tenant di prova viene provisionato via SQL diretto come in rls.test.ts:
// tenants + tenant_features + opening_hours + legal_config — è la stessa
// sequenza che fa il provisioning D1, e la riga web_booking dimostra che
// il gating C1 è davvero per tenant (senza, l'availability risponde 503).
//
// Id ALTO e riservato, non 2: i file di test girano in parallelo sullo
// stesso server, e un tenant provisionato via POST /admin/tenants da un
// altro file può prendere id 2 dalla sequence, farsi cache-are le feature
// (tutte spente, TTL 60s in services/entitlements.ts) e poi sparire col suo
// afterAll — la cache avvelenata resta, e l'availability di QUESTO tenant
// risponderebbe 503 pur avendo web_booking=true a database. Con un id fuori
// dalla portata della sequence la collisione è impossibile per costruzione.
//
// Data futura fissa come in availability.test.ts: per la data odierna
// l'endpoint scarta gli slot già passati e il test dipenderebbe
// dall'orologio.
const DATA_FUTURA = '2027-03-10';
const DOMINIO_TEST = 'prenota.trattoria-slug.test';
const TENANT_ID = 4302;

describe('prenotazioni web per tenant (slug e domini, Fase C3)', () => {
    let db: Client;

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (${TENANT_ID}, 'trattoria-slug', 'Trattoria Slug')
                        ON CONFLICT (id) DO NOTHING`);
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), (SELECT MAX(id) FROM tenants))`);
        // Entitlement web_booking (C1): feature assente = non venduta =
        // spenta. Senza questa riga /public/trattoria-slug/availability
        // risponderebbe 503 — inserirla È il provisioning realistico.
        await db.query(`INSERT INTO tenant_features (tenant_id, feature, enabled) VALUES (${TENANT_ID}, 'web_booking', true)
                        ON CONFLICT (tenant_id, feature) DO NOTHING`);
        // Orari SOLO per il weekday della data fissa: pranzo 12:00-13:00,
        // deliberatamente diverso dal seed del tenant 1 (13:00-14:00) per
        // provare l'isolamento degli orari per tenant.
        const weekday = new Date(DATA_FUTURA + 'T00:00:00').getDay();
        await db.query(
            `INSERT INTO opening_hours (tenant_id, weekday, lunch_open, lunch_close, dinner_open, dinner_close, slot_minutes)
             VALUES (${TENANT_ID}, $1, '12:00', '13:00', NULL, NULL, 30)
             ON CONFLICT DO NOTHING`,
            [weekday]
        );
        // Branding: business_name in legal_config, la fonte di
        // businessIdentity() servita da /public/:slug/contact.
        await db.query(
            `INSERT INTO app_settings (tenant_id, key, text_value) VALUES (${TENANT_ID}, 'legal_config', $1)
             ON CONFLICT DO NOTHING`,
            [JSON.stringify({ business_name: 'Trattoria Slug' })]
        );
        // Dominio custom di prova per il redirect della root e il routing
        // per hostname dei path storici.
        await db.query(`INSERT INTO tenant_domains (domain, tenant_id, purpose) VALUES ($1, ${TENANT_ID}, 'booking')
                        ON CONFLICT DO NOTHING`, [DOMINIO_TEST]);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM tenant_domains WHERE tenant_id = ${TENANT_ID}`);
        await db.query(`DELETE FROM tenant_features WHERE tenant_id = ${TENANT_ID}`);
        await db.query(`DELETE FROM app_settings WHERE tenant_id = ${TENANT_ID}`);
        await db.query(`DELETE FROM opening_hours WHERE tenant_id = ${TENANT_ID}`);
        await db.query(`DELETE FROM role_permissions WHERE tenant_id = ${TENANT_ID}`);
        await db.query(`DELETE FROM tenants WHERE id = ${TENANT_ID}`);
        await db.end();
    });

    it('GET /public/:slug/availability serve gli orari del SUO tenant', async () => {
        const res = await api().get('/public/trattoria-slug/availability').query({ date: DATA_FUTURA });
        expect(res.status).toBe(200);
        expect(res.body.date).toBe(DATA_FUTURA);
        // 12:00-13:00 passo 30': orari del tenant di prova, non quelli del seed.
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

    it('GET /public/trattoria-slug/contact porta il branding del tenant di prova', async () => {
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
        // fallback, quindi gli orari sono quelli del tenant di prova.
        const avail = await api().get('/public/availability')
            .set('Host', DOMINIO_TEST)
            .query({ date: DATA_FUTURA });
        expect(avail.status).toBe(200);
        expect(avail.body.lunch.slots).toEqual(['12:00', '12:30', '13:00']);
    });

    it('i loghi /prenota/logo*.png non vengono catturati dalla slug-route', async () => {
        // Regressione reale: un riordino delle route aveva messo /prenota/:slug
        // prima dei loghi, che rispondevano 404 unknown_slug — email e variante
        // scura della sidebar rotte in silenzio.
        for (const path of ['/prenota/logo.png', '/prenota/logo-dark.png']) {
            const res = await api().get(path);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('image/png');
        }
    });
});
