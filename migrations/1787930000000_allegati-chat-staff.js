/* Allegati foto nella chat staff (piano §9). I file riusano outbound_media
 * (bytea + token pubblico non indovinabile, lo stesso storage degli allegati
 * WhatsApp): il messaggio porta solo i riferimenti in `media` JSONB
 * [{token, content_type, filename}].
 *
 * Con una foto il testo diventa opzionale: body passa a nullable e il CHECK
 * inline sulla lunghezza (nome auto-generato) viene riscritto; un vincolo
 * nuovo impone che almeno uno fra testo e media ci sia.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE staff_messages ADD COLUMN IF NOT EXISTS media JSONB;`);
    pgm.sql(`ALTER TABLE staff_messages ALTER COLUMN body DROP NOT NULL;`);
    pgm.sql(`
        DO $$
        DECLARE c RECORD;
        BEGIN
            FOR c IN
                SELECT conname
                  FROM pg_constraint
                 WHERE conrelid = 'staff_messages'::regclass
                   AND contype = 'c'
                   AND pg_get_constraintdef(oid) LIKE '%char_length(body)%'
            LOOP
                EXECUTE format('ALTER TABLE staff_messages DROP CONSTRAINT %I', c.conname);
            END LOOP;
        END $$;
    `);
    pgm.sql(`
        ALTER TABLE staff_messages
            ADD CONSTRAINT staff_messages_body_len
            CHECK (body IS NULL OR char_length(body) BETWEEN 1 AND 1000);
    `);
    pgm.sql(`
        ALTER TABLE staff_messages
            ADD CONSTRAINT staff_messages_body_o_media
            CHECK (body IS NOT NULL OR media IS NOT NULL);
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE staff_messages DROP CONSTRAINT IF EXISTS staff_messages_body_o_media;`);
    pgm.sql(`ALTER TABLE staff_messages DROP CONSTRAINT IF EXISTS staff_messages_body_len;`);
    pgm.sql(`DELETE FROM staff_messages WHERE body IS NULL;`);
    pgm.sql(`ALTER TABLE staff_messages ALTER COLUMN body SET NOT NULL;`);
    pgm.sql(`
        ALTER TABLE staff_messages
            ADD CONSTRAINT staff_messages_body_check
            CHECK (char_length(body) BETWEEN 1 AND 1000);
    `);
    pgm.sql(`ALTER TABLE staff_messages DROP COLUMN IF EXISTS media;`);
};
