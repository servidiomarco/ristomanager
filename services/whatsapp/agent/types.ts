// I tipi dell'agente WhatsApp.

import type { DepositPolicy } from '../../depositPolicy.js';
import type { AiCustomerProfile } from '../../aiCustomerContext.js';

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
        table_name?: string | null;
        notes?: string | null;
        status?: string | null;
    } | null;
    /** Le prenotazioni ancora in agenda di questo numero, una per riga
     *  (bookingTools.upcomingBookingsForPrompt), o 'nessuna'. */
    upcomingBookings?: string;
    /** La scheda in rubrica di questo numero (null se non c'è). */
    customer?: AiCustomerProfile | null;
    /** Il nome del profilo WhatsApp del cliente: un suggerimento, mai un
     *  nome da usare senza che il cliente lo confermi. */
    profileName?: string | null;
    /** Numero di telefono in formato leggibile, per i parametri degli strumenti. */
    phone: string;
    /** Il catalogo allergeni del locale (le pillole del modulo prenotazione). */
    allergenPresets?: string[];
    /** Le note rapide del locale; quelle con quantità sono piatti da
     *  preparare in anticipo che la cucina somma (lo stinco). */
    notePresets?: Array<{ label: string; has_quantity: boolean; variants: string[] }>;
    knowledge: Array<{ title: string; content: string }>;
    /** Fuso del locale: è l'orologio su cui il modello risolve «domani» e
     *  «venerdì». A Roma per difetto — un default sbagliato qui fa
     *  prenotare il giorno prima. */
    timezone?: string;
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
    /** Quante volte si è interrogato il modello in questo giro. */
    calls: number;
}

export interface AgentResult {
    /** Testo proposto per il cliente; null se non c'è niente da dire. */
    reply: string | null;
    /** Azioni che l'agente eseguirebbe, in attesa di conferma umana. Al più
     *  una per giro: due scritture insieme (annulla e ricrea) le decide una
     *  persona, una alla volta. */
    proposals: AgentProposal[];
    /** Letture fatte davvero (disponibilità…), per trasparenza. */
    checks: Array<{ tool: string; args: Record<string, any>; result: any }>;
    /** Il messaggio del cliente non vuole risposta (un grazie, un ok, un
     *  risponditore automatico): il motivo che il modello ha dato. */
    skipped?: string;
    /** Perché non c'è una risposta, quando capita. */
    reason?: string;
    /** Consumo dell'intero giro, sommato su TUTTE le chiamate al modello. */
    usage: AgentUsage;
}

export class AgentError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'no_knowledge' | 'upstream') {
        super(message);
        this.name = 'AgentError';
    }
}
