// Vendita al peso: un solo articolo «Bistecca» col prezzo al kg al posto
// delle sei grammature finte. Il flag sta sul piatto; il peso sta sulla
// RIGA (grammi interi), perché due bistecche dello stesso tavolo pesano
// diverso e la cucina corregge il peso reale dopo il taglio.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE dishes ADD COLUMN IF NOT EXISTS sold_by_weight boolean NOT NULL DEFAULT false;
    ALTER TABLE order_items ADD COLUMN IF NOT EXISTS weight_grams integer;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE order_items DROP COLUMN IF EXISTS weight_grams;
    ALTER TABLE dishes DROP COLUMN IF EXISTS sold_by_weight;
  `);
};
