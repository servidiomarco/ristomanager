import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// GET /orders/open — i tavoli con una comanda aperta nel servizio, in una
// chiamata sola (docs/cassa-plan.md §6).
//
// Esisteva solo la via per tavolo, che la griglia di Comande chiama in ciclo:
// con sessanta tavoli sono sessanta richieste. Cassa ne ha bisogno anche solo
// per il contatore «tavoli in servizio», dove non sono discutibili.
//
// Gira DOPO orders-bills, che ha già acceso table_orders_enabled.
describe('cassa — tavoli con comanda aperta', () => {
    let token: string;
    let tableId = 0;
    let orderId = 0;

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Tavoli Aperti', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'APERTO1', shape: 'SQUARE', seats: 4, x: 100, y: 100,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
    });

    it('un tavolo senza comanda non compare', async () => {
        const res = await api().get('/orders/open').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.table_ids).not.toContain(tableId);
    });

    it('appena si apre la comanda il tavolo compare', async () => {
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect(order.status).toBe(201);
        orderId = order.body.order.id;

        const res = await api().get('/orders/open').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.table_ids).toContain(tableId);
        expect(res.body.orders.some((o: any) => o.id === orderId && o.table_id === tableId)).toBe(true);
        // Il servizio della risposta dice su cosa si sta guardando.
        expect(res.body.service.service_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(['LUNCH', 'DINNER']).toContain(res.body.service.shift);
    });

    it('gli id non si ripetono se un tavolo ha più comande', async () => {
        const res = await api().get('/orders/open').set(bearer(token));
        expect(res.status).toBe(200);
        const ids: number[] = res.body.table_ids;
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('un giorno senza servizio non torna niente', async () => {
        const res = await api().get('/orders/open?date=2020-01-01').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.table_ids).toEqual([]);
    });

    it('chiusa la comanda il tavolo sparisce', async () => {
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect([200, 201]).toContain(closed.status);

        const res = await api().get('/orders/open').set(bearer(token));
        expect(res.status).toBe(200);
        expect(res.body.table_ids).not.toContain(tableId);
    });
});

// POST /bills/:id/reopen — la riapertura di un conto chiuso per errore
// (docs/cassa-plan.md §3.3). Fino a ora un conto riapriva solo come effetto
// collaterale di uno storno; qui è un atto esplicito, con una guardia che
// conta: uno scontrino confermato è già stato trasmesso.
describe('cassa — riapertura del conto', () => {
    let token: string;
    let billId = 0;

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Riapertura', width: 800, height: 600,
        });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'RIAP1', shape: 'SQUARE', seats: 2, x: 10, y: 10,
            room_id: room.body.id, status: 'FREE',
        });
        const bill = await api().post(`/tables/${table.body.id}/bill`).set(bearer(token)).send({
            total_cents: 5000, covers: 2,
        });
        expect(bill.status).toBe(201);
        billId = bill.body.bill.id;
    });

    it('un conto ancora aperto non si riapre', async () => {
        const res = await api().post(`/bills/${billId}/reopen`).set(bearer(token)).send({});
        expect(res.status).toBe(409);
    });

    it('chiuso con proforma, si riapre e i movimenti restano', async () => {
        const closed = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            payments: [{ method: 'CONTANTI', amount_cents: 5000 }],
            documento: 'Proforma',
        });
        expect(closed.status).toBe(200);
        expect(closed.body.status).toBe('CLOSED');

        const res = await api().post(`/bills/${billId}/reopen`).set(bearer(token)).send({});
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('OPEN');
        expect(res.body.closed_at).toBeNull();

        // Riaprire non è annullare: il libro cassa non si tocca.
        const open = await api().get('/bills/open').set(bearer(token));
        const row = open.body.bills.find((b: any) => b.id === billId);
        expect(row).toBeTruthy();
        expect(row.staff_paid_cents).toBe(5000);
    });

    it('un conto inesistente risponde 404', async () => {
        const res = await api().post('/bills/999999/reopen').set(bearer(token)).send({});
        expect(res.status).toBe(404);
    });
});
