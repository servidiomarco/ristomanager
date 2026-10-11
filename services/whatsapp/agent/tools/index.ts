// Il registro degli strumenti dell'agente WhatsApp. Uno strumento nuovo è
// un file in questa cartella e una riga qui.

import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../types.js';
import type { AgentTool } from './types.js';
import { checkAvailabilityTool, createReservationTool, modifyReservationTool, cancelReservationTool } from './booking.js';
import { skipReplyTool } from './skip.js';
import { restaurantInfoTool } from './info.js';
import { requestCallbackTool } from './callback.js';
import { lateArrivalTool, reservationNoteTool, allergyTool, attendanceTool } from './guest.js';
import { takeawayMenuTool, takeawaySlotsTool, takeawayOrderTool } from './takeaway.js';

export const AGENT_TOOLS: readonly AgentTool[] = [
    checkAvailabilityTool,
    createReservationTool,
    modifyReservationTool,
    cancelReservationTool,
    restaurantInfoTool,
    requestCallbackTool,
    lateArrivalTool,
    reservationNoteTool,
    allergyTool,
    attendanceTool,
    takeawayMenuTool,
    takeawaySlotsTool,
    takeawayOrderTool,
    skipReplyTool,
];

const BY_NAME = new Map(AGENT_TOOLS.map(t => [t.name, t]));

export const findTool = (name: string): AgentTool | undefined => BY_NAME.get(name);

export const isToolAvailable = (tool: AgentTool, ctx: AgentContext): boolean => !tool.available || tool.available(ctx);

export const toolDefinitions = (ctx: AgentContext): Anthropic.Beta.BetaTool[] =>
    AGENT_TOOLS.filter(t => isToolAvailable(t, ctx)).map(t => t.definition(ctx));

export type { AgentTool, ToolDecision, ToolKind, TurnState, ToolRun } from './types.js';
export { defaultDecision } from './types.js';
