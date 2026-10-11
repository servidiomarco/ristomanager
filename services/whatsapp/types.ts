// Tipi del modulo WhatsApp (services/whatsapp/).
//
// Il modulo raccoglie quello che prima stava sparso in server.ts: chi manda
// per conto di quale ristorante, con quale provider, con quali template, e
// cosa arriva dai webhook. Il resto del server parla con queste interfacce e
// non sa più se sotto c'è Twilio (il Frantoio, da variabili d'ambiente) o,
// dalla Fase 12, l'API Cloud di Meta collegata dal ristorante stesso.

export type WhatsAppProviderId = 'twilio' | 'meta';

/** Il mittente WhatsApp di un ristorante. */
export interface TwilioSender {
    provider: 'twilio';
    /** Da dove vengono le credenziali: oggi solo le variabili d'ambiente. */
    source: 'env';
    accountSid: string;
    authToken: string;
    /** Sempre nella forma `whatsapp:+E164`. */
    from: string;
    /** Base delle API REST: https://api.twilio.com, o uno stub nei test. */
    restBase: string;
}

/** Il numero del ristorante sull'API Cloud di Meta (Fase 12): collegato dal
 *  locale, salvato in whatsapp_senders col token cifrato. */
export interface MetaSender {
    provider: 'meta';
    source: 'db';
    phoneNumberId: string;
    wabaId: string;
    accessToken: string;
    /** Come per Twilio, `whatsapp:+E164`: chi mostra il numero non deve
     *  sapere da quale provider arriva. */
    from: string;
    displayName: string | null;
    qualityRating: string | null;
    messagingLimit: string | null;
    /** Base della Graph API: https://graph.facebook.com/v25.0, o uno stub nei test. */
    graphBase: string;
}

export type WhatsAppSender = TwilioSender | MetaSender;

/** Esito di un invio: `sid` manca per i provider che non lo restituiscono
 *  (Vonage), e allora non si può seguire la consegna. */
export interface OutboundConfirmationResult {
    sid?: string;
    channel: 'sms' | 'whatsapp';
}

/** Template approvato: obbligatorio per i messaggi che partono da noi fuori
 *  dalla finestra di 24 ore. Le variabili sono numerate come nel corpo
 *  approvato ({{1}}, {{2}}, …). */
export interface WhatsAppTemplateOpts {
    contentSid: string;
    contentVariables: Record<string, string>;
}

/** Un allegato arrivato con un messaggio. Gli URL dei provider richiedono
 *  autenticazione: si servono dal proxy /messages/:id/media/:index. */
export interface InboundMedia {
    url: string;
    content_type: string;
}

/** Un tocco su un bottone di risposta rapida di un template. */
export interface InboundButton {
    /** L'id del bottone nel template, es. `rsv_confirm:<token>`. */
    payload: string | null;
    /** Il testo del bottone come l'ha visto il cliente. */
    text: string | null;
    type: string | null;
}

export interface InboundLocation {
    latitude: number;
    longitude: number;
    label: string | null;
    address: string | null;
}

/** Un messaggio in arrivo, già tolto dal formato del provider. */
export interface InboundMessage {
    provider: 'twilio' | 'vonage' | 'meta';
    channel: 'sms' | 'whatsapp';
    /** Numero del cliente, senza il prefisso `whatsapp:`. */
    from: string;
    /** Il nostro numero, quello a cui il cliente ha scritto. */
    to: string;
    body: string;
    /** Id del messaggio presso il provider: serve a scartare i ritentativi. */
    sid: string | null;
    media: InboundMedia[];
    /** Il nome del profilo WhatsApp del cliente, se il provider lo manda. */
    profileName: string | null;
    /** L'id utente legato all'azienda che WhatsApp introduce al posto del
     *  numero per chi usa un nome utente. Si conserva da subito. */
    externalUserId: string | null;
    button: InboundButton | null;
    /** Il messaggio nostro a cui il cliente ha risposto, se lo sappiamo. */
    repliedToSid: string | null;
    location: InboundLocation | null;
}
