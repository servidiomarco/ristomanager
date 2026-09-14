/**
 * Compensi del personale: tariffe, acconti/saldi e correzioni del dovuto.
 *
 * Tre tabelle SEPARATE da staff_members, di proposito: GET /staff risponde
 * `SELECT *` a chiunque abbia staff:view, e le tariffe non devono passare di
 * lì — vivono dietro il permesso staff:payments E lo sblocco step-up con la
 * password del titolare (header X-Step-Up-Token, vedi requireStepUp).
 *
 * - staff_compensation_profiles: le tariffe correnti, una riga per
 *   dipendente. monthly_cents per FISSO/STAGIONALE, single/double per gli
 *   EXTRA pagati a servizio (doppio = pranzo+cena nello stesso giorno,
 *   importo TOTALE del giorno). L'id surrogato esiste per la
 *   storicizzazione futura: basterà un valid_from e allentare la UNIQUE.
 * - staff_compensation_payments: il registro dei movimenti (acconti e
 *   saldi), ancorati al mese di competenza (period_month = primo del mese).
 * - staff_compensation_overrides: il dovuto corretto a mano. Riga presente
 *   = quel mese vale l'override; cancellarla = tornare al calcolo
 *   automatico. Copre anche i mezzi mesi degli stagionali senza pro-rata.
 *
 * Importi SEMPRE in cents interi (stessa convenzione della cassa).
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
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS staff_compensation_profiles (
            id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id            BIGINT NOT NULL,
            staff_id             UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
            monthly_cents        INTEGER CHECK (monthly_cents >= 0),
            single_service_cents INTEGER CHECK (single_service_cents >= 0),
            double_service_cents INTEGER CHECK (double_service_cents >= 0),
            notes                TEXT,
            created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, staff_id)
        );
    `);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS staff_compensation_payments (
            id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id    BIGINT NOT NULL,
            staff_id     UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
            period_month DATE NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
            kind         VARCHAR(10) NOT NULL CHECK (kind IN ('ACCONTO', 'SALDO')),
            amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
            paid_on      DATE NOT NULL DEFAULT CURRENT_DATE,
            method       VARCHAR(20) CHECK (method IN ('CONTANTI', 'BONIFICO', 'ALTRO')),
            note         TEXT,
            created_by   INTEGER,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS staff_comp_payments_staff ON staff_compensation_payments (tenant_id, staff_id, period_month);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS staff_comp_payments_month ON staff_compensation_payments (tenant_id, period_month);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS staff_compensation_overrides (
            tenant_id      BIGINT NOT NULL,
            staff_id       UUID NOT NULL REFERENCES staff_members(id) ON DELETE CASCADE,
            period_month   DATE NOT NULL CHECK (EXTRACT(DAY FROM period_month) = 1),
            override_cents INTEGER NOT NULL CHECK (override_cents >= 0),
            note           TEXT,
            created_by     INTEGER,
            updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, staff_id, period_month)
        );
    `);

    enableRls(pgm, 'staff_compensation_profiles');
    enableRls(pgm, 'staff_compensation_payments');
    enableRls(pgm, 'staff_compensation_overrides');

    // Il permesso al solo OWNER, in tutti i tenant: la sezione nasce
    // riservata al titolare, che dalla matrice può aprirla ad altri.
    // PLATFORM_ADMIN non ha righe in role_permissions e non deve averne
    // (bypass della sessione scopata, vedi authMiddleware).
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, 'OWNER', 'staff:payments' FROM tenants t
            ON CONFLICT DO NOTHING;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'staff:payments';`);
    pgm.sql(`DROP TABLE IF EXISTS staff_compensation_overrides;`);
    pgm.sql(`DROP TABLE IF EXISTS staff_compensation_payments;`);
    pgm.sql(`DROP TABLE IF EXISTS staff_compensation_profiles;`);
};
