import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// ---- Tipi risposta (allineati agli endpoint /reports/* in server.ts) ----
// Denaro sempre in centesimi interi, come sul backend.

export interface ReportRange {
  from: string;
  to: string;
}

export interface ReservationsTotals {
  prenotazioni: number;
  coperti: number;
  bambini: number;
  cancellate: number;
  no_show: number;
}

export interface ReservationsReport {
  from: string;
  to: string;
  precedente_range: ReportRange;
  totali: ReservationsTotals;
  precedente: ReservationsTotals;
  per_giorno: { giorno: string; prenotazioni: number; coperti: number }[];
  per_dow: { giorno: number; prenotazioni: number; coperti: number }[];
  per_ora: { ora: number; prenotazioni: number; coperti: number }[];
  per_canale: { canale: string; prenotazioni: number; coperti: number }[];
  per_sala: { sala: string; prenotazioni: number; coperti: number }[];
}

export interface RevenueTotals {
  incassato_cents: number;
  movimenti: number;
  conti: number;
  totale_cents: number;
  scontrino_medio_cents: number;
  coperto_medio_cents: number;
  coperti: number;
  mance_cents: number;
}

export interface RevenueReport {
  from: string;
  to: string;
  precedente_range: ReportRange;
  totali: RevenueTotals;
  precedente: RevenueTotals;
  per_giorno: { giorno: string; turno: 'LUNCH' | 'DINNER'; incassato_cents: number }[];
  per_metodo: { metodo: string; amount_cents: number; movimenti: number; non_cash: boolean }[];
  casse: { sessioni: number; chiuse: number; differenza_totale_cents: number };
  differenze: { giorno: string; turno: string; differenza_cents: number; note: string | null }[];
}

export interface DishesReport {
  enabled: boolean;
  from: string;
  to: string;
  top_piatti?: { piatto: string; qty: number; ricavo_cents: number }[];
  partite?: { station_id: number | null; station_name: string | null; righe: number; media_min: string | null; mediana_min: string | null; stornate: number }[];
  scarti?: { motivo: string | null; righe: number; valore_cents: number }[];
}

export interface VoiceTotals {
  chiamate: number;
  secondi: number;
  con_prenotazione: number;
  phantom: number;
  gruppi_grandi: number;
}

export interface CommunicationsReport {
  from: string;
  to: string;
  precedente_range: ReportRange;
  voce: VoiceTotals;
  voce_precedente: VoiceTotals;
  voce_per_giorno: { giorno: string; chiamate: number; secondi: number }[];
  messaggi: { canale: string; inviati: number; consegnati: number; falliti: number }[];
}

// ---- Plumbing (stesso schema di monitoringApiService: auth + refresh su 401) ----

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

const apiRequest = async <T>(url: string): Promise<T> => {
  const response = await fetchWithAuth(url, { headers: getHeaders(), cache: 'no-store' });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

const qs = (range: ReportRange) => `?from=${range.from}&to=${range.to}`;

export const getReservationsReport = (range: ReportRange): Promise<ReservationsReport> =>
  apiRequest(`${API_URL}/reports/reservations${qs(range)}`);

export const getRevenueReport = (range: ReportRange): Promise<RevenueReport> =>
  apiRequest(`${API_URL}/reports/revenue${qs(range)}`);

export const getDishesReport = (range: ReportRange): Promise<DishesReport> =>
  apiRequest(`${API_URL}/reports/dishes${qs(range)}`);

export const getCommunicationsReport = (range: ReportRange): Promise<CommunicationsReport> =>
  apiRequest(`${API_URL}/reports/communications${qs(range)}`);
