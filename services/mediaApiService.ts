// Libreria media: file caricati una volta e riusati molte volte.
//
// Distinta dagli allegati di messagesApiService, che sono usa-e-getta: lì il
// file esiste per un invio e muore col messaggio. Qui è un catalogo — il menù
// di Ferragosto lo carichi una volta e lo mandi a chiunque lo chieda.

import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

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

export interface MediaFile {
  id: number;
  title: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

/** Ciò che serve per allegare a un messaggio: identica forma di un caricamento al volo. */
export interface AttachableMedia {
  id: number;
  token: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
}

export const listMedia = (): Promise<{ files: MediaFile[] }> =>
  apiRequest(`${API_URL}/media`, { headers: getHeaders() });

/**
 * Carica un file in libreria. Il browser legge i byte e li manda in base64:
 * stessa via degli allegati, così non serve gestire multipart da nessuna parte.
 */
export const uploadMedia = async (file: File, title: string): Promise<MediaFile> => {
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Lettura del file non riuscita'));
    // Il risultato è "data:<tipo>;base64,<dati>": teniamo solo i dati.
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
  return apiRequest(`${API_URL}/media`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      title: title.trim() || file.name,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      data,
    }),
  });
};

export const deleteMedia = (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/media/${id}`, { method: 'DELETE', headers: getHeaders() });

/** Prepara una copia allegabile: il file in libreria resta dov'è. */
export const attachFromLibrary = (id: number): Promise<AttachableMedia> =>
  apiRequest(`${API_URL}/media/${id}/attach`, { method: 'POST', headers: getHeaders() });
