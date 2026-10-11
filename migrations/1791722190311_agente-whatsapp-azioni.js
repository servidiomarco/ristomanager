/**
 * WhatsApp, Fase 7: l'agente prenota, sposta e annulla da solo.
 *
 * Le azioni automatiche stanno in agent_proposals accanto alle proposte,
 * perché per lo staff sono la stessa cosa vista da due lati: una riga
 * «l'agente vuole fare X» che conferma lui, o «l'agente ha fatto X» che può
 * annullare. auto distingue le due; run_id lega l'azione al giro che l'ha
 * fatta; before_state e after_state sono la prenotazione prima e dopo, e
 * servono al tasto «Annulla»: si ripristina solo se la riga è ancora come
 * l'agente l'ha lasciata (se lo staff l'ha toccata nel frattempo vince lui).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE agent_proposals
            ADD COLUMN IF NOT EXISTS auto              BOOLEAN NOT NULL DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS run_id            BIGINT,
            ADD COLUMN IF NOT EXISTS before_state      JSONB,
            ADD COLUMN IF NOT EXISTS after_state       JSONB,
            ADD COLUMN IF NOT EXISTS undone_at         TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS undone_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS agent_proposals_auto ON agent_proposals (tenant_id, phone_digits, created_at DESC) WHERE auto;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS agent_proposals_auto;`);
    pgm.sql(`
        ALTER TABLE agent_proposals
            DROP COLUMN IF EXISTS undone_by_user_id,
            DROP COLUMN IF EXISTS undone_at,
            DROP COLUMN IF EXISTS after_state,
            DROP COLUMN IF EXISTS before_state,
            DROP COLUMN IF EXISTS run_id,
            DROP COLUMN IF EXISTS auto;
    `);
};
