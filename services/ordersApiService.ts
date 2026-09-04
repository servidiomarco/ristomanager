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
  /** Varianti firmate: n>0 aggiunge n volte (addebito), n<0 toglie
   *  (sconto) — «++ prosciutto», «-- prosciutto». Se presente vince su
   *  modifier_ids. */
  modifiers?: { id: number; n: number }[];
  /** Ingredienti tolti da un piatto composto: entrano nello snapshot come
   *  «Senza X» con l'eventuale sconto. Solo su piatti COMPOSED. */
  removed_component_ids?: number[];
  station_id?: number | null;
  /** Chiave di idempotenza per riga: il server la vincola per tenant, quindi
   *  rimandare la stessa riga (retry, coda offline) non la duplica mai. */
  idempotency_key?: string;
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

  /** Conti attivi non incassati del servizio, per la griglia e per il
   *  foglio conto aperto dal tavolo. */
  async getTablesBillsStatus(
    service?: { date?: string; shift?: 'LUNCH' | 'DINNER' }
  ): Promise<{
    bills: ServiceBill[];
    tables: { table_id: number; residual_cents: number }[];
  }> {
    const params = new URLSearchParams();
    if (service?.date) params.set('date', service.date);
    if (service?.shift) params.set('shift', service.shift);
    const qs = params.toString();
    return apiRequest(`${API_URL}/tables/bills-status${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
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

  /** Annulla la CHIAMATA di un'uscita già lanciata: torna in coda, come se
   *  il fuoco non fosse mai partito. 409 se la cucina ha già iniziato. */
  async unfireCourse(orderId: number, courseNo: number): Promise<OrderWithItems> {
    return apiRequest<OrderWithItems>(`${API_URL}/orders/${orderId}/courses/${courseNo}/unfire`, {
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
    /** Guida del gruppo per sala e cucina, espandibile sul foglio varianti. */
    note: string | null;
    /** price_delta_pct: percentuale del prezzo battuto (pg serializza NUMERIC
     *  come stringa); null = sovrapprezzo assoluto. Il foglio la mostra in €
     *  calcolati sul piatto corrente; il conto vero lo fa il server. */
    modifiers: { id: number; group_id: number; name: string; price_delta_cents: number; price_delta_pct: string | null; note: string | null }[];
  }[];
  dish_modifier_groups: { dish_id: number; group_id: number }[];
  /** Ingredienti dei piatti composti: pre-inclusi sul foglio varianti, si
   *  battono in negativo (removed_component_ids sulla riga). */
  dish_components: { id: number; dish_id: number; name: string; removal_delta_cents: number; sort_order: number }[];
  /** Preferenze delle categorie decise in Menu: ordine (sort) e accensione.
   *  Categoria assente = accesa, in coda. */
  category_prefs?: Record<string, { enabled: boolean; sort: number }>;
}

export const getMenuCatalogue = async (): Promise<MenuCatalogue> =>
  apiRequest<MenuCatalogue>(`${API_URL}/menu/catalogue`, { headers: getHeaders() });

// --- Monitor di partita ------------------------------------------------------

/** Tavoli con una comanda aperta nel servizio, in una chiamata sola.
 *  `shift` assente = entrambi i turni del giorno, come /bills/open. */
export const getOpenOrderTables = async (
  service?: { date?: string; shift?: 'LUNCH' | 'DINNER' },
): Promise<{
  service: { service_date: string; shift: 'LUNCH' | 'DINNER' };
  table_ids: number[];
  orders: { id: number; table_id: number }[];
}> => {
  const params = new URLSearchParams();
  if (service?.date) params.set('date', service.date);
  if (service?.shift) params.set('shift', service.shift);
  const qs = params.toString();
  return apiRequest(`${API_URL}/orders/open${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
};

export interface KdsItem {
  id: number;
  order_id: number;
  course_no: number;
  name_snapshot: string;
  qty: number;
  modifiers: { id?: number | null; name: string; price_delta_cents: number }[] | null;
  note: string | null;
  status: 'SENT' | 'PREPARING' | 'READY';
  station_id: number | null;
  fired_at: string | null;
  station_start_at: string | null;
  started_at: string | null;
  ready_at: string | null;
  table_id: number | null;
  table_name: string | null;
  /** Quando il tavolo ha aperto: la testata della card è l'inizio del binario. */
  order_opened_at: string | null;
  customer_name: string | null;
  /** Chi ha preso la comanda: la card del monitor lo mostra. */
  opened_by_name: string | null;
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

/** Riga di un'ALTRA partita sulla stessa uscita: sola lettura, per il
 *  pacing («quanto manca alla griglia prima che io cali la pasta?»). */
export interface KdsOtherItem {
  id: number;
  order_id: number;
  course_no: number;
  station_id: number | null;
  name_snapshot: string;
  qty: number;
  status: 'SENT' | 'PREPARING' | 'READY';
}

/** Riga della comanda intera per la card a binario: tutte le uscite delle
 *  comande a schermo, servite e future comprese, con la partita addosso. */
export interface KdsFullItem {
  id: number;
  order_id: number;
  course_no: number;
  station_id: number | null;
  name_snapshot: string;
  qty: number;
  modifiers: { id?: number | null; name: string; price_delta_cents: number }[] | null;
  note: string | null;
  status: 'QUEUED' | 'SENT' | 'PREPARING' | 'READY' | 'SERVED';
  fired_at: string | null;
  station_start_at: string | null;
  ready_at: string | null;
  served_at: string | null;
}

/** Una riga ancora da cucinare per questa partita nel servizio — comprese le
 *  uscite non ancora chiamate di comande fuori dalla coda a schermo. La barra
 *  dei piatti raggruppati si costruisce da qui. */
export interface KdsComingItem {
  name_snapshot: string;
  qty: number;
  status: 'QUEUED' | 'SENT' | 'PREPARING';
  station_start_at: string | null;
  course_no: number;
  /** Il tocco sul chip apre «dove va questo piatto»: serve il tavolo. */
  table_name: string | null;
}

export interface KdsQueue {
  station_id: number | null;
  items: KdsItem[];
  courses: KdsCourseState[];
  /** Presente solo col filtro partita; vuoto sul monitor senza partita. */
  others?: KdsOtherItem[];
  full?: KdsFullItem[];
  coming?: KdsComingItem[];
}

export const getKdsQueue = async (stationId: number | null): Promise<KdsQueue> =>
  apiRequest<KdsQueue>(
    `${API_URL}/kds/queue${stationId != null ? `?station_id=${stationId}` : ''}`,
    { headers: getHeaders() },
  );

/** Uscita servita, per lo schermo «Consegnate» (consultazione). Le righe
 *  portano la partita: il monitor mostra le proprie in chiaro e quelle
 *  delle altre attenuate — la comanda servita si legge intera. */
export interface KdsServedCourse {
  order_id: number;
  course_no: number;
  table_name: string | null;
  customer_name: string | null;
  served_at: string;
  items: { name: string; qty: number; station_id: number | null }[];
}

export const getKdsServed = async (stationId: number | null): Promise<{ courses: KdsServedCourse[] }> =>
  apiRequest<{ courses: KdsServedCourse[] }>(
    `${API_URL}/kds/served${stationId != null ? `?station_id=${stationId}` : ''}`,
    { headers: getHeaders() },
  );

// Revisioni comanda: modifiche a comande già lanciate (storno, aggiunta,
// riporta, trasferimento). Il monitor mostra "modificata" finché qualcuno
// non conferma con l'ack, che spegne l'avviso su tutti gli schermi.
export interface OrderRevision {
  id: number;
  order_id: number;
  course_no: number | null;
  station_ids: number[] | null;
  kind: 'void' | 'added' | 'unserved' | 'transfer';
  summary: string;
  details: { label: string; note?: string | null }[] | null;
  created_by_name: string;
  created_at: string;
}

export const getKdsRevisions = async (stationId: number | null): Promise<{ revisions: OrderRevision[] }> =>
  apiRequest(
    `${API_URL}/kds/revisions${stationId != null ? `?station=${stationId}` : ''}`,
    { headers: getHeaders() },
  );

export const ackKdsRevision = async (id: number): Promise<{ ok: true }> =>
  apiRequest(`${API_URL}/kds/revisions/${id}/ack`, {
    method: 'POST',
    headers: getHeaders(),
  });

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
  /** Righe già pronte della partita: l'avanzamento parziale (2/3). */
  ready_items: number;
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
  /** Uscite servite negli ultimi minuti: il cestino da cui si riporta. */
  servite: {
    order_id: number;
    course_no: number;
    served_at: string;
    items: number;
    table_name: string | null;
  }[];
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

/** L'uscita lascia il passe: tutte le righe pronte diventano servite. */
export const serveCourse = async (orderId: number, courseNo: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/serve`, {
    method: 'POST', headers: getHeaders(),
  });

/** Il ripensamento del servito: l'uscita torna pronta al passe. */
export const unserveCourse = async (orderId: number, courseNo: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/unserve`, {
    method: 'POST', headers: getHeaders(),
  });

/** Disfa una comanda intonsa (aperta e abbandonata senza battere nulla).
 *  Il server rifiuta con 409 qualunque comanda non vuota: chiamarla è
 *  sempre sicuro, decide la guardia. */
export const deleteEmptyOrder = async (orderId: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}`, { method: 'DELETE', headers: getHeaders() });

/** Un evento della vita della comanda, per la timeline (consultazione). */
export type OrderTimelineEvent =
  | { kind: 'opened'; at: string; by: string | null }
  | { kind: 'course_fired'; at: string; course_no: number }
  | { kind: 'course_started'; at: string; course_no: number }
  | { kind: 'course_ready'; at: string; course_no: number; sync_delta_s: number }
  | { kind: 'course_served'; at: string; course_no: number; lamp_s: number | null }
  | { kind: 'revision'; at: string; revision_kind: string; summary: string; by: string; course_no: number | null };

export const getOrderTimeline = async (orderId: number): Promise<{
  order: { id: number; table_name: string | null; customer_name: string | null; opened_by_name: string | null };
  events: OrderTimelineEvent[];
}> =>
  apiRequest(`${API_URL}/orders/${orderId}/timeline`, { headers: getHeaders() });

/** La campanella della cucina: avvisa la sala che l'uscita è pronta al
 *  ritiro (annuncio nel canale sala della chat staff). Non muove lo stato. */
export const callWaiterForCourse = async (orderId: number, courseNo: number): Promise<unknown> =>
  apiRequest(`${API_URL}/orders/${orderId}/courses/${courseNo}/call-waiter`, {
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
    // Totali derivati aggiunti dalla chiusura per mostrare subito l'acconto.
    paid_cents?: number;
    deposit_credit_cents?: number;
    deposit_paid_cents?: number;
    refund_due_cents?: number;
    residual_cents?: number;
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
  payload: { covers?: number; notes?: string | null; reservation_id?: number | null },
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
  /** Da uscita tutta pronta a servita: il tempo vero sotto la lampada. */
  ritiro: { uscite: number; attesa_media_min: string | null; attesa_massima_min: string | null };
  scarti: { motivo: string | null; righe: number; valore_cents: number }[];
}

export const getKitchenReport = async (from?: string, to?: string): Promise<KitchenReport> => {
  const q = new URLSearchParams();
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  const qs = q.toString();
  return apiRequest<KitchenReport>(`${API_URL}/reports/kitchen${qs ? `?${qs}` : ''}`, { headers: getHeaders() });
};

/** Conto attivo del servizio, come lo restituisce /tables/bills-status. */
export interface ServiceBill {
  id: number;
  table_id: number;
  table_name: string | null;
  total_cents: number;
  covers: number;
  status: string;
  share_token: string | null;
  items: { order_item_id?: number; name: string; qty: number; unit_price_cents: number }[] | null;
  paid_cents: number;
  /** Acconto già versato sulla prenotazione, portato nel conto. Già in paid_cents. */
  deposit_credit_cents?: number;
  /** Acconto TOTALE versato (importo pieno), a prescindere da quanto assorbito. */
  deposit_paid_cents?: number;
  /** Da rimborsare al cliente quando l'acconto supera il totale del conto. */
  refund_due_cents?: number;
  /** Contanti già registrati sul conto (chiusura in cassa). */
  cash_settled_cents?: number;
  /** "pp:comanda:<id>" quando il conto nasce da una comanda Passepartout. */
  external_ref?: string | null;
  residual_cents: number;
  open_orders: number;
}
