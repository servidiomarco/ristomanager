// Card dev board #32 — lingua ospite: schema e rilevamento.
// Fondazione multi-lingua: solo le colonne, nessuna UI tradotta ancora.
// customers/reservations/users.language restano NULL finché un canale non
// la rileva (widget pubblico, prefisso WhatsApp, ElevenLabs); tenants.language
// ha un default perché serve subito come fallback quando nessun segnale è
// disponibile (es. prenotazione creata a mano dallo staff).
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS language VARCHAR(5);
    ALTER TABLE reservations ADD COLUMN IF NOT EXISTS language VARCHAR(5);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS language VARCHAR(5);
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS default_language VARCHAR(5) NOT NULL DEFAULT 'it';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants DROP COLUMN IF EXISTS default_language;
    ALTER TABLE users DROP COLUMN IF EXISTS language;
    ALTER TABLE reservations DROP COLUMN IF EXISTS language;
    ALTER TABLE customers DROP COLUMN IF EXISTS language;
  `);
};
