/**
 * Prenotazioni web «solo confermabili subito» (Fase 0 del sito).
 *
 * - Indice reservations (tenant_id, table_id, reservation_time): la scelta
 *   del tavolo (assignableTableSql) controlla le prenotazioni tavolo per
 *   tavolo, e con la nuova modalità lo fa su un endpoint pubblico per ogni
 *   turno chiesto. Finora c'era solo idx_reservations_time.
 * - public_booking_misses: la domanda che il web non ha preso perché un
 *   tavolo non c'era (turno pieno nella disponibilità, o 409 della POST).
 *   Una riga per (giorno del servizio, turno, persone, motivo, giorno in cui
 *   è successo) con un contatore; nessun dato personale. Serve a capire,
 *   dopo la riaccensione, se i gruppi dirottati sono tanti.
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
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_reservations_tenant_table_time ON reservations (tenant_id, table_id, reservation_time);`);

    pgm.sql(`
        CREATE TABLE IF NOT EXISTS public_booking_misses (
            id            SERIAL PRIMARY KEY,
            tenant_id     BIGINT NOT NULL REFERENCES tenants(id),
            service_date  DATE NOT NULL,
            shift         VARCHAR(10) NOT NULL CHECK (shift IN ('LUNCH', 'DINNER')),
            guests        INTEGER NOT NULL CHECK (guests BETWEEN 1 AND 50),
            reason        VARCHAR(20) NOT NULL CHECK (reason IN ('full', 'not_confirmable')),
            seen_on       DATE NOT NULL DEFAULT CURRENT_DATE,
            count         INTEGER NOT NULL DEFAULT 1,
            first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (tenant_id, service_date, shift, guests, reason, seen_on)
        );
    `);

    pgm.sql(`ALTER TABLE public_booking_misses ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE public_booking_misses FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON public_booking_misses;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON public_booking_misses
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS public_booking_misses;`);
    pgm.sql(`DROP INDEX IF EXISTS idx_reservations_tenant_table_time;`);
};
