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

export interface AvailabilityInput {
    date: string;       // YYYY-MM-DD
    shift: Shift;
    guests: number;
}

export interface AvailabilityResult {
    available: boolean;
    free_tables_count: number;
    alternative_shift?: Shift;
    message: string;    // Italian phrase the agent can read aloud
}

/**
 * Free-table count for the given date+shift. Excludes:
 *   - Tables in closed rooms
 *   - Tables already assigned to a reservation on that date+shift
 *   - Tables whose seats are below requested guest count
 */
export async function findAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    const { date, shift, guests } = input;

    const result = await queryWithRetry(`
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
          )
    `, [guests, date, shift]);

    const free = result.rows[0]?.free ?? 0;

    if (free > 0) {
        return {
            available: true,
            free_tables_count: free,
            message: `Sì, abbiamo disponibilità per ${guests} persone.`
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
          )
    `, [guests, date, otherShift]);
    const altFree = altResult.rows[0]?.free ?? 0;

    if (altFree > 0) {
        const altLabel = otherShift === Shift.LUNCH ? 'a pranzo' : 'a cena';
        return {
            available: false,
            free_tables_count: 0,
            alternative_shift: otherShift,
            message: `Mi dispiace, per quella fascia siamo al completo. Posso proporle ${altLabel} dello stesso giorno?`
        };
    }

    return {
        available: false,
        free_tables_count: 0,
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
    notes?: string;
    conversation_id?: string;
}

export interface VoiceReservationOutput {
    id: number;
    customer_name: string;
    reservation_time: string;
    shift: Shift;
    guests: number;
    phone: string;
    requires_review: boolean;
}

/**
 * Insert a reservation with source=VOICE and requires_review=true.
 * Phase 2 of the rollout: every voice booking is flagged for human approval
 * until accuracy metrics let us lift the flag.
 */
export async function createVoiceReservation(
    input: VoiceReservationInput
): Promise<VoiceReservationOutput> {
    const phone = normalizeItalianPhone(input.phone);
    const notes = input.notes
        ? `[Voce] ${input.notes}`
        : '[Voce] Prenotazione creata da agent vocale ElevenLabs';

    const result = await queryWithRetry(`
        INSERT INTO reservations (
            customer_name, reservation_time, shift, guests, phone,
            notes, payment_status, arrival_status, source, requires_review
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'WAITING', $7, true)
        RETURNING id, customer_name, reservation_time, shift, guests, phone, requires_review
    `, [
        input.customer_name.trim(),
        input.reservation_time,
        input.shift,
        input.guests,
        phone,
        notes,
        ReservationSource.VOICE
    ]);

    return result.rows[0];
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
    return `Confermato ${firstName}, tavolo per ${r.guests} ${persone} ${weekday} ${day} ${month} alle ${hh}:${mm}. Le invieremo conferma su WhatsApp.`;
}
