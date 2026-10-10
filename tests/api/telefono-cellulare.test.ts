import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Telefono, Fase 3 ridotta (docs/telefono-piano.md): prima di Sofia squilla
// il cellulare del locale. Chi risponde sente chi chiama e preme 1; senza il
// tasto, finito lo squillo, la chiamata passa a Sofia (register-call sullo
// stub alla porta del server + 11, come in telefono-voce).
const AUTH_TOKEN = 'test-twilio-auth-token';
const STUB_PORT = Number(process.env.TEST_API_PORT || 3199) + 11;
const NOSTRO_NUMERO = '+390985010032';
const CELLULARE = '+393289900011';
const CLIENTE = '+393478809933';
const STUB_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://stub.example/conv"/></Connect></Response>';

describe('telefono: prima il cellulare, poi Sofia', () => {
    let token: string;
    let db: Client;
    let webhookPath: string;
    let stub: http.Server;

    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const row = async (callSid: string) =>
        (await db.query(`SELECT * FROM phone_calls WHERE call_sid = $1`, [callSid])).rows[0];
    const liveCall = async (id: string) =>
        ((await api().get('/phone/live').set(bearer(token))).body.calls as any[]).find(c => c.id === id);

    beforeAll(async () => {
        stub = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/xml' });
                res.end(STUB_TWIML);
            });
        });
        await new Promise<void>(resolve => stub.listen(STUB_PORT, '127.0.0.1', () => resolve()));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        webhookPath = `/webhook/t/${(await db.query(`SELECT webhook_token FROM tenants WHERE id = 1`)).rows[0].webhook_token}`;

        token = await ownerToken();
        expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true })).status).toBe(200);
        expect((await api().post('/customers').set(bearer(token)).send({ name: 'Ettore Squillo', phone: CLIENTE })).status).toBe(201);
    });

    afterAll(async () => {
        // Gli altri file si aspettano Sofia subito.
        await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [], ring_seconds: 15 });
        await new Promise<void>(resolve => stub.close(() => resolve()));
        await db.end();
    });

    it('le impostazioni validano numeri e secondi', async () => {
        const badMode = await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'sempre', mobiles: [], ring_seconds: 15 });
        expect(badMode.status).toBe(400);
        const badRing = await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'prima_cellulare', mobiles: [CELLULARE], ring_seconds: 2 });
        expect(badRing.status).toBe(400);
        const ok = await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'prima_cellulare', mobiles: ['328 990 0011'], ring_seconds: 15 });
        expect(ok.status).toBe(200);
        expect(ok.body).toMatchObject({ mode: 'prima_locale', mobiles: [CELLULARE], ring_seconds: 15, slots: [], override: null });
        expect(ok.body.effective).toMatchObject({ mode: 'prima_locale', source: 'base' });
        expect((await api().get('/settings/phone-routing').set(bearer(token))).body.mobiles).toEqual([CELLULARE]);
    });

    it('fa squillare il cellulare con annuncio e ritorno a Sofia', async () => {
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0001', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.status).toBe(200);
        expect(res.text).toContain(`<Dial timeout="15" ringTone="it" callerId="${NOSTRO_NUMERO}"`);
        // Senza answerOnBridge: a fine squillo Twilio chiudeva la chiamata del
        // cliente «no-answer» invece di passarla a Sofia (10/10 18:52).
        expect(res.text).not.toContain('answerOnBridge');
        expect(res.text).toContain(`${webhookPath}/voice/after-dial`);
        expect(res.text).toContain(`${webhookPath}/voice/whisper?p=CAcell0001`);
        expect(res.text).toContain(`>${CELLULARE}</Number>`);
        const r = await row('CAcell0001');
        expect(r.routing).toBe('prima_locale');
        expect(r.status).toBe('ringing');
        await new Promise(res => setTimeout(res, 300));
        expect((await liveCall('CAcell0001'))?.stage).toBe('ringing');
    });

    it("l'annuncio dice chi chiama e chiede di premere 1", async () => {
        const res = await signed(`${webhookPath}/voice/whisper?p=CAcell0001`, { CallSid: 'CAleg0001', To: CELLULARE });
        expect(res.status).toBe(200);
        expect(res.text).toContain('<Gather numDigits="1"');
        expect(res.text).toContain('chiama Ettore Squillo');
        expect(res.text).toContain('Premi 1.');
        expect(res.text).toContain(`${webhookPath}/voice/whisper-ok?p=CAcell0001`);
    });

    it('con 1 il cellulare prende la chiamata; a fine chiamata niente Sofia', async () => {
        const ok = await signed(`${webhookPath}/voice/whisper-ok?p=CAcell0001`, { CallSid: 'CAleg0001', To: CELLULARE, Digits: '1' });
        expect(ok.status).toBe(200);
        expect(ok.text).not.toContain('<Hangup');
        const r = await row('CAcell0001');
        expect(r.status).toBe('answered');
        expect(r.answered_by).toBe(`cellulare:${CELLULARE}`);
        expect((await liveCall('CAcell0001'))?.stage).toBe('staff');

        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcell0001', DialCallStatus: 'completed' });
        expect(after.text).toContain('<Hangup/>');

        expect((await signed(`${webhookPath}/voice/status`, { CallSid: 'CAcell0001', CallStatus: 'completed', CallDuration: '90' })).status).toBe(204);
        expect(await liveCall('CAcell0001')).toBeUndefined();
        expect((await row('CAcell0001')).status).toBe('answered');
    });

    it('senza 1 la chiamata passa a Sofia', async () => {
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0002', From: CLIENTE, To: NOSTRO_NUMERO });
        const wrong = await signed(`${webhookPath}/voice/whisper-ok?p=CAcell0002`, { CallSid: 'CAleg0002', To: CELLULARE, Digits: '5' });
        expect(wrong.text).toContain('<Hangup/>');
        expect((await row('CAcell0002')).status).toBe('ringing');

        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcell0002', CallStatus: 'in-progress', DialCallStatus: 'no-answer' });
        expect(after.status).toBe(200);
        expect(after.text).toContain('<Connect>');
        expect((await row('CAcell0002')).status).toBe('sofia');
        await new Promise(res => setTimeout(res, 300));
        expect((await liveCall('CAcell0002'))?.stage).toBe('sofia');
    });

    it('a fine squillo senza risposta passa a Sofia anche con lo stato «no-answer»', async () => {
        // Prova del 10/10 18:52: Twilio mandava CallStatus «no-answer» a ogni
        // fine squillo (la chiamata del cliente non era ancora risposta) e
        // after-dial lo leggeva come cliente andato via.
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0006', From: CLIENTE, To: NOSTRO_NUMERO });
        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcell0006', CallStatus: 'no-answer', DialCallStatus: 'no-answer' });
        expect(after.text).toContain('<Connect>');
        expect((await row('CAcell0006')).status).toBe('sofia');
    });

    it('se chi chiama ha già riattaccato, a fine squillo niente Sofia', async () => {
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0004', From: CLIENTE, To: NOSTRO_NUMERO });
        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcell0004', CallStatus: 'completed', DialCallStatus: 'completed' });
        expect(after.text).toContain('<Hangup/>');
        expect(after.text).not.toContain('<Connect>');
        expect((await row('CAcell0004')).status).not.toBe('sofia');
    });

    it('chi riattacca mentre squilla il cellulare finisce in Da ricontattare', async () => {
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0005', From: CLIENTE, To: NOSTRO_NUMERO });
        expect((await signed(`${webhookPath}/voice/status`, { CallSid: 'CAcell0005', CallStatus: 'completed', CallDuration: '0' })).status).toBe(204);
        let r = await row('CAcell0005');
        for (let i = 0; i < 30 && r.voice_call_id == null; i++) {
            await new Promise(res => setTimeout(res, 100));
            r = await row('CAcell0005');
        }
        expect(r.status).toBe('missed');
        expect(r.missed_reason).toBe('riattaccata_in_attesa');
        const vc = (await db.query(`SELECT * FROM voice_calls WHERE conversation_id = $1`, ['twilio:CAcell0005'])).rows[0];
        expect(vc.follow_up_status).toBe('PENDING');
        // E a fine squillo non si aggancia Sofia.
        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcell0005', CallStatus: 'completed', DialCallStatus: 'no-answer' });
        expect(after.text).toContain('<Hangup/>');
    });

    it('con «Solo Sofia» risponde subito Sofia', async () => {
        expect((await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [CELLULARE], ring_seconds: 15 })).status).toBe(200);
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcell0003', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.text).toContain('<Connect>');
        expect((await row('CAcell0003')).routing).toBe('solo_sofia');
    });
});
