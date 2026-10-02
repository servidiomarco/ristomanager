/**
 * Lista della spesa: promemoria di sistema «da comprare».
 *
 * Una riga di reminders per ristorante con system_key SHOPPING_LIST: all'ora
 * scelta il server conta gli articoli non spuntati e avvisa solo se ce ne
 * sono (runShoppingListReminder). Orario, giorni e destinatari si cambiano da
 * Impostazioni → Promemoria come per il pane e le temperature HACCP. Con la
 * lista vuota non suona, quindi seminarlo ovunque non disturba chi la lista
 * nell'app non la usa.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        INSERT INTO reminders
            (tenant_id, title, description, kind, frequency, schedule_time, target_roles, active, system_key)
        SELECT t.id,
            'Lista della spesa',
            'Avvisa se a quest''ora in lista ci sono articoli da comprare.',
            'RECURRING', 'DAILY', '09:30',
            ARRAY['OWNER', 'GENERAL_MANAGER', 'MANAGER']::TEXT[], TRUE, 'SHOPPING_LIST'
          FROM tenants t
         WHERE NOT EXISTS (
            SELECT 1 FROM reminders r
             WHERE r.tenant_id = t.id AND r.system_key = 'SHOPPING_LIST'
         );
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM reminders WHERE system_key = 'SHOPPING_LIST';`);
};
