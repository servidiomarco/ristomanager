import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

/* Attività programmate (services/scheduledTasks.ts lato server): le attività
   che nascono da sole in Attività. Stessa forma snake_case dei promemoria. */
export type ScheduledTaskKind = 'BANQUET' | 'RECURRING' | 'ONE_OFF';
export type ScheduledTaskFrequency = 'DAILY' | 'WEEKLY' | 'MONTHLY';
export type ScheduledTaskScope = 'ALL' | 'CONFIRMED';
export type ScheduledTaskTeam = 'OWNER' | 'GENERAL_MANAGER' | 'MANAGER' | 'RECEPTION' | 'WAITER' | 'KITCHEN' | 'CASSA';
export type ScheduledTaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';
export type ScheduledTaskCategory = 'GENERAL' | 'RESERVATION' | 'INVENTORY' | 'STAFF' | 'MAINTENANCE' | 'EVENT';

export interface ScheduledTaskInput {
  title: string;
  description: string | null;
  kind: ScheduledTaskKind;
  days_before: number | null;          // BANQUET
  banquet_scope: ScheduledTaskScope;    // BANQUET
  frequency: ScheduledTaskFrequency | null; // RECURRING
  weekdays: string[] | null;            // RECURRING · WEEKLY
  month_day: number | null;             // RECURRING · MONTHLY
  schedule_date: string | null;         // ONE_OFF
  schedule_time: string;                // HH:MM
  due_in_days: number;                  // RECURRING / ONE_OFF
  covers_per_unit: number | null;       // {quantità}
  assigned_team: ScheduledTaskTeam;
  priority: ScheduledTaskPriority;
  category: ScheduledTaskCategory;
  active: boolean;
}

export interface ScheduledTask extends ScheduledTaskInput {
  id: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
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

class ScheduledTasksApiService {
  async list(): Promise<{ tasks: ScheduledTask[] }> {
    return apiRequest(`${API_URL}/scheduled-tasks`, { headers: getHeaders() });
  }
  async create(input: ScheduledTaskInput): Promise<ScheduledTask> {
    return apiRequest(`${API_URL}/scheduled-tasks`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
    });
  }
  async update(id: number, input: ScheduledTaskInput): Promise<ScheduledTask> {
    return apiRequest(`${API_URL}/scheduled-tasks/${id}`, {
      method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
    });
  }
  async delete(id: number): Promise<{ ok: true; removedTodos: number }> {
    return apiRequest(`${API_URL}/scheduled-tasks/${id}`, {
      method: 'DELETE', headers: getHeaders(),
    });
  }
}

export const scheduledTasksApiService = new ScheduledTasksApiService();
