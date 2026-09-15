/**
 * Asporto in cucina: la comanda TAKEAWAY può vivere senza tavolo.
 *
 * Il CHECK storico di orders (`reservation_id IS NOT NULL OR table_id IS NOT
 * NULL`) esiste perché una comanda di sala senza ancoraggio è un orfano che
 * nessuna superficie sa riaprire. L'ordine d'asporto invece l'ancoraggio ce
 * l'ha — takeaway_orders.kitchen_order_id — quindi il vincolo si allarga:
 * senza tavolo né prenotazione va bene SOLO se order_type = 'TAKEAWAY'.
 *
 * Il CHECK originale è anonimo (inline nella CREATE TABLE) e il suo nome
 * generato può variare fra database creati in epoche diverse: si cerca per
 * definizione, non per nome, e si rimette con un nome esplicito.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        DO $$
        DECLARE c text;
        BEGIN
            SELECT conname INTO c FROM pg_constraint
            WHERE conrelid = 'orders'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%reservation_id IS NOT NULL%'
              AND pg_get_constraintdef(oid) LIKE '%table_id IS NOT NULL%';
            IF c IS NOT NULL THEN
                EXECUTE format('ALTER TABLE orders DROP CONSTRAINT %I', c);
            END IF;
        END $$;
    `);
    pgm.sql(`ALTER TABLE orders ADD CONSTRAINT orders_anchor_check
             CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL OR order_type = 'TAKEAWAY');`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_anchor_check;`);
    pgm.sql(`ALTER TABLE orders ADD CONSTRAINT orders_anchor_check
             CHECK (reservation_id IS NOT NULL OR table_id IS NOT NULL);`);
};
