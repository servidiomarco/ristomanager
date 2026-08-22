// Comportamento della blacklist per fonte di prenotazione (Impostazioni →
// Opzioni prenotazioni → Blacklist). Card #27, reso configurabile per tenant.
//
// Per ogni fonte il tenant sceglie cosa fare quando il numero è in blacklist:
//  - 'block': la prenotazione viene rifiutata (sui canali self-service con una
//    frase neutra; sul manuale il salvataggio fa 409 e lo staff vede perché);
//  - 'warn': la prenotazione passa e lo staff vede gli indicatori nel CRM
//    (banner nel modal, badge su card e rubrica).
//
// Il default riproduce il comportamento del primo rilascio della feature —
// blocco su web e voce, avviso su manuale e WhatsApp — così nessun tenant
// cambia condotta al deploy.
import { queryWithRetry } from '../db.js';

export type BlacklistBehavior = 'block' | 'warn';
export type BlacklistSource = 'MANUAL' | 'GOOGLE' | 'VOICE' | 'WHATSAPP';

export type BlacklistPolicyMap = Record<BlacklistSource, BlacklistBehavior>;

export const BLACKLIST_SOURCES: readonly BlacklistSource[] = ['MANUAL', 'GOOGLE', 'VOICE', 'WHATSAPP'];

const SETTINGS_KEY = 'blacklist_policy';

export const DEFAULT_BLACKLIST_POLICY: BlacklistPolicyMap = {
    MANUAL: 'warn',
    GOOGLE: 'block',
    VOICE: 'block',
    WHATSAPP: 'warn',
};

const isBehavior = (v: unknown): v is BlacklistBehavior => v === 'block' || v === 'warn';

/** Legge la policy del tenant; le fonti mancanti o malformate cadono sul default. */
export async function getBlacklistPolicy(tenantId: number): Promise<BlacklistPolicyMap> {
    const policy: BlacklistPolicyMap = { ...DEFAULT_BLACKLIST_POLICY };
    try {
        const res = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, SETTINGS_KEY]
        );
        const raw = res.rows[0]?.text_value;
        if (typeof raw === 'string' && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                for (const source of BLACKLIST_SOURCES) {
                    if (isBehavior(parsed[source])) policy[source] = parsed[source];
                }
            }
        }
    } catch (err: any) {
        console.error('[blacklist-policy] lettura policy fallita:', err?.message || err);
    }
    return policy;
}

/** Sovrascrive la policy (già validata dal chiamante) del tenant. */
export async function saveBlacklistPolicy(tenantId: number, policy: BlacklistPolicyMap): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE
           SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, SETTINGS_KEY, JSON.stringify(policy)]
    );
}

export const isBlacklistBehavior = isBehavior;
