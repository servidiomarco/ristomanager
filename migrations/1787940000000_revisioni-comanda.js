/* Revisioni comanda: quando una comanda già lanciata in cucina cambia
 * (storno di una riga inviata, aggiunta sulla stessa uscita, "riporta",
 * trasferimento di tavolo), la modifica viene registrata qui e la card sul
 * monitor mostra "modificata" — il tocco apre il dettaglio, l'ack la spegne
 * per tutti gli schermi.
 *
 * station_ids: le partite coinvolte (NULL = tutte, es. trasferimento).
 * course_no NULL = riguarda l'intera comanda. details JSONB: righe
 * [{label, note}] già pronte per la resa, il summary è la frase breve.
 * L'ack è globale (una conferma spegne l'avviso ovunque): la cucina lavora
 * a squadra, non serve una ricevuta per schermo.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE order_revisions (
            id              BIGSERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL,
            order_id        INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            course_no       INTEGER,
            station_ids     INTEGER[],
            kind            VARCHAR(20) NOT NULL CHECK (kind IN ('void', 'added', 'unserved', 'transfer')),
            summary         TEXT NOT NULL,
            details         JSONB,
            created_by_name TEXT NOT NULL,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            acked_at        TIMESTAMPTZ,
            acked_by_name   TEXT
        );
    `);
    // La query calda è "revisioni aperte del servizio": indice parziale.
    pgm.sql(`
        CREATE INDEX order_revisions_aperte
            ON order_revisions (tenant_id, order_id)
            WHERE acked_at IS NULL;
    `);

    // RLS come per ogni tabella nuova con tenant_id (pattern outbox).
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
    pgm.sql(`ALTER TABLE order_revisions ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE order_revisions FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON order_revisions;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON order_revisions
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS order_revisions;`);
};
