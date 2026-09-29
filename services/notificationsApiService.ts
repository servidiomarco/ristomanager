import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

// Personal notification centre — persistent history of every push event
// the operator was targeted by, whether the browser was subscribed or not.

export interface NotificationRow {
  id: number;
  category: string | null;
  title: string;
  body: string | null;
  url: string | null;
  tag: string | null;
  metadata: Record<string, any> | null;
  sent_at: string;
  read_at: string | null;
  dismissed_at: string | null;
}

const getHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {};
  const socketId = socketClient.getSocket()?.id;
  if (socketId) headers['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

const fetchWithAuth = async (url: string, options: RequestInit = {}, retried = false): Promise<Response> => {
  const response = await fetch(url, options);
  if (response.status === 401 && !retried) {
    const refreshed = await authApiService.refreshToken();
    if (refreshed) {
      const newHeaders = { ...options.headers } as Record<string, string>;
      newHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;
      return fetchWithAuth(url, { ...options, headers: newHeaders }, true);
    }
  }
  return response;
};

const apiRequest = async <T>(url: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithAuth(url, options);
  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, err);
  }
  return response.json();
};

class NotificationsApiService {
  async list(params: {
    unread?: boolean;
    include_dismissed?: boolean;
    category?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<{ notifications: NotificationRow[] }> {
    const qs = new URLSearchParams();
    if (params.unread) qs.set('unread', '1');
    if (params.include_dismissed) qs.set('include_dismissed', '1');
    if (params.category) qs.set('category', params.category);
    if (params.limit != null) qs.set('limit', String(params.limit));
    if (params.offset != null) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return apiRequest(`${API_URL}/notifications${query ? `?${query}` : ''}`, { headers: getHeaders() });
  }
  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/notifications/unread-count`, { headers: getHeaders() });
  }
  async counts(): Promise<{
    total: number;
    unread: number;
    by_category: {
      reservation: number;
      voice: number;
      payment: number;
      message: number;
      email: number;
      system: number;
      general: number;
    };
  }> {
    return apiRequest(`${API_URL}/notifications/counts`, { headers: getHeaders() });
  }
  async markRead(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/notifications/${id}/read`, { method: 'POST', headers: getHeaders() });
  }
  async markReadByTag(tag: string): Promise<{ ok: true; marked: number }> {
    return apiRequest(`${API_URL}/notifications/read-by-tag`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag }),
    });
  }
  async markAllRead(): Promise<{ ok: true; marked: number }> {
    return apiRequest(`${API_URL}/notifications/read-all`, { method: 'POST', headers: getHeaders() });
  }
  async dismiss(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/notifications/${id}/dismiss`, { method: 'POST', headers: getHeaders() });
  }
}

export const notificationsApiService = new NotificationsApiService();

// Payload di 'notifications:read': letture fatte su un altro dispositivo
// dello stesso utente, o — per telefonate, messaggi e tavoli — da un
// collega. Letto con difesa: un backend più vecchio non lo emette affatto.
export interface NotificationsReadEvent {
  ids: number[];
  tags: string[];
  all: boolean;
}

/** Richiama `onChange` a ogni notifica nuova o letta altrove. Si ri-aggancia
 *  da solo alla riconnessione del socket. */
export const subscribeNotificationChanges = (
  onChange: (read: NotificationsReadEvent | null) => void
): (() => void) => {
  const onNew = () => onChange(null);
  const onRead = (raw: any) => onChange({
    ids: Array.isArray(raw?.ids) ? raw.ids.filter((x: unknown) => typeof x === 'number') : [],
    tags: Array.isArray(raw?.tags) ? raw.tags.filter((x: unknown) => typeof x === 'string') : [],
    all: raw?.all === true,
  });
  let attached: ReturnType<typeof socketClient.getSocket> = null;
  const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
    if (attached === s) return;
    if (attached) {
      attached.off('notification:new', onNew);
      attached.off('notifications:read', onRead);
    }
    attached = s;
    if (attached) {
      attached.on('notification:new', onNew);
      attached.on('notifications:read', onRead);
    }
  };
  attach(socketClient.getSocket());
  const unsub = socketClient.onSocketChange((s) => attach(s));
  return () => { unsub(); attach(null); };
};

const displayedSystemNotifications = async (): Promise<Notification[]> => {
  try {
    if (!('serviceWorker' in navigator)) return [];
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.getNotifications() : [];
  } catch {
    return [];
  }
};

/** Toglie dal centro notifiche del sistema operativo le push già lette:
 *  senza, il banner restava sul telefono anche dopo averlo gestito dal
 *  tablet. */
export const closeSystemNotifications = async (tags: string[]): Promise<void> => {
  if (tags.length === 0) return;
  const wanted = new Set(tags);
  for (const n of await displayedSystemNotifications()) {
    if (n.tag && wanted.has(n.tag)) n.close();
  }
};

/** Riallinea le push mostrate con lo stato sul server: chiude quelle la cui
 *  notifica risulta già letta. Serve al rientro nell'app, quando gli eventi
 *  socket arrivati a schermo spento sono andati persi. Le push senza riga
 *  in `notifications` (chat staff) non si toccano. */
export const reconcileSystemNotifications = async (): Promise<void> => {
  const shown = (await displayedSystemNotifications()).filter(n => n.tag);
  if (shown.length === 0) return;
  let rows: NotificationRow[];
  try {
    ({ notifications: rows } = await notificationsApiService.list({ include_dismissed: true, limit: 200 }));
  } catch {
    return;
  }
  const unread = new Set(rows.filter(r => r.tag && !r.read_at).map(r => r.tag as string));
  const read = new Set(rows.filter(r => r.tag && r.read_at).map(r => r.tag as string));
  for (const n of shown) {
    if (read.has(n.tag) && !unread.has(n.tag)) n.close();
  }
};
