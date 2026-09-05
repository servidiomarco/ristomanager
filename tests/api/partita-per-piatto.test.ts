import { describe, it, expect, beforeAll } from 'vitest';
import { api, bearer, ownerToken } from './helpers';

// Partita per singolo piatto (dishes.station_id): vince sulla mappa
// categoria→partita quando il piatto viene battuto, senza toccare la
// categoria (e quindi dove il piatto compare sull'orderpad). Il caso
// concreto: le patatine stanno nei Contorni a menu ma escono agli Antipasti.
describe('partita per singolo piatto', () => {
    let token: string;
    let salaId: number;
    let antipastiId: number;
    let contorniId: number;
    let patatineId: number;
    let nTavoli = 0;

    const nuovaComanda = async (): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `TP${++nTavoli}`, shape: 'SQUARE', seats: 4,
            x: 100 + nTavoli * 60, y: 500, room_id: salaId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        return order.body.order.id as number;
    };

    const rigaPatatine = async (orderId: number) => {
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: patatineId, qty: 1, course_no: 1 }],
        });
        expect(add.status).toBe(201);
        return add.body.items.find((i: any) => i.dish_id === patatineId);
    };

    beforeAll(async () => {
        token = await ownerToken();

        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Partite', width: 800, height: 600,
        });
        expect(room.status).toBe(201);
        salaId = room.body.id;

        for (const [name, setId] of [
            ['Antipasti PP', (id: number) => { antipastiId = id; }],
            ['Contorni PP', (id: number) => { contorniId = id; }],
        ] as const) {
            const st = await api().post('/sala/stations').set(bearer(token)).send({ name });
            expect(st.status).toBe(201);
            setId(st.body.id);
        }

        // La categoria dei contorni è mappata alla SUA partita: è il default
        // che l'override sul piatto deve battere.
        const map = await api().put('/sala/category-stations').set(bearer(token)).send({
            category: 'CONTORNI-PP', station_id: contorniId,
        });
        expect(map.status).toBe(200);
    });

    it('il piatto nasce con la partita propria e la risposta la riporta', async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Patatine Collaudo', description: null, price: 5,
            category: 'CONTORNI-PP', allergens: null, station_id: antipastiId,
        });
        expect(dish.status).toBe(201);
        expect(dish.body.station_id).toBe(antipastiId);
        expect(dish.body.category).toBe('CONTORNI-PP');
        patatineId = dish.body.id;
    });

    it('alla battuta la riga esce nella partita del piatto, non in quella della categoria', async () => {
        const riga = await rigaPatatine(await nuovaComanda());
        expect(riga.station_id).toBe(antipastiId);
    });

    it('una PUT senza station_id non tocca l\'assegnazione (client vecchi)', async () => {
        const put = await api().put(`/dishes/${patatineId}`).set(bearer(token)).send({
            name: 'Patatine Collaudo', description: 'fritte', price: 5.5,
            category: 'CONTORNI-PP', allergens: null,
        });
        expect(put.status).toBe(200);
        expect(put.body.station_id).toBe(antipastiId);
    });

    it('station_id null torna a seguire la categoria', async () => {
        const put = await api().put(`/dishes/${patatineId}`).set(bearer(token)).send({
            name: 'Patatine Collaudo', description: 'fritte', price: 5.5,
            category: 'CONTORNI-PP', allergens: null, station_id: null,
        });
        expect(put.status).toBe(200);
        expect(put.body.station_id).toBeNull();

        const riga = await rigaPatatine(await nuovaComanda());
        expect(riga.station_id).toBe(contorniId);
    });

    it('una partita inesistente fa 400, in creazione e in modifica', async () => {
        const post = await api().post('/dishes').set(bearer(token)).send({
            name: 'Piatto Rotto', description: null, price: 1,
            category: 'CONTORNI-PP', allergens: null, station_id: 999999,
        });
        expect(post.status).toBe(400);

        const put = await api().put(`/dishes/${patatineId}`).set(bearer(token)).send({
            name: 'Patatine Collaudo', description: 'fritte', price: 5.5,
            category: 'CONTORNI-PP', allergens: null, station_id: 999999,
        });
        expect(put.status).toBe(400);
    });
});
