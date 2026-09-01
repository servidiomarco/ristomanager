/* Nodo di sala, prima tranche (tappa 3 del brainstorming ibrido: relay
 * Socket.IO + cache di lettura sulla LAN del ristorante).
 *
 *   - sala_node_token   → header x-sala-node-token e handshake del namespace
 *                         /sala-node: come print_agent_token, il nodo è un
 *                         processo, non un utente. VARCHAR(64) UNIQUE,
 *                         nullable: nasce col provisioning; qui si backfilla
 *                         solo il tenant 1 (il Frantoio è il collaudo).
 *   - sala_node_certs   → certificati TLS per il sottodominio del nodo
 *                         (sala.<slug>.sympotia.com), emessi dal cloud via
 *                         DNS-01 e scaricati dal nodo con /sala-node/credentials.
 *                         Vivono a DB e non sul nodo: il nodo è bestiame,
 *                         se ne muore uno il sostituto riscarica tutto.
 *   - entitlement 'sala_node' → livello commerciale: il nodo si vende come
 *                         add-on (hardware in comodato), fail-closed come
 *                         'passepartout'. Acceso qui per il solo tenant 1.
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE EXTENSION IF NOT EXISTS pgcrypto;

        ALTER TABLE tenants ADD COLUMN IF NOT EXISTS sala_node_token VARCHAR(64) UNIQUE;

        -- Backfill del solo tenant 1; il WHERE ... IS NULL rende la migration
        -- ri-eseguibile senza ruotare un token già installato sul PC di sala.
        UPDATE tenants
        SET sala_node_token = encode(gen_random_bytes(24), 'hex')
        WHERE id = 1 AND sala_node_token IS NULL;
    `);

    pgm.sql(`
        CREATE TABLE sala_node_certs (
            id         SERIAL PRIMARY KEY,
            tenant_id  INTEGER NOT NULL,
            domain     TEXT NOT NULL,
            cert_pem   TEXT NOT NULL,
            key_pem    TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (tenant_id, domain)
        );
    `);

    // RLS come per ogni tabella con tenant_id (espressione verbatim da
    // outbox-eventi-comanda); il rinnovo certificati gira come lavoro di
    // piattaforma dichiarato (runAsPlatform).
    pgm.sql(`ALTER TABLE sala_node_certs ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE sala_node_certs FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON sala_node_certs;`);
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
    pgm.sql(`
        CREATE POLICY tenant_isolation ON sala_node_certs
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);

    // Il CHECK sui nomi feature va allargato PRIMA del seed (stesso giro
    // della migration import-menu-passepartout, che l'ha già riscritto una
    // volta: si riparte dalla sua lista).
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout', 'sala_node'));`);
    pgm.sql(`INSERT INTO tenant_features (tenant_id, feature, enabled)
             SELECT 1, 'sala_node', TRUE
             WHERE EXISTS (SELECT 1 FROM tenants WHERE id = 1)
             ON CONFLICT (tenant_id, feature) DO NOTHING;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`
        DELETE FROM tenant_features WHERE feature = 'sala_node';
        DROP TABLE IF EXISTS sala_node_certs;
        ALTER TABLE tenants DROP COLUMN IF EXISTS sala_node_token;
    `);
    pgm.sql(`ALTER TABLE tenant_features DROP CONSTRAINT IF EXISTS tenant_features_feature_check;`);
    pgm.sql(`ALTER TABLE tenant_features ADD CONSTRAINT tenant_features_feature_check
             CHECK (feature IN ('voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout'));`);
};
