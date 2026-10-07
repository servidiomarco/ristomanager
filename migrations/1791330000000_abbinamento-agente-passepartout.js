/**
 * Abbinamento del PC della cassa con un codice (piano «Passepartout plug and
 * play», punto 1).
 *
 * Il token dell'agente (tenants.passepartout_agent_token) non si vedeva da
 * nessuna parte: per installare l'agente presso un ristorante lo si leggeva
 * dal database. Ora dalla sezione Passepartout si genera un codice breve,
 * valido 15 minuti e una volta sola; l'agente sul PC lo scambia col token
 * (POST /pp-agent/abbina). Lo scambio RUOTA il token: l'agente di prima
 * perde l'accesso, così due agenti dello stesso ristorante non si
 * scavalcano più.
 *
 * - passepartout_abbinamenti: i codici, solo come sha256; usato_at, PC e
 *   versione dell'agente che l'ha usato.
 * - passepartout_config.token_storico_spento: il token in env
 *   (PASSEPARTOUT_AGENT_TOKEN) vale per il ristorante 1 finché non lo si
 *   abbina col codice o lo si scollega; da lì solo il token del database.
 * - passepartout_config.abbinato_at / abbinato_hostname: quale PC è stato
 *   abbinato e quando, anche ad agente spento.
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

const enableRls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS passepartout_abbinamenti (
            id               SERIAL PRIMARY KEY,
            tenant_id        BIGINT NOT NULL,
            codice_hash      CHAR(64) NOT NULL UNIQUE,
            scade_at         TIMESTAMPTZ NOT NULL,
            usato_at         TIMESTAMPTZ,
            hostname         VARCHAR(255),
            versione_agente  VARCHAR(40),
            creato_da        INTEGER,
            creato_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS passepartout_abbinamenti_tenant ON passepartout_abbinamenti (tenant_id, creato_at DESC);
    `);
    enableRls(pgm, 'passepartout_abbinamenti');

    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS token_storico_spento BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS abbinato_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS abbinato_hostname VARCHAR(255);
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP COLUMN IF EXISTS token_storico_spento,
            DROP COLUMN IF EXISTS abbinato_at,
            DROP COLUMN IF EXISTS abbinato_hostname;
    `);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_abbinamenti;`);
};
