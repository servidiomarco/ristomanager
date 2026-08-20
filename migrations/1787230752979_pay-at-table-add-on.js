/**
 * Conto al tavolo come add-on commerciale (entitlement 'pay_at_table').
 *
 * Backfill acceso per TUTTI i tenant esistenti: chi è nato prima di questo
 * add-on lo usava come parte del prodotto — spegnerglielo col deploy sarebbe
 * un downgrade a sorpresa in servizio. I tenant provisionati d'ora in poi
 * nascono con la riga spenta (il provisioning inserisce ogni feature di
 * TENANT_FEATURES a false salvo richiesta esplicita), e l'add-on si accende
 * dal billing Stripe (STRIPE_PRICE_PAY_AT_TABLE) o dal pannello piattaforma.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        -- La CHECK sui nomi feature (migration tenant-features) è nata con i
        -- tre add-on di allora: va allargata PRIMA dell'INSERT o il backfill
        -- muore con un 23514. Il vincolo anonimo della CREATE TABLE ha nome
        -- autogenerato: si droppa per nome convenzionale e si ricrea esplicito.
        ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;
        ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
            CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table'));

        INSERT INTO tenant_features (tenant_id, feature, enabled)
        SELECT id, 'pay_at_table', true FROM tenants
        ON CONFLICT (tenant_id, feature) DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        DELETE FROM tenant_features WHERE feature = 'pay_at_table';
        ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;
        ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
            CHECK (feature IN ('voice', 'whatsapp', 'web_booking'));
    `);
};
