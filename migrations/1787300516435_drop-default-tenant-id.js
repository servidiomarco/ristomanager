/**
 * Cade il DEFAULT 1 su tenant_id — l'ultimo residuo della Fase B1.
 *
 * Il default era la rete di transizione: le INSERT pre-multitenant dovevano
 * poter funzionare mentre la B3 scopava le route una per una. Ma è anche una
 * calamita per dati altrui: ogni INSERT dimenticata finiva SILENZIOSAMENTE
 * dentro il tenant 1 (vedi il bug di createUser, fix #196). Da qui in poi
 * una INSERT senza tenant esplicito muore di NOT NULL — rumorosa al primo
 * test, mai più inquinamento silenzioso.
 *
 * Prerequisiti già in questa PR: i seed della baseline (createSchema) e le
 * route preset dichiarano il tenant esplicitamente. Le migration PRECEDENTI
 * non vanno toccate: sul replay di un database vergine girano in ordine di
 * timestamp, quindi PRIMA di questa — il default per loro esiste ancora.
 *
 * Ai dati esistenti non succede niente: rimuovere un default non tocca le
 * righe, solo le INSERT future.
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
        DECLARE t RECORD;
        BEGIN
            FOR t IN
                SELECT table_name
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND column_name = 'tenant_id'
                   AND column_default IS NOT NULL
            LOOP
                EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id DROP DEFAULT', t.table_name);
            END LOOP;
        END $$;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        DO $$
        DECLARE t RECORD;
        BEGIN
            FOR t IN
                SELECT table_name
                  FROM information_schema.columns
                 WHERE table_schema = 'public'
                   AND column_name = 'tenant_id'
            LOOP
                EXECUTE format('ALTER TABLE %I ALTER COLUMN tenant_id SET DEFAULT 1', t.table_name);
            END LOOP;
        END $$;
    `);
};
