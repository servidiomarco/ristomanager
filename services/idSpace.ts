// Spazi di id separati fra cloud e nodo di sala (fase B1 del piano «sala,
// comande e conto sul nodo»).
//
// Prima: il bootstrap e la replica portavano ogni sequenza a MAX(id) su
// tutti e due i lati. Finché scrive uno solo va bene; ma con la linea giù
// il nodo inserisce comande (e, dalla fase B3, conti, pagamenti, scontrini)
// mentre il cloud ne inserisce altre (pagamenti online, fatture, prenotazioni
// di Sofia): stessi id, e al rientro una riga calpestava l'altra.
//
// Adesso: sul NODO ogni sequenza sta da NODE_ID_BASE in su, nel CLOUD sotto.
// Una riga nata sul nodo ha un id che il cloud non genererà mai, e
// viceversa. Le colonne id sono int4: da 1 a 1 miliardo il cloud, da 1
// miliardo a 2,1 miliardi il nodo — larghezza per decenni a tutti e due.

import { isServiceNode } from './topology.js';

export const NODE_ID_BASE = 1_000_000_000;

type Queryable = { query: (sql: string, params?: any[]) => Promise<any> };

// Le tabelle di `public` che hanno una colonna id, lette dal catalogo. MAI
// pg_get_serial_sequence nella stessa query del filtro: il pianificatore
// può valutarla prima di filtrare, anche sulle tabelle di sistema. Su
// PostgreSQL 18 (quello del PC del Frantoio) la vecchia query su
// information_schema.columns moriva con «la colonna "id" della relazione
// "pg_statistic" non esiste», e le sequenze del nodo non sono mai entrate
// nel suo spazio. I test girano su versioni precedenti, che non la
// valutavano: si è visto solo sul PC, il 06/10.
const ID_TABLES_SQL = `
    SELECT c.relname AS t
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
       AND a.attname = 'id' AND NOT a.attisdropped`;

const qualified = (table: string): string => `public."${table.replace(/"/g, '""')}"`;

/** Porta la sequenza della colonna id di `table` oltre gli id del PROPRIO
 *  spazio, senza mai entrare in quello dell'altro lato. No-op per le
 *  tabelle senza colonna id (opening_hours ha una chiave composta). */
export const syncIdSequence = async (client: Queryable, table: string): Promise<void> => {
    // Prima il catalogo, poi la sequenza: in due query, per il motivo sopra.
    const has = await client.query(`${ID_TABLES_SQL} AND c.relname = $1`, [table]);
    if (has.rows.length === 0) return;
    const seq = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS s`, [qualified(table)]);
    const name = seq.rows[0]?.s;
    if (!name) return;
    if (isServiceNode) {
        // Il nodo parte da NODE_ID_BASE e segue solo i propri id.
        await client.query(
            `SELECT setval($1, GREATEST(
                $2::bigint - 1,
                (SELECT last_value FROM ${name}),
                (SELECT COALESCE(MAX(id), 0) FROM ${table} WHERE id >= $2)
            ))`,
            [name, NODE_ID_BASE]
        );
    } else {
        // Il cloud ignora gli id del nodo: senza il filtro, la prima riga
        // arrivata dal nodo avrebbe portato la sequenza del cloud nello
        // spazio del nodo.
        await client.query(
            `SELECT setval($1, GREATEST(
                (SELECT CASE WHEN last_value < $2 THEN last_value ELSE 1 END FROM ${name}),
                (SELECT COALESCE(MAX(id), 0) FROM ${table} WHERE id < $2),
                1
            ))`,
            [name, NODE_ID_BASE]
        );
    }
};

/** Sul nodo, a ogni avvio: tutte le sequenze nel suo spazio. Serve ai nodi
 *  installati prima di questa fase, che hanno sequenze allineate al cloud. */
export const ensureNodeIdSpace = async (client: Queryable): Promise<number> => {
    if (!isServiceNode) return 0;
    const tables = await client.query(ID_TABLES_SQL);
    let moved = 0;
    for (const row of tables.rows) {
        const seq = await client.query(`SELECT pg_get_serial_sequence($1, 'id') AS s`, [qualified(row.t)]);
        if (!seq.rows[0]?.s) continue;
        await syncIdSequence(client, row.t);
        moved++;
    }
    return moved;
};
