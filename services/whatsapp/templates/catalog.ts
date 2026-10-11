// Il catalogo dei template WhatsApp: UN elenco di tutti i messaggi che
// partono da noi fuori dalla finestra di 24 ore.
//
// Oggi ogni template esiste nel solo account Twilio del Frantoio e la sua
// SID sta in una variabile d'ambiente TWILIO_WA_CONTENT_SID_<chiave>[_EN],
// incollata a mano su Railway dopo l'approvazione di Meta (vedi
// scripts/create-whatsapp-template*.mjs). Il catalogo dà un nome a quelle
// chiavi: la scheda «Template» delle Impostazioni lo mostra con lo stato di
// ciascuno, e dalla Fase 12 è la lista che si fa approvare per ogni numero
// collegato da un nuovo ristorante.

export type TemplateLanguage = 'it' | 'en';

export interface TemplateDef {
    /** La chiave, senza prefisso e senza lingua: `BOOKING_CONFIRMED_LINK`. */
    key: string;
    /** Come la vede chi apre le Impostazioni. */
    label: string;
    category: 'UTILITY' | 'MARKETING';
    group: 'prenotazioni' | 'caparre' | 'conto' | 'recensioni' | 'banchetti';
    /** Le lingue per cui il template esiste (o è previsto). */
    languages: TemplateLanguage[];
}

export const TEMPLATE_ENV_PREFIX = 'TWILIO_WA_CONTENT_SID_';

/** La variabile d'ambiente che porta la SID di un template in una lingua. */
export const templateEnvKey = (key: string, language: TemplateLanguage): string =>
    `${TEMPLATE_ENV_PREFIX}${key}${language === 'en' ? '_EN' : ''}`;

export const TEMPLATE_CATALOG: readonly TemplateDef[] = [
    { key: 'BOOKING_RECEIVED', label: 'Richiesta ricevuta', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_CONFIRMED', label: 'Prenotazione confermata', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_CONFIRMED_LINK', label: 'Confermata, con «Gestisci»', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_CONFIRMED_LINK_MAPS', label: 'Confermata, con «Gestisci» e «Come raggiungerci»', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_REMINDER', label: 'Promemoria', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_REMINDER_LINK', label: 'Promemoria, con «Gestisci»', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    // Tasti di risposta rapida (scripts/create-whatsapp-template-promemoria-tasti.mjs):
    // si usa solo con l'interruttore «Promemoria con tasti» acceso.
    { key: 'BOOKING_REMINDER_QR', label: 'Promemoria con i tasti «Ci saremo», «Devo modificare», «Annulla»', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_UPDATED', label: 'Prenotazione modificata', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_DECLINED', label: 'Prenotazione non accettata', category: 'UTILITY', group: 'prenotazioni', languages: ['it', 'en'] },
    { key: 'BOOKING_DEPOSIT_REQUEST', label: 'Richiesta di caparra (Revolut)', category: 'UTILITY', group: 'caparre', languages: ['it'] },
    { key: 'BOOKING_DEPOSIT_REQUEST_SUMUP', label: 'Richiesta di caparra (SumUp)', category: 'UTILITY', group: 'caparre', languages: ['it'] },
    { key: 'BOOKING_DEPOSIT_CONFIRMED', label: 'Caparra ricevuta', category: 'UTILITY', group: 'caparre', languages: ['it'] },
    { key: 'TABLE_BILL_LINK_CTA', label: 'Conto al tavolo, col pulsante', category: 'UTILITY', group: 'conto', languages: ['it'] },
    { key: 'TABLE_BILL_LINK', label: 'Conto al tavolo, con la scheda', category: 'UTILITY', group: 'conto', languages: ['it'] },
    { key: 'TAKEAWAY_BILL_LINK_CTA', label: 'Conto dell\'asporto', category: 'UTILITY', group: 'conto', languages: ['it'] },
    { key: 'REVIEW_REQUEST', label: 'Richiesta di recensione', category: 'UTILITY', group: 'recensioni', languages: ['it', 'en'] },
    { key: 'BANQUET_QUOTE', label: 'Preventivo del banchetto', category: 'UTILITY', group: 'banchetti', languages: ['it'] },
];
