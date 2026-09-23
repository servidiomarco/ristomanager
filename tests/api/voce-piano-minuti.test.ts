import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 2 dei minuti di Sofia: piano per ristorante (listino + eccezioni),
// tetto degli extra scelto dal ristoratore, avvisi una volta per soglia.
const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const CONV = 'conv-test-piano-minuti';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const waitFor = async (sql: string, params: any[], tries = 30) => {
    for (let i = 0; i < tries; i++) {
        const r = await dbQuery(sql, params);
        if (r.rowCount) return r;
        await new Promise(res => setTimeout(res, 100));
    }
    return dbQuery(sql, params);
};

describe('piano dei minuti di Sofia', () => {
    let token: string;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
        await dbQuery(`DELETE FROM voice_plans WHERE tenant_id = 1`);
        await dbQuery(`DELETE FROM voice_usage_alerts WHERE tenant_id = 1`);
    });

    afterAll(async () => {
        // DB condiviso fra file: si torna al listino e senza avvisi.
        await dbQuery(`DELETE FROM voice_plans WHERE tenant_id = 1`);
        await dbQuery(`DELETE FROM voice_usage_alerts WHERE tenant_id = 1`);
        await dbQuery(`DELETE FROM voice_calls WHERE conversation_id LIKE $1`, [`${CONV}%`]);
    });

    it('senza eccezioni vale il listino', async () => {
        const res = await api().get('/voice-usage').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.plan).toMatchObject({
            priceCents: 4900, includedMinutes: 250, overageCentsPerMinute: 20, extraCapCents: 5000, custom: false,
        });
        expect(typeof res.body.month.billable_minutes).toBe('number');
        expect(typeof res.body.month.bookings).toBe('number');
        expect(Array.isArray(res.body.month.daily)).toBe(true);
    });

    it('il ristoratore sceglie il tetto degli extra, entro 0–1.000 €', async () => {
        const bad = await api().put('/voice-usage/cap').set(bearer(token)).send({ extra_cap_cents: 200000 });
        expect(bad.status).toBe(400);
        const ok = await api().put('/voice-usage/cap').set(bearer(token)).send({ extra_cap_cents: 2000 });
        expect(ok.status).toBe(200);
        expect(ok.body.plan.extraCapCents).toBe(2000);
        expect(ok.body.plan.custom).toBe(true);
        // Il resto del piano resta di listino.
        expect(ok.body.plan.includedMinutes).toBe(250);
    });

    it('la piattaforma cambia minuti inclusi e prezzi; null torna al listino', async () => {
        const res = await api().patch('/admin/tenants/1/voice-plan').set(ADMIN_HEADER)
            .send({ price_cents: 3900, included_minutes: 1, overage_cents_per_minute: null });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ priceCents: 3900, includedMinutes: 1, overageCentsPerMinute: 20, extraCapCents: 2000 });

        const noAuth = await api().patch('/admin/tenants/1/voice-plan').send({ included_minutes: 5 });
        expect(noAuth.status).toBeGreaterThanOrEqual(401);
    });

    it('superati i minuti inclusi parte un avviso, una volta sola nel mese', async () => {
        const postCall = (id: string) => api().post('/webhook/elevenlabs/post-call').send({
            data: {
                conversation_id: id,
                transcript: [{ role: 'agent', message: 'Ciao, sono Sofia.' }],
                metadata: { call_duration_secs: 90, cost: 900, charging: { llm_price: 0.02, platform_price: 0.13 } },
            },
        });
        expect((await postCall(`${CONV}-1`)).status).toBe(200);
        const first = await waitFor(
            `SELECT threshold FROM voice_usage_alerts WHERE tenant_id = 1 AND threshold = 'included_100'`, []);
        expect(first.rowCount).toBe(1);

        expect((await postCall(`${CONV}-2`)).status).toBe(200);
        await waitFor(`SELECT 1 FROM voice_calls WHERE conversation_id = $1`, [`${CONV}-2`]);
        await new Promise(res => setTimeout(res, 300));
        const again = await dbQuery(
            `SELECT threshold FROM voice_usage_alerts WHERE tenant_id = 1 AND threshold = 'included_100'`);
        expect(again.rowCount).toBe(1);
    });
});
