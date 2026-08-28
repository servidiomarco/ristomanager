/* Preset dei messaggi rapidi della chat staff, gestibili da Impostazioni
 * (piano §9). Tabella vuota = valgono i default hardcoded in
 * services/staffChat.ts: un tenant che non tocca nulla continua a vedere
 * "Piatto finito" e gli altri; il primo salvataggio dalla card li
 * sostituisce per intero (PUT che rimpiazza la lista, come i permessi).
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE staff_chat_presets (
            id         SERIAL PRIMARY KEY,
            tenant_id  BIGINT NOT NULL,
            label      VARCHAR(60) NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
            sort_order INTEGER NOT NULL DEFAULT 0
        );
    `);
    pgm.sql(`CREATE INDEX staff_chat_presets_tenant ON staff_chat_presets (tenant_id, sort_order);`);

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
    pgm.sql(`ALTER TABLE staff_chat_presets ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE staff_chat_presets FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON staff_chat_presets;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON staff_chat_presets
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS staff_chat_presets;`);
};
