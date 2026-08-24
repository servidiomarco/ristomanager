/**
 * Libro cassa del conto al tavolo — fase 1 del piano fatturazione
 * (docs/fatturazione-chiusura-conto-brainstorm.md).
 *
 * Fin qui la chiusura conosceva due soli "metodi": le quote pagate online
 * (table_bill_splits) e un forfait contanti scritto su table_bills
 * (cash_settled_cents). Il tavolo reale paga misto — "80 col POS, 40 in
 * contanti, 30 in buoni pasto" — e la chiusura di cassa serale vuole i
 * totali PER metodo. Questa tabella è il libro cassa: una riga per
 * movimento di incasso.
 *
 * Due famiglie di righe, distinte da table_bill_split_id:
 *  - NULL     → incasso registrato dallo staff (contanti, POS fisico, buoni,
 *               …). Pesa sul residuo del conto.
 *  - NOT NULL → specchio di una quota online PAID (method LINK_ONLINE),
 *               scritta dal webhook. Serve SOLO al report per metodo: il
 *               residuo la conta già tramite la quota, contarla due volte
 *               raddoppierebbe l'incasso. L'indice unico parziale rende
 *               idempotente il replay del webhook (ON CONFLICT DO NOTHING).
 *
 * Lo storno è un soft-void (voided_at), mai DELETE: il libro cassa è
 * append-only e l'errore di battitura resta visibile in audit.
 *
 * RLS: policy copiata verbatim da quella in uso (vedi
 * 1787390463706_table-assignment-suggestions.js per la stessa nota).
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS table_bill_payments (
            id                  BIGSERIAL PRIMARY KEY,
            tenant_id           BIGINT NOT NULL,
            table_bill_id       INTEGER NOT NULL REFERENCES table_bills(id) ON DELETE CASCADE,
            method              VARCHAR(20) NOT NULL CHECK (method IN (
                                    'CONTANTI', 'POS_FISICO', 'SATISPAY', 'BUONO_PASTO',
                                    'GIFT_CARD', 'SOSPESO', 'OMAGGIO', 'LINK_ONLINE'
                                )),
            amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
            table_bill_split_id INTEGER REFERENCES table_bill_splits(id) ON DELETE SET NULL,
            meta                JSONB,
            recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            recorded_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            voided_at           TIMESTAMPTZ,
            voided_by_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
            void_reason         TEXT
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_table_bill_payments_bill ON table_bill_payments(table_bill_id);`);
    // La chiusura di cassa legge un giorno alla volta per ristorante.
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_table_bill_payments_tenant_recorded ON table_bill_payments(tenant_id, recorded_at) WHERE voided_at IS NULL;`);
    // Una quota online ha al più uno specchio nel libro cassa (target
    // dell'ON CONFLICT nel webhook).
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS idx_table_bill_payments_one_mirror_per_split ON table_bill_payments(table_bill_split_id) WHERE table_bill_split_id IS NOT NULL;`);

    // Backfill: il libro cassa parte già riconciliato con lo storico, così i
    // report per metodo non hanno un "prima" vuoto.
    // 1) Quote online già PAID (escluso l'acconto, che non è un incasso della
    //    serata: era denaro versato giorni prima sulla prenotazione).
    pgm.sql(`
        INSERT INTO table_bill_payments (tenant_id, table_bill_id, method, amount_cents, table_bill_split_id, recorded_at, meta)
        SELECT s.tenant_id, s.table_bill_id, 'LINK_ONLINE', s.amount_cents, s.id,
               COALESCE(s.paid_at, s.claimed_at), jsonb_build_object('backfill', true)
        FROM table_bill_splits s
        WHERE s.status = 'PAID' AND s.kind <> 'deposit'
        ON CONFLICT (table_bill_split_id) WHERE table_bill_split_id IS NOT NULL DO NOTHING;
    `);
    // 2) Il forfait contanti dei conti già chiusi.
    pgm.sql(`
        INSERT INTO table_bill_payments (tenant_id, table_bill_id, method, amount_cents, recorded_by_user_id, recorded_at, meta)
        SELECT b.tenant_id, b.id, 'CONTANTI', b.cash_settled_cents, b.closed_by_user_id,
               COALESCE(b.closed_at, b.opened_at), jsonb_build_object('backfill', true)
        FROM table_bills b
        WHERE b.cash_settled_cents > 0 AND b.status IN ('CLOSED', 'SETTLED_PARTIAL');
    `);

    pgm.sql(`ALTER TABLE table_bill_payments ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE table_bill_payments FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON table_bill_payments;`);
    // Espressione copiata verbatim da quella già in uso (vedi nota sopra).
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
        CREATE POLICY tenant_isolation ON table_bill_payments
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS table_bill_payments;`);
};
