// Il catalogo dei template WhatsApp: UN elenco di tutti i messaggi che
// partono da noi fuori dalla finestra di 24 ore.
//
// Oggi ogni template esiste nel solo account Twilio del Frantoio e la sua
// SID sta in una variabile d'ambiente TWILIO_WA_CONTENT_SID_<chiave>[_EN],
// incollata a mano su Railway dopo l'approvazione di Meta (vedi
// scripts/create-whatsapp-template*.mjs). Il catalogo dà un nome a quelle
// chiavi: la scheda «Template» delle Impostazioni lo mostra con lo stato di
// ciascuno. Per i numeri Meta dei locali (Fase 12b) i testi stanno in
// metaCatalog.ts, e si fanno approvare nell'account di ciascuno.

export type TemplateLanguage = 'it' | 'en';

export interface TemplateDef {
    /** La chiave, senza prefisso e senza lingua: `BOOKING_CONFIRMED_LINK`. */
    key: string;
    /** Come la vede chi apre le Impostazioni. */
    label: string;
    category: 'UTILITY' | 'MARKETING';
    group: 'prenotazioni' | 'caparre' | 'conto' | 'recensioni' | 'banchetti' | 'asporto' | 'marketing';
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
    { key: 'BOOKING_DEPOSIT_REQUEST', label: 'Richiesta di caparra (Revolut)', category: 'UTILITY', group: 'caparre', languages: ['it', 'en'] },
    { key: 'BOOKING_DEPOSIT_REQUEST_SUMUP', label: 'Richiesta di caparra (SumUp)', category: 'UTILITY', group: 'caparre', languages: ['it', 'en'] },
    { key: 'BOOKING_DEPOSIT_CONFIRMED', label: 'Caparra ricevuta', category: 'UTILITY', group: 'caparre', languages: ['it', 'en'] },
    { key: 'TABLE_BILL_LINK_CTA', label: 'Conto al tavolo, col pulsante', category: 'UTILITY', group: 'conto', languages: ['it', 'en'] },
    { key: 'TABLE_BILL_LINK', label: 'Conto al tavolo, con la scheda', category: 'UTILITY', group: 'conto', languages: ['it', 'en'] },
    { key: 'TAKEAWAY_BILL_LINK_CTA', label: 'Conto dell\'asporto', category: 'UTILITY', group: 'conto', languages: ['it', 'en'] },
    { key: 'REVIEW_REQUEST', label: 'Richiesta di recensione', category: 'UTILITY', group: 'recensioni', languages: ['it', 'en'] },
    { key: 'BANQUET_QUOTE', label: 'Preventivo del banchetto', category: 'UTILITY', group: 'banchetti', languages: ['it', 'en'] },
    // scripts/create-whatsapp-template-asporto-pronto.mjs; si usa con
    // «Avvisa quando l'ordine è pronto» acceso, fuori dalla finestra di 24 ore.
    { key: 'TAKEAWAY_READY', label: 'Ordine d\'asporto pronto', category: 'UTILITY', group: 'asporto', languages: ['it', 'en'] },
    // scripts/create-whatsapp-template-campagna.mjs: il messaggio delle
    // campagne, col tasto «Stop promozioni». MARKETING: Meta lo fa pagare a
    // tariffa piena e lo consegna solo a chi non ha bloccato il marketing.
    { key: 'CAMPAIGN', label: 'Campagna (con «Stop promozioni»)', category: 'MARKETING', group: 'marketing', languages: ['it', 'en'] },
];
