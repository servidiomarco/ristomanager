import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Quota «per piatti» della cassa: l'incasso porta in meta.item_units quali
// piatti copre, /bills/open riespone le unità già coperte (con le quote
// ospite a riga intera) e il QR le segna prese — così né la cassa né un
// ospite ripropongono o ripagano un piatto già incassato.
describe('quota per piatti (meta.item_units)', () => {
    let token: string;
    let billId: number;
    let shareToken: string;
    let paymentId: number;
    // order_item_id delle due righe: il fritto (qty 2) e il dolce (qty 1).
    let frittoId: number;
    let dolceId: number;

    const takenOf = (bills: any[], oid: number): number => {
        const row = bills.find((b: any) => b.id === billId);
        expect(row).toBeTruthy();
        return row.item_taken_units.find((t: any) => t.order_item_id === oid)?.units ?? 0;
    };

    beforeAll(async () => {
        token = await ownerToken();
        await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Quota Piatti', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'QP1', shape: 'SQUARE', seats: 4, x: 100, y: 100,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const fritto = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Quota', description: null, price: 10, category: 'SECONDI', allergens: null,
        });
        const dolce = await api().post('/dishes').set(bearer(token)).send({
            name: 'Dolce Quota', description: null, price: 6, category: 'DOLCI', allergens: null,
        });
        expect(fritto.status).toBe(201);
        expect(dolce.status).toBe(201);

        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;
        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [
                { dish_id: fritto.body.id, qty: 2 },
                { dish_id: dolce.body.id, qty: 1 },
            ],
        });
        expect(items.status).toBe(201);
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(closed.status).toBe(200);
        billId = closed.body.bill.id as number;
        expect(closed.body.bill.total_cents).toBe(2600);

        const open = await api().get('/bills/open').set(bearer(token));
        expect(open.status).toBe(200);
        const row = open.body.bills.find((b: any) => b.id === billId);
        shareToken = row.share_token as string;
        expect(shareToken).toBeTruthy();
        frittoId = row.items.find((i: any) => i.name === 'Fritto Quota').order_item_id;
        dolceId = row.items.find((i: any) => i.name === 'Dolce Quota').order_item_id;
        expect(frittoId).toBeTruthy();
        expect(dolceId).toBeTruthy();
    });

    afterAll(async () => {
        // Stessa igiene di conto-sconto: orders-bills (dopo, in ordine
        // alfabetico) parte asserendo i flag SPENTI.
        await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: false,
            pay_at_table_enabled: false,
        });
    });

    it('meta.item_units malformato → 400, senza registrare nulla', async () => {
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 1000,
            meta: { item_units: [{ order_item_id: frittoId, units: 0 }] },
        });
        expect(res.status).toBe(400);
    });

    it('l\'incasso per piatti registra le unità coperte e /bills/open le riespone', async () => {
        const res = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 1000,
            meta: { item_units: [{ order_item_id: frittoId, units: 1 }] },
        });
        expect(res.status).toBe(201);
        paymentId = res.body.payments.find((p: any) => p.method === 'CONTANTI').id;

        const open = await api().get('/bills/open').set(bearer(token));
        expect(open.status).toBe(200);
        expect(takenOf(open.body.bills, frittoId)).toBe(1);
        expect(takenOf(open.body.bills, dolceId)).toBe(0);
    });

    it('il QR segna presa la riga anche a copertura parziale, e il claim la rifiuta', async () => {
        const pub = await api().get(`/pay/${shareToken}`);
        expect(pub.status).toBe(200);
        const fritto = pub.body.items.find((i: any) => i.id === frittoId);
        const dolce = pub.body.items.find((i: any) => i.id === dolceId);
        expect(fritto.taken).toBe(true);
        expect(dolce.taken).toBe(false);

        const claim = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item', item_ids: [frittoId], claimant_label: 'Ospite Quota',
        });
        expect(claim.status).toBe(409);
        expect(claim.body.conflicting_item_ids).toContain(frittoId);
    });

    it('lo storno del movimento libera le unità', async () => {
        const res = await api().post(`/bills/${billId}/payments/${paymentId}/void`).set(bearer(token)).send({
            reason: 'prova storno quota piatti',
        });
        expect(res.status).toBe(200);

        const open = await api().get('/bills/open').set(bearer(token));
        expect(open.status).toBe(200);
        expect(takenOf(open.body.bills, frittoId)).toBe(0);

        const pub = await api().get(`/pay/${shareToken}`);
        expect(pub.status).toBe(200);
        expect(pub.body.items.find((i: any) => i.id === frittoId).taken).toBe(false);
    });
});
