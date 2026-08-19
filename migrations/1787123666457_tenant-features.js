/**
 * Fase C1 — Entitlements commerciali (tenant_features).
 *
 * Il livello commerciale SOPRA i flag operativi di app_settings
 * (voice_agent_enabled, public_bookings_enabled…): quelli dicono se il
 * ristoratore ha ACCESO il canale, questa tabella dice se il canale gli
 * è stato VENDUTO. I due livelli non si sostituiscono: un add-on
 * disattivato qui spegne il canale anche se il flag operativo è on.
 *
 * `config JSONB` è margine per la Fase C2 (agent_id ElevenLabs, numero
 * WhatsApp mittente…): oggi resta NULL, ma la colonna nasce insieme alla
 * tabella per non rifare una migration al primo campo di configurazione.
 *
 * RLS identica per forma a row-level-security (B4): ENABLE + FORCE
 * (l'owner della tabella bypassa la RLS se non forzata) e fallback
 * permissivo quando app.tenant_id non è impostata — le letture degli
 * entitlement passano da pool.query, non da withTenant, e una policy
 * rigida oggi le spegnerebbe. Il fallback cade prima del tenant 2,
 * insieme a quello di B4.
 *
 * Seed: il Vecchio Frantoio (tenant 1) è grandfathered — usa già tutti e
 * tre i canali in produzione, quindi nascono ENABLED. ON CONFLICT DO
 * NOTHING: una ri-esecuzione o un seed concorrente non deve sovrascrivere
 * una scelta commerciale fatta nel frattempo.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS tenant_features (
            tenant_id BIGINT NOT NULL REFERENCES tenants(id),
            feature VARCHAR(40) NOT NULL CHECK (feature IN ('voice', 'whatsapp', 'web_booking')),
            enabled BOOLEAN NOT NULL DEFAULT false,
            config JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (tenant_id, feature)
        );

        ALTER TABLE tenant_features ENABLE ROW LEVEL SECURITY;
        ALTER TABLE tenant_features FORCE ROW LEVEL SECURITY;
        DROP POLICY IF EXISTS tenant_isolation ON tenant_features;
        CREATE POLICY tenant_isolation ON tenant_features
            USING (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::bigint, tenant_id))
            WITH CHECK (tenant_id = COALESCE(NULLIF(current_setting('app.tenant_id', true), '')::bigint, tenant_id));

        INSERT INTO tenant_features (tenant_id, feature, enabled)
        VALUES (1, 'voice', true), (1, 'whatsapp', true), (1, 'web_booking', true)
        ON CONFLICT (tenant_id, feature) DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS tenant_features;`);
};
