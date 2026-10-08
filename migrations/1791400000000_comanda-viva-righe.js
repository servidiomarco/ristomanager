/**
 * Comanda viva, fase 2: le righe del CRM scritte nella comanda in cassa.
 *
 * Le prove sulla cassa vera (docs/passepartout-comanda-viva-prove.md, 07 e
 * 08/10/2026) hanno deciso il modo: il CRM scrive solo le sue righe e
 * confronta l'ordine con quello che ha già scritto (passepartout_righe_vive).
 * Il giro quindi non ha bisogno dei numeri di versione della fase 1, che
 * restano senza uso.
 *
 * - passepartout_config.comande_vive_dal: quando l'interruttore è stato
 *   acceso. Vanno in cassa solo gli ordini aperti da allora: accendendo a
 *   servizio iniziato, i tavoli già battuti in cassa non si raddoppiano.
 * - passepartout_comande_vive senza la chiave esterna verso orders: con la
 *   cancellazione forzata di un ordine (DELETE /orders/:id?forza=1) la riga
 *   resta, e il giro toglie dalla cassa le righe che il CRM ci aveva
 *   scritto. Con ON DELETE CASCADE sarebbero rimaste in cassa per sempre.
 * - passepartout_righe_vive.prezzo_cents_scritto: il prezzo scritto, per
 *   riscrivere solo le righe che il CRM ha cambiato (non quelle ritoccate
 *   in cassa: la cassa conserva).
 * - passepartout_righe_vive.sparita: la riga è stata tolta in cassa. Il CRM
 *   non la rimette e non la tocca più.
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
            ADD COLUMN IF NOT EXISTS comande_vive_dal TIMESTAMPTZ;
        UPDATE passepartout_config SET comande_vive_dal = now()
         WHERE comande_vive_enabled AND comande_vive_dal IS NULL;

        ALTER TABLE passepartout_righe_vive
            ADD COLUMN IF NOT EXISTS prezzo_cents_scritto INTEGER,
            ADD COLUMN IF NOT EXISTS sparita BOOLEAN NOT NULL DEFAULT false;

        DO $$
        DECLARE fk text;
        BEGIN
            SELECT con.conname INTO fk
              FROM pg_constraint con
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
             WHERE con.conrelid = 'passepartout_comande_vive'::regclass
               AND con.contype = 'f' AND att.attname = 'order_id'
               AND con.confrelid = 'orders'::regclass;
            IF fk IS NOT NULL THEN
                EXECUTE format('ALTER TABLE passepartout_comande_vive DROP CONSTRAINT %I', fk);
            END IF;
        END $$;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        DELETE FROM passepartout_comande_vive v
         WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = v.order_id);
        ALTER TABLE passepartout_comande_vive
            ADD CONSTRAINT passepartout_comande_vive_order_id_fkey
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
        ALTER TABLE passepartout_righe_vive
            DROP COLUMN IF EXISTS prezzo_cents_scritto,
            DROP COLUMN IF EXISTS sparita;
        ALTER TABLE passepartout_config DROP COLUMN IF EXISTS comande_vive_dal;
    `);
};
