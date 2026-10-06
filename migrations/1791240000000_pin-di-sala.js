/**
 * PIN di sala (fase A2 del piano «sala, comande e conto sul nodo»).
 *
 * Con la linea caduta il login con email e password non si può fare: lo
 * verifica il cloud. Il nodo di sala accetta invece un PIN di 4–6 cifre,
 * come il codice operatore dei palmari Passepartout, e conia una sessione
 * valida solo sul nodo e solo per le funzioni di servizio.
 *
 * - users.service_pin_hash: bcrypt del PIN. Scende al nodo con la
 *   configurazione (le password no): il PIN è una credenziale debole di
 *   proposito, buona solo dentro il locale.
 * - users.service_pin_updated_at: quando è stato impostato l'ultima volta.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS service_pin_hash TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS service_pin_updated_at TIMESTAMPTZ;
    `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP COLUMN IF EXISTS service_pin_updated_at;
        ALTER TABLE users DROP COLUMN IF EXISTS service_pin_hash;
    `);
};
