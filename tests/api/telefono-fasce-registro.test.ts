import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import crypto from 'crypto';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';
import { effectivePhoneMode, parsePhoneSlot, untilTonight, wallClock } from '../../utils/phoneSchedule';

// Telefono, Fase 3 (docs/telefono-piano.md): fasce orarie e interruttore
// rapido decidono chi risponde adesso; il registro tiene ogni chiamata con
// la nota di chi ha risposto e la prenotazione nata dalla chiamata.
// register-call va allo stub alla porta del server + 11, come in telefono-voce.
const AUTH_TOKEN = 'test-twilio-auth-token';
const STUB_PORT = Number(process.env.TEST_API_PORT || 3199) + 11;
const NOSTRO_NUMERO = '+390985010032';
const CELLULARE = '+393289900077';
const CLIENTE = '+393478807711';
const STUB_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://stub.example/conv"/></Connect></Response>';

const hhmm = (minutes: number) => {
    const m = ((minutes % 1440) + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
// Una fascia che contiene adesso, tutti i giorni: vicino a mezzanotte passa
// la mezzanotte, ed è provato anche quel ramo.
const slotNow = (mode: 'solo_sofia' | 'prima_locale') => {
    const { minutes } = wallClock(new Date(), 'Europe/Rome');
    return { days: [1, 2, 3, 4, 5, 6, 7], start: hhmm(minutes - 60), end: hhmm(minutes + 60), mode };
};

describe('telefono: fasce, interruttore rapido e registro', () => {
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
    const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
        let v = await read();
        for (let i = 0; i < 30 && !ok(v); i++) {
            await new Promise(res => setTimeout(res, 100));
            v = await read();
        }
        return v;
    };

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
        expect((await api().post('/customers').set(bearer(token)).send({ name: 'Ottavia Fascia', phone: CLIENTE })).status).toBe(201);
    });

    afterAll(async () => {
        // Gli altri file si aspettano Sofia subito, senza fasce né interruttore.
        await api().put('/phone/mode').set(bearer(token)).send({ mode: null });
        await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [], ring_seconds: 15, slots: [] });
        await new Promise<void>(resolve => stub.close(() => resolve()));
        await db.end();
    });

    it('chi risponde adesso: fasce, mezzanotte, interruttore', () => {
        const tz = 'Europe/Rome';
        const sera = { mode: 'prima_locale' as const, slots: [{ days: [1], start: '19:30', end: '22:30', mode: 'solo_sofia' as const }] };
        // Lunedì 12/10/2026 alle 20:00 a Roma (18:00Z): dentro la fascia.
        expect(effectivePhoneMode(sera, new Date('2026-10-12T18:00:00Z'), tz))
            .toEqual({ mode: 'solo_sofia', source: 'slot', until: '2026-10-12T20:30:00.000Z' });
        // Alle 23:00 di lunedì e alle 20:00 di martedì: regola di base.
        expect(effectivePhoneMode(sera, new Date('2026-10-12T21:00:00Z'), tz).source).toBe('base');
        expect(effectivePhoneMode(sera, new Date('2026-10-13T18:00:00Z'), tz).source).toBe('base');

        // Sabato 22:00 → 02:00: l'una di notte di domenica è ancora sabato sera.
        const notte = { mode: 'prima_locale' as const, slots: [{ days: [6], start: '22:00', end: '02:00', mode: 'solo_sofia' as const }] };
        expect(effectivePhoneMode(notte, new Date('2026-10-10T23:00:00Z'), tz).source).toBe('slot');
        expect(effectivePhoneMode(notte, new Date('2026-10-11T21:00:00Z'), tz).source).toBe('base');

        const now = new Date('2026-10-12T18:00:00Z');
        expect(effectivePhoneMode({ ...sera, override: { mode: 'prima_locale', until: '2026-10-12T19:00:00Z' } }, now, tz).source).toBe('override');
        expect(effectivePhoneMode({ ...sera, override: { mode: 'prima_locale', until: '2026-10-12T17:00:00Z' } }, now, tz).source).toBe('slot');

        // «Fino a stanotte»: le 4 del mattino dopo.
        expect(untilTonight(now, tz)).toBe('2026-10-13T02:00:00.000Z');

        expect(parsePhoneSlot({ days: [], start: '19:00', end: '22:00', mode: 'solo_sofia' })).toBeNull();
        expect(parsePhoneSlot({ days: [1], start: '19:00', end: '19:00', mode: 'solo_sofia' })).toBeNull();
        expect(parsePhoneSlot({ days: [1], start: '25:00', end: '19:00', mode: 'solo_sofia' })).toBeNull();
        expect(parsePhoneSlot({ days: [7, 1, 1, 9], start: '19:00', end: '22:00', mode: 'prima_locale' }))
            .toEqual({ days: [1, 7], start: '19:00', end: '22:00', mode: 'prima_locale' });
    });

    it('le fasce si salvano solo se ben fatte', async () => {
        const base = { mode: 'solo_sofia', mobiles: [CELLULARE], ring_seconds: 12 };
        const bad = await api().put('/settings/phone-routing').set(bearer(token)).send({ ...base, slots: [{ days: [], start: '19:00', end: '22:00', mode: 'solo_sofia' }] });
        expect(bad.status).toBe(400);
        const many = Array.from({ length: 9 }, () => slotNow('prima_locale'));
        expect((await api().put('/settings/phone-routing').set(bearer(token)).send({ ...base, slots: many })).status).toBe(400);

        const ok = await api().put('/settings/phone-routing').set(bearer(token)).send({ ...base, slots: [slotNow('prima_locale')] });
        expect(ok.status).toBe(200);
        expect(ok.body.slots).toHaveLength(1);
        expect(ok.body.effective).toMatchObject({ mode: 'prima_locale', source: 'slot' });
        // Un client senza fasce (precedente) non le cancella.
        const old = await api().put('/settings/phone-routing').set(bearer(token)).send(base);
        expect(old.body.slots).toHaveLength(1);
    });

    it('dentro una fascia «Prima il locale» squilla il locale anche con la regola «Solo Sofia»', async () => {
        const mode = await api().get('/phone/mode').set(bearer(token));
        expect(mode.status).toBe(200);
        expect(mode.body.effective).toMatchObject({ mode: 'prima_locale', source: 'slot' });
        expect(mode.body.base_mode).toBe('solo_sofia');

        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAfasce0001', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.text).toContain('<Dial timeout="12"');
        expect(res.text).toContain(`>${CELLULARE}</Number>`);
        expect((await row('CAfasce0001')).routing).toBe('prima_locale');
    });

    it("l'interruttore rapido passa a Sofia e torna da solo alla regola", async () => {
        expect((await api().put('/phone/mode').set(bearer(token)).send({ mode: 'solo_sofia', minutes: 2 })).status).toBe(400);
        expect((await api().put('/phone/mode').set(bearer(token)).send({ mode: 'altro', minutes: 60 })).status).toBe(400);

        const on = await api().put('/phone/mode').set(bearer(token)).send({ mode: 'solo_sofia', minutes: 60 });
        expect(on.status).toBe(200);
        expect(on.body.effective).toMatchObject({ mode: 'solo_sofia', source: 'override' });
        expect(Date.parse(on.body.effective.until) - Date.now()).toBeGreaterThan(55 * 60_000);

        const res = await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAfasce0002', From: CLIENTE, To: NOSTRO_NUMERO });
        expect(res.text).toContain('<Connect>');
        expect(res.text).not.toContain('<Dial');

        // Salvare la regola non spegne l'interruttore.
        await api().put('/settings/phone-routing').set(bearer(token)).send({ mode: 'solo_sofia', mobiles: [CELLULARE], ring_seconds: 12 });
        expect((await api().get('/phone/mode').set(bearer(token))).body.effective.source).toBe('override');

        const tonight = await api().put('/phone/mode').set(bearer(token)).send({ mode: 'solo_sofia', until: 'tonight' });
        expect(tonight.body.effective.source).toBe('override');

        const back = await api().put('/phone/mode').set(bearer(token)).send({ mode: null });
        expect(back.body.effective).toMatchObject({ mode: 'prima_locale', source: 'slot' });
        expect(back.body.override).toBeNull();
    });

    it('registro: risposta dal cellulare, nota e prenotazione agganciata', async () => {
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAfasce0003', From: CLIENTE, To: NOSTRO_NUMERO });
        const ok = await signed(`${webhookPath}/voice/whisper-ok?p=CAfasce0003`, { CallSid: 'CAlegf0003', To: CELLULARE, Digits: '1' });
        expect(ok.status).toBe(200);
        expect((await signed(`${webhookPath}/voice/status`, { CallSid: 'CAfasce0003', CallStatus: 'completed', CallDuration: '40' })).status).toBe(204);
        await until(() => row('CAfasce0003'), r => r.duration_seconds === 40);

        expect((await api().put('/phone/calls/nonvalida/note').set(bearer(token)).send({ note: 'x' })).status).toBe(400);
        expect((await api().put('/phone/calls/CAinesistente01/note').set(bearer(token)).send({ note: 'x' })).status).toBe(404);
        const note = await api().put('/phone/calls/CAfasce0003/note').set(bearer(token)).send({ note: '  Vuole il tavolo in veranda  ' });
        expect(note.status).toBe(200);
        expect(note.body.note).toBe('Vuole il tavolo in veranda');

        // Prenotata a mano dal «+» subito dopo, con il numero scritto come lo
        // scrive lo staff: si aggancia alla chiamata da sola.
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Ottavia Fascia', phone: '347 880 7711', reservation_time: '2027-04-17T19:30:00.000Z', shift: 'DINNER', guests: 4,
        });
        expect(created.status).toBe(201);
        expect((await row('CAfasce0003')).reservation_id).toBe(created.body.id);

        const staff = await api().get('/phone/calls?filter=staff').set(bearer(token));
        expect(staff.status).toBe(200);
        const mine = staff.body.calls.find((c: any) => c.call_sid === 'CAfasce0003');
        expect(mine).toMatchObject({
            direction: 'inbound',
            phone: CLIENTE,
            status: 'answered',
            note: 'Vuole il tavolo in veranda',
            duration_seconds: 40,
            answered_by: { kind: 'mobile', number: CELLULARE },
        });
        expect(mine.customer.name).toBe('Ottavia Fascia');
        expect(mine.reservation).toMatchObject({ id: created.body.id, guests: 4 });

        const missed = await api().get('/phone/calls?filter=missed').set(bearer(token));
        expect(missed.body.calls.some((c: any) => c.call_sid === 'CAfasce0003')).toBe(false);
        expect((await api().get('/phone/calls?q=veranda').set(bearer(token))).body.calls.map((c: any) => c.call_sid)).toContain('CAfasce0003');
        expect((await api().get('/phone/calls?q=880%207711').set(bearer(token))).body.calls.map((c: any) => c.call_sid)).toContain('CAfasce0003');
        expect((await api().get('/phone/calls?filter=boh').set(bearer(token))).status).toBe(400);
    });

    it('la nota torna nella card quando lo stesso numero richiama', async () => {
        await signed(`${webhookPath}/voice/inbound`, { CallSid: 'CAfasce0004', From: CLIENTE, To: NOSTRO_NUMERO });
        const live = await until(
            async () => ((await api().get('/phone/live').set(bearer(token))).body.calls as any[]).find(c => c.id === 'CAfasce0004'),
            c => !!c,
        );
        expect(live.card.last_note.text).toBe('Vuole il tavolo in veranda');
    });

    it('«Nuova prenotazione» dalla card aggancia la prenotazione alla chiamata', async () => {
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Ottavia Fascia', phone: '+39 347 880 7711', reservation_time: '2027-05-08T19:30:00.000Z', shift: 'DINNER', guests: 2,
        });
        expect(created.status).toBe(201);
        expect((await api().post('/phone/calls/CAfasce0004/reservation').set(bearer(token)).send({ reservation_id: 'x' })).status).toBe(400);
        expect((await api().post('/phone/calls/CAinesistente01/reservation').set(bearer(token)).send({ reservation_id: created.body.id })).status).toBe(404);
        const linked = await api().post('/phone/calls/CAfasce0004/reservation').set(bearer(token)).send({ reservation_id: created.body.id });
        expect(linked.status).toBe(200);
        expect((await row('CAfasce0004')).reservation_id).toBe(created.body.id);
    });
});
