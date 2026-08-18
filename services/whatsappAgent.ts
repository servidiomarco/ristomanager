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
// La prova tecnica del 2026-08-18 su 12 messaggi veri ha dato 11 scelte
// corrette su 12; soprattutto, il modello si ferma da solo dove deve —
// gruppi grandi, allergeni, richieste fuori tema, dati mancanti. Le stesse
// regole sono ripetute qui nel prompt perché è lì che vengono applicate.

import { GoogleGenAI, type FunctionDeclaration } from '@google/genai';
import * as bookingTools from './bookingTools.js';
import { WHATSAPP_CHANNEL } from './bookingTools.js';

const MODEL = 'gemini-3.5-flash';
const MAX_GIRI = 4;

/** Strumenti che scrivono: non si eseguono, si propongono. */
const STRUMENTI_DI_SCRITTURA = new Set(['create_reservation', 'modify_reservation', 'cancel_reservation']);

export interface AgentContext {
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
}

export interface AgentProposal {
    tool: string;
    args: Record<string, any>;
    /** Riga leggibile per lo staff: "Sposta da 20:30 a 21:00". */
    summary: string;
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

const declarations = (threshold: number): FunctionDeclaration[] => ([
    {
        name: 'check_availability',
        description: `Verifica se ci sono tavoli liberi. Usalo SEMPRE prima di dire al cliente che c'è posto: non confermare mai una disponibilità che non hai verificato con questo strumento.`,
        parameters: {
            type: 'object' as any,
            properties: {
                date: { type: 'string' as any, description: 'Data in formato YYYY-MM-DD' },
                shift: { type: 'string' as any, enum: ['LUNCH', 'DINNER'], description: 'LUNCH per pranzo, DINNER per cena' },
                guests: { type: 'integer' as any, description: 'Numero di persone' },
                location_preference: { type: 'string' as any, enum: ['INDOOR', 'OUTDOOR'], description: 'Solo se il cliente esprime una preferenza' },
            },
            required: ['date', 'shift', 'guests'],
        },
    },
    {
        name: 'create_reservation',
        description: `Crea una nuova prenotazione. Servono tutti: nome e cognome reali, telefono, data, ora, turno, numero di persone. Se ne manca anche uno solo NON usare questo strumento: chiedi al cliente il dato mancante.`,
        parameters: {
            type: 'object' as any,
            properties: {
                customer_name: { type: 'string' as any, description: 'Nome e cognome reali, mai segnaposto come "Cliente"' },
                phone: { type: 'string' as any },
                date: { type: 'string' as any, description: 'YYYY-MM-DD' },
                time: { type: 'string' as any, description: 'HH:MM' },
                shift: { type: 'string' as any, enum: ['LUNCH', 'DINNER'] },
                guests: { type: 'integer' as any },
                children: { type: 'integer' as any, description: 'Quanti dei coperti sono bambini' },
                location_preference: { type: 'string' as any, enum: ['INDOOR', 'OUTDOOR'] },
                notes: { type: 'string' as any, description: 'Richieste particolari del cliente' },
            },
            required: ['customer_name', 'phone', 'date', 'time', 'shift', 'guests'],
        },
    },
    {
        name: 'modify_reservation',
        description: `Modifica la prenotazione esistente. Passa SOLO i campi new_* che cambiano davvero; il resto resta com'è.`,
        parameters: {
            type: 'object' as any,
            properties: {
                phone: { type: 'string' as any },
                date: { type: 'string' as any, description: 'Data della prenotazione ATTUALE, YYYY-MM-DD' },
                time: { type: 'string' as any, description: 'Ora attuale, solo per distinguere fra più prenotazioni nello stesso giorno' },
                new_date: { type: 'string' as any },
                new_time: { type: 'string' as any },
                new_guests: { type: 'integer' as any },
                new_location_preference: { type: 'string' as any, enum: ['INDOOR', 'OUTDOOR'] },
                new_notes: { type: 'string' as any },
            },
            required: ['phone', 'date'],
        },
    },
    {
        name: 'cancel_reservation',
        description: 'Annulla la prenotazione esistente.',
        parameters: {
            type: 'object' as any,
            properties: {
                phone: { type: 'string' as any },
                date: { type: 'string' as any, description: 'YYYY-MM-DD' },
                time: { type: 'string' as any, description: 'Solo per distinguere fra più prenotazioni nello stesso giorno' },
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

    return `Sei l'addetto alle prenotazioni del ristorante "${ctx.restaurantName || 'Il Vecchio Frantoio'}" e scrivi ai clienti su WhatsApp.

Oggi è ${oggi} (${iso}). Il pranzo è LUNCH, la cena è DINNER.
Il telefono di questo cliente è ${ctx.phone}: usalo come parametro "phone" degli strumenti, non chiederglielo.

REGOLE DELLA CASA (unica fonte di verità su cosa è permesso: non aggiungere nulla che non sia scritto qui):
${regole}

PRENOTAZIONE COLLEGATA A QUESTO NUMERO:
${pren}

QUANDO NON DEVI USARE GLI STRUMENTI — in questi casi rispondi al cliente che passi la richiesta a una persona:
- Gruppi di ${ctx.largeGroupThreshold + 1} persone o più (comprese le modifiche che portano il totale a ${ctx.largeGroupThreshold + 1} o più).
- Allergie, intolleranze, ingredienti, idoneità di un piatto: mai rispondere nel merito.
- Richieste che non riguardano una prenotazione (meteo, reclami, informazioni non coperte dalle regole).
- Quando ti mancano dati obbligatori: fai UNA domanda breve invece di inventarli.

COME SCRIVERE:
- Italiano, dando del tu, tono cordiale e diretto, da una a tre frasi.
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

/**
 * Chiamata al modello con ritentativi sul 429.
 *
 * Non è prudenza generica: il piano gratuito di Gemini esaurisce la quota
 * dopo una richiesta e l'agente ne fa due o tre per messaggio. Senza attesa e
 * ritentativo, l'agente sembra "non avere niente da dire" mentre in realtà è
 * stato respinto — il modo peggiore di fallire, perché non lo si capisce.
 */
async function generaConRitentativi(ai: GoogleGenAI, richiesta: any): Promise<any> {
    let ultimo: any;
    for (let tentativo = 0; tentativo < 3; tentativo++) {
        try {
            return await ai.models.generateContent(richiesta);
        } catch (err: any) {
            ultimo = err;
            const msg = String(err?.message || '');
            if (!msg.includes('429') && !/RESOURCE_EXHAUSTED/i.test(msg)) throw err;
            if (tentativo < 2) await new Promise(r => setTimeout(r, 4000 * (tentativo + 1)));
        }
    }
    throw new AgentError(
        'Quota del modello esaurita: riprova fra qualche secondo, o attiva la fatturazione su Google AI Studio.',
        'upstream'
    );
}

export function isAgentConfigured(): boolean {
    return Boolean((process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim());
}

export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    if (!apiKey) throw new AgentError('GEMINI_API_KEY non configurata sul backend', 'not_configured');
    if (ctx.knowledge.length === 0) {
        throw new AgentError('Nessuna regola inserita: aggiungine almeno una in Impostazioni → Messaggi con AI', 'no_knowledge');
    }

    const ai = new GoogleGenAI({ apiKey });
    const tools = [{ functionDeclarations: declarations(ctx.largeGroupThreshold) }];
    const system = buildSystem(ctx);
    const checks: AgentResult['checks'] = [];

    // La conversazione come storia di turni: il modello deve vedere chi ha
    // detto cosa, non un blocco di testo indistinto.
    const contents: any[] = ctx.messages
        .filter(m => (m.body || '').trim())
        .slice(-15)
        .map(m => ({
            role: m.direction === 'inbound' ? 'user' : 'model',
            parts: [{ text: m.body.trim() }],
        }));
    // Gemini vuole che la storia inizi con l'utente.
    while (contents.length && contents[0].role !== 'user') contents.shift();
    if (contents.length === 0) return { reply: null, proposal: null, checks, reason: 'Nessun messaggio del cliente da interpretare' };

    for (let giro = 0; giro < MAX_GIRI; giro++) {
        let response: any;
        try {
            response = await generaConRitentativi(ai, {
                model: MODEL,
                contents,
                config: { tools, systemInstruction: system, temperature: 0 },
            });
        } catch (err: any) {
            if (err instanceof AgentError) throw err;
            throw new AgentError(err?.message || 'Errore dal modello', 'upstream');
        }

        const call = response.functionCalls?.[0];
        if (!call) {
            const testo = String(response.text || '').trim().replace(/^["'«]|["'»]$/g, '');
            return { reply: testo || null, proposal: null, checks, reason: testo ? undefined : 'Il modello non ha prodotto una risposta' };
        }

        const nome = String(call.name);
        const args = (call.args || {}) as Record<string, any>;

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
                const r2 = await generaConRitentativi(ai, {
                    model: MODEL,
                    contents: [
                        ...contents,
                        { role: 'model', parts: [{ text: `[richiesta compresa: ${proposal.summary}]` }] },
                        { role: 'user', parts: [{ text: 'Scrivi solo il messaggio da inviare al cliente: digli che stai verificando e che confermi a breve. Una o due frasi, senza dare per fatta la modifica.' }] },
                    ],
                    config: { systemInstruction: system, temperature: 0 },
                });
                reply = String(r2.text || '').trim().replace(/^["'«]|["'»]$/g, '') || null;
            } catch (err: any) {
                // La proposta resta valida anche senza frase pronta: lo staff
                // scrive di suo. Ma il motivo va detto, non nascosto.
                replyError = err?.message || 'testo di attesa non generato';
            }
            return { reply, proposal, checks, reason: replyError };
        }

        // --- sola lettura: si esegue davvero e si prosegue -------------------
        if (nome === 'check_availability') {
            const outcome = await bookingTools.checkAvailability(args, WHATSAPP_CHANNEL);
            checks.push({ tool: nome, args, result: outcome.body });
            contents.push({ role: 'model', parts: [{ functionCall: { name: nome, args } }] });
            contents.push({ role: 'user', parts: [{ functionResponse: { name: nome, response: outcome.body } }] });
            continue;
        }

        // Strumento sconosciuto: non inventiamo, ci fermiamo.
        return { reply: null, proposal: null, checks, reason: `Il modello ha chiesto uno strumento sconosciuto: ${nome}` };
    }

    return { reply: null, proposal: null, checks, reason: 'Troppi passaggi senza arrivare a una risposta' };
}
