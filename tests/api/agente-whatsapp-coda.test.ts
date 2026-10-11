import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubText, type AiStub } from './aiStub';

// WhatsApp, Fase 6: l'agente che parte da solo (services/whatsapp/agent/queue.ts).
//
// Un messaggio in arrivo mette la conversazione in coda; lo scheduler la
// prende quando l'attesa è finita (nei test 300 ms, giro ogni 250 ms: vedi
// globalSetup) e, prima di chiamare il modello, fa i controlli che costano
// zero. In modalità Bozze la risposta resta pronta in Messaggi; in modalità
// Risposte parte da sola — qui, senza un mittente WhatsApp, scende a bozza.
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/agente-whatsapp-coda.test.ts

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const N = {
    raffica: '3391188201',
    grazie: '3391188202',
    bot: '3391188203',
    staff: '3391188204',
    pausa: '3391188205',
    risposta: '3391188206',
};

describe.runIf(AI_STUB_PORT > 0)('agente WhatsApp: la coda automatica', () => {
    let stub: AiStub;
    let db: Client;
    let token = '';
    let sid = 0;

    const inbound = (numero: string, body: string) => {
        const params: Record<string, string> = {
            From: `whatsapp:+39${numero}`, To: NOSTRO, Body: body, NumMedia: '0',
            MessageSid: `SMcoda${Date.now()}${sid++}`,
        };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    /** L'ultimo giro della conversazione, appena finito. */
    const giroFinito = async (numero: string, ms = 8000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const r = await db.query(
                `SELECT * FROM agent_runs WHERE tenant_id = 1 AND phone_digits = $1 AND NOT simulated ORDER BY id DESC LIMIT 1`,
                [numero]
            );
            const run = r.rows[0];
            if (run && !['pending', 'running'].includes(run.status)) return run;
            if (Date.now() > deadline) throw new Error(`giro non finito per ${numero}: ${JSON.stringify(run)}`);
            await new Promise(res => setTimeout(res, 150));
        }
    };
    const politica = (agent: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send({ agent });

    beforeAll(async () => {
        stub = await startAiStub();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Coda test', 'Siamo aperti a cena')`);
    });

    afterAll(async () => {
        await politica({ mode: 'off' });
        await stub.close();
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        const numeri = Object.values(N);
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND (from_phone_digits = ANY($1) OR to_phone_digits = ANY($1))`,
            [numeri.map(n => `39${n}`)]);
        await db.query(`DELETE FROM agent_runs WHERE tenant_id = 1 AND phone_digits = ANY($1)`, [numeri]);
        await db.query(`DELETE FROM agent_conversation_state WHERE tenant_id = 1 AND phone_digits = ANY($1)`, [numeri]);
        await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Coda test'`);
        await db.query(`DELETE FROM ai_token_usage WHERE feature IN ('whatsapp_agent', 'whatsapp_agent_auto')`);
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
        await db.end();
    });

    it('le impostazioni: spento di serie, valori fuori dai limiti rifiutati', async () => {
        const g = await api().get('/whatsapp/settings').set(bearer(token));
        expect(g.status).toBe(200);
        expect(g.body.agent.mode).toBe('off');
        expect((await politica({ mode: 'sempre' })).status).toBe(400);
        expect((await politica({ daily_budget_eur: 1000 })).status).toBe(400);
        const ok = await politica({ mode: 'draft' });
        expect(ok.status).toBe(200);
        expect(ok.body.agent).toMatchObject({ mode: 'draft', debounce_seconds: 20 });
    });

    it('tre messaggi di fila: un giro solo, e la bozza pronta in Messaggi', async () => {
        stub.load(stubText('Ciao! Per quante persone e a che ora?'));
        await inbound(N.raffica, 'Buongiorno');
        await inbound(N.raffica, 'vorrei prenotare');
        await inbound(N.raffica, 'per domani sera');
        const run = await giroFinito(N.raffica);
        expect(run).toMatchObject({ status: 'done', outcome: 'drafted', inbound_count: 3, draft_state: 'new' });
        expect(stub.received).toHaveLength(1);
        const st = await api().get(`/whatsapp/agent/thread/${N.raffica}`).set(bearer(token));
        expect(st.body.mode).toBe('draft');
        expect(st.body.draft.text).toBe('Ciao! Per quante persone e a che ora?');
        const usata = await api().post(`/whatsapp/agent/runs/${st.body.draft.run_id}/draft`).set(bearer(token)).send({ state: 'used' });
        expect(usata.status).toBe(200);
        expect((await api().get(`/whatsapp/agent/thread/${N.raffica}`).set(bearer(token))).body.draft).toBeNull();
        const spesa = await db.query(`SELECT count(*)::int AS n FROM ai_token_usage WHERE tenant_id = 1 AND feature = 'whatsapp_agent_auto'`);
        expect(spesa.rows[0].n).toBeGreaterThan(0);
    });

    it('«Grazie 👍»: nessuna chiamata al modello', async () => {
        stub.load();
        await inbound(N.grazie, 'Grazie 👍');
        const run = await giroFinito(N.grazie);
        expect(run).toMatchObject({ status: 'skipped', skip_reason: 'non serve una risposta' });
        expect(stub.received).toHaveLength(0);
    });

    it('un risponditore automatico mette in pausa la conversazione', async () => {
        stub.load();
        await inbound(N.bot, 'Grazie per aver contattato GELATO LAB. Facci sapere come possiamo aiutarti!');
        const run = await giroFinito(N.bot);
        expect(run.skip_reason).toBe('risponditore automatico');
        expect(stub.received).toHaveLength(0);
        const st = await api().get(`/whatsapp/agent/thread/${N.bot}`).set(bearer(token));
        expect(st.body).toMatchObject({ paused: true, pause_reason: 'bot_suspected' });
    });

    it('lo staff ha appena scritto: l\'agente non si intromette', async () => {
        stub.load();
        await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status)
             VALUES (1, 'twilio', 'whatsapp', 'outbound', $1, $2, 'Ciao, ti rispondo io', 'delivered')`,
            [`+39${N.staff}`, `39${N.staff}`]
        );
        await inbound(N.staff, 'Perfetto, siamo in 3');
        const run = await giroFinito(N.staff);
        expect(run.skip_reason).toBe('lo staff sta già scrivendo');
        expect(stub.received).toHaveLength(0);
    });

    it('pausa decisa dallo staff, poi riattivata', async () => {
        const p = await api().post(`/whatsapp/agent/thread/${N.pausa}/pause`).set(bearer(token)).send({ for: '1h' });
        expect(p.status).toBe(200);
        stub.load();
        await inbound(N.pausa, 'Avete posto stasera?');
        expect((await giroFinito(N.pausa)).skip_reason).toBe('conversazione in pausa (manual)');
        await api().post(`/whatsapp/agent/thread/${N.pausa}/pause`).set(bearer(token)).send({ for: 'resume' });
        const st = await api().get(`/whatsapp/agent/thread/${N.pausa}`).set(bearer(token));
        expect(st.body.paused).toBe(false);
    });

    it('Risposte senza un mittente WhatsApp: la risposta resta in bozza', async () => {
        expect((await politica({ mode: 'reply' })).status).toBe(200);
        stub.load(stubText('Sì, abbiamo posto alle 20:30.'));
        await inbound(N.risposta, 'Avete posto stasera per 2?');
        const run = await giroFinito(N.risposta);
        expect(run).toMatchObject({ status: 'done', outcome: 'drafted', skip_reason: 'WhatsApp non collegato: solo bozza' });
        expect(run.draft_text).toBe('Sì, abbiamo posto alle 20:30.');
    });

    it('il simulatore: risponde senza inviare, ricorda la conversazione, blocca le conferme fantasma', async () => {
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
        stub.load(stubText('Sì, stasera siamo aperti dalle 19:30.'));
        const a = await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ text: 'Siete aperti stasera?', mode: 'reply' });
        expect(a.status).toBe(200);
        expect(a.body).toMatchObject({ outcome: 'would_reply', reply: 'Sì, stasera siamo aperti dalle 19:30.' });

        stub.load(stubText('Ho annullato la tua prenotazione.'));
        const b = await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ text: 'Annulla quella di domani', mode: 'reply' });
        // La storia del secondo giro contiene la risposta del primo.
        expect(JSON.stringify(stub.received[0].body.messages)).toContain('siamo aperti dalle 19:30');
        // «Ho annullato» senza un annullo eseguito: diventa bozza.
        expect(b.body).toMatchObject({ outcome: 'drafted', note: 'la risposta dava per fatta una modifica non eseguita' });

        const reset = await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
        expect(reset.status).toBe(200);
        const rimasti = await db.query(`SELECT count(*)::int AS n FROM outbound_messages WHERE tenant_id = 1 AND provider = 'simulator'`);
        expect(rimasti.rows[0].n).toBe(0);
    });
});
