/**
 * WhatsApp, Fase 10: il cliente avvisato quando l'ordine d'asporto è pronto.
 *
 * ready_notified_at segna l'avviso partito: un ordine che torna indietro e
 * ripassa da «Pronto» (o il «pronto» del monitor e quello del banco insieme)
 * non manda un secondo messaggio.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE takeaway_orders ADD COLUMN IF NOT EXISTS ready_notified_at TIMESTAMPTZ;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE takeaway_orders DROP COLUMN IF EXISTS ready_notified_at;`);
};
