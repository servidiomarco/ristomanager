/**
 * QR unico al tavolo: un token pubblico stabile per tavolo.
 *
 * L'adesivo sul tavolo porta /t/<public_token>: la pagina mostra il menu e,
 * solo mentre il tavolo ha un conto aperto nel servizio in corso, il tasto
 * «Paga il conto» verso /pay/<share_token>. Il token del tavolo è un
 * puntatore, non una credenziale di pagamento: lo share_token per-conto resta
 * quello che muore alla chiusura.
 *
 * Globale e UNIQUE come table_bills.share_token: la pagina senza login risale
 * dal token alla riga, e quindi al tenant. Nullable e senza backfill: i token
 * nascono quando il ristoratore stampa i QR dei tavoli (POST /tables/qr-tokens).
 * La replica verso il nodo di sala copia le righe con jsonb_populate_recordset:
 * una chiave assente diventa NULL, quindi versioni diverse restano coerenti.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 */
export const up = (pgm) => {
    pgm.sql(`
        ALTER TABLE tables ADD COLUMN IF NOT EXISTS public_token VARCHAR(32);
        CREATE UNIQUE INDEX IF NOT EXISTS tables_public_token_key
            ON tables (public_token) WHERE public_token IS NOT NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`
        DROP INDEX IF EXISTS tables_public_token_key;
        ALTER TABLE tables DROP COLUMN IF EXISTS public_token;
    `);
};
