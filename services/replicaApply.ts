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
import { syncIdSequence } from './idSpace.js';
import { eventSpec } from './eventRegistry.js';

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
    // Fase B2: conti (con pagamenti e quote), sessioni di cassa, documenti
    // fiscali. Un lato più vecchio non li manda: si convergerà al prossimo
    // evento dopo l'aggiornamento.
    table_bills?: any[];
    table_bill_payments?: any[];
    table_bill_splits?: any[];
    cash_sessions?: any[];
    fiscal_documents?: any[];
    payment_requests?: any[];
}

type FetchKind = 'tables' | 'reservations' | 'orders' | 'takeaways' | 'bills' | 'cashSessions' | 'fiscalDocs' | 'paymentRequests';
export type WantedRows = Record<'tables' | 'reservations' | 'orders' | 'takeaways', number[]>
    & Partial<Record<'bills' | 'cashSessions' | 'fiscalDocs' | 'paymentRequests', number[]>>;

// Come converge ogni tipo: 'fetch' = riga corrente dall'autorità; 'payload'
// = lo snapshot viaggia nell'evento (unioni/nascosti/chiusure, fase 1b);
// 'delete' = si toglie per riferimento. Un tipo assente si salta (ma si
// importa comunque nel log locale).
type Convergence =
    | { mode: 'fetch'; kind: FetchKind; idFrom: string }
    | { mode: 'payload'; table: string }
    | { mode: 'delete'; table: string; idFrom: string };

const CONVERGENCE: Record<string, Convergence> = {
    'table:updated': { mode: 'fetch', kind: 'tables', idFrom: 'table_id' },
    'reservation:created': { mode: 'fetch', kind: 'reservations', idFrom: 'reservation_id' },
    'reservation:updated': { mode: 'fetch', kind: 'reservations', idFrom: 'reservation_id' },
    // Tappa C: tavolo e arrivo, le sole colonne del servizio.
    'reservation:service-updated': { mode: 'fetch', kind: 'reservations', idFrom: 'reservation_id' },
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
    // Fase B2: l'aggregato conto (conto + pagamenti + quote), la sessione di
    // cassa, il documento fiscale. Riga assente all'autorità = via anche qui.
    'bill:changed': { mode: 'fetch', kind: 'bills', idFrom: 'bill_id' },
    'cash:changed': { mode: 'fetch', kind: 'cashSessions', idFrom: 'cash_session_id' },
    'fiscalDoc:changed': { mode: 'fetch', kind: 'fiscalDocs', idFrom: 'fiscal_document_id' },
    'paymentRequest:changed': { mode: 'fetch', kind: 'paymentRequests', idFrom: 'payment_request_id' },
};

/** I tipi che sul NODO arrivano ai client LAN già dal giro import→
 *  dispatcher: per questi il replay dell'envelope relay:event NON va fatto
 *  (raddoppierebbe i broadcast); per tutti gli altri (features:updated,
 *  kds:*, bill:*, menu…) l'envelope è l'unica strada verso la LAN. */
export const CONVERGED_TYPES: ReadonlySet<string> = new Set(Object.keys(CONVERGENCE));

/** Le colonne della prenotazione che appartengono al servizio (tappa C):
 *  le scrive PATCH /reservations/:id/service, e col servizio in sala il
 *  PUT del cloud non le tocca. */
export const RESERVATION_SERVICE_COLUMNS: readonly string[] = ['table_id', 'arrival_status'];

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

// Upsert SUL POSTO (fase B2): INSERT … ON CONFLICT (id) DO UPDATE. Il
// «via la riga, dentro quella nuova» di upsertRow va bene sul nodo, dove la
// replica gira in replica-mode e le FK tacciono; sul cloud no: cancellare un
// conto con documenti fiscali è vietato (RESTRICT), e cancellare una
// prenotazione si porterebbe via a cascata i suoi conti. Per conti, cassa e
// documenti fiscali si aggiorna la riga dov'è.
const columnsCache = new Map<string, string[]>();
const updatableColumns = async (client: any, table: string): Promise<string[]> => {
    const cached = columnsCache.get(table);
    if (cached) return cached;
    const rs = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name <> 'id' AND is_generated = 'NEVER'
          ORDER BY ordinal_position`,
        [table]
    );
    const cols = rs.rows.map((r: any) => String(r.column_name));
    columnsCache.set(table, cols);
    return cols;
};

const upsertInPlace = async (client: any, table: string, row: any, keep: readonly string[] = []): Promise<void> => {
    if (row?.id == null) return;
    const cols = (await updatableColumns(client, table)).filter(c => !keep.includes(c));
    // Prima l'UPDATE, l'INSERT solo se la riga manca. Non INSERT … ON
    // CONFLICT DO UPDATE: i trigger BEFORE INSERT scattano anche quando poi
    // il conflitto diventa un aggiornamento, e quello delle quote
    // (enforce_table_bill_split_sum, che per un INSERT conta tutte le quote
    // vive) contava due volte la quota già in casa. Il replica-mode sul nodo
    // spegne i trigger; sul cloud di Railway, senza superuser, restano
    // accesi — visto solo nella suite con RLS rigida.
    const set = cols.map(c => `"${c}" = src."${c}"`).join(', ');
    const upd = await client.query(
        `UPDATE ${table} AS t SET ${set}
           FROM jsonb_populate_record(NULL::${table}, $1::jsonb) AS src
          WHERE t.id = src.id`,
        [JSON.stringify(row)]
    );
    if ((upd.rowCount ?? 0) > 0) return;
    await client.query(
        `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
        [JSON.stringify([row])]
    );
};

// Una riga sparita all'autorità si toglie anche qui; ma se qui qualcosa la
// referenzia ancora (sul cloud le FK sono vive) non si blocca lo stream per
// sempre: si logga e si va avanti, il prossimo evento riproverà.
const deleteTolerant = async (client: any, table: string, id: number): Promise<void> => {
    await client.query('SAVEPOINT replica_delete');
    try {
        await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
        await client.query('RELEASE SAVEPOINT replica_delete');
    } catch (err: any) {
        await client.query('ROLLBACK TO SAVEPOINT replica_delete');
        console.warn(`[replica] ${table} ${id} non tolto (ancora referenziato):`, err?.message || err);
    }
};

// Le sequence locali oltre gli id arrivati, ma ognuna nel suo spazio (fase
// B1, services/idSpace.ts): il nodo sopra NODE_ID_BASE, il cloud sotto.
/** Gli id da rifetchare per un batch: il chiamante li passa al suo
 *  fetchRows (HTTP verso il cloud, o RPC socket verso il nodo). */
export const wantedRowsFor = (events: ReplicaEvent[]): WantedRows => {
    const wanted: Record<FetchKind, Set<number>> = {
        tables: new Set(), reservations: new Set(), orders: new Set(), takeaways: new Set(),
        bills: new Set(), cashSessions: new Set(), fiscalDocs: new Set(), paymentRequests: new Set(),
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
        bills: [...wanted.bills],
        cashSessions: [...wanted.cashSessions],
        fiscalDocs: [...wanted.fiscalDocs],
        paymentRequests: [...wanted.paymentRequests],
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
    const rows: FetchedRows = Object.values(wanted).some(list => (list?.length ?? 0) > 0)
        ? await opts.fetchRows(wanted)
        : {};
    // Fase B3: sul cloud le FK sono vive — una comanda o un documento che
    // citano un conto nato sul nodo vogliono il conto in casa PRIMA. Se il
    // conto non è nel lotto (è in un evento appena oltre il limite del
    // pull), lo si chiede ora insieme: è la riga corrente dell'autorità,
    // riapplicarla non costa niente.
    const fetchedBillIds = new Set((rows.table_bills ?? []).map((r: any) => Number(r.id)));
    const missingBills = new Set<number>();
    for (const ref of [...(rows.orders ?? []), ...(rows.fiscal_documents ?? [])]) {
        const billId = Number(ref?.table_bill_id);
        if (Number.isInteger(billId) && billId > 0 && !fetchedBillIds.has(billId)) missingBills.add(billId);
    }
    if (missingBills.size > 0) {
        const more = await opts.fetchRows({ tables: [], reservations: [], orders: [], takeaways: [], bills: [...missingBills] });
        rows.table_bills = [...(rows.table_bills ?? []), ...(more.table_bills ?? [])];
        rows.table_bill_payments = [...(rows.table_bill_payments ?? []), ...(more.table_bill_payments ?? [])];
        rows.table_bill_splits = [...(rows.table_bill_splits ?? []), ...(more.table_bill_splits ?? [])];
        for (const id of missingBills) wanted.bills = [...(wanted.bills ?? []), id];
    }
    const byId = (list?: any[]): Map<number, any> => new Map((list ?? []).map((r: any) => [Number(r.id), r]));
    const fetched = {
        tables: byId(rows.tables),
        reservations: byId(rows.reservations),
        orders: byId(rows.orders),
        takeaways: byId(rows.takeaway_orders),
        bills: byId(rows.table_bills),
        cashSessions: byId(rows.cash_sessions),
        fiscalDocs: byId(rows.fiscal_documents),
        paymentRequests: byId(rows.payment_requests),
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
    const paymentsByBill = groupBy(rows.table_bill_payments, 'table_bill_id');
    const splitsByBill = groupBy(rows.table_bill_splits, 'table_bill_id');

    const client = await pool.connect();
    const touched = new Set<string>();
    try {
        await client.query('BEGIN');
        try {
            await client.query(`SET LOCAL session_replication_role = replica`);
        } catch {
            // Sul Postgres di Railway l'utente NON è superuser e il SET è
            // negato (scoperto al collaudo del 23/09: ogni giro upstream
            // moriva qui e il cursore non nasceva mai — in locale e in CI
            // l'utente è superuser, i test non potevano vederlo). Sul cloud
            // il replica-mode è solo una cintura: gli aggregati arrivano
            // coi genitori già in casa, le FK vive non disturbano. Si
            // riarma la transazione (il SET fallito la abortisce) e si
            // applica senza. Sul NODO il SET riesce (superuser locale) e
            // resta necessario: il carico può citare cicli di FK reali.
            await client.query('ROLLBACK');
            await client.query('BEGIN');
        }
        // L'aggregato conto (conto, quote, pagamenti) dall'autorità: dal
        // cloud quando il conto è suo, dal nodo col servizio in sala (anche
        // le quote del QR, dalla fase B3b). Una volta per conto per lotto.
        const appliedBills = new Set<number>();
        const applyBill = async (id: number): Promise<void> => {
            if (appliedBills.has(id)) return;
            appliedBills.add(id);
            const onNodeSide = cursorStream === 'cloud';
            const bill = fetched.bills.get(id);
            await client.query(`DELETE FROM table_bill_payments WHERE table_bill_id = $1`, [id]);
            // Sul nodo (replica-mode, FK mute) le quote si sostituiscono in
            // blocco. Sul cloud le referenziano le richieste di pagamento (FK
            // vive): si aggiornano sul posto, e quelle sparite si tolgono se
            // nessuno le cita più.
            if (onNodeSide) await client.query(`DELETE FROM table_bill_splits WHERE table_bill_id = $1`, [id]);
            if (!bill) {
                await deleteTolerant(client, 'table_bills', id);
                return;
            }
            await upsertInPlace(client, 'table_bills', bill);
            const splits = splitsByBill.get(id) ?? [];
            if (onNodeSide) {
                if (splits.length) {
                    await client.query(
                        `INSERT INTO table_bill_splits SELECT * FROM jsonb_populate_recordset(NULL::table_bill_splits, $1::jsonb)`,
                        [JSON.stringify(splits)]
                    );
                }
            } else {
                for (const split of splits) await upsertInPlace(client, 'table_bill_splits', split);
                const keep = splits.map((r: any) => Number(r.id));
                const gone = await client.query(
                    `SELECT id FROM table_bill_splits WHERE table_bill_id = $1 AND NOT (id = ANY($2::bigint[]))`,
                    [id, keep]
                );
                for (const row of gone.rows) await deleteTolerant(client, 'table_bill_splits', Number(row.id));
            }
            const payments = paymentsByBill.get(id) ?? [];
            if (payments.length) {
                await client.query(
                    `INSERT INTO table_bill_payments SELECT * FROM jsonb_populate_recordset(NULL::table_bill_payments, $1::jsonb)`,
                    [JSON.stringify(payments)]
                );
            }
            touched.add('table_bills'); touched.add('table_bill_payments'); touched.add('table_bill_splits');
        };
        // Prima i conti (anche quelli presi per dipendenza): comande e
        // documenti fiscali del lotto li citano, e sul cloud le FK sono vive.
        for (const id of fetched.bills.keys()) await applyBill(id);

        // Le prenotazioni per colonna (tappa C). La prenotazione è del
        // cloud, tavolo e arrivo del servizio: con l'autorità in sala il
        // nodo non si fa riscrivere quelle due colonne da una riga del
        // cloud (che le ha vecchie di qualche secondo, o di un'ora a linea
        // giù), e reservation:service-updated porta SOLO quelle. Così un
        // nome corretto nel cloud e un tavolo assegnato in sala, nello
        // stesso minuto, sopravvivono tutti e due. Annullata o rifiutata
        // nel cloud = tavolo libero anche sul nodo, come fa il PUT.
        const onNodeSide = cursorStream === 'cloud';
        let serviceOnNodeCached: boolean | null = null;
        const serviceOnNode = async (): Promise<boolean> => {
            if (serviceOnNodeCached === null) {
                const rs = await client.query(
                    `SELECT value FROM app_settings WHERE tenant_id = $1 AND key = 'sala_node_authority_enabled'`,
                    [tenantId]
                );
                serviceOnNodeCached = rs.rows[0]?.value === true;
            }
            return serviceOnNodeCached;
        };
        const applyReservation = async (type: string, id: number): Promise<void> => {
            const row = fetched.reservations.get(id);
            if (!row) {
                // La prenotazione esiste finché il cloud la tiene: al nodo
                // può mancare solo perché fuori dalla sua finestra.
                if (onNodeSide) await client.query(`DELETE FROM reservations WHERE id = $1`, [id]);
                return;
            }
            const local = await client.query(`SELECT 1 FROM reservations WHERE id = $1`, [id]);
            touched.add('reservations');
            if (local.rows.length === 0) {
                await upsertInPlace(client, 'reservations', row);
                return;
            }
            if (type === 'reservation:service-updated') {
                await client.query(
                    `UPDATE reservations SET table_id = $2, arrival_status = $3 WHERE id = $1`,
                    [id, row.table_id ?? null, row.arrival_status ?? 'WAITING']
                );
                return;
            }
            if (onNodeSide && await serviceOnNode()) {
                const releases = row.reservation_status === 'CANCELLED' || row.reservation_status === 'DECLINED';
                await upsertInPlace(client, 'reservations', row,
                    releases ? ['arrival_status'] : RESERVATION_SERVICE_COLUMNS);
                return;
            }
            await upsertInPlace(client, 'reservations', row);
        };

        for (const ev of events) {
            // L'import SEMPRE, anche per i tipi che non sappiamo applicare:
            // i broadcast partono dal dispatcher locale, e il log resta
            // completo. La dedup è l'ON CONFLICT su event_id.
            await outboxImportInTx(client, tenantId, ev);
            const conv = CONVERGENCE[ev.type];
            if (!conv) continue;
            // Tappa C: sul cloud, un evento che il registro dà al cloud
            // (reservation:updated, :deleted…) arrivato dal nodo si registra
            // ma non si applica — il nodo non è padrone di quei dati, e una
            // sua copia vecchia riscriverebbe la prenotazione vera.
            if (!onNodeSide && eventSpec(ev.type)?.authority === 'cloud') continue;
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
            if (conv.kind === 'reservations') {
                await applyReservation(ev.type, id);
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
            if (conv.kind === 'bills') {
                await applyBill(id);
                continue;
            }
            if (conv.kind === 'cashSessions' || conv.kind === 'fiscalDocs' || conv.kind === 'paymentRequests') {
                const table = conv.kind === 'cashSessions' ? 'cash_sessions' : conv.kind === 'fiscalDocs' ? 'fiscal_documents' : 'payment_requests';
                const row = fetched[conv.kind].get(id);
                if (!row) {
                    await deleteTolerant(client, table, id);
                    continue;
                }
                await upsertInPlace(client, table, row);
                touched.add(table);
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
        for (const table of touched) await syncIdSequence(client, table);
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
