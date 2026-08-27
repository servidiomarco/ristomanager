// Billing Stripe (Fase D3) — lean e webhook-driven: nessun dato carta nel
// nostro DB, la subscription vive in Stripe e qui si persistono solo i
// riferimenti (stripe_customer_id / stripe_subscription_id / billing_status
// su tenants). Il checkout e il customer portal si generano su richiesta
// dagli endpoint admin; lo stato commerciale del tenant lo detta SOLO il
// webhook (applySubscriptionState), così un pagamento fallito o un upgrade
// fatto dal portal arrivano da soli, senza pannello.
//
// Vive in services/ (già copiata dal Dockerfile) e importa solo db +
// entitlements: server.ts la usa, mai il contrario.
import Stripe from 'stripe';
import { queryWithRetry } from '../db.js';
import { TENANT_FEATURES, type TenantFeature, invalidateTenantFeaturesCache } from './entitlements.js';

// Errore tipizzato: le route lo traducono in status HTTP (billing_disabled
// → 503, tenant_not_found → 404, …) senza dover distinguere i messaggi.
export type BillingErrorCode =
    | 'billing_disabled'
    | 'tenant_not_found'
    | 'stripe_customer_missing'
    | 'no_prices'
    | 'no_subscription'
    | 'price_not_configured';

export class BillingError extends Error {
    code: BillingErrorCode;
    constructor(code: BillingErrorCode, message: string) {
        super(message);
        this.name = 'BillingError';
        this.code = code;
    }
}

// Client Stripe lazy: la chiave si legge alla prima chiamata, non al boot —
// un deploy senza STRIPE_SECRET_KEY (il Frantoio oggi) parte normalmente e
// il billing risponde 'billing_disabled' solo se qualcuno lo invoca.
let stripeClient: Stripe | null = null;

export const isBillingEnabled = (): boolean => Boolean(process.env.STRIPE_SECRET_KEY);

export function getStripe(): Stripe {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        throw new BillingError('billing_disabled', 'STRIPE_SECRET_KEY non configurata: billing spento.');
    }
    if (!stripeClient) {
        stripeClient = new Stripe(key);
    }
    return stripeClient;
}

// Mappa price id Stripe → feature commerciale. Letta dall'env a OGNI
// chiamata (mai memoizzata): i price id cambiano tra test e live mode, e i
// test la impostano a runtime — una lettura al load la congelerebbe.
// Il piano base (STRIPE_PRICE_BASE) non è una feature: un price fuori mappa
// si ignora nella sync.
function priceToFeature(): Map<string, TenantFeature> {
    const byFeature: Record<TenantFeature, string | undefined> = {
        voice: process.env.STRIPE_PRICE_VOICE,
        whatsapp: process.env.STRIPE_PRICE_WHATSAPP,
        web_booking: process.env.STRIPE_PRICE_WEB_BOOKING,
        pay_at_table: process.env.STRIPE_PRICE_PAY_AT_TABLE,
        // Integrazione cassa: per ora non è a listino Stripe (accesa a mano).
        passepartout: process.env.STRIPE_PRICE_PASSEPARTOUT,
    };
    const map = new Map<string, TenantFeature>();
    for (const feature of TENANT_FEATURES) {
        const priceId = byFeature[feature];
        if (priceId) map.set(priceId, feature);
    }
    return map;
}

// Verifica firma del webhook: Stripe firma i byte esatti del payload, quindi
// serve il raw body catturato dal verify hook di express.json (server.ts),
// mai il body ri-serializzato. constructEvent lancia se la firma non torna.
export function constructWebhookEvent(rawBody: Buffer | string, signature: string): Stripe.Event {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
        throw new BillingError('billing_disabled', 'STRIPE_WEBHOOK_SECRET non configurata: webhook Stripe spento.');
    }
    return getStripe().webhooks.constructEvent(rawBody, signature, secret);
}

export interface CheckoutSessionOptions {
    prices?: string[];
    successUrl: string;
    cancelUrl: string;
}

// Crea (o riusa) il customer Stripe del tenant e apre una Checkout Session
// in mode subscription. Il customer id si salva SUBITO, prima del checkout:
// è la chiave con cui il webhook risolve il tenant, e ai tentativi
// successivi si riusa lo stesso customer invece di crearne un duplicato.
export async function createCheckoutSession(
    tenantId: number,
    options: CheckoutSessionOptions
): Promise<{ url: string | null; sessionId: string }> {
    const stripe = getStripe();
    const tenantRes = await queryWithRetry(
        'SELECT id, slug, name, stripe_customer_id FROM tenants WHERE id = $1',
        [tenantId]
    );
    if (tenantRes.rows.length === 0) {
        throw new BillingError('tenant_not_found', `Tenant ${tenantId} inesistente.`);
    }
    const tenant = tenantRes.rows[0];

    let customerId: string | null = tenant.stripe_customer_id ?? null;
    if (!customerId) {
        const customer = await stripe.customers.create({
            name: tenant.name,
            metadata: { tenant_id: String(tenantId), tenant_slug: tenant.slug },
        });
        customerId = customer.id;
        await queryWithRetry(
            'UPDATE tenants SET stripe_customer_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
            [tenantId, customerId]
        );
    }

    // Senza prezzi espliciti si sottoscrive il piano base; gli add-on si
    // aggiungono come subscription items (altri price nella stessa lista).
    const prices = options.prices && options.prices.length > 0
        ? options.prices
        : (process.env.STRIPE_PRICE_BASE ? [process.env.STRIPE_PRICE_BASE] : []);
    if (prices.length === 0) {
        throw new BillingError('no_prices', 'Nessun price indicato e STRIPE_PRICE_BASE non configurato.');
    }

    const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: prices.map(price => ({ price, quantity: 1 })),
        success_url: options.successUrl,
        cancel_url: options.cancelUrl,
    });
    return { url: session.url, sessionId: session.id };
}

// Customer portal: il ristoratore gestisce carta, fatture e add-on da
// Stripe; ogni modifica torna a noi via webhook. Esige un customer già
// creato (cioè almeno un checkout avviato).
export async function createPortalSession(
    tenantId: number,
    returnUrl: string
): Promise<{ url: string }> {
    const stripe = getStripe();
    const tenantRes = await queryWithRetry(
        'SELECT stripe_customer_id FROM tenants WHERE id = $1',
        [tenantId]
    );
    if (tenantRes.rows.length === 0) {
        throw new BillingError('tenant_not_found', `Tenant ${tenantId} inesistente.`);
    }
    const customerId: string | null = tenantRes.rows[0].stripe_customer_id ?? null;
    if (!customerId) {
        throw new BillingError('stripe_customer_missing', 'Il tenant non ha un customer Stripe: serve prima un checkout.');
    }
    const session = await stripe.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
    });
    return { url: session.url };
}

// Picker add-on del pannello: accende/spegne moduli su una subscription GIÀ
// attiva aggiungendo o togliendo subscription item, con prorazione. Al
// termine si applica subito lo stato risultante (applySubscriptionState):
// il webhook arriverà comunque, ma il pannello non deve aspettarlo — la
// doppia applicazione è idempotente per costruzione.
export async function updateSubscriptionAddons(
    tenantId: number,
    desired: Partial<Record<TenantFeature, boolean>>
): Promise<AppliedSubscriptionState> {
    const tenantRes = await queryWithRetry(
        'SELECT stripe_subscription_id FROM tenants WHERE id = $1',
        [tenantId]
    );
    if (tenantRes.rows.length === 0) {
        throw new BillingError('tenant_not_found', `Tenant ${tenantId} inesistente.`);
    }
    // Prima della chiave Stripe, così un tenant senza abbonamento riceve il
    // SUO errore anche in ambienti col billing spento (e nei test).
    const subscriptionId: string | null = tenantRes.rows[0].stripe_subscription_id ?? null;
    if (!subscriptionId) {
        throw new BillingError('no_subscription', 'Il tenant non ha una subscription attiva: parti da "Attiva abbonamento".');
    }
    const stripe = getStripe();

    const mapping = priceToFeature();
    const priceOfFeature = new Map<TenantFeature, string>();
    for (const [priceId, feature] of mapping) priceOfFeature.set(feature, priceId);

    const sub = await stripe.subscriptions.retrieve(subscriptionId);
    const itemOfPrice = new Map<string, string>();
    for (const item of sub.items.data) {
        if (item.price?.id) itemOfPrice.set(item.price.id, item.id);
    }

    const changes: Array<{ id?: string; price?: string; deleted?: boolean }> = [];
    for (const [feature, want] of Object.entries(desired) as Array<[TenantFeature, boolean]>) {
        const priceId = priceOfFeature.get(feature);
        if (!priceId) {
            throw new BillingError('price_not_configured', `Nessun price Stripe configurato per "${feature}" (env STRIPE_PRICE_*).`);
        }
        const existingItem = itemOfPrice.get(priceId);
        if (want && !existingItem) changes.push({ price: priceId });
        if (!want && existingItem) changes.push({ id: existingItem, deleted: true });
    }

    // Già allineato (doppio click, o riallineo dopo un webhook): niente
    // chiamata di update, ma il DB si risincronizza comunque dallo stato vero.
    const effective = changes.length === 0
        ? sub
        : await stripe.subscriptions.update(subscriptionId, {
            items: changes,
            proration_behavior: 'create_prorations',
        });

    const applied = await applySubscriptionState(effective as unknown as SubscriptionLike);
    if (!applied) {
        throw new BillingError('tenant_not_found', 'Il customer della subscription non corrisponde a nessun tenant.');
    }
    return applied;
}

// Forma minima della subscription che serve alla sync: strutturale invece di
// Stripe.Subscription così i test possono passare oggetti finti senza
// trascinarsi tutto il tipo (e il webhook passa l'oggetto vero senza cast).
export interface SubscriptionLike {
    id: string;
    customer: string | { id: string };
    status: string;
    items?: { data?: Array<{ price?: { id?: string | null } | null } | null> | null } | null;
}

export interface AppliedSubscriptionState {
    tenantId: number;
    slug: string;
    name: string;
    billingStatus: string;
    // Il billing_status PRIMA di questo evento: serve al webhook per
    // notificare solo le TRANSIZIONI (es. → past_due), non ogni retry.
    previousBillingStatus: string | null;
    tenantStatus: 'active' | 'suspended';
    // true quando tenants.status è cambiato: il chiamante (webhook in
    // server.ts) deve invalidare le cache slug/dominio, come fa la PATCH
    // admin — una sospensione deve chiudere la pagina pubblica subito.
    tenantStatusChanged: boolean;
}

// Sospendono il ristorante: la subscription è morta o il grace period di
// Stripe è esaurito. 'past_due' NON c'è, deliberatamente: un pagamento
// fallito in retry avvisa ma non spegne il ristorante in servizio — se i
// retry falliscono tutti Stripe passa da solo a 'unpaid' o 'canceled' e la
// sospensione arriva da quel webhook.
const SUSPENDING_STATUSES = new Set(['unpaid', 'canceled', 'incomplete_expired']);
const ACTIVATING_STATUSES = new Set(['active', 'trialing', 'past_due']);

// IL CUORE del billing: dato lo stato di una subscription (dal webhook),
// allinea il tenant — riferimenti Stripe, tenants.status, feature vendute.
// Ritorna null se il customer non corrisponde a nessun tenant (evento di un
// altro ambiente Stripe: si logga e si ignora, MAI errore — Stripe
// ritenterebbe per giorni).
export async function applySubscriptionState(
    subscription: SubscriptionLike
): Promise<AppliedSubscriptionState | null> {
    const customerId = typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer?.id;
    if (!customerId) {
        console.warn('[billing] subscription senza customer id, ignorata:', subscription.id);
        return null;
    }
    const tenantRes = await queryWithRetry(
        'SELECT id, slug, name, status, billing_status FROM tenants WHERE stripe_customer_id = $1',
        [customerId]
    );
    if (tenantRes.rows.length === 0) {
        console.warn(`[billing] nessun tenant per il customer Stripe ${customerId}, evento ignorato`);
        return null;
    }
    const tenantId = Number(tenantRes.rows[0].id);
    const slug: string = tenantRes.rows[0].slug;
    const name: string = tenantRes.rows[0].name;
    const previousStatus: string = tenantRes.rows[0].status;
    const previousBillingStatus: string | null = tenantRes.rows[0].billing_status ?? null;

    const billingStatus = subscription.status;
    // Stati fuori da entrambe le liste (es. 'incomplete', 'paused'): lo
    // status del tenant non si tocca — un checkout non ancora pagato non
    // deve né accendere né spegnere niente.
    const nextStatus: 'active' | 'suspended' | null = SUSPENDING_STATUSES.has(billingStatus)
        ? 'suspended'
        : ACTIVATING_STATUSES.has(billingStatus)
            ? 'active'
            : null;

    await queryWithRetry(
        `UPDATE tenants
            SET stripe_subscription_id = $2,
                billing_status = $3,
                status = COALESCE($4, status),
                updated_at = CURRENT_TIMESTAMP
          WHERE id = $1`,
        [tenantId, subscription.id, billingStatus, nextStatus]
    );

    // Sync delle feature vendute dai subscription items. CRITICO: tocca SOLO
    // il tenant appena risolto via stripe_customer_id, che da qui in poi ha
    // billing_status non NULL (l'UPDATE sopra). I tenant grandfathered
    // (billing_status NULL, tenant 1 in testa) non hanno un customer Stripe,
    // non arrivano mai qui, e le loro feature — accese a mano dal pannello —
    // non vengono MAI spente da questa sweep: ogni UPDATE è WHERE
    // tenant_id = questo, niente operazioni cross-tenant.
    const mapping = priceToFeature();
    const purchased = new Set<TenantFeature>();
    for (const item of subscription.items?.data ?? []) {
        const priceId = item?.price?.id;
        if (!priceId) continue;
        const feature = mapping.get(priceId);
        // Price fuori mappa (piano base, add-on futuri): nessuna feature.
        if (feature) purchased.add(feature);
    }
    // Feature non presente negli items (o non mappata) → disabled: la
    // verità è la subscription, un add-on rimosso dal portal si spegne qui.
    for (const feature of TENANT_FEATURES) {
        await queryWithRetry(
            `INSERT INTO tenant_features (tenant_id, feature, enabled, updated_at)
             VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
             ON CONFLICT (tenant_id, feature) DO UPDATE
               SET enabled = EXCLUDED.enabled, updated_at = CURRENT_TIMESTAMP`,
            [tenantId, feature, purchased.has(feature)]
        );
    }
    invalidateTenantFeaturesCache(tenantId);

    const tenantStatus = (nextStatus ?? previousStatus) as 'active' | 'suspended';
    return {
        tenantId,
        slug,
        name,
        billingStatus,
        previousBillingStatus,
        tenantStatus,
        tenantStatusChanged: tenantStatus !== previousStatus,
    };
}
