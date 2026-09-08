import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, bearer } from './helpers';

// Permessi riservati alla piattaforma (Fase B del layer sopra l'OWNER):
// - PUT /admin/tenants/:id/permission-locks blocca i permessi elencati
//   (con revoke li toglie anche a tutti i ruoli, in transazione);
// - la matrice del tenant non può più toccarli: il PUT dell'OWNER li
//   preserva com'erano, senza fallire sul resto;
// - la sessione di piattaforma scopata («Entra») li cambia ancora, e i
//   suoi permessi non passano dalla matrice — l'isolamento regge;
// - GET /auth/permissions espone `locked` per il lucchetto in UI.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'locanda-test-lock';
const OWNER_EMAIL = 'owner.lock@example.com';
const PA_EMAIL = 'platform.admin.lock@example.com';
const PA_PASSWORD = 'password-piattaforma-lock';

const pgClient = async (): Promise<Client> => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    return client;
};

describe('permessi riservati alla piattaforma', () => {
    let tenantId = 0;
    let ownerToken = '';
    let scopedToken = '';

    beforeAll(async () => {
        const client = await pgClient();
        try {
            // Stesso bump di impersonation.test.ts: id alti, niente riuso.
            await client.query(
                `SELECT setval(pg_get_serial_sequence('tenants','id'),
                               GREATEST((SELECT MAX(id) FROM tenants), 100))`
            );
            const hash = await bcrypt.hash(PA_PASSWORD, 4);
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Platform Admin Lock', 'PLATFORM_ADMIN', 1, TRUE)
                 ON CONFLICT (email) DO NOTHING`,
                [PA_EMAIL, hash]
            );
        } finally {
            await client.end();
        }

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Locanda Test Lock',
            owner_email: OWNER_EMAIL,
            owner_full_name: 'Owner Di Prova Lock',
        });
        if (created.status !== 201) {
            throw new Error(`Provisioning fallito (${created.status}): ${JSON.stringify(created.body)}`);
        }
        tenantId = created.body.tenant.id;

        const ownerLogin = await api().post('/auth/login').send({
            email: OWNER_EMAIL,
            password: created.body.owner_temp_password,
        });
        if (ownerLogin.status !== 200) {
            throw new Error(`Login owner fallito (${ownerLogin.status}): ${JSON.stringify(ownerLogin.body)}`);
        }
        ownerToken = ownerLogin.body.accessToken;

        const paLogin = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        const entered = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(paLogin.body.accessToken));
        if (entered.status !== 200) {
            throw new Error(`Enter fallito (${entered.status}): ${JSON.stringify(entered.body)}`);
        }
        scopedToken = entered.body.accessToken;
    });

    afterAll(async () => {
        const client = await pgClient();
        try {
            const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
            const id = t.rows[0]?.id;
            if (id != null) {
                for (const table of ['activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'platform_permission_locks', 'app_settings']) {
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

    it('senza lock la matrice risponde locked vuoto', async () => {
        const res = await api().get('/auth/permissions').set(bearer(ownerToken));
        expect(res.status).toBe(200);
        expect(res.body.locked).toEqual([]);
    });

    it('un permesso sconosciuto nei lock → 400', async () => {
        const res = await api().put(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER)
            .send({ locks: ['floorplan:full', 'permesso:inventato'] });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('unknown_permission');
    });

    it('lock con revoke: il permesso sparisce da tutti i ruoli del tenant', async () => {
        const res = await api().put(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER)
            .send({ locks: ['floorplan:full'], revoke: true });
        expect(res.status).toBe(200);
        expect(res.body.locks).toEqual(['floorplan:full']);

        const matrix = await api().get('/auth/permissions/roles').set(bearer(ownerToken));
        expect(matrix.status).toBe(200);
        for (const role of Object.keys(matrix.body)) {
            expect(matrix.body[role]).not.toContain('floorplan:full');
        }

        const perms = await api().get('/auth/permissions').set(bearer(ownerToken));
        expect(perms.body.locked).toEqual(['floorplan:full']);
    });

    it("l'OWNER non può ridarsi un permesso bloccato: il PUT lo preserva e salva il resto", async () => {
        const current = await api().get('/auth/permissions/roles/MANAGER').set(bearer(ownerToken));
        expect(current.status).toBe(200);
        const attempt = [...new Set([...current.body.permissions, 'floorplan:full', 'logs:full'])];

        const res = await api().put('/auth/permissions/roles/MANAGER').set(bearer(ownerToken))
            .send({ permissions: attempt });
        expect(res.status).toBe(200);
        // La voce bloccata resta com'era (revocata), l'altra modifica passa.
        expect(res.body.permissions).not.toContain('floorplan:full');
        expect(res.body.permissions).toContain('logs:full');
    });

    it('la voce bloccata non si toglie nemmeno: preservata anche in rimozione', async () => {
        // Si blocca reservations:view SENZA revoca: chi ce l'ha lo tiene.
        const lock = await api().put(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER)
            .send({ locks: ['floorplan:full', 'reservations:view'] });
        expect(lock.status).toBe(200);

        const current = await api().get('/auth/permissions/roles/MANAGER').set(bearer(ownerToken));
        expect(current.body.permissions).toContain('reservations:view');

        const senza = current.body.permissions.filter((p: string) => p !== 'reservations:view');
        const res = await api().put('/auth/permissions/roles/MANAGER').set(bearer(ownerToken))
            .send({ permissions: senza });
        expect(res.status).toBe(200);
        expect(res.body.permissions).toContain('reservations:view');
    });

    it('users:full bloccato e revocato: il salvataggio del ruolo OWNER non fallisce più per la voce obbligatoria', async () => {
        const lock = await api().put(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER)
            .send({ locks: ['floorplan:full', 'users:full'], revoke: true });
        expect(lock.status).toBe(200);

        const current = await api().get('/auth/permissions/roles/OWNER').set(bearer(ownerToken));
        expect(current.body.permissions).not.toContain('users:full');

        // Senza l'esenzione questo sarebbe un 400 "Cannot remove users:full".
        const res = await api().put('/auth/permissions/roles/OWNER').set(bearer(ownerToken))
            .send({ permissions: current.body.permissions });
        expect(res.status).toBe(200);
        expect(res.body.permissions).not.toContain('users:full');
    });

    it('la sessione di piattaforma scopata cambia anche le voci bloccate', async () => {
        const current = await api().get('/auth/permissions/roles/MANAGER').set(bearer(scopedToken));
        expect(current.status).toBe(200);

        const res = await api().put('/auth/permissions/roles/MANAGER').set(bearer(scopedToken))
            .send({ permissions: [...new Set([...current.body.permissions, 'floorplan:full'])] });
        expect(res.status).toBe(200);
        expect(res.body.permissions).toContain('floorplan:full');
    });

    it("l'isolamento regge: la sessione scopata passa sul permesso revocato, l'OWNER no", async () => {
        const lock = await api().put(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER)
            .send({ locks: ['settings:full'], revoke: true });
        expect(lock.status).toBe(200);

        // requirePermission('settings:full'): l'OWNER l'ha perso...
        const owner = await api().get('/settings/entitlements').set(bearer(ownerToken));
        expect(owner.status).toBe(403);
        // ...la piattaforma no (bypass della matrice, PR «Entra»).
        const scoped = await api().get('/settings/entitlements').set(bearer(scopedToken));
        expect(scoped.status).toBe(200);
    });

    it('GET /admin/tenants/:id/permission-locks risponde lock e catalogo', async () => {
        const res = await api().get(`/admin/tenants/${tenantId}/permission-locks`).set(ADMIN_HEADER);
        expect(res.status).toBe(200);
        expect(res.body.locks).toEqual(['settings:full']);
        expect(Array.isArray(res.body.features)).toBe(true);
        expect(res.body.features.some((f: any) => f.permissions.includes('floorplan:full'))).toBe(true);
    });

    it('tenant inesistente → 404', async () => {
        const res = await api().put('/admin/tenants/999999/permission-locks').set(ADMIN_HEADER)
            .send({ locks: [] });
        expect(res.status).toBe(404);
    });
});
