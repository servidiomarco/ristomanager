/**
 * Import del menu dalla cassa Passepartout dentro l'anagrafica `dishes`.
 *
 * Il menu ristorante del CRM È la tabella dishes (comande, banchetti,
 * listini, stazioni cucina): l'import non crea un modulo parallelo, aggancia
 * gli articoli del gestionale ai piatti esistenti.
 *
 * - `external_ref` ("pp:articolo:<id>") lega il piatto all'articolo di cassa:
 *   è la chiave dell'upsert di sync, unica per tenant. NULL = piatto nato nel
 *   CRM, mai toccato dal sync.
 * - `is_active`: un articolo disattivato in cassa non sparisce (le comande
 *   storiche lo referenziano), si spegne. Il picker dell'orderpad lo nasconde,
 *   la gestione menu lo mostra spento.
 * - feature `passepartout` in tenant_features: l'integrazione cassa (import
 *   menu e chiusura conti) è dell'unico ristorante col gestionale — il
 *   Vecchio Frantoio (tenant 1), acceso qui sotto. Gli altri tenant gestiscono
 *   il menu a mano.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS external_ref TEXT;`);
    pgm.sql(`ALTER TABLE dishes ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;`);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dishes_tenant_external_ref
             ON dishes(tenant_id, external_ref) WHERE external_ref IS NOT NULL;`);

    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout'));`);
    pgm.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled)
             SELECT 1, 'passepartout', true
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
             ON CONFLICT (tenant_id, feature) DO NOTHING;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DELETE FROM tenant_features WHERE feature = 'passepartout';`);
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table'));`);
    pgm.sql(`DROP INDEX IF EXISTS idx_dishes_tenant_external_ref;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS external_ref;`);
    pgm.sql(`ALTER TABLE dishes DROP COLUMN IF EXISTS is_active;`);
};
