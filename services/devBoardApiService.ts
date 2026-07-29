import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

export type DevBoardColumnKey = 'in_progress' | 'review' | 'nice_to_have' | 'paused' | 'done';

/** Chiavi della palette etichette — la lista autorevole è LABELS in
 *  DevelopmentPage.tsx, il server sanitizza sulla stessa lista. */
export type DevBoardLabelKey = 'comande' | 'prenotazioni' | 'pagamenti' | 'stampa' | 'bug' | 'infra';

export interface DevBoardCard {
  id: number;
  title: string;
  description: string | null;
  column_key: DevBoardColumnKey;
  position: number;
  labels: DevBoardLabelKey[];
  created_at: string;
  updated_at: string;
}

// Helper function to get headers with socket ID and auth token
const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  // Add socket ID to prevent duplicate broadcasts
  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }

  // Add authorization header
  const token = authApiService.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
};

// Fetch with automatic token refresh on 401
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
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  if (expectJson) {
    return response.json();
  }

  return undefined as T;
};

export const getDevBoardCards = (): Promise<DevBoardCard[]> =>
  apiRequest(`${API_URL}/dev-board/cards`, { headers: getHeaders(false), cache: 'no-store' });

export const createDevBoardCard = (input: {
  title: string;
  description?: string | null;
  column_key: DevBoardColumnKey;
  labels?: DevBoardLabelKey[];
}): Promise<DevBoardCard> =>
  apiRequest(`${API_URL}/dev-board/cards`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });

export const updateDevBoardCard = (id: number, input: {
  title: string;
  description?: string | null;
  column_key?: DevBoardColumnKey;
  labels?: DevBoardLabelKey[];
}): Promise<DevBoardCard> =>
  apiRequest(`${API_URL}/dev-board/cards/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });

/** Drop of a drag&drop: move `id` into `column_key`; `ordered_ids` is the full
 *  new order of the destination column (moved card included). */
export const moveDevBoardCard = (id: number, column_key: DevBoardColumnKey, ordered_ids: number[]): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/dev-board/cards/${id}/move`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ column_key, ordered_ids }),
  });

export const deleteDevBoardCard = (id: number): Promise<void> =>
  apiRequest(`${API_URL}/dev-board/cards/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
