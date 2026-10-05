/**
 * HACCP — persone, documenti, interventi esterni (Fase 3 di
 * docs/haccp-piano.md).
 *
 * - haccp_documents: l'archivio che l'ispettore chiede per primo — manuale
 *   di autocontrollo, registrazione sanitaria, schede tecniche e di
 *   sicurezza dei detergenti, contratti, analisi, planimetria, attestati,
 *   rapporti delle ditte. Il file sta in tabella (bytea, 5 MB come la
 *   libreria media); un documento può anche essere solo un riferimento
 *   («l'originale è in ufficio»), senza file. Scadenza dove serve.
 * - haccp_trainings: la formazione degli alimentaristi (Reg. CE 852/2004,
 *   All. II, cap. XII): persona (dal Personale, o a nome libero), corso,
 *   ente, ore, data, scadenza e attestato. Il rinnovo cambia per regione,
 *   quindi la scadenza si scrive, non si calcola.
 * - haccp_interventions: disinfestazione, ritiro dell'olio esausto,
 *   manutenzioni, analisi dell'acqua e di laboratorio, tarature esterne. Sono
 *   registrazioni come le altre (correzioni e annullamenti con storico); un
 *   intervento con rilievi apre una non conformità. La prossima scadenza
 *   alimenta lo scadenzario.
 * - Promemoria di sistema HACCP_EXPIRIES: ogni mattina avvisa solo nei giorni
 *   in cui qualcosa scade fra 30 giorni, fra 7 o oggi — tre avvisi per
 *   scadenza, non uno al giorno per un mese.
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
        CREATE TABLE IF NOT EXISTS haccp_documents (
            id                    SERIAL PRIMARY KEY,
            tenant_id             BIGINT NOT NULL,
            category              VARCHAR(20) NOT NULL
                                  CHECK (category IN ('MANUALE', 'REGISTRAZIONE', 'SCHEDA_TECNICA', 'SCHEDA_SICUREZZA', 'CONTRATTO',
                                                      'ANALISI', 'PLANIMETRIA', 'ATTESTATO', 'RAPPORTO', 'DICHIARAZIONE', 'ALTRO')),
            title                 VARCHAR(200) NOT NULL,
            filename              VARCHAR(255),
            content_type          VARCHAR(120),
            bytes                 BYTEA,
            size_bytes            INTEGER,
            valid_until           DATE,
            note                  TEXT,
            archived              BOOLEAN NOT NULL DEFAULT false,
            uploaded_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            uploaded_by_user_name VARCHAR(255),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_documents_tenant ON haccp_documents (tenant_id, archived, category);`);
    enableRls(pgm, 'haccp_documents');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_trainings (
            id                    SERIAL PRIMARY KEY,
            tenant_id             BIGINT NOT NULL,
            staff_member_id       UUID REFERENCES staff_members(id) ON DELETE SET NULL,
            person_name           VARCHAR(200) NOT NULL,
            course                VARCHAR(20) NOT NULL
                                  CHECK (course IN ('ALIMENTARISTA', 'RESPONSABILE', 'ALLERGENI', 'CELIACHIA', 'AGGIORNAMENTO', 'ALTRO')),
            title                 VARCHAR(200),
            provider              VARCHAR(200),
            hours                 NUMERIC(5,1),
            completed_on          DATE NOT NULL,
            expires_on            DATE,
            document_id           INTEGER REFERENCES haccp_documents(id) ON DELETE SET NULL,
            note                  TEXT,
            archived              BOOLEAN NOT NULL DEFAULT false,
            recorded_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recorded_by_user_name VARCHAR(255),
            created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_trainings_tenant ON haccp_trainings (tenant_id, archived, expires_on);`);
    enableRls(pgm, 'haccp_trainings');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_interventions (
            id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id             BIGINT NOT NULL,
            date                  DATE NOT NULL,
            type                  VARCHAR(20) NOT NULL
                                  CHECK (type IN ('DISINFESTAZIONE', 'RITIRO_OLIO', 'MANUTENZIONE', 'ANALISI_ACQUA', 'ANALISI_LAB',
                                                  'TARATURA', 'SANIFICAZIONE', 'ALTRO')),
            provider              VARCHAR(200),
            outcome_ok            BOOLEAN NOT NULL DEFAULT true,
            findings              TEXT,
            quantity              VARCHAR(50),
            reference             VARCHAR(100),
            document_id           INTEGER REFERENCES haccp_documents(id) ON DELETE SET NULL,
            next_due              DATE,
            note                  TEXT,
            recorded_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recorded_by_user_name VARCHAR(255),
            recorded_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at            TIMESTAMPTZ,
            updated_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            updated_by_user_name  VARCHAR(255),
            voided_at             TIMESTAMPTZ,
            voided_by_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
            voided_by_user_name   VARCHAR(255),
            void_reason           TEXT
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_interventions_date ON haccp_interventions (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_interventions_type ON haccp_interventions (tenant_id, type, date DESC);`);
    enableRls(pgm, 'haccp_interventions');

    // Il promemoria delle scadenze, per ogni ristorante: come quello delle
    // temperature si sposta e si spegne da Impostazioni → Promemoria.
    pgm.sql(`
        INSERT INTO reminders
            (tenant_id, title, description, kind, frequency, schedule_time, target_roles, active, system_key)
        SELECT t.id,
            'Scadenze HACCP',
            'Avvisa 30 giorni prima, 7 giorni prima e il giorno stesso della scadenza di attestati, documenti e interventi.',
            'RECURRING', 'DAILY', '09:00',
            ARRAY['OWNER', 'GENERAL_MANAGER', 'MANAGER']::TEXT[], TRUE, 'HACCP_EXPIRIES'
          FROM tenants t
         WHERE NOT EXISTS (
            SELECT 1 FROM reminders r
             WHERE r.tenant_id = t.id AND r.system_key = 'HACCP_EXPIRIES'
         );
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM reminders WHERE system_key = 'HACCP_EXPIRIES';`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_interventions;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_trainings;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_documents;`);
};
