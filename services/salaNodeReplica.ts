// Il lato NODO della replica (tappa 4 ibrido, fasi 3 e 4a), profilo
// service-node. Due mestieri sullo stesso uplink socket:
//
// 1. CONSUMARE lo stream del cloud (fase 3): pull con cursore su
//    GET /sala-node/events, righe correnti da POST /sala-node/rows,
//    applicazione con l'inbox transazionale condiviso (replicaApply).
//    Il socket sveglia, il polling è il fallback.
//
// 2. SERVIRE lo stream inverso (fase 4a): il cloud tira gli eventi LOCALI
//    del nodo con le RPC `node:pull` (pull con cursore, ack) e `node:rows`
//    (righe correnti, ack) sullo stesso canale — sul router del ristorante
//    non si apre niente, è sempre il nodo a uscire.
//
// L'import degli eventi cloud nell'outbox locale (origin='replica', dentro
// replicaApply) fa girare i handler del dispatcher anche qui: quando la
// fase 4c attaccherà i palmari al socket del nodo, i broadcast partiranno
// dallo stesso meccanismo del cloud, già esercitato.

import { io, type Socket } from 'socket.io-client';
import pool, { runAsPlatform } from '../db.js';
import { isServiceNode } from './topology.js';
import { applyReplicaBatch, CONVERGED_TYPES, type ReplicaEvent, type WantedRows, type FetchedRows } from './replicaApply.js';

const PULL_LIMIT = 500;
const POLL_MS = Math.max(1_000, Number(process.env.SALA_NODE_PULL_INTERVAL_MS) || 15_000);
const WAKE_DEBOUNCE_MS = 150;

const cloudUrl = (): string => (process.env.SALA_NODE_CLOUD_URL || '').replace(/\/+$/, '');
const nodeToken = (): string => process.env.SALA_NODE_TOKEN || '';

const cloudGet = async (path: string): Promise<any> => {
    const res = await fetch(`${cloudUrl()}${path}`, {
        headers: { 'X-Sala-Node-Token': nodeToken(), accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
};

const cloudPost = async (path: string, body: any): Promise<any> => {
    const res = await fetch(`${cloudUrl()}${path}`, {
        method: 'POST',
        headers: { 'X-Sala-Node-Token': nodeToken(), 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
};

const fetchRowsFromCloud = async (wanted: WantedRows): Promise<FetchedRows> =>
    cloudPost('/sala-node/rows', wanted);

/** Un giro di pull dal cloud: torna true se c'era roba (e conviene
 *  rigirare subito — a valle di un outage si drena a batch pieni). */
const pullOnce = async (): Promise<boolean> => runAsPlatform(async () => {
    const cur = await pool.query(`SELECT tenant_id, applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
    if (cur.rows.length === 0) return false; // bootstrap non ancora fatto
    const tenantId = Number(cur.rows[0].tenant_id);
    const after = Number(cur.rows[0].applied_seq);
    const body = await cloudGet(`/sala-node/events?after=${after}&limit=${PULL_LIMIT}`);
    const events: ReplicaEvent[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return false;
    await applyReplicaBatch({ tenantId, events, cursorStream: 'cloud', fetchRows: fetchRowsFromCloud });
    console.log(`[replica] applicati ${events.length} eventi, cursore a ${events[events.length - 1].seq}`);
    return true;
});

// --- Le RPC dello stream inverso (il nodo È l'autorità, il cloud tira) ----

const serveNodePull = async (req: any, ack: (res: any) => void): Promise<void> => {
    try {
        await runAsPlatform(async () => {
            const after = Number(req?.after);
            const limit = Math.min(PULL_LIMIT, Math.max(1, Number(req?.limit) || PULL_LIMIT));
            if (!Number.isFinite(after) || after < 0) return ack({ error: 'after non valido' });
            const rs = await pool.query(
                `SELECT id, event_id, event, aggregate, payload, command_id, causation_id, actor, schema_ver, created_at
                 FROM outbox_events
                 WHERE id > $1 AND origin = 'local'
                 ORDER BY id
                 LIMIT $2`,
                [after, limit]
            );
            ack({
                events: rs.rows.map((r: any) => ({
                    seq: Number(r.id),
                    event_id: r.event_id,
                    type: r.event,
                    aggregate: r.aggregate,
                    payload: r.payload,
                    command_id: r.command_id,
                    causation_id: r.causation_id,
                    actor: r.actor,
                    schema_ver: r.schema_ver,
                    occurred_at: r.created_at,
                })),
            });
        });
    } catch (err: any) {
        ack({ error: err?.message || String(err) });
    }
};

/** Lo stato di replica del nodo, per i cancelli dell'interruttore (4b):
 *  fin dove ho applicato lo stream del cloud, e fin dove arriva il mio
 *  log locale (che il cloud deve aver drenato prima di riprendersi
 *  l'autorità). */
const serveNodeStatus = async (_req: any, ack: (res: any) => void): Promise<void> => {
    try {
        await runAsPlatform(async () => {
            const cur = await pool.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
            const head = await pool.query(`SELECT COALESCE(MAX(id), 0)::bigint AS h FROM outbox_events WHERE origin = 'local'`);
            ack({
                applied_cloud_seq: Number(cur.rows[0]?.applied_seq ?? 0),
                local_head: Number(head.rows[0].h),
            });
        });
    } catch (err: any) {
        ack({ error: err?.message || String(err) });
    }
};

const serveNodeRows = async (req: any, ack: (res: any) => void): Promise<void> => {
    try {
        await runAsPlatform(async () => {
            const ids = (key: string): number[] => {
                const raw = Array.isArray(req?.[key]) ? req[key] : [];
                const parsed = raw.map((n: any) => Number(n)).filter((n: number) => Number.isInteger(n) && n > 0);
                return [...new Set(parsed)].slice(0, 500) as number[];
            };
            const tableIds = ids('tables');
            const reservationIds = ids('reservations');
            const orderIds = ids('orders');
            const takeawayIds = ids('takeaways');
            const q = (sql: string, params: any[]) => pool.query(sql, params).then(r => r.rows);
            const none: any[] = [];
            const [tables, reservations, orders, order_items, order_revisions, takeaway_orders, takeaway_order_items] = await Promise.all([
                tableIds.length ? q(`SELECT * FROM tables WHERE id = ANY($1::int[])`, [tableIds]) : none,
                reservationIds.length ? q(`SELECT * FROM reservations WHERE id = ANY($1::int[])`, [reservationIds]) : none,
                orderIds.length ? q(`SELECT * FROM orders WHERE id = ANY($1::int[])`, [orderIds]) : none,
                orderIds.length ? q(`SELECT * FROM order_items WHERE order_id = ANY($1::int[])`, [orderIds]) : none,
                orderIds.length ? q(`SELECT * FROM order_revisions WHERE order_id = ANY($1::int[])`, [orderIds]) : none,
                takeawayIds.length ? q(`SELECT * FROM takeaway_orders WHERE id = ANY($1::int[])`, [takeawayIds]) : none,
                takeawayIds.length ? q(`SELECT * FROM takeaway_order_items WHERE takeaway_order_id = ANY($1::int[])`, [takeawayIds]) : none,
            ]);
            ack({ tables, reservations, orders, order_items, order_revisions, takeaway_orders, takeaway_order_items });
        });
    } catch (err: any) {
        ack({ error: err?.message || String(err) });
    }
};

export interface SalaNodeReplicaOpts {
    getClients?: () => number;
    /** Rigioca un envelope relay:event ai client LAN del nodo (room per
     *  room, come faceva il relay tappa-3). Iniettato da server.ts. */
    relayToLocal?: (rooms: string[], event: string, data: any) => void;
}

export const startSalaNodeReplica = (opts?: SalaNodeReplicaOpts): void => {
    if (!isServiceNode) return;
    let running = false;
    let lastErrorLogged = 0;
    const drain = async () => {
        if (running) return;
        running = true;
        try {
            while (await pullOnce()) { /* si drena fino a coda vuota */ }
        } catch (err: any) {
            // A cloud giù il giro fallisce e riproverà (sveglia o polling):
            // si logga il primo errore per serie, non la pioggia.
            if (Date.now() - lastErrorLogged > 60_000) {
                lastErrorLogged = Date.now();
                console.warn('[replica] giro fallito (si riprova):', err?.message || err);
            }
        } finally {
            running = false;
        }
    };

    const timer = setInterval(() => void drain(), POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();

    // La sveglia: lo stesso canale /sala-node del mirror tappa 3. Ogni
    // relay:event = «c'è roba nuova», con un debounce per le raffiche.
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    const wake = () => {
        if (wakeTimer) return;
        wakeTimer = setTimeout(() => { wakeTimer = null; void drain(); }, WAKE_DEBOUNCE_MS);
    };
    const socket: Socket = io(`${cloudUrl()}/sala-node`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1_000,
        reconnectionDelayMax: 10_000,
        timeout: 20_000,
        auth: { token: nodeToken() },
    });
    socket.on('connect', () => {
        console.log('[replica] uplink connesso al cloud');
        void drain();
    });
    // Il battito: il bridge marca il nodo online solo se node:stats arriva
    // entro 30s — il relay tappa-3 lo mandava, il full-server pure (trovato
    // al collaudo del 23/09: «nodo offline da 218s» in card con l'uplink
    // vivo e i palmari collegati — e l'interruttore autorità congelato).
    const statsTimer = setInterval(() => {
        if (!socket.connected) return;
        socket.emit('node:stats', {
            clients: opts?.getClients?.() ?? 0,
            cache_entries: 0,
            oldest_cache_age_s: null,
            version: 'service-node-4',
        });
    }, 15_000);
    if (typeof statsTimer.unref === 'function') statsTimer.unref();
    socket.on('relay:event', (envelope: any) => {
        // Doppio mestiere dell'envelope: sveglia il pull, e per i tipi che
        // NON passano dal giro import→dispatcher (features:updated, kds:*,
        // bill:*, menu…) è l'unica strada verso i client LAN — il 23/09 il
        // flip dell'interruttore non arrivava mai ai palmari attaccati al
        // nodo, serviva il reload a mano. I tipi convergiuti si saltano:
        // il loro broadcast lo fa il dispatcher all'import (catch-up
        // post-outage compreso), e raddoppiarli = doppi toast.
        wake();
        try {
            if (envelope && Array.isArray(envelope.rooms) && typeof envelope.event === 'string'
                && !CONVERGED_TYPES.has(envelope.event)) {
                opts?.relayToLocal?.(envelope.rooms, envelope.event, envelope.data);
            }
        } catch { /* il replay non deve mai rompere la sveglia */ }
    });
    // Lo stream inverso: il cloud tira da qui, sempre pull con cursore.
    socket.on('node:pull', (req, ack) => { if (typeof ack === 'function') void serveNodePull(req, ack); });
    socket.on('node:rows', (req, ack) => { if (typeof ack === 'function') void serveNodeRows(req, ack); });
    socket.on('node:status', (req, ack) => { if (typeof ack === 'function') void serveNodeStatus(req, ack); });
    let connErrLogged = 0;
    socket.on('connect_error', (err) => {
        if (Date.now() - connErrLogged > 60_000) {
            connErrLogged = Date.now();
            console.warn('[replica] uplink connect_error:', err?.message || err);
        }
    });

    void drain();
};
