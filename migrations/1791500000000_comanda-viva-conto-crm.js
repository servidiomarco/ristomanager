/**
 * Comanda viva, fase 4c: «conto: il CRM».
 *
 * passepartout_comande_vive.conto_crm_bill_id: il conto che il CRM ha fatto
 * con le sue righe per la comanda in cassa dell'ordine. Il conto porta
 * external_ref «pp:comanda:<id>» come quelli importati dalla cassa (così il
 * saldo chiude la comanda in cassa e lo scontrino lo fa la cassa), ma non
 * va mai riallineato alle righe della cassa: questo lo distingue.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_comande_vive
            ADD COLUMN IF NOT EXISTS conto_crm_bill_id INTEGER REFERENCES table_bills(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS passepartout_comande_vive_conto_crm
            ON passepartout_comande_vive (tenant_id, conto_crm_bill_id) WHERE conto_crm_bill_id IS NOT NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS passepartout_comande_vive_conto_crm;
        ALTER TABLE passepartout_comande_vive DROP COLUMN IF EXISTS conto_crm_bill_id;
    `);
};
