import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

/* ── Prenotazioni in cassa Passepartout ───────────────────────────────────
   Client della scheda Impostazioni → Prenotazioni: interruttore dell'invio,
   abbinamento dei tavoli del CRM a quelli della cassa, «Sincronizza ora». */

export interface PpPrenotazioniStato {
  enabled: boolean;
  agente: { collegato: boolean; aggiornato: boolean };
  tavoli: { totali: number; abbinati: number; da_confermare: number };
  invio: { in_cassa: number; arrivi_oggi: number; ultimo_invio: string | null };
  errori: Array<{ reservation_id: number | null; customer_name: string | null; reservation_time: string | null; last_error: string; attempts: number }>;
}

export interface PpSala { sala: string; tavoli: Array<{ nome: string; coperti: number | null }> }

export interface PpTavolo {
  table_id: number;
  table_name: string;
  room_name: string | null;
  pp_sala: string | null;
  pp_tavolo: string | null;
  origine: 'auto' | 'manuale' | null;
  confermato: boolean;
}

export interface PpTavoli { pianta: PpSala[] | null; pianta_at: string | null; tavoli: PpTavolo[] }

export interface PpRiepilogoGiro {
  saltato?: 'spento' | 'non_venduto' | 'agente' | 'in_corso';
  scritte: number;
  annullate: number;
  prese_in_cassa: number;
  arrivi: number;
  errori: number;
}

const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
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

export const getPpPrenotazioni = (): Promise<PpPrenotazioniStato> =>
  apiRequest(`${API_URL}/passepartout/prenotazioni`, { headers: getHeaders(false), cache: 'no-store' });

export const setPpPrenotazioniEnabled = (enabled: boolean): Promise<{ enabled: boolean }> =>
  apiRequest(`${API_URL}/passepartout/prenotazioni`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ enabled }),
  });

export const sincronizzaPpPrenotazioni = (): Promise<PpRiepilogoGiro> =>
  apiRequest(`${API_URL}/passepartout/prenotazioni/sincronizza`, { method: 'POST', headers: getHeaders() });

export const getPpTavoli = (): Promise<PpTavoli> =>
  apiRequest(`${API_URL}/passepartout/tavoli`, { headers: getHeaders(false), cache: 'no-store' });

export const abbinaPpTavoli = (): Promise<PpTavoli> =>
  apiRequest(`${API_URL}/passepartout/tavoli/abbina`, { method: 'POST', headers: getHeaders() });

/** sala + tavolo della cassa; entrambi vuoti = il tavolo non va in cassa. */
export const setPpTavolo = (tableId: number, ppSala: string | null, ppTavolo: string | null): Promise<Partial<PpTavolo>> =>
  apiRequest(`${API_URL}/passepartout/tavoli/${tableId}`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify({ pp_sala: ppSala, pp_tavolo: ppTavolo }),
  });

/* ── Sezione Passepartout: collegamento e chiusura in cassa ─────────────── */

export interface PpAgente {
  connected: boolean;
  connected_at: string | null;
  hostname: string | null;
  versione_gestionale: string | null;
  capabilities: string[];
}

export interface PpConfig {
  /** Salvati nella sezione (null = non impostato). */
  tipo_pagamento_esterno: string | null;
  tipo_documento: 'Scontrino' | 'Proforma' | null;
  /** Quelli che la chiusura usa davvero (il ristorante 1 eredita l'env). */
  effettivo: { tipo_pagamento: string | null; tipo_documento: string };
  agente: PpAgente;
}

export const getPpConfig = (): Promise<PpConfig> =>
  apiRequest(`${API_URL}/passepartout/config`, { headers: getHeaders(false), cache: 'no-store' });

export const setPpConfig = (input: { tipo_pagamento_esterno?: string | null; tipo_documento?: 'Scontrino' | 'Proforma' | null }): Promise<{ effettivo: PpConfig['effettivo'] }> =>
  apiRequest(`${API_URL}/passepartout/config`, {
    method: 'PUT', headers: getHeaders(), body: JSON.stringify(input),
  });

export const getPpTipiPagamento = (): Promise<Array<{ codice: string; categoria: string | null }>> =>
  apiRequest(`${API_URL}/passepartout/tipi-pagamento`, { headers: getHeaders(false), cache: 'no-store' });
