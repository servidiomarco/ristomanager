/* Personale: chi vede le ferie e le assenze degli altri.
 *
 * - staff:leave, nuovo: piano ferie, richieste, giorni annui e il motivo di
 *   ogni assenza (ferie, malattia, permesso). Di default al titolare e al
 *   general manager; agli altri ruoli lo dà il titolare dalla matrice in
 *   Utenti. Chi ha staff:view senza staff:leave vede i turni e un'assenza
 *   altrui come «Assente», senza motivo.
 * - La Cucina perde staff:full: era stata accesa dalla matrice del tenant 1
 *   e copiata nei tenant nati dopo, e dava ai cuochi la modifica di turni e
 *   schede di tutti più le notifiche «Richiesta ferie». Il titolare l'ha
 *   voluta togliere (11/10/2026); staff:view resta, i turni li vedono.
 *
 * Le migration girano con app.rls_bypass acceso (runMigrations, db.ts):
 * insert e delete cross-tenant passano anche con la strict di produzione. */
export const up = (pgm) => {
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'staff:leave'
          FROM tenants t
         CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER')) AS r(role)
            ON CONFLICT DO NOTHING;
    `);
    pgm.sql(`DELETE FROM role_permissions WHERE role = 'KITCHEN' AND permission = 'staff:full';`);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'staff:leave';`);
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, 'KITCHEN', 'staff:full' FROM tenants t
            ON CONFLICT DO NOTHING;
    `);
};
