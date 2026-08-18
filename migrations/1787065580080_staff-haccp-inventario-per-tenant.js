/**
 * Fase B3.2 — domini staff/todo/fornitori, HACCP e inventario.
 *
 * Vincoli riscritti (stesso PR delle query, regola B1):
 * - haccp_temperature_readings  UNIQUE(date, location)    → (tenant_id, date, location)
 * - haccp_oil_checks            UNIQUE(date, fryer_label) → (tenant_id, date, fryer_label)
 * - haccp_cleaning_checks       UNIQUE(date, point)       → (tenant_id, date, point)
 *   (due cucine con una "Cella 1" collidevano ogni giorno)
 * - inventory_locations/categories UNIQUE(area, name)     → (tenant_id, area, name)
 * - inventory_products: indice unico su (area, categoria, nome) → + tenant_id
 *
 * NON si toccano: staff_shifts UNIQUE(staff_id, date, shift) e
 * inventory_stock PK (product_id, location_id) — le FK sono già scopate
 * per tenant, il vincolo è intrinsecamente sicuro.
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
    pgm.sql(dropUniques('haccp_temperature_readings'));
    pgm.sql(`ALTER TABLE haccp_temperature_readings ADD CONSTRAINT haccp_temperature_readings_tenant_date_location_key UNIQUE (tenant_id, date, location);`);

    pgm.sql(dropUniques('haccp_oil_checks'));
    pgm.sql(`ALTER TABLE haccp_oil_checks ADD CONSTRAINT haccp_oil_checks_tenant_date_fryer_key UNIQUE (tenant_id, date, fryer_label);`);

    pgm.sql(dropUniques('haccp_cleaning_checks'));
    pgm.sql(`ALTER TABLE haccp_cleaning_checks ADD CONSTRAINT haccp_cleaning_checks_tenant_date_point_key UNIQUE (tenant_id, date, point);`);

    pgm.sql(dropUniques('inventory_locations'));
    pgm.sql(`ALTER TABLE inventory_locations ADD CONSTRAINT inventory_locations_tenant_area_name_key UNIQUE (tenant_id, area, name);`);

    pgm.sql(dropUniques('inventory_categories'));
    pgm.sql(`ALTER TABLE inventory_categories ADD CONSTRAINT inventory_categories_tenant_area_name_key UNIQUE (tenant_id, area, name);`);

    pgm.sql(`DROP INDEX IF EXISTS uniq_inventory_products_area_cat_name;`);
    pgm.sql(`CREATE UNIQUE INDEX uniq_inventory_products_area_cat_name ON inventory_products (tenant_id, area, COALESCE(category_id, 0), name);`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE haccp_temperature_readings DROP CONSTRAINT IF EXISTS haccp_temperature_readings_tenant_date_location_key;`);
    pgm.sql(`ALTER TABLE haccp_temperature_readings ADD CONSTRAINT haccp_temperature_readings_date_location_key UNIQUE (date, location);`);
    pgm.sql(`ALTER TABLE haccp_oil_checks DROP CONSTRAINT IF EXISTS haccp_oil_checks_tenant_date_fryer_key;`);
    pgm.sql(`ALTER TABLE haccp_oil_checks ADD CONSTRAINT haccp_oil_checks_date_fryer_label_key UNIQUE (date, fryer_label);`);
    pgm.sql(`ALTER TABLE haccp_cleaning_checks DROP CONSTRAINT IF EXISTS haccp_cleaning_checks_tenant_date_point_key;`);
    pgm.sql(`ALTER TABLE haccp_cleaning_checks ADD CONSTRAINT haccp_cleaning_checks_date_point_key UNIQUE (date, point);`);
    pgm.sql(`ALTER TABLE inventory_locations DROP CONSTRAINT IF EXISTS inventory_locations_tenant_area_name_key;`);
    pgm.sql(`ALTER TABLE inventory_locations ADD CONSTRAINT inventory_locations_area_name_key UNIQUE (area, name);`);
    pgm.sql(`ALTER TABLE inventory_categories DROP CONSTRAINT IF EXISTS inventory_categories_tenant_area_name_key;`);
    pgm.sql(`ALTER TABLE inventory_categories ADD CONSTRAINT inventory_categories_area_name_key UNIQUE (area, name);`);
    pgm.sql(`DROP INDEX IF EXISTS uniq_inventory_products_area_cat_name;`);
    pgm.sql(`CREATE UNIQUE INDEX uniq_inventory_products_area_cat_name ON inventory_products (area, COALESCE(category_id, 0), name);`);
};
