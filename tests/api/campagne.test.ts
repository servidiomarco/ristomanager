import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import http from 'node:http';
import { Client } from 'pg';
import { api, ownerToken, bearer } from './helpers';

// WhatsApp, Fase 11: le campagne (services/whatsapp/campaigns/).
//
// Mandano messaggi, quindi girano nel passo col mittente finto
// (TWILIO_WHATSAPP_FROM) e con la SID finta del template della campagna
// (TWILIO_WA_CONTENT_SID_CAMPAIGN). Twilio è lo stub di questo file sulla
// porta del server + 12; lo sweep gira ogni 300 ms (globalSetup).

const AUTH_TOKEN = 'test-twilio-auth-token';
const NOSTRO = 'whatsapp:+393895916494';
const REST_PORT = Number(process.env.TEST_API_PORT || 3199) + 12;
// I clienti della prova: chi ha il consenso e chi no, per ogni motivo.
const C = {
    vip: { name: 'Anna Campagna', phone: '+393391188701' },
    nuovo: { name: 'Bruno Campagna', phone: '+393391188702' },
    revocato: { name: 'Carla Campagna', phone: '+393391188703' },
    blacklist: { name: 'Dario Campagna', phone: '+393391188704' },
    noshow: { name: 'Elena Campagna', phone: '+393391188705' },
    senza: { name: 'Franco Campagna', phone: '+393391188706' },
};

describe.runIf(!!process.env.TWILIO_WHATSAPP_FROM && process.env.TWILIO_WA_CONTENT_SID_CAMPAIGN === 'HXtestcampaign')('WhatsApp: le campagne', () => {
    let twilio: http.Server;
    const inviati: Array<Record<string, string>> = [];
    let db: Client;
    let token = '';
    let sid = 0;
    let campagnaId = 0;

    const impostazioni = (body: Record<string, unknown>) => api().put('/whatsapp/settings').set(bearer(token)).send(body);
    const cliente = async (c: { name: string; phone: string }, extra: { consent?: boolean | null; vip?: boolean; blacklisted?: boolean; optOut?: boolean } = {}) =>
        Number((await db.query(
            `INSERT INTO customers (tenant_id, name, phone, consent_marketing, is_vip, is_blacklisted, marketing_opt_out_at)
             VALUES (1, $1, $2, $3, $4, $5, CASE WHEN $6 THEN NOW() ELSE NULL END) RETURNING id`,
            [c.name, c.phone, extra.consent ?? true, extra.vip ?? false, extra.blacklisted ?? false, extra.optOut ?? false]
        )).rows[0].id);
    const prenotazione = async (phone: string, giorniFa: number, status = 'CONFIRMED') =>
        db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, reservation_status, arrival_status, source, payment_status)
             VALUES (1, 'Storico Campagna', NOW() - ($2::int * interval '1 day'), 'DINNER', 2, $1, $3, 'DEPARTED', 'MANUAL', 'PENDING')`,
            [phone, giorniFa, status]
        );
    const inbound = (phone: string, body: string, extra: Record<string, string> = {}) => {
        const params: Record<string, string> = { From: `whatsapp:${phone}`, To: NOSTRO, Body: body, NumMedia: '0', MessageSid: `SMcamp${Date.now()}${sid++}`, ...extra };
        const url = `${process.env.TEST_BASE_URL}/webhook/twilio-whatsapp`;
        const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
        const signature = crypto.createHmac('sha1', AUTH_TOKEN).update(data).digest('base64');
        return api().post('/webhook/twilio-whatsapp').set('X-Twilio-Signature', signature).type('form').send(params);
    };
    const finoA = async (cond: () => Promise<boolean>, ms = 6000) => {
        const deadline = Date.now() + ms;
        while (!(await cond())) {
            if (Date.now() > deadline) throw new Error('condizione non raggiunta');
            await new Promise(res => setTimeout(res, 150));
        }
    };

    beforeAll(async () => {
        twilio = http.createServer((req, res) => {
            let body = '';
            req.on('data', c => { body += c; });
            req.on('end', () => {
                inviati.push(Object.fromEntries(new URLSearchParams(body)));
                res.writeHead(201, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ sid: `SMstubcamp${inviati.length}${Date.now()}`, status: 'queued' }));
            });
        });
        await new Promise<void>(resolve => twilio.listen(REST_PORT, '127.0.0.1', () => resolve()));
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        token = await ownerToken();
        await api().put('/settings/entitlements').set(bearer(token)).send({ whatsapp: true });
        await cliente(C.vip, { vip: true });
        for (const d of [10, 40, 80]) await prenotazione(C.vip.phone, d);
        await cliente(C.nuovo);
        await cliente(C.revocato, { optOut: true });
        await cliente(C.blacklist, { blacklisted: true });
        await cliente(C.noshow);
        await prenotazione(C.noshow.phone, 20, 'NO_SHOW');
        await cliente(C.senza, { consent: false });
    });

    afterAll(async () => {
        await impostazioni({ campaigns: { enabled: false, send_from_hour: 10, send_to_hour: 21 } });
        await new Promise<void>(resolve => twilio.close(() => resolve()));
        await db.end();
    });

    it('le regole: spente di serie, una fascia rovesciata si rifiuta', async () => {
        const g = await api().get('/whatsapp/settings').set(bearer(token));
        expect(g.body.campaigns).toMatchObject({ enabled: false, send_from_hour: 10, send_to_hour: 21, pause_days: 7 });
        expect((await impostazioni({ campaigns: { send_from_hour: 20, send_to_hour: 9 } })).status).toBe(400);
    });

    it('il consenso dato dallo staff sulla prenotazione entra nel registro', async () => {
        const r = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Gino Consenso', phone: '+393391188707', reservation_time: '2027-06-10T20:00:00',
            shift: 'DINNER', guests: 2, children: 0, consent_marketing: true,
        });
        expect(r.status).toBe(201);
        await finoA(async () => (await db.query(`SELECT 1 FROM consent_events WHERE phone_digits = '3391188707' AND value AND source = 'staff'`)).rowCount === 1);
        // Lo stesso sì una seconda volta non riempie il registro.
        await api().put(`/reservations/${r.body.id}`).set(bearer(token)).send({ ...r.body, consent_marketing: true });
        expect((await db.query(`SELECT count(*)::int AS n FROM consent_events WHERE phone_digits = '3391188707'`)).rows[0].n).toBe(1);
    });

    it('i segmenti: solo chi ha il consenso, e mai revocati, blacklist o no-show recenti', async () => {
        const vip = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: { vip_only: true } });
        expect(vip.body).toMatchObject({ count: 1, sample: ['Anna Campagna'] });
        const fedeli = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: { min_visits: 3 } });
        expect(fedeli.body.sample).toEqual(['Anna Campagna']);
        const tornare = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: { last_visit_days_min: 30 } });
        expect(tornare.body.count).toBe(0); // Anna è venuta 10 giorni fa
        const tutti = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: {} });
        const nomi: string[] = tutti.body.sample;
        expect(nomi).toEqual(expect.arrayContaining(['Anna Campagna', 'Bruno Campagna']));
        for (const n of ['Carla Campagna', 'Dario Campagna', 'Elena Campagna', 'Franco Campagna']) expect(nomi).not.toContain(n);
        expect(tutti.body.estimated_cost_cents).toBeGreaterThan(0);
    });

    it('la campagna parte solo con le campagne accese e la cifra confermata, poi arriva a tutti', async () => {
        const c = await api().post('/whatsapp/campaigns').set(bearer(token)).send({
            name: 'Prova VIP', message: 'venerdì cena al tartufo, rispondi qui per prenotare.', segment: { vip_only: true },
        });
        expect(c.status).toBe(201);
        campagnaId = c.body.campaign.id;
        const costo = c.body.campaign.estimated_cost_cents;
        expect(c.body.campaign).toMatchObject({ status: 'draft', recipients_count: 1 });

        const spente = await api().post(`/whatsapp/campaigns/${campagnaId}/start`).set(bearer(token)).send({ confirm_cost_cents: costo });
        expect(spente.body.error).toBe('campaigns_disabled');
        await impostazioni({ campaigns: { enabled: true, send_from_hour: 0, send_to_hour: 24 } });
        const sbagliata = await api().post(`/whatsapp/campaigns/${campagnaId}/start`).set(bearer(token)).send({ confirm_cost_cents: costo + 1 });
        expect(sbagliata.body.error).toBe('estimate_changed');

        const dal = inviati.length;
        const via = await api().post(`/whatsapp/campaigns/${campagnaId}/start`).set(bearer(token)).send({ confirm_cost_cents: costo });
        expect(via.body).toMatchObject({ ok: true, recipients: 1 });
        await finoA(async () => (await db.query(`SELECT status FROM campaigns WHERE id = $1`, [campagnaId])).rows[0].status === 'done');
        const msg = inviati.slice(dal).find(m => m.To === `whatsapp:${C.vip.phone}`)!;
        expect(msg.ContentSid).toBe('HXtestcampaign');
        expect(JSON.parse(msg.ContentVariables)).toMatchObject({ '1': 'Anna', '3': 'venerdì cena al tartufo, rispondi qui per prenotare.' });
        const riga = (await db.query(`SELECT kind FROM outbound_messages WHERE to_phone_digits = '393391188701' ORDER BY id DESC LIMIT 1`)).rows[0];
        expect(riga.kind).toBe('campaign');
    });

    it('allo stesso numero non arriva una seconda campagna entro la pausa', async () => {
        const p = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: { vip_only: true } });
        expect(p.body.count).toBe(0);
    });

    it('«STOP» revoca il consenso, risponde, e la campagna dopo non lo raggiunge', async () => {
        const dal = inviati.length;
        await inbound(C.nuovo.phone, 'STOP');
        await finoA(async () => inviati.slice(dal).some(m => m.To === `whatsapp:${C.nuovo.phone}`));
        expect(inviati.slice(dal).find(m => m.To === `whatsapp:${C.nuovo.phone}`)!.Body).toMatch(/^Fatto: non riceverai più promozioni/);
        const c = (await db.query(`SELECT consent_marketing, marketing_opt_out_at FROM customers WHERE phone = $1`, [C.nuovo.phone])).rows[0];
        expect(c.consent_marketing).toBe(false);
        expect(c.marketing_opt_out_at).not.toBeNull();
        expect((await db.query(`SELECT source FROM consent_events WHERE phone_digits = '3391188702' ORDER BY id DESC LIMIT 1`)).rows[0].source).toBe('whatsapp_stop');
        const tutti = await api().post('/whatsapp/campaigns/preview').set(bearer(token)).send({ segment: {} });
        expect(tutti.body.sample).not.toContain('Bruno Campagna');
    });

    it('la lista mostra i conteggi e cosa serve per mandare', async () => {
        const l = await api().get('/whatsapp/campaigns').set(bearer(token));
        const mia = l.body.campaigns.find((c: any) => c.id === campagnaId);
        expect(mia).toMatchObject({ status: 'done', sent: 1, waiting: 0 });
        expect(l.body.readiness).toMatchObject({ enabled: true, legal_ok: true, template_ready: true });
    });
});
