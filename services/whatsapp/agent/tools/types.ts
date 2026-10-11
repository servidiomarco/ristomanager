// Il contratto di uno strumento dell'agente WhatsApp.
//
// Ogni strumento dichiara cosa fa (legge, scrive, o governa il giro) e il
// ciclo decide per ciascuna chiamata se eseguirla, proporla allo staff o
// rifiutarla. Uno strumento nuovo è un file in questa cartella più una riga
// nel registro (index.ts): il ciclo non cambia.

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../types.js';

export type ToolKind = 'read' | 'write' | 'control';

export type ToolDecision =
    /** `auto`: una scrittura che l'agente esegue da solo (modalità «Azioni»)
     *  sulla prenotazione indicata; va nel registro con il prima e il dopo. */
    | { kind: 'execute'; auto?: { reservationId: number | null } }
    | { kind: 'propose' }
    /** Prima di eseguire serve una risposta del cliente (l'annullo da
     *  confermare): il modello la chiede, il giro dopo esegue. */
    | { kind: 'ask'; message: string }
    | { kind: 'refuse'; reason: string };

/** Quello che serve a eseguire uno strumento: il ristorante e il cliente
 *  della conversazione. Il contesto dell'agente lo contiene; la conferma di
 *  una proposta dallo staff ne costruisce uno da sé. */
export interface ToolRun {
    tenantId: number;
    phone: string;
    phoneDigits: string;
    /** La proposta l'ha letta e confermata una persona: i controlli che
     *  chiederebbero al cliente (nome diverso dalla rubrica, prenotazione già
     *  in agenda) li ha già fatti lei. */
    approvedByStaff?: boolean;
    /** Eseguita dall'agente da solo: le push lo dicono. */
    auto?: boolean;
}

/** Lo stato del giro che una decisione può guardare. */
export interface TurnState {
    /** Proposte già raccolte in questo giro. */
    proposals: number;
    /** Scritture già eseguite da sole in questo giro. */
    actions: number;
}

export interface AgentTool {
    name: string;
    kind: ToolKind;
    definition: (ctx: AgentContext) => Anthropic.Beta.BetaTool;
    /** Di serie: le letture si eseguono, le scritture si propongono. Può
     *  leggere il database (l'idoneità di un'azione automatica). */
    decide?: (args: Record<string, any>, ctx: AgentContext, turn: TurnState) => ToolDecision | Promise<ToolDecision>;
    /** Gli argomenti come li vuole lo strumento: il telefono è sempre quello
     *  della conversazione, mai quello che il modello crede di aver letto. */
    prepareArgs?: (args: Record<string, any>, ctx: AgentContext) => Record<string, any>;
    /** L'esecuzione vera: subito per le letture, dalla conferma dello staff
     *  per le proposte. Restituisce il corpo per il modello (success, …). */
    execute?: (args: Record<string, any>, run: ToolRun) => Promise<Record<string, any>>;
    /** La riga che lo staff legge sulla proposta. */
    summarize?: (args: Record<string, any>, ctx: AgentContext) => string;
}

export const defaultDecision = (tool: AgentTool): ToolDecision =>
    tool.kind === 'write' ? { kind: 'propose' } : { kind: 'execute' };
