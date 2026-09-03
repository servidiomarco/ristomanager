/**
 * Lancio ristretto della Reportistica (tenant 1, Vecchio Frantoio).
 *
 * reports:view era in matrice da sempre — OWNER, GM, MANAGER e perfino
 * WAITER — ma non apriva nessuna pagina: guardava solo il report AI della
 * Dashboard. Ora che apre la Reportistica (incassi, scontrino medio,
 * differenze di cassa), il titolare vuole decidere LUI a chi darla: questa
 * migration azzera reports:* nella matrice del ristorante, e l'accesso resta
 * ai soli account in REPORTS_ADMIN_EMAILS (requireReportsAccess in
 * server.ts). Ridare il permesso a un ruolo dalla pagina Utenti riapre la
 * via ordinaria, senza deploy.
 *
 * Solo tenant 1: il tenant demo resta com'è (la Reportistica si mostra
 * nelle demo), e i tenant futuri nascono dal seed del provisioning, che
 * gira dopo questa migration.
 *
 * L'ensure di boot in db.ts che ri-seminava reports:view/full al
 * GENERAL_MANAGER è stato tolto nello stesso PR, o questa DELETE verrebbe
 * annullata al riavvio successivo.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        DELETE FROM role_permissions
        WHERE tenant_id = 1
          AND permission IN ('reports:view', 'reports:full');
    `);
};

/**
 * Ripristina i default storici (la personalizzazione fatta nel frattempo
 * dalla pagina Utenti non è ricostruibile).
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        VALUES
            (1, 'OWNER', 'reports:view'), (1, 'OWNER', 'reports:full'),
            (1, 'GENERAL_MANAGER', 'reports:view'), (1, 'GENERAL_MANAGER', 'reports:full'),
            (1, 'MANAGER', 'reports:view')
        ON CONFLICT DO NOTHING;
    `);
};
