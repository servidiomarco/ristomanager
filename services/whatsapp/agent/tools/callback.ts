// request_callback: lo staff richiama il cliente.
//
// Per i gruppi oltre la soglia, i banchetti e i menù da concordare (un
// gruppo da 21 «col menù da definire», settembre 2026) l'agente diceva solo
// «passo la richiesta a una persona», e la richiesta restava una riga in
// chat. Ora diventa un promemoria in Chiamate › Da ricontattare, con la push,
// come quelli che lascia Sofia.

import * as bookingTools from '../../../bookingTools.js';
import { WHATSAPP_CHANNEL } from '../../../bookingTools.js';
import type { AgentTool } from './types.js';

export const requestCallbackTool: AgentTool = {
    name: 'request_callback',
    // Scrive (un promemoria e una push), ma non tocca le prenotazioni: si
    // esegue subito anche quando le prenotazioni restano proposte.
    kind: 'write',
    decide: () => ({ kind: 'execute' }),
    definition: ctx => ({
        name: 'request_callback',
        description: `Chiede allo staff di richiamare il cliente. Usalo per gruppi di ${ctx.largeGroupThreshold + 1} persone o più, banchetti, eventi, menù da concordare e richieste che solo una persona può decidere. Poi di' al cliente che verrà richiamato.`,
        input_schema: {
            type: 'object',
            properties: {
                reason: { type: 'string', description: 'Il motivo in una frase, es. "gruppo da 21, menù da definire"' },
                customer_name: { type: 'string', description: 'Il nome, se il cliente lo ha detto' },
                requested_date: { type: 'string', description: 'YYYY-MM-DD, se c\'è' },
                requested_time: { type: 'string', description: 'HH:MM, se c\'è' },
                guests: { type: 'integer' },
                notes: { type: 'string' },
            },
            required: ['reason'],
        },
    }),
    // Un promemoria al giorno per numero: se il cliente scrive tre volte, la
    // richiesta si aggiorna invece di moltiplicarsi.
    prepareArgs: (args, ctx) => ({
        ...args,
        phone: ctx.phone,
        conversation_id: `wa-cb-${ctx.tenantId}-${ctx.phoneDigits}-${new Date().toISOString().slice(0, 10)}`,
    }),
    execute: async (args, ctx) => (await bookingTools.saveCallbackRequest(ctx.tenantId, args, WHATSAPP_CHANNEL)).body,
};
