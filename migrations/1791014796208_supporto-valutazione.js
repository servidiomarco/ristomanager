/**
 * Supporto, fase 4 — la valutazione di una richiesta risolta.
 *
 * Chi ha aperto la richiesta dice com'è andata: pollice su (1) o giù (-1),
 * con un commento facoltativo. Alimenta le metriche della tab Supporto del
 * pannello (quota di valutazioni positive). Sulla stessa riga del ticket e
 * non in una tabella a parte: una richiesta ha una valutazione, l'ultima.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating IN (-1, 1));`);
    pgm.sql(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS rating_comment VARCHAR(500);`);
    pgm.sql(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS rated_at TIMESTAMPTZ;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS rated_at;`);
    pgm.sql(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS rating_comment;`);
    pgm.sql(`ALTER TABLE support_tickets DROP COLUMN IF EXISTS rating;`);
};
