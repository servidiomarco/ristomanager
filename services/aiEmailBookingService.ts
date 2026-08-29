// Estrazione dei dettagli di prenotazione da un'email in arrivo.
//
// Stessa idea di services/tableAssignmentAgent.ts: un solo strumento, il
// modello lo chiama solo se ha qualcosa di sensato da proporre. Qui "sensato"
// vuol dire una richiesta di tavolo — se l'email è una domanda sul menù o un
// reclamo, il modello semplicemente non chiama lo strumento e la route
// restituisce has_booking_request: false. Non è un caso limite da gestire a
// parte, è il comportamento normale per la maggior parte delle email.
//
// Come per i suggerimenti di risposta, il modello NON crea nulla da solo:
// propone dei valori che il cameriere vede nel form di nuova prenotazione,
// già scritti ma tutti modificabili, prima di salvare.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const SFORZO = 'low' as const;
const MAX_TOKEN = 1024;

export interface EmailBookingContext {
    fromEmail: string;
    subject: string | null;
    body: string;
    restaurantName?: string;
}

export interface ExtractedBooking {
    customer_name: string | null;
    phone: string | null;
    /** YYYY-MM-DD */
    date: string | null;
    /** HH:MM */
    time: string | null;
    guests: number | null;
    notes: string | null;
}

export interface EmailBookingUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface EmailBookingResult {
    booking: ExtractedBooking | null;
    usage: EmailBookingUsage;
    /** Perché non c'è una proposta, quando capita — per non far sembrare rotto il tasto. */
    reason?: string;
}

export class EmailBookingExtractionError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'upstream') {
        super(message);
        this.name = 'EmailBookingExtractionError';
    }
}

export function isAiConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

const declaration: Anthropic.Tool = {
    name: 'estrai_prenotazione',
    description: 'Registra i dati di una richiesta di prenotazione trovata nell\'email. Chiamalo SOLO se il cliente sta chiedendo (o modificando) un tavolo per una data — non per domande generiche, reclami o altro.',
    input_schema: {
        type: 'object',
        properties: {
            customer_name: { type: 'string', description: 'Nome e cognome del cliente, come firmato o citato nell\'email' },
            phone: { type: 'string', description: 'Solo se presente nel testo dell\'email (es. in firma)' },
            date: { type: 'string', description: 'YYYY-MM-DD. Solo se esplicita o deducibile senza ambiguità rispetto a oggi (es. "domani", "sabato prossimo")' },
            time: { type: 'string', description: 'HH:MM, 24 ore' },
            guests: { type: 'integer', description: 'Numero di persone' },
            notes: { type: 'string', description: 'Richieste particolari: occasione, allergie citate dal cliente, posizione tavolo, ecc.' },
        },
    },
};

function buildSystem(ctx: EmailBookingContext): string {
    const oggi = new Date().toLocaleDateString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const iso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }); // YYYY-MM-DD

    return `Sei l'addetto alle prenotazioni del ristorante "${ctx.restaurantName || 'il ristorante'}" e leggi le email in arrivo dai clienti.

Oggi è ${oggi} (${iso}), fuso orario Europe/Rome.

COMPITO: leggi l'email e, se contiene una richiesta di prenotazione, chiama estrai_prenotazione con i dati trovati.

COME LEGGERE:
- Estrai solo ciò che è scritto o deducibile senza ambiguità (una data relativa come "venerdì" si risolve rispetto a oggi). Se un dato manca o è ambiguo, ometti quel campo: non inventare nomi, numeri di persone, date o orari.
- Il mittente è ${ctx.fromEmail}: non serve ripeterlo come nome, a meno che non compaia anche un nome proprio nel testo o nella firma.
- Se l'email NON è una richiesta di prenotazione (domanda generica, reclamo, altro), non chiamare lo strumento: rispondi con una riga di testo che dice perché.`;
}

export async function extractBookingFromEmail(ctx: EmailBookingContext): Promise<EmailBookingResult> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) {
        throw new EmailBookingExtractionError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    }

    const client = new Anthropic({ apiKey });
    let response: Anthropic.Message;
    try {
        response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            output_config: { effort: SFORZO },
            system: buildSystem(ctx),
            messages: [{
                role: 'user',
                content: `OGGETTO: ${ctx.subject || '(nessuno)'}\n\nTESTO:\n${ctx.body.slice(0, 6000)}`,
            }],
            tools: [declaration],
        } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (err: any) {
        throw new EmailBookingExtractionError(err?.message || 'Errore dal modello', 'upstream');
    }

    const usage: EmailBookingUsage = {
        model: MODEL,
        promptTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    };

    if (response.stop_reason === 'refusal') {
        return { booking: null, usage, reason: 'Il modello ha rifiutato di leggere questa email' };
    }

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) {
        const testo = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text)
            .join('')
            .trim();
        return { booking: null, usage, reason: testo || 'Nessuna richiesta di prenotazione trovata in questa email' };
    }

    const args = (call.input || {}) as Record<string, any>;
    const guests = Number(args.guests);
    const date = typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : null;
    const time = typeof args.time === 'string' && /^\d{1,2}:\d{2}$/.test(args.time) ? args.time.padStart(5, '0') : null;

    return {
        booking: {
            customer_name: typeof args.customer_name === 'string' && args.customer_name.trim() ? args.customer_name.trim() : null,
            phone: typeof args.phone === 'string' && args.phone.trim() ? args.phone.trim() : null,
            date,
            time,
            guests: Number.isFinite(guests) && guests > 0 ? Math.round(guests) : null,
            notes: typeof args.notes === 'string' && args.notes.trim() ? args.notes.trim() : null,
        },
        usage,
    };
}
