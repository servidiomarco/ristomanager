import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Telefono, Fase 4 (docs/telefono-piano.md): il cordless del locale. Una
// base DECT IP si registra sul dominio SIP di Sympotia, squilla con il CRM e
// i cellulari col nome di chi chiama, e chiama fuori col numero del locale.
// Le API REST di Twilio (credenziali SIP) stanno su uno stub alla porta del
// server + 12; il dominio SIP è finto (globalSetup).
const AUTH_TOKEN = 'test-twilio-auth-token';
const REST_PORT = Number(process.env.TEST_API_PORT || 3199) + 12;
const DOMAIN = 'sympotia-test.sip.twilio.com';
const NOSTRO_NUMERO = '+390985010032';
const CLIENTE = '+393478806655';

describe('telefono: cordless SIP', () => {
    let token: string;
    let db: Client;
    let webhookPath: string;
    let rest: http.Server;
    let failNext = false;
    const restCalls: { method: string; path: string; body: string }[] = [];
    let lineId: number;
    let username: string;

    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const row = async (callSid: string) =>
        (await db.query(`SELECT * FROM phone_calls WHERE call_sid = $1`, [callSid])).rows[0];
    const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
        let v = await read();
        for (let i = 0; i < 30 && !ok(v); i++) {
            await new Promise(res => setTimeout(res, 100));
            v = await read();
        }
        return v;
    };

    beforeAll(async () => {
        rest = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                restCalls.push({ method: req.method || '', path: req.url || '', body });
                if (failNext) {
                    failNext = false;
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end('{"message":"boom"}');
                    return;
                }
                if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: `CRtest${String(restCalls.length).padStart(26, '0')}` }));
            });
        });
        await new Promise<void>(resolve => rest.listen(REST_PORT, '127.0.0.1', () => resolve()));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        webhookPath = `/webhook/t/${(await db.query(`SELECT webhook_token FROM tenants WHERE id = 1`)).rows[0].webhook_token}`;
        token = await ownerToken();
        expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true })).status).toBe(200);
        expect((await api().post('/customers').set(bearer(token)).send({ name: 'Bruno Cordless', phone: CLIENTE })).status).toBe(201);
    });

    afterAll(async () => {
        await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [], ring_seconds: 15, slots: [] });
        await db.query(`DELETE FROM phone_sip_lines`);
        await new Promise<void>(resolve => rest.close(() => resolve()));
        await db.end();
    });

    it('aggiunge un cordless: credenziale su Twilio, password mostrata una volta', async () => {
        const empty = await api().get('/phone/sip-lines').set(bearer(token));
        expect(empty.status).toBe(200);
        expect(empty.body).toMatchObject({ configured: true, domain: DOMAIN, proxy: 'sip.frankfurt.twilio.com', lines: [] });

        expect((await api().post('/phone/sip-lines').set(bearer(token)).send({ label: '  ' })).status).toBe(400);

        const created = await api().post('/phone/sip-lines').set(bearer(token)).send({ label: 'Cordless sala' });
        expect(created.status).toBe(201);
        lineId = created.body.id;
        username = created.body.username;
        expect(username).toBe(`t1c${lineId}`);
        expect(created.body.password).toMatch(/^[A-Za-z0-9]{20}$/);
        expect(created.body.password).toMatch(/[A-Z]/);
        expect(created.body.password).toMatch(/[a-z]/);
        expect(created.body.password).toMatch(/\d/);
        const call = restCalls.at(-1)!;
        expect(call.method).toBe('POST');
        expect(call.path).toBe('/2010-04-01/Accounts/ACtest00000000000000000000000000/SIP/CredentialLists/CLtest00000000000000000000000000/Credentials.json');
        const form = new URLSearchParams(call.body);
        expect(form.get('Username')).toBe(username);
        expect(form.get('Password')).toBe(created.body.password);

        const list = await api().get('/phone/sip-lines').set(bearer(token));
        expect(list.body.lines).toEqual([{ id: lineId, label: 'Cordless sala', username, created_at: expect.any(String) }]);
        expect(JSON.stringify(list.body)).not.toContain(created.body.password);
    });

    it('se Twilio non crea la credenziale non resta niente', async () => {
        failNext = true;
        const res = await api().post('/phone/sip-lines').set(bearer(token)).send({ label: 'Cordless rotto' });
        expect(res.status).toBe(502);
        expect((await db.query(`SELECT COUNT(*)::int AS n FROM phone_sip_lines WHERE label = 'Cordless rotto'`)).rows[0].n).toBe(0);
    });

    it('squilla insieme al locale, col nome del cliente sul display', async () => {
        expect((await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'prima_locale', mobiles: [], ring_seconds: 20, slots: [] })).status).toBe(200);
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcord0001', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.text).toContain('<Dial timeout="20"');
        const sip = /<Sip statusCallbackEvent="answered" statusCallback="([^"]+)" statusCallbackMethod="POST">([^<]+)<\/Sip>/.exec(res.text);
        expect(sip).not.toBeNull();
        expect(sip![1]).toContain(`${webhookPath}/voice/client-answered?p=CAcord0001`);
        const uri = sip![2].replace(/&amp;/g, '&');
        expect(uri.startsWith(`sip:${username}@${DOMAIN}?Remote-Party-ID=`)).toBe(true);
        const rpid = decodeURIComponent(uri.split('Remote-Party-ID=')[1]);
        expect(rpid).toBe(`"Bruno Cordless" <sip:${CLIENTE}@${DOMAIN}>;party=calling;screen=yes;privacy=off`);
        expect((await row('CAcord0001')).routing).toBe('prima_locale');
    });

    it('risponde il cordless: la chiamata è sua, col suo nome', async () => {
        const answered = await signed(`${webhookPath}/voice/client-answered?p=CAcord0001`, {
            CallSid: 'CAcordleg01', ParentCallSid: 'CAcord0001', To: `sip:${username}@${DOMAIN}`, CallStatus: 'in-progress',
        });
        expect(answered.status).toBe(204);
        const r = await until(() => row('CAcord0001'), x => x.status === 'answered');
        expect(r.answered_by).toBe(`cordless:${lineId}`);
        const after = await signed(`${webhookPath}/voice/after-dial`, { CallSid: 'CAcord0001', CallStatus: 'in-progress', DialCallStatus: 'completed' });
        expect(after.text).toContain('<Hangup/>');
        const staff = await api().get('/phone/calls?filter=staff').set(bearer(token));
        expect(staff.body.calls.find((c: any) => c.call_sid === 'CAcord0001').answered_by).toEqual({ kind: 'cordless', name: 'Cordless sala' });
    });

    it('dal cordless si chiama fuori col numero del locale, solo fissi e cellulari italiani', async () => {
        const out = await signed('/webhook/twilio/voice/sip-call', { CallSid: 'CAcordout1', From: `sip:${username}@${DOMAIN}`, To: `sip:3478806655@${DOMAIN}` });
        expect(out.status).toBe(200);
        expect(out.text).toContain(`<Dial callerId="${NOSTRO_NUMERO}"`);
        expect(out.text).toContain(`<Number>${CLIENTE}</Number>`);
        const r = await row('CAcordout1');
        expect(r).toMatchObject({ direction: 'outbound', to_number: CLIENTE, answered_by: `cordless:${lineId}` });
        expect(r.customer_id).not.toBeNull();

        for (const to of ['112', '899123456', '+447700900123']) {
            const no = await signed('/webhook/twilio/voice/sip-call', { CallSid: `CAcordno${to.length}`, From: `sip:${username}@${DOMAIN}`, To: `sip:${to}@${DOMAIN}` });
            expect(no.text).toContain('Numero non chiamabile');
            expect(no.text).not.toContain('<Dial');
        }
        const stranger = await signed('/webhook/twilio/voice/sip-call', { CallSid: 'CAcordout9', From: `sip:t1c999999@${DOMAIN}`, To: `sip:3478806655@${DOMAIN}` });
        expect(stranger.text).toContain('Telefono non riconosciuto');
        expect((await api().post('/webhook/twilio/voice/sip-call').type('form').send({ From: `sip:${username}@${DOMAIN}`, To: `sip:3478806655@${DOMAIN}` })).status).toBe(403);

        expect((await signed('/webhook/twilio/voice/client-status', { CallSid: 'CAcordout1', From: `sip:${username}@${DOMAIN}`, CallStatus: 'completed', CallDuration: '27' })).status).toBe(204);
        expect((await until(() => row('CAcordout1'), x => x.duration_seconds != null)).duration_seconds).toBe(27);
    });

    it('togliere il cordless cancella la credenziale e smette di squillare', async () => {
        const before = restCalls.length;
        expect((await api().delete(`/phone/sip-lines/${lineId}`).set(bearer(token))).status).toBe(204);
        const del = restCalls.slice(before).find(c => c.method === 'DELETE');
        expect(del?.path).toMatch(/\/SIP\/CredentialLists\/CLtest0+\/Credentials\/CRtest\d+\.json$/);
        expect((await api().get('/phone/sip-lines').set(bearer(token))).body.lines).toEqual([]);
        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAcord0002', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.text).not.toContain('<Sip');
        expect((await api().delete(`/phone/sip-lines/${lineId}`).set(bearer(token))).status).toBe(404);
    });
});
