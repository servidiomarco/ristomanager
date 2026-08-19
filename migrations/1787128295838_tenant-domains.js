/**
 * Fase C3 — Prenotazioni web per tenant (tenant_domains).
 *
 * Mappa un hostname pubblico (es. prenotazioni.vecchiofrantoio.com) al suo
 * tenant: sostituisce il redirect hardcoded sulla root di server.ts e dà a
 * ogni ristorante la possibilità di puntare un dominio custom alla propria
 * pagina /prenota/<slug>. `purpose` distingue fin d'ora i domini di booking
 * da quelli del CRM (serviranno alla allowlist CORS di D4).
 *
 * NIENTE RLS, di proposito: come `tenants`, è una tabella di routing della
 * piattaforma — si consulta PRIMA di sapere chi è il tenant (è proprio lei
 * a dirlo), quindi una policy su app.tenant_id non avrebbe mai il contesto
 * per funzionare.
 *
 * Il dominio è la PK (lowercase per convenzione: il resolver normalizza
 * prima della lookup): un hostname non può appartenere a due ristoranti.
 *
 * Seed: il dominio storico del Frantoio, così il redirect data-driven
 * subentra a quello hardcoded senza nessun passo manuale al deploy.
 * ON CONFLICT DO NOTHING: la ri-esecuzione non tocca una riga già
 * eventualmente ripuntata altrove.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS tenant_domains (
            domain     VARCHAR(255) PRIMARY KEY,
            tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
            purpose    VARCHAR(20) NOT NULL DEFAULT 'booking'
                       CHECK (purpose IN ('booking', 'crm')),
            created_at TIMESTAMPTZ DEFAULT now()
        );

        INSERT INTO tenant_domains (domain, tenant_id, purpose)
        VALUES ('prenotazioni.vecchiofrantoio.com', 1, 'booking')
        ON CONFLICT DO NOTHING;
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS tenant_domains;`);
};
