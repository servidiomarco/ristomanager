/* Copia digitale del documento commerciale: share_token opaco su
 * fiscal_documents, chiave della pagina pubblica GET /r/:token e del QR
 * stampato sulla copia cartacea. Generato pigramente alla prima richiesta
 * di copia (stampa o QR), non all'emissione: i documenti storici restano
 * validi e ricevono il token quando serve davvero.
 *
 * Niente scadenza: lo scontrino è un documento che il cliente può voler
 * rileggere a distanza di mesi (resi, garanzia). 192 bit di entropia come
 * lo share_token dei conti.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents ADD COLUMN share_token TEXT;`);
    pgm.sql(`
        CREATE UNIQUE INDEX fiscal_documents_share_token
            ON fiscal_documents (share_token)
            WHERE share_token IS NOT NULL;
    `);
};

export const down = (pgm) => {
    pgm.sql(`DROP INDEX IF EXISTS fiscal_documents_share_token;`);
    pgm.sql(`ALTER TABLE fiscal_documents DROP COLUMN IF EXISTS share_token;`);
};
