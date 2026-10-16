/**
 * Piano ferie: i giorni di riposo nel conteggio, a scelta del ristorante.
 *
 * Finora il riposo settimanale (o il settimo giorno di chi non ha un riposo
 * fisso) non si scalava mai dal monte ferie. Alcuni ristoranti scalano
 * invece ogni giorno di calendario in cui la persona è assente, riposi
 * compresi. false = come prima: chi non tocca le Regole non vede cambiare
 * nessun saldo.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE staff_leave_settings ADD COLUMN IF NOT EXISTS count_rest_days BOOLEAN NOT NULL DEFAULT false;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE staff_leave_settings DROP COLUMN IF EXISTS count_rest_days;`);
};
