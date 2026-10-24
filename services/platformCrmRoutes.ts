// ============================================
// CRM della piattaforma — i clienti di Sympotia (pannello Piattaforma)
// ============================================
// Lead e ristoranti in un'anagrafica sola, con referenti, cronologia,
// promemoria, opportunità, salute calcolata dall'uso e billing Stripe per
// cliente. Montato su /admin/crm dietro platformAdminAuth (server.ts), che
// apre già runAsPlatform: qui si legge e si scrive di piattaforma, sempre
// con queryWithRetry (pool.query non porta il contesto, vedi db.ts).
//
// Le righe portano tenant_id = ristorante di casa di chi scrive (come
// platform_incidents e il dev board), ma il CRM è unico per la piattaforma:
// le letture non filtrano su tenant_id. Schema e motivi nella migrazione
// 1792848768440_crm-piattaforma.js, il prodotto in docs/pannello-crm.md.
//
// Supporto, avvisi e creazione del ristorante entrano nella cronologia in
// lettura, dalle loro tabelle: copiarli in crm_activities vorrebbe dire
// tenere due verità allineate.

import express from 'express';
import type { Request, Response } from 'express';
import type Stripe from 'stripe';
import pool, { queryWithRetry } from '../db.js';
import { getStripe, isBillingEnabled } from './billingService.js';

export const CRM_STAGES = ['lead', 'contattato', 'demo', 'proposta', 'prova', 'cliente', 'perso', 'disdetto'] as const;
export type CrmStage = typeof CRM_STAGES[number];
// Prima della prova: la vendita è ancora aperta.
const PRESALE_STAGES: readonly CrmStage[] = ['lead', 'contattato', 'demo', 'proposta'];

const STAGE_LABEL: Record<CrmStage, string> = {
    lead: 'lead', contattato: 'contattato', demo: 'demo', proposta: 'proposta',
    prova: 'in prova', cliente: 'cliente', perso: 'perso', disdetto: 'disdetto',
};

// 'sistema' lo scrive solo il server (cambi di fase, opportunità chiuse).
const ACTIVITY_KINDS = ['nota', 'chiamata', 'email', 'incontro', 'demo', 'whatsapp'] as const;

const DEAL_STAGES = ['nuova', 'demo', 'proposta', 'trattativa', 'vinta', 'persa'] as const;
type DealStage = typeof DEAL_STAGES[number];
const DEAL_KINDS = ['nuovo', 'upsell', 'rinnovo'] as const;
// Probabilità di chiusura quando l'opportunità non ne ha una sua: il valore
// pesato della pipeline senza un numero scritto a mano su ogni card.
const DEAL_DEFAULT_PROBABILITY: Record<DealStage, number> = {
    nuova: 10, demo: 30, proposta: 50, trattativa: 70, vinta: 100, persa: 0,
};

const IMPORT_MAX_ROWS = 500;
const TAGS_MAX = 12;
const TAG_MAX_LENGTH = 30;

class CrmInputError extends Error {
    constructor(public code: string, message: string) {
        super(message);
    }
}

// ── Validazione ────────────────────────────────────────────────────────────

const ACCOUNT_TEXT_FIELDS: Record<string, number> = {
    name: 160, business_type: 40, source: 30, current_software: 80, city: 80, address: 200,
    phone: 40, email: 160, website: 200, legal_name: 160, vat_number: 20, sdi_code: 7, pec: 160,
    lost_reason: 200, notes: 5000,
};
const ACCOUNT_INT_FIELDS = ['seats', 'locations', 'expected_mrr_cents'] as const;
const ACCOUNT_DATE_FIELDS = ['contract_start', 'renewal_date'] as const;

const isIsoDate = (v: unknown): v is string => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T12:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Testo facoltativo: stringa vuota = NULL, oltre il limite = errore. */
const optionalText = (value: unknown, field: string, max: number): string | null => {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'string' && typeof value !== 'number') {
        throw new CrmInputError('invalid_field', `Campo non valido: ${field}`);
    }
    const s = String(value).trim();
    if (!s) return null;
    if (s.length > max) throw new CrmInputError('invalid_field', `${field}: massimo ${max} caratteri`);
    return s;
};

const optionalInt = (value: unknown, field: string): number | null => {
    if (value === null || value === undefined || value === '') return null;
    const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
        throw new CrmInputError('invalid_field', `Campo non valido: ${field}`);
    }
    return n;
};

const optionalDate = (value: unknown, field: string): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (!isIsoDate(value)) throw new CrmInputError('invalid_field', `Data non valida: ${field}`);
    return value;
};

const parseTags = (value: unknown): string[] => {
    if (!Array.isArray(value)) throw new CrmInputError('invalid_tags', 'tags deve essere un elenco');
    const out: string[] = [];
    for (const raw of value) {
        if (typeof raw !== 'string') continue;
        const tag = raw.trim().toLowerCase().slice(0, TAG_MAX_LENGTH);
        if (tag && !out.includes(tag)) out.push(tag);
    }
    return out.slice(0, TAGS_MAX);
};

/** I campi dell'azienda presenti nel body, validati. `partial` per il PATCH:
 *  un campo assente non si tocca, uno vuoto si azzera. */
const parseAccountInput = (body: any, partial: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [field, max] of Object.entries(ACCOUNT_TEXT_FIELDS)) {
        if (partial && !(field in body)) continue;
        out[field] = optionalText(body[field], field, max);
    }
    for (const field of ACCOUNT_INT_FIELDS) {
        if (partial && !(field in body)) continue;
        out[field] = optionalInt(body[field], field);
    }
    for (const field of ACCOUNT_DATE_FIELDS) {
        if (partial && !(field in body)) continue;
        out[field] = optionalDate(body[field], field);
    }
    if (!partial || 'name' in body) {
        if (!out.name) throw new CrmInputError('invalid_name', 'Il nome è obbligatorio');
    }
    if (out.email && !String(out.email).includes('@')) throw new CrmInputError('invalid_email', 'Email non valida');
    if (!partial || 'stage' in body) {
        const stage = body.stage ?? 'lead';
        if (!(CRM_STAGES as readonly string[]).includes(stage)) throw new CrmInputError('invalid_stage', 'Fase non valida');
        out.stage = stage;
    }
    if ('tags' in body) out.tags = parseTags(body.tags);
    if ('internal' in body) {
        if (typeof body.internal !== 'boolean') throw new CrmInputError('invalid_field', 'internal deve essere vero o falso');
        out.internal = body.internal;
    }
    return out;
};

const parseContactInput = (body: any, partial: boolean): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const fields: Record<string, number> = { full_name: 120, role: 60, email: 160, phone: 40, notes: 500 };
    for (const [field, max] of Object.entries(fields)) {
        if (partial && !(field in body)) continue;
        out[field] = optionalText(body[field], field, max);
    }
    if ((!partial || 'full_name' in body) && !out.full_name) {
        throw new CrmInputError('invalid_name', 'Il nome del referente è obbligatorio');
    }
    if (out.email && !String(out.email).includes('@')) throw new CrmInputError('invalid_email', 'Email non valida');
    if ('is_primary' in body) {
        if (typeof body.is_primary !== 'boolean') throw new CrmInputError('invalid_field', 'is_primary deve essere vero o falso');
        out.is_primary = body.is_primary;
    }
    return out;
};

const idParam = (req: Request): number => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new CrmInputError('invalid_id', 'Id non valido');
    return id;
};

/** UPDATE dinamico su colonne già validate (i nomi vengono dalle liste
 *  chiuse sopra, mai dal body). */
const buildSet = (values: Record<string, unknown>, firstParam: number): { sql: string; params: unknown[] } => {
    const keys = Object.keys(values);
    return {
        sql: keys.map((k, i) => `${k} = $${firstParam + i}`).join(', '),
        params: keys.map(k => values[k]),
    };
};

// ── Chi scrive ─────────────────────────────────────────────────────────────

interface Actor { tenantId: number; userId: number | null; name: string }

/** Il ristorante di casa e il nome di chi agisce. Con PLATFORM_ADMIN_TOKEN
 *  (nessun utente dietro) vale il primo admin attivo, come per la card del
 *  dev board nata da una richiesta di supporto. */
const actorOf = async (req: Request): Promise<Actor> => {
    const userId = Number((req as any).user?.userId);
    const r = Number.isInteger(userId) && userId > 0
        ? await queryWithRetry(`SELECT tenant_id, full_name FROM users WHERE id = $1`, [userId])
        : await queryWithRetry(
            `SELECT tenant_id, NULL AS full_name FROM users WHERE role = 'PLATFORM_ADMIN' AND is_active = TRUE ORDER BY id LIMIT 1`
        );
    const tenantId = Number(r.rows[0]?.tenant_id);
    return {
        tenantId: Number.isInteger(tenantId) && tenantId > 0 ? tenantId : 1,
        userId: Number.isInteger(userId) && userId > 0 ? userId : null,
        name: String(r.rows[0]?.full_name || 'Piattaforma'),
    };
};

const logSystemActivity = async (actor: Actor, accountId: number, body: string): Promise<void> => {
    await queryWithRetry(
        `INSERT INTO crm_activities (tenant_id, account_id, kind, body, created_by_user_id, author_name)
         VALUES ($1, $2, 'sistema', $3, $4, $5)`,
        [actor.tenantId, accountId, body, actor.userId, actor.name]
    );
};

// ── Allineamento con i ristoranti ──────────────────────────────────────────

/** Ogni ristorante ha la sua scheda: quelli nuovi (o di prima del CRM) la
 *  ricevono qui, alla prima lettura. Fase dal billing; le demo nascono
 *  interne, fuori dai numeri. Poi il billing Stripe porta avanti le fasi
 *  dei ristoranti abbonati, una volta sola per cambio. */
const syncAccounts = async (actor: Actor): Promise<void> => {
    await queryWithRetry(
        `INSERT INTO crm_accounts (tenant_id, customer_tenant_id, name, stage, internal, contract_start, created_at, stage_changed_at)
         SELECT $1, t.id, t.name,
                CASE t.billing_status WHEN 'trialing' THEN 'prova' WHEN 'canceled' THEN 'disdetto' ELSE 'cliente' END,
                t.slug LIKE 'demo%',
                (t.created_at AT TIME ZONE 'Europe/Rome')::date,
                t.created_at, t.created_at
           FROM tenants t
          WHERE NOT EXISTS (SELECT 1 FROM crm_accounts a WHERE a.customer_tenant_id = t.id)
         ON CONFLICT (customer_tenant_id) DO NOTHING`,
        [actor.tenantId]
    );
    const drift = await queryWithRetry(
        `SELECT a.id, a.stage, t.billing_status
           FROM crm_accounts a
           JOIN tenants t ON t.id = a.customer_tenant_id
          WHERE t.billing_status IS NOT NULL
            AND (
                (t.billing_status IN ('active', 'past_due', 'unpaid') AND a.stage <> 'cliente')
             OR (t.billing_status = 'trialing' AND a.stage = ANY($1::text[]))
             OR (t.billing_status = 'canceled' AND a.stage IN ('cliente', 'prova'))
            )`,
        [PRESALE_STAGES]
    );
    for (const row of drift.rows) {
        const next: CrmStage = row.billing_status === 'trialing' ? 'prova'
            : row.billing_status === 'canceled' ? 'disdetto'
            : 'cliente';
        await queryWithRetry(
            `UPDATE crm_accounts SET stage = $2, stage_changed_at = now(), updated_at = now() WHERE id = $1`,
            [row.id, next]
        );
        await logSystemActivity(actor, Number(row.id),
            `Fase: ${STAGE_LABEL[row.stage as CrmStage] ?? row.stage} → ${STAGE_LABEL[next]} (abbonamento Stripe)`);
    }
};

/** Lega una scheda a un ristorante appena creato (provisioning dal pannello)
 *  o già esistente. Se il ristorante aveva già la scheda automatica, vuota,
 *  quella sparisce; se ci si era già lavorato sopra, conflitto. */
export const linkCrmAccountToTenant = async (
    accountId: number,
    customerTenantId: number,
    actorInput: Actor | null,
): Promise<'linked' | 'not_found' | 'already_linked' | 'tenant_has_account'> => {
    const actor = actorInput ?? { tenantId: 1, userId: null, name: 'Piattaforma' };
    const account = (await queryWithRetry(
        `SELECT id, stage, customer_tenant_id FROM crm_accounts WHERE id = $1`, [accountId]
    )).rows[0];
    if (!account) return 'not_found';
    if (account.customer_tenant_id !== null) {
        return Number(account.customer_tenant_id) === customerTenantId ? 'linked' : 'already_linked';
    }
    const existing = (await queryWithRetry(
        `SELECT a.id,
                (SELECT COUNT(*) FROM crm_contacts c WHERE c.account_id = a.id)
              + (SELECT COUNT(*) FROM crm_activities x WHERE x.account_id = a.id AND x.kind <> 'sistema')
              + (SELECT COUNT(*) FROM crm_tasks k WHERE k.account_id = a.id)
              + (SELECT COUNT(*) FROM crm_deals d WHERE d.account_id = a.id) AS work
           FROM crm_accounts a WHERE a.customer_tenant_id = $1`,
        [customerTenantId]
    )).rows[0];
    if (existing) {
        if (Number(existing.work) > 0) return 'tenant_has_account';
        await queryWithRetry(`DELETE FROM crm_accounts WHERE id = $1`, [existing.id]);
    }
    const presale = (PRESALE_STAGES as readonly string[]).includes(account.stage);
    await queryWithRetry(
        `UPDATE crm_accounts
            SET customer_tenant_id = $2,
                stage = CASE WHEN $3::boolean THEN 'prova' ELSE stage END,
                stage_changed_at = CASE WHEN $3::boolean THEN now() ELSE stage_changed_at END,
                contract_start = COALESCE(contract_start, (now() AT TIME ZONE 'Europe/Rome')::date),
                updated_at = now()
          WHERE id = $1`,
        [accountId, customerTenantId, presale]
    );
    const slug = (await queryWithRetry(`SELECT slug FROM tenants WHERE id = $1`, [customerTenantId])).rows[0]?.slug;
    await logSystemActivity(actor, accountId,
        `Ristorante collegato su Sympotia${slug ? ` (${slug})` : ''}${presale ? ' · fase: in prova' : ''}`);
    return 'linked';
};

// ── Billing Stripe per cliente ─────────────────────────────────────────────

interface StripeBilling {
    status: string;
    mrr_cents: number;
    trial_end: string | null;
    current_period_end: string | null;
    cancel_at_period_end: boolean;
}

// Una lista delle subscription ogni 5 minuti basta: il pannello si apre
// spesso, il billing cambia di rado, e il webhook aggiorna già lo stato a DB.
const STRIPE_CACHE_MS = 5 * 60_000;
let stripeCache: { at: number; byCustomer: Map<string, StripeBilling> } | null = null;

const subscriptionMrrCents = (sub: Stripe.Subscription): number => {
    let cents = 0;
    for (const item of sub.items.data) {
        const price = item.price;
        if (!price?.recurring || typeof price.unit_amount !== 'number') continue;
        const amount = price.unit_amount * (item.quantity ?? 1);
        cents += price.recurring.interval === 'year' ? Math.round(amount / 12)
            : price.recurring.interval === 'month' ? amount
            : 0;
    }
    return cents;
};

const unixToIso = (v: unknown): string | null =>
    typeof v === 'number' && v > 0 ? new Date(v * 1000).toISOString() : null;

/** Per customer Stripe la subscription che conta: viva prima delle chiuse,
 *  la più recente a parità. null = billing spento o Stripe giù (il pannello
 *  ripiega sul canone scritto a mano). */
const loadStripeBilling = async (): Promise<Map<string, StripeBilling> | null> => {
    if (!isBillingEnabled()) return null;
    if (stripeCache && Date.now() - stripeCache.at < STRIPE_CACHE_MS) return stripeCache.byCustomer;
    try {
        const stripe = getStripe();
        const best = new Map<string, { sub: Stripe.Subscription; alive: boolean }>();
        for await (const sub of stripe.subscriptions.list({ status: 'all', limit: 100 })) {
            const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
            if (!customer) continue;
            const alive = !['canceled', 'incomplete_expired'].includes(sub.status);
            const prev = best.get(customer);
            if (!prev || (alive && !prev.alive) || (alive === prev.alive && sub.created > prev.sub.created)) {
                best.set(customer, { sub, alive });
            }
        }
        const byCustomer = new Map<string, StripeBilling>();
        for (const [customer, { sub, alive }] of best) {
            // Dal 2025 il periodo sta sugli item; prima sulla subscription.
            const periodEnd = (sub.items.data[0] as any)?.current_period_end ?? (sub as any).current_period_end;
            byCustomer.set(customer, {
                status: sub.status,
                mrr_cents: alive && sub.status !== 'trialing' ? subscriptionMrrCents(sub) : 0,
                trial_end: unixToIso(sub.trial_end),
                current_period_end: unixToIso(periodEnd),
                cancel_at_period_end: sub.cancel_at_period_end === true,
            });
        }
        stripeCache = { at: Date.now(), byCustomer };
        return byCustomer;
    } catch (err: any) {
        console.error('[crm] lettura subscription Stripe non riuscita:', err?.message || err);
        return stripeCache?.byCustomer ?? null;
    }
};

// ── Salute dei clienti ─────────────────────────────────────────────────────

type HealthLevel = 'sano' | 'da_seguire' | 'a_rischio';

interface Health {
    score: number;
    level: HealthLevel;
    /** Perché il punteggio è sceso, in frasi corte: è la prima cosa da leggere. */
    signals: string[];
    metrics: {
        users: number;
        active_users_7d: number;
        last_seen_at: string | null;
        reservations_30d: number;
        reservations_prev_30d: number;
        voice_calls_30d: number;
        open_tickets: number;
        urgent_tickets: number;
        open_alerts: number;
    };
}

/** Il punteggio parte da 100 e perde punti per ciò che di solito precede una
 *  disdetta: nessuno entra più, le prenotazioni calano, problemi aperti,
 *  pagamenti scaduti. Le soglie sono un primo taglio da tarare sui dati veri. */
const scoreHealth = (m: Health['metrics'], billingStatus: string | null, suspended: boolean): Health => {
    let score = 100;
    const signals: string[] = [];
    const daysSince = m.last_seen_at ? Math.floor((Date.now() - new Date(m.last_seen_at).getTime()) / 86_400_000) : null;
    if (daysSince === null) { score -= 45; signals.push('nessun accesso registrato'); }
    else if (daysSince > 14) { score -= 40; signals.push(`nessun accesso da ${daysSince} giorni`); }
    else if (daysSince > 7) { score -= 20; signals.push(`ultimo accesso ${daysSince} giorni fa`); }
    if (m.reservations_30d === 0) { score -= 20; signals.push('nessuna prenotazione in 30 giorni'); }
    else if (m.reservations_prev_30d >= 10 && m.reservations_30d < m.reservations_prev_30d * 0.5) {
        const drop = Math.round((1 - m.reservations_30d / m.reservations_prev_30d) * 100);
        score -= 15;
        signals.push(`prenotazioni −${drop}% sul mese prima`);
    }
    if (m.open_alerts > 0) {
        score -= Math.min(20, m.open_alerts * 10);
        signals.push(m.open_alerts === 1 ? '1 avviso aperto' : `${m.open_alerts} avvisi aperti`);
    }
    if (m.urgent_tickets > 0) {
        score -= Math.min(20, m.urgent_tickets * 10);
        signals.push(m.urgent_tickets === 1 ? '1 richiesta urgente aperta' : `${m.urgent_tickets} richieste urgenti aperte`);
    } else if (m.open_tickets > 2) {
        score -= 5;
        signals.push(`${m.open_tickets} richieste di supporto aperte`);
    }
    if (billingStatus === 'past_due' || billingStatus === 'unpaid') { score -= 30; signals.push('pagamento scaduto'); }
    if (billingStatus === 'canceled') { score -= 40; signals.push('abbonamento disdetto'); }
    if (suspended) { score -= 50; signals.push('ristorante sospeso'); }
    score = Math.max(0, Math.min(100, score));
    return { score, level: score >= 70 ? 'sano' : score >= 40 ? 'da_seguire' : 'a_rischio', signals, metrics: m };
};

const loadHealth = async (tenantIds: number[]): Promise<Map<number, Health>> => {
    const out = new Map<number, Health>();
    if (tenantIds.length === 0) return out;
    const [tenants, users, reservations, voice, tickets, alerts] = await Promise.all([
        queryWithRetry(`SELECT id, status, billing_status FROM tenants WHERE id = ANY($1::bigint[])`, [tenantIds]),
        // L'admin di piattaforma ha casa in un ristorante: i suoi accessi
        // non sono l'uso di quel ristorante.
        queryWithRetry(
            `SELECT u.tenant_id,
                    COUNT(*) FILTER (WHERE u.is_active)::int AS users,
                    COUNT(*) FILTER (WHERE GREATEST(u.last_login, s.last_seen) > now() - interval '7 days')::int AS active_7d,
                    MAX(GREATEST(u.last_login, s.last_seen)) AS last_seen_at
               FROM users u
               LEFT JOIN (SELECT user_id, MAX(last_seen_at) AS last_seen FROM user_sessions GROUP BY user_id) s
                      ON s.user_id = u.id
              WHERE u.tenant_id = ANY($1::bigint[]) AND u.role <> 'PLATFORM_ADMIN'
              GROUP BY u.tenant_id`,
            [tenantIds]
        ),
        queryWithRetry(
            `SELECT tenant_id,
                    COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS r30,
                    COUNT(*) FILTER (WHERE created_at <= now() - interval '30 days')::int AS rprev
               FROM reservations
              WHERE tenant_id = ANY($1::bigint[]) AND created_at > now() - interval '60 days'
              GROUP BY tenant_id`,
            [tenantIds]
        ),
        queryWithRetry(
            `SELECT tenant_id, COUNT(*)::int AS n FROM voice_calls
              WHERE tenant_id = ANY($1::bigint[]) AND created_at > now() - interval '30 days'
              GROUP BY tenant_id`,
            [tenantIds]
        ),
        queryWithRetry(
            `SELECT tenant_id,
                    COUNT(*) FILTER (WHERE status <> 'risolto')::int AS open,
                    COUNT(*) FILTER (WHERE status <> 'risolto' AND priority = 'urgente')::int AS urgent
               FROM support_tickets WHERE tenant_id = ANY($1::bigint[])
              GROUP BY tenant_id`,
            [tenantIds]
        ),
        queryWithRetry(
            `SELECT tenant_id, COUNT(*)::int AS n FROM platform_alerts
              WHERE tenant_id = ANY($1::bigint[]) AND resolved_at IS NULL
              GROUP BY tenant_id`,
            [tenantIds]
        ),
    ]);
    const by = (rows: any[]) => new Map<number, any>(rows.map(r => [Number(r.tenant_id ?? r.id), r]));
    const u = by(users.rows), r = by(reservations.rows), v = by(voice.rows), t = by(tickets.rows), a = by(alerts.rows);
    for (const tenant of tenants.rows) {
        const id = Number(tenant.id);
        const metrics: Health['metrics'] = {
            users: Number(u.get(id)?.users ?? 0),
            active_users_7d: Number(u.get(id)?.active_7d ?? 0),
            last_seen_at: u.get(id)?.last_seen_at ? new Date(u.get(id).last_seen_at).toISOString() : null,
            reservations_30d: Number(r.get(id)?.r30 ?? 0),
            reservations_prev_30d: Number(r.get(id)?.rprev ?? 0),
            voice_calls_30d: Number(v.get(id)?.n ?? 0),
            open_tickets: Number(t.get(id)?.open ?? 0),
            urgent_tickets: Number(t.get(id)?.urgent ?? 0),
            open_alerts: Number(a.get(id)?.n ?? 0),
        };
        out.set(id, scoreHealth(metrics, tenant.billing_status ?? null, tenant.status === 'suspended'));
    }
    return out;
};

// ── Lettura delle schede ───────────────────────────────────────────────────

const todayRome = `(now() AT TIME ZONE 'Europe/Rome')::date`;

/** Le righe della lista (o di una scheda sola, con `ids`), con tutto ciò che
 *  la lista mostra: ristorante, salute, billing, referente, promemoria,
 *  opportunità aperte e ultima attività. */
const loadAccountRows = async (ids?: number[]): Promise<any[]> => {
    const filter = ids ? `WHERE a.id = ANY($1::int[])` : '';
    const params = ids ? [ids] : [];
    const accounts = await queryWithRetry(
        `SELECT a.*,
                t.slug AS tenant_slug, t.status AS tenant_status, t.billing_status AS tenant_billing_status,
                t.stripe_customer_id AS tenant_stripe_customer_id, t.created_at AS tenant_created_at,
                COALESCE((SELECT array_agg(f.feature ORDER BY f.feature) FROM tenant_features f
                           WHERE f.tenant_id = t.id AND f.enabled), '{}') AS tenant_features,
                (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id AND u.role <> 'PLATFORM_ADMIN') AS tenant_user_count
           FROM crm_accounts a
           LEFT JOIN tenants t ON t.id = a.customer_tenant_id
           ${filter}
          ORDER BY lower(a.name), a.id`,
        params
    );
    if (accounts.rows.length === 0) return [];
    const accountIds = accounts.rows.map((r: any) => Number(r.id));
    const tenantIds = accounts.rows.map((r: any) => Number(r.customer_tenant_id)).filter((n: number) => n > 0);
    const [contacts, tasks, deals, lastActivity, health, stripe] = await Promise.all([
        queryWithRetry(
            `SELECT DISTINCT ON (account_id) account_id, id, full_name, role, phone, email
               FROM crm_contacts WHERE account_id = ANY($1::int[])
              ORDER BY account_id, is_primary DESC, id`,
            [accountIds]
        ),
        queryWithRetry(
            `SELECT account_id,
                    COUNT(*)::int AS open,
                    COUNT(*) FILTER (WHERE due_date < ${todayRome})::int AS overdue,
                    MIN(due_date) AS next_due
               FROM crm_tasks WHERE account_id = ANY($1::int[]) AND done_at IS NULL
              GROUP BY account_id`,
            [accountIds]
        ),
        queryWithRetry(
            `SELECT account_id, COUNT(*)::int AS open, COALESCE(SUM(mrr_cents), 0)::int AS mrr
               FROM crm_deals WHERE account_id = ANY($1::int[]) AND stage NOT IN ('vinta', 'persa')
              GROUP BY account_id`,
            [accountIds]
        ),
        queryWithRetry(
            `SELECT account_id, MAX(occurred_at) AS at FROM crm_activities
              WHERE account_id = ANY($1::int[]) AND kind <> 'sistema'
              GROUP BY account_id`,
            [accountIds]
        ),
        loadHealth(tenantIds),
        loadStripeBilling(),
    ]);
    const byAccount = (rows: any[]) => new Map<number, any>(rows.map(r => [Number(r.account_id), r]));
    const c = byAccount(contacts.rows), k = byAccount(tasks.rows), d = byAccount(deals.rows), l = byAccount(lastActivity.rows);
    return accounts.rows.map((a: any) => {
        const id = Number(a.id);
        const tenantId = a.customer_tenant_id === null ? null : Number(a.customer_tenant_id);
        const billing = a.tenant_stripe_customer_id && stripe ? stripe.get(a.tenant_stripe_customer_id) ?? null : null;
        // Il canone vero è quello di Stripe; senza (accordo a mano, tenant
        // senza billing) vale quello scritto nella scheda, solo da cliente.
        const stripeMrr = billing && billing.mrr_cents > 0 ? billing.mrr_cents : null;
        const manualMrr = a.stage === 'cliente' && typeof a.expected_mrr_cents === 'number' ? a.expected_mrr_cents : null;
        const contact = c.get(id);
        return {
            id,
            name: a.name,
            stage: a.stage,
            internal: a.internal === true,
            business_type: a.business_type,
            source: a.source,
            current_software: a.current_software,
            city: a.city,
            address: a.address,
            phone: a.phone,
            email: a.email,
            website: a.website,
            legal_name: a.legal_name,
            vat_number: a.vat_number,
            sdi_code: a.sdi_code,
            pec: a.pec,
            seats: a.seats,
            locations: a.locations,
            expected_mrr_cents: a.expected_mrr_cents,
            contract_start: a.contract_start,
            renewal_date: a.renewal_date,
            lost_reason: a.lost_reason,
            notes: a.notes,
            tags: a.tags ?? [],
            onboarding: a.onboarding ?? {},
            stage_changed_at: a.stage_changed_at,
            created_at: a.created_at,
            updated_at: a.updated_at,
            customer_tenant_id: tenantId,
            tenant: tenantId === null ? null : {
                id: tenantId,
                slug: a.tenant_slug,
                status: a.tenant_status,
                billing_status: a.tenant_billing_status,
                features: a.tenant_features ?? [],
                user_count: Number(a.tenant_user_count ?? 0),
                created_at: a.tenant_created_at,
            },
            health: tenantId === null ? null : health.get(tenantId) ?? null,
            billing,
            mrr_cents: stripeMrr ?? manualMrr ?? 0,
            mrr_source: stripeMrr !== null ? 'stripe' : manualMrr !== null ? 'accordo' : null,
            primary_contact: contact
                ? { id: Number(contact.id), full_name: contact.full_name, role: contact.role, phone: contact.phone, email: contact.email }
                : null,
            open_tasks: Number(k.get(id)?.open ?? 0),
            overdue_tasks: Number(k.get(id)?.overdue ?? 0),
            next_task_due: k.get(id)?.next_due ?? null,
            open_deals: Number(d.get(id)?.open ?? 0),
            open_deals_mrr_cents: Number(d.get(id)?.mrr ?? 0),
            last_activity_at: l.get(id)?.at ?? null,
        };
    });
};

interface OnboardingStep { key: string; label: string; done: boolean; auto: boolean; done_at: string | null }

/** La checklist di avviamento: i passi che il sistema sa riconoscere si
 *  spuntano da soli, gli altri a mano (account.onboarding: chiave → data). */
const loadOnboarding = async (account: any): Promise<OnboardingStep[]> => {
    const manual: Record<string, string> = account.onboarding ?? {};
    const tenantId = account.customer_tenant_id;
    let auto: Record<string, string | null> = {};
    let voiceOn = false;
    if (tenantId) {
        const r = (await queryWithRetry(
            `SELECT t.created_at, t.onboarding_completed_at,
                    (SELECT COUNT(*)::int FROM tables WHERE tenant_id = t.id) AS tables,
                    (SELECT COUNT(*)::int FROM dishes WHERE tenant_id = t.id) AS dishes,
                    (SELECT COUNT(*)::int FROM users WHERE tenant_id = t.id AND role <> 'PLATFORM_ADMIN') AS users,
                    (SELECT MIN(created_at) FROM reservations WHERE tenant_id = t.id) AS first_reservation_at,
                    (SELECT MIN(created_at) FROM voice_calls WHERE tenant_id = t.id) AS first_call_at,
                    COALESCE((SELECT enabled FROM tenant_features WHERE tenant_id = t.id AND feature = 'voice'), FALSE) AS voice_on
               FROM tenants t WHERE t.id = $1`,
            [tenantId]
        )).rows[0];
        if (r) {
            const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
            voiceOn = r.voice_on === true;
            auto = {
                account: iso(r.created_at),
                configurazione: iso(r.onboarding_completed_at),
                sala: Number(r.tables) > 0 ? 'si' : null,
                menu: Number(r.dishes) > 0 ? 'si' : null,
                staff: Number(r.users) > 1 ? 'si' : null,
                prima_prenotazione: iso(r.first_reservation_at),
                sofia: iso(r.first_call_at),
            };
        }
    }
    const steps: Array<{ key: string; label: string; detectable: boolean }> = [
        { key: 'contratto', label: 'Contratto firmato', detectable: false },
        { key: 'account', label: 'Ristorante creato su Sympotia', detectable: true },
        { key: 'configurazione', label: 'Configurazione iniziale', detectable: true },
        { key: 'sala', label: 'Sale e tavoli', detectable: true },
        { key: 'menu', label: 'Menu caricato', detectable: true },
        { key: 'staff', label: 'Staff invitato', detectable: true },
        { key: 'formazione', label: 'Formazione fatta', detectable: false },
        { key: 'prima_prenotazione', label: 'Prima prenotazione', detectable: true },
        ...(voiceOn ? [{ key: 'sofia', label: 'Sofia risponde al telefono', detectable: true }] : []),
        { key: 'go_live', label: 'Go-live', detectable: false },
    ];
    return steps.map(s => {
        const autoValue = auto[s.key] ?? null;
        const manualValue = typeof manual[s.key] === 'string' ? manual[s.key] : null;
        const autoAt = autoValue && autoValue !== 'si' ? autoValue : null;
        return {
            key: s.key,
            label: s.label,
            done: !!autoValue || !!manualValue,
            auto: !!autoValue,
            done_at: autoAt ?? manualValue,
        };
    });
};

const ONBOARDING_KEYS = ['contratto', 'account', 'configurazione', 'sala', 'menu', 'staff', 'formazione', 'prima_prenotazione', 'sofia', 'go_live'];

interface TimelineItem {
    id: string;
    kind: string;
    body: string;
    occurred_at: string;
    author_name: string | null;
    contact_name: string | null;
    /** Solo per le righe scritte nel CRM: si possono cancellare. */
    activity_id: number | null;
    ticket_id: number | null;
}

const loadTimeline = async (accountId: number, tenantId: number | null): Promise<TimelineItem[]> => {
    const activities = await queryWithRetry(
        `SELECT x.id, x.kind, x.body, x.occurred_at, x.author_name, c.full_name AS contact_name
           FROM crm_activities x
           LEFT JOIN crm_contacts c ON c.id = x.contact_id
          WHERE x.account_id = $1
          ORDER BY x.occurred_at DESC, x.id DESC
          LIMIT 200`,
        [accountId]
    );
    const items: TimelineItem[] = activities.rows.map((r: any) => ({
        id: `a${r.id}`,
        kind: r.kind,
        body: r.body,
        occurred_at: new Date(r.occurred_at).toISOString(),
        author_name: r.author_name,
        contact_name: r.contact_name,
        activity_id: r.kind === 'sistema' ? null : Number(r.id),
        ticket_id: null,
    }));
    if (tenantId) {
        const [tenant, tickets, alerts] = await Promise.all([
            queryWithRetry(`SELECT created_at, onboarding_completed_at FROM tenants WHERE id = $1`, [tenantId]),
            queryWithRetry(
                `SELECT id, subject, created_at, resolved_at, rating FROM support_tickets
                  WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`,
                [tenantId]
            ),
            queryWithRetry(
                `SELECT id, kind, opened_at, resolved_at FROM platform_alerts
                  WHERE tenant_id = $1 ORDER BY opened_at DESC LIMIT 30`,
                [tenantId]
            ),
        ]);
        const sys = (id: string, kind: string, body: string, at: unknown, ticketId: number | null = null): TimelineItem => ({
            id, kind, body, occurred_at: new Date(at as string).toISOString(),
            author_name: null, contact_name: null, activity_id: null, ticket_id: ticketId,
        });
        const t = tenant.rows[0];
        if (t?.created_at) items.push(sys('t-created', 'sistema', 'Ristorante creato su Sympotia', t.created_at));
        if (t?.onboarding_completed_at) items.push(sys('t-onboarding', 'sistema', 'Configurazione iniziale completata', t.onboarding_completed_at));
        for (const k of tickets.rows) {
            items.push(sys(`s${k.id}`, 'supporto', `Richiesta di supporto: ${k.subject}`, k.created_at, Number(k.id)));
            if (k.resolved_at) {
                const voto = k.rating === 1 ? ' · valutata bene' : k.rating === -1 ? ' · valutata male' : '';
                items.push(sys(`s${k.id}-r`, 'supporto', `Richiesta risolta: ${k.subject}${voto}`, k.resolved_at, Number(k.id)));
            }
        }
        for (const a of alerts.rows) {
            items.push(sys(`p${a.id}`, 'avviso', `Avviso ${a.kind}`, a.opened_at));
            if (a.resolved_at) items.push(sys(`p${a.id}-r`, 'avviso', `Avviso ${a.kind} rientrato`, a.resolved_at));
        }
    }
    return items.sort((x, y) => y.occurred_at.localeCompare(x.occurred_at)).slice(0, 250);
};

const loadAccountDetail = async (accountId: number): Promise<any | null> => {
    const [row] = await loadAccountRows([accountId]);
    if (!row) return null;
    const [contacts, tasks, deals, timeline, onboarding] = await Promise.all([
        queryWithRetry(
            `SELECT id, full_name, role, email, phone, is_primary, notes, created_at
               FROM crm_contacts WHERE account_id = $1 ORDER BY is_primary DESC, id`,
            [accountId]
        ),
        queryWithRetry(
            `(SELECT id, account_id, title, due_date, priority, done_at, created_at FROM crm_tasks
               WHERE account_id = $1 AND done_at IS NULL)
             UNION ALL
             (SELECT id, account_id, title, due_date, priority, done_at, created_at FROM crm_tasks
               WHERE account_id = $1 AND done_at IS NOT NULL ORDER BY done_at DESC LIMIT 20)
             ORDER BY due_date, id`,
            [accountId]
        ),
        queryWithRetry(
            `SELECT id, account_id, title, kind, stage, mrr_cents, setup_cents, probability, expected_close, closed_at, lost_reason, created_at, updated_at
               FROM crm_deals WHERE account_id = $1 ORDER BY (stage IN ('vinta', 'persa')), created_at DESC`,
            [accountId]
        ),
        loadTimeline(accountId, row.customer_tenant_id),
        loadOnboarding(row),
    ]);
    return {
        ...row,
        contacts: contacts.rows,
        tasks: tasks.rows.map(mapTask),
        deals: deals.rows.map(mapDeal),
        timeline,
        onboarding_steps: onboarding,
    };
};

const mapTask = (r: any) => ({
    id: Number(r.id),
    account_id: r.account_id === null ? null : Number(r.account_id),
    account_name: r.account_name ?? null,
    title: r.title,
    due_date: r.due_date,
    priority: r.priority,
    done: r.done_at !== null,
    done_at: r.done_at,
    created_at: r.created_at,
});

const mapDeal = (r: any) => ({
    id: Number(r.id),
    account_id: Number(r.account_id),
    account_name: r.account_name ?? null,
    title: r.title,
    kind: r.kind,
    stage: r.stage,
    mrr_cents: Number(r.mrr_cents),
    setup_cents: Number(r.setup_cents),
    probability: r.probability === null ? null : Number(r.probability),
    effective_probability: r.probability === null ? DEAL_DEFAULT_PROBABILITY[r.stage as DealStage] : Number(r.probability),
    expected_close: r.expected_close,
    closed_at: r.closed_at,
    lost_reason: r.lost_reason,
    created_at: r.created_at,
    updated_at: r.updated_at,
});

// ── Router ─────────────────────────────────────────────────────────────────

type Handler = (req: Request, res: Response) => Promise<unknown>;

const handle = (route: string, fn: Handler) => async (req: Request, res: Response) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof CrmInputError) {
            return res.status(400).json({ error: err.code, message: err.message });
        }
        console.error(`${route} error:`, err);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const accountExists = async (id: number): Promise<boolean> =>
    (await queryWithRetry(`SELECT 1 FROM crm_accounts WHERE id = $1`, [id])).rows.length > 0;

export const createPlatformCrmRouter = (): express.Router => {
    const router = express.Router();

    // Panoramica: i numeri della piattaforma e cosa fare oggi. Demo e locali
    // interni restano fuori da ogni conteggio.
    router.get('/overview', handle('GET /admin/crm/overview', async (req, res) => {
        const actor = await actorOf(req);
        await syncAccounts(actor);
        const rows = (await loadAccountRows()).filter(a => !a.internal);
        const [tasks, deals, recent, month] = await Promise.all([
            queryWithRetry(
                `SELECT k.id, k.account_id, a.name AS account_name, k.title, k.due_date, k.priority, k.done_at, k.created_at
                   FROM crm_tasks k LEFT JOIN crm_accounts a ON a.id = k.account_id
                  WHERE k.done_at IS NULL AND k.due_date <= ${todayRome}
                  ORDER BY k.due_date, (k.priority = 'alta') DESC, k.id
                  LIMIT 50`
            ),
            queryWithRetry(
                `SELECT d.stage, d.mrr_cents, d.probability, d.closed_at, d.kind
                   FROM crm_deals d JOIN crm_accounts a ON a.id = d.account_id
                  WHERE NOT a.internal`
            ),
            queryWithRetry(
                `SELECT x.id, x.account_id, a.name AS account_name, x.kind, x.body, x.occurred_at, x.author_name
                   FROM crm_activities x JOIN crm_accounts a ON a.id = x.account_id
                  WHERE NOT a.internal
                  ORDER BY x.occurred_at DESC, x.id DESC LIMIT 12`
            ),
            queryWithRetry(`SELECT date_trunc('month', now() AT TIME ZONE 'Europe/Rome') AT TIME ZONE 'Europe/Rome' AS start`),
        ]);
        const monthStart = new Date(month.rows[0].start).getTime();
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
        const byStage = Object.fromEntries(CRM_STAGES.map(s => [s, 0])) as Record<CrmStage, number>;
        for (const a of rows) byStage[a.stage as CrmStage] += 1;
        const customers = rows.filter(a => a.stage === 'cliente');
        const mrr = customers.reduce((sum, a) => sum + (a.mrr_cents || 0), 0);
        let pipelineMrr = 0, weightedMrr = 0, openDeals = 0, wonMonth = 0, wonMonthMrr = 0;
        for (const d of deals.rows) {
            const value = Number(d.mrr_cents);
            if (d.stage === 'vinta' || d.stage === 'persa') {
                if (d.stage === 'vinta' && d.closed_at && new Date(d.closed_at).getTime() >= monthStart) {
                    wonMonth += 1;
                    wonMonthMrr += value;
                }
                continue;
            }
            openDeals += 1;
            pipelineMrr += value;
            const p = d.probability === null ? DEAL_DEFAULT_PROBABILITY[d.stage as DealStage] : Number(d.probability);
            weightedMrr += Math.round(value * p / 100);
        }
        const changedThisMonth = (a: any) => new Date(a.stage_changed_at).getTime() >= monthStart;
        const inDays = (iso: string | null, days: number) => {
            if (!iso) return false;
            const t = new Date(iso).getTime();
            return t >= Date.now() - 86_400_000 && t <= Date.now() + days * 86_400_000;
        };
        const summary = (a: any) => ({
            id: a.id, name: a.name, stage: a.stage, city: a.city,
            health: a.health, mrr_cents: a.mrr_cents, billing: a.billing, renewal_date: a.renewal_date,
        });
        const atRisk = rows
            .filter(a => (a.stage === 'cliente' || a.stage === 'prova') && a.health && a.health.level !== 'sano')
            .sort((x, y) => x.health.score - y.health.score)
            .slice(0, 8)
            .map(summary);
        const expiring = rows
            .filter(a => a.stage !== 'disdetto' && a.stage !== 'perso')
            .filter(a => inDays(a.billing?.trial_end ?? null, 14)
                || (a.billing?.cancel_at_period_end && inDays(a.billing?.current_period_end ?? null, 45))
                || (a.renewal_date && a.renewal_date >= today && inDays(`${a.renewal_date}T12:00:00Z`, 30)))
            .map(summary);
        res.json({
            stripe: isBillingEnabled(),
            mrr_cents: mrr,
            arpa_cents: customers.length ? Math.round(mrr / customers.length) : 0,
            by_stage: byStage,
            customers: customers.length,
            trials: byStage.prova,
            open_leads: PRESALE_STAGES.reduce((n, s) => n + byStage[s], 0),
            new_customers_month: customers.filter(changedThisMonth).length,
            churned_month: rows.filter(a => a.stage === 'disdetto' && changedThisMonth(a)).length,
            pipeline: {
                open_deals: openDeals,
                mrr_cents: pipelineMrr,
                weighted_mrr_cents: weightedMrr,
                won_month: wonMonth,
                won_month_mrr_cents: wonMonthMrr,
            },
            tasks_due: tasks.rows.map(mapTask),
            at_risk: atRisk,
            expiring,
            recent_activities: recent.rows.map((r: any) => ({
                id: Number(r.id), account_id: Number(r.account_id), account_name: r.account_name,
                kind: r.kind, body: r.body, occurred_at: r.occurred_at, author_name: r.author_name,
            })),
        });
    }));

    router.get('/accounts', handle('GET /admin/crm/accounts', async (req, res) => {
        await syncAccounts(await actorOf(req));
        res.json({ accounts: await loadAccountRows(), stripe: isBillingEnabled() });
    }));

    router.post('/accounts', handle('POST /admin/crm/accounts', async (req, res) => {
        const body = req.body ?? {};
        const values = parseAccountInput(body, false);
        const contact = body.contact && typeof body.contact === 'object' && String(body.contact.full_name ?? '').trim()
            ? parseContactInput(body.contact, false)
            : null;
        const actor = await actorOf(req);
        const cols = Object.keys(values);
        const ins = await queryWithRetry(
            `INSERT INTO crm_accounts (tenant_id, ${cols.join(', ')})
             VALUES ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')})
             RETURNING id`,
            [actor.tenantId, ...cols.map(k => values[k])]
        );
        const id = Number(ins.rows[0].id);
        if (contact) {
            await queryWithRetry(
                `INSERT INTO crm_contacts (tenant_id, account_id, full_name, role, email, phone, notes, is_primary)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
                [actor.tenantId, id, contact.full_name, contact.role ?? null, contact.email ?? null, contact.phone ?? null, contact.notes ?? null]
            );
        }
        res.status(201).json(await loadAccountDetail(id));
    }));

    // Import da CSV (il pannello lo legge e manda le righe già divise): una
    // riga con lo stesso nome e la stessa città di una scheda esistente si
    // salta, così reimportare lo stesso file non raddoppia niente.
    router.post('/accounts/import', handle('POST /admin/crm/accounts/import', async (req, res) => {
        const rows = req.body?.rows;
        if (!Array.isArray(rows) || rows.length === 0) {
            throw new CrmInputError('invalid_rows', 'Nessuna riga da importare');
        }
        if (rows.length > IMPORT_MAX_ROWS) {
            throw new CrmInputError('too_many_rows', `Massimo ${IMPORT_MAX_ROWS} righe per volta`);
        }
        const actor = await actorOf(req);
        const existing = await queryWithRetry(`SELECT lower(name) AS n, lower(COALESCE(city, '')) AS c FROM crm_accounts`);
        const seen = new Set(existing.rows.map((r: any) => `${r.n}|${r.c}`));
        let created = 0, skipped = 0;
        const errors: Array<{ row: number; message: string }> = [];
        for (let i = 0; i < rows.length; i++) {
            const raw = rows[i] && typeof rows[i] === 'object' ? rows[i] : {};
            try {
                const tags = typeof raw.tags === 'string' ? raw.tags.split(/[;,|]/) : raw.tags;
                const values = parseAccountInput({ ...raw, tags: tags ?? [] }, false);
                const key = `${String(values.name).toLowerCase()}|${String(values.city ?? '').toLowerCase()}`;
                if (seen.has(key)) { skipped += 1; continue; }
                const contactName = optionalText(raw.contact_name, 'contact_name', 120);
                const contact = contactName
                    ? parseContactInput({ full_name: contactName, role: raw.contact_role, email: raw.contact_email, phone: raw.contact_phone }, false)
                    : null;
                const cols = Object.keys(values);
                const ins = await queryWithRetry(
                    `INSERT INTO crm_accounts (tenant_id, ${cols.join(', ')})
                     VALUES ($1, ${cols.map((_, j) => `$${j + 2}`).join(', ')})
                     RETURNING id`,
                    [actor.tenantId, ...cols.map(k => values[k])]
                );
                if (contact) {
                    await queryWithRetry(
                        `INSERT INTO crm_contacts (tenant_id, account_id, full_name, role, email, phone, is_primary)
                         VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
                        [actor.tenantId, ins.rows[0].id, contact.full_name, contact.role ?? null, contact.email ?? null, contact.phone ?? null]
                    );
                }
                seen.add(key);
                created += 1;
            } catch (err) {
                if (!(err instanceof CrmInputError)) throw err;
                errors.push({ row: i + 1, message: err.message });
            }
        }
        res.json({ created, skipped, errors: errors.slice(0, 50) });
    }));

    router.get('/accounts/:id', handle('GET /admin/crm/accounts/:id', async (req, res) => {
        const detail = await loadAccountDetail(idParam(req));
        if (!detail) return res.status(404).json({ error: 'not_found' });
        res.json(detail);
    }));

    router.patch('/accounts/:id', handle('PATCH /admin/crm/accounts/:id', async (req, res) => {
        const id = idParam(req);
        const body = req.body ?? {};
        const values = parseAccountInput(body, true);
        const before = (await queryWithRetry(`SELECT stage, onboarding FROM crm_accounts WHERE id = $1`, [id])).rows[0];
        if (!before) return res.status(404).json({ error: 'not_found' });
        const actor = await actorOf(req);

        // Onboarding a mano: { passo: true } segna oggi, { passo: false } toglie.
        if (body.onboarding !== undefined) {
            if (typeof body.onboarding !== 'object' || body.onboarding === null || Array.isArray(body.onboarding)) {
                throw new CrmInputError('invalid_onboarding', 'onboarding deve essere un oggetto');
            }
            const next: Record<string, string> = { ...(before.onboarding ?? {}) };
            const today = (await queryWithRetry(`SELECT ${todayRome}::text AS d`)).rows[0].d;
            for (const [key, on] of Object.entries(body.onboarding)) {
                if (!ONBOARDING_KEYS.includes(key) || typeof on !== 'boolean') {
                    throw new CrmInputError('invalid_onboarding', `Passo non valido: ${String(key).slice(0, 40)}`);
                }
                if (on) next[key] = next[key] ?? today;
                else delete next[key];
            }
            values.onboarding = JSON.stringify(next);
        }

        const stageChanged = typeof values.stage === 'string' && values.stage !== before.stage;
        if (Object.keys(values).length === 0) {
            throw new CrmInputError('no_updates', 'Niente da aggiornare');
        }
        const set = buildSet(values, 2);
        await queryWithRetry(
            `UPDATE crm_accounts
                SET ${set.sql}${stageChanged ? ', stage_changed_at = now()' : ''}, updated_at = now()
              WHERE id = $1`,
            [id, ...set.params]
        );
        if (stageChanged) {
            const reason = (values.stage === 'perso' || values.stage === 'disdetto') && values.lost_reason
                ? ` · ${values.lost_reason}` : '';
            await logSystemActivity(actor, id,
                `Fase: ${STAGE_LABEL[before.stage as CrmStage] ?? before.stage} → ${STAGE_LABEL[values.stage as CrmStage]}${reason}`);
        }
        res.json(await loadAccountDetail(id));
    }));

    // Si cancellano solo le schede senza ristorante: per un cliente vero la
    // storia resta, e a fine rapporto la fase è «disdetto».
    router.delete('/accounts/:id', handle('DELETE /admin/crm/accounts/:id', async (req, res) => {
        const id = idParam(req);
        const row = (await queryWithRetry(`SELECT customer_tenant_id FROM crm_accounts WHERE id = $1`, [id])).rows[0];
        if (!row) return res.status(404).json({ error: 'not_found' });
        if (row.customer_tenant_id !== null) {
            return res.status(409).json({ error: 'linked_account', message: 'La scheda è legata a un ristorante: segnala come disdetto invece di cancellarla.' });
        }
        await queryWithRetry(`DELETE FROM crm_accounts WHERE id = $1`, [id]);
        res.status(204).send();
    }));

    router.post('/accounts/:id/link', handle('POST /admin/crm/accounts/:id/link', async (req, res) => {
        const id = idParam(req);
        const tenantId = Number(req.body?.tenant_id);
        if (!Number.isInteger(tenantId) || tenantId <= 0) throw new CrmInputError('invalid_tenant_id', 'Ristorante non valido');
        const tenant = await queryWithRetry(`SELECT 1 FROM tenants WHERE id = $1`, [tenantId]);
        if (tenant.rows.length === 0) return res.status(404).json({ error: 'tenant_not_found' });
        const outcome = await linkCrmAccountToTenant(id, tenantId, await actorOf(req));
        if (outcome === 'not_found') return res.status(404).json({ error: 'not_found' });
        if (outcome === 'already_linked') {
            return res.status(409).json({ error: 'already_linked', message: 'La scheda è già legata a un altro ristorante.' });
        }
        if (outcome === 'tenant_has_account') {
            return res.status(409).json({ error: 'tenant_has_account', message: 'Il ristorante ha già una scheda con attività: lavora su quella.' });
        }
        res.json(await loadAccountDetail(id));
    }));

    // ── Referenti ──
    // Un solo referente principale per azienda: quando uno lo diventa, gli
    // altri smettono di esserlo nella stessa transazione.
    const setPrimary = async (client: import('pg').PoolClient, accountId: number, contactId: number) => {
        await client.query(`UPDATE crm_contacts SET is_primary = (id = $2), updated_at = now() WHERE account_id = $1`, [accountId, contactId]);
    };

    router.post('/accounts/:id/contacts', handle('POST /admin/crm/accounts/:id/contacts', async (req, res) => {
        const accountId = idParam(req);
        const values = parseContactInput(req.body ?? {}, false);
        if (!(await accountExists(accountId))) return res.status(404).json({ error: 'not_found' });
        const actor = await actorOf(req);
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const first = (await client.query(`SELECT COUNT(*)::int AS n FROM crm_contacts WHERE account_id = $1`, [accountId])).rows[0].n === 0;
            const ins = await client.query(
                `INSERT INTO crm_contacts (tenant_id, account_id, full_name, role, email, phone, notes, is_primary)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE) RETURNING id`,
                [actor.tenantId, accountId, values.full_name, values.role ?? null, values.email ?? null, values.phone ?? null, values.notes ?? null]
            );
            if (first || values.is_primary === true) await setPrimary(client, accountId, Number(ins.rows[0].id));
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.status(201).json(await loadAccountDetail(accountId));
    }));

    router.patch('/contacts/:id', handle('PATCH /admin/crm/contacts/:id', async (req, res) => {
        const id = idParam(req);
        const values = parseContactInput(req.body ?? {}, true);
        const row = (await queryWithRetry(`SELECT account_id FROM crm_contacts WHERE id = $1`, [id])).rows[0];
        if (!row) return res.status(404).json({ error: 'not_found' });
        const accountId = Number(row.account_id);
        const { is_primary: primary, ...fields } = values;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            if (Object.keys(fields).length > 0) {
                const set = buildSet(fields, 2);
                await client.query(`UPDATE crm_contacts SET ${set.sql}, updated_at = now() WHERE id = $1`, [id, ...set.params]);
            }
            if (primary === true) await setPrimary(client, accountId, id);
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        res.json(await loadAccountDetail(accountId));
    }));

    router.delete('/contacts/:id', handle('DELETE /admin/crm/contacts/:id', async (req, res) => {
        const id = idParam(req);
        const row = (await queryWithRetry(`DELETE FROM crm_contacts WHERE id = $1 RETURNING account_id, is_primary`, [id])).rows[0];
        if (!row) return res.status(404).json({ error: 'not_found' });
        // Tolto il principale, lo diventa il più vecchio rimasto.
        if (row.is_primary) {
            await queryWithRetry(
                `UPDATE crm_contacts SET is_primary = TRUE
                  WHERE id = (SELECT id FROM crm_contacts WHERE account_id = $1 ORDER BY id LIMIT 1)`,
                [row.account_id]
            );
        }
        res.json(await loadAccountDetail(Number(row.account_id)));
    }));

    // ── Cronologia ──
    router.post('/accounts/:id/activities', handle('POST /admin/crm/accounts/:id/activities', async (req, res) => {
        const accountId = idParam(req);
        const body = req.body ?? {};
        if (!(ACTIVITY_KINDS as readonly string[]).includes(body.kind)) throw new CrmInputError('invalid_kind', 'Tipo di attività non valido');
        const text = optionalText(body.body, 'body', 5000);
        if (!text) throw new CrmInputError('invalid_body', 'Scrivi cosa è successo');
        let occurredAt: string | null = null;
        if (body.occurred_at !== undefined && body.occurred_at !== null && body.occurred_at !== '') {
            const d = new Date(String(body.occurred_at));
            if (Number.isNaN(d.getTime())) throw new CrmInputError('invalid_date', 'Data non valida');
            occurredAt = d.toISOString();
        }
        const contactId = body.contact_id === undefined || body.contact_id === null ? null : Number(body.contact_id);
        if (!(await accountExists(accountId))) return res.status(404).json({ error: 'not_found' });
        if (contactId !== null) {
            const ok = await queryWithRetry(`SELECT 1 FROM crm_contacts WHERE id = $1 AND account_id = $2`, [contactId, accountId]);
            if (ok.rows.length === 0) throw new CrmInputError('invalid_contact', 'Referente non valido');
        }
        const actor = await actorOf(req);
        await queryWithRetry(
            `INSERT INTO crm_activities (tenant_id, account_id, kind, body, contact_id, occurred_at, created_by_user_id, author_name)
             VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8)`,
            [actor.tenantId, accountId, body.kind, text, contactId, occurredAt, actor.userId, actor.name]
        );
        await queryWithRetry(`UPDATE crm_accounts SET updated_at = now() WHERE id = $1`, [accountId]);
        res.status(201).json(await loadAccountDetail(accountId));
    }));

    router.delete('/activities/:id', handle('DELETE /admin/crm/activities/:id', async (req, res) => {
        const id = idParam(req);
        const row = (await queryWithRetry(
            `DELETE FROM crm_activities WHERE id = $1 AND kind <> 'sistema' RETURNING account_id`, [id]
        )).rows[0];
        if (!row) return res.status(404).json({ error: 'not_found' });
        res.json(await loadAccountDetail(Number(row.account_id)));
    }));

    // ── Promemoria ──
    const TASK_SELECT = `SELECT k.id, k.account_id, a.name AS account_name, k.title, k.due_date, k.priority, k.done_at, k.created_at
                           FROM crm_tasks k LEFT JOIN crm_accounts a ON a.id = k.account_id`;

    router.get('/tasks', handle('GET /admin/crm/tasks', async (req, res) => {
        const done = req.query.status === 'done';
        const r = await queryWithRetry(
            done
                ? `${TASK_SELECT} WHERE k.done_at IS NOT NULL ORDER BY k.done_at DESC LIMIT 100`
                : `${TASK_SELECT} WHERE k.done_at IS NULL ORDER BY k.due_date, (k.priority = 'alta') DESC, k.id LIMIT 500`
        );
        res.json({ tasks: r.rows.map(mapTask) });
    }));

    const parseTaskInput = (body: any, partial: boolean) => {
        const out: Record<string, unknown> = {};
        if (!partial || 'title' in body) {
            const title = optionalText(body.title, 'title', 200);
            if (!title) throw new CrmInputError('invalid_title', 'Scrivi cosa fare');
            out.title = title;
        }
        if (!partial || 'due_date' in body) {
            if (!isIsoDate(body.due_date)) throw new CrmInputError('invalid_date', 'Data non valida');
            out.due_date = body.due_date;
        }
        if ('priority' in body || !partial) {
            const p = body.priority ?? 'normale';
            if (p !== 'alta' && p !== 'normale') throw new CrmInputError('invalid_priority', 'Priorità non valida');
            out.priority = p;
        }
        return out;
    };

    const loadTask = async (id: number) => {
        const r = await queryWithRetry(`${TASK_SELECT} WHERE k.id = $1`, [id]);
        return r.rows[0] ? mapTask(r.rows[0]) : null;
    };

    router.post('/tasks', handle('POST /admin/crm/tasks', async (req, res) => {
        const body = req.body ?? {};
        const values = parseTaskInput(body, false);
        const accountId = body.account_id === undefined || body.account_id === null ? null : Number(body.account_id);
        if (accountId !== null && (!Number.isInteger(accountId) || !(await accountExists(accountId)))) {
            throw new CrmInputError('invalid_account', 'Azienda non valida');
        }
        const actor = await actorOf(req);
        const ins = await queryWithRetry(
            `INSERT INTO crm_tasks (tenant_id, account_id, title, due_date, priority, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [actor.tenantId, accountId, values.title, values.due_date, values.priority, actor.userId]
        );
        res.status(201).json(await loadTask(Number(ins.rows[0].id)));
    }));

    router.patch('/tasks/:id', handle('PATCH /admin/crm/tasks/:id', async (req, res) => {
        const id = idParam(req);
        const body = req.body ?? {};
        const values = parseTaskInput(body, true);
        if (body.done !== undefined && typeof body.done !== 'boolean') throw new CrmInputError('invalid_done', 'done deve essere vero o falso');
        const before = (await queryWithRetry(`SELECT account_id, title, done_at FROM crm_tasks WHERE id = $1`, [id])).rows[0];
        if (!before) return res.status(404).json({ error: 'not_found' });
        if (Object.keys(values).length === 0 && body.done === undefined) throw new CrmInputError('no_updates', 'Niente da aggiornare');
        const set = buildSet(values, 2);
        const doneSql = body.done === true ? 'done_at = COALESCE(done_at, now())' : body.done === false ? 'done_at = NULL' : null;
        await queryWithRetry(
            `UPDATE crm_tasks SET ${[set.sql, doneSql].filter(Boolean).join(', ')}, updated_at = now() WHERE id = $1`,
            [id, ...set.params]
        );
        // Un promemoria chiuso resta anche nella storia dell'azienda.
        if (body.done === true && before.done_at === null && before.account_id !== null) {
            await logSystemActivity(await actorOf(req), Number(before.account_id), `Promemoria fatto: ${values.title ?? before.title}`);
        }
        res.json(await loadTask(id));
    }));

    router.delete('/tasks/:id', handle('DELETE /admin/crm/tasks/:id', async (req, res) => {
        const r = await queryWithRetry(`DELETE FROM crm_tasks WHERE id = $1 RETURNING id`, [idParam(req)]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
        res.status(204).send();
    }));

    // ── Opportunità ──
    const DEAL_SELECT = `SELECT d.*, a.name AS account_name FROM crm_deals d JOIN crm_accounts a ON a.id = d.account_id`;

    router.get('/deals', handle('GET /admin/crm/deals', async (_req, res) => {
        // Le chiuse degli ultimi 90 giorni: la colonna «vinta» racconta il
        // trimestre, non tutta la storia.
        const r = await queryWithRetry(
            `${DEAL_SELECT}
              WHERE d.stage NOT IN ('vinta', 'persa') OR d.closed_at > now() - interval '90 days'
              ORDER BY d.expected_close NULLS LAST, d.created_at DESC`
        );
        res.json({ deals: r.rows.map(mapDeal) });
    }));

    const parseDealInput = (body: any, partial: boolean) => {
        const out: Record<string, unknown> = {};
        if (!partial || 'title' in body) {
            const title = optionalText(body.title, 'title', 160);
            if (!title) throw new CrmInputError('invalid_title', 'Il titolo è obbligatorio');
            out.title = title;
        }
        if (!partial || 'kind' in body) {
            const kind = body.kind ?? 'nuovo';
            if (!(DEAL_KINDS as readonly string[]).includes(kind)) throw new CrmInputError('invalid_kind', 'Tipo non valido');
            out.kind = kind;
        }
        if (!partial || 'stage' in body) {
            const stage = body.stage ?? 'nuova';
            if (!(DEAL_STAGES as readonly string[]).includes(stage)) throw new CrmInputError('invalid_stage', 'Fase non valida');
            out.stage = stage;
        }
        if (!partial || 'mrr_cents' in body) out.mrr_cents = optionalInt(body.mrr_cents, 'mrr_cents') ?? 0;
        if (!partial || 'setup_cents' in body) out.setup_cents = optionalInt(body.setup_cents, 'setup_cents') ?? 0;
        if ('probability' in body) {
            const p = optionalInt(body.probability, 'probability');
            if (p !== null && p > 100) throw new CrmInputError('invalid_field', 'La probabilità va da 0 a 100');
            out.probability = p;
        }
        if ('expected_close' in body) out.expected_close = optionalDate(body.expected_close, 'expected_close');
        if ('lost_reason' in body) out.lost_reason = optionalText(body.lost_reason, 'lost_reason', 200);
        return out;
    };

    const loadDeal = async (id: number) => {
        const r = await queryWithRetry(`${DEAL_SELECT} WHERE d.id = $1`, [id]);
        return r.rows[0] ? mapDeal(r.rows[0]) : null;
    };

    const euro = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`;

    router.post('/accounts/:id/deals', handle('POST /admin/crm/accounts/:id/deals', async (req, res) => {
        const accountId = idParam(req);
        const values = parseDealInput(req.body ?? {}, false);
        if (!(await accountExists(accountId))) return res.status(404).json({ error: 'not_found' });
        const actor = await actorOf(req);
        const closed = values.stage === 'vinta' || values.stage === 'persa';
        const cols = Object.keys(values);
        const ins = await queryWithRetry(
            `INSERT INTO crm_deals (tenant_id, account_id, ${cols.join(', ')}, closed_at)
             VALUES ($1, $2, ${cols.map((_, i) => `$${i + 3}`).join(', ')}, ${closed ? 'now()' : 'NULL'})
             RETURNING id`,
            [actor.tenantId, accountId, ...cols.map(k => values[k])]
        );
        res.status(201).json(await loadDeal(Number(ins.rows[0].id)));
    }));

    router.patch('/deals/:id', handle('PATCH /admin/crm/deals/:id', async (req, res) => {
        const id = idParam(req);
        const values = parseDealInput(req.body ?? {}, true);
        const before = (await queryWithRetry(`SELECT account_id, stage, title, mrr_cents FROM crm_deals WHERE id = $1`, [id])).rows[0];
        if (!before) return res.status(404).json({ error: 'not_found' });
        if (Object.keys(values).length === 0) throw new CrmInputError('no_updates', 'Niente da aggiornare');
        const nextStage = (values.stage ?? before.stage) as DealStage;
        const wasClosed = before.stage === 'vinta' || before.stage === 'persa';
        const isClosed = nextStage === 'vinta' || nextStage === 'persa';
        const set = buildSet(values, 2);
        const closedSql = isClosed && (!wasClosed || nextStage !== before.stage) ? ', closed_at = now()'
            : !isClosed && wasClosed ? ', closed_at = NULL'
            : '';
        await queryWithRetry(
            `UPDATE crm_deals SET ${set.sql}${closedSql}, updated_at = now() WHERE id = $1`,
            [id, ...set.params]
        );
        // La chiusura entra nella storia dell'azienda: vinta col valore, persa
        // col motivo.
        if (isClosed && nextStage !== before.stage) {
            const title = values.title ?? before.title;
            const mrr = Number(values.mrr_cents ?? before.mrr_cents);
            const text = nextStage === 'vinta'
                ? `Opportunità vinta: ${title}${mrr > 0 ? ` · ${euro(mrr)}/mese` : ''}`
                : `Opportunità persa: ${title}${values.lost_reason ? ` · ${values.lost_reason}` : ''}`;
            await logSystemActivity(await actorOf(req), Number(before.account_id), text);
        }
        res.json(await loadDeal(id));
    }));

    router.delete('/deals/:id', handle('DELETE /admin/crm/deals/:id', async (req, res) => {
        const r = await queryWithRetry(`DELETE FROM crm_deals WHERE id = $1 RETURNING id`, [idParam(req)]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'not_found' });
        res.status(204).send();
    }));

    return router;
};

/** Il chi-scrive della richiesta, per il provisioning in server.ts. */
export const crmActorOf = actorOf;
