// Canali di risposta per le prenotazioni (Impostazioni → Canali di
// prenotazione → Canali di risposta).
//
// Ogni fonte di prenotazione (web, voce, WhatsApp, manuale) ha una lista di
// priorità sui tre canali di notifica: il PRIMO canale disponibile vince e
// porta richiesta/conferma/disdetta. "Disponibile" significa due cose insieme:
// l'ospite ha lasciato quel recapito E il provider del tenant è configurato —
// la policy non promette mai un canale che non può partire davvero.
//
// `email_copy` è il ponte col comportamento storico: prima di questa policy
// telefono ed email viaggiavano IN PARALLELO (SMS/WA + email quando c'era).
// Col flag acceso l'email parte sempre in copia anche quando il canale scelto
// è un altro — così il default riproduce esattamente la condotta di prima e
// nessun tenant cambia comportamento al deploy.
import { queryWithRetry } from '../db.js';

export type BookingChannel = 'email' | 'whatsapp' | 'sms';
export type BookingSource = 'GOOGLE' | 'VOICE' | 'WHATSAPP' | 'MANUAL';

export interface SourceChannelPolicy {
    /** Ordine di preferenza; sottoinsieme non vuoto dei tre canali. */
    priority: BookingChannel[];
    /** Email sempre in copia quando disponibile (e non già canale scelto). */
    email_copy: boolean;
}

export type BookingChannelPolicyMap = Record<BookingSource, SourceChannelPolicy>;

export const BOOKING_CHANNELS: readonly BookingChannel[] = ['email', 'whatsapp', 'sms'] as const;
export const BOOKING_SOURCES: readonly BookingSource[] = ['GOOGLE', 'VOICE', 'WHATSAPP', 'MANUAL'] as const;

const SETTINGS_KEY = 'booking_channel_policy';

// Default = comportamento in produzione al momento dell'introduzione:
// - web (GOOGLE): email-first (ex PR #185), telefono come ripiego;
// - tutte le altre fonti: WhatsApp con ripiego SMS, email in copia quando
//   c'è — che è il parallelismo storico telefono+email.
export const DEFAULT_BOOKING_CHANNEL_POLICY: BookingChannelPolicyMap = {
    GOOGLE: { priority: ['email', 'whatsapp', 'sms'], email_copy: false },
    VOICE: { priority: ['whatsapp', 'sms'], email_copy: true },
    WHATSAPP: { priority: ['whatsapp', 'sms'], email_copy: true },
    MANUAL: { priority: ['whatsapp', 'sms'], email_copy: true },
};

const isChannel = (v: unknown): v is BookingChannel =>
    v === 'email' || v === 'whatsapp' || v === 'sms';

/** Valida la policy di UNA fonte; null se malformata. */
export function normalizeSourcePolicy(raw: unknown): SourceChannelPolicy | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const priorityRaw = (raw as any).priority;
    if (!Array.isArray(priorityRaw) || priorityRaw.length === 0) return null;
    const priority: BookingChannel[] = [];
    for (const item of priorityRaw) {
        if (!isChannel(item)) return null;
        if (priority.includes(item)) return null; // duplicato
        priority.push(item);
    }
    const emailCopy = (raw as any).email_copy;
    if (typeof emailCopy !== 'boolean') return null;
    return { priority, email_copy: emailCopy };
}

/**
 * Legge la policy del tenant. Le fonti mancanti o malformate cadono sul
 * default — una riga corrotta non deve mai lasciare una fonte senza canali.
 */
export async function getBookingChannelPolicy(tenantId: number): Promise<BookingChannelPolicyMap> {
    const policy: BookingChannelPolicyMap = {
        GOOGLE: { ...DEFAULT_BOOKING_CHANNEL_POLICY.GOOGLE, priority: [...DEFAULT_BOOKING_CHANNEL_POLICY.GOOGLE.priority] },
        VOICE: { ...DEFAULT_BOOKING_CHANNEL_POLICY.VOICE, priority: [...DEFAULT_BOOKING_CHANNEL_POLICY.VOICE.priority] },
        WHATSAPP: { ...DEFAULT_BOOKING_CHANNEL_POLICY.WHATSAPP, priority: [...DEFAULT_BOOKING_CHANNEL_POLICY.WHATSAPP.priority] },
        MANUAL: { ...DEFAULT_BOOKING_CHANNEL_POLICY.MANUAL, priority: [...DEFAULT_BOOKING_CHANNEL_POLICY.MANUAL.priority] },
    };
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                for (const source of BOOKING_SOURCES) {
                    const normalized = normalizeSourcePolicy(parsed[source]);
                    if (normalized) policy[source] = normalized;
                }
            }
        }
    } catch (err: any) {
        console.error('[booking-channels] lettura policy fallita:', err?.message || err);
    }
    return policy;
}

/** Sovrascrive la policy (già validata dal chiamante) del tenant. */
export async function saveBookingChannelPolicy(tenantId: number, policy: BookingChannelPolicyMap): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}

export interface ChannelAvailability {
    /** L'ospite ha lasciato il recapito? */
    hasPhone: boolean;
    hasEmail: boolean;
    /** Il provider del tenant può davvero spedire su quel canale? */
    smtpReady: boolean;
    whatsappReady: boolean;
    smsReady: boolean;
}

export interface ResolvedChannels {
    /**
     * Canali telefonici/email da tentare, in ordine, finché uno riesce.
     * Vuoto = nessun canale praticabile (l'ospite resta senza notifica:
     * il chiamante lo logga, non è un errore della richiesta).
     */
    attempts: BookingChannel[];
    /** Email in copia oltre al canale scelto (mai doppia con attempts). */
    emailCopy: boolean;
}

/**
 * Applica la policy di una fonte allo stato reale di prenotazione e provider.
 * Pura e sincrona: i check di configurazione arrivano dal chiamante, così la
 * decisione è testabile e non nasconde I/O.
 */
export function resolveBookingChannels(
    policy: SourceChannelPolicy,
    avail: ChannelAvailability
): ResolvedChannels {
    const usable = (c: BookingChannel): boolean =>
        c === 'email' ? (avail.hasEmail && avail.smtpReady)
        : c === 'whatsapp' ? (avail.hasPhone && avail.whatsappReady)
        : (avail.hasPhone && avail.smsReady);

    const attempts = policy.priority.filter(usable);
    const emailInAttempts = attempts.includes('email');
    const emailCopy = policy.email_copy && !emailInAttempts && avail.hasEmail && avail.smtpReady;
    return { attempts, emailCopy };
}
