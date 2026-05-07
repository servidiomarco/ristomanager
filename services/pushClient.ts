import { authApiService } from './authApiService';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

const authHeaders = (): HeadersInit => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = authApiService.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return headers;
};

export const isPushSupported = (): boolean => {
    return typeof window !== 'undefined'
        && 'serviceWorker' in navigator
        && 'PushManager' in window
        && 'Notification' in window;
};

export const getNotificationPermission = (): NotificationPermission | 'unsupported' => {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission;
};

export const registerServiceWorker = async (): Promise<ServiceWorkerRegistration | null> => {
    if (!('serviceWorker' in navigator)) return null;
    try {
        const existing = await navigator.serviceWorker.getRegistration('/');
        if (existing) return existing;
        return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch (err) {
        console.error('Service worker registration failed', err);
        return null;
    }
};

const urlBase64ToUint8Array = (base64String: string): Uint8Array => {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
};

const fetchVapidPublicKey = async (): Promise<string> => {
    const res = await fetch(`${API_URL}/push/vapid-public-key`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Server push non configurato');
    const data = await res.json();
    if (!data.publicKey) throw new Error('VAPID public key mancante');
    return data.publicKey as string;
};

export const getCurrentSubscription = async (): Promise<PushSubscription | null> => {
    const reg = await registerServiceWorker();
    if (!reg) return null;
    return reg.pushManager.getSubscription();
};

export const enablePushNotifications = async (): Promise<PushSubscription> => {
    if (!isPushSupported()) {
        throw new Error('Push non supportate dal browser');
    }

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error('Permesso notifiche negato');
    }

    const reg = await registerServiceWorker();
    if (!reg) throw new Error('Impossibile registrare il service worker');

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
        const publicKey = await fetchVapidPublicKey();
        sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
    }

    const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    const res = await fetch(`${API_URL}/push/subscribe`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
            userAgent: navigator.userAgent,
        }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Errore durante la sottoscrizione');
    }

    return sub;
};

export const disablePushNotifications = async (): Promise<void> => {
    const sub = await getCurrentSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    try {
        await sub.unsubscribe();
    } catch (err) {
        console.error('Failed to unsubscribe locally', err);
    }
    try {
        await fetch(`${API_URL}/push/unsubscribe`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ endpoint }),
        });
    } catch (err) {
        console.error('Failed to notify server of unsubscribe', err);
    }
};

export const sendTestPush = async (): Promise<void> => {
    const res = await fetch(`${API_URL}/push/test`, {
        method: 'POST',
        headers: authHeaders(),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Invio fallito');
    }
};
