// Impostazioni › WhatsApp: stato del numero, template, consumi del mese.
// Le rotte stanno in services/whatsapp/routes.ts (backend).

import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface WhatsAppStatus {
  connected: boolean;
  provider: 'twilio' | 'meta' | null;
  source: 'env' | null;
  phone: string | null;
  /** Il locale scrive con le credenziali Twilio in env (il Frantoio, o un
   *  demo ammesso esplicitamente). */
  shared_env_sender: boolean;
  sms_ready: boolean;
  webhooks: { inbound: string; status: string } | null;
}

export type TemplateApproval = 'approved' | 'pending' | 'rejected' | 'unsubmitted' | 'unknown';

export interface WhatsAppTemplateRow {
  key: string;
  label: string;
  group: 'prenotazioni' | 'caparre' | 'conto' | 'recensioni' | 'banchetti';
  category: 'UTILITY' | 'MARKETING';
  languages: Array<{
    language: 'it' | 'en';
    configured: boolean;
    approval: TemplateApproval | null;
    rejectionReason: string | null;
  }>;
}

export interface WhatsAppUsage {
  month: string;
  whatsapp: {
    inbound: number;
    outboundStaff: number;
    outboundAutomatic: number;
    failed: number;
    byKind: Record<string, number>;
  };
  sms: { outbound: number; failed: number };
  ai: { runs: number; costUsd: number; costEur: number; unpriced: number };
}

const getHeaders = (): HeadersInit => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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

export const getWhatsAppStatus = (): Promise<WhatsAppStatus> =>
  apiRequest(`${API_URL}/whatsapp/status`, { headers: getHeaders() });

export const getWhatsAppTemplates = (): Promise<{ templates: WhatsAppTemplateRow[] }> =>
  apiRequest(`${API_URL}/whatsapp/templates`, { headers: getHeaders() });

export const getWhatsAppUsage = (): Promise<WhatsAppUsage> =>
  apiRequest(`${API_URL}/whatsapp/usage`, { headers: getHeaders() });
