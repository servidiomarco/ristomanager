// Collega il prompt "Impostazioni > Prompt logica tavoli per AI" alla sala
// vera. Il testo lì dentro lo scrive il ristoratore e descrive le dinamiche
// MANUALI di oggi (quando unire tavoli, quando dividerli, come gestire
// gruppi grandi, come ottimizzare l'occupancy). Questo modulo non sostituisce
// quella logica: la legge, insieme allo stato reale del servizio, e PROPONE
// un'assegnazione — mai un'azione automatica silenziosa (card dev board #26).
//
// Stesso pattern di services/whatsappAgent.ts: uno strumento a scrittura
// forzata, mai eseguito qui dentro. Il chiamante salva la proposta e la
// esegue solo dopo un tocco dello staff.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const SFORZO = 'low' as const;
const MAX_TOKEN = 1024;

export interface TableInfo {
    id: number;
    name: string;
    seats: number;
    room_id: number;
    room_name: string;
}

export interface OccupancyRow {
    table_id: number;
    customer_name: string;
    guests: number;
    time: string;
}

export interface MergeRow {
    primary_id: number;
    merged_ids: number[];
}

export interface AssignmentContext {
    /** Testo scritto dal ristoratore in Impostazioni: unica fonte delle regole di casa. */
    prompt: string;
    reservation: {
        customer_name: string;
        guests: number;
        children: number;
        time: string;
        shift: 'LUNCH' | 'DINNER';
        notes?: string | null;
    };
    tables: TableInfo[];
    occupancy: OccupancyRow[];
    merges: MergeRow[];
}

export interface AssignmentProposal {
    tableId: number;
    mergeWithTableIds: number[];
    /** Riga leggibile per lo staff: perché questo tavolo, non solo quale. */
    summary: string;
}

export interface AssignmentUsage {
    model: string;
    promptTokens: number;
    outputTokens: number;
    totalTokens: number;
}

export interface AssignmentResult {
    proposal: AssignmentProposal | null;
    usage: AssignmentUsage | null;
    reason?: string;
}

export class TableAssignmentAgentError extends Error {
    constructor(message: string, public readonly kind: 'not_configured' | 'upstream') {
        super(message);
        this.name = 'TableAssignmentAgentError';
    }
}

export function isAgentConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

const declaration: Anthropic.Tool = {
    name: 'propose_table_assignment',
    description: 'Proponi il tavolo (ed eventuali tavoli da unire) per questa prenotazione. Chiamalo solo se ti senti ragionevolmente sicuro della scelta: se i dati non bastano, non chiamarlo.',
    input_schema: {
        type: 'object',
        properties: {
            table_id: { type: 'integer', description: "ID del tavolo principale a cui assegnare la prenotazione, dall'elenco fornito." },
            merge_with_table_ids: {
                type: 'array',
                items: { type: 'integer' },
                description: 'ID di eventuali altri tavoli da unire a table_id per questo servizio (vuoto se non serve unire nulla).',
            },
            summary: { type: 'string', description: 'Una riga in italiano per lo staff: quale tavolo (ed eventuale unione) e perché, in base alle regole della casa.' },
        },
        required: ['table_id', 'summary'],
    },
};

function buildSystem(ctx: AssignmentContext): string {
    const tableLines = ctx.tables
        .map(t => `- #${t.id} "${t.name}" · sala ${t.room_name} · ${t.seats} posti`)
        .join('\n') || '(nessun tavolo disponibile)';
    const mergeLines = ctx.merges.length
        ? ctx.merges.map(m => `- tavolo #${m.primary_id} unito con [${m.merged_ids.join(', ')}]`).join('\n')
        : '(nessuna unione attiva per questo servizio)';
    const occupancyLines = ctx.occupancy.length
        ? ctx.occupancy.map(o => `- tavolo #${o.table_id}: ${o.customer_name}, ${o.guests} persone, ore ${o.time}`).join('\n')
        : '(nessuna altra prenotazione con tavolo assegnato in questo servizio)';

    return `Sei l'addetto sala di un ristorante e devi proporre l'assegnazione del tavolo per una nuova prenotazione arrivata senza tavolo (dal sito, da WhatsApp o dall'agente telefonico).

REGOLE DELLA CASA (scritte dal gestore — unica fonte di verità su come si assegnano e si uniscono i tavoli qui):
${ctx.prompt}

PRENOTAZIONE DA ASSEGNARE:
- Cliente: ${ctx.reservation.customer_name}
- Persone: ${ctx.reservation.guests}${ctx.reservation.children ? ` (di cui ${ctx.reservation.children} bambini)` : ''}
- Turno: ${ctx.reservation.shift === 'LUNCH' ? 'pranzo' : 'cena'}, ore ${ctx.reservation.time}
${ctx.reservation.notes ? `- Note: ${ctx.reservation.notes}` : ''}

TAVOLI DISPONIBILI (capienza, non superarla senza unione):
${tableLines}

UNIONI GIÀ ATTIVE IN QUESTO SERVIZIO:
${mergeLines}

ALTRE PRENOTAZIONI GIÀ ASSEGNATE IN QUESTO SERVIZIO:
${occupancyLines}

Proponi UN tavolo (o un'unione di più tavoli se il gruppo non ci sta in uno solo) rispettando sempre la capienza reale. Se non riesci a proporre nulla di sensato con questi dati, non chiamare lo strumento e basta.`;
}

export async function suggestTableAssignment(ctx: AssignmentContext): Promise<AssignmentResult> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new TableAssignmentAgentError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (ctx.tables.length === 0) return { proposal: null, usage: null, reason: 'Nessun tavolo aperto per questo servizio' };

    const client = new Anthropic({ apiKey });
    const system = buildSystem(ctx);

    let response: Anthropic.Message;
    try {
        response = await client.messages.create({
            model: MODEL,
            max_tokens: MAX_TOKEN,
            output_config: { effort: SFORZO },
            system,
            messages: [{ role: 'user', content: 'Proponi l\'assegnazione tavolo per questa prenotazione.' }],
            tools: [declaration],
        } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (err: any) {
        throw new TableAssignmentAgentError(err?.message || 'Errore dal modello', 'upstream');
    }

    const usage: AssignmentUsage = {
        model: MODEL,
        promptTokens: response.usage.input_tokens ?? 0,
        outputTokens: response.usage.output_tokens ?? 0,
        totalTokens: (response.usage.input_tokens ?? 0) + (response.usage.output_tokens ?? 0),
    };

    if (response.stop_reason === 'refusal') {
        return { proposal: null, usage, reason: 'Il modello ha rifiutato la richiesta' };
    }

    const call = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!call) {
        return { proposal: null, usage, reason: 'Il modello non ha proposto un\'assegnazione' };
    }

    const args = (call.input || {}) as Record<string, any>;
    const tableId = Number(args.table_id);
    if (!Number.isFinite(tableId)) {
        return { proposal: null, usage, reason: 'Il modello ha proposto un tavolo non valido' };
    }
    const mergeWithTableIds = Array.isArray(args.merge_with_table_ids)
        ? args.merge_with_table_ids.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v) && v !== tableId)
        : [];
    const summary = typeof args.summary === 'string' && args.summary.trim() ? args.summary.trim() : `Tavolo #${tableId}`;

    return {
        proposal: { tableId, mergeWithTableIds, summary },
        usage,
    };
}
