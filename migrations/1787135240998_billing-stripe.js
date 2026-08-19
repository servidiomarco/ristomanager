/**
 * Fase D3 — Billing Stripe: tre colonne su tenants, nessun dato carta nel
 * nostro DB (vive tutto in Stripe; qui restano solo i riferimenti).
 *
 *   - stripe_customer_id     → chiave di risoluzione del webhook: da un
 *                              evento subscription si risale al tenant.
 *                              UNIQUE: due tenant sullo stesso customer
 *                              Stripe sarebbero un pasticcio irrecuperabile.
 *   - stripe_subscription_id → la subscription corrente (base + add-on come
 *                              subscription items).
 *   - billing_status         → lo status Stripe della subscription
 *                              (active, trialing, past_due, canceled, …),
 *                              persistito com'è. NULLABLE ed è il punto:
 *                              NULL = tenant non a pagamento (grandfathered)
 *                              — il tenant 1 resta senza billing, e la sync
 *                              feature del webhook non lo tocca mai.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(64) UNIQUE;
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(64);
        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS billing_status VARCHAR(30);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants DROP COLUMN IF EXISTS billing_status;
        ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_subscription_id;
        ALTER TABLE tenants DROP COLUMN IF EXISTS stripe_customer_id;
    `);
};
