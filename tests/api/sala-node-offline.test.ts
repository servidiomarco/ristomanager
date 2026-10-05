import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { Client } from 'pg';
import jwt from 'jsonwebtoken';
import { io as ioClient } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';

// Fase A2 del piano «sala, comande e conto sul nodo», end-to-end: il nodo
// parla col cloud attraverso un proxy TCP che il test può STACCARE — la
// linea del ristorante che cade, con il nodo e i palmari ancora vivi.
// - la configurazione (utenti, piatti, tavoli nuovi) scende sul nodo da sola,
//   senza password;
// - il token di un altro tenant non apre il nodo;
// - a linea giù un token scaduto da poco, di un utente attivo, vale ancora
//   (route e socket); oltre la proroga, o per un utente disattivato, il nodo
//   risponde session_expired_offline.

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

// La «linea» fra nodo e cloud: ogni connessione del nodo passa di qui.
// cut() chiude tutto e smette di accettare, come un router che perde la WAN.
const startLine = async (targetPort: number) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((inbound) => {
        const outbound = net.connect(targetPort, '127.0.0.1');
        for (const s of [inbound, outbound]) {
            sockets.add(s);
            s.on('close', () => sockets.delete(s));
            s.on('error', () => { inbound.destroy(); outbound.destroy(); });
        }
        inbound.pipe(outbound).pipe(inbound);
    });
    const port = await freePort();
    await new Promise<void>(r => server.listen(port, '127.0.0.1', () => r()));
    return {
        url: `http://127.0.0.1:${port}`,
        cut: async () => {
            await new Promise<void>(r => { server.close(() => r()); for (const s of sockets) s.destroy(); });
        },
    };
};

const NODE_DB = 'ristotest_node_offline';
const PRIVATE_KEY = process.env.TEST_JWT_ES256_PRIVATE_KEY as string;

describe('nodo di sala a linea giù: configurazione allineata e proroga degli accessi', () => {
    let ownerAccess: string;
    let ownerClaims: any;
    let kid: string;
    let child: ChildProcess | null = null;
    let nodeDb: Client | null = null;
    let cloudDb: Client | null = null;
    let nodeBase = '';
    let nodeLog = '';
    let line: Awaited<ReturnType<typeof startLine>>;
    let waiterId = 0;
    let renamedDish: { id: number; name: string } | null = null;

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 30_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) {
                // Senza le righe di accesso HTTP: qui il test fa polling.
                const log = nodeLog.split('\n').filter(l => !/\] (GET|POST|PUT|PATCH|DELETE) \//.test(l)).join('\n');
                throw new Error(`Timeout: ${descr}. Log del nodo:\n${log.slice(-3000)}`);
            }
            await sleep(300);
        }
    };

    // Token coniati con la chiave della suite: scadenze e tenant che il
    // cloud non emetterebbe mai.
    const mint = (claims: Record<string, unknown>, expiresInSec: number): string => {
        const now = Math.floor(Date.now() / 1000);
        return jwt.sign(
            { ...claims, iat: now - 6 * 3600, exp: now + expiresInSec },
            PRIVATE_KEY,
            { algorithm: 'ES256', keyid: kid }
        );
    };
    // Una lettura di sala che il nodo serve sempre (il modulo comande, a
    // questo punto della suite, può essere spento).
    const nodeGet = (token: string) => fetch(`${nodeBase}/sala/config`, { headers: { Authorization: `Bearer ${token}` } });

    beforeAll(async () => {
        expect(PRIVATE_KEY).toContain('PRIVATE KEY');
        ownerAccess = await ownerToken();
        const [h, p] = ownerAccess.split('.');
        kid = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')).kid;
        ownerClaims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));

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

        line = await startLine(Number(new URL(process.env.TEST_BASE_URL as string).port));

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
                SALA_NODE_CLOUD_URL: line.url,
                SALA_NODE_TOKEN: nodeToken,
                SALA_NODE_PULL_INTERVAL_MS: '1000',
                SALA_NODE_CONFIG_SYNC_MS: '1000',
                SALA_NODE_UPLINK_DOWN_AFTER_MS: '1000',
                JWT_SECRET: '',
                JWT_REFRESH_SECRET: '',
                SALA_NODE_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), 'nodo-offline-')),
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
    }, 150_000);

    afterAll(async () => {
        child?.kill('SIGKILL');
        await line?.cut().catch(() => {});
        await nodeDb?.end().catch(() => {});
        if (waiterId) await cloudDb?.query('DELETE FROM users WHERE id = $1', [waiterId]).catch(() => {});
        if (renamedDish) await cloudDb?.query('UPDATE dishes SET name = $2 WHERE id = $1', [renamedDish.id, renamedDish.name]).catch(() => {});
        await cloudDb?.end().catch(() => {});
    });

    it('la configurazione cambiata nel cloud scende sul nodo, senza password', async () => {
        // Un utente nato DOPO il bootstrap: prima di questa fase non
        // arrivava mai, e le sue comande sul nodo violavano la FK.
        const created = await api().post('/auth/users').set(bearer(ownerAccess)).send({
            email: `cameriere.offline.${Date.now()}@example.com`,
            password: 'Password-di-prova-1',
            full_name: 'Cameriere Offline',
            role: 'WAITER',
        });
        expect(created.status).toBe(201);
        waiterId = created.body.id;
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT password_hash, is_active FROM users WHERE id = $1', [waiterId]);
            return r.rows.length === 1;
        }, 'utente nuovo sul nodo');
        const sulNodo = await nodeDb!.query('SELECT password_hash FROM users WHERE id = $1', [waiterId]);
        expect(sulNodo.rows[0].password_hash).toBe('!nodo-di-sala');

        // Un piatto rinominato e un tavolo nuovo: menu e pianta non restano
        // fermi alla foto dell'installazione.
        const dish = await cloudDb!.query(`SELECT id, name FROM dishes WHERE tenant_id = 1 ORDER BY id LIMIT 1`);
        const dishId = dish.rows[0]?.id;
        if (dishId) {
            renamedDish = { id: dishId, name: dish.rows[0].name };
            await cloudDb!.query(`UPDATE dishes SET name = 'Piatto rinominato offline' WHERE id = $1`, [dishId]);
            await finoA(async () => {
                const r = await nodeDb!.query('SELECT name FROM dishes WHERE id = $1', [dishId]);
                return r.rows[0]?.name === 'Piatto rinominato offline';
            }, 'piatto rinominato sul nodo');
        }
        const room = await api().post('/rooms').set(bearer(ownerAccess)).send({ name: 'Sala Offline', width: 600, height: 400 });
        const table = await api().post('/tables').set(bearer(ownerAccess)).send({
            name: 'OFF1', shape: 'SQUARE', seats: 2, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT 1 FROM tables WHERE id = $1', [table.body.id]);
            return r.rows.length === 1;
        }, 'tavolo nuovo sul nodo');

        // Disattivato nel cloud → disattivato sul nodo (serve alla proroga).
        const off = await api().put(`/auth/users/${waiterId}`).set(bearer(ownerAccess)).send({ is_active: false });
        expect(off.status).toBe(200);
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT is_active FROM users WHERE id = $1', [waiterId]);
            return r.rows[0]?.is_active === false;
        }, 'disattivazione sul nodo');
    }, 60_000);

    it('il token di un altro ristorante non apre il nodo', async () => {
        const altro = mint({ ...ownerClaims, tenantId: 999 }, 3600);
        expect((await nodeGet(altro)).status).toBe(401);
        expect((await nodeGet(ownerAccess)).status).toBe(200);
    });

    it('a linea su un token scaduto non ha proroga: il client deve rinnovare', async () => {
        const scaduto = mint(ownerClaims, -3600);
        const res = await nodeGet(scaduto);
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('Invalid or expired token');
    });

    it('a linea giù: proroga per chi è attivo, session_expired_offline per gli altri', async () => {
        await line.cut();
        const scadutoDaPoco = mint(ownerClaims, -3600);
        await finoA(async () => (await nodeGet(scadutoDaPoco)).status === 200, 'proroga a linea giù');

        // Anche il socket: un palmare che riattacca col token scaduto.
        const socket = ioClient(nodeBase, { transports: ['websocket'], auth: { token: scadutoDaPoco }, reconnection: false, timeout: 5_000 });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.on('connect', () => resolve());
                socket.on('connect_error', (err) => reject(err));
            });
        } finally {
            socket.close();
        }

        const troppoVecchio = mint(ownerClaims, -13 * 3600);
        const oltre = await nodeGet(troppoVecchio);
        expect(oltre.status).toBe(401);
        expect((await oltre.json()).error).toBe('session_expired_offline');

        const disattivato = mint({ userId: waiterId, email: 'x@example.com', role: 'WAITER', tenantId: 1 }, -600);
        const no = await nodeGet(disattivato);
        expect(no.status).toBe(401);
        expect((await no.json()).error).toBe('session_expired_offline');

        // Uno step-up scaduto non diventa un accesso perché la linea è giù.
        const stepUp = mint({ purpose: 'step_up', scope: 'compensi', userId: ownerClaims.userId, tenantId: 1 }, -60);
        expect((await nodeGet(stepUp)).status).toBe(401);

        // Il token valido resta valido, ovviamente.
        expect((await nodeGet(ownerAccess)).status).toBe(200);
    }, 60_000);
});
