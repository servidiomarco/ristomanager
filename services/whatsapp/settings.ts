// La politica WhatsApp del ristorante (Impostazioni › WhatsApp), salvata
// come JSON in app_settings come le altre politiche (guestManage,
// bookingReminders). Una riga corrotta cade sul default: agente spento.

import { queryWithRetry } from '../../db.js';

/**
 * Come lavora l'agente sui messaggi in arrivo:
 * - off: solo a pulsante, come prima (lo lancia lo staff dalla bacchetta);
 * - draft: parte da solo e prepara la risposta, che lo staff invia;
 * - reply: parte da solo e risponde; le modifiche alle prenotazioni restano
 *   proposte da confermare.
 */
export type AgentMode = 'off' | 'draft' | 'reply';
export const AGENT_MODES: readonly AgentMode[] = ['off', 'draft', 'reply'];

export interface WhatsAppAgentPolicy {
    mode: AgentMode;
    /** Attesa dopo l'ultimo messaggio del cliente: chi scrive in tre righe
     *  riceve una risposta sola. */
    debounce_seconds: number;
    /** Tetto all'attesa dal primo messaggio, per chi scrive senza fermarsi. */
    max_wait_seconds: number;
    /** Se lo staff ha scritto a mano da poco, l'agente non si intromette. */
    staff_quiet_minutes: number;
    /** Risposte dell'agente per conversazione nelle 24 ore. */
    max_replies_per_thread_24h: number;
    /** Giri al giorno per tutto il locale. */
    max_runs_per_day: number;
    /** Spesa AI al giorno; oltre, l'agente passa a sole bozze fino a domani. */
    daily_budget_eur: number;
}

export const DEFAULT_AGENT_POLICY: WhatsAppAgentPolicy = {
    mode: 'off',
    debounce_seconds: 20,
    max_wait_seconds: 60,
    staff_quiet_minutes: 30,
    max_replies_per_thread_24h: 6,
    max_runs_per_day: 120,
    daily_budget_eur: 5,
};

const LIMITS: Record<Exclude<keyof WhatsAppAgentPolicy, 'mode'>, [number, number]> = {
    debounce_seconds: [5, 300],
    max_wait_seconds: [10, 900],
    staff_quiet_minutes: [0, 240],
    max_replies_per_thread_24h: [1, 50],
    max_runs_per_day: [1, 2000],
    daily_budget_eur: [0.5, 100],
};

const SETTINGS_KEY = 'whatsapp_agent_policy';

/** Valida una politica (anche parziale, sopra il default); null se un
 *  valore è fuori dai limiti. */
export function normalizeAgentPolicy(raw: unknown, base: WhatsAppAgentPolicy = DEFAULT_AGENT_POLICY): WhatsAppAgentPolicy | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    const out: WhatsAppAgentPolicy = { ...base };
    if (r.mode !== undefined) {
        if (!AGENT_MODES.includes(r.mode as AgentMode)) return null;
        out.mode = r.mode as AgentMode;
    }
    for (const [key, [min, max]] of Object.entries(LIMITS) as Array<[keyof typeof LIMITS, [number, number]]>) {
        if (r[key] === undefined) continue;
        const n = Number(r[key]);
        if (!Number.isFinite(n) || n < min || n > max) return null;
        out[key] = key === 'daily_budget_eur' ? Math.round(n * 100) / 100 : Math.trunc(n);
    }
    if (out.max_wait_seconds < out.debounce_seconds) out.max_wait_seconds = out.debounce_seconds;
    return out;
}

export async function getAgentPolicy(tenantId: number): Promise<WhatsAppAgentPolicy> {
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const normalized = normalizeAgentPolicy(JSON.parse(raw));
            if (normalized) return normalized;
        }
    } catch (err: any) {
        console.error('[whatsapp] lettura politica agente fallita:', err?.message || err);
    }
    return { ...DEFAULT_AGENT_POLICY };
}

export async function saveAgentPolicy(tenantId: number, policy: WhatsAppAgentPolicy): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}
