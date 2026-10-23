/**
 * Codici a barre dei prodotti di magazzino.
 *
 * Un prodotto può averne più d'uno: lo stesso riso arriva da due fornitori,
 * o in due confezioni, con due EAN diversi. Un codice invece porta a un
 * prodotto solo per ristorante (UNIQUE tenant_id, code): è quello che rende
 * la scansione una risposta e non una domanda.
 *
 * Il codice è salvato già normalizzato (utils/barcode.ts): l'UPC-A a 12
 * cifre e il GTIN-14 con lo zero davanti diventano EAN-13, così il telefono
 * che legge «012345678905» e la fattura che scrive «0012345678905» trovano
 * la stessa riga.
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
        CREATE TABLE IF NOT EXISTS inventory_product_barcodes (
            id          SERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            product_id  INTEGER NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
            code        VARCHAR(64) NOT NULL,
            created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, code)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_inventory_product_barcodes_product ON inventory_product_barcodes (tenant_id, product_id);`);

    pgm.sql(`ALTER TABLE inventory_product_barcodes ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE inventory_product_barcodes FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON inventory_product_barcodes;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON inventory_product_barcodes
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS inventory_product_barcodes;`);
};
