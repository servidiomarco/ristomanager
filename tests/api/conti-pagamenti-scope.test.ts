import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Fase B3.6 — comande, conti & pagamenti per tenant. Il flusso base è già
// coperto da orders-bills.test.ts: qui si verificano i contratti toccati
// dalla scopatura — il replay idempotente (vincolo ora composto su
// tenant_id + idempotency_key), la semantica di chiusura comanda → conto,
// e il 404 su id estranei (un id di un altro tenant equivale a inesistente,
// quindi un id inesistente esercita lo stesso ramo).
describe('conti & pagamenti — scoping per tenant', () => {
    let token: string;
    let tavoloReplay: number;
    let tavoloChiusura: number;
    let tavoloBozze: number;
    let dishId: number;

    beforeAll(async () => {
        token = await ownerToken();

        // I flag partono spenti: si accendono qui (idempotente) invece di
        // dipendere dall'ordine di esecuzione degli altri file di test.
        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Scope B36',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);

        const tables: Array<[string, (id: number) => void]> = [
            ['SC1', (id) => { tavoloReplay = id; }],
            ['SC2', (id) => { tavoloChiusura = id; }],
            ['SC3', (id) => { tavoloBozze = id; }],
        ];
        for (let i = 0; i < tables.length; i++) {
            const [name, setId] = tables[i];
            const table = await api().post('/tables').set(bearer(token)).send({
                name,
                shape: 'SQUARE',
                seats: 4,
                x: 100 + i * 200,
                y: 300,
                room_id: room.body.id,
                status: 'FREE',
            });
            expect(table.status).toBe(201);
            setId(table.body.id);
        }

        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Piatto Scope B36',
            description: null,
            price: 10,
            category: 'PRIMI',
            allergens: null,
        });
        expect(dish.status).toBe(201);
        dishId = dish.body.id;
    });

    afterAll(async () => {
        // I flag tornano spenti: orders-bills.test.ts verifica proprio il
        // gate chiuso di partenza, e i file girano in sequenza sullo stesso
        // database.
        await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: false,
            pay_at_table_enabled: false,
        });
    });

    it('replay idempotente: stessa Idempotency-Key, stessa comanda', async () => {
        const key = `scope-b36-${Date.now()}`;

        const first = await api().post('/orders')
            .set(bearer(token))
            .set('Idempotency-Key', key)
            .send({ table_id: tavoloReplay });
        expect(first.status).toBe(201);
        const orderId = first.body.order.id as number;

        // Il retry del palmare (stessa chiave) NON crea una seconda comanda:
        // torna la stessa riga marcata replayed.
        const second = await api().post('/orders')
            .set(bearer(token))
            .set('Idempotency-Key', key)
            .send({ table_id: tavoloReplay });
        expect(second.status).toBe(200);
        expect(second.body.replayed).toBe(true);
        expect(second.body.order.id).toBe(orderId);

        // Chiusa senza righe: nessun conto da un centesimo, solo la comanda
        // che si chiude (è il ramo billable=0 del close).
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(closed.status).toBe(200);
        expect(closed.body.bill).toBeNull();
    });

    it('chiusura: 409 con righe in bozza, poi invio e conto valorizzato', async () => {
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tavoloChiusura });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;

        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dishId, qty: 2 }],
        });
        expect(items.status).toBe(201);

        // Righe ancora in DRAFT: la chiusura rifiuta e dice quante sono.
        const blocked = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(blocked.status).toBe(409);
        expect(blocked.body.pending_items).toBe(1);
        expect(blocked.body.hint).toContain('discard_pending');

        // Invio in cucina (fire mode di default AUTO_ALL: l'uscita parte).
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        expect(sent.body.fired_courses).toContain(1);

        // Ora la chiusura crea il conto, valorizzato dalle righe inviate.
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(closed.status).toBe(200);
        expect(closed.body.order_id).toBe(orderId);
        expect(closed.body.bill).toBeTruthy();
        expect(closed.body.bill.total_cents).toBe(2000); // 10,00 € × 2
        expect(closed.body.bill.share_token).toBeTruthy();
        expect(closed.body.bill.residual_cents).toBe(2000);

        // La comanda non è più aperta: una seconda chiusura è un 409.
        const again = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(again.status).toBe(409);
    });

    it('chiusura con discard_pending: le bozze si scartano e niente conto', async () => {
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tavoloBozze });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;

        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dishId, qty: 1 }],
        });
        expect(items.status).toBe(201);

        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({
            discard_pending: true,
        });
        expect(closed.status).toBe(200);
        // Le sole righe erano bozze scartate: nessun importo, nessun conto.
        expect(closed.body.bill).toBeNull();
    });

    it('id estranei fanno 404 su comande, righe e conti', async () => {
        // Il fetch è scopato sul tenant: un id di un altro ristorante cade
        // nello stesso ramo di un id inesistente.
        const ghost = 99999999;

        const order = await api().get(`/orders/${ghost}`).set(bearer(token));
        expect(order.status).toBe(404);

        const closeOrder = await api().post(`/orders/${ghost}/close`).set(bearer(token)).send({});
        expect(closeOrder.status).toBe(404);

        const patchItem = await api().patch(`/orders/items/${ghost}`).set(bearer(token)).send({ qty: 3 });
        expect(patchItem.status).toBe(404);

        const closeBill = await api().post(`/bills/${ghost}/close`).set(bearer(token)).send({
            cash_settled_cents: 100,
        });
        expect(closeBill.status).toBe(404);

        const voidBill = await api().post(`/bills/${ghost}/void`).set(bearer(token)).send({});
        expect(voidBill.status).toBe(404);

        const reconcile = await api().post(`/payments/${ghost}/reconcile`).set(bearer(token)).send({});
        expect(reconcile.status).toBe(404);
    });
});
