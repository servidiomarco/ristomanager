import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// ---- Tipi risposta (allineati agli endpoint /ai-usage/* in server.ts) ----

export interface GeminiUsageTotals {
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
  /** Dollari, calcolati dal listino sul backend. */
  cost_usd: number;
  /** Generazioni con un modello senza prezzo in tabella: escluse dal costo. */
  unpriced_calls: number;
  last_at: string | null;
}

export interface GeminiUsageDay {
  day: string;
  prompt_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
  cost_usd: number;
}

export interface GeminiUsageFeature {
  feature: string;
  model: string;
  total_tokens: number;
  calls: number;
  cost_usd: number;
  unpriced_calls: number;
}

export interface GeminiUsage {
  days: number;
  totals: GeminiUsageTotals;
  daily: GeminiUsageDay[];
  byFeature: GeminiUsageFeature[];
  /** Tasso usato per mostrare gli euro; la fattura resta in dollari. */
  usdEur: number;
}

export interface ElevenLabsSubscription {
  tier: string | null;
  status: string | null;
  character_count: number | null;
  character_limit: number | null;
  next_reset_unix: number | null;
  currency: string | null;
}

export interface ElevenLabsCallStats {
  calls: number;
  seconds: number;
  last_at?: string | null;
}

export interface ElevenLabsCallDay {
  day: string;
  calls: number;
  seconds: number;
}

export interface ElevenLabsUsage {
  days: number;
  subscription: ElevenLabsSubscription | null;
  subscriptionError: string | null;
  calls: {
    window: ElevenLabsCallStats;
    daily: ElevenLabsCallDay[];
    allTime: ElevenLabsCallStats;
  };
}

// ---- Plumbing (stesso schema di devBoardApiService: auth + refresh su 401) ----

const getHeaders = (): HeadersInit => {
  const headers: HeadersInit = {};
  const token = authApiService.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
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

export const getGeminiUsage = (days = 30): Promise<GeminiUsage> =>
  apiRequest(`${API_URL}/ai-usage/gemini?days=${days}`, { headers: getHeaders(), cache: 'no-store' });

export const getElevenLabsUsage = (days = 30): Promise<ElevenLabsUsage> =>
  apiRequest(`${API_URL}/ai-usage/elevenlabs?days=${days}`, { headers: getHeaders(), cache: 'no-store' });
