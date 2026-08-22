// Card dev board #27 — blacklist clienti.
// Flag sul cliente in rubrica: lo staff vede un avviso quando crea a mano una
// prenotazione per un numero in blacklist; il booking web e l'agente vocale
// la rifiutano da soli. La colonna reason esiste perché tra sei mesi nessuno
// ricorda PERCHÉ un cliente è finito in blacklist, e la decisione di toglierlo
// ha bisogno di quel contesto.
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_blacklisted BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS blacklist_reason TEXT;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE customers DROP COLUMN IF EXISTS blacklist_reason;
    ALTER TABLE customers DROP COLUMN IF EXISTS is_blacklisted;
  `);
};
