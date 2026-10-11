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
// variabili TWILIO_* del canale messaggi. Le funzioni sull'env restano pure
// (i test le chiamano direttamente); il mittente Meta di un locale (Fase 12)
// si legge da whatsapp_senders, con una cache breve.

import { queryWithRetry } from '../../db.js';
import { decryptSecret } from '../../utils/secrets.js';
import type { MetaSender, TwilioSender, WhatsAppSender } from './types.js';

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

/** Base della Graph API di Meta. META_GRAPH_URL esiste per i test (stub). */
export function metaGraphBase(env: NodeJS.ProcessEnv = process.env): string {
    return (env.META_GRAPH_URL || 'https://graph.facebook.com/v25.0').replace(/\/+$/, '');
}

// Il mittente Meta si legge a ogni invio: mezzo minuto di cache basta a non
// interrogare il database per ogni messaggio di una raffica, e il
// collegamento e lo scollegamento la svuotano subito.
const META_CACHE_MS = 30_000;
const metaCache = new Map<number, { at: number; sender: MetaSender | null }>();

export function invalidateSenderCache(tenantId?: number): void {
    if (tenantId == null) metaCache.clear();
    else metaCache.delete(tenantId);
}

async function metaSenderFor(tenantId: number): Promise<MetaSender | null> {
    const hit = metaCache.get(tenantId);
    if (hit && Date.now() - hit.at < META_CACHE_MS) return hit.sender;
    let sender: MetaSender | null = null;
    try {
        const r = await queryWithRetry(
            `SELECT phone_e164, phone_number_id, waba_id, display_name, quality_rating, messaging_limit, access_token_enc
               FROM whatsapp_senders WHERE tenant_id = $1 AND provider = 'meta'`,
            [tenantId]
        );
        const row = r.rows[0];
        if (row) {
            sender = {
                provider: 'meta',
                source: 'db',
                phoneNumberId: String(row.phone_number_id),
                wabaId: String(row.waba_id),
                accessToken: decryptSecret(String(row.access_token_enc)),
                from: `whatsapp:${row.phone_e164}`,
                displayName: row.display_name ?? null,
                qualityRating: row.quality_rating ?? null,
                messagingLimit: row.messaging_limit ?? null,
                graphBase: metaGraphBase(),
            };
        }
    } catch (err: any) {
        // Un token che non si decifra (chiave cambiata) vale come nessun
        // mittente: il messaggio scende su email invece di fallire a metà.
        console.error('[whatsapp] mittente Meta non leggibile:', err?.message || err);
    }
    metaCache.set(tenantId, { at: Date.now(), sender });
    return sender;
}

/** Il mittente WhatsApp del ristorante, o null se non ne ha uno: Twilio da
 *  env per i ristoranti elencati (il Frantoio), altrimenti il numero Meta
 *  collegato dal locale. */
export async function getSender(tenantId: number): Promise<WhatsAppSender | null> {
    if (envTenantIds().has(tenantId)) {
        const twilio = twilioEnvSender();
        if (twilio) return twilio;
    }
    return metaSenderFor(tenantId);
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
