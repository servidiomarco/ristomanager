/**
 * Fase B4 — Row-Level Security su ogni tabella tenant.
 *
 * La rete sotto i sette PR della B3: una query sfuggita allo scoping
 * applicativo, se eseguita dentro withTenant() (db.ts), ritorna zero
 * righe invece dei dati di un altro ristorante.
 *
 * Due scelte deliberate, da capire prima di toccare questo file:
 *
 * 1. FORCE ROW LEVEL SECURITY: l'app si connette come owner delle
 *    tabelle, e l'owner BYPASSA la RLS se non forzata. Senza FORCE le
 *    policy sarebbero decorative.
 *
 * 2. Policy con fallback permissivo: quando app.tenant_id NON è
 *    impostata (current_setting con missing_ok → NULL) la policy
 *    collassa in tenant_id = tenant_id, cioè passa tutto. La B3 ha
 *    scopato le query con predicati espliciti su pool.query, non
 *    tutte passano da withTenant: una policy rigida oggi spegnerebbe
 *    l'applicazione (createSchema e i seed compresi). Il contratto:
 *    - dentro withTenant/tenantQuery la RLS è GIÀ rigida;
 *    - PRIMA di accendere il secondo tenant il fallback va rimosso
 *      (policy → tenant_id = current_setting('app.tenant_id')::bigint)
 *      migrando i percorsi caldi su withTenant. Annotato anche nel
 *      piano (docs/saas-multitenant-plan.md).
 *
 * Il DEFAULT 1 su tenant_id resta: i seed della baseline congelata
 * (createSchema) inseriscono senza tenant esplicito e devono poterlo
 * fare. Cade insieme al fallback, prima del tenant 2.
 *
 * Dinamico su pg_tables (61 tabelle oggi) con guardia sull'esistenza
 * della colonna: una tabella futura senza tenant_id non deve far
 * fallire la migration ma va scoperta (WARNING in log).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        DO $$
        DECLARE t RECORD;
        BEGIN
            FOR t IN
                SELECT tablename
                  FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename NOT IN ('pgmigrations', 'tenants')
            LOOP
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public'
                       AND table_name = t.tablename
                       AND column_name = 'tenant_id'
                ) THEN
                    RAISE WARNING 'RLS saltata: % non ha tenant_id', t.tablename;
                    CONTINUE;
                END IF;
                EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
                EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t.tablename);
                EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.tablename);
                EXECUTE format(
                    'CREATE POLICY tenant_isolation ON %I '
                    || 'USING (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint, tenant_id)) '
                    || 'WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting(''app.tenant_id'', true), '''')::bigint, tenant_id))',
                    t.tablename
                );
            END LOOP;
        END $$;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        DO $$
        DECLARE t RECORD;
        BEGIN
            FOR t IN
                SELECT tablename
                  FROM pg_tables
                 WHERE schemaname = 'public'
                   AND tablename NOT IN ('pgmigrations', 'tenants')
            LOOP
                EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.tablename);
                EXECUTE format('ALTER TABLE %I NO FORCE ROW LEVEL SECURITY', t.tablename);
                EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', t.tablename);
            END LOOP;
        END $$;
    `);
};
