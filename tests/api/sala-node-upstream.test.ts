import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 4a della tappa 4, end-to-end: lo STREAM INVERSO. Si scrive SUL NODO
// (il suo server HTTP, con lo stesso JWT del cloud: la verifica è stateless
// col segreto condiviso) e si guarda il cloud convergere — pull con cursore
// via RPC socket, inbox transazionale, import con origin='replica' che fa
// partire i broadcast dal dispatcher del cloud. E il cerchio non fa eco:
// l'evento importato non viene mai rispedito da dove è venuto.

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

const NODE_DB = 'ristotest_node_upstream';

describe('stream inverso nodo→cloud', () => {
    let token: string;
    let child: ChildProcess | null = null;
    let nodeDb: Client | null = null;
    let cloudDb: Client | null = null;
    let nodeBase = '';
    let nodeLog = '';
    let tableId = 0;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 25_000): Promise<void> => {
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
        const cloudDbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        cloudDb = new Client({ connectionString: cloudDbUrl });
        await cloudDb.connect();
        const t = await cloudDb.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        const nodeToken = t.rows[0].sala_node_token as string;

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
        nodeBase = `http://127.0.0.1:${port}`;
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

        // Un tavolo nato sul cloud che scende sul nodo: il campo di gioco.
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Inversa', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'INV1', shape: 'SQUARE', seats: 4, x: 80, y: 80, room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
        // table:created è autorità cloud e non è (ancora) nel log: per far
        // scendere la riga serve un evento che la citi — un PUT innocuo.
        const touch = await api().put(`/tables/${tableId}`).set(bearer(token)).send({ seats: 4 });
        expect(touch.status).toBe(200);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM tables WHERE id = $1', [tableId]);
            return r.rows.length === 1;
        }, 'tavolo sceso sul nodo');
    }, 150_000);

    afterAll(async () => {
        child?.kill('SIGKILL');
        await nodeDb?.end().catch(() => {});
        await cloudDb?.end().catch(() => {});
    });

    it('una scrittura SUL NODO converge sul cloud, coi broadcast dal dispatcher', async () => {
        // Il JWT del cloud vale sul nodo: verifica stateless, segreto condiviso.
        const upd = await fetch(`${nodeBase}/tables/${tableId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ status: 'OCCUPIED' }),
        });
        expect(upd.status).toBe(200);
        // Applicata subito sul nodo (è lui l'autorità della scrittura)...
        const locale = await nodeDb!.query('SELECT status FROM tables WHERE id = $1', [tableId]);
        expect(locale.rows[0].status).toBe('OCCUPIED');
        // ...e il cloud converge dallo stream inverso.
        await finoA(async () => {
            const r = await cloudDb!.query('SELECT status FROM tables WHERE id = $1', [tableId]);
            return r.rows[0]?.status === 'OCCUPIED';
        }, 'tavolo OCCUPIED risalito sul cloud');

        // L'evento del nodo sta nel log del cloud come importato, UNA volta.
        const imported = await cloudDb!.query(
            `SELECT origin, COUNT(*)::int AS n FROM outbox_events
             WHERE aggregate = $1 AND event = 'table:updated' AND origin = 'replica'
             GROUP BY origin`,
            [`table:${tableId}`]
        );
        expect(imported.rows[0]?.n).toBe(1);

        // Il cursore dello stream 'node' esiste ed è avanzato.
        const cur = await cloudDb!.query(`SELECT applied_seq FROM replication_cursor WHERE tenant_id = 1 AND stream = 'node'`);
        expect(Number(cur.rows[0]?.applied_seq ?? 0)).toBeGreaterThan(0);
    });

    it("un'unione fatta sul nodo appare sul cloud (payload-snapshot risalito)", async () => {
        const t2cloud = await api().post('/tables').set(bearer(token)).send({
            name: 'INV2', shape: 'SQUARE', seats: 2, x: 300, y: 80,
            room_id: (await cloudDb!.query('SELECT room_id FROM tables WHERE id = $1', [tableId])).rows[0].room_id,
            status: 'FREE',
        });
        expect(t2cloud.status).toBe(201);
        const touch = await api().put(`/tables/${t2cloud.body.id}`).set(bearer(token)).send({ seats: 2 });
        expect(touch.status).toBe(200);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM tables WHERE id = $1', [t2cloud.body.id]);
            return r.rows.length === 1;
        }, 'secondo tavolo sceso sul nodo');

        const merge = await fetch(`${nodeBase}/table-merges`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ date: '2027-06-06', shift: 'DINNER', primary_id: tableId, merged_ids: [t2cloud.body.id] }),
        });
        expect(merge.status).toBe(201);
        const mergeBody = await merge.json();

        await finoA(async () => {
            const r = await cloudDb!.query('SELECT 1 FROM table_merges WHERE id = $1', [mergeBody.id]);
            return r.rows.length === 1;
        }, 'unione del nodo risalita sul cloud');
    });

    it("l'interruttore autorità si accende ad allineamento raggiunto e si spegne col drenaggio (4b)", async () => {
        // L'ibrido va acceso (l'interruttore lo esige) — si rimette dopo.
        const flags = await api().get('/settings/features').set(bearer(token));
        const hybridPrima = flags.body.sala_node_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: true });
        try {
            // L'allineamento arriva da solo (i due consumatori girano).
            await finoA(async () => {
                const o = await api().get('/sala-node/authority').set(bearer(token));
                return o.body.node_online === true && o.body.aligned === true;
            }, 'repliche allineate nei due sensi');

            const on = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
            expect(on.status).toBe(200);
            expect(on.body.enabled).toBe(true);

            // Lo spegnimento drena (qui è già tutto importato) e restituisce.
            const off = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
            expect(off.status).toBe(200);
            expect(off.body.enabled).toBe(false);
        } finally {
            await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: hybridPrima });
        }
    });

    it("niente eco: l'evento importato dal nodo non riscende al nodo come nuovo", async () => {
        // Lo stream in discesa manda solo origin='local': l'evento del
        // tavolo (nato sul nodo, importato dal cloud) non deve tornare.
        const eco = await cloudDb!.query(
            `SELECT event_id FROM outbox_events
             WHERE aggregate = $1 AND event = 'table:updated' AND origin = 'replica'`,
            [`table:${tableId}`]
        );
        const eventId = eco.rows[0].event_id;
        // Sul NODO quell'event_id esiste UNA volta sola (l'originale locale):
        // se l'eco esistesse, l'import ne avrebbe creata una copia... che
        // l'ON CONFLICT su event_id scarta comunque — doppia cintura.
        const suNodo = await nodeDb!.query(
            `SELECT COUNT(*)::int AS n, MIN(origin) AS o FROM outbox_events WHERE event_id = $1`,
            [eventId]
        );
        expect(suNodo.rows[0].n).toBe(1);
        expect(suNodo.rows[0].o).toBe('local');
    });
});
