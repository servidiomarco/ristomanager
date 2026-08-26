/**
 * Indici sulle ultime 10 cifre del telefono (rubrica e prenotazioni).
 *
 * Inbox messaggi e lista Chiamate agganciano nome/scheda per "ultime 10
 * cifre" — right(regexp_replace(phone, '\D', '', 'g'), 10) — perché i numeri
 * sono salvati in formati misti (E.164, nazionale, cifre nude). L'indice
 * idx_customers_phone_digits (26/08) copre l'espressione INTERA e qui non
 * serve a nulla: misurato in produzione il 26/08, /messages/conversations
 * 3.5s (scan di reservations × 2402 conversazioni) e /voice-calls 2.3s
 * (scan di customers × 1146 telefoni distinti). Con questi due indici le
 * lateral diventano lookup; beneficia anche la ricerca testuale di
 * /voice-calls (EXISTS sulla rubrica con la stessa espressione).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_customers_phone_last10
             ON customers (tenant_id, right(regexp_replace(phone, '\\D', '', 'g'), 10));`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reservations_phone_last10
             ON reservations (tenant_id, right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10));`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_customers_phone_last10;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_reservations_phone_last10;`);
};
