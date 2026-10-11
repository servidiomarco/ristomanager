import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// WhatsApp, Fase 8: il promemoria coi tasti «Ci saremo», «Devo modificare»,
// «Annulla» (services/whatsapp/buttons.ts) e «Farsi trovare».
//
// I tasti rispondono al cliente, quindi serve un mittente WhatsApp: gira
// nello stesso passo a parte del test delle azioni, con TWILIO_WHATSAPP_FROM
// e le SID finte del promemoria, e le API Twilio sullo stub di questo file
// (porta del server + 12). Non serve l'AI: i tasti funzionano senza.
//   TWILIO_WHATSAPP_FROM=+393895916494 TWILIO_WA_CONTENT_SID_BOOKING_REMINDER=HXtestplain \
//   TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_QR=HXtestqr npx vitest run tests/api/whatsapp-tasti.test.ts

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const REST_PORT = Number(process.env.TEST_API_PORT || 3199) + 12;
const N = {
    promemoria: '3391188401',
    estraneo: '3391188402',
    tardi: '3391188403',
};

const giornoFra = (days: number): string => {
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const [y, m, d] = oggi.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

describe.runIf(!!process.env.TWILIO_WHATSAPP_FROM && process.env.TWILIO_WA_CONTENT_SID_BOOKING_REMINDER_QR === 'HXtestqr')('WhatsApp: i tasti del promemoria', () => {
    let twilio: http.Server;
    const inviati: Array<Record<string, string>> = [];
    let db: Client;
    let token = '';
    let sid = 0;

    const inbound = (numero: string, body: string, extra: Record<string, string> = {}) => {
        const params: Record<string, string> = {
            From: `whatsapp:+39${numero}`, To: NOSTRO, Body: body, NumMedia: '0',
            MessageSid: `SMtasti${Date.now()}${sid++}`, ...extra,
        };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    /** I messaggi mandati al numero dopo `dal`, aspettando che arrivino. */
    const risposteA = async (numero: string, dal: number, almeno = 1, ms = 4000) => {
        const deadline = Date.now() + ms;
        for (;;) {
            const r = inviati.slice(dal).filter(m => m.To === `whatsapp:+39${numero}`);
            if (r.length >= almeno || Date.now() > deadline) return r;
            await new Promise(res => setTimeout(res, 100));
        }
    };
    const prenotazione = async (id: number) => (await db.query(`SELECT * FROM reservations WHERE id = $1`, [id])).rows[0];
    const inAgenda = async (numero: string, quando: string) => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, children, phone,
                                       reservation_status, arrival_status, source, payment_status)
             VALUES (1, $1, ${quando}, 'DINNER', 2, 0, $2, 'CONFIRMED', 'WAITING', 'MANUAL', 'PENDING')
             RETURNING id`,
            [`Cliente ${numero}`, `+39${numero}`]
        );
        return Number(r.rows[0].id);
    };
    const impostazioni = (body: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send(body);

    beforeAll(async () => {
        twilio = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                const form = Object.fromEntries(new URLSearchParams(body));
                const sidOut = `SMstubtasti${inviati.length}${Date.now()}`;
                inviati.push({ ...form, _sid: sidOut });
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: sidOut, status: 'queued' }));
            });
        });
        await new Promise<void>(resolve => twilio.listen(REST_PORT, '127.0.0.1', () => resolve()));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
    });

    afterAll(async () => {
        await impostazioni({ reminders: { quick_replies: false }, entry: { show_on_booking_page: false } });
        await new Promise<void>(resolve => twilio.close(() => resolve()));
        await db.end();
    });

    it('le impostazioni: tasti e «Farsi trovare» spenti di serie, valori sbagliati rifiutati', async () => {
        const g = await api().get('/whatsapp/settings').set(bearer(token));
        expect(g.body).toMatchObject({
            reminders: { quick_replies: false },
            entry: { show_on_booking_page: false, show_on_menu: false, prefill_text: '' },
        });
        expect((await impostazioni({ reminders: { quick_replies: 'sì' } })).status).toBe(400);
        expect((await impostazioni({ entry: { prefill_text: 'x'.repeat(201) } })).status).toBe(400);
        // Una sezione non tocca le altre.
        const r = await impostazioni({ entry: { prefill_text: '  Ciao,   un tavolo per stasera? ' } });
        expect(r.status).toBe(200);
        expect(r.body.entry.prefill_text).toBe('Ciao, un tavolo per stasera?');
        expect(r.body.agent.mode).toBe('off');
    });

    it('«Farsi trovare»: /prenota mostra il link wa.me solo se acceso', async () => {
        expect((await api().get('/public/contact')).body.whatsapp).toBeNull();
        await impostazioni({ entry: { show_on_booking_page: true } });
        const c = await api().get('/public/contact');
        expect(c.body.whatsapp).toEqual({
            url: `https://wa.me/393895916494?text=${encodeURIComponent('Ciao, un tavolo per stasera?')}`,
            display: '+39 389 591 6494',
        });
    });

    it('il promemoria: con l\'interruttore acceso parte il template coi tasti', async () => {
        const id = await inAgenda(N.promemoria, `NOW() + interval '3 days'`);
        let dal = inviati.length;
        expect((await api().post(`/reservations/${id}/send-reminder`).set(bearer(token))).status).toBe(200);
        expect((await risposteA(N.promemoria, dal))[0].ContentSid).toBe('HXtestplain');

        await impostazioni({ reminders: { quick_replies: true } });
        dal = inviati.length;
        expect((await api().post(`/reservations/${id}/send-reminder`).set(bearer(token))).status).toBe(200);
        const [qr] = await risposteA(N.promemoria, dal);
        expect(qr.ContentSid).toBe('HXtestqr');
        expect(Object.keys(JSON.parse(qr.ContentVariables))).toEqual(['1', '2', '3', '4', '5']);
    });

    it('«Ci saremo» segna la conferma e ringrazia; il tasto si ritrova dal messaggio a cui risponde', async () => {
        const id = (await db.query(`SELECT id FROM reservations WHERE phone = $1`, [`+39${N.promemoria}`])).rows[0].id;
        const promemoria = (await db.query(
            `SELECT provider_sid FROM outbound_messages WHERE reservation_id = $1 AND direction = 'outbound' ORDER BY id DESC LIMIT 1`, [id]
        )).rows[0].provider_sid;
        const dal = inviati.length;
        await inbound(N.promemoria, 'Ci saremo', { ButtonPayload: 'rsv_confirm', ButtonText: 'Ci saremo', OriginalRepliedMessageSid: promemoria });
        const [grazie] = await risposteA(N.promemoria, dal);
        expect(grazie.Body).toMatch(/^Grazie! Ti aspettiamo .+ alle \d{2}:\d{2}\.$/);
        expect((await prenotazione(id)).guest_confirmed_at).not.toBeNull();
    });

    it('«Annulla» in due tempi: «Confermi?», poi al «sì» annulla come la pagina dell\'ospite', async () => {
        const id = (await db.query(`SELECT id FROM reservations WHERE phone = $1`, [`+39${N.promemoria}`])).rows[0].id;
        const promemoria = (await db.query(
            `SELECT provider_sid FROM outbound_messages WHERE reservation_id = $1 AND direction = 'outbound' AND kind = 'reminder' ORDER BY id DESC LIMIT 1`, [id]
        )).rows[0].provider_sid;
        let dal = inviati.length;
        await inbound(N.promemoria, 'Annulla', { ButtonPayload: 'rsv_cancel', ButtonText: 'Annulla', OriginalRepliedMessageSid: promemoria });
        expect((await risposteA(N.promemoria, dal))[0].Body).toMatch(/^Confermi che annulli la prenotazione di .+\? Rispondi «sì» per annullare\.$/);
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');

        dal = inviati.length;
        await inbound(N.promemoria, 'Sì');
        expect((await risposteA(N.promemoria, dal))[0].Body).toMatch(/^Fatto: la prenotazione di .+ è annullata\./);
        const annullata = await prenotazione(id);
        expect(annullata.reservation_status).toBe('CANCELLED');
        expect(annullata.guest_cancelled_at).not.toBeNull();
    });

    it('il tasto di una prenotazione di un altro numero non tocca niente', async () => {
        const id = await inAgenda(N.promemoria, `NOW() + interval '4 days'`);
        const guestToken = 'TastiTokenDiProva1234567';
        await db.query(`UPDATE reservations SET guest_token = $1 WHERE id = $2`, [guestToken, id]);
        const dal = inviati.length;
        await inbound(N.estraneo, 'Annulla', { ButtonPayload: `rsv_cancel:${guestToken}`, ButtonText: 'Annulla' });
        expect(await risposteA(N.estraneo, dal, 1, 800)).toHaveLength(0);
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');

        // Lo stesso tasto dal numero giusto, col token: chiede conferma.
        await inbound(N.promemoria, 'Annulla', { ButtonPayload: `rsv_cancel:${guestToken}`, ButtonText: 'Annulla' });
        expect((await risposteA(N.promemoria, dal))[0].Body).toMatch(/^Confermi che annulli/);
        // Un «no» la lascia com'è.
        const dopo = inviati.length;
        await inbound(N.promemoria, 'No');
        expect((await risposteA(N.promemoria, dopo))[0].Body).toMatch(/resta com'è/);
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');
    });

    it('troppo vicina: «Annulla» dice di chiamare; «Devo modificare» senza agente risponde una persona', async () => {
        const id = await inAgenda(N.tardi, `NOW() + interval '1 hour'`);
        const guestToken = 'TastiTokenTardi123456789';
        await db.query(`UPDATE reservations SET guest_token = $1 WHERE id = $2`, [guestToken, id]);
        let dal = inviati.length;
        await inbound(N.tardi, 'Annulla', { ButtonPayload: `rsv_cancel:${guestToken}`, ButtonText: 'Annulla' });
        expect((await risposteA(N.tardi, dal))[0].Body).toMatch(/^Mancano meno di \d+ ore: per annullare chiamaci/);
        expect((await prenotazione(id)).reservation_status).toBe('CONFIRMED');

        dal = inviati.length;
        await inbound(N.tardi, 'Devo modificare', { ButtonPayload: `rsv_manage:${guestToken}`, ButtonText: 'Devo modificare' });
        expect((await risposteA(N.tardi, dal))[0].Body).toMatch(/ti risponde una persona del locale/);
    });
});
