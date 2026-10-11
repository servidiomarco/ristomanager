// L'asporto in chat: menu, orari di ritiro, ordine. Ci sono solo se il
// locale ha l'add-on asporto e ha acceso «Asporto in chat» (ctx.takeaway).
//
// L'ordine si fa come al telefono con Sofia (services/takeaway.ts): i piatti
// scritti dal cliente si abbinano al menu Alla carta, l'orario dev'essere
// nella griglia, libero e abbastanza lontano per la cucina. In modalità
// «Azioni» l'agente lo registra da solo quando tutto torna; altrimenti lo
// propone allo staff.

import { queryWithRetry } from '../../../../db.js';
import { isoDatesToEuropean } from '../../../../utils/text.js';
import { getTenantLocale } from '../../../tenantLocale.js';
import { parseFlexibleDate, parseFlexibleTime } from '../../../elevenlabsService.js';
import { sendToRoles as pushSendToRoles } from '../../../pushService.js';
import {
    buildTakeawayItems, createTakeawayOrder, filterOrderableSlots, freeTakeawaySlots, getTakeawaySettings,
    loadTakeawayView, loadVoiceCatalogue, matchVoiceDish, normalizeDishText, takeawayDateReadback, validateTakeawaySlot,
} from '../../../takeaway.js';
import { getDatePartInTz } from '../../../../utils/reservationTime.js';
import { whatsappDeps } from '../../deps.js';
import type { AgentContext } from '../types.js';
import type { AgentTool, ToolDecision, ToolRun } from './types.js';

const available = (ctx: AgentContext) => !!ctx.takeaway;
const euro = (cents: number) => `${Math.floor(cents / 100)},${String(cents % 100).padStart(2, '0')} €`;
const fail = (error: string, message: string, extra: Record<string, any> = {}) => ({ success: false, error, message, ...extra });
const PLACEHOLDER_NAMES = new Set(['cliente', 'ospite', 'test', 'sconosciuto', 'anonimo', 'customer', 'guest']);

export const takeawayMenuTool: AgentTool = {
    name: 'get_takeaway_menu',
    kind: 'read',
    available,
    definition: () => ({
        name: 'get_takeaway_menu',
        description: "Il menu d'asporto: i piatti ordinabili con i prezzi, per categoria. Usalo prima di prendere un ordine o se il cliente chiede cosa c'è.",
        input_schema: { type: 'object', properties: {} },
    }),
    execute: async (_args, run: ToolRun) => {
        const r = await queryWithRetry(
            `SELECT d.name, d.price, COALESCE(d.category, 'Altro') AS category
               FROM dishes d
              WHERE d.tenant_id = $1 AND d.is_active AND d.crm_enabled
                AND COALESCE(d.sold_by_weight, false) = false
                AND EXISTS (SELECT 1 FROM dish_menus dm JOIN menus m ON m.id = dm.menu_id
                            WHERE dm.dish_id = d.id AND m.system_key = 'ALLA_CARTA')
              ORDER BY d.category, d.sort_order NULLS LAST, d.name
              LIMIT 150`,
            [run.tenantId]
        );
        const byCat = new Map<string, string[]>();
        for (const d of r.rows) {
            const list = byCat.get(d.category) ?? [];
            list.push(`${d.name} (${euro(Math.round(Number(d.price) * 100))})`);
            byCat.set(d.category, list);
        }
        return {
            success: true,
            menu: [...byCat.entries()].map(([category, dishes]) => ({ category, dishes })),
        };
    },
};

export const takeawaySlotsTool: AgentTool = {
    name: 'check_takeaway_slots',
    kind: 'read',
    available,
    definition: () => ({
        name: 'check_takeaway_slots',
        description: "Gli orari di ritiro dell'asporto ancora liberi in un giorno (oggi se non indicato). Usalo prima di proporre o accettare un orario.",
        input_schema: {
            type: 'object',
            properties: { date: { type: 'string', description: 'YYYY-MM-DD; vuoto per oggi' } },
        },
    }),
    execute: async (args, run: ToolRun) => {
        const tz = (await getTenantLocale(run.tenantId)).timezone;
        const date = parseFlexibleDate(args.date, tz) ?? getDatePartInTz(new Date(), tz);
        const free = await freeTakeawaySlots(run.tenantId, date, tz);
        if (!free) return fail('takeaway_stopped', `Per ${takeawayDateReadback(date)} non prendiamo ordini d'asporto.`, { date });
        if (free.lunch.length === 0 && free.dinner.length === 0) {
            return fail('no_slots', `Per ${takeawayDateReadback(date)} non ci sono più orari di ritiro liberi.`, { date });
        }
        return { success: true, date, date_readback: takeawayDateReadback(date), lunch_slots: free.lunch, dinner_slots: free.dinner };
    },
};

type Prepared =
    | { ok: true; name: string; date: string; time: string; shift: 'LUNCH' | 'DINNER'; notes: string | null;
        items: NonNullable<Awaited<ReturnType<typeof buildTakeawayItems>>['items']>; readback: string }
    | { ok: false; body: Record<string, any> };

/** I controlli dell'ordine, gli stessi dell'ordine al telefono: nome vero,
 *  orario nella griglia, libero e non troppo vicino, piatti del menu senza
 *  ambiguità. */
async function prepareOrder(tenantId: number, args: Record<string, any>): Promise<Prepared> {
    const name = typeof args.customer_name === 'string' ? args.customer_name.trim().slice(0, 120) : '';
    if (!name || PLACEHOLDER_NAMES.has(normalizeDishText(name))) {
        return { ok: false, body: fail('missing_name', "Serve il nome per l'ordine: chiedilo al cliente.") };
    }
    const tz = (await getTenantLocale(tenantId)).timezone;
    const date = parseFlexibleDate(args.date, tz) ?? getDatePartInTz(new Date(), tz);
    const time = parseFlexibleTime(args.time);
    if (!time) return { ok: false, body: fail('missing_time', 'Chiedi al cliente a che ora passa a ritirare.') };
    const raw: any[] = Array.isArray(args.items) ? args.items : [];
    if (raw.length === 0) return { ok: false, body: fail('missing_items', 'Chiedi al cliente cosa vuole ordinare.') };
    if (raw.length > 50) return { ok: false, body: fail('too_many_items', "Troppi piatti per un ordine in chat: al massimo cinquanta.") };

    const catalogue = await loadVoiceCatalogue(tenantId);
    const matched: { dish_id: number; qty: number; note: string | null }[] = [];
    const readback: string[] = [];
    for (const item of raw) {
        const written = typeof item?.name === 'string' ? item.name : '';
        const qty = Math.max(1, Math.min(99, Math.trunc(Number(item?.qty ?? 1)) || 1));
        const note = typeof item?.note === 'string' ? item.note.trim().slice(0, 300) : '';
        const match = matchVoiceDish(catalogue, written);
        if ('dish' in match) {
            matched.push({ dish_id: match.dish.id, qty, note: note || null });
            readback.push(`${qty}× ${match.dish.name}`);
        } else if ('ambiguous' in match) {
            return { ok: false, body: fail('ambiguous_dish', `Per «${written}» ci sono più piatti: ${match.ambiguous.join(', ')}. Chiedi al cliente quale.`) };
        } else {
            return { ok: false, body: fail('unknown_dish', `«${written}» non è nel menu d'asporto.${match.suggestions.length ? ` Forse: ${match.suggestions.join(', ')}.` : ''} Usa get_takeaway_menu.`) };
        }
    }

    const slot = await validateTakeawaySlot(tenantId, date, time, { force: false });
    if (slot.error) {
        const code = slot.error.body?.error;
        if (code === 'takeaway_stopped') return { ok: false, body: fail('takeaway_stopped', `Per ${takeawayDateReadback(date)} non prendiamo ordini d'asporto.`) };
        if (code === 'slot_full') return { ok: false, body: fail('slot_full', `Alle ${time} siamo al completo con l'asporto: proponi un altro orario con check_takeaway_slots.`) };
        return { ok: false, body: fail('invalid_slot', `Le ${time} non sono un orario di ritiro: usa check_takeaway_slots.`) };
    }
    const settings = await getTakeawaySettings(tenantId);
    if (!filterOrderableSlots([time], date, settings.prepMinutes, tz).includes(time)) {
        return { ok: false, body: fail('slot_too_soon', `Per le ${time} la cucina non fa in tempo (servono ${settings.prepMinutes} minuti): proponi un orario più tardi.`) };
    }
    const built = await buildTakeawayItems(tenantId, matched);
    if (built.error) return { ok: false, body: fail('invalid_items', built.error) };
    const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 1000) : '';
    return { ok: true, name, date, time, shift: slot.shift!, notes: notes || null, items: built.items!, readback: readback.join(', ') };
}

async function decideOrder(args: Record<string, any>, ctx: AgentContext): Promise<ToolDecision> {
    if (!ctx.autonomy?.takeaway) return { kind: 'propose' };
    const p = await prepareOrder(ctx.tenantId, args);
    // Qualcosa non torna: il modello lo dice al cliente, niente da proporre.
    if (p.ok === false) return { kind: 'refuse', reason: String(p.body.message) };
    return { kind: 'execute', auto: { reservationId: null } };
}

export const takeawayOrderTool: AgentTool = {
    name: 'create_takeaway_order',
    kind: 'write',
    available,
    // Il telefono della conversazione viaggia con la proposta: chi la
    // conferma dallo staff non deve ricostruirlo dalle cifre della chiave.
    prepareArgs: (args, ctx) => ({ ...args, phone: ctx.phone }),
    decide: (args, ctx) => decideOrder(args, ctx),
    definition: () => ({
        name: 'create_takeaway_order',
        description: "Registra un ordine d'asporto. Prima riepiloga al cliente piatti, giorno, ora di ritiro e nome, e usalo solo dopo il suo sì. Il telefono è quello della conversazione.",
        input_schema: {
            type: 'object',
            properties: {
                customer_name: { type: 'string', description: 'Il nome per il ritiro' },
                date: { type: 'string', description: 'YYYY-MM-DD; vuoto per oggi' },
                time: { type: 'string', description: 'HH:MM, uno degli orari di check_takeaway_slots' },
                items: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            name: { type: 'string', description: 'Il piatto, come nel menu' },
                            qty: { type: 'integer' },
                            note: { type: 'string', description: 'Una richiesta su quel piatto' },
                        },
                        required: ['name'],
                    },
                },
                notes: { type: 'string', description: "Una richiesta sull'ordine intero" },
            },
            required: ['customer_name', 'time', 'items'],
        },
    }),
    summarize: args => {
        const items = Array.isArray(args.items) ? args.items.map((i: any) => `${i?.qty ?? 1}× ${i?.name ?? '?'}`).join(', ') : '';
        return isoDatesToEuropean(`Ordine d'asporto: ${items} · ritiro ${args.date ? `il ${args.date} ` : ''}alle ${args.time} · ${args.customer_name}`);
    },
    execute: async (args, run: ToolRun) => {
        const p = await prepareOrder(run.tenantId, args);
        if (p.ok === false) return p.body;
        const orderId = await createTakeawayOrder(run.tenantId, {
            name: p.name, phone: run.phone, date: p.date, time: p.time, shift: p.shift, channel: 'WHATSAPP',
            notes: p.notes, items: p.items, outbox: { actor: { channel: 'whatsapp' } },
        });
        const view = await loadTakeawayView(run.tenantId, orderId);
        try { whatsappDeps().broadcastToAll(run.tenantId, 'takeaway:created', view); } catch { /* best effort */ }
        pushSendToRoles(run.tenantId, ['RECEPTION', 'CASSA', 'MANAGER', 'GENERAL_MANAGER', 'OWNER'], {
            category: 'service',
            title: `Asporto ${p.time}${view?.daily_number != null ? ` #${view.daily_number}` : ''} — nuovo ordine`,
            body: `${p.name} · su WhatsApp${run.auto ? ", preso dall'agente" : ''}`,
            url: '/?view=ASPORTO',
            tag: `takeaway-new-${orderId}`,
        }).catch(err => console.warn('[takeaway] push ordine WhatsApp non inviata:', err?.message ?? err));
        const total = Number(view?.total_cents) || 0;
        return {
            success: true,
            order_id: orderId,
            daily_number: view?.daily_number ?? null,
            items: p.readback,
            pickup: `${takeawayDateReadback(p.date)} alle ${p.time}`,
            total: euro(total),
            message: `Ordine registrato${view?.daily_number != null ? `, numero ${view.daily_number}` : ''}: digli piatti, ora di ritiro, totale e il numero da dire al ritiro.`,
        };
    },
};
