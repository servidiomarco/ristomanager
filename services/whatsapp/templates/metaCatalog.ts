// I template del catalogo come si creano sul numero Meta di un locale.
//
// Sono i testi del Frantoio, già approvati da Meta sul suo account Twilio,
// senza quello che è solo suo: il telefono nel «non accettata», il link di
// Maps fisso nella conferma, «dal Vecchio Frantoio» nel conto dell'asporto,
// il dominio crm.vecchiofrantoio.com nel conto al tavolo. Il nome del locale
// non serve nel testo: il messaggio arriva dal suo numero, col suo nome.
//
// I builder di server.ts numerano le variabili come i template Twilio
// ({{1}} nome, {{2}} ospiti, …), anche quando il testo le usa in un altro
// ordine. Su Meta il corpo le numera in ordine di comparsa e i pulsanti
// link hanno una variabile propria: `bodyVars` dice, per ogni {{n}} del
// corpo Meta, quale variabile del builder ci va; `urlVar` lo stesso per il
// pulsante. Così i builder restano quelli di sempre per tutti i provider.
//
// Cambiare un testo vuol dire cambiare `name`: Meta non riapre in
// approvazione un template già approvato, e un nome rifiutato resta occupato.
//
// Fuori dal catalogo Meta: il conto al tavolo con la scheda del QR (vuole
// l'immagine d'esempio caricata su Meta, e il conto col pulsante fa lo
// stesso lavoro) e la richiesta di recensione, che non ha un template
// nemmeno sul Frantoio.

import type { TemplateLanguage } from './catalog.js';

export type MetaButtonSpec =
    | { type: 'QUICK_REPLY'; text: string; payload: string }
    | { type: 'URL'; text: string; url: string; urlVar: string; example: string };

export interface MetaTemplateSpec {
    /** Il nome su Meta, uguale per le due lingue. */
    name: string;
    /** Il corpo, con {{1}}…{{n}} in ordine di comparsa. */
    body: string;
    /** Per ogni {{n}} del corpo, la variabile del builder che lo riempie. */
    bodyVars: string[];
    /** Un esempio per ogni {{n}}: Meta li chiede per approvare. */
    examples: string[];
    buttons?: MetaButtonSpec[];
}

const S = 'https://app.sympotia.com';
const MANAGE_IT: MetaButtonSpec = { type: 'URL', text: 'Gestisci la prenotazione', url: `${S}/r/{{1}}`, urlVar: '6', example: `${S}/r/AbCdEfGhIjKlMnOpQrStUv` };
const MANAGE_EN: MetaButtonSpec = { type: 'URL', text: 'Manage your booking', url: `${S}/r/{{1}}`, urlVar: '6', example: `${S}/r/AbCdEfGhIjKlMnOpQrStUv` };

export const META_TEMPLATES: Readonly<Record<string, Partial<Record<TemplateLanguage, MetaTemplateSpec>>>> = {
    BOOKING_RECEIVED: {
        it: {
            name: 'sympotia_booking_received_v1',
            body: 'Ciao {{1}}, abbiamo ricevuto la tua richiesta di prenotazione per {{2}} il {{3}} alle {{4}}. Ti ricontatteremo a breve per confermarla. Grazie!',
            bodyVars: ['1', '2', '3', '4'],
            examples: ['Mario', '4 persone', 'venerdì 18 luglio', '20:30'],
        },
        en: {
            name: 'sympotia_booking_received_v1',
            body: "Hi {{1}}, we've received your reservation request for {{2}} on {{3}} at {{4}}. We'll get back to you shortly to confirm it. Thank you!",
            bodyVars: ['1', '2', '3', '4'],
            examples: ['John', '4 guests', 'Friday 18 July', '20:30'],
        },
    },
    BOOKING_CONFIRMED: {
        it: {
            name: 'sympotia_booking_confirmed_v1',
            body: 'Ciao {{1}}, la tua prenotazione per {{2}} il {{3}} alle {{4}} è confermata. A presto!',
            bodyVars: ['1', '2', '3', '4'],
            examples: ['Mario Rossi', '4 persone', '15/08/2026', '20:30'],
        },
        en: {
            name: 'sympotia_booking_confirmed_v1',
            body: 'Hi {{1}}, your reservation for {{2}} on {{3}} at {{4}} is confirmed. See you soon!',
            bodyVars: ['1', '2', '3', '4'],
            examples: ['John Smith', '4 guests', '15/08/2026', '20:30'],
        },
    },
    BOOKING_CONFIRMED_LINK: {
        it: {
            name: 'sympotia_booking_confirmed_link_v1',
            body: 'Ciao {{1}}, la tua prenotazione per {{2}} il {{3}} alle {{4}} da {{5}} è confermata. Se cambia qualcosa, gestiscila dal pulsante qui sotto. A presto!',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Mario', '4 persone', '12/10/2026', '20:30', 'Trattoria da Gino'],
            buttons: [MANAGE_IT],
        },
        en: {
            name: 'sympotia_booking_confirmed_link_v1',
            body: 'Hi {{1}}, your reservation for {{2}} on {{3}} at {{4}} at {{5}} is confirmed. If anything changes, manage it with the button below. See you soon!',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Mario', '4 guests', '12/10/2026', '20:30', 'Trattoria da Gino'],
            buttons: [MANAGE_EN],
        },
    },
    BOOKING_CONFIRMED_LINK_MAPS: {
        it: {
            name: 'sympotia_booking_confirmed_link_maps_v1',
            body: 'Ciao {{1}}, la tua prenotazione per {{2}} il {{3}} alle {{4}} da {{5}} è confermata. Qui sotto trovi come raggiungerci e, se cambia qualcosa, puoi gestire la prenotazione. A presto!',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Mario', '4 persone', '12/10/2026', '20:30', 'Trattoria da Gino'],
            buttons: [MANAGE_IT, { type: 'URL', text: 'Come raggiungerci', url: 'https://maps.app.goo.gl/{{1}}', urlVar: '7', example: 'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8' }],
        },
        en: {
            name: 'sympotia_booking_confirmed_link_maps_v1',
            body: "Hi {{1}}, your reservation for {{2}} on {{3}} at {{4}} at {{5}} is confirmed. Below you'll find directions and, if anything changes, you can manage your booking. See you soon!",
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Mario', '4 guests', '12/10/2026', '20:30', 'Trattoria da Gino'],
            buttons: [MANAGE_EN, { type: 'URL', text: 'Get directions', url: 'https://maps.app.goo.gl/{{1}}', urlVar: '7', example: 'https://maps.app.goo.gl/pf1DjUYzkhi1sStP8' }],
        },
    },
    BOOKING_REMINDER: {
        it: {
            name: 'sympotia_booking_reminder_v1',
            body: 'Ciao {{1}}! Ti aspettiamo {{2}} alle {{3}}: tavolo per {{4}}. Per modifiche o imprevisti rispondi a questo messaggio. A presto!',
            bodyVars: ['1', '3', '4', '2'],
            examples: ['Marco', 'sabato 23 agosto', '20:00', '4 persone'],
        },
        en: {
            name: 'sympotia_booking_reminder_v1',
            body: 'Hi {{1}}! We look forward to seeing you {{2}} at {{3}}: table for {{4}}. Need to make a change? Just reply to this message. See you soon!',
            bodyVars: ['1', '3', '4', '2'],
            examples: ['John', 'Saturday 23 August', '20:00', '4 guests'],
        },
    },
    BOOKING_REMINDER_LINK: {
        it: {
            name: 'sympotia_booking_reminder_link_v1',
            body: 'Ciao {{1}}! Ti aspettiamo il {{2}} alle {{3}}: tavolo per {{4}} da {{5}}. Ci sarai? Confermalo dal pulsante qui sotto, o gestisci la prenotazione se cambia qualcosa. A presto!',
            bodyVars: ['1', '3', '4', '2', '5'],
            examples: ['Mario', '12/10/2026', '20:30', '4 persone', 'Trattoria da Gino'],
            buttons: [MANAGE_IT],
        },
        en: {
            name: 'sympotia_booking_reminder_link_v1',
            body: 'Hi {{1}}! We look forward to seeing you on {{2}} at {{3}}: a table for {{4}} at {{5}}. Will you make it? Confirm with the button below, or manage your booking if anything changes. See you soon!',
            bodyVars: ['1', '3', '4', '2', '5'],
            examples: ['Mario', '12/10/2026', '20:30', '4 guests', 'Trattoria da Gino'],
            buttons: [MANAGE_EN],
        },
    },
    // Gli id dei tasti coincidono con PAYLOAD_RE di buttons.ts; la
    // prenotazione si ritrova dal messaggio a cui il cliente risponde.
    BOOKING_REMINDER_QR: {
        it: {
            name: 'sympotia_booking_reminder_qr_v1',
            body: 'Ciao {{1}}! Ti aspettiamo il {{2}} alle {{3}}: tavolo per {{4}} da {{5}}. Ci sarai?',
            bodyVars: ['1', '3', '4', '2', '5'],
            examples: ['Mario', '12/10/2026', '20:30', '4 persone', 'Trattoria da Gino'],
            buttons: [
                { type: 'QUICK_REPLY', text: 'Ci saremo', payload: 'rsv_confirm' },
                { type: 'QUICK_REPLY', text: 'Devo modificare', payload: 'rsv_manage' },
                { type: 'QUICK_REPLY', text: 'Annulla', payload: 'rsv_cancel' },
            ],
        },
        en: {
            name: 'sympotia_booking_reminder_qr_v1',
            body: 'Hi {{1}}! We look forward to seeing you on {{2}} at {{3}}: a table for {{4}} at {{5}}. Will you make it?',
            bodyVars: ['1', '3', '4', '2', '5'],
            examples: ['Mario', '12/10/2026', '20:30', '4 guests', 'Trattoria da Gino'],
            buttons: [
                { type: 'QUICK_REPLY', text: "We'll be there", payload: 'rsv_confirm' },
                { type: 'QUICK_REPLY', text: 'I need to change', payload: 'rsv_manage' },
                { type: 'QUICK_REPLY', text: 'Cancel', payload: 'rsv_cancel' },
            ],
        },
    },
    BOOKING_UPDATED: {
        it: {
            name: 'sympotia_booking_updated_v1',
            body: 'Ciao {{1}}, la tua prenotazione è stata aggiornata: {{2}}, {{3}} alle {{4}}. Se qualcosa non torna rispondi a questo messaggio. A presto!',
            bodyVars: ['1', '2', '3', '4'],
            examples: ['Marco', '4 persone', 'sabato 23 agosto', '20:00'],
        },
        en: {
            name: 'sympotia_booking_updated_v1',
            body: 'Hi {{1}}, your reservation has been updated: {{2}}, {{3}} at {{4}}. If anything looks off, reply to this message. See you soon!',
            bodyVars: ['1', '2', '3', '4'],
            examples: ['John', '4 guests', 'Saturday 23 August', '20:00'],
        },
    },
    BOOKING_DECLINED: {
        it: {
            name: 'sympotia_booking_declined_v1',
            body: "Ciao {{1}}, purtroppo non ci è stato possibile confermare la tua richiesta di prenotazione per {{2}} il {{3}} alle {{4}}. Rispondi a questo messaggio e cerchiamo insieme un'altra data. Grazie!",
            bodyVars: ['1', '2', '3', '4'],
            examples: ['Mario', '4 persone', '15/07/2026', '20:30'],
        },
        en: {
            name: 'sympotia_booking_declined_v1',
            body: "Hi {{1}}, unfortunately we couldn't confirm your reservation request for {{2}} on {{3}} at {{4}}. Reply to this message and we'll find another date together. Thank you!",
            bodyVars: ['1', '2', '3', '4'],
            examples: ['John', '4 guests', '15/07/2026', '20:30'],
        },
    },
    BOOKING_DEPOSIT_REQUEST: {
        it: {
            name: 'sympotia_deposit_request_revolut_v1',
            body: 'Ciao {{1}}, per confermare la prenotazione per {{2}} il {{3}} alle {{4}} serve una caparra di {{5}}. Clicca il pulsante qui sotto per pagare.',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Marco', '4 persone', 'venerdì 18 luglio', '20:30', '€40'],
            buttons: [{ type: 'URL', text: 'Paga caparra', url: 'https://checkout.revolut.com/payment-link/{{1}}', urlVar: '6', example: 'https://checkout.revolut.com/payment-link/f98265d4-872d-4fc8-baaf-6ccca67aa6bf' }],
        },
        en: {
            name: 'sympotia_deposit_request_revolut_v1',
            body: 'Hi {{1}}, to confirm your reservation for {{2}} on {{3}} at {{4}} we kindly ask for a {{5}} deposit. Tap the button below to pay.',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['John', '4 guests', 'Friday 18 July', '20:30', '€40'],
            buttons: [{ type: 'URL', text: 'Pay deposit', url: 'https://checkout.revolut.com/payment-link/{{1}}', urlVar: '6', example: 'https://checkout.revolut.com/payment-link/f98265d4-872d-4fc8-baaf-6ccca67aa6bf' }],
        },
    },
    BOOKING_DEPOSIT_REQUEST_SUMUP: {
        it: {
            name: 'sympotia_deposit_request_sumup_v1',
            body: 'Ciao {{1}}, per confermare la prenotazione per {{2}} il {{3}} alle {{4}} serve una caparra di {{5}}. Clicca il pulsante qui sotto per pagare.',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Marco', '4 persone', 'venerdì 18 luglio', '20:30', '€40'],
            buttons: [{ type: 'URL', text: 'Paga caparra', url: 'https://checkout.sumup.com/pay/{{1}}', urlVar: '6', example: 'https://checkout.sumup.com/pay/abc123token' }],
        },
        en: {
            name: 'sympotia_deposit_request_sumup_v1',
            body: 'Hi {{1}}, to confirm your reservation for {{2}} on {{3}} at {{4}} we kindly ask for a {{5}} deposit. Tap the button below to pay.',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['John', '4 guests', 'Friday 18 July', '20:30', '€40'],
            buttons: [{ type: 'URL', text: 'Pay deposit', url: 'https://checkout.sumup.com/pay/{{1}}', urlVar: '6', example: 'https://checkout.sumup.com/pay/abc123token' }],
        },
    },
    BOOKING_DEPOSIT_CONFIRMED: {
        it: {
            name: 'sympotia_deposit_confirmed_v1',
            body: 'Ciao {{1}}, abbiamo ricevuto la caparra di {{2}}. La tua prenotazione per {{3}} il {{4}} alle {{5}} è confermata. A presto!',
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['Mario', '40€', '4 persone', '15/07/2026', '20:30'],
        },
        en: {
            name: 'sympotia_deposit_confirmed_v1',
            body: "Hi {{1}}, we've received your deposit of {{2}}. Your reservation for {{3}} on {{4}} at {{5}} is confirmed. See you soon!",
            bodyVars: ['1', '2', '3', '4', '5'],
            examples: ['John', '€40', '4 guests', '15/07/2026', '20:30'],
        },
    },
    TABLE_BILL_LINK_CTA: {
        it: {
            name: 'sympotia_table_bill_link_v1',
            body: 'Ciao {{1}}, ecco il link per pagare al tavolo ({{2}} · totale {{3}}). Puoi inoltrarlo agli altri al tavolo per dividere il conto. Grazie!',
            bodyVars: ['1', '2', '3'],
            examples: ['Marco', '2 coperti', '€ 45,00'],
            buttons: [{ type: 'URL', text: 'Paga ora', url: `${S}/pay/{{1}}`, urlVar: '4', example: `${S}/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }],
        },
        en: {
            name: 'sympotia_table_bill_link_v1',
            body: "Hi {{1}}, here's your link to pay at the table ({{2}} · total {{3}}). You can forward it to the others at your table to split the bill. Thank you!",
            bodyVars: ['1', '2', '3'],
            examples: ['John', '2 guests', '€ 45.00'],
            buttons: [{ type: 'URL', text: 'Pay now', url: `${S}/pay/{{1}}`, urlVar: '4', example: `${S}/pay/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }],
        },
    },
    TAKEAWAY_BILL_LINK_CTA: {
        it: {
            name: 'sympotia_takeaway_bill_link_v1',
            body: "Ciao {{1}}, ecco il link per pagare il tuo ordine d'asporto delle {{2}} (totale {{3}}). Puoi inoltrarlo a chi è con te: ognuno paga i propri piatti. Grazie!",
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', '19:30', '26,50 €'],
            buttons: [{ type: 'URL', text: 'Paga il conto', url: `${S}/pay/{{1}}`, urlVar: '4', example: `${S}/pay/tok_esempio_123` }],
        },
        en: {
            name: 'sympotia_takeaway_bill_link_v1',
            body: 'Hi {{1}}, here is the link to pay for your takeaway order at {{2}} (total {{3}}). You can forward it to anyone with you: everyone pays for their own dishes. Thank you!',
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', '19:30', '26.50 EUR'],
            buttons: [{ type: 'URL', text: 'Pay the bill', url: `${S}/pay/{{1}}`, urlVar: '4', example: `${S}/pay/tok_esempio_123` }],
        },
    },
    BANQUET_QUOTE: {
        it: {
            name: 'sympotia_banquet_quote_v1',
            body: 'Ciao {{1}}, ecco il preventivo per «{{2}}» del {{3}}: nel link trovi il menù, le tariffe e il totale. Per qualunque modifica siamo a disposizione.',
            bodyVars: ['1', '2', '3'],
            examples: ['Marco', 'Battesimo di Sofia', '12 ottobre 2026'],
            buttons: [{ type: 'URL', text: 'Apri il preventivo', url: `${S}/preventivo/{{1}}`, urlVar: '4', example: `${S}/preventivo/abc123def456ghi789jkl012mno345pq` }],
        },
        en: {
            name: 'sympotia_banquet_quote_v1',
            body: 'Hi {{1}}, here is the quote for "{{2}}" on {{3}}: in the link you will find the menu, the rates and the total. We are at your disposal for any change.',
            bodyVars: ['1', '2', '3'],
            examples: ['Marco', "Sofia's christening", '12 October 2026'],
            buttons: [{ type: 'URL', text: 'Open the quote', url: `${S}/preventivo/{{1}}`, urlVar: '4', example: `${S}/preventivo/abc123def456ghi789jkl012mno345pq` }],
        },
    },
    TAKEAWAY_READY: {
        it: {
            name: 'sympotia_takeaway_ready_v1',
            body: "Ciao {{1}}! Il tuo ordine d'asporto n. {{2}} è pronto: ti aspettiamo da {{3}}. A presto!",
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', '12', 'Trattoria da Gino'],
        },
        en: {
            name: 'sympotia_takeaway_ready_v1',
            body: 'Hi {{1}}! Your takeaway order no. {{2}} is ready: see you at {{3}}. Thank you!',
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', '12', 'Trattoria da Gino'],
        },
    },
    // L'id del tasto coincide con STOP_PAYLOAD di campaigns/consent.ts.
    CAMPAIGN: {
        it: {
            name: 'sympotia_campaign_v1',
            body: 'Ciao {{1}}, una novità da {{2}}: {{3}}\n\nSe non vuoi più ricevere promozioni tocca il tasto qui sotto.',
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', 'Trattoria da Gino', 'venerdì cena al tartufo, prenota rispondendo qui.'],
            buttons: [{ type: 'QUICK_REPLY', text: 'Stop promozioni', payload: 'marketing_stop' }],
        },
        en: {
            name: 'sympotia_campaign_v1',
            body: 'Hi {{1}}, some news from {{2}}: {{3}}\n\nIf you no longer want promotions, tap the button below.',
            bodyVars: ['1', '2', '3'],
            examples: ['Mario', 'Trattoria da Gino', 'this Friday truffle dinner, book a table by replying here.'],
            buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions', payload: 'marketing_stop' }],
        },
    },
};

/** Il template Meta di una chiave in una lingua, se il catalogo lo prevede. */
export const metaSpec = (key: string, language: TemplateLanguage): MetaTemplateSpec | undefined =>
    META_TEMPLATES[key]?.[language];

/** Tutte le coppie chiave–lingua da creare su un account. */
export function metaSpecList(): Array<{ key: string; language: TemplateLanguage; spec: MetaTemplateSpec }> {
    const out: Array<{ key: string; language: TemplateLanguage; spec: MetaTemplateSpec }> = [];
    for (const [key, byLang] of Object.entries(META_TEMPLATES)) {
        for (const language of ['it', 'en'] as const) {
            const spec = byLang[language];
            if (spec) out.push({ key, language, spec });
        }
    }
    return out;
}
