/**
 * Fase A4 del piano SaaS: i turni di servizio non sono più un vincolo di
 * schema. Il CHECK (shift IN ('LUNCH','DINNER')) era inciso in 8 punti
 * (table_merges, table_hidden_overrides, room_closed_overrides,
 * staff_shifts, staff_time_off, opening_hours_disabled_slots, orders) e
 * rendeva irrappresentabile un ristorante con orario continuato o tre
 * turni. L'invariante si sposta in applicazione: il middleware globale in
 * server.ts rifiuta con 400 qualunque body con un turno sconosciuto.
 *
 * Il drop è dinamico su pg_constraint invece che per nome: i CHECK inline
 * hanno nomi auto-generati e un elenco scritto a mano si desincronizza. La
 * regex prende qualunque constraint di tipo CHECK la cui definizione
 * contenga shift + 'LUNCH', su qualunque tabella.
 *
 * Su un database vuoto createSchema (che gira PRIMA delle migration) crea
 * ancora i CHECK: questa migration li toglie subito dopo, e i CREATE/ALTER
 * IF NOT EXISTS dei boot successivi non li ricreano.
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
        DECLARE c RECORD;
        BEGIN
            FOR c IN
                SELECT conrelid::regclass AS tbl, conname
                  FROM pg_constraint
                 WHERE contype = 'c'
                   AND pg_get_constraintdef(oid) ~ 'shift.*''LUNCH'''
            LOOP
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
            END LOOP;
        END $$;
    `);
};

/**
 * Ripristina i CHECK storici sulle tabelle note. Prima del down vanno
 * rimosse (o corrette) le eventuali righe con turni fuori dall'enum.
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE table_merges ADD CONSTRAINT table_merges_shift_check CHECK (shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE table_hidden_overrides ADD CONSTRAINT table_hidden_overrides_shift_check CHECK (shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE room_closed_overrides ADD CONSTRAINT room_closed_overrides_shift_check CHECK (shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE staff_shifts ADD CONSTRAINT staff_shifts_shift_check CHECK (shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE staff_time_off ADD CONSTRAINT staff_time_off_shift_check CHECK (shift IS NULL OR shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE opening_hours_disabled_slots ADD CONSTRAINT opening_hours_disabled_slots_shift_check CHECK (shift IN ('LUNCH','DINNER'));`);
    pgm.sql(`ALTER TABLE orders ADD CONSTRAINT orders_shift_check CHECK (shift IS NULL OR shift IN ('LUNCH','DINNER'));`);
};
