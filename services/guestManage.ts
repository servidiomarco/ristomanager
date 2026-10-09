// «La tua prenotazione»: la pagina dove l'ospite conferma la presenza o
// annulla da solo, aperta dal link «Gestisci la prenotazione» della
// conferma e del promemoria (Impostazioni → Prenotazioni → Gestione
// dall'ospite).
//
// Qui stanno le parti che le rotte in server.ts devono fare giuste,
// separate dall'I/O così i test le eseguono davvero:
//
// 1. la policy del ristorante (spenta di default, come il promemoria: il
//    link compare nei messaggi solo quando il locale l'ha scelto);
// 2. COSA può fare l'ospite adesso (guestActionsFor), dato l'orologio e lo
//    stato della prenotazione;
// 3. la modifica (data, ora, persone): solo dove il tavolo si trova da
//    solo, altrimenti «chiama il ristorante» (decisione del 09/10/2026) —
//    qui le regole sulla richiesta, il tavolo lo cerca server.ts;
// 4. la caparra: rimborsabile solo annullando con almeno 24 ore d'anticipo,
//    come dicono da sempre le condizioni nelle email e su /prenota. Il
//    rimborso lo fa lo staff a mano: l'avviso glielo chiede (decisione del
//    09/10/2026 — soldi che escono da un link pubblico senza nessuno che
//    guardi, no).
// 5. il token, che è la capability del link: chi lo ha vede la
//    prenotazione e può annullarla, quindi è lungo e casuale.
import crypto from 'crypto';
import { queryWithRetry } from '../db.js';

export interface GuestManagePolicy {
    enabled: boolean;
    /** Fino a quante ore prima dell'arrivo l'ospite può annullare o
     *  modificare da solo. Il nome resta quello della prima versione, che
     *  aveva solo l'annullo: è la chiave salvata in app_settings. */
    cancel_cutoff_hours: number;
}

const SETTINGS_KEY = 'guest_manage_policy';

// Un'ora è il minimo che lascia al locale il tempo di accorgersene; oltre
// tre giorni l'ospite non potrebbe più annullare da solo nemmeno dal
// promemoria del giorno prima.
export const CANCEL_CUTOFF_MIN = 1;
export const CANCEL_CUTOFF_MAX = 72;

// La regola della caparra già scritta nelle condizioni («rimborsata se
// annulli almeno 24 ore prima»): qui diventa il criterio dell'avviso.
export const DEPOSIT_REFUND_MIN_HOURS = 24;

export const DEFAULT_GUEST_MANAGE_POLICY: GuestManagePolicy = {
    enabled: false,
    cancel_cutoff_hours: 3,
};

/** Valida una policy completa; null se malformata. */
export function normalizeGuestManagePolicy(raw: unknown): GuestManagePolicy | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.enabled !== 'boolean') return null;
    const hours = Number(r.cancel_cutoff_hours);
    if (!Number.isInteger(hours) || hours < CANCEL_CUTOFF_MIN || hours > CANCEL_CUTOFF_MAX) return null;
    return { enabled: r.enabled, cancel_cutoff_hours: hours };
}

/** Legge la policy del tenant; una riga corrotta cade sul default (spento). */
export async function getGuestManagePolicy(tenantId: number): Promise<GuestManagePolicy> {
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const normalized = normalizeGuestManagePolicy(JSON.parse(raw));
            if (normalized) return normalized;
        }
    } catch (err: any) {
        console.error('[guest-manage] lettura policy fallita:', err?.message || err);
    }
    return { ...DEFAULT_GUEST_MANAGE_POLICY };
}

/** Sovrascrive la policy (già validata dal chiamante) del tenant. */
export async function saveGuestManagePolicy(tenantId: number, policy: GuestManagePolicy): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}

// ── Cosa può fare l'ospite ───────────────────────────────────────────────

/** Come la pagina racconta la prenotazione. */
export type GuestReservationState = 'confirmed' | 'pending' | 'cancelled' | 'declined' | 'past';

export type GuestCancelBlock = 'disabled' | 'too_late' | null;

export interface GuestActions {
    state: GuestReservationState;
    can_confirm: boolean;
    can_cancel: boolean;
    /** Perché non può annullare, quando la prenotazione sarebbe annullabile. */
    cancel_block: GuestCancelBlock;
    /** Cambiare data, ora o persone (stessa soglia dell'annullo). */
    can_modify: boolean;
}

// Gli arrivi che dicono «è già al tavolo o è già andato via»: da lì in poi
// la prenotazione è storia, anche se l'orario non è ancora passato.
const SEATED_OR_GONE = new Set(['ARRIVED', 'DEPARTING', 'DEPARTED']);

export function guestReservationState(params: {
    now: Date;
    reservationTime: Date;
    status: string | null | undefined;
    arrivalStatus?: string | null;
}): GuestReservationState {
    const status = String(params.status || 'CONFIRMED').toUpperCase();
    if (status === 'CANCELLED') return 'cancelled';
    if (status === 'DECLINED') return 'declined';
    if (status === 'NO_SHOW') return 'past';
    if (SEATED_OR_GONE.has(String(params.arrivalStatus || '').toUpperCase())) return 'past';
    if (params.reservationTime.getTime() <= params.now.getTime()) return 'past';
    return status === 'PENDING' ? 'pending' : 'confirmed';
}

/**
 * Quello che la pagina mostra come possibile adesso. Le rotte di scrittura
 * rifanno lo stesso calcolo sul dato fresco: la pagina aperta ieri non
 * autorizza niente.
 */
export function guestActionsFor(params: {
    now: Date;
    reservationTime: Date;
    status: string | null | undefined;
    arrivalStatus?: string | null;
    guestConfirmedAt: Date | null;
    policy: GuestManagePolicy;
    /** Legata a un banchetto: tavoli e menù li decide lo staff, l'ospite
     *  può confermare o annullare ma non spostarla. */
    banquetLinked?: boolean;
}): GuestActions {
    const state = guestReservationState(params);
    const open = state === 'confirmed' || state === 'pending';
    const none = { can_confirm: false, can_cancel: false, can_modify: false };
    if (!open) return { state, ...none, cancel_block: null };
    if (!params.policy.enabled) return { state, ...none, cancel_block: 'disabled' };
    const hoursToGo = (params.reservationTime.getTime() - params.now.getTime()) / 3600_000;
    const tooLate = hoursToGo < params.policy.cancel_cutoff_hours;
    return {
        state,
        // Si conferma solo una prenotazione confermata dal locale: una
        // richiesta in attesa non ha ancora un tavolo da tenere.
        can_confirm: state === 'confirmed' && !params.guestConfirmedAt,
        can_cancel: !tooLate,
        cancel_block: tooLate ? 'too_late' : null,
        // Stessa ragione: si sposta un tavolo che c'è. Una richiesta in
        // attesa la sistema lo staff quando la guarda.
        can_modify: state === 'confirmed' && !tooLate && !params.banquetLinked,
    };
}

// ── La modifica ──────────────────────────────────────────────────────────

// Gli stessi limiti del modulo /prenota: fino a 20 persone, fino a 60
// giorni avanti. Oltre, la prenotazione si fa parlando col locale.
export const GUEST_MODIFY_MAX_GUESTS = 20;
export const GUEST_MODIFY_HORIZON_DAYS = 60;

export interface GuestModifyRequest {
    date: string;
    time: string;
    guests: number;
}

export type GuestModifyRefusal =
    | 'invalid_request'
    | 'out_of_range'
    | 'too_soon'
    | 'guests_locked'
    | 'no_change';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** La richiesta del modulo, validata nella forma; null se malformata. */
export function parseGuestModifyRequest(body: unknown): GuestModifyRequest | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as Record<string, unknown>;
    const date = typeof b.date === 'string' ? b.date : '';
    const time = typeof b.time === 'string' ? b.time : '';
    const guests = Number(b.guests);
    if (!ISO_DATE.test(date) || !HH_MM.test(time) || !Number.isInteger(guests)) return null;
    return { date, time, guests };
}

/** 'YYYY-MM-DD' + n giorni, senza passare dal fuso del server. */
export function addDaysIsoDate(iso: string, days: number): string {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Le regole della richiesta che non dipendono dalla sala: date e persone
 * nei limiti, il nuovo orario non più vicino della soglia (chi sposta a
 * fra un'ora deve parlarne col locale, come chi annulla), le persone
 * bloccate se c'è una caparra pagata (più persone vorrebbero più caparra,
 * meno un rimborso: lo decide lo staff), e almeno una cosa cambiata.
 * Il posto lo cerca il server dopo.
 */
export function guestModifyRefusal(p: {
    now: Date;
    /** L'istante del nuovo orario, già calcolato nel fuso del locale. */
    newTime: Date;
    /** Oggi nel fuso del locale. */
    today: string;
    request: GuestModifyRequest;
    current: { date: string; time: string; guests: number };
    depositPaid: boolean;
    policy: GuestManagePolicy;
}): GuestModifyRefusal | null {
    const { request: r, current: c } = p;
    if (r.guests < 1 || r.guests > GUEST_MODIFY_MAX_GUESTS) return 'invalid_request';
    if (r.date < p.today || r.date > addDaysIsoDate(p.today, GUEST_MODIFY_HORIZON_DAYS)) return 'out_of_range';
    if (r.date === c.date && r.time === c.time && r.guests === c.guests) return 'no_change';
    if (p.depositPaid && r.guests !== c.guests) return 'guests_locked';
    const hoursToGo = (p.newTime.getTime() - p.now.getTime()) / 3600_000;
    if (hoursToGo < p.policy.cancel_cutoff_hours) return 'too_soon';
    return null;
}

/** La caparra, se l'ospite annulla adesso: rimborsabile o trattenuta. */
export function depositOutcomeOnCancel(now: Date, reservationTime: Date): 'refund' | 'retained' {
    const hoursToGo = (reservationTime.getTime() - now.getTime()) / 3600_000;
    return hoursToGo >= DEPOSIT_REFUND_MIN_HOURS ? 'refund' : 'retained';
}

// ── Il token del link ────────────────────────────────────────────────────

// 16 byte casuali: 22 caratteri in base64url. Abbastanza per non essere
// indovinati, abbastanza corti per stare in un SMS senza un segmento in più.
export const GUEST_TOKEN_MIN_LENGTH = 20;
export const newGuestToken = (): string => crypto.randomBytes(16).toString('base64url');

/**
 * Il token della prenotazione, coniato la prima volta che serve e poi
 * stabile: conferma, promemoria e link copiato dallo staff aprono la stessa
 * pagina. Due chiamate in gara coniano due token, ma ne scrive uno solo
 * (WHERE guest_token IS NULL) e l'altra rilegge quello.
 */
export async function ensureGuestToken(tenantId: number, reservationId: number): Promise<string | null> {
    const minted = await queryWithRetry(
        `UPDATE reservations SET guest_token = $3
          WHERE id = $1 AND tenant_id = $2 AND guest_token IS NULL
          RETURNING guest_token`,
        [reservationId, tenantId, newGuestToken()]
    );
    if (minted.rows[0]?.guest_token) return String(minted.rows[0].guest_token);
    const existing = await queryWithRetry(
        'SELECT guest_token FROM reservations WHERE id = $1 AND tenant_id = $2',
        [reservationId, tenantId]
    );
    const token = existing.rows[0]?.guest_token;
    return typeof token === 'string' && token ? token : null;
}

// ── L'orologio del locale ────────────────────────────────────────────────

/** Di quanto il fuso `tz` è avanti a UTC nell'istante `utcMs`. */
function tzOffsetMs(utcMs: number, tz: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value);
    return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - utcMs;
}

/**
 * L'istante di «giorno, ora» sull'orologio del locale: serve a confrontare
 * il nuovo orario scelto dall'ospite con adesso. Il secondo giro sistema i
 * giorni del cambio d'ora, quando l'offset di mezzanotte non è quello della
 * sera.
 */
export function wallClockToInstant(date: string, time: string, tz: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    const [hh, mm] = time.split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh, mm);
    const first = tzOffsetMs(guess, tz);
    const second = tzOffsetMs(guess - first, tz);
    return new Date(guess - second);
}
