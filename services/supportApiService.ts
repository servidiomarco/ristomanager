import { authApiService } from './authApiService';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import { onSocketEvent } from './socketEvents';
import type {
  SupportCategory, SupportStatus, SupportPriority, SupportTicket, SupportTicketDetail, SupportMetrics, NewsEntry,
} from './supportShared';

/* Supporto clienti (Aiuto): le chiamate del ristorante (/support) e quelle
   del pannello piattaforma (/admin/support). Stesso schema di
   staffChatApiService: fetch con refresh del token su 401, errori tipizzati. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface SupportUploadedAttachment {
  token: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
}

export interface SupportClientContext {
  origin_view?: string;
  app_version?: string;
  user_agent?: string;
  viewport?: string;
  dpr?: number;
  standalone?: boolean;
  language?: string;
  timezone?: string;
  online?: boolean;
  socket_connected?: boolean;
  offline_queue?: number;
  node_hybrid?: boolean;
  node_in_use?: boolean;
}

export interface PlatformSupportList {
  tickets: SupportTicket[];
  counts: Record<SupportStatus, number>;
  unread: number;
}

const getHeaders = (json = false): Record<string, string> => {
  const headers: Record<string, string> = {};
  const socketId = socketClient.getSocket()?.id;
  if (socketId) headers['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
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
    const err = buildApiError(response.status, errorData);
    // Le rotte del supporto mandano accanto al codice (`error`) una frase
    // per chi legge (`message`): è quella che va mostrata. Senza, la vista
    // Aiuto mostrava «ai_key_invalid» o «invalid_subject» al ristoratore.
    if (typeof errorData?.message === 'string' && errorData.message.trim()) err.message = errorData.message;
    throw err;
  }
  return response.json();
};

/** Gli eventi del supporto (vedi onSocketEvent): `support:updated` arriva
 *  al ristorante, `support:admin-updated` alla stanza degli admin. */
export const onSupportSocketEvent = (
  event: 'support:updated' | 'support:admin-updated',
  handler: (payload: { id?: number; tenant_id?: number }) => void,
): (() => void) => onSocketEvent(event, handler);

/** Le foto del supporto stanno dietro login (possono mostrare dati di
 *  clienti): un <img src> non manda l'header Authorization, quindi si
 *  scaricano con il token e si mostrano da un object URL. */
export const fetchSupportAttachmentUrl = async (token: string, scope: 'tenant' | 'platform'): Promise<string> => {
  const path = scope === 'platform' ? '/admin/support/attachments/' : '/support/attachments/';
  const response = await fetchWithAuth(`${API_URL}${path}${encodeURIComponent(token)}`, { headers: getHeaders() });
  if (!response.ok) throw buildApiError(response.status, { error: 'attachment_unavailable' });
  return URL.createObjectURL(await response.blob());
};

class SupportApiService {
  /* ── Ristorante ──────────────────────────────────────────────────────── */

  async list(): Promise<{ tickets: SupportTicket[]; sees_all: boolean }> {
    return apiRequest(`${API_URL}/support/tickets`, { headers: getHeaders() });
  }

  async get(id: number): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets/${id}`, { headers: getHeaders() });
  }

  async create(input: {
    category: SupportCategory;
    urgent: boolean;
    subject: string;
    body: string;
    attachments: string[];
    context: SupportClientContext;
  }): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify(input),
    });
  }

  async reply(id: number, body: string, attachments: string[]): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets/${id}/messages`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ body, attachments }),
    });
  }

  async resolve(id: number): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets/${id}`, {
      method: 'PATCH',
      headers: getHeaders(true),
      body: JSON.stringify({ status: 'risolto' }),
    });
  }

  async escalate(id: number): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets/${id}`, {
      method: 'PATCH',
      headers: getHeaders(true),
      body: JSON.stringify({ priority: 'urgente' }),
    });
  }

  // Come la chat staff: le foto dal telefono pesano 3-5 MB e qui serve
  // leggere uno schermo, non stamparlo.
  async uploadAttachment(file: File): Promise<SupportUploadedAttachment> {
    const dataUrl = await resizeImageToDataUrl(file, 1600, 0.82);
    const data = dataUrl.split(',')[1] || '';
    const filename = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return apiRequest(`${API_URL}/support/attachments`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ content_type: 'image/jpeg', filename, data }),
    });
  }

  /** Fase 4: com'è andata una richiesta risolta (1 / -1), con un commento. */
  async rate(id: number, rating: 1 | -1, comment?: string): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/support/tickets/${id}/rating`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ rating, comment }),
    });
  }

  /** Le novità dal registro delle modifiche (più recenti prima). */
  async news(limit = 30): Promise<NewsEntry[]> {
    const res = await apiRequest<{ entries: NewsEntry[] }>(`${API_URL}/support/news?limit=${limit}`, { headers: getHeaders() });
    return Array.isArray(res.entries) ? res.entries : [];
  }

  /** «Chiedi a Sympotia»: la conversazione intera, l'ultima è la domanda. */
  async ask(messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<{ answer: string; suggest_ticket: boolean }> {
    return apiRequest(`${API_URL}/support/assistant`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ messages }),
    });
  }

  /* ── Pannello piattaforma ────────────────────────────────────────────── */

  async adminList(filters: { status?: SupportStatus | 'aperte' | 'tutte'; priority?: SupportPriority; tenantId?: number } = {}): Promise<PlatformSupportList> {
    const qs = new URLSearchParams();
    if (filters.status) qs.set('status', filters.status);
    if (filters.priority) qs.set('priority', filters.priority);
    if (filters.tenantId) qs.set('tenant_id', String(filters.tenantId));
    const suffix = qs.toString() ? `?${qs}` : '';
    return apiRequest(`${API_URL}/admin/support/tickets${suffix}`, { headers: getHeaders() });
  }

  async adminMetrics(days = 30): Promise<SupportMetrics> {
    return apiRequest(`${API_URL}/admin/support/metrics?days=${days}`, { headers: getHeaders() });
  }

  async adminGet(id: number): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/admin/support/tickets/${id}`, { headers: getHeaders() });
  }

  async adminReply(id: number, body: string, status?: SupportStatus): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/admin/support/tickets/${id}/messages`, {
      method: 'POST',
      headers: getHeaders(true),
      body: JSON.stringify({ body, status }),
    });
  }

  async adminUpdate(id: number, patch: { status?: SupportStatus; priority?: SupportPriority }): Promise<SupportTicketDetail> {
    return apiRequest(`${API_URL}/admin/support/tickets/${id}`, {
      method: 'PATCH',
      headers: getHeaders(true),
      body: JSON.stringify(patch),
    });
  }

  async adminCreateDevCard(id: number): Promise<{ dev_card_id: number }> {
    return apiRequest(`${API_URL}/admin/support/tickets/${id}/dev-card`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const supportApiService = new SupportApiService();
