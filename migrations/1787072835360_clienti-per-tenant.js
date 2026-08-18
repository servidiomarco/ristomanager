/**
 * Fase B3.4 — dominio clienti & messaggistica.
 *
 * Il vincolo più delicato del censimento: il telefono cliente era unico
 * GLOBALMENTE (indice su espressione: sole cifre, parziale sui non-vuoti).
 * Due ristoranti non potevano avere lo stesso cliente in rubrica — con la
 * dedupe di createSchema che azzerava il telefono del "perdente". Ora
 * l'unicità è per tenant, stessa espressione e stessa condizione.
 *
 * voice_calls.conversation_id resta unico globale: è l'id ElevenLabs,
 * univoco per costruzione nel loro workspace — la scopatura è nelle query.
 * outbound_messages non ha vincoli unici.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_customers_phone_digits_unique;`);
    pgm.sql(`
        CREATE UNIQUE INDEX idx_customers_phone_digits_unique
        ON customers (tenant_id, (regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')))
        WHERE phone IS NOT NULL
          AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> '';
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_customers_phone_digits_unique;`);
    pgm.sql(`
        CREATE UNIQUE INDEX idx_customers_phone_digits_unique
        ON customers ((regexp_replace(COALESCE(phone, ''), '\\D', '', 'g')))
        WHERE phone IS NOT NULL
          AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') <> '';
    `);
};
