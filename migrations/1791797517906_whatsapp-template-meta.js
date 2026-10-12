/**
 * WhatsApp, Fase 12b: i template sul numero Meta di un locale.
 *
 * Il Frantoio usa i template del suo account Twilio, con le SID in env. Un
 * locale col proprio numero Meta ha i suoi: li crea Sympotia nel suo account
 * WhatsApp Business al collegamento (services/whatsapp/templates/provision.ts)
 * e Meta li approva uno per uno. Qui lo stato di ciascuno, per chiave del
 * catalogo e lingua: cosa si può mandare, cosa è in approvazione, cosa Meta
 * ha rifiutato e perché.
 *
 * waba_id è l'account dove il template esiste: se il locale collega un altro
 * account i template vanno ricreati là, e le righe vecchie non valgono più.
 * Il webhook message_template_status_update arriva per account, nome e
 * lingua, senza il locale: da qui l'indice su (waba_id, name, language).
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

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS whatsapp_templates (
            id            BIGSERIAL PRIMARY KEY,
            tenant_id     BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
            provider      VARCHAR(10) NOT NULL DEFAULT 'meta' CHECK (provider IN ('meta')),
            template_key  VARCHAR(60) NOT NULL,
            language      VARCHAR(5) NOT NULL,
            name          VARCHAR(120) NOT NULL,
            waba_id       VARCHAR(40) NOT NULL,
            external_id   VARCHAR(40),
            category      VARCHAR(20),
            status        VARCHAR(20) NOT NULL,
            reason        TEXT,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, template_key, language)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS whatsapp_templates_waba_name_idx ON whatsapp_templates (waba_id, name, language);`);
    pgm.sql(`ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON whatsapp_templates;`);
    pgm.sql(`CREATE POLICY tenant_isolation ON whatsapp_templates USING (${RLS_POLICY}) WITH CHECK (${RLS_POLICY});`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS whatsapp_templates;`);
};
