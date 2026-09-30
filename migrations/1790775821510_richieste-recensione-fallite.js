/**
 * Recensioni: quando una richiesta di recensione non è partita.
 *
 * L'avviso «richieste di recensione non partite» raccoglie i fallimenti della
 * giornata del ristorante. Fin qui la prenotazione ricordava solo quando la
 * richiesta era USCITA (review_request_sent_at); per un fallimento non c'era
 * un'ora, e la data della visita non basta — la richiesta parte ore dopo,
 * spesso la mattina seguente. Le righe già fallite restano NULL: l'avviso
 * guarda solo avanti.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE reservations ADD COLUMN IF NOT EXISTS review_request_failed_at TIMESTAMPTZ;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE reservations DROP COLUMN IF EXISTS review_request_failed_at;`);
};
