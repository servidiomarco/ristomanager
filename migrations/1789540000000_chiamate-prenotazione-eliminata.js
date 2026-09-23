/* Chiamata vocale la cui prenotazione è stata eliminata dal CRM.
 *
 * voice_calls.reservation_id è ON DELETE SET NULL: eliminando una
 * prenotazione nata da una telefonata, la chiamata restava senza
 * prenotazione e tornava fra le «Da ricontattare», con la notifica allo
 * staff (tre chiamate di prova del 23/09/2026, ma vale per ogni disdetta
 * eliminata invece che annullata). Il timestamp dice che una prenotazione
 * c'era: la route di DELETE lo scrive e segna la chiamata come gestita.
 *
 * Nessun riempimento dello storico: una volta azzerato reservation_id non
 * resta traccia di quale chiamata avesse una prenotazione.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE voice_calls ADD COLUMN IF NOT EXISTS reservation_deleted_at TIMESTAMPTZ;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE voice_calls DROP COLUMN IF EXISTS reservation_deleted_at;`);
};
