// skip_reply: il messaggio del cliente non vuole risposta.
//
// Un «Grazie 👍» dopo la conferma non va ringraziato a sua volta, e un
// risponditore automatico di un'altra azienda («Grazie per aver contattato
// GELATO LAB», arrivato al Frantoio il 20/09/2026) non va mai inseguito: due
// bot che si rispondono non si fermano più.

import type { AgentTool } from './types.js';

export const SKIP_REASONS = ['ringraziamento', 'conferma_ricevuta', 'risponditore_automatico', 'gia_risposto'] as const;

export const skipReplyTool: AgentTool = {
    name: 'skip_reply',
    kind: 'control',
    definition: () => ({
        name: 'skip_reply',
        description: "Usalo invece di scrivere quando l'ultimo messaggio del cliente non chiede niente: un grazie, un ok o un'emoji dopo una conferma, un messaggio a cui hai già risposto, o un risponditore automatico di un'altra azienda.",
        input_schema: {
            type: 'object',
            properties: {
                reason: { type: 'string', enum: [...SKIP_REASONS] },
            },
            required: ['reason'],
        },
    }),
};
