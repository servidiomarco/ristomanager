/**
 * Telefono, Fase 3 ridotta (docs/telefono-piano.md): prima del giro a Sofia
 * squilla il cellulare del locale. phone_calls.answered_by dice chi ha
 * risposto quando non è Sofia: «cellulare:+39…» oggi, un utente o un
 * dispositivo del CRM quando arriverà il softphone.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE phone_calls ADD COLUMN IF NOT EXISTS answered_by VARCHAR(60);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE phone_calls DROP COLUMN IF EXISTS answered_by;`);
};
