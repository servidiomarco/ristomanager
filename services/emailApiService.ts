import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

// Email inbox — parallel to messagesApiService but keyed by email address
// instead of phone digits. Backed by the same outbound_messages table.

export type EmailDirection = 'inbound' | 'outbound';

/** URL scaricabile di un allegato partito: il token da 32 byte è la protezione. */
export const publicMediaUrl = (token: string): string => `${API_URL}/public/media/${token}`;

export interface EmailThreadSummary {
  email_key: string;                    // lowercased email address, the thread key
  email: string;                        // as-typed casing for display
  last_direction: EmailDirection;
  last_subject: string | null;
  last_body: string;
  last_sent_at: string;
  last_reservation_id: number | null;
  unread_count: number;
  last_inbound_at: string | null;
  customer_name: string | null;
}

export interface EmailMessage {
  id: number;
  provider: string;
  channel: 'email';
  direction: EmailDirection;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  reservation_id: number | null;
  /** Allegati partiti con l'email: nome file e token per il download. */
  media?: Array<{ token: string; filename: string | null; content_type?: string; size_bytes?: number }> | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  read_at: string | null;
  error_code: string | null;
  error_message: string | null;
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

class EmailApiService {
  async listThreads(): Promise<{ threads: EmailThreadSummary[] }> {
    return apiRequest(`${API_URL}/email/threads`, { headers: getHeaders() });
  }
  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/email/unread-count`, { headers: getHeaders() });
  }
  async getThread(emailKey: string): Promise<{ messages: EmailMessage[] }> {
    return apiRequest(
      `${API_URL}/email/threads/${encodeURIComponent(emailKey)}`,
      { headers: getHeaders() }
    );
  }
  async markThreadRead(emailKey: string): Promise<{ ok: true; marked: number }> {
    return apiRequest(
      `${API_URL}/email/threads/${encodeURIComponent(emailKey)}/read`,
      { method: 'POST', headers: getHeaders() }
    );
  }
  async send(input: {
    to: string;
    subject: string;
    body: string;
    reservation_id?: number | null;
    in_reply_to?: string | null;
    /** Token di outbound_media (upload diretto o libreria): partono come veri allegati MIME. */
    attachment_tokens?: string[];
  }): Promise<{ ok: true; message: EmailMessage }> {
    return apiRequest(`${API_URL}/email/send`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  }
}

export const emailApiService = new EmailApiService();
