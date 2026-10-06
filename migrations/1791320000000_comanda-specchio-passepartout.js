/**
 * Conti del CRM verso la cassa Passepartout (fase 4, «comanda specchio»).
 *
 * I conti chiusi nel CRM (scontrino dal registratore del CRM) non
 * esistevano per la cassa: statistiche per articolo e magazzino del
 * gestionale vedevano solo i tavoli battuti lì. In modalità «statistiche»
 * ogni conto del CRM chiuso diventa in cassa una comanda sul tavolo scelto
 * (al Frantoio il 29 di DENTRO), senza invio in produzione, chiusa come
 * proforma pagata col tipo esterno: nessun documento fiscale dalla cassa,
 * l'incasso non conta due volte.
 *
 * - passepartout_config: conti_crm_mode ('off' | 'statistiche'; 'fiscale'
 *   è riservato), il tavolo della comanda specchio (specchio_sala,
 *   specchio_tavolo) e l'articolo della cassa per i piatti nati solo nel
 *   CRM e per il servizio (articolo_generico_id, id del catalogo).
 * - passepartout_specchio: un conto del CRM da copiare, durevole come la
 *   chiusura in cassa: PENDING nella transazione che chiude il conto,
 *   CONFIRMED con gli id della cassa, FAILED quando serve una mano. La
 *   comanda porta in nota il tag del conto: un nuovo tentativo la ritrova
 *   invece di farne un'altra.
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
        ALTER TABLE passepartout_config
            ADD COLUMN IF NOT EXISTS conti_crm_mode VARCHAR(20) NOT NULL DEFAULT 'off',
            ADD COLUMN IF NOT EXISTS specchio_sala VARCHAR(100),
            ADD COLUMN IF NOT EXISTS specchio_tavolo VARCHAR(100),
            ADD COLUMN IF NOT EXISTS articolo_generico_id INTEGER;
        ALTER TABLE passepartout_config DROP CONSTRAINT IF EXISTS passepartout_config_conti_crm_mode_check;
        ALTER TABLE passepartout_config ADD CONSTRAINT passepartout_config_conti_crm_mode_check
            CHECK (conti_crm_mode IN ('off', 'statistiche', 'fiscale'));
    `);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS passepartout_specchio (
            tenant_id           BIGINT NOT NULL,
            table_bill_id       INTEGER NOT NULL REFERENCES table_bills(id) ON DELETE CASCADE,
            stato               VARCHAR(12) NOT NULL DEFAULT 'PENDING' CHECK (stato IN ('PENDING', 'CONFIRMED', 'FAILED')),
            attempts            INTEGER NOT NULL DEFAULT 0,
            next_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
            pp_comanda_id       INTEGER,
            pp_conto_id         INTEGER,
            totale_cents        INTEGER,
            totale_cassa_cents  INTEGER,
            error               TEXT,
            avviso              TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, table_bill_id)
        );
        CREATE INDEX IF NOT EXISTS passepartout_specchio_coda ON passepartout_specchio (stato, next_at);
        CREATE INDEX IF NOT EXISTS passepartout_specchio_comanda ON passepartout_specchio (tenant_id, pp_comanda_id);
    `);
    enableRls(pgm, 'passepartout_specchio');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS passepartout_specchio;`);
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP CONSTRAINT IF EXISTS passepartout_config_conti_crm_mode_check,
            DROP COLUMN IF EXISTS conti_crm_mode,
            DROP COLUMN IF EXISTS specchio_sala,
            DROP COLUMN IF EXISTS specchio_tavolo,
            DROP COLUMN IF EXISTS articolo_generico_id;
    `);
};
