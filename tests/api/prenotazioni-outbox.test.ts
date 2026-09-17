import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 1c della tappa 4: gli atti di servizio sulle prenotazioni (modifica,
// scambio tavoli, cancellazione) entrano nel log di replica NELLA stessa
// transazione della mutazione. Eventi SOLO-LOG: reservation:* è un tipo
// 'split' (inbound cloud + servizio sulla stessa route), il broadcast resta
// diretto finché lo sdoppiamento pre-fase-4 non lo porta sull'outbox — qui
// si verifica che il log ci sia, con payload per riferimento e senza PII.
describe('prenotazioni nel log di replica', () => {
    let token: string;
    let db: Client;
    let roomId: number;

    const creaPrenotazione = async (name: string, time: string, tableId?: number) => {
        const res = await api().post('/reservations').set(bearer(token)).send({
            customer_name: name,
            phone: '340 555 1177',
            reservation_time: time,
            shift: 'DINNER',
            guests: 2,
            ...(tableId ? { table_id: tableId } : {}),
        });
        expect(res.status).toBe(201);
        return res.body;
    };

    const creaTavolo = async (name: string, x: number) => {
        const res = await api().post('/tables').set(bearer(token)).send({
            name, shape: 'SQUARE', seats: 4, x, y: 400, room_id: roomId, status: 'FREE',
        });
        expect(res.status).toBe(201);
        return res.body.id;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Log 1c', width: 900, height: 600 });
        roomId = room.body.id;
    });

    afterAll(async () => {
        await db.end();
    });

    it("la modifica (l'arrivo in reception) lascia l'evento in transazione, per riferimento", async () => {
        const resv = await creaPrenotazione('Log Arrivo', '2027-04-06T19:30:00.000Z');

        const upd = await api().put(`/reservations/${resv.id}`).set(bearer(token)).send({
            customer_name: resv.customer_name,
            phone: resv.phone,
            reservation_time: resv.reservation_time,
            shift: resv.shift,
            guests: resv.guests,
            arrival_status: 'ARRIVED',
        });
        expect(upd.status).toBe(200);

        const rows = await db.query(
            `SELECT payload, actor, event_id FROM outbox_events
             WHERE event = 'reservation:updated' AND aggregate = $1`,
            [`reservation:${resv.id}`]
        );
        expect(rows.rows.length).toBeGreaterThanOrEqual(1);
        // Per riferimento e senza PII: mai il nome o il telefono nel log.
        expect(rows.rows[0].payload).toEqual({ reservation_id: resv.id });
        expect(JSON.stringify(rows.rows[0].payload)).not.toContain('Log Arrivo');
        expect(rows.rows[0].actor.user_id).toBeTypeOf('number');
        expect(rows.rows[0].event_id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('lo scambio tavoli logga entrambe le prenotazioni nella stessa transazione', async () => {
        const t1 = await creaTavolo('SW1', 100);
        const t2 = await creaTavolo('SW2', 300);
        const a = await creaPrenotazione('Log Swap A', '2027-04-07T19:00:00.000Z', t1);
        const b = await creaPrenotazione('Log Swap B', '2027-04-07T21:30:00.000Z', t2);

        const swap = await api().post(`/reservations/${a.id}/swap-table`).set(bearer(token)).send({ other_id: b.id });
        expect(swap.status).toBe(200);
        expect(swap.body.a.table_id).toBe(t2);

        const rows = await db.query(
            `SELECT aggregate FROM outbox_events
             WHERE event = 'reservation:updated' AND aggregate = ANY($1) ORDER BY id`,
            [[`reservation:${a.id}`, `reservation:${b.id}`]]
        );
        expect(rows.rows.map((r: any) => r.aggregate).sort()).toEqual(
            [`reservation:${a.id}`, `reservation:${b.id}`].sort()
        );
    });

    it("la cancellazione lascia reservation:deleted e l'evento solo-log viene chiuso dal dispatcher", async () => {
        const resv = await creaPrenotazione('Log Delete', '2027-04-08T20:00:00.000Z');
        const del = await api().delete(`/reservations/${resv.id}`).set(bearer(token));
        expect(del.status).toBe(204);

        const rows = await db.query(
            `SELECT id FROM outbox_events WHERE event = 'reservation:deleted' AND aggregate = $1`,
            [`reservation:${resv.id}`]
        );
        expect(rows.rows.length).toBe(1);

        // Solo-log = nessun handler: il dispatcher lo marca consegnato senza
        // effetti, la coda non si intasa.
        let consegnato = 0;
        for (let i = 0; i < 50; i++) {
            const r = await db.query(
                `SELECT COUNT(*)::int AS n FROM outbox_events
                 WHERE aggregate = $1 AND delivered_at IS NOT NULL`,
                [`reservation:${resv.id}`]
            );
            consegnato = r.rows[0].n;
            if (consegnato > 0) break;
            await new Promise(rs => setTimeout(rs, 200));
        }
        expect(consegnato).toBe(1);
    });
});
