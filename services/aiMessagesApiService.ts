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

export interface AgentProposal {
  id: number;
  tool: 'create_reservation' | 'modify_reservation' | 'cancel_reservation' | string;
  args: Record<string, any>;
  /** Riga leggibile per lo staff: "Modifica prenotazione del …: persone 5 → 3". */
  summary: string;
  suggested_reply: string | null;
  status: string;
  expires_at: string;
  reservation_id: number | null;
}

export interface AgentRunResult {
  reply: string | null;
  /** Azione che l'agente eseguirebbe: nulla parte senza una conferma umana. */
  proposal: AgentProposal | null;
  checks: Array<{ tool: string; args: Record<string, any>; result: any }>;
  reason: string | null;
  knowledge_count: number;
}

/** Fa ragionare l'agente sulla conversazione. Non invia e non scrive nulla. */
export const runAgent = (phoneDigits: string): Promise<AgentRunResult> =>
  apiRequest(`${API_URL}/messages/agent/run`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ phone_digits: phoneDigits }),
  });

/** Esegue davvero la proposta: è l'unico punto in cui l'agente scrive. */
export const confirmProposal = (id: number): Promise<{ ok: boolean; tool: string; result: any }> =>
  apiRequest(`${API_URL}/messages/agent/proposals/${id}/confirm`, { method: 'POST', headers: getHeaders() });

export const discardProposal = (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/messages/agent/proposals/${id}/discard`, { method: 'POST', headers: getHeaders() });

export const suggestReply = (phoneDigits: string): Promise<SuggestReplyResult> =>
  apiRequest(`${API_URL}/messages/suggest-reply`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ phone_digits: phoneDigits }),
  });
