// ============================================
// MITTENTE WHATSAPP/SMS — QUELLO IN ENV È DEL FRANTOIO
// ============================================
// Le credenziali Twilio/Meta in env (conto, numero WhatsApp verificato,
// sender «V Frantoio», template approvati) sono del Vecchio Frantoio. Fino
// al 25/09/2026 ogni tenant spediva da lì, anche senza login: una POST
// anonima su /public/demo-pizzeria/reservations con un telefono qualsiasi
// faceva partire un WhatsApp/SMS dal mittente del Frantoio, col nome scelto
// da chi scriveva (audit isolamento tenant, H-08). Un abuso così abbassa il
// quality rating del numero e mette a rischio le conferme del ristorante vero.
//
// Da allora le credenziali si leggono SOLO da qui. Il tenant proprietario
// (il Frantoio, PUBLIC_TENANT_ID) è cablato e nessuna env può escluderlo: un
// typo spegnerebbe in silenzio conferme e promemoria del ristorante vero.
// ENV_MESSAGING_TENANT_IDS può solo AGGIUNGERE tenant; un valore malformato
// si logga e si ignora.
//
// Per le demo, ENV_MESSAGING_SANDBOX_RECIPIENTS (numeri separati da virgola,
// vuota = nessuno): un tenant non ammesso può spedire solo verso quei numeri
// — i telefoni di chi fa la demo, come nei trial Twilio. Il confronto è
// l'uguaglianza esatta in E.164 sul numero che partirebbe davvero: né
// right-10 (caso Pisciotta) né phoneMatchKey, che è una chiave larga pensata
// per unire i thread e farebbe passare anche +3330009990 per +39 333 000 9990.
//
// Modulo puro, env passata dal chiamante: è la parte che decide, e si prova
// senza avviare il server (tests/api/messaggistica-mittente-tenant.test.ts).

import { normalizePhoneE164 } from '../utils/phone.js';

export type MessagingEnv = Readonly<Record<string, string | undefined>>;

export interface EnvMessagingConfig {
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioWhatsAppFrom?: string;
    twilioMessagingServiceSid?: string;
    twilioSmsFrom?: string;
    metaAccessToken?: string;
    metaPhoneNumberId?: string;
}

// Lanciata dalle primitive d'invio PRIMA di qualunque fetch e di qualunque
// riga in outbound_messages: un tenant senza mittente non lascia nemmeno un
// tentativo «fallito» nella propria conversazione.
export class MessagingUnavailableError extends Error {
    constructor() {
        super('Messaggi non ancora attivi per questo ristorante');
        this.name = 'MessagingUnavailableError';
    }
}

// Il corpo del 409 degli invii a mano. `message` è la frase che l'operatore
// legge (buildApiError la preferisce al codice), `error` il codice su cui
// un client può ramificare.
export const MESSAGING_NOT_AVAILABLE = {
    error: 'messaging_not_available',
    message: 'Messaggi non ancora attivi per questo ristorante',
} as const;

export function parseMessagingTenantIds(raw: string | undefined, warn: (msg: string) => void = () => {}): Set<number> {
    const ids = new Set<number>();
    for (const part of String(raw || '').split(',')) {
        const value = part.trim();
        if (!value) continue;
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) ids.add(id);
        else warn(`[messaggi] ENV_MESSAGING_TENANT_IDS: valore «${value.slice(0, 20)}» ignorato`);
    }
    return ids;
}

// Le voci della sandbox vanno scritte col prefisso internazionale; senza,
// valgono come italiane (chi fa le demo oggi è in Italia).
export function parseSandboxRecipients(raw: string | undefined): Set<string> {
    const numbers = new Set<string>();
    for (const part of String(raw || '').split(',')) {
        const e164 = normalizePhoneE164(part.trim(), '39');
        if (e164.replace(/\D/g, '').length >= 8) numbers.add(e164);
    }
    return numbers;
}

// Solo un numero già internazionale ('+' e cifre) può combaciare con la
// sandbox. La forma locale va prima risolta col prefisso del ristorante
// (lo fanno le primitive d'invio e messagingDestination in server.ts):
// indovinarla qui farebbe divergere il controllo dall'invio vero.
function asE164(to: string | null | undefined): string {
    const s = String(to ?? '').trim();
    if (!s.startsWith('+')) return '';
    const digits = s.replace(/\D/g, '');
    return digits ? `+${digits}` : '';
}

export interface NotificationReadiness {
    /** Il tenant può spedire verso questo numero dal mittente in env. */
    allowed: boolean;
    whatsappReady: boolean;
    smsReady: boolean;
}

export interface MessagingSender {
    /** Mittente proprio: il tenant proprietario o uno aggiunto da env. La
     *  sandbox non conta: quella guarda il destinatario. */
    hasOwnSender(tenantId: number | string): boolean;
    isSandboxRecipient(toE164: string | null | undefined): boolean;
    /** null = questo tenant non spedisce dal mittente in env (verso `toE164`,
     *  quando c'è). Un oggetto non vuol dire «configurato»: per il tenant
     *  proprietario i campi possono mancare e i chiamanti danno i loro errori
     *  di sempre («Twilio not configured»). */
    configFor(tenantId: number | string, toE164?: string | null): EnvMessagingConfig | null;
    twilioWhatsAppReady(tenantId: number | string, toE164?: string | null): boolean;
    twilioSmsReady(tenantId: number | string, toE164?: string | null): boolean;
    metaWhatsAppReady(tenantId: number | string): boolean;
    /** Il canale WhatsApp si può OFFRIRE all'operatore prima di conoscere il
     *  numero: mittente proprio, oppure una sandbox non vuota (il numero si
     *  controlla all'invio, che risponde 409 fuori dalla sandbox). */
    twilioWhatsAppOffered(tenantId: number | string): boolean;
    /** I canali di una notifica automatica (dispatchBookingNotification):
     *  per un tenant non ammesso verso quel numero, né WhatsApp né SMS. */
    notificationReadiness(tenantId: number | string, toE164: string | null | undefined, opts: { whatsappTemplate: boolean }): NotificationReadiness;
}

export function createMessagingSender(
    env: MessagingEnv,
    opts: { ownerTenantId: number; warn?: (msg: string) => void }
): MessagingSender {
    // Lette una volta al boot, come ogni env di configurazione; le
    // credenziali invece si rileggono a ogni chiamata, come prima.
    const extraTenants = parseMessagingTenantIds(env.ENV_MESSAGING_TENANT_IDS, opts.warn);
    const sandbox = parseSandboxRecipients(env.ENV_MESSAGING_SANDBOX_RECIPIENTS);

    // tenantId può arrivare come stringa: pg restituisce i BIGINT così.
    const hasOwnSender = (tenantId: number | string): boolean => {
        const id = Number(tenantId);
        return id === opts.ownerTenantId || extraTenants.has(id);
    };
    const isSandboxRecipient = (toE164: string | null | undefined): boolean => {
        const e164 = asE164(toE164);
        return !!e164 && sandbox.has(e164);
    };
    const configFor = (tenantId: number | string, toE164?: string | null): EnvMessagingConfig | null => {
        if (!hasOwnSender(tenantId) && !isSandboxRecipient(toE164)) return null;
        return {
            twilioAccountSid: env.TWILIO_ACCOUNT_SID,
            twilioAuthToken: env.TWILIO_AUTH_TOKEN,
            twilioWhatsAppFrom: env.TWILIO_WHATSAPP_FROM,
            twilioMessagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
            twilioSmsFrom: env.TWILIO_SMS_FROM,
            metaAccessToken: env.META_WHATSAPP_ACCESS_TOKEN,
            metaPhoneNumberId: env.META_WHATSAPP_PHONE_NUMBER_ID,
        };
    };
    const whatsAppCredentials = (cfg: EnvMessagingConfig | null): boolean =>
        !!(cfg?.twilioAccountSid && cfg.twilioAuthToken && cfg.twilioWhatsAppFrom);
    const smsCredentials = (cfg: EnvMessagingConfig | null): boolean =>
        !!(cfg?.twilioAccountSid && cfg.twilioAuthToken && (cfg.twilioMessagingServiceSid || cfg.twilioSmsFrom));

    return {
        hasOwnSender,
        isSandboxRecipient,
        configFor,
        twilioWhatsAppReady: (tenantId, toE164) => whatsAppCredentials(configFor(tenantId, toE164)),
        twilioSmsReady: (tenantId, toE164) => smsCredentials(configFor(tenantId, toE164)),
        metaWhatsAppReady: (tenantId) => {
            const cfg = configFor(tenantId);
            return !!(cfg?.metaAccessToken && cfg.metaPhoneNumberId);
        },
        twilioWhatsAppOffered: (tenantId) =>
            (hasOwnSender(tenantId) || sandbox.size > 0)
            && whatsAppCredentials({
                twilioAccountSid: env.TWILIO_ACCOUNT_SID,
                twilioAuthToken: env.TWILIO_AUTH_TOKEN,
                twilioWhatsAppFrom: env.TWILIO_WHATSAPP_FROM,
            }),
        notificationReadiness: (tenantId, toE164, { whatsappTemplate }) => {
            const cfg = configFor(tenantId, toE164);
            return {
                allowed: !!cfg,
                whatsappReady: whatsappTemplate && whatsAppCredentials(cfg),
                smsReady: smsCredentials(cfg),
            };
        },
    };
}
