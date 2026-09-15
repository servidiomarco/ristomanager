/**
 * Modulo asporto — fondamenta (fase 1 del piano take-away).
 *
 * L'ordine d'asporto è un'entità di primo livello, NON una comanda con un
 * tavolo virtuale: risponde a «cosa vuoi e a che ora lo ritiri», e tutta la
 * sua vita ruota attorno all'ora di ritiro. La comanda di cucina la genererà
 * lui al momento giusto (kitchen_order_id, cablata in una PR successiva),
 * riusando KDS, coda stampa e push così come sono.
 *
 * - takeaway_orders: cliente (nome + telefono libero, l'aggancio rubrica
 *   passa dagli indici telefonici esistenti), slot di ritiro (pickup_date +
 *   pickup_time 'HH:MM', la stessa griglia di opening_hours che usa la
 *   pagina prenotazioni), shift derivato dallo slot (nessun CHECK: i CHECK
 *   sui turni sono stati rimossi ovunque, vedi drop-shift-checks), stato e
 *   canale d'ingresso. REQUESTED e i canali WEB/VOICE/WHATSAPP sono già nel
 *   CHECK perché arrivano nelle fasi 2-3: meglio un valore inerte oggi che
 *   una migration sul CHECK domani.
 * - takeaway_order_items: righe con snapshot nome/prezzo come order_items —
 *   il menu cambia, l'ordine preso resta quello che si è detto al cliente.
 *   dish_id ON DELETE SET NULL per lo stesso motivo.
 * - feature 'takeaway' in tenant_features: add-on commerciale, acceso qui
 *   per il Vecchio Frantoio (tenant 1) come 'reviews'.
 * - permessi takeaway:view / takeaway:manage a OWNER, GENERAL_MANAGER,
 *   MANAGER, RECEPTION e CASSA: l'asporto vive fra banco e cassa, non in
 *   cucina (la cucina lo vede dal KDS come ogni comanda). Restringibile
 *   dalla matrice ruoli.
 *
 * RLS con la stessa policy delle altre tabelle per-tenant: la migration RLS
 * globale è già girata e non copre tabelle nuove.
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
        CREATE TABLE IF NOT EXISTS takeaway_orders (
            id                 BIGSERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            customer_name      VARCHAR(120) NOT NULL,
            customer_phone     VARCHAR(40),
            pickup_date        DATE NOT NULL,
            pickup_time        VARCHAR(5) NOT NULL,
            shift              VARCHAR(10) NOT NULL,
            status             VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED'
                               CHECK (status IN ('REQUESTED', 'CONFIRMED', 'IN_PREPARATION', 'READY', 'PICKED_UP', 'NO_SHOW', 'CANCELLED')),
            channel            VARCHAR(20) NOT NULL DEFAULT 'STAFF'
                               CHECK (channel IN ('STAFF', 'WEB', 'VOICE', 'WHATSAPP')),
            notes              TEXT,
            kitchen_order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL,
            created_by_user_id INTEGER,
            ready_at           TIMESTAMPTZ,
            picked_up_at       TIMESTAMPTZ,
            cancelled_at       TIMESTAMPTZ,
            created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_takeaway_orders_service
             ON takeaway_orders (tenant_id, pickup_date, shift);`);
    // Il conteggio di capienza per slot filtra sempre gli annullati: indice
    // parziale sugli attivi, lo storico non pesa.
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_takeaway_orders_slot_active
             ON takeaway_orders (tenant_id, pickup_date, pickup_time)
             WHERE status NOT IN ('CANCELLED', 'NO_SHOW');`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS takeaway_order_items (
            id                 BIGSERIAL PRIMARY KEY,
            tenant_id          BIGINT NOT NULL,
            takeaway_order_id  BIGINT NOT NULL REFERENCES takeaway_orders(id) ON DELETE CASCADE,
            dish_id            INTEGER REFERENCES dishes(id) ON DELETE SET NULL,
            name_snapshot      VARCHAR(255) NOT NULL,
            unit_price_cents   INTEGER NOT NULL DEFAULT 0 CHECK (unit_price_cents >= 0),
            qty                INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
            note               TEXT
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_takeaway_order_items_order
             ON takeaway_order_items (tenant_id, takeaway_order_id);`);

    enableRls(pgm, 'takeaway_orders');
    enableRls(pgm, 'takeaway_order_items');

    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'reviews', 'takeaway'));`);
    pgm.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled)
             SELECT 1, 'takeaway', true
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
             ON CONFLICT (tenant_id, feature) DO NOTHING;`);

    pgm.sql(`INSERT INTO role_permissions (tenant_id, role, permission)
             SELECT t.id, r.role, p.permission
             FROM tenants t
             CROSS JOIN (VALUES ('OWNER'), ('GENERAL_MANAGER'), ('MANAGER'), ('RECEPTION'), ('CASSA')) AS r(role)
             CROSS JOIN (VALUES ('takeaway:view'), ('takeaway:manage')) AS p(permission)
             ON CONFLICT DO NOTHING;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM role_permissions WHERE permission IN ('takeaway:view', 'takeaway:manage');`);
    pgm.sql(`DELETE FROM tenant_features WHERE feature = 'takeaway';`);
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'reviews'));`);
    pgm.sql(`DROP TABLE IF EXISTS takeaway_order_items;`);
    pgm.sql(`DROP TABLE IF EXISTS takeaway_orders;`);
};
