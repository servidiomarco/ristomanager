/**
 * Telefono, Fase 2 (docs/telefono-piano.md): Sympotia davanti al numero.
 *
 * Ogni chiamata che Twilio porta al webhook /voice/inbound lascia una riga
 * in phone_calls, prima ancora che risponda qualcuno: anche quelle che Sofia
 * non prende (servizio giù, crediti finiti) e, dalla Fase 3, quelle prese
 * dallo staff. voice_calls resta la riga della conversazione con Sofia e si
 * collega qui col CallSid Twilio, che il post-call porta in
 * metadata.phone_call.call_sid.
 *
 * - status: ringing (appena arrivata) → sofia (agganciata a Sofia) o
 *   missed (nessuno ha risposto). answered è dello staff, dalla Fase 3.
 * - routing: la regola che ha deciso il giro; in Fase 2 sempre solo_sofia.
 * - missed_reason: perché è persa (sofia_non_disponibile, sofia_muta, …).
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
        CREATE TABLE IF NOT EXISTS phone_calls (
            id               SERIAL PRIMARY KEY,
            tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
            call_sid         VARCHAR(64) NOT NULL UNIQUE,
            direction        VARCHAR(10) NOT NULL DEFAULT 'inbound',
            from_number      VARCHAR(40),
            to_number        VARCHAR(40),
            customer_id      INTEGER REFERENCES customers(id) ON DELETE SET NULL,
            routing          VARCHAR(20) NOT NULL,
            status           VARCHAR(20) NOT NULL DEFAULT 'ringing'
                             CHECK (status IN ('ringing', 'sofia', 'answered', 'missed')),
            missed_reason    VARCHAR(40),
            conversation_id  VARCHAR(100),
            voice_call_id    INTEGER REFERENCES voice_calls(id) ON DELETE SET NULL,
            started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            answered_at      TIMESTAMPTZ,
            ended_at         TIMESTAMPTZ,
            duration_seconds INTEGER
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_phone_calls_tenant_started ON phone_calls (tenant_id, started_at DESC);`);

    pgm.sql(`ALTER TABLE phone_calls ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE phone_calls FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON phone_calls;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON phone_calls
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS phone_calls;`);
};
