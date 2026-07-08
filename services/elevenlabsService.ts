import crypto from 'crypto';
import type { Request } from 'express';
import { queryWithRetry } from '../db.js';
import { Shift, ReservationSource } from '../types.js';

// ============================================
// HMAC SIGNATURE VERIFICATION
// ============================================

const SIGNATURE_HEADER = 'elevenlabs-signature';
const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes

/**
 * Verify Stripe-style HMAC signature on an ElevenLabs webhook request.
 * Header format: `t=<unix_ts>,v0=<hex_hmac_sha256>`
 * The body MUST be raw (Buffer or string) — JSON.stringify reorders keys
 * and breaks the signature.
 */
export function verifyElevenLabsSignature(
    req: Request & { rawBody?: Buffer | string },
    secret: string
): boolean {
    const header = req.header(SIGNATURE_HEADER);
    if (!header) return false;

    const parts = header.split(',').reduce<Record<string, string>>((acc, kv) => {
        const [k, v] = kv.split('=');
        if (k && v) acc[k.trim()] = v.trim();
        return acc;
    }, {});

    const ts = Number(parts.t);
    const provided = parts.v0;
    if (!ts || !provided) return false;

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (ageSeconds > SIGNATURE_TOLERANCE_SECONDS) return false;

    const raw = req.rawBody ?? JSON.stringify(req.body);
    const payload = `${ts}.${typeof raw === 'string' ? raw : raw.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

    const a = Buffer.from(provided, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
}

// ============================================
// FLEXIBLE DATE / TIME PARSING
// ============================================
// ElevenLabs ASR + LLM sends date/time in many shapes. Accept them all and
// normalize to ISO YYYY-MM-DD / HH:MM before validation. Returns null on
// truly unparseable input — let the caller respond with a clear 400.

const ITALIAN_MONTHS_LOOKUP: Record<string, number> = {
    gennaio: 1, gen: 1,
    febbraio: 2, feb: 2,
    marzo: 3, mar: 3,
    aprile: 4, apr: 4,
    maggio: 5, mag: 5,
    giugno: 6, giu: 6,
    luglio: 7, lug: 7,
    agosto: 8, ago: 8,
    settembre: 9, set: 9, sett: 9,
    ottobre: 10, ott: 10,
    novembre: 11, nov: 11,
    dicembre: 12, dic: 12,
};

function toIsoDate(y: number, mo: number, d: number): string | null {
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // Reject impossible day-of-month (e.g. 31 Feb).
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function parseFlexibleDate(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const s = input.trim();
    if (!s) return null;

    // YYYY-MM-DD (optionally followed by THH:MM:SS) — already canonical.
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return toIsoDate(+m[1], +m[2], +m[3]);

    // YYYY/MM/DD
    m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (m) return toIsoDate(+m[1], +m[2], +m[3]);

    // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY (Italian human format)
    m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/);
    if (m) return toIsoDate(+m[3], +m[2], +m[1]);

    // DD/MM/YY → 20YY
    m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2})(?!\d)/);
    if (m) return toIsoDate(2000 + +m[3], +m[2], +m[1]);

    // "14 maggio 2026" / "14 mag 2026" / "14 maggio" (assume current year)
    m = s.toLowerCase().match(/(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|gen|feb|mar|apr|mag|giu|lug|ago|set|sett|ott|nov|dic)(?:\s+(\d{4}))?/);
    if (m) {
        const day = +m[1];
        const month = ITALIAN_MONTHS_LOOKUP[m[2]];
        const year = m[3] ? +m[3] : new Date().getFullYear();
        return toIsoDate(year, month, day);
    }

    return null;
}

export function parseFlexibleTime(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;

    // 20:30, 20.30, 20-30, 8:05 — explicit hour:minute
    let m = s.match(/(\d{1,2})[:.\-](\d{2})/);
    if (m) {
        const h = +m[1];
        const mm = +m[2];
        if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) {
            return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        }
    }

    // "20 e 30" / "20 e mezza" / "8 e un quarto"
    m = s.match(/(\d{1,2})\s*e\s*(mezza|mezzo|trenta|tre\s*quarti|un\s*quarto|quarto|quindici|quarantacinque|\d{1,2})/);
    if (m) {
        const h = +m[1];
        const minPart = m[2].replace(/\s+/g, ' ');
        let mins: number;
        if (minPart === 'mezza' || minPart === 'mezzo' || minPart === 'trenta') mins = 30;
        else if (minPart === 'un quarto' || minPart === 'quarto' || minPart === 'quindici') mins = 15;
        else if (minPart === 'tre quarti' || minPart === 'quarantacinque') mins = 45;
        else mins = parseInt(minPart) || 0;
        if (h >= 0 && h <= 23 && mins >= 0 && mins <= 59) {
            return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        }
    }

    // Bare hour: "20", "8" → assume :00. Reject if it's clearly something else.
    m = s.match(/^(\d{1,2})$/);
    if (m) {
        const h = +m[1];
        if (h >= 0 && h <= 23) return `${String(h).padStart(2, '0')}:00`;
    }

    return null;
}

// ============================================
// PHONE NUMBER NORMALIZATION
// ============================================

/**
 * Force Italian E.164 format. Voice agents commonly emit phones as
 * "tre tre tre uno due tre quattro cinque sei sette" → ElevenLabs ASR
 * usually transcribes digits, but we still strip whitespace and prepend +39
 * if a leading country code is missing.
 */
export function normalizeItalianPhone(input: string): string {
    if (!input) return '';
    const digits = input.replace(/\D/g, '');
    if (digits.startsWith('00')) return '+' + digits.slice(2);
    if (digits.startsWith('39') && digits.length >= 11) return '+' + digits;
    if (digits.length === 10 && (digits.startsWith('3') || digits.startsWith('0'))) {
        return '+39' + digits;
    }
    return digits.startsWith('+') ? digits : '+' + digits;
}

// ============================================
// AVAILABILITY LOOKUP
// ============================================

export type RoomLocation = 'INDOOR' | 'OUTDOOR';

export interface AvailabilityInput {
    date: string;       // YYYY-MM-DD
    shift: Shift;
    guests: number;
    location_preference?: RoomLocation;
}

export interface AvailabilityResult {
    available: boolean;
    free_tables_count: number;
    free_indoor: number;
    free_outdoor: number;
    alternative_shift?: Shift;
    message: string;    // Italian phrase the agent can read aloud
}

/**
 * Free-table breakdown for the given date+shift, split by room location
 * (INDOOR/OUTDOOR). Excludes:
 *   - Tables in closed rooms
 *   - Tables already assigned to a non-cancelled reservation that date+shift
 *   - Tables whose seats are below requested guest count
 *
 * The agent uses the per-zone counts to negotiate with the caller when their
 * preferred zone is full but the other has space.
 */
export async function findAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    const { date, shift, guests, location_preference } = input;

    const breakdown = await queryWithRetry(`
        SELECT r.location AS location, COUNT(*)::int AS free
        FROM tables t
        JOIN rooms r ON t.room_id = r.id
        WHERE r.is_closed = false
          AND t.seats >= $1
          AND NOT EXISTS (
              SELECT 1 FROM reservations res
              WHERE res.table_id = t.id
                AND DATE(res.reservation_time) = $2
                AND res.shift = $3
                AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
          )
        GROUP BY r.location
    `, [guests, date, shift]);

    let freeIndoor = 0;
    let freeOutdoor = 0;
    for (const row of breakdown.rows) {
        if (row.location === 'INDOOR') freeIndoor = row.free;
        else if (row.location === 'OUTDOOR') freeOutdoor = row.free;
    }
    const freeTotal = freeIndoor + freeOutdoor;

    if (freeTotal > 0) {
        const preferredFree = location_preference === 'INDOOR' ? freeIndoor
            : location_preference === 'OUTDOOR' ? freeOutdoor
            : freeTotal;
        if (preferredFree > 0) {
            const where = location_preference === 'INDOOR' ? " all'interno"
                : location_preference === 'OUTDOOR' ? ' all\'esterno' : '';
            return {
                available: true,
                free_tables_count: freeTotal,
                free_indoor: freeIndoor,
                free_outdoor: freeOutdoor,
                message: `Sì, abbiamo disponibilità${where} per ${guests} persone.`
            };
        }
        // Preferred zone full but the other has space — let the agent propose it.
        const altWhere = location_preference === 'INDOOR' ? "all'esterno" : "all'interno";
        const requestedWhere = location_preference === 'INDOOR' ? "all'interno" : "all'esterno";
        return {
            available: false,
            free_tables_count: freeTotal,
            free_indoor: freeIndoor,
            free_outdoor: freeOutdoor,
            message: `Mi dispiace, ${requestedWhere} è tutto prenotato, ma ${altWhere} abbiamo posto. Le va bene?`
        };
    }

    const otherShift = shift === Shift.LUNCH ? Shift.DINNER : Shift.LUNCH;
    const altResult = await queryWithRetry(`
        SELECT COUNT(*)::int AS free
        FROM tables t
        JOIN rooms r ON t.room_id = r.id
        WHERE r.is_closed = false
          AND t.seats >= $1
          AND NOT EXISTS (
              SELECT 1 FROM reservations res
              WHERE res.table_id = t.id
                AND DATE(res.reservation_time) = $2
                AND res.shift = $3
                AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
          )
    `, [guests, date, otherShift]);
    const altFree = altResult.rows[0]?.free ?? 0;

    if (altFree > 0) {
        const altLabel = otherShift === Shift.LUNCH ? 'a pranzo' : 'a cena';
        return {
            available: false,
            free_tables_count: 0,
            free_indoor: 0,
            free_outdoor: 0,
            alternative_shift: otherShift,
            message: `Mi dispiace, per quella fascia siamo al completo. Posso proporle ${altLabel} dello stesso giorno?`
        };
    }

    return {
        available: false,
        free_tables_count: 0,
        free_indoor: 0,
        free_outdoor: 0,
        message: 'Mi dispiace, per quel giorno siamo al completo. Possiamo provare un altro giorno?'
    };
}

// ============================================
// VOICE RESERVATION CREATION
// ============================================

export interface VoiceReservationInput {
    customer_name: string;
    phone: string;
    reservation_time: string;  // ISO datetime
    shift: Shift;
    guests: number;
    children?: number;
    notes?: string;
    conversation_id?: string;
    location_preference?: RoomLocation;
}

export interface VoiceReservationOutput {
    id: number;
    customer_name: string;
    reservation_time: string;
    shift: Shift;
    guests: number;
    children: number;
    phone: string;
    requires_review: boolean;
    table_id: number | null;
    table_name: string | null;
    room_name: string | null;
    room_location: RoomLocation | null;
}

/**
 * Pick the smallest free table that fits `guests` on the given date+shift,
 * restricted to `locationPreference` when provided. Returns null if nothing
 * matches — the caller saves the reservation with table_id=NULL so a human
 * can place it manually.
 */
async function pickAutoAssignTable(
    date: string,
    shift: Shift,
    guests: number,
    locationPreference: RoomLocation | undefined
): Promise<{ id: number; name: string; room_name: string; location: RoomLocation | null } | null> {
    const params: any[] = [guests, date, shift];
    let locationFilter = '';
    if (locationPreference) {
        params.push(locationPreference);
        locationFilter = ` AND r.location = $${params.length}`;
    }
    const result = await queryWithRetry(`
        SELECT t.id, t.name, r.name AS room_name, r.location
        FROM tables t
        JOIN rooms r ON t.room_id = r.id
        WHERE r.is_closed = false
          AND t.seats >= $1
          ${locationFilter}
          AND NOT EXISTS (
              SELECT 1 FROM reservations res
              WHERE res.table_id = t.id
                AND DATE(res.reservation_time) = $2
                AND res.shift = $3
                AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
          )
        ORDER BY t.seats ASC, t.id ASC
        LIMIT 1
    `, params);
    return result.rows[0] ?? null;
}

/**
 * Insert a reservation with source=VOICE and requires_review=true.
 * Phase 2 of the rollout: every voice booking is flagged for human approval
 * until accuracy metrics let us lift the flag.
 *
 * Auto-assigns a table when one fits the requested location_preference (with
 * hard restriction — agent must negotiate fallback with the caller before
 * calling this). Falls back to table_id=NULL when nothing fits, so the
 * booking is still recorded for manual placement.
 */
export async function createVoiceReservation(
    input: VoiceReservationInput
): Promise<VoiceReservationOutput> {
    const phone = normalizeItalianPhone(input.phone);
    const notes = input.notes
        ? `[Voce] ${input.notes}`
        : '[Voce] Prenotazione creata da agent vocale ElevenLabs';
    const children = Math.max(0, Math.min(Number(input.children) || 0, input.guests));
    const reservationDate = input.reservation_time.slice(0, 10);

    const assigned = await pickAutoAssignTable(
        reservationDate,
        input.shift,
        input.guests,
        input.location_preference
    );

    const result = await queryWithRetry(`
        INSERT INTO reservations (
            customer_name, reservation_time, shift, guests, children, phone,
            notes, payment_status, arrival_status, source, requires_review, table_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', 'WAITING', $8, true, $9)
        RETURNING *
    `, [
        input.customer_name.trim(),
        input.reservation_time,
        input.shift,
        input.guests,
        children,
        phone,
        notes,
        ReservationSource.VOICE,
        assigned?.id ?? null
    ]);

    const row = result.rows[0];
    return {
        ...row,
        table_name: assigned?.name ?? null,
        room_name: assigned?.room_name ?? null,
        room_location: assigned?.location ?? null,
    };
}

// ============================================
// VOICE RESERVATION CANCELLATION
// ============================================

export interface CancelVoiceReservationInput {
    phone: string;          // raw input — will be normalized
    date: string;           // YYYY-MM-DD
    time?: string;          // HH:MM, used to disambiguate when caller has >1 booking that day
    conversation_id?: string;
}

export interface CancelCandidate {
    id: number;
    customer_name: string;
    reservation_time: string;
    shift: Shift;
    guests: number;
}

export type CancelVoiceReservationOutput =
    | { status: 'cancelled'; reservation: CancelCandidate }
    | { status: 'already_cancelled'; reservation: CancelCandidate }
    | { status: 'not_found' }
    | { status: 'ambiguous'; candidates: CancelCandidate[] };

/**
 * Soft-cancel a reservation booked by `phone` on `date`. Sets
 * reservation_status='CANCELLED' rather than deleting the row, so the
 * audit trail (and the link in voice_calls) is preserved.
 *
 * Matching rules:
 *   - Phone is normalized to E.164 (+39…) before comparing.
 *   - Only non-cancelled reservations for the given date are considered.
 *   - If `time` is provided it must match exactly (HH:MM); otherwise we
 *     require a single non-cancelled booking on that date.
 *   - Returns 'ambiguous' (with candidates) if the caller has more than
 *     one booking that day and no time was provided.
 */
export async function cancelVoiceReservation(
    input: CancelVoiceReservationInput
): Promise<CancelVoiceReservationOutput> {
    const phone = normalizeItalianPhone(input.phone);

    const params: any[] = [phone, input.date];
    let sql = `
        SELECT id, customer_name, reservation_time, shift, guests
        FROM reservations
        WHERE phone = $1
          AND DATE(reservation_time) = $2::date
          AND COALESCE(reservation_status, 'CONFIRMED') <> 'CANCELLED'
    `;
    if (input.time) {
        sql += ` AND to_char(reservation_time, 'HH24:MI') = $3`;
        params.push(input.time);
    }
    sql += ' ORDER BY reservation_time ASC';

    const matches = await queryWithRetry(sql, params);
    const rows: CancelCandidate[] = matches.rows;

    if (rows.length === 0) {
        // Nothing active to cancel — check whether the caller is asking us to
        // cancel something we already cancelled (common after a dashboard test
        // or a duplicate call). Same filters as above but allowing the
        // CANCELLED status, so we can tell the caller it's already done.
        const cancelledParams: any[] = [phone, input.date];
        let cancelledSql = `
            SELECT id, customer_name, reservation_time, shift, guests
            FROM reservations
            WHERE phone = $1
              AND DATE(reservation_time) = $2::date
              AND COALESCE(reservation_status, 'CONFIRMED') = 'CANCELLED'
        `;
        if (input.time) {
            cancelledSql += ` AND to_char(reservation_time, 'HH24:MI') = $3`;
            cancelledParams.push(input.time);
        }
        cancelledSql += ' ORDER BY reservation_time DESC LIMIT 1';
        const cancelledResult = await queryWithRetry(cancelledSql, cancelledParams);
        if (cancelledResult.rows.length > 0) {
            return { status: 'already_cancelled', reservation: cancelledResult.rows[0] };
        }
        return { status: 'not_found' };
    }
    if (rows.length > 1) return { status: 'ambiguous', candidates: rows };

    const target = rows[0];
    const updated = await queryWithRetry(`
        UPDATE reservations
        SET reservation_status = 'CANCELLED'
        WHERE id = $1
        RETURNING id, customer_name, reservation_time, shift, guests
    `, [target.id]);

    return { status: 'cancelled', reservation: updated.rows[0] };
}

/**
 * Short Italian phrase the agent can read after a successful cancellation.
 * Example: "Cancellazione confermata Mario, prenotazione di giovedì 14 maggio
 * alle 20:30 annullata. Le invieremo conferma su WhatsApp."
 */
export function formatItalianCancellation(r: CancelCandidate): string {
    const d = new Date(r.reservation_time);
    const weekday = ITALIAN_WEEKDAYS[d.getDay()];
    const day = d.getDate();
    const month = ITALIAN_MONTHS[d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const firstName = r.customer_name.split(' ')[0];
    return `Cancellazione confermata ${firstName}, la prenotazione di ${weekday} ${day} ${month} alle ${hh}:${mm} è stata annullata. Le invieremo conferma su WhatsApp.`;
}

// ============================================
// VOICE CALL AUDIT
// ============================================

export interface VoiceCallRecord {
    conversation_id: string;
    phone?: string;
    duration_seconds?: number;
    transcript?: string;
    summary?: string;
    reservation_id?: number;
}

export async function recordVoiceCall(record: VoiceCallRecord): Promise<void> {
    await queryWithRetry(`
        INSERT INTO voice_calls (conversation_id, phone, duration_seconds, transcript, summary, reservation_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (conversation_id) DO UPDATE SET
            phone = COALESCE(EXCLUDED.phone, voice_calls.phone),
            duration_seconds = COALESCE(EXCLUDED.duration_seconds, voice_calls.duration_seconds),
            transcript = COALESCE(EXCLUDED.transcript, voice_calls.transcript),
            summary = COALESCE(EXCLUDED.summary, voice_calls.summary),
            reservation_id = COALESCE(EXCLUDED.reservation_id, voice_calls.reservation_id)
    `, [
        record.conversation_id,
        record.phone ?? null,
        record.duration_seconds ?? null,
        record.transcript ?? null,
        record.summary ?? null,
        record.reservation_id ?? null
    ]);
}

// ============================================
// ITALIAN CONFIRMATION FORMATTING
// ============================================

const ITALIAN_WEEKDAYS = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const ITALIAN_MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
                        'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/**
 * Short Italian phrase the agent can read aloud at end of call.
 * Example: "Confermato Mario, tavolo per 4 persone giovedì 7 maggio alle 20:30."
 */
export function formatItalianConfirmation(r: VoiceReservationOutput): string {
    const d = new Date(r.reservation_time);
    const weekday = ITALIAN_WEEKDAYS[d.getDay()];
    const day = d.getDate();
    const month = ITALIAN_MONTHS[d.getMonth()];
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const persone = r.guests === 1 ? 'persona' : 'persone';
    const firstName = r.customer_name.split(' ')[0];
    const childrenSuffix = r.children && r.children > 0
        ? ` di cui ${r.children} ${r.children === 1 ? 'bambino' : 'bambini'}`
        : '';
    return `Confermato ${firstName}, tavolo per ${r.guests} ${persone}${childrenSuffix} ${weekday} ${day} ${month} alle ${hh}:${mm}. Le invieremo conferma su WhatsApp.`;
}
