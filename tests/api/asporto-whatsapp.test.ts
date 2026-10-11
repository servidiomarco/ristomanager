import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubCalls, stubText, type AiStub } from './aiStub';

// WhatsApp, Fase 10: l'asporto in chat (services/whatsapp/agent/tools/
// takeaway.ts, services/takeaway.ts) e l'avviso «il tuo ordine è pronto»
// (services/whatsapp/takeawayReady.ts).
//
// Risponde al cliente, quindi gira nel passo col mittente finto
// (TWILIO_WHATSAPP_FROM) e con lo stub di Anthropic; Twilio è lo stub di
// questo file sulla porta del server + 12. Data fissa futura, diversa da
// quella di takeaway.test.ts, così la capienza parte da zero.

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const REST_PORT = Number(process.env.TEST_API_PORT || 3199) + 12;
const DATA = '2027-05-19';
const N = {
    ordine: '3391188601',
    ignoto: '3391188602',
    proposta: '3391188603',
};

describe.runIf(AI_STUB_PORT > 0 && !!process.env.TWILIO_WHATSAPP_FROM)('WhatsApp: asporto in chat', () => {
    let stub: AiStub;
    let twilio: http.Server;
    const inviati: Array<Record<string, string>> = [];
    let db: Client;
    let token = '';
    let sid = 0;

    const inbound = (numero: string, body: string) => {
        const params: Record<string, string> = {
            From: `whatsapp:+39${numero}`, To: NOSTRO, Body: body, NumMedia: '0', MessageSid: `SMasporto${Date.now()}${sid++}`,
        };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const ultimoGiro = async (numero: string) =>
        (await db.query(`SELECT COALESCE(max(id), 0)::int AS id FROM agent_runs WHERE tenant_id = 1 AND phone_digits = $1 AND NOT simulated`, [numero])).rows[0].id;
    const scrive = async (numero: string, testo: string) => {
        const prima = await ultimoGiro(numero);
        await inbound(numero, testo);
        const deadline = Date.now() + 8000;
        for (;;) {
            const run = (await db.query(
                `SELECT * FROM agent_runs WHERE tenant_id = 1 AND phone_digits = $1 AND NOT simulated AND id > $2 ORDER BY id DESC LIMIT 1`,
                [numero, prima]
            )).rows[0];
            if (run && !['pending', 'running'].includes(run.status)) return run;
            if (Date.now() > deadline) throw new Error(`giro non finito: ${JSON.stringify(run)}`);
            await new Promise(res => setTimeout(res, 150));
        }
    };
    const impostazioni = (body: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send(body);
    const ordiniDi = async (numero: string) =>
        (await db.query(`SELECT * FROM takeaway_orders WHERE tenant_id = 1 AND customer_phone LIKE $1 ORDER BY id`, [`%${numero}`])).rows;

    beforeAll(async () => {
        twilio = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                inviati.push(Object.fromEntries(new URLSearchParams(body)));
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: `SMstubasporto${inviati.length}${Date.now()}`, status: 'queued' }));
            });
        });
        await new Promise<void>(resolve => twilio.listen(REST_PORT, '127.0.0.1', () => resolve()));
        stub = await startAiStub();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true, takeaway: true });
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Asporto chat', 'Facciamo asporto a cena')`);
        const menus = await api().get('/menus').set(bearer(token));
        const allaCarta = menus.body.find((m: any) => m.system_key === 'ALLA_CARTA');
        for (const [name, price] of [['Amatriciana Chat', 12], ['Tagliata Chat', 18]] as const) {
            const d = await api().post('/dishes').set(bearer(token)).send({ name, price, category: 'Chat Asporto', menu_ids: [allaCarta.id] });
            expect(d.status).toBe(201);
        }
    });

    afterAll(async () => {
        await impostazioni({ takeaway: { enabled: false, notify_ready: false }, agent: { mode: 'off' } });
        await stub.close();
        await new Promise<void>(resolve => twilio.close(() => resolve()));
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Asporto chat'`);
        await db.end();
    });

    it('spento di serie: l\'agente non ha gli strumenti dell\'asporto', async () => {
        const g = await api().get('/whatsapp/settings').set(bearer(token));
        expect(g.body).toMatchObject({ takeaway: { enabled: false, notify_ready: false }, takeaway_available: true });
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
        stub.load(stubText('Ciao!'));
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ text: 'Fate asporto?', mode: 'reply' });
        const nomi = stub.received[0].body.tools.map((t: any) => t.name);
        expect(nomi).not.toContain('create_takeaway_order');
    });

    it('in «Azioni» prende l\'ordine: menu, orari, ordine sulla board col numero del giorno', async () => {
        await impostazioni({ takeaway: { enabled: true, notify_ready: true }, agent: { mode: 'actions' } });
        stub.load(
            stubCalls(['m1', 'get_takeaway_menu', {}], ['s1', 'check_takeaway_slots', { date: DATA }]),
            stubCalls(['o1', 'create_takeaway_order', {
                customer_name: 'Rossi Chat', date: DATA, time: '20:30',
                items: [{ name: 'amatriciana chat', qty: 2 }, { name: 'Tagliata Chat', note: 'al sangue' }],
            }]),
            stubText('Fatto! Ordine numero 1: ritiro alle 20:30, totale 42 €.'),
        );
        const run = await scrive(N.ordine, `Confermo: 2 amatriciane e una tagliata al sangue, ritiro il ${DATA} alle 20:30, Rossi`);
        expect(run).toMatchObject({ status: 'done', outcome: 'replied' });
        expect(stub.received[0].body.tools.map((t: any) => t.name)).toContain('create_takeaway_order');
        expect(JSON.stringify(stub.toolResult('m1'))).toContain('Amatriciana Chat (12,00 €)');
        expect(stub.toolResult('s1').dinner_slots).toContain('20:30');
        expect(stub.toolResult('o1')).toMatchObject({ success: true, executed: true, total: '42,00 €' });

        const [ordine] = await ordiniDi(N.ordine);
        expect(ordine).toMatchObject({ channel: 'WHATSAPP', status: 'CONFIRMED', pickup_time: '20:30', customer_name: 'Rossi Chat' });
        const righe = (await db.query(`SELECT name_snapshot, qty, note FROM takeaway_order_items WHERE takeaway_order_id = $1 ORDER BY id`, [ordine.id])).rows;
        expect(righe).toEqual([
            { name_snapshot: 'Amatriciana Chat', qty: 2, note: null },
            { name_snapshot: 'Tagliata Chat', qty: 1, note: 'al sangue' },
        ]);
        const azione = (await db.query(`SELECT * FROM agent_proposals WHERE tenant_id = 1 AND auto AND run_id = $1`, [run.id])).rows[0];
        expect(azione.tool).toBe('create_takeaway_order');
    });

    it('«pronto» dalla board: il cliente riceve un WhatsApp, una volta sola', async () => {
        const [ordine] = await ordiniDi(N.ordine);
        const dal = inviati.length;
        expect((await api().post(`/takeaway/orders/${ordine.id}/status`).set(bearer(token)).send({ status: 'READY' })).status).toBe(200);
        const deadline = Date.now() + 3000;
        while (inviati.length === dal && Date.now() < deadline) await new Promise(res => setTimeout(res, 100));
        const msg = inviati.slice(dal).find(m => m.To === `whatsapp:+39${N.ordine}`);
        expect(msg?.Body).toMatch(/^Ciao Rossi Chat! Il tuo ordine #\d+ è pronto: ti aspettiamo da /);

        await api().post(`/takeaway/orders/${ordine.id}/status`).set(bearer(token)).send({ status: 'IN_PREPARATION' });
        const dopo = inviati.length;
        await api().post(`/takeaway/orders/${ordine.id}/status`).set(bearer(token)).send({ status: 'READY' });
        await new Promise(res => setTimeout(res, 500));
        expect(inviati.slice(dopo).filter(m => m.To === `whatsapp:+39${N.ordine}`)).toHaveLength(0);
    });

    it('un piatto che non c\'è: niente ordine, il modello lo dice al cliente', async () => {
        stub.load(
            stubCalls(['x1', 'create_takeaway_order', { customer_name: 'Bianchi Chat', date: DATA, time: '21:00', items: [{ name: 'pizza marziana' }] }]),
            stubText('Mi spiace, la pizza marziana non è nel menu.'),
        );
        await scrive(N.ignoto, 'Una pizza marziana per le 21');
        expect(stub.toolResult('x1')).toMatchObject({ status: 'refused', executed: false });
        expect(stub.toolResult('x1').message).toContain('non è nel menu');
        expect(await ordiniDi(N.ignoto)).toHaveLength(0);
    });

    it('in «Risposte» lo propone; confermato dallo staff, il cliente riceve il riepilogo', async () => {
        await impostazioni({ agent: { mode: 'reply' } });
        stub.load(
            stubCalls(['p1', 'create_takeaway_order', { customer_name: 'Verdi Chat', date: DATA, time: '21:00', items: [{ name: 'Tagliata Chat' }] }]),
            stubText('Registrato: il locale ti conferma a breve.'),
        );
        await scrive(N.proposta, 'Una tagliata per le 21, Verdi');
        expect(stub.toolResult('p1')).toMatchObject({ status: 'pending_staff' });
        expect(await ordiniDi(N.proposta)).toHaveLength(0);
        const proposta = (await db.query(
            `SELECT id FROM agent_proposals WHERE tenant_id = 1 AND phone_digits = $1 AND status = 'PENDING'`, [N.proposta]
        )).rows[0];
        const dal = inviati.length;
        const ok = await api().post(`/messages/agent/proposals/${proposta.id}/confirm`).set(bearer(token));
        expect(ok.body).toMatchObject({ ok: true, followup_sent: true });
        const [ordine] = await ordiniDi(N.proposta);
        expect(ordine).toMatchObject({ channel: 'WHATSAPP', pickup_time: '21:00', customer_phone: `+39${N.proposta}` });
        expect(inviati.slice(dal).find(m => m.To === `whatsapp:+39${N.proposta}`)?.Body).toMatch(/^Fatto! 1× Tagliata Chat, da ritirare .+ alle 21:00\. Totale 18,00 €\./);
    });
});
