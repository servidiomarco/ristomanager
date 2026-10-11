import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubCalls, stubText, type AiStub } from './aiStub';

// WhatsApp, Fase 7: in modalità «Azioni» l'agente prenota, sposta e annulla
// da solo dove l'idoneità passa (services/whatsapp/agent/autonomy.ts), e
// ogni azione ha il suo «Annulla».
//
// Un'azione da sola si fa solo se la risposta può partire: serve un mittente
// WhatsApp. Il tenant 1 lo ha quando TWILIO_WHATSAPP_FROM è impostata, e le
// API di Twilio vanno allo stub che questo file accende sulla porta del
// server + 12 (TWILIO_REST_URL in globalSetup). Per questo il file gira in un
// passo a parte del job con lo stub AI, e non nella suite principale, dove
// il tenant 1 deve restare senza mittente:
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   TWILIO_WHATSAPP_FROM=+393895916494 npx vitest run tests/api/agente-whatsapp-azioni.test.ts

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const REST_PORT = Number(process.env.TEST_API_PORT || 3199) + 12;
const N = {
    annullo: '3391188301',
    modifica: '3391188302',
    caparra: '3391188303',
    crea: '3391188304',
    spento: '3391188305',
};

/** 'YYYY-MM-DD' fra `days` giorni, nel fuso del locale. */
const giornoFra = (days: number): string => {
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const [y, m, d] = oggi.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

describe.runIf(AI_STUB_PORT > 0 && !!process.env.TWILIO_WHATSAPP_FROM)('agente WhatsApp: le azioni da sole', () => {
    let stub: AiStub;
    let twilio: http.Server;
    const inviati: Array<Record<string, string>> = [];
    let db: Client;
    let token = '';
    let sid = 0;
    let roomId = 0;
    const tavoli: number[] = [];

    const inbound = (numero: string, body: string) => {
        const params: Record<string, string> = {
            From: `whatsapp:+39${numero}`, To: NOSTRO, Body: body, NumMedia: '0',
            MessageSid: `SMazioni${Date.now()}${sid++}`,
        };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const ultimoGiro = async (numero: string): Promise<number> => {
        const r = await db.query(`SELECT COALESCE(max(id), 0)::int AS id FROM agent_runs WHERE tenant_id = 1 AND phone_digits = $1 AND NOT simulated`, [numero]);
        return r.rows[0].id;
    };
    /** Il primo giro dopo `dopo`, appena finito. */
    const giroDopo = async (numero: string, dopo: number, ms = 8000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const r = await db.query(
                `SELECT * FROM agent_runs WHERE tenant_id = 1 AND phone_digits = $1 AND NOT simulated AND id > $2 ORDER BY id DESC LIMIT 1`,
                [numero, dopo]
            );
            const run = r.rows[0];
            if (run && !['pending', 'running'].includes(run.status)) return run;
            if (Date.now() > deadline) throw new Error(`giro non finito per ${numero}: ${JSON.stringify(run)}`);
            await new Promise(res => setTimeout(res, 150));
        }
    };
    const scrive = async (numero: string, testo: string) => {
        const prima = await ultimoGiro(numero);
        await inbound(numero, testo);
        return giroDopo(numero, prima);
    };
    const prenotazione = async (id: number) =>
        (await db.query(`SELECT * FROM reservations WHERE id = $1`, [id])).rows[0];
    const orarioDi = async (date: string): Promise<string> => {
        const slots = await api().get('/public/availability').query({ date });
        const t = slots.body.dinner.slots[0];
        expect(t).toBeTruthy();
        return t;
    };
    /** Una prenotazione confermata in agenda per il numero, scritta a mano. */
    const inAgenda = async (numero: string, date: string, time: string, extra: { table_id?: number | null; payment_status?: string; deposit_amount?: number } = {}) => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, children, phone,
                                       reservation_status, arrival_status, source, table_id, payment_status, deposit_amount)
             VALUES (1, $1, ($2::date + $3::time) AT TIME ZONE 'Europe/Rome', 'DINNER', 2, 0, $4,
                     'CONFIRMED', 'WAITING', 'MANUAL', $5, $6, $7)
             RETURNING id`,
            [`Cliente ${numero}`, date, time, `+39${numero}`, extra.table_id ?? null, extra.payment_status ?? 'PENDING', extra.deposit_amount ?? null]
        );
        return Number(r.rows[0].id);
    };
    const politica = (agent: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send({ agent });

    beforeAll(async () => {
        twilio = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const form = Object.fromEntries(new URLSearchParams(body));
                inviati.push(form);
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: `SMstub${inviati.length}${Date.now()}`, status: 'queued' }));
            });
        });
        await new Promise<void>(resolve => twilio.listen(REST_PORT, '127.0.0.1', () => resolve()));
        stub = await startAiStub();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Azioni test', 'Siamo aperti a cena')`);
        // Il database dei test nasce senza sala: senza tavoli non c'è posto
        // e nessuna azione passerebbe l'idoneità.
        roomId = (await db.query(`INSERT INTO rooms (tenant_id, name, width, height, location) VALUES (1, 'Sala Azioni', 800, 600, 'INDOOR') RETURNING id`)).rows[0].id;
        for (const nome of ['A1', 'A2', 'A3']) {
            const t = await db.query(
                `INSERT INTO tables (tenant_id, room_id, name, shape, seats, x, y, status)
                 VALUES (1, $1, $2, 'SQUARE', 4, 100, 100, 'FREE') RETURNING id`, [roomId, nome]);
            tavoli.push(Number(t.rows[0].id));
        }
    });

    afterAll(async () => {
        await politica({ mode: 'off' });
        await stub.close();
        await new Promise<void>(resolve => twilio.close(() => resolve()));
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        await db.end();
    });

    it('la modalità «Azioni»: di serie fa tutto, chiede conferma prima di annullare', async () => {
        expect((await politica({ auto_actions: { cancel: 'sì' } })).status).toBe(400);
        const r = await politica({ mode: 'actions' });
        expect(r.status).toBe(200);
        expect(r.body.agent).toMatchObject({
            mode: 'actions',
            auto_actions: { create: true, modify: true, cancel: true, notes: true },
            confirm_cancel: true,
        });
    });

    it('annullo in due tempi: «confermi?», poi al sì annulla; «Annulla» la rimette col suo tavolo', async () => {
        const data = giornoFra(12);
        const ora = await orarioDi(data);
        const tavolo = tavoli[0];
        const id = await inAgenda(N.annullo, data, ora, { table_id: tavolo });

        stub.load(
            stubCalls(['c1', 'cancel_reservation', { reservation_id: id, date: data }]),
            stubText(`Confermi che annullo la prenotazione del ${data} alle ${ora}?`),
        );
        const domanda = await scrive(N.annullo, 'Devo annullare la prenotazione, scusate');
        expect(domanda).toMatchObject({ status: 'done', outcome: 'replied' });
        expect(stub.toolResult('c1')).toMatchObject({ status: 'confirm_with_customer', executed: false });
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');
        expect(inviati.some(m => m.Body?.startsWith('Confermi che annullo'))).toBe(true);

        stub.load(
            stubCalls(['c2', 'cancel_reservation', { reservation_id: id, date: data }]),
            stubText('Fatto, la prenotazione è annullata. A presto!'),
        );
        const fatto = await scrive(N.annullo, 'Sì');
        expect(fatto).toMatchObject({ status: 'done', outcome: 'replied' });
        expect(stub.toolResult('c2')).toMatchObject({ success: true, executed: true });
        const annullata = await prenotazione(id);
        expect(annullata).toMatchObject({ reservation_status: 'CANCELLED', table_id: null });
        expect(annullata.guest_cancelled_at).not.toBeNull();

        const azione = (await db.query(`SELECT * FROM agent_proposals WHERE tenant_id = 1 AND auto AND run_id = $1`, [fatto.id])).rows[0];
        expect(azione).toMatchObject({ tool: 'cancel_reservation', status: 'DONE', reservation_id: id });
        expect(azione.before_state).toMatchObject({ reservation_status: 'CONFIRMED', table_id: tavolo });
        const st = await api().get(`/whatsapp/agent/thread/${N.annullo}`).set(bearer(token));
        expect(st.body.actions[0]).toMatchObject({ id: azione.id, tool: 'cancel_reservation', undoable: true });

        const undo = await api().post(`/whatsapp/agent/actions/${azione.id}/undo`).set(bearer(token));
        expect(undo.status).toBe(200);
        const tornata = await prenotazione(id);
        expect(tornata).toMatchObject({ reservation_status: 'CONFIRMED', table_id: tavolo, guest_cancelled_at: null });
        const ancora = await api().post(`/whatsapp/agent/actions/${azione.id}/undo`).set(bearer(token));
        expect(ancora.status).toBe(409);
        expect(ancora.body.error).toBe('already_undone');
    });

    it('«siamo in 3»: modifica da sola; se poi lo staff la tocca, «Annulla» non la sovrascrive', async () => {
        const data = giornoFra(13);
        const ora = await orarioDi(data);
        const id = await inAgenda(N.modifica, data, ora);
        stub.load(
            stubCalls(['m1', 'modify_reservation', { reservation_id: id, date: data, new_guests: 3 }]),
            stubText('Fatto, ora siete in 3.'),
        );
        const run = await scrive(N.modifica, 'Siamo in 3 invece di 2');
        expect(run).toMatchObject({ status: 'done', outcome: 'replied' });
        expect(stub.toolResult('m1')).toMatchObject({ success: true, executed: true });
        expect(Number((await prenotazione(id)).guests)).toBe(3);
        const azione = (await db.query(`SELECT * FROM agent_proposals WHERE tenant_id = 1 AND auto AND run_id = $1`, [run.id])).rows[0];
        expect(azione.before_state.guests).toBe(2);
        expect(azione.after_state.guests).toBe(3);

        await db.query(`UPDATE reservations SET guests = 4 WHERE id = $1`, [id]);
        const undo = await api().post(`/whatsapp/agent/actions/${azione.id}/undo`).set(bearer(token));
        expect(undo.status).toBe(409);
        expect(undo.body.error).toBe('changed');
        expect(Number((await prenotazione(id)).guests)).toBe(4);
    });

    it('con una caparra pagata non annulla da solo: lo propone allo staff', async () => {
        const data = giornoFra(14);
        const ora = await orarioDi(data);
        const id = await inAgenda(N.caparra, data, ora, { payment_status: 'PAID_DEPOSIT', deposit_amount: 20 });
        stub.load(
            stubCalls(['p1', 'cancel_reservation', { reservation_id: id, date: data }]),
            stubText('Passo la richiesta al ristorante, ti confermiamo a breve.'),
        );
        const run = await scrive(N.caparra, 'Annullate la mia prenotazione');
        expect(run.status).toBe('done');
        expect(stub.toolResult('p1')).toMatchObject({ status: 'pending_staff', executed: false });
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');
        const proposta = (await db.query(
            `SELECT * FROM agent_proposals WHERE tenant_id = 1 AND phone_digits = $1 AND status = 'PENDING'`, [N.caparra]
        )).rows[0];
        expect(proposta).toMatchObject({ tool: 'cancel_reservation', auto: false });
    });

    it('prenota da solo come Sofia, e «Annulla» la toglie', async () => {
        const data = giornoFra(15);
        const ora = await orarioDi(data);
        const prima = inviati.length;
        stub.load(
            stubCalls(['k1', 'create_reservation', { customer_name: 'Bianchi Azioni', date: data, time: ora, shift: 'DINNER', guests: 2 }]),
            stubText('Fatto! Ti aspettiamo.'),
        );
        const run = await scrive(N.crea, `Sì, confermo: 2 persone il ${data} alle ${ora}, a nome Bianchi Azioni`);
        expect(run).toMatchObject({ status: 'done', outcome: 'replied' });
        expect(stub.toolResult('k1')).toMatchObject({ success: true, executed: true });
        expect(inviati.slice(prima).some(m => m.Body?.startsWith('Fatto! Ti aspettiamo.'))).toBe(true);
        const nuova = (await db.query(
            `SELECT * FROM reservations WHERE tenant_id = 1 AND phone LIKE $1 AND customer_name ILIKE 'Bianchi Azioni'`, [`%${N.crea}`]
        )).rows[0];
        expect(nuova).toMatchObject({ source: 'WHATSAPP', reservation_status: 'CONFIRMED' });

        const azione = (await db.query(`SELECT * FROM agent_proposals WHERE tenant_id = 1 AND auto AND run_id = $1`, [run.id])).rows[0];
        expect(azione).toMatchObject({ tool: 'create_reservation', reservation_id: nuova.id });
        expect(azione.before_state).toBeNull();
        const undo = await api().post(`/whatsapp/agent/actions/${azione.id}/undo`).set(bearer(token));
        expect(undo.status).toBe(200);
        expect((await prenotazione(nuova.id)).reservation_status).toBe('CANCELLED');
    });

    it('un\'azione spenta nelle Impostazioni torna proposta', async () => {
        expect((await politica({ auto_actions: { create: false } })).status).toBe(200);
        const data = giornoFra(16);
        const ora = await orarioDi(data);
        stub.load(
            stubCalls(['s1', 'create_reservation', { customer_name: 'Verdi Spento', date: data, time: ora, shift: 'DINNER', guests: 2 }]),
            stubText('Registrato: il ristorante ti conferma a breve.'),
        );
        await scrive(N.spento, `Confermo, 2 persone il ${data} alle ${ora}, Verdi Spento`);
        expect(stub.toolResult('s1')).toMatchObject({ status: 'pending_staff', executed: false });
        const nessuna = await db.query(`SELECT 1 FROM reservations WHERE tenant_id = 1 AND phone LIKE $1`, [`%${N.spento}`]);
        expect(nessuna.rowCount).toBe(0);
        await politica({ auto_actions: { create: true } });
    });

    it('il simulatore in «Azioni» dice cosa farebbe, senza prenotare niente', async () => {
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
        const data = giornoFra(17);
        const ora = await orarioDi(data);
        stub.load(
            stubCalls(['z1', 'create_reservation', { customer_name: 'Prova Simulatore', date: data, time: ora, shift: 'DINNER', guests: 2 }]),
            stubText('Fatto! Ti aspettiamo.'),
        );
        const r = await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ text: 'Prenota per 2, Prova Simulatore', mode: 'actions' });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ outcome: 'would_reply', reply: 'Fatto! Ti aspettiamo.' });
        expect(r.body.actions[0].summary).toContain('Prova Simulatore');
        expect(stub.toolResult('z1')).toMatchObject({ executed: true, simulated: true });
        const nessuna = await db.query(`SELECT 1 FROM reservations WHERE tenant_id = 1 AND customer_name ILIKE 'Prova Simulatore'`);
        expect(nessuna.rowCount).toBe(0);
        await api().post('/whatsapp/agent/simulate').set(bearer(token)).send({ reset: true });
    });
});
