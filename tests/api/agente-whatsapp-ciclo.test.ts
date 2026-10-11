import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { AI_STUB_PORT, startAiStub, stubCalls as chiama, stubText as testo, type AiStub, type StubReply as Risposta } from './aiStub';

// WhatsApp, Fase 3: il ciclo dell'agente (services/whatsapp/agent/run.ts).
//
// Fino all'11/10/2026 l'agente gestiva solo la PRIMA chiamata a strumento di
// ogni risposta, e per le scritture chiedeva al modello una seconda frase
// d'attesa. Ora ogni chiamata ha il suo esito (eseguita, proposta allo staff
// o rifiutata), tutti gli esiti tornano al modello in un messaggio solo, e la
// frase finale la scrive lui. Senza chiave le rotte rispondono 503: si prova
// con lo stub locale di Anthropic (job «Test API (report AI, stub locale)»):
//   TEST_AI_STUB=1 ANTHROPIC_API_KEY=stub ANTHROPIC_BASE_URL=http://127.0.0.1:47649 \
//   npx vitest run tests/api/agente-whatsapp-ciclo.test.ts

const NUMERO = '3391188001';        // la conversazione principale
const NUMERO_GRAZIE = '3391188002'; // «grazie 👍»
const NUMERO_NOTE = '3391188003';   // modifica confermata dallo staff

/** 'YYYY-MM-DD' fra `days` giorni, nel fuso del locale. */
const giornoFra = (days: number): string => {
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const [y, m, d] = oggi.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const DATA = giornoFra(9);

describe.runIf(AI_STUB_PORT > 0)('agente WhatsApp: il ciclo', () => {
    let stub: AiStub;
    let received: AiStub['received'];
    let db: Client;
    let token = '';
    let orario = '';
    let esistenteId = 0;

    const giro = async (numero: string, ...risposte: Risposta[]) => {
        stub.load(...risposte);
        return api().post('/messages/agent/run').set(bearer(token)).send({ phone_digits: numero });
    };
    const ultimoUtente = (n: number) => stub.lastMessage(n);

    beforeAll(async () => {
        stub = await startAiStub();
        received = stub.received;

        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: true });
        await db.query(`INSERT INTO ai_knowledge_entries (tenant_id, title, content) VALUES (1, 'Ciclo test', 'Siamo aperti a cena')`);

        const slots = await api().get('/public/availability').query({ date: DATA });
        orario = slots.body.dinner.slots[0];
        expect(orario).toBeTruthy();

        // Una prenotazione già in agenda per il numero: l'agente la vede con l'id.
        const creata = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Rossi Ciclo', phone: NUMERO, reservation_time: `${giornoFra(15)}T${orario}:00`,
            shift: 'DINNER', guests: 2, children: 0,
        });
        expect(creata.status).toBe(201);
        esistenteId = creata.body.id;

        const inbound = async (numero: string, testoMsg: string, profilo: string | null) =>
            db.query(
                `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, from_phone, from_phone_digits, body, status, profile_name)
                 VALUES (1, 'twilio', 'whatsapp', 'inbound', $1, $2, $3, 'received', $4)`,
                [`+39${numero}`, `39${numero}`, testoMsg, profilo]
            );
        await inbound(NUMERO, `Vorrei prenotare per 2 il ${DATA} alle ${orario}`, 'Marco Profilo');
        // Un automatismo nascosto dall'inbox: l'agente non deve leggerlo.
        await db.query(
            `INSERT INTO outbound_messages (tenant_id, provider, channel, direction, to_phone, to_phone_digits, body, status, kind)
             VALUES (1, 'twilio', 'whatsapp', 'outbound', $1, $2, 'RECENSIONE-NASCOSTA', 'delivered', 'review_request')`,
            [`+39${NUMERO}`, `39${NUMERO}`]
        );
        await inbound(NUMERO, 'Siamo in 2, a nome Rossi', null);
        await inbound(NUMERO_GRAZIE, 'Grazie 👍', null);
    });

    afterAll(async () => {
        await stub.close();
        await api().put('/settings/features').set(bearer(token)).send({ ai_messages_enabled: false });
        const numeri = [NUMERO, NUMERO_GRAZIE, NUMERO_NOTE];
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND (from_phone_digits = ANY($1) OR to_phone_digits = ANY($1))`,
            [numeri.map(n => `39${n}`)]);
        await db.query(`DELETE FROM agent_proposals WHERE tenant_id = 1 AND phone_digits = ANY($1)`, [numeri]);
        await db.query(`DELETE FROM reservations WHERE tenant_id = 1 AND right(regexp_replace(phone, '\\D', '', 'g'), 10) = ANY($1)`, [numeri]);
        await db.query(`DELETE FROM ai_knowledge_entries WHERE tenant_id = 1 AND title = 'Ciclo test'`);
        await db.query(`DELETE FROM ai_token_usage WHERE feature = 'whatsapp_agent'`);
        await db.end();
    });

    it('due letture nello stesso turno, poi una proposta: esiti veri e frase finale del modello', async () => {
        const res = await giro(NUMERO,
            chiama(
                ['t1', 'check_availability', { date: DATA, shift: 'DINNER', guests: 2, time: orario }],
                ['t2', 'check_availability', { date: DATA, shift: 'DINNER', guests: 2, location_preference: 'OUTDOOR' }],
            ),
            chiama(['t3', 'create_reservation', { customer_name: 'Mario Rossi', date: DATA, time: orario, shift: 'DINNER', guests: 2, phone: '+390000000000' }]),
            testo('Verifico e ti confermo a breve.'),
        );
        expect(res.status).toBe(200);
        expect(res.body.reply).toBe('Verifico e ti confermo a breve.');
        expect(res.body.proposal.tool).toBe('create_reservation');
        // Il telefono è quello della conversazione, non quello del modello.
        expect(res.body.proposal.args.phone).toBe(`+39${NUMERO}`);
        expect(res.body.checks).toHaveLength(2);

        // Tre richieste: la seconda porta i due esiti in UN messaggio.
        expect(received).toHaveLength(3);
        const esiti = ultimoUtente(1);
        expect(esiti.role).toBe('user');
        expect(esiti.content.map((b: any) => b.tool_use_id)).toEqual(['t1', 't2']);
        expect(JSON.parse(esiti.content[0].content).executed).toBe(true);
        const proposta = JSON.parse(ultimoUtente(2).content[0].content);
        expect(proposta).toMatchObject({ status: 'pending_staff', executed: false });

        // Il prompt: nome del locale, nome del profilo, prenotazione con l'id;
        // niente automatismi nascosti nella storia.
        const contatto = await api().get('/public/contact');
        const system: string = received[0].body.system;
        expect(system).toContain(`"${contatto.body.branding.name}"`);
        expect(system).toContain('«Marco Profilo»');
        expect(system).toContain(`id ${esistenteId}`);
        expect(JSON.stringify(received[0].body.messages)).not.toContain('RECENSIONE-NASCOSTA');
        expect(received[0].body.tools.map((t: any) => t.name)).toContain('skip_reply');
        // Ripiego del server sui rifiuti.
        expect(received[0].body.fallbacks).toBe('default');
        expect(String(received[0].headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');

        const usage = await db.query(`SELECT count(*)::int AS n FROM ai_token_usage WHERE tenant_id = 1 AND feature = 'whatsapp_agent'`);
        expect(usage.rows[0].n).toBeGreaterThan(0);

        // Lo staff conferma: la prenotazione nasce da WhatsApp, non dalla voce.
        const conf = await api().post(`/messages/agent/proposals/${res.body.proposal.id}/confirm`).set(bearer(token));
        expect(conf.status).toBe(200);
        expect(conf.body.ok).toBe(true);
        // Nei test non c'è un mittente WhatsApp: niente messaggio al cliente.
        expect(conf.body.followup_sent).toBe(false);
        const r = await db.query(`SELECT source, notes FROM reservations WHERE id = $1`, [conf.body.result.reservation_id]);
        expect(r.rows[0].source).toBe('WHATSAPP');
        expect(r.rows[0].notes).toMatch(/^\[WhatsApp\]/);
    });

    it('«Grazie 👍»: skip_reply chiude il giro senza risposta e senza altre chiamate', async () => {
        const res = await giro(NUMERO_GRAZIE, chiama(['s1', 'skip_reply', { reason: 'ringraziamento' }]));
        expect(res.status).toBe(200);
        expect(res.body.reply).toBeNull();
        expect(res.body.skipped).toBe('ringraziamento');
        expect(res.body.proposal).toBeNull();
        expect(received).toHaveLength(1);
    });

    it('rifiuto del modello: nessuna risposta, il motivo è detto', async () => {
        const res = await giro(NUMERO_GRAZIE, { content: [], stop_reason: 'refusal' });
        expect(res.status).toBe(200);
        expect(res.body.reply).toBeNull();
        expect(res.body.reason).toMatch(/rifiutato/);
    });

    it('strumento sconosciuto e seconda scrittura: esiti d\'errore, una sola proposta', async () => {
        const res = await giro(NUMERO,
            chiama(
                ['u1', 'strumento_inventato', {}],
                ['u2', 'cancel_reservation', { date: giornoFra(15), reservation_id: esistenteId }],
                ['u3', 'modify_reservation', { date: giornoFra(15), new_guests: 3 }],
            ),
            testo('Ti confermo a breve.'),
        );
        expect(res.status).toBe(200);
        expect(res.body.proposal.tool).toBe('cancel_reservation');
        expect(res.body.proposal.args.reservation_id).toBe(esistenteId);
        const esiti = ultimoUtente(1).content;
        expect(esiti).toHaveLength(3);
        expect(esiti[0].is_error).toBe(true);
        expect(JSON.parse(esiti[1].content).status).toBe('pending_staff');
        expect(JSON.parse(esiti[2].content).status).toBe('refused');
    });

    it('modifica confermata dallo staff: le note si aggiungono e la richiesta resta da confermare', async () => {
        const creata = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Note Ciclo', phone: NUMERO_NOTE, reservation_time: `${giornoFra(16)}T${orario}:00`,
            shift: 'DINNER', guests: 2, children: 0, notes: 'Nota dello staff', reservation_status: 'PENDING',
        });
        expect(creata.status).toBe(201);
        const ins = await db.query(
            `INSERT INTO agent_proposals (tenant_id, phone_digits, tool, args, summary)
             VALUES (1, $1, 'modify_reservation', $2::jsonb, 'Aggiunge una nota') RETURNING id`,
            [NUMERO_NOTE, JSON.stringify({ phone: `+39${NUMERO_NOTE}`, date: giornoFra(16), reservation_id: creata.body.id, new_notes: 'Porta il cane' })]
        );
        const conf = await api().post(`/messages/agent/proposals/${ins.rows[0].id}/confirm`).set(bearer(token));
        expect(conf.status).toBe(200);
        expect(conf.body.ok).toBe(true);
        const r = await db.query(`SELECT notes, reservation_status FROM reservations WHERE id = $1`, [creata.body.id]);
        expect(r.rows[0].notes).toBe('Nota dello staff · [WhatsApp] Porta il cane');
        expect(r.rows[0].reservation_status).toBe('PENDING');
    });

    it('una modifica a un orario fuori griglia è rifiutata', async () => {
        const ins = await db.query(
            `INSERT INTO agent_proposals (tenant_id, phone_digits, tool, args, summary)
             VALUES (1, $1, 'modify_reservation', $2::jsonb, 'Sposta alle 20:07') RETURNING id`,
            [NUMERO, JSON.stringify({ phone: `+39${NUMERO}`, date: giornoFra(15), reservation_id: esistenteId, new_time: '20:07' })]
        );
        const conf = await api().post(`/messages/agent/proposals/${ins.rows[0].id}/confirm`).set(bearer(token));
        expect(conf.body.ok).toBe(false);
        expect(conf.body.result.error).toBe('invalid_slot');
    });
});
