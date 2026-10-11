// Gli strumenti di prenotazione: gli stessi quattro di Sofia, sugli stessi
// servizi (services/bookingTools.ts) col canale WhatsApp.

import * as bookingTools from '../../../bookingTools.js';
import { WHATSAPP_AUTO_CHANNEL, WHATSAPP_CHANNEL } from '../../../bookingTools.js';
import { isoDatesToEuropean } from '../../../../utils/text.js';
import { decideCancel, decideCreate, decideModify } from '../autonomy.js';
import type { AgentContext } from '../types.js';
import type { AgentTool, ToolRun } from './types.js';

// Il telefono è sempre quello della conversazione: il modello non lo
// sceglie, e nemmeno il nome su cui cercare una prenotazione esistente (il
// ripiego per nome dei servizi di Sofia troverebbe la cena di un omonimo).
const conTelefono = (args: Record<string, any>, ctx: AgentContext) => ({ ...args, phone: ctx.phone });
const senzaNome = (args: Record<string, any>, ctx: AgentContext) => {
    const { customer_name: _nome, ...resto } = args;
    return conTelefono(resto, ctx);
};

const zona = (v: unknown) => (v === 'OUTDOOR' ? 'esterno' : 'interno');

// Eseguita dall'agente da solo: le push allo staff lo dicono.
const canale = (run: ToolRun) => (run.auto ? WHATSAPP_AUTO_CHANNEL : WHATSAPP_CHANNEL);

export const checkAvailabilityTool: AgentTool = {
    name: 'check_availability',
    kind: 'read',
    definition: () => ({
        name: 'check_availability',
        description: `Verifica se ci sono tavoli liberi. Usalo SEMPRE prima di dire al cliente che c'è posto: non confermare mai una disponibilità che non hai verificato con questo strumento.`,
        input_schema: {
            type: 'object',
            properties: {
                date: { type: 'string', description: 'Data in formato YYYY-MM-DD' },
                shift: { type: 'string', enum: ['LUNCH', 'DINNER'], description: 'LUNCH per pranzo, DINNER per cena' },
                guests: { type: 'integer', description: 'Numero di persone' },
                time: { type: 'string', description: "Orario chiesto dal cliente, HH:MM, se l'ha detto" },
                location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'], description: 'Solo se il cliente esprime una preferenza' },
            },
            required: ['date', 'shift', 'guests'],
        },
    }),
    prepareArgs: conTelefono,
    execute: async (args, ctx) =>
        (await bookingTools.checkAvailability(ctx.tenantId, { ...args, caller_id: ctx.phone }, WHATSAPP_CHANNEL)).body,
};

export const createReservationTool: AgentTool = {
    name: 'create_reservation',
    kind: 'write',
    definition: () => ({
        name: 'create_reservation',
        description: `Crea una nuova prenotazione. Servono tutti: nome e cognome reali confermati dal cliente, data, ora, turno, numero di persone. Se ne manca anche uno solo NON usare questo strumento: chiedi al cliente il dato mancante. Il telefono è quello della conversazione: non chiederlo.`,
        input_schema: {
            type: 'object',
            properties: {
                customer_name: { type: 'string', description: 'Nome e cognome reali, mai segnaposto come "Cliente"' },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time: { type: 'string', description: 'HH:MM' },
                shift: { type: 'string', enum: ['LUNCH', 'DINNER'] },
                guests: { type: 'integer' },
                children: { type: 'integer', description: 'Quanti dei coperti sono bambini' },
                location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'] },
                notes: { type: 'string', description: 'Richieste particolari del cliente' },
            },
            required: ['customer_name', 'date', 'time', 'shift', 'guests'],
        },
    }),
    prepareArgs: conTelefono,
    // In modalità «Azioni» prenota da solo, come Sofia, dove c'è posto e
    // non serve una caparra; altrimenti propone.
    decide: (args, ctx) => (ctx.autonomy ? decideCreate(args, ctx) : { kind: 'propose' }),
    execute: async (args, run: ToolRun) => (await bookingTools.createReservation(
        run.tenantId,
        // Confermata da una persona che ha letto la chat e l'agenda: i due
        // controlli che farebbero una domanda al cliente non devono fermarla.
        // Se il nome differisce dal titolare del numero resta la nota
        // «Numero in rubrica: …».
        run.approvedByStaff ? { ...args, phone: run.phone, name_confirmed: true, existing_booking_confirmed: true } : { ...args, phone: run.phone },
        canale(run)
    )).body,
    summarize: args => isoDatesToEuropean(
        `Crea prenotazione: ${args.customer_name} · ${args.guests} persone · ${args.date} alle ${args.time}` +
        (args.location_preference ? ` · ${zona(args.location_preference)}` : '')
    ),
};

export const modifyReservationTool: AgentTool = {
    name: 'modify_reservation',
    kind: 'write',
    definition: () => ({
        name: 'modify_reservation',
        description: `Modifica una prenotazione esistente di questo numero: data, ora, persone, zona. Passa SOLO i campi new_* che cambiano davvero; il resto resta com'è. Per una richiesta da annotare usa add_reservation_note.`,
        input_schema: {
            type: 'object',
            properties: {
                reservation_id: { type: 'integer', description: "L'id della prenotazione, dall'elenco PRENOTAZIONI IN AGENDA" },
                date: { type: 'string', description: 'Data della prenotazione ATTUALE, YYYY-MM-DD' },
                time: { type: 'string', description: 'Ora attuale, solo per distinguere fra più prenotazioni nello stesso giorno' },
                new_date: { type: 'string', description: 'YYYY-MM-DD' },
                new_time: { type: 'string', description: 'HH:MM' },
                new_guests: { type: 'integer' },
                new_location_preference: { type: 'string', enum: ['INDOOR', 'OUTDOOR'] },
            },
            required: ['date'],
        },
    }),
    prepareArgs: senzaNome,
    decide: (args, ctx) => (ctx.autonomy ? decideModify(args, ctx) : { kind: 'propose' }),
    execute: async (args, run: ToolRun) =>
        (await bookingTools.modifyReservation(run.tenantId, { ...args, phone: run.phone }, canale(run))).body,
    summarize: (args, ctx) => {
        const cambi: string[] = [];
        if (args.new_date) cambi.push(`data → ${args.new_date}`);
        if (args.new_time) cambi.push(`ora → ${args.new_time}`);
        if (args.new_guests !== undefined) cambi.push(`persone: ${ctx.reservation?.guests ?? '?'} → ${args.new_guests}`);
        if (args.new_location_preference) cambi.push(`zona → ${zona(args.new_location_preference)}`);
        if (args.new_notes) cambi.push(`nota: ${String(args.new_notes).slice(0, 40)}`);
        return isoDatesToEuropean(`Modifica prenotazione del ${args.date}: ${cambi.join(', ') || '(nessun cambiamento)'}`);
    },
};

export const cancelReservationTool: AgentTool = {
    name: 'cancel_reservation',
    kind: 'write',
    definition: () => ({
        name: 'cancel_reservation',
        description: 'Annulla una prenotazione esistente di questo numero.',
        input_schema: {
            type: 'object',
            properties: {
                reservation_id: { type: 'integer', description: "L'id della prenotazione, dall'elenco PRENOTAZIONI IN AGENDA" },
                date: { type: 'string', description: 'YYYY-MM-DD' },
                time: { type: 'string', description: 'Solo per distinguere fra più prenotazioni nello stesso giorno' },
            },
            required: ['date'],
        },
    }),
    prepareArgs: senzaNome,
    decide: (args, ctx) => (ctx.autonomy ? decideCancel(args, ctx) : { kind: 'propose' }),
    execute: async (args, run: ToolRun) =>
        (await bookingTools.cancelReservation(run.tenantId, { ...args, phone: run.phone }, canale(run))).body,
    summarize: args => isoDatesToEuropean(
        `Annulla la prenotazione del ${args.date}${args.time ? ` alle ${args.time}` : ''}`
    ),
};
