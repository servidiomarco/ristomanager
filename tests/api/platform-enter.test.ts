import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, bearer } from './helpers';

// Sessione di piattaforma scopata (layer sopra l'OWNER):
// - POST /admin/tenants/:id/enter emette una sessione PIENA (access +
//   refresh) con l'identità dell'admin, ruolo PLATFORM_ADMIN e claim
//   scopedTenantId = tenant bersaglio;
// - dentro il tenant la sessione bypassa matrice permessi e gate di ruolo;
// - un token di piattaforma SENZA scope resta confinato al pannello;
// - il refresh preserva lo scope, e la sospensione del tenant lo taglia.
// Come in impersonation.test.ts, l'utente PLATFORM_ADMIN si crea via SQL:
// è il flusso previsto in produzione (nessuna route di signup).

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'trattoria-test-scope';
const OWNER_EMAIL = 'owner.scope@example.com';
const PA_EMAIL = 'platform.admin.scope@example.com';
const PA_PASSWORD = 'password-piattaforma-scope';

const decodeJwtPayload = (token: string): Record<string, any> =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

const pgClient = async (): Promise<Client> => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    return client;
};

describe('sessione di piattaforma scopata su un tenant', () => {
    let tenantId = 0;
    let platformAdminToken = '';
    let scopedAccessToken = '';
    let scopedRefreshToken = '';

    // Stesso bump di impersonation.test.ts: id di tenant alti, così nessun
    // file successivo riusa un id e avvelena le cache per-tenant del server.
    beforeAll(async () => {
        const client = await pgClient();
        try {
            await client.query(
                `SELECT setval(pg_get_serial_sequence('tenants','id'),
                               GREATEST((SELECT MAX(id) FROM tenants), 100))`
            );
            const hash = await bcrypt.hash(PA_PASSWORD, 4);
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Platform Admin Scope', 'PLATFORM_ADMIN', 1, TRUE)
                 ON CONFLICT (email) DO NOTHING`,
                [PA_EMAIL, hash]
            );
        } finally {
            await client.end();
        }

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Trattoria Test Scope',
            owner_email: OWNER_EMAIL,
            owner_full_name: 'Owner Di Prova Scope',
        });
        if (created.status !== 201) {
            throw new Error(`Provisioning fallito (${created.status}): ${JSON.stringify(created.body)}`);
        }
        tenantId = created.body.tenant.id;

        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        if (login.status !== 200) {
            throw new Error(`Login platform admin fallito (${login.status}): ${JSON.stringify(login.body)}`);
        }
        platformAdminToken = login.body.accessToken;
    });

    afterAll(async () => {
        const client = await pgClient();
        try {
            const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
            const id = t.rows[0]?.id;
            if (id != null) {
                for (const table of ['activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
                }
                await client.query('DELETE FROM tenants WHERE id = $1', [id]);
            }
            await client.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
            await client.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
            await client.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('il token env non entra: serve un account con identità', async () => {
        const res = await api().post(`/admin/tenants/${tenantId}/enter`).set(ADMIN_HEADER);
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('jwt_required');
    });

    it('senza scope il JWT di piattaforma resta fuori dalle route del tenant', async () => {
        // requirePermission: nessuna riga in role_permissions per il ruolo.
        const entitlements = await api().get('/settings/entitlements').set(bearer(platformAdminToken));
        expect(entitlements.status).toBe(403);
        const reservations = await api().get('/reservations').set(bearer(platformAdminToken));
        expect(reservations.status).toBe(403);
        // authorize(OWNER): il bypass esige lo scope, il ruolo da solo no.
        const matrix = await api().get('/auth/permissions').set(bearer(platformAdminToken));
        expect(matrix.status).toBe(403);
    });

    it("l'admin entra nel tenant: sessione piena con scope nel claim", async () => {
        const res = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(platformAdminToken));
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        expect(res.body.refreshToken).toBeTruthy();
        expect(res.body.tenant).toEqual({ id: tenantId, slug: SLUG, name: 'Trattoria Test Scope' });

        const payload = decodeJwtPayload(res.body.accessToken);
        expect(payload.email).toBe(PA_EMAIL);
        expect(payload.role).toBe('PLATFORM_ADMIN');
        expect(payload.tenantId).toBe(tenantId);
        expect(payload.scopedTenantId).toBe(tenantId);

        scopedAccessToken = res.body.accessToken;
        scopedRefreshToken = res.body.refreshToken;
    });

    it('/auth/me della sessione scopata: identità propria, tenant bersaglio, permessi pieni', async () => {
        const res = await api().get('/auth/me').set(bearer(scopedAccessToken));
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(PA_EMAIL);
        expect(res.body.role).toBe('PLATFORM_ADMIN');
        expect(res.body.tenant.id).toBe(tenantId);
        expect(res.body.tenant.slug).toBe(SLUG);
        expect(res.body.tenant.needs_onboarding).toBe(false);
        expect(res.body.permissions).toContain('floorplan:full');
        expect(res.body.permissions).toContain('users:full');
    });

    it('la sessione scopata passa requirePermission e authorize(OWNER) nel tenant', async () => {
        // La lista vuota prova che la sessione legge il tenant bersaglio
        // (appena provisionato), non quello di casa.
        const reservations = await api().get('/reservations').set(bearer(scopedAccessToken));
        expect(reservations.status).toBe(200);
        expect(Array.isArray(reservations.body)).toBe(true);
        expect(reservations.body).toHaveLength(0);

        // requirePermission('settings:full') senza righe in matrice: passa
        // solo per il bypass della sessione scopata.
        const entitlements = await api().get('/settings/entitlements').set(bearer(scopedAccessToken));
        expect(entitlements.status).toBe(200);

        const matrix = await api().get('/auth/permissions/roles').set(bearer(scopedAccessToken));
        expect(matrix.status).toBe(200);
        expect(matrix.body.OWNER).toBeTruthy();
    });

    it('il refresh preserva lo scope', async () => {
        const res = await api().post('/auth/refresh').send({ refreshToken: scopedRefreshToken });
        expect(res.status).toBe(200);
        const payload = decodeJwtPayload(res.body.accessToken);
        expect(payload.role).toBe('PLATFORM_ADMIN');
        expect(payload.tenantId).toBe(tenantId);
        expect(payload.scopedTenantId).toBe(tenantId);
        // Anche il refresh token ruotato porta lo scope: il prossimo giro
        // non deve perderlo.
        expect(decodeJwtPayload(res.body.refreshToken).scopedTenantId).toBe(tenantId);
        scopedRefreshToken = res.body.refreshToken;
    });

    it('tenant sospeso: niente ingresso e niente rinnovo', async () => {
        const suspend = await api().patch(`/admin/tenants/${tenantId}`).set(ADMIN_HEADER).send({ status: 'suspended' });
        expect(suspend.status).toBe(200);

        const enter = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(platformAdminToken));
        expect(enter.status).toBe(409);
        expect(enter.body.error).toBe('tenant_not_active');

        const refresh = await api().post('/auth/refresh').send({ refreshToken: scopedRefreshToken });
        expect(refresh.status).toBe(401);

        const reactivate = await api().patch(`/admin/tenants/${tenantId}`).set(ADMIN_HEADER).send({ status: 'active' });
        expect(reactivate.status).toBe(200);
    });

    it('enter su un tenant inesistente → 404', async () => {
        const res = await api().post('/admin/tenants/999999/enter').set(bearer(platformAdminToken));
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('tenant_not_found');
    });
});
