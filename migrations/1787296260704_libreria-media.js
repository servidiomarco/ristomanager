/**
 * Libreria media: file caricati una volta e allegati molte volte ai messaggi
 * (il menù di una serata, la piantina delle sale).
 *
 * Distinta da `outbound_media`, che è l'artefatto di UN invio — token
 * usa-e-getta, muore col messaggio. Questa è il catalogo. Allegare un file
 * dalla libreria ne materializza una copia in outbound_media, così la via
 * verso Twilio resta quella collaudata e non va toccata.
 *
 * RLS: la tabella nasce con `tenant_id` e la propria policy. Non è
 * ridondante — la migration che ha acceso la Row-Level Security ha girato
 * una volta sola sulle tabelle di allora, quindi una tabella nata dopo
 * resterebbe l'unica leggibile da chiunque.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS media_library (
            id            SERIAL PRIMARY KEY,
            tenant_id     BIGINT NOT NULL DEFAULT 1,
            title         TEXT NOT NULL,
            filename      TEXT NOT NULL,
            content_type  VARCHAR(100) NOT NULL,
            bytes         BYTEA NOT NULL,
            size_bytes    INTEGER NOT NULL,
            created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_media_library_tenant ON media_library (tenant_id, created_at DESC);`);
    pgm.sql(`ALTER TABLE media_library ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE media_library FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON media_library;`);
    // Espressione copiata VERBATIM dalla policy generata sulle altre tabelle
    // (letta con pg_get_expr su reservations), non riscritta a memoria. La
    // differenza conta: con app.tenant_id impostato la riga DEVE combaciare —
    // il ramo di bypass vale solo quando un contesto tenant non c'e' affatto.
    // Una versione "piu' semplice" in cui rls_bypass scavalca tutto darebbe al
    // lavoro di piattaforma la lettura dei dati di un tenant mentre ne serve
    // un altro.
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
    pgm.sql(`
        CREATE POLICY tenant_isolation ON media_library
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS media_library;`);
};
