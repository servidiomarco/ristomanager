/**
 * PLATFORM_ADMIN esce dalla matrice permessi, in tutti i tenant (audit
 * isolamento M-03, correzione (b) della contro-valutazione).
 *
 * PLATFORM_ADMIN non ha righe in role_permissions e non deve averne. La
 * sessione «Entra» bypassa la matrice e il token di pannello non opera nel
 * tenant. Tre migration però gliele avevano seminate in ogni tenant:
 * chat-interna-staff (staffchat:use), modulo-cassa (cash:* ×4) e
 * permesso-fiscalita (fiscal:view). Il provisioning le copiava poi in ogni
 * tenant nuovo. Oggi requirePermission non le onora solo per caso:
 * emptyRoleMap (permissionService.ts) non ha la chiave PLATFORM_ADMIN.
 * Chi un giorno la aggiungesse aprirebbe cassa e fiscalità al token di
 * pannello. Intanto /auth/me e il login le mandano al frontend, che mostra
 * Cassa, Fiscalità e Chat staff per poi prendere un 403 muto.
 *
 * Il provisioning smette di copiarle nello stesso PR (tenantProvisioning.ts),
 * e nessun seed di boot in db.ts le ricrea. La DELETE è idempotente: una
 * seconda esecuzione non trova niente. Le migration girano con
 * app.rls_bypass acceso (runMigrations, db.ts), quindi la pulizia
 * attraversa tutti i tenant anche con la RLS rigida di produzione.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE role = 'PLATFORM_ADMIN';`);
};

/**
 * Nessun ripristino, di proposito: le righe cancellate erano la trappola,
 * non una configurazione da restituire.
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = () => {};
