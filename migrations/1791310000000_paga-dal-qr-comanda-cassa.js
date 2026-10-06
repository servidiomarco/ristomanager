/**
 * Pagamento dal QR del tavolo di una comanda della cassa Passepartout.
 *
 * Il QR del tavolo mostrava «Paga il conto» solo per un conto aperto nel
 * CRM: un tavolo battuto tutto in cassa non aveva modo di pagare dal
 * telefono. Con l'interruttore acceso, il tavolo con una comanda aperta in
 * cassa (letta ogni minuto in passepartout_tavoli_aperti) mostra il tasto, e
 * al tocco il CRM importa la comanda come conto.
 *
 * - passepartout_config.qr_pagamento_enabled: l'interruttore, per
 *   ristorante. Tiene accesa anche la lettura delle comande aperte, a
 *   prescindere dai «Tavoli aperti in cassa» della sala.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS qr_pagamento_enabled BOOLEAN NOT NULL DEFAULT false;
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE passepartout_config DROP COLUMN IF EXISTS qr_pagamento_enabled;`);
};
