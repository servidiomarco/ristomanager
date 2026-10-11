/**
 * WhatsApp, Fase 9: i vocali trascritti.
 *
 * La trascrizione sta sulla riga del messaggio in arrivo: l'Inbox la mostra
 * sotto il lettore audio e l'agente la legge come testo del cliente. Lo
 * stato dice se c'è (done), se sta arrivando (pending), se non è riuscita
 * (failed) o se il locale non trascrive (NULL). La lingua è quella che il
 * servizio ha riconosciuto, in due lettere.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE outbound_messages
            ADD COLUMN IF NOT EXISTS transcript          TEXT,
            ADD COLUMN IF NOT EXISTS transcript_status   VARCHAR(10)
                CHECK (transcript_status IN ('pending', 'done', 'failed')),
            ADD COLUMN IF NOT EXISTS transcript_language VARCHAR(8);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE outbound_messages
            DROP COLUMN IF EXISTS transcript_language,
            DROP COLUMN IF EXISTS transcript_status,
            DROP COLUMN IF EXISTS transcript;
    `);
};
