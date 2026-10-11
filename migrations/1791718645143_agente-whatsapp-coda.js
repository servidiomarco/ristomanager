/**
 * WhatsApp, Fase 6: l'agente parte da solo quando arriva un messaggio.
 *
 * agent_runs è la coda: una riga «pending» per conversazione, che si sposta
 * avanti (due_at) a ogni messaggio che il cliente aggiunge, fino a un tetto,
 * così tre messaggi di fila («Buongiorno», «vorrei prenotare», «per 4»)
 * danno un giro solo. Sta nel database perché un riavvio non perda i
 * messaggi in attesa. La riga resta dopo il giro come registro: esito,
 * motivo del salto, bozza, consumo.
 *
 * agent_conversation_state tiene quello che vale per la conversazione e non
 * per un giro: la pausa decisa dallo staff (o dal riconoscimento di un
 * risponditore automatico) e, dalla Fase 7, la conferma che l'agente
 * aspetta dal cliente.
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

const rls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`CREATE POLICY tenant_isolation ON ${table} USING (${RLS_POLICY}) WITH CHECK (${RLS_POLICY});`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS agent_runs (
            id               BIGSERIAL PRIMARY KEY,
            tenant_id        BIGINT NOT NULL REFERENCES tenants(id),
            phone_digits     VARCHAR(20) NOT NULL,
            status           VARCHAR(12) NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'running', 'done', 'skipped', 'superseded', 'failed')),
            mode             VARCHAR(10),
            simulated        BOOLEAN NOT NULL DEFAULT FALSE,
            due_at           TIMESTAMPTZ NOT NULL,
            first_inbound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_inbound_id  INTEGER,
            inbound_count    INTEGER NOT NULL DEFAULT 1,
            claimed_at       TIMESTAMPTZ,
            finished_at      TIMESTAMPTZ,
            attempts         INTEGER NOT NULL DEFAULT 0,
            outcome          VARCHAR(20),
            skip_reason      TEXT,
            draft_text       TEXT,
            draft_state      VARCHAR(10) CHECK (draft_state IN ('new', 'used', 'discarded')),
            reply_message_id INTEGER,
            proposal_id      INTEGER,
            usage            JSONB,
            error            TEXT,
            created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_pending ON agent_runs (tenant_id, phone_digits) WHERE status = 'pending';`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS agent_runs_due ON agent_runs (due_at) WHERE status = 'pending';`);
    pgm.sql(`CREATE INDEX IF NOT EXISTS agent_runs_thread ON agent_runs (tenant_id, phone_digits, created_at DESC);`);
    rls(pgm, 'agent_runs');

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS agent_conversation_state (
            tenant_id            BIGINT NOT NULL REFERENCES tenants(id),
            phone_digits         VARCHAR(20) NOT NULL,
            paused_until         TIMESTAMPTZ,
            pause_reason         VARCHAR(20),
            paused_by_user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
            pending_confirmation JSONB,
            updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (tenant_id, phone_digits)
        );
    `);
    rls(pgm, 'agent_conversation_state');
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS agent_conversation_state;`);
    pgm.sql(`DROP TABLE IF EXISTS agent_runs;`);
};
