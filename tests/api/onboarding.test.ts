import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
import { api } from './helpers';

// Wizard di primo accesso (coda della Fase D1): un tenant appena provisionato
// nasce con onboarding_completed_at NULL, il login del suo OWNER espone
// tenant.needs_onboarding = true, e POST /onboarding/complete (solo OWNER,
// idempotente) lo spegne. I tenant nati prima della migration sono
// backfillati a completato: il Frantoio non deve mai vedere il wizard.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'locanda-test-onboarding';
const OWNER_EMAIL = 'owner.onboarding@example.com';
const WAITER_EMAIL = 'waiter.onboarding@example.com';

describe('onboarding di primo accesso (Fase D1)', () => {
    let ownerAccess = '';
    let waiterAccess = '';

    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
            const id = t.rows[0]?.id;
            if (id != null) {
                for (const table of ['activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
                }
                await client.query('DELETE FROM tenants WHERE id = $1', [id]);
            }
        } finally {
            await client.end();
        }
    });

    it('il tenant storico è backfillato: il suo owner non vede il wizard', async () => {
        const res = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        expect(res.status).toBe(200);
        expect(res.body.user.tenant.needs_onboarding).toBe(false);
    });

    it('un tenant appena provisionato nasce con needs_onboarding = true', async () => {
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Locanda Test Onboarding',
            owner_email: OWNER_EMAIL,
        });
        expect(created.status).toBe(201);

        const login = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        expect(login.body.user.tenant.needs_onboarding).toBe(true);
        ownerAccess = login.body.accessToken;
    });

    it('lo staff creato dal nuovo owner finisce nel SUO tenant, non nel tenant 1', async () => {
        const created = await api().post('/auth/users')
            .set({ Authorization: `Bearer ${ownerAccess}` })
            .send({ email: WAITER_EMAIL, password: 'password-waiter-1', full_name: 'Cameriere Test', role: 'WAITER' });
        expect(created.status).toBe(201);

        // Il login rivela il tenant di appartenenza: prima del fix cadeva sul
        // DEFAULT 1 di Fase B e il cameriere nasceva dentro il Frantoio.
        const login = await api().post('/auth/login').send({ email: WAITER_EMAIL, password: 'password-waiter-1' });
        expect(login.status).toBe(200);
        expect(login.body.user.tenant.slug).toBe(SLUG);
        waiterAccess = login.body.accessToken;
    });

    it('un non-OWNER non può completare il wizard → 403', async () => {
        const res = await api().post('/onboarding/complete').set({ Authorization: `Bearer ${waiterAccess}` });
        expect(res.status).toBe(403);
    });

    it('l\'OWNER completa: needs_onboarding si spegne, e il secondo tocco è innocuo', async () => {
        const done = await api().post('/onboarding/complete').set({ Authorization: `Bearer ${ownerAccess}` });
        expect(done.status).toBe(200);

        const me = await api().get('/auth/me').set({ Authorization: `Bearer ${ownerAccess}` });
        expect(me.status).toBe(200);
        expect(me.body.tenant.needs_onboarding).toBe(false);

        const again = await api().post('/onboarding/complete').set({ Authorization: `Bearer ${ownerAccess}` });
        expect(again.status).toBe(200);
    });
});
