/* Stato 'PRINTING' per print_jobs: il claim atomico dei documenti fiscali.
 * Un job RT_FISCALE non si può emettere due volte — un secondo poll
 * dell'agente (o un secondo agente) che ripesca lo stesso PENDING stampa un
 * secondo scontrino fiscale vero. Il claim porta il job a PRINTING; il poll
 * vede solo i PENDING, quindi solo chi vince il claim emette. */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;`);
    pgm.sql(`ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
             CHECK (status IN ('PENDING', 'PRINTING', 'PRINTED', 'FAILED'));`);
};

export const down = (pgm) => {
    pgm.sql(`UPDATE print_jobs SET status = 'PENDING' WHERE status = 'PRINTING';`);
    pgm.sql(`ALTER TABLE print_jobs DROP CONSTRAINT IF EXISTS print_jobs_status_check;`);
    pgm.sql(`ALTER TABLE print_jobs ADD CONSTRAINT print_jobs_status_check
             CHECK (status IN ('PENDING', 'PRINTED', 'FAILED'));`);
};
