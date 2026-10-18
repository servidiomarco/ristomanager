/**
 * Avviso «il tavolo ha pagato» dalla cassa Passepartout.
 *
 * Quando una comanda sparisce dalla lettura dei tavoli aperti e, riletta,
 * risulta pagata, titolare, GM, manager e reception ricevono un modal che
 * propone di liberare il tavolo della prenotazione seduta. Acceso di serie:
 * vale solo dove la lettura dei tavoli aperti è già accesa, e lo spegne
 * l'interruttore in Impostazioni → Passepartout → Tavoli aperti in cassa.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config ADD COLUMN IF NOT EXISTS tavolo_pagato_avviso BOOLEAN NOT NULL DEFAULT true;
    `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config DROP COLUMN IF EXISTS tavolo_pagato_avviso;
    `);
};
