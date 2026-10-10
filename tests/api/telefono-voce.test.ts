import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Telefono, Fase 2 (docs/telefono-piano.md): Sympotia davanti al numero.
// Twilio chiama /voice/inbound firmando la richiesta; Sympotia registra la
// chiamata e risponde col TwiML di register-call (qui uno stub locale sulla
// porta del server + 11, vedi globalSetup). Se Sofia non c'è, o resta muta,
// la chiamata finisce in Chiamate › Da ricontattare.
//
// Telefoni e CallSid unici per non collidere con gli altri file.
const AUTH_TOKEN = 'test-twilio-auth-token';
const STUB_PORT = Number(process.env.TEST_API_PORT || 3199) + 11;
const NOSTRO_NUMERO = '+390985010032';
const CLIENTE = '+393478809911';
const SCONOSCIUTO = '+393478809922';
const STUB_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://stub.example/conv"/></Connect></Response>';

const waitFor = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 30): Promise<T> => {
    let last = await read();
    for (let i = 0; i < tries && !ok(last); i++) {
        await new Promise(r => setTimeout(r, 100));
        last = await read();
    }
    return last;
};

describe('telefono: Sympotia davanti al numero', () => {
    let token: string;
    let db: Client;
    let webhookPath: string;
    let stub: http.Server;
    let stubStatus = 200;
    const received: any[] = [];

    // Firma Twilio: HMAC-SHA1 col token, sull'URL completo seguito dai
    // parametri ordinati per chiave (chiave+valore).
    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const inbound = (callSid: string, from: string) =>
        signed(`${webhookPath}/voice/inbound`, { CallSid: callSid, From: from, To: NOSTRO_NUMERO, Direction: 'inbound' });
    const status = (callSid: string, duration: number) =>
        signed(`${webhookPath}/voice/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: String(duration) });
    const row = async (callSid: string) =>
        (await db.query(`SELECT * FROM phone_calls WHERE call_sid = $1`, [callSid])).rows[0];
    const placeholder = async (callSid: string) =>
        (await db.query(`SELECT * FROM voice_calls WHERE conversation_id = $1`, [`twilio:${callSid}`])).rows[0];

    beforeAll(async () => {
        stub = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                try { received.push(JSON.parse(body)); } catch { received.push(null); }
                if (stubStatus !== 200) {
                    res.writeHead(stubStatus, { 'content-type': 'application/json' });
                    res.end('{"detail":"stub in errore"}');
                    return;
                }
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end(STUB_TWIML);
            });
        });
        await new Promise<void>(resolve => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));

        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const t = await db.query(`SELECT webhook_token FROM tenants WHERE id = 1`);
        webhookPath = `/webhook/t/${t.rows[0].webhook_token}`;

        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);
        const customer = await api().post('/customers').set(bearer(token)).send({ name: 'Teresa Centralino', phone: CLIENTE });
        expect(customer.status).toBe(201);
    });

    afterAll(async () => {
        await new Promise<void>(resolve => stub.close(() => resolve()));
        await db.end();
    });

    it('senza firma Twilio valida risponde 403 e non registra niente', async () => {
        const res = await api().post(`${webhookPath}/voice/inbound`).set('X-Twilio-Signature', 'firma-falsa')
            .type('form').send({ CallSid: 'CAvoce0000', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.status).toBe(403);
        expect(await row('CAvoce0000')).toBeUndefined();
    });

    it('aggancia Sofia con register-call e le passa il cliente', async () => {
        received.length = 0;
        const res = await inbound('CAvoce0001', CLIENTE);
        expect(res.status).toBe(200);
        expect(res.text).toContain('<Connect>');

        const sent = received[0];
        expect(sent.from_number).toBe(CLIENTE);
        expect(sent.to_number).toBe(NOSTRO_NUMERO);
        expect(sent.direction).toBe('inbound');
        expect(sent.conversation_initiation_client_data.dynamic_variables.customer_first_name).toBe('Teresa');
        expect(sent.conversation_initiation_client_data.conversation_config_override.agent.first_message).toContain('Teresa');

        const r = await waitFor(() => row('CAvoce0001'), v => v?.customer_id != null);
        expect(r.status).toBe('sofia');
        expect(r.routing).toBe('solo_sofia');
        expect(r.from_number).toBe(CLIENTE);
        expect(r.customer_id).not.toBeNull();

        const live = await api().get('/phone/live').set(bearer(token));
        expect(live.body.calls.find((c: any) => c.id === 'CAvoce0001')?.card.customer.name).toBe('Teresa Centralino');
    });

    it('il post-call collega la conversazione e la chiamata non risulta persa', async () => {
        const post = await api().post('/webhook/elevenlabs/post-call').send({
            data: {
                conversation_id: 'conv_telefono_voce_1',
                metadata: { call_duration_secs: 40, phone_call: { call_sid: 'CAvoce0001', external_number: CLIENTE } },
            },
        });
        expect(post.status).toBe(200);
        const r = await waitFor(() => row('CAvoce0001'), v => v?.voice_call_id != null);
        expect(r.conversation_id).toBe('conv_telefono_voce_1');

        expect((await status('CAvoce0001', 41)).status).toBe(204);
        await new Promise(res => setTimeout(res, 800));
        const after = await row('CAvoce0001');
        expect(after.status).toBe('sofia');
        expect(after.duration_seconds).toBe(41);
        expect(await placeholder('CAvoce0001')).toBeUndefined();
    });

    it('Sofia non raggiungibile: messaggio di cortesia e chiamata da ricontattare', async () => {
        stubStatus = 500;
        try {
            const res = await inbound('CAvoce0002', SCONOSCIUTO);
            expect(res.status).toBe(200);
            expect(res.text).toContain('<Say');
            expect(res.text).toContain('<Hangup/>');
        } finally {
            stubStatus = 200;
        }
        const r = await waitFor(() => row('CAvoce0002'), v => v?.status === 'missed' && v?.voice_call_id != null);
        expect(r.missed_reason).toBe('sofia_non_disponibile');
        const vc = await placeholder('CAvoce0002');
        expect(vc.phone).toBe(SCONOSCIUTO);
        expect(vc.follow_up_status).toBe('PENDING');
        expect(vc.reservation_id).toBeNull();

        // Il banner si chiude anche se ElevenLabs ha fallito prima che la
        // scheda fosse pronta.
        const live = await waitFor(
            async () => (await api().get('/phone/live').set(bearer(token))).body.calls as any[],
            calls => !calls.some(c => c.id === 'CAvoce0002'),
        );
        expect(live.some(c => c.id === 'CAvoce0002')).toBe(false);
    });

    it('Sofia muta: agganciata ma senza post-call, la chiamata diventa persa', async () => {
        expect((await inbound('CAvoce0003', SCONOSCIUTO)).status).toBe(200);
        expect((await status('CAvoce0003', 4)).status).toBe(204);
        const r = await waitFor(() => row('CAvoce0003'), v => v?.status === 'missed', 40);
        expect(r.missed_reason).toBe('sofia_muta');
        expect((await placeholder('CAvoce0003')).follow_up_status).toBe('PENDING');
    });

    it('un post-call in ritardo la riprende e chiude la riga provvisoria', async () => {
        const post = await api().post('/webhook/elevenlabs/post-call').send({
            data: {
                conversation_id: 'conv_telefono_voce_3',
                metadata: { call_duration_secs: 4, phone_call: { call_sid: 'CAvoce0003', external_number: SCONOSCIUTO } },
            },
        });
        expect(post.status).toBe(200);
        const r = await waitFor(() => row('CAvoce0003'), v => v?.status === 'sofia');
        expect(r.conversation_id).toBe('conv_telefono_voce_3');
        expect(r.missed_reason).toBeNull();
        expect((await placeholder('CAvoce0003')).follow_up_status).toBe('CONTACTED');
    });

    it('numero nascosto: Sofia risponde lo stesso, col saluto generico', async () => {
        received.length = 0;
        const res = await inbound('CAvoce0004', 'anonymous');
        expect(res.status).toBe(200);
        expect(res.text).toContain('<Connect>');
        expect(received[0].conversation_initiation_client_data.dynamic_variables.customer_known).toBe('false');
        expect((await row('CAvoce0004')).status).toBe('sofia');
    });
});
