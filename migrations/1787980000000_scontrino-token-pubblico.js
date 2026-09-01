// Scontrino digitale per l'ospite: ogni documento fiscale porta un token
// pubblico opaco, e il QR sull'esito di chiusura punta a /scontrino/<token>.
// Il token è una capability come lo share_token del conto — chi lo ha vede
// SOLO quel documento, per questo va lungo e imprevedibile (64 hex ≈ 256 bit).
//
// Backfill anche sui documenti già emessi: il collaudo ha scontrini veri in
// sandbox e devono diventare mostrabili senza riemetterli.
//
// Già che siamo sulla tabella: doc_number per gli scontrini Openapi non è mai
// stato valorizzato (il numero sta in response->data->>document_number e la
// UPDATE di conferma non lo copiava) — si recupera qui per lo storico, e il
// server da ora lo scrive alla conferma.

export const up = (pgm) => {
    pgm.sql(`ALTER TABLE fiscal_documents ADD COLUMN IF NOT EXISTS public_token text`);
    pgm.sql(`
        UPDATE fiscal_documents
        SET public_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
        WHERE public_token IS NULL
    `);
    pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS fiscal_documents_public_token_idx ON fiscal_documents (public_token)`);
    pgm.sql(`
        UPDATE fiscal_documents
        SET doc_number = response->'data'->>'document_number'
        WHERE doc_number IS NULL AND response->'data'->>'document_number' IS NOT NULL
    `);
};
