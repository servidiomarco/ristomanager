import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// ----- Types ----------------------------------------------------------------

export type HaccpOilAction = 'SOSTITUITO' | 'FILTRATO' | 'UTILIZZABILE';

export const HACCP_OIL_ACTIONS: HaccpOilAction[] = ['SOSTITUITO', 'FILTRATO', 'UTILIZZABILE'];

interface HaccpAuditFields {
  recordedByUserId?: number | null;
  recordedByUserName?: string | null;
  recordedAt?: string;
}

export interface HaccpTemperatureReading extends HaccpAuditFields {
  id: string;
  date: string;
  location: string;
  temperature: number;
  targetMax: number | null;
  note: string | null;
}

export interface HaccpOilCheck extends HaccpAuditFields {
  id: string;
  date: string;
  fryerLabel: string;
  action: HaccpOilAction;
  note: string | null;
}

export interface HaccpCleaningCheck extends HaccpAuditFields {
  id: string;
  date: string;
  point: string;
  done: boolean;
  note: string | null;
}

export interface HaccpGoodsReceipt extends HaccpAuditFields {
  id: string;
  date: string;
  product: string;
  lotNumber: string | null;
  temperature: number | null;
  accepted: boolean;
  note: string | null;
}

export interface HaccpProductionLog extends HaccpAuditFields {
  id: string;
  date: string;
  product: string;
  blastTempRange: string | null;
  blastDuration: string | null;
  internalLot: string | null;
  note: string | null;
}

// ----- Predefined items (sourced from the Excel template) -------------------
// These drive the rows the daily form pre-populates for the operator. The
// values are intentionally fixed in code — the cells/fryers/cleaning points
// are physical equipment in the kitchen, not user-managed lists.

export interface HaccpTemperatureLocation {
  location: string;
  targetMax: number;
}

export const HACCP_TEMPERATURE_LOCATIONS: HaccpTemperatureLocation[] = [
  { location: 'Cella 1', targetMax: 4 },
  { location: 'Cella 2', targetMax: 4 },
  { location: 'Cella 3', targetMax: 4 },
  { location: 'Cella 4', targetMax: 4 },
  { location: 'Banco cella grill', targetMax: 4 },
  { location: 'Frigo antipasti', targetMax: 4 },
  { location: 'Frigo primi', targetMax: 4 },
  { location: 'Frigo office', targetMax: 4 },
  { location: 'Congelatore 1c', targetMax: -18 },
  { location: 'Congelatore 2c', targetMax: -18 },
  { location: 'Congelatore gelati', targetMax: -18 },
];

export const HACCP_FRYERS: string[] = [
  'Friggitrice 1',
  'Friggitrice 2',
  'Friggitrice 3',
  'Friggitrice 4',
  'Friggitrice 5',
];

export const HACCP_CLEANING_POINTS: string[] = [
  'Banchi',
  'Lavandini',
  'Affettatrice',
  'Cutter',
  'Impastatrice',
  'Sfogliatrice',
  'Taglieri',
  'Pelapatate',
  'Piani cottura',
];

export const HACCP_BLAST_TEMP_RANGES: string[] = ['-18°/-20°', '0°/-5°'];
export const HACCP_BLAST_DURATIONS: string[] = ['30MIN', '60MIN'];

// Hints shown as datalist suggestions; users are free to type anything else.
export const HACCP_RECEIPT_PRODUCT_HINTS: string[] = [
  'Filetto Vacc. One',
  'Broccoli',
  'Cicoria',
  'Lombata',
  'Reale di vitello',
  'Petto di pollo',
  'Verdure pastellate',
];

export const HACCP_PRODUCTION_PRODUCT_HINTS: string[] = [
  'Salsa porcini',
  'Salsa pomodoro',
  'Salsa zingara',
  'Salsa silana',
  'Broccoli',
];

// ----- HTTP plumbing (mirrors shoppingApiService) ---------------------------

const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};
  if (includeContentType) headers['Content-Type'] = 'application/json';
  const socketId = socketClient.getSocket()?.id;
  if (socketId) headers['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
};

const fetchWithAuth = async (
  url: string,
  options: RequestInit = {},
  retried = false,
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
  expectJson = true,
): Promise<T> => {
  const response = await fetchWithAuth(url, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  if (expectJson) return response.json();
  return undefined as T;
};

// ----- CRUD per resource -----------------------------------------------------

class HaccpApiService {
  // --- Temperature readings (upsert by date+location) ---
  async getTemperatures(date: string): Promise<HaccpTemperatureReading[]> {
    return apiRequest(`${API_URL}/haccp/temperatures?date=${date}`, {
      headers: getHeaders(false),
    });
  }

  async upsertTemperature(input: {
    date: string;
    location: string;
    temperature: number;
    targetMax?: number | null;
    note?: string | null;
  }): Promise<HaccpTemperatureReading> {
    return apiRequest(`${API_URL}/haccp/temperatures`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async deleteTemperature(id: string): Promise<void> {
    return apiRequest(`${API_URL}/haccp/temperatures/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // --- Oil checks (upsert by date+fryer_label) ---
  async getOilChecks(date: string): Promise<HaccpOilCheck[]> {
    return apiRequest(`${API_URL}/haccp/oil?date=${date}`, {
      headers: getHeaders(false),
    });
  }

  async upsertOilCheck(input: {
    date: string;
    fryerLabel: string;
    action: HaccpOilAction;
    note?: string | null;
  }): Promise<HaccpOilCheck> {
    return apiRequest(`${API_URL}/haccp/oil`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async deleteOilCheck(id: string): Promise<void> {
    return apiRequest(`${API_URL}/haccp/oil/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // --- Cleaning checks (upsert by date+point) ---
  async getCleaningChecks(date: string): Promise<HaccpCleaningCheck[]> {
    return apiRequest(`${API_URL}/haccp/cleaning?date=${date}`, {
      headers: getHeaders(false),
    });
  }

  async upsertCleaningCheck(input: {
    date: string;
    point: string;
    done: boolean;
    note?: string | null;
  }): Promise<HaccpCleaningCheck> {
    return apiRequest(`${API_URL}/haccp/cleaning`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async deleteCleaningCheck(id: string): Promise<void> {
    return apiRequest(`${API_URL}/haccp/cleaning/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // --- Goods receipts (ad-hoc list) ---
  async getReceipts(date: string): Promise<HaccpGoodsReceipt[]> {
    return apiRequest(`${API_URL}/haccp/receipts?date=${date}`, {
      headers: getHeaders(false),
    });
  }

  async createReceipt(input: {
    date: string;
    product: string;
    lotNumber?: string | null;
    temperature?: number | null;
    accepted?: boolean;
    note?: string | null;
  }): Promise<HaccpGoodsReceipt> {
    return apiRequest(`${API_URL}/haccp/receipts`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async updateReceipt(id: string, updates: {
    product?: string;
    lotNumber?: string | null;
    temperature?: number | null;
    accepted?: boolean;
    note?: string | null;
  }): Promise<HaccpGoodsReceipt> {
    return apiRequest(`${API_URL}/haccp/receipts/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  async deleteReceipt(id: string): Promise<void> {
    return apiRequest(`${API_URL}/haccp/receipts/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  // --- Production logs (ad-hoc list) ---
  async getProductionLogs(date: string): Promise<HaccpProductionLog[]> {
    return apiRequest(`${API_URL}/haccp/production?date=${date}`, {
      headers: getHeaders(false),
    });
  }

  async createProductionLog(input: {
    date: string;
    product: string;
    blastTempRange?: string | null;
    blastDuration?: string | null;
    internalLot?: string | null;
    note?: string | null;
  }): Promise<HaccpProductionLog> {
    return apiRequest(`${API_URL}/haccp/production`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(input),
    });
  }

  async updateProductionLog(id: string, updates: {
    product?: string;
    blastTempRange?: string | null;
    blastDuration?: string | null;
    internalLot?: string | null;
    note?: string | null;
  }): Promise<HaccpProductionLog> {
    return apiRequest(`${API_URL}/haccp/production/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates),
    });
  }

  async deleteProductionLog(id: string): Promise<void> {
    return apiRequest(`${API_URL}/haccp/production/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }
}

export const haccpApiService = new HaccpApiService();
