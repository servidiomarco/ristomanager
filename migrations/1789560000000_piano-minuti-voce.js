/* Piano dei minuti di Sofia per ristorante (Fase 2).
 *
 * voice_plans: una riga per tenant, facoltativa. Ogni colonna NULL vale il
 * default di services/voicePlan.ts (49 €, 250 minuti, 0,20 €/min, tetto
 * extra 50 €): così cambiare il listino per tutti è una riga di codice, e un
 * accordo particolare con un ristorante è una riga qui.
 *  - price_cents, included_minutes, overage_cents_per_minute: li decide la
 *    piattaforma (pannello Piattaforma).
 *  - extra_cap_cents: tetto di spesa per i minuti extra del mese, lo sceglie
 *    il ristoratore. 0 = nessun extra. In Fase 2 serve agli avvisi; lo stop
 *    di Sofia al tetto arriva con la Fase 4.
 *
 * voice_usage_alerts: un avviso per soglia per mese, una volta sola. La
 * chiave primaria fa da lucchetto: il primo INSERT vince, gli altri post-call
 * dello stesso mese trovano la riga e non rimandano la notifica.
 */
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

export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS voice_plans (
            tenant_id                 INTEGER PRIMARY KEY REFERENCES tenants(id),
            price_cents               INTEGER CHECK (price_cents >= 0),
            included_minutes          INTEGER CHECK (included_minutes >= 0),
            overage_cents_per_minute  INTEGER CHECK (overage_cents_per_minute >= 0),
            extra_cap_cents           INTEGER CHECK (extra_cap_cents >= 0),
            updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_by                INTEGER REFERENCES users(id) ON DELETE SET NULL
        );
    `);
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS voice_usage_alerts (
            tenant_id  INTEGER NOT NULL REFERENCES tenants(id),
            month      DATE NOT NULL,
            threshold  VARCHAR(20) NOT NULL,
            sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (tenant_id, month, threshold)
        );
    `);
    for (const table of ['voice_plans', 'voice_usage_alerts']) {
        pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
        pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
        pgm.sql(`CREATE POLICY tenant_isolation ON ${table} USING (${POLICY}) WITH CHECK (${POLICY});`);
    }
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS voice_usage_alerts;`);
    pgm.sql(`DROP TABLE IF EXISTS voice_plans;`);
};
