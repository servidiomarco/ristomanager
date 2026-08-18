/**
 * Fase B3.3 — domini menu, sala & cucina, banchetti.
 *
 * Vincoli riscritti (stesso PR delle query, regola B1):
 * - menu_price_lists: nome unico case-insensitive → per tenant;
 *   "un solo listino di default" → un default PER TENANT
 * - stations: nome unico case-insensitive → per tenant
 * - printers: nome unico → per tenant
 * - sala_profiles: nome unico → per tenant
 * - category_stations: PK (category) → (tenant_id, category)
 *
 * NON si toccano: table_merges/table_hidden_overrides/room_closed_overrides
 * UNIQUE(date, shift, id-FK) e dish_prices PK (dish_id, price_list_id) —
 * le FK sono già scopate per tenant.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const dropUniques = (table) => `
    DO $$
    DECLARE c RECORD;
    BEGIN
        FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = '${table}'::regclass AND contype = 'u'
        LOOP
            EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END LOOP;
    END $$;
`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_price_lists_name;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_price_lists_name ON menu_price_lists (tenant_id, LOWER(name));`);
    pgm.sql(`DROP INDEX IF EXISTS idx_price_lists_single_default;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_price_lists_single_default ON menu_price_lists (tenant_id) WHERE is_default;`);

    pgm.sql(`DROP INDEX IF EXISTS idx_stations_name;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_stations_name ON stations (tenant_id, LOWER(name));`);

    pgm.sql(dropUniques('printers'));
    pgm.sql(`ALTER TABLE printers ADD CONSTRAINT printers_tenant_name_key UNIQUE (tenant_id, name);`);

    pgm.sql(dropUniques('sala_profiles'));
    pgm.sql(`ALTER TABLE sala_profiles ADD CONSTRAINT sala_profiles_tenant_name_key UNIQUE (tenant_id, name);`);

    pgm.sql(`ALTER TABLE category_stations DROP CONSTRAINT category_stations_pkey;`);
    pgm.sql(`ALTER TABLE category_stations ADD CONSTRAINT category_stations_pkey PRIMARY KEY (tenant_id, category);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_price_lists_name;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_price_lists_name ON menu_price_lists (LOWER(name));`);
    pgm.sql(`DROP INDEX IF EXISTS idx_price_lists_single_default;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_price_lists_single_default ON menu_price_lists (is_default) WHERE is_default;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_stations_name;`);
    pgm.sql(`CREATE UNIQUE INDEX idx_stations_name ON stations (LOWER(name));`);
    pgm.sql(`ALTER TABLE printers DROP CONSTRAINT IF EXISTS printers_tenant_name_key;`);
    pgm.sql(`ALTER TABLE printers ADD CONSTRAINT printers_name_key UNIQUE (name);`);
    pgm.sql(`ALTER TABLE sala_profiles DROP CONSTRAINT IF EXISTS sala_profiles_tenant_name_key;`);
    pgm.sql(`ALTER TABLE sala_profiles ADD CONSTRAINT sala_profiles_name_key UNIQUE (name);`);
    pgm.sql(`ALTER TABLE category_stations DROP CONSTRAINT category_stations_pkey;`);
    pgm.sql(`ALTER TABLE category_stations ADD CONSTRAINT category_stations_pkey PRIMARY KEY (category);`);
};
