import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { TableBill, TableBillWithSplits } from '../types';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface OpenBillPayload {
  total_cents: number;
  covers?: number;
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
    const err: any = new Error(errorData.error || `Request failed with status ${response.status}`);
    err.status = response.status;
    err.data = errorData;
    throw err;
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
