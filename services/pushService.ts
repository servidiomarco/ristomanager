import webpush from 'web-push';
import { queryWithRetry } from '../db.js';

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:awmrac@gmail.com';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
} else {
    console.warn('Push notifications disabled: VAPID keys not set in environment');
}

export const isPushConfigured = () => configured;
export const getVapidPublicKey = () => VAPID_PUBLIC_KEY;

export interface PushPayload {
    title: string;
    body: string;
    url?: string;
    tag?: string;
    icon?: string;
    // App-icon badge (Web App Badging API). When omitted, sendToSubscriptions
    // auto-computes the "cose da attenzionare" total from the DB so the badge
    // updates anche a PWA chiusa. Callers che vogliono un valore fisso
    // (es. 0 per pulire il badge) possono passarlo esplicitamente.
    badge?: number;
    // Persistence knobs — everything routed through sendToUser/sendToRoles
    // is logged in the `notifications` table so the operator can review
    // history in the NotifichePage even when browsers were closed. `category`
    // groups alerts in the UI filters ('voice', 'payment', 'reservation',
    // 'message', 'system'). `persist=false` opts out for transient signals
    // (e.g. mark-as-read badge refreshes) that should never surface as
    // history entries. Defaults: category='general', persist=true.
    category?: string;
    persist?: boolean;
    metadata?: Record<string, any>;
}

// Somma degli indicatori mostrati nel badge PWA — combacia esattamente con
// il calcolo lato client in App.tsx (useAppBadge). Una singola query con
// tre subquery per evitare roundtrip multipli. Errori restituiscono null così
// il payload push omette il campo badge (SW non tocca il valore corrente).
async function computeAttentionBadge(): Promise<number | null> {
    try {
        const result = await queryWithRetry(`
            SELECT (
                (SELECT COUNT(*) FROM reservations WHERE reservation_status = 'PENDING')
                + (SELECT COUNT(*) FROM voice_calls
                   WHERE reservation_id IS NULL
                     AND (follow_up_status IS NULL OR follow_up_status = 'PENDING')
                     AND created_at >= NOW() - INTERVAL '7 days')
                + (SELECT COUNT(*) FROM outbound_messages
                   WHERE direction = 'inbound'
                     AND channel IN ('sms','whatsapp')
                     AND read_at IS NULL
                     AND from_phone_digits IS NOT NULL
                     AND length(from_phone_digits) >= 8)
                + (SELECT COUNT(*) FROM outbound_messages
                   WHERE direction = 'inbound'
                     AND channel = 'email'
                     AND read_at IS NULL)
            )::int AS badge
        `);
        const n = Number(result.rows[0]?.badge ?? 0);
        return Number.isFinite(n) && n >= 0 ? n : 0;
    } catch (err) {
        console.warn('[push] failed to compute attention badge', (err as any)?.message || err);
        return null;
    }
}

interface SubscriptionRow {
    id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
}

const fetchSubscriptionsForUser = async (userId: number): Promise<SubscriptionRow[]> => {
    const result = await queryWithRetry(
        'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1',
        [userId]
    );
    return result.rows;
};

const fetchSubscriptionsForRoles = async (tenantId: number, roles: string[], excludeUserId?: number | null): Promise<SubscriptionRow[]> => {
    if (roles.length === 0) return [];
    // Il tenant è obbligatorio: senza filtro una push per ruolo arriverebbe
    // allo staff di TUTTI i ristoranti (con due tenant l'altro locale vedrebbe
    // le prenotazioni altrui nel centro notifiche).
    const params: any[] = [roles, tenantId];
    let where = 'u.role = ANY($1::text[]) AND u.is_active = TRUE AND u.tenant_id = $2';
    if (excludeUserId) {
        params.push(excludeUserId);
        where += ` AND u.id <> $${params.length}`;
    }
    const result = await queryWithRetry(
        `SELECT ps.id, ps.endpoint, ps.p256dh, ps.auth
         FROM push_subscriptions ps
         JOIN users u ON u.id = ps.user_id
         WHERE ${where}`,
        params
    );
    return result.rows;
};

const deleteSubscriptionById = async (id: number) => {
    try {
        await queryWithRetry('DELETE FROM push_subscriptions WHERE id = $1', [id]);
    } catch (err) {
        console.error('Failed to delete stale push subscription', id, err);
    }
};

const sendToSubscriptions = async (subs: SubscriptionRow[], payload: PushPayload) => {
    if (!configured || subs.length === 0) return { sent: 0, removed: 0 };
    // Auto-attach the badge count so the PWA icon stays in sync even quando
    // l'app è chiusa. Skipped se il caller ha già passato un valore esplicito.
    let effectivePayload = payload;
    if (payload.badge === undefined) {
        const badge = await computeAttentionBadge();
        if (badge !== null) effectivePayload = { ...payload, badge };
    }
    const body = JSON.stringify(effectivePayload);
    let sent = 0;
    let removed = 0;
    await Promise.all(subs.map(async (sub) => {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                body
            );
            sent++;
        } catch (err: any) {
            const status = err?.statusCode;
            if (status === 404 || status === 410) {
                await deleteSubscriptionById(sub.id);
                removed++;
            } else {
                console.error('Push send failed', sub.endpoint, status, err?.message);
            }
        }
    }));
    return { sent, removed };
};

// Persist one row per recipient in the notifications table so the
// NotifichePage can rebuild history even for users offline at send time.
// Uses tag-based dedupe: the same (user, tag) combination is skipped when
// there's already an unresolved notification with that tag — mirrors the
// browser's own web-push tag semantics so operators don't see duplicates
// pile up on retries.
async function persistForUsers(
    userIds: number[],
    payload: PushPayload
): Promise<void> {
    if (payload.persist === false) return;
    if (userIds.length === 0) return;
    const category = payload.category ?? 'general';
    const meta = payload.metadata ? JSON.stringify(payload.metadata) : null;
    // One INSERT per user rather than a bulk one so ON CONFLICT-like dedupe
    // stays readable; volumes here are small (dozens of managers max).
    await Promise.all(userIds.map(async (uid) => {
        try {
            if (payload.tag) {
                const existing = await queryWithRetry(
                    `SELECT id FROM notifications
                     WHERE recipient_user_id = $1 AND tag = $2 AND dismissed_at IS NULL
                     ORDER BY sent_at DESC LIMIT 1`,
                    [uid, payload.tag]
                );
                if (existing.rows.length > 0) {
                    // Refresh the sent_at so the row bumps to the top of the
                    // list; keeps read_at as-is (still red if unread).
                    await queryWithRetry(
                        `UPDATE notifications
                         SET sent_at = CURRENT_TIMESTAMP,
                             title = $1, body = $2, url = $3, metadata = $4,
                             read_at = NULL
                         WHERE id = $5`,
                        [payload.title, payload.body, payload.url ?? null, meta, existing.rows[0].id]
                    );
                    return;
                }
            }
            await queryWithRetry(
                `INSERT INTO notifications
                    (recipient_user_id, category, title, body, url, tag, metadata)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [uid, category, payload.title, payload.body, payload.url ?? null, payload.tag ?? null, meta]
            );
        } catch (err) {
            console.warn('[push] persistForUsers failed for', uid, (err as any)?.message || err);
        }
    }));
}

async function fetchUserIdsForRoles(tenantId: number, roles: string[], excludeUserId?: number | null): Promise<number[]> {
    if (roles.length === 0) return [];
    const params: any[] = [roles, tenantId];
    let where = 'role = ANY($1::text[]) AND is_active = TRUE AND tenant_id = $2';
    if (excludeUserId) {
        params.push(excludeUserId);
        where += ` AND id <> $${params.length}`;
    }
    const r = await queryWithRetry(`SELECT id FROM users WHERE ${where}`, params);
    return r.rows.map((row: any) => row.id as number);
}

export const sendToUser = async (userId: number, payload: PushPayload) => {
    await persistForUsers([userId], payload);
    const subs = await fetchSubscriptionsForUser(userId);
    return sendToSubscriptions(subs, payload);
};

// tenantId è il PRIMO parametro, obbligatorio: rende impossibile aggiungere
// un call site che dimentica il tenant (il compilatore lo rifiuta).
export const sendToRoles = async (
    tenantId: number,
    roles: string[],
    payload: PushPayload,
    options?: { excludeUserId?: number | null }
) => {
    const recipients = await fetchUserIdsForRoles(tenantId, roles, options?.excludeUserId);
    await persistForUsers(recipients, payload);
    const subs = await fetchSubscriptionsForRoles(tenantId, roles, options?.excludeUserId);
    return sendToSubscriptions(subs, payload);
};
