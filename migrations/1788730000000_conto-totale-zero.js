/**
 * Il conto può valere zero.
 *
 * Il CHECK (total_cents > 0) imponeva un minimo tecnico di 1 centesimo:
 * con uno sconto pari all'intero conto (T206, collaudo del 6/09) il totale
 * restava a 0,01 € e la cassa chiedeva di incassare un centesimo che non
 * esiste. La chiusura comanda aveva già dovuto aggirarlo (le comande
 * annullate in blocco non aprono più il conto); qui si toglie il pavimento
 * alla radice: un conto interamente scontato vale 0 e si chiude saldato.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_total_cents_check;
    ALTER TABLE table_bills ADD CONSTRAINT table_bills_total_cents_check CHECK (total_cents >= 0);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    UPDATE table_bills SET total_cents = 1 WHERE total_cents = 0;
    ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_total_cents_check;
    ALTER TABLE table_bills ADD CONSTRAINT table_bills_total_cents_check CHECK (total_cents > 0);
  `);
};
