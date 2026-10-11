// L'agente che agisce da solo (modalità «Azioni»): quando una scrittura si
// esegue senza lo staff, come si registra e come si torna indietro.
//
// Le regole sono quelle della pagina «La tua prenotazione», dove l'ospite
// annulla e sposta da solo (services/guestManage.ts), più quelle di Sofia
// per le prenotazioni nuove. Fuori da queste regole l'azione diventa una
// proposta, come in modalità «Risposte»:
// - una prenotazione confermata, di questo numero, non legata a un banchetto,
//   senza caparra pagata (un rimborso o una caparra in più li decide lo staff);
// - entro la soglia d'anticipo del locale (la stessa del link ospite);
// - per la modifica: stessa zona, persone entro la soglia dei gruppi e senza
//   far scattare una caparra, data entro 60 giorni, orario sulla griglia;
// - per l'annullo: il cliente conferma («Confermi?» — «Sì») se il locale
//   lo chiede (di serie sì);
// - per una prenotazione nuova: posto verificato adesso e nessuna caparra.
//
// Ogni azione riuscita finisce in agent_proposals (auto) con la prenotazione
// prima e dopo; «Annulla» la rimette com'era solo se nessuno l'ha toccata
// nel frattempo.

import { queryWithRetry } from '../../../db.js';
import { phoneDigitsVariants } from '../../../utils/text.js';
import { getDatePartInTz, getTimePartInTz } from '../../../utils/reservationTime.js';
import { getGuestManagePolicy, guestActionsFor, addDaysIsoDate, wallClockToInstant, GUEST_MODIFY_HORIZON_DAYS } from '../../guestManage.js';
import { getTenantLocale } from '../../tenantLocale.js';
import { pickGuestReservation } from '../../reservationGuestUpdates.js';
import { outboxEnqueueInTx, outboxKick, withOutboxTx } from '../../outboxService.js';
import { findTableForChange } from '../../roomOccupancyService.js';
import * as bookingTools from '../../bookingTools.js';
import { Shift } from '../../../types.js';
import type { AgentAction, AgentContext, ReservationSnapshot } from './types.js';
import type { ToolDecision } from './tools/types.js';

const reservationIdOf = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 ? n : null;
};

// ---------------------------------------------------------------------------
// La prenotazione prima e dopo
// ---------------------------------------------------------------------------

export async function snapshotReservation(tenantId: number, id: number | null | undefined): Promise<ReservationSnapshot | null> {
    if (!id) return null;
    const r = (await queryWithRetry(
        `SELECT id, reservation_time, shift, guests, COALESCE(children, 0) AS children, table_id,
                COALESCE(reservation_status, 'CONFIRMED') AS reservation_status, notes
           FROM reservations WHERE id = $1 AND tenant_id = $2`,
        [id, tenantId]
    )).rows[0];
    if (!r) return null;
    return {
        id: Number(r.id),
        reservation_time: new Date(r.reservation_time).toISOString(),
        shift: r.shift ?? null,
        guests: Number(r.guests),
        children: Number(r.children),
        table_id: r.table_id == null ? null : Number(r.table_id),
        reservation_status: String(r.reservation_status),
        notes: r.notes ?? null,
    };
}

// ---------------------------------------------------------------------------
// Idoneità
// ---------------------------------------------------------------------------

// Quello che serve a decidere: la prenotazione con la caparra pagata (online
// o segnata a mano), come la vede la pagina dell'ospite.
const TARGET_SQL = `
    SELECT r.id, r.reservation_time, COALESCE(r.reservation_status, 'CONFIRMED') AS reservation_status,
           r.arrival_status, r.guest_confirmed_at, r.guests, r.table_id, r.shift, r.banquet_menu_id,
           r.payment_status, r.deposit_amount, dep.amount_cents AS deposit_paid_cents
      FROM reservations r
      LEFT JOIN LATERAL (
          SELECT SUM(pr.amount_cents)::int AS amount_cents
            FROM payment_requests pr
           WHERE pr.reservation_id = r.id AND pr.tenant_id = r.tenant_id
             AND pr.table_bill_split_id IS NULL AND UPPER(pr.status) = 'COMPLETED'
      ) dep ON true
     WHERE r.id = $1 AND r.tenant_id = $2`;

const depositPaid = (row: any): boolean =>
    (Number(row.deposit_paid_cents) || 0) > 0
    || (row.payment_status === 'PAID_DEPOSIT' && (Number(row.deposit_amount) || 0) > 0);

type Resolved = { ok: true; row: any; date: string; time: string; tz: string } | { ok: false; decision: ToolDecision };

/** La prenotazione su cui l'agente vuole agire: una del numero, quella
 *  indicata o l'unica. Se non si sa quale, lo si dice al modello. */
async function resolveTarget(ctx: AgentContext, args: Record<string, any>): Promise<Resolved> {
    const pick = await pickGuestReservation(ctx.tenantId, ctx.phone, { reservationId: reservationIdOf(args.reservation_id) });
    if (pick.status === 'none') {
        return { ok: false, decision: { kind: 'refuse', reason: 'Questo numero non ha una prenotazione in agenda con quei dati. Chiedi al cliente giorno e ora; se è a nome di un altro numero, di\' che passi la richiesta a una persona.' } };
    }
    if (pick.status === 'many') {
        return { ok: false, decision: { kind: 'refuse', reason: `Il numero ha più prenotazioni (${pick.candidates.map(c => `id ${c.id}: ${c.date} ${c.time}`).join('; ')}): chiedi al cliente quale, poi passa reservation_id.` } };
    }
    const tz = (await getTenantLocale(ctx.tenantId)).timezone;
    const r = pick.reservation;
    // La data detta dal modello deve essere quella della prenotazione scelta:
    // se non torna, ha confuso due prenotazioni e non si tocca niente.
    if (typeof args.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date) && args.date !== r.date) {
        return { ok: false, decision: { kind: 'refuse', reason: `La prenotazione ${r.id} è del ${r.date} alle ${r.time}, non del ${args.date}: verifica col cliente quale intende.` } };
    }
    const row = (await queryWithRetry(TARGET_SQL, [r.id, ctx.tenantId])).rows[0];
    if (!row) return { ok: false, decision: { kind: 'propose' } };
    return { ok: true, row, date: r.date, time: r.time, tz };
}

/** Le regole comuni ad annullo e modifica; null se si può fare da solo. */
async function commonBlock(ctx: AgentContext, row: any, what: 'cancel' | 'modify'): Promise<string | null> {
    if (row.reservation_status !== 'CONFIRMED') return 'non è confermata';
    if (row.banquet_menu_id != null) return 'è legata a un banchetto';
    if (depositPaid(row)) return 'ha una caparra pagata';
    const policy = await getGuestManagePolicy(ctx.tenantId);
    const actions = guestActionsFor({
        now: new Date(),
        reservationTime: new Date(row.reservation_time),
        status: row.reservation_status,
        arrivalStatus: row.arrival_status,
        guestConfirmedAt: row.guest_confirmed_at ? new Date(row.guest_confirmed_at) : null,
        // La soglia è quella del link ospite, anche se il link è spento: è
        // la regola del locale su quanto prima si può cambiare da soli.
        policy: { enabled: true, cancel_cutoff_hours: policy.cancel_cutoff_hours },
        banquetLinked: row.banquet_menu_id != null,
    });
    if (what === 'cancel' && !actions.can_cancel) return 'è troppo vicina';
    if (what === 'modify' && !actions.can_modify) return 'è troppo vicina';
    return null;
}

const proposeBecause = (_why: string): ToolDecision => ({ kind: 'propose' });

// ---- annullo --------------------------------------------------------------

interface PendingConfirmation {
    tool: string;
    reservation_id: number;
    asked_at: string;
}

async function readPending(ctx: AgentContext): Promise<PendingConfirmation | null> {
    const r = await queryWithRetry(
        `SELECT pending_confirmation FROM agent_conversation_state WHERE tenant_id = $1 AND phone_digits = $2`,
        [ctx.tenantId, ctx.phoneDigits]
    );
    const p = r.rows[0]?.pending_confirmation;
    return p && typeof p === 'object' ? p as PendingConfirmation : null;
}

async function writePending(ctx: AgentContext, pending: PendingConfirmation | null): Promise<void> {
    await queryWithRetry(
        `INSERT INTO agent_conversation_state (tenant_id, phone_digits, pending_confirmation, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (tenant_id, phone_digits) DO UPDATE
            SET pending_confirmation = EXCLUDED.pending_confirmation, updated_at = NOW()`,
        [ctx.tenantId, ctx.phoneDigits, pending ? JSON.stringify(pending) : null]
    );
}

/** L'agente ha chiesto «confermi?» per questa prenotazione, e il cliente ha
 *  scritto dopo la domanda (è lì che ha detto sì: lo legge il modello). */
async function cancelConfirmedByGuest(ctx: AgentContext, reservationId: number): Promise<boolean> {
    const p = await readPending(ctx);
    if (!p || p.tool !== 'cancel_reservation' || Number(p.reservation_id) !== reservationId) return false;
    const askedAt = new Date(p.asked_at);
    if (!Number.isFinite(askedAt.getTime()) || Date.now() - askedAt.getTime() > 24 * 3600_000) return false;
    const after = await queryWithRetry(
        `SELECT 1 FROM outbound_messages
          WHERE tenant_id = $1 AND direction = 'inbound' AND from_phone_digits = ANY($2::text[]) AND sent_at > $3
          LIMIT 1`,
        [ctx.tenantId, phoneDigitsVariants(ctx.phoneDigits), askedAt.toISOString()]
    );
    return (after.rowCount ?? 0) > 0;
}

export async function decideCancel(args: Record<string, any>, ctx: AgentContext): Promise<ToolDecision> {
    if (!ctx.autonomy?.cancel) return { kind: 'propose' };
    const t = await resolveTarget(ctx, args);
    if (t.ok === false) return t.decision;
    const block = await commonBlock(ctx, t.row, 'cancel');
    if (block) return proposeBecause(block);
    const id = Number(t.row.id);
    if (ctx.autonomy.confirmCancel && !(await cancelConfirmedByGuest(ctx, id))) {
        await writePending(ctx, { tool: 'cancel_reservation', reservation_id: id, asked_at: new Date().toISOString() });
        return {
            kind: 'ask',
            message: `Prima di annullare chiedi conferma al cliente, con giorno e ora: «Confermi che annullo la prenotazione del ${t.date} alle ${t.time}?». Annulla solo dopo il suo sì, richiamando cancel_reservation con reservation_id ${id}.`,
        };
    }
    return { kind: 'execute', auto: { reservationId: id } };
}

/** Dopo un annullo riuscito la domanda non vale più. */
export async function clearPendingConfirmation(ctx: AgentContext): Promise<void> {
    await writePending(ctx, null).catch(() => {});
}

// ---- modifica -------------------------------------------------------------

export async function decideModify(args: Record<string, any>, ctx: AgentContext): Promise<ToolDecision> {
    if (!ctx.autonomy?.modify) return { kind: 'propose' };
    const t = await resolveTarget(ctx, args);
    if (t.ok === false) return t.decision;
    const block = await commonBlock(ctx, t.row, 'modify');
    if (block) return proposeBecause(block);
    // Cambiare zona vuol dire cambiare sala: lo decide lo staff.
    if (args.new_location_preference) return proposeBecause('cambio di zona');

    const current = Number(t.row.guests) || 1;
    const guests = args.new_guests !== undefined && args.new_guests !== null ? Number(args.new_guests) : current;
    if (!Number.isInteger(guests) || guests < 1) return proposeBecause('persone non valide');
    if (guests > await bookingTools.largeGroupThreshold(ctx.tenantId)) return proposeBecause('gruppo numeroso');
    if (guests > current && await bookingTools.autoDepositRequired(ctx.tenantId, guests)) return proposeBecause('farebbe scattare la caparra');

    const date = typeof args.new_date === 'string' && args.new_date.trim() ? args.new_date.trim() : t.date;
    const time = typeof args.new_time === 'string' && args.new_time.trim() ? args.new_time.trim() : t.time;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) return proposeBecause('data o ora da interpretare');
    const today = getDatePartInTz(new Date(), t.tz);
    if (date < today || date > addDaysIsoDate(today, GUEST_MODIFY_HORIZON_DAYS)) return proposeBecause('data fuori dai 60 giorni');
    const policy = await getGuestManagePolicy(ctx.tenantId);
    const when = wallClockToInstant(date, time.padStart(5, '0'), t.tz);
    if ((when.getTime() - Date.now()) / 3600_000 < policy.cancel_cutoff_hours) return proposeBecause('nuovo orario troppo vicino');

    return { kind: 'execute', auto: { reservationId: Number(t.row.id) } };
}

/** Gli argomenti della modifica eseguita da sola: con una data nuova e la
 *  stessa ora, l'ora si passa comunque, così lo strumento controlla che stia
 *  sulla griglia di quel giorno (una cena alle 20:30 non esiste di domenica
 *  se la domenica si apre alle 19:00). */
export async function modifyArgsForAuto(args: Record<string, any>, ctx: AgentContext, reservationId: number): Promise<Record<string, any>> {
    if (!args.new_date || args.new_time) return { ...args, reservation_id: reservationId };
    const r = (await queryWithRetry(`SELECT reservation_time FROM reservations WHERE id = $1 AND tenant_id = $2`, [reservationId, ctx.tenantId])).rows[0];
    if (!r) return { ...args, reservation_id: reservationId };
    const tz = (await getTenantLocale(ctx.tenantId)).timezone;
    return { ...args, reservation_id: reservationId, new_time: getTimePartInTz(r.reservation_time, tz) };
}

// ---- prenotazione nuova ---------------------------------------------------

export async function decideCreate(args: Record<string, any>, ctx: AgentContext): Promise<ToolDecision> {
    if (!ctx.autonomy?.create) return { kind: 'propose' };
    const guests = Number(args.guests);
    if (!Number.isInteger(guests) || guests < 1) return { kind: 'execute', auto: { reservationId: null } };
    // Oltre la soglia lo strumento rifiuta da sé e indica la richiamata.
    if (guests <= await bookingTools.largeGroupThreshold(ctx.tenantId)
        && await bookingTools.autoDepositRequired(ctx.tenantId, guests)) {
        return proposeBecause('caparra');
    }
    // Il posto si verifica adesso, qualunque cosa il modello abbia letto
    // prima: fra la domanda del cliente e il suo «sì» la sala può riempirsi.
    const check = (await bookingTools.checkAvailability(ctx.tenantId, {
        date: args.date, shift: args.shift, guests, time: args.time,
        location_preference: args.location_preference, caller_id: ctx.phone,
    }, bookingTools.WHATSAPP_CHANNEL)).body;
    if (check?.available !== true) {
        return { kind: 'refuse', reason: `Non c'è posto così: ${check?.message || 'proponi al cliente un altro orario o giorno, dopo check_availability'}` };
    }
    return { kind: 'execute', auto: { reservationId: null } };
}

// ---- note e allergie ------------------------------------------------------

export async function decideNote(args: Record<string, any>, ctx: AgentContext): Promise<ToolDecision> {
    if (!ctx.autonomy?.notes) return { kind: 'propose' };
    const pick = await pickGuestReservation(ctx.tenantId, ctx.phone, { reservationId: reservationIdOf(args.reservation_id) });
    return { kind: 'execute', auto: { reservationId: pick.status === 'one' ? pick.reservation.id : null } };
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/** Un'azione riuscita nel registro (agent_proposals, auto). */
export async function recordAutoAction(
    tenantId: number, phoneDigits: string, runId: number | null, action: AgentAction, reply: string | null
): Promise<number | null> {
    const r = await queryWithRetry(
        `INSERT INTO agent_proposals
            (tenant_id, phone_digits, tool, args, summary, suggested_reply, status, reservation_id, result,
             auto, run_id, before_state, after_state, resolved_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'DONE', $7, $8::jsonb, TRUE, $9, $10::jsonb, $11::jsonb, NOW())
         RETURNING id`,
        [tenantId, phoneDigits, action.tool, JSON.stringify(action.args), action.summary, reply,
         action.after?.id ?? action.reservationId ?? null, JSON.stringify(action.result), runId,
         action.before ? JSON.stringify(action.before) : null, action.after ? JSON.stringify(action.after) : null]
    );
    return r.rows[0]?.id ?? null;
}

/** Le azioni che si possono annullare: quelle sulle prenotazioni. Note e
 *  allergie si correggono dalla scheda. */
export const UNDOABLE_TOOLS = new Set(['create_reservation', 'modify_reservation', 'cancel_reservation']);

// ---------------------------------------------------------------------------
// Annulla
// ---------------------------------------------------------------------------

export type UndoOutcome =
    | { ok: true; reservationId: number; tool: string; customerName: string }
    | { ok: false; status: number; error: 'not_found' | 'not_undoable' | 'already_undone' | 'changed' | 'past' | 'no_table' };

const sameAsAfter = (cur: any, after: ReservationSnapshot): boolean =>
    new Date(cur.reservation_time).getTime() === new Date(after.reservation_time).getTime()
    && Number(cur.guests) === after.guests
    && (cur.table_id == null ? null : Number(cur.table_id)) === after.table_id
    && String(cur.reservation_status ?? 'CONFIRMED') === after.reservation_status;

/**
 * Rimette la prenotazione com'era prima dell'azione dell'agente. Solo se è
 * ancora esattamente come l'agente l'ha lasciata (se lo staff o l'ospite
 * l'hanno toccata nel frattempo, vince il loro cambiamento) e se l'orario
 * da ripristinare non è passato. Il tavolo di prima torna se è libero,
 * altrimenti uno equivalente; se non ce n'è, non si fa niente e si dice.
 */
export async function undoAutoAction(tenantId: number, actionId: number, userId: number | null, actor: Record<string, any> | null): Promise<UndoOutcome> {
    const a = (await queryWithRetry(
        `SELECT * FROM agent_proposals WHERE id = $1 AND tenant_id = $2 AND auto`,
        [actionId, tenantId]
    )).rows[0];
    if (!a) return { ok: false, status: 404, error: 'not_found' };
    if (a.undone_at) return { ok: false, status: 409, error: 'already_undone' };
    if (!UNDOABLE_TOOLS.has(a.tool) || !a.after_state) return { ok: false, status: 409, error: 'not_undoable' };
    const after = a.after_state as ReservationSnapshot;
    const before = a.before_state as ReservationSnapshot | null;
    const id = Number(after.id);

    // Cosa diventa la prenotazione.
    let restore: { reservation_time: string; shift: string | null; guests: number; children: number; status: string; table_id: number | null };
    if (a.tool === 'create_reservation') {
        restore = { ...after, status: 'CANCELLED', table_id: null };
    } else {
        if (!before) return { ok: false, status: 409, error: 'not_undoable' };
        restore = { ...before, status: before.reservation_status, table_id: before.table_id };
    }
    if (restore.status !== 'CANCELLED' && new Date(restore.reservation_time).getTime() <= Date.now()) {
        return { ok: false, status: 409, error: 'past' };
    }
    if (a.tool === 'create_reservation' && new Date(after.reservation_time).getTime() <= Date.now()) {
        return { ok: false, status: 409, error: 'past' };
    }

    // Il tavolo, fuori dalla transazione come nella modifica dell'ospite:
    // prima quello di prima, poi uno libero con le stesse regole.
    if (restore.status !== 'CANCELLED' && restore.table_id != null && before) {
        const tz = (await getTenantLocale(tenantId)).timezone;
        const found = await findTableForChange(tenantId, {
            reservationId: id,
            currentTableId: before.table_id,
            currentGuests: before.guests,
            date: getDatePartInTz(new Date(before.reservation_time), tz),
            shift: (before.shift as Shift) || Shift.DINNER,
            guests: before.guests,
        });
        if (!found) return { ok: false, status: 409, error: 'no_table' };
        restore.table_id = found.table_id;
    }

    const done = await withOutboxTx(async (tx) => {
        const cur = (await tx.query(
            `SELECT id, customer_name, reservation_time, guests, table_id, COALESCE(reservation_status, 'CONFIRMED') AS reservation_status
               FROM reservations WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
            [id, tenantId]
        )).rows[0];
        if (!cur) return { error: 'not_found' as const };
        if (!sameAsAfter(cur, after)) return { error: 'changed' as const };
        const mark = await tx.query(
            `UPDATE agent_proposals SET undone_at = NOW(), undone_by_user_id = $3
              WHERE id = $1 AND tenant_id = $2 AND undone_at IS NULL RETURNING id`,
            [actionId, tenantId, userId]
        );
        if (!mark.rows[0]) return { error: 'already_undone' as const };
        await tx.query(
            `UPDATE reservations
                SET reservation_time = $3::timestamptz, shift = $4, guests = $5,
                    children = LEAST(COALESCE($6::int, 0), $5), reservation_status = $7::text, table_id = $8,
                    guest_cancelled_at = CASE WHEN $7::text = 'CANCELLED' THEN COALESCE(guest_cancelled_at, NOW()) ELSE NULL END
              WHERE id = $1 AND tenant_id = $2`,
            [id, tenantId, restore.reservation_time, restore.shift, restore.guests, restore.children, restore.status, restore.table_id]
        );
        await outboxEnqueueInTx(tx, tenantId, 'reservation:updated', `reservation:${id}`, { reservation_id: id }, { actor });
        return { customerName: String(cur.customer_name ?? '') };
    });
    if ('error' in done && done.error) {
        const status = done.error === 'not_found' ? 404 : 409;
        return { ok: false, status, error: done.error };
    }
    outboxKick();
    return { ok: true, reservationId: id, tool: a.tool, customerName: 'customerName' in done ? String(done.customerName) : '' };
}
