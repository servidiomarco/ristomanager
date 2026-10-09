import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import type { CostoPiatto, StatoCosto, UnitaCosto } from '../utils/foodCost';

/* Client delle rotte /food-cost (services/foodCostRoutes.ts). Solo cloud:
   costi e schede non servono al nodo di sala. */

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

export interface FcIngrediente {
  id: number;
  area: 'CUCINA' | 'SALA' | 'BAR';
  nome: string;
  unita: string | null;
  categoriaId: number | null;
  categoria: string | null;
  costoCents: number | null;
  unitaCosto: UnitaCosto | null;
  resaPct: number;
  supplierId: string | null;
  fornitore: string | null;
  costoAggiornatoAt: string | null;
  isPreparazione: boolean;
  resaQuantita: number | null;
}

export interface FcRiga {
  id: number;
  dishId: number | null;
  preparazioneId: number | null;
  productId: number;
  quantita: number;
  sortOrder: number;
  note: string | null;
}

export interface FcPiattoMeta {
  dishId: number;
  porzioni: number;
  costoManualeCents: number | null;
}

export interface FcImpostazioni {
  targetPct: number;
  ivaBanchettiPct: number;
  quotaBambiniPct: number;
}

export interface FcDati {
  ingredienti: FcIngrediente[];
  righe: FcRiga[];
  piatti: FcPiattoMeta[];
  impostazioni: FcImpostazioni;
  canManage: boolean;
  /** La bozza con l'AI si può chiedere (chiave sul server e foodcost:manage).
   *  Assente da un server di prima: vale false. */
  aiDisponibile?: boolean;
}

export interface FcPiattoCosto {
  id: number;
  nome: string;
  categoria: string | null;
  prezzo: number;
  ivaPct: number;
  alPeso: boolean;
  attivo: boolean;
  costoCents: number | null;
  stato: StatoCosto;
  manuale: boolean;
  mancanti: number[];
  foodCostPct: number | null;
  margineCents: number | null;
}

export interface FcPrezzoStorico {
  id: number;
  costoCents: number;
  unitaCosto: UnitaCosto;
  fonte: 'MANUALE' | 'BOLLA' | 'FATTURA_XML' | 'PASSEPARTOUT';
  documento: string | null;
  fornitore: string | null;
  autore: string | null;
  data: string;
}

export interface FcRigaInput {
  productId: number;
  quantita: number;
  note?: string | null;
  /** Fissa l'unità di un ingrediente che non ne ha ancora una. */
  unita?: UnitaCosto | null;
}

/** Una riga proposta dall'AI: un ingrediente del ristorante o uno nuovo. */
export interface FcRigaBozza {
  productId: number | null;
  nomeNuovo: string | null;
  unita: UnitaCosto;
  quantita: number;
  nota: string | null;
}

export interface FcBozza {
  righe: FcRigaBozza[];
  resaQuantita: number | null;
  resaUnita: UnitaCosto | null;
  avvisi: string[];
}

export interface FcIngredienteInput {
  costoCents?: number | null;
  unitaCosto?: UnitaCosto | null;
  resaPct?: number;
  supplierId?: string | null;
  isPreparazione?: boolean;
  resaQuantita?: number | null;
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

const get = <T>(path: string): Promise<T> =>
  apiRequest<T>(`${API_URL}/food-cost${path}`, { headers: getHeaders(false) });

const send = <T>(method: 'POST' | 'PUT' | 'PATCH', path: string, body: unknown): Promise<T> =>
  apiRequest<T>(`${API_URL}/food-cost${path}`, { method, headers: getHeaders(), body: JSON.stringify(body) });

class FoodCostApiService {
  getDati(): Promise<FcDati> {
    return get('/dati');
  }

  getPiatti(): Promise<{ piatti: FcPiattoCosto[]; impostazioni: FcImpostazioni }> {
    return get('/piatti');
  }

  creaIngrediente(input: {
    nome: string;
    unitaCosto: UnitaCosto;
    costoCents?: number | null;
    resaPct?: number;
    isPreparazione?: boolean;
    area?: 'CUCINA' | 'SALA' | 'BAR';
  }): Promise<FcIngrediente> {
    return send('POST', '/ingredienti', input);
  }

  aggiornaIngrediente(id: number, input: FcIngredienteInput): Promise<FcIngrediente> {
    return send('PATCH', `/ingredienti/${id}`, input);
  }

  getPrezzi(id: number): Promise<{ prezzi: FcPrezzoStorico[] }> {
    return get(`/ingredienti/${id}/prezzi`);
  }

  salvaSchedaPiatto(dishId: number, input: { righe: FcRigaInput[]; porzioni: number; costoManualeCents: number | null }): Promise<{
    righe: FcRiga[];
    piatto: FcPiattoMeta;
    costo: CostoPiatto | null;
  }> {
    return send('PUT', `/schede/piatto/${dishId}`, input);
  }

  salvaSchedaPreparazione(productId: number, input: { righe: FcRigaInput[]; resaQuantita: number; unitaCosto?: UnitaCosto }): Promise<{
    ingrediente: FcIngrediente;
    righe: FcRiga[];
  }> {
    return send('PUT', `/schede/preparazione/${productId}`, input);
  }

  /** La proposta dell'AI per una scheda vuota: non salva niente. */
  bozzaScheda(input: { piattoId: number; porzioni: number } | { preparazioneId: number }): Promise<FcBozza> {
    return send('POST', '/bozza', input);
  }

  salvaImpostazioni(input: Partial<FcImpostazioni>): Promise<FcImpostazioni> {
    return send('PUT', '/impostazioni', input);
  }
}

export const foodCostApiService = new FoodCostApiService();
