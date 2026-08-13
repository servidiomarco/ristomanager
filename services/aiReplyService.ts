// Risposte suggerite ai messaggi dei clienti.
//
// Il modello NON invia mai nulla da solo: propone una frase che il cameriere
// legge, corregge se serve e spedisce con un tocco. È una scelta di progetto,
// non una limitazione temporanea — su WhatsApp il rapporto col cliente è
// personale, e una risposta sbagliata mandata in automatico costa più di dieci
// risposte lente.
//
// Il contesto che riceve è tutto qui: gli ultimi messaggi della conversazione,
// la prenotazione collegata (se c'è) e le regole della casa scritte dal
// gestore. Nient'altro: nessun dato di altri clienti, nessuno storico di
// prenotazioni altrui.
//
// La chiave sta sul backend (GEMINI_API_KEY su Railway) e non viene mai
// esposta al browser — a differenza del vecchio report della dashboard, che
// girava lato client con la chiave iniettata nel bundle.

import { GoogleGenAI } from '@google/genai';

const MODEL = 'gemini-2.5-flash';

export interface AiReplyContext {
    /** Messaggi della conversazione, dal più vecchio al più recente. */
    messages: Array<{ direction: 'inbound' | 'outbound'; body: string; sent_at: Date | string }>;
    /** Prenotazione collegata al numero, se esiste. */
    reservation?: {
        customer_name?: string | null;
        reservation_time?: Date | string | null;
        guests?: number | null;
        room_name?: string | null;
        notes?: string | null;
        status?: string | null;
    } | null;
    /** Regole della casa attive, in ordine. */
    knowledge: Array<{ title: string; content: string }>;
    /** Nome del ristorante per la firma. */
    restaurantName?: string;
}

export class AiReplyError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'no_knowledge' | 'upstream') {
        super(message);
        this.name = 'AiReplyError';
    }
}

export function isAiConfigured(): boolean {
    return Boolean((process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim());
}

const fmtDate = (d: Date | string | null | undefined): string => {
    if (!d) return '';
    const dt = typeof d === 'string' ? new Date(d) : d;
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: '2-digit',
        month: '2-digit', hour: '2-digit', minute: '2-digit',
    });
};

function buildPrompt(ctx: AiReplyContext): string {
    const nome = ctx.restaurantName || 'Il Vecchio Frantoio';
    const regole = ctx.knowledge.length > 0
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

    const conversazione = ctx.messages
        .map(m => `${m.direction === 'inbound' ? 'CLIENTE' : 'RISTORANTE'}: ${String(m.body || '').replace(/\s+/g, ' ').trim()}`)
        .filter(l => l.length > 10)
        .slice(-15)
        .join('\n');

    // Le istruzioni ripetono due volte il divieto di inventare perché è il
    // fallimento che costa di più: una risposta sicura di sé su un orario o
    // una disponibilità sbagliata manda un cliente davanti a una porta chiusa.
    return `Sei l'addetto alle prenotazioni del ristorante "${nome}" e scrivi ai clienti su WhatsApp.

REGOLE DELLA CASA (l'unica fonte di verità: non aggiungere nulla che non sia scritto qui):
${regole}

PRENOTAZIONE COLLEGATA A QUESTO NUMERO:
${pren}

CONVERSAZIONE (dal più vecchio al più recente):
${conversazione}

COMPITO: scrivi la prossima risposta del RISTORANTE all'ultimo messaggio del cliente.

COME SCRIVERE:
- In italiano, dando del tu, tono cordiale e diretto come si scrive su WhatsApp.
- Da una a tre frasi. Niente formule da call center, niente "gentile cliente", niente firma finale.
- Vai dritto al punto: il cliente sta guardando il telefono, non legge paragrafi.

COSA NON FARE MAI:
- Non inventare orari, prezzi, disponibilità di tavoli o regole che non siano nelle REGOLE DELLA CASA o nella PRENOTAZIONE qui sopra.
- Non confermare la disponibilità di un tavolo, di una data o di un orario: quella la verifica una persona.
- Non dare informazioni su allergeni, ingredienti o idoneità di un piatto per allergie o intolleranze.
- Non promettere nulla che non sia già scritto sopra.

SE NON SAI RISPONDERE (l'informazione non è nelle regole, oppure serve una verifica umana come disponibilità, allergeni, conti):
rispondi esattamente con: NON_SO

Scrivi solo il testo del messaggio da inviare, senza virgolette e senza spiegazioni.`;
}

/**
 * Genera la risposta suggerita. Ritorna null quando il modello dichiara di non
 * sapere: meglio nessun suggerimento che uno inventato, e il cameriere scrive
 * di suo come farebbe comunque oggi.
 */
export async function generateSuggestedReply(ctx: AiReplyContext): Promise<string | null> {
    const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
    if (!apiKey) {
        throw new AiReplyError('GEMINI_API_KEY non configurata sul backend', 'not_configured');
    }
    if (ctx.knowledge.length === 0) {
        throw new AiReplyError(
            'Nessuna regola inserita: aggiungine almeno una in Impostazioni → Messaggi con AI',
            'no_knowledge'
        );
    }

    try {
        const ai = new GoogleGenAI({ apiKey });
        const response = await ai.models.generateContent({
            model: MODEL,
            contents: buildPrompt(ctx),
        });
        const text = String(response.text || '').trim();
        if (!text || /^NON_SO\b/i.test(text)) return null;
        // Il modello ogni tanto incornicia la frase fra virgolette nonostante
        // le istruzioni: toglierle qui evita che finiscano nel messaggio.
        return text.replace(/^["'«]|["'»]$/g, '').trim() || null;
    } catch (err: any) {
        throw new AiReplyError(err?.message || 'Errore dal modello', 'upstream');
    }
}
