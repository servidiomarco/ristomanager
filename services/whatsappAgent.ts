// L'agente che legge i messaggi WhatsApp e propone cosa fare.
//
// REGOLA CENTRALE, da cui discende tutto il resto: **l'agente non scrive mai
// sulle prenotazioni da solo**. Gli strumenti sono divisi in due categorie e
// trattati in modo opposto:
//
//   check_availability   sola lettura  → eseguito subito, senza chiedere
//   create/modify/cancel scrivono      → diventano una PROPOSTA da confermare
//
// La divisione non è una fase di rodaggio da superare, è il progetto: un
// errore su una lettura si legge e si scarta, un errore su una scrittura è un
// tavolo fantasma o una prenotazione cancellata a un cliente che si presenta.
// Il modello fa la parte in cui è bravo (capire "siamo 3 invece di 5" e
// tradurlo in parametri), la persona fa quella che conta (decidere).
//
// Il modello è Claude. La prova tecnica del 2026-08-18 era stata fatta su
// Gemini (11 scelte corrette su 12) ma quel piano si esaurisce dopo una
// manciata di richieste al giorno, e un agente che si ferma al quinto cliente
// della serata non è un agente. Le regole della casa sono ripetute nel prompt
// qui sotto perché è lì che vengono applicate, non negli strumenti.

import Anthropic from '@anthropic-ai/sdk';
import { describeDepositPolicy, type DepositPolicy } from './depositPolicy.js';
import * as bookingTools from './bookingTools.js';
import { WHATSAPP_CHANNEL } from './bookingTools.js';

const MODEL = 'claude-opus-5';
const MAX_GIRI = 4;

// Il ragionamento resta ACCESO. Non è un vezzo: con il ragionamento spento il
// modello può scrivere la chiamata a uno strumento dentro il testo visibile
// invece di emetterla davvero — il turno riesce, la chiamata non parte, e
// nessuno se ne accorge. Per contenere costo e attesa si abbassa lo sforzo,
// non si spegne il ragionamento.
const SFORZO = 'low' as const;

// Il ragionamento consuma dallo stesso budget della risposta: stretto qui
// significa risposte troncate a metà.
const MAX_TOKEN = 4096;

/** Strumenti che scrivono: non si eseguono, si propongono. */
const STRUMENTI_DI_SCRITTURA = new Set(['create_reservation', 'modify_reservation', 'cancel_reservation']);

export interface AgentContext {
    /** Tenant della conversazione: la route autenticata passa req.tenantId,
     *  e gli strumenti di prenotazione lo esigono come primo parametro (C2). */
    tenantId: number;
    phoneDigits: string;
    /** Messaggi della conversazione, dal più vecchio al più recente. */
    messages: Array<{ direction: 'inbound' | 'outbound'; body: string }>;
    reservation?: {
        id?: number | null;
        customer_name?: string | null;
        reservation_time?: Date | string | null;
        guests?: number | null;
        room_name?: string | null;
        notes?: string | null;
        status?: string | null;
    } | null;
    /** Numero di telefono in formato leggibile, per i parametri degli strumenti. */
    phone: string;
    knowledge: Array<{ title: string; content: string }>;
    largeGroupThreshold: number;
    restaurantName?: string;
    /**
     * Politica caparra letta dalle Impostazioni. Arriva qui invece di stare
     * scritta in una regola della casa perché il gestore la cambia da lì: una
     * regola col numero a mano resta indietro in silenzio, e l'AI finisce a
     * dire ai clienti una soglia che il sistema non applica.
     */
    depositPolicy?: DepositPolicy;
}

export interface AgentProposal {
    tool: string;
    args: Record<string, any>;
    /** Riga leggibile per lo staff: "Sposta da 20:30 a 21:00". */
    summary: string;
}

/** Token consumati da UN giro dell'agente, sommati su tutte le chiamate. */
export interface AgentUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
    /** Quante volte si è interrogato il modello: il giro ne fa da 1 a 3. */
    calls: number;
}

export interface AgentResult {
    /** Testo proposto per il cliente; null se l'agente non sa che dire. */
    reply: string | null;
    /** Azione che l'agente eseguirebbe, in attesa di conferma umana. */
    proposal: AgentProposal | null;
    /** Esito delle letture fatte davvero (disponibilità), per trasparenza. */
    checks: Array<{ tool: string; args: Record<string, any>; result: any }>;
    /** Perché non c'è una proposta né una risposta, quando capita. */
    reason?: string;
    /**
     * Consumo dell'intero giro. Va sommato su TUTTE le chiamate: il ciclo può
     * interrogare il modello più volte (verifica disponibilità, poi la frase di
     * attesa), e contarne una sola sottostimerebbe la spesa di due terzi.
     */
    usage: AgentUsage;
}

export class AgentError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'no_knowledge' | 'upstream') {
        super(message);
        this.name = 'AgentError';
    }
}

// ---------------------------------------------------------------------------
// Dichiarazione degli strumenti — gli stessi quattro di Sofia
// ---------------------------------------------------------------------------

const declarations = (threshold: number): Anthropic.Tool[] => ([
    {
        name: 'check_availability',
        description: `Verifica se ci sono tavoli liberi. Usalo SEMPRE prima di dire al cliente che c'è posto: non confermare mai una disponibilità che non hai verificato con questo strumento.`,
        input_schema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Data in formato YYYY-MM-DD' },
                shift: { type: 'string', enum: ['LUNCH', 'DINNER'], description: 'LUNCH per pranzo, DINNER per cena' },
                guests: { type: 'integer', description: 'Numero di persone' },
                location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'], description: 'Solo se il cliente esprime una preferenza' },
            },
            required: ['date', 'shift', 'guests'],
        },
    },
    {
        name: 'create_reservation',
        description: `Crea una nuova prenotazione. Servono tutti: nome e cognome reali, telefono, data, ora, turno, numero di persone. Se ne manca anche uno solo NON usare questo strumento: chiedi al cliente il dato mancante.`,
        input_schema: {
            type: 'object',
            properties: {
                customer_name: { type: 'string', description: 'Nome e cognome reali, mai segnaposto come "Cliente"' },
                phone: { type: 'string' },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time: { type: 'string', description: 'HH:MM' },
                shift: { type: 'string', enum: ['LUNCH', 'DINNER'] },
                guests: { type: 'integer' },
                children: { type: 'integer', description: 'Quanti dei coperti sono bambini' },
                location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'] },
                notes: { type: 'string', description: 'Richieste particolari del cliente' },
            },
            required: ['customer_name', 'phone', 'date', 'time', 'shift', 'guests'],
        },
    },
    {
        name: 'modify_reservation',
        description: `Modifica la prenotazione esistente. Passa SOLO i campi new_* che cambiano davvero; il resto resta com'è.`,
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string' },
                date: { type: 'string', description: 'Data della prenotazione ATTUALE, YYYY-MM-DD' },
                time: { type: 'string', description: 'Ora attuale, solo per distinguere fra più prenotazioni nello stesso giorno' },
                new_date: { type: 'string' },
                new_time: { type: 'string' },
                new_guests: { type: 'integer' },
                new_location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'] },
                new_notes: { type: 'string' },
            },
            required: ['phone', 'date'],
        },
    },
    {
        name: 'cancel_reservation',
        description: 'Annulla la prenotazione esistente.',
        input_schema: {
            type: 'object',
            properties: {
                phone: { type: 'string' },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time: { type: 'string', description: 'Solo per distinguere fra più prenotazioni nello stesso giorno' },
            },
            required: ['phone', 'date'],
        },
    },
]);

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const fmtDate = (d: Date | string | null | undefined): string => {
    if (!d) return '';
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: '2-digit', month: '2-digit',
        year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
};

function buildSystem(ctx: AgentContext): string {
    const oggi = new Date().toLocaleDateString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const iso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }); // YYYY-MM-DD
    const regole = ctx.knowledge.length
        ? ctx.knowledge.map(k => `- ${k.title}: ${k.content}`).join('\n')
        : '(nessuna regola inserita)';
    // I numeri della caparra vengono SEMPRE da qui, mai dalle regole scritte
    // a mano: sono la stessa fonte che alimenta la pagina di prenotazione.
    const caparra = describeDepositPolicy(ctx.depositPolicy);
    const pren = ctx.reservation
        ? [
            `- Cliente: ${ctx.reservation.customer_name || 'n/d'}`,
            `- Quando: ${fmtDate(ctx.reservation.reservation_time) || 'n/d'}`,
            `- Persone: ${ctx.reservation.guests ?? 'n/d'}`,
            ctx.reservation.room_name ? `- Sala: ${ctx.reservation.room_name}` : '',
            ctx.reservation.status ? `- Stato: ${ctx.reservation.status}` : '',
            ctx.reservation.notes ? `- Note: ${ctx.reservation.notes}` : '',
        ].filter(Boolean).join('\n')
        : '(nessuna prenotazione collegata a questo numero)';

    return `Sei l'addetto alle prenotazioni del ristorante "${ctx.restaurantName || 'il ristorante'}" e scrivi ai clienti su WhatsApp.

Oggi è ${oggi} (${iso}). Il pranzo è LUNCH, la cena è DINNER.
Il telefono di questo cliente è ${ctx.phone}: usalo come parametro "phone" degli strumenti, non chiederglielo.

REGOLE DELLA CASA (unica fonte di verità su cosa è permesso: non aggiungere nulla che non sia scritto qui):
${regole}

CAPARRA (dalle impostazioni del ristorante — questi numeri battono qualsiasi cosa dicano le regole qui sopra):
${caparra}

PRENOTAZIONE COLLEGATA A QUESTO NUMERO:
${pren}

QUANDO NON DEVI USARE GLI STRUMENTI — in questi casi rispondi al cliente che passi la richiesta a una persona:
- Gruppi di ${ctx.largeGroupThreshold + 1} persone o più (comprese le modifiche che portano il totale a ${ctx.largeGroupThreshold + 1} o più).
- Allergie, intolleranze, ingredienti, idoneità di un piatto: mai rispondere nel merito.
- Richieste che non riguardano una prenotazione (meteo, reclami, informazioni non coperte dalle regole).
- Quando ti mancano dati obbligatori: fai UNA domanda breve invece di inventarli.

COME SCRIVERE:
- Rispondi SEMPRE nella stessa lingua dell'ultimo messaggio del cliente: se scrive in inglese rispondi in inglese, se scrive in italiano rispondi in italiano (e così per altre lingue). In italiano dai del tu.
- Tono cordiale e diretto, da una a tre frasi.
- Niente formule da call center, niente firma finale.
- Non confermare MAI che una prenotazione è stata creata, modificata o annullata: quelle azioni le esegue una persona dopo di te. Di' che stai verificando o che confermi a breve.`;
}

/** Riga leggibile per lo staff. */
function riassumi(tool: string, args: Record<string, any>, ctx: AgentContext): string {
    const p = (k: string) => args[k];
    if (tool === 'cancel_reservation') {
        return `Annulla la prenotazione del ${p('date')}${p('time') ? ` alle ${p('time')}` : ''}`;
    }
    if (tool === 'create_reservation') {
        return `Crea prenotazione: ${p('customer_name')} · ${p('guests')} persone · ${p('date')} alle ${p('time')}` +
            (p('location_preference') ? ` · ${p('location_preference') === 'OUTDOOR' ? 'esterno' : 'interno'}` : '');
    }
    // modify: elenca solo ciò che cambia davvero
    const cambi: string[] = [];
    if (p('new_date')) cambi.push(`data → ${p('new_date')}`);
    if (p('new_time')) cambi.push(`ora → ${p('new_time')}`);
    if (p('new_guests') !== undefined) cambi.push(`persone: ${ctx.reservation?.guests ?? '?'} → ${p('new_guests')}`);
    if (p('new_location_preference')) cambi.push(`zona → ${p('new_location_preference') === 'OUTDOOR' ? 'esterno' : 'interno'}`);
    if (p('new_notes')) cambi.push(`note: ${String(p('new_notes')).slice(0, 40)}`);
    return `Modifica prenotazione del ${p('date')}: ${cambi.join(', ') || '(nessun cambiamento)'}`;
}

// ---------------------------------------------------------------------------
// Ciclo
// ---------------------------------------------------------------------------

export function isAgentConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

/** Il testo visibile della risposta, ignorando i blocchi di ragionamento. */
function testoDi(message: Anthropic.Message): string {
    return message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim()
        .replace(/^["'«]|["'»]$/g, '');
}

/** La prima chiamata a strumento, se c'è. */
function chiamataDi(message: Anthropic.Message): Anthropic.ToolUseBlock | null {
    return message.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use') ?? null;
}

export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new AgentError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (ctx.knowledge.length === 0) {
        throw new AgentError('Nessuna regola inserita: aggiungine almeno una in Impostazioni → Messaggi con AI', 'no_knowledge');
    }

    const client = new Anthropic({ apiKey });
    const tools = declarations(ctx.largeGroupThreshold);
    const system = buildSystem(ctx);
    const checks: AgentResult['checks'] = [];
    const usage: AgentUsage = { model: MODEL, promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
    const conta = (m: Anthropic.Message) => {
        usage.promptTokens += m.usage.input_tokens ?? 0;
        usage.outputTokens += m.usage.output_tokens ?? 0;
        usage.totalTokens = usage.promptTokens + usage.outputTokens;
        usage.calls += 1;
    };

    // La conversazione come storia di turni: il modello deve vedere chi ha
    // detto cosa, non un blocco di testo indistinto.
    const messages: Anthropic.MessageParam[] = ctx.messages
        .filter(m => (m.body || '').trim())
        .slice(-15)
        .map(m => ({
            role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.body.trim(),
        }));
    // La storia deve iniziare da un messaggio del cliente.
    while (messages.length && messages[0].role !== 'user') messages.shift();
    if (messages.length === 0) return { reply: null, proposal: null, checks, usage, reason: 'Nessun messaggio del cliente da interpretare' };

    const chiedi = (extra: Partial<Anthropic.MessageCreateParams> = {}) =>
        client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            output_config: { effort: SFORZO },
            system,
            messages,
            tools,
            ...extra,
        } as Anthropic.MessageCreateParamsNonStreaming);

    for (let giro = 0; giro < MAX_GIRI; giro++) {
        let response: Anthropic.Message;
        try {
            response = await chiedi();
            conta(response);
        } catch (err: any) {
            throw new AgentError(err?.message || 'Errore dal modello', 'upstream');
        }

        // I classificatori possono rifiutare: va guardato PRIMA di leggere il
        // contenuto, che in quel caso è vuoto o troncato.
        if (response.stop_reason === 'refusal') {
            return { reply: null, proposal: null, checks, usage, reason: 'Il modello ha rifiutato di rispondere a questo messaggio' };
        }

        const call = chiamataDi(response);
        if (!call) {
            const testo = testoDi(response);
            return { reply: testo || null, proposal: null, checks, usage, reason: testo ? undefined : 'Il modello non ha prodotto una risposta' };
        }

        const nome = call.name;
        const args = (call.input || {}) as Record<string, any>;

        // --- strumento che scrive: si ferma qui e propone -------------------
        if (STRUMENTI_DI_SCRITTURA.has(nome)) {
            const proposal: AgentProposal = {
                tool: nome,
                args: { ...args, phone: args.phone || ctx.phone },
                summary: riassumi(nome, args, ctx),
            };
            // Una riga da mandare al cliente che NON dia per fatta l'azione:
            // la esegue una persona, e potrebbe scartarla.
            let reply: string | null = null;
            let replyError: string | undefined;
            try {
                // Senza strumenti: qui vogliamo solo la frase, non un'altra chiamata.
                const r2 = await client.messages.create({
                    model: MODEL,
                    max_tokens: MAX_TOKEN,
                    output_config: { effort: SFORZO },
                    system,
                    messages: [
                        ...messages,
                        { role: 'assistant', content: `[richiesta compresa: ${proposal.summary}]` },
                        { role: 'user', content: 'Scrivi solo il messaggio da inviare al cliente: digli che stai verificando e che confermi a breve. Una o due frasi, senza dare per fatta la modifica.' },
                    ],
                });
                conta(r2);
                reply = r2.stop_reason === 'refusal' ? null : (testoDi(r2) || null);
            } catch (err: any) {
                // La proposta resta valida anche senza frase pronta: lo staff
                // scrive di suo. Ma il motivo va detto, non nascosto.
                replyError = err?.message || 'testo di attesa non generato';
            }
            return { reply, proposal, checks, usage, reason: replyError };
        }

        // --- sola lettura: si esegue davvero e si prosegue -------------------
        if (nome === 'check_availability') {
            const outcome = await bookingTools.checkAvailability(ctx.tenantId, args, WHATSAPP_CHANNEL);
            checks.push({ tool: nome, args, result: outcome.body });
            messages.push({ role: 'assistant', content: response.content });
            messages.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: call.id,
                    content: JSON.stringify(outcome.body),
                }],
            });
            continue;
        }

        // Strumento sconosciuto: non inventiamo, ci fermiamo.
        return { reply: null, proposal: null, checks, usage, reason: `Il modello ha chiesto uno strumento sconosciuto: ${nome}` };
    }

    return { reply: null, proposal: null, checks, usage, reason: 'Troppi passaggi senza arrivare a una risposta' };
}
