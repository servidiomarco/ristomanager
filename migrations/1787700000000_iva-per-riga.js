/**
 * IVA per riga — fase 2 del piano fatturazione
 * (docs/fatturazione-chiusura-conto-brainstorm.md).
 *
 * Il documento commerciale e la fattura elettronica vogliono i totali per
 * aliquota, quindi l'aliquota deve nascere sulla riga, non essere dedotta a
 * posteriori. Due colonne:
 *
 *  - dishes.vat_rate: l'aliquota di anagrafica del piatto. Default 10
 *    (somministrazione in loco); il ristoratore la cambia dal menù per i
 *    casi diversi (es. 22 su alcolici da asporto, 4 su pane).
 *  - order_items.vat_rate: SNAPSHOT alla battitura, come il prezzo — se
 *    domani l'aliquota di anagrafica cambia, la comanda di ieri non si
 *    muove. Le righe di sistema (coperto/servizio) la ricevono dal codice.
 *
 * CHECK largo (0..100) invece dell'elenco {0,4,5,10,22}: le aliquote le
 * cambia la legge, non una migration — la UI propone l'elenco, il DB non
 * lo blinda. Il backfill a 10 delle righe esistenti è il default PG
 * (colonna NOT NULL DEFAULT su PG11+: instant, niente riscrittura).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE dishes
            ADD COLUMN IF NOT EXISTS vat_rate SMALLINT NOT NULL DEFAULT 10
            CONSTRAINT dishes_vat_rate_range CHECK (vat_rate BETWEEN 0 AND 100);
    `);
    pgm.sql(`
        ALTER TABLE order_items
            ADD COLUMN IF NOT EXISTS vat_rate SMALLINT NOT NULL DEFAULT 10
            CONSTRAINT order_items_vat_rate_range CHECK (vat_rate BETWEEN 0 AND 100);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE order_items DROP COLUMN IF EXISTS vat_rate;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS vat_rate;`);
};
