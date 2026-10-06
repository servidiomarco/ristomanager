/**
 * Incassi idempotenti (fase B2 del piano «sala, comande e conto sul nodo»).
 *
 * table_bill_payments.command_id: la Idempotency-Key del client che ha
 * registrato l'incasso. Un tocco ripetuto (rete che balla, coda offline che
 * rigioca, nodo che cade e il client ritenta sul cloud) trova la riga già
 * scritta e non incassa due volte. L'indice unico è la cintura: la route
 * controlla prima, sotto il lucchetto del conto.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE table_bill_payments ADD COLUMN IF NOT EXISTS command_id TEXT;
        CREATE UNIQUE INDEX IF NOT EXISTS table_bill_payments_command_id_uniq
            ON table_bill_payments (tenant_id, command_id) WHERE command_id IS NOT NULL;
    `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS table_bill_payments_command_id_uniq;
        ALTER TABLE table_bill_payments DROP COLUMN IF EXISTS command_id;
    `);
};
