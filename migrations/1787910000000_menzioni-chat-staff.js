/* Menzioni nella chat staff (piano §9): dentro un canale si può richiamare
 * l'attenzione di un collega con @Nome. Gli id menzionati stanno in una
 * colonna propria — mai riestratti dal testo, che è libero — così la push
 * mirata e l'evidenziazione client leggono un dato certo.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS mentioned_user_ids INTEGER[];`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE staff_messages DROP COLUMN IF EXISTS mentioned_user_ids;`);
};
