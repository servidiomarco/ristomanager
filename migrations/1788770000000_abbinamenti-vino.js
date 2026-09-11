/**
 * Abbinamenti vino–piatto (dish_wine_pairings).
 *
 * Tabella ponte come dish_menus: un piatto suggerisce da 1 a 3 vini della
 * carta (piatti a loro volta, di categorie marcate «vino»), curati dal
 * ristoratore in scheda piatto — l'AI li propone soltanto. Entrambe le FK
 * cascano con il piatto: un vino tolto dal menu porta via anche i suoi
 * abbinamenti, senza orfani.
 *
 * sort_order conserva l'ordine di preferenza («dal più adatto»), che è
 * informazione del sommelier, non un dettaglio di visualizzazione.
 *
 * RLS con la stessa policy di dish_menus (pattern outbox).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS dish_wine_pairings (
            tenant_id    BIGINT NOT NULL,
            dish_id      INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
            wine_dish_id INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
            sort_order   INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, dish_id, wine_dish_id)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS dish_wine_pairings_wine ON dish_wine_pairings (wine_dish_id);`);

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
    pgm.sql(`ALTER TABLE dish_wine_pairings ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE dish_wine_pairings FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON dish_wine_pairings;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON dish_wine_pairings
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};
