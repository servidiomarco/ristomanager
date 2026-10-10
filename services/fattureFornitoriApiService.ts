import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import type { UnitaCosto } from '../utils/foodCost';

/* Client delle rotte /fatture-fornitori (services/fattureFornitoriRoutes.ts).
   Solo cloud: le fatture non servono al nodo di sala. */

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

export type StatoFattura = 'DA_CONTROLLARE' | 'CARICATA' | 'IGNORATA';
export type TipoRiga = 'merce' | 'nota' | 'sconto' | 'spesa' | 'servizio';
export type CategoriaSpesa = 'cibo' | 'bevande' | 'pulizia' | 'monouso' | 'personale' | 'servizi' | 'altro';

export const CATEGORIE_SPESA: { value: CategoriaSpesa; label: string }[] = [
  { value: 'cibo', label: 'Cibo' },
  { value: 'bevande', label: 'Bevande' },
  { value: 'pulizia', label: 'Pulizia' },
  { value: 'monouso', label: 'Monouso' },
  { value: 'personale', label: 'Personale' },
  { value: 'servizi', label: 'Servizi' },
  { value: 'altro', label: 'Altro' },
];

export interface FfTestata {
  id: number;
  fornitore: { nome: string; piva: string | null; supplierId: string | null; supplierNome: string | null };
  tipoDocumento: string;
  notaDiCredito: boolean;
  numero: string;
  data: string;
  totaleCents: number | null;
  imponibileCents: number;
  impostaCents: number;
  stato: StatoFattura;
  origine: 'UPLOAD' | 'EMAIL';
  righeMerce: number;
  righeDaDecidere: number;
  caricataAt: string | null;
  caricataDa: string | null;
  createdAt: string;
}

export interface FfProdotto {
  id: number;
  nome: string;
  area: 'CUCINA' | 'SALA' | 'BAR' | null;
  unita: string | null;
  costoCents: number | null;
  unitaCosto: UnitaCosto | null;
  isPreparazione: boolean;
}

export interface FfRiga {
  id: number;
  numeroLinea: number;
  tipo: TipoRiga;
  descrizione: string;
  ean: string | null;
  codice: string | null;
  quantita: number | null;
  unitaMisura: string | null;
  prezzoUnitario: number;
  prezzoTotale: number;
  aliquotaIva: number;
  lotto: string | null;
  scadenza: string | null;
  ddt: string | null;
  esito: 'CARICO' | 'IGNORA' | null;
  daMemoria: boolean;
  productId: number | null;
  prodotto: FfProdotto | null;
  fattoreMagazzino: number | null;
  fattoreCosto: number | null;
  unitaCosto: UnitaCosto | null;
  categoriaSpesa: CategoriaSpesa | null;
  quantitaMagazzino: number | null;
  costoCents: number | null;
  caricata: boolean;
  prezzoAggiornato: boolean;
}

export interface FfDettaglio extends FfTestata {
  cedente: { indirizzo?: string | null; email?: string | null; telefono?: string | null };
  altroDestinatario: boolean;
  causale: string | null;
  ddt: { numero: string; data: string | null }[];
  pagamenti: { modalita: string | null; data: string | null; importo: number | null; iban: string | null }[];
  allegati: { indice: number; nome: string; formato: string | null; bytes: number }[];
  fornitoreSuggerito: { id: string; nome: string } | null;
  foodCost: boolean;
  /** L'unità del food cost di ogni prodotto che ne ha una (assente da un server di prima). */
  unitaCostoProdotti?: Record<number, UnitaCosto>;
  righe: FfRiga[];
}

export interface FfEsitoFile {
  file: string;
  esito: 'nuova' | 'doppione' | 'scartato';
  motivo?: string;
  id?: number;
  fornitore?: string;
  numero?: string;
  data?: string;
  riconosciute?: number;
  righeMerce?: number;
}

export interface FfDecisione {
  esito: 'CARICO' | 'IGNORA' | null;
  productId?: number;
  fattoreMagazzino?: number;
  fattoreCosto?: number | null;
  unitaCosto?: UnitaCosto | null;
  categoriaSpesa?: CategoriaSpesa;
}

const headers = (json = true): Record<string, string> => {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  const socketId = socketClient.getSocket()?.id;
  if (socketId) h['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
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

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithAuth(`${API_URL}/fatture-fornitori${path}`, options);
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
};

const send = <T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });

class FattureFornitoriApiService {
  elenco(stato?: StatoFattura): Promise<{ fatture: FfTestata[]; daControllare: number }> {
    return request(stato ? `?stato=${stato}` : '', { headers: headers(false) });
  }
  conteggio(): Promise<{ daControllare: number }> {
    return request('/conteggio', { headers: headers(false) });
  }
  dettaglio(id: number): Promise<FfDettaglio> {
    return request(`/${id}`, { headers: headers(false) });
  }
  /** Il file com'è: niente base64, uno zip di un mese può pesare parecchio. */
  carica(file: File): Promise<{ esiti: FfEsitoFile[] }> {
    return request('/upload', {
      method: 'POST',
      headers: { ...headers(false), 'Content-Type': 'application/octet-stream', 'X-Nome-File': encodeURIComponent(file.name) },
      body: file,
    });
  }
  /** Il PDF di cortesia, da aprire in una scheda nuova. */
  async allegato(id: number, indice: number): Promise<Blob> {
    const response = await fetchWithAuth(`${API_URL}/fatture-fornitori/${id}/allegati/${indice}`, { headers: headers(false) });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
      throw buildApiError(response.status, errorData);
    }
    return response.blob();
  }
  collegaFornitore(id: number, input: { supplierId: string } | { crea: true }): Promise<FfDettaglio> {
    return send('PUT', `/${id}/fornitore`, input);
  }
  decidiRiga(id: number, rigaId: number, decisione: FfDecisione): Promise<FfRiga> {
    return send('PUT', `/${id}/righe/${rigaId}`, decisione);
  }
  caricaInMagazzino(id: number, ubicazioni: Partial<Record<'CUCINA' | 'SALA' | 'BAR', number>>): Promise<{
    caricate: number;
    prezzi: number;
    avvisi: string[];
    fattura: FfDettaglio;
  }> {
    return send('POST', `/${id}/carica`, { ubicazioni });
  }
  annullaCarico(id: number): Promise<FfDettaglio> {
    return send('POST', `/${id}/annulla`);
  }
  cambiaStato(id: number, stato: 'IGNORATA' | 'DA_CONTROLLARE'): Promise<FfDettaglio> {
    return send('PUT', `/${id}/stato`, { stato });
  }
  elimina(id: number): Promise<void> {
    return send('DELETE', `/${id}`);
  }
}

export const fattureFornitoriApi = new FattureFornitoriApiService();
