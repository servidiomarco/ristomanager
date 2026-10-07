/**
 * Rilasci dell'agente della cassa distribuiti dal cloud (piano «Passepartout
 * plug and play», punto 3).
 *
 * Il pacchetto leggero dell'agente (scripts/build-agent-bundle.mjs, ~110 KB
 * zippato) lo carica la CI a ogni merge su main che cambia l'agente; il
 * supervisore sul PC della cassa chiede ogni ora se c'è una versione nuova
 * per il suo canale e la scarica col token dell'agente. Come i media, i
 * byte stanno nel database: niente bucket da configurare.
 *
 * - agent_releases: tabella di PIATTAFORMA, senza tenant_id e senza RLS
 *   (vedi tests/api/rls-invarianti.test.ts): lo stesso pacchetto vale per
 *   tutti i ristoranti e non contiene niente di loro. canale «pilota» al
 *   caricamento, «stabile» quando lo si promuove dal pannello;
 *   contenuto_sha256 è l'impronta di agente e supervisore, per non
 *   pubblicare due volte lo stesso codice. Se ne tengono gli ultimi 10.
 * - tenants.agente_canale: da quale canale il ristorante prende gli
 *   aggiornamenti. Default «stabile»; il pilota lo si sceglie dal pannello.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        CREATE TABLE IF NOT EXISTS agent_releases (
            sha               VARCHAR(40) PRIMARY KEY,
            canale            VARCHAR(10) NOT NULL DEFAULT 'pilota' CHECK (canale IN ('pilota', 'stabile')),
            contenuto         BYTEA NOT NULL,
            dimensione        INTEGER NOT NULL,
            sha256            CHAR(64) NOT NULL,
            contenuto_sha256  CHAR(64),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
            promosso_at       TIMESTAMPTZ
        );
        CREATE INDEX IF NOT EXISTS agent_releases_created ON agent_releases (created_at DESC);

        ALTER TABLE tenants
            ADD COLUMN IF NOT EXISTS agente_canale VARCHAR(10) NOT NULL DEFAULT 'stabile'
                CHECK (agente_canale IN ('pilota', 'stabile'));
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE tenants DROP COLUMN IF EXISTS agente_canale;
        DROP TABLE IF EXISTS agent_releases;
    `);
};
