// Bootstrap del nodo di sala (tappa 4 ibrido, fase 2c): scarica lo snapshot
// dal cloud (GET /sala-node/snapshot, fase 2b) e lo carica nel Postgres
// locale, registrando il cursore in replication_cursor. «Il nodo è bestiame»:
// un PC nuovo con token + questo bootstrap è un nodo funzionante, e un nodo
// rimasto indietro oltre la ritenzione si rifà da capo con lo stesso codice.
//
// Gira SOLO col profilo service-node (server.ts lo invoca dopo le
// migration). Al primo avvio la riga del cursore non c'è → si scarica e si
// carica; agli avvii successivi la riga c'è → non si tocca niente (il
// riallineamento fine è compito del replay, fase 3). SALA_NODE_BOOTSTRAP=
// force ripete il bootstrap comunque: è il «reinstallo» senza reinstallare.
//
// Due scelte tecniche da conoscere:
// - session_replication_role = replica DENTRO la transazione di carico: le
//   proiezioni hanno un ciclo di FK reale (orders → table_bills →
//   takeaway_orders → orders), nessun ordine di INSERT può soddisfarlo.
//   In replica-mode le FK non si valutano — legittimo: queste righe le ha
//   già validate il cloud, qui si copia una foto, non si scrive dominio.
//   Richiede un utente superuser sul Postgres LOCALE del nodo (che è
//   nostro: lo crea l'installer); se manca, l'errore lo dice chiaro.
// - jsonb_populate_recordset(NULL::tabella, $1) per gli INSERT: il cast dal
//   JSON dello snapshot ai tipi veri (date, jsonb, int[]) lo fa Postgres
//   per nome di colonna — niente serializzazioni artigianali, le colonne
//   assenti (gli hash tolti dal cloud) restano NULL.

import pool, { runAsPlatform } from '../db.js';
import { isServiceNode } from './topology.js';

const RETRY_MS = 60_000;
const CHUNK_ROWS = 1_000;

// Colonne che il cloud toglie dallo snapshot ma che localmente sono NOT
// NULL: si riempiono con una sentinella NON verificabile — nessun bcrypt
// comincia per '!', quindi il login con password sul nodo fallisce sempre
// (com'è giusto: le password le verifica solo il cloud, il nodo verifica
// i JWT col segreto condiviso).
const FILL_COLUMNS: Record<string, Record<string, string>> = {
    users: { password_hash: '!nodo-di-sala' },
};

interface Snapshot {
    format: number;
    tenant_id: number;
    seq: number;
    tables: Record<string, any[]>;
}

const cloudUrl = (): string | null => {
    const raw = process.env.SALA_NODE_CLOUD_URL || '';
    return raw ? raw.replace(/\/+$/, '') : null;
};

const fetchSnapshot = async (): Promise<Snapshot> => {
    const base = cloudUrl();
    const token = process.env.SALA_NODE_TOKEN || '';
    if (!base || !token) {
        throw new Error('SALA_NODE_CLOUD_URL e SALA_NODE_TOKEN sono obbligatorie col profilo service-node');
    }
    const res = await fetch(`${base}/sala-node/snapshot`, {
        headers: { 'X-Sala-Node-Token': token, accept: 'application/json' },
    });
    if (!res.ok) {
        throw new Error(`snapshot dal cloud: HTTP ${res.status}`);
    }
    const body = await res.json() as Snapshot;
    if (body?.format !== 1 || !Number.isInteger(body?.tenant_id) || !Number.isFinite(body?.seq) || typeof body?.tables !== 'object') {
        throw new Error('snapshot dal cloud: forma inattesa');
    }
    return body;
};

const loadSnapshot = async (snap: Snapshot): Promise<void> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = '300s'`);
        try {
            await client.query(`SET LOCAL session_replication_role = replica`);
        } catch (err: any) {
            throw new Error(
                `session_replication_role richiede un utente superuser sul Postgres locale del nodo (${err?.message || err})`
            );
        }
        const names = Object.keys(snap.tables);
        // DELETE in ordine inverso (figli prima) — non necessario in
        // replica-mode, ma tiene il carico leggibile e rigiocabile a mano.
        for (const name of [...names].reverse()) {
            await client.query(`DELETE FROM ${name} WHERE tenant_id = $1`, [snap.tenant_id]);
        }
        for (const name of names) {
            let rows = snap.tables[name];
            if (!Array.isArray(rows) || rows.length === 0) continue;
            const fill = FILL_COLUMNS[name];
            if (fill) rows = rows.map(row => ({ ...row, ...fill }));
            for (let i = 0; i < rows.length; i += CHUNK_ROWS) {
                const chunk = rows.slice(i, i + CHUNK_ROWS);
                await client.query(
                    `INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name}, $1::jsonb)`,
                    [JSON.stringify(chunk)]
                );
            }
            // Le righe arrivano con gli id del cloud: la sequence locale va
            // portata oltre, o il primo INSERT nativo del nodo collide.
            // Il WHERE EXISTS evita l'errore (che abortirebbe la tx) sulle
            // tabelle senza colonna id (opening_hours ha PK composta).
            const seqName = await client.query(
                `SELECT pg_get_serial_sequence($1, 'id') AS s
                 WHERE EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'id'
                 )`,
                [name]
            );
            if (seqName.rows[0]?.s) {
                await client.query(
                    `SELECT setval($1, GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${name}), 1))`,
                    [seqName.rows[0].s]
                );
            }
        }
        // Il cursore, NELLA stessa transazione delle proiezioni: le righe e
        // il punto di ripresa del replay sono un fatto solo.
        await client.query(
            `INSERT INTO replication_cursor (tenant_id, stream, applied_seq)
             VALUES ($1, 'cloud', $2)
             ON CONFLICT (tenant_id, stream)
             DO UPDATE SET applied_seq = EXCLUDED.applied_seq, updated_at = CURRENT_TIMESTAMP`,
            [snap.tenant_id, snap.seq]
        );
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* noop */ });
        throw err;
    } finally {
        client.release();
    }
};

const attempt = async (): Promise<boolean> => runAsPlatform(async () => {
    if (process.env.SALA_NODE_BOOTSTRAP !== 'force') {
        const cur = await pool.query(`SELECT applied_seq FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
        if (cur.rows.length > 0) {
            console.log(`[bootstrap] cursore già presente (seq ${cur.rows[0].applied_seq}): niente da fare, il riallineamento è del replay`);
            return true;
        }
    }
    const snap = await fetchSnapshot();
    const righe = Object.values(snap.tables).reduce((n, rows) => n + (rows?.length ?? 0), 0);
    console.log(`[bootstrap] snapshot del tenant ${snap.tenant_id} al seq ${snap.seq}: ${righe} righe in ${Object.keys(snap.tables).length} tabelle`);
    await loadSnapshot(snap);
    console.log(`[bootstrap] ✅ proiezioni caricate, cursore 'cloud' a ${snap.seq}`);
    return true;
});

/** Avviato da server.ts (solo profilo service-node) dopo le migration:
 *  ritenta ogni minuto finché non riesce — un nodo appena installato con la
 *  linea giù non deve morire, deve aspettare la linea. */
export const scheduleSalaNodeBootstrap = (): void => {
    if (!isServiceNode) return;
    let running = false;
    const tick = async () => {
        if (running) return;
        running = true;
        try {
            if (await attempt()) {
                clearInterval(timer);
            }
        } catch (err: any) {
            console.error('[bootstrap] tentativo fallito, si riprova fra 60s:', err?.message || err);
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void tick(), RETRY_MS);
    if (typeof timer.unref === 'function') timer.unref();
    void tick();
};
