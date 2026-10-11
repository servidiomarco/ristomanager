// Quello che l'ospite dice della sua prenotazione e che va scritto sulla
// prenotazione stessa: a che ora arriva, una richiesta in più, un'allergia,
// «ci saremo». Oggi lo dice su WhatsApp all'agente; le stesse funzioni
// serviranno ai tasti del promemoria (Fase 8) e a Sofia.
//
// Ogni scrittura passa dal log di replica nella stessa transazione (il nodo
// di sala la vede) e avvisa i client con il broadcast. Le note si aggiungono
// sempre in coda, come segmento a sé: mai al posto di quelle dello staff.

import { queryWithRetry } from '../db.js';
import { LogService, ActivityAction, ResourceType } from '../activityLogs/logService.js';
import { outboxEnqueueInTx, outboxKick, withOutboxTx } from './outboxService.js';
import { sendToRoles as pushSendToRoles } from './pushService.js';
import { appendReservationNote, findActiveReservationsByPhone, type ActiveReservationByPhone } from './elevenlabsService.js';
import { buildDietaryNote, parseDietary, stripDietaryNote } from '../utils/dietary.js';
import { getDatePartInTz, getTimePartInTz } from '../utils/reservationTime.js';
import { getTenantLocale } from './tenantLocale.js';

export interface GuestUpdatesDeps {
    broadcastReservationsUpdatedByIds: (ids: number[]) => Promise<unknown>;
}
let deps: GuestUpdatesDeps | null = null;
export function configureGuestUpdates(d: GuestUpdatesDeps): void {
    deps = d;
}

/** Chi scrive, per il log attività e per il prefisso delle note. */
export interface GuestUpdateActor {
    email: string;
    name: string;
    source: string;
    notePrefix: string;
}

export const WHATSAPP_GUEST_ACTOR: GuestUpdateActor = {
    email: 'agente-whatsapp@ristomanager',
    name: 'Agente WhatsApp',
    source: 'WHATSAPP',
    notePrefix: '[WhatsApp]',
};

// ---------------------------------------------------------------------------
// Quale prenotazione
// ---------------------------------------------------------------------------

export type GuestReservationPick =
    | { status: 'one'; reservation: ActiveReservationByPhone }
    | { status: 'none' }
    | { status: 'many'; candidates: ActiveReservationByPhone[] };

/**
 * La prenotazione di cui parla l'ospite, fra quelle in agenda del suo
 * numero. Con l'id si prende quella (se è davvero sua); con `todayOnly` solo
 * quelle di oggi. Se ce n'è più d'una e non si sa quale, lo si dice invece di
 * tirare a indovinare.
 */
export async function pickGuestReservation(
    tenantId: number,
    phone: string,
    opts: { reservationId?: number | null; todayOnly?: boolean } = {}
): Promise<GuestReservationPick> {
    const tz = (await getTenantLocale(tenantId)).timezone;
    const today = getDatePartInTz(new Date(), tz);
    const list = await findActiveReservationsByPhone(tenantId, phone, opts.todayOnly ? { date: today } : {});
    const candidates = opts.reservationId != null
        ? list.filter(r => Number(r.id) === Number(opts.reservationId))
        : list;
    if (candidates.length === 0) return { status: 'none' };
    if (candidates.length > 1) return { status: 'many', candidates };
    return { status: 'one', reservation: candidates[0] };
}

// ---------------------------------------------------------------------------
// Scritture
// ---------------------------------------------------------------------------

async function write(
    tenantId: number,
    reservationId: number,
    actor: GuestUpdateActor,
    change: (client: { query: (sql: string, params?: any[]) => Promise<any> }, current: any) => Promise<any | null>,
    logDetails: Record<string, unknown>
): Promise<any | null> {
    const row = await withOutboxTx(async (client) => {
        const cur = (await client.query(
            `SELECT * FROM reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
            [reservationId, tenantId]
        )).rows[0];
        if (!cur) return null;
        const updated = await change(client, cur);
        if (updated) {
            await outboxEnqueueInTx(client, tenantId, 'reservation:updated', `reservation:${reservationId}`,
                { reservation_id: reservationId }, { actor: { channel: actor.source.toLowerCase() } });
        }
        return updated;
    });
    if (!row) return null;
    outboxKick();
    await deps?.broadcastReservationsUpdatedByIds([reservationId]).catch(err =>
        console.warn('[guest-updates] broadcast fallito:', err?.message || err));
    LogService.logActivity(
        tenantId, null, actor.email, actor.name,
        ActivityAction.UPDATE, ResourceType.RESERVATION, reservationId, String(row.customer_name ?? ''),
        { source: actor.source, ...logDetails }
    ).catch(() => {});
    return row;
}

/** L'ora d'arrivo che l'ospite ha comunicato. Solo per chi non è ancora
 *  arrivato: a cliente seduto l'avviso non serve più. */
export async function setGuestEta(tenantId: number, reservationId: number, eta: Date, actor: GuestUpdateActor): Promise<any | null> {
    const row = await write(tenantId, reservationId, actor, async (client, cur) => {
        if (cur.reservation_status === 'CANCELLED' || (cur.arrival_status && cur.arrival_status !== 'WAITING')) return null;
        return (await client.query(
            `UPDATE reservations SET guest_eta_at = $1, guest_eta_noted_at = NOW()
              WHERE id = $2 AND tenant_id = $3
              RETURNING id, tenant_id, customer_name, reservation_time, guests, guest_eta_at, guest_eta_noted_at`,
            [eta.toISOString(), reservationId, tenantId]
        )).rows[0] ?? null;
    }, { guest_eta_at: eta.toISOString() });
    if (row) {
        const tz = (await getTenantLocale(tenantId)).timezone;
        pushSendToRoles(tenantId, ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION', 'WAITER'], {
            category: 'reservation',
            title: 'Arriva più tardi',
            body: `${row.customer_name} (${row.guests}): arriva alle ${getTimePartInTz(eta, tz)} invece che alle ${getTimePartInTz(row.reservation_time, tz)}`,
            url: `/?view=RESERVATIONS&reservationId=${reservationId}`,
            tag: `guest-eta-${reservationId}`,
        }, { excludeUserId: null }).catch(err => console.warn('[guest-updates] push ritardo fallita:', err?.message || err));
    }
    return row;
}

/** Una richiesta dell'ospite in coda alle note. Con una scelta strutturata
 *  (un piatto da preparare, «2× Stinco (maiale)») si aggiunge anche a
 *  note_selections, che la cucina somma: mai una seconda volta la stessa. */
export async function appendGuestNote(
    tenantId: number,
    reservationId: number,
    text: string,
    actor: GuestUpdateActor,
    selection?: { preset_id: number; label: string; quantity: number; variant: string | null } | null
): Promise<{ row: any; selectionAdded: boolean } | null> {
    let selectionAdded = false;
    const row = await write(tenantId, reservationId, actor, async (client, cur) => {
        if (cur.reservation_status === 'CANCELLED') return null;
        const notes = appendReservationNote(cur.notes, `${actor.notePrefix} ${text.trim()}`);
        let selections: any[] = Array.isArray(cur.note_selections) ? cur.note_selections : [];
        if (selection) {
            const same = selections.some(s => Number(s.preset_id) === selection.preset_id && (s.variant ?? null) === (selection.variant ?? null));
            if (!same) {
                selections = [...selections, selection];
                selectionAdded = true;
            }
        }
        return (await client.query(
            `UPDATE reservations SET notes = $1, note_selections = $2::jsonb
              WHERE id = $3 AND tenant_id = $4
              RETURNING id, tenant_id, customer_name, notes, note_selections`,
            [notes, JSON.stringify(selections), reservationId, tenantId]
        )).rows[0] ?? null;
    }, { note_added: text.trim().slice(0, 200), selection: selection ?? undefined });
    return row ? { row, selectionAdded } : null;
}

/**
 * Allergie e intolleranze dichiarate dall'ospite, nel formato che il modulo
 * prenotazione legge e mostra come pillole («Allergie: X | Intolleranze: Y»).
 * Si uniscono a quelle già segnate. Il chiamante deve avere il consenso al
 * trattamento dei dati sanitari (art. 9 GDPR): qui si registra, con l'ora.
 */
export async function recordGuestDietary(
    tenantId: number,
    reservationId: number,
    input: { allergies: string[]; intolerances: string[]; details?: string | null },
    actor: GuestUpdateActor
): Promise<{ row: any; allergies: string[]; intolerances: string[] } | null> {
    const presets = (await queryWithRetry(
        `SELECT label FROM reservation_allergen_presets WHERE tenant_id = $1 ORDER BY sort_order, id`, [tenantId]
    )).rows.map((r: any) => String(r.label));
    // Solo valori del catalogo del locale: sono quelli che diventano pillole.
    const canon = (values: string[]) => values
        .map(v => presets.find(p => p.toLowerCase() === String(v).trim().toLowerCase()))
        .filter((v): v is string => !!v);
    const union = (a: string[], b: string[]) => [...a, ...b.filter(x => !a.includes(x))];
    let merged: { allergies: string[]; intolerances: string[] } = { allergies: [], intolerances: [] };
    const row = await write(tenantId, reservationId, actor, async (client, cur) => {
        if (cur.reservation_status === 'CANCELLED') return null;
        const prima = parseDietary(cur.notes, presets);
        merged = {
            allergies: union(prima.allergies, canon(input.allergies)),
            intolerances: union(prima.intolerances, canon(input.intolerances)),
        };
        let notes = [buildDietaryNote(merged.allergies, merged.intolerances), stripDietaryNote(cur.notes)]
            .filter(Boolean).join(' | ');
        if (input.details && input.details.trim()) {
            notes = appendReservationNote(notes, `${actor.notePrefix} ${input.details.trim()}`);
        }
        return (await client.query(
            `UPDATE reservations SET notes = $1, consent_data_health = TRUE, consent_updated_at = NOW()
              WHERE id = $2 AND tenant_id = $3
              RETURNING id, tenant_id, customer_name, guests, reservation_time, notes`,
            [notes, reservationId, tenantId]
        )).rows[0] ?? null;
    }, { dietary: input, consent_data_health: true });
    if (!row) return null;
    const tz = (await getTenantLocale(tenantId)).timezone;
    const elenco = [...merged.allergies, ...merged.intolerances].join(', ') || (input.details ?? '');
    pushSendToRoles(tenantId, ['OWNER', 'GENERAL_MANAGER', 'MANAGER', 'RECEPTION'], {
        category: 'reservation',
        title: 'Allergia segnalata',
        body: `${row.customer_name} (${getDatePartInTz(row.reservation_time, tz)} ${getTimePartInTz(row.reservation_time, tz)}): ${elenco}`,
        url: `/?view=RESERVATIONS&reservationId=${reservationId}`,
        tag: `guest-allergy-${reservationId}`,
    }, { excludeUserId: null }).catch(err => console.warn('[guest-updates] push allergia fallita:', err?.message || err));
    return { row, ...merged };
}

/** «Ci saremo»: la stessa conferma della pagina «La tua prenotazione». */
export async function confirmGuestAttendance(tenantId: number, reservationId: number, actor: GuestUpdateActor): Promise<any | null> {
    return write(tenantId, reservationId, actor, async (client, cur) => {
        if (cur.reservation_status === 'CANCELLED') return null;
        return (await client.query(
            `UPDATE reservations SET guest_confirmed_at = COALESCE(guest_confirmed_at, NOW())
              WHERE id = $1 AND tenant_id = $2
              RETURNING id, tenant_id, customer_name, guest_confirmed_at`,
            [reservationId, tenantId]
        )).rows[0] ?? null;
    }, { guest_confirmed: true });
}
