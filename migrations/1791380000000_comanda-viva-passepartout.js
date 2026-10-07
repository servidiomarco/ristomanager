/**
 * Comande del CRM in cassa, dal vivo («comanda viva»): la comanda presa nel
 * CRM nasce e cresce nella comanda in cassa Passepartout del tavolo vero,
 * invece di arrivarci solo a conto chiuso come la comanda specchio. Piano
 * del 07/10/2026; le prove sulla cassa vera sono in
 * docs/passepartout-comanda-viva-prove.md.
 *
 * - passepartout_config: l'interruttore e le due scelte del ristorante —
 *   chi stampa in cucina e al bar (la cassa o il CRM) e chi fa il conto
 *   (la cassa o il CRM).
 * - passepartout_comande_vive: un ordine del CRM da tenere allineato in
 *   cassa. Lo stato desiderato è l'ordine com'è adesso: ogni modifica alza
 *   `versione` nella sua transazione, il giro scrive la differenza e porta
 *   `versione_scritta` alla versione letta. `palmare` = la comanda in
 *   cassa c'era già (aperta dal palmare o dalla cassa): il CRM aggiunge le
 *   sue righe e non tocca le altre.
 * - passepartout_righe_vive: le righe che il CRM ha scritto in cassa, con
 *   l'IdGestionale della riga (la cassa non ha note per riga: è l'unico
 *   modo di riconoscerle). `chiave` è 'oi:<order_item_id>' per le righe
 *   dei piatti; coperto e servizio, che il CRM rigenera a ogni modifica con
 *   id nuovi, hanno una chiave fissa ('coperto', 'servizio').
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
            ADD COLUMN IF NOT EXISTS comande_vive_enabled BOOLEAN NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS comande_stampa VARCHAR(10) NOT NULL DEFAULT 'cassa',
            ADD COLUMN IF NOT EXISTS comande_conto VARCHAR(10) NOT NULL DEFAULT 'cassa';
        ALTER TABLE passepartout_config DROP CONSTRAINT IF EXISTS passepartout_config_comande_stampa_check;
        ALTER TABLE passepartout_config ADD CONSTRAINT passepartout_config_comande_stampa_check
            CHECK (comande_stampa IN ('cassa', 'crm'));
        ALTER TABLE passepartout_config DROP CONSTRAINT IF EXISTS passepartout_config_comande_conto_check;
        ALTER TABLE passepartout_config ADD CONSTRAINT passepartout_config_comande_conto_check
            CHECK (comande_conto IN ('cassa', 'crm'));
    `);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS passepartout_comande_vive (
            tenant_id           BIGINT NOT NULL,
            order_id            INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
            table_id            INTEGER,
            pp_comanda_id       INTEGER,
            palmare             BOOLEAN NOT NULL DEFAULT false,
            versione            INTEGER NOT NULL DEFAULT 1,
            versione_scritta    INTEGER NOT NULL DEFAULT 0,
            stato               VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                                CHECK (stato IN ('PENDING', 'SCRITTA', 'FAILED', 'CHIUSA')),
            attempts            INTEGER NOT NULL DEFAULT 0,
            next_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
            error               TEXT,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, order_id)
        );
        CREATE INDEX IF NOT EXISTS passepartout_comande_vive_coda ON passepartout_comande_vive (stato, next_at);
        CREATE INDEX IF NOT EXISTS passepartout_comande_vive_comanda ON passepartout_comande_vive (tenant_id, pp_comanda_id);

        CREATE TABLE IF NOT EXISTS passepartout_righe_vive (
            tenant_id           BIGINT NOT NULL,
            order_id            INTEGER NOT NULL,
            chiave              VARCHAR(40) NOT NULL,
            order_item_id       INTEGER REFERENCES order_items(id) ON DELETE SET NULL,
            pp_riga_id          INTEGER,
            pezzi_scritti       INTEGER NOT NULL DEFAULT 0,
            inviata             BOOLEAN NOT NULL DEFAULT false,
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, order_id, chiave),
            FOREIGN KEY (tenant_id, order_id) REFERENCES passepartout_comande_vive (tenant_id, order_id) ON DELETE CASCADE
        );
    `);
    enableRls(pgm, 'passepartout_comande_vive');
    enableRls(pgm, 'passepartout_righe_vive');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS passepartout_righe_vive;`);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_comande_vive;`);
    pgm.sql(`
        ALTER TABLE passepartout_config
            DROP CONSTRAINT IF EXISTS passepartout_config_comande_stampa_check,
            DROP CONSTRAINT IF EXISTS passepartout_config_comande_conto_check,
            DROP COLUMN IF EXISTS comande_vive_enabled,
            DROP COLUMN IF EXISTS comande_stampa,
            DROP COLUMN IF EXISTS comande_conto;
    `);
};
