import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Tappa C del piano «sala, comande e conto sul nodo»: l'accoglienza.
// Tavolo e arrivo hanno il loro comando (PATCH /reservations/:id/service),
// che scrive solo quelle due colonne e va nel log come evento di servizio;
// il walk-in ha la sua route; ogni modifica del cloud a una prenotazione
// entra nel log, anche quelle che prima erano solo broadcast. Qui col
// servizio nel cloud (interruttore spento): la parte col nodo sta in
// sala-node-upstream.

describe('accoglienza: tavolo e arrivo, walk-in, prenotazioni nel log', () => {
    let token: string;
    let db: Client;
    let tableA = 0;
    let tableB = 0;

    const logged = async (event: string, id: number): Promise<number> => {
        const r = await db.query(
            `SELECT COUNT(*)::int AS n FROM outbox_events WHERE event = $1 AND payload->>'reservation_id' = $2`,
            [event, String(id)]
        );
        return r.rows[0].n;
    };
    const newReservation = async (name: string, phone: string, time = '2031-05-10T19:00:00.000Z') => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: name, phone, reservation_time: time, shift: 'DINNER', guests: 2,
        });
        expect(res.status).toBe(201);
        return res.body as { id: number };
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Accoglienza', width: 600, height: 400 });
        for (const name of ['ACC1', 'ACC2']) {
            const t = await api().post('/tables').set(bearer(token)).send({
                name, shape: 'SQUARE', seats: 4, x: 50, y: 50, room_id: room.body.id, status: 'FREE',
            });
            expect(t.status).toBe(201);
            if (name === 'ACC1') tableA = t.body.id; else tableB = t.body.id;
        }
    });

    afterAll(async () => { await db.end(); });

    it('il comando di servizio scrive solo tavolo e arrivo, e va nel log come evento di servizio', async () => {
        const r = await newReservation('Accoglienza Uno', '+393331110001');
        const prima = await db.query(`SELECT customer_name, guests, notes FROM reservations WHERE id = $1`, [r.id]);

        const bad = await api().patch(`/reservations/${r.id}/service`).set(bearer(token)).send({ arrival_status: 'SEDUTO' });
        expect(bad.status).toBe(400);
        const empty = await api().patch(`/reservations/${r.id}/service`).set(bearer(token)).send({ customer_name: 'Altro' });
        expect(empty.status).toBe(400);

        const seat = await api().patch(`/reservations/${r.id}/service`).set(bearer(token))
            .send({ table_id: tableA, arrival_status: 'ARRIVED', customer_name: 'Ignorato' });
        expect(seat.status).toBe(200);
        expect(seat.body.table_id).toBe(tableA);
        expect(seat.body.arrival_status).toBe('ARRIVED');
        const dopo = await db.query(`SELECT customer_name, guests, notes FROM reservations WHERE id = $1`, [r.id]);
        expect(dopo.rows[0]).toEqual(prima.rows[0]);
        expect(await logged('reservation:service-updated', r.id)).toBe(1);

        // Togliere il tavolo senza toccare l'arrivo.
        const unseat = await api().patch(`/reservations/${r.id}/service`).set(bearer(token)).send({ table_id: null });
        expect(unseat.status).toBe(200);
        expect(unseat.body.table_id).toBeNull();
        expect(unseat.body.arrival_status).toBe('ARRIVED');
    });

    it('un tavolo occupato nella finestra dell\'ospite si rifiuta, come nel PUT', async () => {
        const a = await newReservation('Accoglienza Due', '+393331110002', '2031-05-11T19:00:00.000Z');
        const b = await newReservation('Accoglienza Tre', '+393331110003', '2031-05-11T19:30:00.000Z');
        expect((await api().patch(`/reservations/${a.id}/service`).set(bearer(token)).send({ table_id: tableB })).status).toBe(200);
        const clash = await api().patch(`/reservations/${b.id}/service`).set(bearer(token)).send({ table_id: tableB });
        expect(clash.status).toBe(409);
        expect(Array.isArray(clash.body.conflicts)).toBe(true);
        const missing = await api().patch(`/reservations/${b.id}/service`).set(bearer(token)).send({ table_id: 987654 });
        expect(missing.status).toBe(404);
    });

    it('lo scambio tavoli va nel log come evento di servizio', async () => {
        const a = await newReservation('Scambio Uno', '+393331110004', '2031-05-12T19:00:00.000Z');
        const b = await newReservation('Scambio Due', '+393331110005', '2031-05-12T19:00:00.000Z');
        await api().patch(`/reservations/${a.id}/service`).set(bearer(token)).send({ table_id: tableA });
        await api().patch(`/reservations/${b.id}/service`).set(bearer(token)).send({ table_id: tableB });
        const swap = await api().post(`/reservations/${a.id}/swap-table`).set(bearer(token)).send({ other_id: b.id });
        expect(swap.status).toBe(200);
        expect(await logged('reservation:service-updated', a.id)).toBe(2);
        expect(await logged('reservation:service-updated', b.id)).toBe(2);
        expect(await logged('reservation:updated', a.id)).toBe(0);
    });

    it('il walk-in nasce arrivato e confermato, adesso, con la scheda in rubrica', async () => {
        const res = await api().post('/reservations/walk-in').set(bearer(token))
            .send({ customer_name: 'Passante Rossi', guests: 3, phone: '+393331110006', notes: 'senza prenotazione' });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ customer_name: 'Passante Rossi', guests: 3, arrival_status: 'ARRIVED', reservation_status: 'CONFIRMED' });
        expect(Math.abs(Date.now() - new Date(res.body.reservation_time).getTime())).toBeLessThan(60_000);
        expect(await logged('reservation:created', res.body.id)).toBe(1);
        const customer = await db.query(`SELECT name FROM customers WHERE tenant_id = 1 AND regexp_replace(phone, '\\D', '', 'g') = '393331110006'`);
        expect(customer.rows[0]?.name).toBeTruthy();
        expect((await api().post('/reservations/walk-in').set(bearer(token)).send({ guests: 2 })).status).toBe(400);
    });

    it('una modifica del cloud fuori dal PUT (rinomina dalla rubrica) entra nel log', async () => {
        const r = await newReservation('Cascata Prima', '+393331110007', '2031-05-13T19:00:00.000Z');
        const customer = await db.query(`SELECT id FROM customers WHERE tenant_id = 1 AND regexp_replace(phone, '\\D', '', 'g') = '393331110007'`);
        expect(customer.rows[0]).toBeTruthy();
        const prima = await logged('reservation:updated', r.id);
        const rename = await api().put(`/customers/${customer.rows[0].id}`).set(bearer(token))
            .send({ name: 'Cascata Dopo', phone: '+393331110007' });
        expect(rename.status).toBe(200);
        const row = await db.query(`SELECT customer_name FROM reservations WHERE id = $1`, [r.id]);
        expect(row.rows[0].customer_name).toBe('Cascata Dopo');
        expect(await logged('reservation:updated', r.id)).toBe(prima + 1);
    });
});
