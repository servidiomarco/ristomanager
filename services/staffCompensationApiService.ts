import {
  StaffCompensationProfile, StaffCompensationPayment, StaffCompensationSummary
} from '../types';
import { authApiService } from './authApiService';
import { buildApiError, ApiError } from './apiError';

// Client dei Compensi del personale. Ogni chiamata (tranne lo sblocco)
// esige il token step-up nell'header X-Step-Up-Token: lo tiene il
// COMPONENTE nel proprio stato, mai questo service né localStorage —
// smontare la sezione butta via lo sblocco per costruzione.

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// Il server risponde 401 { error: 'step_up_required' } quando lo sblocco
// manca o è scaduto. Va riconosciuto dal BODY: fetchWithAuth su un 401
// prova prima il refresh dell'access token, quindi lo status da solo non
// distingue una sessione scaduta da uno sblocco scaduto.
export const isStepUpRequired = (err: unknown): boolean =>
  (err as ApiError)?.data?.error === 'step_up_required';

const getHeaders = (stepUpToken: string, includeContentType = true): HeadersInit => {
  const headers: Record<string, string> = { 'X-Step-Up-Token': stepUpToken };
  if (includeContentType) headers['Content-Type'] = 'application/json';
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

const fetchWithAuth = async (
  url: string,
  options: RequestInit = {},
  retried = false
): Promise<Response> => {
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

export interface StepUpGrant {
  stepUpToken: string;
  expiresIn: number; // secondi
}

export interface CreateCompensationPaymentInput {
  staffId: string;
  periodMonth: string; // YYYY-MM
  kind: 'ACCONTO' | 'SALDO';
  amountCents: number;
  paidOn?: string;
  method?: 'CONTANTI' | 'BONIFICO' | 'ALTRO';
  note?: string;
}

export interface UpdateCompensationProfileInput {
  monthlyCents?: number | null;
  singleServiceCents?: number | null;
  doubleServiceCents?: number | null;
  notes?: string;
}

class StaffCompensationApiService {
  // Sblocco: password dell'account → token 15 min. Errori tipici sul body:
  // wrong_password (401), rate_limited (429).
  async stepUp(password: string): Promise<StepUpGrant> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = authApiService.getAccessToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return apiRequest<StepUpGrant>(`${API_URL}/auth/step-up`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password, scope: 'staff_compensation' }),
    });
  }

  async getProfiles(stepUpToken: string): Promise<StaffCompensationProfile[]> {
    return apiRequest<StaffCompensationProfile[]>(`${API_URL}/staff/compensation/profiles`, {
      headers: getHeaders(stepUpToken, false)
    });
  }

  async updateProfile(stepUpToken: string, staffId: string, updates: UpdateCompensationProfileInput): Promise<StaffCompensationProfile> {
    return apiRequest<StaffCompensationProfile>(`${API_URL}/staff/compensation/profiles/${staffId}`, {
      method: 'PUT',
      headers: getHeaders(stepUpToken),
      body: JSON.stringify(updates),
    });
  }

  async getSummary(stepUpToken: string, month: string): Promise<StaffCompensationSummary> {
    return apiRequest<StaffCompensationSummary>(`${API_URL}/staff/compensation/summary?month=${month}`, {
      headers: getHeaders(stepUpToken, false)
    });
  }

  async getPayments(stepUpToken: string, month: string, staffId?: string): Promise<StaffCompensationPayment[]> {
    const params = new URLSearchParams({ month });
    if (staffId) params.append('staffId', staffId);
    return apiRequest<StaffCompensationPayment[]>(`${API_URL}/staff/compensation/payments?${params.toString()}`, {
      headers: getHeaders(stepUpToken, false)
    });
  }

  async createPayment(stepUpToken: string, payment: CreateCompensationPaymentInput): Promise<StaffCompensationPayment> {
    return apiRequest<StaffCompensationPayment>(`${API_URL}/staff/compensation/payments`, {
      method: 'POST',
      headers: getHeaders(stepUpToken),
      body: JSON.stringify(payment),
    });
  }

  async deletePayment(stepUpToken: string, id: string): Promise<void> {
    await apiRequest<{ ok: boolean }>(`${API_URL}/staff/compensation/payments/${id}`, {
      method: 'DELETE',
      headers: getHeaders(stepUpToken, false),
    });
  }

  async setOverride(stepUpToken: string, staffId: string, periodMonth: string, overrideCents: number, note?: string): Promise<void> {
    await apiRequest<{ ok: boolean }>(`${API_URL}/staff/compensation/overrides/${staffId}`, {
      method: 'PUT',
      headers: getHeaders(stepUpToken),
      body: JSON.stringify({ periodMonth, overrideCents, note }),
    });
  }

  async deleteOverride(stepUpToken: string, staffId: string, month: string): Promise<void> {
    await apiRequest<{ ok: boolean }>(`${API_URL}/staff/compensation/overrides/${staffId}?month=${month}`, {
      method: 'DELETE',
      headers: getHeaders(stepUpToken, false),
    });
  }
}

export const staffCompensationApiService = new StaffCompensationApiService();
