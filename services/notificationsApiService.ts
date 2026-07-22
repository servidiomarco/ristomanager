import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

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
    throw new Error(err.error || `Request failed with status ${response.status}`);
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
      system: number;
      general: number;
    };
  }> {
    return apiRequest(`${API_URL}/notifications/counts`, { headers: getHeaders() });
  }
  async markRead(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/notifications/${id}/read`, { method: 'POST', headers: getHeaders() });
  }
  async markAllRead(): Promise<{ ok: true; marked: number }> {
    return apiRequest(`${API_URL}/notifications/read-all`, { method: 'POST', headers: getHeaders() });
  }
  async dismiss(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/notifications/${id}/dismiss`, { method: 'POST', headers: getHeaders() });
  }
}

export const notificationsApiService = new NotificationsApiService();
