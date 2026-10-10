/**
 * Telefono, Fase 3 (docs/telefono-piano.md): il CRM squilla come un telefono.
 *
 * phone_devices: i browser in cui qualcuno ha acceso «Questo dispositivo
 * squilla». La chiave del dispositivo la genera il browser e la tiene in
 * localStorage; l'identità Twilio del client è t<tenant>d<id>. Una riga per
 * dispositivo: spegnere l'interruttore cancella la riga. last_seen_at si
 * aggiorna a ogni token: i dispositivi spariti da giorni non squillano.
 *
 * phone_calls.direction accetta già 'outbound' («Richiama» dal CRM).
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
        CREATE TABLE IF NOT EXISTS phone_devices (
            id            SERIAL PRIMARY KEY,
            tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
            device_key    VARCHAR(64) NOT NULL UNIQUE,
            user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
            label         VARCHAR(80),
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_phone_devices_tenant ON phone_devices (tenant_id, last_seen_at DESC);`);
    pgm.sql(`ALTER TABLE phone_devices ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE phone_devices FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON phone_devices;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON phone_devices
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS phone_devices;`);
};
