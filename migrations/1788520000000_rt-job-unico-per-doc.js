/* Un solo job RT_FISCALE per documento fiscale, garantito dal DATABASE.
 * L'emissione rt-local è asincrona (il documento resta PENDING finché
 * l'agente non risponde) e più trigger sullo stesso conto — chiusura
 * manuale + webhook di pagamento — possono accodare due job e far stampare
 * due scontrini. Il guard applicativo (NOT EXISTS su job vivo) ha due
 * buchi: la race fra trigger concorrenti, e il job già PRINTED che il
 * predicato non vede. Un indice unico chiude entrambi in modo atomico.
 *
 * (payload->>'fiscal_doc_id') è unico fra TUTTI i job RT_FISCALE: un doc si
 * emette una volta sola; un retry dopo un FAILED è un documento NUOVO (id
 * nuovo, l'indice one-live-per-bill ne crea un altro), quindi non collide. */
export const up = (pgm) => {
    // Bonifica difensiva: se esistessero già doppioni storici, l'indice non
    // si creerebbe. Teniamo il job più vecchio (quello che ha davvero
    // emesso), gli altri li marchiamo FAILED così escono dall'unicità.
    pgm.sql(`
        UPDATE print_jobs SET status = 'FAILED', error = COALESCE(error, 'doppione RT bonificato')
        WHERE kind = 'RT_FISCALE' AND id NOT IN (
            SELECT MIN(id) FROM print_jobs WHERE kind = 'RT_FISCALE'
            GROUP BY (payload->>'fiscal_doc_id')
        );
    `);
    pgm.sql(`
        CREATE UNIQUE INDEX print_jobs_rt_one_per_doc
            ON print_jobs ((payload->>'fiscal_doc_id'))
            WHERE kind = 'RT_FISCALE' AND status <> 'FAILED';
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS print_jobs_rt_one_per_doc;`);
};
