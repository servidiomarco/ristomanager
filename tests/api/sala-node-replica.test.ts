import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 3 della tappa 4, end-to-end: un nodo vero (secondo dist/server.js,
// profilo service-node, DB fresco) si bootstrappa dal server di test e poi
// RESTA ALLINEATO mentre il cloud muta — pull con cursore svegliato dal
// socket, inbox transazionale, convergenza per rifetch. Include la proprietà
// più bella del rifetch: un aggregato nato DOPO il bootstrap (che il log
// delle creazioni ancora non copre) appare sul nodo al primo evento che lo
// tocca, perché la replica scarica la riga corrente, non il diff.

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
            const p = addr.port;
            srv.close(() => resolve(p));
        } else {
            srv.close(() => reject(new Error('no port')));
        }
    });
});

const NODE_DB = 'ristotest_node_replica';

describe('replica cloud→nodo', () => {
    let token: string;
    let child: ChildProcess | null = null;
    let nodeDb: Client | null = null;
    let nodeLog = '';
    let tableOrdersPrima = false;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 20_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) {
                throw new Error(`Timeout: ${descr}. Log del nodo:\n${nodeLog.slice(-3000)}`);
            }
            await sleep(300);
        }
    };

    beforeAll(async () => {
        token = await ownerToken();
        // Il modulo comande serve per il flusso ordini: com'era, si rimette.
        const flags = await api().get('/settings/features').set(bearer(token));
        tableOrdersPrima = flags.body.table_orders_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true });

        const cloudDbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const cloudDb = new Client({ connectionString: cloudDbUrl });
        await cloudDb.connect();
        const t = await cloudDb.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        const nodeToken = t.rows[0].sala_node_token as string;
        await cloudDb.end();

        const url = new URL(cloudDbUrl);
        url.pathname = '/postgres';
        const admin = new Client({ connectionString: url.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${NODE_DB} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${NODE_DB}`);
        await admin.end();

        const nodeDbUrl = (() => { const u = new URL(cloudDbUrl); u.pathname = `/${NODE_DB}`; return u.toString(); })();
        const distServer = path.resolve('dist/server.js');
        expect(existsSync(distServer)).toBe(true);
        const port = await freePort();
        child = spawn('node', [distServer], {
            env: {
                ...process.env,
                DATABASE_URL: nodeDbUrl,
                PORT: String(port),
                SERVER_PROFILE: 'service-node',
                SALA_NODE_CLOUD_URL: process.env.TEST_BASE_URL,
                SALA_NODE_TOKEN: nodeToken,
                SALA_NODE_PULL_INTERVAL_MS: '1000',
                JWT_SECRET: 'test-jwt-secret',
                JWT_REFRESH_SECRET: 'test-jwt-refresh-secret',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (d) => { nodeLog += String(d); });
        child.stderr?.on('data', (d) => { nodeLog += String(d); });

        nodeDb = new Client({ connectionString: nodeDbUrl });
        await nodeDb.connect();
        await finoA(async () => {
            if (child!.exitCode !== null) throw new Error(`Nodo uscito subito (exit ${child!.exitCode})`);
            try {
                const cur = await nodeDb!.query(`SELECT 1 FROM replication_cursor WHERE stream = 'cloud'`);
                return cur.rows.length > 0;
            } catch { return false; }
        }, 'bootstrap del nodo', 90_000);
    }, 120_000);

    afterAll(async () => {
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: tableOrdersPrima });
        child?.kill('SIGKILL');
        await nodeDb?.end().catch(() => {});
    });

    it('lo stato di un tavolo cambia sul cloud e converge sul nodo', async () => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Replica', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'RP1', shape: 'SQUARE', seats: 4, x: 60, y: 60, room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        const upd = await api().put(`/tables/${table.body.id}`).set(bearer(token)).send({ status: 'OCCUPIED' });
        expect(upd.status).toBe(200);

        await finoA(async () => {
            const r = await nodeDb!.query('SELECT status FROM tables WHERE id = $1', [table.body.id]);
            return r.rows[0]?.status === 'OCCUPIED';
        }, 'tavolo OCCUPIED replicato');
    });

    it("un'unione appare e sparisce anche sul nodo", async () => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Replica U', width: 600, height: 400 });
        const t1 = await api().post('/tables').set(bearer(token)).send({ name: 'RU1', shape: 'SQUARE', seats: 2, x: 100, y: 100, room_id: room.body.id, status: 'FREE' });
        const t2 = await api().post('/tables').set(bearer(token)).send({ name: 'RU2', shape: 'SQUARE', seats: 2, x: 300, y: 100, room_id: room.body.id, status: 'FREE' });
        const merge = await api().post('/table-merges').set(bearer(token)).send({
            date: '2027-05-05', shift: 'DINNER', primary_id: t1.body.id, merged_ids: [t2.body.id],
        });
        expect(merge.status).toBe(201);

        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM table_merges WHERE id = $1', [merge.body.id]);
            return r.rows.length === 1;
        }, 'unione replicata');

        const del = await api().delete('/table-merges').set(bearer(token)).send({
            date: '2027-05-05', shift: 'DINNER', primary_id: t1.body.id,
        });
        expect(del.status).toBe(200);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM table_merges WHERE id = $1', [merge.body.id]);
            return r.rows.length === 0;
        }, 'divisione replicata');
    });

    it('una prenotazione appena creata appare sul nodo senza bisogno di altri eventi (3b)', async () => {
        const resv = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Replica Nascita',
            phone: '340 555 4411',
            reservation_time: '2027-05-08T20:00:00.000Z',
            shift: 'DINNER',
            guests: 3,
        });
        expect(resv.status).toBe(201);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT guests FROM reservations WHERE id = $1', [resv.body.id]);
            return r.rows[0]?.guests === 3;
        }, 'prenotazione nata e replicata');
    });

    it('una comanda disfatta sparisce anche dal nodo (3b)', async () => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Replica D', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({ name: 'RD1', shape: 'SQUARE', seats: 2, x: 400, y: 200, room_id: room.body.id, status: 'FREE' });
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id;
        // order:created è nel log: la comanda vuota (DRAFT) arriva sul nodo.
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
            return r.rows.length === 1;
        }, 'comanda nata e replicata');
        const del = await api().delete(`/orders/${orderId}`).set(bearer(token));
        expect(del.status).toBe(200);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
            return r.rows.length === 0;
        }, 'comanda disfatta anche sul nodo');
    });

    it("un asporto creato dal banco converge con le sue righe (3b)", async () => {
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Asporto Replica', description: null, price: 12, category: 'ANTIPASTI', allergens: null,
        });
        expect(dish.status).toBe(201);
        const tw = await api().post('/takeaway/orders').set(bearer(token)).send({
            customer_name: 'Asporto Replica',
            pickup_date: '2027-05-09',
            pickup_time: '19:30',
            force: true,
            items: [{ dish_id: dish.body.id, qty: 2 }],
        });
        expect(tw.status).toBe(201);
        await finoA(async () => {
            const o = await nodeDb!.query('SELECT 1 FROM takeaway_orders WHERE id = $1', [tw.body.id]);
            if (o.rows.length === 0) return false;
            const items = await nodeDb!.query('SELECT qty FROM takeaway_order_items WHERE takeaway_order_id = $1', [tw.body.id]);
            return items.rows.length === 1 && Number(items.rows[0].qty) === 2;
        }, 'asporto replicato con le righe');
    });

    it('una prenotazione nata DOPO il bootstrap appare al primo evento che la tocca', async () => {
        const resv = await api().post('/reservations').set(bearer(token)).send({
            customer_name: 'Replica Convergenza',
            phone: '340 555 3399',
            reservation_time: '2027-05-06T20:00:00.000Z',
            shift: 'DINNER',
            guests: 2,
        });
        expect(resv.status).toBe(201);
        // Il POST non è (ancora) nel log: sul nodo non c'è. Il PUT sì — e il
        // rifetch porta la riga INTERA, sanando la creazione mancante.
        const upd = await api().put(`/reservations/${resv.body.id}`).set(bearer(token)).send({
            customer_name: resv.body.customer_name,
            phone: resv.body.phone,
            reservation_time: resv.body.reservation_time,
            shift: resv.body.shift,
            guests: 4,
        });
        expect(upd.status).toBe(200);

        await finoA(async () => {
            const r = await nodeDb!.query('SELECT guests FROM reservations WHERE id = $1', [resv.body.id]);
            return r.rows[0]?.guests === 4;
        }, 'prenotazione convergiuta sul nodo');
    });

    it('una comanda con le sue righe converge in blocco', async () => {
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Replica O', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({ name: 'RO1', shape: 'SQUARE', seats: 2, x: 200, y: 200, room_id: room.body.id, status: 'FREE' });
        const order = await api().post('/orders').set(bearer(token)).send({ table_id: table.body.id });
        expect(order.status).toBe(201);
        const orderId = order.body.order.id;
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Fritto Replica', description: null, price: 11, category: 'ANTIPASTI', allergens: null,
        });
        const add = await api().post(`/orders/${orderId}/items`).set(bearer(token)).send({
            items: [{ dish_id: dish.body.id, qty: 2 }],
        });
        expect(add.status).toBe(201);

        await finoA(async () => {
            const o = await nodeDb!.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
            if (o.rows.length === 0) return false;
            const items = await nodeDb!.query('SELECT qty FROM order_items WHERE order_id = $1', [orderId]);
            return items.rows.length === 1 && Number(items.rows[0].qty) === 2;
        }, 'comanda e righe replicate');
    });

    it('il cursore del nodo raggiunge la testa del log del cloud', async () => {
        const cloudDb = new Client({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api' });
        await cloudDb.connect();
        const head = Number((await cloudDb.query('SELECT COALESCE(MAX(id),0)::bigint AS h FROM outbox_events WHERE tenant_id = 1')).rows[0].h);
        await cloudDb.end();
        await finoA(async () => {
            const cur = await nodeDb!.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'cloud'`);
            return Number(cur.rows[0]?.applied_seq ?? 0) >= head;
        }, `cursore >= ${head}`);
    });
});
