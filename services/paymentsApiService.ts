import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

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
  // Pay-at-table: set only when the payment comes from a bill split. The
  // table name is the REAL number shown in the room, not the internal id.
  table_bill_split_id: number | null;
  table_bill_id: number | null;
  claimant_label: string | null;
  bill_total_cents: number | null;
  bill_status: string | null;
  table_name: string | null;
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
  // Gateway that owns the reconciled order, and its raw state. `revolut_state`
  // is the original field name, kept as an alias of `provider_state` so
  // existing call sites keep working whichever gateway answered.
  provider?: string;
  provider_state?: string;
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
    throw buildApiError(response.status, errorData);
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

  /**
   * Full refund of a standalone payment (deposit / payment link). Bill-split
   * payments use billsApiService.refundSplit instead — that endpoint also
   * reopens the bill when the refund drops it below its total.
   */
  async refund(id: number): Promise<{ ok: true; payment_request: PaymentRequest }> {
    return apiRequest<{ ok: true; payment_request: PaymentRequest }>(`${API_URL}/payments/${id}/refund`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /**
   * Card #28 — revoca di un link ancora payabile (PENDING/AUTHORISED):
   * annulla l'ordine al provider così il cliente non può più pagarlo.
   */
  async revoke(id: number): Promise<{ ok: true; payment_request: PaymentRequest }> {
    return apiRequest<{ ok: true; payment_request: PaymentRequest }>(`${API_URL}/payments/${id}/revoke`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** Paid payments nobody has looked at yet — feeds the sidebar badge. */
  async unseenCount(): Promise<{ count: number }> {
    return apiRequest<{ count: number }>(`${API_URL}/payments/unseen-count`, {
      headers: getHeaders(),
    });
  }

  /** Marks every currently-paid payment as seen (server-side, all devices). */
  async markSeen(): Promise<{ marked: number }> {
    return apiRequest<{ marked: number }>(`${API_URL}/payments/mark-seen`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const paymentsApiService = new PaymentsApiService();
