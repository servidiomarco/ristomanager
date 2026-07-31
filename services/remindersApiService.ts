import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type ReminderKind = 'ONE_OFF' | 'RECURRING';
export type ReminderFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ReminderRole = 'OWNER' | 'GENERAL_MANAGER' | 'MANAGER' | 'RECEPTION' | 'WAITER' | 'KITCHEN';

export interface Reminder {
  id: number;
  title: string;
  description: string | null;
  kind: ReminderKind;
  frequency: ReminderFrequency | null;
  schedule_time: string;              // HH:MM
  schedule_date: string | null;       // YYYY-MM-DD (ONE_OFF only)
  weekdays: string[] | null;          // WEEKLY only
  month_day: number | null;           // MONTHLY only
  target_roles: ReminderRole[];
  active: boolean;
  system_key: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReminderInput {
  title: string;
  description?: string | null;
  kind: ReminderKind;
  frequency?: ReminderFrequency | null;
  schedule_time: string;
  schedule_date?: string | null;
  weekdays?: string[] | null;
  month_day?: number | null;
  target_roles: ReminderRole[];
  active?: boolean;
}

const getHeaders = (): HeadersInit => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

class RemindersApiService {
  async list(): Promise<{ reminders: Reminder[] }> {
    return apiRequest(`${API_URL}/reminders`, { headers: getHeaders() });
  }
  async create(input: ReminderInput): Promise<Reminder> {
    return apiRequest(`${API_URL}/reminders`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
    });
  }
  async update(id: number, input: ReminderInput): Promise<Reminder> {
    return apiRequest(`${API_URL}/reminders/${id}`, {
      method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
    });
  }
  async delete(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/reminders/${id}`, {
      method: 'DELETE', headers: getHeaders(),
    });
  }
}

export const remindersApiService = new RemindersApiService();
