import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// WhatsApp, Fase 12a: il numero di un locale sull'API Cloud di Meta
// (services/whatsapp/providers/meta.ts).
//
// Il collegamento a mano (id del numero, account, token), il webhook unico
// firmato dal segreto dell'app con il locale ricavato da phone_number_id, gli
// invii col token del locale, gli stati col costo, le foto dal proxy
// dell'Inbox e l'eco della coesistenza. La Graph API è lo stub di questo
// file sulla porta del server + 14 (globalSetup).
//
// Gira nella suite principale, dove il tenant 1 non ha il mittente Twilio in
// env: è lì che può collegare un numero Meta. Nel passo col mittente finto
// (TWILIO_WHATSAPP_FROM) il tenant 1 scrive da Twilio e il collegamento è
// giustamente rifiutato.

const PORT = Number(process.env.TEST_API_PORT || 3199);
const META_PORT = PORT + 14;
const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-meta-verify-token';
const PNID = '109000000000001';
const WABA = '209000000000001';
const TOKEN = 'EAAGtest-token-del-locale-0123456789';
const NOSTRO = '15550001111';
const CLIENTE = '393391188601';
const FOTO = Buffer.from('jpeg-finto-della-foto');

interface Chiamata { method: string; url: string; auth: string | undefined; body: any }

describe.runIf(!process.env.TWILIO_WHATSAPP_FROM)('WhatsApp su Meta (API Cloud)', () => {
    let meta: http.Server;
    const chiamate: Chiamata[] = [];
    let inviati = 0;
    let db: Client;
    let token = '';

    const firma = (raw: string, secret = APP_SECRET) =>
        `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
    const webhook = (payload: unknown, secret = APP_SECRET) => {
        const raw = JSON.stringify(payload);
        return api().post('/webhook/meta-whatsapp')
            .set('Content-Type', 'application/json')
            .set('X-Hub-Signature-256', firma(raw, secret))
            .send(raw);
    };
    const cambio = (field: string, value: Record<string, unknown>, pnid = PNID) => ({
        object: 'whatsapp_business_account',
        entry: [{ id: WABA, changes: [{ field, value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: NOSTRO, phone_number_id: pnid },
            ...value,
        } }] }],
    });
    const testo = (id: string, body: string, pnid = PNID) => cambio('messages', {
        contacts: [{ profile: { name: 'Giulia' }, wa_id: CLIENTE }],
        messages: [{ from: CLIENTE, id, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
    }, pnid);
    /** La riga che il webhook scrive, che arriva dopo il 200. */
    const riga = async (sql: string, params: unknown[], ok: (row: any) => boolean = () => true, ms = 5000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const row = (await db.query(sql, params)).rows[0];
            if (row && ok(row)) return row;
            if (Date.now() > deadline) throw new Error(`riga non arrivata: ${JSON.stringify(row)}`);
            await new Promise(res => setTimeout(res, 100));
        }
    };
    const conta = async (sql: string, params: unknown[]) => Number((await db.query(sql, params)).rows[0].n);

    beforeAll(async () => {
        meta = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                const url = new URL(req.url ?? '/', 'http://stub');
                const auth = req.headers.authorization;
                let body: any = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
                chiamate.push({ method: req.method ?? '', url: req.url ?? '', auth, body });
                const json = (status: number, payload: unknown) => {
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(payload));
                };
                if (auth !== `Bearer ${TOKEN}`) {
                    return json(401, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
                }
                if (req.method === 'GET' && url.pathname === `/${PNID}`) {
                    return json(200, {
                        id: PNID, display_phone_number: '+1 555-000-1111', verified_name: 'Trattoria Prova',
                        quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250',
                    });
                }
                if (req.method === 'POST' && url.pathname === `/${WABA}/subscribed_apps`) return json(200, { success: true });
                if (req.method === 'POST' && url.pathname === `/${PNID}/messages`) {
                    inviati += 1;
                    return json(200, { messaging_product: 'whatsapp', contacts: [{ input: body?.to, wa_id: body?.to }], messages: [{ id: `wamid.out${inviati}` }] });
                }
                if (req.method === 'GET' && url.pathname === '/media123') {
                    return json(200, { id: 'media123', mime_type: 'image/jpeg', url: `http://127.0.0.1:${META_PORT}/file/media123` });
                }
                if (req.method === 'GET' && url.pathname === '/file/media123') {
                    res.writeHead(200, { 'content-type': 'image/jpeg' });
                    return res.end(FOTO);
                }
                json(404, { error: { message: 'not found' } });
            });
        });
        await new Promise<void>(resolve => meta.listen(META_PORT, '127.0.0.1', resolve));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await db.query(`DELETE FROM whatsapp_senders WHERE tenant_id = 1`);
    });

    afterAll(async () => {
        await api().delete('/whatsapp/meta/connect').set(bearer(token));
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND (from_phone_digits = $1 OR to_phone_digits = $1)`, [CLIENTE]);
        await db.query(`DELETE FROM whatsapp_senders WHERE tenant_id = 4391`);
        await db.query(`DELETE FROM tenants WHERE id = 4391`);
        await db.end();
        await new Promise<void>(resolve => meta.close(() => resolve()));
    });

    it("la verifica dell'indirizzo risponde alla sfida solo col token giusto", async () => {
        const ok = await api().get('/webhook/meta-whatsapp')
            .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '987654' });
        expect(ok.status).toBe(200);
        expect(ok.text).toBe('987654');
        const no = await api().get('/webhook/meta-whatsapp')
            .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'sbagliato', 'hub.challenge': '987654' });
        expect(no.status).toBe(403);
    });

    it('senza numero, lo stato offre il collegamento', async () => {
        const res = await api().get('/whatsapp/status').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.connected).toBe(false);
        expect(res.body.meta).toBeNull();
        expect(res.body.meta_connect_available).toBe(true);
    });

    it('id sbagliati o un token che Meta rifiuta non si salvano', async () => {
        const lettere = await api().post('/whatsapp/meta/connect').set(bearer(token))
            .send({ phone_number_id: 'abc', waba_id: WABA, access_token: TOKEN });
        expect(lettere.status).toBe(400);
        const rifiutato = await api().post('/whatsapp/meta/connect').set(bearer(token))
            .send({ phone_number_id: PNID, waba_id: WABA, access_token: 'EAAGtoken-scaduto-0123456789' });
        expect(rifiutato.status).toBe(400);
        expect(rifiutato.body.error).toMatch(/Meta non riconosce/);
        expect(rifiutato.body.error).toMatch(/190/);
        expect(await conta(`SELECT COUNT(*) AS n FROM whatsapp_senders WHERE tenant_id = 1`, [])).toBe(0);
    });

    it('col token giusto il numero si collega, e il token si salva cifrato', async () => {
        const res = await api().post('/whatsapp/meta/connect').set(bearer(token))
            .send({ phone_number_id: PNID, waba_id: WABA, access_token: TOKEN });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, phone: `+${NOSTRO}`, display_name: 'Trattoria Prova', quality_rating: 'GREEN', subscribed: true });
        expect(JSON.stringify(res.body)).not.toContain(TOKEN);
        expect(chiamate.some(c => c.method === 'POST' && c.url === `/${WABA}/subscribed_apps` && c.auth === `Bearer ${TOKEN}`)).toBe(true);

        const row = (await db.query(`SELECT * FROM whatsapp_senders WHERE tenant_id = 1`)).rows[0];
        expect(row).toMatchObject({ provider: 'meta', phone_e164: `+${NOSTRO}`, phone_number_id: PNID, waba_id: WABA, messaging_limit: 'TIER_250' });
        expect(row.access_token_enc).toMatch(/^v1:/);
        expect(row.access_token_enc).not.toContain(TOKEN);

        const status = await api().get('/whatsapp/status').set(bearer(token));
        expect(status.body).toMatchObject({ connected: true, provider: 'meta', phone: `+${NOSTRO}` });
        expect(status.body.meta).toMatchObject({ display_name: 'Trattoria Prova', quality_rating: 'GREEN', phone_number_id: PNID });
        expect(status.body.webhooks.inbound).toMatch(/\/webhook\/meta-whatsapp$/);
        expect(JSON.stringify(status.body)).not.toContain(TOKEN);
    });

    it('lo stesso numero non si collega a un secondo locale', async () => {
        await db.query(`INSERT INTO tenants (id, slug, name) VALUES (4391, 'trattoria-meta', 'Trattoria Meta') ON CONFLICT (id) DO NOTHING`);
        await expect(db.query(
            `INSERT INTO whatsapp_senders (tenant_id, phone_e164, phone_number_id, waba_id, access_token_enc) VALUES (4391, '+15550002222', $1, $2, 'v1:x')`,
            [PNID, WABA]
        )).rejects.toThrow(/duplicate key/);
    });

    it('un webhook senza la firma giusta si scarta', async () => {
        const res = await webhook(testo('wamid.falso1', 'firma sbagliata'), 'segreto-sbagliato');
        expect(res.status).toBe(403);
        const senza = await api().post('/webhook/meta-whatsapp').set('Content-Type', 'application/json').send(JSON.stringify(testo('wamid.falso2', 'senza firma')));
        expect(senza.status).toBe(403);
        await new Promise(res => setTimeout(res, 300));
        expect(await conta(`SELECT COUNT(*) AS n FROM outbound_messages WHERE provider_sid IN ('wamid.falso1', 'wamid.falso2')`, [])).toBe(0);
    });

    it('un messaggio in arrivo entra nella conversazione del locale, una volta sola', async () => {
        const payload = testo('wamid.in1', 'Ciao, avete posto stasera?');
        expect((await webhook(payload)).status).toBe(200);
        const row = await riga(
            `SELECT * FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = 'wamid.in1'`, []);
        expect(row).toMatchObject({
            provider: 'meta', channel: 'whatsapp', direction: 'inbound',
            from_phone_digits: CLIENTE, body: 'Ciao, avete posto stasera?', profile_name: 'Giulia',
        });
        // Meta ritenta: lo stesso id non entra due volte.
        expect((await webhook(payload)).status).toBe(200);
        await new Promise(res => setTimeout(res, 300));
        expect(await conta(`SELECT COUNT(*) AS n FROM outbound_messages WHERE provider_sid = 'wamid.in1'`, [])).toBe(1);
    });

    it('un numero che nessun locale ha collegato si ignora', async () => {
        expect((await webhook(testo('wamid.altro1', 'numero di nessuno', '999000000000009'))).status).toBe(200);
        await new Promise(res => setTimeout(res, 300));
        expect(await conta(`SELECT COUNT(*) AS n FROM outbound_messages WHERE provider_sid = 'wamid.altro1'`, [])).toBe(0);
    });

    it('la risposta dello staff parte da Meta col token del locale', async () => {
        const prima = chiamate.length;
        const res = await api().post('/messages/send').set(bearer(token)).send({ phone: `+${CLIENTE}`, text: 'Sì, alle 20 vi va bene?' });
        expect(res.status).toBe(200);
        const invio = chiamate.slice(prima).find(c => c.method === 'POST' && c.url === `/${PNID}/messages`);
        expect(invio).toBeTruthy();
        expect(invio!.auth).toBe(`Bearer ${TOKEN}`);
        expect(invio!.body).toMatchObject({ messaging_product: 'whatsapp', to: CLIENTE, type: 'text', text: { body: 'Sì, alle 20 vi va bene?' } });
        const row = (await db.query(`SELECT * FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = $1`, [`wamid.out${inviati}`])).rows[0];
        expect(row).toMatchObject({ provider: 'meta', channel: 'whatsapp', to_phone_digits: CLIENTE, kind: 'staff' });
    });

    it('gli stati di consegna aggiornano il messaggio e il suo costo', async () => {
        const sid = `wamid.out${inviati}`;
        const res = await webhook(cambio('messages', {
            statuses: [{ id: sid, status: 'delivered', timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: CLIENTE,
                pricing: { billable: false, pricing_model: 'PMP', category: 'service' } }],
        }));
        expect(res.status).toBe(200);
        const row = await riga(`SELECT * FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = $1`, [sid], r => r.status === 'delivered');
        expect(row).toMatchObject({ pricing_category: 'service', billable: false });
    });

    it("una foto del cliente si apre dal proxy dell'Inbox", async () => {
        expect((await webhook(cambio('messages', {
            contacts: [{ profile: { name: 'Giulia' }, wa_id: CLIENTE }],
            messages: [{ from: CLIENTE, id: 'wamid.foto1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'image',
                image: { id: 'media123', mime_type: 'image/jpeg', caption: 'il tavolo di ieri' } }],
        }))).status).toBe(200);
        const row = await riga(`SELECT * FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = 'wamid.foto1'`, []);
        expect(row.body).toBe('il tavolo di ieri');
        expect(row.media).toEqual([{ url: 'meta-media:media123', content_type: 'image/jpeg' }]);
        const file = await api().get(`/messages/${row.id}/media/0`).set(bearer(token)).buffer(true).parse((r, cb) => {
            const parts: Buffer[] = [];
            r.on('data', (c: Buffer) => parts.push(c));
            r.on('end', () => cb(null, Buffer.concat(parts)));
        });
        expect(file.status).toBe(200);
        expect(file.headers['content-type']).toMatch(/image\/jpeg/);
        expect(Buffer.compare(file.body as Buffer, FOTO)).toBe(0);
    });

    it("quello che il locale scrive dall'app WhatsApp Business entra come scritto dallo staff", async () => {
        const eco = cambio('smb_message_echoes', {
            message_echoes: [{ from: NOSTRO, to: CLIENTE, id: 'wamid.eco1', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Vi richiamo io tra poco' } }],
        });
        expect((await webhook(eco)).status).toBe(200);
        const row = await riga(`SELECT * FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = 'wamid.eco1'`, []);
        expect(row).toMatchObject({ provider: 'meta', direction: 'outbound', to_phone_digits: CLIENTE, body: 'Vi richiamo io tra poco', kind: 'staff' });
        expect((await webhook(eco)).status).toBe(200);
        await new Promise(res => setTimeout(res, 300));
        expect(await conta(`SELECT COUNT(*) AS n FROM outbound_messages WHERE provider_sid = 'wamid.eco1'`, [])).toBe(1);
    });

    it('scollegato, il numero non manda più e i suoi webhook si ignorano', async () => {
        const res = await api().delete('/whatsapp/meta/connect').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true, removed: true });
        expect(await conta(`SELECT COUNT(*) AS n FROM whatsapp_senders WHERE tenant_id = 1`, [])).toBe(0);
        const status = await api().get('/whatsapp/status').set(bearer(token));
        expect(status.body.connected).toBe(false);

        const prima = chiamate.length;
        const invio = await api().post('/messages/send').set(bearer(token)).send({ phone: `+${CLIENTE}`, text: 'non deve partire' });
        expect(invio.status).toBeGreaterThanOrEqual(400);
        expect(chiamate.slice(prima).some(c => c.url === `/${PNID}/messages`)).toBe(false);

        expect((await webhook(testo('wamid.dopo1', 'ci siete?'))).status).toBe(200);
        await new Promise(res => setTimeout(res, 300));
        expect(await conta(`SELECT COUNT(*) AS n FROM outbound_messages WHERE provider_sid = 'wamid.dopo1'`, [])).toBe(0);
    });

    it('senza accesso non si collega né scollega', async () => {
        expect((await api().post('/whatsapp/meta/connect').send({ phone_number_id: PNID, waba_id: WABA, access_token: TOKEN })).status).toBe(401);
        expect((await api().delete('/whatsapp/meta/connect')).status).toBe(401);
    });
});
