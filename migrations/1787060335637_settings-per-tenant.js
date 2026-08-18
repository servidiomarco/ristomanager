/**
 * Fase B3, dominio "impostazioni & config": le tabelle di configurazione
 * passano da singleton a per-tenant. PK e vincoli unici diventano
 * compositi nello stesso PR che aggiorna le query e gli ON CONFLICT del
 * dominio (regola stabilita in B1).
 *
 * - app_settings:                  PK (key)                    → (tenant_id, key)
 * - opening_hours:                 PK (weekday)                → (tenant_id, weekday)
 * - opening_hours_disabled_slots:  PK (weekday,shift,slot)     → (tenant_id, weekday, shift, slot_time)
 * - special_closures:              UNIQUE (date,shift)         → (tenant_id, date, shift)
 *
 * integration_settings (PK provider) NON si tocca qui: appartiene al
 * dominio pagamenti/messaggistica, che riscriverà vincolo e query insieme.
 *
 * I seed di createSchema su queste tabelle sono stati portati a
 * "ON CONFLICT DO NOTHING" senza target (validi con qualunque vincolo),
 * perché sul primo boot di un database vuoto girano PRIMA di questa
 * migration, e sui boot successivi DOPO.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;`);
    pgm.sql(`ALTER TABLE app_settings ADD CONSTRAINT app_settings_pkey PRIMARY KEY (tenant_id, key);`);

    pgm.sql(`ALTER TABLE opening_hours DROP CONSTRAINT opening_hours_pkey;`);
    pgm.sql(`ALTER TABLE opening_hours ADD CONSTRAINT opening_hours_pkey PRIMARY KEY (tenant_id, weekday);`);

    pgm.sql(`ALTER TABLE opening_hours_disabled_slots DROP CONSTRAINT opening_hours_disabled_slots_pkey;`);
    pgm.sql(`ALTER TABLE opening_hours_disabled_slots ADD CONSTRAINT opening_hours_disabled_slots_pkey PRIMARY KEY (tenant_id, weekday, shift, slot_time);`);

    // Vincolo unico con nome auto-generato: drop dinamico. La forma resta
    // identica (shift nullable ⇒ le chiusure giornata-intera, shift NULL,
    // continuano a non collidere fra loro).
    pgm.sql(`
        DO $$
        DECLARE c RECORD;
        BEGIN
            FOR c IN
                SELECT conname
                  FROM pg_constraint
                 WHERE conrelid = 'special_closures'::regclass
                   AND contype = 'u'
            LOOP
                EXECUTE format('ALTER TABLE special_closures DROP CONSTRAINT %I', c.conname);
            END LOOP;
        END $$;
    `);
    pgm.sql(`
        ALTER TABLE special_closures
            ADD CONSTRAINT special_closures_tenant_date_shift_key
            UNIQUE (tenant_id, date, shift);
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`ALTER TABLE app_settings DROP CONSTRAINT app_settings_pkey;`);
    pgm.sql(`ALTER TABLE app_settings ADD CONSTRAINT app_settings_pkey PRIMARY KEY (key);`);
    pgm.sql(`ALTER TABLE opening_hours DROP CONSTRAINT opening_hours_pkey;`);
    pgm.sql(`ALTER TABLE opening_hours ADD CONSTRAINT opening_hours_pkey PRIMARY KEY (weekday);`);
    pgm.sql(`ALTER TABLE opening_hours_disabled_slots DROP CONSTRAINT opening_hours_disabled_slots_pkey;`);
    pgm.sql(`ALTER TABLE opening_hours_disabled_slots ADD CONSTRAINT opening_hours_disabled_slots_pkey PRIMARY KEY (weekday, shift, slot_time);`);
    pgm.sql(`ALTER TABLE special_closures DROP CONSTRAINT IF EXISTS special_closures_tenant_date_shift_key;`);
    pgm.sql(`ALTER TABLE special_closures ADD CONSTRAINT special_closures_date_shift_key UNIQUE (date, shift);`);
};
