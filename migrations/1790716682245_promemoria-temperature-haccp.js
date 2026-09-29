/**
 * HACCP: promemoria di sistema «temperature mancanti».
 *
 * Una riga di reminders per ristorante con system_key HACCP_TEMPERATURES:
 * all'orario scelto il server controlla il registro di oggi e avvisa solo se
 * mancano rilevazioni (runHaccpMissingReminder). Orario, giorni e ruoli si
 * cambiano da Impostazioni → Promemoria come per il pane. Tace per chi il
 * registro non l'ha usato nell'ultimo mese, quindi seminarlo ovunque non
 * disturba chi l'HACCP non lo tiene nell'app.
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
            'Temperature HACCP',
            'Avvisa se a quest''ora mancano rilevazioni nel registro temperature di oggi.',
            'RECURRING', 'DAILY', '11:00',
            ARRAY['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'KITCHEN']::TEXT[], TRUE, 'HACCP_TEMPERATURES'
          FROM tenants t
         WHERE NOT EXISTS (
            SELECT 1 FROM reminders r
             WHERE r.tenant_id = t.id AND r.system_key = 'HACCP_TEMPERATURES'
         );
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM reminders WHERE system_key = 'HACCP_TEMPERATURES';`);
};
