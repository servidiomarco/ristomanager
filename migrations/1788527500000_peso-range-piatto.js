// Vendita al peso, rifinitura: ogni piatto ha il SUO range di pesi e il suo
// punto di partenza (un filetto non parte da 500 g come una bistecca).
// Solo guida per la battuta — chip e stepper del foglio; il server continua
// ad accettare il peso vero della bilancia (1..50000), che non mente.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE dishes ADD COLUMN IF NOT EXISTS weight_min_grams integer;
    ALTER TABLE dishes ADD COLUMN IF NOT EXISTS weight_max_grams integer;
    ALTER TABLE dishes ADD COLUMN IF NOT EXISTS weight_default_grams integer;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE dishes DROP COLUMN IF EXISTS weight_default_grams;
    ALTER TABLE dishes DROP COLUMN IF EXISTS weight_max_grams;
    ALTER TABLE dishes DROP COLUMN IF EXISTS weight_min_grams;
  `);
};
