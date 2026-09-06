import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Coperto e servizio dalle impostazioni (GET/PUT /settings/charges): le due
// chiavi app_settings che syncSystemLines applica a ogni comanda come righe
// COVER e SERVICE. Prima di questo endpoint si cambiavano solo a mano sul DB.
describe('coperto e servizio (settings/charges)', () => {
    let token: string;
    let salaId: number;
    let piattoId: number;
    let nTavoli = 0;

    const nuovaComanda = async (covers: number): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `CPRT${++nTavoli}`, shape: 'SQUARE', seats: 4,
            x: 100 + nTavoli * 60, y: 500, room_id: salaId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id, covers });
        expect(order.status).toBe(201);
        return order.body.order.id as number;
    };

    beforeAll(async () => {
        token = await ownerToken();
        // Flag delle comande accesi esplicitamente: lo stato è condiviso fra
        // i file e qui serve il modulo ordini.
        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Coperto', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        salaId = room.body.id;
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Coperto', description: null, price: 18, category: 'SECONDI', allergens: null,
        });
        expect(dish.status).toBe(201);
        piattoId = dish.body.id;
    });

    afterAll(async () => {
        // Stato condiviso fra i file: gli importi tornano a zero.
        const reset = await api().put('/settings/charges').set(bearer(token)).send({
            cover_charge_cents: 0, service_charge_percent: 0,
        });
        expect(reset.status).toBe(200);
    });

    it('parte a zero e valida gli input', async () => {
        const before = await api().get('/settings/charges').set(bearer(token));
        expect(before.status).toBe(200);
        expect(before.body).toEqual({ cover_charge_cents: 0, service_charge_percent: 0 });

        const badCover = await api().put('/settings/charges').set(bearer(token)).send({ cover_charge_cents: 2.5 });
        expect(badCover.status).toBe(400);
        const negCover = await api().put('/settings/charges').set(bearer(token)).send({ cover_charge_cents: -100 });
        expect(negCover.status).toBe(400);
        const hugeCover = await api().put('/settings/charges').set(bearer(token)).send({ cover_charge_cents: 10001 });
        expect(hugeCover.status).toBe(400);
        const badService = await api().put('/settings/charges').set(bearer(token)).send({ service_charge_percent: 101 });
        expect(badService.status).toBe(400);
    });

    it('il PUT parziale scrive una chiave sola e non tocca l\'altra', async () => {
        const cover = await api().put('/settings/charges').set(bearer(token)).send({ cover_charge_cents: 200 });
        expect(cover.status).toBe(200);
        expect(cover.body).toEqual({ cover_charge_cents: 200, service_charge_percent: 0 });

        const service = await api().put('/settings/charges').set(bearer(token)).send({ service_charge_percent: 10 });
        expect(service.status).toBe(200);
        expect(service.body).toEqual({ cover_charge_cents: 200, service_charge_percent: 10 });
    });

    it('gli importi finiscono sulla comanda come righe COVER e SERVICE', async () => {
        const orderId = await nuovaComanda(3);
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piattoId, qty: 2, course_no: 1 }],
        });
        expect(add.status).toBe(201);

        const coverLine = add.body.items.find((i: any) => i.line_kind === 'COVER');
        expect(coverLine, 'riga Coperto').toBeTruthy();
        expect(coverLine.name_snapshot).toBe('Coperto');
        expect(Number(coverLine.unit_price_cents)).toBe(200);
        expect(Number(coverLine.qty)).toBe(3); // uno a coperto

        // Il servizio è il 10% dell'imponibile dei PIATTI (2 × 1800), non
        // del coperto: addebitare il servizio sul coperto è l'errore che il
        // cliente contesta.
        const serviceLine = add.body.items.find((i: any) => i.line_kind === 'SERVICE');
        expect(serviceLine, 'riga Servizio').toBeTruthy();
        expect(serviceLine.name_snapshot).toBe('Servizio 10%');
        expect(Number(serviceLine.unit_price_cents)).toBe(360);
        expect(Number(serviceLine.qty)).toBe(1);
    });

    it('a zero le righe di sistema spariscono alla mutazione successiva', async () => {
        const orderId = await nuovaComanda(2);
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piattoId, qty: 1, course_no: 1 }],
        });
        expect(add.status).toBe(201);
        expect(add.body.items.some((i: any) => i.line_kind === 'COVER')).toBe(true);

        const off = await api().put('/settings/charges').set(bearer(token)).send({
            cover_charge_cents: 0, service_charge_percent: 0,
        });
        expect(off.status).toBe(200);

        // La comanda aperta si adegua alla battitura successiva.
        const add2 = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: piattoId, qty: 1, course_no: 1 }],
        });
        expect(add2.status).toBe(201);
        expect(add2.body.items.some((i: any) => i.line_kind === 'COVER')).toBe(false);
        expect(add2.body.items.some((i: any) => i.line_kind === 'SERVICE')).toBe(false);
    });
});
