/**
 * Supporto clienti (Aiuto): le richieste di assistenza che un ristorante apre
 * verso il team Sympotia, e la conversazione che ne segue.
 *
 * - support_tickets: una richiesta. `context` è la fotografia tecnica presa
 *   all'apertura (versione, vista, nodo di sala, stampe ferme…), così chi
 *   risponde non deve chiedere «che versione hai?». I due flag *_unread
 *   dicono a ciascun lato se c'è una risposta che non ha ancora visto: uno
 *   per lato e non per utente, perché dall'altra parte c'è una persona sola.
 *   dev_card_id lega la richiesta alla card del dev board nata da lei.
 * - support_messages: il thread. author_name è una copia presa alla
 *   scrittura, non una JOIN: chi risponde per la piattaforma è un utente di
 *   un ALTRO tenant, e sotto RLS il ristorante non vedrebbe la sua riga in
 *   users — il nome uscirebbe vuoto.
 *
 * tenant_id senza DEFAULT (rls.test.ts) e RLS con la stessa policy delle
 * altre tabelle per-tenant: la passata dinamica al boot la rimetterebbe
 * comunque, ma la tabella deve nascere già chiusa.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const RLS_POLICY = `
    (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
    OR (
        (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
        AND (
            (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
            OR (current_setting('app.rls_bypass', true) = 'on')
        )
    )
`;

const enableRls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS support_tickets (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            category           VARCHAR(20) NOT NULL DEFAULT 'altro'
                               CHECK (category IN ('stampa', 'cassa_fiscale', 'sofia', 'prenotazioni', 'menu', 'fatturazione', 'altro')),
            priority           VARCHAR(10) NOT NULL DEFAULT 'normale'
                               CHECK (priority IN ('urgente', 'normale')),
            status             VARCHAR(16) NOT NULL DEFAULT 'nuovo'
                               CHECK (status IN ('nuovo', 'in_corso', 'attesa_cliente', 'risolto')),
            subject            VARCHAR(160) NOT NULL,
            context            JSONB NOT NULL DEFAULT '{}'::jsonb,
            platform_unread    BOOLEAN NOT NULL DEFAULT TRUE,
            tenant_unread      BOOLEAN NOT NULL DEFAULT FALSE,
            dev_card_id        INTEGER,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            last_message_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
            resolved_at        TIMESTAMPTZ
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS support_tickets_tenant_recent ON support_tickets (tenant_id, last_message_at DESC);`);
    // La coda della piattaforma: solo le aperte, urgenti in cima.
    pgm.sql(`CREATE INDEX IF NOT EXISTS support_tickets_open_queue ON support_tickets (status, priority, last_message_at DESC) WHERE status <> 'risolto';`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS support_messages (
            id             SERIAL PRIMARY KEY,
            tenant_id      BIGINT NOT NULL,
            ticket_id      INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
            author_type    VARCHAR(12) NOT NULL CHECK (author_type IN ('utente', 'piattaforma')),
            author_user_id INTEGER,
            author_name    TEXT,
            body           TEXT NOT NULL,
            attachments    JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS support_messages_ticket ON support_messages (ticket_id, created_at);`);

    enableRls(pgm, 'support_tickets');
    enableRls(pgm, 'support_messages');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS support_messages;`);
    pgm.sql(`DROP TABLE IF EXISTS support_tickets;`);
};
