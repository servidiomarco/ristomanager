/**
 * Sconto sul conto (operazioni di cassa).
 *
 * Lo sconto esisteva solo sulla comanda APERTA: al momento dell'incasso la
 * comanda è già chiusa e la route lo rifiutava, e un conto aperto a mano
 * (senza comanda) non era scontabile affatto. Le stesse quattro colonne di
 * `orders` passano su `table_bills`: il totale le applica in
 * syncBillTotalInTx DOPO la somma delle comande, così i due sconti
 * compongono invece di escludersi.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE table_bills
      ADD COLUMN IF NOT EXISTS discount_type VARCHAR(10) CHECK (discount_type IN ('PERCENT','AMOUNT')),
      ADD COLUMN IF NOT EXISTS discount_value NUMERIC(10,2) CHECK (discount_value >= 0),
      ADD COLUMN IF NOT EXISTS discount_reason TEXT,
      ADD COLUMN IF NOT EXISTS discount_by_user_id INTEGER REFERENCES users(id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE table_bills
      DROP COLUMN IF EXISTS discount_type,
      DROP COLUMN IF EXISTS discount_value,
      DROP COLUMN IF EXISTS discount_reason,
      DROP COLUMN IF EXISTS discount_by_user_id;
  `);
};
