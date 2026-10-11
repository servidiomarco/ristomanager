/**
 * WhatsApp, Fase 11: le campagne.
 *
 * consent_events è il registro dei consensi al marketing: chi, sì o no, da
 * dove (modulo /prenota, /ordina, staff, «STOP» su WhatsApp), quando. Il
 * consenso valido resta su customers.consent_marketing; il registro è la
 * prova di come ci si è arrivati, che il GDPR chiede di poter mostrare.
 * customers.marketing_opt_out_at segna chi ha detto «basta»: nessuna
 * campagna lo raggiunge più, anche se un modulo dopo spuntasse di nuovo.
 * Si toglie solo con un nuovo consenso esplicito.
 *
 * campaigns è la campagna (testo, segmento, stima, stato); campaign_recipients
 * i destinatari, fissati alla conferma: lo sweep li prende in carico prima
 * di mandare (come le richieste di recensione), così un riavvio a metà non
 * manda due volte. Il consenso si ricontrolla comunque all'invio.
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

const rls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`CREATE POLICY tenant_isolation ON ${table} USING (${RLS_POLICY}) WITH CHECK (${RLS_POLICY});`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS marketing_opt_out_at TIMESTAMPTZ;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS consent_events (
            id           BIGSERIAL PRIMARY KEY,
            tenant_id    BIGINT NOT NULL REFERENCES tenants(id),
            customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
            phone_digits VARCHAR(20),
            kind         VARCHAR(20) NOT NULL DEFAULT 'marketing',
            value        BOOLEAN NOT NULL,
            source       VARCHAR(30) NOT NULL,
            user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS consent_events_customer ON consent_events (tenant_id, customer_id, created_at DESC);`);
    rls(pgm, 'consent_events');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS campaigns (
            id                    BIGSERIAL PRIMARY KEY,
            tenant_id             BIGINT NOT NULL REFERENCES tenants(id),
            name                  VARCHAR(120) NOT NULL,
            message               TEXT NOT NULL,
            segment               JSONB NOT NULL DEFAULT '{}'::jsonb,
            status                VARCHAR(12) NOT NULL DEFAULT 'draft'
                                  CHECK (status IN ('draft', 'sending', 'paused', 'done', 'cancelled')),
            pause_reason          TEXT,
            recipients_count      INTEGER NOT NULL DEFAULT 0,
            estimated_cost_cents  INTEGER NOT NULL DEFAULT 0,
            created_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            confirmed_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            confirmed_at          TIMESTAMPTZ,
            finished_at           TIMESTAMPTZ
        );
    `);
    rls(pgm, 'campaigns');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS campaign_recipients (
            id                  BIGSERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL REFERENCES tenants(id),
            campaign_id         BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
            customer_id         INTEGER REFERENCES customers(id) ON DELETE SET NULL,
            name                VARCHAR(120),
            phone               VARCHAR(40) NOT NULL,
            phone_digits        VARCHAR(20) NOT NULL,
            status              VARCHAR(10) NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
            skip_reason         TEXT,
            outbound_message_id INTEGER,
            claimed_at          TIMESTAMPTZ,
            sent_at             TIMESTAMPTZ,
            error               TEXT,
            UNIQUE (campaign_id, phone_digits)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS campaign_recipients_pending ON campaign_recipients (campaign_id) WHERE status = 'pending';`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS campaign_recipients_sent ON campaign_recipients (tenant_id, phone_digits, sent_at DESC) WHERE status = 'sent';`);
    rls(pgm, 'campaign_recipients');

    // campaigns:manage, nuovo: chi crea e manda le campagne. Al titolare e
    // al general manager; agli altri lo dà il titolare dalla matrice in
    // Utenti. Le migration girano con app.rls_bypass acceso.
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'campaigns:manage'
          FROM tenants t
         CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER')) AS r(role)
            ON CONFLICT DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'campaigns:manage';`);
    pgm.sql(`DROP TABLE IF EXISTS campaign_recipients;`);
    pgm.sql(`DROP TABLE IF EXISTS campaigns;`);
    pgm.sql(`DROP TABLE IF EXISTS consent_events;`);
    pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS marketing_opt_out_at;`);
};
