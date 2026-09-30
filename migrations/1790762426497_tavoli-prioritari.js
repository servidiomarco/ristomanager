/**
 * Ordine di assegnazione dei tavoli.
 *
 * L'assegnazione automatica di Sofia, WhatsApp e /prenota sceglie il tavolo
 * libero più piccolo che basta, a parità di posti quello creato per primo:
 * al Vecchio Frantoio le coppie finivano sempre al 29 della Veranda, e il
 * gestore non aveva modo di cambiarlo (il prompt della logica tavoli entra in
 * gioco solo quando il tavolo automatico non c'è). Con assign_priority il
 * ristoratore numera in piantina, sala per sala, i tavoli da riempire per
 * primi: 1 prima di 2, prima di 3; a pari numero vince il più piccolo che
 * basta; i tavoli senza numero vengono dopo tutti gli altri.
 *
 * Nullable, e NULL vuol dire «nessuna priorità»: la replica verso il nodo di
 * sala riscrive le righe con jsonb_populate_recordset, che mette NULL a una
 * chiave assente, quindi un nodo e un cloud a versioni diverse restano
 * coerenti senza bloccare la replica dei tavoli.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE tables ADD COLUMN IF NOT EXISTS assign_priority INTEGER
            CHECK (assign_priority IS NULL OR assign_priority BETWEEN 1 AND 99);
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE tables DROP COLUMN IF EXISTS assign_priority;`);
};
