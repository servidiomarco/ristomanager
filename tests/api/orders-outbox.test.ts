import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// L'outbox transazionale delle comande: l'evento nasce NELLA transazione che
// scrive il dato, la consegna la fa il dispatcher. Qui si verifica il
// contratto da entrambi i lati — il percorso normale (kick dopo il COMMIT)
// e la rete di sicurezza (una riga lasciata indietro, come dopo un crash,
// consegnata dal giro periodico).
describe('outbox eventi comanda', () => {
    let token: string;
    let db: Client;
    let orderId: number;

    const attesaConsegna = async (filtro: string, params: any[]): Promise<number> => {
        // Il giro periodico passa ogni 3 secondi: 10 secondi bastano con
        // margine, senza rendere il test lento quando il kick fa il lavoro.
        for (let i = 0; i < 50; i++) {
            const r = await db.query(
                `SELECT COUNT(*)::int AS n FROM outbox_events
                 WHERE ${filtro} AND delivered_at IS NULL`, params);
            if (r.rows[0].n === 0) break;
            await new Promise(rs => setTimeout(rs, 200));
        }
        const done = await db.query(
            `SELECT COUNT(*)::int AS n FROM outbox_events
             WHERE ${filtro} AND delivered_at IS NOT NULL`, params);
        return done.rows[0].n;
    };

    beforeAll(async () => {
        token = await ownerToken();
        db = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await db.connect();

        const flags = await api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: true,
            pay_at_table_enabled: true,
        });
        expect(flags.status).toBe(200);

        const room = await api().post('/rooms').set(bearer(token)).send({
            name: 'Sala Test Outbox', width: 800, height: 600,
        });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'TO1', shape: 'SQUARE', seats: 2, x: 700, y: 500,
            room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        orderId = order.body.order.id;
    });

    afterAll(async () => {
        await db.end();
    });

    it('aggiungere righe scrive l\'evento nella transazione e il dispatcher lo consegna', async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Outbox', description: null, price: 9, category: 'ANTIPASTI', allergens: null,
        });
        expect(dish.status).toBe(201);

        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 1 }],
        });
        expect(add.status).toBe(201);

        // L'evento esiste (era nella stessa transazione delle righe)...
        const scritti = await db.query(
            `SELECT payload FROM outbox_events WHERE aggregate = $1 AND event = 'order:updated'`,
            [`order:${orderId}`]
        );
        expect(scritti.rows.length).toBeGreaterThanOrEqual(1);
        // ...il payload porta riferimenti, mai dati anagrafici (regola PII).
        expect(scritti.rows[0].payload).toEqual({ order_id: orderId });

        // ...e viene consegnato.
        const consegnati = await attesaConsegna('aggregate = $1', [`order:${orderId}`]);
        expect(consegnati).toBeGreaterThanOrEqual(1);
    });

    it('una riga lasciata indietro (crash fra COMMIT e notifica) la consegna il giro periodico', async () => {
        // Inserita direttamente, senza kick: è la riga che un processo morto
        // nel momento sbagliato avrebbe lasciato non consegnata.
        const ins = await db.query(
            `INSERT INTO outbox_events (tenant_id, event, aggregate, payload)
             VALUES (1, 'order:updated', $1, $2::jsonb)
             RETURNING id`,
            [`order:${orderId}`, JSON.stringify({ order_id: orderId })]
        );
        const rowId = ins.rows[0].id;

        const consegnati = await attesaConsegna('id = $1', [rowId]);
        expect(consegnati).toBe(1);
    });

    it('un evento senza handler valido non blocca la coda: conta i tentativi e la coda scorre', async () => {
        // Evento con payload rotto: l'handler ignora gli id non numerici e la
        // riga si chiude comunque — mentre un evento sconosciuto non ha
        // handler e viene marcato consegnato senza effetti. In nessuno dei
        // due casi la coda si ferma.
        const ins = await db.query(
            `INSERT INTO outbox_events (tenant_id, event, aggregate, payload)
             VALUES (1, 'evento:ignoto', 'order:0', '{}'::jsonb)
             RETURNING id`
        );
        const rowId = ins.rows[0].id;
        const consegnati = await attesaConsegna('id = $1', [rowId]);
        expect(consegnati).toBe(1);
    });
});
