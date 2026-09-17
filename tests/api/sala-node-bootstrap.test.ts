import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { Client } from 'pg';
import { api, bearer, ownerToken } from './helpers';

// Fase 2c della tappa 4, end-to-end vero: un secondo dist/server.js parte
// col profilo service-node su un database FRESCO, scarica lo snapshot dal
// server di test (che fa da cloud) col token del nodo, carica le proiezioni
// e registra il cursore. È il collaudo del «nodo bestiame»: token + replay,
// niente mani.

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

const NODE_DB = 'ristotest_node_bootstrap';

describe('bootstrap del nodo di sala', () => {
    let child: ChildProcess | null = null;
    let nodeDb: Client | null = null;
    let roomId = 0;
    let cloudSeqPrima = 0;

    beforeAll(async () => {
        const token = await ownerToken();
        const cloudDbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        const cloudDb = new Client({ connectionString: cloudDbUrl });
        await cloudDb.connect();
        const t = await cloudDb.query('SELECT sala_node_token FROM tenants WHERE id = 1');
        const nodeToken = t.rows[0].sala_node_token as string;

        // Un segnaposto sul cloud che dovrà riapparire sul nodo, e il seq del
        // log prima del bootstrap: il cursore del nodo dovrà stare almeno lì.
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Bootstrap E2E', width: 640, height: 480 });
        expect(room.status).toBe(201);
        roomId = room.body.id;
        const seqRs = await cloudDb.query('SELECT COALESCE(MAX(id), 0)::bigint AS seq FROM outbox_events WHERE tenant_id = 1');
        cloudSeqPrima = Number(seqRs.rows[0].seq);

        // Il database del nodo: fresco a ogni giro, come un PC appena
        // installato. Stesso host localhost del DB di test (guardia già in
        // globalSetup: mai host remoti).
        const url = new URL(cloudDbUrl);
        url.pathname = '/postgres';
        const admin = new Client({ connectionString: url.toString() });
        await admin.connect();
        await admin.query(`DROP DATABASE IF EXISTS ${NODE_DB} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${NODE_DB}`);
        await admin.end();
        await cloudDb.end();

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
                JWT_SECRET: 'test-jwt-secret',
                JWT_REFRESH_SECRET: 'test-jwt-refresh-secret',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Il log del nodo si accumula e si stampa solo se il bootstrap non
        // arriva: è l'unico posto dove leggere un errore del processo figlio.
        let nodeLog = '';
        child.stdout?.on('data', (d) => { nodeLog += String(d); });
        child.stderr?.on('data', (d) => { nodeLog += String(d); });
        (child as any).__log = () => nodeLog;

        nodeDb = new Client({ connectionString: nodeDbUrl });
        // Il DB nasce ora: la connessione riesce subito, ma schema e
        // bootstrap arrivano col boot del nodo — si aspetta il cursore.
        await nodeDb.connect();
        const deadline = Date.now() + 90_000;
        for (;;) {
            if (child.exitCode !== null) throw new Error(`Nodo uscito subito (exit ${child.exitCode})`);
            try {
                const cur = await nodeDb.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'cloud'`);
                if (cur.rows.length > 0) break;
            } catch { /* schema non ancora migrato */ }
            if (Date.now() > deadline) {
                throw new Error(`Bootstrap del nodo non completato entro 90s. Log del nodo:\n${(child as any).__log?.().slice(-4000)}`);
            }
            await sleep(500);
        }
    }, 120_000);

    afterAll(async () => {
        child?.kill('SIGKILL');
        await nodeDb?.end().catch(() => {});
        // Il DB del nodo si lascia: il prossimo giro lo ricrea (FORCE), e
        // in caso di rosso resta lì da ispezionare.
    });

    it('il cursore è registrato al seq dello snapshot, non prima del log visto dal cloud', async () => {
        const cur = await nodeDb!.query(`SELECT tenant_id, applied_seq FROM replication_cursor WHERE stream = 'cloud'`);
        expect(cur.rows.length).toBe(1);
        expect(cur.rows[0].tenant_id).toBe(1);
        expect(Number(cur.rows[0].applied_seq)).toBeGreaterThanOrEqual(cloudSeqPrima);
    });

    it('le proiezioni ci sono: la sala creata sul cloud esiste sul nodo', async () => {
        const rooms = await nodeDb!.query('SELECT id, name FROM rooms WHERE id = $1', [roomId]);
        expect(rooms.rows.length).toBe(1);
        expect(rooms.rows[0].name).toBe('Sala Bootstrap E2E');
    });

    it('gli hash non sono arrivati: sul nodo solo la sentinella non verificabile', async () => {
        const users = await nodeDb!.query(
            `SELECT COUNT(*)::int AS n,
                    COUNT(*) FILTER (WHERE password_hash <> '!nodo-di-sala')::int AS con_hash
             FROM users`
        );
        expect(users.rows[0].n).toBeGreaterThan(0);
        expect(users.rows[0].con_hash).toBe(0);
    });

    it('le sequence locali sono oltre gli id del cloud: un INSERT nativo non collide', async () => {
        const ins = await nodeDb!.query(
            `INSERT INTO rooms (tenant_id, name, width, height) VALUES (1, 'Post Bootstrap', 100, 100) RETURNING id`
        );
        expect(ins.rows[0].id).toBeGreaterThan(roomId);
        await nodeDb!.query('DELETE FROM rooms WHERE id = $1', [ins.rows[0].id]);
    });
});
