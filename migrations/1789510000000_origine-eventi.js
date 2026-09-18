/* L'origine degli eventi (tappa 4 ibrido, fase 4a — lo stream inverso).
 *
 * Con la replica bidirezionale ogni lato tiene nel proprio outbox sia gli
 * eventi che ha PRODOTTO ('local') sia quelli IMPORTATI dall'altro lato
 * ('replica', per far girare i broadcast dai handler del dispatcher con la
 * stessa atomicità di sempre). Il filtro sull'origine è ciò che chiude il
 * cerchio senza eco: ogni lato spedisce all'altro SOLO i propri 'local' —
 * un evento non torna mai da dove è venuto.
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE outbox_events
            ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'local';
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE outbox_events DROP COLUMN IF EXISTS origin;`);
};
