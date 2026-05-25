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

export async function getOpeningHours(weekday: number): Promise<OpeningHoursRow | null> {
    const result = await queryWithRetry(
        `SELECT weekday,
                to_char(lunch_open,  'HH24:MI') AS lunch_open,
                to_char(lunch_close, 'HH24:MI') AS lunch_close,
                to_char(dinner_open, 'HH24:MI') AS dinner_open,
                to_char(dinner_close,'HH24:MI') AS dinner_close,
                slot_minutes
         FROM opening_hours
         WHERE weekday = $1`,
        [weekday]
    );
    return result.rows[0] ?? null;
}

export async function getAllOpeningHours(): Promise<OpeningHoursRow[]> {
    const result = await queryWithRetry(
        `SELECT weekday,
                to_char(lunch_open,  'HH24:MI') AS lunch_open,
                to_char(lunch_close, 'HH24:MI') AS lunch_close,
                to_char(dinner_open, 'HH24:MI') AS dinner_open,
                to_char(dinner_close,'HH24:MI') AS dinner_close,
                slot_minutes
         FROM opening_hours
         ORDER BY weekday ASC`
    );
    return result.rows;
}

/**
 * Returns true if the date+shift is marked closed in special_closures.
 * A row with shift=NULL closes the entire day for both shifts.
 */
export async function isShiftClosed(date: string, shift: Shift): Promise<boolean> {
    const result = await queryWithRetry(
        `SELECT 1 FROM special_closures
         WHERE date = $1::date AND (shift IS NULL OR shift = $2)
         LIMIT 1`,
        [date, shift]
    );
    return result.rows.length > 0;
}

export async function listClosures(fromDate?: string): Promise<SpecialClosureRow[]> {
    const params: any[] = [];
    let sql = `SELECT id, to_char(date, 'YYYY-MM-DD') AS date, shift, reason
               FROM special_closures`;
    if (fromDate) {
        sql += ` WHERE date >= $1::date`;
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
export async function getAvailableSlots(date: string, shift: Shift): Promise<string[]> {
    const weekday = isoDateToWeekday(date);
    const hours = await getOpeningHours(weekday);
    if (!hours) return [];

    const open  = shift === Shift.LUNCH ? hours.lunch_open  : hours.dinner_open;
    const close = shift === Shift.LUNCH ? hours.lunch_close : hours.dinner_close;
    if (!open || !close) return [];

    if (await isShiftClosed(date, shift)) return [];

    return generateSlots(open, close, hours.slot_minutes);
}

export async function isValidSlotForShift(time: string, date: string, shift: Shift): Promise<boolean> {
    const slots = await getAvailableSlots(date, shift);
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
