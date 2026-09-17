/**
 * Numero d'ordine del giorno per l'asporto.
 *
 * Al ritiro l'ospite oggi ha solo nome e telefono: con due «Marco» nello
 * stesso slot il banco confronta i telefoni a mano. Il numero corto del
 * giorno («#12») è il linguaggio nativo dell'asporto: si dice al telefono
 * (Sofia), si scrive sul cartone, si legge sulla card della board.
 *
 * - `daily_number`: progressivo per (tenant, pickup_date), assegnato alla
 *   creazione e PERSISTITO — mai derivato a video, così un annullamento non
 *   rinumera gli ordini già comunicati ai clienti. Il numero segue la data
 *   di ritiro: spostare un ordine a un altro giorno gli assegna un numero
 *   nuovo di quel giorno.
 * - Nullable: gli ordini storici restano senza numero (assegnarne uno oggi
 *   racconterebbe un numero mai comunicato a nessuno); il backfill numera
 *   solo i giorni da oggi in poi, dove il numero verrà davvero usato.
 * - Indice unico parziale: difesa contro la doppia assegnazione — la
 *   serializzazione vera è l'advisory lock transazionale in server.ts.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE takeaway_orders ADD COLUMN IF NOT EXISTS daily_number INTEGER;`);
    pgm.sql(`
        WITH numbered AS (
            SELECT id, ROW_NUMBER() OVER (
                       PARTITION BY tenant_id, pickup_date ORDER BY id
                   ) AS n
              FROM takeaway_orders
             WHERE pickup_date >= CURRENT_DATE
        )
        UPDATE takeaway_orders t
           SET daily_number = numbered.n
          FROM numbered
         WHERE t.id = numbered.id AND t.daily_number IS NULL;
    `);
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_takeaway_orders_daily_number
            ON takeaway_orders (tenant_id, pickup_date, daily_number)
            WHERE daily_number IS NOT NULL;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_takeaway_orders_daily_number;`);
    pgm.sql(`ALTER TABLE takeaway_orders DROP COLUMN IF EXISTS daily_number;`);
};
