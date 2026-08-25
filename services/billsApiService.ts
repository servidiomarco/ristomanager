import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { BillPaymentMethod, CashClosureReport, FiscalDocument, FiscalProviderSetting, TableBill, TableBillWithSplits } from '../types';
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

/** Movimento di incasso da registrare (metodo + importo, in centesimi). */
export interface BillPaymentInput {
  method: Exclude<BillPaymentMethod, 'LINK_ONLINE'>;
  amount_cents: number;
  meta?: Record<string, unknown>;
}

export interface CloseBillPayload {
  /** Movimenti di incasso registrati contestualmente alla chiusura. */
  payments?: BillPaymentInput[];
  /** Legacy: totale contanti cumulativo. Preferire payments. */
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

  /** Registra un incasso a conto ancora aperto (contanti/POS a metà servizio). */
  async recordPayment(billId: number, payload: BillPaymentInput): Promise<TableBillWithSplits> {
    return apiRequest<TableBillWithSplits>(`${API_URL}/bills/${billId}/payments`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  /** Storna un movimento (soft-void): il conto riapre se il saldo non regge più. */
  async voidPayment(billId: number, paymentId: number, reason?: string): Promise<TableBillWithSplits> {
    return apiRequest<TableBillWithSplits>(`${API_URL}/bills/${billId}/payments/${paymentId}/void`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  /** Chiusura di cassa: totali del giorno per metodo (default oggi). */
  async getCashClosure(date?: string): Promise<CashClosureReport> {
    const suffix = date ? `?date=${encodeURIComponent(date)}` : '';
    return apiRequest<CashClosureReport>(`${API_URL}/reports/cash-closure${suffix}`, {
      headers: getHeaders(),
    });
  }

  /** Emette (o ritenta) il documento commerciale di un conto chiuso.
   *  409 con reason 'in_progress' = emissione già in volo: riprovare. */
  async emitFiscalDoc(billId: number): Promise<{ doc: FiscalDocument; request: unknown }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** Annulla il documento presso il provider (il conto non si tocca). */
  async voidFiscalDoc(billId: number, docId: number): Promise<{ doc: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs/${docId}/void`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** Ritenta la chiusura in cassa di un conto Passepartout già chiuso
   *  (scontrino dall'RT + tavolo liberato sul gestionale). */
  async passepartoutClose(billId: number): Promise<{ id_comanda: number; esito: unknown }> {
    return apiRequest(`${API_URL}/bills/${billId}/passepartout-close`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  async getFiscalSettings(): Promise<FiscalSettings> {
    return apiRequest<FiscalSettings>(`${API_URL}/settings/fiscal`, { headers: getHeaders() });
  }

  async updateFiscalSettings(patch: { provider?: FiscalProviderSetting; vat_number?: string }): Promise<FiscalSettings> {
    return apiRequest<FiscalSettings>(`${API_URL}/settings/fiscal`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(patch),
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

export interface FiscalSettings {
  provider: FiscalProviderSetting;
  vat_number: string;
  providers: readonly FiscalProviderSetting[];
  openapi_token_configured: boolean;
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
  /** Acconto TOTALE versato (importo pieno), a prescindere da quanto assorbito dal conto. */
  deposit_paid_cents?: number;
  /** Da rimborsare al cliente quando l'acconto supera il totale del conto. */
  refund_due_cents?: number;
  /** Contanti già registrati sul conto (proiezione del libro cassa). */
  cash_settled_cents?: number;
  /** Incassi staff dal libro cassa (contanti, POS, buoni, …). Già in paid_cents. */
  staff_paid_cents?: number;
  /** Mancia registrata alla chiusura. */
  tip_cents?: number;
  /** Quando il conto è stato chiuso (solo per i conti chiusi). */
  closed_at?: string | null;
  residual_cents: number;
  paid_splits: number;
  /** Ultimo documento fiscale del conto (badge scontrino nella vista Chiusi). */
  fiscal_status?: 'PENDING' | 'CONFIRMED' | 'FAILED' | 'VOIDED' | null;
  fiscal_doc_id?: number | null;
  fiscal_error?: string | null;
  /** 'openapi' = documento commerciale cloud; 'passepartout' = scontrino dall'RT di cassa. */
  fiscal_provider?: string | null;
  /** Numero del documento (provider_ref: numero scontrino RT o id Openapi). */
  fiscal_ref?: string | null;
  /** "pp:comanda:<id>" quando il conto nasce da una comanda Passepartout. */
  external_ref?: string | null;
  /** Movimenti vivi del libro cassa: come è stato pagato il conto. */
  payments?: BillPaymentRow[];
  /** Comande ancora aperte su questo conto: il tavolo sta ancora ordinando. */
  open_orders: number;
  service_date: string;
  shift: 'LUNCH' | 'DINNER';
  is_current_service: boolean;
}

/** Un movimento del libro cassa sul conto: incasso staff o specchio di una
 *  quota pagata online (online: true). */
export interface BillPaymentRow {
  id: number;
  method: string;
  amount_cents: number;
  recorded_at: string;
  online: boolean;
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
export const getOpenBills = async (
  service?: { service_date?: string; shift?: 'LUNCH' | 'DINNER' },
  opts?: { status?: 'open' | 'closed' },
): Promise<{
  service: { service_date: string; shift: 'LUNCH' | 'DINNER' };
  bills: OpenBillRow[];
  stale_orders: StaleOrderRow[];
}> => {
  const qs = new URLSearchParams();
  if (service?.service_date) qs.set('date', service.service_date);
  if (service?.shift) qs.set('shift', service.shift);
  if (opts?.status === 'closed') qs.set('status', 'closed');
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return apiRequest(`${API_URL}/bills/open${suffix}`, { headers: getHeaders() });
};

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
