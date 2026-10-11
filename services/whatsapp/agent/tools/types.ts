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
    | { kind: 'execute' }
    | { kind: 'propose' }
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
}

/** Lo stato del giro che una decisione può guardare. */
export interface TurnState {
    /** Proposte già raccolte in questo giro. */
    proposals: number;
}

export interface AgentTool {
    name: string;
    kind: ToolKind;
    definition: (ctx: AgentContext) => Anthropic.Beta.BetaTool;
    /** Di serie: le letture si eseguono, le scritture si propongono. */
    decide?: (args: Record<string, any>, ctx: AgentContext, turn: TurnState) => ToolDecision;
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
