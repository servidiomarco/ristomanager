/**
 * Fatture fornitori — dall'XML della fattura elettronica al carico del
 * magazzino (e, col food cost, al prezzo degli ingredienti).
 *
 * Le fatture arrivano come file (XML, p7m, zip) e restano uno strato
 * operativo: la contabilità è del commercialista, qui servono le righe.
 *
 * - fatture_fornitori_file: l'XML com'era (già tolto dal p7m), una volta
 *   sola per ristorante (sha256). Serve a rileggere la fattura e a tirare
 *   fuori il PDF di cortesia, che resta dentro l'XML.
 * - fatture_fornitori: la testata. Una fattura è unica per fornitore,
 *   numero, data e tipo: ricaricare lo stesso file, o lo stesso documento
 *   arrivato in un altro zip, non la duplica. Il fornitore si riconosce dalla
 *   P.IVA (chiave_fornitore), anche quando non è ancora collegato a una riga
 *   di suppliers.
 * - fatture_fornitori_righe: le righe, già classificate (merce, nota,
 *   sconto, spesa, servizio), con la decisione presa: CARICO su un prodotto
 *   con i suoi fattori, o IGNORA con una categoria di spesa.
 * - fornitori_articoli: la memoria. La stessa merce dello stesso fornitore
 *   (per EAN, codice o descrizione) alla fattura dopo si riconosce da sola.
 *   Si scrive solo quando qualcuno conferma il carico.
 * - suppliers.vat_number: la P.IVA, per collegare le fatture al fornitore.
 * - inventory_movements.fattura_riga_id e lotto: il carico sa da quale riga
 *   di quale fattura viene, e il lotto serve alla rintracciabilità.
 * - Permesso inventory:invoices: le fatture portano i prezzi d'acquisto,
 *   riservati come i costi del food cost (la cucina ha inventory:full ma non
 *   li vede). A titolare, direzione e manager.
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

const CATEGORIE_SPESA = `('cibo', 'bevande', 'pulizia', 'monouso', 'personale', 'servizi', 'altro')`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ---- Fornitori: la P.IVA ------------------------------------------------
    pgm.sql(`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS vat_number VARCHAR(30);`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_suppliers_vat_number
             ON suppliers (tenant_id, vat_number) WHERE vat_number IS NOT NULL;`);

    // ---- I file -------------------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fatture_fornitori_file (
            id          SERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            nome        VARCHAR(255) NOT NULL,
            sha256      CHAR(64) NOT NULL,
            xml         TEXT NOT NULL,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, sha256)
        );
    `);

    // ---- Le testate ---------------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fatture_fornitori (
            id                   SERIAL PRIMARY KEY,
            tenant_id            BIGINT NOT NULL,
            file_id              INTEGER NOT NULL REFERENCES fatture_fornitori_file(id) ON DELETE CASCADE,
            indice_body          SMALLINT NOT NULL DEFAULT 0,
            supplier_id          UUID REFERENCES suppliers(id) ON DELETE SET NULL,
            chiave_fornitore     VARCHAR(60) NOT NULL,
            cedente_piva         VARCHAR(30),
            cedente_nome         VARCHAR(255) NOT NULL,
            cedente              JSONB NOT NULL DEFAULT '{}'::jsonb,
            tipo_documento       VARCHAR(4) NOT NULL,
            numero               VARCHAR(40) NOT NULL,
            data                 DATE NOT NULL,
            importo_totale_cents INTEGER,
            imponibile_cents     INTEGER NOT NULL DEFAULT 0,
            imposta_cents        INTEGER NOT NULL DEFAULT 0,
            dati                 JSONB NOT NULL DEFAULT '{}'::jsonb,
            stato                VARCHAR(16) NOT NULL DEFAULT 'DA_CONTROLLARE'
                                 CHECK (stato IN ('DA_CONTROLLARE', 'CARICATA', 'IGNORATA')),
            origine              VARCHAR(8) NOT NULL DEFAULT 'UPLOAD' CHECK (origine IN ('UPLOAD', 'EMAIL')),
            caricata_at          TIMESTAMPTZ,
            caricata_da          VARCHAR(255),
            created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_by           VARCHAR(255),
            UNIQUE (tenant_id, chiave_fornitore, tipo_documento, numero, data)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fatture_fornitori_elenco ON fatture_fornitori (tenant_id, stato, data DESC);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fatture_fornitori_supplier ON fatture_fornitori (tenant_id, supplier_id);`);

    // ---- Le righe -----------------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fatture_fornitori_righe (
            id                SERIAL PRIMARY KEY,
            tenant_id         BIGINT NOT NULL,
            fattura_id        INTEGER NOT NULL REFERENCES fatture_fornitori(id) ON DELETE CASCADE,
            numero_linea      INTEGER NOT NULL,
            tipo              VARCHAR(10) NOT NULL CHECK (tipo IN ('merce', 'nota', 'sconto', 'spesa', 'servizio')),
            descrizione       TEXT NOT NULL DEFAULT '',
            ean               VARCHAR(20),
            codice            VARCHAR(100),
            chiave_tipo       VARCHAR(12) CHECK (chiave_tipo IS NULL OR chiave_tipo IN ('ean', 'codice', 'descrizione')),
            chiave            VARCHAR(200),
            quantita          NUMERIC(14,4),
            unita_misura      VARCHAR(20),
            prezzo_unitario   NUMERIC(18,8) NOT NULL DEFAULT 0,
            prezzo_totale     NUMERIC(14,4) NOT NULL DEFAULT 0,
            aliquota_iva      NUMERIC(5,2) NOT NULL DEFAULT 0,
            lotto             VARCHAR(100),
            scadenza          VARCHAR(30),
            ddt               VARCHAR(40),
            esito             VARCHAR(8) CHECK (esito IS NULL OR esito IN ('CARICO', 'IGNORA')),
            da_memoria        BOOLEAN NOT NULL DEFAULT false,
            product_id        INTEGER REFERENCES inventory_products(id) ON DELETE SET NULL,
            fattore_magazzino NUMERIC(12,4) CHECK (fattore_magazzino IS NULL OR fattore_magazzino > 0),
            fattore_costo     NUMERIC(12,4) CHECK (fattore_costo IS NULL OR fattore_costo > 0),
            unita_costo       VARCHAR(2) CHECK (unita_costo IS NULL OR unita_costo IN ('kg', 'l', 'pz')),
            categoria_spesa   VARCHAR(12) CHECK (categoria_spesa IS NULL OR categoria_spesa IN ${CATEGORIE_SPESA}),
            movimento_id      INTEGER REFERENCES inventory_movements(id) ON DELETE SET NULL,
            prezzo_id         BIGINT REFERENCES food_cost_prezzi(id) ON DELETE SET NULL
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fatture_fornitori_righe_fattura ON fatture_fornitori_righe (fattura_id, numero_linea);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fatture_fornitori_righe_prodotto ON fatture_fornitori_righe (tenant_id, product_id) WHERE product_id IS NOT NULL;`);

    // ---- La memoria degli abbinamenti ---------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fornitori_articoli (
            id                SERIAL PRIMARY KEY,
            tenant_id         BIGINT NOT NULL,
            chiave_fornitore  VARCHAR(60) NOT NULL,
            chiave_tipo       VARCHAR(12) NOT NULL CHECK (chiave_tipo IN ('ean', 'codice', 'descrizione')),
            chiave            VARCHAR(200) NOT NULL,
            descrizione       TEXT,
            azione            VARCHAR(8) NOT NULL CHECK (azione IN ('CARICO', 'IGNORA')),
            product_id        INTEGER REFERENCES inventory_products(id) ON DELETE CASCADE,
            fattore_magazzino NUMERIC(12,4) CHECK (fattore_magazzino IS NULL OR fattore_magazzino > 0),
            fattore_costo     NUMERIC(12,4) CHECK (fattore_costo IS NULL OR fattore_costo > 0),
            unita_costo       VARCHAR(2) CHECK (unita_costo IS NULL OR unita_costo IN ('kg', 'l', 'pz')),
            categoria_spesa   VARCHAR(12) CHECK (categoria_spesa IS NULL OR categoria_spesa IN ${CATEGORIE_SPESA}),
            usi               INTEGER NOT NULL DEFAULT 1,
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, chiave_fornitore, chiave_tipo, chiave),
            CHECK (azione = 'IGNORA' OR (product_id IS NOT NULL AND fattore_magazzino IS NOT NULL))
        );
    `);

    // ---- Il carico sa da dove viene -----------------------------------------
    pgm.sql(`
        ALTER TABLE inventory_movements
            ADD COLUMN IF NOT EXISTS fattura_riga_id INTEGER REFERENCES fatture_fornitori_righe(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS lotto VARCHAR(100);
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_inventory_movements_fattura_riga ON inventory_movements (fattura_riga_id) WHERE fattura_riga_id IS NOT NULL;`);

    enableRls(pgm, 'fatture_fornitori_file');
    enableRls(pgm, 'fatture_fornitori');
    enableRls(pgm, 'fatture_fornitori_righe');
    enableRls(pgm, 'fornitori_articoli');

    // ---- Permesso -----------------------------------------------------------
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'inventory:invoices'
          FROM tenants t
         CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER')) AS r(role)
        ON CONFLICT DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'inventory:invoices';`);
    pgm.sql(`DROP INDEX IF EXISTS idx_inventory_movements_fattura_riga;`);
    pgm.sql(`ALTER TABLE inventory_movements DROP COLUMN IF EXISTS fattura_riga_id, DROP COLUMN IF EXISTS lotto;`);
    pgm.sql(`DROP TABLE IF EXISTS fornitori_articoli;`);
    pgm.sql(`DROP TABLE IF EXISTS fatture_fornitori_righe;`);
    pgm.sql(`DROP TABLE IF EXISTS fatture_fornitori;`);
    pgm.sql(`DROP TABLE IF EXISTS fatture_fornitori_file;`);
    pgm.sql(`DROP INDEX IF EXISTS uq_suppliers_vat_number;`);
    pgm.sql(`ALTER TABLE suppliers DROP COLUMN IF EXISTS vat_number;`);
};
