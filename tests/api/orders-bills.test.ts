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
