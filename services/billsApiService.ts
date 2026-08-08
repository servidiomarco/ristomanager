import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { TableBill, TableBillWithSplits } from '../types';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface OpenBillPayload {
  /** Obbligatorio per l'apertura manuale; ignorato con source='passepartout'
   *  (righe e totale arrivano dalla comanda del gestionale). */
  total_cents?: number;
  covers?: number;
  source?: 'passepartout';
  /** Nome del tavolo sul gestionale Passepartout (es. "40", "204."). */
  pp_tavolo?: string;
}

export interface CloseBillPayload {
  cash_settled_cents?: number;
  tip_cents?: number;
  notes?: string;
}

export interface VoidBillPayload {
  notes?: string;
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

class BillsApiService {
  // 404 → no active bill (caller handles as "no bill yet")
  async getBill(reservationId: number): Promise<TableBillWithSplits | null> {
    try {
      return await apiRequest<TableBillWithSplits>(`${API_URL}/reservations/${reservationId}/bill`, {
        headers: getHeaders(),
      });
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async openBill(reservationId: number, payload: OpenBillPayload): Promise<TableBillWithSplits> {
    return apiRequest<TableBillWithSplits>(`${API_URL}/reservations/${reservationId}/bill`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async closeBill(billId: number, payload: CloseBillPayload = {}): Promise<TableBill> {
    return apiRequest<TableBill>(`${API_URL}/bills/${billId}/close`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async voidBill(billId: number, payload: VoidBillPayload = {}): Promise<TableBill> {
    return apiRequest<TableBill>(`${API_URL}/bills/${billId}/void`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  /** Refunds a paid split via Revolut; the bill reopens if it was SETTLED. */
  async refundSplit(splitId: number): Promise<{ ok: true; split_id: number; bill_id: number; reopened: boolean }> {
    return apiRequest(`${API_URL}/bills/splits/${splitId}/refund`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  // Server picks WhatsApp when a Meta-approved template is available and the
  // customer is inside the 24h service window; otherwise falls back to SMS.
  // The returned `channel` tells the UI which one was actually used.
  async notifyBillLink(reservationId: number): Promise<{
    ok: true;
    bill_id: number;
    channel: 'sms' | 'whatsapp' | string;
    provider_sid: string | null;
    public_url: string;
  }> {
    return apiRequest(`${API_URL}/reservations/${reservationId}/bill/notify`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const billsApiService = new BillsApiService();

export interface OpenBillRow {
  id: number;
  reservation_id: number | null;
  table_id: number | null;
  table_name: string | null;
  customer_name: string | null;
  total_cents: number;
  covers: number;
  currency: string;
  items: { name: string; qty: number; unit_price_cents: number }[] | null;
  status: string;
  share_token: string | null;
  opened_at: string;
  paid_cents: number;
  claimed_cents: number;
  /** Acconto già versato sulla prenotazione, portato nel conto. Già in paid_cents. */
  deposit_credit_cents?: number;
  residual_cents: number;
  paid_splits: number;
  /** Comande ancora aperte su questo conto: il tavolo sta ancora ordinando. */
  open_orders: number;
  service_date: string;
  shift: 'LUNCH' | 'DINNER';
  is_current_service: boolean;
}

/** Comanda rimasta aperta in un servizio precedente. */
export interface StaleOrderRow {
  id: number;
  table_id: number | null;
  table_name: string | null;
  service_date: string;
  shift: 'LUNCH' | 'DINNER';
  covers: number;
  opened_at: string;
  total_cents: number;
}

/** Conti attivi, con e senza prenotazione, più le comande rimaste appese. */
export const getOpenBills = async (): Promise<{
  service: { service_date: string; shift: 'LUNCH' | 'DINNER' };
  bills: OpenBillRow[];
  stale_orders: StaleOrderRow[];
}> => apiRequest(`${API_URL}/bills/open`, { headers: getHeaders() });

/** Accoda la stampa del preconto sulla termica in sala. L'origin serve al
 *  server per comporre l'URL del QR: solo il client sa da che host è servita
 *  la SPA (IP in LAN, dominio in produzione). */
export const printBill = async (
  billId: number,
  kind: 'PRECONTO' | 'QR' = 'PRECONTO',
): Promise<{ id: number; status: string }> =>
  apiRequest<{ id: number; status: string }>(`${API_URL}/print-jobs`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ bill_id: billId, origin: window.location.origin, kind }),
  });
