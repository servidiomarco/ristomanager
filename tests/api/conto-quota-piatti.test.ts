import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Quota «per piatti» della cassa: l'incasso porta in meta.item_units quali
// piatti copre, /bills/open riespone le unità già coperte (con le quote
// ospite) e il QR le conta — così né la cassa né un ospite ripropongono o
// ripagano un piatto già incassato. Dal 24/09 anche la quota dal QR va a
// pezzi (item_units): al tavolo da quattro ognuno paga il suo coperto.
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
    // I pezzi davvero PAGATI (incasso in cassa, quota QR saldata): quello che
    // l'incasso mostra accanto alle righe. Una quota QR solo prenotata non c'è.
    const paidOf = (bills: any[], oid: number): number => {
        const row = bills.find((b: any) => b.id === billId);
        expect(row).toBeTruthy();
        return row.item_paid_units.find((t: any) => t.order_item_id === oid)?.units ?? 0;
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
        expect(paidOf(open.body.bills, frittoId)).toBe(1);
    });

    it('il QR conta i pezzi già incassati, e la riga intera non si prende più', async () => {
        const pub = await api().get(`/pay/${shareToken}`);
        expect(pub.status).toBe(200);
        const fritto = pub.body.items.find((i: any) => i.id === frittoId);
        const dolce = pub.body.items.find((i: any) => i.id === dolceId);
        // Un fritto su due è pagato: la riga non è esaurita, ma un pezzo è di altri.
        expect(fritto.taken).toBe(false);
        expect(fritto.taken_units).toBe(1);
        expect(fritto.unit_cents).toBe(1000);
        expect(dolce.taken).toBe(false);
        expect(dolce.taken_units).toBe(0);

        // La forma vecchia (riga intera = 2 pezzi) non ci sta più.

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

    it('la quota dal QR prende un pezzo alla volta, fino a esaurire la riga', async () => {
        const bad = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item', item_units: [{ order_item_id: frittoId, units: 0 }],
        });
        expect(bad.status).toBe(400);

        const primo = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item', item_units: [{ order_item_id: frittoId, units: 1 }], claimant_label: 'Primo',
        });
        expect(primo.status).toBe(201);
        expect(primo.body.amount_cents).toBe(1000);

        let pub = await api().get(`/pay/${shareToken}`);
        let fritto = pub.body.items.find((i: any) => i.id === frittoId);
        expect(fritto.taken_units).toBe(1);
        expect(fritto.taken).toBe(false);

        // Più pezzi di quanti ne restano → 409, senza impegnare niente.
        const troppi = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item', item_units: [{ order_item_id: frittoId, units: 2 }],
        });
        expect(troppi.status).toBe(409);
        expect(troppi.body.conflicting_item_ids).toContain(frittoId);

        const secondo = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item',
            item_units: [{ order_item_id: frittoId, units: 1 }, { order_item_id: dolceId, units: 1 }],
            claimant_label: 'Secondo',
        });
        expect(secondo.status).toBe(201);
        expect(secondo.body.amount_cents).toBe(1600);

        pub = await api().get(`/pay/${shareToken}`);
        fritto = pub.body.items.find((i: any) => i.id === frittoId);
        expect(fritto.taken_units).toBe(2);
        expect(fritto.taken).toBe(true);

        const esaurito = await api().post(`/pay/${shareToken}/claim`).send({
            kind: 'per_item', item_units: [{ order_item_id: frittoId, units: 1 }],
        });
        expect(esaurito.status).toBe(409);

        // La cassa vede gli stessi pezzi presi dal QR — presi, non pagati:
        // le quote sono solo prenotate finché il pagamento non arriva.
        const open = await api().get('/bills/open').set(bearer(token));
        expect(takenOf(open.body.bills, frittoId)).toBe(2);
        expect(takenOf(open.body.bills, dolceId)).toBe(1);
        expect(paidOf(open.body.bills, frittoId)).toBe(0);
        expect(paidOf(open.body.bills, dolceId)).toBe(0);
    });
});
