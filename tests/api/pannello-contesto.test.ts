import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Audit isolamento M-03. La sessione del pannello piattaforma (JWT
// PLATFORM_ADMIN senza scope, cioè senza «Entra») girava in runAsPlatform su
// OGNI route, non solo su /admin/*: le route che si affidavano alla RLS
// invece che al WHERE tenant_id mescolavano i tenant, a cominciare dal report
// AI. Ora fuori da /admin la sessione gira nel tenant di casa dell'admin.
// Qui si verifica che:
// - /auth/me, preferenze, push e logout funzionano ancora in quel contesto;
// - i preset e (con lo stub, vedi sotto) il report AI restano nel tenant;
// - una route senza filtro tenant esplicito vede solo il tenant di casa
//   (distinguibile solo con TEST_STRICT_RLS=1: da superuser la RLS tace);
// - /admin/tenants vede ancora tutti i tenant, «Entra» solo il suo;
// - PLATFORM_ADMIN non ha righe nella matrice e il provisioning non gliele
//   copia (la trappola di emptyRoleMap);
// - il JWT di un admin disattivato o retrocesso non apre più /admin/*.
//
// Il report AI non si può provare nella suite ordinaria: senza chiave
// risponde 503 prima di leggere il DB, e la suite non chiama mai Anthropic.
// Il blocco dedicato gira solo se si avvia vitest con uno stub locale:
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   REPORTS_ADMIN_EMAILS=admin@ristomanager.com,platform.admin.contesto@example.com \
//   npx vitest run tests/api/pannello-contesto.test.ts
// Lo stub gira in questo processo e registra il prompt ricevuto. In CI lo
// lancia il job «Test API (report AI, stub locale)» di ci.yml, da
// superuser: lì la RLS tace, e a tenere fuori le sale dell'altro tenant
// restano solo i filtri tenant_id espliciti del report. Non va messo nel
// globalSetup: ai-report.test.ts si aspetta il 503 senza chiave, e le altre
// route AI finirebbero sullo stub.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'trattoria-contesto-pannello';
const TENANT_NAME = 'Trattoria Contesto Pannello';
const OWNER_EMAIL = 'owner.contesto@example.com';
const PA_EMAIL = 'platform.admin.contesto@example.com';
const PA_PASSWORD = 'password-piattaforma-contesto';

const HOME_ALLERGEN = 'Allergene Casa Pannello';
const OTHER_ALLERGEN = 'Allergene Altro Tenant Pannello';
const HOME_NOTE = 'Nota Casa Pannello';
const OTHER_NOTE = 'Nota Altro Tenant Pannello';
const HOME_DISH = 'Piatto Casa Pannello';
const HOME_ROOM = 'Sala Casa Pannello';
const OTHER_ROOM = 'Sala Altro Tenant Pannello';
const PUSH_ENDPOINT = 'https://push.example.test/pannello-contesto';

const pgClient = async (): Promise<Client> => {
    const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
    const client = new Client({ connectionString: dbUrl });
    await client.connect();
    return client;
};

const STRICT = process.env.TEST_STRICT_RLS === '1';

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    const admins = (process.env.REPORTS_ADMIN_EMAILS || '').toLowerCase().split(',').map(s => s.trim());
    return m && process.env.ANTHROPIC_API_KEY && admins.includes(PA_EMAIL) ? Number(m[1]) : 0;
})();

// Con TEST_AI_STUB=1 lo stub è obbligatorio: un ambiente incompleto
// salterebbe il blocco in silenzio, e il job di CI resterebbe verde senza
// aver provato niente.
if (process.env.TEST_AI_STUB === '1' && AI_STUB_PORT === 0) {
    throw new Error('TEST_AI_STUB=1 ma mancano ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL (http://127.0.0.1:<porta>) o REPORTS_ADMIN_EMAILS con l\'admin di test');
}

describe('sessione di pannello nel tenant di casa (audit M-03)', () => {
    let tenantId = 0;
    let panelToken = '';
    let homeDishId = 0;
    let otherMenuId = 0;

    beforeAll(async () => {
        const client = await pgClient();
        try {
            // Id di tenant alti, come in platform-enter.test.ts: nessun file
            // successivo riusa un id e avvelena le cache per-tenant.
            await client.query(
                `SELECT setval(pg_get_serial_sequence('tenants','id'),
                               GREATEST((SELECT MAX(id) FROM tenants), 100))`
            );
            const hash = await bcrypt.hash(PA_PASSWORD, 4);
            await client.query(
                `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
                 VALUES ($1, $2, 'Platform Admin Contesto', 'PLATFORM_ADMIN', 1, TRUE)
                 ON CONFLICT (email) DO NOTHING`,
                [PA_EMAIL, hash]
            );
            // Una riga PLATFORM_ADMIN rimasta nel tenant 1 (come quelle che
            // la migration piattaforma-fuori-dalla-matrice cancella): il
            // provisioning non deve copiarla. Permesso che nessuna migration
            // ha mai seminato, così la pulizia sotto tocca solo questa riga.
            await client.query(
                `INSERT INTO role_permissions (tenant_id, role, permission)
                 VALUES (1, 'PLATFORM_ADMIN', 'dashboard:view')`
            );
        } finally {
            await client.end();
        }

        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: TENANT_NAME,
            owner_email: OWNER_EMAIL,
            owner_full_name: 'Owner Contesto Pannello',
        });
        if (created.status !== 201) {
            throw new Error(`Provisioning fallito (${created.status}): ${JSON.stringify(created.body)}`);
        }
        tenantId = created.body.tenant.id;

        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        if (login.status !== 200) {
            throw new Error(`Login platform admin fallito (${login.status}): ${JSON.stringify(login.body)}`);
        }
        panelToken = login.body.accessToken;

        const db = await pgClient();
        try {
            await db.query(
                `DELETE FROM role_permissions WHERE tenant_id = 1 AND role = 'PLATFORM_ADMIN' AND permission = 'dashboard:view'`
            );
            await db.query(
                `INSERT INTO reservation_allergen_presets (tenant_id, label, sort_order) VALUES (1, $1, 990), ($2, $3, 10)`,
                [HOME_ALLERGEN, tenantId, OTHER_ALLERGEN]
            );
            await db.query(
                `INSERT INTO reservation_note_presets (tenant_id, label, sort_order) VALUES (1, $1, 990), ($2, $3, 10)`,
                [HOME_NOTE, tenantId, OTHER_NOTE]
            );
            // Riga di un altro tenant agganciata a un piatto di casa: la
            // sottoquery menu_ids di GET /dishes la correla solo per dish_id,
            // senza tenant_id. La tiene fuori soltanto il contesto RLS.
            const dish = await db.query(
                `INSERT INTO dishes (tenant_id, name, price) VALUES (1, $1, 9) RETURNING id`, [HOME_DISH]
            );
            homeDishId = dish.rows[0].id;
            const menu = await db.query(
                `INSERT INTO menus (tenant_id, name, sort_order) VALUES ($1, 'Menu Altro Tenant Pannello', 5) RETURNING id`,
                [tenantId]
            );
            otherMenuId = menu.rows[0].id;
            await db.query(
                `INSERT INTO dish_menus (tenant_id, dish_id, menu_id) VALUES ($1, $2, $3)`,
                [tenantId, homeDishId, otherMenuId]
            );
            // Una sala per parte con una prenotazione dentro la finestra del
            // report AI: il nome della sala finisce nel prompt.
            for (const [tid, room, table] of [[1, HOME_ROOM, 'PANCASA'], [tenantId, OTHER_ROOM, 'PANALTRO']] as const) {
                const r = await db.query(
                    `INSERT INTO rooms (tenant_id, name, width, height) VALUES ($1, $2, 800, 600) RETURNING id`, [tid, room]
                );
                const t = await db.query(
                    `INSERT INTO tables (tenant_id, room_id, name, shape, seats, x, y, status)
                     VALUES ($1, $2, $3, 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`,
                    [tid, r.rows[0].id, table]
                );
                await db.query(
                    `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, payment_status, table_id)
                     VALUES ($1, 'Ospite Pannello Contesto', NOW() - interval '2 days', 'DINNER', 4, 'PENDING', $2)`,
                    [tid, t.rows[0].id]
                );
            }
        } finally {
            await db.end();
        }
    });

    afterAll(async () => {
        const client = await pgClient();
        try {
            await client.query(`DELETE FROM role_permissions WHERE tenant_id = 1 AND role = 'PLATFORM_ADMIN' AND permission = 'dashboard:view'`);
            await client.query(`DELETE FROM reservations WHERE customer_name = 'Ospite Pannello Contesto'`);
            await client.query(`DELETE FROM tables WHERE name IN ('PANCASA', 'PANALTRO')`);
            await client.query(`DELETE FROM rooms WHERE name IN ($1, $2)`, [HOME_ROOM, OTHER_ROOM]);
            await client.query(`DELETE FROM reservation_allergen_presets WHERE label IN ($1, $2)`, [HOME_ALLERGEN, OTHER_ALLERGEN]);
            await client.query(`DELETE FROM reservation_note_presets WHERE label IN ($1, $2)`, [HOME_NOTE, OTHER_NOTE]);
            await client.query(`DELETE FROM dishes WHERE tenant_id = 1 AND name = $1`, [HOME_DISH]);
            await client.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [PUSH_ENDPOINT]);
            await client.query(`DELETE FROM ai_token_usage WHERE user_email = $1`, [PA_EMAIL]);
            const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [SLUG]);
            const id = t.rows[0]?.id;
            if (id != null) {
                // L'ordine conta: prima le righe che puntano ad altre righe del
                // tenant, poi le tabelle con FK verso tenants.
                for (const table of ['dish_menus', 'menus', 'reservation_allergen_presets', 'reservation_note_presets',
                    'activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
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

    it('/auth/me: tenant di casa, nessun permesso di matrice', async () => {
        const res = await api().get('/auth/me').set(bearer(panelToken));
        expect(res.status).toBe(200);
        expect(res.body.email).toBe(PA_EMAIL);
        expect(res.body.role).toBe('PLATFORM_ADMIN');
        expect(res.body.tenant.id).toBe(1);
        // Niente staffchat:use, cash:* e fiscal:view seminati dalle vecchie
        // migration: il menu del pannello non mostra più voci che danno 403.
        expect(res.body.permissions).toEqual([]);
    });

    it('il provisioning non copia righe PLATFORM_ADMIN nel tenant nuovo', async () => {
        const client = await pgClient();
        try {
            const r = await client.query(
                `SELECT permission FROM role_permissions WHERE tenant_id = $1 AND role = 'PLATFORM_ADMIN'`, [tenantId]
            );
            expect(r.rows).toEqual([]);
            // La matrice dei ruoli del ristorante invece arriva intera.
            const owner = await client.query(
                `SELECT COUNT(*)::int AS n FROM role_permissions WHERE tenant_id = $1 AND role = 'OWNER'`, [tenantId]
            );
            expect(owner.rows[0].n).toBeGreaterThan(0);
        } finally {
            await client.end();
        }
    });

    it('la matrice del tenant non accetta il ruolo PLATFORM_ADMIN', async () => {
        // Senza questa guardia un OWNER del tenant di casa rimetteva con un
        // PUT le righe che la migration cancella, e il token di pannello le
        // ritrovava in /auth/me.
        const owner = await ownerToken();
        const put = await api().put('/auth/permissions/roles/PLATFORM_ADMIN').set(bearer(owner))
            .send({ permissions: ['dashboard:view'] });
        expect(put.status).toBe(400);
        const get = await api().get('/auth/permissions/roles/platform_admin').set(bearer(owner));
        expect(get.status).toBe(400);

        const client = await pgClient();
        try {
            const r = await client.query(
                `SELECT permission FROM role_permissions WHERE tenant_id = 1 AND role = 'PLATFORM_ADMIN'`
            );
            expect(r.rows).toEqual([]);
        } finally {
            await client.end();
        }
        const me = await api().get('/auth/me').set(bearer(panelToken));
        expect(me.status).toBe(200);
        expect(me.body.permissions).toEqual([]);
    });

    it('preferenze, push e notifiche funzionano nel tenant di casa', async () => {
        const prefs = await api().put('/auth/me/preferences').set(bearer(panelToken)).send({ preferred_design_style: null });
        expect(prefs.status).toBe(200);
        expect(prefs.body.email).toBe(PA_EMAIL);

        const sub = await api().post('/push/subscribe').set(bearer(panelToken)).send({
            endpoint: PUSH_ENDPOINT, keys: { p256dh: 'chiave-p256dh', auth: 'chiave-auth' },
        });
        expect(sub.status).toBe(201);
        const client = await pgClient();
        try {
            const row = await client.query(
                `SELECT ps.tenant_id, u.email FROM push_subscriptions ps JOIN users u ON u.id = ps.user_id WHERE ps.endpoint = $1`,
                [PUSH_ENDPOINT]
            );
            expect(row.rows).toHaveLength(1);
            expect(Number(row.rows[0].tenant_id)).toBe(1);
            expect(row.rows[0].email).toBe(PA_EMAIL);
        } finally {
            await client.end();
        }

        const unread = await api().get('/notifications/unread-count').set(bearer(panelToken));
        expect(unread.status).toBe(200);

        const unsub = await api().post('/push/unsubscribe').set(bearer(panelToken)).send({ endpoint: PUSH_ENDPOINT });
        expect(unsub.status).toBe(200);
    });

    it('i preset di un altro tenant non arrivano alla sessione di pannello', async () => {
        const allergens = await api().get('/settings/reservation-allergens').set(bearer(panelToken));
        expect(allergens.status).toBe(200);
        const allergenLabels = allergens.body.map((p: any) => p.label);
        expect(allergenLabels).toContain(HOME_ALLERGEN);
        expect(allergenLabels).not.toContain(OTHER_ALLERGEN);

        const notes = await api().get('/settings/reservation-notes').set(bearer(panelToken));
        expect(notes.status).toBe(200);
        const noteLabels = notes.body.map((p: any) => p.label);
        expect(noteLabels).toContain(HOME_NOTE);
        expect(noteLabels).not.toContain(OTHER_NOTE);
    });

    // Da superuser (suite ordinaria) la RLS non filtra niente, qualunque sia
    // il contesto: la differenza fra runAsPlatform e tenant di casa si vede
    // solo col ruolo non-superuser della modalità rigida.
    it.runIf(STRICT)('una route senza filtro tenant esplicito vede solo il tenant di casa', async () => {
        const res = await api().get('/dishes').set(bearer(panelToken));
        expect(res.status).toBe(200);
        const dish = res.body.find((d: any) => d.id === homeDishId);
        expect(dish).toBeTruthy();
        expect(dish.menu_ids).not.toContain(otherMenuId);
        expect(dish.menu_ids).toEqual([]);
    });

    it('/admin/tenants col JWT di pannello elenca ancora tutti i tenant', async () => {
        const res = await api().get('/admin/tenants').set(bearer(panelToken));
        expect(res.status).toBe(200);
        const ids = res.body.map((t: any) => Number(t.id));
        expect(ids).toContain(1);
        expect(ids).toContain(tenantId);
    });

    it('«Entra» nel tenant: vede solo quel tenant', async () => {
        const enter = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(panelToken));
        expect(enter.status).toBe(200);
        const scoped = enter.body.accessToken as string;

        const allergens = await api().get('/settings/reservation-allergens').set(bearer(scoped));
        expect(allergens.status).toBe(200);
        const labels = allergens.body.map((p: any) => p.label);
        expect(labels).toContain(OTHER_ALLERGEN);
        expect(labels).not.toContain(HOME_ALLERGEN);

        const dishes = await api().get('/dishes').set(bearer(scoped));
        expect(dishes.status).toBe(200);
        expect(dishes.body.map((d: any) => d.id)).not.toContain(homeDishId);
    });

    describe.runIf(AI_STUB_PORT > 0)('report AI con lo stub locale di Anthropic', () => {
        const received: any[] = [];
        let stub: http.Server;

        beforeAll(async () => {
            stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try { received.push(JSON.parse(body)); } catch { received.push(null); }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'msg_stub_pannello', type: 'message', role: 'assistant', model: 'stub',
                        content: [{ type: 'text', text: 'Report di prova.' }],
                        stop_reason: 'end_turn', stop_sequence: null,
                        usage: { input_tokens: 10, output_tokens: 5 },
                    }));
                });
            });
            await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => stub.close(() => resolve()));
        });

        const lastPrompt = () => {
            const last = received[received.length - 1];
            return { system: String(last?.system ?? ''), user: String(last?.messages?.[0]?.content ?? '') };
        };

        it('sessione di pannello: nel prompt solo le sale del tenant di casa', async () => {
            const res = await api().post('/reports/ai-summary').set(bearer(panelToken)).send({ days: 30 });
            expect(res.status).toBe(200);
            const { user } = lastPrompt();
            expect(user).toContain(HOME_ROOM);
            expect(user).not.toContain(OTHER_ROOM);
        });

        it('«Entra»: solo le sale del tenant, e il nome è il suo', async () => {
            const enter = await api().post(`/admin/tenants/${tenantId}/enter`).set(bearer(panelToken));
            expect(enter.status).toBe(200);
            const res = await api().post('/reports/ai-summary').set(bearer(enter.body.accessToken)).send({ days: 30 });
            expect(res.status).toBe(200);
            const { system, user } = lastPrompt();
            expect(user).toContain(OTHER_ROOM);
            expect(user).not.toContain(HOME_ROOM);
            expect(system).toContain(TENANT_NAME);
            expect(system).not.toContain('Frantoio');
        });
    });

    it('il JWT di un admin disattivato o retrocesso non apre più /admin', async () => {
        const client = await pgClient();
        try {
            await client.query(`UPDATE users SET is_active = FALSE WHERE email = $1`, [PA_EMAIL]);
            const off = await api().get('/admin/tenants').set(bearer(panelToken));
            expect(off.status).toBe(403);
            expect(off.body.error).toBe('platform_admin_revoked');
            await client.query(`UPDATE users SET is_active = TRUE, role = 'OWNER' WHERE email = $1`, [PA_EMAIL]);
            const demoted = await api().get('/admin/tenants').set(bearer(panelToken));
            expect(demoted.status).toBe(403);
            expect(demoted.body.error).toBe('platform_admin_revoked');
        } finally {
            await client.query(`UPDATE users SET is_active = TRUE, role = 'PLATFORM_ADMIN' WHERE email = $1`, [PA_EMAIL]);
            await client.end();
        }
        const back = await api().get('/admin/tenants').set(bearer(panelToken));
        expect(back.status).toBe(200);
    });

    it('logout della sessione di pannello', async () => {
        const res = await api().post('/auth/logout').set(bearer(panelToken)).send({});
        expect(res.status).toBe(200);
    });
});
