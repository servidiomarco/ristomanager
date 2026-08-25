/**
 * Chiusura proforma via Passepartout — il doc_type PROFORMA.
 *
 * Un conto del gestionale chiuso "tutto a sospeso" dal CRM produce in cassa
 * una proforma (documento NON fiscale) e il conto resta da regolarizzare.
 * La riga in fiscal_documents serve alla card Scontrino per raccontare lo
 * stato — provider 'passepartout', provider_ref NULL (non c'è numero
 * fiscale) — e il CHECK nato con la tabella ammetteva solo RECEIPT.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_doc_type_check;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_doc_type_check CHECK (doc_type IN ('RECEIPT', 'PROFORMA'));`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_doc_type_check;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_doc_type_check CHECK (doc_type IN ('RECEIPT'));`);
};
