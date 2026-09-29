import { authApiService } from './authApiService';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import { closeSystemNotifications, displayedSystemNotifications } from './notificationsApiService';
import type { StaffChannel, StaffMessage } from './staffChat';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface StaffUploadedAttachment {
  token: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
}

// Le foto stanno in outbound_media dietro token non indovinabile: l'URL
// pubblico basta a <img>, niente fetch autenticato.
export const staffMediaUrl = (token: string): string =>
  `${API_URL}/public/media/${encodeURIComponent(token)}`;

/** Il tag che il server dà alla push di un thread (POST /staff-chat/messages):
 *  `staffchat:<threadKey>`, dove per un DM il threadKey è quello visto dal
 *  destinatario (dm:<mittente>). */
export const staffChatPushTag = (threadKey: string): string => `staffchat:${threadKey}`;

/** Il tag della push di menzione di un canale: distinto da quello del
 *  canale, perché la lettura di squadra spegne il secondo e non la prima. */
export const staffChatMentionPushTag = (threadKey: string): string => `staffchat:mention:${threadKey}`;

export interface StaffThreadSummary {
  threadKey: string;
  kind: 'channel' | 'direct';
  channel?: StaffChannel;
  otherUser?: { id: number; fullName: string | null; role: string | null; isActive: boolean };
  lastMessage: StaffMessage | null;
  unreadCount: number;
}

export interface StaffPreset {
  key: string;
  label: string;
}

export interface StaffColleague {
  id: number;
  fullName: string;
  role: string;
}

// Cache a livello modulo, stesso schema di inboxCache (messagesApiService):
// StaffChatPage viene smontata a ogni cambio vista, quindi senza cache ogni
// rientro rifaceva lista e thread da zero — spinner e mezzo secondo di rete
// per dati appena visti. Si mostra subito l'ultimo stato noto e si rinfresca
// in background (stale-while-revalidate); App pre-riempie la lista al login
// e svuota tutto al logout. Le timeline cacheate sono la prima pagina (le
// ultime 50): riaprire un thread mostra quelle subito, il "carica più
// vecchi" resta un fetch normale.
const TIMELINE_CACHE_MAX = 30;
export const staffChatCache = {
  list: null as { threads: StaffThreadSummary[]; colleagues: StaffColleague[] } | null,
  timelines: new Map<string, StaffMessage[]>(),
  setTimeline(threadKey: string, messages: StaffMessage[]) {
    // Ri-inserire la chiave la sposta in coda: la prima è sempre la meno recente.
    this.timelines.delete(threadKey);
    this.timelines.set(threadKey, messages);
    if (this.timelines.size > TIMELINE_CACHE_MAX) {
      const oldest = this.timelines.keys().next().value;
      if (oldest !== undefined) this.timelines.delete(oldest);
    }
  },
  clear() {
    this.list = null;
    this.timelines.clear();
  },
};

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
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

class StaffChatApiService {
  async listThreads(): Promise<{ threads: StaffThreadSummary[]; colleagues: StaffColleague[] }> {
    return apiRequest(`${API_URL}/staff-chat/threads`, { headers: getHeaders() });
  }

  /** Pre-scalda la cache al login, così il primo ingresso in Chat staff
   *  trova la lista pronta invece dello spinner. Silenzioso: se fallisce,
   *  la pagina farà comunque il suo fetch. */
  async prefetchThreads(): Promise<void> {
    if (staffChatCache.list) return;
    try {
      staffChatCache.list = await this.listThreads();
    } catch { /* niente: il caricamento normale copre */ }
  }

  /** `peer_read_up_to`: solo per i DM, fin dove l'altro ha letto (conferma
   *  di lettura). Assente da un backend più vecchio: leggerlo con difesa. */
  async getMessages(threadKey: string, before?: number): Promise<{ messages: StaffMessage[]; peer_read_up_to?: number | null }> {
    const qs = before ? `?before=${before}` : '';
    return apiRequest(`${API_URL}/staff-chat/threads/${encodeURIComponent(threadKey)}/messages${qs}`, {
      headers: getHeaders(),
    });
  }

  async send(threadKey: string, body: string, presetKey?: string | null, mentionedUserIds?: number[], attachments?: string[]): Promise<StaffMessage> {
    return apiRequest(`${API_URL}/staff-chat/messages`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadKey, body,
        presetKey: presetKey ?? undefined,
        mentionedUserIds: mentionedUserIds && mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      }),
    });
  }

  async markRead(threadKey: string, lastReadMessageId: number): Promise<{ ok: true }> {
    const res = await apiRequest<{ ok: true }>(`${API_URL}/staff-chat/threads/${encodeURIComponent(threadKey)}/read`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastReadMessageId }),
    });
    // Letto qui, di persona: la push del thread e quella di menzione non
    // hanno più niente da dire su questo dispositivo. Gli altri le chiudono
    // su 'staffchat:read' (App.tsx).
    void closeSystemNotifications([staffChatPushTag(threadKey), staffChatMentionPushTag(threadKey)]);
    return res;
  }

  /** Al rientro nell'app: chiude le push dei thread che risultano già letti
   *  (letti su un altro dispositivo mentre questo dormiva e l'evento socket
   *  è andato perso). */
  async reconcileSystemNotifications(): Promise<void> {
    try {
      // La lista thread costa cinque query: la si chiede solo se c'è davvero
      // una push della chat ancora in vista.
      const shown = await displayedSystemNotifications();
      if (!shown.some(n => n.tag?.startsWith(staffChatPushTag('')))) return;
      const { threads } = await this.listThreads();
      const read = threads.filter(t => t.unreadCount === 0)
        .flatMap(t => [staffChatPushTag(t.threadKey), staffChatMentionPushTag(t.threadKey)]);
      await closeSystemNotifications(read);
    } catch { /* best-effort */ }
  }

  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/staff-chat/unread-count`, { headers: getHeaders() });
  }

  // Ridimensiona come l'inbox: le foto dal telefono pesano 3-5 MB e in chat
  // non servono a quella risoluzione.
  async uploadAttachment(file: File): Promise<StaffUploadedAttachment> {
    const dataUrl = await resizeImageToDataUrl(file, 1600, 0.82);
    const data = dataUrl.split(',')[1] || '';
    const filename = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return apiRequest(`${API_URL}/staff-chat/attachments`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg', filename, data }),
    });
  }

  async getPresets(): Promise<{ presets: StaffPreset[]; custom: boolean }> {
    return apiRequest(`${API_URL}/staff-chat/presets`, { headers: getHeaders() });
  }

  // Sostituzione integrale della lista; vuota = torna ai default.
  async savePresets(labels: string[]): Promise<{ presets: StaffPreset[]; custom: boolean }> {
    return apiRequest(`${API_URL}/staff-chat/presets`, {
      method: 'PUT',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
  }
}

export const staffChatApiService = new StaffChatApiService();
