/* Lotteria degli scontrini: il codice del cliente dettato in cassa viaggia
 * sul conto e finisce nel documento commerciale (campo lottery_code del
 * payload Openapi, che il builder supporta già). Vive sul conto, non sul
 * documento: si raccoglie prima che il documento esista, e il retry di
 * un'emissione fallita lo ritrova qui. VARCHAR(16) largo: il codice AdE è
 * 8 alfanumerici, ma il formato non è nostro. */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills ADD COLUMN lottery_code VARCHAR(16);`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE table_bills DROP COLUMN IF EXISTS lottery_code;`);
};
