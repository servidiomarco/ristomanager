import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { io as ioClient, type Socket } from 'socket.io-client';
import { api, bearer, ownerToken } from './helpers';
import { cassaFinta } from './cassaFinta';
import { getComanda, scriviComandaViva, PassepartoutError, type EsitoComandaViva, type MemoriaComandaViva } from '../../services/passepartoutService';

// Comanda viva, fase 6: gli ordini del CRM li scrive in cassa chi li ha.
// Col servizio in sala il nodo (configurazione e tavoli abbinati gli
// arrivano con la sincronizzazione), senza il cloud. L'agente del PC, come
// quello vero, è collegato a tutti e due con lo stesso token e una memoria
// sola: qui si guarda chi lo chiama.

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

const NODE_DB = 'ristotest_node_comanda_viva';
const AGENT_TOKEN = 'test-pp-agent-token';

describe('comanda viva col servizio in sala (fase 6)', () => {
    let token: string;
    let child: ChildProcess | null = null;
    let nodeDb: Client | null = null;
    let cloudDb: Client | null = null;
    let nodeBase = '';
    let nodeLog = '';
    let tableId = 0;
    let dishId = 0;
    const ordini: number[] = [];
    const cassa = cassaFinta();
    const memoria = new Map<string, MemoriaComandaViva>();
    // Chi ha chiesto ogni scrittura in cassa: 'cloud' o 'nodo', con il tag.
    const scritture: Array<{ da: 'cloud' | 'nodo'; tag: string }> = [];
    const agenti: Socket[] = [];
    let ripristina: Array<() => Promise<unknown>> = [];

    const finoA = async (cond: () => Promise<boolean>, descr: string, timeoutMs = 25_000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (await cond()) return;
            if (Date.now() > deadline) throw new Error(`Timeout: ${descr}. Log del nodo:\n${nodeLog.slice(-3000)}`);
            await sleep(300);
        }
    };
    const nodeFetch = (p: string, method: string, body?: any) => fetch(`${nodeBase}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    // L'agente del PC: due collegamenti, una memoria e una cassa.
    const collegaAgente = async (da: 'cloud' | 'nodo', base: string) => {
        const socket = ioClient(`${base}/pp-agent`, { auth: { token: AGENT_TOKEN }, transports: ['websocket'], reconnection: false });
        socket.on('pp:call', async (payload: any, ack: (r: unknown) => void) => {
            if (payload?.op === 'comandeAperte') {
                return ack({ ok: true, result: [...cassa.comande.values()].filter((c) => !c.pagata).map((c) => ({
                    idComanda: c.id, tavolo: c.tavolo, sala: c.sala, coperti: c.coperti, idPrenotazione: null, aperta: null, totale: 0,
                })) });
            }
            if (payload?.op === 'comanda') return ack({ ok: true, result: await getComanda(Number(payload.params?.idGestionale)) });
            if (payload?.op !== 'comandaViva') return ack({ ok: false, error: `op non prevista: ${payload?.op}`, kind: 'agent' });
            try {
                const p = payload.params;
                scritture.push({ da, tag: p.tag });
                const esito: EsitoComandaViva = await scriviComandaViva(p, memoria.get(p.tag) ?? { idComanda: null, righe: {} });
                const m = memoria.get(p.tag) ?? { idComanda: null, righe: {} };
                if (esito.idComanda != null) m.idComanda = esito.idComanda;
                for (const r of esito.righe) {
                    if (r.cancellata) delete m.righe[r.chiave];
                    else if (r.idRiga != null) m.righe[r.chiave] = r.idRiga;
                }
                memoria.set(p.tag, m);
                ack({ ok: true, result: esito });
            } catch (err) {
                ack({ ok: false, error: (err as Error).message, kind: err instanceof PassepartoutError ? 'gestionale' : 'agent' });
            }
        });
        await new Promise<void>((resolve, reject) => { socket.on('connect', () => resolve()); socket.on('connect_error', reject); });
        socket.emit('agent:hello', { hostname: 'pc-di-sala', capabilities: ['comanda-viva', 'comanda-viva-invio'] });
        agenti.push(socket);
    };

    beforeAll(async () => {
        token = await ownerToken();
        const cloudDbUrl = process.env.DATABASE_URL || 'postgresql://localhost/ristotest_api';
        cloudDb = new Client({ connectionString: cloudDbUrl });
        await cloudDb.connect();
        const nodeToken = (await cloudDb.query('SELECT sala_node_token FROM tenants WHERE id = 1')).rows[0].sala_node_token as string;

        // La cassa finta, che il client SOAP di questo processo raggiunge.
        await new Promise<void>((resolve) => cassa.server.listen(0, '127.0.0.1', () => resolve()));
        process.env.PASSEPARTOUT_WS_URL = `http://127.0.0.1:${(cassa.server.address() as AddressInfo).port}/AdapterWS`;
        process.env.PASSEPARTOUT_WS_USER = 'utente-prova';
        process.env.PASSEPARTOUT_WS_PASSWORD = 'segreto-prova';

        // Il ristorante: comande, Passepartout, un tavolo abbinato e un
        // piatto. Tutto nasce nel cloud.
        const features = (await api().get('/settings/features').set(bearer(token))).body;
        await api().put('/settings/entitlements').set(bearer(token)).send({ passepartout: true });
        await api().put('/settings/features').set(bearer(token)).send({ table_orders_enabled: true, sala_node_enabled: true });
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
        ripristina.push(() => api().put('/settings/features').set(bearer(token)).send({
            table_orders_enabled: features.table_orders_enabled === true, sala_node_enabled: features.sala_node_enabled === true,
        }));
        const room = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala Viva Nodo', width: 400, height: 300 });
        const table = await api().post('/tables').set(bearer(token)).send({
            name: 'NV1', shape: 'SQUARE', seats: 4, x: 40, y: 40, room_id: room.body.id, status: 'FREE',
        });
        expect(table.status).toBe(201);
        tableId = table.body.id;
        await cloudDb.query(
            `INSERT INTO passepartout_tavoli (table_id, tenant_id, pp_sala, pp_tavolo, origine, confermato)
             VALUES ($1, 1, 'TETTOIA', 'NV1', 'manuale', true)`,
            [tableId]
        );
        const dish = await api().post('/dishes').set(bearer(token)).send({
            name: 'Gnocchi Nodo', description: null, price: 12, category: 'PRIMI', allergens: null,
        });
        expect(dish.status).toBe(201);
        dishId = dish.body.id;
        await cloudDb.query(
            `INSERT INTO passepartout_config (tenant_id, articolo_generico_id) VALUES (1, 500)
             ON CONFLICT (tenant_id) DO UPDATE SET articolo_generico_id = 500`
        );
        // L'interruttore vuole l'agente collegato (e aggiornato).
        await collegaAgente('cloud', process.env.TEST_BASE_URL as string);
        await finoA(async () => ((await api().get('/passepartout/status').set(bearer(token))).body.capabilities ?? []).includes('comanda-viva'),
            'agente annunciato al cloud');
        const acceso = await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: true, stampa: 'cassa', conto: 'cassa' });
        expect(acceso.status).toBe(200);

        // Il nodo, col giro delle comande in cassa rapido.
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
                SALA_NODE_CONFIG_SYNC_MS: '1000',
                JWT_SECRET: '',
                JWT_REFRESH_SECRET: '',
                PASSEPARTOUT_AGENT_TOKEN: AGENT_TOKEN,
                PASSEPARTOUT_TIPO_PAGAMENTO: '',
                PASSEPARTOUT_TIPO_DOCUMENTO: '',
                PASSEPARTOUT_COMANDE_VIVE_SWEEP_MS: '1000',
                PASSEPARTOUT_COMANDE_VIVE_RIPIEGO_MS: '500',
                PASSEPARTOUT_COMANDE_VIVE_CHIUSE_MS: '1',
                SALA_NODE_STATE_DIR: mkdtempSync(path.join(os.tmpdir(), 'nodo-di-prova-')),
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
                return (await nodeDb!.query(`SELECT 1 FROM replication_cursor WHERE stream = 'cloud'`)).rows.length > 0;
            } catch { return false; }
        }, 'bootstrap del nodo', 90_000);

        // La configurazione della cassa scende sul nodo: tavolo abbinato e
        // interruttore, oltre al piatto col suo articolo.
        await finoA(async () => {
            const cfg = await nodeDb!.query(`SELECT comande_vive_enabled, articolo_generico_id FROM passepartout_config WHERE tenant_id = 1`);
            const tav = await nodeDb!.query(`SELECT 1 FROM passepartout_tavoli WHERE table_id = $1 AND confermato`, [tableId]);
            const piatto = await nodeDb!.query(`SELECT 1 FROM dishes WHERE id = $1`, [dishId]);
            return cfg.rows[0]?.comande_vive_enabled === true && Number(cfg.rows[0]?.articolo_generico_id) === 500
                && tav.rows.length === 1 && piatto.rows.length === 1;
        }, 'configurazione della cassa sul nodo');

        await collegaAgente('nodo', nodeBase);
    }, 180_000);

    afterAll(async () => {
        for (const a of agenti) a.close();
        await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false, force: true }).catch(() => {});
        for (const id of ordini) {
            await api().delete(`/orders/${id}?forza=1`).set(bearer(token)).send({ motivo: 'fine prova' }).catch(() => {});
        }
        await api().put('/passepartout/comande-vive/config').set(bearer(token)).send({ enabled: false, stampa: 'cassa', conto: 'cassa' }).catch(() => {});
        for (const r of ripristina) await r().catch(() => {});
        await cloudDb?.query(`DELETE FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = ANY($1::int[])`, [ordini]).catch(() => {});
        await cloudDb?.query(`DELETE FROM passepartout_tavoli WHERE tenant_id = 1 AND table_id = $1`, [tableId]).catch(() => {});
        await cloudDb?.query(`UPDATE passepartout_config SET articolo_generico_id = NULL WHERE tenant_id = 1`).catch(() => {});
        child?.kill('SIGKILL');
        // Questo nodo ha scritto: il cloud ha letto i suoi eventi fino a un
        // punto. Il nodo dei file dopo riparte da 1 su un database nuovo, e
        // con il cursore lasciato qui i suoi primi eventi non salirebbero.
        await cloudDb?.query(`DELETE FROM replication_cursor WHERE tenant_id = 1 AND stream = 'node'`).catch(() => {});
        delete process.env.PASSEPARTOUT_WS_URL;
        delete process.env.PASSEPARTOUT_WS_USER;
        delete process.env.PASSEPARTOUT_WS_PASSWORD;
        await new Promise<void>((resolve) => cassa.server.close(() => resolve()));
        await nodeDb?.end().catch(() => {});
        await cloudDb?.end().catch(() => {});
    });

    it('col servizio in sala l\'ordine nato sul nodo lo scrive in cassa il nodo, e il cloud non lo tocca', async () => {
        await finoA(async () => {
            const o = await api().get('/sala-node/authority').set(bearer(token));
            return o.body.node_online === true && o.body.aligned === true;
        }, 'repliche allineate');
        await cloudDb!.query(`UPDATE table_bill_splits SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP WHERE status = 'CLAIMED'`);
        const on = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
        expect(on.status).toBe(200);
        await finoA(async () => (await nodeDb!.query(
            `SELECT value FROM app_settings WHERE tenant_id = 1 AND key = 'sala_node_authority_enabled'`
        )).rows[0]?.value === true, 'servizio in sala anche per il nodo');

        const aperto = await nodeFetch('/orders', 'POST', { table_id: tableId, covers: 2 });
        expect(aperto.status).toBe(201);
        const ordine = (await aperto.json()).order.id as number;
        ordini.push(ordine);
        expect((await nodeFetch(`/orders/${ordine}/items`, 'POST', { items: [{ dish_id: dishId, qty: 1, course_no: 1 }] })).status).toBe(201);
        expect((await nodeFetch(`/orders/${ordine}/send`, 'POST', {})).status).toBe(200);

        await finoA(async () => (await nodeDb!.query(
            `SELECT stato FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [ordine]
        )).rows[0]?.stato === 'SCRITTA', 'ordine scritto in cassa dal nodo');
        const c = cassa.sulTavolo('NV1')!;
        // Un piatto nato nel CRM: in cassa sull'articolo generico, col suo nome.
        expect(c.righe.find((r) => r.articolo === 'VARIE' && r.descrizione === 'Gnocchi Nodo')).toBeTruthy();
        const tag = `sympotia-ordine:${ordine}`;
        expect(scritture.filter((s) => s.tag === tag).map((s) => s.da).every((da) => da === 'nodo')).toBe(true);

        // L'ordine risale al cloud, che non lo riscrive: niente stato suo.
        await finoA(async () => (await cloudDb!.query(`SELECT 1 FROM orders WHERE id = $1`, [ordine])).rows.length === 1, 'ordine risalito');
        await sleep(1500);
        expect((await cloudDb!.query(`SELECT 1 FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [ordine])).rows).toEqual([]);
        expect(scritture.filter((s) => s.tag === tag && s.da === 'cloud')).toEqual([]);

        // Il «Riprova» passa dal nodo: nel cloud c'è il recinto.
        const riprova = await api().post(`/passepartout/comande-vive/ordini/${ordine}/riprova`).set(bearer(token)).send({});
        expect(riprova.status).toBe(409);
        expect(riprova.body.error).toBe('authority_on_node');

        const off = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
        expect(off.status).toBe(200);
    }, 120_000);

    it('senza servizio in sala l\'ordine lo scrive il cloud, e il nodo non lo tocca', async () => {
        await finoA(async () => (await nodeDb!.query(
            `SELECT value FROM app_settings WHERE tenant_id = 1 AND key = 'sala_node_authority_enabled'`
        )).rows[0]?.value !== true, 'servizio tornato al cloud anche per il nodo');
        // Il tavolo di nuovo libero, nel CRM e in cassa.
        expect((await api().delete(`/orders/${ordini[0]}?forza=1`).set(bearer(token)).send({ motivo: 'fine prova' })).status).toBe(200);
        const prima = cassa.sulTavolo('NV1');
        if (prima) prima.pagata = true;

        const aperto = await api().post('/orders').set(bearer(token)).send({ table_id: tableId, covers: 2 });
        expect(aperto.status).toBe(201);
        const ordine = aperto.body.order.id as number;
        ordini.push(ordine);
        expect((await api().post(`/orders/${ordine}/items`).set(bearer(token)).send({ items: [{ dish_id: dishId, qty: 1, course_no: 1 }] })).status).toBe(201);
        expect((await api().post(`/orders/${ordine}/send`).set(bearer(token)).send({})).status).toBe(200);

        await finoA(async () => (await cloudDb!.query(
            `SELECT stato FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [ordine]
        )).rows[0]?.stato === 'SCRITTA', 'ordine scritto in cassa dal cloud');
        const tag = `sympotia-ordine:${ordine}`;
        // Il giro del nodo gira ogni secondo: due giri senza toccarlo.
        await sleep(2500);
        expect(scritture.filter((s) => s.tag === tag).map((s) => s.da).every((da) => da === 'cloud')).toBe(true);
        expect((await nodeDb!.query(`SELECT 1 FROM passepartout_comande_vive WHERE tenant_id = 1 AND order_id = $1`, [ordine])).rows).toEqual([]);
    }, 90_000);
});
