/**
 * Prenotazioni del CRM nel planning della cassa Passepartout, e ritorno
 * degli arrivi (prova sulla cassa vera del 06/10/2026, prenotazione 94).
 *
 * - passepartout_config: una riga per ristorante. L'interruttore dell'invio
 *   (spento finché i tavoli non sono abbinati) e l'ultima pianta letta dalla
 *   cassa — sale e nomi dei tavoli — per abbinare anche ad agente spento.
 * - passepartout_tavoli: tavolo del CRM → sala e nome del tavolo in cassa.
 *   I nomi non bastano: «23» e «23.» sono due tavoli in due sale diverse, e
 *   le varianti tipografiche («80» / «80-», «3 Bis» / «3BIS») sono tante.
 *   `confermato` = usabile dall'invio: l'abbinamento automatico sicuro lo è
 *   da subito, quello per somiglianza aspetta un sì.
 * - passepartout_prenotazioni: cosa il CRM ha scritto in cassa per ogni
 *   prenotazione. `stato_scritto` è l'ultimo stato scritto dal CRM: se la
 *   cassa ne mostra un altro l'ha presa in mano lei (`gestita_in_cassa`) e
 *   il CRM non la tocca più. `impronta` evita di riscrivere ciò che non è
 *   cambiato. Alla cancellazione della prenotazione la riga resta (con
 *   reservation_id NULL) finché in cassa non è annullata.
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
        CREATE TABLE IF NOT EXISTS passepartout_config (
            tenant_id             BIGINT PRIMARY KEY,
            prenotazioni_enabled  BOOLEAN NOT NULL DEFAULT false,
            pianta                JSONB,
            pianta_at             TIMESTAMPTZ,
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    enableRls(pgm, 'passepartout_config');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS passepartout_tavoli (
            table_id    INTEGER PRIMARY KEY REFERENCES tables(id) ON DELETE CASCADE,
            tenant_id   BIGINT NOT NULL,
            pp_sala     VARCHAR(100) NOT NULL,
            pp_tavolo   VARCHAR(100) NOT NULL,
            origine     VARCHAR(10) NOT NULL DEFAULT 'auto' CHECK (origine IN ('auto', 'manuale')),
            confermato  BOOLEAN NOT NULL DEFAULT false,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS passepartout_tavoli_tenant ON passepartout_tavoli (tenant_id);
    `);
    enableRls(pgm, 'passepartout_tavoli');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS passepartout_prenotazioni (
            id                   SERIAL PRIMARY KEY,
            tenant_id            BIGINT NOT NULL,
            reservation_id       INTEGER UNIQUE REFERENCES reservations(id) ON DELETE SET NULL,
            tag                  VARCHAR(40) NOT NULL,
            pp_id                INTEGER,
            pp_giorno            DATE,
            stato_scritto        VARCHAR(20),
            stato_cassa          VARCHAR(20),
            impronta             VARCHAR(64),
            gestita_in_cassa     BOOLEAN NOT NULL DEFAULT false,
            -- Una creazione fallita a metà può aver creato la prenotazione
            -- in cassa senza che il CRM ne sappia il numero: l'annullo la
            -- cerca per tag.
            incerta              BOOLEAN NOT NULL DEFAULT false,
            arrivo_riportato_at  TIMESTAMPTZ,
            attempts             INTEGER NOT NULL DEFAULT 0,
            next_at              TIMESTAMPTZ,
            last_error           TEXT,
            synced_at            TIMESTAMPTZ,
            created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS passepartout_prenotazioni_tenant ON passepartout_prenotazioni (tenant_id, pp_giorno);
    `);
    enableRls(pgm, 'passepartout_prenotazioni');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS passepartout_prenotazioni;`);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_tavoli;`);
    pgm.sql(`DROP TABLE IF EXISTS passepartout_config;`);
};
