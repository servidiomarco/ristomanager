/**
 * Profilo utente self-service + recupero password: tre colonne su users.
 *
 *   - phone                  → telefono personale dell'utente, mostrato e
 *                              modificato solo dal profilo self-service.
 *                              VARCHAR(30): basta per qualunque formato
 *                              internazionale con prefisso e spazi.
 *   - reset_token_hash       → SHA-256 (hex, 64 char) del token di recupero
 *                              password. In chiaro il token viaggia SOLO
 *                              nell'email: un dump del DB non permette di
 *                              resettare la password di nessuno.
 *   - reset_token_expires_at → scadenza del token (now()+60min alla
 *                              generazione). Il reset richiede hash valido
 *                              E non scaduto; entrambe le colonne tornano
 *                              NULL al primo uso (single-use).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_hash VARCHAR(64);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMPTZ;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP COLUMN IF EXISTS reset_token_expires_at;
        ALTER TABLE users DROP COLUMN IF EXISTS reset_token_hash;
        ALTER TABLE users DROP COLUMN IF EXISTS phone;
    `);
};
