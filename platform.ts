// Nome del prodotto (non del ristorante: quello vive in legal_config lato
// server). Il brand è Sympotia: il wordmark sta in public/logo-sympotia-*.svg
// (nero per il tema chiaro, bianco per lo scuro).
export const PLATFORM_NAME = 'Sympotia';

/** Sottotitolo del marchio, sotto il wordmark nella pagina di accesso. Sta qui
 *  e non nel componente perche' e' identita' di prodotto come il nome: se il
 *  posizionamento cambia, cambia in un posto solo. */
export const PLATFORM_TAGLINE = "CRM e operatività per l'ospitalità";

/* Il ristorante che usa questa installazione. Scritto qui a mano, e vale per
   uno solo: il logo del tenant non esiste nel modello dati — `branding` porta
   nome, tagline, sito, indirizzo e mappa, non un'immagine — e i due file in
   `public/logo-vf*.png` sono di questo ristorante. La rotta che li serve alla
   pagina pubblica (`/prenota/logo.png`) ignora gia' il tenant, quindi la
   scorciatoia non ne apre una nuova: la rende visibile.

   Col secondo ristorante servono un campo sul tenant e un modo di caricarlo,
   e queste due costanti spariscono. Il nome vero, quello che l'utente puo'
   cambiare, vive gia' in `legal_config.business_name` lato server. */
export const TENANT_NAME = 'Il Vecchio Frantoio';
