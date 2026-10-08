import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
    normalizeBookingReminderPolicy,
    zonedWallTimeToInstant,
    reminderSendAt,
    decideBookingReminder,
    bookingReminderFailureDigest,
    BOOKING_REMINDER_CANDIDATES_SQL,
    CLAIM_BOOKING_REMINDER_SQL,
    FINISH_BOOKING_REMINDER_SQL,
    DEFAULT_BOOKING_REMINDER_POLICY,
    type BookingReminderPolicy,
} from '../../services/bookingReminders';
import { api, ownerToken, bearer } from './helpers';

// Promemoria automatico all'ospite (services/bookingReminders.ts).
//
// Tre parti, come per la richiesta di recensione: la decisione «quando»
// (pura, qui con gli orari veri del cambio d'ora), le query di presa in
// carico ed esito eseguite contro Postgres — l'incidente del 18-19/09 è
// nato da una UPDATE che falliva solo a contatto col database — e le rotte
// delle impostazioni.

const ROME = 'Europe/Rome';
const giornoPrima: BookingReminderPolicy = { enabled: true, timing: 'day_before', day_before_time: '11:00', hours_before: 24 };
const treOrePrima: BookingReminderPolicy = { enabled: true, timing: 'hours_before', day_before_time: '11:00', hours_before: 3 };
const ore = (n: number) => n * 3600_000;

describe('promemoria automatico — policy', () => {
    it('accetta le due modalità nei loro limiti', () => {
        expect(normalizeBookingReminderPolicy(giornoPrima)).toEqual(giornoPrima);
        expect(normalizeBookingReminderPolicy({ ...treOrePrima, hours_before: 48 })).not.toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, day_before_time: '09:00' })).not.toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, day_before_time: '20:00' })).not.toBeNull();
    });

    it('rifiuta orari fuori finestra, ore fuori limite e campi malformati', () => {
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, day_before_time: '08:59' })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, day_before_time: '20:01' })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, day_before_time: '9:00' })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...treOrePrima, hours_before: 1 })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...treOrePrima, hours_before: 49 })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...treOrePrima, hours_before: 2.5 })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, timing: 'settimana_prima' })).toBeNull();
        expect(normalizeBookingReminderPolicy({ ...giornoPrima, enabled: 'si' })).toBeNull();
        expect(normalizeBookingReminderPolicy(null)).toBeNull();
    });

    it('di serie è spenta', () => {
        expect(DEFAULT_BOOKING_REMINDER_POLICY.enabled).toBe(false);
    });
});

describe('promemoria automatico — orologio del ristorante', () => {
    it("converte l'ora di Roma in istante, d'estate e d'inverno", () => {
        expect(zonedWallTimeToInstant('2026-10-09', '11:00', ROME).toISOString()).toBe('2026-10-09T09:00:00.000Z');
        expect(zonedWallTimeToInstant('2026-12-10', '11:00', ROME).toISOString()).toBe('2026-12-10T10:00:00.000Z');
        expect(zonedWallTimeToInstant('2026-10-09', '11:00', 'Europe/London').toISOString()).toBe('2026-10-09T10:00:00.000Z');
    });

    it("regge i giorni del cambio d'ora", () => {
        // 25/10/2026: alle 3 si torna alle 2, alle 11 è già ora solare.
        expect(zonedWallTimeToInstant('2026-10-25', '11:00', ROME).toISOString()).toBe('2026-10-25T10:00:00.000Z');
        // 29/03/2026: alle 2 si passa alle 3, alle 11 è già ora legale.
        expect(zonedWallTimeToInstant('2026-03-29', '11:00', ROME).toISOString()).toBe('2026-03-29T09:00:00.000Z');
    });

    it('il giorno prima alle 11 della cena di lunedì 26/10 cade domenica alle 11 solari', () => {
        const cena = new Date('2026-10-26T19:00:00Z'); // 20:00 a Roma
        expect(reminderSendAt(cena, giornoPrima, ROME).toISOString()).toBe('2026-10-25T10:00:00.000Z');
        // A cavallo del mese: la cena del 1/11 si ricorda il 31/10.
        const novembre = new Date('2026-11-01T19:00:00Z');
        expect(reminderSendAt(novembre, giornoPrima, ROME).toISOString()).toBe('2026-10-31T10:00:00.000Z');
    });

    it('«ore prima» conta dall\'orario della prenotazione', () => {
        const cena = new Date('2026-10-09T18:30:00Z');
        expect(reminderSendAt(cena, treOrePrima, ROME).toISOString()).toBe('2026-10-09T15:30:00.000Z');
    });
});

describe('promemoria automatico — quando partire', () => {
    // Cena di venerdì 9/10 alle 20:30 di Roma, prenotata il lunedì.
    const cena = new Date('2026-10-09T18:30:00Z');
    const prenotataLunedi = new Date('2026-10-05T10:00:00Z');
    const decidi = (now: string, opts: Partial<{ lastContactAt: Date | null; policy: BookingReminderPolicy; reservationTime: Date }> = {}) =>
        decideBookingReminder({
            now: new Date(now),
            reservationTime: opts.reservationTime ?? cena,
            lastContactAt: opts.lastContactAt === undefined ? prenotataLunedi : opts.lastContactAt,
            policy: opts.policy ?? giornoPrima,
            tz: ROME,
        });

    it('aspetta fino al giorno prima alle 11, poi parte', () => {
        expect(decidi('2026-10-08T08:59:00Z')).toBe('wait');   // 10:59 a Roma
        expect(decidi('2026-10-08T09:00:00Z')).toBe('send');   // 11:00
        expect(decidi('2026-10-08T15:00:00Z')).toBe('send');   // in ritardo ma utile
    });

    it('salta chi ha prenotato o ricevuto la conferma da meno di 12 ore', () => {
        // Prenotata alle 2 di notte del giorno prima: 9 ore prima dell'invio.
        expect(decidi('2026-10-08T09:00:00Z', { lastContactAt: new Date('2026-10-08T00:00:00Z') })).toBe('skipped_recent_booking');
        // Prenotata la sera prima ancora: 14 ore prima, il promemoria serve.
        expect(decidi('2026-10-08T09:00:00Z', { lastContactAt: new Date('2026-10-07T19:00:00Z') })).toBe('send');
        // Senza data di creazione (righe storiche) non si salta.
        expect(decidi('2026-10-08T09:00:00Z', { lastContactAt: null })).toBe('send');
    });

    it("a meno di un'ora dall'arrivo è troppo tardi", () => {
        expect(decidi('2026-10-09T17:45:00Z')).toBe('skipped_too_late');
    });

    it('fuori dalla finestra 9–21 aspetta la mattina', () => {
        // «24 ore prima» di una cena alle 22:00: cadrebbe alle 22 della sera prima.
        const tardi = new Date('2026-10-09T20:00:00Z');
        const ventiquattro: BookingReminderPolicy = { ...treOrePrima, hours_before: 24 };
        expect(decidi('2026-10-08T20:05:00Z', { reservationTime: tardi, policy: ventiquattro })).toBe('wait'); // 22:05
        expect(decidi('2026-10-09T06:59:00Z', { reservationTime: tardi, policy: ventiquattro })).toBe('wait'); // 8:59
        expect(decidi('2026-10-09T07:00:00Z', { reservationTime: tardi, policy: ventiquattro })).toBe('send'); // 9:00
    });

    it("l'avviso dei non partiti dice chi e perché", () => {
        expect(bookingReminderFailureDigest([{ customerName: 'Rossi', error: 'Twilio 21211' }]))
            .toEqual({ title: '1 promemoria non partito', body: 'Rossi (Twilio 21211)' });
        const d = bookingReminderFailureDigest([
            { customerName: 'Rossi', error: null },
            { customerName: '', error: 'x' },
            { customerName: 'Verdi', error: 'y' },
            { customerName: 'Neri', error: 'z' },
        ]);
        expect(d.title).toBe('4 promemoria non partiti');
        expect(d.body).toBe('Rossi, cliente senza nome (x), Verdi (y) e altri 1');
    });
});

describe('promemoria automatico — presa in carico ed esito sul database', () => {
    const TENANT = 1;
    let db: Client;

    const nuovaPrenotazione = async (offsetHours: number): Promise<{ id: number; time: Date }> => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, payment_status, reservation_status, arrival_status)
             VALUES ($1, 'Collaudo Promemoria', date_trunc('minute', NOW()) + make_interval(mins => $2), 'DINNER', 2, '+393331112299', 'NONE', 'CONFIRMED', 'WAITING')
             RETURNING id, reservation_time`,
            [TENANT, Math.round(offsetHours * 60)]
        );
        return { id: Number(r.rows[0].id), time: new Date(r.rows[0].reservation_time) };
    };
    const stato = async (id: number) => (await db.query(
        `SELECT auto_reminder_status, auto_reminder_channel, auto_reminder_for, auto_reminder_sent_at,
                auto_reminder_failed_at, auto_reminder_error, reminder_sent
           FROM reservations WHERE id = $1`, [id])).rows[0];

    beforeAll(async () => {
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        await db.query(`DELETE FROM reservations WHERE customer_name = 'Collaudo Promemoria' AND tenant_id = $1`, [TENANT]);
        await db.end();
    });

    it('lo sweep guarda solo le confermate fra un\'ora e 72 ore, non ancora valutate', async () => {
        const domani = await nuovaPrenotazione(30);
        const subito = await nuovaPrenotazione(0.5);
        const lontana = await nuovaPrenotazione(100);
        const annullata = await nuovaPrenotazione(30);
        await db.query(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE id = $1`, [annullata.id]);
        const inCorso = await nuovaPrenotazione(30);
        await db.query(CLAIM_BOOKING_REMINDER_SQL, [inCorso.id, TENANT, inCorso.time.toISOString()]);

        const res = await db.query(BOOKING_REMINDER_CANDIDATES_SQL);
        const ids = res.rows.map((r: any) => Number(r.id));
        expect(ids).toContain(domani.id);
        for (const fuori of [subito.id, lontana.id, annullata.id, inCorso.id]) expect(ids).not.toContain(fuori);
        const riga = res.rows.find((r: any) => Number(r.id) === domani.id);
        expect(Number(riga.tenant_id)).toBe(TENANT);
        expect(riga.phone).toBe('+393331112299');
    });

    it('la presa in carico riesce una volta sola', async () => {
        const { id, time } = await nuovaPrenotazione(30);
        expect((await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, time.toISOString()])).rowCount).toBe(1);
        expect((await stato(id)).auto_reminder_status).toBe('sending');
        expect((await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, time.toISOString()])).rowCount).toBe(0);
    });

    it("non prende in carico se nel frattempo l'orario è cambiato", async () => {
        const { id, time } = await nuovaPrenotazione(30);
        const vecchio = new Date(time.getTime() - ore(1));
        expect((await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, vecchio.toISOString()])).rowCount).toBe(0);
        expect((await stato(id)).auto_reminder_status).toBeNull();
    });

    it("l'invio riuscito segna esito, canale, orario e la campanella del promemoria", async () => {
        const { id, time } = await nuovaPrenotazione(30);
        await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, time.toISOString()]);
        const fine = await db.query(FINISH_BOOKING_REMINDER_SQL, ['sent', 'whatsapp', null, id, TENANT]);
        expect(fine.rowCount).toBe(1);
        expect(Number(fine.rows[0].id)).toBe(id);
        const riga = await stato(id);
        expect(riga.auto_reminder_status).toBe('sent');
        expect(riga.auto_reminder_channel).toBe('whatsapp');
        expect(riga.auto_reminder_sent_at).not.toBeNull();
        expect(riga.reminder_sent).toBe(true);
        expect(new Date(riga.auto_reminder_for).getTime()).toBe(time.getTime());
    });

    it('gli esiti saltati e falliti non accendono la campanella', async () => {
        const saltata = await nuovaPrenotazione(30);
        await db.query(CLAIM_BOOKING_REMINDER_SQL, [saltata.id, TENANT, saltata.time.toISOString()]);
        await db.query(FINISH_BOOKING_REMINDER_SQL, ['skipped_recent_booking', null, null, saltata.id, TENANT]);
        const s = await stato(saltata.id);
        expect(s.auto_reminder_status).toBe('skipped_recent_booking');
        expect(s.reminder_sent).toBe(false);
        expect(s.auto_reminder_sent_at).toBeNull();

        const fallita = await nuovaPrenotazione(30);
        await db.query(CLAIM_BOOKING_REMINDER_SQL, [fallita.id, TENANT, fallita.time.toISOString()]);
        await db.query(FINISH_BOOKING_REMINDER_SQL, ['failed', null, 'Twilio 21211', fallita.id, TENANT]);
        const f = await stato(fallita.id);
        expect(f.auto_reminder_error).toBe('Twilio 21211');
        expect(f.auto_reminder_failed_at).not.toBeNull();
        expect(f.reminder_sent).toBe(false);
    });

    it("l'esito non tocca una riga che nessuno ha preso in carico", async () => {
        const { id } = await nuovaPrenotazione(30);
        const fine = await db.query(FINISH_BOOKING_REMINDER_SQL, ['sent', 'sms', null, id, TENANT]);
        expect(fine.rowCount).toBe(0);
        expect((await stato(id)).reminder_sent).toBe(false);
    });

    it('spostata di giorno torna da valutare; spostata di mezz\'ora no', async () => {
        const { id, time } = await nuovaPrenotazione(30);
        await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, time.toISOString()]);
        await db.query(FINISH_BOOKING_REMINDER_SQL, ['sent', 'sms', null, id, TENANT]);

        const mezzora = new Date(time.getTime() + 30 * 60_000);
        await db.query(`UPDATE reservations SET reservation_time = $1 WHERE id = $2`, [mezzora.toISOString(), id]);
        expect((await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, mezzora.toISOString()])).rowCount).toBe(0);

        const domani = new Date(time.getTime() + ore(24));
        await db.query(`UPDATE reservations SET reservation_time = $1 WHERE id = $2`, [domani.toISOString(), id]);
        expect((await db.query(CLAIM_BOOKING_REMINDER_SQL, [id, TENANT, domani.toISOString()])).rowCount).toBe(1);
        expect(new Date((await stato(id)).auto_reminder_for).getTime()).toBe(domani.getTime());
    });
});

describe('promemoria automatico — impostazioni', () => {
    let owner: string;
    let db: Client;
    const createdUserIds: number[] = [];

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
    });

    afterAll(async () => {
        // Torna al default: il resto della suite non deve trovarsi promemoria accesi.
        await db.query(`DELETE FROM app_settings WHERE tenant_id = 1 AND key = 'booking_reminder_policy'`);
        if (createdUserIds.length > 0) await db.query('DELETE FROM users WHERE id = ANY($1::int[])', [createdUserIds]);
        await db.end();
    });

    it('di serie è spento, il giorno prima alle 11', async () => {
        const res = await api().get('/settings/booking-reminders').set(bearer(owner));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ enabled: false, timing: 'day_before', day_before_time: '11:00', hours_before: 24 });
    });

    it('update parziale: si accende e i campi assenti restano', async () => {
        const acceso = await api().put('/settings/booking-reminders').set(bearer(owner)).send({ enabled: true });
        expect(acceso.status).toBe(200);
        expect(acceso.body).toEqual({ enabled: true, timing: 'day_before', day_before_time: '11:00', hours_before: 24 });

        const inOre = await api().put('/settings/booking-reminders').set(bearer(owner)).send({ timing: 'hours_before', hours_before: 3 });
        expect(inOre.status).toBe(200);
        expect(inOre.body).toEqual({ enabled: true, timing: 'hours_before', day_before_time: '11:00', hours_before: 3 });

        const riletto = await api().get('/settings/booking-reminders').set(bearer(owner));
        expect(riletto.body).toEqual(inOre.body);
    });

    it('rifiuta valori fuori dai limiti senza toccare quelli salvati', async () => {
        const presto = await api().put('/settings/booking-reminders').set(bearer(owner)).send({ day_before_time: '07:00' });
        expect(presto.status).toBe(400);
        expect(presto.body.error).toBe('invalid_policy');
        const troppe = await api().put('/settings/booking-reminders').set(bearer(owner)).send({ hours_before: 72 });
        expect(troppe.status).toBe(400);
        const riletto = await api().get('/settings/booking-reminders').set(bearer(owner));
        expect(riletto.body.hours_before).toBe(3);
    });

    it('un cameriere la legge ma non la cambia', async () => {
        const created = await api().post('/auth/users').set(bearer(owner))
            .send({ email: 'promemoria-cameriere@test.local', password: 'password-iniziale-1', full_name: 'Cameriere Promemoria', role: 'WAITER' });
        expect(created.status).toBe(201);
        createdUserIds.push(created.body.id);
        const session = await api().post('/auth/login').send({ email: 'promemoria-cameriere@test.local', password: 'password-iniziale-1' });
        const waiter = session.body.accessToken as string;

        expect((await api().get('/settings/booking-reminders').set(bearer(waiter))).status).toBe(200);
        const put = await api().put('/settings/booking-reminders').set(bearer(waiter)).send({ enabled: false });
        expect(put.status).toBe(403);
    });
});
