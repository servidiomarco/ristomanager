import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api } from './helpers';
// Import diretto del servizio (non passa dal server di globalSetup): il
// cuore del billing — applySubscriptionState — è una funzione pura DB che
// gira anche qui nel worker vitest, contro lo stesso database dei test.
// Nessun account Stripe: si testano le cuciture (env assenti → 503) e la
// sync con oggetti subscription finti.
import { applySubscriptionState } from '../../services/billingService';
import pool from '../../db';

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'billing-test-d3';
const CUSTOMER_ID = 'cus_billing_test_d3';
const SUBSCRIPTION_ID = 'sub_billing_test_d3';
const PRICE_VOICE = 'price_voice_test';

// Oggetto subscription minimo nella forma che manda Stripe: items.data con
// i price sottoscritti (base + add-on). SubscriptionLike è strutturale
// proprio per permettere questi finti.
const fakeSubscription = (status: string, priceIds: string[]) => ({
    id: SUBSCRIPTION_ID,
    customer: CUSTOMER_ID,
    status,
    items: { data: priceIds.map(id => ({ price: { id } })) },
});

describe('billing Stripe (Fase D3)', () => {
    let client: Client;
    let tenantId = 0;

    beforeAll(async () => {
        // La mappa price→feature legge l'env a ogni chiamata (lazy): il set
        // fatto QUI, dopo l'import del modulo, deve bastare.
        process.env.STRIPE_PRICE_VOICE = PRICE_VOICE;
        delete process.env.STRIPE_PRICE_WHATSAPP;
        delete process.env.STRIPE_PRICE_WEB_BOOKING;

        client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await client.connect();
        const inserted = await client.query(
            `INSERT INTO tenants (slug, name, stripe_customer_id)
             VALUES ($1, 'Billing Test D3', $2)
             RETURNING id`,
            [SLUG, CUSTOMER_ID]
        );
        tenantId = Number(inserted.rows[0].id);
    });

    // Cleanup diretto a DB qualunque cosa succeda, come provisioning.test:
    // le run ripetute sullo stesso database non devono collidere sullo slug.
    afterAll(async () => {
        if (client) {
            try {
                await client.query('DELETE FROM tenant_features WHERE tenant_id = $1', [tenantId]);
                await client.query('DELETE FROM tenants WHERE slug = $1', [SLUG]);
            } finally {
                await client.end();
            }
        }
        // Il pool di db.ts è stato aperto dall'import del servizio in QUESTO
        // processo: senza end() il worker vitest resta appeso sui socket idle.
        await pool.end();
    });

    const featuresOf = async (id: number): Promise<Record<string, boolean>> => {
        const r = await client.query(
            'SELECT feature, enabled FROM tenant_features WHERE tenant_id = $1 ORDER BY feature',
            [id]
        );
        return Object.fromEntries(r.rows.map(row => [row.feature, row.enabled]));
    };

    const tenantRow = async (id: number) => {
        const r = await client.query(
            'SELECT status, billing_status, stripe_subscription_id FROM tenants WHERE id = $1',
            [id]
        );
        return r.rows[0];
    };

    it('POST /webhook/stripe → 503 senza STRIPE_WEBHOOK_SECRET', async () => {
        const res = await api().post('/webhook/stripe').send({ type: 'customer.subscription.updated' });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('billing_disabled');
    });

    it('checkout e portal admin → 503 billing_disabled senza STRIPE_SECRET_KEY', async () => {
        const checkout = await api().post('/admin/tenants/1/billing/checkout').set(ADMIN_HEADER).send({});
        expect(checkout.status).toBe(503);
        expect(checkout.body.error).toBe('billing_disabled');

        const portal = await api().post('/admin/tenants/1/billing/portal').set(ADMIN_HEADER).send({});
        expect(portal.status).toBe(503);
        expect(portal.body.error).toBe('billing_disabled');
    });

    it('checkout senza header di piattaforma → 401', async () => {
        const res = await api().post('/admin/tenants/1/billing/checkout').send({});
        expect(res.status).toBe(401);
    });

    it('le pagine di ritorno esistono (Stripe ci atterra dopo checkout e portal)', async () => {
        for (const path of ['/admin/billing/success', '/admin/billing/cancel', '/admin/billing/return']) {
            const res = await api().get(path);
            expect(res.status).toBe(200);
            expect(res.headers['content-type']).toContain('text/html');
        }
    });

    it('subscription active con price voice → feature voice accesa, le altre spente', async () => {
        const applied = await applySubscriptionState(
            // Il price base non è in mappa: deve essere ignorato dalla sync.
            fakeSubscription('active', ['price_base_ignorato', PRICE_VOICE])
        );
        expect(applied?.tenantId).toBe(tenantId);
        expect(applied?.tenantStatus).toBe('active');

        const row = await tenantRow(tenantId);
        expect(row.status).toBe('active');
        expect(row.billing_status).toBe('active');
        expect(row.stripe_subscription_id).toBe(SUBSCRIPTION_ID);

        expect(await featuresOf(tenantId)).toEqual({ voice: true, whatsapp: false, web_booking: false, pay_at_table: false });
    });

    it("past_due → billing_status registrato ma il ristorante resta acceso", async () => {
        const applied = await applySubscriptionState(fakeSubscription('past_due', [PRICE_VOICE]));
        expect(applied?.tenantStatus).toBe('active');
        // La transizione è visibile al chiamante: è quello che il webhook usa
        // per notificare i platform admin solo al PASSAGGIO a past_due, non a
        // ogni retry.
        expect(applied?.billingStatus).toBe('past_due');
        expect(applied?.previousBillingStatus).toBe('active');

        const row = await tenantRow(tenantId);
        expect(row.status).toBe('active');
        expect(row.billing_status).toBe('past_due');
    });

    it('summary billing: 503 senza Stripe configurato; la lista admin porta il link al customer', async () => {
        const summary = await api().get('/admin/billing/summary').set(ADMIN_HEADER);
        expect(summary.status).toBe(503);
        expect(summary.body.error).toBe('billing_disabled');

        const list = await api().get('/admin/tenants').set(ADMIN_HEADER);
        expect(list.status).toBe(200);
        const mine = list.body.find((t: any) => t.id === tenantId);
        expect(mine.stripe_customer_url).toContain(CUSTOMER_ID);
        // Il tenant 1 non ha un customer Stripe: niente link.
        const frantoio = list.body.find((t: any) => t.id === 1);
        expect(frantoio.stripe_customer_url).toBeNull();
    });

    it('canceled → tenant sospeso e feature spente', async () => {
        const applied = await applySubscriptionState(fakeSubscription('canceled', []));
        expect(applied?.tenantStatus).toBe('suspended');
        expect(applied?.tenantStatusChanged).toBe(true);

        const row = await tenantRow(tenantId);
        expect(row.status).toBe('suspended');
        expect(row.billing_status).toBe('canceled');

        expect(await featuresOf(tenantId)).toEqual({ voice: false, whatsapp: false, web_booking: false, pay_at_table: false });
    });

    it('riattivazione: di nuovo active → tenant riacceso', async () => {
        const applied = await applySubscriptionState(fakeSubscription('active', [PRICE_VOICE]));
        expect(applied?.tenantStatus).toBe('active');

        const row = await tenantRow(tenantId);
        expect(row.status).toBe('active');
        expect(await featuresOf(tenantId)).toEqual({ voice: true, whatsapp: false, web_booking: false, pay_at_table: false });
    });

    it('guardia grandfathered: il tenant 1 (billing_status NULL) non è toccato dalla sync', async () => {
        // Il tenant 1 non ha stripe_customer_id: tutte le sync qui sopra non
        // devono avergli spento niente (le feature del seed restano accese)
        // né avergli scritto uno stato billing.
        const row = await tenantRow(1);
        expect(row.billing_status).toBeNull();
        expect(row.status).toBe('active');
        expect(await featuresOf(1)).toEqual({ voice: true, whatsapp: true, web_booking: true, pay_at_table: true });
    });

    it('customer sconosciuto → null, nessun errore (Stripe non deve ritentare)', async () => {
        const applied = await applySubscriptionState({
            id: 'sub_ignoto',
            customer: 'cus_di_un_altro_ambiente',
            status: 'active',
            items: { data: [{ price: { id: PRICE_VOICE } }] },
        });
        expect(applied).toBeNull();
    });
});
