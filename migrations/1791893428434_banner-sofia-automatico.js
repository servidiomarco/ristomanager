/**
 * Banner automatici. Il cane da guardia apre da solo un banner «problema
 * noto» quando Sofia non è raggiungibile (13/10/2026: ElevenLabs in timeout
 * per ore) e lo chiude quando il disservizio finisce.
 *
 * - auto_kind NULL: banner scritto da un admin dal pannello, come prima.
 * - auto_kind 'sofia': aperto e chiuso dal cane da guardia, lo vedono solo
 *   i ristoranti con Sofia attiva.
 *
 * L'indice unico parziale tiene al più un banner automatico aperto per tipo,
 * anche se due giri del cane da guardia si accavallano.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE platform_incidents ADD COLUMN IF NOT EXISTS auto_kind VARCHAR(20);`);
    pgm.sql(`
        CREATE UNIQUE INDEX IF NOT EXISTS platform_incidents_one_auto_open
        ON platform_incidents (auto_kind) WHERE resolved_at IS NULL AND auto_kind IS NOT NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS platform_incidents_one_auto_open;`);
    pgm.sql(`ALTER TABLE platform_incidents DROP COLUMN IF EXISTS auto_kind;`);
};
