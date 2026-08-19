import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Fase D2 — ruolo PLATFORM_ADMIN e impersonation:
// - /admin/tenants accetta anche un Bearer JWT con ruolo PLATFORM_ADMIN,
//   oltre al token env di bootstrap (D1);
// - POST /admin/tenants/:id/impersonate emette un access token corto
//   (15 min) del primo OWNER attivo del tenant, col claim impersonated_by
//   e SENZA refresh token: la sessione non può rinnovarsi per costruzione.
// Gli utenti PLATFORM_ADMIN non hanno una route di signup: qui si crea via
// SQL diretto, che è esattamente il flusso previsto in produzione.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'osteria-test-d2';
const OWNER_EMAIL = 'owner.d2@example.com';
const PA_EMAIL = 'platform.admin.d2@example.com';
const PA_PASSWORD = 'password-piattaforma-d2';

// Il payload di un JWT è base64url in chiaro: per leggere i claim non serve
// il secret (la firma qui non si verifica, la verifica la fa il server).
const decodeJwtPayload = (token: string): Record<string, any> =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));

const pgClient = async (): Promise<Client> => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    return client;
};

describe('platform admin e impersonation (Fase D2)', () => {
    let tenantId = 0;
    let impersonationToken = '';
    let platformAdminToken = '';

    // Questo file gira PRIMA di prenota-slug.test.ts (ordine alfabetico dei
    // file, esecuzione sequenziale): senza il bump, il tenant provisionato
    // qui prenderebbe l'id 2 dalla serial — lo stesso id che prenota-slug
    // inserisce a mano — e le cache per-tenant del server (feature,
    // entitlements) resterebbero avvelenate con le feature tutte spente del
    // tenant di questo file anche dopo il cleanup. Id alti = nessun riuso.
    beforeAll(async () => {
        const client = await pgClient();
        try {
            await client.query(
                `SELECT setval(pg_get_serial_sequence('tenants','id'),
                               GREATEST((SELECT MAX(id) FROM tenants), 100))`
            );
        } finally {
            await client.end();
        }
    });

    // Cleanup diretto a DB, stesso pattern di provisioning.test.ts: il tenant
    // di test e l'utente di piattaforma spariscono qualunque cosa sia
    // successo, così le run ripetute non collidono.
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
            // L'utente di piattaforma vive appoggiato al tenant 1: via anche
            // le sue righe di log (il login ne scrive una).
            await client.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
            await client.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        } finally {
            await client.end();
        }
    });

    it('il token env crea il tenant e ne impersona l\'OWNER', async () => {
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Osteria Test D2',
            owner_email: OWNER_EMAIL,
            owner_full_name: 'Owner Di Prova D2',
        });
        expect(created.status).toBe(201);
        tenantId = created.body.tenant.id;

        const res = await api().post(`/admin/tenants/${tenantId}/impersonate`).set(ADMIN_HEADER);
        expect(res.status).toBe(200);
        expect(res.body.accessToken).toBeTruthy();
        expect(res.body.expires_in_seconds).toBe(900);
        expect(res.body.user).toEqual({ email: OWNER_EMAIL, role: 'OWNER' });
        expect(res.body.tenant).toEqual({ id: tenantId, slug: SLUG });
        // Nessun refresh token, da nessuna parte nella risposta.
        expect(res.body.refreshToken).toBeUndefined();
        impersonationToken = res.body.accessToken;
    });

    it('il payload porta impersonated_by e scade in 15 minuti', () => {
        const payload = decodeJwtPayload(impersonationToken);
        expect(payload.impersonated_by).toBe('env-token');
        expect(payload.role).toBe('OWNER');
        expect(payload.tenantId).toBe(tenantId);
        expect(payload.exp - payload.iat).toBe(900);
    });

    it('/auth/me accetta il token impersonato: tenant e ruolo del bersaglio', async () => {
        const res = await api().get('/auth/me').set(bearer(impersonationToken));
        expect(res.status).toBe(200);
        expect(res.body.role).toBe('OWNER');
        expect(res.body.email).toBe(OWNER_EMAIL);
        expect(res.body.tenant.slug).toBe(SLUG);
    });

    it('il token impersonato lavora su una route scoped: /reservations del tenant nuovo, vuota', async () => {
        const res = await api().get('/reservations').set(bearer(impersonationToken));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body).toHaveLength(0);
    });

    it('nessun rinnovo: /auth/refresh con il token impersonato → 401', async () => {
        // L'unico token in mano al flusso è l'access token: usarlo come
        // refresh deve fallire (firma col secret sbagliato per costruzione).
        const res = await api().post('/auth/refresh').send({ refreshToken: impersonationToken });
        expect(res.status).toBe(401);
    });

    it('impersonate di un tenant inesistente → 404', async () => {
        const res = await api().post('/admin/tenants/999999/impersonate').set(ADMIN_HEADER);
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('tenant_not_found');
    });

    it('un utente PLATFORM_ADMIN creato via SQL entra dal login normale', async () => {
        // Creazione manuale: è il flusso di produzione (nessuna route di
        // signup). L'utente si appoggia al tenant 1 per il login, ma il suo
        // ruolo vale sulla piattaforma intera.
        const client = await pgClient();
        try {
            const hash = bcrypt.hashSync(PA_PASSWORD, 10);
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Platform Admin D2', 'PLATFORM_ADMIN', 1, TRUE)`,
                [PA_EMAIL, hash]
            );
        } finally {
            await client.end();
        }

        const res = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        expect(res.status).toBe(200);
        expect(res.body.user.role).toBe('PLATFORM_ADMIN');
        platformAdminToken = res.body.accessToken;
    });

    it('il JWT PLATFORM_ADMIN apre /admin/tenants senza header env', async () => {
        const res = await api().get('/admin/tenants').set(bearer(platformAdminToken));
        expect(res.status).toBe(200);
        expect(res.body.some((t: any) => t.slug === SLUG)).toBe(true);
    });

    it('impersonation via JWT: impersonated_by è l\'email dell\'admin', async () => {
        const res = await api().post(`/admin/tenants/${tenantId}/impersonate`).set(bearer(platformAdminToken));
        expect(res.status).toBe(200);
        const payload = decodeJwtPayload(res.body.accessToken);
        expect(payload.impersonated_by).toBe(PA_EMAIL);
    });

    it('un JWT di tenant (OWNER) NON apre /admin/tenants', async () => {
        const token = await ownerToken();
        const res = await api().get('/admin/tenants').set(bearer(token));
        expect(res.status).toBe(401);
        expect(res.body.error).toBe('invalid_platform_admin_token');
    });

    it("un OWNER non può creare né promuovere un PLATFORM_ADMIN dalla gestione utenti", async () => {
        const token = await ownerToken();
        const res = await api().post('/auth/users').set(bearer(token)).send({
            email: 'escalation.d2@example.com',
            password: 'password-escalation',
            full_name: 'Tentata Escalation',
            role: 'PLATFORM_ADMIN',
        });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid role');
    });
});
