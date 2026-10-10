/**
 * Telefono, Fase 3 (docs/telefono-piano.md): registro delle chiamate.
 *
 * phone_calls.note: la nota di chi ha risposto, a fine chiamata. Compare nel
 * registro e nella card «chi chiama» la volta dopo che lo stesso numero
 * richiama.
 *
 * phone_calls.reservation_id: la prenotazione fatta durante la chiamata
 * (dalla card, o creata a mano a chiamata appena finita per lo stesso
 * numero). Per quelle di Sofia basta voice_calls.reservation_id. Serve alla
 * valutazione della Fase 7: quante prenotazioni del personale passano dal
 * numero dedicato.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS note TEXT;`);
    pgm.sql(`ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS note_updated_at TIMESTAMPTZ;`);
    pgm.sql(`ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE phone_calls DROP COLUMN IF EXISTS reservation_id;`);
    pgm.sql(`ALTER TABLE phone_calls DROP COLUMN IF EXISTS note_updated_at;`);
    pgm.sql(`ALTER TABLE phone_calls DROP COLUMN IF EXISTS note;`);
};
