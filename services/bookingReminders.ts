// Promemoria automatico all'ospite prima della prenotazione
// (Impostazioni → Prenotazioni → Promemoria all'ospite).
//
// Fino a qui il promemoria partiva solo a mano, dal tab Comunicazione del
// modal. Questo modulo tiene le due cose che lo sweep in server.ts deve
// fare giuste, separate dall'I/O così i test le eseguono davvero:
//
// 1. QUANDO inviare (decideBookingReminder): pura, dato l'orologio, la
//    prenotazione e la policy del ristorante.
// 2. COME segnare l'esito (CLAIM_/FINISH_BOOKING_REMINDER_SQL): stesse
//    regole della richiesta di recensione (services/reviewRequests.ts), che
//    l'incidente del 18-19/09/2026 ha reso obbligatorie — si prende in
//    carico PRIMA di inviare, e una riga presa in carico non si ritenta mai.
//    Un promemoria mancato vale molto meno di dieci copie allo stesso ospite.
//
// La policy è SPENTA di default, come la scadenza dei link: accenderla al
// deploy manderebbe messaggi a tutte le prenotazioni di domani di ogni
// ristorante senza che nessuno l'abbia chiesto.
import { queryWithRetry } from '../db.js';
import { getDatePartInTz, getTimePartInTz } from '../utils/reservationTime.js';

export type BookingReminderTiming = 'day_before' | 'hours_before';

export interface BookingReminderPolicy {
    enabled: boolean;
    timing: BookingReminderTiming;
    /** 'day_before': ora del ristorante, HH:MM, del giorno prima. */
    day_before_time: string;
    /** 'hours_before': ore prima dell'orario della prenotazione. */
    hours_before: number;
}

const SETTINGS_KEY = 'booking_reminder_policy';

// L'ora del giorno prima sta dentro la finestra d'invio: un promemoria
// alle 7 del mattino sveglia l'ospite, uno alle 22 arriva a cena finita.
export const DAY_BEFORE_TIME_MIN = '09:00';
export const DAY_BEFORE_TIME_MAX = '20:00';
// Due ore è il minimo che lascia il tempo di disdire e al locale di
// riassegnare il tavolo; oltre 48 il promemoria diventa una seconda conferma.
export const HOURS_BEFORE_MIN = 2;
export const HOURS_BEFORE_MAX = 48;

export const DEFAULT_BOOKING_REMINDER_POLICY: BookingReminderPolicy = {
    enabled: false,
    timing: 'day_before',
    day_before_time: '11:00',
    hours_before: 24,
};

// Finestra d'invio sull'orologio del ristorante: fuori si aspetta.
export const REMINDER_WINDOW_START_MIN = 9 * 60;
export const REMINDER_WINDOW_END_MIN = 21 * 60;
// Chi ha prenotato (o ricevuto la conferma) da meno di 12 ore ha appena
// letto data e ora: un promemoria subito dopo è rumore.
export const REMINDER_MIN_GAP_HOURS = 12;
// A meno di un'ora dall'arrivo il promemoria non serve più a niente.
export const REMINDER_TOO_LATE_MIN = 60;
// Una prenotazione spostata di più di 12 ore (altro giorno, altro turno)
// merita il promemoria per la data nuova, anche se quello vecchio è partito.
export const REMINDER_MOVED_HOURS = 12;
// Lo sweep guarda solo le prossime 72 ore: copre il massimo anticipo
// possibile (giorno prima alle 9 per una cena alle 23 dell'indomani, o 48 ore).
export const REMINDER_HORIZON_HOURS = 72;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isTiming = (v: unknown): v is BookingReminderTiming =>
    v === 'day_before' || v === 'hours_before';

/** Valida una policy completa; null se malformata. */
export function normalizeBookingReminderPolicy(raw: unknown): BookingReminderPolicy | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled !== 'boolean') return null;
    if (!isTiming(r.timing)) return null;
    const time = typeof r.day_before_time === 'string' ? r.day_before_time.trim() : '';
    if (!HHMM.test(time) || time < DAY_BEFORE_TIME_MIN || time > DAY_BEFORE_TIME_MAX) return null;
    const hours = Number(r.hours_before);
    if (!Number.isInteger(hours) || hours < HOURS_BEFORE_MIN || hours > HOURS_BEFORE_MAX) return null;
    return { enabled: r.enabled, timing: r.timing, day_before_time: time, hours_before: hours };
}

/** Legge la policy del tenant; una riga corrotta cade sul default (spento). */
export async function getBookingReminderPolicy(tenantId: number): Promise<BookingReminderPolicy> {
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const normalized = normalizeBookingReminderPolicy(JSON.parse(raw));
            if (normalized) return normalized;
        }
    } catch (err: any) {
        console.error('[booking-reminder] lettura policy fallita:', err?.message || err);
    }
    return { ...DEFAULT_BOOKING_REMINDER_POLICY };
}

/** Sovrascrive la policy (già validata dal chiamante) del tenant. */
export async function saveBookingReminderPolicy(tenantId: number, policy: BookingReminderPolicy): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}

// ── Orologio del ristorante ──────────────────────────────────────────────

/** Millisecondi UTC dell'ora «da parete» che il fuso mostra all'istante t. */
const wallClockMs = (t: number, tz: string): number => {
    const [y, m, d] = getDatePartInTz(new Date(t), tz).split('-').map(Number);
    const [h, mi] = getTimePartInTz(new Date(t), tz).split(':').map(Number);
    return Date.UTC(y, m - 1, d, h, mi);
};

/**
 * L'istante in cui l'orologio del ristorante segna `date` alle `hhmm`.
 * Due passate: la prima stima l'offset dall'ora UTC omonima, la seconda lo
 * rilegge all'istante trovato, così il cambio d'ora del giorno prima non
 * sposta il promemoria di un'ora.
 */
export function zonedWallTimeToInstant(date: string, hhmm: string, tz: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    const target = Date.UTC(y, m - 1, d, h, mi);
    let guess = target - (wallClockMs(target, tz) - target);
    guess = target - (wallClockMs(guess, tz) - guess);
    return new Date(guess);
}

const previousDay = (date: string): string => {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
};

/** Quando parte il promemoria di una prenotazione, secondo la policy. */
export function reminderSendAt(reservationTime: Date, policy: BookingReminderPolicy, tz: string): Date {
    if (policy.timing === 'hours_before') {
        return new Date(reservationTime.getTime() - policy.hours_before * 3600_000);
    }
    const day = getDatePartInTz(reservationTime, tz);
    return zonedWallTimeToInstant(previousDay(day), policy.day_before_time, tz);
}

export type BookingReminderDecision =
    | 'wait'
    | 'send'
    | 'skipped_recent_booking'
    | 'skipped_too_late';

/**
 * Cosa fare adesso con una prenotazione confermata non ancora valutata.
 * `lastContactAt` è il più recente fra creazione e invio della conferma:
 * una richiesta di giorni fa confermata stamattina ha appena avuto il suo
 * messaggio.
 */
export function decideBookingReminder(params: {
    now: Date;
    reservationTime: Date;
    lastContactAt: Date | null;
    policy: BookingReminderPolicy;
    tz: string;
}): BookingReminderDecision {
    const { now, reservationTime, lastContactAt, policy, tz } = params;
    const sendAt = reminderSendAt(reservationTime, policy, tz);
    if (now.getTime() < sendAt.getTime()) return 'wait';
    if (lastContactAt && lastContactAt.getTime() > sendAt.getTime() - REMINDER_MIN_GAP_HOURS * 3600_000) {
        return 'skipped_recent_booking';
    }
    if (reservationTime.getTime() - now.getTime() < REMINDER_TOO_LATE_MIN * 60_000) return 'skipped_too_late';
    const [h, mi] = getTimePartInTz(now, tz).split(':').map(Number);
    const minutes = h * 60 + mi;
    if (minutes < REMINDER_WINDOW_START_MIN || minutes > REMINDER_WINDOW_END_MIN) return 'wait';
    return 'send';
}

// ── Registro dell'esito sulla prenotazione ───────────────────────────────

/** 'sending' = presa in carico, esito ancora ignoto: non si riprova. */
export type BookingReminderStatus =
    | 'sending'
    | 'sent'
    | 'failed'
    | 'skipped_no_contact'
    | 'skipped_manual'
    | 'skipped_recent_booking'
    | 'skipped_too_late';

/**
 * Le prenotazioni da valutare: mai valutate, oppure valutate per un orario
 * da cui si sono spostate di più di REMINDER_MOVED_HOURS. Una riga a
 * 'sending' resta ferma in ogni caso. Stesso frammento nella SELECT dello
 * sweep e nella presa in carico, così le due non possono divergere.
 */
export const bookingReminderPendingSql = (alias: string = ''): string => {
    const c = (column: string) => (alias ? `${alias}.${column}` : column);
    return `(
    ${c('auto_reminder_status')} IS NULL
    OR (${c('auto_reminder_status')} <> 'sending'
        AND (${c('auto_reminder_for')} IS NULL
             OR ABS(EXTRACT(EPOCH FROM (${c('reservation_time')} - ${c('auto_reminder_for')}))) > ${REMINDER_MOVED_HOURS * 3600}))
)`;
};

// Le candidate dello sweep, di tutti i ristoranti: confermate, fra
// REMINDER_TOO_LATE_MIN e REMINDER_HORIZON_HOURS da adesso, da valutare.
// Quelle a meno di un'ora dall'arrivo non si guardano nemmeno: restano
// NULL e nessuno le tocca più. La policy si applica dopo, per tenant.
export const BOOKING_REMINDER_CANDIDATES_SQL = `
    SELECT r.id, r.tenant_id, r.customer_name, r.phone, r.email, r.source,
           r.reservation_time, r.guests, r.language, r.reminder_sent,
           r.auto_reminder_status, r.created_at, r.confirmation_sent_at,
           ro.name AS room_name
      FROM reservations r
      LEFT JOIN tables t ON t.id = r.table_id AND t.tenant_id = r.tenant_id
      LEFT JOIN rooms ro ON ro.id = t.room_id AND ro.tenant_id = t.tenant_id
     WHERE r.reservation_status = 'CONFIRMED'
       AND r.reservation_time > NOW() + make_interval(mins => ${REMINDER_TOO_LATE_MIN})
       AND r.reservation_time < NOW() + make_interval(hours => ${REMINDER_HORIZON_HOURS})
       AND ${bookingReminderPendingSql('r')}
     ORDER BY r.reservation_time
     LIMIT 500`;

// $3 è l'orario su cui lo sweep ha deciso: se nel frattempo la prenotazione
// è stata spostata, la presa in carico fallisce e il giro dopo la rivaluta.
// Confronto entro un secondo e non uguaglianza: il Date di JavaScript perde
// i microsecondi che Postgres conserva.
export const CLAIM_BOOKING_REMINDER_SQL = `
    UPDATE reservations
       SET auto_reminder_status = 'sending',
           auto_reminder_for = reservation_time,
           auto_reminder_channel = NULL,
           auto_reminder_error = NULL
     WHERE id = $1::int
       AND tenant_id = $2::bigint
       AND ABS(EXTRACT(EPOCH FROM (reservation_time - $3::timestamptz))) < 1
       AND ${bookingReminderPendingSql()}
    RETURNING id`;

// Cast espliciti su ogni parametro: è la lezione della marcatura delle
// recensioni, dove `$1` dedotto insieme varchar e text faceva fallire la
// query solo a contatto col database. Il promemoria partito accende anche
// reminder_sent, la campanella che la card già mostra per quello manuale.
export const FINISH_BOOKING_REMINDER_SQL = `
    UPDATE reservations
       SET auto_reminder_status = $1::varchar,
           auto_reminder_channel = $2::varchar,
           auto_reminder_sent_at = CASE WHEN $1::varchar = 'sent' THEN CURRENT_TIMESTAMP ELSE auto_reminder_sent_at END,
           auto_reminder_failed_at = CASE WHEN $1::varchar = 'failed' THEN CURRENT_TIMESTAMP ELSE auto_reminder_failed_at END,
           auto_reminder_error = $3::text,
           reminder_sent = CASE WHEN $1::varchar = 'sent' THEN TRUE ELSE reminder_sent END
     WHERE id = $4::int
       AND tenant_id = $5::bigint
       AND auto_reminder_status = 'sending'
    RETURNING *`;

/** Prende in carico la prenotazione: true solo per chi la ottiene. */
export async function claimBookingReminder(tenantId: number, reservationId: number, reservationTime: Date): Promise<boolean> {
    const res = await queryWithRetry(CLAIM_BOOKING_REMINDER_SQL, [reservationId, tenantId, reservationTime.toISOString()]);
    return (res.rowCount ?? 0) > 0;
}

/** Scrive l'esito; restituisce la riga aggiornata (per broadcast e replica) o null. */
export async function finishBookingReminder(
    tenantId: number,
    reservationId: number,
    status: Exclude<BookingReminderStatus, 'sending'>,
    channel: string | null = null,
    error: string | null = null
): Promise<Record<string, any> | null> {
    const res = await queryWithRetry(FINISH_BOOKING_REMINDER_SQL, [status, channel, error, reservationId, tenantId]);
    return res.rows[0] ?? null;
}

// ── Avviso dei promemoria non partiti ────────────────────────────────────

export const bookingReminderFailureTag = (date: string): string => `booking-reminder-failed-${date}`;

const shortError = (error: string | null): string => {
    const clean = String(error ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (clean.length <= 40) return clean;
    const cut = clean.slice(0, 39);
    const space = cut.lastIndexOf(' ');
    return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
};

/** «2 promemoria non partiti» · «Rossi (numero non valido), Bianchi». */
export function bookingReminderFailureDigest(rows: { customerName: string | null; error: string | null }[]): { title: string; body: string } {
    const title = rows.length === 1 ? '1 promemoria non partito' : `${rows.length} promemoria non partiti`;
    const parts = rows.slice(0, 3).map(r => {
        const name = (r.customerName ?? '').trim() || 'cliente senza nome';
        const err = shortError(r.error);
        return err ? `${name} (${err})` : name;
    });
    const rest = rows.length - parts.length;
    return { title, body: parts.join(', ') + (rest > 0 ? ` e altri ${rest}` : '') };
}
