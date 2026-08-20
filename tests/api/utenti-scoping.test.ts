import { describe, it, expect, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Isolamento della gestione utenti (/auth/users): il leak scoperto in
// produzione — l'owner del tenant Demo vedeva TUTTO lo staff del Frantoio,
// e update/delete non filtravano il tenant (password altrui modificabili
// conoscendo l'id). PLATFORM_ADMIN sta sopra i tenant: mai in lista, mai
// modificabile o eliminabile dalla gestione utenti di un ristorante.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'osteria-scoping-utenti';
const OWNER2_EMAIL = 'owner.scoping@example.com';

describe('scoping utenti per tenant', () => {
    let owner2Access = '';
    let tenant1UserId = 0;
    let platformAdminId = 0;

    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            await client.query(`DELETE FROM users WHERE id = $1`, [platformAdminId]);
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

    it('la lista utenti di un tenant nuovo contiene solo il suo owner', async () => {
        // Un PLATFORM_ADMIN a database (si crea solo via SQL, come da D2):
        // non deve comparire in NESSUNA lista.
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const db = new Client({ connectionString: dbUrl });
        await db.connect();
        const pa = await db.query(
            `INSERT INTO users (tenant_id, email, password_hash, full_name, role, is_active)
             VALUES (1, 'platform.scoping@example.com', 'x', 'Platform Admin Test', 'PLATFORM_ADMIN', true)
             RETURNING id`
        );
        platformAdminId = Number(pa.rows[0].id);
        const anyTenant1User = await db.query(
            `SELECT id FROM users WHERE tenant_id = 1 AND role <> 'PLATFORM_ADMIN' LIMIT 1`
        );
        tenant1UserId = Number(anyTenant1User.rows[0].id);
        await db.end();

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Osteria Scoping Utenti',
            owner_email: OWNER2_EMAIL,
        });
        expect(created.status).toBe(201);
        const login = await api().post('/auth/login').send({
            email: OWNER2_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        owner2Access = login.body.accessToken;

        const list = await api().get('/auth/users').set({ Authorization: `Bearer ${owner2Access}` });
        expect(list.status).toBe(200);
        // Solo l'owner appena creato: niente Frantoio, niente platform admin.
        expect(list.body.map((u: any) => u.email)).toEqual([OWNER2_EMAIL]);
    });

    it('la lista del tenant 1 non contiene né il tenant nuovo né i PLATFORM_ADMIN', async () => {
        const token = await ownerToken();
        const list = await api().get('/auth/users').set(bearer(token));
        expect(list.status).toBe(200);
        const emails = list.body.map((u: any) => u.email);
        expect(emails).not.toContain(OWNER2_EMAIL);
        expect(emails).not.toContain('platform.scoping@example.com');
    });

    it('update e delete di un utente di un ALTRO tenant → 404, la riga non si tocca', async () => {
        const upd = await api().put(`/auth/users/${tenant1UserId}`)
            .set({ Authorization: `Bearer ${owner2Access}` })
            .send({ password: 'password-rubata-1' });
        expect(upd.status).toBe(404);

        const del = await api().delete(`/auth/users/${tenant1UserId}`)
            .set({ Authorization: `Bearer ${owner2Access}` });
        expect(del.status).toBe(404);

        // L'utente del tenant 1 esiste ancora e il suo login non è cambiato.
        const still = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL,
            password: process.env.TEST_OWNER_PASSWORD,
        });
        expect(still.status).toBe(200);
    });

    it('un PLATFORM_ADMIN non è modificabile né eliminabile nemmeno dall\'owner del suo tenant', async () => {
        const token = await ownerToken();
        const upd = await api().put(`/auth/users/${platformAdminId}`)
            .set(bearer(token))
            .send({ is_active: false });
        expect(upd.status).toBe(404);

        const del = await api().delete(`/auth/users/${platformAdminId}`).set(bearer(token));
        expect(del.status).toBe(404);
    });
});
