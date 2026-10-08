/**
 * Comanda viva, fase 3: chi stampa in cucina.
 *
 * - passepartout_righe_vive.stampata_crm: la riga l'ha stampata il CRM (la
 *   cassa non poteva mandarla, o la sua uscita era già del CRM). La cassa
 *   manda in produzione l'uscita intera: un'uscita con righe stampate dal
 *   CRM resta del CRM, o quelle righe uscirebbero due volte. La riga può
 *   esistere prima della scrittura in cassa (pp_riga_id NULL).
 * - «stampa: il CRM» con «conto: la cassa» non si può più scegliere: la
 *   cassa, chiudendo dal suo schermo, manda in produzione le righe del CRM
 *   mai partite (collaudo sulla demo, 08/10/2026). Chi l'aveva torna a
 *   «stampa: la cassa».
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_righe_vive
            ADD COLUMN IF NOT EXISTS stampata_crm BOOLEAN NOT NULL DEFAULT false;
        UPDATE passepartout_config SET comande_stampa = 'cassa', updated_at = now()
         WHERE comande_stampa = 'crm' AND comande_conto <> 'crm';
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_righe_vive DROP COLUMN IF EXISTS stampata_crm;
    `);
};
