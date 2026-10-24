/**
 * CRM della piattaforma — i clienti di Sympotia, dal primo contatto al
 * rinnovo (pannello Piattaforma, docs/pannello-crm.md).
 *
 * - crm_accounts: un'azienda, lead o cliente. customer_tenant_id la lega al
 *   ristorante su Sympotia quando esiste (UNIQUE: un ristorante, una
 *   scheda); i tenant senza scheda la ricevono da soli alla prima lettura
 *   del pannello. internal marca demo e locali di prova: restano nel
 *   pannello ma fuori dai numeri (MRR, imbuto, salute).
 * - crm_contacts: i referenti dell'azienda (titolare, socio, chef…).
 * - crm_activities: la cronologia scritta a mano (note, chiamate, email,
 *   incontri, demo) più i cambi di fase registrati dal server ('sistema').
 *   Supporto, avvisi e creazione del ristorante NON si copiano qui: si
 *   leggono dalle loro tabelle quando si apre la scheda.
 * - crm_tasks: i promemoria, con o senza azienda. Solo data (Europe/Rome),
 *   come le scadenze che contano qui: «richiamare giovedì».
 * - crm_deals: le opportunità (contratto nuovo, add-on, rinnovo) con il
 *   valore in canone mensile; la pipeline del pannello le mette in colonne.
 *
 * tenant_id è il ristorante di casa di chi scrive, come platform_incidents,
 * dev_board_cards e roadmap: le tabelle restano dentro gli invarianti RLS e
 * si leggono di piattaforma (runAsPlatform) dalle sole rotte /admin/crm. I
 * dati sono della piattaforma, non del ristorante di casa: nessuna rotta
 * con contesto di tenant li legge.
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
        CREATE TABLE IF NOT EXISTS crm_accounts (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            customer_tenant_id BIGINT UNIQUE REFERENCES tenants(id) ON DELETE SET NULL,
            name               VARCHAR(160) NOT NULL,
            stage              VARCHAR(16) NOT NULL DEFAULT 'lead'
                               CHECK (stage IN ('lead', 'contattato', 'demo', 'proposta', 'prova', 'cliente', 'perso', 'disdetto')),
            internal           BOOLEAN NOT NULL DEFAULT FALSE,
            business_type      VARCHAR(40),
            source             VARCHAR(30),
            current_software   VARCHAR(80),
            city               VARCHAR(80),
            address            VARCHAR(200),
            phone              VARCHAR(40),
            email              VARCHAR(160),
            website            VARCHAR(200),
            legal_name         VARCHAR(160),
            vat_number         VARCHAR(20),
            sdi_code           VARCHAR(7),
            pec                VARCHAR(160),
            seats              INTEGER CHECK (seats IS NULL OR seats >= 0),
            locations          INTEGER CHECK (locations IS NULL OR locations >= 0),
            expected_mrr_cents INTEGER CHECK (expected_mrr_cents IS NULL OR expected_mrr_cents >= 0),
            contract_start     DATE,
            renewal_date       DATE,
            lost_reason        VARCHAR(200),
            notes              TEXT,
            tags               TEXT[] NOT NULL DEFAULT '{}',
            onboarding         JSONB NOT NULL DEFAULT '{}'::jsonb,
            stage_changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_accounts_stage ON crm_accounts (stage);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS crm_contacts (
            id          SERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            account_id  INTEGER NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
            full_name   VARCHAR(120) NOT NULL,
            role        VARCHAR(60),
            email       VARCHAR(160),
            phone       VARCHAR(40),
            is_primary  BOOLEAN NOT NULL DEFAULT FALSE,
            notes       VARCHAR(500),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_contacts_account ON crm_contacts (account_id);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS crm_activities (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            account_id         INTEGER NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
            kind               VARCHAR(12) NOT NULL
                               CHECK (kind IN ('nota', 'chiamata', 'email', 'incontro', 'demo', 'whatsapp', 'sistema')),
            body               TEXT NOT NULL,
            contact_id         INTEGER REFERENCES crm_contacts(id) ON DELETE SET NULL,
            occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_by_user_id INTEGER,
            author_name        VARCHAR(120),
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_activities_account ON crm_activities (account_id, occurred_at DESC);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_activities_recent ON crm_activities (occurred_at DESC);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS crm_tasks (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            account_id         INTEGER REFERENCES crm_accounts(id) ON DELETE CASCADE,
            title              VARCHAR(200) NOT NULL,
            due_date           DATE NOT NULL,
            priority           VARCHAR(8) NOT NULL DEFAULT 'normale' CHECK (priority IN ('alta', 'normale')),
            done_at            TIMESTAMPTZ,
            created_by_user_id INTEGER,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_tasks_open ON crm_tasks (due_date) WHERE done_at IS NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_tasks_account ON crm_tasks (account_id);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS crm_deals (
            id             SERIAL PRIMARY KEY,
            tenant_id      BIGINT NOT NULL,
            account_id     INTEGER NOT NULL REFERENCES crm_accounts(id) ON DELETE CASCADE,
            title          VARCHAR(160) NOT NULL,
            kind           VARCHAR(10) NOT NULL DEFAULT 'nuovo' CHECK (kind IN ('nuovo', 'upsell', 'rinnovo')),
            stage          VARCHAR(12) NOT NULL DEFAULT 'nuova'
                           CHECK (stage IN ('nuova', 'demo', 'proposta', 'trattativa', 'vinta', 'persa')),
            mrr_cents      INTEGER NOT NULL DEFAULT 0 CHECK (mrr_cents >= 0),
            setup_cents    INTEGER NOT NULL DEFAULT 0 CHECK (setup_cents >= 0),
            probability    SMALLINT CHECK (probability IS NULL OR probability BETWEEN 0 AND 100),
            expected_close DATE,
            closed_at      TIMESTAMPTZ,
            lost_reason    VARCHAR(200),
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_deals_account ON crm_deals (account_id);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS crm_deals_open ON crm_deals (stage) WHERE stage NOT IN ('vinta', 'persa');`);

    enableRls(pgm, 'crm_accounts');
    enableRls(pgm, 'crm_contacts');
    enableRls(pgm, 'crm_activities');
    enableRls(pgm, 'crm_tasks');
    enableRls(pgm, 'crm_deals');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS crm_deals;`);
    pgm.sql(`DROP TABLE IF EXISTS crm_tasks;`);
    pgm.sql(`DROP TABLE IF EXISTS crm_activities;`);
    pgm.sql(`DROP TABLE IF EXISTS crm_contacts;`);
    pgm.sql(`DROP TABLE IF EXISTS crm_accounts;`);
};
