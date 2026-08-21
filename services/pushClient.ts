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

const arrayBufferToBase64Url = (buffer: ArrayBuffer | null | undefined): string => {
    if (!buffer) return '';
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

const subscribeFresh = (reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> => {
    return reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
};

const formatSubscribeError = (err: any): string => {
    const name = err?.name;
    const message = err?.message || 'Errore sconosciuto';
    return name ? `${name}: ${message}` : message;
};

// Subscribe with recovery for two known Android failure modes:
//   1. A cached subscription whose applicationServerKey doesn't match the
//      current VAPID public key (typical after a key rotation) — reusing it
//      would let the server send pushes that the browser silently rejects.
//   2. subscribe() throwing "push service error" / AbortError on a device
//      whose FCM/GCM token is in a corrupt state — clearing any lingering
//      subscription and retrying once usually resolves it.
const subscribeWithRecovery = async (
    reg: ServiceWorkerRegistration,
    publicKey: string
): Promise<PushSubscription> => {
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
        const existingKey = arrayBufferToBase64Url(existing.options?.applicationServerKey ?? null);
        if (existingKey === publicKey) {
            return existing;
        }
        console.warn('Stale push subscription detected (VAPID key mismatch), unsubscribing');
        try {
            await existing.unsubscribe();
        } catch (err) {
            console.warn('Failed to unsubscribe stale push subscription', err);
        }
    }

    try {
        return await subscribeFresh(reg, publicKey);
    } catch (firstErr: any) {
        console.error('pushManager.subscribe failed, attempting cleanup + retry', firstErr);
        try {
            const lingering = await reg.pushManager.getSubscription();
            if (lingering) await lingering.unsubscribe();
        } catch (cleanupErr) {
            console.warn('Cleanup unsubscribe failed', cleanupErr);
        }

        try {
            return await subscribeFresh(reg, publicKey);
        } catch (retryErr: any) {
            const detail = formatSubscribeError(retryErr) || formatSubscribeError(firstErr);
            throw new Error(
                `Sottoscrizione push fallita (${detail}). Verifica connessione, account Google attivo sul dispositivo e che l'orologio di sistema sia corretto.`
            );
        }
    }
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

    const publicKey = await fetchVapidPublicKey();
    const sub = await subscribeWithRecovery(reg, publicKey);

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

// La subscription push vive nel BROWSER e sopravvive a logout e cambi di
// account: senza questo sync, le notifiche seguono l'utente che l'ha
// registrata mesi fa, non chi è loggato adesso (il platform admin che
// riceveva le push del ristorante). Da chiamare a ogni login/ripristino
// sessione: se il permesso è già concesso e l'endpoint esiste, lo
// ri-registra per l'utente corrente (l'ON CONFLICT del server riassegna
// user e tenant). Nessun prompt, nessuna subscription nuova: solo il
// passaggio di proprietà. Silenzioso per costruzione — il login non deve
// mai fallire per colpa delle notifiche.
export const syncPushSubscription = async (): Promise<void> => {
    try {
        if (!isPushSupported()) return;
        if (Notification.permission !== 'granted') return;
        const sub = await getCurrentSubscription();
        if (!sub) return;
        const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) return;
        await fetch(`${API_URL}/push/subscribe`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({
                endpoint: json.endpoint,
                keys: json.keys,
                userAgent: navigator.userAgent,
            }),
        });
    } catch (err) {
        console.warn('Push subscription sync failed', err);
    }
};

// Al logout la riga a server va sganciata: un browser senza sessione non
// deve ricevere niente. La subscription del BROWSER resta viva di
// proposito — al prossimo login syncPushSubscription la riassegna senza
// nuovi permessi. Va chiamata PRIMA di buttare i token (serve l'auth).
export const detachPushSubscription = async (): Promise<void> => {
    try {
        if (!isPushSupported()) return;
        const sub = await getCurrentSubscription();
        if (!sub) return;
        await fetch(`${API_URL}/push/unsubscribe`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ endpoint: sub.endpoint }),
        });
    } catch (err) {
        console.warn('Push subscription detach failed', err);
    }
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
