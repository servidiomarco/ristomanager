/**
 * HACCP — sensori di temperatura ed etichette (Fase 4 di docs/haccp-piano.md).
 *
 * - haccp_sensors / haccp_sensor_readings: i sensori wireless mandano le
 *   letture a un webhook con un token per ristorante (haccp_settings.
 *   sensor_token), in un formato generico o in quello dei gateway più
 *   diffusi. Un sensore mai visto si registra da solo, non assegnato:
 *   l'assegnazione a una postazione si fa in Configura. Il sensore compila la
 *   rilevazione del giorno nelle sue fasce orarie, apre una non conformità
 *   se resta fuori soglia troppo a lungo e avvisa quando tace.
 * - haccp_temperature_readings.sensor_id: la rilevazione scritta dal
 *   sensore lo dice, sul modulo e sul foglio.
 * - haccp_label_presets / haccp_labels: le etichette di produzione, di
 *   prodotto aperto e di scongelamento, con la scadenza secondaria calcolata
 *   dal preset; ogni etichetta stampata resta registrata (rintracciabilità).
 *   Sulla termica escono come job ETICHETTA dell'agente di stampa.
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
    pgm.sql(`ALTER TABLE haccp_settings ADD COLUMN IF NOT EXISTS sensor_token VARCHAR(64);`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_settings_sensor_token ON haccp_settings (sensor_token) WHERE sensor_token IS NOT NULL;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_sensors (
            id                 SERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            external_id        VARCHAR(100) NOT NULL,
            label              VARCHAR(100),
            vendor             VARCHAR(30),
            point_id           INTEGER REFERENCES haccp_points(id) ON DELETE SET NULL,
            active             BOOLEAN NOT NULL DEFAULT true,
            last_value         NUMERIC(5,1),
            last_seen_at       TIMESTAMPTZ,
            battery            SMALLINT,
            out_since          TIMESTAMPTZ,
            offline_alerted_at TIMESTAMPTZ,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (tenant_id, external_id)
        );
    `);
    enableRls(pgm, 'haccp_sensors');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_sensor_readings (
            id          BIGSERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            sensor_id   INTEGER NOT NULL REFERENCES haccp_sensors(id) ON DELETE CASCADE,
            measured_at TIMESTAMPTZ NOT NULL,
            value       NUMERIC(5,1) NOT NULL,
            received_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_sensor_readings ON haccp_sensor_readings (tenant_id, sensor_id, measured_at DESC);`);
    enableRls(pgm, 'haccp_sensor_readings');

    pgm.sql(`ALTER TABLE haccp_temperature_readings ADD COLUMN IF NOT EXISTS sensor_id INTEGER REFERENCES haccp_sensors(id) ON DELETE SET NULL;`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_label_presets (
            id              SERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL,
            name            VARCHAR(100) NOT NULL,
            kind            VARCHAR(14) NOT NULL DEFAULT 'PRODUZIONE'
                            CHECK (kind IN ('PRODUZIONE', 'APERTURA', 'SCONGELAMENTO')),
            shelf_life_days SMALLINT NOT NULL CHECK (shelf_life_days BETWEEN 0 AND 3650),
            storage         VARCHAR(60),
            allergens       TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            sort_order      INTEGER NOT NULL DEFAULT 0,
            active          BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_label_presets ON haccp_label_presets (tenant_id, active, sort_order);`);
    enableRls(pgm, 'haccp_label_presets');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_labels (
            id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tenant_id            BIGINT NOT NULL,
            kind                 VARCHAR(14) NOT NULL CHECK (kind IN ('PRODUZIONE', 'APERTURA', 'SCONGELAMENTO')),
            label_date           DATE NOT NULL,
            product              VARCHAR(255) NOT NULL,
            prepared_at          TIMESTAMPTZ NOT NULL,
            expiry_date          DATE NOT NULL,
            lot                  VARCHAR(100),
            storage              VARCHAR(60),
            allergens            TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
            note                 VARCHAR(200),
            copies               SMALLINT NOT NULL DEFAULT 1 CHECK (copies BETWEEN 1 AND 20),
            printer              VARCHAR(30),
            print_job_id         INTEGER,
            source_entity        VARCHAR(20),
            source_id            TEXT,
            printed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            printed_by_user_name VARCHAR(255),
            created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_labels_date ON haccp_labels (tenant_id, label_date);`);
    enableRls(pgm, 'haccp_labels');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS haccp_labels;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_label_presets;`);
    pgm.sql(`ALTER TABLE haccp_temperature_readings DROP COLUMN IF EXISTS sensor_id;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_sensor_readings;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_sensors;`);
    pgm.sql(`DROP INDEX IF EXISTS haccp_settings_sensor_token;`);
    pgm.sql(`ALTER TABLE haccp_settings DROP COLUMN IF EXISTS sensor_token;`);
};
