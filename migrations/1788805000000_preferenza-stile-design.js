/**
 * Stile dell'interfaccia, per utente.
 *
 * Il redesign dei raggi (6px le scatole, 8px i controlli) non sostituisce il
 * look classico: diventa una scelta. Come il layout comande, la scelta deve
 * seguire l'operatore su qualunque dispositivo prenda in mano — quindi vive
 * su users come preferred_orderpad_layout, non in localStorage come il tema.
 *
 * Valori: 'squadrato' (il nuovo design, raggi 6/4/8px) o NULL = classico
 * (scatole morbide, controlli a pillola). Catalogo chiuso validato in
 * /auth/me/preferences; niente CHECK qui, così uno stile futuro non richiede
 * un'altra migration.
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
            ADD COLUMN IF NOT EXISTS preferred_design_style VARCHAR(20);
    `);
};
