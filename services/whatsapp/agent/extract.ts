// Estrae i campi di UNA prenotazione dal thread, per il bottone "Crea
// prenotazione" della chat. A differenza di runAgent — che propone
// create_reservation solo a valle della conferma del cliente e per una
// richiesta nuova si limita a rispondere — qui FORZIAMO la chiamata a
// create_reservation, così i campi tornano sempre. Non esegue nulla, non
// scrive, non richiede le regole della casa: è pura lettura del messaggio.

import Anthropic from '@anthropic-ai/sdk';
import { MODEL, historyOf } from './run.js';
import { createReservationTool } from './tools/booking.js';
import { AgentError, type AgentContext, type AgentUsage } from './types.js';

const MAX_TOKEN = 4096;

export interface ExtractedBooking {
    customer_name?: string;
    date?: string;   // grezzo dal modello, normalizzato dall'endpoint
    time?: string;
    shift?: 'LUNCH' | 'DINNER';
    guests?: number;
    children?: number;
    location_preference?: 'INDOOR' | 'OUTDOOR';
    notes?: string;
}

export async function extractBooking(input: {
    phone: string;
    /** Oggi nel fuso del locale (YYYY-MM-DD), per risolvere "sabato 29",
     *  "domani". Il nome resta todayRome: è la stessa cosa per il Frantoio. */
    todayRome: string;
    /** Fuso del locale, solo per dirlo al modello nel prompt. */
    timezone?: string;
    messages: Array<{ direction: 'inbound' | 'outbound'; body: string }>;
}): Promise<{ args: ExtractedBooking | null; usage: AgentUsage }> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new AgentError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    const client = new Anthropic({ apiKey });
    const usage: AgentUsage = { model: MODEL, promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };

    // Inizia e finisce con un turno del cliente: il modello rifiuta un prefill
    // dell'assistant come ultimo messaggio (400). Se lo staff ha risposto per
    // ultimo, si estrae comunque dall'ultima richiesta del cliente.
    const messages = historyOf(input.messages);
    if (messages.length === 0) return { args: null, usage };

    const system = `Estrai i dati di UNA prenotazione dai messaggi del cliente e chiama create_reservation con i campi che riesci a ricavare. Oggi è ${input.todayRome} (fuso ${input.timezone || 'Europe/Rome'}). Regole:
- date: formato YYYY-MM-DD, risolvendo le espressioni relative ("sabato 29", "domani", "questo venerdì") rispetto a oggi.
- time: formato HH:MM 24h. Un orario serale scritto informale come "7:30"/"7.30"/"half seven" per cena è le 19:30; "8" di sera è 20:00. A pranzo l'orario resta com'è.
- shift: LUNCH se l'orario cade fra le 11 e le 16, altrimenti DINNER.
- guests: numero di persone. children solo se il cliente lo indica.
- location_preference: OUTDOOR per esterno/fuori/fiume/giardino/"level up from the river", INDOOR per interno/sala; ometti se non espresso.
- notes: eventuali richieste particolari, testuali e brevi (es. "level up from the river").
- customer_name: il nome del cliente se compare nel thread.
Il telefono è ${input.phone}. Chiama SEMPRE create_reservation, anche con dati parziali; non scrivere altro testo.`;

    let response: Anthropic.Beta.BetaMessage;
    try {
        // Niente reasoning qui: tool_choice forzato non è compatibile con
        // l'effort, e l'estrazione è un compito diretto.
        response = await client.beta.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            system,
            messages,
            tools: [createReservationTool.definition({} as AgentContext)],
            tool_choice: { type: 'tool', name: 'create_reservation' },
        });
        usage.promptTokens += response.usage.input_tokens ?? 0;
        usage.outputTokens += response.usage.output_tokens ?? 0;
        usage.totalTokens = usage.promptTokens + usage.outputTokens;
        usage.calls = 1;
    } catch (err: any) {
        throw new AgentError(err?.message || 'Errore dal modello', 'upstream');
    }

    const call = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (!call) return { args: null, usage };
    const a = (call.input || {}) as Record<string, any>;
    const args: ExtractedBooking = {
        customer_name: typeof a.customer_name === 'string' ? a.customer_name : undefined,
        date: typeof a.date === 'string' ? a.date : undefined,
        time: typeof a.time === 'string' ? a.time : undefined,
        shift: a.shift === 'LUNCH' || a.shift === 'DINNER' ? a.shift : undefined,
        guests: typeof a.guests === 'number' ? a.guests : (Number.isFinite(Number(a.guests)) ? Number(a.guests) : undefined),
        children: typeof a.children === 'number' ? a.children : undefined,
        location_preference: a.location_preference === 'INDOOR' || a.location_preference === 'OUTDOOR' ? a.location_preference : undefined,
        notes: typeof a.notes === 'string' && a.notes.trim() ? a.notes.trim() : undefined,
    };
    return { args, usage };
}
