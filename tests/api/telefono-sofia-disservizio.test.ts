import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Il banner «Sofia non raggiungibile» (13/10/2026: ElevenLabs in timeout per
// ore, e in sala nessuno sapeva perché). Il cane da guardia lo accende quando
// la pagina di stato di ElevenLabs segna un disservizio o quando i nostri
// register-call falliscono, e lo spegne quando tutto rientra. Pagina di stato
// e register-call stanno sullo stesso stub (porta del server + 11, vedi
// globalSetup); «Controlla adesso» fa un giro del cane da guardia.
const AUTH_TOKEN = 'test-twilio-auth-token';
const ADMIN_HEADER = { 'X-Platform-Admin-Token': 'test-platform-token' };
const STUB_PORT = Number(process.env.TEST_API_PORT || 3199) + 11;
const NOSTRO_NUMERO = '+390985010032';
const CLIENTE = '+393478809977';
const STUB_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://stub.example/conv"/></Connect></Response>';

const statusPage = (conversations: string) => ({
    page: { name: 'ElevenLabs' },
    components: [
        { name: 'Text to Speech', status: 'operational' },
        { name: 'Conversations', status: conversations },
        { name: 'Telephony', status: 'operational' },
    ],
});

describe('banner «Sofia non raggiungibile»', () => {
    let token: string;
    let db: Client;
    let webhookPath: string;
    let stub: http.Server;
    let conversations = 'operational';
    let statusUp = true;
    let registerStatus = 200;

    const signed = (path: string, params: Record<string, string>) => {
        const url = `${process.env.TEST_BASE_URL}${path}`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post(path).set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const inbound = (callSid: string) =>
        signed(`${webhookPath}/voice/inbound`, { CallSid: callSid, From: CLIENTE, To: NOSTRO_NUMERO, Direction: 'inbound' });
    const check = async () => {
        expect((await api().post('/admin/health/check').set(ADMIN_HEADER)).status).toBe(200);
    };
    const sofiaBanner = async () =>
        ((await api().get('/incidents/active').set(bearer(token))).body.incidents as any[]).find(i => i.message.includes('ElevenLabs'));
    const openBanners = async () =>
        (await db.query(`SELECT id FROM platform_incidents WHERE auto_kind = 'sofia' AND resolved_at IS NULL`)).rows;
    const registerFailures = async (n: number) => {
        for (let i = 0; i < 30; i++) {
            const r = await db.query(`SELECT COUNT(*)::int AS n FROM app_errors WHERE source = 'register-call'`);
            if (r.rows[0].n >= n) return;
            await new Promise(res => setTimeout(res, 100));
        }
        throw new Error(`attesi ${n} register-call falliti`);
    };

    beforeAll(async () => {
        stub = http.createServer((req, res) => {
            req.resume();
            req.on('end', () => {
                if (req.url?.startsWith('/status')) {
                    if (!statusUp) {
                        res.writeHead(503);
                        res.end();
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(statusPage(conversations)));
                    return;
                }
                if (registerStatus !== 200) {
                    res.writeHead(registerStatus, { 'content-type': 'application/json' });
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
        webhookPath = `/webhook/t/${(await db.query(`SELECT webhook_token FROM tenants WHERE id = 1`)).rows[0].webhook_token}`;

        token = await ownerToken();
        expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true })).status).toBe(200);
        // Sofia subito, senza niente da far squillare: chi non la trova sente
        // la cortesia.
        expect((await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [], ring_seconds: 15 })).status).toBe(200);
        await db.query(`DELETE FROM app_errors WHERE source = 'register-call'`);
        await db.query(`UPDATE platform_incidents SET resolved_at = now() WHERE auto_kind = 'sofia' AND resolved_at IS NULL`);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM app_errors WHERE source = 'register-call'`);
        await db.query(`DELETE FROM platform_incidents WHERE auto_kind = 'sofia'`);
        await new Promise<void>(resolve => stub.close(() => resolve()));
        await db.end();
    });

    it('con ElevenLabs in ordine niente banner', async () => {
        await check();
        expect(await sofiaBanner()).toBeUndefined();
        expect(await openBanners()).toHaveLength(0);
    });

    it('disservizio sulla pagina di stato: il banner si accende', async () => {
        conversations = 'partial_outage';
        await check();
        const banner = await sofiaBanner();
        expect(banner?.level).toBe('critico');
        expect(banner?.message).toContain('Sofia può non rispondere');
        // Un altro giro non ne apre un secondo.
        await check();
        expect(await openBanners()).toHaveLength(1);
    });

    it('chi non ha Sofia non lo vede', async () => {
        expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: false })).status).toBe(200);
        try {
            expect(await sofiaBanner()).toBeUndefined();
        } finally {
            expect((await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true })).status).toBe(200);
        }
        expect(await sofiaBanner()).toBeDefined();
    });

    it('se la pagina di stato non risponde il banner resta com\'è', async () => {
        statusUp = false;
        try {
            await check();
            expect(await openBanners()).toHaveLength(1);
        } finally {
            statusUp = true;
        }
    });

    it('a disservizio finito il banner si spegne', async () => {
        conversations = 'operational';
        await check();
        expect(await sofiaBanner()).toBeUndefined();
        expect(await openBanners()).toHaveLength(0);
    });

    it('i nostri register-call falliti lo accendono anche con la pagina di stato in ordine', async () => {
        registerStatus = 500;
        try {
            expect((await inbound('CAdisserv01')).text).toContain('<Say');
            await registerFailures(1);
            // Uno solo può essere un intoppo.
            await check();
            expect(await openBanners()).toHaveLength(0);
            expect((await inbound('CAdisserv02')).text).toContain('<Say');
            await registerFailures(2);
        } finally {
            registerStatus = 200;
        }
        await check();
        expect(await sofiaBanner()).toBeDefined();
    });

    it('una chiamata agganciata a Sofia lo spegne', async () => {
        expect((await inbound('CAdisserv03')).text).toContain('<Connect>');
        await check();
        expect(await sofiaBanner()).toBeUndefined();
        expect(await openBanners()).toHaveLength(0);
    });
});
