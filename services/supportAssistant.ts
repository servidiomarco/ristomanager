// «Chiedi a Sympotia» — l'assistente di primo livello del supporto (fase 3).
//
// Risponde ai «come si fa» leggendo i manuali dell'app: il catalogo delle
// funzionalità (docs/funzionalita-app.md, senza il registro delle modifiche),
// il manuale utente e quello operativo di comande e cucina. Niente RAG: i
// tre testi stanno nel prompt di sistema, in cache (sono ~38k token stabili
// fra una domanda e l'altra), e la domanda arriva dopo.
//
// Non fa niente da solo: non legge dati del ristorante, non cambia
// impostazioni. Quando la domanda è un guasto o una cosa che i manuali non
// coprono lo dice e consiglia di aprire una richiesta — la conversazione
// diventa il primo messaggio della richiesta (vedi SupportPanel).
//
// Modello economico per scelta dell'utente (03/10/2026): Claude Haiku 4.5.
// Su Haiku 4.5 `output_config.effort` è un errore e il ragionamento esteso
// non serve a rispondere su un manuale: la richiesta resta essenziale.

import fs from 'fs';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';

export const SUPPORT_ASSISTANT_MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 1200;
/** La conversazione che il client rimanda: oltre, si tengono le ultime. */
const MAX_TURNS = 12;
const MAX_TURN_CHARS = 2000;
/** Il segnale che il modello mette in fondo quando serve una persona. */
const TICKET_MARKER = '[[RICHIESTA]]';

const DOCS = [
    { file: 'funzionalita-app.md', title: 'Catalogo delle funzionalità', stripFrom: '## Registro aggiornamenti' },
    { file: 'Manuale_Utente_CRM.md', title: 'Manuale utente' },
    { file: 'manuale-operativo-comande-cucina-passe.md', title: 'Manuale operativo comande, cucina e passe' },
] as const;

export class SupportAssistantError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'no_manuals' | 'upstream') {
        super(message);
        this.name = 'SupportAssistantError';
    }
}

export interface AssistantTurn {
    role: 'user' | 'assistant';
    content: string;
}

export interface AssistantContext {
    restaurantName: string;
    userRole: string;
    /** Le feature attive del ristorante: l'assistente non spiega un canale
     *  che il locale non ha come se fosse a portata di mano. */
    features: string[];
}

export interface AssistantUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

export interface AssistantAnswer {
    answer: string;
    /** Il modello consiglia di parlare con una persona del team. */
    suggestTicket: boolean;
}

// I manuali si leggono una volta per processo: cambiano solo con un deploy.
let manualsCache: string | null = null;

function loadManuals(): string {
    if (manualsCache != null) return manualsCache;
    const dir = path.resolve(process.cwd(), 'docs');
    const parts: string[] = [];
    for (const d of DOCS) {
        try {
            let text = fs.readFileSync(path.join(dir, d.file), 'utf8');
            const cut = 'stripFrom' in d ? text.indexOf(d.stripFrom) : -1;
            if (cut > 0) text = text.slice(0, cut);
            parts.push(`<manuale titolo="${d.title}">\n${text.trim()}\n</manuale>`);
        } catch {
            // Un manuale che manca non ferma gli altri: l'immagine Docker li
            // copia uno per uno (vedi Dockerfile).
        }
    }
    manualsCache = parts.join('\n\n');
    return manualsCache;
}

const INSTRUCTIONS = `Sei «Chiedi a Sympotia», l'assistente dentro Sympotia, il gestionale per ristoranti. Ti scrive chi lavora in un ristorante che usa Sympotia: titolare, direzione, sala, cucina, reception.

Rispondi solo con quello che trovi nei manuali qui sotto. Spiega dove si trova una funzione e quali tocchi servono, con i nomi esatti di menu, schede e bottoni come compaiono nei manuali. Se una cosa nei manuali non c'è, dillo chiaramente invece di indovinare.

Scrivi in italiano (o nella lingua in cui ti scrivono), in modo breve e pratico: chi legge spesso è in servizio. Di solito bastano da due a sei frasi, oppure un elenco numerato di passi. Niente titoli, niente tabelle.

Le funzioni del «pannello Piattaforma» (creare ristoranti, impersonificazione, permessi riservati, salute dei ristoranti) sono del team Sympotia, non del ristorante: non indicarle come cose che chi ti scrive può fare.

Se chi scrive descrive un guasto (qualcosa che non funziona come dovrebbe, un errore, una stampa che non esce, Sofia che non risponde, uno scontrino non emesso), se chiede una modifica al suo abbonamento, o se dopo la tua risposta il problema non si risolve con i manuali, consiglia di aprire una richiesta al team Sympotia e termina la risposta con la riga ${TICKET_MARKER} da sola. Non usare quella riga in nessun altro caso.`;

function buildSystem(ctx: AssistantContext): Anthropic.TextBlockParam[] {
    return [
        // Istruzioni + manuali: identici per ogni ristorante e ogni domanda,
        // quindi in cache. Il blocco variabile (chi scrive) viene DOPO il
        // punto di cache, così non lo invalida.
        {
            type: 'text',
            text: `${INSTRUCTIONS}\n\n${loadManuals()}`,
            cache_control: { type: 'ephemeral' },
        },
        {
            type: 'text',
            text: `Chi ti scrive: ruolo ${ctx.userRole} nel ristorante «${ctx.restaurantName}». Moduli attivi nel ristorante: ${ctx.features.length > 0 ? ctx.features.join(', ') : 'solo quelli di base'}. Se una funzione dipende da un modulo che non è attivo, dillo.`,
        },
    ];
}

/** La conversazione del client, ripulita: alternanza utente/assistente,
 *  testi tagliati, solo gli ultimi turni, e sempre una domanda in fondo. */
export function sanitizeAssistantTurns(input: unknown): AssistantTurn[] | null {
    if (!Array.isArray(input) || input.length === 0) return null;
    const turns: AssistantTurn[] = [];
    for (const raw of input) {
        if (!raw || typeof raw !== 'object') return null;
        const r = raw as Record<string, unknown>;
        const role = r.role === 'assistant' ? 'assistant' : r.role === 'user' ? 'user' : null;
        const content = typeof r.content === 'string' ? r.content.trim() : '';
        if (!role || !content) return null;
        turns.push({ role, content: content.slice(0, MAX_TURN_CHARS) });
    }
    const last = turns.slice(-MAX_TURNS);
    // Il primo turno dev'essere dell'utente; l'ultimo è la domanda nuova.
    while (last.length > 0 && last[0].role !== 'user') last.shift();
    if (last.length === 0 || last[last.length - 1].role !== 'user') return null;
    return last;
}

export const isSupportAssistantConfigured = (): boolean => !!(process.env.ANTHROPIC_API_KEY || '').trim();

export async function askSupportAssistant(
    turns: AssistantTurn[],
    ctx: AssistantContext,
    onUsage?: (usage: AssistantUsage) => void,
): Promise<AssistantAnswer> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new SupportAssistantError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (!loadManuals()) throw new SupportAssistantError('Manuali non trovati sul server', 'no_manuals');

    let response: Anthropic.Message;
    try {
        const client = new Anthropic({ apiKey });
        response = await client.messages.create({
            model: SUPPORT_ASSISTANT_MODEL,
            max_tokens: MAX_TOKENS,
            system: buildSystem(ctx),
            messages: turns.map(t => ({ role: t.role, content: t.content })),
        });
    } catch (err: any) {
        throw new SupportAssistantError(err?.message || 'Errore dal modello', 'upstream');
    }

    // I token si pagano anche quando la risposta non serve: prima di tutto.
    // ai_token_usage ha un solo contatore di input, prezzato a tariffa piena
    // (aiPricing.costUsd): qui va il suo EQUIVALENTE di costo — la scrittura
    // in cache costa 1,25×, la lettura 0,1× — così Consumi AI non gonfia di
    // dieci volte un prompt che quasi sempre arriva dalla cache.
    const cacheRead = response.usage.cache_read_input_tokens ?? 0;
    const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
    onUsage?.({
        model: SUPPORT_ASSISTANT_MODEL,
        promptTokens: (response.usage.input_tokens ?? 0) + Math.round(cacheWrite * 1.25) + Math.round(cacheRead * 0.1),
        outputTokens: response.usage.output_tokens ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
    });

    // Il rifiuto va guardato prima del contenuto: lì dentro non c'è niente.
    if (response.stop_reason === 'refusal') {
        return { answer: 'Su questo non posso aiutarti: apri una richiesta al team Sympotia.', suggestTicket: true };
    }

    const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();
    const suggestTicket = text.includes(TICKET_MARKER);
    const answer = text.split(TICKET_MARKER).join('').trim();
    if (!answer) {
        return { answer: 'Non ho trovato una risposta nei manuali: apri una richiesta al team Sympotia.', suggestTicket: true };
    }
    return { answer, suggestTicket };
}
