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
