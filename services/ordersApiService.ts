import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import type { OrderWithItems } from '../types';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface OpenOrderPayload {
  table_id?: number;
  reservation_id?: number;
  covers?: number;
  price_list_id?: number;
  notes?: string;
}

export interface NewOrderItem {
  dish_id: number;
  qty?: number;
  course_no?: number;
  seat_no?: number | null;
  note?: string | null;
  modifier_ids?: number[];
  station_id?: number | null;
}

export interface PatchOrderItemPayload {
  qty?: number;
  course_no?: number;
  seat_no?: number | null;
  note?: string | null;
  station_id?: number | null;
}

export interface SendOrderResult extends OrderWithItems {
  fire_mode: 'AUTO_ALL' | 'AUTO_FIRST' | 'MANUAL';
  fired_courses: number[];
  queued_courses: number[];
}

const getHeaders = (idempotencyKey?: string): HeadersInit => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const socketId = socketClient.getSocket()?.id;
  if (socketId) headers['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // Il palmare in sala perde il WiFi a metà richiesta e ritenta: senza chiave
  // il tavolo si ritroverebbe l'ordine doppio.
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
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

// Chiave di idempotenza per un invio: stabile finché la richiesta è la stessa,
// così un ritentativo dopo un timeout non duplica nulla.
export const newIdempotencyKey = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

class OrdersApiService {
  /** 404 → nessuna comanda aperta sul tavolo. */
  /** 404 → nessuna comanda aperta sul tavolo. Senza `service` il server
   *  guarda il servizio in corso; con data/turno espliciti guarda quello —
   *  è ciò che permette di riprendere una comanda appesa di un servizio
   *  passato navigando la griglia a quel giorno. */
  async getOrderByTable(
    tableId: number,
    service?: { date?: string; shift?: 'LUNCH' | 'DINNER' }
  ): Promise<OrderWithItems | null> {
    const params = new URLSearchParams();
    if (service?.date) params.set('date', service.date);
    if (service?.shift) params.set('shift', service.shift);
    const qs = params.toString();
    try {
      return await apiRequest<OrderWithItems>(`${API_URL}/tables/${tableId}/order${qs ? `?${qs}` : ''}`, {
        headers: getHeaders(),
      });
    } catch (err: any) {
      if (err?.status === 404) return null;
      throw err;
    }
  }

  async getOrder(orderId: number): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}`, { headers: getHeaders() });
  }

  async openOrder(payload: OpenOrderPayload, idempotencyKey?: string): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders`, {
      method: 'POST',
      headers: getHeaders(idempotencyKey),
      body: JSON.stringify(payload),
    });
  }

  async addItems(orderId: number, items: NewOrderItem[], idempotencyKey?: string): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}/items`, {
      method: 'POST',
      headers: getHeaders(idempotencyKey),
      body: JSON.stringify({ items }),
    });
  }

  async patchItem(itemId: number, payload: PatchOrderItemPayload): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/items/${itemId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(payload),
    });
  }

  async deleteItem(itemId: number): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/items/${itemId}`, {
      method: 'DELETE',
      headers: getHeaders(),
    });
  }

  /** Invio: la sala propone. Il lancio dipende da `course_fire_mode`. */
  async send(orderId: number, courseNo?: number, idempotencyKey?: string): Promise<SendOrderResult> {
    return apiRequest<SendOrderResult>(`${API_URL}/orders/${orderId}/send`, {
      method: 'POST',
      headers: getHeaders(idempotencyKey),
      body: JSON.stringify(courseNo != null ? { course_no: courseNo } : {}),
    });
  }

  /** Richiama un'uscita proposta ma non ancora lanciata dal passe. */
  async recallCourse(orderId: number, courseNo: number): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}/courses/${courseNo}/recall`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const ordersApiService = new OrdersApiService();

export interface MenuCatalogue {
  price_lists: { id: number; name: string; is_default: boolean; sort_order: number }[];
  stations: { id: number; name: string; color: string | null; sort_order: number }[];
  modifier_groups: {
    id: number; name: string; min_select: number; max_select: number; sort_order: number;
    modifiers: { id: number; group_id: number; name: string; price_delta_cents: number }[];
  }[];
  dish_modifier_groups: { dish_id: number; group_id: number }[];
}

export const getMenuCatalogue = async (): Promise<MenuCatalogue> =>
  apiRequest<MenuCatalogue>(`${API_URL}/menu/catalogue`, { headers: getHeaders() });

// --- Monitor di partita ------------------------------------------------------

export interface KdsItem {
  id: number;
  order_id: number;
  course_no: number;
  name_snapshot: string;
  qty: number;
  modifiers: { name: string; price_delta_cents: number }[] | null;
  note: string | null;
  status: 'SENT' | 'PREPARING' | 'READY';
  station_id: number | null;
  fired_at: string | null;
  station_start_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  table_id: number | null;
  table_name: string | null;
  customer_name: string | null;
  reservation_notes: string | null;
  customer_dietary_notes: string | null;
}

export interface KdsCourseState {
  order_id: number;
  course_no: number;
  total_items: number;
  ready_items: number;
  waiting_station_ids: (number | null)[];
}

export interface KdsQueue {
  station_id: number | null;
  items: KdsItem[];
  courses: KdsCourseState[];
}

export const getKdsQueue = async (stationId: number | null): Promise<KdsQueue> =>
  apiRequest<KdsQueue>(
    `${API_URL}/kds/queue${stationId != null ? `?station_id=${stationId}` : ''}`,
    { headers: getHeaders() },
  );

export const setKdsItemStatus = async (
  itemId: number,
  status: 'PREPARING' | 'READY',
): Promise<{ item: KdsItem; course_ready: boolean; waiting_station_ids: (number | null)[] }> =>
  apiRequest(`${API_URL}/kds/items/${itemId}/status`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ status }),
  });

// --- Passe -------------------------------------------------------------------

export interface ExpediterStationState {
  station_id: number | null;
  ready: boolean;
  items: number;
}

export interface ExpediterCourse {
  order_id: number;
  course_no: number;
  table_id: number | null;
  table_name: string | null;
  customer_name: string | null;
  status: 'QUEUED' | 'FIRED' | 'READY';
  stations: ExpediterStationState[];
  waiting_station_ids: (number | null)[];
  queued_at: string | null;
  fired_at: string | null;
  age_seconds: number;
  /** Proposta che nessuno lancia da troppo tempo. */
  stale_queued: boolean;
  /** Una partita ha finito e le altre no, da troppo tempo. */
  lagging: boolean;
  lamp_wait_seconds: number;
  sync_delta_seconds: number;
  items: { id: number; name_snapshot: string; qty: number; station_id: number | null; status: string }[];
}

export interface ExpediterBoard {
  stations: { id: number; name: string; color: string | null; sort_order: number }[];
  courses: ExpediterCourse[];
}

export const getExpediterBoard = async (): Promise<ExpediterBoard> =>
  apiRequest<ExpediterBoard>(`${API_URL}/kds/expediter`, { headers: getHeaders() });

export const fireCourse = async (orderId: number, courseNo: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/fire`, {
    method: 'POST', headers: getHeaders(),
  });

/** Ricalcola i tempi di partenza da adesso: la partita è andata in tilt. */
export const refireCourse = async (orderId: number, courseNo: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/refire`, {
    method: 'POST', headers: getHeaders(),
  });

/** Chiama la sala a ritirare l'uscita pronta. */
export const callCourse = async (orderId: number, courseNo: number): Promise<{ table_name: string }> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/call`, {
    method: 'POST', headers: getHeaders(),
  });

// --- Ponte al conto ----------------------------------------------------------

export interface CloseOrderResult {
  order_id: number;
  /** null quando non c'era nulla da pagare: comanda chiusa senza conto. */
  bill: null | {
    id: number;
    table_id: number | null;
    total_cents: number;
    covers: number;
    share_token: string | null;
    items: { name: string; qty: number; unit_price_cents: number }[] | null;
  };
  /** Claim non pagati rilasciati perché il totale è sceso. */
  released_split_ids: number[];
  message?: string;
}

/** Chiude la comanda e apre (o aggiorna) il conto, già valorizzato. */
export const closeOrder = async (orderId: number, discardPending = false): Promise<CloseOrderResult> =>
  apiRequest<CloseOrderResult>(`${API_URL}/orders/${orderId}/close`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ discard_pending: discardPending }),
  });

export const updateOrder = async (
  orderId: number,
  payload: { covers?: number; notes?: string | null },
): Promise<OrderWithItems> =>
  apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(payload),
  });

// --- Storni, sconti, trasferimenti -------------------------------------------

/** Storno di una riga già inviata: la motivazione è obbligatoria. */
export const voidItem = async (itemId: number, reason: string): Promise<OrderWithItems> =>
  apiRequest<OrderWithItems>(`${API_URL}/orders/items/${itemId}/void`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ reason }),
  });

export const setOrderDiscount = async (
  orderId: number,
  payload: { discount_type: 'PERCENT' | 'AMOUNT'; discount_value: number; reason: string } | null,
): Promise<OrderWithItems> =>
  apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}/discount`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify(payload ?? {}),
  });

export const transferOrder = async (orderId: number, tableId: number): Promise<OrderWithItems> =>
  apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}/transfer`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ table_id: tableId }),
  });

// --- Statistiche di cucina ---------------------------------------------------

export interface KitchenReport {
  from: string | null;
  to: string | null;
  partite: {
    station_id: number | null; station_name: string | null;
    righe: number; media_min: string | null; mediana_min: string | null; stornate: number;
  }[];
  sincronia: {
    uscite: number; uscite_multipartita: number;
    delta_medio_min: string | null; delta_mediano_min: string | null; delta_massimo_min: string | null;
  };
  passe: { uscite: number; attesa_media_min: string | null; attesa_massima_min: string | null };
  scarti: { motivo: string | null; righe: number; valore_cents: number }[];
}

export const getKitchenReport = async (from?: string, to?: string): Promise<KitchenReport> => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const qs = q.toString();
  return apiRequest<KitchenReport>(`${API_URL}/reports/kitchen${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
};
