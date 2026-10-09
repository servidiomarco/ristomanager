/**
 * Food cost — schede tecniche, costo del piatto e del banchetto (Fase 1).
 *
 * Il magazzino diventa l'anagrafica degli ingredienti: niente seconda
 * tabella prodotti, così lo stesso «Pomodoro pelato» è quello che si carica,
 * si scarica e si mette nella ricetta. Su inventory_products arrivano il
 * costo (centesimi interi al kg, al litro o al pezzo, come le altre cifre
 * nuove), la resa (scarto e calo peso: il branzino intero rende il 48% di
 * filetto) e, per i semilavorati (ragù, fondo, impasto), la quantità che la
 * loro ricetta rende. Il costo di un semilavorato non si salva: si calcola
 * dalle sue righe, così un rincaro arriva fino al piatto senza ricalcoli.
 *
 * - food_cost_righe: le righe della scheda, di un piatto (dish_id) o di un
 *   semilavorato (preparazione_id), mai di entrambi. Le quantità sono nette,
 *   in g, ml o pezzi secondo l'unità di costo dell'ingrediente. Un
 *   ingrediente usato in una scheda non si cancella dal magazzino
 *   (RESTRICT): la rotta risponde 409 e dice dove è usato.
 * - food_cost_piatti: porzioni che la scheda rende (la teglia di lasagne da
 *   8) e il costo a mano per i piatti senza ricetta (acqua, vino in
 *   bottiglia, dolci comprati). Tabella a parte e non colonne su dishes: le
 *   letture dei piatti arrivano a camerieri e cucina, il costo no.
 * - food_cost_prezzi: lo storico di ogni prezzo, con la fonte. Oggi solo
 *   MANUALE; BOLLA, FATTURA_XML e PASSEPARTOUT sono per le fasi dopo, già
 *   nel CHECK come valori inerti.
 * - food_cost_settings: target di food cost, IVA dei banchetti e quota del
 *   menu bambini, per ristorante (app_settings ha solo booleani).
 * - Permessi foodcost:view / foodcost:manage a titolare, direzione e
 *   manager: i costi sono dati riservati, come i compensi.
 * - Entitlement 'food_cost', acceso per il tenant 1: il modulo si potrà
 *   vendere a parte o dentro un piano, la scelta non è ancora fatta.
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

const enableRls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ---- Ingredienti: il magazzino con il costo -----------------------------
    pgm.sql(`
        ALTER TABLE inventory_products
            ADD COLUMN IF NOT EXISTS costo_cents         INTEGER CHECK (costo_cents IS NULL OR costo_cents >= 0),
            ADD COLUMN IF NOT EXISTS unita_costo         VARCHAR(2) CHECK (unita_costo IS NULL OR unita_costo IN ('kg', 'l', 'pz')),
            ADD COLUMN IF NOT EXISTS resa_pct            SMALLINT NOT NULL DEFAULT 100 CHECK (resa_pct BETWEEN 1 AND 100),
            ADD COLUMN IF NOT EXISTS supplier_id         UUID REFERENCES suppliers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS costo_aggiornato_at TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS is_preparazione     BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS resa_quantita       NUMERIC(12,3) CHECK (resa_quantita IS NULL OR resa_quantita > 0);
    `);

    // ---- Righe delle schede -------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS food_cost_righe (
            id              SERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL,
            dish_id         INTEGER REFERENCES dishes(id) ON DELETE CASCADE,
            preparazione_id INTEGER REFERENCES inventory_products(id) ON DELETE CASCADE,
            product_id      INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE RESTRICT,
            quantita        NUMERIC(12,3) NOT NULL CHECK (quantita > 0),
            sort_order      SMALLINT NOT NULL DEFAULT 0,
            note            VARCHAR(200),
            CHECK (num_nonnulls(dish_id, preparazione_id) = 1),
            CHECK (preparazione_id IS NULL OR preparazione_id <> product_id)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_righe_dish ON food_cost_righe (tenant_id, dish_id) WHERE dish_id IS NOT NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_righe_prep ON food_cost_righe (tenant_id, preparazione_id) WHERE preparazione_id IS NOT NULL;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_righe_product ON food_cost_righe (product_id);`);

    // ---- Porzioni e costo a mano del piatto ---------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS food_cost_piatti (
            dish_id             INTEGER PRIMARY KEY REFERENCES dishes(id) ON DELETE CASCADE,
            tenant_id           BIGINT NOT NULL,
            porzioni            SMALLINT NOT NULL DEFAULT 1 CHECK (porzioni BETWEEN 1 AND 500),
            costo_manuale_cents INTEGER CHECK (costo_manuale_cents IS NULL OR costo_manuale_cents >= 0),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_piatti_tenant ON food_cost_piatti (tenant_id);`);

    // ---- Storico dei prezzi -------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS food_cost_prezzi (
            id          BIGSERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            product_id  INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
            costo_cents INTEGER NOT NULL CHECK (costo_cents >= 0),
            unita_costo VARCHAR(2) NOT NULL CHECK (unita_costo IN ('kg', 'l', 'pz')),
            fonte       VARCHAR(16) NOT NULL CHECK (fonte IN ('MANUALE', 'BOLLA', 'FATTURA_XML', 'PASSEPARTOUT')),
            supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL,
            documento   VARCHAR(120),
            user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_name   VARCHAR(255),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_food_cost_prezzi_product ON food_cost_prezzi (tenant_id, product_id, created_at DESC);`);

    // ---- Impostazioni -------------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS food_cost_settings (
            tenant_id          BIGINT PRIMARY KEY,
            target_pct         SMALLINT NOT NULL DEFAULT 30 CHECK (target_pct BETWEEN 5 AND 90),
            iva_banchetti_pct  SMALLINT NOT NULL DEFAULT 10 CHECK (iva_banchetti_pct BETWEEN 0 AND 30),
            quota_bambini_pct  SMALLINT NOT NULL DEFAULT 50 CHECK (quota_bambini_pct BETWEEN 0 AND 100),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);

    enableRls(pgm, 'food_cost_righe');
    enableRls(pgm, 'food_cost_piatti');
    enableRls(pgm, 'food_cost_prezzi');
    enableRls(pgm, 'food_cost_settings');

    // ---- Entitlement --------------------------------------------------------
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'reviews', 'takeaway', 'sala_node', 'food_cost'));`);
    pgm.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled)
             SELECT 1, 'food_cost', true
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
             ON CONFLICT (tenant_id, feature) DO NOTHING;`);

    // ---- Permessi -----------------------------------------------------------
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, p.permission
          FROM tenants t
         CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER')) AS r(role)
         CROSS JOIN (VALUES ('foodcost:view'), ('foodcost:manage')) AS p(permission)
        ON CONFLICT DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission IN ('foodcost:view', 'foodcost:manage');`);
    pgm.sql(`DELETE FROM tenant_features WHERE feature = 'food_cost';`);
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'reviews', 'takeaway', 'sala_node'));`);
    pgm.sql(`DROP TABLE IF EXISTS food_cost_settings;`);
    pgm.sql(`DROP TABLE IF EXISTS food_cost_prezzi;`);
    pgm.sql(`DROP TABLE IF EXISTS food_cost_piatti;`);
    pgm.sql(`DROP TABLE IF EXISTS food_cost_righe;`);
    pgm.sql(`
        ALTER TABLE inventory_products
            DROP COLUMN IF EXISTS resa_quantita,
            DROP COLUMN IF EXISTS is_preparazione,
            DROP COLUMN IF EXISTS costo_aggiornato_at,
            DROP COLUMN IF EXISTS supplier_id,
            DROP COLUMN IF EXISTS resa_pct,
            DROP COLUMN IF EXISTS unita_costo,
            DROP COLUMN IF EXISTS costo_cents;
    `);
};
