// Le integrazioni configurabili da variabili d'ambiente (SMTP_*, RESEND_*,
// EMAIL_FROM*, IMAP_*) sono quelle del Vecchio Frantoio: risalgono a prima
// del SaaS, quando il ristorante era uno solo e la configurazione stava su
// Railway invece che nelle Impostazioni. Valgono SOLO per il tenant 1.
//
// Un altro tenant senza la sua riga in integration_settings (o con un campo
// vuoto) NON è configurato: non eredita mittente, chiavi e password del
// Frantoio. Prima le ereditava campo per campo — audit isolamento H-03: un
// owner di un altro ristorante puntava l'host SMTP a un suo server, lasciava
// vuota la password, premeva «Test» e riceveva in AUTH la password del
// Frantoio; con Resend spediva come il Frantoio, e il webhook inbound col
// suo token verificava le firme col segreto del Frantoio.
export const LEGACY_ENV_TENANT_ID = 1;

// Number(): le colonne tenant_id sono BIGINT e pg restituisce gli int8 come
// stringhe. Un chiamante futuro che passasse row.tenant_id senza convertirlo
// spegnerebbe in silenzio il fallback del Frantoio su quel solo percorso
// («Email non è configurato» da uno scheduler, tutto il resto funzionante),
// e TypeScript non lo vedrebbe perché i campi delle righe sono any.
export const legacyEnvAllowed = (tenantId: number | string): boolean =>
    Number(tenantId) === LEGACY_ENV_TENANT_ID;
