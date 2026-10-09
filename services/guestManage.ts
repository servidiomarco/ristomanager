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
// 3. la caparra: rimborsabile solo annullando con almeno 24 ore d'anticipo,
//    come dicono da sempre le condizioni nelle email e su /prenota. Il
//    rimborso lo fa lo staff a mano: l'avviso glielo chiede (decisione del
//    09/10/2026 — soldi che escono da un link pubblico senza nessuno che
//    guardi, no).
// 4. il token, che è la capability del link: chi lo ha vede la
//    prenotazione e può annullarla, quindi è lungo e casuale.
import crypto from 'crypto';
import { queryWithRetry } from '../db.js';

export interface GuestManagePolicy {
    enabled: boolean;
    /** Fino a quante ore prima dell'arrivo l'ospite può annullare da solo. */
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
}): GuestActions {
    const state = guestReservationState(params);
    const open = state === 'confirmed' || state === 'pending';
    if (!open) return { state, can_confirm: false, can_cancel: false, cancel_block: null };
    if (!params.policy.enabled) return { state, can_confirm: false, can_cancel: false, cancel_block: 'disabled' };
    const hoursToGo = (params.reservationTime.getTime() - params.now.getTime()) / 3600_000;
    const tooLate = hoursToGo < params.policy.cancel_cutoff_hours;
    return {
        state,
        // Si conferma solo una prenotazione confermata dal locale: una
        // richiesta in attesa non ha ancora un tavolo da tenere.
        can_confirm: state === 'confirmed' && !params.guestConfirmedAt,
        can_cancel: !tooLate,
        cancel_block: tooLate ? 'too_late' : null,
    };
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
