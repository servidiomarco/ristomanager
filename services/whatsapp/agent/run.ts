// L'agente che legge i messaggi WhatsApp e risponde.
//
// Ogni strumento dichiara se legge, scrive o governa il giro, e il ciclo
// decide chiamata per chiamata:
//
//   letture (check_availability)        → eseguite subito
//   scritture (crea/sposta/annulla)     → PROPOSTA che lo staff conferma,
//                                         o eseguite da sole in modalità
//                                         «Azioni» se l'idoneità passa
//   skip_reply                          → il giro finisce senza risposta
//
// Le scritture si eseguono da sole solo dove i controlli d'idoneità lo
// permettono (autonomy.ts): un errore su una lettura si legge e si scarta,
// un errore su una scrittura è un tavolo fantasma o una prenotazione
// cancellata a un cliente che si presenta. Ogni scrittura eseguita da sola
// esce di qui con la prenotazione prima e dopo, per il tasto «Annulla».
//
// Il modello riceve l'esito vero di ogni chiamata (tool_result) e scrive
// lui la frase finale: dice «fatto» solo davanti a executed: true, «confermo
// a breve» davanti a una proposta. Prima si fermava alla prima chiamata e
// una seconda richiesta al modello scriveva la frase d'attesa.
//
// Il modello è Claude. La prova tecnica del 2026-08-18 era stata fatta su
// Gemini (11 scelte corrette su 12) ma quel piano si esaurisce dopo una
// manciata di richieste al giorno, e un agente che si ferma al quinto cliente
// della serata non è un agente.

import Anthropic from '@anthropic-ai/sdk';
import { buildSystem } from './prompt.js';
import { AGENT_TOOLS, defaultDecision, findTool, toolDefinitions, type ToolDecision } from './tools/index.js';
import { clearPendingConfirmation, modifyArgsForAuto, snapshotReservation } from './autonomy.js';
import { AgentError, type AgentAction, type AgentContext, type AgentProposal, type AgentResult, type AgentUsage } from './types.js';

export const MODEL = 'claude-opus-5';
// Più strumenti per risposta e un giro per ogni esito: verifica, proposta,
// frase finale stanno comodi in tre; sei lasciano margine a una domanda in più.
const MAX_GIRI = 6;

// Il ragionamento resta ACCESO. Non è un vezzo: con il ragionamento spento il
// modello può scrivere la chiamata a uno strumento dentro il testo visibile
// invece di emetterla davvero — il turno riesce, la chiamata non parte, e
// nessuno se ne accorge. Per contenere costo e attesa si abbassa lo sforzo,
// non si spegne il ragionamento.
const SFORZO = 'low' as const;

// Il ragionamento consuma dallo stesso budget della risposta: stretto qui
// significa risposte troncate a metà.
const MAX_TOKEN = 4096;

// Se un classificatore rifiuta la richiesta, il server la rifà sul modello
// di ripiego che sceglie lui per quella categoria.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01' as const;

export function isAgentConfigured(): boolean {
    return Boolean((process.env.ANTHROPIC_API_KEY || '').trim());
}

/** Il testo visibile della risposta, ignorando i blocchi di ragionamento. */
export function textOf(message: Anthropic.Beta.BetaMessage): string {
    return message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim()
        .replace(/^["'«]|["'»]$/g, '');
}

/**
 * Il contenuto di una risposta da rimandare al modello nel giro dopo. Se il
 * server è passato al modello di ripiego, prima dell'ultimo blocco
 * `fallback` restano solo i testi (ragionamento e chiamate del modello che
 * ha rifiutato non valgono più); il segnaposto stesso non serve.
 */
export function echoable(content: Anthropic.Beta.BetaContentBlock[]): Anthropic.Beta.BetaContentBlockParam[] {
    const last = content.map(b => b.type).lastIndexOf('fallback');
    return content.filter((b, i) => b.type !== 'fallback' && (i > last || b.type === 'text')) as Anthropic.Beta.BetaContentBlockParam[];
}

/** La conversazione come storia di turni: il modello deve vedere chi ha
 *  detto cosa, non un blocco di testo indistinto. */
export function historyOf(messages: AgentContext['messages']): Anthropic.Beta.BetaMessageParam[] {
    const out: Anthropic.Beta.BetaMessageParam[] = messages
        .filter(m => (m.body || '').trim())
        .slice(-15)
        .map(m => ({
            role: (m.direction === 'inbound' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.body.trim(),
        }));
    // La storia deve iniziare E finire con un messaggio del cliente: il modello
    // rifiuta un prefill dell'assistant come ultimo turno ("The conversation
    // must end with a user message", 400). Quando lo staff ha già risposto per
    // ultimo si tolgono le code assistant, così si ragiona sull'ultima richiesta
    // del cliente.
    while (out.length && out[0].role !== 'user') out.shift();
    while (out.length && out[out.length - 1].role !== 'user') out.pop();
    return out;
}

const result = (content: Record<string, any>) => JSON.stringify(content);

export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (!apiKey) throw new AgentError('ANTHROPIC_API_KEY non configurata sul backend', 'not_configured');
    if (ctx.knowledge.length === 0) {
        throw new AgentError('Nessuna regola inserita: aggiungine almeno una in Impostazioni → WhatsApp → Messaggi con AI', 'no_knowledge');
    }

    const client = new Anthropic({ apiKey });
    const tools = toolDefinitions(ctx);
    const system = buildSystem(ctx);
    const checks: AgentResult['checks'] = [];
    const proposals: AgentProposal[] = [];
    const actions: AgentAction[] = [];
    const usage: AgentUsage = { model: MODEL, promptTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
    const conta = (m: Anthropic.Beta.BetaMessage) => {
        usage.promptTokens += m.usage.input_tokens ?? 0;
        usage.outputTokens += m.usage.output_tokens ?? 0;
        usage.totalTokens = usage.promptTokens + usage.outputTokens;
        usage.calls += 1;
    };
    const fine = (extra: Partial<AgentResult>): AgentResult => ({ reply: null, proposals, actions, checks, usage, ...extra });

    const messages = historyOf(ctx.messages);
    if (messages.length === 0) return fine({ reason: 'Nessun messaggio del cliente da interpretare' });

    for (let giro = 0; giro < MAX_GIRI; giro++) {
        let response: Anthropic.Beta.BetaMessage;
        try {
            response = await client.beta.messages.create({
                model: MODEL,
                max_tokens: MAX_TOKEN,
                betas: [FALLBACK_BETA],
                fallbacks: 'default',
                output_config: { effort: SFORZO },
                system,
                messages,
                tools,
            });
            conta(response);
        } catch (err: any) {
            throw new AgentError(err?.message || 'Errore dal modello', 'upstream');
        }

        // I classificatori possono rifiutare (anche il modello di ripiego):
        // va guardato PRIMA di leggere il contenuto, che è vuoto o troncato.
        if (response.stop_reason === 'refusal') {
            return fine({ reason: 'Il modello ha rifiutato di rispondere a questo messaggio' });
        }
        // Una risposta tagliata può contenere una chiamata a metà: meglio
        // nessuna risposta che un'azione con argomenti monchi.
        if (response.stop_reason === 'max_tokens') {
            return fine({ reason: 'Risposta del modello troncata' });
        }

        const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        if (uses.length === 0) {
            const testo = textOf(response);
            return fine({ reply: testo || null, reason: testo ? undefined : 'Il modello non ha prodotto una risposta' });
        }

        messages.push({ role: 'assistant', content: echoable(response.content) });
        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        let skipped: string | undefined;

        for (const use of uses) {
            const tool = findTool(use.name);
            const raw = (use.input && typeof use.input === 'object' ? use.input : {}) as Record<string, any>;
            if (!tool) {
                results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: result({ error: `Strumento sconosciuto: ${use.name}` }) });
                continue;
            }
            if (tool.kind === 'control') {
                skipped = String(raw.reason || 'senza motivo');
                results.push({ type: 'tool_result', tool_use_id: use.id, content: result({ ok: true }) });
                continue;
            }

            let args = tool.prepareArgs ? tool.prepareArgs(raw, ctx) : raw;
            let decision: ToolDecision;
            try {
                decision = tool.decide ? await tool.decide(args, ctx, { proposals: proposals.length, actions: actions.length }) : defaultDecision(tool);
            } catch (err: any) {
                // Un controllo d'idoneità che non riesce a leggere il dato
                // non autorizza niente: si torna alla proposta.
                console.warn(`[agent] decisione su ${tool.name} non riuscita:`, err?.message || err);
                decision = tool.kind === 'write' ? { kind: 'propose' } : { kind: 'refuse', reason: 'Errore tecnico' };
            }
            const scrive = decision.kind === 'propose' || (decision.kind === 'execute' && decision.auto);
            if (scrive && proposals.length + actions.length >= 1) {
                decision = { kind: 'refuse', reason: 'Una sola modifica alle prenotazioni per risposta: questa va chiesta dopo che la prima è fatta o confermata.' };
            }

            if (decision.kind === 'execute' && decision.auto && tool.execute) {
                // Eseguita da sola: la prenotazione esatta, la fotografia
                // prima e dopo, e niente scrittura nel simulatore.
                const reservationId = decision.auto.reservationId;
                if (reservationId != null) {
                    args = tool.name === 'modify_reservation'
                        ? await modifyArgsForAuto(args, ctx, reservationId)
                        : { ...args, reservation_id: reservationId };
                }
                const summary = tool.summarize ? tool.summarize(args, ctx) : tool.name;
                if (ctx.dryRun) {
                    actions.push({ tool: tool.name, args, summary, result: {}, reservationId, before: null, after: null, simulated: true });
                    results.push({
                        type: 'tool_result', tool_use_id: use.id,
                        content: result({ success: true, executed: true, simulated: true, message: 'Fatto (simulazione: nel locale vero sarebbe eseguito ora).' }),
                    });
                    continue;
                }
                try {
                    const before = await snapshotReservation(ctx.tenantId, reservationId);
                    const body = await tool.execute(args, { tenantId: ctx.tenantId, phone: ctx.phone, phoneDigits: ctx.phoneDigits, auto: true });
                    const ok = body?.success === true;
                    if (ok) {
                        const after = await snapshotReservation(ctx.tenantId, Number(body.reservation_id) || reservationId);
                        actions.push({ tool: tool.name, args, summary, result: body, reservationId: after?.id ?? reservationId, before, after });
                        if (tool.name === 'cancel_reservation') await clearPendingConfirmation(ctx);
                    }
                    checks.push({ tool: tool.name, args, result: body });
                    results.push({ type: 'tool_result', tool_use_id: use.id, content: result({ ...body, executed: ok }) });
                } catch (err: any) {
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: result({ error: err?.message || 'Errore dello strumento', executed: false }) });
                }
            } else if (decision.kind === 'execute' && tool.execute && ctx.dryRun && tool.kind === 'write') {
                // Simulatore: un ritardo, una conferma, una richiamata non
                // si scrivono per il cliente finto.
                results.push({
                    type: 'tool_result', tool_use_id: use.id,
                    content: result({ success: true, executed: true, simulated: true, message: 'Fatto (simulazione).' }),
                });
            } else if (decision.kind === 'execute' && tool.execute) {
                try {
                    const body = await tool.execute(args, ctx);
                    checks.push({ tool: tool.name, args, result: body });
                    results.push({ type: 'tool_result', tool_use_id: use.id, content: result({ ...body, executed: true }) });
                } catch (err: any) {
                    results.push({ type: 'tool_result', tool_use_id: use.id, is_error: true, content: result({ error: err?.message || 'Errore dello strumento' }) });
                }
            } else if (decision.kind === 'propose' || (decision.kind === 'execute' && !tool.execute)) {
                proposals.push({ tool: tool.name, args, summary: tool.summarize ? tool.summarize(args, ctx) : tool.name });
                results.push({
                    type: 'tool_result', tool_use_id: use.id,
                    content: result({ status: 'pending_staff', executed: false, message: 'Registrato per il ristorante, che conferma a breve. Non dire al cliente che è fatto.' }),
                });
            } else if (decision.kind === 'ask') {
                results.push({
                    type: 'tool_result', tool_use_id: use.id,
                    content: result({ status: 'confirm_with_customer', executed: false, message: decision.message }),
                });
            } else {
                results.push({
                    type: 'tool_result', tool_use_id: use.id,
                    content: result({ status: 'refused', executed: false, message: decision.kind === 'refuse' ? decision.reason : 'Non eseguibile' }),
                });
            }
        }

        // Il cliente non vuole risposta: niente altre chiamate al modello.
        if (skipped) return fine({ skipped });

        // Tutti gli esiti in UN messaggio: dividerli insegna al modello a non
        // fare più chiamate in parallelo.
        messages.push({ role: 'user', content: results });
    }

    return fine({ reason: 'Troppi passaggi senza arrivare a una risposta' });
}

/** Gli strumenti dichiarati, per chi deve sapere quali scrivono. */
export const WRITE_TOOLS = new Set(AGENT_TOOLS.filter(t => t.kind === 'write').map(t => t.name));
