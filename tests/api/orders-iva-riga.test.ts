import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// IVA per riga (fase 2 fatturazione): aliquota di anagrafica sul piatto,
// snapshot sulla riga alla battitura, scomposizione per aliquota sul conto.
// Gira DOPO orders-bills (ordine alfabetico = contratto), che ha già acceso
// table_orders_enabled e pay_at_table_enabled.
describe('IVA per riga', () => {
    let token: string;
    let tableId: number;
    let dishDefaultId: number; // aliquota di default (10)
    let dishAlcolicoId: number; // aliquota esplicita 22

    beforeAll(async () => {
        token = await ownerToken();
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test IVA', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'IVA1', shape: 'SQUARE', seats: 4, x: 100, y: 500,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
    });

    it('il piatto nasce al 10% e accetta un\'aliquota esplicita', async () => {
        const def = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fiorentina Collaudo', description: null, price: 40,
            category: 'SECONDI', allergens: null,
        });
        expect(def.status).toBe(201);
        expect(def.body.vat_rate).toBe(10);
        dishDefaultId = def.body.id;

        const alcolico = await api().post('/dishes').set(bearer(token)).send({
            name: 'Amaro Collaudo', description: null, price: 5,
            category: 'BEVANDE', allergens: null, vat_rate: 22,
        });
        expect(alcolico.status).toBe(201);
        expect(alcolico.body.vat_rate).toBe(22);
        dishAlcolicoId = alcolico.body.id;

        const invalida = await api().post('/dishes').set(bearer(token)).send({
            name: 'Errore Collaudo', price: 1, vat_rate: 12.5,
        });
        expect(invalida.status).toBe(400);
    });

    it('l\'aliquota è uno snapshot: cambiare l\'anagrafica non muove la riga', async () => {
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tableId });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;

        // 40 € al 10% + 2×5 € al 22%.
        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: dishDefaultId, qty: 1 },
                { dish_id: dishAlcolicoId, qty: 2 },
            ],
        });
        expect(items.status).toBe(201);
        const byDish = (id: number) => items.body.items.find((i: any) => i.dish_id === id);
        expect(byDish(dishDefaultId).vat_rate).toBe(10);
        expect(byDish(dishAlcolicoId).vat_rate).toBe(22);

        // L'anagrafica cambia DOPO la battitura: la riga non si muove.
        const upd = await api().put(`/dishes/${dishAlcolicoId}`).set(bearer(token)).send({
            name: 'Amaro Collaudo', description: null, price: 5,
            category: 'BEVANDE', allergens: null, vat_rate: 10,
        });
        expect(upd.status).toBe(200);
        expect(upd.body.vat_rate).toBe(10);

        // Le righe vanno inviate in cucina prima della chiusura (le bozze
        // bloccano il close). Fire mode esplicito: il file cucina che gira
        // prima lo lascia su MANUAL e le righe resterebbero QUEUED.
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'AUTO_ALL' });
        expect(mode.status).toBe(200);
        const send = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(send.status).toBe(200);

        // Chiusura comanda → conto: lo snapshot righe porta l'aliquota
        // battuta e la scomposizione quadra col totale.
        const close = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(close.status).toBe(200);
        const billId = close.body.bill.id as number;

        const view = await api().get(`/bills/open`).set(bearer(token));
        expect(view.status).toBe(200);
        const row = view.body.bills.find((b: any) => b.id === billId);
        expect(row.total_cents).toBe(5000);
        const item22 = row.items.find((i: any) => i.name.startsWith('Amaro'));
        expect(item22.vat_rate).toBe(22);

        // La bill view (risposta di POST /bills/:id/payments) espone la
        // scomposizione per aliquota con lo scorporo dell'IVA inclusa:
        // 4000@10 → net 3636 + iva 364; 1000@22 → net 820 + iva 180.
        const paid = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 5000,
        });
        expect(paid.status).toBe(201);
        expect(paid.body.vat_breakdown).toEqual([
            { rate: 10, gross_cents: 4000, net_cents: 3636, vat_cents: 364 },
            { rate: 22, gross_cents: 1000, net_cents: 820, vat_cents: 180 },
        ]);
        expect(paid.body.bill.status).toBe('SETTLED');
    });

    it('un client vecchio che aggiorna il piatto senza vat_rate non la resetta', async () => {
        const legacy = await api().put(`/dishes/${dishDefaultId}`).set(bearer(token)).send({
            name: 'Fiorentina Collaudo', description: 'aggiornata', price: 42,
            category: 'SECONDI', allergens: null,
        });
        expect(legacy.status).toBe(200);
        expect(legacy.body.vat_rate).toBe(10);

        const esplicita = await api().put(`/dishes/${dishAlcolicoId}`).set(bearer(token)).send({
            name: 'Amaro Collaudo', description: null, price: 5,
            category: 'BEVANDE', allergens: null, vat_rate: 22,
        });
        expect(esplicita.status).toBe(200);
        expect(esplicita.body.vat_rate).toBe(22);
    });
});
