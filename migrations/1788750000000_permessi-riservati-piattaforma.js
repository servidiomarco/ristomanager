/**
 * Permessi riservati alla piattaforma (platform_permission_locks).
 *
 * Il layer sopra l'OWNER (PR «Entra», sessione di piattaforma scopata) ha
 * senso solo se la piattaforma può anche FENCERE la matrice: un permesso
 * bloccato qui non è più assegnabile né revocabile dalla matrice del
 * tenant — lo amministra solo il pannello piattaforma. Chi lo aveva lo
 * tiene finché la piattaforma non decide (la revoca è un'opzione esplicita
 * del PUT admin, non un effetto collaterale del lock).
 *
 * NIENTE RLS, di proposito: la tabella si consulta nelle route della
 * matrice sempre filtrata per tenant_id, e nelle route /admin (runAsPlatform)
 * attraversa i tenant di mestiere — come tenant_features.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS platform_permission_locks (
            tenant_id  INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            permission TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, permission)
        );
    `);
};
