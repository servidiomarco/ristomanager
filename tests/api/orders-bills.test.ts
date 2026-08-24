import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Comande e conto al tavolo stanno dietro due feature flag spenti di default:
// il test verifica prima il gate chiuso, poi accende i flag via API come
// farebbe un OWNER da Impostazioni.
describe('orders & bills', () => {
    let token: string;
    let tavoloComanda: number;
    let tavoloConto: number;

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Comande',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);
        for (const [name, setId] of [
            ['TC1', (id: number) => { tavoloComanda = id; }],
            ['TC2', (id: number) => { tavoloConto = id; }],
        ] as const) {
            const table = await api().post('/tables').set(bearer(token)).send({
                name,
                shape: 'SQUARE',
                seats: 4,
                x: name === 'TC1' ? 100 : 300,
                y: 100,
                room_id: room.body.id,
                status: 'FREE',
            });
            expect(table.status).toBe(201);
            setId(table.body.id);
        }
    });

    it('il modulo comande parte disattivato e la feature va accesa via API', async () => {
        const flags = await api().get('/settings/features').set(bearer(token));
        expect(flags.status).toBe(200);
        expect(flags.body.table_orders_enabled).toBe(false);

        const bloccato = await api().post('/orders').set(bearer(token)).send({
            table_id: tavoloComanda,
        });
        expect(bloccato.status).toBe(403);
        expect(bloccato.body.error).toBe('feature_disabled');

        const acceso = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(acceso.status).toBe(200);
        expect(acceso.body.table_orders_enabled).toBe(true);
        expect(acceso.body.pay_at_table_enabled).toBe(true);
    });

    it('apre una comanda, aggiunge righe e totalizza dal listino', async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Tagliolini Collaudo',
            description: null,
            price: 12.5,
            category: 'PRIMI',
            allergens: null,
        });
        expect(dish.status).toBe(201);

        const order = await api().post('/orders').set(bearer(token)).send({
            table_id: tavoloComanda,
        });
        expect(order.status).toBe(201);
        expect(order.body.order.status).toBe('OPEN');
        expect(order.body.order.covers).toBe(1);
        const orderId = order.body.order.id as number;

        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2 }],
        });
        expect(items.status).toBe(201);
        expect(items.body.items).toHaveLength(1);
        // 12.50 € × 2 dal fallback dishes.price, senza listini configurati.
        expect(items.body.items[0].line_total_cents).toBe(2500);
        expect(items.body.subtotal_cents).toBe(2500);
        expect(items.body.total_cents).toBe(2500);
    });

    // Il contratto su cui il palmare conta per i retry: stessa chiave di
    // idempotenza → mai una riga doppia; finché la riga è in bozza il replay
    // allinea la quantità all'ultimo invio; dopo l'invio in cucina il replay
    // non tocca più niente.
    it('il replay di una riga con la stessa chiave non duplica e converge in bozza', async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Amatriciana Collaudo',
            description: null,
            price: 10,
            category: 'PRIMI',
            allergens: null,
        });
        expect(dish.status).toBe(201);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Replay', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'TC3', shape: 'SQUARE', seats: 4, x: 500, y: 100,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);

        const order = await api().post('/orders').set(bearer(token)).send({
            table_id: table.body.id,
        });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;

        const riga = (body: any) =>
            body.items.filter((i: any) => i.dish_id === dish.body.id);

        const primo = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2, idempotency_key: 'replay-amatriciana' }],
        });
        expect(primo.status).toBe(201);
        expect(riga(primo.body)).toHaveLength(1);
        expect(riga(primo.body)[0].qty).toBe(2);

        // Retry identico (timeout con risposta persa): nessuna riga in più.
        const retry = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2, idempotency_key: 'replay-amatriciana' }],
        });
        expect(retry.status).toBe(201);
        expect(riga(retry.body)).toHaveLength(1);
        expect(riga(retry.body)[0].qty).toBe(2);

        // Retry dopo un ritocco della quantità, riga ancora in bozza:
        // vince l'intento più recente, sempre su una riga sola.
        const ritocco = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 3, idempotency_key: 'replay-amatriciana' }],
        });
        expect(ritocco.status).toBe(201);
        expect(riga(ritocco.body)).toHaveLength(1);
        expect(riga(ritocco.body)[0].qty).toBe(3);

        // Invio in cucina: da qui la riga non è più in bozza.
        const inviato = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(inviato.status).toBe(200);

        // Il replay tardivo con un'altra quantità non tocca ciò che la
        // cucina ha già visto: né duplica, né aggiorna.
        const tardivo = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 5, idempotency_key: 'replay-amatriciana' }],
        });
        expect(tardivo.status).toBe(201);
        expect(riga(tardivo.body)).toHaveLength(1);
        expect(riga(tardivo.body)[0].qty).toBe(3);
    });

    it('apre e chiude un conto al tavolo in contanti', async () => {
        const bill = await api().post(`/tables/${tavoloConto}/bill`).set(bearer(token)).send({
            total_cents: 5000,
            covers: 2,
        });
        expect(bill.status).toBe(201);
        expect(bill.body.bill.status).toBe('OPEN');
        expect(bill.body.bill.share_token).toBeTruthy();
        expect(bill.body.residual_cents).toBe(5000);
        const billId = bill.body.bill.id as number;

        const doppio = await api().post(`/tables/${tavoloConto}/bill`).set(bearer(token)).send({
            total_cents: 1000,
        });
        expect(doppio.status).toBe(409);

        const chiuso = await api().post(`/bills/${billId}/close`).set(bearer(token)).send({
            cash_settled_cents: 5000,
            tip_cents: 200,
        });
        expect(chiuso.status).toBe(200);
        expect(chiuso.body.status).toBe('CLOSED');
        expect(chiuso.body.cash_settled_cents).toBe(5000);
        expect(chiuso.body.share_token).toBeNull();
    });
});
