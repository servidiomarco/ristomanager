/**
 * Fase B3.6 — domini comande, conti & pagamenti.
 *
 * Vincoli riscritti (stesso PR delle query, regola B1):
 * - integration_settings: PK (provider) → (tenant_id, provider) — era
 *   l'ultima tabella di configurazione singleton: un solo Revolut, un
 *   solo SumUp, una sola casella SMTP/IMAP per l'intero database.
 * - orders / order_items: idempotency_key unico → (tenant_id, key).
 *   La chiave la genera il client: due ristoranti non devono potersi
 *   pestare i replay a vicenda.
 *
 * Restano GLOBALI di proposito (il token/id È il meccanismo con cui i
 * flussi senza JWT risalgono alla riga, e quindi al tenant):
 * - table_bills.share_token (il QR /pay/:token del cliente)
 * - payment_requests.provider_order_id (id del gateway nei webhook)
 * - push_subscriptions.endpoint (unico per natura, browser-side)
 * Gli indici parziali "una comanda aperta / un conto attivo per tavolo
 * e servizio" sono FK-scopati e non si toccano.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const dropUniques = (table) => `
    DO $$
    DECLARE c RECORD;
    BEGIN
        FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = '${table}'::regclass AND contype = 'u'
        LOOP
            EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END LOOP;
    END $$;
`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE integration_settings DROP CONSTRAINT integration_settings_pkey;`);
    pgm.sql(`ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_pkey PRIMARY KEY (tenant_id, provider);`);

    pgm.sql(dropUniques('orders'));
    pgm.sql(`ALTER TABLE orders ADD CONSTRAINT orders_tenant_idempotency_key_key UNIQUE (tenant_id, idempotency_key);`);

    pgm.sql(dropUniques('order_items'));
    pgm.sql(`ALTER TABLE order_items ADD CONSTRAINT order_items_tenant_idempotency_key_key UNIQUE (tenant_id, idempotency_key);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE integration_settings DROP CONSTRAINT integration_settings_pkey;`);
    pgm.sql(`ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_pkey PRIMARY KEY (provider);`);
    pgm.sql(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_tenant_idempotency_key_key;`);
    pgm.sql(`ALTER TABLE orders ADD CONSTRAINT orders_idempotency_key_key UNIQUE (idempotency_key);`);
    pgm.sql(`ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_tenant_idempotency_key_key;`);
    pgm.sql(`ALTER TABLE order_items ADD CONSTRAINT order_items_idempotency_key_key UNIQUE (idempotency_key);`);
};
