/**
 * HACCP — processi, limiti del locale, rintracciabilità, tarature (Fase 2 di
 * docs/haccp-piano.md).
 *
 * - haccp_settings: i limiti del manuale del locale (abbattimento a +3 °C in
 *   90 minuti, cottura ≥ 75 °C, caldo ≥ 65 °C, composti polari 25%, soglie
 *   del ricevimento per tipo di merce…). Riga assente = i valori di
 *   riferimento di utils/haccp.ts: un ristorante nuovo parte già coperto.
 * - haccp_production_logs diventa il registro dei processi: tipo di processo
 *   (abbattimento, surgelazione, bonifica anti-Anisakis, cottura,
 *   rinvenimento, mantenimento a caldo, scongelamento, sanificazione delle
 *   verdure, campione testimone), orari e temperature vere di inizio e fine
 *   (con chi ha chiuso il ciclo: è il suo secondo tempo, non una correzione),
 *   attrezzatura, lotti degli ingredienti, scadenza assegnata, esito
 *   calcolato sui limiti. Le righe di prima restano 'LEGACY' con range e
 *   durata: sono quello che il foglio diceva, e il report le mostra così.
 * - haccp_oil_checks: composti polari (%) e temperatura dell'olio.
 * - haccp_goods_receipts: fornitore (l'anagrafica della Lista della spesa,
 *   con il nome fotografato), documento di trasporto, scadenza, imballo,
 *   tipo di merce, quantità — quello che serve a rintracciare «un passo
 *   indietro» (Reg. CE 178/2002, art. 18).
 * - haccp_calibrations: la taratura dei termometri (ghiaccio fondente,
 *   ebollizione o termometro di riferimento), con lo scarto ammesso
 *   fotografato.
 * - Frequenze trimestrale, semestrale e annuale per i punti periodici: la
 *   taratura e certe pulizie non sono né settimanali né mensili.
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

const PROCESSES = ['LEGACY', 'ABBATTIMENTO', 'SURGELAZIONE', 'ANISAKIS', 'COTTURA', 'RINVENIMENTO',
    'MANTENIMENTO_CALDO', 'SCONGELAMENTO', 'SANIFICAZIONE', 'CAMPIONE'];
const RECEIPT_CATEGORIES = ['REFRIGERATO', 'CARNE', 'POLLAME', 'PESCE', 'LATTICINI', 'SURGELATO', 'ORTOFRUTTA', 'SECCO', 'ALTRO'];
const list = (values) => values.map(v => `'${v}'`).join(', ');

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE haccp_points DROP CONSTRAINT IF EXISTS haccp_points_frequency_check;`);
    pgm.sql(`ALTER TABLE haccp_points ADD CONSTRAINT haccp_points_frequency_check
             CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL', 'ON_DEMAND'));`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_settings (
            tenant_id            BIGINT PRIMARY KEY,
            limits               JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_by_user_name VARCHAR(255)
        );
    `);
    enableRls(pgm, 'haccp_settings');

    pgm.sql(`
        ALTER TABLE haccp_production_logs
            ADD COLUMN IF NOT EXISTS process            VARCHAR(24) NOT NULL DEFAULT 'LEGACY',
            ADD COLUMN IF NOT EXISTS equipment_point_id INTEGER REFERENCES haccp_points(id),
            ADD COLUMN IF NOT EXISTS equipment_label    VARCHAR(100),
            ADD COLUMN IF NOT EXISTS started_at         TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS start_temp         NUMERIC(5,1),
            ADD COLUMN IF NOT EXISTS ended_at           TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS end_temp           NUMERIC(5,1),
            ADD COLUMN IF NOT EXISTS ended_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS ended_by_user_name VARCHAR(255),
            ADD COLUMN IF NOT EXISTS quantity           VARCHAR(50),
            ADD COLUMN IF NOT EXISTS expiry_date        DATE,
            ADD COLUMN IF NOT EXISTS source_lots        TEXT,
            ADD COLUMN IF NOT EXISTS sanitizer          VARCHAR(100),
            ADD COLUMN IF NOT EXISTS concentration      VARCHAR(50),
            ADD COLUMN IF NOT EXISTS contact_minutes    INTEGER CHECK (contact_minutes IS NULL OR contact_minutes BETWEEN 0 AND 1440),
            ADD COLUMN IF NOT EXISTS event_label        VARCHAR(255),
            ADD COLUMN IF NOT EXISTS keep_until         TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS compliant          BOOLEAN,
            ADD COLUMN IF NOT EXISTS problem            TEXT;
    `);
    pgm.sql(`ALTER TABLE haccp_production_logs DROP CONSTRAINT IF EXISTS haccp_production_logs_process_check;`);
    pgm.sql(`ALTER TABLE haccp_production_logs ADD CONSTRAINT haccp_production_logs_process_check
             CHECK (process IN (${list(PROCESSES)}));`);
    // I cicli in corso (abbattimento iniziato, bonifica in congelatore) si
    // cercano a ogni apertura del registro.
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_production_open
             ON haccp_production_logs (tenant_id, date) WHERE ended_at IS NULL AND voided_at IS NULL;`);

    pgm.sql(`
        ALTER TABLE haccp_oil_checks
            ADD COLUMN IF NOT EXISTS polar_compounds NUMERIC(4,1) CHECK (polar_compounds IS NULL OR polar_compounds BETWEEN 0 AND 100),
            ADD COLUMN IF NOT EXISTS oil_temp        NUMERIC(5,1);
    `);

    pgm.sql(`
        ALTER TABLE haccp_goods_receipts
            ADD COLUMN IF NOT EXISTS supplier_id   UUID REFERENCES suppliers(id) ON DELETE SET NULL,
            ADD COLUMN IF NOT EXISTS supplier_name VARCHAR(255),
            ADD COLUMN IF NOT EXISTS ddt_number    VARCHAR(50),
            ADD COLUMN IF NOT EXISTS expiry_date   DATE,
            ADD COLUMN IF NOT EXISTS packaging_ok  BOOLEAN,
            ADD COLUMN IF NOT EXISTS category      VARCHAR(20),
            ADD COLUMN IF NOT EXISTS quantity      VARCHAR(50);
    `);
    pgm.sql(`ALTER TABLE haccp_goods_receipts DROP CONSTRAINT IF EXISTS haccp_goods_receipts_category_check;`);
    pgm.sql(`ALTER TABLE haccp_goods_receipts ADD CONSTRAINT haccp_goods_receipts_category_check
             CHECK (category IS NULL OR category IN (${list(RECEIPT_CATEGORIES)}));`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_receipt_lot ON haccp_goods_receipts (tenant_id, lower(lot_number));`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_calibrations (
            id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id             BIGINT NOT NULL,
            date                  DATE NOT NULL,
            point_id              INTEGER NOT NULL REFERENCES haccp_points(id),
            instrument            VARCHAR(100) NOT NULL,
            method                VARCHAR(12) NOT NULL CHECK (method IN ('GHIACCIO', 'EBOLLIZIONE', 'RIFERIMENTO')),
            reference_temp        NUMERIC(5,1) NOT NULL,
            measured_temp         NUMERIC(5,1) NOT NULL,
            max_deviation         NUMERIC(3,1) NOT NULL,
            outcome               VARCHAR(12) NOT NULL DEFAULT 'OK' CHECK (outcome IN ('OK', 'CORRETTO', 'SOSTITUITO')),
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
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_calibrations_date ON haccp_calibrations (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_calibrations_point ON haccp_calibrations (tenant_id, point_id, date DESC);`);
    enableRls(pgm, 'haccp_calibrations');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS haccp_calibrations;`);
    pgm.sql(`
        ALTER TABLE haccp_goods_receipts
            DROP CONSTRAINT IF EXISTS haccp_goods_receipts_category_check,
            DROP COLUMN IF EXISTS supplier_id, DROP COLUMN IF EXISTS supplier_name, DROP COLUMN IF EXISTS ddt_number,
            DROP COLUMN IF EXISTS expiry_date, DROP COLUMN IF EXISTS packaging_ok, DROP COLUMN IF EXISTS category,
            DROP COLUMN IF EXISTS quantity;
    `);
    pgm.sql(`DROP INDEX IF EXISTS idx_haccp_receipt_lot;`);
    pgm.sql(`ALTER TABLE haccp_oil_checks DROP COLUMN IF EXISTS polar_compounds, DROP COLUMN IF EXISTS oil_temp;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_haccp_production_open;`);
    pgm.sql(`
        ALTER TABLE haccp_production_logs
            DROP CONSTRAINT IF EXISTS haccp_production_logs_process_check,
            DROP COLUMN IF EXISTS process, DROP COLUMN IF EXISTS equipment_point_id, DROP COLUMN IF EXISTS equipment_label,
            DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS start_temp, DROP COLUMN IF EXISTS ended_at,
            DROP COLUMN IF EXISTS end_temp, DROP COLUMN IF EXISTS ended_by_user_id, DROP COLUMN IF EXISTS ended_by_user_name,
            DROP COLUMN IF EXISTS quantity, DROP COLUMN IF EXISTS expiry_date,
            DROP COLUMN IF EXISTS source_lots, DROP COLUMN IF EXISTS sanitizer, DROP COLUMN IF EXISTS concentration,
            DROP COLUMN IF EXISTS contact_minutes, DROP COLUMN IF EXISTS event_label, DROP COLUMN IF EXISTS keep_until,
            DROP COLUMN IF EXISTS compliant, DROP COLUMN IF EXISTS problem;
    `);
    pgm.sql(`DROP TABLE IF EXISTS haccp_settings;`);
    pgm.sql(`UPDATE haccp_points SET frequency = 'MONTHLY' WHERE frequency IN ('QUARTERLY', 'SEMIANNUAL', 'ANNUAL');`);
    pgm.sql(`ALTER TABLE haccp_points DROP CONSTRAINT IF EXISTS haccp_points_frequency_check;`);
    pgm.sql(`ALTER TABLE haccp_points ADD CONSTRAINT haccp_points_frequency_check
             CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND'));`);
};
