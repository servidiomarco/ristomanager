/**
 * Tavoli aperti nella cassa Passepartout (sola lettura).
 *
 * Disponibilità, Sofia e sala leggevano solo le prenotazioni: un tavolo
 * aperto in cassa (un walk-in mai passato dal CRM) risultava libero, e il
 * sistema poteva proporlo a chi chiama. Ora il CRM legge ogni minuto le
 * comande aperte della cassa e le tiene qui, sui tavoli abbinati.
 *
 * - passepartout_tavoli_aperti: una comanda aperta per riga. Non tocca
 *   tables.status né crea walk-in: è una proiezione della cassa, che col
 *   nodo di sala il cloud non potrebbe scrivere come servizio, e che la
 *   sincronizzazione delle prenotazioni rimanderebbe in cassa.
 *   libero_previsto_at = apertura + durata del turno, mai prima di adesso
 *   + 20 minuti. Le righe non più viste spariscono (al giro dopo, o dopo
 *   5 minuti ad agente muto): una cassa muta non blocca la sala.
 * - passepartout_config.tavoli_aperti_enabled: l'interruttore;
 *   tavoli_aperti_disponibilita: se i tavoli aperti contano anche per la
 *   disponibilità automatica (services/apertiInCassaSql.ts).
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
        CREATE TABLE IF NOT EXISTS passepartout_tavoli_aperti (
            tenant_id           BIGINT NOT NULL,
            pp_comanda_id       INTEGER NOT NULL,
            table_id            INTEGER NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
            coperti             INTEGER,
            totale_cents        INTEGER NOT NULL DEFAULT 0,
            aperta_da           TIMESTAMPTZ,
            libero_previsto_at  TIMESTAMPTZ NOT NULL,
            visto_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, pp_comanda_id)
        );
        CREATE INDEX IF NOT EXISTS passepartout_tavoli_aperti_tavolo ON passepartout_tavoli_aperti (tenant_id, table_id);
    `);
    enableRls(pgm, 'passepartout_tavoli_aperti');

    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS tavoli_aperti_enabled BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS tavoli_aperti_disponibilita BOOLEAN NOT NULL DEFAULT true;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP COLUMN IF EXISTS tavoli_aperti_enabled,
            DROP COLUMN IF EXISTS tavoli_aperti_disponibilita;
    `);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_tavoli_aperti;`);
};
