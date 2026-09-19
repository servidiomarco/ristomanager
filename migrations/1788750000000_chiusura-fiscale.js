/* Chiusura fiscale della giornata dal CRM (docs/chiusura-fiscale-plan.md).
 *
 * `fiscal_closures` è il registro delle chiusure: una riga per giornata di
 * CALENDARIO Europe/Rome (deciso col titolare: è come ragionano l'RT e
 * l'Agenzia — il tavolo di mezzanotte finisce nel giorno in cui il suo
 * scontrino è stato battuto). Cosa significa "chiudere" dipende dal
 * provider fiscale del tenant:
 *   - rt-local: la Z vera, comandata all'RT via job RT_CHIUSURA dell'agente
 *     di stampa (la riga nasce PENDING, l'ack la conferma col numero Z);
 *   - openapi/mock: un riscontro registrato — la trasmissione è per
 *     documento, una Z non esiste;
 *   - none (il ponte Passepartout): registrazione manuale di numero Z e
 *     totale dal tagliando del registratore.
 *
 * I totali CRM sono MEMORIZZATI, non ricalcolati: come difference_cents
 * della sessione di cassa, sono la fotografia del momento della firma — uno
 * scontrino emesso dopo non deve riscrivere un numero già riscontrato. Il
 * registro vivo resta GET /reports/cash-closure, che è calcolato.
 *
 * Nessun permesso nuovo: la POST usa cash:close_session (chi conta il
 * cassetto chiude anche la giornata), la GET payments:view.
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE fiscal_closures (
            id                   BIGSERIAL PRIMARY KEY,
            tenant_id            BIGINT NOT NULL,
            closure_date         DATE NOT NULL,
            provider             VARCHAR(20) NOT NULL,
            status               VARCHAR(12) NOT NULL DEFAULT 'PENDING'
                                 CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED')),
            -- Numero della chiusura Z: dalla risposta dell'RT (rt-local) o
            -- dal tagliando (registrazione manuale). Non esiste su openapi.
            zrep_number          VARCHAR(20),
            -- Totale del rapporto Z, quando è noto: l'RT potrebbe non
            -- riportarlo nella risposta, e su openapi non esiste.
            rt_total_cents       INTEGER CHECK (rt_total_cents IS NULL OR rt_total_cents >= 0),
            crm_docs_count       INTEGER NOT NULL CHECK (crm_docs_count >= 0),
            crm_total_cents      INTEGER NOT NULL CHECK (crm_total_cents >= 0),
            -- La fotografia completa dei documenti del giorno (per tipo e
            -- stato) al momento della chiusura.
            breakdown            JSONB,
            -- Nota dell'operatore: obbligatoria (validata in route, non qui —
            -- l'ack dell'agente non ha una nota da offrire) quando il totale
            -- RT è noto e non combacia col totale CRM.
            note                 TEXT,
            error                TEXT,
            requested_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            requested_by_name    TEXT NOT NULL,
            requested_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            confirmed_at         TIMESTAMPTZ,
            -- Risposta grezza dell'RT, per il forense.
            raw                  JSONB
        );
    `);

    // Una chiusura viva per giornata: la Z è irreversibile e una seconda
    // uscirebbe a zero. Una FAILED non blocca il nuovo tentativo.
    pgm.sql(`
        CREATE UNIQUE INDEX fiscal_closures_giornata
            ON fiscal_closures (tenant_id, closure_date)
            WHERE status <> 'FAILED';
    `);

    // Un solo job Z vivo per riga di chiusura, garantito dal database come
    // per print_jobs_rt_one_per_doc: la Z non si comanda due volte.
    pgm.sql(`
        CREATE UNIQUE INDEX print_jobs_z_one_per_closure
            ON print_jobs ((payload->>'closure_id'))
            WHERE kind = 'RT_CHIUSURA' AND status <> 'FAILED';
    `);

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
    pgm.sql(`ALTER TABLE fiscal_closures ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE fiscal_closures FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON fiscal_closures;`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON fiscal_closures
        USING (${POLICY})
        WITH CHECK (${POLICY});
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS print_jobs_z_one_per_closure;`);
    pgm.sql(`DROP TABLE IF EXISTS fiscal_closures;`);
};
