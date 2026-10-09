// La configurazione del nodo di sala resta allineata al cloud anche dopo il
// bootstrap (fase A2 del piano «sala, comande e conto sul nodo»).
//
// Lo snapshot carica menu, listini, utenti, stampanti e impostazioni una
// volta sola; lo stream degli eventi porta solo il dominio servizio. Senza
// questo giro, un piatto aggiunto nel cloud in giornata non esisteva sul
// nodo (con l'autorità al nodo non si poteva battere), un utente
// disattivato restava attivo e uno creato dopo l'installazione mancava del
// tutto (le sue comande sul nodo violavano la FK).
//
// Il meccanismo: il nodo manda l'impronta che conosce di ogni tabella
// (POST /sala-node/config), il cloud risponde le righe delle sole tabelle
// cambiate, il nodo le applica in UNA transazione in replica-mode (come il
// bootstrap). Ogni 2 minuti, subito quando il cloud annuncia una modifica
// di configurazione, e la rubrica clienti, grande e mossa a ogni
// prenotazione, ogni 15.
//
// Come si applica ogni tabella dipende da chi la scrive sul nodo:
// - 'replace' (default): tutta configurazione del cloud, si sostituisce;
// - 'tables': lo STATO dei tavoli lo scrive il nodo quando ha l'autorità,
//   quindi qui si aggiungono solo i tavoli nuovi e si tolgono quelli
//   spariti; le righe esistenti le muove il log (table:updated);
// - 'app_settings': si sovrascrivono solo le chiavi che il cloud ha, una
//   chiave locale del nodo non si cancella.

import pool, { runAsPlatform } from '../db.js';
import { isServiceNode } from './topology.js';
import { syncIdSequence } from './idSpace.js';

const FAST_MS = Math.max(1_000, Number(process.env.SALA_NODE_CONFIG_SYNC_MS) || 120_000);
const SLOW_EVERY = 7; // la rubrica un giro su 7: ~15 minuti col passo di default
const SLOW_TABLES = new Set(['customers']);
const WAKE_DEBOUNCE_MS = 2_000;

// Le stesse tabelle della CONFIG_SYNC_TABLES del cloud: il cloud ignora
// quelle che non conosce, quindi una versione diversa non rompe niente.
const CONFIG_TABLES = [
    'tenants', 'tenant_features', 'users', 'role_permissions', 'rooms', 'tables', 'sala_profiles', 'stations',
    'category_stations', 'printers', 'menus', 'menu_price_lists', 'dishes', 'dish_menus',
    'dish_prices', 'dish_components', 'modifier_groups', 'modifiers', 'dish_modifier_groups',
    'opening_hours', 'opening_hours_disabled_slots', 'special_closures', 'reservation_note_presets',
    'reservation_note_preset_variants', 'reservation_allergen_presets', 'banquet_menus', 'customers',
    'app_settings', 'tenant_domains', 'passepartout_config', 'passepartout_tavoli',
];

// Come nel bootstrap: colonne tolte dal cloud ma NOT NULL qui. Nessun
// bcrypt comincia per '!': la password sul nodo non verifica mai.
const FILL_COLUMNS: Record<string, Record<string, string>> = {
    users: { password_hash: '!nodo-di-sala' },
};

// Gli annunci del cloud che vogliono un giro subito, senza aspettare i 2
// minuti: menu e listini, sale e tavoli nuovi, impostazioni, personale.
const WAKE_EVENT = /^(dish|menu|catalogue|banquet|room|features|settings|staff|printer|station):|^table:(created|deleted)$|^takeaway:config$/;

const knownHashes = new Map<string, string>();

const cloudUrl = (): string => (process.env.SALA_NODE_CLOUD_URL || '').replace(/\/+$/, '');

const fetchChanged = async (tables: string[]): Promise<{ changed: Record<string, { hash: string; rows: any[] }> }> => {
    const body: Record<string, string | null> = {};
    for (const name of tables) body[name] = knownHashes.get(name) ?? null;
    const res = await fetch(`${cloudUrl()}/sala-node/config`, {
        method: 'POST',
        headers: { 'X-Sala-Node-Token': process.env.SALA_NODE_TOKEN || '', 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ tables: body }),
    });
    if (!res.ok) throw new Error(`/sala-node/config: HTTP ${res.status}`);
    const parsed: any = await res.json();
    return { changed: parsed?.changed && typeof parsed.changed === 'object' ? parsed.changed : {} };
};

const insertRows = async (client: any, table: string, rows: any[], onlyMissing = false): Promise<void> => {
    if (rows.length === 0) return;
    const fill = FILL_COLUMNS[table];
    const filled = fill ? rows.map(row => ({ ...row, ...fill })) : rows;
    const guard = onlyMissing ? ` WHERE NOT EXISTS (SELECT 1 FROM ${table} x WHERE x.id = r.id)` : '';
    await client.query(
        `INSERT INTO ${table} SELECT r.* FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb) r${guard}`,
        [JSON.stringify(filled)]
    );
};

const applyTable = async (client: any, tenantId: number, table: string, rows: any[]): Promise<void> => {
    if (table === 'tenants') {
        await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
        await insertRows(client, table, rows);
        return;
    }
    if (table === 'tables') {
        const ids = rows.map(r => Number(r.id)).filter(Number.isInteger);
        await client.query(`DELETE FROM tables WHERE tenant_id = $1 AND NOT (id = ANY($2::int[]))`, [tenantId, ids]);
        await insertRows(client, table, rows, true);
        return;
    }
    if (table === 'app_settings') {
        const keys = rows.map(r => String(r.key));
        await client.query(`DELETE FROM app_settings WHERE tenant_id = $1 AND key = ANY($2::text[])`, [tenantId, keys]);
        await insertRows(client, table, rows);
        return;
    }
    await client.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
    await insertRows(client, table, rows);
};

/** Un giro: chiede le tabelle, applica le cambiate. Torna i nomi applicati. */
// rls-bypass: solo nodo, giro di sistema senza sessione: il tenant è quello del cursore di replica
export const syncConfigOnce = async (opts: { includeSlow: boolean }): Promise<string[]> => runAsPlatform(async () => {
    // rls-bypass: solo nodo (superuser locale, un tenant): il cursore 'cloud' dice se il bootstrap c'è stato
    const cur = await pool.query(`SELECT tenant_id FROM replication_cursor WHERE stream = 'cloud' LIMIT 1`);
    if (cur.rows.length === 0) return []; // prima il bootstrap
    const tenantId = Number(cur.rows[0].tenant_id);
    const tables = CONFIG_TABLES.filter(name => opts.includeSlow || !SLOW_TABLES.has(name));
    const { changed } = await fetchChanged(tables);
    const names = CONFIG_TABLES.filter(name => changed[name] && Array.isArray(changed[name].rows));
    if (names.length === 0) return [];
    // rls-bypass: solo nodo (superuser locale): transazione di carico in replica-mode, come il bootstrap
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL session_replication_role = replica`);
        for (const name of names) {
            await applyTable(client, tenantId, name, changed[name].rows);
            await syncIdSequence(client, name);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { /* noop */ });
        throw err;
    } finally {
        client.release();
    }
    // Le impronte si ricordano solo a transazione riuscita: un giro fallito
    // riprova tutto al prossimo.
    for (const name of names) knownHashes.set(name, String(changed[name].hash));
    return names;
});

let wakeTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let round = 0;
let lastErrorLogged = 0;

const runRound = async (includeSlow: boolean): Promise<void> => {
    if (running) return;
    running = true;
    try {
        const applied = await syncConfigOnce({ includeSlow });
        if (applied.length > 0) console.log(`[config] allineate dal cloud: ${applied.join(', ')}`);
    } catch (err: any) {
        // A linea giù il giro fallisce e riprova: un log per serie, non la pioggia.
        if (Date.now() - lastErrorLogged > 60_000) {
            lastErrorLogged = Date.now();
            console.warn('[config] giro fallito (si riprova):', err?.message || err);
        }
    } finally {
        running = false;
    }
};

/** Sveglia dagli annunci del cloud (relay:event). */
export const kickConfigSync = (event: string): void => {
    if (!isServiceNode || !WAKE_EVENT.test(event) || wakeTimer) return;
    wakeTimer = setTimeout(() => { wakeTimer = null; void runRound(false); }, WAKE_DEBOUNCE_MS);
};

export const startSalaNodeConfigSync = (): void => {
    if (!isServiceNode) return;
    const timer = setInterval(() => {
        round += 1;
        void runRound(round % SLOW_EVERY === 0);
    }, FAST_MS);
    if (typeof timer.unref === 'function') timer.unref();
    // Il primo giro completo poco dopo l'avvio: copre quello che è cambiato
    // nel cloud mentre il nodo era spento.
    setTimeout(() => void runRound(true), 5_000).unref?.();
};
