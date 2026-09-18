// L'applier della replica — condiviso fra i DUE consumatori dell'ibrido
// (tappa 4): il nodo che consuma lo stream del cloud (salaNodeReplica) e il
// cloud che consuma lo stream del nodo (salaNodeUpstream). Stesso codice,
// stessa semantica, cambia solo chi fornisce le righe correnti (fetchRows)
// e il nome del cursore.
//
// I principi (sez. 7 del brainstorming):
// - INBOX transazionale: proiezioni, import degli eventi nel log locale e
//   cursore avanzano in UNA transazione — at-least-once che diventa
//   exactly-once (la dedup dell'import è l'ON CONFLICT su event_id).
// - CONVERGENZA per rifetch: il log porta riferimenti; «applicare» è
//   scaricare la riga corrente dall'autorità e upsertarla. Riga assente =
//   sparita dall'autorità = si toglie anche qui. Eventi multipli sullo
//   stesso aggregato collassano da soli.
// - L'IMPORT nel log locale (origin='replica') fa partire i broadcast dai
//   handler del dispatcher, con l'atomicità di sempre — ed essendo
//   'replica' non verrà mai rispedito da dove è venuto: niente eco.
// - session_replication_role=replica sulle scritture: righe già validate
//   dall'autorità, le FK locali non hanno niente da dire. Richiede un
//   utente superuser (vero sul Postgres locale del nodo E sul Postgres
//   Railway di oggi).
// - Un tipo ignoto si IMPORTA (broadcast/futuro) ma non si applica: la
//   tolleranza di schema — i due lati possono girare ore su versioni
//   diverse.

import pool from '../db.js';
import { outboxImportInTx } from './outboxService.js';

export interface ReplicaEvent {
    seq: number;
    event_id: string;
    type: string;
    aggregate: string;
    payload: any;
    command_id?: string | null;
    causation_id?: string | null;
    actor?: any;
    schema_ver?: number;
}

export interface FetchedRows {
    tables?: any[];
    reservations?: any[];
    orders?: any[];
    order_items?: any[];
    order_revisions?: any[];
    takeaway_orders?: any[];
    takeaway_order_items?: any[];
}

export type WantedRows = Record<'tables' | 'reservations' | 'orders' | 'takeaways', number[]>;

// Come converge ogni tipo: 'fetch' = riga corrente dall'autorità; 'payload'
// = lo snapshot viaggia nell'evento (unioni/nascosti/chiusure, fase 1b);
// 'delete' = si toglie per riferimento. Un tipo assente si salta (ma si
// importa comunque nel log locale).
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

/** Le sequence locali vanno tenute oltre gli id dell'autorità, o il primo
 *  INSERT nativo di questo lato colliderà. */
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

/** Gli id da rifetchare per un batch: il chiamante li passa al suo
 *  fetchRows (HTTP verso il cloud, o RPC socket verso il nodo). */
export const wantedRowsFor = (events: ReplicaEvent[]): WantedRows => {
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
    return {
        tables: [...wanted.tables],
        reservations: [...wanted.reservations],
        orders: [...wanted.orders],
        takeaways: [...wanted.takeaways],
    };
};

export const applyReplicaBatch = async (opts: {
    tenantId: number;
    events: ReplicaEvent[];
    /** 'cloud' sul nodo (consuma lo stream del cloud), 'node' sul cloud. */
    cursorStream: 'cloud' | 'node';
    /** Le righe correnti degli aggregati citati, chieste all'autorità. */
    fetchRows: (wanted: WantedRows) => Promise<FetchedRows>;
}): Promise<void> => {
    const { tenantId, events, cursorStream } = opts;
    if (events.length === 0) return;

    // Prima il rifetch (fuori transazione: è rete), poi l'applicazione.
    const wanted = wantedRowsFor(events);
    const rows: FetchedRows = (wanted.tables.length || wanted.reservations.length || wanted.orders.length || wanted.takeaways.length)
        ? await opts.fetchRows(wanted)
        : {};
    const byId = (list?: any[]): Map<number, any> => new Map((list ?? []).map((r: any) => [Number(r.id), r]));
    const fetched = {
        tables: byId(rows.tables),
        reservations: byId(rows.reservations),
        orders: byId(rows.orders),
        takeaways: byId(rows.takeaway_orders),
    };
    const groupBy = (list: any[] | undefined, key: string): Map<number, any[]> => {
        const map = new Map<number, any[]>();
        for (const row of list ?? []) {
            const k = Number(row[key]);
            const bucket = map.get(k) ?? [];
            bucket.push(row);
            map.set(k, bucket);
        }
        return map;
    };
    const itemsByOrder = groupBy(rows.order_items, 'order_id');
    const revisionsByOrder = groupBy(rows.order_revisions, 'order_id');
    const takeawayItemsByOrder = groupBy(rows.takeaway_order_items, 'takeaway_order_id');

    const client = await pool.connect();
    const touched = new Set<string>();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`);
        for (const ev of events) {
            // L'import SEMPRE, anche per i tipi che non sappiamo applicare:
            // i broadcast partono dal dispatcher locale, e il log resta
            // completo. La dedup è l'ON CONFLICT su event_id.
            await outboxImportInTx(client, tenantId, ev);
            const conv = CONVERGENCE[ev.type];
            if (!conv) continue;
            if (conv.mode === 'delete') {
                const id = Number(ev.payload?.[conv.idFrom]);
                if (Number.isInteger(id)) await client.query(`DELETE FROM ${conv.table} WHERE id = $1`, [id]);
                continue;
            }
            if (conv.mode === 'payload') {
                // Lo snapshot nel payload è nato da un RETURNING senza
                // tenant_id (colonna NOT NULL qui): lo mette l'applier.
                await upsertRow(client, conv.table, { ...ev.payload, tenant_id: tenantId });
                touched.add(conv.table);
                continue;
            }
            const id = Number(ev.payload?.[conv.idFrom]);
            if (!Number.isInteger(id) || id <= 0) continue;
            if (conv.kind === 'orders') {
                const order = fetched.orders.get(id);
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
        // proiezioni — righe, import e punto di ripresa sono un fatto solo.
        await client.query(
            `INSERT INTO replication_cursor (tenant_id, stream, applied_seq)
             VALUES ($1, $2, $3)
             ON CONFLICT (tenant_id, stream)
             DO UPDATE SET applied_seq = EXCLUDED.applied_seq, updated_at = CURRENT_TIMESTAMP`,
            [tenantId, cursorStream, events[events.length - 1].seq]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* noop */ });
        throw err;
    } finally {
        client.release();
    }
};
