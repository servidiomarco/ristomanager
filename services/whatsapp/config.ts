// Chi manda WhatsApp (e SMS) per conto di quale ristorante.
//
// Fino a questo modulo il mittente era UNO, letto dalle variabili d'ambiente
// in una decina di punti di server.ts: qualunque ristorante con l'add-on
// WhatsApp scriveva ai suoi clienti dal numero del Frantoio, coi template del
// Frantoio (alcuni col nome scritto nel testo) e, in ripiego, con il mittente
// SMS «V Frantoio». Qui la regola diventa esplicita: le credenziali in env
// valgono solo per i ristoranti elencati in WHATSAPP_ENV_TENANT_IDS (di serie
// il solo tenant 1). Gli altri non hanno WhatsApp finché non collegano il
// proprio numero (Fase 12, API Cloud di Meta) — un messaggio che non parte è
// meglio di un messaggio che parte col nome di un altro locale.
//
// È l'unico posto, insieme a providers/twilio.ts, dove si leggono le
// variabili TWILIO_* del canale messaggi. Niente database qui: le funzioni
// sono pure e i test le chiamano direttamente (callbacks.ts legge il token
// webhook del ristorante).

import type { TwilioSender, WhatsAppSender } from './types.js';

/** I ristoranti che usano le credenziali Twilio in env. Il tenant 1 è il
 *  Frantoio, padrone del numero; un demo si aggiunge qui solo se deve
 *  davvero scrivere dal numero del Frantoio. */
export function envTenantIds(env: NodeJS.ProcessEnv = process.env): Set<number> {
    const raw = (env.WHATSAPP_ENV_TENANT_IDS ?? '1').trim();
    const ids = raw.split(',')
        .map(s => Number(s.trim()))
        .filter(n => Number.isInteger(n) && n > 0);
    return new Set(ids);
}

/** Il mittente Twilio dalle variabili d'ambiente, o null se manca un pezzo. */
export function twilioEnvSender(env: NodeJS.ProcessEnv = process.env): TwilioSender | null {
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const fromRaw = env.TWILIO_WHATSAPP_FROM;
    if (!accountSid || !authToken || !fromRaw) return null;
    const from = fromRaw.startsWith('whatsapp:')
        ? fromRaw
        : `whatsapp:${fromRaw.startsWith('+') ? fromRaw : `+${fromRaw}`}`;
    return {
        provider: 'twilio',
        source: 'env',
        accountSid,
        authToken,
        from,
        restBase: twilioRestBase(env),
    };
}

/** Base delle API REST di Twilio. TWILIO_REST_URL esiste per i test (stub
 *  locale), come per le credenziali SIP del cordless. */
export function twilioRestBase(env: NodeJS.ProcessEnv = process.env): string {
    return (env.TWILIO_REST_URL || 'https://api.twilio.com').replace(/\/+$/, '');
}

/** Il mittente WhatsApp del ristorante, o null se non ne ha uno. */
export async function getSender(tenantId: number): Promise<WhatsAppSender | null> {
    if (envTenantIds().has(tenantId)) return twilioEnvSender();
    return null;
}

/** Il ristorante può mandare WhatsApp adesso? */
export async function isWhatsAppReady(tenantId: number): Promise<boolean> {
    return (await getSender(tenantId)) != null;
}

/** Il mittente SMS (sempre Twilio da env: un servizio di messaggistica col
 *  mittente alfanumerico «V Frantoio», o un numero). Vale solo per i
 *  ristoranti in WHATSAPP_ENV_TENANT_IDS, per la stessa ragione del
 *  WhatsApp: il mittente porta il nome del Frantoio. */
export interface TwilioSmsSender {
    accountSid: string;
    authToken: string;
    messagingServiceSid: string | null;
    from: string | null;
    restBase: string;
}

export function getSmsSender(tenantId: number, env: NodeJS.ProcessEnv = process.env): TwilioSmsSender | null {
    if (!envTenantIds(env).has(tenantId)) return null;
    const accountSid = env.TWILIO_ACCOUNT_SID;
    const authToken = env.TWILIO_AUTH_TOKEN;
    const messagingServiceSid = env.TWILIO_MESSAGING_SERVICE_SID || null;
    const from = env.TWILIO_SMS_FROM || null;
    if (!accountSid || !authToken || (!messagingServiceSid && !from)) return null;
    return { accountSid, authToken, messagingServiceSid, from, restBase: twilioRestBase(env) };
}

export function isSmsReady(tenantId: number): boolean {
    return getSmsSender(tenantId) != null;
}

// Base pubblica del BACKEND (questo processo), da non confondere con
// publicBaseUrl() di server.ts che punta alla SPA su Vercel. Serve a tutto
// ciò che un servizio esterno deve poter chiamare o scaricare da noi:
// callback Twilio e allegati in uscita.
export function backendBaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
    const base = env.PUBLIC_WEBHOOK_BASE_URL || env.VITE_API_URL;
    return base ? base.replace(/\/+$/, '') : null;
}

/** Il token con cui Twilio firma i webhook dell'account principale (voce,
 *  WhatsApp e SMS del Frantoio). Basta questo per verificare una firma,
 *  anche dove il mittente WhatsApp non è configurato (i test). */
export function twilioWebhookAuthToken(env: NodeJS.ProcessEnv = process.env): string | null {
    return env.TWILIO_AUTH_TOKEN || null;
}
