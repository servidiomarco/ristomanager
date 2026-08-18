/**
 * Fase B1 del piano SaaS: nasce il concetto di tenant.
 *
 * 1. Tabella `tenants`; il Vecchio Frantoio è il tenant 1, creato qui.
 * 2. `tenant_id BIGINT NOT NULL DEFAULT 1` + FK + indice su OGNI tabella
 *    esistente. Il DEFAULT 1 è deliberato e temporaneo: le route non
 *    passano ancora il tenant (arriva con B2/B3), e senza default ogni
 *    INSERT del codice attuale fallirebbe. Con un solo tenant in
 *    produzione il default è anche semanticamente corretto. Cade quando
 *    lo scoping delle route è completo (fine Fase B, insieme alla RLS).
 *
 * L'aggiunta della colonna è DINAMICA su pg_tables invece che un elenco di
 * 57 ALTER scritti a mano: l'elenco si desincronizza, la query no. Su
 * PG11+ ADD COLUMN NOT NULL DEFAULT non riscrive la tabella, quindi il
 * backfill delle righe esistenti a tenant 1 è istantaneo.
 *
 * NON si riscrivono qui i vincoli unici globali (email, telefono cliente,
 * PK di app_settings/integration_settings/opening_hours, …): molti sono
 * bersaglio di ON CONFLICT nel codice, e cambiarli senza aggiornare le
 * query nello stesso deploy rompe le scritture. Ogni PR di dominio della
 * Fase B3 riscrive i vincoli del suo dominio insieme alle sue query.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS tenants (
            id         BIGSERIAL PRIMARY KEY,
            slug       VARCHAR(60) NOT NULL UNIQUE
                       CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
            name       VARCHAR(120) NOT NULL,
            status     VARCHAR(20) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'suspended')),
            timezone   VARCHAR(40) NOT NULL DEFAULT 'Europe/Rome',
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
    `);

    // Tenant 1 con id esplicito: tutto il backfill sotto punta a lui.
    // La sequence va riallineata, o la prima INSERT senza id collide.
    pgm.sql(`
        INSERT INTO tenants (id, slug, name)
        VALUES (1, 'vecchio-frantoio', 'Il Vecchio Frantoio')
        ON CONFLICT (id) DO NOTHING;
    `);
    pgm.sql(`
        SELECT setval(pg_get_serial_sequence('tenants', 'id'),
                      (SELECT MAX(id) FROM tenants));
    `);

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
                EXECUTE format(
                    'ALTER TABLE %I ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1 REFERENCES tenants(id)',
                    t.tablename
                );
                EXECUTE format(
                    'CREATE INDEX IF NOT EXISTS idx_%s_tenant ON %I (tenant_id)',
                    t.tablename, t.tablename
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
                EXECUTE format('ALTER TABLE %I DROP COLUMN IF EXISTS tenant_id', t.tablename);
            END LOOP;
        END $$;
    `);
    pgm.sql(`DROP TABLE IF EXISTS tenants;`);
};
