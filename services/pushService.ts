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

const fetchSubscriptionsForRoles = async (roles: string[], excludeUserId?: number | null): Promise<SubscriptionRow[]> => {
    if (roles.length === 0) return [];
    const params: any[] = [roles];
    let where = 'u.role = ANY($1::text[]) AND u.is_active = TRUE';
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

export const sendToUser = async (userId: number, payload: PushPayload) => {
    const subs = await fetchSubscriptionsForUser(userId);
    return sendToSubscriptions(subs, payload);
};

export const sendToRoles = async (
    roles: string[],
    payload: PushPayload,
    options?: { excludeUserId?: number | null }
) => {
    const subs = await fetchSubscriptionsForRoles(roles, options?.excludeUserId);
    return sendToSubscriptions(subs, payload);
};
