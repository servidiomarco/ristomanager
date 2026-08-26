/**
 * Fattura elettronica — fase 4 del piano fatturazione
 * (docs/fatturazione-chiusura-conto-brainstorm.md).
 *
 * Tre pezzi:
 *
 * 1. customers.billing (JSONB): i dati di fatturazione del cliente —
 *    denominazione, P.IVA, CF, codice destinatario SDI, PEC, indirizzo.
 *    Una colonna sola invece di sei: il CRUD clienti ha liste di colonne
 *    esplicite in quattro punti e il blob attraversa tutto senza churn.
 *
 * 2. fiscal_documents impara le fatture: doc_type 'INVOICE' (accanto a
 *    RECEIPT e al PROFORMA introdotto dalla migration documento-proforma —
 *    la CHECK va riscritta con TUTTI i tipi, non solo i nostri),
 *    table_bill_split_id (la fattura sulla quota dell'azienda al tavolo
 *    misto), doc_number (numerazione nostra, non del provider).
 *    L'indice unico "un documento vivo per conto" si sdoppia:
 *      - un documento vivo A LIVELLO CONTO (split IS NULL) — scontrino O
 *        fattura sull'intero: mai entrambi;
 *      - un documento vivo PER QUOTA (split IS NOT NULL).
 *    La coesistenza scontrino-intero + fattura-su-quota resta vietata, ma
 *    dal codice (il doppio binario fiscale sullo stesso importo è la cosa
 *    da impedire, e un indice non sa sommare).
 *
 * 3. invoice_counters: numerazione progressiva per tenant e anno, presa
 *    sotto lock di riga. Il numero è un obbligo di legge e non può avere
 *    buchi allegri né doppioni: MAX+1 senza lock li produce entrambi.
 *
 * RLS su invoice_counters: policy copiata verbatim da quella in uso (vedi
 * 1787390463706_table-assignment-suggestions.js per la stessa nota).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS billing JSONB;`);

    pgm.sql(`ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_doc_type_check;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_doc_type_check CHECK (doc_type IN ('RECEIPT', 'PROFORMA', 'INVOICE'));`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS table_bill_split_id INTEGER REFERENCES table_bill_splits(id) ON DELETE SET NULL;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS doc_number TEXT;`);

    pgm.sql(`DROP INDEX IF EXISTS idx_fiscal_documents_one_live_per_bill;`);
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_documents_one_live_per_bill
            ON fiscal_documents(table_bill_id)
            WHERE status IN ('PENDING', 'CONFIRMED') AND table_bill_split_id IS NULL;
    `);
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_documents_one_live_per_split
            ON fiscal_documents(table_bill_split_id)
            WHERE status IN ('PENDING', 'CONFIRMED') AND table_bill_split_id IS NOT NULL;
    `);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS invoice_counters (
            tenant_id   BIGINT NOT NULL,
            year        INTEGER NOT NULL,
            last_number INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (tenant_id, year)
        );
    `);

    pgm.sql(`ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE invoice_counters FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON invoice_counters;`);
    // Espressione copiata verbatim da quella già in uso (vedi nota sopra).
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
    pgm.sql(`
        CREATE POLICY tenant_isolation ON invoice_counters
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_doc_type_check;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_doc_type_check CHECK (doc_type IN ('RECEIPT', 'PROFORMA'));`);
    pgm.sql(`DROP TABLE IF EXISTS invoice_counters;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_fiscal_documents_one_live_per_split;`);
    pgm.sql(`ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS doc_number;`);
    pgm.sql(`ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS table_bill_split_id;`);
    pgm.sql(`ALTER TABLE customers DROP COLUMN IF EXISTS billing;`);
};
