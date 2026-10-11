/**
 * WhatsApp, Fase 12a: il numero WhatsApp del locale sull'API Cloud di Meta.
 *
 * whatsapp_senders è il mittente di un ristorante che non usa le credenziali
 * Twilio in env (il Frantoio): il numero, il suo id presso Meta, l'account
 * WhatsApp Business, e il token d'accesso cifrato (utils/secrets.ts, chiave
 * in INTEGRATION_SECRETS_KEY). Uno per locale; phone_number_id è unico in
 * tutta la piattaforma, perché è da lì che il webhook di Meta ricava il
 * ristorante. Oggi si collega a mano (Impostazioni › WhatsApp, anche col
 * numero di prova di Meta per le demo); dalla Fase 12c lo riempirà
 * l'Embedded Signup.
 *
 * Su outbound_messages la categoria di prezzo e se il messaggio si paga,
 * come arrivano negli stati di consegna di Meta: è il costo vero, al posto
 * della stima.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const RLS_POLICY = `
    (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
    OR (
        (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
        AND (
            (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
            OR (current_setting('app.rls_bypass', true) = 'on')
        )
    )
`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS whatsapp_senders (
            id                   BIGSERIAL PRIMARY KEY,
            tenant_id            BIGINT NOT NULL UNIQUE REFERENCES tenants(id),
            provider             VARCHAR(10) NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta')),
            phone_e164           VARCHAR(20) NOT NULL,
            phone_number_id      VARCHAR(40) NOT NULL UNIQUE,
            waba_id              VARCHAR(40) NOT NULL,
            display_name         VARCHAR(120),
            quality_rating       VARCHAR(20),
            messaging_limit      VARCHAR(40),
            access_token_enc     TEXT NOT NULL,
            connected_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    pgm.sql(`ALTER TABLE whatsapp_senders ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE whatsapp_senders FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON whatsapp_senders;`);
    pgm.sql(`CREATE POLICY tenant_isolation ON whatsapp_senders USING (${RLS_POLICY}) WITH CHECK (${RLS_POLICY});`);

    pgm.sql(`
        ALTER TABLE outbound_messages
            ADD COLUMN IF NOT EXISTS pricing_category VARCHAR(20),
            ADD COLUMN IF NOT EXISTS billable         BOOLEAN;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE outbound_messages DROP COLUMN IF EXISTS billable, DROP COLUMN IF EXISTS pricing_category;`);
    pgm.sql(`DROP TABLE IF EXISTS whatsapp_senders;`);
};
