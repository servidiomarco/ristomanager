/* Il cursore della replica (tappa 4 ibrido, fase 2c — sez. 7 del
 * brainstorming, «pattern inbox»): per ogni stream consumato, l'ultimo seq
 * applicato. Sul NODO la riga ('cloud', N) nasce col bootstrap dallo
 * snapshot e avanza col replay; sul CLOUD la stessa tabella terrà il
 * cursore dello stream del nodo quando la fase 3 accenderà la replica
 * inversa. Una migration sola per entrambe le topologie: stessa codebase,
 * stesse migration.
 *
 * La regola del pattern inbox: chi applica un batch di eventi avanza
 * applied_seq NELLA STESSA transazione delle proiezioni — è ciò che rende
 * la consegna at-least-once un effetto exactly-once.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE replication_cursor (
            tenant_id   INTEGER NOT NULL,
            stream      TEXT NOT NULL,
            applied_seq BIGINT NOT NULL DEFAULT 0,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, stream)
        );
    `);
    // RLS come ogni tabella con tenant_id (espressione standard del repo).
    pgm.sql(`ALTER TABLE replication_cursor ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE replication_cursor FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON replication_cursor;`);
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
        CREATE POLICY tenant_isolation ON replication_cursor
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS replication_cursor;`);
};
