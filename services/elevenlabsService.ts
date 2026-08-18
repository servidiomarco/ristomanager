import crypto from 'crypto';
import type { Request } from 'express';
import { queryWithRetry } from '../db.js';
import { Shift, ReservationSource } from '../types.js';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime.js';
import { getAvailableSlots } from '../utils/slots.js';
import { getCappedRoomIds, pickSelfServiceTable, isTableStillAssignable } from './roomOccupancyService.js';

// ============================================
// HMAC SIGNATURE VERIFICATION
// ============================================

// Tenant del canale vocale: le chiamate arrivano da webhook senza JWT, quindi
// non c'è un req.tenantId da leggere. Finché la Fase C3 non ricava il tenant
// dal numero chiamato, tutta la voce appartiene al tenant 1 (stesso valore di
// PUBLIC_TENANT_ID in server.ts — non importabile da qui: ciclo di moduli).
const VOICE_TENANT_ID = 1;

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

// weekday index matches Date#getUTCDay(): 0=Sunday, 6=Saturday.
const ITALIAN_WEEKDAY_LOOKUP: Record<string, number> = {
    domenica: 0,
    lunedi: 1, 'lunedì': 1,
    martedi: 2, 'martedì': 2,
    mercoledi: 3, 'mercoledì': 3,
    giovedi: 4, 'giovedì': 4,
    venerdi: 5, 'venerdì': 5,
    sabato: 6,
};

// English lookups — the voice agent switches to English for non-Italian
// callers and passes date words verbatim ("tomorrow", "this Friday",
// "August 15"), so the parser must accept both languages. Abbreviations
// that collide with Italian (mar/apr/nov) map to the same month anyway.
const ENGLISH_MONTHS_LOOKUP: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9, sept: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
};
const ENGLISH_MONTH_RE = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';

const ENGLISH_WEEKDAY_LOOKUP: Record<string, number> = {
    sunday: 0, monday: 1, tuesday: 2, wednesday: 3,
    thursday: 4, friday: 5, saturday: 6,
};

const ITALIAN_WEEKDAY_NAMES = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const ITALIAN_MONTH_NAMES = [
    'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
    'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

function toIsoDate(y: number, mo: number, d: number): string | null {
    if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    // Reject impossible day-of-month (e.g. 31 Feb).
    const probe = new Date(Date.UTC(y, mo - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
    return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Today in Europe/Rome (server may run in UTC on Railway). Returned as a
// UTC-anchored Date at 00:00Z so arithmetic on it stays trivial.
function getRomeTodayUtc(): Date {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Rome',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === 'year')!.value;
    const m = parts.find(p => p.type === 'month')!.value;
    const d = parts.find(p => p.type === 'day')!.value;
    return new Date(`${y}-${m}-${d}T00:00:00Z`);
}

function utcDateToIso(d: Date): string {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Italian day-name + day-of-month readback, e.g. "venerdì 10 luglio".
 * The agent reads this string verbatim so we never rely on the LLM to
 * compute the weekday from a date — that's the class of error where it
 * confidently says "venerdì 11 luglio" when Friday is actually the 10th.
 */
export function formatItalianDateReadback(iso: string): string {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return iso;
    const y = +m[1], mo = +m[2], d = +m[3];
    const date = new Date(Date.UTC(y, mo - 1, d));
    const weekday = ITALIAN_WEEKDAY_NAMES[date.getUTCDay()];
    const month = ITALIAN_MONTH_NAMES[mo - 1];
    return `${weekday} ${d} ${month}`;
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

    // English day-first: "15 August", "15th of August 2026"
    m = s.toLowerCase().match(new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+(${ENGLISH_MONTH_RE})(?:\\s+(\\d{4}))?`));
    if (m) {
        const day = +m[1];
        const month = ENGLISH_MONTHS_LOOKUP[m[2]];
        const year = m[3] ? +m[3] : new Date().getFullYear();
        return toIsoDate(year, month, day);
    }

    // English month-first: "August 15", "August 15th, 2026"
    m = s.toLowerCase().match(new RegExp(`(${ENGLISH_MONTH_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`));
    if (m) {
        const month = ENGLISH_MONTHS_LOOKUP[m[1]];
        const day = +m[2];
        const year = m[3] ? +m[3] : new Date().getFullYear();
        return toIsoDate(year, month, day);
    }

    // Relative Italian phrases: "oggi" / "stasera" / "domani" / "dopodomani" /
    // "venerdì" / "venerdì prossimo" / "sabato che viene".
    // The agent is instructed to pass these verbatim instead of doing the
    // date math itself — LLMs are unreliable at weekday↔date arithmetic.
    const lower = s.toLowerCase();
    const today = getRomeTodayUtc();

    // "day after tomorrow" must be checked before "tomorrow".
    if (/\bdopodomani\b/.test(lower) || /\bday\s+after\s+tomorrow\b/.test(lower)) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() + 2);
        return utcDateToIso(d);
    }
    if (/\bdomani\b/.test(lower) || /\btomorrow\b/.test(lower)) {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() + 1);
        return utcDateToIso(d);
    }
    if (/\b(oggi|stasera|stanotte|questa\s+sera|questa\s+notte|today|tonight|this\s+evening)\b/.test(lower)) {
        return utcDateToIso(today);
    }

    // Bare weekday (Italian or English), optionally with "prossimo" /
    // "che viene" / "next" to force the *following* week when today matches
    // the requested weekday. "this Friday" = nearest upcoming, like bare.
    // Match on the accent-folded string: JS \b is ASCII-only, so
    // /\bvenerdì\b/ never matches (ì is not a word char) — folding both
    // sides ("venerdì" → "venerdi") sidesteps the problem entirely.
    const foldedLower = lower.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const WEEKDAY_LOOKUPS = { ...ITALIAN_WEEKDAY_LOOKUP, ...ENGLISH_WEEKDAY_LOOKUP };
    for (const word of Object.keys(WEEKDAY_LOOKUPS)) {
        const folded = word.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const wRe = new RegExp(`\\b${folded}\\b`);
        if (wRe.test(foldedLower)) {
            const target = WEEKDAY_LOOKUPS[word];
            const forceNext = /\bprossim[oa]\b|\bche\s+viene\b|\bnext\b/.test(lower);
            const currentDow = today.getUTCDay();
            let diff = (target - currentDow + 7) % 7;
            if (diff === 0 && forceNext) diff = 7;
            const d = new Date(today);
            d.setUTCDate(d.getUTCDate() + diff);
            return utcDateToIso(d);
        }
    }

    return null;
}

export function parseFlexibleTime(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const s = input.trim().toLowerCase();
    if (!s) return null;

    // English am/pm: "8:30 pm", "8 pm", "8.30pm", "12 am". MUST run before
    // the generic hour:minute regex, which would otherwise read "8:30 pm"
    // as 08:30 and silently book a morning table.
    let m = s.match(/(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/);
    if (m) {
        let h = +m[1];
        const mm = m[2] ? +m[2] : 0;
        const isPm = m[3].startsWith('p');
        if (h >= 1 && h <= 12 && mm >= 0 && mm <= 59) {
            if (isPm && h < 12) h += 12;
            if (!isPm && h === 12) h = 0;
            return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
        }
    }

    // "half past eight" / "quarter past 8" / "quarter to nine" — the hour
    // can arrive as a digit or spelled out.
    const HOUR_WORDS: Record<string, number> = {
        one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
        seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
    };
    m = s.match(/\b(half|quarter)\s+(past|to)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/);
    if (m) {
        const mins = m[1] === 'half' ? 30 : 15;
        let h = /^\d/.test(m[3]) ? +m[3] : HOUR_WORDS[m[3]];
        if (h >= 0 && h <= 23) {
            if (m[2] === 'to') {
                h = (h - 1 + 24) % 24;
                return `${String(h).padStart(2, '0')}:${String(60 - mins).padStart(2, '0')}`;
            }
            return `${String(h).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
        }
    }

    // 20:30, 20.30, 20-30, 8:05 — explicit hour:minute
    m = s.match(/(\d{1,2})[:.\-](\d{2})/);
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

/**
 * Last 10 digits of a phone number — the suffix shared by "+39 366 1234567",
 * "3661234567" and "0039366…". Lookups on `reservations.phone` must use this
 * (never string equality): the staff types numbers in local format, the
 * caller id arrives in E.164, and the two never compare equal verbatim.
 */
export function lastTenDigits(input: string): string {
    return String(input ?? '').replace(/\D/g, '').slice(-10);
}

/**
 * Pre-render an Italian-language digit-by-digit readback for a phone number.
 *
 * ElevenLabs voice models are unreliable at speaking digit sequences: even
 * when the system prompt hands them the caller_id verbatim they can hallucinate
 * a wrong prefix mid-utterance (e.g. saying "tre-tre-cinque" instead of
 * "tre-quattro-sette"). We work around that by pre-computing the exact spoken
 * form here and telling the agent to read *this string* verbatim rather than
 * generate it from the raw phone number.
 *
 * Format: 10 mobile digits grouped 3-3-4 (matches how Italians usually dictate
 * a mobile number), country prefix included when present. Digits are separated
 * by hyphens inside a group so ElevenLabs' TTS pauses briefly between them.
 * Example: "+393477837689" → "più tre-nove, tre-quattro-sette, sette-otto-tre,
 * sette-sei-otto-nove".
 */
export function spellItalianPhoneDigits(phone: string): string {
    if (!phone) return '';
    const digitsToWords: Record<string, string> = {
        '0': 'zero', '1': 'uno', '2': 'due', '3': 'tre', '4': 'quattro',
        '5': 'cinque', '6': 'sei', '7': 'sette', '8': 'otto', '9': 'nove',
    };
    const spellGroup = (chunk: string): string =>
        chunk.split('').map(d => digitsToWords[d] ?? d).join('-');

    const trimmed = phone.trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    if (!digits) return '';

    const groups: string[] = [];

    // Italian mobile: country code (2 digits) + 10 digits grouped 3-3-4.
    // Landline lengths vary; fall back to a plain 3-digit grouping.
    if (digits.length >= 12 && digits.startsWith('39')) {
        groups.push(digits.slice(0, 2));                    // 39
        groups.push(digits.slice(2, 5));                    // 3XX
        groups.push(digits.slice(5, 8));                    // XXX
        groups.push(digits.slice(8));                       // last
    } else if (digits.length === 10 && digits.startsWith('3')) {
        groups.push(digits.slice(0, 3));
        groups.push(digits.slice(3, 6));
        groups.push(digits.slice(6));
    } else {
        for (let i = 0; i < digits.length; i += 3) {
            groups.push(digits.slice(i, i + 3));
        }
    }

    const spelled = groups.map(spellGroup).join(', ');
    return hasPlus ? `più ${spelled}` : spelled;
}

// ============================================
// CUSTOMER LOOKUP BY PHONE
// ============================================

export interface CustomerLookupResult {
    exists: boolean;
    customer_id?: number;
    customer_name?: string;
    first_name?: string;
    last_visit?: string; // ISO date of most recent non-cancelled reservation, if any
}

/**
 * Match `phone` against the customers table on last-10-digits — same rule used
 * by upsertCustomerFromReservation, so "+39 333 1234567" and "3331234567"
 * collide. Also fetches the most recent non-cancelled reservation date so the
 * agent can greet returning callers with "bentornato".
 */
export async function findCustomerByPhone(phone: string): Promise<CustomerLookupResult> {
    if (!phone) return { exists: false };
    const digits = phone.replace(/\D/g, '');
    if (!digits) return { exists: false };
    const last10 = digits.slice(-10);

    const result = await queryWithRetry(
        `SELECT id, name
         FROM customers
         WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
         ORDER BY id ASC
         LIMIT 1`,
        [last10]
    );
    if (result.rows.length === 0) return { exists: false };

    const row = result.rows[0];
    const customerName: string = (row.name || '').trim();
    const firstName = customerName.split(/\s+/)[0] || customerName;

    // Best-effort last visit — used only for the greeting phrase, never blocks.
    let lastVisit: string | undefined;
    try {
        const visit = await queryWithRetry(
            `SELECT reservation_time
             FROM reservations
             WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
               AND COALESCE(reservation_status, 'CONFIRMED') <> 'CANCELLED'
               AND reservation_time < CURRENT_TIMESTAMP
             ORDER BY reservation_time DESC
             LIMIT 1`,
            [last10]
        );
        if (visit.rows.length > 0) {
            const dt = new Date(visit.rows[0].reservation_time);
            lastVisit = utcDateToIso(new Date(Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate())));
        }
    } catch (err) {
        console.warn('[ElevenLabs] findCustomerByPhone last_visit lookup failed:', (err as Error)?.message || err);
    }

    return {
        exists: true,
        customer_id: row.id,
        customer_name: customerName,
        first_name: firstName,
        last_visit: lastVisit,
    };
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
 *   - Tables in rooms that already hit their self-service occupancy cap
 *     (Settings → Canali di prenotazione)
 *   - Tables already assigned to a non-cancelled reservation that date+shift
 *   - Tables whose seats are below requested guest count
 *
 * The agent uses the per-zone counts to negotiate with the caller when their
 * preferred zone is full but the other has space.
 */
// True when `date` is today in Rome and the shift's service is already over
// (every slot is in the past, or the shift has no slots that weekday). Guards
// the alternative-shift suggestion so a caller at 18:00 whose dinner is full
// isn't offered lunch "of the same day" — lunch has long ended. Only ever
// true for today; future dates are never "over".
async function isShiftAlreadyOverToday(date: string, shift: Shift): Promise<boolean> {
    if (date !== getRomeDatePart(new Date())) return false;
    const nowTime = getRomeTimePart(new Date()); // HH:MM, 24h Rome
    const slots = await getAvailableSlots(VOICE_TENANT_ID, date, shift);
    // Zero-padded 24h strings compare correctly lexicographically. Empty slot
    // list (shift closed that weekday) → nothing left to offer.
    return slots.every(s => s <= nowTime);
}

export async function findAvailability(input: AvailabilityInput): Promise<AvailabilityResult> {
    const { date, shift, guests, location_preference } = input;
    const cappedRooms = await getCappedRoomIds(VOICE_TENANT_ID, date, shift);

    const breakdown = await queryWithRetry(`
        SELECT r.location AS location, COUNT(*)::int AS free
        FROM tables t
        JOIN rooms r ON t.room_id = r.id
        WHERE r.is_closed = false
          AND NOT (r.id = ANY($4::int[]))
          AND r.id NOT IN (
              SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3
          )
          AND t.id NOT IN (
              SELECT table_id FROM table_hidden_overrides WHERE date = $2 AND shift = $3
          )
          AND t.seats >= $1
          AND NOT EXISTS (
              SELECT 1 FROM reservations res
              WHERE res.table_id = t.id
                AND DATE(res.reservation_time) = $2
                AND res.shift = $3
                AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM table_merges tm
              WHERE tm.date = $2 AND tm.shift = $3
                AND (tm.primary_id = t.id OR t.id = ANY(tm.merged_ids))
          )
        GROUP BY r.location
    `, [guests, date, shift, cappedRooms]);

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
    // I cap si misurano per turno: l'altro turno ha la sua occupazione.
    const cappedRoomsAlt = await getCappedRoomIds(VOICE_TENANT_ID, date, otherShift);
    const altResult = await queryWithRetry(`
        SELECT COUNT(*)::int AS free
        FROM tables t
        JOIN rooms r ON t.room_id = r.id
        WHERE r.is_closed = false
          AND NOT (r.id = ANY($4::int[]))
          AND r.id NOT IN (
              SELECT room_id FROM room_closed_overrides WHERE date = $2 AND shift = $3
          )
          AND t.id NOT IN (
              SELECT table_id FROM table_hidden_overrides WHERE date = $2 AND shift = $3
          )
          AND t.seats >= $1
          AND NOT EXISTS (
              SELECT 1 FROM reservations res
              WHERE res.table_id = t.id
                AND DATE(res.reservation_time) = $2
                AND res.shift = $3
                AND COALESCE(res.reservation_status, 'CONFIRMED') <> 'CANCELLED'
          )
          AND NOT EXISTS (
              SELECT 1 FROM table_merges tm
              WHERE tm.date = $2 AND tm.shift = $3
                AND (tm.primary_id = t.id OR t.id = ANY(tm.merged_ids))
          )
    `, [guests, date, otherShift, cappedRoomsAlt]);
    const altFree = altResult.rows[0]?.free ?? 0;

    // Only offer the other shift if it hasn't already passed today — otherwise
    // a 18:00 caller with a full dinner would be told "posso proporle a pranzo
    // dello stesso giorno?", which is nonsensical.
    if (altFree > 0 && !(await isShiftAlreadyOverToday(date, otherShift))) {
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
    // Auto-deposit policy hit (large group + policy enabled): the booking is
    // saved PENDING with no table — the table is guaranteed only when the
    // deposit is paid, same rule as the web channel. The payment-completion
    // webhook flips PENDING→CONFIRMED.
    deposit_required?: boolean;
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
 * restricted to `locationPreference` when provided. Rooms already at their
 * self-service occupancy cap are skipped, so a voice booking can't land in
 * the room the operator meant to protect. Returns null if nothing matches —
 * the caller saves the reservation with table_id=NULL so a human can place
 * it manually.
 */
async function pickAutoAssignTable(
    date: string,
    shift: Shift,
    guests: number,
    locationPreference: RoomLocation | undefined
): Promise<{ id: number; name: string; room_name: string; location: RoomLocation | null } | null> {
    const picked = await pickSelfServiceTable(VOICE_TENANT_ID, date, shift, guests, { location: locationPreference });
    if (!picked) return null;
    return { id: picked.id, name: picked.name, room_name: picked.room_name, location: picked.location };
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

    // No table while a deposit is pending: assigning one would guarantee the
    // very thing the deposit exists to secure.
    const assigned = input.deposit_required ? null : await pickAutoAssignTable(
        reservationDate,
        input.shift,
        input.guests,
        input.location_preference
    );

    const result = await queryWithRetry(`
        INSERT INTO reservations (
            customer_name, reservation_time, shift, guests, children, phone,
            notes, payment_status, arrival_status, source, requires_review, table_id,
            reservation_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', 'WAITING', $8, true, $9, $10)
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
        assigned?.id ?? null,
        input.deposit_required ? 'PENDING' : 'CONFIRMED'
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
    /** Presente solo nel `before` delle modifiche: serve all'audit log per
     *  rendere visibile un eventuale cambio tavolo. */
    table_id?: number | null;
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
 *   - Phone matches on last-10-digits (same rule as findCustomerByPhone):
 *     the row may hold the number as typed by the staff, without +39.
 *   - Only non-cancelled reservations for the given date are considered.
 *   - If `time` is provided it must match exactly (HH:MM); otherwise we
 *     require a single non-cancelled booking on that date.
 *   - Returns 'ambiguous' (with candidates) if the caller has more than
 *     one booking that day and no time was provided.
 */
export async function cancelVoiceReservation(
    input: CancelVoiceReservationInput
): Promise<CancelVoiceReservationOutput> {
    const last10 = lastTenDigits(input.phone);

    const params: any[] = [last10, input.date];
    let sql = `
        SELECT id, customer_name, reservation_time, shift, guests
        FROM reservations
        WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
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
        const cancelledParams: any[] = [last10, input.date];
        let cancelledSql = `
            SELECT id, customer_name, reservation_time, shift, guests
            FROM reservations
            WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
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
    const rome = romeWallClock(r.reservation_time);
    const firstName = r.customer_name.split(' ')[0];
    return `Cancellazione confermata ${firstName}, la prenotazione di ${rome.weekday} ${rome.day} ${rome.month} alle ${rome.hh}:${rome.mm} è stata annullata. Le invieremo conferma su WhatsApp.`;
}

// Reads the wall-clock components of a reservation_time in Europe/Rome so that
// voice-agent responses read the hour the caller actually booked — not the
// UTC hour of the timestamptz value.
function romeWallClock(iso: string | Date): {
    weekday: string; day: number; month: string; hh: string; mm: string;
} {
    const d = iso instanceof Date ? iso : new Date(iso);
    const [datePart, timePart] = [getRomeDatePart(d), getRomeTimePart(d)];
    const [y, mo, dd] = datePart.split('-').map(Number);
    const [hh, mm] = (timePart || '00:00').split(':');
    // Build a naive Date with Rome components-as-local so .getDay() gives the
    // Italian weekday for the reservation date without a second timezone hop.
    const naive = new Date(y, mo - 1, dd);
    return {
        weekday: ITALIAN_WEEKDAYS[naive.getDay()],
        day: dd,
        month: ITALIAN_MONTHS[mo - 1],
        hh,
        mm,
    };
}

// ============================================
// VOICE RESERVATION MODIFICATION
// ============================================

export interface ModifyVoiceReservationInput {
    phone: string;              // caller's phone — identifies the reservation
    date: string;               // YYYY-MM-DD — original date of the booking
    time?: string;              // HH:MM — used to disambiguate when caller has >1 booking that day
    conversation_id?: string;

    // Only fields that are actually being changed should be non-null. Anything
    // omitted keeps the current value.
    new_date?: string;                          // YYYY-MM-DD
    new_time?: string;                          // HH:MM
    new_shift?: Shift;                          // LUNCH | DINNER
    new_guests?: number;
    new_location_preference?: 'INDOOR' | 'OUTDOOR';
    new_notes?: string;                         // free text — appended after the "[Voce]" prefix
}

export interface ModifiedReservation {
    id: number;
    customer_name: string;
    reservation_time: string;
    shift: Shift;
    guests: number;
    phone: string | null;
    table_id: number | null;
    table_name: string | null;
    room_name: string | null;
    room_location: string | null;
}

export type ModifyVoiceReservationOutput =
    | { status: 'not_found' }
    | { status: 'already_cancelled'; reservation: CancelCandidate }
    | { status: 'ambiguous'; candidates: CancelCandidate[] }
    | { status: 'no_change' }
    | { status: 'unavailable'; alternatives?: any }
    | { status: 'modified'; before: CancelCandidate; after: ModifiedReservation };

/**
 * Update a reservation booked by `phone` on `date` with the fields present
 * in the input. Uses the same match rules as cancelVoiceReservation.
 *
 * If date/time/shift/guests/location change we re-run findAvailability and
 * reassign a table. If only notes change we skip the availability check.
 * Kept idempotent: if the caller asks for the same values already stored,
 * returns 'no_change' instead of a spurious success.
 */
export async function modifyVoiceReservation(
    input: ModifyVoiceReservationInput
): Promise<ModifyVoiceReservationOutput> {
    const last10 = lastTenDigits(input.phone);

    // 1) Locate the reservation. Same rules as cancel.
    const params: any[] = [last10, input.date];
    let sql = `
        SELECT id, customer_name, reservation_time, shift, guests, table_id, phone,
               COALESCE(reservation_status, 'CONFIRMED') AS reservation_status,
               notes, children
        FROM reservations
        WHERE right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $1
          AND DATE(reservation_time) = $2::date
    `;
    if (input.time) {
        sql += ` AND to_char(reservation_time, 'HH24:MI') = $3`;
        params.push(input.time);
    }
    sql += ' ORDER BY reservation_time ASC';
    const matches = await queryWithRetry(sql, params);
    const rows = matches.rows;

    const active = rows.filter((r: any) => r.reservation_status !== 'CANCELLED');
    if (active.length === 0) {
        if (rows.length > 0) {
            return { status: 'already_cancelled', reservation: rows[0] };
        }
        return { status: 'not_found' };
    }
    if (active.length > 1) {
        return { status: 'ambiguous', candidates: active };
    }

    const current = active[0];

    // 2) Compute the new state (merge current with overrides).
    // reservation_time comes back from pg as a Date object; `String(Date)`
    // formats it as "Fri Jan 15 2027 ..." (Date.prototype.toString), which
    // is not ISO. Use toISOString() to get YYYY-MM-DDTHH:MM:SS.SSSZ then
    // slice — Railway runs in UTC, so wall-clock and UTC coincide for the
    // way we store reservation_time (see createVoiceReservation).
    const iso = current.reservation_time instanceof Date
        ? current.reservation_time.toISOString()
        : String(current.reservation_time);
    const curDate = iso.slice(0, 10);
    const timeMatch = iso.match(/T(\d{2}):(\d{2})/);
    const curTime = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : '00:00';

    const newDate = input.new_date ?? curDate;
    const newTime = input.new_time ?? curTime;
    const newShift: Shift = input.new_shift ?? current.shift;
    const newGuests: number = input.new_guests ?? current.guests;
    const newLocation = input.new_location_preference; // undefined = keep existing table if still valid

    const scheduleChanged =
        newDate !== curDate ||
        newTime !== curTime ||
        newShift !== current.shift ||
        newGuests !== current.guests ||
        !!newLocation;
    const notesChanged = input.new_notes !== undefined && input.new_notes.trim() !== '';

    if (!scheduleChanged && !notesChanged) {
        return { status: 'no_change' };
    }

    // 3) If schedule changed the table has to hold the new schedule too.
    // FIRST try to KEEP the table already on the booking — it's often the
    // operator's hand-picked seating — and only re-assign when it no longer
    // fits (occupied at the new time, too small for the new party) or the
    // caller explicitly asked for a different area. Blind re-assignment used
    // to silently free a table the staff had just placed (tavolo 56,
    // 2026-08-04) and the floor plan lied until someone noticed.
    let assigned: { id: number; name: string; room_name: string | null; location: 'INDOOR' | 'OUTDOOR' | null } | null | undefined;
    if (scheduleChanged) {
        const keepCurrentTable = current.table_id != null
            && !newLocation
            && await isTableStillAssignable(current.table_id, newDate, newShift, newGuests, current.id);
        if (!keepCurrentTable) {
            assigned = await pickAutoAssignTable(
                newDate,
                newShift,
                newGuests,
                newLocation
            );
            if (!assigned) {
                return { status: 'unavailable' };
            }
        }
    }

    // 4) UPDATE. Reconstruct the reservation_time in local wall-clock form so
    // downstream code (which slices the ISO string) sees the intended values.
    const newReservationTime = `${newDate}T${newTime}:00`;
    const notesToStore = input.new_notes !== undefined
        ? `[Voce] ${input.new_notes.trim()}`
        : current.notes;

    // The two branches use different SQL parameter counts. Postgres refuses
    // to bind excess parameters ("could not determine data type of parameter
    // $1"), so we split into two calls with their own params array.
    const returning = 'id, customer_name, reservation_time, shift, guests, table_id, phone';
    const updated = scheduleChanged
        ? await queryWithRetry(
            `UPDATE reservations
             SET reservation_time = $1, shift = $2, guests = $3, table_id = $4,
                 notes = $5, reservation_status = 'CONFIRMED'
             WHERE id = $6
             RETURNING ${returning}`,
            [newReservationTime, newShift, newGuests, assigned?.id ?? current.table_id,
             notesToStore, current.id]
          )
        : await queryWithRetry(
            `UPDATE reservations
             SET notes = $1, reservation_status = 'CONFIRMED'
             WHERE id = $2
             RETURNING ${returning}`,
            [notesToStore, current.id]
          );

    const after: ModifiedReservation = {
        ...updated.rows[0],
        table_name: assigned?.name ?? null,
        room_name: assigned?.room_name ?? null,
        room_location: assigned?.location ?? null,
    };

    return {
        status: 'modified',
        before: {
            id: current.id,
            customer_name: current.customer_name,
            reservation_time: current.reservation_time,
            shift: current.shift,
            guests: current.guests,
            table_id: current.table_id ?? null,
        },
        after,
    };
}

/**
 * Italian phrase read by the agent after a successful modification. Mirrors
 * formatItalianConfirmation but says "aggiornata" so the caller understands
 * this is a change, not a new booking.
 */
export function formatItalianModification(r: ModifiedReservation): string {
    const rome = romeWallClock(r.reservation_time);
    const firstName = r.customer_name.split(' ')[0];
    return `Prenotazione aggiornata ${firstName}: ${rome.weekday} ${rome.day} ${rome.month} alle ${rome.hh}:${rome.mm} per ${r.guests} persone. Le invieremo la conferma su WhatsApp.`;
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
    const rome = romeWallClock(r.reservation_time);
    const persone = r.guests === 1 ? 'persona' : 'persone';
    const firstName = r.customer_name.split(' ')[0];
    const childrenSuffix = r.children && r.children > 0
        ? ` di cui ${r.children} ${r.children === 1 ? 'bambino' : 'bambini'}`
        : '';
    return `Confermato ${firstName}, tavolo per ${r.guests} ${persone}${childrenSuffix} ${rome.weekday} ${rome.day} ${rome.month} alle ${rome.hh}:${rome.mm}. Le invieremo conferma su WhatsApp.`;
}
