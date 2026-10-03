import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// Supporto, fase 2 — la salute dei ristoranti vista dalla piattaforma:
// - gli errori del browser arrivano a /client-errors, si raggruppano e si
//   allegano alle richieste di supporto di chi li ha avuti;
// - il banner «problema noto» si apre dal pannello e lo legge solo chi
//   deve leggerlo;
// - il cane da guardia apre un avviso una volta sola e lo chiude quando
//   il problema rientra («Controlla adesso» esegue lo stesso giro).

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const PA_EMAIL = 'platform.admin.salute@example.com';
const PA_PASSWORD = 'password-salute-piattaforma';
const SLUG = 'osteria-test-salute';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

const waitFor = async <T>(fn: () => Promise<T | null>, ms = 4000): Promise<T | null> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await new Promise(res => setTimeout(res, 100));
    }
    return fn();
};

describe('salute dei ristoranti (supporto, fase 2)', () => {
    let db: Client;
    let owner = '';
    let platform = '';
    let otherTenantId = 0;
    let otherToken = '';
    let fingerprint = '';

    beforeAll(async () => {
        db = await pgClient();
        owner = await ownerToken();
        // Altri file possono aver lasciato errori (un tool di Sofia andato in
        // errore apposta): qui si conta da zero.
        await db.query(`DELETE FROM app_errors`);
        await db.query(`DELETE FROM platform_alerts`);
        await db.query(
            `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
             VALUES ($1, $2, 'Admin Salute', 'PLATFORM_ADMIN', 1, TRUE)`,
            [PA_EMAIL, bcrypt.hashSync(PA_PASSWORD, 4)]
        );
        await db.query(`SELECT setval(pg_get_serial_sequence('tenants','id'), GREATEST((SELECT MAX(id) FROM tenants), 100))`);
        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        expect(login.status).toBe(200);
        platform = login.body.accessToken;
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG, name: 'Osteria Test Salute', owner_email: 'owner.salute@example.com', owner_full_name: 'Owner Salute',
        });
        expect(created.status).toBe(201);
        otherTenantId = created.body.tenant.id;
        const imp = await api().post(`/admin/tenants/${otherTenantId}/impersonate`).set(ADMIN_HEADER);
        otherToken = imp.body.accessToken;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM support_messages WHERE tenant_id IN (1, $1)`, [otherTenantId]);
        await db.query(`DELETE FROM support_tickets WHERE tenant_id IN (1, $1)`, [otherTenantId]);
        await db.query(`DELETE FROM app_errors`);
        await db.query(`DELETE FROM platform_alerts`);
        await db.query(`DELETE FROM platform_incidents`);
        await db.query(`DELETE FROM notifications WHERE tag LIKE 'alert-%' OR tag LIKE 'support-%'`);
        await db.query(`DELETE FROM print_jobs WHERE tenant_id = $1`, [otherTenantId]);
        await db.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
        await db.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
        await db.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        if (otherTenantId) {
            for (const table of ['activity_logs', 'user_sessions', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [otherTenantId]).catch(() => {});
            }
            await db.query('DELETE FROM tenants WHERE id = $1', [otherTenantId]);
        }
        await db.end();
    });

    describe('errori del browser', () => {
        it('rifiuta lotti non validi e chi non è loggato', async () => {
            expect((await api().post('/client-errors').send({ errors: [{ source: 'onerror', message: 'x' }] })).status).toBe(401);
            expect((await api().post('/client-errors').set(bearer(owner)).send({ errors: [] })).status).toBe(400);
            expect((await api().post('/client-errors').set(bearer(owner)).send({ errors: [{ source: 'inventato', message: 'x' }] })).status).toBe(400);
            const tooMany = Array.from({ length: 11 }, () => ({ source: 'onerror', message: 'x' }));
            expect((await api().post('/client-errors').set(bearer(owner)).send({ errors: tooMany })).status).toBe(400);
        });

        it('registra gli errori con utente, vista e versione; la scheda caduta finisce nel messaggio', async () => {
            const res = await api().post('/client-errors').set(bearer(owner)).send({
                errors: [
                    { source: 'boundary', label: 'Cassa', message: "Cannot read properties of undefined (reading 'total')", stack: 'TypeError: x\n    at CassaPage (https://crm.example.com/assets/index-AbC123xyz.js:10:20)', view: 'CASSA', app_version: 'abc1234' },
                    { source: 'rejection', message: 'Errore nella rete 42', view: 'DASHBOARD', campo_ignoto: 'via' },
                ],
            });
            expect(res.status).toBe(204);
            const rows = await db.query(`SELECT * FROM app_errors WHERE tenant_id = 1 ORDER BY id`);
            expect(rows.rows).toHaveLength(2);
            expect(rows.rows[0].origin).toBe('client');
            expect(rows.rows[0].message).toBe("Cassa: Cannot read properties of undefined (reading 'total')");
            expect(rows.rows[0].view).toBe('CASSA');
            expect(rows.rows[0].app_version).toBe('abc1234');
            expect(rows.rows[0].user_role).toBe('OWNER');
            expect(rows.rows[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
            fingerprint = rows.rows[0].fingerprint;
        });

        it('lo stesso errore dopo un deploy (hash del bundle e numeri diversi) resta lo stesso gruppo', async () => {
            await api().post('/client-errors').set(bearer(owner)).send({
                errors: [{ source: 'boundary', label: 'Cassa', message: "Cannot read properties of undefined (reading 'total')", stack: 'TypeError: x\n    at CassaPage (https://crm.example.com/assets/index-ZzZ999qqq.js:11:5)', view: 'CASSA', app_version: 'def5678' }],
            });
            const r = await db.query(`SELECT DISTINCT fingerprint FROM app_errors WHERE tenant_id = 1 AND source = 'boundary'`);
            expect(r.rows.map((x: any) => x.fingerprint)).toEqual([fingerprint]);
        });

        it('una richiesta di supporto porta con sé gli errori recenti di chi la apre', async () => {
            const res = await api().post('/support/tickets').set(bearer(owner)).send({
                category: 'altro', subject: 'La cassa si blocca', body: 'Si chiude da sola',
            });
            expect(res.status).toBe(201);
            const errors = res.body.context.server.client_errors_24h;
            expect(Array.isArray(errors)).toBe(true);
            expect(errors.length).toBeGreaterThanOrEqual(2);
            expect(errors[0]).toMatchObject({ source: 'boundary', view: 'CASSA' });
        });

        it('la piattaforma li vede raggruppati e ne apre il dettaglio', async () => {
            expect((await api().get('/admin/health').set(bearer(owner))).status).toBe(401);
            const res = await api().get('/admin/health').set(bearer(platform));
            expect(res.status).toBe(200);
            const group = res.body.errors.find((g: any) => g.fingerprint === fingerprint);
            expect(group).toBeTruthy();
            expect(group.occurrences).toBe(2);
            expect(group.last_version).toBe('def5678');
            expect(group.tenants).toEqual([{ id: 1, name: expect.any(String) }]);
            const detail = await api().get(`/admin/health/errors/${fingerprint}`).set(bearer(platform));
            expect(detail.status).toBe(200);
            expect(detail.body.occurrences).toHaveLength(2);
            expect(detail.body.occurrences[0].stack).toContain('CassaPage');
            expect((await api().get('/admin/health/errors/non-valido').set(bearer(platform))).status).toBe(400);
        });
    });

    describe('banner «problema noto»', () => {
        let globalId = 0;

        it('serve un account vero per scriverlo, e un messaggio', async () => {
            expect((await api().post('/admin/incidents').set(ADMIN_HEADER).send({ message: 'x' })).status).toBe(403);
            expect((await api().post('/admin/incidents').set(bearer(platform)).send({ message: '  ' })).status).toBe(400);
            expect((await api().post('/admin/incidents').set(bearer(platform)).send({ message: 'x', level: 'boh' })).status).toBe(400);
        });

        it('un banner per tutti lo vedono tutti; uno mirato solo il suo ristorante', async () => {
            const all = await api().post('/admin/incidents').set(bearer(platform)).send({ message: 'Sofia non risponde: ci stiamo lavorando.', level: 'critico' });
            expect(all.status).toBe(201);
            globalId = all.body.id;
            const only = await api().post('/admin/incidents').set(bearer(platform)).send({ message: 'Manutenzione della vostra stampante', tenant_ids: [otherTenantId] });
            expect(only.status).toBe(201);
            expect(only.body.target_tenant_ids).toEqual([otherTenantId]);

            const mine = await api().get('/incidents/active').set(bearer(owner));
            expect(mine.status).toBe(200);
            expect(mine.body.incidents.map((i: any) => i.message)).toEqual(['Sofia non risponde: ci stiamo lavorando.']);

            const theirs = await api().get('/incidents/active').set(bearer(otherToken));
            expect(theirs.body.incidents.map((i: any) => i.message)).toEqual([
                'Sofia non risponde: ci stiamo lavorando.', 'Manutenzione della vostra stampante',
            ]);
        });

        it('tolto dal pannello, sparisce per tutti', async () => {
            const res = await api().post(`/admin/incidents/${globalId}/resolve`).set(bearer(platform));
            expect(res.status).toBe(200);
            const mine = await api().get('/incidents/active').set(bearer(owner));
            expect(mine.body.incidents).toEqual([]);
            const panel = await api().get('/admin/health').set(bearer(platform));
            expect(panel.body.incidents.find((i: any) => i.id === globalId).resolved_at).toBeTruthy();
        });
    });

    describe('cane da guardia', () => {
        const tagOf = (kind: string) => `alert-${kind}-${otherTenantId}`;
        const adminNotifications = (tag: string) => db.query(
            `SELECT n.read_at FROM notifications n JOIN users u ON u.id = n.recipient_user_id
              WHERE u.email = $1 AND n.tag = $2`,
            [PA_EMAIL, tag]
        );

        it('stampe che falliscono aprono un avviso, una volta sola', async () => {
            for (let i = 0; i < 2; i++) {
                await db.query(
                    `INSERT INTO print_jobs (tenant_id, kind, payload, status, error) VALUES ($1, 'comanda', '{}', 'FAILED', 'ECONNREFUSED 192.168.1.50:9100')`,
                    [otherTenantId]
                );
            }
            expect((await api().post('/admin/health/check').set(bearer(platform))).status).toBe(200);
            const alert = await db.query(`SELECT * FROM platform_alerts WHERE tenant_id = $1 AND kind = 'stampa'`, [otherTenantId]);
            expect(alert.rows).toHaveLength(1);
            expect(alert.rows[0].resolved_at).toBeNull();
            expect(alert.rows[0].detail).toMatchObject({ failed: 2, last_error: 'ECONNREFUSED 192.168.1.50:9100' });
            const n = await waitFor(async () => (await adminNotifications(tagOf('stampa'))).rows[0] ?? null);
            expect(n).toBeTruthy();

            // Secondo giro con il problema ancora acceso: niente avviso nuovo.
            await api().post('/admin/health/check').set(bearer(platform));
            const again = await db.query(`SELECT COUNT(*)::int AS n FROM platform_alerts WHERE tenant_id = $1 AND kind = 'stampa'`, [otherTenantId]);
            expect(again.rows[0].n).toBe(1);

            const panel = await api().get('/admin/health').set(bearer(platform));
            expect(panel.body.alerts_open.some((a: any) => a.tenant_id === otherTenantId && a.kind === 'stampa')).toBe(true);
        });

        it('quando il problema rientra, l\'avviso si chiude e la notifica si spegne', async () => {
            await db.query(`DELETE FROM print_jobs WHERE tenant_id = $1`, [otherTenantId]);
            await api().post('/admin/health/check').set(bearer(platform));
            const alert = await db.query(`SELECT resolved_at FROM platform_alerts WHERE tenant_id = $1 AND kind = 'stampa'`, [otherTenantId]);
            expect(alert.rows[0].resolved_at).not.toBeNull();
            const n = await adminNotifications(tagOf('stampa'));
            expect(n.rows[0].read_at).not.toBeNull();
            const panel = await api().get('/admin/health').set(bearer(platform));
            expect(panel.body.alerts_recent.some((a: any) => a.tenant_id === otherTenantId && a.kind === 'stampa')).toBe(true);
        });

        it('gli errori di Sofia contano da tre in su', async () => {
            const insert = () => db.query(
                `INSERT INTO app_errors (tenant_id, origin, source, fingerprint, message) VALUES ($1, 'sofia', 'create-reservation', 'abcdef0123456789', 'timeout')`,
                [otherTenantId]
            );
            await insert(); await insert();
            await api().post('/admin/health/check').set(bearer(platform));
            const two = await db.query(`SELECT COUNT(*)::int AS n FROM platform_alerts WHERE tenant_id = $1 AND kind = 'sofia'`, [otherTenantId]);
            expect(two.rows[0].n).toBe(0);
            await insert();
            await api().post('/admin/health/check').set(bearer(platform));
            const three = await db.query(`SELECT detail FROM platform_alerts WHERE tenant_id = $1 AND kind = 'sofia' AND resolved_at IS NULL`, [otherTenantId]);
            expect(three.rows).toHaveLength(1);
            expect(three.rows[0].detail).toMatchObject({ failures: 3, last_error: 'create-reservation: timeout' });
        });
    });
});
