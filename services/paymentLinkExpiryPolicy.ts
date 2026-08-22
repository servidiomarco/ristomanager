// Scadenza dei link di pagamento (Impostazioni → Opzioni prenotazioni).
// Card dev board #28.
//
// Un link di caparra non pagato oggi resta payabile per sempre e la
// prenotazione resta PENDING a occupare la lista finché uno staff non la
// tocca. Questa policy, per tenant, chiude il buco: dopo N ore il link viene
// annullato al provider e — a scelta — il cliente riceve il messaggio delle
// prenotazioni non confermate (stessi template del decline manuale).
//
// Il default è SPENTO: accenderla d'ufficio al deploy farebbe scadere in
// blocco i link pendenti esistenti e manderebbe messaggi non richiesti ai
// clienti del tenant. La si accende dalla pagina Impostazioni.
import { queryWithRetry } from '../db.js';

/** Cosa mandare al cliente quando il link scade da solo. */
export type PaymentLinkExpiryMessage = 'declined' | 'none';

export interface PaymentLinkExpiryPolicy {
    enabled: boolean;
    /** Ore di vita del link prima della scadenza automatica. */
    hours: number;
    message: PaymentLinkExpiryMessage;
}

const SETTINGS_KEY = 'payment_link_expiry_policy';

export const PAYMENT_LINK_EXPIRY_MIN_HOURS = 1;
export const PAYMENT_LINK_EXPIRY_MAX_HOURS = 168; // una settimana

export const DEFAULT_PAYMENT_LINK_EXPIRY_POLICY: PaymentLinkExpiryPolicy = {
    enabled: false,
    hours: 24,
    message: 'declined',
};

const isMessage = (v: unknown): v is PaymentLinkExpiryMessage =>
    v === 'declined' || v === 'none';

/** Valida una policy completa; null se malformata. */
export function normalizePaymentLinkExpiryPolicy(raw: unknown): PaymentLinkExpiryPolicy | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const enabled = (raw as any).enabled;
    if (typeof enabled !== 'boolean') return null;
    const hours = Number((raw as any).hours);
    if (!Number.isInteger(hours) || hours < PAYMENT_LINK_EXPIRY_MIN_HOURS || hours > PAYMENT_LINK_EXPIRY_MAX_HOURS) return null;
    const message = (raw as any).message;
    if (!isMessage(message)) return null;
    return { enabled, hours, message };
}

/** Legge la policy del tenant; una riga corrotta cade sul default (spento). */
export async function getPaymentLinkExpiryPolicy(tenantId: number): Promise<PaymentLinkExpiryPolicy> {
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const normalized = normalizePaymentLinkExpiryPolicy(JSON.parse(raw));
            if (normalized) return normalized;
        }
    } catch (err: any) {
        console.error('[payment-link-expiry] lettura policy fallita:', err?.message || err);
    }
    return { ...DEFAULT_PAYMENT_LINK_EXPIRY_POLICY };
}

/** Sovrascrive la policy (già validata dal chiamante) del tenant. */
export async function savePaymentLinkExpiryPolicy(tenantId: number, policy: PaymentLinkExpiryPolicy): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}
