/**
 * Piano ferie: richieste dei dipendenti, monte ferie annuo, regole di
 * copertura per la proposta automatica.
 *
 * - staff_members.user_id: collega la scheda del personale all'account con
 *   cui il dipendente entra nell'app. È il collegamento a fare da
 *   autorizzazione per il self-service («Le mie ferie»): chi ha un account
 *   collegato chiede ferie solo per la propria scheda, senza un permesso di
 *   matrice in più. Unico: un account, una scheda.
 * - staff_members.annual_leave_days: giorni di ferie spettanti l'anno. NULL =
 *   si eredita il default del ristorante (staff_leave_settings), che a sua
 *   volta NULL = monte non tenuto.
 * - staff_leave_requests: le richieste. SEPARATE da staff_time_off di
 *   proposito: presenze del giorno, calendario turni e Dashboard leggono
 *   staff_time_off senza guardare `approved`, quindi una richiesta in attesa
 *   scritta lì toglierebbe la persona dal turno prima del sì. All'approvazione
 *   nasce la riga VACANZA in staff_time_off (time_off_id), e da lì in poi i
 *   lettori esistenti la vedono come qualsiasi altra assenza.
 * - staff_leave_settings: una riga per ristorante — copertura minima per
 *   reparto e servizio, giorni di default, criterio di priorità.
 *
 * RLS con la stessa policy delle altre tabelle per-tenant: la migration RLS
 * globale è già girata e non copre tabelle nuove.
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
    pgm.sql(`ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS staff_members_user_id_key ON staff_members (user_id) WHERE user_id IS NOT NULL;`);
    pgm.sql(`
        ALTER TABLE staff_members ADD COLUMN IF NOT EXISTS annual_leave_days NUMERIC(5,1)
            CHECK (annual_leave_days IS NULL OR annual_leave_days >= 0);
    `);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS staff_leave_requests (
            id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id            BIGINT NOT NULL,
            staff_id             UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
            start_date           DATE NOT NULL,
            end_date             DATE NOT NULL,
            note                 TEXT,
            status               VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                                 CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
            requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            decided_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            decided_at           TIMESTAMPTZ,
            decision_note        TEXT,
            time_off_id          UUID REFERENCES staff_time_off(id) ON DELETE SET NULL,
            created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (end_date >= start_date)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS staff_leave_requests_status ON staff_leave_requests (tenant_id, status, start_date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS staff_leave_requests_staff ON staff_leave_requests (tenant_id, staff_id, start_date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS staff_leave_requests_time_off ON staff_leave_requests (time_off_id) WHERE time_off_id IS NOT NULL;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS staff_leave_settings (
            tenant_id           BIGINT PRIMARY KEY,
            default_annual_days NUMERIC(5,1) CHECK (default_annual_days IS NULL OR default_annual_days >= 0),
            min_sala_lunch      SMALLINT NOT NULL DEFAULT 0 CHECK (min_sala_lunch >= 0),
            min_sala_dinner     SMALLINT NOT NULL DEFAULT 0 CHECK (min_sala_dinner >= 0),
            min_cucina_lunch    SMALLINT NOT NULL DEFAULT 0 CHECK (min_cucina_lunch >= 0),
            min_cucina_dinner   SMALLINT NOT NULL DEFAULT 0 CHECK (min_cucina_dinner >= 0),
            priority            VARCHAR(12) NOT NULL DEFAULT 'FIRST_COME'
                                CHECK (priority IN ('FIRST_COME', 'FEWEST_DAYS')),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

    enableRls(pgm, 'staff_leave_requests');
    enableRls(pgm, 'staff_leave_settings');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS staff_leave_settings;`);
    pgm.sql(`DROP TABLE IF EXISTS staff_leave_requests;`);
    pgm.sql(`DROP INDEX IF EXISTS staff_members_user_id_key;`);
    pgm.sql(`ALTER TABLE staff_members DROP COLUMN IF EXISTS annual_leave_days;`);
    pgm.sql(`ALTER TABLE staff_members DROP COLUMN IF EXISTS user_id;`);
};
