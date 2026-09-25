import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// L'agente ElevenLabs in env è Sofia, la linea del Frantoio (tenant 1).
// Prima di questo gate «Sincronizza» dal tenant Demo, con voice acceso,
// importava nel Demo le chiamate del Frantoio (telefoni, trascrizioni,
// audio), e la /prenota di ogni ristorante mostrava il numero di Sofia
// (audit isolamento tenant, H-02 e L-11). Un tenant senza agente ora
// riceve 409 su sync e audio, e /public/:slug/contact non gli dà né numero
// né agente. globalSetup imposta un agente e un numero finti e lascia
// vuota la chiave: il tenant 1 passa il gate e si ferma al 503.

const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const SLUG = 'pizzeria-senza-sofia';
const OWNER_B_EMAIL = 'owner.senzasofia@example.com';

describe('agente vocale per tenant', () => {
    let tenantB = 0;
    let tokenB = '';

    beforeAll(async () => {
        // Il tenant B ha voice ACCESO, come il Demo in produzione: è il caso
        // in cui il vecchio sync importava le chiamate del Frantoio.
        const created = await api().post('/admin/tenants').set(ADMIN_HEADER).send({
            slug: SLUG,
            name: 'Pizzeria Senza Sofia',
            owner_email: OWNER_B_EMAIL,
            features: { voice: true },
        });
        expect(created.status).toBe(201);
        tenantB = Number(created.body.tenant.id);
        const login = await api().post('/auth/login').send({
            email: OWNER_B_EMAIL,
            password: created.body.owner_temp_password,
        });
        expect(login.status).toBe(200);
        tokenB = login.body.accessToken;

        // Tenant 1 con voice acceso a prescindere dai file girati prima.
        const t1 = await api().patch('/admin/tenants/1').set(ADMIN_HEADER).send({ features: { voice: true } });
        expect(t1.status).toBe(200);
    });

    afterAll(async () => {
        if (!tenantB) return;
        const db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        try {
            for (const table of ['activity_logs', 'users', 'tenant_features', 'opening_hours', 'role_permissions', 'app_settings']) {
                await db.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantB]);
            }
            await db.query('DELETE FROM tenants WHERE id = $1', [tenantB]);
        } finally {
            await db.end();
        }
    });

    it('un tenant senza agente non sincronizza le chiamate di Sofia', async () => {
        const res = await api().post('/voice-calls/sync').set(bearer(tokenB));
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('voice_agent_not_configured');
        expect(res.body.message).toBe('Nessun agente vocale collegato a questo ristorante.');
    });

    it('un tenant senza agente non ascolta audio dall\'account del Frantoio', async () => {
        const res = await api().get('/voice-calls/1/audio').set(bearer(tokenB));
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('voice_agent_not_configured');
    });

    it('la /prenota di un altro ristorante non mostra numero né agente di Sofia', async () => {
        const res = await api().get(`/public/${SLUG}/contact`);
        expect(res.status).toBe(200);
        expect(res.body.voice).toBeNull();
        expect(res.body.voice_agent_id).toBe('');
    });

    it('il Frantoio passa il gate: sync e audio si fermano alla chiave mancante', async () => {
        const token = await ownerToken();
        const sync = await api().post('/voice-calls/sync').set(bearer(token));
        expect(sync.status).toBe(503);
        expect(sync.body.error).toBe('ELEVENLABS_API_KEY not configured');

        const audio = await api().get('/voice-calls/1/audio').set(bearer(token));
        expect(audio.status).toBe(503);
        expect(audio.body.error).toBe('ELEVENLABS_API_KEY not configured');
    });

    it('la /prenota del Frantoio tiene numero e agente di Sofia', async () => {
        const res = await api().get('/public/contact');
        expect(res.status).toBe(200);
        expect(res.body.voice).toEqual({ phone: '+390550000000', display: '+39 055 0000000' });
        expect(res.body.voice_agent_id).toBe('agent_test_frantoio');
    });
});
