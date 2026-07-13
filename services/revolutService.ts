// Revolut Merchant API wrapper — create hosted-checkout orders and validate
// incoming webhook signatures. Everything is env-driven so the same code
// runs against the sandbox (default) and production merchant endpoints.
//
// https://developer.revolut.com/docs/merchant/create-order
// https://developer.revolut.com/docs/guides/accept-payments/tutorials/work-with-webhooks/verify-the-payload-signature

import crypto from 'crypto';
import type express from 'express';

const REVOLUT_API_BASE = process.env.REVOLUT_API_BASE || 'https://sandbox-merchant.revolut.com';
const REVOLUT_API_VERSION = process.env.REVOLUT_API_VERSION || '2024-09-01';
const REVOLUT_API_KEY = process.env.REVOLUT_API_KEY || '';
const REVOLUT_WEBHOOK_SIGNING_SECRET = process.env.REVOLUT_WEBHOOK_SIGNING_SECRET || '';

export function isRevolutConfigured(): boolean {
    return !!REVOLUT_API_KEY;
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
    if (!REVOLUT_API_KEY) {
        throw new Error('Revolut is not configured (REVOLUT_API_KEY is missing)');
    }

    const body = {
        amount: Math.round(input.amount),
        currency: input.currency,
        description: input.description,
        merchant_order_ext_ref: input.merchant_order_ext_ref,
        redirect_url: input.redirect_url,
    };

    const response = await fetch(`${REVOLUT_API_BASE}/api/orders`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${REVOLUT_API_KEY}`,
            'Revolut-Api-Version': REVOLUT_API_VERSION,
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
export function verifyWebhookSignature(req: express.Request): WebhookVerificationResult {
    if (!REVOLUT_WEBHOOK_SIGNING_SECRET) {
        return { valid: false, reason: 'REVOLUT_WEBHOOK_SIGNING_SECRET not set' };
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
    const expected = crypto.createHmac('sha256', REVOLUT_WEBHOOK_SIGNING_SECRET).update(payload).digest('hex');

    // Support comma-separated multi-signature during rotation, and both
    // "v1=..." and bare hex forms defensively.
    const candidates = signatureHeader.split(',').map(s => s.trim()).map(s => s.startsWith('v1=') ? s.slice(3) : s);
    for (const candidate of candidates) {
        if (timingSafeEqualHex(candidate, expected)) return { valid: true };
    }

    return { valid: false, reason: 'signature mismatch' };
}
