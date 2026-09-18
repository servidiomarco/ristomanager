// Servizio API del modulo asporto, sullo stampo di ordersApiService:
// stesso refresh su 401, stesso X-Socket-ID sulle scritture (il server
// però broadcasta takeaway:* a TUTTI, mittente compreso: la riga del
// server è autoritativa, come per le prenotazioni).
import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { TakeawayOrderView, TakeawaySlotBoard, TakeawayStatus } from '../types';
import { buildApiError } from './apiError';
import { routeWriteUrl, cloudFallbackUrl, fetchNodeAware } from './apiRouting';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface TakeawayItemPayload {
  dish_id: number;
  qty: number;
  note?: string | null;
}

export interface CreateTakeawayPayload {
  customer_name: string;
  customer_phone?: string;
  pickup_date: string;
  pickup_time: string;
  items: TakeawayItemPayload[];
  notes?: string;
  /** Scavalca stop e capienza — la decisione di chi sta al banco. */
  force?: boolean;
}

export interface PatchTakeawayPayload {
  customer_name?: string;
  customer_phone?: string;
  pickup_date?: string;
  pickup_time?: string;
  items?: TakeawayItemPayload[];
  notes?: string;
  force?: boolean;
}

export interface TakeawayConfig {
  capacity_per_slot: number;
  prep_minutes: number;
  stop_date: string | null;
  /** Interruttore della pagina pubblica /ordina (flag takeaway_online_enabled). */
  online_enabled: boolean;
  /** Interruttore degli ordini presi da Sofia al telefono (takeaway_voice_enabled). */
  voice_enabled: boolean;
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
  // Fase 4c: la board dell'asporto (stato, lancio, righe) scrive sul nodo
  // quando l'autorità è in sala; se il nodo non risponde si ritenta sul
  // cloud, come negli altri servizi sala.
  url = routeWriteUrl(url, (options.method as string) || 'GET');
  let response: Response;
  try {
    response = await fetchNodeAware(url, options);
  } catch (err) {
    const cloudUrl = cloudFallbackUrl(url);
    if (!cloudUrl) throw err;
    return fetchWithAuth(cloudUrl, options, retried);
  }
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

class AsportoApiService {
  async getOrders(date: string): Promise<{ date: string; orders: TakeawayOrderView[] }> {
    return apiRequest(`${API_URL}/takeaway/orders?date=${encodeURIComponent(date)}`, { headers: getHeaders() });
  }

  async getSlots(date: string): Promise<TakeawaySlotBoard> {
    return apiRequest(`${API_URL}/takeaway/slots?date=${encodeURIComponent(date)}`, { headers: getHeaders() });
  }

  async getConfig(): Promise<TakeawayConfig> {
    return apiRequest(`${API_URL}/takeaway/config`, { headers: getHeaders() });
  }

  async updateConfig(payload: Partial<TakeawayConfig>): Promise<TakeawayConfig> {
    return apiRequest(`${API_URL}/takeaway/config`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async createOrder(payload: CreateTakeawayPayload): Promise<TakeawayOrderView> {
    return apiRequest(`${API_URL}/takeaway/orders`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async updateOrder(id: number, payload: PatchTakeawayPayload): Promise<TakeawayOrderView> {
    return apiRequest(`${API_URL}/takeaway/orders/${id}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  /** «Prepara il conto»: chiude la comanda e apre il conto in coda cassa. */
  async prepareBill(id: number): Promise<{ bill_id: number; reused: boolean; total_cents: number }> {
    return apiRequest(`${API_URL}/takeaway/orders/${id}/bill`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** «Manda in cucina»: genera la comanda TAKEAWAY e lancia l'uscita. */
  async fire(id: number): Promise<TakeawayOrderView> {
    return apiRequest(`${API_URL}/takeaway/orders/${id}/fire`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** force_unpaid: ritiro confermato dall'operatore a conto ancora aperto
      (il server altrimenti risponde 409 bill_unpaid). */
  async setStatus(id: number, status: TakeawayStatus, opts?: { forceUnpaid?: boolean }): Promise<TakeawayOrderView> {
    return apiRequest(`${API_URL}/takeaway/orders/${id}/status`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(opts?.forceUnpaid ? { status, force_unpaid: true } : { status }),
    });
  }
}

export const asportoApiService = new AsportoApiService();
