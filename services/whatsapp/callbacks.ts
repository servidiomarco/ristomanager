// L'URL di stato che si passa a Twilio a ogni invio. Sta fuori da config.ts
// perché legge il token webhook del ristorante dal database.

import { queryWithRetry } from '../../db.js';
import { backendBaseUrl } from './config.js';

const webhookTokenCache = new Map<number, { token: string | null; at: number }>();
const WEBHOOK_TOKEN_TTL_MS = 60_000;

async function tenantWebhookToken(tenantId: number): Promise<string | null> {
    const cached = webhookTokenCache.get(tenantId);
    if (cached && Date.now() - cached.at <= WEBHOOK_TOKEN_TTL_MS) return cached.token;
    try {
        const r = await queryWithRetry('SELECT webhook_token FROM tenants WHERE id = $1', [tenantId]);
        const token: string | null = r.rows[0]?.webhook_token ?? null;
        webhookTokenCache.set(tenantId, { token, at: Date.now() });
        return token;
    } catch (err: any) {
        console.warn('[whatsapp] lettura del token webhook fallita:', err?.message || err);
        return cached ? cached.token : null;
    }
}

/**
 * L'URL a cui Twilio manda l'esito di un messaggio.
 *
 * Prima era sempre il percorso storico /webhook/twilio-whatsapp-status, che
 * vale come tenant 1: l'esito di un messaggio di un altro ristorante veniva
 * cercato fra le righe del tenant 1, non si trovava, e consegna e ripiego su
 * SMS si perdevano in silenzio. Col token del ristorante l'esito torna a lui.
 * Senza token resta il percorso storico, come prima.
 */
export async function statusCallbackUrl(tenantId: number): Promise<string | null> {
    const base = backendBaseUrl();
    if (!base) return null;
    const token = await tenantWebhookToken(tenantId);
    return token
        ? `${base}/webhook/t/${token}/twilio-whatsapp-status`
        : `${base}/webhook/twilio-whatsapp-status`;
}
