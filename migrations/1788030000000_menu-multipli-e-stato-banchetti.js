/* Due menu di sistema più i menu stagionali, e lo stato dei banchetti.
 *
 * - `menus`: "Alla carta" e "Banchetti" (system_key, non eliminabili) più i
 *   menu creati dal ristoratore (Ferragosto, Pasqua…). system_key decide il
 *   ruolo operativo: ALLA_CARTA governa comande e menu digitale, BANQUETS i
 *   piatti proponibili nella composizione banchetti.
 * - `dish_menus`: appartenenza piatto→menu (spunte nel form del piatto).
 *   Seed: ogni piatto esistente in ENTRAMBI i menu di sistema, così il
 *   giorno del deploy nessuna superficie perde piatti — la cura è del
 *   ristoratore, dopo.
 * - `banquet_menus.status`: QUOTE (preventivo) / CONFIRMED. Gli eventi già
 *   in archivio nascono CONFIRMED (sono banchetti veri, non preventivi);
 *   il default passa poi a QUOTE per i nuovi.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE menus (
            id         SERIAL PRIMARY KEY,
            tenant_id  BIGINT NOT NULL,
            name       VARCHAR(80) NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
            system_key VARCHAR(20) CHECK (system_key IN ('ALLA_CARTA', 'BANQUETS')),
            sort_order INTEGER NOT NULL DEFAULT 0
        );
    `);
    pgm.sql(`CREATE UNIQUE INDEX menus_tenant_system ON menus (tenant_id, system_key) WHERE system_key IS NOT NULL;`);
    pgm.sql(`CREATE INDEX menus_tenant ON menus (tenant_id, sort_order);`);

    pgm.sql(`
        CREATE TABLE dish_menus (
            tenant_id BIGINT NOT NULL,
            dish_id   INTEGER NOT NULL REFERENCES dishes(id) ON DELETE CASCADE,
            menu_id   INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
            PRIMARY KEY (dish_id, menu_id)
        );
    `);
    pgm.sql(`CREATE INDEX dish_menus_menu ON dish_menus (menu_id);`);

    // RLS come per ogni tabella nuova con tenant_id (pattern outbox).
    const POLICY = `
        (tenant_id = (NULLIF(current_setting('app.tenant_id', true), ''))::bigint)
        OR (
            (NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
            AND (
                (current_setting('app.rls_strict', true) IS DISTINCT FROM 'on')
                OR (current_setting('app.rls_bypass', true) = 'on')
            )
        )
    `;
    for (const table of ['menus', 'dish_menus']) {
        pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
        pgm.sql(`
            CREATE POLICY tenant_isolation ON ${table}
            USING (${POLICY})
            WITH CHECK (${POLICY});
        `);
    }

    // Menu di sistema per i tenant esistenti; per quelli futuri li crea
    // ensureSystemMenus alla prima lettura di /menus.
    pgm.sql(`
        INSERT INTO menus (tenant_id, name, system_key, sort_order)
        SELECT id, 'Alla carta', 'ALLA_CARTA', 0 FROM tenants
        UNION ALL
        SELECT id, 'Banchetti', 'BANQUETS', 1 FROM tenants;
    `);
    pgm.sql(`
        INSERT INTO dish_menus (tenant_id, dish_id, menu_id)
        SELECT d.tenant_id, d.id, m.id
        FROM dishes d
        JOIN menus m ON m.tenant_id = d.tenant_id AND m.system_key IS NOT NULL;
    `);

    pgm.sql(`ALTER TABLE banquet_menus ADD COLUMN status VARCHAR(10) NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('QUOTE', 'CONFIRMED'));`);
    pgm.sql(`ALTER TABLE banquet_menus ALTER COLUMN status SET DEFAULT 'QUOTE';`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE banquet_menus DROP COLUMN IF EXISTS status;`);
    pgm.sql(`DROP TABLE IF EXISTS dish_menus;`);
    pgm.sql(`DROP TABLE IF EXISTS menus;`);
};
