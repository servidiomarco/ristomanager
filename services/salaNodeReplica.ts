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
import { BUILD_VERSION } from './buildInfo.js';

const PULL_LIMIT = 500;
// Dopo quanto silenzio l'uplink si considera giù: un socket che si
// riconnette in pochi secondi (riavvio di Railway, Wi-Fi che balla) non
// deve far scattare la proroga degli accessi (salaNodeAccess).
const UPLINK_DOWN_AFTER_MS = Math.max(1_000, Number(process.env.SALA_NODE_UPLINK_DOWN_AFTER_MS) || 30_000);
// Il battito verso il cloud (node:stats): la card lo legge per dire online,
// versione e ritardi. Configurabile solo per i test.
const STATS_INTERVAL_MS = Math.max(1_000, Number(process.env.SALA_NODE_STATS_INTERVAL_MS) || 15_000);
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

// Fase B3: dopo ogni lotto applicato, gli effetti che spettano al nodo
// (es. la caparra pagata online da accreditare sul conto in sala). Fuori
// dalla transazione della replica: sono scritture locali vere, con i loro
// eventi verso il cloud. Iniettato da server.ts.
let onAppliedHook: ((tenantId: number, events: ReplicaEvent[]) => Promise<void>) | null = null;

/** Un giro di pull dal cloud: torna true se c'era roba (e conviene
 *  rigirare subito — a valle di un outage si drena a batch pieni). */
// rls-bypass: solo nodo, un tenant: giro di replica senza sessione, il tenant lo dà il cursore locale
const pullOnce = async (): Promise<boolean> => runAsPlatform(async () => {
    // rls-bypass: solo nodo (Postgres locale superuser, un tenant): il pool nudo legge il cursore 'cloud'
    const cur = await pool.query(`SELECT tenant_id, applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
    if (cur.rows.length === 0) return false; // bootstrap non ancora fatto
    const tenantId = Number(cur.rows[0].tenant_id);
    const after = Number(cur.rows[0].applied_seq);
    const body = await cloudGet(`/sala-node/events?after=${after}&limit=${PULL_LIMIT}`);
    const events: ReplicaEvent[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) {
        lastCloudPullOkAt = Date.now();
        return false;
    }
    await applyReplicaBatch({ tenantId, events, cursorStream: 'cloud', fetchRows: fetchRowsFromCloud });
    lastCloudPullOkAt = Date.now();
    if (onAppliedHook) {
        try { await onAppliedHook(tenantId, events); }
        catch (err: any) { console.warn('[replica] effetti dopo il lotto non riusciti:', err?.message || err); }
    }
    console.log(`[replica] applicati ${events.length} eventi, cursore a ${events[events.length - 1].seq}`);
    return true;
});

// --- Le RPC dello stream inverso (il nodo È l'autorità, il cloud tira) ----

const serveNodePull = async (req: any, ack: (res: any) => void): Promise<void> => {
    try {
        // rls-bypass: solo nodo, un tenant: RPC node:pull del cloud senza sessione, legge il suo outbox locale
        await runAsPlatform(async () => {
            const after = Number(req?.after);
            const limit = Math.min(PULL_LIMIT, Math.max(1, Number(req?.limit) || PULL_LIMIT));
            if (!Number.isFinite(after) || after < 0) return ack({ error: 'after non valido' });
            // Il cloud chiede «dopo after»: fin lì ha già applicato tutto.
            void rememberCloudAck(after);
            // rls-bypass: solo nodo (superuser locale, un tenant): outbox 'local' senza filtro tenant, è tutto suo
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
        // rls-bypass: solo nodo, un tenant: RPC node:status del cloud senza sessione, cursore e testa del log
        await runAsPlatform(async () => {
            // rls-bypass: solo nodo (superuser locale, un tenant): il cursore 'cloud' è unico, niente filtro tenant
            const cur = await pool.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
            // rls-bypass: solo nodo (superuser locale, un tenant): testa dell'outbox locale, niente filtro tenant
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
        // rls-bypass: solo nodo, un tenant: RPC node:rows del cloud senza sessione, righe per id dal DB locale
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
            const billIds = ids('bills');
            const cashIds = ids('cashSessions');
            const fiscalIds = ids('fiscalDocs');
            // rls-bypass: solo nodo (superuser locale, un tenant): righe per id, il DB del nodo ha un tenant solo
            const q = (sql: string, params: any[]) => pool.query(sql, params).then(r => r.rows);
            const none: any[] = [];
            // Fase B2: l'aggregato conto, le sessioni di cassa, i documenti fiscali.
            const [table_bills, table_bill_payments, table_bill_splits, cash_sessions, fiscal_documents] = await Promise.all([
                billIds.length ? q(`SELECT * FROM table_bills WHERE id = ANY($1::bigint[])`, [billIds]) : none,
                billIds.length ? q(`SELECT * FROM table_bill_payments WHERE table_bill_id = ANY($1::bigint[])`, [billIds]) : none,
                billIds.length ? q(`SELECT * FROM table_bill_splits WHERE table_bill_id = ANY($1::bigint[])`, [billIds]) : none,
                cashIds.length ? q(`SELECT * FROM cash_sessions WHERE id = ANY($1::bigint[])`, [cashIds]) : none,
                fiscalIds.length ? q(`SELECT * FROM fiscal_documents WHERE id = ANY($1::bigint[])`, [fiscalIds]) : none,
            ]);
            const [tables, reservations, orders, order_items, order_revisions, takeaway_orders, takeaway_order_items] = await Promise.all([
                tableIds.length ? q(`SELECT * FROM tables WHERE id = ANY($1::int[])`, [tableIds]) : none,
                reservationIds.length ? q(`SELECT * FROM reservations WHERE id = ANY($1::int[])`, [reservationIds]) : none,
                orderIds.length ? q(`SELECT * FROM orders WHERE id = ANY($1::int[])`, [orderIds]) : none,
                orderIds.length ? q(`SELECT * FROM order_items WHERE order_id = ANY($1::int[])`, [orderIds]) : none,
                orderIds.length ? q(`SELECT * FROM order_revisions WHERE order_id = ANY($1::int[])`, [orderIds]) : none,
                takeawayIds.length ? q(`SELECT * FROM takeaway_orders WHERE id = ANY($1::int[])`, [takeawayIds]) : none,
                takeawayIds.length ? q(`SELECT * FROM takeaway_order_items WHERE takeaway_order_id = ANY($1::int[])`, [takeawayIds]) : none,
            ]);
            ack({
                tables, reservations, orders, order_items, order_revisions, takeaway_orders, takeaway_order_items,
                table_bills, table_bill_payments, table_bill_splits, cash_sessions, fiscal_documents,
            });
        });
    } catch (err: any) {
        ack({ error: err?.message || String(err) });
    }
};

// Lo stato dell'uplink verso il cloud. Parte «giù» dall'avvio: un nodo
// acceso a linea caduta non si collegherà mai, e deve saperlo.
let uplinkConnected = false;
let uplinkDownSince = Date.now();

/** Il cloud non risponde da almeno UPLINK_DOWN_AFTER_MS: il nodo lavora
 *  in isola. Solo col profilo service-node ha senso. */
export const isCloudUplinkDown = (): boolean =>
    isServiceNode && !uplinkConnected && Date.now() - uplinkDownSince >= UPLINK_DOWN_AFTER_MS;

// --- I tre numeri dell'osservabilità (fase A3; sez. «Osservabilità» del
// brainstorming): ritardo cloud→nodo, ritardo nodo→cloud, battiture del nodo
// che il cloud non ha ancora. Tutti dal punto di vista del nodo, che è
// l'unico a saperli anche a linea giù.

// Ultimo giro di pull dal cloud andato a buon fine (anche vuoto): da qui il
// ritardo cloud→nodo, «quanto è vecchia la mia copia del cloud».
let lastCloudPullOkAt: number | null = null;

// Fin dove il cloud ha applicato il log del nodo: è l'`after` che il cloud
// manda a ogni node:pull. Sta anche su disco (replication_cursor, stream
// 'node_acked'), così un nodo riavviato a linea giù sa ancora cosa manca.
let cloudAckedSeq: number | null = null;

// rls-bypass: solo nodo, giro di sistema: il cursore 'node_acked' è del nodo, un tenant solo
const rememberCloudAck = async (after: number): Promise<void> => runAsPlatform(async () => {
    if (cloudAckedSeq !== null && after <= cloudAckedSeq) return;
    cloudAckedSeq = after;
    try {
        // rls-bypass: solo nodo (superuser locale, un tenant): il tenant si copia dal cursore 'cloud'
        await pool.query(
            `INSERT INTO replication_cursor (tenant_id, stream, applied_seq)
             SELECT tenant_id, 'node_acked', $1 FROM replication_cursor WHERE stream = 'cloud' LIMIT 1
             ON CONFLICT (tenant_id, stream)
             DO UPDATE SET applied_seq = GREATEST(replication_cursor.applied_seq, EXCLUDED.applied_seq), updated_at = CURRENT_TIMESTAMP`,
            [after]
        );
    } catch { /* il numero in memoria basta fino al prossimo giro */ }
});

export interface SalaNodeLocalStatus {
    version: string;
    uplink_connected: boolean;
    /** Da quando l'uplink è giù (ISO), null se è su. */
    uplink_down_since: string | null;
    /** Secondi dall'ultimo giro riuscito col cloud (null = mai). */
    lag_down_s: number | null;
    /** Età in secondi della più vecchia battitura locale che il cloud non ha. */
    lag_up_s: number;
    /** Battiture locali che il cloud non ha ancora. */
    pending_up: number;
}

// rls-bypass: solo nodo, nessuna sessione: legge il suo outbox locale e il cursore 'node_acked'
export const getSalaNodeLocalStatus = async (): Promise<SalaNodeLocalStatus> => runAsPlatform(async () => {
    if (cloudAckedSeq === null) {
        // rls-bypass: solo nodo (superuser locale, un tenant): il cursore 'node_acked' è unico
        const cur = await pool.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'node_acked' LIMIT 1`);
        cloudAckedSeq = cur.rows.length ? Number(cur.rows[0].applied_seq) : 0;
    }
    // rls-bypass: solo nodo (superuser locale, un tenant): outbox 'local' senza filtro tenant, è tutto suo
    const pending = await pool.query(
        `SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest
           FROM outbox_events WHERE origin = 'local' AND id > $1`,
        [cloudAckedSeq]
    );
    const oldest = pending.rows[0]?.oldest ? new Date(pending.rows[0].oldest).getTime() : null;
    const now = Date.now();
    return {
        version: BUILD_VERSION,
        uplink_connected: uplinkConnected,
        uplink_down_since: uplinkConnected ? null : new Date(uplinkDownSince).toISOString(),
        lag_down_s: lastCloudPullOkAt === null ? null : Math.max(0, Math.round((now - lastCloudPullOkAt) / 1000)),
        lag_up_s: oldest === null ? 0 : Math.max(0, Math.round((now - oldest) / 1000)),
        pending_up: Number(pending.rows[0]?.n ?? 0),
    };
});

export interface SalaNodeReplicaOpts {
    getClients?: () => number;
    /** Rigioca un envelope relay:event ai client LAN del nodo (room per
     *  room, come faceva il relay tappa-3). Iniettato da server.ts. */
    relayToLocal?: (rooms: string[], event: string, data: any) => void;
    /** Ogni tipo di evento annunciato dal cloud: la sincronizzazione della
     *  configurazione (salaNodeConfigSync) lo usa come sveglia. */
    onCloudEvent?: (event: string) => void;
    /** Gli effetti locali dopo un lotto del cloud applicato (fase B3). */
    onApplied?: (tenantId: number, events: ReplicaEvent[]) => Promise<void>;
    /** Le chiamate del cloud al nodo (fase B3b), per nome. */
    rpc?: Record<string, (payload: any) => Promise<any>>;
}

export const startSalaNodeReplica = (opts?: SalaNodeReplicaOpts): void => {
    if (!isServiceNode) return;
    onAppliedHook = opts?.onApplied ?? null;
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
        uplinkConnected = true;
        console.log('[replica] uplink connesso al cloud');
        void drain();
    });
    socket.on('disconnect', () => {
        if (uplinkConnected) uplinkDownSince = Date.now();
        uplinkConnected = false;
    });
    // Il battito: il bridge marca il nodo online solo se node:stats arriva
    // entro 30s — il relay tappa-3 lo mandava, il full-server pure (trovato
    // al collaudo del 23/09: «nodo offline da 218s» in card con l'uplink
    // vivo e i palmari collegati — e l'interruttore autorità congelato).
    const statsTimer = setInterval(() => {
        if (!socket.connected) return;
        void getSalaNodeLocalStatus().then((local) => {
            socket.emit('node:stats', {
                clients: opts?.getClients?.() ?? 0,
                cache_entries: 0,
                oldest_cache_age_s: null,
                version: local.version,
                lag_up_s: local.lag_up_s,
                lag_down_s: local.lag_down_s,
                pending_up: local.pending_up,
            });
        }).catch(() => {
            socket.emit('node:stats', { clients: opts?.getClients?.() ?? 0, cache_entries: 0, oldest_cache_age_s: null, version: BUILD_VERSION });
        });
    }, STATS_INTERVAL_MS);
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
            if (typeof envelope?.event === 'string') opts?.onCloudEvent?.(envelope.event);
        } catch { /* best effort */ }
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
    // Le chiamate del cloud (fase B3b: la quota del QR su un conto del nodo).
    socket.on('node:rpc', (req: any, ack: any) => {
        if (typeof ack !== 'function') return;
        const handler = opts?.rpc?.[String(req?.method)];
        if (!handler) return ack({ ok: false, error: 'unknown_method' });
        handler(req?.payload)
            .then((result) => ack({ ok: true, result }))
            .catch((err: any) => ack({ ok: false, error: err?.message || String(err) }));
    });
    let connErrLogged = 0;
    socket.on('connect_error', (err) => {
        if (Date.now() - connErrLogged > 60_000) {
            connErrLogged = Date.now();
            console.warn('[replica] uplink connect_error:', err?.message || err);
        }
    });

    void drain();
};
