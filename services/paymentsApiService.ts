import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

// Payment status vocabulary the UI works with. Backend column is VARCHAR(20),
// mirroring Revolut order states (PENDING/AUTHORISED/COMPLETED/CANCELLED/
// FAILED) plus our own EXPIRED terminal state; we also treat PAID as a
// friendly synonym for COMPLETED when displaying badges.
export type PaymentStatus =
  | 'PENDING'
  | 'AUTHORISED'
  | 'COMPLETED'
  | 'PAID'
  | 'CANCELLED'
  | 'FAILED'
  | 'EXPIRED'
  | string;

export interface PaymentRequest {
  id: number;
  reservation_id: number | null;
  amount_cents: number;
  currency: string;
  description: string | null;
  status: PaymentStatus;
  provider: string;
  provider_order_id: string | null;
  checkout_url: string | null;
  delivery_channel: string | null;
  delivery_provider_sid: string | null;
  delivery_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  reservation_customer_name: string | null;
  reservation_phone: string | null;
  reservation_time: string | null;
  reservation_guests: number | null;
  reservation_status: string | null;
}

export interface PaymentsListResponse {
  items: PaymentRequest[];
  total: number;
  limit: number;
  offset: number;
}

export interface PaymentsListParams {
  from?: string;
  to?: string;
  q?: string;
  // Comma-separated list of statuses (case-insensitive).
  status?: string;
  limit?: number;
  offset?: number;
}

export interface PaymentMessage {
  id: number;
  provider: string;
  channel: 'sms' | 'whatsapp' | 'email' | string;
  to_phone: string | null;
  to_email: string | null;
  subject: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  reservation_id: number | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
  is_payment_link: boolean;
}

export interface PaymentMessagesResponse {
  items: PaymentMessage[];
  checkout_url: string | null;
}

export interface PaymentReconcileResponse {
  ok: boolean;
  changed: boolean;
  revolut_state?: string;
  first_completion?: boolean;
  ignored?: string;
  message?: string;
  payment_request?: PaymentRequest;
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
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }
  return response.json();
};

const buildQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

class PaymentsApiService {
  async list(params: PaymentsListParams = {}): Promise<PaymentsListResponse> {
    const qs = buildQuery({
      from: params.from,
      to: params.to,
      q: params.q,
      status: params.status,
      limit: params.limit,
      offset: params.offset,
    });
    return apiRequest<PaymentsListResponse>(`${API_URL}/payments${qs}`, {
      headers: getHeaders(),
    });
  }

  async listMessages(id: number): Promise<PaymentMessagesResponse> {
    return apiRequest<PaymentMessagesResponse>(`${API_URL}/payments/${id}/messages`, {
      headers: getHeaders(),
    });
  }

  async reconcile(id: number): Promise<PaymentReconcileResponse> {
    return apiRequest<PaymentReconcileResponse>(`${API_URL}/payments/${id}/reconcile`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const paymentsApiService = new PaymentsApiService();
