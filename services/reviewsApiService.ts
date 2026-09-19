import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

/* ── Recensioni (piano recensioni) ────────────────────────────────────────
   Client della sezione Impostazioni → Recensioni e — dalle tappe
   successive — della pagina Recensioni. */

export type ReviewRequestTiming = 'immediate' | 'delay' | 'next_morning';
export type ReviewRequestAudience = 'consent' | 'all';
export type ReviewReplyAutomation = 'off' | 'draft' | 'auto_positive' | 'auto_all';

export interface ReviewSettings {
  /** Richiesta di recensione post-visita accesa (flag operativo). */
  review_requests_enabled: boolean;
  /** Quando parte la richiesta rispetto alla fine della visita. */
  timing: ReviewRequestTiming;
  /** Ore di attesa quando timing = 'delay'. */
  delay_hours: number;
  /** A chi si manda: solo consenso marketing o tutti i contatti. */
  audience: ReviewRequestAudience;
  /** Risposte alle recensioni (operativo dalla Fase B, col profilo Google collegato). */
  reply_automation: ReviewReplyAutomation;
  /** Place ID del profilo Google: da solo basta per il link «scrivi una recensione». */
  google_place_id: string | null;
}

const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};
  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }
  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }
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

const apiRequest = async <T>(
  url: string,
  options: RequestInit = {},
  expectJson = true
): Promise<T> => {
  const response = await fetchWithAuth(url, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  if (expectJson) {
    return response.json();
  }
  return undefined as T;
};

export const getReviewSettings = (): Promise<ReviewSettings> =>
  apiRequest(`${API_URL}/review-settings`, { headers: getHeaders(false), cache: 'no-store' });

export const updateReviewSettings = (input: Partial<ReviewSettings>): Promise<ReviewSettings> =>
  apiRequest(`${API_URL}/review-settings`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });

/** Esito della richiesta post-visita su una prenotazione già valutata.
 *  'sending' = presa in carico e mai confermata (il processo è caduto fra
 *  invio ed esito): non verrà ritentata, per non rischiare un doppione. */
export type ReviewRequestStatus = 'sending' | 'sent' | 'skipped_consent' | 'skipped_no_contact' | 'skipped_recent' | 'failed';

export interface ReviewRequestRow {
  id: number;
  customer_name: string;
  phone: string | null;
  email: string | null;
  reservation_time: string;
  guests: number;
  status: ReviewRequestStatus;
  channel: string | null;
  sent_at: string | null;
  error: string | null;
}

export const getReviewRequests = (offset = 0, limit = 50): Promise<{ total: number; requests: ReviewRequestRow[] }> =>
  apiRequest(`${API_URL}/reviews/requests?offset=${offset}&limit=${limit}`, {
    headers: getHeaders(false),
    cache: 'no-store',
  });
