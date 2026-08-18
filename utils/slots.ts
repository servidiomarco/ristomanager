import { queryWithRetry } from '../db.js';
import { Shift } from '../types.js';

// ============================================
// CONFIGURABLE SLOT GRID
// ============================================
// Slots are derived from the `opening_hours` table (per weekday open/close
// times + slot step) and filtered by `special_closures`. Both tables are
// seeded in db.ts. JS getDay() and Postgres extract(dow) share the same
// convention: 0=Sunday … 6=Saturday.

export interface OpeningHoursRow {
    weekday: number;
    lunch_open: string | null;   // 'HH:MM' or null
    lunch_close: string | null;
    dinner_open: string | null;
    dinner_close: string | null;
    slot_minutes: number;
    // Blacklist di slot HH:MM da nascondere per questo weekday+turno. Popolata
    // da opening_hours_disabled_slots — vedi getAvailableSlots().
    disabled_lunch_slots: string[];
    disabled_dinner_slots: string[];
}

export interface SpecialClosureRow {
    id: number;
    date: string;            // YYYY-MM-DD
    shift: Shift | null;     // null = whole-day closure
    reason: string | null;
}

function isoDateToWeekday(date: string): number {
    return new Date(date + 'T00:00:00').getDay();
}

function generateSlots(open: string, close: string, stepMinutes: number): string[] {
    const [oh, om] = open.split(':').map(Number);
    const [ch, cm] = close.split(':').map(Number);
    const startMin = oh * 60 + om;
    const endMin = ch * 60 + cm;
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || stepMinutes <= 0) return [];
    const out: string[] = [];
    for (let m = startMin; m <= endMin; m += stepMinutes) {
        const h = Math.floor(m / 60);
        const mm = m % 60;
        out.push(`${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`);
    }
    return out;
}

// Aggregate disabled_slots per (weekday, shift). Doing this in SQL con
// array_agg + FILTER evita una seconda query per ogni row di opening_hours.
// Il JOIN sui disabled slots vincola anche il tenant: senza `d.tenant_id =
// h.tenant_id` gli slot spenti di un ristorante sparirebbero dal calendario
// di tutti gli altri.
const OPENING_HOURS_SELECT = `
    SELECT h.weekday,
           to_char(h.lunch_open,  'HH24:MI') AS lunch_open,
           to_char(h.lunch_close, 'HH24:MI') AS lunch_close,
           to_char(h.dinner_open, 'HH24:MI') AS dinner_open,
           to_char(h.dinner_close,'HH24:MI') AS dinner_close,
           h.slot_minutes,
           COALESCE(
               array_agg(to_char(d.slot_time, 'HH24:MI') ORDER BY d.slot_time)
                   FILTER (WHERE d.shift = 'LUNCH'),
               '{}'
           ) AS disabled_lunch_slots,
           COALESCE(
               array_agg(to_char(d.slot_time, 'HH24:MI') ORDER BY d.slot_time)
                   FILTER (WHERE d.shift = 'DINNER'),
               '{}'
           ) AS disabled_dinner_slots
    FROM opening_hours h
    LEFT JOIN opening_hours_disabled_slots d
           ON d.tenant_id = h.tenant_id AND d.weekday = h.weekday
`;

// GROUP BY su (tenant_id, weekday): con la PK composita il solo weekday non
// basta più a Postgres per la dipendenza funzionale delle altre colonne.
export async function getOpeningHours(tenantId: number, weekday: number): Promise<OpeningHoursRow | null> {
    const result = await queryWithRetry(
        `${OPENING_HOURS_SELECT} WHERE h.tenant_id = $1 AND h.weekday = $2 GROUP BY h.tenant_id, h.weekday`,
        [tenantId, weekday]
    );
    return result.rows[0] ?? null;
}

export async function getAllOpeningHours(tenantId: number): Promise<OpeningHoursRow[]> {
    const result = await queryWithRetry(
        `${OPENING_HOURS_SELECT} WHERE h.tenant_id = $1 GROUP BY h.tenant_id, h.weekday ORDER BY h.weekday ASC`,
        [tenantId]
    );
    return result.rows;
}

/**
 * Returns true if the date+shift is marked closed in special_closures.
 * A row with shift=NULL closes the entire day for both shifts.
 */
export async function isShiftClosed(tenantId: number, date: string, shift: Shift): Promise<boolean> {
    const result = await queryWithRetry(
        `SELECT 1 FROM special_closures
         WHERE tenant_id = $1 AND date = $2::date AND (shift IS NULL OR shift = $3)
         LIMIT 1`,
        [tenantId, date, shift]
    );
    return result.rows.length > 0;
}

export async function listClosures(tenantId: number, fromDate?: string): Promise<SpecialClosureRow[]> {
    const params: any[] = [tenantId];
    let sql = `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, shift, reason
               FROM special_closures
               WHERE tenant_id = $1`;
    if (fromDate) {
        sql += ` AND date >= $2::date`;
        params.push(fromDate);
    }
    sql += ` ORDER BY date ASC, shift NULLS FIRST`;
    const result = await queryWithRetry(sql, params);
    return result.rows;
}

/**
 * All allowed booking slots for a given date+shift.
 * Returns [] if the weekday has no configured hours for that shift,
 * or if the date is closed (whole-day or shift-specific) via special_closures.
 */
export async function getAvailableSlots(tenantId: number, date: string, shift: Shift): Promise<string[]> {
    const weekday = isoDateToWeekday(date);
    const hours = await getOpeningHours(tenantId, weekday);
    if (!hours) return [];

    const open  = shift === Shift.LUNCH ? hours.lunch_open  : hours.dinner_open;
    const close = shift === Shift.LUNCH ? hours.lunch_close : hours.dinner_close;
    if (!open || !close) return [];

    if (await isShiftClosed(tenantId, date, shift)) return [];

    const disabled = new Set(
        shift === Shift.LUNCH ? hours.disabled_lunch_slots : hours.disabled_dinner_slots
    );
    return generateSlots(open, close, hours.slot_minutes).filter(s => !disabled.has(s));
}

export async function isValidSlotForShift(tenantId: number, time: string, date: string, shift: Shift): Promise<boolean> {
    const slots = await getAvailableSlots(tenantId, date, shift);
    return slots.includes(time);
}

/**
 * Italian list rendering for an array of HH:MM slot strings.
 * Example: ["19:30","20:00","20:30"] → "19:30, 20:00 o 20:30"
 */
export function formatSlotListItalian(slots: readonly string[]): string {
    if (slots.length === 0) return '';
    if (slots.length === 1) return slots[0];
    const head = slots.slice(0, -1).join(', ');
    return `${head} o ${slots[slots.length - 1]}`;
}
