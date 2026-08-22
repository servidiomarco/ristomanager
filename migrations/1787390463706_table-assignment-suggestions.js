/**
 * Card dev board #26 — collega il prompt "Impostazioni > Prompt logica
 * tavoli per AI" (app_settings, chiave table_assignment_ai_prompt) alla
 * assegnazione automatica.
 *
 * Il prompt del ristoratore NON sostituisce la logica di assegnazione
 * esistente: la affianca. Quando arriva una prenotazione senza tavolo da un
 * canale self-service (sito, WhatsApp, Sofia) l'AI legge quel prompt + lo
 * stato reale di sala e prenotazioni e PROPONE un tavolo (con eventuali
 * unioni). Questa tabella tiene traccia di quella proposta finché non viene
 * confermata o ignorata da una persona in lista prenotazioni — mai
 * un'azione automatica silenziosa.
 *
 * RLS: la tabella nasce con `tenant_id` e la propria policy, copiata
 * verbatim da quella già in uso sulle altre tabelle (vedi
 * 1787296260704_libreria-media.js per la stessa nota) — la migration che ha
 * acceso la Row-Level Security ha girato una volta sola sulle tabelle di
 * allora.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS table_assignment_suggestions (
            id                   BIGSERIAL PRIMARY KEY,
            tenant_id            BIGINT NOT NULL,
            reservation_id       INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
            table_id             INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
            merge_with_table_ids INTEGER[] NOT NULL DEFAULT '{}',
            summary              TEXT NOT NULL,
            status               VARCHAR(20) NOT NULL DEFAULT 'PENDING',
            created_at           TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            resolved_at          TIMESTAMPTZ,
            resolved_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
    `);
    // Una proposta pendente per prenotazione: la query che alimenta la lista
    // prenotazioni legge solo le PENDING, l'indice le serve dirette.
    pgm.sql(`
        CREATE INDEX IF NOT EXISTS idx_table_assignment_suggestions_pending
            ON table_assignment_suggestions (tenant_id, reservation_id)
            WHERE status = 'PENDING';
    `);

    pgm.sql(`ALTER TABLE table_assignment_suggestions ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE table_assignment_suggestions FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON table_assignment_suggestions;`);
    // Espressione copiata verbatim da quella già in uso (vedi nota sopra).
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
        CREATE POLICY tenant_isolation ON table_assignment_suggestions
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS table_assignment_suggestions;`);
};
