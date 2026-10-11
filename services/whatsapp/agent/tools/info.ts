// get_restaurant_info: orari, chiusure, sale, menu, indicazioni, recapiti.
// Sola lettura, dai dati del CRM (services/restaurantInfo.ts).

import { restaurantInfo, INFO_TOPICS, type InfoTopic } from '../../../restaurantInfo.js';
import type { AgentTool } from './types.js';

export const restaurantInfoTool: AgentTool = {
    name: 'get_restaurant_info',
    kind: 'read',
    definition: () => ({
        name: 'get_restaurant_info',
        description: "Legge dal gestionale le informazioni sul locale: orari (hours), chiusure straordinarie (closures), sale aperte o chiuse (zones), link del menu (menu), indirizzo e mappa (directions), telefono e sito (contacts). Usalo invece di indovinare: se il cliente chiede «siete aperti?» o «l'esterno è aperto?», chiedi qui. Per un giorno preciso passa date e, per le sale, shift.",
        input_schema: {
            type: 'object',
            properties: {
                topic: { type: 'string', enum: [...INFO_TOPICS] },
                date: { type: 'string', description: 'YYYY-MM-DD, se la domanda riguarda un giorno preciso' },
                shift: { type: 'string', enum: ['LUNCH', 'DINNER'] },
            },
            required: ['topic'],
        },
    }),
    execute: async (args, ctx) => {
        const topic = INFO_TOPICS.includes(args.topic) ? args.topic as InfoTopic : 'hours';
        return restaurantInfo(ctx.tenantId, topic, { date: args.date, shift: args.shift });
    },
};
