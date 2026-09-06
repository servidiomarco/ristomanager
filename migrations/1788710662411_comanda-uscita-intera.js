/**
 * Comanda con l'uscita intera, per partita.
 *
 * Agli antipasti si compone il piatto d'apertura guardando cosa esce
 * insieme: la carta della partita deve dire anche cosa fanno gli altri
 * centri nella stessa uscita, come già fa il piede della card sul
 * monitor. Col flag acceso, il ticket COMANDA della partita porta in
 * coda — in corpo piccolo, per partita — i piatti delle altre partite
 * dell'uscita. Spento di default: alla griglia non interessa la
 * carbonara, e la carta in più è solo rumore.
 */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE stations ADD COLUMN IF NOT EXISTS full_course BOOLEAN NOT NULL DEFAULT false;`);
};

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE stations DROP COLUMN IF EXISTS full_course;`);
};
