/**
 * Fatture fornitori, Fase 2 (PR 3): le fatture arrivano per email.
 *
 * Ogni locale ha un indirizzo suo sul dominio di piattaforma
 * (`<slug>-<token>@fatture.sympotia.com`), ricevuto da Resend: il
 * commercialista o il fornitore ci inoltrano l'email e gli allegati XML, p7m
 * o zip entrano «da controllare» come quelli caricati a mano.
 *
 * - tenants.fatture_email_token: la parte segreta dell'indirizzo. Sta sui
 *   tenants (senza RLS) perché il webhook deve trovare il locale prima di
 *   sapere chi è. Si genera alla prima lettura e si può rigenerare: il
 *   vecchio indirizzo smette di funzionare.
 * - fatture_email_ricevute: il registro delle email arrivate, una riga per
 *   email di Resend (UNIQUE: un webhook ripetuto non importa due volte), con
 *   l'esito di ogni allegato. È quello che si legge quando una fattura «non
 *   è arrivata».
 * - fornitori_carico_automatico: l'interruttore per fornitore (per P.IVA,
 *   come la memoria degli abbinamenti) con le celle in cui caricare. Se tutte
 *   le righe di una fattura nuova sono già note, si carica da sola.
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
    pgm.sql(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS fatture_email_token VARCHAR(32) UNIQUE;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fatture_email_ricevute (
            id              SERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL,
            resend_id       VARCHAR(100) NOT NULL,
            mittente        VARCHAR(320),
            oggetto         TEXT,
            allegati        INTEGER NOT NULL DEFAULT 0,
            esito           JSONB NOT NULL DEFAULT '[]'::jsonb,
            ricevuta_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, resend_id)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_fatture_email_ricevute_tenant ON fatture_email_ricevute (tenant_id, ricevuta_at DESC);`);
    enableRls(pgm, 'fatture_email_ricevute');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS fornitori_carico_automatico (
            tenant_id         BIGINT NOT NULL,
            chiave_fornitore  VARCHAR(60) NOT NULL,
            attivo            BOOLEAN NOT NULL DEFAULT true,
            ubicazioni        JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_by        VARCHAR(255),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (tenant_id, chiave_fornitore)
        );
    `);
    enableRls(pgm, 'fornitori_carico_automatico');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS fornitori_carico_automatico;`);
    pgm.sql(`DROP TABLE IF EXISTS fatture_email_ricevute;`);
    pgm.sql(`ALTER TABLE tenants DROP COLUMN IF EXISTS fatture_email_token;`);
};
