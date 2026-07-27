// Revolut Merchant API wrapper — create hosted-checkout orders and validate
// incoming webhook signatures. Configuration is layered: DB row in
// `integration_settings` wins, per-field fallback to env vars. So an install
// without a DB row keeps behaving like the previous env-only version, and
// updates from the Settings UI take effect on the next request (cache is
// refreshed lazily and can be invalidated explicitly after a save).
//
// https://developer.revolut.com/docs/merchant/create-order
// https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature

import crypto from 'crypto';
import type express from 'express';
import { queryWithRetry } from '../db.js';

export type RevolutEnvironment = 'sandbox' | 'production';

const SANDBOX_BASE = 'https://sandbox-merchant.revolut.com';
const PRODUCTION_BASE = 'https://merchant.revolut.com';

export interface RevolutConfig {
    environment: RevolutEnvironment;
    apiBase: string;
    apiVersion: string;
    apiKey: string;
    webhookSecret: string;
}

// In-memory cache to keep the hot path (createOrder, verifyWebhookSignature)
// synchronous where possible. TTL is short so a manual DB edit still
// propagates; explicit invalidation is preferred after PUT /settings/....
const CACHE_TTL_MS = 30_000;
let cache: { config: RevolutConfig; loadedAt: number } | null = null;

// Env-only defaults used before the DB is reachable or when no row exists.
function envDefaults(): RevolutConfig {
    const environment: RevolutEnvironment = process.env.REVOLUT_API_BASE?.includes('sandbox') !== false
        ? 'sandbox'
        : 'production';
    return {
        environment,
        apiBase: process.env.REVOLUT_API_BASE || SANDBOX_BASE,
        apiVersion: process.env.REVOLUT_API_VERSION || '2024-09-01',
        apiKey: process.env.REVOLUT_API_KEY || '',
        webhookSecret: process.env.REVOLUT_WEBHOOK_SIGNING_SECRET || '',
    };
}

function baseForEnvironment(env: RevolutEnvironment): string {
    return env === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;
}

// Merge DB row over env-var defaults on a per-field basis. Empty strings in
// the DB are treated as "not set" so partial saves work as expected.
async function loadFromDb(): Promise<RevolutConfig> {
    const defaults = envDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT environment, api_key, webhook_secret, api_version
             FROM integration_settings WHERE provider = 'revolut' LIMIT 1`
        );
        const row = result.rows[0];
        if (!row) return defaults;
        const environment: RevolutEnvironment =
            row.environment === 'production' ? 'production' : 'sandbox';
        const apiKey = (row.api_key && String(row.api_key).trim()) || defaults.apiKey;
        const webhookSecret = (row.webhook_secret && String(row.webhook_secret).trim()) || defaults.webhookSecret;
        const apiVersion = (row.api_version && String(row.api_version).trim()) || defaults.apiVersion;
        return {
            environment,
            apiBase: baseForEnvironment(environment),
            apiVersion,
            apiKey,
            webhookSecret,
        };
    } catch (err) {
        console.warn('[Revolut] loadFromDb failed, using env fallbacks:', (err as any)?.message || err);
        return defaults;
    }
}

async function getConfig(force = false): Promise<RevolutConfig> {
    const now = Date.now();
    if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;
    const config = await loadFromDb();
    cache = { config, loadedAt: now };
    return config;
}

// Called by the settings endpoint after a successful DB write so the next
// createOrder/verifyWebhookSignature picks up the new values immediately.
export function invalidateRevolutConfigCache(): void {
    cache = null;
}

// Kept as an async function so future callers can await a fresh config load
// (the /settings endpoint uses this). Callers that only care about "do we
// have any API key at all" can await this cheaply — it's cached.
export async function isRevolutConfigured(): Promise<boolean> {
    const config = await getConfig();
    return !!config.apiKey;
}

// Snapshot of the current config, without secrets. Used by GET /settings/....
export async function getRevolutConfigStatus(): Promise<{
    environment: RevolutEnvironment;
    api_base: string;
    api_version: string;
    has_api_key: boolean;
    has_webhook_secret: boolean;
    api_key_last4: string | null;
    webhook_secret_last4: string | null;
}> {
    const config = await getConfig(true);
    return {
        environment: config.environment,
        api_base: config.apiBase,
        api_version: config.apiVersion,
        has_api_key: !!config.apiKey,
        has_webhook_secret: !!config.webhookSecret,
        api_key_last4: config.apiKey ? config.apiKey.slice(-4) : null,
        webhook_secret_last4: config.webhookSecret ? config.webhookSecret.slice(-4) : null,
    };
}

export interface RevolutCreateOrderInput {
    // Amount in minor units (e.g. 1000 = €10.00).
    amount: number;
    currency: string;
    description?: string;
    // Free-form reference the merchant can use to correlate the order with a
    // domain entity. Echoed back in webhook events as `merchant_order_ext_ref`.
    merchant_order_ext_ref?: string;
    // Where the shopper is redirected after a successful/cancelled payment.
    redirect_url?: string;
}

export interface RevolutOrder {
    id: string;
    token?: string;
    state: string;
    checkout_url: string;
    amount: number;
    currency: string;
    created_at?: string;
    updated_at?: string;
}

// POST /api/orders — creates a hosted-checkout order and returns the payment
// URL to hand to the customer. Throws on non-2xx responses; the error message
// includes the Revolut error body to make debugging easier.
export async function createOrder(input: RevolutCreateOrderInput): Promise<RevolutOrder> {
    const config = await getConfig();
    if (!config.apiKey) {
        throw new Error('Revolut is not configured (API key missing)');
    }

    const body = {
        amount: Math.round(input.amount),
        currency: input.currency,
        description: input.description,
        merchant_order_ext_ref: input.merchant_order_ext_ref,
        redirect_url: input.redirect_url,
    };

    const response = await fetch(`${config.apiBase}/api/orders`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Revolut-Api-Version': config.apiVersion,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!response.ok) {
        console.error('[Revolut] createOrder failed', response.status, parsed);
        throw new Error(`Revolut createOrder ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.checkout_url) {
        console.error('[Revolut] Unexpected order response shape:', parsed);
        throw new Error('Revolut createOrder: response missing id/checkout_url');
    }

    return parsed as RevolutOrder;
}

// POST /api/orders/{id}/cancel — voids a not-yet-paid order so its hosted
// checkout stops accepting payment. Vital when a bill-split claim expires:
// without this the customer can keep the checkout tab open past our TTL and
// pay a share that has already been re-claimed by someone else (overpayment).
// Throws on non-2xx EXCEPT when Revolut refuses because the order is already
// in a terminal state — callers must re-getOrder and reconcile in that case.
export async function cancelOrder(orderId: string): Promise<RevolutOrder> {
    const config = await getConfig();
    if (!config.apiKey) {
        throw new Error('Revolut is not configured (API key missing)');
    }

    const response = await fetch(`${config.apiBase}/api/orders/${encodeURIComponent(orderId)}/cancel`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Revolut-Api-Version': config.apiVersion,
            'Accept': 'application/json',
        },
    });

    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!response.ok) {
        console.error('[Revolut] cancelOrder failed', response.status, parsed);
        throw new Error(`Revolut cancelOrder ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    return (parsed && typeof parsed === 'object' ? parsed : { id: orderId, state: 'CANCELLED' }) as RevolutOrder;
}

// POST /api/orders/{id}/refund — sends money back to the customer for a
// COMPLETED order. Amount is in minor units and may be partial; we only ever
// refund whole splits, so callers pass the split's amount_cents verbatim.
export async function refundOrder(orderId: string, amountMinor: number, currency: string, description?: string): Promise<any> {
    const config = await getConfig();
    if (!config.apiKey) {
        throw new Error('Revolut is not configured (API key missing)');
    }

    const response = await fetch(`${config.apiBase}/api/orders/${encodeURIComponent(orderId)}/refund`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Revolut-Api-Version': config.apiVersion,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        },
        body: JSON.stringify({
            amount: Math.round(amountMinor),
            currency,
            description: description || undefined,
        }),
    });

    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!response.ok) {
        console.error('[Revolut] refundOrder failed', response.status, parsed);
        throw new Error(`Revolut refundOrder ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    return parsed;
}

// GET /api/orders/{id} — retrieves the authoritative state of an order. Used
// by the manual reconciliation endpoint when a webhook was missed (e.g. an
// order created before the webhook endpoint existed, or a delivery Revolut
// gave up on). Returns the raw response as-is: callers care about `state`.
export async function getOrder(orderId: string): Promise<RevolutOrder> {
    const config = await getConfig();
    if (!config.apiKey) {
        throw new Error('Revolut is not configured (API key missing)');
    }

    const response = await fetch(`${config.apiBase}/api/orders/${encodeURIComponent(orderId)}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Revolut-Api-Version': config.apiVersion,
            'Accept': 'application/json',
        },
    });

    const text = await response.text();
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { parsed = text; }

    if (!response.ok) {
        console.error('[Revolut] getOrder failed', response.status, parsed);
        throw new Error(`Revolut getOrder ${response.status}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
        console.error('[Revolut] Unexpected order response shape:', parsed);
        throw new Error('Revolut getOrder: response missing id');
    }

    return parsed as RevolutOrder;
}

// Constant-time string compare — prevents timing-oracle attacks against the
// webhook signature check.
function timingSafeEqualHex(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
    } catch {
        return false;
    }
}

export interface WebhookVerificationResult {
    valid: boolean;
    reason?: string;
}

// Revolut signs webhooks as `Revolut-Signature: v1=<hex>` (multiple values
// separated by commas during a signing-secret rotation). Payload-to-sign is
// `v1.{timestamp}.{rawBody}`, HMAC-SHA256 with the webhook signing secret.
// `Revolut-Request-Timestamp` header prevents replay attacks — we reject
// requests older than 5 minutes.
export async function verifyWebhookSignature(req: express.Request): Promise<WebhookVerificationResult> {
    const config = await getConfig();
    if (!config.webhookSecret) {
        return { valid: false, reason: 'webhook signing secret not set' };
    }

    const signatureHeader = req.header('Revolut-Signature') || req.header('revolut-signature');
    const timestampHeader = req.header('Revolut-Request-Timestamp') || req.header('revolut-request-timestamp');
    const rawBody: Buffer | undefined = (req as any).rawBody;

    if (!signatureHeader) return { valid: false, reason: 'missing Revolut-Signature header' };
    if (!timestampHeader) return { valid: false, reason: 'missing Revolut-Request-Timestamp header' };
    if (!rawBody) return { valid: false, reason: 'rawBody unavailable — check express.json verify hook' };

    // Replay protection: timestamp is in milliseconds. Allow ±5 min drift.
    const ts = Number(timestampHeader);
    if (!Number.isFinite(ts)) return { valid: false, reason: 'invalid timestamp' };
    const ageMs = Math.abs(Date.now() - ts);
    if (ageMs > 5 * 60 * 1000) {
        return { valid: false, reason: `timestamp too old (${Math.round(ageMs / 1000)}s)` };
    }

    const payload = `v1.${timestampHeader}.${rawBody.toString('utf8')}`;
    const expected = crypto.createHmac('sha256', config.webhookSecret).update(payload).digest('hex');

    // Support comma-separated multi-signature during rotation, and both
    // "v1=..." and bare hex forms defensively.
    const candidates = signatureHeader.split(',').map(s => s.trim()).map(s => s.startsWith('v1=') ? s.slice(3) : s);
    for (const candidate of candidates) {
        if (timingSafeEqualHex(candidate, expected)) return { valid: true };
    }

    return { valid: false, reason: 'signature mismatch' };
}
