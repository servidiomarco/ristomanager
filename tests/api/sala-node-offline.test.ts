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
    let offlineTableId = 0;

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
                SALA_NODE_STATS_INTERVAL_MS: '1000',
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
        await cloudDb?.query('UPDATE users SET service_pin_hash = NULL, service_pin_updated_at = NULL WHERE id = $1', [ownerClaims?.userId ?? 0]).catch(() => {});
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
        offlineTableId = table.body.id;
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

    it('occhi sul nodo a linea su: stato locale in LAN, versione e ritardi nella card del cloud', async () => {
        const local = await fetch(`${nodeBase}/sala-node/local-status`, { headers: { Authorization: `Bearer ${ownerAccess}` } });
        expect(local.status).toBe(200);
        const s = await local.json();
        expect(s.uplink_connected).toBe(true);
        expect(s.uplink_down_since).toBeNull();
        expect(typeof s.version).toBe('string');
        expect(s.pending_up).toBe(0);
        // Solo sul nodo.
        expect((await api().get('/sala-node/local-status').set(bearer(ownerAccess))).status).toBe(404);

        // Il battito porta versione e ritardi fino alla card del cloud.
        await finoA(async () => {
            const cfg = await api().get('/sala/config').set(bearer(ownerAccess));
            return typeof cfg.body?.sala_node?.lag_up_s === 'number';
        }, 'ritardi nella card del cloud');
        const cfg = await api().get('/sala/config').set(bearer(ownerAccess));
        expect(cfg.body.sala_node.version).toBe(cfg.body.sala_node.cloud_version);
        expect(typeof cfg.body.sala_node.lag_down_s).toBe('number');
        expect(cfg.body.sala_node.pending_up).toBe(0);
    }, 60_000);

    it('a linea su un token scaduto non ha proroga: il client deve rinnovare', async () => {
        const scaduto = mint(ownerClaims, -3600);
        const res = await nodeGet(scaduto);
        expect(res.status).toBe(401);
        expect((await res.json()).error).toBe('Invalid or expired token');
    });

    it('PIN di sala: si imposta nel cloud, mai banale, e il cloud non fa entrare con quello', async () => {
        const banale = await api().put('/auth/me/service-pin').set(bearer(ownerAccess)).send({ pin: '1234' });
        expect(banale.status).toBe(400);
        expect(banale.body.error).toBe('trivial_pin');
        const corto = await api().put('/auth/me/service-pin').set(bearer(ownerAccess)).send({ pin: '12' });
        expect(corto.body.error).toBe('invalid_pin');
        const ok = await api().put('/auth/me/service-pin').set(bearer(ownerAccess)).send({ pin: '4071' });
        expect(ok.status).toBe(200);
        const me = await api().get('/auth/me').set(bearer(ownerAccess));
        expect(me.body.has_service_pin).toBe(true);
        expect(JSON.stringify(me.body)).not.toContain('service_pin_hash');
        // Le rotte del PIN vivono solo sul nodo.
        expect((await api().get('/auth/pin-users')).status).toBe(404);
        expect((await api().post('/auth/pin-login').send({ user_id: ownerClaims.userId, pin: '4071' })).status).toBe(404);
    });

    it('PIN di sala sul nodo: sessione solo di servizio, che il cloud non riconosce', async () => {
        await finoA(async () => {
            const r = await nodeDb!.query('SELECT service_pin_hash FROM users WHERE id = $1', [ownerClaims.userId]);
            return Boolean(r.rows[0]?.service_pin_hash);
        }, 'PIN sceso sul nodo');
        const elenco = await (await fetch(`${nodeBase}/auth/pin-users`)).json();
        expect(elenco.users.map((u: any) => u.id)).toContain(ownerClaims.userId);
        expect(JSON.stringify(elenco)).not.toContain('pin_hash');

        const pinLogin = (pin: string) => fetch(`${nodeBase}/auth/pin-login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: ownerClaims.userId, pin }),
        });
        const sbagliato = await pinLogin('9999');
        expect(sbagliato.status).toBe(401);

        const giusto = await pinLogin('4071');
        expect(giusto.status).toBe(200);
        const sessione = await giusto.json();
        expect(sessione.refreshToken).toBeNull();
        expect(sessione.session).toBe('pin');
        // Solo permessi di servizio, anche per un titolare.
        expect(sessione.permissions).toContain('orders:take');
        expect(sessione.permissions).not.toContain('users:view');
        expect(sessione.permissions).not.toContain('settings:full');
        const pinToken = sessione.accessToken as string;
        expect(JSON.parse(Buffer.from(pinToken.split('.')[0], 'base64url').toString('utf8')).kid).toMatch(/^node-/);

        expect((await nodeGet(pinToken)).status).toBe(200);
        // Fase B4: a linea giù l'app si riapre dal nodo. Tutto quello con cui
        // carica la sala passa anche con la sessione del PIN: un solo 403
        // farebbe fallire il caricamento intero.
        const oggi = new Date().toISOString().slice(0, 10);
        const finestra = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
        for (const p of [
            '/tables', '/rooms', '/dishes', '/menus', '/banquet-menus',
            `/reservations?from=${finestra}`,
            `/table-merges?date=${oggi}&shift=DINNER`,
            `/table-hidden?date=${oggi}&shift=DINNER`,
            `/room-closed?date=${oggi}&shift=DINNER`,
        ]) {
            const r = await fetch(`${nodeBase}${p}`, { headers: { Authorization: `Bearer ${pinToken}` } });
            expect(r.status, p).toBe(200);
            expect(Array.isArray(await r.json()), p).toBe(true);
        }
        // Amministrazione chiusa: gestione utenti (gate di ruolo) e CRM.
        expect((await fetch(`${nodeBase}/auth/users`, { headers: { Authorization: `Bearer ${pinToken}` } })).status).toBe(403);
        expect((await fetch(`${nodeBase}/customers`, { headers: { Authorization: `Bearer ${pinToken}` } })).status).toBe(403);
        // Il cloud non conosce la chiave del nodo.
        expect((await api().get('/auth/me').set(bearer(pinToken))).status).toBe(401);

        // Cinque PIN sbagliati bloccano l'utente: anche quello giusto aspetta.
        for (let i = 0; i < 5; i++) await pinLogin('9998');
        const bloccato = await pinLogin('4071');
        expect(bloccato.status).toBe(429);
        expect((await bloccato.json()).error).toBe('pin_locked');
    }, 60_000);

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

        // Occhi in isola: il nodo dice da quando e cosa ha ancora da mandare.
        const scrittura = await fetch(`${nodeBase}/tables/${offlineTableId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerAccess}` },
            body: JSON.stringify({ status: 'OCCUPIED' }),
        });
        expect(scrittura.status).toBe(200);
        const isola = await (await fetch(`${nodeBase}/sala-node/local-status`, { headers: { Authorization: `Bearer ${ownerAccess}` } })).json();
        expect(isola.uplink_connected).toBe(false);
        expect(typeof isola.uplink_down_since).toBe('string');
        expect(isola.pending_up).toBeGreaterThanOrEqual(1);
        expect(isola.lag_up_s).toBeGreaterThanOrEqual(0);
    }, 60_000);
});
