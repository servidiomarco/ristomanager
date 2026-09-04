import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { BillPaymentMethod, CashClosureReport, CustomerBilling, FiscalDocument, FiscalProviderSetting, TableBill, TableBillWithSplits } from '../types';
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
  /** Conti nativi: 'Proforma' = chiusura deliberata senza documento fiscale
   *  (registrata come segnaposto PROFORMA, sostituibile da scontrino o
   *  fattura emessi dopo). Assente o 'Scontrino' → emissione automatica. */
  documento?: 'Scontrino' | 'Proforma' | 'Cassa';
  /** Numero dello scontrino battuto sull'RT esterno (con documento 'Cassa'). */
  rt_doc_number?: string;
  /** Solo conti Passepartout: documento della chiusura in cassa.
   *  'Proforma' = niente scontrino (la routine della cassa); assente = Scontrino. */
  passepartout_documento?: 'Scontrino' | 'Proforma';
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

  /** Riapre un conto chiuso per errore: i movimenti restano, torna lo stato.
   *  409 se il conto porta un documento fiscale confermato — quello va
   *  annullato prima, o si incasserebbe due volte contro un solo scontrino. */
  async reopenBill(billId: number): Promise<TableBill> {
    return apiRequest<TableBill>(`${API_URL}/bills/${billId}/reopen`, {
      method: 'POST',
      headers: getHeaders(),
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

  /** Segna a posteriori un conto chiuso come proforma: nessuna emissione,
   *  solo il segnaposto PROFORMA (sostituibile da scontrino o fattura). */
  async markProforma(billId: number): Promise<{ doc: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ documento: 'Proforma' }),
    });
  }

  /** Registra (anche a posteriori) lo scontrino battuto sull'RT esterno:
   *  documento vero a registro, col numero del registratore se riportato. */
  async markCassa(billId: number, rtDocNumber?: string): Promise<{ doc: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ documento: 'Cassa', ...(rtDocNumber ? { rt_doc_number: rtDocNumber } : {}) }),
    });
  }

  /** Annulla il documento presso il provider (il conto non si tocca). */
  async voidFiscalDoc(billId: number, docId: number): Promise<{ doc: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs/${docId}/void`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  /** Storna una fattura con nota di credito TD04 (storno totale): la
   *  fattura passa VOIDED, la nota resta a registro per sempre, e il conto
   *  torna libero di riemettere scontrino o fattura corretta. */
  async issueCreditNote(billId: number, docId: number): Promise<{ doc: FiscalDocument; voided_invoice: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/fiscal-docs/${docId}/credit-note`, {
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

  /** Emette la fattura elettronica (SDI) sul conto chiuso o su una quota
   *  pagata. Il cessionario arriva dalla rubrica (customer_id) e/o inline
   *  (buyer): l'inline vince campo per campo. */
  async issueInvoice(billId: number, payload: {
    customer_id?: number;
    split_id?: number;
    buyer?: CustomerBilling;
  }): Promise<{ doc: FiscalDocument }> {
    return apiRequest(`${API_URL}/bills/${billId}/invoices`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async getFiscalSettings(): Promise<FiscalSettings> {
    return apiRequest<FiscalSettings>(`${API_URL}/settings/fiscal`, { headers: getHeaders() });
  }

  async updateFiscalSettings(patch: {
    provider?: FiscalProviderSetting;
    vat_number?: string;
    seller?: { business_name?: string; regime?: string; address?: { street?: string; zip?: string; city?: string; province?: string } };
    vat_map?: Partial<FiscalVatMap>;
  }): Promise<FiscalSettings> {
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

/** Mappatura IVA del tenant: default piatti e voci di sistema. */
export interface FiscalVatMap {
  dish_default: number;
  cover: number;
  service: number;
  fallback: number;
}

export interface FiscalSettings {
  provider: FiscalProviderSetting;
  vat_number: string;
  /** Cedente della fattura elettronica (denominazione, regime, sede). */
  seller: { business_name?: string; regime?: string; address?: { street?: string; zip?: string; city?: string; province?: string } };
  vat_map: FiscalVatMap;
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
  /** RECEIPT = scontrino; PROFORMA = chiusura "paga dopo"; CREDIT_NOTE = fattura stornata. */
  fiscal_doc_type?: 'RECEIPT' | 'PROFORMA' | 'INVOICE' | 'CREDIT_NOTE' | null;
  /** Numero del documento: fattura nostra (numerazione annuale) o numero
   *  del documento commerciale Openapi ("0005-0005"). */
  fiscal_doc_number?: string | null;
  /** Capability dello scontrino digitale: /scontrino/<token> lo mostra
   *  all'ospite senza login. Presente su ogni documento nativo. */
  fiscal_public_token?: string | null;
  /** Per una nota di credito: l'id della fattura stornata (serve al retry). */
  fiscal_related_doc_id?: number | null;
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

/** La comanda dietro un conto, con gli id delle righe: serve alla
 *  correzione in cassa (storno di una portata contestata). */
export const getBillOrder = async (billId: number): Promise<any> =>
  apiRequest(`${API_URL}/bills/${billId}/order`, { headers: getHeaders() });

/** Accoda la stampa del preconto sulla termica in sala. L'origin serve al
 *  server per comporre l'URL del QR: solo il client sa da che host è servita
 *  la SPA (IP in LAN, dominio in produzione). */
export const printBill = async (
  billId: number,
  kind: 'PRECONTO' | 'QR' | 'SCONTRINO' = 'PRECONTO',
): Promise<{ id: number; status: string }> =>
  apiRequest<{ id: number; status: string }>(`${API_URL}/print-jobs`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ bill_id: billId, origin: window.location.origin, kind }),
  });

// --- Reportistica fiscale (vista Fiscalità) ---------------------------------

export type FiscalRegistryDocType = 'RECEIPT' | 'INVOICE' | 'CREDIT_NOTE' | 'PROFORMA';
export type FiscalRegistryStatus = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'VOIDED';

export interface FiscalRegistryRow {
  id: number;
  doc_type: FiscalRegistryDocType;
  provider: string;
  status: FiscalRegistryStatus;
  doc_number: string | null;
  provider_ref: string | null;
  total_cents: number;
  created_at: string;
  confirmed_at: string | null;
  voided_at: string | null;
  public_token: string | null;
  related_doc_id: number | null;
  table_bill_id: number | null;
  day: string;
  table_name: string | null;
  customer_name: string | null;
  /** Fattura stornata: numero della nota di credito che la punta. */
  credit_note_number: string | null;
}

export interface FiscalRegistryTotals {
  documented_total_cents: number;
  receipts: { count: number; total_cents: number };
  invoices: { count: number; total_cents: number };
  credit_notes: { count: number; total_cents: number };
  proforma: { count: number; total_cents: number };
  voided_count: number;
  failed_count: number;
  pending_count: number;
}

export interface FiscalRegistryResponse {
  from: string;
  to: string;
  totals: FiscalRegistryTotals;
  counts: { all: number; receipt: number; invoice: number; credit_note: number; proforma: number; voided: number; failed: number };
  documents: FiscalRegistryRow[];
  total_count: number;
}

export interface FiscalVatSummaryRow {
  day: string;
  vat_rate_code: string;
  is_nature: boolean;
  gross_cents: number;
  net_cents: number;
  tax_cents: number;
  docs: number;
}

export interface FiscalVatSummaryResponse {
  from: string;
  to: string;
  rows: FiscalVatSummaryRow[];
  discounts: { day: string; discount_cents: number }[];
  excluded: { passepartout_docs: number; passepartout_total_cents: number };
}

export interface FiscalDocumentDetail {
  document: {
    id: number; doc_type: FiscalRegistryDocType; provider: string; status: FiscalRegistryStatus;
    doc_number: string | null; provider_ref: string | null; total_cents: number;
    fiscal_id: string | null; error: string | null;
    created_at: string; confirmed_at: string | null; voided_at: string | null;
    public_token: string | null; table_bill_id: number | null;
    table_name: string | null; customer_name: string | null; bill_closed_at: string | null;
    related: { id: number; doc_type: FiscalRegistryDocType; doc_number: string | null } | null;
    credit_note_number: string | null;
  };
  items: { description: string; quantity: number; unit_price_cents: number; vat_rate_code: string }[];
  payments: { cash_cents: number; electronic_cents: number; ticket_cents: number; uncollected_cents: number; discount_cents: number };
}

export interface FiscalRegistryQuery {
  from: string;
  to: string;
  doc_type?: FiscalRegistryDocType;
  status?: FiscalRegistryStatus;
  limit?: number;
  offset?: number;
}

const fiscalRegistryQs = (q: FiscalRegistryQuery): string => {
  const qs = new URLSearchParams({ from: q.from, to: q.to });
  if (q.doc_type) qs.set('doc_type', q.doc_type);
  if (q.status) qs.set('status', q.status);
  if (q.limit != null) qs.set('limit', String(q.limit));
  if (q.offset != null) qs.set('offset', String(q.offset));
  return qs.toString();
};

export const getFiscalRegistry = async (q: FiscalRegistryQuery): Promise<FiscalRegistryResponse> =>
  apiRequest(`${API_URL}/reports/fiscal-registry?${fiscalRegistryQs(q)}`, { headers: getHeaders() });

export const getFiscalVatSummary = async (from: string, to: string): Promise<FiscalVatSummaryResponse> =>
  apiRequest(`${API_URL}/reports/fiscal-vat-summary?from=${from}&to=${to}`, { headers: getHeaders() });

export const getFiscalDocumentDetail = async (id: number): Promise<FiscalDocumentDetail> =>
  apiRequest(`${API_URL}/reports/fiscal-documents/${id}`, { headers: getHeaders() });

/** Scarica un CSV di report autenticato. Il JWT vive in localStorage, non in
 *  cookie: un <a href> nudo prenderebbe 401 — serve il fetch con header e il
 *  click su un object URL (stesso pattern dell'export marketing). */
export const downloadReportCsv = async (path: string, filename: string): Promise<void> => {
  const res = await fetch(`${API_URL}${path}`, { headers: getHeaders() });
  if (!res.ok) throw buildApiError(res.status, await res.json().catch(() => null));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};
