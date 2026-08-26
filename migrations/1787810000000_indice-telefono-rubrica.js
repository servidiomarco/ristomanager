/**
 * Indice a espressione sul telefono normalizzato della rubrica.
 *
 * L'aggancio prenotazione→scheda cliente confronta i telefoni con
 * regexp_replace(phone, '\D', '', 'g') su entrambi i lati (GET /reservations,
 * PUT/POST prenotazione, broadcast socket). Senza indice ogni telefono
 * distinto costa una scansione completa di customers: a 4.5k prenotazioni ×
 * 3.1k clienti la GET di boot era arrivata a ~4.1s di sola CPU regex
 * (misurata in produzione il 26/08/2026). Con l'indice la lateral diventa
 * una lookup e la query torna a decine di millisecondi.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_customers_phone_digits
             ON customers (tenant_id, regexp_replace(phone, '\\D', '', 'g'));`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_customers_phone_digits;`);
};
