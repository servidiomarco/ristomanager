/**
 * «La tua prenotazione»: la pagina dove l'ospite conferma o annulla da solo,
 * dal link nella conferma e nel promemoria (services/guestManage.ts).
 *
 * - `guest_token` è la capability del link: coniato alla prima volta che un
 *   messaggio lo porta, poi stabile, così conferma e promemoria della stessa
 *   prenotazione aprono la stessa pagina. Unico solo dove c'è.
 * - `guest_confirmed_at`: l'ospite ha detto «ci saremo». È diverso da
 *   `confirmation_*`, che registra solo la consegna del messaggio.
 * - `guest_cancelled_at`: l'annullamento è partito dall'ospite e non dallo
 *   staff — la card e l'avviso lo dicono, e la caparra segue le sue regole.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_token VARCHAR(64);`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_confirmed_at TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS guest_cancelled_at TIMESTAMPTZ;`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_guest_token ON reservations (guest_token) WHERE guest_token IS NOT NULL;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_reservations_guest_token;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS guest_cancelled_at;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS guest_confirmed_at;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS guest_token;`);
};
