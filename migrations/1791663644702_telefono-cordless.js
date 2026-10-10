/**
 * Telefono, Fase 4 (docs/telefono-piano.md): cordless e telefoni SIP.
 *
 * phone_sip_lines: le basi DECT IP (o le app SIP) che squillano insieme al
 * CRM. L'utente SIP è t<tenant>c<id> sul dominio SIP Twilio di Sympotia; la
 * password sta solo nella Credential List di Twilio (credential_sid), qui
 * no. Togliere la linea cancella la credenziale e la riga.
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
        CREATE TABLE IF NOT EXISTS phone_sip_lines (
            id              SERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL REFERENCES tenants(id),
            label           VARCHAR(80) NOT NULL,
            username        VARCHAR(64) UNIQUE,
            credential_sid  VARCHAR(64),
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_phone_sip_lines_tenant ON phone_sip_lines (tenant_id);`);
    pgm.sql(`ALTER TABLE phone_sip_lines ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE phone_sip_lines FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON phone_sip_lines;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON phone_sip_lines
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS phone_sip_lines;`);
};
