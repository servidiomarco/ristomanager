/**
 * Conti della cassa Passepartout nel CRM (sola lettura).
 *
 * I tavoli chiusi solo in cassa per il CRM non esistevano: i report incassi
 * contano table_bills, la rubrica non sapeva quanto spende un cliente, e il
 * riscontro CRM↔cassa («delta zero», docs/serata-pilota-comande.md) si
 * faceva a mano. Ora i conti del giorno si leggono dalla cassa e restano qui.
 *
 * - passepartout_conti: un conto della cassa per riga, chiave il suo id nel
 *   gestionale. `origine` 'crm' = un conto del CRM chiuso in cassa (comanda
 *   importata, external_ref pp:comanda:<id>, o pagato col tipo esterno):
 *   è già nei table_bills e non va contato due volte. `reservation_id` dal
 *   planning (la comanda nata dalla prenotazione porta il suo id), `table_id`
 *   dall'abbinamento dei tavoli.
 * - passepartout_config.conti_enabled: l'interruttore della sezione;
 *   conti_completo_fino: l'ultimo giorno importato a giornata chiusa (il
 *   giro di notte rilegge ieri, così i conti chiusi dopo l'ultimo giro
 *   serale ci sono).
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
        CREATE TABLE IF NOT EXISTS passepartout_conti (
            id                  SERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL,
            pp_conto_id         INTEGER NOT NULL,
            giorno              DATE NOT NULL,
            chiuso_at           TIMESTAMPTZ,
            pp_comanda_id       INTEGER,
            pp_prenotazione_id  INTEGER,
            reservation_id      INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
            table_id            INTEGER REFERENCES tables(id) ON DELETE SET NULL,
            tavolo              VARCHAR(100),
            sala                VARCHAR(100),
            coperti             INTEGER,
            totale_cents        INTEGER NOT NULL DEFAULT 0,
            pagato_cents        INTEGER NOT NULL DEFAULT 0,
            sospeso_cents       INTEGER NOT NULL DEFAULT 0,
            stato               VARCHAR(30),
            tipo_conto          VARCHAR(30),
            tipo_documento      VARCHAR(40),
            numero_scontrino    VARCHAR(40),
            pagamenti           JSONB NOT NULL DEFAULT '[]'::jsonb,
            origine             VARCHAR(5) NOT NULL DEFAULT 'cassa' CHECK (origine IN ('cassa', 'crm')),
            table_bill_id       INTEGER REFERENCES table_bills(id) ON DELETE SET NULL,
            importato_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, pp_conto_id)
        );
        CREATE INDEX IF NOT EXISTS passepartout_conti_giorno ON passepartout_conti (tenant_id, giorno);
        CREATE INDEX IF NOT EXISTS passepartout_conti_prenotazione ON passepartout_conti (tenant_id, reservation_id);
    `);
    enableRls(pgm, 'passepartout_conti');

    pgm.sql(`
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS conti_enabled BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS conti_completo_fino DATE,
            ADD COLUMN IF NOT EXISTS conti_importati_at TIMESTAMPTZ;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP COLUMN IF EXISTS conti_enabled,
            DROP COLUMN IF EXISTS conti_completo_fino,
            DROP COLUMN IF EXISTS conti_importati_at;
    `);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_conti;`);
};
