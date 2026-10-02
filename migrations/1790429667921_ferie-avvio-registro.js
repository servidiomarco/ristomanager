/**
 * Piano ferie: avvio del registro ferie del ristorante.
 *
 * Il monte annuo ora si proporziona ai mesi di contratto (rateo mensile).
 * Ma le date d'assunzione già sulle schede sono spesso il giorno in cui la
 * scheda è entrata nell'app, non l'assunzione vera: al Vecchio Frantoio tre
 * schede risultano «assunte» il 1° aprile 2026, l'avvio. Chi risulta assunto
 * fino a leave_start_date matura quindi da inizio anno; NULL = tutte le
 * date d'assunzione sono vere.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE staff_leave_settings ADD COLUMN IF NOT EXISTS leave_start_date DATE;`);

    // Chi ha già le regole salvate parte dal giorno in cui ha creato la sua
    // prima scheda del personale: è l'avvio vero, e senza questo il rateo
    // appena acceso toglierebbe mesi a chi risulta «assunto» all'avvio
    // (26 → 19,5 giorni per un fisso al Vecchio Frantoio). Si cambia dalle
    // Regole del piano ferie.
    pgm.sql(`
        UPDATE staff_leave_settings s
           SET leave_start_date = f.first_card
          FROM (SELECT tenant_id, MIN(created_at)::date AS first_card
                  FROM staff_members GROUP BY tenant_id) f
         WHERE f.tenant_id = s.tenant_id AND s.leave_start_date IS NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE staff_leave_settings DROP COLUMN IF EXISTS leave_start_date;`);
};
