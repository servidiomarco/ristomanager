/**
 * Fase B2 del piano SaaS — dominio auth: la matrice permessi diventa per
 * tenant. Il vincolo UNIQUE(role, permission) era globale: con due tenant,
 * il secondo non potrebbe avere la propria riga OWNER/dashboard:view.
 *
 * Questo è il primo vincolo riscritto secondo la regola stabilita in B1:
 * ogni dominio riscrive i SUOI vincoli nello stesso PR che aggiorna le
 * SUE query (qui permissionService, che ora filtra e inserisce con
 * tenant_id). Gli ON CONFLICT esistenti su questa tabella sono tutti
 * senza target esplicito ("ON CONFLICT DO NOTHING") e restano validi con
 * qualunque vincolo.
 *
 * Drop dinamico su pg_constraint: il vincolo inline ha nome auto-generato.
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
                SELECT conname
                  FROM pg_constraint
                 WHERE conrelid = 'role_permissions'::regclass
                   AND contype = 'u'
            LOOP
                EXECUTE format('ALTER TABLE role_permissions DROP CONSTRAINT %I', c.conname);
            END LOOP;
        END $$;
    `);
    pgm.sql(`
        ALTER TABLE role_permissions
            ADD CONSTRAINT role_permissions_tenant_role_permission_key
            UNIQUE (tenant_id, role, permission);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE role_permissions DROP CONSTRAINT IF EXISTS role_permissions_tenant_role_permission_key;`);
    pgm.sql(`ALTER TABLE role_permissions ADD CONSTRAINT role_permissions_role_permission_key UNIQUE (role, permission);`);
};
