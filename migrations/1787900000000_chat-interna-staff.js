/* Chat staff — messaggistica interna fra le sezioni (docs/chat-staff-plan.md).
 *
 * Due tabelle: staff_messages (canali fissi derivati dal ruolo + DM 1-a-1,
 * discriminante `kind`) e staff_message_reads (cursore di lettura per
 * utente+thread, modello WhatsApp: non letti = id > cursore). L'id BIGSERIAL
 * è anche l'ordine totale del thread — paginazione e cursori ragionano per
 * id, mai per timestamp.
 *
 * Mittente denormalizzato come in activity_logs: la riga sopravvive alla
 * cancellazione dell'utente e la lista non fa join su users. Per i DM il
 * vincolo su recipient è "id OR name" proprio perché ON DELETE SET NULL può
 * svuotare l'id lasciando il nome.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE staff_messages (
            id                    BIGSERIAL PRIMARY KEY,
            tenant_id             BIGINT NOT NULL,
            kind                  VARCHAR(10) NOT NULL CHECK (kind IN ('channel', 'direct')),
            channel               VARCHAR(20) CHECK (channel IN ('generale', 'sala', 'cucina', 'reception')),
            sender_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
            sender_name           TEXT NOT NULL,
            sender_role           VARCHAR(20) NOT NULL,
            recipient_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recipient_name        TEXT,
            body                  TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
            preset_key            VARCHAR(40),
            linked_reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
            linked_table_id       INTEGER REFERENCES tables(id) ON DELETE SET NULL,
            created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CHECK (kind <> 'channel' OR channel IS NOT NULL),
            CHECK (kind <> 'direct'  OR recipient_user_id IS NOT NULL OR recipient_name IS NOT NULL)
        );
    `);
    // Le due query calde sono i thread paginati per id discendente. Il thread
    // DM filtra con OR sui due versi (io→lui, lui→io): due indici parziali,
    // il planner li combina in BitmapOr.
    pgm.sql(`
        CREATE INDEX staff_messages_canale
            ON staff_messages (tenant_id, channel, id DESC)
            WHERE kind = 'channel';
    `);
    pgm.sql(`
        CREATE INDEX staff_messages_dm_mittente
            ON staff_messages (tenant_id, sender_user_id, id DESC)
            WHERE kind = 'direct';
    `);
    pgm.sql(`
        CREATE INDEX staff_messages_dm_destinatario
            ON staff_messages (tenant_id, recipient_user_id, id DESC)
            WHERE kind = 'direct';
    `);

    pgm.sql(`
        CREATE TABLE staff_message_reads (
            tenant_id            BIGINT NOT NULL,
            user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            thread_key           VARCHAR(40) NOT NULL,
            last_read_message_id BIGINT NOT NULL DEFAULT 0,
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, user_id, thread_key)
        );
    `);

    // RLS come per ogni tabella nuova con tenant_id: la migration B4 ha
    // coperto solo l'esistente. Espressione copiata verbatim da
    // outbox-eventi-comanda.
    const POLICY = `
        (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
        OR (
            (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
            AND (
                (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
                OR (current_setting('app.rls_bypass', true) = 'on')
            )
        )
    `;
    for (const table of ['staff_messages', 'staff_message_reads']) {
        pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
        pgm.sql(`
            CREATE POLICY tenant_isolation ON ${table}
            USING (${POLICY})
            WITH CHECK (${POLICY});
        `);
    }

    // Il permesso a tutti i ruoli di tutti i tenant (il singolo ristorante
    // può toglierlo dalla UI permessi). I seed di createSchema sono baseline
    // congelata del tenant 1: le migration girano con app.rls_bypass acceso
    // (runMigrations, db.ts), quindi l'insert cross-tenant passa anche con
    // la strict di produzione.
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'staffchat:use'
          FROM tenants t
         CROSS JOIN (VALUES ('PLATFORM_ADMIN'), ('OWNER'), ('GENERAL_MANAGER'),
                            ('MANAGER'), ('RECEPTION'), ('WAITER'), ('KITCHEN')) AS r(role)
            ON CONFLICT DO NOTHING;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission = 'staffchat:use';`);
    pgm.sql(`DROP TABLE IF EXISTS staff_message_reads;`);
    pgm.sql(`DROP TABLE IF EXISTS staff_messages;`);
};
