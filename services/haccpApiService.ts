import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError, ApiError } from './apiError';
import type {
  HaccpDeadline, HaccpDocumentCategory, HaccpFrequency, HaccpInterventionType, HaccpLabelKind, HaccpLimits, HaccpPoint,
  HaccpProcess, HaccpReceiptCategory, HaccpRegister, HaccpTrainingCourse,
} from '../utils/haccp';

export type {
  HaccpDeadline, HaccpDocumentCategory, HaccpFrequency, HaccpInterventionType, HaccpLabelKind, HaccpLimits, HaccpPoint,
  HaccpProcess, HaccpReceiptCategory, HaccpRegister, HaccpTrainingCourse,
} from '../utils/haccp';

export interface HaccpSensor {
  id: number;
  externalId: string;
  label: string | null;
  vendor: string | null;
  pointId: number | null;
  active: boolean;
  lastValue: number | null;
  lastSeenAt: string | null;
  battery: number | null;
  outSince: string | null;
  createdAt: string;
}

export interface HaccpLabel {
  id: string;
  kind: HaccpLabelKind;
  labelDate: string;
  product: string;
  preparedAt: string;
  expiryDate: string;
  lot: string | null;
  storage: string | null;
  allergens: string[];
  note: string | null;
  copies: number;
  printer: string | null;
  printJobId: number | null;
  printedByUserName: string | null;
  createdAt: string;
}

export interface HaccpLabelPreset {
  id: number;
  name: string;
  kind: HaccpLabelKind;
  shelfLifeDays: number;
  storage: string | null;
  allergens: string[];
  sortOrder: number;
  active: boolean;
}

export interface HaccpDdtProposal {
  supplier: string | null;
  supplierMatch: { id: string; name: string } | null;
  ddtNumber: string | null;
  documentDate: string | null;
  lines: Array<{ product: string; lotNumber: string | null; expiryDate: string | null; quantity: string | null; category: HaccpReceiptCategory | null }>;
  warnings: string[];
}

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
  /** Assenti su un server della versione precedente. */
  polarCompounds?: number | null;
  oilTemp?: number | null;
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
  supplierId?: string | null;
  supplierName?: string | null;
  ddtNumber?: string | null;
  expiryDate?: string | null;
  packagingOk?: boolean | null;
  category?: HaccpReceiptCategory | null;
  quantity?: string | null;
}

/** Un processo (abbattimento, cottura, bonifica…). Le righe di prima della
 *  Fase 2 sono LEGACY, con range e durata. */
export interface HaccpProductionLog extends HaccpAuditFields {
  id: string;
  date: string;
  product: string;
  process?: HaccpProcess;
  blastTempRange: string | null;
  blastDuration: string | null;
  internalLot: string | null;
  note: string | null;
  equipmentPointId?: number | null;
  equipmentLabel?: string | null;
  startedAt?: string | null;
  startTemp?: number | null;
  endedAt?: string | null;
  endTemp?: number | null;
  /** Chi ha chiuso il ciclo, se non è chi l'ha avviato. */
  endedByUserName?: string | null;
  quantity?: string | null;
  expiryDate?: string | null;
  sourceLots?: string | null;
  sanitizer?: string | null;
  concentration?: string | null;
  contactMinutes?: number | null;
  eventLabel?: string | null;
  keepUntil?: string | null;
  compliant?: boolean | null;
  problem?: string | null;
}

export type HaccpCalibrationMethod = 'GHIACCIO' | 'EBOLLIZIONE' | 'RIFERIMENTO';
export type HaccpCalibrationOutcome = 'OK' | 'CORRETTO' | 'SOSTITUITO';

export interface HaccpCalibration extends HaccpAuditFields {
  id: string;
  date: string;
  pointId: number;
  instrument: string;
  method: HaccpCalibrationMethod;
  referenceTemp: number;
  measuredTemp: number;
  maxDeviation: number;
  outcome: HaccpCalibrationOutcome;
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

export interface HaccpIntervention extends HaccpAuditFields {
  id: string;
  date: string;
  type: HaccpInterventionType;
  provider: string | null;
  outcomeOk: boolean;
  findings: string | null;
  quantity: string | null;
  reference: string | null;
  documentId: number | null;
  nextDue: string | null;
  note: string | null;
}

export interface HaccpDocument {
  id: number;
  category: HaccpDocumentCategory;
  title: string;
  filename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  hasFile: boolean;
  validUntil: string | null;
  note: string | null;
  archived: boolean;
  uploadedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HaccpTraining {
  id: number;
  staffMemberId: string | null;
  personName: string;
  course: HaccpTrainingCourse;
  title: string | null;
  provider: string | null;
  hours: number | null;
  completedOn: string;
  expiresOn: string | null;
  documentId: number | null;
  note: string | null;
  archived: boolean;
  recordedByUserName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HaccpStaffOption { id: string; name: string; surname: string; role: string | null; category: string }

export interface HaccpArchive {
  today: string;
  documents: HaccpDocument[];
  trainings: HaccpTraining[];
  interventions: HaccpIntervention[];
  staff: HaccpStaffOption[];
  deadlines: HaccpDeadline[];
}

export interface HaccpAllergenDish { id: number; name: string; category: string | null; allergens: string[] }

export interface HaccpDay {
  date: string;
  points: HaccpPoint[];
  temperatures: HaccpTemperatureReading[];
  oil: HaccpOilCheck[];
  /** L'ultima pulizia di ogni punto fino al giorno (una per punto): le
   *  periodiche coprono il loro periodo. */
  cleaning: HaccpCleaningCheck[];
  receipts: HaccpGoodsReceipt[];
  /** I processi del giorno più i cicli ancora aperti dei giorni prima. */
  production: HaccpProductionLog[];
  /** L'ultima taratura di ogni termometro fino al giorno. Assente su un
   *  server della versione precedente. */
  calibrations?: HaccpCalibration[];
  /** Quelle del giorno più tutte le aperte. */
  nonconformities: HaccpNonConformity[];
  limits?: HaccpLimits;
  /** Attestati, documenti e interventi scaduti o in scadenza. */
  deadlines?: HaccpDeadline[];
  /** I sensori assegnati a una postazione, con l'ultima lettura. */
  sensors?: HaccpSensor[];
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
  calibrations?: HaccpCalibration[];
  interventions?: HaccpIntervention[];
  labels?: HaccpLabel[];
  nonconformities: HaccpNonConformity[];
  changes: HaccpChange[];
  limits?: HaccpLimits;
  /** Solo nel fascicolo per l'ispezione. */
  documents?: HaccpDocument[];
  trainings?: HaccpTraining[];
  generatedAt: string;
}

export interface HaccpTraceResult {
  q: string;
  receipts: HaccpGoodsReceipt[];
  production: HaccpProductionLog[];
}

export type HaccpProcessInput = Partial<Omit<HaccpProductionLog, 'id' | 'date' | keyof HaccpAuditFields | 'compliant' | 'problem' | 'keepUntil' | 'equipmentLabel' | 'endedByUserName'>> & { product?: string };

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
    polarCompounds?: number | null;
    oilTemp?: number | null;
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
    supplierId?: string | null;
    supplierName?: string | null;
    ddtNumber?: string | null;
    expiryDate?: string | null;
    packagingOk?: boolean | null;
    category?: HaccpReceiptCategory | null;
    quantity?: string | null;
  }): Promise<HaccpGoodsReceipt> {
    return send('POST', '/receipts', input);
  }

  voidReceipt(id: string, reason: string | null): Promise<HaccpGoodsReceipt> {
    return send('POST', `/receipts/${id}/void`, { reason });
  }

  // --- Processi (abbattimento, cottura, bonifica…) ---
  createProductionLog(input: HaccpProcessInput & { date: string; product: string }): Promise<HaccpProductionLog> {
    return send('POST', '/production', input);
  }

  /** Chiude un ciclo (fine e temperatura finale) o corregge un processo. */
  updateProductionLog(id: string, input: HaccpProcessInput & { reason?: string | null }): Promise<HaccpProductionLog> {
    return send('PUT', `/production/${id}`, input);
  }

  voidProductionLog(id: string, reason: string | null): Promise<HaccpProductionLog> {
    return send('POST', `/production/${id}/void`, { reason });
  }

  // --- Taratura dei termometri ---
  createCalibration(input: {
    date: string;
    pointId: number;
    method: HaccpCalibrationMethod;
    referenceTemp: number;
    measuredTemp: number;
    outcome: HaccpCalibrationOutcome;
    note?: string | null;
  }): Promise<HaccpCalibration> {
    return send('POST', '/calibrations', input);
  }

  voidCalibration(id: string, reason: string | null): Promise<HaccpCalibration> {
    return send('POST', `/calibrations/${id}/void`, { reason });
  }

  // --- Limiti del locale ---
  getSettings(): Promise<{ limits: HaccpLimits; defaults: HaccpLimits }> {
    return get('/settings');
  }

  saveSettings(limits: HaccpLimits, reason?: string | null): Promise<{ limits: HaccpLimits }> {
    return send('PUT', '/settings', { limits, reason: reason ?? null });
  }

  // --- Rintracciabilità ---
  trace(q: string, from?: string, to?: string): Promise<HaccpTraceResult> {
    const params = new URLSearchParams({ q });
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return get(`/trace?${params.toString()}`);
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

  createNonConformity(input: { date: string; title: string; detail?: string | null; correctiveAction?: string | null; source?: 'MANUAL' | 'RECALL' }): Promise<HaccpNonConformity> {
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

  getReport(from: string, to: string, dossier = false): Promise<HaccpReportData> {
    return get(`/report?from=${from}&to=${to}${dossier ? '&dossier=1' : ''}`);
  }

  // --- Archivio ---
  getArchive(): Promise<HaccpArchive> {
    return get('/archive');
  }

  uploadDocument(input: {
    category: HaccpDocumentCategory;
    title: string;
    validUntil?: string | null;
    note?: string | null;
    file?: { filename: string; contentType: string; data: string } | null;
  }): Promise<HaccpDocument> {
    const { file, ...rest } = input;
    return send('POST', '/documents', { ...rest, ...(file ? { filename: file.filename, contentType: file.contentType, data: file.data } : {}) });
  }

  updateDocument(id: number, input: Partial<Pick<HaccpDocument, 'category' | 'title' | 'validUntil' | 'note' | 'archived'>> & { reason?: string | null }): Promise<HaccpDocument> {
    return send('PUT', `/documents/${id}`, input);
  }

  /** Il file di un documento, con il token: un link diretto non porterebbe
   *  l'intestazione di autenticazione. */
  async downloadDocument(id: number): Promise<Blob> {
    const response = await fetchWithAuth(`${API_URL}/haccp/documents/${id}/file`, { headers: getHeaders(false) });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
      throw buildApiError(response.status, errorData);
    }
    return response.blob();
  }

  createTraining(input: Partial<Omit<HaccpTraining, 'id' | 'createdAt' | 'updatedAt' | 'recordedByUserName'>>): Promise<HaccpTraining> {
    return send('POST', '/trainings', input);
  }

  updateTraining(id: number, input: Partial<Omit<HaccpTraining, 'id' | 'createdAt' | 'updatedAt' | 'recordedByUserName'>> & { reason?: string | null }): Promise<HaccpTraining> {
    return send('PUT', `/trainings/${id}`, input);
  }

  createIntervention(input: Partial<Omit<HaccpIntervention, 'id' | keyof HaccpAuditFields>> & { date: string; type: HaccpInterventionType }): Promise<HaccpIntervention> {
    return send('POST', '/interventions', input);
  }

  voidIntervention(id: string, reason: string | null): Promise<HaccpIntervention> {
    return send('POST', `/interventions/${id}/void`, { reason });
  }

  getAllergens(): Promise<{ restaurantName: string | null; dishes: HaccpAllergenDish[] }> {
    return get('/allergens');
  }

  // --- Sensori ---
  getSensors(): Promise<{ sensors: HaccpSensor[]; token: string | null }> {
    return get('/sensors');
  }

  regenerateSensorToken(): Promise<{ token: string }> {
    return send('POST', '/sensors/token', {});
  }

  updateSensor(id: number, input: { pointId?: number | null; label?: string | null; active?: boolean }): Promise<HaccpSensor> {
    return send('PUT', `/sensors/${id}`, input);
  }

  getSensorReadings(id: number, hours = 24): Promise<{ readings: Array<{ measuredAt: string; value: number }> }> {
    return get(`/sensors/${id}/readings?hours=${hours}`);
  }

  /** L'indirizzo a cui i gateway dei sensori mandano le letture. */
  sensorIngestUrl(): string {
    return `${API_URL}/haccp/sensors/ingest`;
  }

  // --- Etichette ---
  getLabelConfig(): Promise<{ presets: HaccpLabelPreset[]; printers: string[] }> {
    return get('/labels/config');
  }

  getLabels(date: string): Promise<{ labels: HaccpLabel[] }> {
    return get(`/labels?date=${date}`);
  }

  createLabel(input: {
    kind: HaccpLabelKind; product: string; preparedAt?: string; expiryDate: string; lot?: string | null; storage?: string | null;
    allergens?: string[]; note?: string | null; copies?: number; printer?: string | null; sourceEntity?: string | null; sourceId?: string | null;
  }): Promise<HaccpLabel> {
    return send('POST', '/labels', input);
  }

  createLabelPreset(input: Partial<Omit<HaccpLabelPreset, 'id' | 'sortOrder'>> & { name: string; shelfLifeDays: number }): Promise<HaccpLabelPreset> {
    return send('POST', '/label-presets', input);
  }

  updateLabelPreset(id: number, input: Partial<Omit<HaccpLabelPreset, 'id' | 'sortOrder'>>): Promise<HaccpLabelPreset> {
    return send('PUT', `/label-presets/${id}`, input);
  }

  // --- Lettura AI della bolla ---
  scanDdt(file: { contentType: string; data: string }): Promise<HaccpDdtProposal> {
    return send('POST', '/receipts/scan', file);
  }
}

export const haccpApiService = new HaccpApiService();
