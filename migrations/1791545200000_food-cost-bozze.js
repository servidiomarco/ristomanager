/**
 * Food cost — bozze delle schede scritte dall'AI, in blocco.
 *
 * «Prepara le bozze» fa scrivere all'AI una scheda per ogni piatto che non
 * ne ha, in sottofondo. Il risultato NON è una scheda: sta qui finché lo chef
 * non la apre, la corregge e la salva (allora diventa righe in
 * food_cost_righe e la bozza si cancella) o la scarta. Così una grammatura
 * inventata non entra mai nei costi, nei badge del menu o nei banchetti.
 *
 * - righe: le righe proposte, già ripulite dal server (productId o nome di
 *   un ingrediente nuovo, unità, quantità, nota).
 * - avvisi: le note del modello da mostrare allo chef.
 * - Una bozza per piatto (dish_id è la chiave, come in food_cost_piatti), e
 *   se il piatto si cancella la bozza va con lui.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const RLS_POLICY = `
    (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
    OR (
        (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
        AND (
            (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
            OR (current_setting('app.rls_bypass', true) = 'on')
        )
    )
`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS food_cost_bozze (
            dish_id    INTEGER PRIMARY KEY REFERENCES dishes(id) ON DELETE CASCADE,
            tenant_id  BIGINT NOT NULL,
            righe      JSONB NOT NULL DEFAULT '[]'::jsonb,
            avvisi     JSONB NOT NULL DEFAULT '[]'::jsonb,
            porzioni   SMALLINT NOT NULL DEFAULT 1 CHECK (porzioni BETWEEN 1 AND 500),
            model      VARCHAR(64),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_bozze_tenant ON food_cost_bozze (tenant_id);`);

    pgm.sql(`ALTER TABLE food_cost_bozze ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE food_cost_bozze FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON food_cost_bozze;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON food_cost_bozze
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS food_cost_bozze;`);
};
