/**
 * Promemoria automatico all'ospite prima della prenotazione.
 *
 * - `auto_reminder_*` su reservations: il registro dell'invio automatico,
 *   specchio della famiglia `review_request_*`. `status` NULL = mai valutata
 *   dallo sweep; 'sending' = presa in carico, mai più ritentata (vedi
 *   services/bookingReminders.ts); gli altri valori sono esiti definitivi
 *   (sent | failed | skipped_*).
 * - `auto_reminder_for` è l'orario della prenotazione per cui il promemoria
 *   è stato valutato: se la prenotazione si sposta di giorno, lo sweep la
 *   rivaluta per la data nuova invece di fidarsi di un esito vecchio.
 * - Il promemoria manuale resta su `reminder_sent`, che l'invio automatico
 *   riusa: la campanella sulla card dice «promemoria partito» qualunque sia
 *   la strada.
 * - L'indice su reservation_time serve allo sweep, che guarda le prossime
 *   72 ore di tutti i ristoranti ogni 15 minuti.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_status VARCHAR(30);`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_channel VARCHAR(20);`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_for TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_sent_at TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_failed_at TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS auto_reminder_error TEXT;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reservations_time ON reservations (reservation_time);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_reservations_time;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_error;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_failed_at;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_sent_at;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_for;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_channel;`);
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS auto_reminder_status;`);
};
