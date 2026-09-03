/* Permesso dedicato della vista Fiscalità (registro documenti, corrispettivi,
 * export): fiscal:view. Di default ce l'ha SOLO il titolare (più il platform
 * admin), per scelta esplicita: il registro fiscale non segue reports:view —
 * che i ruoli direttivi hanno già per i report operativi — e chi lo deve
 * vedere lo decide l'owner, ruolo per ruolo, dalla matrice permessi in
 * Utenti (role_permissions è per tenant e modificabile a runtime).
 *
 * Le migration girano con app.rls_bypass acceso (runMigrations, db.ts):
 * l'insert cross-tenant passa anche con la strict di produzione — stesso
 * pattern del modulo cassa. */
export const up = (pgm) => {
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'fiscal:view'
          FROM tenants t
         CROSS JOIN (VALUES ('PLATFORM_ADMIN'), ('OWNER')) AS r(role)
            ON CONFLICT DO NOTHING;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'fiscal:view';`);
};
