import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// «Chiedi a Sympotia» (supporto, fase 3): l'assistente sui manuali.
// Nella suite ordinaria non c'è la chiave: si prova la validazione, il 503
// «non disponibile» e chi può chiedere. Il comportamento col modello gira
// solo con lo stub locale di Anthropic (job «Test API (report AI, stub
// locale)» di ci.yml), come pannello-contesto.test.ts:
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/assistente.test.ts

const PA_EMAIL = 'platform.admin.assistente@example.com';
const PA_PASSWORD = 'password-assistente-piattaforma';

const pgClient = async (): Promise<Client> => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    return client;
};

const AI_STUB_PORT = (() => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(process.env.ANTHROPIC_BASE_URL || '');
    return m && process.env.ANTHROPIC_API_KEY ? Number(m[1]) : 0;
})();

const question = (content: string) => ({ messages: [{ role: 'user', content }] });

describe('assistente «Chiedi a Sympotia»', () => {
    let db: Client;
    let owner = '';
    let platform = '';

    beforeAll(async () => {
        db = await pgClient();
        owner = await ownerToken();
        await db.query(
            `INSERT INTO users (email, password_hash, full_name, role, tenant_id, is_active)
             VALUES ($1, $2, 'Admin Assistente', 'PLATFORM_ADMIN', 1, TRUE)`,
            [PA_EMAIL, bcrypt.hashSync(PA_PASSWORD, 4)]
        );
        const login = await api().post('/auth/login').send({ email: PA_EMAIL, password: PA_PASSWORD });
        platform = login.body.accessToken;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM ai_token_usage WHERE feature = 'support_assistant'`);
        await db.query('DELETE FROM activity_logs WHERE user_email = $1', [PA_EMAIL]);
        await db.query('DELETE FROM user_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)', [PA_EMAIL]);
        await db.query('DELETE FROM users WHERE email = $1', [PA_EMAIL]);
        await db.end();
    });

    it('chiede una conversazione valida che finisce con una domanda', async () => {
        expect((await api().post('/support/assistant').send(question('ciao'))).status).toBe(401);
        expect((await api().post('/support/assistant').set(bearer(owner)).send({ messages: [] })).status).toBe(400);
        expect((await api().post('/support/assistant').set(bearer(owner)).send({ messages: [{ role: 'assistant', content: 'solo io' }] })).status).toBe(400);
        expect((await api().post('/support/assistant').set(bearer(owner)).send({ messages: [{ role: 'boh', content: 'x' }] })).status).toBe(400);
    });

    it('il token di pannello non ha un ristorante: niente assistente', async () => {
        const res = await api().post('/support/assistant').set(bearer(platform)).send(question('ciao'));
        expect(res.status).toBe(403);
    });

    it.runIf(AI_STUB_PORT === 0)('senza chiave dice che non è disponibile, invece di un errore generico', async () => {
        const res = await api().post('/support/assistant').set(bearer(owner)).send(question('Come sposto una prenotazione?'));
        expect(res.status).toBe(503);
        expect(res.body.error).toBe('not_configured');
    });

    describe.runIf(AI_STUB_PORT > 0)('con lo stub locale di Anthropic', () => {
        const received: any[] = [];
        let reply: Record<string, unknown> = {};
        let stub: http.Server;

        beforeAll(async () => {
            stub = http.createServer((req, res) => {
                let body = '';
                req.on('data', chunk => { body += chunk; });
                req.on('end', () => {
                    try { received.push(JSON.parse(body)); } catch { received.push(null); }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'msg_stub_assistente', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
                        content: [{ type: 'text', text: 'Risposta di prova.' }],
                        stop_reason: 'end_turn', stop_sequence: null,
                        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 30000, cache_creation_input_tokens: 0 },
                        ...reply,
                    }));
                });
            });
            await new Promise<void>(resolve => stub.listen(AI_STUB_PORT, '127.0.0.1', () => resolve()));
        });

        afterAll(async () => {
            await new Promise<void>(resolve => stub.close(() => resolve()));
        });

        it('modello economico, manuali in cache nel prompt, chi scrive dopo il punto di cache', async () => {
            const res = await api().post('/support/assistant').set(bearer(owner)).send(question('Come sposto una prenotazione?'));
            expect(res.status).toBe(200);
            expect(res.body).toEqual({ answer: 'Risposta di prova.', suggest_ticket: false });
            const last = received[received.length - 1];
            expect(last.model).toBe('claude-haiku-4-5');
            expect(Array.isArray(last.system)).toBe(true);
            expect(last.system[0].cache_control).toEqual({ type: 'ephemeral' });
            expect(last.system[0].text).toContain('Catalogo delle funzionalità');
            expect(last.system[0].text).toContain('Manuale utente');
            // Il registro delle modifiche resta fuori: è metà del file e non
            // serve a rispondere ai «come si fa».
            expect(last.system[0].text).not.toContain('## Registro aggiornamenti');
            expect(last.system[1].cache_control).toBeUndefined();
            expect(last.system[1].text).toContain('ruolo OWNER');
            expect(last.messages).toEqual([{ role: 'user', content: 'Come sposto una prenotazione?' }]);
        });

        it('registra il consumo a costo equivalente: la lettura dalla cache conta un decimo', async () => {
            // La riga si scrive dopo la risposta, senza farla aspettare: si
            // attende che arrivi. Letta subito, in CI una volta non c'era
            // ancora (PR #815).
            let row: any = null;
            for (let i = 0; i < 40 && !row; i++) {
                const r = await db.query(
                    `SELECT model, prompt_tokens, output_tokens FROM ai_token_usage WHERE feature = 'support_assistant' ORDER BY id DESC LIMIT 1`
                );
                row = r.rows[0] ?? null;
                if (!row) await new Promise(res => setTimeout(res, 50));
            }
            expect(row).toEqual({ model: 'claude-haiku-4-5', prompt_tokens: 100 + 3000, output_tokens: 20 });
        });

        it('quando serve una persona lo dice, e il segnale non arriva al ristoratore', async () => {
            reply = { content: [{ type: 'text', text: 'Sembra un guasto della stampante: apri una richiesta al team.\n[[RICHIESTA]]' }] };
            const res = await api().post('/support/assistant').set(bearer(owner)).send({
                messages: [
                    { role: 'user', content: 'La comanda non esce' },
                    { role: 'assistant', content: 'Controlla che la stampante sia accesa.' },
                    { role: 'user', content: 'È accesa ma non stampa' },
                ],
            });
            expect(res.status).toBe(200);
            expect(res.body.suggest_ticket).toBe(true);
            expect(res.body.answer).toBe('Sembra un guasto della stampante: apri una richiesta al team.');
            expect(received[received.length - 1].messages).toHaveLength(3);
        });

        it('un rifiuto del modello diventa un invito ad aprire una richiesta', async () => {
            reply = { content: [], stop_reason: 'refusal' };
            const res = await api().post('/support/assistant').set(bearer(owner)).send(question('domanda'));
            expect(res.status).toBe(200);
            expect(res.body.suggest_ticket).toBe(true);
            expect(res.body.answer).toMatch(/apri una richiesta/i);
            reply = {};
        });
    });
});
