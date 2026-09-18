// La replica cloud→nodo (tappa 4 ibrido, fase 3): il consumatore dello
// stream del cloud, girato sul nodo di sala col profilo service-node.
//
// Il protocollo (sez. 7 del brainstorming):
// - PULL con cursore: «dammi da seq N, max 500» su GET /sala-node/events.
//   Il socket (namespace /sala-node, lo stesso canale del mirror tappa 3)
//   SVEGLIA soltanto: ogni relay:event fa scattare un giro di pull. Il
//   polling periodico è il fallback a socket giù. Il recupero post-outage
//   è lo stesso giro con più batch: nessun percorso speciale.
// - INBOX transazionale: le proiezioni si aggiornano e il cursore avanza
//   NELLA STESSA transazione — consegna at-least-once, effetto exactly-once.
// - CONVERGENZA per rifetch: il log porta riferimenti (regola PII), quindi
//   «applicare» un evento significa richiedere la riga corrente al cloud
//   (POST /sala-node/rows) e upsertarla; una riga assente nella risposta è
//   sparita sul cloud e si toglie anche qui. Eventi multipli sullo stesso
//   aggregato in un batch collassano da soli: si scrive lo stato corrente.
// - Le scritture di proiezione girano con session_replication_role=replica
//   (come il bootstrap): righe già validate dal cloud, le FK locali non
//   hanno niente da dire — e gli eventi possono citare aggregati i cui
//   genitori arriveranno con l'evento dopo.
//
// Un tipo di evento sconosciuto NON ferma la replica: si salta e il cursore
// avanza — è la tolleranza di schema della sez. «Migrazioni» (nodo e cloud
// possono girare ore su versioni diverse).

import { io, type Socket } from 'socket.io-client';
import pool, { runAsPlatform } from '../db.js';
import { isServiceNode } from './topology.js';

const PULL_LIMIT = 500;
const POLL_MS = Math.max(1_000, Number(process.env.SALA_NODE_PULL_INTERVAL_MS) || 15_000);
const WAKE_DEBOUNCE_MS = 150;

interface ReplicaEvent {
    seq: number;
    type: string;
    aggregate: string;
    payload: any;
}

// Come converge ogni tipo: 'fetch' = riga corrente dal cloud; 'payload' =
// lo snapshot viaggia nell'evento (unioni/nascosti/chiusure, fase 1b);
// 'delete' = si toglie per riferimento. Un tipo assente qui si salta.
type Convergence =
    | { mode: 'fetch'; kind: 'tables' | 'reservations' | 'orders' | 'takeaways'; idFrom: string }
    | { mode: 'payload'; table: string }
    | { mode: 'delete'; table: string; idFrom: string };

const CONVERGENCE: Record<string, Convergence> = {
    'table:updated': { mode: 'fetch', kind: 'tables', idFrom: 'table_id' },
    'reservation:created': { mode: 'fetch', kind: 'reservations', idFrom: 'reservation_id' },
    'reservation:updated': { mode: 'fetch', kind: 'reservations', idFrom: 'reservation_id' },
    'reservation:deleted': { mode: 'delete', table: 'reservations', idFrom: 'reservation_id' },
    'order:created': { mode: 'fetch', kind: 'orders', idFrom: 'order_id' },
    'order:updated': { mode: 'fetch', kind: 'orders', idFrom: 'order_id' },
    // La cancellazione converge per rifetch come tutto il resto: la riga
    // non c'è più → si toglie comanda e figli con lo stesso codice.
    'order:deleted': { mode: 'fetch', kind: 'orders', idFrom: 'order_id' },
    'takeaway:created': { mode: 'fetch', kind: 'takeaways', idFrom: 'takeaway_order_id' },
    'takeaway:updated': { mode: 'fetch', kind: 'takeaways', idFrom: 'takeaway_order_id' },
    'tableMerge:created': { mode: 'payload', table: 'table_merges' },
    'tableMerge:deleted': { mode: 'delete', table: 'table_merges', idFrom: 'id' },
    'tableHidden:created': { mode: 'payload', table: 'table_hidden_overrides' },
    'tableHidden:deleted': { mode: 'delete', table: 'table_hidden_overrides', idFrom: 'id' },
    'roomClosed:created': { mode: 'payload', table: 'room_closed_overrides' },
    'roomClosed:deleted': { mode: 'delete', table: 'room_closed_overrides', idFrom: 'id' },
};

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

/** Upsert brutale e idempotente: via la riga con quell'id, dentro quella
 *  nuova — jsonb_populate_recordset fa i cast per nome di colonna. */
const upsertRow = async (client: any, table: string, row: any): Promise<void> => {
    if (row?.id == null) return;
    await client.query(`DELETE FROM ${table} WHERE id = $1`, [row.id]);
    await client.query(
        `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
        [JSON.stringify([row])]
    );
};

/** Le sequence locali vanno tenute oltre gli id del cloud, o il primo
 *  INSERT nativo del nodo (fase 4) colliderà. Stessa guardia del bootstrap. */
const bumpSequence = async (client: any, table: string): Promise<void> => {
    const seqName = await client.query(
        `SELECT pg_get_serial_sequence($1, 'id') AS s
         WHERE EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
         )`,
        [table]
    );
    if (seqName.rows[0]?.s) {
        await client.query(
            `SELECT setval($1, GREATEST((SELECT last_value FROM ${seqName.rows[0].s}), (SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`,
            [seqName.rows[0].s]
        );
    }
};

const applyBatch = async (tenantId: number, events: ReplicaEvent[]): Promise<void> => {
    // Prima il rifetch (fuori transazione: è rete), poi l'applicazione.
    const wanted: Record<'tables' | 'reservations' | 'orders' | 'takeaways', Set<number>> = {
        tables: new Set(), reservations: new Set(), orders: new Set(), takeaways: new Set(),
    };
    for (const ev of events) {
        const conv = CONVERGENCE[ev.type];
        if (conv?.mode === 'fetch') {
            const id = Number(ev.payload?.[conv.idFrom]);
            if (Number.isInteger(id) && id > 0) wanted[conv.kind].add(id);
        }
    }
    const rows = (wanted.tables.size || wanted.reservations.size || wanted.orders.size || wanted.takeaways.size)
        ? await cloudPost('/sala-node/rows', {
            tables: [...wanted.tables],
            reservations: [...wanted.reservations],
            orders: [...wanted.orders],
            takeaways: [...wanted.takeaways],
        })
        : { tables: [], reservations: [], orders: [], order_items: [], order_revisions: [], takeaway_orders: [], takeaway_order_items: [] };
    const byId = (list: any[]): Map<number, any> => new Map((list ?? []).map((r: any) => [Number(r.id), r]));
    const fetched = {
        tables: byId(rows.tables),
        reservations: byId(rows.reservations),
        orders: byId(rows.orders),
        takeaways: byId(rows.takeaway_orders),
    };
    const takeawayItemsByOrder = new Map<number, any[]>();
    for (const item of rows.takeaway_order_items ?? []) {
        const list = takeawayItemsByOrder.get(Number(item.takeaway_order_id)) ?? [];
        list.push(item);
        takeawayItemsByOrder.set(Number(item.takeaway_order_id), list);
    }
    const itemsByOrder = new Map<number, any[]>();
    for (const item of rows.order_items ?? []) {
        const list = itemsByOrder.get(Number(item.order_id)) ?? [];
        list.push(item);
        itemsByOrder.set(Number(item.order_id), list);
    }
    const revisionsByOrder = new Map<number, any[]>();
    for (const rev of rows.order_revisions ?? []) {
        const list = revisionsByOrder.get(Number(rev.order_id)) ?? [];
        list.push(rev);
        revisionsByOrder.set(Number(rev.order_id), list);
    }

    const client = await pool.connect();
    const touched = new Set<string>();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`);
        for (const ev of events) {
            const conv = CONVERGENCE[ev.type];
            if (!conv) continue; // tipo ignoto o non replicabile: si salta, il cursore avanza
            if (conv.mode === 'delete') {
                const id = Number(ev.payload?.[conv.idFrom]);
                if (Number.isInteger(id)) await client.query(`DELETE FROM ${conv.table} WHERE id = $1`, [id]);
                continue;
            }
            if (conv.mode === 'payload') {
                // Lo snapshot nel payload è nato da un RETURNING senza
                // tenant_id (colonna NOT NULL qui): lo mette l'applier, che
                // il tenant lo sa dal cursore.
                await upsertRow(client, conv.table, { ...ev.payload, tenant_id: tenantId });
                touched.add(conv.table);
                continue;
            }
            const id = Number(ev.payload?.[conv.idFrom]);
            if (!Number.isInteger(id) || id <= 0) continue;
            if (conv.kind === 'orders') {
                const order = fetched.orders.get(id);
                // La riga (e i figli) si sostituiscono in blocco; assente sul
                // cloud = si toglie anche qui, figli compresi.
                await client.query(`DELETE FROM order_items WHERE order_id = $1`, [id]);
                await client.query(`DELETE FROM order_revisions WHERE order_id = $1`, [id]);
                if (!order) {
                    await client.query(`DELETE FROM orders WHERE id = $1`, [id]);
                    continue;
                }
                await upsertRow(client, 'orders', order);
                const items = itemsByOrder.get(id) ?? [];
                if (items.length) {
                    await client.query(
                        `INSERT INTO order_items SELECT * FROM jsonb_populate_recordset(NULL::order_items, $1::jsonb)`,
                        [JSON.stringify(items)]
                    );
                }
                const revisions = revisionsByOrder.get(id) ?? [];
                if (revisions.length) {
                    await client.query(
                        `INSERT INTO order_revisions SELECT * FROM jsonb_populate_recordset(NULL::order_revisions, $1::jsonb)`,
                        [JSON.stringify(revisions)]
                    );
                }
                touched.add('orders'); touched.add('order_items'); touched.add('order_revisions');
                continue;
            }
            if (conv.kind === 'takeaways') {
                const tw = fetched.takeaways.get(id);
                await client.query(`DELETE FROM takeaway_order_items WHERE takeaway_order_id = $1`, [id]);
                if (!tw) {
                    await client.query(`DELETE FROM takeaway_orders WHERE id = $1`, [id]);
                    continue;
                }
                await upsertRow(client, 'takeaway_orders', tw);
                const twItems = takeawayItemsByOrder.get(id) ?? [];
                if (twItems.length) {
                    await client.query(
                        `INSERT INTO takeaway_order_items SELECT * FROM jsonb_populate_recordset(NULL::takeaway_order_items, $1::jsonb)`,
                        [JSON.stringify(twItems)]
                    );
                }
                touched.add('takeaway_orders'); touched.add('takeaway_order_items');
                continue;
            }
            const table = conv.kind; // 'tables' | 'reservations': nome tabella = kind
            const row = fetched[conv.kind].get(id);
            if (!row) {
                await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
                continue;
            }
            await upsertRow(client, table, row);
            touched.add(table);
        }
        for (const table of touched) await bumpSequence(client, table);
        // L'inbox: il cursore avanza NELLA stessa transazione delle
        // proiezioni — righe e punto di ripresa sono un fatto solo.
        await client.query(
            `UPDATE replication_cursor SET applied_seq = $2, updated_at = CURRENT_TIMESTAMP
             WHERE tenant_id = $1 AND stream = 'cloud'`,
            [tenantId, events[events.length - 1].seq]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* noop */ });
        throw err;
    } finally {
        client.release();
    }
};

/** Un giro di pull: torna true se c'era roba (e quindi conviene rigirare
 *  subito — a valle di un outage si drena a batch pieni). */
const pullOnce = async (): Promise<boolean> => runAsPlatform(async () => {
    const cur = await pool.query(`SELECT tenant_id, applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
    if (cur.rows.length === 0) return false; // bootstrap non ancora fatto
    const tenantId = Number(cur.rows[0].tenant_id);
    const after = Number(cur.rows[0].applied_seq);
    const body = await cloudGet(`/sala-node/events?after=${after}&limit=${PULL_LIMIT}`);
    const events: ReplicaEvent[] = Array.isArray(body?.events) ? body.events : [];
    if (events.length === 0) return false;
    await applyBatch(tenantId, events);
    console.log(`[replica] applicati ${events.length} eventi, cursore a ${events[events.length - 1].seq}`);
    return true;
});

export const startSalaNodeReplica = (): void => {
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
    socket.on('relay:event', wake);
    let connErrLogged = 0;
    socket.on('connect_error', (err) => {
        if (Date.now() - connErrLogged > 60_000) {
            connErrLogged = Date.now();
            console.warn('[replica] uplink connect_error:', err?.message || err);
        }
    });

    void drain();
};
