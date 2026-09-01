import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { CashSessionView, CashTransactionsView } from '../types';
import { buildApiError } from './apiError';

// Cassa — la sessione del cassetto (docs/cassa-plan.md §3.1, §6).
//
// Modulo a sé e non un'aggiunta a billsApiService: quello parla del CONTO,
// questo del CASSETTO. Sono due oggetti diversi — un conto si chiude senza
// toccare la cassa, e la cassa si chiude con dei conti ancora aperti.

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

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

export interface CashService {
  service_date?: string;
  shift?: 'LUNCH' | 'DINNER';
}

const serviceQuery = (service?: CashService): string => {
  const qs = new URLSearchParams();
  if (service?.service_date) qs.set('date', service.service_date);
  if (service?.shift) qs.set('shift', service.shift);
  return qs.toString() ? `?${qs.toString()}` : '';
};

class CashApiService {
  /** Totali del servizio e sessione, se aperta. Risponde anche a cassa mai
   *  aperta: `session` è null e i numeri del turno ci sono lo stesso. */
  async getSession(service?: CashService): Promise<CashSessionView> {
    return apiRequest<CashSessionView>(`${API_URL}/cash/session${serviceQuery(service)}`, {
      headers: getHeaders(),
    });
  }

  /** I movimenti del servizio: libro cassa + caparre a credito, in un elenco
   *  solo. Le caparre ci sono ma restano fuori dagli incassi. */
  async getTransactions(service?: CashService): Promise<CashTransactionsView> {
    return apiRequest<CashTransactionsView>(`${API_URL}/cash/transactions${serviceQuery(service)}`, {
      headers: getHeaders(),
    });
  }

  /** Dichiara il fondo di apertura. 409 se qualcun altro l'ha già aperta. */
  async openSession(openingFloatCents: number, service?: CashService): Promise<CashSessionView> {
    return apiRequest<CashSessionView>(`${API_URL}/cash/session`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        opening_float_cents: openingFloatCents,
        date: service?.service_date,
        shift: service?.shift,
      }),
    });
  }

  /** Corregge il fondo. Solo a cassa aperta: dopo sposterebbe una differenza
   *  che qualcuno ha già firmato. */
  async updateFloat(sessionId: number, openingFloatCents: number): Promise<CashSessionView> {
    return apiRequest<CashSessionView>(`${API_URL}/cash/session/${sessionId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ opening_float_cents: openingFloatCents }),
    });
  }

  /** Chiude il cassetto. La nota è obbligatoria quando il conteggio non torna:
   *  il 400 riporta `expected_cents` e `difference_cents` ricalcolati dal
   *  server, che sono quelli buoni — fra l'apertura della schermata e questo
   *  click può essere entrato un incasso. */
  async closeSession(sessionId: number, countedCents: number, note?: string): Promise<CashSessionView> {
    return apiRequest<CashSessionView>(`${API_URL}/cash/session/${sessionId}/close`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ counted_cents: countedCents, note: note ?? '' }),
    });
  }
}

export const cashApiService = new CashApiService();
