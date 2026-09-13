/**
 * Layout della presa comanda sul palmare, per utente.
 *
 * Il titolare arriva dall'app comande di Passepartout e naviga a memoria
 * muscolare: pagine di categorie, non chip che scorrono. La variante
 * «a pagine» dell'OrderPad esiste per lui, e la scelta deve seguirlo su
 * qualunque palmare prenda in mano — quindi vive su users come
 * preferred_landing_view, non in localStorage come la densità.
 *
 * Valori: 'pages' (variante a pagine) o NULL = layout classico. Catalogo
 * chiuso validato in /auth/me/preferences; niente CHECK qui, così una
 * variante futura non richiede un'altra migration.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users
            ADD COLUMN IF NOT EXISTS preferred_orderpad_layout VARCHAR(20);
    `);
};
