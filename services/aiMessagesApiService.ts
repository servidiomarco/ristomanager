// Regole della casa per le risposte suggerite + richiesta del suggerimento.
// Il modello gira sul backend: da qui passano solo testi già pronti, mai la
// chiave dell'API.

import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface KnowledgeEntry {
  id: number;
  title: string;
  content: string;
  is_active: boolean;
  sort_order: number;
  updated_at: string;
}

export interface SuggestReplyResult {
  /** null quando l'AI non sa rispondere: si scrive a mano, come oggi. */
  suggestion: string | null;
  reason: string | null;
  knowledge_count: number;
  reservation_linked: boolean;
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

export const listKnowledge = (): Promise<{ entries: KnowledgeEntry[] }> =>
  apiRequest(`${API_URL}/settings/ai-knowledge`, { headers: getHeaders() });

export const createKnowledge = (body: { title: string; content: string }): Promise<KnowledgeEntry> =>
  apiRequest(`${API_URL}/settings/ai-knowledge`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
  });

export const updateKnowledge = (
  id: number,
  body: Partial<Pick<KnowledgeEntry, 'title' | 'content' | 'is_active'>>
): Promise<KnowledgeEntry> =>
  apiRequest(`${API_URL}/settings/ai-knowledge/${id}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(body),
  });

export const deleteKnowledge = (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/settings/ai-knowledge/${id}`, {
    method: 'DELETE', headers: getHeaders(),
  });

export const suggestReply = (phoneDigits: string): Promise<SuggestReplyResult> =>
  apiRequest(`${API_URL}/messages/suggest-reply`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ phone_digits: phoneDigits }),
  });
