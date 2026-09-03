/* Promemoria di richiamata sull'audit delle chiamate voce. L'estate 2026 ha
 * mostrato il buco: per gruppi grandi, errori tecnici e prenotazioni non
 * trovate Sofia prometteva "la richiamiamo" e raccoglieva nome e numero, ma
 * nessun tool li salvava — 0 lead persistiti su 32 promesse, nomi e numeri
 * rimasti solo nei transcript ElevenLabs. Il nuovo tool save_callback_request
 * fa upsert su voice_calls (la riga può nascere qui a metà chiamata; il
 * webhook post-call la completa poi con transcript e durata), così il lead
 * compare in Conversazioni col normale flusso "da ricontattare".
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE voice_calls
        ADD COLUMN callback_requested BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN callback_name TEXT,
        ADD COLUMN callback_reason TEXT,
        ADD COLUMN callback_details TEXT;`);
    pgm.sql(`CREATE INDEX idx_voice_calls_callback ON voice_calls (tenant_id)
        WHERE callback_requested = TRUE;`);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS idx_voice_calls_callback;`);
    pgm.sql(`ALTER TABLE voice_calls
        DROP COLUMN IF EXISTS callback_requested,
        DROP COLUMN IF EXISTS callback_name,
        DROP COLUMN IF EXISTS callback_reason,
        DROP COLUMN IF EXISTS callback_details;`);
};
