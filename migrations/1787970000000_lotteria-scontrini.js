/* Lotteria degli scontrini: il cliente detta il suo codice lotteria alla
 * chiusura e finisce nel documento commerciale (campo lottery_code del
 * payload Openapi, che il builder supportava già ma nessuno alimentava).
 * Vive sul conto, non sul documento: si raccoglie in cassa prima che il
 * documento esista, e il retry di un'emissione fallita lo ritrova qui.
 * VARCHAR(16) largo: il codice AdE è 8 alfanumerici, ma il formato non è
 * nostro e non si migra una colonna per un carattere in più. */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills ADD COLUMN lottery_code VARCHAR(16);`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills DROP COLUMN IF EXISTS lottery_code;`);
};
