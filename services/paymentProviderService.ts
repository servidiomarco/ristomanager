// Provider-agnostic façade over the payment gateways we can charge through.
//
// Everything downstream of a payment — payment_requests rows, bill-split
// reconciliation, the deposit-confirmation flow — was written against
// Revolut's vocabulary (minor units, ORDER_* events). Rather than rewrite it
// for SumUp, this module normalises SumUp onto that same vocabulary and
// dispatches per call:
//
//  - NEW payments go to whichever provider is active
//    (app_settings.active_payment_provider, default 'revolut' so existing
//    installs keep behaving exactly as before);
//  - EXISTING payments are always handled by the provider recorded on their
//    payment_requests.provider column, so a mid-flight order stays with the
//    gateway that created it even after the operator switches providers.
//
// Amounts are minor units (cents) everywhere in this interface.

import { queryWithRetry } from '../db.js';
import {
    isRevolutConfigured,
    createOrder as revolutCreateOrder,
    cancelOrder as revolutCancelOrder,
    refundOrder as revolutRefundOrder,
    getOrder as revolutGetOrder,
} from './revolutService.js';
import {
    isSumUpConfigured,
    createCheckout as sumupCreateCheckout,
    deactivateCheckout as sumupDeactivateCheckout,
    refundCheckout as sumupRefundCheckout,
    getCheckout as sumupGetCheckout,
    getSumUpCallbackSecret,
    extractTransactionId,
} from './sumupService.js';

export type PaymentProvider = 'revolut' | 'sumup';

export const PAYMENT_PROVIDERS: PaymentProvider[] = ['revolut', 'sumup'];

export function isPaymentProvider(value: unknown): value is PaymentProvider {
    return value === 'revolut' || value === 'sumup';
}

// Base URL where the SPA is served. Payment redirects and the SumUp
// server-to-server callback are both built from it. Kept here (rather than in
// server.ts) because the provider modules need it too; server.ts delegates.
export function publicBaseUrl(): string {
    const raw = (process.env.CRM_APP_BASE_URL || 'https://crm.vecchiofrantoio.com').trim();
    return raw.replace(/\/+$/, '');
}

// ============================================
// Active provider (app_settings.active_payment_provider)
// ============================================

const ACTIVE_PROVIDER_KEY = 'active_payment_provider';
const DEFAULT_PROVIDER: PaymentProvider = 'revolut';
const CACHE_TTL_MS = 30_000;
// Cache per tenant: una Map e non una singola entry, altrimenti il provider
// scelto da un ristorante resterebbe "attivo" per tutti gli altri fino alla
// scadenza del TTL.
const activeCache = new Map<number, { provider: PaymentProvider; loadedAt: number }>();

export function invalidateActivePaymentProviderCache(): void {
    activeCache.clear();
}

export async function getActivePaymentProvider(tenantId: number): Promise<PaymentProvider> {
    const now = Date.now();
    const cached = activeCache.get(tenantId);
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.provider;
    let provider: PaymentProvider = DEFAULT_PROVIDER;
    try {
        const result = await queryWithRetry(
            'SELECT text_value FROM app_settings WHERE tenant_id = $1 AND key = $2',
            [tenantId, ACTIVE_PROVIDER_KEY]
        );
        const raw = result.rows[0]?.text_value;
        if (isPaymentProvider(raw)) provider = raw;
    } catch (err) {
        console.warn('[payments] active provider lookup failed, using', DEFAULT_PROVIDER, ':', (err as any)?.message || err);
    }
    activeCache.set(tenantId, { provider, loadedAt: now });
    return provider;
}

export async function setActivePaymentProvider(tenantId: number, provider: PaymentProvider): Promise<void> {
    await queryWithRetry(
        `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
         ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
        [tenantId, ACTIVE_PROVIDER_KEY, provider]
    );
    invalidateActivePaymentProviderCache();
}

export async function isProviderConfigured(tenantId: number, provider: PaymentProvider): Promise<boolean> {
    return provider === 'sumup' ? isSumUpConfigured(tenantId) : isRevolutConfigured(tenantId);
}

// ============================================
// Per-flow overrides (caparre vs conti al tavolo)
// ============================================
// Le caparre e i conti al tavolo possono preferire gateway diversi (es.
// caparre su Revolut per i bonifici, conti su SumUp per le fee). L'override
// è opzionale: senza riga in app_settings il flusso segue il provider
// globale, così le installazioni esistenti non cambiano comportamento.

export type PaymentFlow = 'deposit' | 'bill';
export const PAYMENT_FLOWS: PaymentFlow[] = ['deposit', 'bill'];

export function isPaymentFlow(value: unknown): value is PaymentFlow {
    return value === 'deposit' || value === 'bill';
}

const FLOW_KEYS: Record<PaymentFlow, string> = {
    deposit: 'deposit_payment_provider',
    bill: 'bill_payment_provider',
};

// Stessa regola della cache del provider attivo: per tenant.
const flowCache = new Map<number, { loadedAt: number; overrides: Partial<Record<PaymentFlow, PaymentProvider>> }>();

export function invalidatePaymentProviderFlowCache(): void {
    flowCache.clear();
}

export async function getPaymentProviderOverrides(tenantId: number): Promise<Partial<Record<PaymentFlow, PaymentProvider>>> {
    const now = Date.now();
    const cached = flowCache.get(tenantId);
    if (cached && now - cached.loadedAt < CACHE_TTL_MS) return cached.overrides;
    const overrides: Partial<Record<PaymentFlow, PaymentProvider>> = {};
    try {
        const result = await queryWithRetry(
            'SELECT key, text_value FROM app_settings WHERE tenant_id = $1 AND key = ANY($2::text[])',
            [tenantId, PAYMENT_FLOWS.map(f => FLOW_KEYS[f])]
        );
        for (const flow of PAYMENT_FLOWS) {
            const raw = result.rows.find((r: any) => r.key === FLOW_KEYS[flow])?.text_value;
            if (isPaymentProvider(raw)) overrides[flow] = raw;
        }
    } catch (err) {
        console.warn('[payments] flow provider lookup failed, using global:', (err as any)?.message || err);
    }
    flowCache.set(tenantId, { loadedAt: now, overrides });
    return overrides;
}

export async function getPaymentProviderForFlow(tenantId: number, flow: PaymentFlow): Promise<PaymentProvider> {
    const overrides = await getPaymentProviderOverrides(tenantId);
    return overrides[flow] ?? getActivePaymentProvider(tenantId);
}

// provider === null rimuove l'override: il flusso torna a seguire il globale.
export async function setPaymentProviderForFlow(tenantId: number, flow: PaymentFlow, provider: PaymentProvider | null): Promise<void> {
    if (provider === null) {
        await queryWithRetry('DELETE FROM app_settings WHERE tenant_id = $1 AND key = $2', [tenantId, FLOW_KEYS[flow]]);
    } else {
        await queryWithRetry(
            `INSERT INTO app_settings (tenant_id, key, text_value, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (tenant_id, key) DO UPDATE SET text_value = EXCLUDED.text_value, updated_at = CURRENT_TIMESTAMP`,
            [tenantId, FLOW_KEYS[flow], provider]
        );
    }
    invalidatePaymentProviderFlowCache();
}

// "Possiamo incassare adesso su QUESTO flusso?" — chiede al provider
// effettivo del flusso (override o globale).
export async function isPaymentConfiguredForFlow(tenantId: number, flow: PaymentFlow): Promise<boolean> {
    return isProviderConfigured(tenantId, await getPaymentProviderForFlow(tenantId, flow));
}

// "Can we take a payment right now?" — asks the ACTIVE provider only, which
// is what every create-payment guard in server.ts wants.
export async function isPaymentConfigured(tenantId: number): Promise<boolean> {
    return isProviderConfigured(tenantId, await getActivePaymentProvider(tenantId));
}

// Italian label used in the 503 bodies the UI surfaces verbatim.
export function providerLabel(provider: PaymentProvider): string {
    return provider === 'sumup' ? 'SumUp' : 'Revolut';
}

// ============================================
// Normalised order operations
// ============================================

export interface CreatePaymentOrderInput {
    // Minor units (cents).
    amount: number;
    currency: string;
    description?: string;
    // Correlation reference echoed back by the provider (e.g.
    // "reservation:42" or "bill_split:17").
    reference?: string;
    // Where the payer's browser lands once the hosted checkout finishes.
    redirectUrl?: string;
    // Which flow this charge belongs to — resolves the per-flow provider
    // override. Omitted → global active provider (backwards compatible).
    flow?: PaymentFlow;
}

export interface NormalisedOrder {
    provider: PaymentProvider;
    // Goes into payment_requests.provider_order_id.
    id: string;
    // Goes into payment_requests.status — already in our vocabulary
    // (PENDING/AUTHORISED/COMPLETED/CANCELLED/FAILED).
    status: string;
    checkoutUrl: string;
    // Provider-specific extras merged into payment_requests.metadata.
    metadata: Record<string, unknown>;
}

// Map a provider's own order/checkout state onto the ORDER_* event vocabulary
// that applyPaymentOrderTransition consumes. Returns null when the state
// carries no transition (e.g. a checkout still waiting to be paid).
export function providerStateToEvent(provider: PaymentProvider, state: string): string | null {
    const s = (state || '').toUpperCase();
    if (provider === 'sumup') {
        switch (s) {
            case 'PAID': return 'ORDER_COMPLETED';
            case 'FAILED': return 'ORDER_PAYMENT_FAILED';
            // A SumUp checkout goes EXPIRED both when it times out and when we
            // deactivate it — either way nobody can pay it any more, which is
            // exactly what CANCELLED means downstream.
            case 'EXPIRED': return 'ORDER_CANCELLED';
            default: return null; // PENDING
        }
    }
    switch (s) {
        case 'COMPLETED': return 'ORDER_COMPLETED';
        case 'AUTHORISED': return 'ORDER_AUTHORISED';
        case 'CANCELLED': return 'ORDER_CANCELLED';
        case 'FAILED': return 'ORDER_PAYMENT_FAILED';
        case 'DECLINED': return 'ORDER_PAYMENT_DECLINED';
        default: return null;
    }
}

// The status we persist on payment_requests at creation time. Revolut hands
// back its own vocabulary already; SumUp's PENDING/PAID/FAILED/EXPIRED needs
// translating so the Pagamenti page renders one consistent set of badges.
function normaliseCreationStatus(provider: PaymentProvider, state: string | undefined): string {
    const s = (state || 'PENDING').toUpperCase();
    if (provider !== 'sumup') return s;
    switch (s) {
        case 'PAID': return 'COMPLETED';
        case 'EXPIRED': return 'CANCELLED';
        case 'FAILED': return 'FAILED';
        default: return 'PENDING';
    }
}

// Server-to-server callback URL registered on every SumUp checkout. The token
// is a cheap first-line filter — the handler still re-reads the checkout from
// SumUp before believing anything, because the callback body is unsigned.
async function sumupReturnUrl(tenantId: number): Promise<string | undefined> {
    const secret = await getSumUpCallbackSecret(tenantId);
    if (!secret) {
        // Not fatal — the reconcile poller will still settle the payment —
        // but it costs us real-time updates, so make it visible in the logs
        // instead of silently degrading.
        console.warn('[SumUp] no callback secret configured: creating checkout without return_url, '
            + 'status will only update via the reconcile job');
        return undefined;
    }
    return `${publicBaseUrl()}/webhook/sumup/${encodeURIComponent(secret)}`;
}

// Create a checkout with the provider effective for the flow (or the ACTIVE
// provider when no flow is given).
export async function createPaymentOrder(tenantId: number, input: CreatePaymentOrderInput): Promise<NormalisedOrder> {
    const provider = input.flow
        ? await getPaymentProviderForFlow(tenantId, input.flow)
        : await getActivePaymentProvider(tenantId);

    if (provider === 'sumup') {
        const returnUrl = await sumupReturnUrl(tenantId);
        const checkout = await sumupCreateCheckout(tenantId, {
            amount: input.amount,
            currency: input.currency,
            description: input.description,
            reference: input.reference,
            redirectUrl: input.redirectUrl,
            returnUrl,
        });
        return {
            provider,
            id: checkout.id,
            status: normaliseCreationStatus(provider, checkout.status),
            checkoutUrl: checkout.hosted_checkout_url!,
            metadata: {
                sumup_checkout_reference: checkout.checkout_reference || null,
                sumup_merchant_code: checkout.merchant_code || null,
                // Recorded so a payment stuck on PENDING can be diagnosed
                // without guessing: if this points at the wrong host, the
                // callback never had a chance and CRM_APP_BASE_URL is wrong.
                sumup_return_url: returnUrl || null,
            },
        };
    }

    const order = await revolutCreateOrder(tenantId, {
        amount: input.amount,
        currency: input.currency,
        description: input.description,
        merchant_order_ext_ref: input.reference,
        redirect_url: input.redirectUrl,
    });
    return {
        provider,
        id: order.id,
        status: normaliseCreationStatus(provider, order.state),
        checkoutUrl: order.checkout_url,
        metadata: { revolut_token: order.token || null },
    };
}

export interface FetchedOrder {
    // Raw provider state, for logging and the reconcile response body.
    state: string;
    // Normalised ORDER_* event, or null when nothing changed.
    event: string | null;
    raw: any;
}

// Read the authoritative state of an existing order from the provider that
// owns it. tenantId = tenant della payment_request (webhook e scheduler lo
// prendono dalla riga, le route autenticate da req.tenantId!).
export async function fetchPaymentOrder(tenantId: number, provider: PaymentProvider, orderId: string): Promise<FetchedOrder> {
    if (provider === 'sumup') {
        const checkout = await sumupGetCheckout(tenantId, orderId);
        const state = String(checkout.status || '');
        return { state, event: providerStateToEvent(provider, state), raw: checkout };
    }
    const order = await revolutGetOrder(tenantId, orderId);
    const state = String(order.state || '');
    return { state, event: providerStateToEvent(provider, state), raw: order };
}

// Void a not-yet-paid order so its checkout page stops accepting money.
export async function cancelPaymentOrder(tenantId: number, provider: PaymentProvider, orderId: string): Promise<void> {
    if (provider === 'sumup') {
        await sumupDeactivateCheckout(tenantId, orderId);
        return;
    }
    await revolutCancelOrder(tenantId, orderId);
}

// Send money back for a completed order. `knownTransactionId` is only used by
// SumUp, whose refunds are keyed on the transaction rather than the checkout:
// callers pass metadata.sumup_transaction_id when they have it so we don't
// have to re-derive it from the checkout.
export async function refundPaymentOrder(
    tenantId: number,
    provider: PaymentProvider,
    orderId: string,
    amountMinor: number,
    currency: string,
    description?: string,
    knownTransactionId?: string | null
): Promise<any> {
    if (provider === 'sumup') {
        return sumupRefundCheckout(tenantId, orderId, amountMinor, currency, description, knownTransactionId);
    }
    return revolutRefundOrder(tenantId, orderId, amountMinor, currency, description);
}

// Extra fields worth persisting on payment_requests.metadata once we know an
// order's final state — SumUp refunds are keyed on the transaction, not the
// checkout, so capturing the transaction id at completion saves a lookup
// later (and still works if the checkout ages out of the API).
export function transitionMetadata(provider: PaymentProvider, raw: any): Record<string, unknown> | null {
    if (provider !== 'sumup' || !raw) return null;
    const transactionId = extractTransactionId(raw);
    return transactionId ? { sumup_transaction_id: transactionId } : null;
}
