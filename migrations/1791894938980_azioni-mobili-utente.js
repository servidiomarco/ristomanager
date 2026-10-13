/**
 * Azioni del «+» sulla barra del telefono, per utente.
 *
 * Il pannello «Crea» del telefono mostrava sempre le stesse cinque azioni;
 * ora ognuno sceglie le sue (Impostazioni → Menu). Come lo stile
 * dell'interfaccia, la scelta segue l'operatore su ogni dispositivo, quindi
 * vive su users e non in localStorage.
 *
 * Valori: l'elenco ordinato delle chiavi scelte ('reservation', 'walkin',
 * 'dish'…) o NULL = le predefinite. Catalogo chiuso validato in
 * /auth/me/preferences; niente CHECK qui, così un'azione nuova non richiede
 * un'altra migration.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_mobile_actions TEXT[];
    `);
};

/** @param pgm {import('node-pg-migrate').MigrationBuilder} */
export const down = (pgm) => {
    pgm.sql(`
        ALTER TABLE users DROP COLUMN IF EXISTS preferred_mobile_actions;
    `);
};
