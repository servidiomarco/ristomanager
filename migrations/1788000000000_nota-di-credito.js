// Nota di credito (TD04): una fattura trasmessa a SDI non si annulla come
// uno scontrino — si storna con un documento uguale e contrario, che qui
// diventa un doc_type a sé, collegato alla fattura stornata.
//
// Gli indici "one live per bill/split" cambiano predicato: la nota di
// credito NON occupa il posto del documento vivo — a storno fatto la
// fattura è VOIDED e il conto deve poter riemettere scontrino o fattura,
// mentre la nota resta CONFIRMED per sempre come atto contabile. I tre
// ON CONFLICT che inferiscono questi indici (scontrino, proforma nativa,
// registrazione Passepartout) sono aggiornati nello stesso PR: senza il
// predicato identico l'inferenza fallisce a runtime.
//
// Timestamp 1788000000000: il precedente su main è 1787990000000; il
// cantiere nodo-di-sala deve rinumerarsi DOPO questo (avviso in PR #345).

export const up = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents DROP CONSTRAINT IF EXISTS fiscal_documents_doc_type_check;`);
    pgm.sql(`ALTER TABLE fiscal_documents ADD CONSTRAINT fiscal_documents_doc_type_check CHECK (doc_type IN ('RECEIPT', 'PROFORMA', 'INVOICE', 'CREDIT_NOTE'));`);
    // La fattura che questa nota storna. SET NULL e non CASCADE: la nota è
    // un atto contabile e sopravvive a qualunque pulizia della fattura.
    pgm.sql(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS related_doc_id BIGINT REFERENCES fiscal_documents(id) ON DELETE SET NULL;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_fiscal_documents_one_live_per_bill;`);
    pgm.sql(`
        CREATE UNIQUE INDEX idx_fiscal_documents_one_live_per_bill
        ON fiscal_documents(table_bill_id)
        WHERE status IN ('PENDING', 'CONFIRMED') AND table_bill_split_id IS NULL AND doc_type <> 'CREDIT_NOTE';
    `);
    pgm.sql(`DROP INDEX IF EXISTS idx_fiscal_documents_one_live_per_split;`);
    pgm.sql(`
        CREATE UNIQUE INDEX idx_fiscal_documents_one_live_per_split
        ON fiscal_documents(table_bill_split_id)
        WHERE status IN ('PENDING', 'CONFIRMED') AND table_bill_split_id IS NOT NULL AND doc_type <> 'CREDIT_NOTE';
    `);
};
