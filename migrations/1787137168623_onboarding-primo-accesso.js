/**
 * Fase D1 (coda) — Wizard di primo accesso: quando è stato completato.
 *
 * NULL = l'OWNER non ha ancora finito il wizard (dati legali, sale/tavoli,
 * orari, menu minimo) e la SPA glielo mostra al login al posto dell'app.
 *
 * Il backfill marca completati TUTTI i tenant esistenti: sono nati prima del
 * wizard e sono già configurati (il Frantoio su tutti) — mostrarglielo ora
 * chiederebbe dati che hanno già. Solo i tenant provisionati d'ora in poi
 * nascono con NULL.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;
        UPDATE tenants SET onboarding_completed_at = CURRENT_TIMESTAMP
         WHERE onboarding_completed_at IS NULL;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants DROP COLUMN IF EXISTS onboarding_completed_at;
    `);
};
