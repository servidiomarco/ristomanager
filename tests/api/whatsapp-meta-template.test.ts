import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';
import { metaSpecList } from '../../services/whatsapp/templates/metaCatalog';

// WhatsApp, Fase 12b: i template sul numero Meta di un locale
// (services/whatsapp/templates/provision.ts e meta.ts).
//
// Al collegamento Sympotia crea nell'account del locale i template del
// catalogo e li manda in approvazione; Meta risponde col webhook
// message_template_status_update; un template approvato parte con le
// variabili dei builder di sempre, rimappate sul corpo Meta; i tasti del
// promemoria tornano col messaggio a cui il cliente risponde. La Graph API
// è lo stub di questo file sulla porta del server + 14, come in
// whatsapp-meta.test.ts.

const PORT = Number(process.env.TEST_API_PORT || 3199);
const META_PORT = PORT + 14;
const APP_SECRET = 'test-meta-app-secret';
const PNID = '109000000000002';
const WABA = '209000000000002';
const TOKEN = 'EAAGtest-token-dei-template-0123456789';
const NOSTRO = '15550002222';
const CLIENTE = '393391188611';
const TOTALE = metaSpecList().length;

interface Remoto { id: string; name: string; language: string; status: string; category: string }

describe.runIf(!process.env.TWILIO_WHATSAPP_FROM)('WhatsApp su Meta: i template del locale', () => {
    let meta: http.Server;
    let db: Client;
    let token = '';
    const remoti = new Map<string, Remoto>();
    const creati: any[] = [];
    const messaggi: any[] = [];
    // Il primo giro lo rifiuta come errore (non è arrivato a Meta).
    const rifiuta = new Set<string>(['sympotia_banquet_quote_v1:en']);
    let prenotazione = 0;

    const firma = (raw: string) => `sha256=${crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex')}`;
    const webhook = (payload: unknown) => {
        const raw = JSON.stringify(payload);
        return api().post('/webhook/meta-whatsapp')
            .set('Content-Type', 'application/json')
            .set('X-Hub-Signature-256', firma(raw))
            .send(raw);
    };
    const riga = async (sql: string, params: unknown[], ok: (row: any) => boolean = () => true, ms = 8000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const row = (await db.query(sql, params)).rows[0];
            if (row && ok(row)) return row;
            if (Date.now() > deadline) throw new Error(`riga non arrivata: ${JSON.stringify(row)}`);
            await new Promise(res => setTimeout(res, 100));
        }
    };
    const statoDi = (name: string, language: string) =>
        db.query(`SELECT status, reason FROM whatsapp_templates WHERE tenant_id = 1 AND name = $1 AND language = $2`, [name, language]).then(r => r.rows[0]);
    /** Meta decide su un template: lo stato cambia nello stub e arriva col webhook. */
    const decide = async (name: string, language: string, event: string, reason = 'NONE') => {
        const t = remoti.get(`${name}:${language}`);
        if (t) t.status = event;
        const res = await webhook({
            object: 'whatsapp_business_account',
            entry: [{ id: WABA, time: Math.floor(Date.now() / 1000), changes: [{ field: 'message_template_status_update', value: {
                event, message_template_id: t?.id, message_template_name: name, message_template_language: language, reason,
            } }] }],
        });
        expect(res.status).toBe(200);
        await riga(`SELECT status FROM whatsapp_templates WHERE tenant_id = 1 AND name = $1 AND language = $2`, [name, language], r => r.status === event);
    };
    const mandati = (dal: number) => messaggi.slice(dal).filter(m => m?.to === CLIENTE);
    const attendiMandati = async (dal: number, almeno = 1, ms = 4000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const r = mandati(dal);
            if (r.length >= almeno || Date.now() > deadline) return r;
            await new Promise(res => setTimeout(res, 100));
        }
    };
    const collega = () => api().post('/whatsapp/meta/connect').set(bearer(token))
        .send({ phone_number_id: PNID, waba_id: WABA, access_token: TOKEN });
    const tutti = () => riga(
        `SELECT COUNT(*)::int AS n FROM whatsapp_templates WHERE tenant_id = 1 AND waba_id = $1`, [WABA], r => r.n === TOTALE
    );

    beforeAll(async () => {
        meta = http.createServer((req, res) => {
            let raw = '';
            req.on('data', c => { raw += c; });
            req.on('end', () => {
                const url = new URL(req.url ?? '/', 'http://stub');
                let body: any = null;
                try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
                const json = (status: number, payload: unknown) => {
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(JSON.stringify(payload));
                };
                if (req.headers.authorization !== `Bearer ${TOKEN}`) {
                    return json(401, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
                }
                if (req.method === 'GET' && url.pathname === `/${PNID}`) {
                    return json(200, { id: PNID, display_phone_number: '+1 555-000-2222', verified_name: 'Osteria Prova', quality_rating: 'GREEN', messaging_limit_tier: 'TIER_250' });
                }
                if (req.method === 'POST' && url.pathname === `/${WABA}/subscribed_apps`) return json(200, { success: true });
                if (req.method === 'GET' && url.pathname === `/${WABA}/message_templates`) {
                    return json(200, { data: [...remoti.values()].map(t => ({ ...t, rejected_reason: 'NONE' })) });
                }
                if (req.method === 'POST' && url.pathname === `/${WABA}/message_templates`) {
                    creati.push(body);
                    const k = `${body?.name}:${body?.language}`;
                    if (rifiuta.has(k)) {
                        return json(400, { error: { message: 'Invalid parameter', type: 'OAuthException', code: 100, error_subcode: 2388299, error_user_msg: 'Il servizio di Meta non risponde' } });
                    }
                    const t: Remoto = { id: `tpl${remoti.size + 1}`, name: body.name, language: body.language, status: 'PENDING', category: body.category };
                    remoti.set(k, t);
                    return json(200, { id: t.id, status: 'PENDING', category: body.category });
                }
                if (req.method === 'POST' && url.pathname === `/${PNID}/messages`) {
                    messaggi.push(body);
                    return json(200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.tpl${messaggi.length}` }] });
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
        await db.query(`DELETE FROM whatsapp_templates WHERE tenant_id = 1`);
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, children, phone,
                                       reservation_status, arrival_status, source, payment_status)
             VALUES (1, 'Giulia Template', NOW() + interval '3 days', 'DINNER', 3, 0, $1, 'CONFIRMED', 'WAITING', 'MANUAL', 'PENDING')
             RETURNING id`,
            [`+${CLIENTE}`]
        );
        prenotazione = Number(r.rows[0].id);
    });

    afterAll(async () => {
        await api().put('/whatsapp/settings').set(bearer(token)).send({ reminders: { quick_replies: false } });
        await api().delete('/whatsapp/meta/connect').set(bearer(token));
        await db.query(`DELETE FROM outbound_messages WHERE tenant_id = 1 AND (from_phone_digits = $1 OR to_phone_digits = $1)`, [CLIENTE]);
        await db.query(`DELETE FROM reservations WHERE id = $1`, [prenotazione]);
        await db.end();
        await new Promise<void>(resolve => meta.close(() => resolve()));
    });

    it('al collegamento il catalogo va in approvazione nell\'account del locale', async () => {
        const res = await collega();
        expect(res.status).toBe(200);
        await tutti();

        expect(creati).toHaveLength(TOTALE);
        const qr = creati.find(c => c.name === 'sympotia_booking_reminder_qr_v1' && c.language === 'it');
        expect(qr.category).toBe('UTILITY');
        const corpo = qr.components.find((c: any) => c.type === 'BODY');
        expect(corpo.text).toContain('Ti aspettiamo il {{2}} alle {{3}}: tavolo per {{4}} da {{5}}');
        expect(corpo.example.body_text[0]).toHaveLength(5);
        expect(qr.components.find((c: any) => c.type === 'BUTTONS').buttons.map((b: any) => b.type))
            .toEqual(['QUICK_REPLY', 'QUICK_REPLY', 'QUICK_REPLY']);
        expect(creati.find(c => c.name === 'sympotia_campaign_v1').category).toBe('MARKETING');
        // Niente di ciò che è solo del Frantoio.
        expect(JSON.stringify(creati)).not.toMatch(/Frantoio|0985|vecchiofrantoio/);

        expect(await statoDi('sympotia_booking_reminder_v1', 'it')).toMatchObject({ status: 'PENDING' });
        expect(await statoDi('sympotia_banquet_quote_v1', 'en')).toMatchObject({ status: 'ERROR', reason: 'Il servizio di Meta non risponde' });
    });

    it('la scheda Template: in approvazione, quello non arrivato da rimandare, niente template che su Meta non ci sono', async () => {
        const res = await api().get('/whatsapp/templates').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.provider).toBe('meta');
        const keys = res.body.templates.map((t: any) => t.key);
        expect(keys).not.toContain('TABLE_BILL_LINK');
        expect(keys).not.toContain('REVIEW_REQUEST');
        const banchetto = res.body.templates.find((t: any) => t.key === 'BANQUET_QUOTE');
        expect(banchetto.languages).toEqual([
            { language: 'it', configured: true, approval: 'pending', rejectionReason: null },
            { language: 'en', configured: true, approval: 'unsubmitted', rejectionReason: 'Il servizio di Meta non risponde' },
        ]);
    });

    it('finché non è approvato il promemoria non parte da WhatsApp', async () => {
        const dal = messaggi.length;
        await api().post(`/reservations/${prenotazione}/send-reminder`).set(bearer(token));
        await new Promise(res => setTimeout(res, 300));
        expect(mandati(dal)).toHaveLength(0);
    });

    it('approvato dal webhook, il promemoria parte col template di Meta e le variabili al loro posto', async () => {
        await decide('sympotia_booking_reminder_v1', 'it', 'APPROVED');
        const dal = messaggi.length;
        const res = await api().post(`/reservations/${prenotazione}/send-reminder`).set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.channel).toBe('whatsapp');
        const [m] = await attendiMandati(dal);
        expect(m.type).toBe('template');
        expect(m.template.name).toBe('sympotia_booking_reminder_v1');
        expect(m.template.language).toEqual({ code: 'it' });
        // Il corpo Meta è «{{1}} … {{2}} data, {{3}} ora, {{4}} ospiti»:
        // i builder li danno come 1 nome, 2 ospiti, 3 data, 4 ora.
        const params = m.template.components[0].parameters.map((p: any) => p.text);
        expect(params[0]).toBe('Giulia Template');
        expect(params[3]).toBe('3 persone');
        expect(params[2]).toMatch(/^\d{2}:\d{2}$/);
        const salvato = (await db.query(
            `SELECT provider, kind, reservation_id FROM outbound_messages WHERE tenant_id = 1 AND provider_sid = $1`, [`wamid.tpl${messaggi.length}`]
        )).rows[0];
        expect(salvato).toMatchObject({ provider: 'meta', kind: 'reminder' });
        expect(Number(salvato.reservation_id)).toBe(prenotazione);
    });

    it('i tasti del promemoria: il payload va col template, e «Ci saremo» torna sulla prenotazione giusta', async () => {
        await decide('sympotia_booking_reminder_qr_v1', 'it', 'APPROVED');
        expect((await api().put('/whatsapp/settings').set(bearer(token)).send({ reminders: { quick_replies: true } })).status).toBe(200);
        const dal = messaggi.length;
        expect((await api().post(`/reservations/${prenotazione}/send-reminder`).set(bearer(token))).status).toBe(200);
        const [m] = await attendiMandati(dal);
        expect(m.template.name).toBe('sympotia_booking_reminder_qr_v1');
        const tasti = m.template.components.filter((c: any) => c.type === 'button');
        expect(tasti.map((c: any) => [c.sub_type, c.index, c.parameters[0].payload])).toEqual([
            ['quick_reply', '0', 'rsv_confirm'], ['quick_reply', '1', 'rsv_manage'], ['quick_reply', '2', 'rsv_cancel'],
        ]);
        const wamid = `wamid.tpl${messaggi.length}`;

        const tocco = await webhook({
            object: 'whatsapp_business_account',
            entry: [{ id: WABA, changes: [{ field: 'messages', value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: NOSTRO, phone_number_id: PNID },
                contacts: [{ profile: { name: 'Giulia' }, wa_id: CLIENTE }],
                messages: [{
                    from: CLIENTE, id: `wamid.tocco${Date.now()}`, timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'button', button: { payload: 'rsv_confirm', text: 'Ci saremo' }, context: { from: NOSTRO, id: wamid },
                }],
            } }] }],
        });
        expect(tocco.status).toBe(200);
        await riga(`SELECT guest_confirmed_at FROM reservations WHERE id = $1`, [prenotazione], r => r.guest_confirmed_at != null);
    });

    it('rifiutato da Meta: la scheda dice perché, e il promemoria inglese resta sull\'italiano', async () => {
        await decide('sympotia_booking_reminder_v1', 'en', 'REJECTED', 'INVALID_FORMAT');
        const res = await api().get('/whatsapp/templates').set(bearer(token));
        const promemoria = res.body.templates.find((t: any) => t.key === 'BOOKING_REMINDER');
        expect(promemoria.languages[1]).toEqual({ language: 'en', configured: true, approval: 'rejected', rejectionReason: 'INVALID_FORMAT' });
    });

    it('il tasto della scheda rimanda solo quello che non era arrivato', async () => {
        rifiuta.clear();
        const prima = creati.length;
        const res = await api().post('/whatsapp/templates/provision').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, created: 1, existing: TOTALE - 1, failed: 0 });
        expect(creati.slice(prima).map(c => `${c.name}:${c.language}`)).toEqual(['sympotia_banquet_quote_v1:en']);
        expect(await statoDi('sympotia_banquet_quote_v1', 'en')).toMatchObject({ status: 'PENDING', reason: null });
        // Gli stati già decisi restano quelli di Meta.
        expect(await statoDi('sympotia_booking_reminder_v1', 'it')).toMatchObject({ status: 'APPROVED' });
    });

    it('scollegato e ricollegato lo stesso account: i template non si ricreano, lo stato torna da Meta', async () => {
        expect((await api().delete('/whatsapp/meta/connect').set(bearer(token))).status).toBe(200);
        expect(Number((await db.query(`SELECT COUNT(*) AS n FROM whatsapp_templates WHERE tenant_id = 1`)).rows[0].n)).toBe(0);
        const dal = messaggi.length;
        await api().post(`/reservations/${prenotazione}/send-reminder`).set(bearer(token));
        expect(mandati(dal)).toHaveLength(0);

        const prima = creati.length;
        expect((await collega()).status).toBe(200);
        await tutti();
        expect(creati.length).toBe(prima);
        expect(await statoDi('sympotia_booking_reminder_v1', 'it')).toMatchObject({ status: 'APPROVED' });
    });

    it('un webhook senza la firma giusta non cambia lo stato dei template', async () => {
        const raw = JSON.stringify({
            object: 'whatsapp_business_account',
            entry: [{ id: WABA, changes: [{ field: 'message_template_status_update', value: {
                event: 'REJECTED', message_template_name: 'sympotia_booking_reminder_v1', message_template_language: 'it', reason: 'NONE',
            } }] }],
        });
        const res = await api().post('/webhook/meta-whatsapp').set('Content-Type', 'application/json')
            .set('X-Hub-Signature-256', `sha256=${'0'.repeat(64)}`).send(raw);
        expect(res.status).toBe(403);
        expect(await statoDi('sympotia_booking_reminder_v1', 'it')).toMatchObject({ status: 'APPROVED' });
    });
});
