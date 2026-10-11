// Gli strumenti che scrivono sulla prenotazione quello che l'ospite dice:
// ritardo, una richiesta in più, allergie, «ci saremo». La scrittura vera
// sta in services/reservationGuestUpdates.ts.

import { queryWithRetry } from '../../../../db.js';
import {
    appendGuestNote, confirmGuestAttendance, pickGuestReservation, recordGuestDietary, setGuestEta,
    WHATSAPP_GUEST_ACTOR, type GuestReservationPick,
} from '../../../reservationGuestUpdates.js';
import { getTenantLocale } from '../../../tenantLocale.js';
import { getDatePartInTz, getTimePartInTz } from '../../../../utils/reservationTime.js';
import { decideNote } from '../autonomy.js';
import type { AgentContext } from '../types.js';
import type { AgentTool, ToolRun } from './types.js';

const RESERVATION_ID = {
    type: 'integer',
    description: "L'id della prenotazione, dall'elenco PRENOTAZIONI IN AGENDA; se il cliente ne ha una sola puoi ometterlo",
} as const;

const fail = (status: string, message: string) => ({ success: false, status, message });

/** Il corpo per il modello quando non si sa quale prenotazione toccare. */
function notOne(pick: Exclude<GuestReservationPick, { status: 'one' }>, todayOnly = false) {
    if (pick.status === 'none') {
        return fail('not_found', todayOnly
            ? 'Questo numero non ha prenotazioni attese per oggi (nessuna, o il cliente è già arrivato).'
            : 'Questo numero non ha prenotazioni in agenda.');
    }
    return {
        ...fail('ambiguous', 'Il numero ha più prenotazioni: chiedi al cliente quale, poi passa reservation_id.'),
        candidates: pick.candidates.map(c => ({ id: c.id, date: c.date, time: c.time, guests: c.guests })),
    };
}

const reservationIdOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

export const lateArrivalTool: AgentTool = {
    name: 'report_late_arrival',
    // Scrive, ma è un avviso: la sala lo deve sapere subito.
    kind: 'write',
    decide: () => ({ kind: 'execute' }),
    definition: () => ({
        name: 'report_late_arrival',
        description: "Avvisa la sala che il cliente arriverà in ritardo o a un'ora diversa, per la prenotazione di OGGI. Usalo quando il cliente scrive «arriviamo con 15 minuti di ritardo», «stiamo arrivando, 10 minuti», «arriviamo alle 21:30».",
        input_schema: {
            type: 'object',
            properties: {
                minutes: { type: 'integer', description: 'Minuti di ritardo o di attesa, se il cliente li dice' },
                eta_time: { type: 'string', description: "L'ora d'arrivo HH:MM, se il cliente la dice" },
                reservation_id: RESERVATION_ID,
            },
        },
    }),
    execute: async (args, run: ToolRun) => {
        const pick = await pickGuestReservation(run.tenantId, run.phone, { reservationId: reservationIdOf(args.reservation_id), todayOnly: true });
        if (pick.status !== 'one') return notOne(pick, true);
        const r = pick.reservation;
        const tz = (await getTenantLocale(run.tenantId)).timezone;
        let eta: Date | null = null;
        if (typeof args.eta_time === 'string' && /^\d{1,2}[:.]\d{2}$/.test(args.eta_time.trim())) {
            const hhmm = args.eta_time.trim().replace('.', ':').padStart(5, '0');
            // L'ora detta dal cliente è quella del locale, nel giorno della prenotazione.
            const t = await queryWithRetry(`SELECT (($1::date + $2::time) AT TIME ZONE $3) AS t`, [r.date, hhmm, tz]);
            eta = t.rows[0]?.t ? new Date(t.rows[0].t) : null;
        } else if (Number.isFinite(Number(args.minutes)) && Number(args.minutes) > 0) {
            // «15 minuti di ritardo» si conta dall'orario prenotato; se quello
            // è già passato («stiamo arrivando, 10 minuti») da adesso.
            const base = Math.max(new Date(r.reservation_time).getTime(), Date.now());
            eta = new Date(base + Math.min(Number(args.minutes), 240) * 60_000);
        }
        if (!eta) return fail('missing_time', 'Chiedi al cliente fra quanto arriva o a che ora.');
        const row = await setGuestEta(run.tenantId, r.id, eta, WHATSAPP_GUEST_ACTOR);
        if (!row) return fail('not_waiting', 'Il cliente risulta già arrivato o la prenotazione non è attiva.');
        return {
            success: true,
            reservation_id: r.id,
            prenotata_alle: getTimePartInTz(r.reservation_time, tz),
            arriva_alle: getTimePartInTz(eta, tz),
            message: 'La sala è avvisata.',
        };
    },
};

export const reservationNoteTool: AgentTool = {
    name: 'add_reservation_note',
    kind: 'write',
    decide: (args, ctx) => (ctx.autonomy ? decideNote(args, ctx) : { kind: 'propose' }),
    definition: (ctx: AgentContext) => {
        const presets = ctx.notePresets ?? [];
        const conQuantita = presets.filter(p => p.has_quantity);
        return {
            name: 'add_reservation_note',
            description: `Aggiunge una richiesta del cliente alle note della prenotazione (un piatto da preparare, un seggiolone, il cane, una torta), senza cancellare quelle che ci sono. ${conQuantita.length
                ? `Per un piatto da preparare in anticipo che è nel catalogo del locale passa preset_label e quantity (ed eventualmente variant): ${conQuantita.map(p => `«${p.label}»${p.variants.length ? ` (varianti: ${p.variants.join(', ')})` : ''}`).join('; ')}.`
                : ''} Non usarlo per allergie e intolleranze: per quelle c'è record_allergy.`,
            input_schema: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'La richiesta, breve, come la leggerebbe la sala' },
                    preset_label: conQuantita.length
                        ? { type: 'string', enum: conQuantita.map(p => p.label) }
                        : { type: 'string', description: 'Lascialo vuoto: il locale non ha piatti da preparare in catalogo' },
                    quantity: { type: 'integer' },
                    variant: { type: 'string' },
                    reservation_id: RESERVATION_ID,
                },
                required: ['text'],
            },
        };
    },
    summarize: args => `Aggiunge alle note: ${String(args.text ?? '').slice(0, 80)}`,
    execute: async (args, run: ToolRun) => {
        const text = String(args.text ?? '').trim();
        if (!text) return fail('missing_text', 'Manca la richiesta da annotare.');
        const pick = await pickGuestReservation(run.tenantId, run.phone, { reservationId: reservationIdOf(args.reservation_id) });
        if (pick.status !== 'one') return notOne(pick);
        let selection: { preset_id: number; label: string; quantity: number; variant: string | null } | null = null;
        if (typeof args.preset_label === 'string' && args.preset_label.trim()) {
            const p = (await queryWithRetry(
                `SELECT p.id, p.label, p.has_quantity,
                        COALESCE(array_agg(v.label ORDER BY v.sort_order, v.id) FILTER (WHERE v.id IS NOT NULL), '{}') AS variants
                   FROM reservation_note_presets p
                   LEFT JOIN reservation_note_preset_variants v ON v.preset_id = p.id
                  WHERE p.tenant_id = $1 AND lower(p.label) = lower($2)
                  GROUP BY p.id`,
                [run.tenantId, args.preset_label.trim()]
            )).rows[0];
            const quantity = Math.max(1, Math.min(99, Math.trunc(Number(args.quantity) || 1)));
            if (p?.has_quantity) {
                const variants: string[] = p.variants ?? [];
                const variant = typeof args.variant === 'string'
                    ? variants.find(v => v.toLowerCase() === args.variant.trim().toLowerCase()) ?? null
                    : null;
                if (variants.length > 0 && !variant) {
                    return fail('missing_variant', `Chiedi al cliente quale: ${variants.join(', ')}.`);
                }
                selection = { preset_id: Number(p.id), label: String(p.label), quantity, variant };
            }
        }
        const done = await appendGuestNote(run.tenantId, pick.reservation.id, text, WHATSAPP_GUEST_ACTOR, selection);
        if (!done) return fail('not_active', 'La prenotazione non è più attiva.');
        return { success: true, reservation_id: pick.reservation.id, piatto_in_cucina: done.selectionAdded };
    },
};

export const allergyTool: AgentTool = {
    name: 'record_allergy',
    kind: 'write',
    // Dati sanitari: si scrivono solo col consenso esplicito del cliente.
    // Con il consenso, in modalità «Azioni» si registrano subito (lo staff
    // riceve comunque «Allergia segnalata»), altrimenti si propongono.
    decide: (args, ctx) => args.customer_consented !== true
        ? { kind: 'refuse', reason: 'Prima chiedi al cliente: «Posso annotarlo sulla prenotazione per la cucina?». Solo se risponde sì richiama record_allergy con customer_consented: true.' }
        : (ctx.autonomy ? decideNote(args, ctx) : { kind: 'propose' }),
    definition: (ctx: AgentContext) => {
        const presets = ctx.allergenPresets ?? [];
        const lista = presets.length ? { type: 'array', items: { type: 'string', enum: presets } } : { type: 'array', items: { type: 'string' } };
        return {
            name: 'record_allergy',
            description: "Registra sulla prenotazione le allergie o intolleranze dichiarate dal cliente, perché la cucina le veda. Serve il suo consenso esplicito (customer_consented: true dopo che ha detto sì). Non dire mai se un piatto è adatto: lo conferma il personale.",
            input_schema: {
                type: 'object',
                properties: {
                    allergies: { ...lista, description: 'Allergie (le gravi), dal catalogo del locale' },
                    intolerances: { ...lista, description: 'Intolleranze, dal catalogo del locale' },
                    details: { type: 'string', description: 'Quello che il cliente ha detto, se non sta nel catalogo' },
                    customer_consented: { type: 'boolean' },
                    reservation_id: RESERVATION_ID,
                },
                required: ['customer_consented'],
            },
        };
    },
    summarize: args => `Segna ${[...(args.allergies ?? []), ...(args.intolerances ?? [])].join(', ') || String(args.details ?? '').slice(0, 60)} (consenso dato in chat)`,
    execute: async (args, run: ToolRun) => {
        if (args.customer_consented !== true) return fail('needs_customer_consent', 'Serve il consenso del cliente.');
        const allergies = Array.isArray(args.allergies) ? args.allergies.map(String) : [];
        const intolerances = Array.isArray(args.intolerances) ? args.intolerances.map(String) : [];
        const details = typeof args.details === 'string' ? args.details : null;
        if (allergies.length + intolerances.length === 0 && !details?.trim()) return fail('missing_allergens', 'Manca cosa annotare.');
        const pick = await pickGuestReservation(run.tenantId, run.phone, { reservationId: reservationIdOf(args.reservation_id) });
        if (pick.status !== 'one') return notOne(pick);
        const done = await recordGuestDietary(run.tenantId, pick.reservation.id, { allergies, intolerances, details }, WHATSAPP_GUEST_ACTOR);
        if (!done) return fail('not_active', 'La prenotazione non è più attiva.');
        return { success: true, reservation_id: pick.reservation.id, allergie: done.allergies, intolleranze: done.intolerances };
    },
};

export const attendanceTool: AgentTool = {
    name: 'confirm_attendance',
    // «Ci saremo» è una conferma dell'ospite, come il pulsante della pagina
    // «La tua prenotazione»: si segna subito.
    kind: 'write',
    decide: () => ({ kind: 'execute' }),
    definition: () => ({
        name: 'confirm_attendance',
        description: 'Segna che il cliente conferma che verrà («confermo», «ci saremo», «sì, ci vediamo stasera»), di solito in risposta al promemoria.',
        input_schema: {
            type: 'object',
            properties: { reservation_id: RESERVATION_ID },
        },
    }),
    execute: async (args, run: ToolRun) => {
        const pick = await pickGuestReservation(run.tenantId, run.phone, { reservationId: reservationIdOf(args.reservation_id) });
        if (pick.status !== 'one') return notOne(pick);
        const row = await confirmGuestAttendance(run.tenantId, pick.reservation.id, WHATSAPP_GUEST_ACTOR);
        if (!row) return fail('not_active', 'La prenotazione non è più attiva.');
        const tz = (await getTenantLocale(run.tenantId)).timezone;
        return {
            success: true, reservation_id: pick.reservation.id,
            giorno: getDatePartInTz(pick.reservation.reservation_time, tz), ora: pick.reservation.time,
        };
    },
};
