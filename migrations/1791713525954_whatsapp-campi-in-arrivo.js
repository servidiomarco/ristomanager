/**
 * WhatsApp, Fase 1 (modulo services/whatsapp/): i campi del webhook in arrivo
 * che prima si buttavano.
 *
 * - profile_name: il nome del profilo WhatsApp del cliente. Lo mostra la
 *   notifica, e dalla Fase 3 l'agente lo propone come nome della
 *   prenotazione («a nome di Marco?»), mai senza conferma.
 * - external_user_id: l'id utente legato all'azienda che WhatsApp introduce
 *   al posto del numero per chi usa un nome utente. Si conserva da subito.
 * - button_payload / button_text: il tocco su un bottone di risposta rapida
 *   di un template (Fase 8, promemoria con «Ci saremo / Annulla»).
 * - replied_to_sid: il nostro messaggio a cui il cliente ha risposto.
 * - location: una posizione condivisa (lat, lng, nome, indirizzo). Arriva
 *   senza testo né allegati e prima la riga non veniva nemmeno scritta.
 *
 * Nessun indice unico su provider_sid per scartare i ritentativi di Twilio:
 * in produzione esistono già due doppioni, e il vincolo farebbe fallire la
 * migrazione. Il controllo lo fa logInboundMessage prima di scrivere.
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
            ADD COLUMN IF NOT EXISTS profile_name     TEXT,
            ADD COLUMN IF NOT EXISTS external_user_id TEXT,
            ADD COLUMN IF NOT EXISTS button_payload   TEXT,
            ADD COLUMN IF NOT EXISTS button_text      TEXT,
            ADD COLUMN IF NOT EXISTS replied_to_sid   TEXT,
            ADD COLUMN IF NOT EXISTS location         JSONB;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE outbound_messages
            DROP COLUMN IF EXISTS profile_name,
            DROP COLUMN IF EXISTS external_user_id,
            DROP COLUMN IF EXISTS button_payload,
            DROP COLUMN IF EXISTS button_text,
            DROP COLUMN IF EXISTS replied_to_sid,
            DROP COLUMN IF EXISTS location;
    `);
};
