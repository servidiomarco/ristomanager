/* Modulo Cassa — sessione di cassa, ruolo e permessi (docs/cassa-plan.md).
 *
 * Tre cose in una migration perché sono un pezzo solo: senza il ruolo nella
 * allow-list dei CHECK non si crea un utente CASSA, e senza i permessi a
 * registro il modulo esiste ma nessuno lo apre.
 *
 * 1. `cash_sessions` — il cassetto di UN SERVIZIO, non di una giornata: lo
 *    stesso cassetto passa di mano fra pranzo e cena e una differenza va
 *    imputata al turno che l'ha prodotta. Il report giornaliero
 *    (GET /reports/cash-closure) resta dov'è, intatto, per Pagamenti.
 *
 * 2. Allargamento dei CHECK su users.role e role_permissions.role al ruolo
 *    CASSA, con lo stesso drop dinamico su pg_constraint di
 *    platform-admin-role: i CHECK possono essere nati inline con nome
 *    auto-generato oppure dalle ALTER nominate di createSchema, e un elenco
 *    di nomi scritto a mano si desincronizza.
 *
 *    ATTENZIONE (stesso limite noto di platform-admin-role): createSchema in
 *    db.ts ri-esegue a ogni boot le ALTER che ricreano questi CHECK con la
 *    lista storica a sei ruoli, e gira PRIMA delle migration. Il boot di
 *    server.ts perciò ri-applica l'allargamento dopo runMigrations() (vedi
 *    ensureRoleChecks): questa migration resta la fonte versionata, il
 *    re-assert al boot la difende dal ri-restringimento.
 *
 * 3. Seed dei permessi. `cash:operate` e `cash:void_payment` vanno anche al
 *    ruolo CASSA; `cash:close_partial` e `cash:close_session` restano ai
 *    ruoli di direzione — chiudere in ammanco e contare il cassetto sono le
 *    due cose che il titolare vuole separare da chi sta in cassa.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE cash_sessions (
            id                  BIGSERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL,
            service_date        DATE NOT NULL,
            shift               VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
            opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
            opened_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            opened_by_name      TEXT NOT NULL,
            opened_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            counted_cents       INTEGER CHECK (counted_cents IS NULL OR counted_cents >= 0),
            -- Memorizzata, a differenza dell'atteso che si ricalcola sempre:
            -- è la fotografia del momento in cui si è contato il cassetto. Uno
            -- storno alle 23:40 non deve riscriverla, o la nota dell'operatore
            -- finirebbe a spiegare un numero che non esiste più.
            difference_cents    INTEGER,
            note                TEXT,
            closed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            closed_by_name      TEXT,
            closed_at           TIMESTAMPTZ,
            -- La nota è obbligatoria quando il conteggio non torna: è l'unica
            -- spiegazione che resterà a registro. Vincolo qui e non solo nella
            -- route, perché è una regola del dato.
            CONSTRAINT cash_sessions_nota_differenza
                CHECK (closed_at IS NULL OR difference_cents = 0
                       OR (note IS NOT NULL AND char_length(btrim(note)) > 0))
        );
    `);

    // Una sola sessione per servizio: è il modello, non una convenzione.
    pgm.sql(`
        CREATE UNIQUE INDEX cash_sessions_servizio
            ON cash_sessions (tenant_id, service_date, shift);
    `);

    // RLS come per ogni tabella nuova con tenant_id (pattern outbox).
    const POLICY = `
        (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
        OR (
            (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
            AND (
                (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
                OR (current_setting('app.rls_bypass', true) = 'on')
            )
        )
    `;
    pgm.sql(`ALTER TABLE cash_sessions ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE cash_sessions FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON cash_sessions;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON cash_sessions
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);

    // Il ruolo CASSA nella allow-list dei CHECK. Drop dinamico: vedi testata.
    pgm.sql(`
        DO $$
        DECLARE c RECORD;
        BEGIN
            FOR c IN
                SELECT conrelid::regclass AS tbl, conname
                  FROM pg_constraint
                 WHERE contype = 'c'
                   AND conrelid IN ('users'::regclass, 'role_permissions'::regclass)
                   AND pg_get_constraintdef(oid) ~ 'role.*''OWNER'''
                   AND pg_get_constraintdef(oid) !~ 'CASSA'
            LOOP
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
                EXECUTE format(
                    'ALTER TABLE %s ADD CONSTRAINT %I CHECK (role IN (''PLATFORM_ADMIN'', ''OWNER'', ''GENERAL_MANAGER'', ''MANAGER'', ''RECEPTION'', ''WAITER'', ''KITCHEN'', ''CASSA''))',
                    c.tbl, c.conname
                );
            END LOOP;
        END $$;
    `);

    // I quattro permessi ai ruoli di direzione, in tutti i tenant. Le
    // migration girano con app.rls_bypass acceso (runMigrations, db.ts),
    // quindi l'insert cross-tenant passa anche con la strict di produzione.
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, p.permission
          FROM tenants t
         CROSS JOIN (VALUES ('PLATFORM_ADMIN'), ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER')) AS r(role)
         CROSS JOIN (VALUES ('cash:operate'), ('cash:void_payment'),
                            ('cash:close_partial'), ('cash:close_session')) AS p(permission)
            ON CONFLICT DO NOTHING;
    `);

    // Il ruolo CASSA: incassa e storna, non chiude il cassetto. orders:void
    // c'è perché senza non si storna una riga né si applica lo sconto conto.
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, 'CASSA', p.permission
          FROM tenants t
         CROSS JOIN (VALUES ('dashboard:view'), ('floorplan:view'), ('reservations:view'),
                            ('customers:view'), ('customers:full'), ('reception:view'),
                            ('payments:view'), ('orders:view'), ('orders:take'), ('orders:void'),
                            ('cash:operate'), ('cash:void_payment'), ('staffchat:use')) AS p(permission)
            ON CONFLICT DO NOTHING;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE role = 'CASSA';`);
    pgm.sql(`DELETE FROM role_permissions WHERE permission LIKE 'cash:%';`);
    pgm.sql(`DROP TABLE IF EXISTS cash_sessions;`);
    // I CHECK non si restringono: un eventuale utente CASSA già creato
    // renderebbe la ADD CONSTRAINT invalida e il down fallirebbe a metà.
};
