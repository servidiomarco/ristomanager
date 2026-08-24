/* Outbox transazionale per gli eventi di dominio (prima tratta: comande).
 *
 * L'evento viene scritto QUI, nella stessa transazione che muta il dato, e
 * consegnato dopo da un dispatcher con retry: non può più esistere lo stato
 * «salvato ma non comunicato» (ordine committato, cucina mai avvisata perché
 * il processo è morto fra COMMIT e broadcast). L'id seriale è anche l'ordine
 * totale dello stream: è l'embrione dell'event log del futuro nodo di sala
 * (docs/brainstorming-installazione-ibrida.md, sez. 7 del repo marketing).
 *
 * PII: il payload porta riferimenti (order_id), mai dati anagrafici — la
 * regola «l'evento porta customer:2210, mai il nome» parte da qui.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE outbox_events (
            id           BIGSERIAL PRIMARY KEY,
            tenant_id    INTEGER NOT NULL,
            event        TEXT NOT NULL,
            aggregate    TEXT NOT NULL,
            payload      JSONB,
            attempts     INTEGER NOT NULL DEFAULT 0,
            created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            delivered_at TIMESTAMPTZ
        );
    `);
    // Il dispatcher legge solo le righe non consegnate, in ordine di id:
    // l'indice parziale tiene la scansione O(coda), non O(storia).
    pgm.sql(`
        CREATE INDEX outbox_events_da_consegnare
            ON outbox_events (id)
            WHERE delivered_at IS NULL;
    `);

    // RLS come per ogni tabella con tenant_id; il dispatcher legge
    // cross-tenant come lavoro di piattaforma dichiarato (runAsPlatform).
    // Espressione copiata verbatim da table-assignment-suggestions.
    pgm.sql(`ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON outbox_events;`);
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
        CREATE POLICY tenant_isolation ON outbox_events
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS outbox_events;`);
};
