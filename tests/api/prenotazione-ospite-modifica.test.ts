import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import {
    guestActionsFor,
    guestModifyRefusal,
    parseGuestModifyRequest,
    wallClockToInstant,
    addDaysIsoDate,
    GUEST_MODIFY_HORIZON_DAYS,
    type GuestManagePolicy,
} from '../../services/guestManage';
import { api, ownerToken, bearer } from './helpers';

// «La tua prenotazione», seconda parte: l'ospite cambia giorno, ora o
// persone dal link, solo dove il tavolo si trova da solo (decisione del
// 09/10/2026). Il tavolo lo sceglie findTableForChange, lo stesso di Sofia:
// qui anche annullo e modifica di Sofia, che ora passano dal log di replica.

const acceso: GuestManagePolicy = { enabled: true, cancel_cutoff_hours: 3 };
const ore = (n: number) => n * 3600_000;

describe('modifica dall\'ospite — regole', () => {
    const now = new Date('2026-10-09T10:00:00Z');
    const base = {
        now,
        today: '2026-10-09',
        current: { date: '2026-10-20', time: '20:30', guests: 4 },
        depositPaid: false,
        policy: acceso,
    };
    const richiesta = (date: string, time: string, guests: number) => ({
        ...base,
        request: { date, time, guests },
        newTime: wallClockToInstant(date, time, 'Europe/Rome'),
    });

    it('si sposta una prenotazione confermata, non una richiesta né un banchetto', () => {
        const lontana = new Date(now.getTime() + ore(30));
        const args = { now, reservationTime: lontana, guestConfirmedAt: null, policy: acceso };
        expect(guestActionsFor({ ...args, status: 'CONFIRMED' }).can_modify).toBe(true);
        expect(guestActionsFor({ ...args, status: 'PENDING' }).can_modify).toBe(false);
        const banchetto = guestActionsFor({ ...args, status: 'CONFIRMED', banquetLinked: true });
        expect(banchetto.can_modify).toBe(false);
        expect(banchetto.can_cancel).toBe(true);
    });

    it('la richiesta del modulo si legge solo se ben formata', () => {
        expect(parseGuestModifyRequest({ date: '2026-10-20', time: '21:00', guests: 3 })).toEqual({ date: '2026-10-20', time: '21:00', guests: 3 });
        expect(parseGuestModifyRequest({ date: '2026-10-20', time: '21:00', guests: '3' })).toEqual({ date: '2026-10-20', time: '21:00', guests: 3 });
        expect(parseGuestModifyRequest({ date: '20/10/2026', time: '21:00', guests: 3 })).toBeNull();
        expect(parseGuestModifyRequest({ date: '2026-10-20', time: '9:00', guests: 3 })).toBeNull();
        expect(parseGuestModifyRequest({ date: '2026-10-20', time: '21:00', guests: 2.5 })).toBeNull();
        expect(parseGuestModifyRequest(null)).toBeNull();
    });

    it('limiti: date, persone, soglia, caparra, niente di cambiato', () => {
        expect(guestModifyRefusal(richiesta('2026-10-21', '21:00', 4))).toBeNull();
        expect(guestModifyRefusal(richiesta('2026-10-20', '20:30', 4))).toBe('no_change');
        expect(guestModifyRefusal(richiesta('2026-10-08', '21:00', 4))).toBe('out_of_range');
        expect(guestModifyRefusal(richiesta(addDaysIsoDate('2026-10-09', GUEST_MODIFY_HORIZON_DAYS + 1), '21:00', 4))).toBe('out_of_range');
        expect(guestModifyRefusal(richiesta('2026-10-21', '21:00', 0))).toBe('invalid_request');
        expect(guestModifyRefusal(richiesta('2026-10-21', '21:00', 21))).toBe('invalid_request');
        // Oggi alle 13:30 a Roma = 11:30Z: un'ora e mezza da adesso, sotto le 3.
        expect(guestModifyRefusal(richiesta('2026-10-09', '13:30', 4))).toBe('too_soon');
        expect(guestModifyRefusal(richiesta('2026-10-09', '19:30', 4))).toBeNull();
        // Con la caparra pagata le persone restano; l'orario si sposta.
        expect(guestModifyRefusal({ ...richiesta('2026-10-21', '21:00', 5), depositPaid: true })).toBe('guests_locked');
        expect(guestModifyRefusal({ ...richiesta('2026-10-21', '21:00', 4), depositPaid: true })).toBeNull();
    });

    it('l\'orologio del locale diventa l\'istante giusto, anche al cambio d\'ora', () => {
        expect(wallClockToInstant('2026-10-09', '20:30', 'Europe/Rome').toISOString()).toBe('2026-10-09T18:30:00.000Z');
        expect(wallClockToInstant('2026-12-10', '20:30', 'Europe/Rome').toISOString()).toBe('2026-12-10T19:30:00.000Z');
        // 25/10/2026: si torna all'ora solare alle 03:00, la sera è già +1.
        expect(wallClockToInstant('2026-10-25', '20:30', 'Europe/Rome').toISOString()).toBe('2026-10-25T19:30:00.000Z');
        expect(wallClockToInstant('2026-03-29', '20:30', 'Europe/Rome').toISOString()).toBe('2026-03-29T18:30:00.000Z');
        expect(wallClockToInstant('2026-10-09', '20:30', 'Europe/London').toISOString()).toBe('2026-10-09T19:30:00.000Z');
    });
});

describe('modifica dall\'ospite — rotte pubbliche', () => {
    const TENANT = 1;
    const NAME = 'Collaudo Modifica Ospite';
    let owner: string;
    let db: Client;
    let roomId: number;
    let tavoloDa4: number;
    let tavoloDa8: number;

    const romeDay = (offsetDays: number): string =>
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(new Date(Date.now() + offsetDays * 86400_000));
    // Un giorno per prova: due prenotazioni di prova sullo stesso tavolo e
    // turno si toglierebbero il posto a vicenda.
    let giorni = 10;
    const nuovoGiorno = () => romeDay(giorni++);
    const PIENO = romeDay(45);

    const nuova = async (day: string, extra: { status?: string; payment?: string; deposit?: number } = {}): Promise<number> => {
        const r = await db.query(
            `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, table_id,
                                       payment_status, deposit_amount, reservation_status, arrival_status)
             VALUES ($1, $2, ($3::timestamp AT TIME ZONE 'Europe/Rome'), 'DINNER', 4, '+393331112288', $4,
                     $5, $6, $7, 'WAITING')
             RETURNING id`,
            [TENANT, NAME, `${day} 20:30`, tavoloDa4,
             extra.payment ?? 'NONE', extra.deposit ?? null, extra.status ?? 'CONFIRMED']
        );
        return Number(r.rows[0].id);
    };
    const linkDi = async (id: number): Promise<string> => {
        const res = await api().post(`/reservations/${id}/guest-link`).set(bearer(owner));
        expect(res.status).toBe(200);
        return res.body.token as string;
    };
    const riga = async (id: number) => (await db.query(
        `SELECT to_char(reservation_time AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD HH24:MI') AS quando,
                shift, guests, table_id, reservation_status, guest_confirmed_at, requires_review
           FROM reservations WHERE id = $1`, [id]
    )).rows[0];
    const orari = async (token: string, date: string, guests: number) =>
        api().get(`/r/${token}/slots`).query({ date, guests });
    const modifica = (token: string, body: Record<string, unknown>) => api().post(`/r/${token}/modify`).send(body);
    const politica = (body: Record<string, unknown>) => api().put('/settings/guest-manage').set(bearer(owner)).send(body);

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // Una sala tutta per questi test: il tavolo da 4 della prenotazione
        // e quello da 8 dove deve finire chi aggiunge persone.
        const room = await api().post('/rooms').set(bearer(owner)).send({ name: 'Sala Collaudo Modifica', width: 800, height: 600 });
        expect(room.status).toBe(201);
        roomId = room.body.id;
        const tavolo = async (name: string, seats: number) => {
            const t = await api().post('/tables').set(bearer(owner)).send({ name, shape: 'SQUARE', seats, x: 100, y: 100, room_id: roomId, status: 'FREE' });
            expect(t.status).toBe(201);
            return Number(t.body.id);
        };
        tavoloDa4 = await tavolo('CM4', 4);
        tavoloDa8 = await tavolo('CM8', 8);
        expect((await politica({ enabled: true, cancel_cutoff_hours: 3 })).status).toBe(200);
    });

    afterAll(async () => {
        await db.query(`DELETE FROM reservations WHERE customer_name = $1 AND tenant_id = $2`, [NAME, TENANT]);
        await db.query(`DELETE FROM room_closed_overrides WHERE tenant_id = $1 AND date = $2`, [TENANT, PIENO]);
        await db.query(`DELETE FROM tables WHERE room_id = $1`, [roomId]);
        await db.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await db.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = 'guest_manage_policy'`, [TENANT]);
        await db.end();
    });

    it('la pagina dice entro quali limiti si può cambiare', async () => {
        const token = await linkDi(await nuova(nuovoGiorno()));
        const vista = await api().get(`/r/${token}`);
        expect(vista.status).toBe(200);
        expect(vista.body.actions.can_modify).toBe(true);
        expect(vista.body.modify).toEqual({
            first_date: romeDay(0),
            last_date: addDaysIsoDate(romeDay(0), GUEST_MODIFY_HORIZON_DAYS),
            max_guests: 20,
            guests_locked: false,
        });
    });

    it('a gestione spenta niente modifica', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        expect((await politica({ enabled: false })).status).toBe(200);
        try {
            const vista = await api().get(`/r/${token}`);
            expect(vista.body.actions.can_modify).toBe(false);
            expect(vista.body.modify).toBeNull();
            expect((await orari(token, GIORNO, 4)).status).toBe(409);
            const res = await modifica(token, { date: GIORNO, time: '21:00', guests: 4 });
            expect(res.status).toBe(409);
            expect((await riga(id)).quando).toBe(`${GIORNO} 20:30`);
        } finally {
            expect((await politica({ enabled: true })).status).toBe(200);
        }
    });

    it('gli orari arrivano per turno, e l\'orario nuovo tiene il tavolo', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        const slots = await orari(token, GIORNO, 4);
        expect(slots.status).toBe(200);
        expect(slots.body.deposit_required).toBe(false);
        expect(slots.body.dinner.times).toEqual(expect.arrayContaining(['20:30', '21:00']));

        const res = await modifica(token, { date: GIORNO, time: '21:00', guests: 4 });
        expect(res.status).toBe(200);
        expect(res.body.reservation).toMatchObject({ date: GIORNO, time: '21:00', guests: 4, state: 'confirmed' });
        // L'orario l'ha scelto lui: vale come «ci saremo».
        expect(res.body.reservation.guest_confirmed_at).toBeTruthy();
        const r = await riga(id);
        expect(r).toMatchObject({ quando: `${GIORNO} 21:00`, shift: 'DINNER', guests: 4, table_id: tavoloDa4 });

        // Nel log di replica, col canale dell'ospite.
        const ev = await db.query(
            `SELECT actor FROM outbox_events WHERE aggregate = $1 AND event = 'reservation:updated' ORDER BY id DESC LIMIT 1`,
            [`reservation:${id}`]
        );
        expect(ev.rows[0]?.actor).toMatchObject({ channel: 'guest' });
    });

    it('più persone del tavolo: passa a uno più grande della stessa sala', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        const res = await modifica(token, { date: GIORNO, time: '20:30', guests: 6 });
        expect(res.status).toBe(200);
        expect(await riga(id)).toMatchObject({ guests: 6, table_id: tavoloDa8 });
    });

    it('lo stesso orario due volte non cambia niente', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        const res = await modifica(token, { date: GIORNO, time: '20:30', guests: 4 });
        expect(res.status).toBe(200);
        expect((await riga(id)).guest_confirmed_at).toBeNull();
    });

    it('dove non c\'è un tavolo: nessun orario, e la modifica è rifiutata', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        await db.query(
            `INSERT INTO room_closed_overrides (tenant_id, room_id, date, shift)
             SELECT $1, r.id, $2::date, s.shift FROM rooms r CROSS JOIN (VALUES ('LUNCH'), ('DINNER')) AS s(shift)
              WHERE r.tenant_id = $1
             ON CONFLICT DO NOTHING`,
            [TENANT, PIENO]
        );
        const slots = await orari(token, PIENO, 4);
        expect(slots.status).toBe(200);
        expect(slots.body.dinner).toEqual({ times: [], full: true });

        const res = await modifica(token, { date: PIENO, time: '20:30', guests: 4 });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('unavailable');
        expect(await riga(id)).toMatchObject({ quando: `${GIORNO} 20:30`, table_id: tavoloDa4 });
    });

    it('orari fuori griglia o date fuori dai limiti: rifiutati', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO);
        const token = await linkDi(id);
        expect((await modifica(token, { date: GIORNO, time: '17:10', guests: 4 })).body.error).toBe('unavailable');
        expect((await modifica(token, { date: romeDay(-1), time: '20:30', guests: 4 })).status).toBe(400);
        expect((await modifica(token, { date: romeDay(GUEST_MODIFY_HORIZON_DAYS + 2), time: '20:30', guests: 4 })).status).toBe(400);
        expect((await modifica(token, { date: GIORNO, time: 'sera', guests: 4 })).status).toBe(400);
        expect((await orari(token, romeDay(-1), 4)).status).toBe(400);
        expect((await riga(id)).quando).toBe(`${GIORNO} 20:30`);
    });

    it('con la caparra pagata si sposta l\'orario, non il numero di persone', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO, { payment: 'PAID_DEPOSIT', deposit: 40 });
        const token = await linkDi(id);
        expect((await api().get(`/r/${token}`)).body.modify.guests_locked).toBe(true);
        expect((await orari(token, GIORNO, 5)).status).toBe(409);
        const piu = await modifica(token, { date: GIORNO, time: '20:30', guests: 5 });
        expect(piu.status).toBe(409);
        expect(piu.body.error).toBe('guests_locked');
        const ora = await modifica(token, { date: GIORNO, time: '21:30', guests: 4 });
        expect(ora.status).toBe(200);
        expect((await riga(id)).quando).toBe(`${GIORNO} 21:30`);
    });

    it('una richiesta in attesa non si sposta', async () => {
        const GIORNO = nuovoGiorno();
        const id = await nuova(GIORNO, { status: 'PENDING' });
        const token = await linkDi(id);
        expect((await api().get(`/r/${token}`)).body.actions.can_modify).toBe(false);
        const res = await modifica(token, { date: GIORNO, time: '21:00', guests: 4 });
        expect(res.status).toBe(409);
        expect((await riga(id)).reservation_status).toBe('PENDING');
    });
});

describe('annullo e modifica di Sofia nel log di replica', () => {
    const TELEFONO = '3387650099';
    const NAME = 'Collaudo Sofia Replica';
    let owner: string;
    let db: Client;
    let roomId: number;
    let tableId: number;

    beforeAll(async () => {
        owner = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        // I webhook di Sofia passano da voiceChannelOpen.
        expect((await api().put('/settings/entitlements').set(bearer(owner)).send({ voice: true })).status).toBe(200);
        const room = await api().post('/rooms').set(bearer(owner)).send({ name: 'Sala Collaudo Sofia', width: 800, height: 600 });
        expect(room.status).toBe(201);
        roomId = room.body.id;
        const t = await api().post('/tables').set(bearer(owner)).send({ name: 'CS2', shape: 'SQUARE', seats: 2, x: 100, y: 100, room_id: roomId, status: 'FREE' });
        expect(t.status).toBe(201);
        tableId = t.body.id;
    });

    afterAll(async () => {
        await db.query(`DELETE FROM reservations WHERE customer_name = $1`, [NAME]);
        await db.query(`DELETE FROM tables WHERE room_id = $1`, [roomId]);
        await db.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
        await db.end();
    });

    const nuova = async (day: string): Promise<number> => (await db.query(
        `INSERT INTO reservations (tenant_id, customer_name, reservation_time, shift, guests, phone, table_id,
                                   payment_status, reservation_status, arrival_status, guest_confirmed_at)
         VALUES (1, $1, ($2::timestamp AT TIME ZONE 'Europe/Rome'), 'DINNER', 2, $3, $4, 'NONE', 'CONFIRMED', 'WAITING', NOW())
         RETURNING id`,
        [NAME, `${day} 20:30`, `+39${TELEFONO}`, tableId]
    )).rows[0].id;
    const ultimoEvento = async (id: number) => (await db.query(
        `SELECT actor FROM outbox_events WHERE aggregate = $1 AND event = 'reservation:updated' ORDER BY id DESC LIMIT 1`,
        [`reservation:${id}`]
    )).rows[0];

    it('la modifica entra nel log e azzera il «ci saremo» dell\'orario vecchio', async () => {
        const id = await nuova('2027-05-12');
        const res = await api().post('/webhook/elevenlabs/modify-reservation').send({ phone: TELEFONO, date: '2027-05-12', new_time: '21:30' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('modified');
        const r = (await db.query(`SELECT guest_confirmed_at FROM reservations WHERE id = $1`, [id])).rows[0];
        expect(r.guest_confirmed_at).toBeNull();
        expect((await ultimoEvento(id))?.actor).toMatchObject({ channel: 'voice' });
    });

    it('l\'annullo libera il tavolo ed entra nel log', async () => {
        const id = await nuova('2027-05-13');
        const res = await api().post('/webhook/elevenlabs/cancel-reservation').send({ phone: TELEFONO, date: '2027-05-13' });
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('cancelled');
        const r = (await db.query(`SELECT reservation_status, table_id FROM reservations WHERE id = $1`, [id])).rows[0];
        expect(r).toMatchObject({ reservation_status: 'CANCELLED', table_id: null });
        expect((await ultimoEvento(id))?.actor).toMatchObject({ channel: 'voice' });
    });
});
