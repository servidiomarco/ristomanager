// Anche la proforma ha la sua pagina: /scontrino/<token> ora la mostra
// (etichettata «non fiscale»), quindi il token pubblico serve pure a lei.
// registerNativeProforma e registerExternalRtReceipt però non lo scrivevano
// (solo emitFiscalDocForBill lo faceva): le righe nate da quelle due strade
// dopo il backfill di 1787990000000 sono rimaste senza. Si recuperano qui,
// e da ora il server lo scrive a ogni insert.

export const up = (pgm) => {
    pgm.sql(`
        UPDATE fiscal_documents
        SET public_token = replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
        WHERE public_token IS NULL
    `);
};
