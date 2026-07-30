import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type FireMode = 'AUTO_ALL' | 'AUTO_FIRST' | 'MANUAL';

export interface SalaStation {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  is_active: boolean;
  /** Nome logico della termica del centro; null = solo monitor KDS. */
  printer: string | null;
}

export interface SalaPrinter {
  id: number;
  name: string;
  host: string;
  port: number;
  kind: 'THERMAL' | 'FISCAL';
  is_active: boolean;
  notes: string | null;
}

export interface SalaConfig {
  fire_mode: FireMode;
  stations: SalaStation[];
  printers: SalaPrinter[];
  agent: { online: boolean; last_seen_seconds: number | null };
  pending_jobs: number;
  failed_jobs: number;
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
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }
  return response.json();
};

export const getSalaConfig = (): Promise<SalaConfig> =>
  apiRequest(`${API_URL}/sala/config`, { headers: getHeaders() });

export const setFireMode = (mode: FireMode): Promise<{ fire_mode: FireMode }> =>
  apiRequest(`${API_URL}/sala/fire-mode`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ mode }),
  });

export const createStation = (input: { name: string; color?: string | null; printer?: string | null }): Promise<SalaStation> =>
  apiRequest(`${API_URL}/sala/stations`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
  });

export const updateStation = (id: number, input: Partial<Pick<SalaStation, 'name' | 'color' | 'is_active' | 'printer'>>): Promise<SalaStation> =>
  apiRequest(`${API_URL}/sala/stations/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
  });

export const createPrinter = (input: { name: string; host: string; port?: number; kind?: 'THERMAL' | 'FISCAL'; notes?: string }): Promise<SalaPrinter> =>
  apiRequest(`${API_URL}/sala/printers`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
  });

export const updatePrinter = (id: number, input: Partial<Pick<SalaPrinter, 'host' | 'port' | 'is_active' | 'notes'>>): Promise<SalaPrinter> =>
  apiRequest(`${API_URL}/sala/printers/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
  });

export const deletePrinter = (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/sala/printers/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });

export const testPrinter = (id: number): Promise<{ id: number; status: string }> =>
  apiRequest(`${API_URL}/sala/printers/${id}/test`, {
    method: 'POST', headers: getHeaders(),
  });
