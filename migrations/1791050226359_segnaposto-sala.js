/**
 * Segnaposto di sala (Sala dal vivo): ingresso, pass e accoglienza, uno per
 * tipo in ogni sala, posizionati sulla piantina di Sale & Tavoli e trascinati
 * come i tavoli. Sono i punti fermi della sala che i dati non avevano: da
 * dove entrano gli ospiti, da dove escono i piatti, dove si accoglie.
 *
 * x/y = il CENTRO del segnaposto, nello stesso spazio di tables.x/y (px della
 * tela della sala, origine in alto a sinistra, y verso il basso). Un
 * segnaposto è un punto, non una sagoma: il centro non cambia con lo zoom né
 * con la misura del chip che lo disegna. tables.x/y resta invece l'angolo in
 * alto a sinistra del glifo, perché il tavolo una forma ce l'ha.
 *
 * UNIQUE (room_id, kind) senza tenant_id: rooms.id è un SERIAL globale, la
 * coppia identifica già il segnaposto. È anche il bersaglio dell'upsert (ON
 * CONFLICT), per questo PUT /floor-markers verifica che la sala sia del
 * tenant PRIMA di scrivere, come POST /room-closed e /table-merges: un
 * room_id altrui farebbe DO UPDATE sul segnaposto di un altro ristorante.
 *
 * tenant_id senza DEFAULT (rls.test.ts lo vieta: una INSERT dimenticata deve
 * morire di NOT NULL, non finire nel tenant 1) e RLS con la stessa policy
 * delle altre tabelle per-tenant: ensureRlsPolicies al boot la rimetterebbe
 * comunque, ma la tabella deve nascere già chiusa.
 *
 * x/y fra 0 e 20000, lo stesso tetto di FLOOR_MARKER_MAX_PX in server.ts:
 * cambiano insieme. La rotta lo controlla già, ma chi scrive da fuori (uno
 * script, una correzione a mano) passerebbe; e un 999999 allargherebbe la
 * sala sulla piantina di tutti, che per farcela stare scalerebbe i tavoli
 * fino a non leggerli più.
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

const enableRls = (pgm, table) => {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`
        CREATE POLICY tenant_isolation ON ${table}
        USING (${RLS_POLICY})
        WITH CHECK (${RLS_POLICY});
    `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS floor_markers (
            id         SERIAL PRIMARY KEY,
            tenant_id  BIGINT NOT NULL REFERENCES tenants(id),
            room_id    INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            kind       VARCHAR(20) NOT NULL CHECK (kind IN ('ENTRANCE', 'PASS', 'HOST_STAND')),
            x          INTEGER NOT NULL CHECK (x BETWEEN 0 AND 20000),
            y          INTEGER NOT NULL CHECK (y BETWEEN 0 AND 20000),
            created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (room_id, kind)
        );
    `);
    pgm.sql(`CREATE INDEX IF NOT EXISTS idx_floor_markers_tenant ON floor_markers (tenant_id);`);

    enableRls(pgm, 'floor_markers');
};

export const down = (pgm) => {
    pgm.sql(`DROP TABLE IF EXISTS floor_markers;`);
};
