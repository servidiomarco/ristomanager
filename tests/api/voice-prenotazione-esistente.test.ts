import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Chi chiama con un tavolo già in agenda di solito chiama per QUELLO.
// Vernoccoli (25/08/2026) richiamò per correggere l'orario e ne uscì una
// seconda prenotazione; Lo Feudo (27/09/2026) disse "siamo uno in più" e la
// chiamata partì come prenotazione nuova. Due difese sotto test:
//  1. check_availability, col caller_id, riporta le prenotazioni in agenda e
//     l'istruzione di chiedere "modificare questa o una in più?";
//  2. create_reservation non scrive un secondo tavolo per lo stesso numero,
//     giorno e turno senza existing_booking_confirmed — e se è la stessa
//     chiamata ripetuta risponde con la prenotazione che esiste già.
//
// Le date sono relative a oggi: check_availability guarda solo i prossimi 30
// giorni. Telefoni unici per non collidere con gli altri file.
const TELEFONO = '3398877001';
const TELEFONO_REPLAY = '3398877002';

const dbQuery = async (sql: string, params: any[] = []) => {
    const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
    await client.connect();
    try {
        return await client.query(sql, params);
    } finally {
        await client.end();
    }
};

/** 'YYYY-MM-DD' fra `days` giorni, nel fuso del locale. */
const giornoFra = (days: number): string => {
    const oggi = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
    const [y, m, d] = oggi.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

const DATA = giornoFra(10);
const ALTRA_DATA = giornoFra(12);

const contaPrenotazioni = async (telefono: string, data: string) =>
    Number((await dbQuery(
        `SELECT count(*) FROM reservations
          WHERE tenant_id = 1 AND phone LIKE '%' || $1
            AND (reservation_time AT TIME ZONE 'Europe/Rome')::date = $2::date
            AND COALESCE(reservation_status, 'CONFIRMED') <> 'CANCELLED'`,
        [telefono, data])).rows[0].count);

describe('voce: prenotazione già in agenda per lo stesso numero', () => {
    let token: string;
    let orarioCena: string;
    let orarioPranzo: string;
    let esistenteId: number;

    beforeAll(async () => {
        token = await ownerToken();
        const ent = await api().put('/settings/entitlements').set(bearer(token)).send({ voice: true });
        expect(ent.status).toBe(200);

        // Orari dalla griglia vera del giorno: create_reservation rifiuta
        // quelli fuori griglia prima di arrivare al controllo.
        const slots = await api().get('/public/availability').query({ date: DATA });
        expect(slots.status).toBe(200);
        orarioCena = slots.body.dinner.slots[0];
        orarioPranzo = slots.body.lunch.slots[0];
        expect(orarioCena).toBeTruthy();
        expect(orarioPranzo).toBeTruthy();

        // La prenotazione già in agenda, inserita dallo staff come per Vernoccoli.
        const created = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Lo Feudo Giuseppe',
            phone: TELEFONO,
            reservation_time: `${DATA}T${orarioCena}:00`,
            shift: 'DINNER',
            guests: 4,
            children: 0,
        });
        expect(created.status).toBe(201);
        esistenteId = created.body.id;
    });

    afterAll(async () => {
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND (phone LIKE '%' || $1 OR phone LIKE '%' || $2)`, [TELEFONO, TELEFONO_REPLAY]);
        await dbQuery(`DELETE FROM customers WHERE tenant_id = 1 AND (phone LIKE '%' || $1 OR phone LIKE '%' || $2)`, [TELEFONO, TELEFONO_REPLAY]);
    });

    const verifica = (extra: Record<string, any>) =>
        api().post('/webhook/elevenlabs/check-availability').send({ shift: 'DINNER', guests: 5, ...extra });

    const crea = (extra: Record<string, any>) =>
        api().post('/webhook/elevenlabs/create-reservation').send({
            customer_name: 'Lo Feudo Giuseppe', phone: TELEFONO, date: DATA,
            time: orarioCena, shift: 'DINNER', guests: 5, ...extra,
        });

    it('check_availability, stesso giorno: chiede se modificare quella', async () => {
        const res = await verifica({ date: DATA, caller_id: `+39${TELEFONO}` });
        expect(res.status).toBe(200);
        expect(res.body.existing_bookings).toHaveLength(1);
        expect(res.body.existing_bookings[0]).toMatchObject({ date: DATA, time: orarioCena, guests: 4, shift: 'DINNER', same_day: true });
        expect(res.body.existing_booking_instruction).toContain('GIÀ');
        expect(res.body.existing_booking_instruction).toContain(`modify_reservation con date "${DATA}"`);
        expect(res.body.existing_booking_instruction).toContain('existing_booking_confirmed: true');
    });

    it('check_availability, altro giorno: chiede se spostarla o è in più', async () => {
        const res = await verifica({ date: ALTRA_DATA, caller_id: TELEFONO });
        expect(res.status).toBe(200);
        expect(res.body.existing_bookings[0]).toMatchObject({ date: DATA, same_day: false });
        expect(res.body.existing_booking_instruction).toContain('spostare');
        expect(res.body.existing_booking_instruction).not.toContain('existing_booking_confirmed');
    });

    it('check_availability senza caller_id: nessun campo in più', async () => {
        const res = await verifica({ date: DATA });
        expect(res.status).toBe(200);
        expect(res.body.existing_bookings).toBeUndefined();
        expect(res.body.existing_booking_instruction).toBeUndefined();
    });

    it('create_reservation stesso giorno e turno: si ferma con existing_booking', async () => {
        const res = await crea({});
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('existing_booking');
        expect(res.body.message).toContain(orarioCena);
        expect(res.body.message).toContain('4 persone');
        expect(res.body.existing_booking).toMatchObject({ date: DATA, time: orarioCena, guests: 4 });
        expect(await contaPrenotazioni(TELEFONO, DATA)).toBe(1);
    });

    it('create_reservation stesso giorno, altro turno: passa', async () => {
        const res = await crea({ time: orarioPranzo, shift: 'LUNCH', guests: 2 });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND id = $1`, [res.body.reservation_id]);
    });

    it('existing_booking_confirmed: il cliente ne vuole davvero un\'altra', async () => {
        const res = await crea({ existing_booking_confirmed: true });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.reservation_id).not.toBe(esistenteId);
        expect(await contaPrenotazioni(TELEFONO, DATA)).toBe(2);
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND id = $1`, [res.body.reservation_id]);
    });

    it('prenotazione annullata: non conta più', async () => {
        await dbQuery(`UPDATE reservations SET reservation_status = 'CANCELLED' WHERE id = $1`, [esistenteId]);
        const check = await verifica({ date: DATA, caller_id: TELEFONO });
        expect(check.body.existing_booking_instruction).toBeUndefined();
        const res = await crea({});
        expect(res.body.success).toBe(true);
        await dbQuery(`DELETE FROM reservations WHERE tenant_id = 1 AND id = $1`, [res.body.reservation_id]);
        await dbQuery(`UPDATE reservations SET reservation_status = 'CONFIRMED' WHERE id = $1`, [esistenteId]);
    });

    it('stessa create_reservation ripetuta: risponde con quella già salvata', async () => {
        const dati = {
            customer_name: 'Ripetuta Prova', phone: TELEFONO_REPLAY, date: DATA,
            time: orarioCena, shift: 'DINNER', guests: 2,
        };
        const prima = await api().post('/webhook/elevenlabs/create-reservation').send(dati);
        expect(prima.body.success).toBe(true);
        const seconda = await api().post('/webhook/elevenlabs/create-reservation').send(dati);
        expect(seconda.status).toBe(200);
        expect(seconda.body.success).toBe(true);
        expect(seconda.body.already_registered).toBe(true);
        expect(seconda.body.reservation_id).toBe(prima.body.reservation_id);
        expect(seconda.body.confirmation_phrase).toContain(orarioCena);
        expect(await contaPrenotazioni(TELEFONO_REPLAY, DATA)).toBe(1);
    });
});
