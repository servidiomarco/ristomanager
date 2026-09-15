/**
 * Conto asporto: table_bills può ancorarsi a un ordine d'asporto.
 *
 * Il CHECK table_bills_anchor_present esiste per impedire il conto orfano
 * (un ON DELETE SET NULL su table_id lo lascerebbe senza ancoraggio). Per
 * l'asporto l'ancoraggio è il nuovo takeaway_order_id: il CHECK si allarga
 * a tre alternative invece di sparire.
 *
 * Il constraint si ricrea con LO STESSO NOME e lo stesso NOT VALID
 * dell'originale: il DO $$ di createSchema (db.ts) fa la guardia per nome
 * con IF NOT EXISTS — un nome diverso farebbe rinascere il CHECK vecchio
 * accanto al nuovo al boot successivo (stessa trappola annotata in db.ts).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills ADD COLUMN IF NOT EXISTS takeaway_order_id INTEGER REFERENCES takeaway_orders(id) ON DELETE SET NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_table_bills_takeaway
             ON table_bills (tenant_id, takeaway_order_id)
             WHERE takeaway_order_id IS NOT NULL;`);
    pgm.sql(`ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_anchor_present;`);
    pgm.sql(`ALTER TABLE table_bills ADD CONSTRAINT table_bills_anchor_present
             CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL OR takeaway_order_id IS NOT NULL) NOT VALID;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_anchor_present;`);
    pgm.sql(`ALTER TABLE table_bills ADD CONSTRAINT table_bills_anchor_present
             CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL) NOT VALID;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_table_bills_takeaway;`);
    pgm.sql(`ALTER TABLE table_bills DROP COLUMN IF EXISTS takeaway_order_id;`);
};
