/* Che cosa è quel messaggio: `kind` su outbound_messages.
 *
 * L'etichetta esisteva già nel codice (dispatchBookingNotification la passa
 * come 'ack' | 'confirmation' | 'decline' | 'review_request') ma finiva solo
 * nei log: la riga salvata non sapeva di cosa fosse. Così l'inbox non poteva
 * distinguere una conversazione da un automatismo, e le 483 richieste di
 * recensione del 18-19/09 — più le 28 scuse dell'incidente dei reinvii — si
 * sono prese la cima della lista su 75 thread, sotterrando gli scambi veri.
 *
 * La colonna resta NULL su tutto ciò che è scritto a mano: è quello il caso
 * normale, e un default finto ('manual') direbbe una cosa che non sappiamo
 * per le righe storiche.
 *
 * Il riempimento dello storico va per forza a modello di testo — quelle
 * righe sono partite prima che la colonna esistesse. Da qui in avanti il
 * kind arriva dal chiamante e il testo non c'entra più. I due modelli sono
 * ancorati alla parte che non cambia col nome del cliente né col ristorante
 * (l'identità è interpolata nel mezzo), e la finestra temporale sulle scuse
 * evita di pescare un futuro messaggio a mano che cominci per «Ci scusiamo».
 */
export const up = (pgm) => {
    pgm.sql(`ALTER TABLE outbound_messages ADD COLUMN IF NOT EXISTS kind TEXT;`);

    pgm.sql(`
        UPDATE outbound_messages
        SET kind = 'review_request'
        WHERE kind IS NULL
          AND direction = 'outbound'
          AND (body LIKE '%lasciaci una recensione su Google%'
            OR body LIKE '%leave us a review on Google%');
    `);

    pgm.sql(`
        UPDATE outbound_messages
        SET kind = 'apology'
        WHERE kind IS NULL
          AND direction = 'outbound'
          AND body LIKE 'Ci scusiamo: un errore tecnico ha inviato più volte la nostra richiesta di recensione%'
          AND sent_at < '2026-09-21';
    `);
};

export const down = (pgm) => {
    pgm.sql(`ALTER TABLE outbound_messages DROP COLUMN IF EXISTS kind;`);
};
