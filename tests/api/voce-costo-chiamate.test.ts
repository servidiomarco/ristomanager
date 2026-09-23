import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 1 dei minuti di Sofia: il post-call salva durata e costo della
// conversazione, e il pannello Piattaforma li somma per ristorante nel mese.
// La durata arriva in metadata.call_duration_secs: leggendo solo
// call_duration_seconds non veniva mai salvata (agosto 2026: 36 su 1.542).
const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const CONV_LUNGA = 'conv-test-costo-lunga';
const CONV_CORTA = 'conv-test-costo-corta';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

const postCall = (conversationId: string, seconds: number, llm: number, platform: number, credits: number) =>
    api().post('/webhook/elevenlabs/post-call').send({
        type: 'post_call_transcription',
        data: {
            conversation_id: conversationId,
            transcript: [{ role: 'agent', message: 'Ciao, sono Sofia.' }],
            metadata: {
                call_duration_secs: seconds,
                cost: credits,
                charging: { llm_price: llm, platform_price: platform },
                phone_call: { external_number: '+393390000801' },
            },
        },
    });

describe('costo delle chiamate di Sofia', () => {
    beforeAll(async () => {
        const token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM voice_calls WHERE conversation_id = ANY($1::text[])`, [[CONV_LUNGA, CONV_CORTA]]);
    });

    it('il post-call salva durata (call_duration_secs) e costo', async () => {
        const res = await postCall(CONV_LUNGA, 130, 0.04, 0.17, 1300);
        expect(res.status).toBe(200);

        // Il salvataggio parte dopo la risposta: si attende la riga.
        let row: any;
        for (let i = 0; i < 20 && !row; i++) {
            const r = await dbQuery(
                `SELECT duration_seconds, cost_credits, cost_usd::float, llm_cost_usd::float, platform_cost_usd::float
                   FROM voice_calls WHERE conversation_id = $1`, [CONV_LUNGA]);
            row = r.rows[0];
            if (!row) await new Promise(res => setTimeout(res, 100));
        }
        expect(row.duration_seconds).toBe(130);
        expect(row.cost_credits).toBe(1300);
        expect(row.llm_cost_usd).toBeCloseTo(0.04, 5);
        expect(row.platform_cost_usd).toBeCloseTo(0.17, 5);
        expect(row.cost_usd).toBeCloseTo(0.21, 5);
    });

    it('il pannello Piattaforma somma il mese: le chiamate sotto i 10 s non contano', async () => {
        const corta = await postCall(CONV_CORTA, 6, 0, 0.01, 50);
        expect(corta.status).toBe(200);
        for (let i = 0; i < 20; i++) {
            const r = await dbQuery(`SELECT 1 FROM voice_calls WHERE conversation_id = $1`, [CONV_CORTA]);
            if (r.rowCount) break;
            await new Promise(res => setTimeout(res, 100));
        }

        const list = await api().get('/admin/tenants').set(ADMIN_HEADER);
        expect(list.status).toBe(200);
        const t1 = list.body.find((t: any) => t.id === 1);
        expect(t1.voice_month).toBeTruthy();
        // 130 s conteggiati (i 6 s no) → 3 minuti arrotondati per eccesso.
        expect(t1.voice_month.billable_minutes).toBeGreaterThanOrEqual(3);
        expect(t1.voice_month.included_minutes).toBe(250);
        expect(t1.voice_month.cost_usd).toBeGreaterThanOrEqual(0.22 - 1e-9);
        expect(t1.voice_month.estimated_revenue_cents).toBeGreaterThanOrEqual(4900);
    });
});
