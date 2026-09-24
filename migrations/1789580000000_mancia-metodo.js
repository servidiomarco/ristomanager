/* Come è stata data la mancia.
 *
 * tip_cents era un numero senza metodo: 5 € di mancia in contanti a un conto
 * saldato col QR finivano sul conto ma non nei contanti attesi del cassetto,
 * e a fine turno la conta tornava con 5 € in più senza spiegazione (24/09).
 * tip_method dice dove sono finiti: CONTANTI entra nel cassetto, POS_FISICO
 * e SATISPAY no. NULL = mancia registrata prima di questa colonna, o da un
 * client che non lo manda.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE table_bills ADD COLUMN IF NOT EXISTS tip_method VARCHAR(20);
        ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_tip_method_check;
        ALTER TABLE table_bills ADD CONSTRAINT table_bills_tip_method_check
            CHECK (tip_method IS NULL OR tip_method IN ('CONTANTI', 'POS_FISICO', 'SATISPAY'));
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE table_bills DROP CONSTRAINT IF EXISTS table_bills_tip_method_check;
        ALTER TABLE table_bills DROP COLUMN IF EXISTS tip_method;
    `);
};
