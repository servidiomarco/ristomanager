/**
 * Supporto, fase 2 — la salute dei ristoranti vista dalla piattaforma.
 *
 * - app_errors: gli errori che altrimenti finivano solo in una console.
 *   origin 'client' = il browser di chi lavora (crash di una vista, errori
 *   non gestiti); origin 'sofia' = un tool o un webhook di Sofia che non ha
 *   risposto come doveva. fingerprint raggruppa le occorrenze dello stesso
 *   errore. Si allegano da soli alle richieste di supporto e alimentano gli
 *   avvisi; si cancellano dopo 30 giorni.
 * - platform_alerts: un avviso proattivo per ristorante e tipo (stampa,
 *   fiscale, sofia, nodo), aperto dal cane da guardia e chiuso quando il
 *   problema rientra. Lo stato sta qui e non in memoria: un deploy non deve
 *   far ripartire la stessa push. L'indice unico parziale garantisce un solo
 *   avviso aperto per (ristorante, tipo).
 * - platform_incidents: il banner «problema noto» che la piattaforma mostra
 *   ai ristoranti. tenant_id è il ristorante di casa di chi lo scrive, come
 *   dev_board_cards e roadmap: la tabella resta dentro gli invarianti RLS e
 *   si legge di piattaforma (runAsPlatform). target_tenant_ids vuoto = tutti.
 *
 * tenant_id senza DEFAULT e RLS con la policy standard (rls-invarianti).
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
        CREATE TABLE IF NOT EXISTS app_errors (
            id          BIGSERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            origin      VARCHAR(10) NOT NULL CHECK (origin IN ('client', 'sofia')),
            source      VARCHAR(40) NOT NULL,
            fingerprint VARCHAR(32) NOT NULL,
            message     TEXT NOT NULL,
            stack       TEXT,
            view        VARCHAR(40),
            app_version VARCHAR(20),
            user_id     INTEGER,
            user_role   VARCHAR(30),
            user_agent  TEXT,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS app_errors_tenant_recent ON app_errors (tenant_id, created_at DESC);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS app_errors_recent ON app_errors (created_at DESC);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS app_errors_user_recent ON app_errors (tenant_id, user_id, created_at DESC) WHERE user_id IS NOT NULL;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS platform_alerts (
            id           BIGSERIAL PRIMARY KEY,
            tenant_id    BIGINT NOT NULL,
            kind         VARCHAR(12) NOT NULL CHECK (kind IN ('stampa', 'fiscale', 'sofia', 'nodo')),
            detail       JSONB NOT NULL DEFAULT '{}'::jsonb,
            opened_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at  TIMESTAMPTZ
        );
    `);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS platform_alerts_one_open ON platform_alerts (tenant_id, kind) WHERE resolved_at IS NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS platform_alerts_recent ON platform_alerts (opened_at DESC);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS platform_incidents (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            message            VARCHAR(240) NOT NULL,
            level              VARCHAR(10) NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'critico')),
            target_tenant_ids  BIGINT[] NOT NULL DEFAULT '{}',
            created_by_user_id INTEGER,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at        TIMESTAMPTZ
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS platform_incidents_active ON platform_incidents (created_at DESC) WHERE resolved_at IS NULL;`);

    enableRls(pgm, 'app_errors');
    enableRls(pgm, 'platform_alerts');
    enableRls(pgm, 'platform_incidents');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS platform_incidents;`);
    pgm.sql(`DROP TABLE IF EXISTS platform_alerts;`);
    pgm.sql(`DROP TABLE IF EXISTS app_errors;`);
};
