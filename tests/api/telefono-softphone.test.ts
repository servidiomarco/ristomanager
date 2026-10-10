import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Telefono, Fase 3 (docs/telefono-piano.md): il CRM squilla come un telefono.
// Un browser accende «Questo dispositivo squilla», riceve un token Twilio e
// squilla insieme ai cellulari; risponde dal CRM; richiama i clienti dal CRM
// (solo numeri italiani). La API key e la TwiML App sono finte (globalSetup).
const AUTH_TOKEN = 'test-twilio-auth-token';
const API_KEY_SECRET = 'test-api-key-secret';
const NOSTRO_NUMERO = '+390985010032';
const CLIENTE = '+393478809944';
const DEVICE_KEY = 'dispositivo-prova-softphone-0001';

describe('telefono: softphone nel CRM', () => {
    let token: string;
    let ownerId: number;
    let db: Client;
    let webhookPath: string;
    let deviceId: number;
    let identity: string;

    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const row = async (callSid: string) =>
        (await db.query(`SELECT * FROM phone_calls WHERE call_sid = $1`, [callSid])).rows[0];

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        webhookPath = `/webhook/t/${(await db.query(`SELECT webhook_token FROM tenants WHERE id = 1`)).rows[0].webhook_token}`;
        token = await ownerToken();
        ownerId = (await api().get('/auth/me').set(bearer(token))).body.id;
        expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true })).status).toBe(200);
        expect((await api().post('/customers').set(bearer(token)).send({ name: 'Livia Softphone', phone: CLIENTE })).status).toBe(201);
    });

    afterAll(async () => {
        await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [], ring_seconds: 15 });
        await db.query(`DELETE FROM phone_devices WHERE device_key = $1`, [DEVICE_KEY]);
        await db.end();
    });

    it('accende il dispositivo e rilascia un token Twilio con la sua identità', async () => {
        expect((await api().post('/phone/devices').set(bearer(token)).send({ device_key: 'corta' })).status).toBe(400);
        const created = await api().post('/phone/devices').set(bearer(token)).send({ device_key: DEVICE_KEY, label: 'PC reception' });
        expect(created.status).toBe(201);
        deviceId = created.body.id;
        identity = `t1d${deviceId}`;

        const list = await api().get(`/phone/devices?device_key=${DEVICE_KEY}`).set(bearer(token));
        expect(list.body.configured).toBe(true);
        const mine = list.body.devices.find((d: any) => d.id === deviceId);
        expect(mine.mine).toBe(true);
        expect(mine.label).toBe('PC reception');
        expect(mine).not.toHaveProperty('device_key');

        expect((await api().post('/phone/token').set(bearer(token)).send({ device_key: 'dispositivo-mai-acceso-000000' })).status).toBe(404);
        const t = await api().post('/phone/token').set(bearer(token)).send({ device_key: DEVICE_KEY });
        expect(t.status).toBe(200);
        expect(t.body.identity).toBe(identity);
        const claims: any = jwt.verify(t.body.token, API_KEY_SECRET);
        expect(claims.grants.identity).toBe(identity);
        expect(claims.grants.voice.incoming.allow).toBe(true);
        expect(claims.grants.voice.outgoing.application_sid).toBe('APtest00000000000000000000000000');
        expect(claims.iss).toBe('SKtest00000000000000000000000000');
    });

    it('con «Prima il locale» squilla il CRM, con la chiamata del cliente come parametro', async () => {
        expect((await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'prima_locale', mobiles: [], ring_seconds: 20 })).status).toBe(200);
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAsoft0001', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.status).toBe(200);
        expect(res.text).toContain('<Dial timeout="20" ringTone="it"');
        expect(res.text).toContain(`<Identity>${identity}</Identity>`);
        expect(res.text).toContain('<Parameter name="parentCallSid" value="CAsoft0001"/>');
        expect(res.text).toContain(`<Parameter name="caller" value="${CLIENTE}"/>`);
        expect(res.text).toContain(`${webhookPath}/voice/client-answered?p=CAsoft0001`);
        expect(res.text).not.toContain('<Number');
        expect((await row('CAsoft0001')).routing).toBe('prima_locale');
    });

    it('risposta dal CRM: la chiamata è di chi ha risposto e a fine chiamata niente Sofia', async () => {
        const answered = await signed(`${webhookPath}/voice/client-answered?p=CAsoft0001`, {
            CallSid: 'CAsoftleg01', ParentCallSid: 'CAsoft0001', To: `client:${identity}`, CallStatus: 'in-progress',
        });
        expect(answered.status).toBe(204);
        let r = await row('CAsoft0001');
        for (let i = 0; i < 20 && r.status !== 'answered'; i++) {
            await new Promise(res => setTimeout(res, 100));
            r = await row('CAsoft0001');
        }
        expect(r.status).toBe('answered');
        expect(r.answered_by).toBe(`utente:${ownerId}`);
        const live = (await api().get('/phone/live').set(bearer(token))).body.calls.find((c: any) => c.id === 'CAsoft0001');
        expect(live.stage).toBe('staff');

        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAsoft0001', CallStatus: 'in-progress', DialCallStatus: 'completed' });
        expect(after.text).toContain('<Hangup/>');
    });

    it('«Richiama» dal CRM esce col numero del locale, solo verso numeri italiani', async () => {
        const res = await signed('/webhook/twilio/voice/client-call', { CallSid: 'CAout0001', From: `client:${identity}`, To: '347 880 9944' });
        expect(res.status).toBe(200);
        expect(res.text).toContain(`<Dial callerId="${NOSTRO_NUMERO}"`);
        expect(res.text).toContain(`<Number>${CLIENTE}</Number>`);
        const r = await row('CAout0001');
        expect(r.direction).toBe('outbound');
        expect(r.to_number).toBe(CLIENTE);
        expect(r.customer_id).not.toBeNull();
        expect(r.answered_by).toBe(`utente:${ownerId}`);

        const estero = await signed('/webhook/twilio/voice/client-call', { CallSid: 'CAout0002', From: `client:${identity}`, To: '+447700900123' });
        expect(estero.text).toContain('Numero non chiamabile');
        expect(estero.text).not.toContain('<Dial');

        const sconosciuto = await signed('/webhook/twilio/voice/client-call', { CallSid: 'CAout0003', From: 'client:t1d999999', To: CLIENTE });
        expect(sconosciuto.text).toContain('Dispositivo non riconosciuto');

        const senzaFirma = await api().post('/webhook/twilio/voice/client-call').type('form').send({ From: `client:${identity}`, To: CLIENTE });
        expect(senzaFirma.status).toBe(403);

        expect((await signed('/webhook/twilio/voice/client-status', { CallSid: 'CAout0001', From: `client:${identity}`, CallStatus: 'completed', CallDuration: '33' })).status).toBe(204);
        for (let i = 0; i < 20 && (await row('CAout0001')).duration_seconds == null; i++) await new Promise(res => setTimeout(res, 100));
        expect((await row('CAout0001')).duration_seconds).toBe(33);
    });

    it('spento il dispositivo non c\'è più token e non squilla', async () => {
        expect((await api().delete(`/phone/devices/${deviceId}`).set(bearer(token))).status).toBe(204);
        expect((await api().post('/phone/token').set(bearer(token)).send({ device_key: DEVICE_KEY })).status).toBe(404);
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAsoft0002', From: CLIENTE, To: NOSTRO_NUMERO });
        // Nessun dispositivo e nessun cellulare: Sofia subito.
        expect(res.text).not.toContain('<Dial');
        expect((await row('CAsoft0002')).routing).toBe('solo_sofia');
    });
});
