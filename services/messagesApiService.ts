import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type MessageChannel = 'sms' | 'whatsapp';
export type MessageDirection = 'inbound' | 'outbound';

export interface ConversationSummary {
  phone_digits: string;
  phone: string | null;
  last_channel: MessageChannel;
  last_direction: MessageDirection;
  last_body: string;
  last_sent_at: string;
  last_reservation_id: number | null;
  unread_count: number;
  last_inbound_at: string | null;
  customer_name: string | null;
}

export interface InboxMessage {
  id: number;
  provider: string;
  channel: MessageChannel;
  direction: MessageDirection;
  from_phone: string | null;
  to_phone: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  reservation_id: number | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  read_at: string | null;
  error_code: string | null;
  error_message: string | null;
  from_phone_digits?: string | null;
  to_phone_digits?: string | null;
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
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    const err = new Error(errorData.error || `Request failed with status ${response.status}`) as Error & {
      status?: number; data?: any;
    };
    err.status = response.status;
    err.data = errorData;
    throw err;
  }
  return response.json();
};

class MessagesApiService {
  async listConversations(): Promise<{ conversations: ConversationSummary[] }> {
    return apiRequest(`${API_URL}/messages/conversations`, { headers: getHeaders() });
  }

  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/messages/unread-count`, { headers: getHeaders() });
  }

  async getTimeline(phoneDigits: string): Promise<{ messages: InboxMessage[] }> {
    return apiRequest(`${API_URL}/messages/conversations/${encodeURIComponent(phoneDigits)}`, {
      headers: getHeaders(),
    });
  }

  async markRead(phoneDigits: string): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/messages/conversations/${encodeURIComponent(phoneDigits)}/read`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  async send(params: {
    phone: string;
    text: string;
    channel?: MessageChannel;
  }): Promise<{ ok: true; message: InboxMessage | null; channel: MessageChannel; sid: string | null }> {
    return apiRequest(`${API_URL}/messages/send`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
}

export const messagesApiService = new MessagesApiService();
