/**
 * Documenti fiscali — fase 3 del piano fatturazione
 * (docs/fatturazione-chiusura-conto-brainstorm.md, provider in
 * docs/confronto-provider-fiscali.md).
 *
 * Un documento commerciale (scontrino elettronico) emesso via provider cloud
 * per un conto chiuso. La riga nasce PENDING, il provider risponde e diventa
 * CONFIRMED o FAILED; l'annullo la porta a VOIDED. request/response sono i
 * payload integrali: quando l'AdE chiede conto di uno scontrino fra sei
 * mesi, questa tabella è l'unica memoria di cosa abbiamo trasmesso.
 *
 * La trasmissione può fallire senza bloccare l'operatività: il conto chiude
 * comunque (tavolo libero) e il documento resta PENDING/FAILED da ritentare
 * — è la regola fissata nel piano.
 *
 * L'indice unico parziale ammette UN documento vivo (PENDING/CONFIRMED) per
 * conto: il retry riusa la riga, il replay non duplica lo scontrino. FAILED
 * e VOIDED non contano: dopo un annullo se ne può emettere uno nuovo.
 *
 * ON DELETE RESTRICT sul conto, in controtendenza con le altre tabelle del
 * modulo: un documento trasmesso al fisco non deve sparire in cascata.
 *
 * RLS: policy copiata verbatim da quella in uso (vedi
 * 1787390463706_table-assignment-suggestions.js per la stessa nota).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fiscal_documents (
            id                  BIGSERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL,
            table_bill_id       INTEGER NOT NULL REFERENCES table_bills(id) ON DELETE RESTRICT,
            doc_type            VARCHAR(20) NOT NULL DEFAULT 'RECEIPT' CHECK (doc_type IN ('RECEIPT')),
            provider            VARCHAR(20) NOT NULL,
            fiscal_id_snapshot  TEXT,
            status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                                CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'VOIDED')),
            provider_ref        TEXT,
            request             JSONB,
            response            JSONB,
            error               TEXT,
            total_cents         INTEGER NOT NULL,
            attempts            INTEGER NOT NULL DEFAULT 0,
            created_by_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            confirmed_at        TIMESTAMPTZ,
            voided_at           TIMESTAMPTZ
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fiscal_documents_tenant_created ON fiscal_documents(tenant_id, created_at);`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_fiscal_documents_one_live_per_bill ON fiscal_documents(table_bill_id) WHERE status IN ('PENDING', 'CONFIRMED');`);

    pgm.sql(`ALTER TABLE fiscal_documents ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE fiscal_documents FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON fiscal_documents;`);
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
        CREATE POLICY tenant_isolation ON fiscal_documents
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS fiscal_documents;`);
};
