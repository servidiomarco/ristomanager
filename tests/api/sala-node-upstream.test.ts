import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { Client } from 'pg';
import { createHmac } from 'node:crypto';
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
                SALA_NODE_CONFIG_SYNC_MS: '1000',
                // Nessun segreto JWT sul nodo (fase A1): i token del cloud li
                // verifica con le chiavi pubbliche ricevute dalle credenziali.
                // Stringa vuota e non assente, così nemmeno la shell lo passa.
                JWT_SECRET: '',
                JWT_REFRESH_SECRET: '',
                // Log e cache (chiavi, certificato) fuori dal checkout.
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

        // Spazi di id separati (fase B1): la riga nata sul nodo ha un id da
        // un miliardo in su, e il cloud che la applica NON porta la propria
        // sequenza lassù — la prossima unione del cloud resta nel suo spazio.
        expect(Number(mergeBody.id)).toBeGreaterThanOrEqual(1_000_000_000);
        const cloudSeq = await cloudDb!.query(`SELECT last_value FROM table_merges_id_seq`);
        expect(Number(cloudSeq.rows[0].last_value)).toBeLessThan(1_000_000_000);
        const nodeSeq = await nodeDb!.query(`SELECT last_value FROM orders_id_seq`);
        expect(Number(nodeSeq.rows[0].last_value)).toBeGreaterThanOrEqual(999_999_999);
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

            // Il cancello dei pagamenti col QR in corso (fase B3): le quote
            // lasciate prenotate dai test dei conti si liberano.
            await cloudDb!.query(`UPDATE table_bill_splits SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP WHERE status = 'CLAIMED'`);
            const on = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
            expect(on.status).toBe(200);
            expect(on.body.enabled).toBe(true);

            // Il recinto (fase B1): a nodo vivo il cloud rifiuta le battiture
            // di servizio, il nodo le accetta. Le scritture fuori dal
            // servizio (qui la pianta) restano al cloud.
            const sulCloud = await api().put(`/tables/${tableId}`).set(bearer(token)).send({ status: 'FREE' });
            expect(sulCloud.status).toBe(409);
            expect(sulCloud.body.error).toBe('authority_on_node');
            const sulNodo = await fetch(`${nodeBase}/tables/${tableId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ status: 'FREE' }),
            });
            expect(sulNodo.status).toBe(200);
            const pianta = await api().post('/rooms').set(bearer(token)).send({ name: 'Sala del recinto', width: 300, height: 200 });
            expect(pianta.status).toBe(201);

            // Lo spegnimento drena (qui è già tutto importato) e restituisce.
            const off = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
            expect(off.status).toBe(200);
            expect(off.body.enabled).toBe(false);
        } finally {
            await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: hybridPrima });
        }
    });

    it('col servizio in sala il conto nasce sul nodo: incassi, chiusura e scontrino risalgono al cloud (fase B3)', async () => {
        const nodeFetch = (path: string, method: string, body?: any, extra: Record<string, string> = {}) => fetch(`${nodeBase}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const flags = await api().get('/settings/features').set(bearer(token));
        const hybridPrima = flags.body.sala_node_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: true });
        // Lo scontrino deve poter partire dalla LAN: il mock vale come registratore.
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'mock', vat_number: '11122211133' });
        try {
            await finoA(async () => {
                const o = await api().get('/sala-node/authority').set(bearer(token));
                return o.body.node_online === true && o.body.aligned === true;
            }, 'repliche allineate');
            // Il nodo deve avere il provider fiscale (config allineata).
            await finoA(async () => {
                const r = await nodeDb!.query(`SELECT text_value FROM app_settings WHERE key = 'fiscal_provider'`);
                return r.rows[0]?.text_value === 'mock';
            }, 'provider fiscale sul nodo');
            // Il cancello dei pagamenti col QR in corso (fase B3): le quote
            // lasciate prenotate dai test dei conti si liberano.
            await cloudDb!.query(`UPDATE table_bill_splits SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP WHERE status = 'CLAIMED'`);
            const on = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
            expect(on.status).toBe(200);
            await finoA(async () => {
                const r = await nodeDb!.query(`SELECT value FROM app_settings WHERE key = 'sala_node_authority_enabled'`);
                return r.rows[0]?.value === true;
            }, 'interruttore sul nodo');

            // Conto, incasso e chiusura SUL NODO.
            const opened = await nodeFetch(`/tables/${tableId}/bill`, 'POST', { total_cents: 2000, covers: 2 });
            expect(opened.status).toBe(201);
            const bill = (await opened.json()).bill;
            expect(Number(bill.id)).toBeGreaterThanOrEqual(1_000_000_000);
            const pay = await nodeFetch(`/bills/${bill.id}/payments`, 'POST', { method: 'CONTANTI', amount_cents: 500 }, { 'Idempotency-Key': `nodo-${bill.id}` });
            expect(pay.status).toBe(201);
            const close = await nodeFetch(`/bills/${bill.id}/close`, 'POST', { payments: [{ method: 'POS_FISICO', amount_cents: 1500 }] });
            expect(close.status).toBe(200);
            expect((await close.json()).status).toBe('CLOSED');

            // Tutto risale al cloud, con gli id del nodo.
            await finoA(async () => {
                const r = await cloudDb!.query(
                    `SELECT b.status,
                            (SELECT COUNT(*)::int FROM table_bill_payments p WHERE p.table_bill_id = b.id) AS payments,
                            (SELECT COUNT(*)::int FROM fiscal_documents f WHERE f.table_bill_id = b.id AND f.status = 'CONFIRMED') AS docs
                       FROM table_bills b WHERE b.id = $1`,
                    [bill.id]
                );
                return r.rows[0]?.status === 'CLOSED' && r.rows[0]?.payments === 2 && r.rows[0]?.docs === 1;
            }, 'conto chiuso, due incassi e scontrino sul cloud', 30_000);

            // Il recinto: sul cloud niente incassi né conti nuovi.
            const second = await nodeFetch(`/tables/${tableId}/bill`, 'POST', { total_cents: 1000, covers: 1 });
            expect(second.status).toBe(201);
            const secondBill = (await second.json()).bill;
            await finoA(async () => {
                const r = await cloudDb!.query('SELECT share_token FROM table_bills WHERE id = $1', [secondBill.id]);
                return Boolean(r.rows[0]?.share_token);
            }, 'secondo conto sul cloud');
            const cloudPay = await api().post(`/bills/${secondBill.id}/payments`).set(bearer(token)).send({ method: 'CONTANTI', amount_cents: 100 });
            expect(cloudPay.status).toBe(409);
            expect(cloudPay.body.error).toBe('authority_on_node');
            const voided = await nodeFetch(`/bills/${secondBill.id}/void`, 'POST', {});
            expect(voided.status).toBe(200);

            const off = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
            expect(off.status).toBe(200);
        } finally {
            await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false, force: true });
            await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
            await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: hybridPrima });
        }
    }, 90_000);

    it('col servizio in sala il QR passa dal nodo: quota, pagamento, chiusura e scontrino (fase B3b)', async () => {
        const WEBHOOK_SECRET = 'segreto-webhook-qr-nodo';
        const nodeFetch = (path: string, method: string, body?: any) => fetch(`${nodeBase}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const flags = await api().get('/settings/features').set(bearer(token));
        const hybridPrima = flags.body.sala_node_enabled === true;
        await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: true });
        await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'mock', vat_number: '11122211133' });
        await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: WEBHOOK_SECRET });
        try {
            await finoA(async () => {
                const o = await api().get('/sala-node/authority').set(bearer(token));
                return o.body.node_online === true && o.body.aligned === true;
            }, 'repliche allineate');
            await finoA(async () => {
                const r = await nodeDb!.query(`SELECT text_value FROM app_settings WHERE key = 'fiscal_provider'`);
                return r.rows[0]?.text_value === 'mock';
            }, 'provider fiscale sul nodo');
            await cloudDb!.query(`UPDATE table_bill_splits SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP WHERE status = 'CLAIMED'`);
            const on = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: true });
            expect(on.status).toBe(200);
            await finoA(async () => {
                const r = await nodeDb!.query(`SELECT value FROM app_settings WHERE key = 'sala_node_authority_enabled'`);
                return r.rows[0]?.value === true;
            }, 'interruttore sul nodo');

            const opened = await nodeFetch(`/tables/${tableId}/bill`, 'POST', { total_cents: 3000, covers: 2 });
            expect(opened.status).toBe(201);
            const bill = (await opened.json()).bill;
            await finoA(async () => {
                const r = await cloudDb!.query('SELECT share_token FROM table_bills WHERE id = $1', [bill.id]);
                return Boolean(r.rows[0]?.share_token);
            }, 'conto sul cloud');

            // La quota: l'ospite parla col cloud, la quota nasce sul nodo.
            const claim = await api().post(`/pay/${bill.share_token}/claim`).send({ kind: 'full_bill', claimant_label: 'Ospite' });
            expect(claim.status).toBe(201);
            const splitId = Number(claim.body.split_id);
            expect(splitId).toBeGreaterThanOrEqual(1_000_000_000);
            const sulNodo = await nodeDb!.query('SELECT status FROM table_bill_splits WHERE id = $1', [splitId]);
            expect(sulNodo.rows[0]?.status).toBe('CLAIMED');

            // Il gateway (qui assente) avrebbe creato l'ordine: la richiesta
            // di pagamento del cloud punta alla quota del nodo.
            const orderId = `ordine-qr-nodo-${bill.id}`;
            await cloudDb!.query(
                `INSERT INTO payment_requests (tenant_id, amount_cents, currency, description, status, provider, provider_order_id, table_bill_split_id)
                 VALUES (1, 3000, 'EUR', 'Quota dal nodo', 'PENDING', 'revolut', $1, $2)`,
                [orderId, splitId]
            );
            const body = JSON.stringify({ event: 'ORDER_COMPLETED', order_id: orderId });
            const ts = String(Date.now());
            const signature = createHmac('sha256', WEBHOOK_SECRET).update(`v1.${ts}.${body}`).digest('hex');
            const hook = await api().post('/webhook/revolut')
                .set('Content-Type', 'application/json')
                .set('Revolut-Request-Timestamp', ts)
                .set('Revolut-Signature', `v1=${signature}`)
                .send(body);
            expect(hook.status).toBe(200);

            // Il nodo applica: quota pagata, conto chiuso, scontrino; e risale.
            await finoA(async () => {
                const r = await nodeDb!.query(
                    `SELECT b.status, s.status AS split_status,
                            (SELECT COUNT(*)::int FROM fiscal_documents f WHERE f.table_bill_id = b.id AND f.status = 'CONFIRMED') AS docs
                       FROM table_bills b JOIN table_bill_splits s ON s.table_bill_id = b.id
                      WHERE b.id = $1 AND s.id = $2`,
                    [bill.id, splitId]
                );
                return r.rows[0]?.status === 'CLOSED' && r.rows[0]?.split_status === 'PAID' && r.rows[0]?.docs === 1;
            }, 'quota pagata, conto chiuso e scontrino sul nodo', 30_000);
            await finoA(async () => {
                const r = await cloudDb!.query(
                    `SELECT b.status, (SELECT COUNT(*)::int FROM fiscal_documents f WHERE f.table_bill_id = b.id AND f.status = 'CONFIRMED') AS docs
                       FROM table_bills b WHERE b.id = $1`,
                    [bill.id]
                );
                return r.rows[0]?.status === 'CLOSED' && r.rows[0]?.docs === 1;
            }, 'conto chiuso e scontrino sul cloud', 30_000);

            // Il rilascio passa dal nodo anche lui.
            const second = await nodeFetch(`/tables/${tableId}/bill`, 'POST', { total_cents: 1200, covers: 1 });
            const secondBill = (await second.json()).bill;
            await finoA(async () => {
                const r = await cloudDb!.query('SELECT share_token FROM table_bills WHERE id = $1', [secondBill.id]);
                return Boolean(r.rows[0]?.share_token);
            }, 'secondo conto sul cloud');
            const claim2 = await api().post(`/pay/${secondBill.share_token}/claim`).send({ kind: 'full_bill' });
            expect(claim2.status).toBe(201);
            const release = await api().post(`/pay/${secondBill.share_token}/release`).send({ split_id: claim2.body.split_id });
            expect(release.status).toBe(200);
            const rel = await nodeDb!.query('SELECT status FROM table_bill_splits WHERE id = $1', [claim2.body.split_id]);
            expect(rel.rows[0]?.status).toBe('RELEASED');
            await nodeFetch(`/bills/${secondBill.id}/void`, 'POST', {});

            const off = await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false });
            expect(off.status).toBe(200);
        } finally {
            await api().post('/sala-node/authority').set(bearer(token)).send({ enabled: false, force: true });
            await api().put('/settings/fiscal').set(bearer(token)).send({ provider: 'none' });
            await api().put('/settings/integrations/revolut').set(bearer(token)).send({ webhook_secret: '' });
            await api().put('/settings/features').set(bearer(token)).send({ sala_node_enabled: hybridPrima });
        }
    }, 120_000);

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

    it('un evento già applicato non si riapplica: il cursore letto è quello scritto', async () => {
        // In produzione (RLS rigida, 24/09) il cursore si scriveva ma non si
        // rileggeva: il cloud ripartiva da zero a ogni giro e riscriveva le
        // righe dalla copia del nodo, di continuo. Una modifica fatta sul
        // cloud dopo la convergenza deve restare lì oltre qualche giro di
        // poll. Il bug si vede con TEST_STRICT_RLS=1.
        const cur = await cloudDb!.query(`SELECT applied_seq FROM replication_cursor WHERE tenant_id = 1 AND stream = 'node'`);
        expect(Number(cur.rows[0]?.applied_seq ?? 0)).toBeGreaterThan(0);
        await cloudDb!.query(`UPDATE tables SET status = 'AVAILABLE' WHERE id = $1`, [tableId]);
        await sleep(7_000);
        const r = await cloudDb!.query('SELECT status FROM tables WHERE id = $1', [tableId]);
        expect(r.rows[0].status).toBe('AVAILABLE');
    }, 20_000);
});
