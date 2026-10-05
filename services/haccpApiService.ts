import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError, ApiError } from './apiError';
import type { HaccpFrequency, HaccpPoint, HaccpRegister } from '../utils/haccp';

export type { HaccpFrequency, HaccpPoint, HaccpRegister } from '../utils/haccp';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// ----- Types ----------------------------------------------------------------

export type HaccpOilAction = 'SOSTITUITO' | 'FILTRATO' | 'UTILIZZABILE';

export const HACCP_OIL_ACTIONS: HaccpOilAction[] = ['SOSTITUITO', 'FILTRATO', 'UTILIZZABILE'];

/** Firma, modifica e annullamento: le stesse colonne su ogni registro. */
export interface HaccpAuditFields {
  recordedByUserId?: number | null;
  recordedByUserName?: string | null;
  recordedAt?: string;
  updatedAt?: string | null;
  updatedByUserId?: number | null;
  updatedByUserName?: string | null;
  voidedAt?: string | null;
  voidedByUserName?: string | null;
  voidReason?: string | null;
}

export interface HaccpTemperatureReading extends HaccpAuditFields {
  id: string;
  date: string;
  pointId: number | null;
  location: string;
  slot: number;
  temperature: number;
  targetMin: number | null;
  targetMax: number | null;
  note: string | null;
}

export interface HaccpOilCheck extends HaccpAuditFields {
  id: string;
  date: string;
  pointId: number | null;
  fryerLabel: string;
  action: HaccpOilAction;
  note: string | null;
}

export interface HaccpCleaningCheck extends HaccpAuditFields {
  id: string;
  date: string;
  pointId: number | null;
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

export type HaccpNcStatus = 'OPEN' | 'CLOSED' | 'VOID';
export type HaccpNcSource = 'TEMPERATURE' | 'OIL' | 'CLEANING' | 'RECEIPT' | 'PROCESS' | 'CALIBRATION'
  | 'SENSOR' | 'INTERVENTION' | 'RECALL' | 'MANUAL';

export interface HaccpNonConformity {
  id: number;
  date: string;
  source: HaccpNcSource;
  sourceId: string | null;
  pointId: number | null;
  title: string;
  detail: string | null;
  status: HaccpNcStatus;
  correctiveAction: string | null;
  openedByUserName: string | null;
  openedAt: string;
  closedByUserName: string | null;
  closedAt: string | null;
  voidReason: string | null;
  updatedAt: string;
}

export interface HaccpChange {
  id: number;
  entity: string;
  entityId: string;
  action: 'CREATE' | 'UPDATE' | 'VOID';
  recordDate: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  userName: string | null;
  createdAt: string;
}

export interface HaccpDay {
  date: string;
  points: HaccpPoint[];
  temperatures: HaccpTemperatureReading[];
  oil: HaccpOilCheck[];
  /** Le pulizie fatte nella finestra che copre anche le settimanali e le
   *  mensili: dal primo del mese (o da sei giorni prima) al giorno. */
  cleaning: HaccpCleaningCheck[];
  receipts: HaccpGoodsReceipt[];
  production: HaccpProductionLog[];
  /** Quelle del giorno più tutte le aperte. */
  nonconformities: HaccpNonConformity[];
  canManage: boolean;
}

export interface HaccpReportData {
  from: string;
  to: string;
  restaurantName: string | null;
  points: HaccpPoint[];
  temperatures: HaccpTemperatureReading[];
  oil: HaccpOilCheck[];
  cleaning: HaccpCleaningCheck[];
  receipts: HaccpGoodsReceipt[];
  production: HaccpProductionLog[];
  nonconformities: HaccpNonConformity[];
  changes: HaccpChange[];
  generatedAt: string;
}

export interface HaccpPointInput {
  register?: HaccpRegister;
  label?: string;
  minTemp?: number | null;
  maxTemp?: number | null;
  checksPerDay?: number;
  frequency?: HaccpFrequency;
  instructions?: string | null;
  active?: boolean;
}

/** Il server chiede il motivo della correzione (409, code reason_required):
 *  il chiamante lo domanda all'utente e ripete con `reason`. */
export const isReasonRequired = (err: unknown): boolean =>
  (err as ApiError)?.status === 409 && (err as ApiError)?.data?.code === 'reason_required';

// ----- Valori suggeriti --------------------------------------------------------
// Solo suggerimenti per i campi liberi della produzione: il cuoco scrive
// quello che vuole. Le postazioni, invece, sono dati del ristorante
// (haccp_points) e si configurano da HACCP → Configura.

export const HACCP_BLAST_TEMP_RANGES: string[] = ['-18°/-20°', '0°/-5°'];
export const HACCP_BLAST_DURATIONS: string[] = ['30MIN', '60MIN'];

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

const get = <T>(path: string): Promise<T> =>
  apiRequest<T>(`${API_URL}/haccp${path}`, { headers: getHeaders(false) });

const send = <T>(method: 'POST' | 'PUT', path: string, body: unknown): Promise<T> =>
  apiRequest<T>(`${API_URL}/haccp${path}`, { method, headers: getHeaders(), body: JSON.stringify(body) });

// ----- API ---------------------------------------------------------------------

class HaccpApiService {
  // --- Punti di controllo ---
  getPoints(all = false): Promise<{ points: HaccpPoint[]; canManage: boolean }> {
    return get(`/points${all ? '?all=1' : ''}`);
  }

  createPoint(input: HaccpPointInput & { register: HaccpRegister; label: string }): Promise<HaccpPoint> {
    return send('POST', '/points', input);
  }

  updatePoint(id: number, input: HaccpPointInput & { reason?: string | null }): Promise<HaccpPoint> {
    return send('PUT', `/points/${id}`, input);
  }

  reorderPoints(register: HaccpRegister, ids: number[]): Promise<{ ok: true }> {
    return send('POST', '/points/reorder', { register, ids });
  }

  // --- Il giorno ---
  getDay(date: string): Promise<HaccpDay> {
    return get(`/day?date=${date}`);
  }

  // --- Temperature: upsert su (giorno, postazione, rilevazione) ---
  saveTemperature(input: {
    date: string;
    pointId: number;
    slot: number;
    temperature: number;
    note?: string | null;
    reason?: string | null;
  }): Promise<HaccpTemperatureReading> {
    return send('POST', '/temperatures', input);
  }

  voidTemperature(id: string, reason: string | null): Promise<HaccpTemperatureReading> {
    return send('POST', `/temperatures/${id}/void`, { reason });
  }

  // --- Olio: upsert su (giorno, friggitrice) ---
  saveOilCheck(input: {
    date: string;
    pointId: number;
    action: HaccpOilAction;
    note?: string | null;
    reason?: string | null;
  }): Promise<HaccpOilCheck> {
    return send('POST', '/oil', input);
  }

  // --- Pulizie: done = false annulla la spunta ---
  saveCleaningCheck(input: {
    date: string;
    pointId: number;
    done: boolean;
    note?: string | null;
    reason?: string | null;
  }): Promise<HaccpCleaningCheck> {
    return send('POST', '/cleaning', input);
  }

  // --- Ricevimento merci ---
  createReceipt(input: {
    date: string;
    product: string;
    lotNumber?: string | null;
    temperature?: number | null;
    accepted: boolean;
    note?: string | null;
  }): Promise<HaccpGoodsReceipt> {
    return send('POST', '/receipts', input);
  }

  voidReceipt(id: string, reason: string | null): Promise<HaccpGoodsReceipt> {
    return send('POST', `/receipts/${id}/void`, { reason });
  }

  // --- Produzione / abbattimento ---
  createProductionLog(input: {
    date: string;
    product: string;
    blastTempRange?: string | null;
    blastDuration?: string | null;
    internalLot?: string | null;
    note?: string | null;
  }): Promise<HaccpProductionLog> {
    return send('POST', '/production', input);
  }

  voidProductionLog(id: string, reason: string | null): Promise<HaccpProductionLog> {
    return send('POST', `/production/${id}/void`, { reason });
  }

  // --- Non conformità ---
  getNonConformities(params: { status?: 'open' | 'all'; from?: string; to?: string } = {}): Promise<{ nonconformities: HaccpNonConformity[] }> {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    const qs = q.toString();
    return get(`/nonconformities${qs ? `?${qs}` : ''}`);
  }

  createNonConformity(input: { date: string; title: string; detail?: string | null; correctiveAction?: string | null }): Promise<HaccpNonConformity> {
    return send('POST', '/nonconformities', input);
  }

  closeNonConformity(id: number, correctiveAction: string, reason?: string | null): Promise<HaccpNonConformity> {
    return send('POST', `/nonconformities/${id}/close`, { correctiveAction, reason: reason ?? null });
  }

  voidNonConformity(id: number, reason: string): Promise<HaccpNonConformity> {
    return send('POST', `/nonconformities/${id}/void`, { reason });
  }

  // --- Storico e report ---
  getChanges(entity: string, entityId: string): Promise<{ changes: HaccpChange[] }> {
    return get(`/changes?entity=${encodeURIComponent(entity)}&entityId=${encodeURIComponent(entityId)}`);
  }

  getReport(from: string, to: string): Promise<HaccpReportData> {
    return get(`/report?from=${from}&to=${to}`);
  }
}

export const haccpApiService = new HaccpApiService();
