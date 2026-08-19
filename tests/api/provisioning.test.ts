import { describe, it, expect, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { api } from './helpers';

// Provisioning tenant (Fase D1): POST /admin/tenants crea un ristorante
// completo (riga tenants + token, matrice permessi copiata dal tenant 1,
// orari neutri, entitlement, utente OWNER) in una transazione sola. Il gate
// è il token di piattaforma da env (il ruolo PLATFORM_ADMIN arriva in D2).
//
// Data futura fissa come negli altri file: per la data odierna availability
// scarta gli slot già passati e il test dipenderebbe dall'orologio.
const DATA_FUTURA = '2027-03-10';

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };

const SLUG = 'trattoria-test-d1';
const SLUG_EMAIL_DUP = 'osteria-test-d1';
const OWNER_EMAIL = 'owner.d1@example.com';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('provisioning tenant (/admin/tenants, Fase D1)', () => {
    let tenantId = 0;
    let ownerTempPassword = '';

    // Cleanup diretto a DB: il tenant di test sparisce qualunque cosa sia
    // successo, così le run ripetute sullo stesso database non collidono
    // sullo slug e gli altri file di test non vedono un tenant in più.
    afterAll(async () => {
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        try {
            for (const slug of [SLUG, SLUG_EMAIL_DUP]) {
                const t = await client.query('SELECT id FROM tenants WHERE slug = $1', [slug]);
                const id = t.rows[0]?.id;
                if (id == null) continue;
                // Prima le tabelle figlie (FK su tenants), poi la riga tenant.
                // activity_logs: il login dell'OWNER ha scritto righe di log.
                for (const table of ['activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [id]);
                }
                await client.query('DELETE FROM tenants WHERE id = $1', [id]);
            }
        } finally {
            await client.end();
        }
    });

    it('senza header di piattaforma → 401 (anche con token sbagliato)', async () => {
        const senza = await api().get('/admin/tenants');
        expect(senza.status).toBe(401);
        expect(senza.body.error).toBe('invalid_platform_admin_token');

        const sbagliato = await api().get('/admin/tenants').set({ 'X-Platform-Admin-Token': 'token-sbagliato' });
        expect(sbagliato.status).toBe(401);
    });

    it('senza PLATFORM_ADMIN_TOKEN in env → 503 platform_admin_disabled', async () => {
        // Il server condiviso dei test ha il token configurato: per provare
        // il caso "funzionalità spenta" si avvia un secondo processo senza
        // env e lo si uccide subito dopo la richiesta. /health risponde
        // prima che createSchema finisca, e il middleware non tocca il DB.
        const distServer = path.resolve('dist/server.js');
        expect(existsSync(distServer)).toBe(true);
        const dbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const env = { ...process.env, DATABASE_URL: dbUrl, PORT: '3299', JWT_SECRET: 'test-jwt-secret', JWT_REFRESH_SECRET: 'test-jwt-refresh-secret' };
        delete (env as Record<string, unknown>).PLATFORM_ADMIN_TOKEN;
        const child = spawn('node', [distServer], { env, stdio: 'ignore' });
        try {
            const deadline = Date.now() + 20_000;
            for (;;) {
                try {
                    const res = await fetch('http://127.0.0.1:3299/health');
                    if (res.status === 200) break;
                } catch { /* non ancora in ascolto */ }
                if (Date.now() > deadline) throw new Error('Secondo server non pronto entro 20s');
                await sleep(250);
            }
            const res = await fetch('http://127.0.0.1:3299/admin/tenants', { headers: ADMIN_HEADER });
            expect(res.status).toBe(503);
            const body = await res.json();
            expect(body.error).toBe('platform_admin_disabled');
        } finally {
            child.kill('SIGKILL');
        }
    });

    it('POST crea il tenant e risponde password temporanea e token', async () => {
        const res = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Trattoria Test D1',
            owner_email: OWNER_EMAIL,
            owner_full_name: 'Owner Di Prova',
        });
        expect(res.status).toBe(201);
        expect(res.body.tenant.slug).toBe(SLUG);
        expect(res.body.tenant.status).toBe('active');
        // Password temporanea 16 byte → 32 hex; token 24 byte → 48 hex
        // (stessa forma dei token del tenant 1 generati da pgcrypto).
        expect(res.body.owner_temp_password).toMatch(/^[0-9a-f]{32}$/);
        expect(res.body.webhook_token).toMatch(/^[0-9a-f]{48}$/);
        expect(res.body.print_agent_token).toMatch(/^[0-9a-f]{48}$/);
        expect(res.body.booking_url).toContain(`/prenota/${SLUG}`);
        tenantId = res.body.tenant.id;
        ownerTempPassword = res.body.owner_temp_password;
    });

    it('la lista tenant include il nuovo, con conteggio utenti e feature attive', async () => {
        const res = await api().get('/admin/tenants').set(ADMIN_HEADER);
        expect(res.status).toBe(200);
        const nuovo = res.body.find((t: any) => t.slug === SLUG);
        expect(nuovo).toBeTruthy();
        expect(nuovo.user_count).toBe(1);
        expect(nuovo.features).toEqual([]); // niente regali: tutte spente
        // Il tenant 1 resta in lista (grandfathered con tutti gli add-on).
        expect(res.body.some((t: any) => t.id === 1)).toBe(true);
    });

    it("l'OWNER entra con la password temporanea, nel tenant giusto, feature tutte false", async () => {
        const res = await api().post('/auth/login').send({ email: OWNER_EMAIL, password: ownerTempPassword });
        expect(res.status).toBe(200);
        expect(res.body.user.role).toBe('OWNER');
        expect(res.body.user.tenant.slug).toBe(SLUG);
        expect(res.body.user.tenant.features).toEqual({ voice: false, whatsapp: false, web_booking: false });
        // La matrice permessi copiata dal tenant 1 deve dare all'OWNER i suoi
        // permessi: senza la copia questo array sarebbe vuoto.
        expect(res.body.permissions).toContain('settings:full');
    });

    it('web_booking nasce spento: availability pubblica → 503 (si vende, non si regala)', async () => {
        const res = await api().get(`/public/${SLUG}/availability`).query({ date: DATA_FUTURA });
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('bookings_disabled');
    });

    it('PATCH abilita web_booking → availability 200 con gli orari neutri seminati', async () => {
        const patch = await api().patch(`/admin/tenants/${tenantId}`).set(ADMIN_HEADER).send({
            features: { web_booking: true },
        });
        expect(patch.status).toBe(200);
        expect(patch.body.features).toEqual({ voice: false, whatsapp: false, web_booking: true });

        const avail = await api().get(`/public/${SLUG}/availability`).query({ date: DATA_FUTURA });
        expect(avail.status).toBe(200);
        // Default neutri del provisioning (12:30–14:00 / 19:30–22:30, 30'),
        // NON gli orari del Frantoio (che partono alle 13:00).
        expect(avail.body.lunch.slots[0]).toBe('12:30');
        expect(avail.body.lunch.slots).toContain('14:00');
        expect(avail.body.dinner.slots[0]).toBe('19:30');
        expect(avail.body.dinner.slots[avail.body.dinner.slots.length - 1]).toBe('22:30');
    });

    it('PATCH status suspended → login OWNER 403 tenant_suspended', async () => {
        const patch = await api().patch(`/admin/tenants/${tenantId}`).set(ADMIN_HEADER).send({ status: 'suspended' });
        expect(patch.status).toBe(200);
        expect(patch.body.tenant.status).toBe('suspended');

        const login = await api().post('/auth/login').send({ email: OWNER_EMAIL, password: ownerTempPassword });
        expect(login.status).toBe(403);
        expect(login.body.error).toBe('tenant_suspended');
    });

    it('slug duplicato → 409 slug_conflict', async () => {
        const res = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Doppione',
            owner_email: 'altro.owner.d1@example.com',
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('slug_conflict');
    });

    it('email duplicata → 409 email_conflict, e il tenant NON nasce a metà', async () => {
        const res = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG_EMAIL_DUP,
            name: 'Osteria Email Doppia',
            owner_email: OWNER_EMAIL,
        });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('email_conflict');

        // La transazione unica deve aver fatto rollback di tutto: nessuna
        // riga tenants orfana senza OWNER.
        const list = await api().get('/admin/tenants').set(ADMIN_HEADER);
        expect(list.body.some((t: any) => t.slug === SLUG_EMAIL_DUP)).toBe(false);
    });
});
