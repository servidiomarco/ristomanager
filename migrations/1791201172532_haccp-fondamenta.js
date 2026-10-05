/**
 * HACCP — fondamenta (Fase 1 di docs/haccp-piano.md).
 *
 * Il registro nasceva come copia dei fogli del Vecchio Frantoio: postazioni
 * scritte nel codice, una riga per giorno sovrascritta a ogni correzione,
 * cancellazione libera. Qui diventa un registro che regge un secondo
 * ristorante e un ispettore:
 *
 * - haccp_points: i punti di controllo del SINGOLO locale (postazioni di
 *   temperatura, friggitrici, punti di pulizia; termometri e attrezzature
 *   per le fasi successive, già nel CHECK come valori inerti). Il manuale di
 *   autocontrollo è del locale, e l'ASL controlla che si applichi quello:
 *   soglie, rilevazioni al giorno e frequenze stanno qui, non nel codice.
 *   Un punto non si cancella, si archivia (active = false): lo storico resta
 *   agganciato. Il Frantoio (tenant 1) riceve i suoi punti di oggi, con lo
 *   stesso ordine del modulo, e lo storico si aggancia per nome.
 * - Le cinque tabelle di registro ricevono point_id (le tre a punto), slot
 *   (fino a tre rilevazioni al giorno per postazione), la soglia minima
 *   fotografata (il caldo si controlla dal basso), e le colonne di modifica e
 *   di annullamento. Una registrazione non si cancella più: si annulla con un
 *   motivo e resta nel report come annullata. Il vincolo «una riga per
 *   giorno» diventa un indice parziale sulle righe vive: un annullamento
 *   libera il posto senza far sparire la riga.
 * - haccp_changes: ogni creazione, modifica o annullamento con prima/dopo,
 *   chi, quando e perché. In sola aggiunta: il trigger rifiuta gli UPDATE.
 *   user_id senza FK di proposito — un ON DELETE SET NULL su users sarebbe
 *   un UPDATE, che il trigger rifiuterebbe, e cancellare un utente morirebbe.
 * - haccp_nonconformities: lo scostamento e la sua azione correttiva (5°
 *   principio HACCP). Si aprono da sole sul fuori soglia o a mano; una sola
 *   aperta per registrazione d'origine.
 * - Permessi haccp:view / haccp:record a chi oggi apre l'HACCP
 *   (dashboard:view nella matrice del suo tenant), haccp:manage a titolare,
 *   direzione e manager. Restringibili dalla matrice ruoli. PLATFORM_ADMIN
 *   resta fuori (migration piattaforma-fuori-dalla-matrice).
 *
 * RLS con la stessa policy delle altre tabelle per-tenant sulle tre tabelle
 * nuove: la migration RLS globale è già girata e non copre tabelle nuove.
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

const dropUniques = (table) => `
    DO $$
    DECLARE c RECORD;
    BEGIN
        FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = '${table}'::regclass AND contype = 'u'
        LOOP
            EXECUTE format('ALTER TABLE ${table} DROP CONSTRAINT %I', c.conname);
        END LOOP;
    END $$;
`;

// Colonne di modifica e annullamento, uguali sulle cinque tabelle di registro.
const auditColumns = (table) => `
    ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS updated_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS updated_by_user_name VARCHAR(255),
        ADD COLUMN IF NOT EXISTS voided_at            TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS voided_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS voided_by_user_name  VARCHAR(255),
        ADD COLUMN IF NOT EXISTS void_reason          TEXT;
`;

// I punti di oggi del Frantoio, nell'ordine del modulo. Erano in
// utils/haccp.ts e services/haccpApiService.ts: da qui in poi sono dati.
const FRANTOIO_TEMPERATURES = [
    ['Cella 1', 4], ['Cella 2', 4], ['Cella 3', 4], ['Cella 4', 4],
    ['Banco cella grill', 4], ['Frigo antipasti', 4], ['Frigo primi', 4], ['Frigo office', 4],
    ['Congelatore 1c', -18], ['Congelatore 2c', -18], ['Congelatore gelati', -18],
];
const FRANTOIO_FRYERS = ['Friggitrice 1', 'Friggitrice 2', 'Friggitrice 3', 'Friggitrice 4', 'Friggitrice 5'];
const FRANTOIO_CLEANING = [
    'Banchi', 'Lavandini', 'Affettatrice', 'Cutter', 'Impastatrice',
    'Sfogliatrice', 'Taglieri', 'Pelapatate', 'Piani cottura',
];

const sqlString = (s) => `'${String(s).replace(/'/g, "''")}'`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    // ---- Punti di controllo -------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_points (
            id              SERIAL PRIMARY KEY,
            tenant_id       BIGINT NOT NULL,
            register        VARCHAR(20) NOT NULL
                            CHECK (register IN ('TEMPERATURE', 'OIL', 'CLEANING', 'THERMOMETER', 'EQUIPMENT')),
            label           VARCHAR(100) NOT NULL,
            min_temp        NUMERIC(5,1),
            max_temp        NUMERIC(5,1),
            checks_per_day  SMALLINT NOT NULL DEFAULT 1 CHECK (checks_per_day BETWEEN 1 AND 3),
            frequency       VARCHAR(12) NOT NULL DEFAULT 'DAILY'
                            CHECK (frequency IN ('DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND')),
            instructions    TEXT,
            sort_order      INTEGER NOT NULL DEFAULT 0,
            active          BOOLEAN NOT NULL DEFAULT true,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
            CHECK (min_temp IS NULL OR max_temp IS NULL OR min_temp <= max_temp)
        );
    `);
    // Due punti vivi con lo stesso nome nello stesso registro sarebbero due
    // righe indistinguibili sul foglio. Gli archiviati non contano: «Cella 1»
    // può rinascere dopo che la vecchia è stata dismessa.
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_points_label_active
             ON haccp_points (tenant_id, register, lower(label)) WHERE active;`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_points_register
             ON haccp_points (tenant_id, register, sort_order);`);

    const seed = (register, rows) => {
        const values = rows.map(([label, max], i) =>
            `(${sqlString(label)}, ${max === null || max === undefined ? 'NULL' : max}, ${i + 1})`).join(',\n                ');
        pgm.sql(`
            INSERT INTO haccp_points (tenant_id, register, label, max_temp, sort_order)
            SELECT 1, '${register}', v.label, v.max_temp::numeric, v.ord
              FROM (VALUES
                ${values}
              ) AS v(label, max_temp, ord)
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
               AND NOT EXISTS (
                   SELECT 1 FROM haccp_points p
                    WHERE p.tenant_id = 1 AND p.register = '${register}' AND lower(p.label) = lower(v.label)
               );
        `);
    };
    seed('TEMPERATURE', FRANTOIO_TEMPERATURES);
    seed('OIL', FRANTOIO_FRYERS.map(l => [l, null]));
    seed('CLEANING', FRANTOIO_CLEANING.map(l => [l, null]));

    // Etichette rimaste nello storico ma non fra i punti (un altro tenant che
    // abbia già usato il registro, o un nome cambiato): diventano punti, così
    // nessuna riga resta orfana. In produzione al 05/10/2026 non ce ne sono.
    pgm.sql(`
        INSERT INTO haccp_points (tenant_id, register, label, max_temp, sort_order)
        SELECT r.tenant_id, 'TEMPERATURE', r.location,
               (array_agg(r.target_max ORDER BY r.recorded_at DESC NULLS LAST))[1], 1000
          FROM haccp_temperature_readings r
         WHERE NOT EXISTS (
               SELECT 1 FROM haccp_points p
                WHERE p.tenant_id = r.tenant_id AND p.register = 'TEMPERATURE' AND lower(p.label) = lower(r.location)
         )
         GROUP BY r.tenant_id, r.location;
    `);
    pgm.sql(`
        INSERT INTO haccp_points (tenant_id, register, label, sort_order)
        SELECT DISTINCT o.tenant_id, 'OIL', o.fryer_label, 1000
          FROM haccp_oil_checks o
         WHERE NOT EXISTS (
               SELECT 1 FROM haccp_points p
                WHERE p.tenant_id = o.tenant_id AND p.register = 'OIL' AND lower(p.label) = lower(o.fryer_label)
         );
    `);
    pgm.sql(`
        INSERT INTO haccp_points (tenant_id, register, label, sort_order)
        SELECT DISTINCT c.tenant_id, 'CLEANING', c.point, 1000
          FROM haccp_cleaning_checks c
         WHERE NOT EXISTS (
               SELECT 1 FROM haccp_points p
                WHERE p.tenant_id = c.tenant_id AND p.register = 'CLEANING' AND lower(p.label) = lower(c.point)
         );
    `);

    // ---- Registri: punto, slot, soglia minima, modifica, annullamento -------
    pgm.sql(`
        ALTER TABLE haccp_temperature_readings
            ADD COLUMN IF NOT EXISTS point_id   INTEGER REFERENCES haccp_points(id),
            ADD COLUMN IF NOT EXISTS slot       SMALLINT NOT NULL DEFAULT 1 CHECK (slot BETWEEN 1 AND 3),
            ADD COLUMN IF NOT EXISTS target_min NUMERIC(5,1);
    `);
    pgm.sql(`ALTER TABLE haccp_oil_checks ADD COLUMN IF NOT EXISTS point_id INTEGER REFERENCES haccp_points(id);`);
    pgm.sql(`ALTER TABLE haccp_cleaning_checks ADD COLUMN IF NOT EXISTS point_id INTEGER REFERENCES haccp_points(id);`);
    for (const table of ['haccp_temperature_readings', 'haccp_oil_checks', 'haccp_cleaning_checks', 'haccp_goods_receipts', 'haccp_production_logs']) {
        pgm.sql(auditColumns(table));
    }

    pgm.sql(`
        UPDATE haccp_temperature_readings r SET point_id = p.id
          FROM haccp_points p
         WHERE r.point_id IS NULL AND p.tenant_id = r.tenant_id
           AND p.register = 'TEMPERATURE' AND p.active AND lower(p.label) = lower(r.location);
    `);
    pgm.sql(`
        UPDATE haccp_oil_checks r SET point_id = p.id
          FROM haccp_points p
         WHERE r.point_id IS NULL AND p.tenant_id = r.tenant_id
           AND p.register = 'OIL' AND p.active AND lower(p.label) = lower(r.fryer_label);
    `);
    pgm.sql(`
        UPDATE haccp_cleaning_checks r SET point_id = p.id
          FROM haccp_points p
         WHERE r.point_id IS NULL AND p.tenant_id = r.tenant_id
           AND p.register = 'CLEANING' AND p.active AND lower(p.label) = lower(r.point);
    `);

    // «Una riga per giorno» diventa «una riga VIVA per giorno e slot».
    pgm.sql(dropUniques('haccp_temperature_readings'));
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_temperature_one_live
             ON haccp_temperature_readings (tenant_id, date, point_id, slot) WHERE voided_at IS NULL;`);
    pgm.sql(dropUniques('haccp_oil_checks'));
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_oil_one_live
             ON haccp_oil_checks (tenant_id, date, point_id) WHERE voided_at IS NULL;`);
    pgm.sql(dropUniques('haccp_cleaning_checks'));
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_cleaning_one_live
             ON haccp_cleaning_checks (tenant_id, date, point_id) WHERE voided_at IS NULL;`);
    // Il report per periodo legge per tenant e intervallo di date.
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_temp_tenant_date ON haccp_temperature_readings (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_oil_tenant_date ON haccp_oil_checks (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_cleaning_tenant_date ON haccp_cleaning_checks (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_receipt_tenant_date ON haccp_goods_receipts (tenant_id, date);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_production_tenant_date ON haccp_production_logs (tenant_id, date);`);

    // ---- Storico delle correzioni --------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_changes (
            id          BIGSERIAL PRIMARY KEY,
            tenant_id   BIGINT NOT NULL,
            entity      VARCHAR(30) NOT NULL,
            entity_id   TEXT NOT NULL,
            action      VARCHAR(10) NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'VOID')),
            record_date DATE,
            before      JSONB,
            after       JSONB,
            reason      TEXT,
            user_id     INTEGER,
            user_name   VARCHAR(255),
            created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_changes_entity ON haccp_changes (tenant_id, entity, entity_id);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_changes_date ON haccp_changes (tenant_id, record_date);`);
    pgm.sql(`
        CREATE OR REPLACE FUNCTION haccp_changes_append_only() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'haccp_changes è in sola aggiunta: le correzioni si registrano, non si riscrivono';
        END;
        $$ LANGUAGE plpgsql;
    `);
    pgm.sql(`DROP TRIGGER IF EXISTS haccp_changes_no_update ON haccp_changes;`);
    pgm.sql(`CREATE TRIGGER haccp_changes_no_update BEFORE UPDATE ON haccp_changes
             FOR EACH ROW EXECUTE FUNCTION haccp_changes_append_only();`);

    // ---- Non conformità ------------------------------------------------------
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS haccp_nonconformities (
            id                  SERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL,
            date                DATE NOT NULL,
            source              VARCHAR(20) NOT NULL
                                CHECK (source IN ('TEMPERATURE', 'OIL', 'CLEANING', 'RECEIPT', 'PROCESS', 'CALIBRATION',
                                                  'SENSOR', 'INTERVENTION', 'RECALL', 'MANUAL')),
            source_id           TEXT,
            point_id            INTEGER REFERENCES haccp_points(id),
            title               VARCHAR(255) NOT NULL,
            detail              TEXT,
            status              VARCHAR(10) NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'VOID')),
            corrective_action   TEXT,
            opened_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            opened_by_user_name VARCHAR(255),
            opened_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
            closed_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            closed_by_user_name VARCHAR(255),
            closed_at           TIMESTAMPTZ,
            void_reason         TEXT,
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_nc_status ON haccp_nonconformities (tenant_id, status);`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_haccp_nc_date ON haccp_nonconformities (tenant_id, date);`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS haccp_nc_one_open_per_source
             ON haccp_nonconformities (tenant_id, source, source_id)
             WHERE status = 'OPEN' AND source_id IS NOT NULL;`);

    enableRls(pgm, 'haccp_points');
    enableRls(pgm, 'haccp_changes');
    enableRls(pgm, 'haccp_nonconformities');

    // ---- Permessi -------------------------------------------------------------
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT rp.tenant_id, rp.role, p.permission
          FROM role_permissions rp
         CROSS JOIN (VALUES ('haccp:view'), ('haccp:record')) AS p(permission)
         WHERE rp.permission = 'dashboard:view' AND rp.role <> 'PLATFORM_ADMIN'
        ON CONFLICT DO NOTHING;
    `);
    // La cucina compila il registro più di chiunque: la matrice di default
    // in auth/permissions.ts non le dà dashboard:view, quindi un tenant che
    // l'avesse tenuta così resterebbe senza chi misura le celle.
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, 'KITCHEN', p.permission
          FROM tenants t
         CROSS JOIN (VALUES ('haccp:view'), ('haccp:record')) AS p(permission)
        ON CONFLICT DO NOTHING;
    `);
    pgm.sql(`
        INSERT INTO role_permissions (tenant_id, role, permission)
        SELECT t.id, r.role, 'haccp:manage'
          FROM tenants t
         CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER')) AS r(role)
        ON CONFLICT DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission IN ('haccp:view', 'haccp:record', 'haccp:manage');`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_nonconformities;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_changes;`);
    pgm.sql(`DROP FUNCTION IF EXISTS haccp_changes_append_only();`);

    // Al ritorno vale di nuovo «una riga per giorno»: le righe annullate e gli
    // slot oltre il primo non ci stanno, e se ne vanno.
    pgm.sql(`DELETE FROM haccp_temperature_readings WHERE voided_at IS NOT NULL OR slot > 1;`);
    pgm.sql(`DELETE FROM haccp_oil_checks WHERE voided_at IS NOT NULL;`);
    pgm.sql(`DELETE FROM haccp_cleaning_checks WHERE voided_at IS NOT NULL;`);
    pgm.sql(`DELETE FROM haccp_goods_receipts WHERE voided_at IS NOT NULL;`);
    pgm.sql(`DELETE FROM haccp_production_logs WHERE voided_at IS NOT NULL;`);
    pgm.sql(`DROP INDEX IF EXISTS haccp_temperature_one_live;`);
    pgm.sql(`DROP INDEX IF EXISTS haccp_oil_one_live;`);
    pgm.sql(`DROP INDEX IF EXISTS haccp_cleaning_one_live;`);
    pgm.sql(`ALTER TABLE haccp_temperature_readings ADD CONSTRAINT haccp_temperature_readings_tenant_date_location_key UNIQUE (tenant_id, date, location);`);
    pgm.sql(`ALTER TABLE haccp_oil_checks ADD CONSTRAINT haccp_oil_checks_tenant_date_fryer_key UNIQUE (tenant_id, date, fryer_label);`);
    pgm.sql(`ALTER TABLE haccp_cleaning_checks ADD CONSTRAINT haccp_cleaning_checks_tenant_date_point_key UNIQUE (tenant_id, date, point);`);

    for (const table of ['haccp_temperature_readings', 'haccp_oil_checks', 'haccp_cleaning_checks', 'haccp_goods_receipts', 'haccp_production_logs']) {
        pgm.sql(`
            ALTER TABLE ${table}
                DROP COLUMN IF EXISTS updated_at,
                DROP COLUMN IF EXISTS updated_by_user_id,
                DROP COLUMN IF EXISTS updated_by_user_name,
                DROP COLUMN IF EXISTS voided_at,
                DROP COLUMN IF EXISTS voided_by_user_id,
                DROP COLUMN IF EXISTS voided_by_user_name,
                DROP COLUMN IF EXISTS void_reason;
        `);
    }
    pgm.sql(`ALTER TABLE haccp_temperature_readings DROP COLUMN IF EXISTS point_id, DROP COLUMN IF EXISTS slot, DROP COLUMN IF EXISTS target_min;`);
    pgm.sql(`ALTER TABLE haccp_oil_checks DROP COLUMN IF EXISTS point_id;`);
    pgm.sql(`ALTER TABLE haccp_cleaning_checks DROP COLUMN IF EXISTS point_id;`);
    pgm.sql(`DROP TABLE IF EXISTS haccp_points;`);
};
