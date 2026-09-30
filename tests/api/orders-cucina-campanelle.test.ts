import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Le campanelle «uscita pronta» di un tavolo (tag course-<comanda>-<uscita>)
// non devono restare accese quando non c'è più niente da portare: spunta
// «pronto» tolta dal cuoco, comanda chiusa, comanda cancellata. La chiusura
// all'uscita servita è coperta in notifiche-lettura-condivisa.

const dbUrl = () => process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';

describe('comande · campanelle dei tavoli', () => {
    let token = '';
    let ownerId = 0;
    let salaId = 0;
    let piatto = 0;
    let n = 0;
    let db: Client;

    const nuovaComanda = async (): Promise<number> => {
        const table = await api().post('/tables').set(bearer(token)).send({
            name: `CP${++n}`, shape: 'SQUARE', seats: 4, x: 100 + n * 60, y: 420, room_id: salaId, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        return order.body.order.id as number;
    };

    // Comanda con un piatto già lanciato in cucina: ritorna l'id della riga.
    const lanciata = async (orderId: number): Promise<number> => {
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token))
            .send({ items: [{ dish_id: piatto, qty: 1, course_no: 1 }] });
        expect(add.status).toBe(201);
        await api().post(`/orders/${orderId}/send`).set(bearer(token)).send({});
        await api().post(`/orders/${orderId}/courses/1/fire`).set(bearer(token)).send({});
        const view = await api().get(`/orders/${orderId}`).set(bearer(token));
        return view.body.items.find((i: any) => i.dish_id === piatto).id;
    };

    const campanella = async (orderId: number) => {
        for (let i = 0; i < 30; i++) {
            const r = await db.query(
                `SELECT read_at FROM notifications WHERE recipient_user_id = $1 AND tag = $2`,
                [ownerId, `course-${orderId}-1`]
            );
            if (r.rows[0]) return r.rows[0];
            await new Promise(res => setTimeout(res, 100));
        }
        return null;
    };
    const letta = async (orderId: number) => (await db.query(
        `SELECT read_at FROM notifications WHERE recipient_user_id = $1 AND tag = $2`,
        [ownerId, `course-${orderId}-1`]
    )).rows[0]?.read_at ?? null;

    beforeAll(async () => {
        token = await ownerToken();
        const me = await api().post('/auth/login').send({
            email: process.env.TEST_OWNER_EMAIL, password: process.env.TEST_OWNER_PASSWORD,
        });
        ownerId = me.body.user.id;
        const flags = await api().put('/settings/features').set(bearer(token))
            .send({ table_orders_enabled: true, pay_at_table_enabled: true });
        expect(flags.status).toBe(200);
        const mode = await api().put('/sala/fire-mode').set(bearer(token)).send({ mode: 'MANUAL' });
        expect(mode.status).toBe(200);
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Campanelle', width: 800, height: 600 });
        expect(room.status).toBe(201);
        salaId = room.body.id;
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Risotto Campanella', description: null, price: 14, category: 'PRIMI', allergens: null,
        });
        expect(dish.status).toBe(201);
        piatto = dish.body.id;
        db = new Client({ connectionString: dbUrl() });
        await db.connect();
    });

    afterAll(async () => {
        try {
            await db.query(`DELETE FROM notifications WHERE recipient_user_id = $1 AND tag LIKE 'course-%'`, [ownerId]);
        } finally {
            await db.end();
        }
    });

    it('spunta «pronto» tolta: la campanella si spegne, e si riaccende al nuovo pronto', async () => {
        const orderId = await nuovaComanda();
        const riga = await lanciata(orderId);

        expect((await api().post(`/kds/items/${riga}/status`).set(bearer(token)).send({ status: 'READY' })).status).toBe(200);
        const accesa = await campanella(orderId);
        expect(accesa).not.toBeNull();
        expect(accesa.read_at).toBeNull();

        expect((await api().post(`/kds/items/${riga}/status`).set(bearer(token)).send({ status: 'PREPARING' })).status).toBe(200);
        expect(await letta(orderId)).not.toBeNull();

        expect((await api().post(`/kds/items/${riga}/status`).set(bearer(token)).send({ status: 'READY' })).status).toBe(200);
        let riaccesa: any = 'x';
        for (let i = 0; i < 30 && riaccesa !== null; i++) {
            riaccesa = await letta(orderId);
            if (riaccesa !== null) await new Promise(res => setTimeout(res, 100));
        }
        expect(riaccesa).toBeNull();
    });

    it('comanda chiusa: la campanella si spegne', async () => {
        const orderId = await nuovaComanda();
        const riga = await lanciata(orderId);
        await api().post(`/kds/items/${riga}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(await campanella(orderId)).not.toBeNull();

        const close = await api().post(`/orders/${orderId}/close`).set(bearer(token)).send({});
        expect(close.status).toBeLessThan(300);
        expect(await letta(orderId)).not.toBeNull();
    });

    it('comanda cancellata: la campanella si spegne', async () => {
        const orderId = await nuovaComanda();
        const riga = await lanciata(orderId);
        await api().post(`/kds/items/${riga}/status`).set(bearer(token)).send({ status: 'READY' });
        expect(await campanella(orderId)).not.toBeNull();

        // Righe già in cucina: si cancella solo forzando, con un motivo.
        const del = await api().delete(`/orders/${orderId}?forza=1`).set(bearer(token))
            .send({ motivo: 'prova campanelle' });
        expect(del.status).toBeLessThan(300);
        expect(await letta(orderId)).not.toBeNull();
    });
});
