import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type FireMode = 'AUTO_ALL' | 'AUTO_FIRST' | 'AUTO_NEXT' | 'MANUAL';

export interface SalaStation {
  id: number;
  name: string;
  color: string | null;
  sort_order: number;
  is_active: boolean;
  /** Nome logico della termica del centro; null = solo monitor KDS. */
  printer: string | null;
  /** Pronto automatico: la partita lavora solo di carta (nessun monitor),
   *  le sue righe nascono già pronte al lancio e non bloccano l'uscita. */
  auto_ready: boolean;
  /** La comanda stampata porta anche i piatti delle altre partite della
   *  stessa uscita (in corpo piccolo, per partita). Per chi impiatta
   *  guardando cosa esce insieme — gli antipasti. */
  full_course: boolean;
}

export interface SalaPrinter {
  id: number;
  name: string;
  host: string;
  port: number;
  kind: 'THERMAL' | 'FISCAL';
  is_active: boolean;
  /** Cicalino alla stampa: l'agente antepone il beep ESC/POS a ogni job
   *  verso questa termica. Per la cucina, non per il banco. */
  buzzer: boolean;
  notes: string | null;
}

export interface SalaPrintRoutes {
  /** Nome della termica per il preconto; null = default 'preconti'. */
  preconto: string | null;
  /** Nome della termica per il foglietto QR del conto; null = default 'preconti'. */
  qr: string | null;
}

export interface SalaConfig {
  fire_mode: FireMode;
  stations: SalaStation[];
  printers: SalaPrinter[];
  print_routes: SalaPrintRoutes;
  /** Categorie di menu presenti in anagrafica piatti. */
  categories: string[];
  /** Mappa categoria → id partita (solo le categorie mappate). */
  category_stations: Record<string, number>;
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
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

export const getSalaConfig = (): Promise<SalaConfig> =>
  apiRequest(`${API_URL}/sala/config`, { headers: getHeaders() });

/** Campo assente = non toccare; null = torna al default 'preconti'. */
export const updatePrintRoutes = (routes: Partial<SalaPrintRoutes>): Promise<{ ok: true; print_routes: SalaPrintRoutes }> =>
  apiRequest(`${API_URL}/sala/print-routes`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(routes),
  });

export const setFireMode = (mode: FireMode): Promise<{ fire_mode: FireMode }> =>
  apiRequest(`${API_URL}/sala/fire-mode`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ mode }),
  });

export const createStation = (input: { name: string; color?: string | null; printer?: string | null }): Promise<SalaStation> =>
  apiRequest(`${API_URL}/sala/stations`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
  });

export const updateStation = (id: number, input: Partial<Pick<SalaStation, 'name' | 'color' | 'is_active' | 'printer' | 'auto_ready' | 'full_course'>>): Promise<SalaStation> =>
  apiRequest(`${API_URL}/sala/stations/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
  });

export const createPrinter = (input: { name: string; host: string; port?: number; kind?: 'THERMAL' | 'FISCAL'; notes?: string }): Promise<SalaPrinter> =>
  apiRequest(`${API_URL}/sala/printers`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(input),
  });

export const updatePrinter = (id: number, input: Partial<Pick<SalaPrinter, 'host' | 'port' | 'is_active' | 'buzzer' | 'notes'>>): Promise<SalaPrinter> =>
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

export interface SalaProfile {
  id: number;
  name: string;
  updated_at: string;
}

export const getSalaProfiles = (): Promise<{ profiles: SalaProfile[]; active_profile: string | null }> =>
  apiRequest(`${API_URL}/sala/profiles`, { headers: getHeaders() });

/** Salva il setup corrente (fire mode + partite + stampanti) come profilo. */
export const createSalaProfile = (name: string): Promise<SalaProfile> =>
  apiRequest(`${API_URL}/sala/profiles`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ name }),
  });

/** Sovrascrive lo snapshot del profilo con il setup corrente. */
export const updateSalaProfile = (id: number): Promise<SalaProfile> =>
  apiRequest(`${API_URL}/sala/profiles/${id}`, { method: 'PUT', headers: getHeaders() });

/** Applica il profilo (upsert per nome, non distruttivo) e lo marca attivo. */
export const activateSalaProfile = (id: number): Promise<{ ok: true; active_profile: string }> =>
  apiRequest(`${API_URL}/sala/profiles/${id}/activate`, { method: 'POST', headers: getHeaders() });

/** Toglie il marcatore di profilo attivo; la configurazione corrente resta. */
export const detachSalaProfile = (): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/sala/profiles/detach`, { method: 'POST', headers: getHeaders() });

export const deleteSalaProfile = (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/sala/profiles/${id}`, { method: 'DELETE', headers: getHeaders() });

/** Associa una categoria di menu a una partita; null rimuove la mappatura. */
export const setCategoryStation = (category: string, stationId: number | null): Promise<{ category: string; station_id: number | null }> =>
  apiRequest(`${API_URL}/sala/category-stations`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ category, station_id: stationId }),
  });
