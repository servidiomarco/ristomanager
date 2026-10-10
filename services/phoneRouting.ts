// Il giro delle chiamate quando Sympotia sta davanti al numero (docs/
// telefono-piano.md, Fase 2). Twilio chiama /voice/inbound, Sympotia decide
// e risponde con TwiML. In Fase 2 la regola è una sola: risponde Sofia, come
// prima, ma agganciata da noi con register-call invece che dall'integrazione
// nativa di ElevenLabs. Dalla Fase 3 qui nascono anche gli squilli in sala.
//
// register-call (verificato nella Fase 0, 10/10/2026): ElevenLabs restituisce
// il TwiML che collega la chiamata all'agente via WebSocket. Le variabili
// passate in conversation_initiation_client_data arrivano a Sofia, e il
// post-call porta metadata.phone_call.call_sid = CallSid Twilio,
// system__caller_id = from_number. L'agente deve avere l'audio in μ-law 8000.

import jwt from 'jsonwebtoken';
import type { PhoneAnswerMode, PhoneRoutingOverride, PhoneRoutingSlot } from '../utils/phoneSchedule.js';

const REGISTER_CALL_URL = 'https://api.elevenlabs.io/v1/convai/twilio/register-call';

// Twilio aspetta il TwiML al massimo 15 secondi; register-call risponde in
// meno di uno. Oltre i 5 secondi conviene il messaggio di cortesia a un
// chiamante appeso al silenzio.
const REGISTER_CALL_TIMEOUT_MS = 5000;

export const xmlEscape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export const twimlResponse = (inner: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

/** Il chiamante sente un messaggio e la chiamata si chiude: Sofia non c'è e
 *  in Fase 2 non c'è ancora nessuno da far squillare. Lo staff la ritrova in
 *  Chiamate › Da ricontattare. */
export const unavailableTwiml = (businessName: string): string =>
    twimlResponse(
        `<Say language="it-IT">${xmlEscape(
            `Grazie per aver chiamato ${businessName}. In questo momento non riusciamo a rispondere: la richiameremo al più presto.`
        )}</Say><Hangup/>`
    );

export interface SofiaInitData {
    dynamic_variables: Record<string, string>;
    conversation_config_override?: { agent?: { first_message?: string } };
}

/** Configurazione per register-call: la chiave e l'agente di ElevenLabs.
 *  SOFIA_REGISTER_CALL_URL sostituisce l'endpoint di ElevenLabs solo nei test
 *  (stub locale): lì chiave e agente non servono. */
export function sofiaRegisterConfig(): { url: string; apiKey: string; agentId: string } | null {
    const override = process.env.SOFIA_REGISTER_CALL_URL;
    if (override) return { url: override, apiKey: 'stub', agentId: process.env.ELEVENLABS_AGENT_ID || 'agent-stub' };
    const apiKey = process.env.ELEVENLABS_API_KEY;
    const agentId = process.env.ELEVENLABS_AGENT_ID;
    if (!apiKey || !agentId) return null;
    return { url: REGISTER_CALL_URL, apiKey, agentId };
}

/** TwiML che collega la chiamata a Sofia. Lancia se ElevenLabs non risponde,
 *  risponde con un errore o non restituisce TwiML: il chiamante allora sente
 *  il messaggio di cortesia. */
export async function registerSofiaCall(args: {
    from: string;
    to: string;
    init: SofiaInitData;
}): Promise<string> {
    const config = sofiaRegisterConfig();
    if (!config) throw new Error('ElevenLabs non configurato');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REGISTER_CALL_TIMEOUT_MS);
    try {
        const res = await fetch(config.url, {
            method: 'POST',
            headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agent_id: config.agentId,
                from_number: args.from,
                to_number: args.to,
                direction: 'inbound',
                conversation_initiation_client_data: args.init,
            }),
            signal: controller.signal,
        });
        const text = await res.text();
        if (!res.ok) throw new Error(`register-call ${res.status}: ${text.slice(0, 200)}`);
        if (!text.includes('<Response')) throw new Error(`register-call senza TwiML: ${text.slice(0, 200)}`);
        return text;
    } finally {
        clearTimeout(timer);
    }
}

// --- Prima il cellulare, poi Sofia (Fase 3 ridotta) -------------------------
// In attesa del softphone e del cordless, squilla il cellulare del locale
// come una telefonata normale: suona anche a schermo bloccato e non serve
// nessuna app. Chi risponde sente chi chiama e preme 1: senza questo
// controllo la segreteria del cellulare «risponderebbe» e la chiamata non
// arriverebbe mai a Sofia.

/** 'prima_locale' fa squillare i dispositivi del CRM e i cellulari; si
 *  chiamava 'prima_cellulare' prima del softphone (Fase 3) e il valore
 *  vecchio salvato si legge così. */
export type PhoneRoutingMode = PhoneAnswerMode;

export interface PhoneRouting {
    /** La regola di base: vale fuori dalle fasce e senza interruttore. */
    mode: PhoneRoutingMode;
    /** E.164, al massimo tre: squillano insieme, vince il primo che preme 1. */
    mobiles: string[];
    ring_seconds: number;
    /** Fasce orarie con una regola diversa da quella di base. */
    slots: PhoneRoutingSlot[];
    /** «Risponde Sofia / il locale adesso», fino a un'ora data. */
    override: PhoneRoutingOverride | null;
}

export const parseRoutingMode = (raw: unknown): PhoneRoutingMode =>
    raw === 'prima_locale' || raw === 'prima_cellulare' ? 'prima_locale' : 'solo_sofia';

export const DEFAULT_PHONE_ROUTING: PhoneRouting = { mode: 'solo_sofia', mobiles: [], ring_seconds: 15, slots: [], override: null };
export const PHONE_ROUTING_MAX_MOBILES = 3;
export const PHONE_ROUTING_RING_MIN = 5;
export const PHONE_ROUTING_RING_MAX = 60;

/** Squillo del locale: i dispositivi del CRM (<Client>) e i cellulari
 *  (<Number> con l'annuncio), tutti insieme. Chi chiama sente lo squillo
 *  italiano (ringTone) finché qualcuno non risponde, annuncio compreso. Niente
 *  answerOnBridge: con la chiamata del cliente ancora senza risposta, a fine
 *  squillo Twilio la chiudeva «no-answer» invece di passarla a Sofia (prova
 *  del 10/10 18:52). Il numero mostrato ai cellulari è il nostro: il passaggio del
 *  numero del cliente va provato prima di usarlo. Il browser riceve il
 *  CallSid della chiamata del cliente e il suo numero come parametri, per
 *  agganciarsi al banner «chi chiama». */
export const dialLocaleTwiml = (args: {
    clients: string[]; mobiles: string[]; ringSeconds: number; callerId: string;
    parentCallSid: string; caller: string;
    afterDialUrl: string; whisperUrl: string; clientAnsweredUrl: string;
}): string =>
    twimlResponse(
        `<Dial timeout="${args.ringSeconds}" ringTone="it" callerId="${xmlEscape(args.callerId)}" action="${xmlEscape(args.afterDialUrl)}" method="POST">`
        + args.clients.map(identity =>
            `<Client statusCallbackEvent="answered" statusCallback="${xmlEscape(args.clientAnsweredUrl)}" statusCallbackMethod="POST">`
            + `<Identity>${xmlEscape(identity)}</Identity>`
            + `<Parameter name="parentCallSid" value="${xmlEscape(args.parentCallSid)}"/>`
            + `<Parameter name="caller" value="${xmlEscape(args.caller)}"/>`
            + `</Client>`).join('')
        + args.mobiles.map(m => `<Number url="${xmlEscape(args.whisperUrl)}" method="POST">${xmlEscape(m)}</Number>`).join('')
        + `</Dial>`
    );

/** Annuncio al cellulare che ha risposto: chi chiama, e «premi 1». Senza il
 *  tasto la gamba si chiude e la chiamata passa a Sofia. */
export const whisperTwiml = (args: { announce: string; confirmUrl: string }): string =>
    twimlResponse(
        `<Gather numDigits="1" timeout="6" action="${xmlEscape(args.confirmUrl)}" method="POST">`
        + `<Say language="it-IT">${xmlEscape(args.announce)}</Say>`
        + `</Gather><Hangup/>`
    );

// --- Softphone nel CRM (Fase 3) ---------------------------------------------
// Il browser riceve un access token Twilio (JWT HS256 firmato con una API key)
// e registra un Device con identità t<tenant>d<dispositivo>. Le chiamate in
// uscita («Richiama») passano dalla TwiML App, che chiama /voice/client-call.

export interface SoftphoneConfig {
    accountSid: string;
    apiKeySid: string;
    apiKeySecret: string;
    twimlAppSid: string;
}

export function softphoneConfig(): SoftphoneConfig | null {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const apiKeySid = process.env.TWILIO_API_KEY_SID;
    const apiKeySecret = process.env.TWILIO_API_KEY_SECRET;
    const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
    if (!accountSid || !apiKeySid || !apiKeySecret || !twimlAppSid) return null;
    return { accountSid, apiKeySid, apiKeySecret, twimlAppSid };
}

export const deviceIdentity = (tenantId: number, deviceId: number): string => `t${tenantId}d${deviceId}`;

export function parseDeviceIdentity(raw: unknown): { tenantId: number; deviceId: number } | null {
    const m = /^(?:client:)?t(\d+)d(\d+)$/.exec(String(raw ?? ''));
    return m ? { tenantId: Number(m[1]), deviceId: Number(m[2]) } : null;
}

export const SOFTPHONE_TOKEN_TTL_SECONDS = 3600;

/** Access token del Voice SDK: riceve le chiamate per la sua identità e
 *  chiama solo attraverso la TwiML App di Sympotia. */
export function softphoneToken(config: SoftphoneConfig, identity: string): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
        {
            jti: `${config.apiKeySid}-${now}`,
            grants: {
                identity,
                voice: { incoming: { allow: true }, outgoing: { application_sid: config.twimlAppSid } },
            },
        },
        config.apiKeySecret,
        {
            algorithm: 'HS256',
            issuer: config.apiKeySid,
            subject: config.accountSid,
            expiresIn: SOFTPHONE_TOKEN_TTL_SECONDS,
            header: { typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' } as any,
        }
    );
}

/** «Richiama» dal CRM: solo numeri italiani, col numero del locale come
 *  chiamante. Il limite all'Italia è la difesa dalle chiamate verso numeri
 *  esteri a pagamento se un token finisse in mani sbagliate. */
export const isCallableNumber = (e164: string): boolean => /^\+39\d{6,11}$/.test(e164);

// La durata arriva dallo status callback della TwiML App, sul CallSid del
// browser: è quello che finisce in phone_calls.
export const outboundTwiml = (args: { callerId: string; number: string }): string =>
    twimlResponse(
        `<Dial callerId="${xmlEscape(args.callerId)}" answerOnBridge="true" timeout="40">`
        + `<Number>${xmlEscape(args.number)}</Number>`
        + `</Dial>`
    );
