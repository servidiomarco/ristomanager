/**
 * Fase D2 — Pannello piattaforma: il ruolo PLATFORM_ADMIN entra nella
 * allow-list dei CHECK su users.role e role_permissions.role. È un ruolo
 * SOPRA i tenant (lista tenant, sospensione, impersonation): non esiste una
 * route di signup, gli utenti PLATFORM_ADMIN si creano solo a mano via SQL.
 *
 * Il drop è dinamico su pg_constraint invece che per nome (stesso pattern di
 * drop-shift-checks): i CHECK possono essere nati inline con nome
 * auto-generato oppure dalle ALTER nominate di createSchema, e un elenco
 * scritto a mano si desincronizza. La regex prende qualunque CHECK sulle due
 * tabelle la cui definizione contenga role + 'OWNER'.
 *
 * ATTENZIONE (limite noto, da sanare quando createSchema verrà scongelato):
 * createSchema in db.ts ri-esegue a ogni boot le ALTER che ricreano questi
 * CHECK con la lista storica a 6 ruoli, e gira PRIMA delle migration — che
 * essendo già applicate non ri-allargano niente. Il boot di server.ts perciò
 * ri-applica questo stesso allargamento dopo runMigrations() (vedi
 * ensurePlatformAdminRoleChecks in server.ts): la migration resta la fonte
 * versionata del cambiamento, il re-assert al boot lo difende dal
 * ri-restringimento.
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
        DECLARE c RECORD;
        BEGIN
            FOR c IN
                SELECT conrelid::regclass AS tbl, conname
                  FROM pg_constraint
                 WHERE contype = 'c'
                   AND conrelid IN ('users'::regclass, 'role_permissions'::regclass)
                   AND pg_get_constraintdef(oid) ~ 'role.*''OWNER'''
            LOOP
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
            END LOOP;
        END $$;

        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('PLATFORM_ADMIN', 'OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'));
        ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
            CHECK (role IN ('PLATFORM_ADMIN', 'OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'));
    `);
};

/**
 * Ripristina le liste storiche a 6 ruoli. Prima del down vanno rimosse le
 * eventuali righe con role = 'PLATFORM_ADMIN', o le ADD CONSTRAINT falliscono.
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'));
        ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
        ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_check
            CHECK (role IN ('OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER', 'KITCHEN'));
    `);
};
