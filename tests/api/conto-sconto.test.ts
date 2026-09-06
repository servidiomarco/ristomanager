import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Sconto sul CONTO (operazioni di cassa): al momento dell'incasso la comanda
// è già chiusa e POST /orders/:id/discount la rifiuta — lo sconto passa da
// POST /bills/:id/discount e si applica in syncBillTotalInTx, sopra gli
// eventuali sconti per comanda. Le righe del conto NON cambiano: cambia il
// totale, e sul preconto la differenza esce come riga «Sconto».
describe('sconto sul conto', () => {
    let token: string;
    let tavolo: number;
    let tavoloManuale: number;
    let billId: number;

    beforeAll(async () => {
        token = await ownerToken();
        // I flag restano accesi dai file precedenti, ma il PUT è idempotente:
        // il file deve reggersi da solo se girato in isolamento.
        await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Sconto Conto',
            width: 800,
            height: 600,
        });
        expect(room.status).toBe(201);
        for (const [name, x, setId] of [
            ['SC1', 100, (id: number) => { tavolo = id; }],
            ['SC2', 300, (id: number) => { tavoloManuale = id; }],
        ] as const) {
            const table = await api().post('/tables').set(bearer(token)).send({
                name, shape: 'SQUARE', seats: 4, x, y: 100,
                room_id: room.body.id, status: 'FREE',
            });
            expect(table.status).toBe(201);
            setId(table.body.id);
        }
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Sconto Collaudo',
            description: null,
            price: 12.5,
            category: 'SECONDI',
            allergens: null,
        });
        expect(dish.status).toBe(201);

        const order = await api().post('/orders').set(bearer(token)).send({ table_id: tavolo });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id as number;
        const items = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2 }],
        });
        expect(items.status).toBe(201);
        // Le bozze non si incassano: prima l'invio in cucina, come in cassa.
        const sent = await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        expect(sent.status).toBe(200);
        const closed = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(closed.status).toBe(200);
        billId = closed.body.bill.id as number;
        expect(closed.body.bill.total_cents).toBe(2500);
    });

    afterAll(async () => {
        // I file girano in sequenza sullo stesso server: questo viene prima di
        // orders-bills, che parte asserendo i flag SPENTI e li riaccende da sé.
        // Lasciarli accesi qui fa fallire quella asserzione e trascina in 403
        // tutti i file cassa a valle (successo davvero, run 34051090136).
        await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: false,
            pay_at_table_enabled: false,
        });
    });

    it('valida tipo, valore e motivazione come lo sconto di comanda', async () => {
        const senzaMotivo = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'PERCENT', discount_value: 10,
        });
        expect(senzaMotivo.status).toBe(400);

        const oltreCento = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'PERCENT', discount_value: 120, reason: 'troppo generosi',
        });
        expect(oltreCento.status).toBe(400);

        const tipoIgnoto = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'GRATIS', discount_value: 10, reason: 'tipo inventato',
        });
        expect(tipoIgnoto.status).toBe(400);
    });

    it('applica, sostituisce e rimuove lo sconto ricalcolando il totale (righe intatte)', async () => {
        const percento = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'PERCENT', discount_value: 10, reason: 'cliente abituale',
        });
        expect(percento.status).toBe(200);
        expect(percento.body.bill.total_cents).toBe(2250);

        // Un nuovo sconto SOSTITUISCE il precedente, non si somma.
        const importo = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'AMOUNT', discount_value: 5, reason: 'piatto in ritardo',
        });
        expect(importo.status).toBe(200);
        expect(importo.body.bill.total_cents).toBe(2000);

        // La lista della cassa porta i campi sconto e il totale scontato;
        // le righe restano piene: la differenza la spiega la riga Sconto.
        const open = await api().get('/bills/open').set(bearer(token));
        expect(open.status).toBe(200);
        const row = open.body.bills.find((b: any) => b.id === billId);
        expect(row.total_cents).toBe(2000);
        expect(row.discount_type).toBe('AMOUNT');
        expect(row.discount_reason).toBe('piatto in ritardo');
        const itemsSum = row.items.reduce((s: number, i: any) => s + i.unit_price_cents * i.qty, 0);
        expect(itemsSum).toBe(2500);

        const rimosso = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({});
        expect(rimosso.status).toBe(200);
        expect(rimosso.body.bill.total_cents).toBe(2500);
        expect(rimosso.body.bill.discount_type).toBeNull();
    });

    it('sotto il già incassato non si scende: serve un rimborso, non uno sconto', async () => {
        const incasso = await api().post(`/bills/${billId}/payments`).set(bearer(token)).send({
            method: 'CONTANTI', amount_cents: 2000,
        });
        expect(incasso.status).toBe(201);

        const troppo = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'AMOUNT', discount_value: 10, reason: 'sconto tardivo',
        });
        expect(troppo.status).toBe(409);
        expect(troppo.body.error).toMatch(/rimborso/);

        // Uno sconto che resta sopra l'incassato invece passa.
        const giusto = await api().post(`/bills/${billId}/discount`).set(bearer(token)).send({
            discount_type: 'AMOUNT', discount_value: 4, reason: 'arrotondamento cortesia',
        });
        expect(giusto.status).toBe(200);
        expect(giusto.body.bill.total_cents).toBe(2100);
    });

    it('un conto aperto a mano (senza comanda) non si sconta: il totale è digitato', async () => {
        const manuale = await api().post(`/tables/${tavoloManuale}/bill`).set(bearer(token)).send({
            total_cents: 3000, covers: 2,
        });
        expect(manuale.status).toBe(201);

        const rifiutato = await api().post(`/bills/${manuale.body.bill.id}/discount`).set(bearer(token)).send({
            discount_type: 'PERCENT', discount_value: 10, reason: 'prova a mano',
        });
        expect(rifiutato.status).toBe(409);
    });
});
