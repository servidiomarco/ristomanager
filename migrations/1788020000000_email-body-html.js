/**
 * Corpo HTML delle email in arrivo.
 *
 * Finora l'IMAP inbound salvava solo la parte testuale (`parsed.text`) e le
 * newsletter/email HTML arrivavano in Messaggi come testo grezzo: link nudi,
 * token di unsubscribe lunghissimi che sfondavano la card, righe vuote al
 * posto delle immagini. `body_html` conserva l'HTML originale così la UI può
 * renderizzarlo in un iframe sandbox; `body` resta la versione testuale usata
 * da anteprime, ricerca e suggerimento prenotazione.
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS body_html TEXT;`);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE outbound_messages DROP COLUMN IF EXISTS body_html;`);
};
