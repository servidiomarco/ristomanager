/* Quote ospite «per piatto» a unità.
 *
 * item_ids prende righe intere: «4× Coperto» si pagava tutto o niente, e al
 * tavolo da quattro chi pagava solo quello che aveva preso non poteva
 * prendersi il suo coperto (24/09). item_units = [{order_item_id, units}],
 * la stessa forma che gli incassi staff tengono in meta.item_units: una
 * riga si divide fra più quote, pezzo per pezzo.
 *
 * item_ids resta per le quote già esistenti e per un client vecchio nella
 * finestra fra i due deploy (riga intera = tutte le sue unità).
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE table_bill_splits ADD COLUMN IF NOT EXISTS item_units JSONB;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE table_bill_splits DROP COLUMN IF EXISTS item_units;`);
};
