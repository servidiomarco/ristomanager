/**
 * Note sulle varianti, per la sala e per la cucina.
 *
 * - `modifier_groups.note`: la guida discorsiva del gruppo (es. i gradi di
 *   cottura spiegati, con l'avvertenza sulle carni bianche). Si legge dal
 *   foglio varianti del palmare, espandibile. È campo del CRM anche sui
 *   gruppi della cassa: il sync Passepartout non la tocca.
 * - `modifiers.note`: la nota breve della singola opzione (es. «48–52°C al
 *   cuore»). Compare accanto al nome sul foglio varianti e sulla riga del
 *   monitor cucina — è il promemoria del cuoco alla griglia.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE modifier_groups ADD COLUMN IF NOT EXISTS note TEXT;`);
    pgm.sql(`ALTER TABLE modifiers ADD COLUMN IF NOT EXISTS note TEXT;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE modifiers DROP COLUMN IF EXISTS note;`);
    pgm.sql(`ALTER TABLE modifier_groups DROP COLUMN IF EXISTS note;`);
};
