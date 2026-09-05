/**
 * Traduzione inglese del nome dell'opzione, per il cameriere.
 *
 * Nata dai gradi di cottura («Al sangue» → «Rare»): serve sul foglio
 * varianti quando al tavolo c'è un cliente straniero, NON in cucina — il
 * cuoco legge la nota (temperatura al cuore), la traduzione lì è rumore.
 * Per questo è un campo suo e non un pezzo della nota.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE modifiers ADD COLUMN IF NOT EXISTS name_en TEXT;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE modifiers DROP COLUMN IF EXISTS name_en;`);
};
