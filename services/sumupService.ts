// SumUp Online Payments wrapper — create Hosted Checkout sessions, poll their
// status, deactivate them and refund the resulting transaction. Configuration
// is layered exactly like services/revolutService.ts: the DB row in
// `integration_settings` (provider = 'sumup') wins, with per-field fallback to
// env vars, so an install without a DB row still works from the environment
// and a save from the Settings UI takes effect on the next request.
//
// Two things differ from Revolut and drive most of the shape of this file:
//
//  1. SumUp uses ONE base URL (https://api.sumup.com) for both sandbox and
//     production — the environment is decided by which API key you send, and a
//     sandbox key belongs to a sandbox merchant account created from the SumUp
//     dashboard. So `environment` here selects a *credential pair*
//     (api key + merchant code) rather than a host, which also means the
//     operator can keep both sets saved and flip between them.
//  2. SumUp amounts are in MAJOR units (12.5 = €12.50). Every function in this
//     module takes/returns MINOR units (cents) so callers share one convention
//     with the Revolut path; conversion happens at the API boundary only.
//
// https://developer.sumup.com/api/checkouts/create
// https://developer.sumup.com/online-payments/checkouts/hosted-checkout

import crypto from 'crypto';
import { queryWithRetry } from '../db.js';

export type SumUpEnvironment = 'sandbox' | 'production';

// Same host for both environments — see note 1 above.
const API_BASE = 'https://api.sumup.com';

export interface SumUpConfig {
    environment: SumUpEnvironment;
    apiBase: string;
    // Credentials for the ACTIVE environment (already resolved).
    apiKey: string;
    merchantCode: string;
    // Shared across environments: opaque token embedded in the return_url we
    // register on each checkout, so /webhook/sumup/:token can cheaply reject
    // traffic that didn't come from a checkout we created.
    callbackSecret: string;
    // Kept so the settings endpoint can report which environments are ready
    // without a second DB round-trip.
    productionConfigured: boolean;
    sandboxConfigured: boolean;
    productionKeyLast4: string | null;
    sandboxKeyLast4: string | null;
    productionMerchantCode: string;
    sandboxMerchantCode: string;
}

// Short TTL cache, mirroring revolutService: keeps the hot path cheap while
// still picking up a manual DB edit. Explicit invalidation after a save.
const CACHE_TTL_MS = 30_000;
let cache: { config: SumUpConfig; loadedAt: number } | null = null;

interface RawCredentials {
    environment: SumUpEnvironment;
    prodKey: string;
    prodMerchant: string;
    sandboxKey: string;
    sandboxMerchant: string;
    callbackSecret: string;
}

function envDefaults(): RawCredentials {
    const raw = (process.env.SUMUP_ENVIRONMENT || '').trim().toLowerCase();
    return {
        environment: raw === 'production' ? 'production' : 'sandbox',
        prodKey: process.env.SUMUP_API_KEY || '',
        prodMerchant: process.env.SUMUP_MERCHANT_CODE || '',
        sandboxKey: process.env.SUMUP_SANDBOX_API_KEY || '',
        sandboxMerchant: process.env.SUMUP_SANDBOX_MERCHANT_CODE || '',
        callbackSecret: process.env.SUMUP_CALLBACK_SECRET || '',
    };
}

function assemble(raw: RawCredentials): SumUpConfig {
    const isProd = raw.environment === 'production';
    return {
        environment: raw.environment,
        apiBase: API_BASE,
        apiKey: isProd ? raw.prodKey : raw.sandboxKey,
        merchantCode: isProd ? raw.prodMerchant : raw.sandboxMerchant,
        callbackSecret: raw.callbackSecret,
        productionConfigured: !!(raw.prodKey && raw.prodMerchant),
        sandboxConfigured: !!(raw.sandboxKey && raw.sandboxMerchant),
        productionKeyLast4: raw.prodKey ? raw.prodKey.slice(-4) : null,
        sandboxKeyLast4: raw.sandboxKey ? raw.sandboxKey.slice(-4) : null,
        productionMerchantCode: raw.prodMerchant,
        sandboxMerchantCode: raw.sandboxMerchant,
    };
}

// Merge the DB row over env-var defaults field by field. Empty strings in the
// DB count as "not set" so a partial save behaves as expected.
async function loadFromDb(): Promise<SumUpConfig> {
    const defaults = envDefaults();
    try {
        const result = await queryWithRetry(
            `SELECT environment, api_key, webhook_secret,
                    sumup_merchant_code, sumup_sandbox_api_key, sumup_sandbox_merchant_code
             FROM integration_settings WHERE provider = 'sumup' LIMIT 1`
        );
        const row = result.rows[0];
        if (!row) return assemble(defaults);
        const pick = (value: unknown, fallback: string): string => {
            const trimmed = value == null ? '' : String(value).trim();
            return trimmed || fallback;
        };
        return assemble({
            environment: row.environment === 'production' ? 'production' : 'sandbox',
            prodKey: pick(row.api_key, defaults.prodKey),
            prodMerchant: pick(row.sumup_merchant_code, defaults.prodMerchant),
            sandboxKey: pick(row.sumup_sandbox_api_key, defaults.sandboxKey),
            sandboxMerchant: pick(row.sumup_sandbox_merchant_code, defaults.sandboxMerchant),
            callbackSecret: pick(row.webhook_secret, defaults.callbackSecret),
        });
    } catch (err) {
        console.warn('[SumUp] loadFromDb failed, using env fallbacks:', (err as any)?.message || err);
        return assemble(defaults);
    }
}

async function getConfig(force = false): Promise<SumUpConfig> {
    const now = Date.now();
    if (!force && cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;
    const config = await loadFromDb();
    cache = { config, loadedAt: now };
    return config;
}

// Called by the settings endpoint after a successful DB write so the next
// checkout picks up the new values immediately.
export function invalidateSumUpConfigCache(): void {
    cache = null;
}

// "Configured" means the ACTIVE environment has both halves of the credential
// pair — a key without a merchant code can't create a checkout.
export async function isSumUpConfigured(): Promise<boolean> {
    const config = await getConfig();
    return !!(config.apiKey && config.merchantCode);
}

// Snapshot for GET /settings/integrations/sumup — never leaks a full secret.
export async function getSumUpConfigStatus(): Promise<{
    environment: SumUpEnvironment;
    api_base: string;
    configured: boolean;
    has_api_key: boolean;
    has_merchant_code: boolean;
    api_key_last4: string | null;
    merchant_code: string;
    production_configured: boolean;
    sandbox_configured: boolean;
    production_api_key_last4: string | null;
    sandbox_api_key_last4: string | null;
    production_merchant_code: string;
    sandbox_merchant_code: string;
    has_callback_secret: boolean;
    callback_secret_last4: string | null;
}> {
    const config = await getConfig(true);
    return {
        environment: config.environment,
        api_base: config.apiBase,
        configured: !!(config.apiKey && config.merchantCode),
        has_api_key: !!config.apiKey,
        has_merchant_code: !!config.merchantCode,
        api_key_last4: config.apiKey ? config.apiKey.slice(-4) : null,
        merchant_code: config.merchantCode,
        production_configured: config.productionConfigured,
        sandbox_configured: config.sandboxConfigured,
        production_api_key_last4: config.productionKeyLast4,
        sandbox_api_key_last4: config.sandboxKeyLast4,
        production_merchant_code: config.productionMerchantCode,
        sandbox_merchant_code: config.sandboxMerchantCode,
        has_callback_secret: !!config.callbackSecret,
        callback_secret_last4: config.callbackSecret ? config.callbackSecret.slice(-4) : null,
    };
}

// The token that ends up in the return_url path. Exposed so the webhook route
// can compare it against what SumUp called us back on.
export async function getSumUpCallbackSecret(): Promise<string> {
    const config = await getConfig();
    return config.callbackSecret;
}

// Constant-time compare for the callback token — the path segment is
// attacker-controlled, so avoid leaking it through response timing.
export function callbackTokenMatches(candidate: string, expected: string): boolean {
    if (!expected) return false;
    const a = Buffer.from(String(candidate ?? ''), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    try {
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// ============================================
// Checkouts API
// ============================================

export type SumUpCheckoutStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED';

export interface SumUpCheckout {
    id: string;
    checkout_reference: string;
    status: SumUpCheckoutStatus | string;
    // Present only when hosted_checkout.enabled was set on creation.
    hosted_checkout_url?: string;
    amount?: number;
    currency?: string;
    merchant_code?: string;
    transaction_id?: string;
    transactions?: Array<{ id?: string; status?: string; transaction_code?: string }>;
}

export interface SumUpCreateCheckoutInput {
    // Minor units (cents), converted to SumUp's major units on the way out.
    amount: number;
    currency: string;
    description?: string;
    // Our own correlation reference, echoed back on the checkout resource.
    // Truncated + suffixed to satisfy SumUp's 90-char unique-ish requirement.
    reference?: string;
    // Browser redirect after the payer finishes on the hosted page.
    redirectUrl?: string;
    // Server-to-server callback SumUp pings on status changes.
    returnUrl?: string;
}

// SumUp wants major units as a JSON number. Going through toFixed(2) keeps
// 1999 cents from serialising as 19.990000000000002.
function minorToMajor(amountMinor: number): number {
    return Number((Math.round(amountMinor) / 100).toFixed(2));
}

// `checkout_reference` must be unique per checkout: a retried claim on the
// same split would otherwise collide. Keep the caller's semantic prefix (it
// is what an operator scans for in the SumUp dashboard) and append entropy,
// staying inside the 90-char limit.
function buildCheckoutReference(reference: string | undefined): string {
    const suffix = crypto.randomBytes(6).toString('hex');
    const prefix = (reference || 'payment').slice(0, 90 - suffix.length - 1);
    return `${prefix}:${suffix}`;
}

async function sumupFetch(
    config: SumUpConfig,
    path: string,
    init: { method: string; body?: unknown }
): Promise<any> {
    const response = await fetch(`${config.apiBase}${path}`, {
        method: init.method,
        headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Accept': 'application/json',
            ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });

    const text = await response.text();
    let parsed: any;
    try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = text; }

    if (!response.ok) {
        const detail = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        const err: any = new Error(`SumUp ${init.method} ${path} ${response.status}: ${detail}`);
        err.status = response.status;
        err.body = parsed;
        throw err;
    }
    return parsed;
}

async function requireConfig(): Promise<SumUpConfig> {
    const config = await getConfig();
    if (!config.apiKey || !config.merchantCode) {
        throw new Error(
            `SumUp non è configurato per l'ambiente ${config.environment} (API key o merchant code mancante)`
        );
    }
    return config;
}

// POST /v0.1/checkouts with hosted_checkout.enabled — returns the checkout
// plus the SumUp-hosted payment page URL we hand to the guest.
export async function createCheckout(input: SumUpCreateCheckoutInput): Promise<SumUpCheckout> {
    const config = await requireConfig();

    const body: Record<string, unknown> = {
        checkout_reference: buildCheckoutReference(input.reference),
        amount: minorToMajor(input.amount),
        currency: input.currency,
        merchant_code: config.merchantCode,
        hosted_checkout: { enabled: true },
    };
    if (input.description) body.description = input.description;
    if (input.redirectUrl) body.redirect_url = input.redirectUrl;
    if (input.returnUrl) body.return_url = input.returnUrl;

    const parsed = await sumupFetch(config, '/v0.1/checkouts', { method: 'POST', body });

    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
        console.error('[SumUp] Unexpected checkout response shape:', parsed);
        throw new Error('SumUp createCheckout: risposta senza id');
    }
    if (!parsed.hosted_checkout_url) {
        // Hosted Checkout has to be enabled on the merchant account; without
        // the URL there is nothing to send the guest to, so fail loudly
        // instead of persisting a payment request nobody can pay.
        console.error('[SumUp] checkout created without hosted_checkout_url:', parsed);
        throw new Error('SumUp createCheckout: hosted_checkout_url mancante (Hosted Checkout non abilitato sull\'account?)');
    }

    return parsed as SumUpCheckout;
}

// GET /v0.1/checkouts/{id} — authoritative state. Used by the callback
// handler (which never trusts the posted body) and by manual reconciliation.
export async function getCheckout(checkoutId: string): Promise<SumUpCheckout> {
    const config = await requireConfig();
    const parsed = await sumupFetch(config, `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { method: 'GET' });
    if (!parsed || typeof parsed !== 'object' || !parsed.id) {
        console.error('[SumUp] Unexpected getCheckout response shape:', parsed);
        throw new Error('SumUp getCheckout: risposta senza id');
    }
    return parsed as SumUpCheckout;
}

// DELETE /v0.1/checkouts/{id} — deactivates a not-yet-processed checkout so
// its hosted page stops accepting payment. Same role as Revolut's cancel: a
// bill-split claim that expires must not leave a payable link alive, or the
// guest can pay a share someone else has already re-claimed.
// SumUp answers 409 CHECKOUT_PROCESSED when it is too late; we surface that
// so the caller re-reads the checkout and reconciles instead of guessing.
export async function deactivateCheckout(checkoutId: string): Promise<SumUpCheckout> {
    const config = await requireConfig();
    const parsed = await sumupFetch(config, `/v0.1/checkouts/${encodeURIComponent(checkoutId)}`, { method: 'DELETE' });
    return (parsed && typeof parsed === 'object' ? parsed : { id: checkoutId, status: 'EXPIRED' }) as SumUpCheckout;
}

// Pull the id of the successful transaction out of a checkout resource.
// SumUp exposes it either flat (`transaction_id`, on the "checkout success"
// shape) or inside the `transactions` array — refunds need it because they
// are keyed on the transaction, not on the checkout.
export function extractTransactionId(checkout: SumUpCheckout): string | null {
    if (checkout.transaction_id) return checkout.transaction_id;
    const list = Array.isArray(checkout.transactions) ? checkout.transactions : [];
    const successful = list.find(t => String(t?.status || '').toUpperCase() === 'SUCCESSFUL');
    return (successful?.id || list[0]?.id) ?? null;
}

// POST /v1.0/merchants/{merchant_code}/payments/{transaction_id}/refunds.
// Takes the CHECKOUT id (that's what we persist as provider_order_id) and
// resolves the transaction itself, so callers keep one identifier throughout.
// `amountMinor` may be a partial refund; we only ever refund whole splits.
export async function refundCheckout(
    checkoutId: string,
    amountMinor: number,
    _currency: string,
    _description?: string
): Promise<any> {
    const config = await requireConfig();

    const checkout = await getCheckout(checkoutId);
    const transactionId = extractTransactionId(checkout);
    if (!transactionId) {
        throw new Error(`SumUp refund: nessuna transazione riuscita sul checkout ${checkoutId}`);
    }

    // SumUp has no description field on refunds and derives the currency from
    // the original transaction, hence the unused parameters — they exist to
    // keep the signature interchangeable with the Revolut refund.
    return sumupFetch(
        config,
        `/v1.0/merchants/${encodeURIComponent(config.merchantCode)}/payments/${encodeURIComponent(transactionId)}/refunds`,
        { method: 'POST', body: { amount: minorToMajor(amountMinor) } }
    );
}
