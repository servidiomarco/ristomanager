import { Reservation, Table, Room, Dish, BanquetMenu, BanquetPayment, TableMerge, TableHiddenOverride, RoomClosedOverride, Shift, Customer, InventoryArea, InventoryLocation, InventoryProduct, InventoryStockRow, InventoryMovement, InventoryMovementReason, InventoryCategory, PaymentRequest, TableAssignmentSuggestion } from '../types';
import { socketClient } from './socketClient';
import { authApiService } from './authApiService';
import { buildApiError } from './apiError';
import { offlineQueue } from './offlineQueue';

// Use import.meta.env for Vite frontend environment variables
const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// Helper function to get headers with socket ID and auth token
const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  // Add socket ID to prevent duplicate broadcasts
  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }

  // Add authorization header
  const token = authApiService.getAccessToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  return headers;
};

// Fetch with automatic token refresh on 401
const fetchWithAuth = async (
  url: string,
  options: RequestInit = {},
  retried = false
): Promise<Response> => {
  const response = await fetch(url, options);

  // If unauthorized and not already retried, try to refresh token
  if (response.status === 401 && !retried) {
    console.log('Token expired, attempting refresh...');
    const refreshed = await authApiService.refreshToken();

    if (refreshed) {
      console.log('Token refreshed successfully, retrying request...');
      // Update the authorization header with new token
      const newHeaders = { ...options.headers } as Record<string, string>;
      newHeaders['Authorization'] = `Bearer ${refreshed.accessToken}`;

      // Retry the request with new token
      return fetchWithAuth(url, { ...options, headers: newHeaders }, true);
    }
    // If refresh failed, the authApiService will trigger session expired
  }

  return response;
};

// Scritture che possono aspettare la rete: chi passa `offline` accetta che,
// se il server non è mai stato raggiunto, la richiesta finisca in coda e
// venga rigiocata al riconnettersi. Va passato SOLO su richieste sicure da
// rigiocare: PUT e DELETE, o POST con chiave di idempotenza nel body.
type OfflineSpec = { description: string };

// Helper to make authenticated requests with error handling
const apiRequest = async <T>(
  url: string,
  options: RequestInit & { offline?: OfflineSpec } = {},
  expectJson = true
): Promise<T> => {
  const { offline, ...init } = options;
  let response: Response;
  try {
    // Bypass the browser HTTP cache by default. iOS Safari in PWA mode can
    // otherwise serve stale GET responses after the app is backgrounded.
    // Callers can still override by passing an explicit `cache` option.
    response = await fetchWithAuth(url, { cache: 'no-store', ...init });
  } catch (err) {
    // fetch rifiuta solo quando il server non è mai stato raggiunto: è
    // l'unico caso in cui accodare è onesto — su una risposta HTTP il
    // server ha già deciso e la coda non deve ricontestarla.
    const method = (init.method ?? 'GET').toUpperCase();
    if (offline && (method === 'PUT' || method === 'DELETE' || method === 'POST')) {
      offlineQueue.enqueue({
        method: method as 'PUT' | 'DELETE' | 'POST',
        url,
        body: typeof init.body === 'string' ? init.body : null,
        description: offline.description,
      });
      throw buildApiError(0, {
        error: `Sei offline: «${offline.description}» è in coda e partirà appena torna la rete`,
        queued: true,
      });
    }
    throw err;
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }

  if (expectJson) {
    return response.json();
  }

  return undefined as T;
};

// Finestra opzionale (estremi inclusi, giorni Europe/Rome): il boot carica
// prima i giorni recenti, lo storico arriva in background subito dopo.
export const getReservations = async (range?: { from?: string; to?: string }): Promise<Reservation[]> => {
  const params = new URLSearchParams();
  if (range?.from) params.set('from', range.from);
  if (range?.to) params.set('to', range.to);
  const qs = params.toString();
  return apiRequest<Reservation[]>(`${API_URL}/reservations${qs ? `?${qs}` : ''}`, {
    headers: getHeaders(false)
  });
};

export const createReservation = async (reservation: Omit<Reservation, 'id'>): Promise<Reservation> => {
  return apiRequest<Reservation>(`${API_URL}/reservations`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(reservation),
  });
};

export const updateReservation = async (id: number, reservation: Partial<Reservation>): Promise<Reservation> => {
  return apiRequest<Reservation>(`${API_URL}/reservations/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(reservation),
    // Check-in, cambio stato, assegnazione tavolo: il flusso della reception
    // durante il servizio. PUT idempotente → sicuro da rigiocare.
    offline: { description: `aggiornamento della prenotazione ${id}` },
  });
};

export const deleteReservation = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/reservations/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
    offline: { description: `cancellazione della prenotazione ${id}` },
  }, false);
};

export const swapReservationTables = async (
  aId: number,
  bId: number,
): Promise<{ a: Reservation; b: Reservation }> => {
  return apiRequest<{ a: Reservation; b: Reservation }>(
    `${API_URL}/reservations/${aId}/swap-table`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ other_id: bId }),
    },
  );
};

export const getTables = async (): Promise<Table[]> => {
  return apiRequest<Table[]>(`${API_URL}/tables`, {
    headers: getHeaders(false)
  });
};

export const createTable = async (table: Omit<Table, 'id'>): Promise<Table> => {
  return apiRequest<Table>(`${API_URL}/tables`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(table),
  });
};

export const updateTable = async (id: number, table: Partial<Table>): Promise<Table> => {
  console.log('apiService.updateTable - Sending to backend:', id, 'Data:', JSON.stringify(table, null, 2));

  const result = await apiRequest<Table>(`${API_URL}/tables/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(table),
    // Lo stato del tavolo cambia dal palmare in sala: PUT idempotente,
    // sicuro da rigiocare al riconnettersi.
    offline: { description: `aggiornamento del tavolo ${id}` },
  });

  console.log('apiService.updateTable - Backend returned:', JSON.stringify(result, null, 2));
  return result;
};

export const deleteTable = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/tables/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

// ============================================
// PER-SHIFT TABLE MERGES
// ============================================

export const getTableMerges = async (date: string, shift: Shift): Promise<TableMerge[]> => {
  const params = new URLSearchParams({ date, shift });
  return apiRequest<TableMerge[]>(`${API_URL}/table-merges?${params.toString()}`, {
    headers: getHeaders(false),
  });
};

export const createTableMerge = async (
  date: string,
  shift: Shift,
  primary_id: number,
  merged_ids: number[]
): Promise<TableMerge> => {
  return apiRequest<TableMerge>(`${API_URL}/table-merges`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, primary_id, merged_ids }),
  });
};

export const deleteTableMerge = async (
  date: string,
  shift: Shift,
  primary_id: number
): Promise<void> => {
  return apiRequest<void>(`${API_URL}/table-merges`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, primary_id }),
  }, false);
};

// ============================================
// TABLE ASSIGNMENT AI — proposte (card dev board #26)
// ============================================

export const getTableAssignmentSuggestions = async (): Promise<TableAssignmentSuggestion[]> => {
  return apiRequest<TableAssignmentSuggestion[]>(`${API_URL}/table-assignment-suggestions`, {
    headers: getHeaders(false),
  });
};

export const confirmTableAssignmentSuggestion = async (id: number): Promise<{ reservation: Reservation; merge: TableMerge | null }> => {
  return apiRequest(`${API_URL}/table-assignment-suggestions/${id}/confirm`, {
    method: 'POST',
    headers: getHeaders(),
  });
};

export const dismissTableAssignmentSuggestion = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/table-assignment-suggestions/${id}/dismiss`, {
    method: 'POST',
    headers: getHeaders(),
  }, false);
};

// ============================================
// PER-SHIFT HIDDEN TABLES
// ============================================

export const getTableHidden = async (
  date?: string,
  shift?: Shift,
  scope?: 'future' | 'all'
): Promise<TableHiddenOverride[]> => {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (shift) params.set('shift', shift);
  if (scope === 'all') params.set('scope', 'all');
  const qs = params.toString();
  return apiRequest<TableHiddenOverride[]>(`${API_URL}/table-hidden${qs ? '?' + qs : ''}`, {
    headers: getHeaders(false),
  });
};

export const createTableHidden = async (
  date: string,
  shift: Shift,
  table_id: number
): Promise<TableHiddenOverride> => {
  return apiRequest<TableHiddenOverride>(`${API_URL}/table-hidden`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, table_id }),
  });
};

export const deleteTableHidden = async (
  date: string,
  shift: Shift,
  table_id: number
): Promise<void> => {
  return apiRequest<void>(`${API_URL}/table-hidden`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, table_id }),
  }, false);
};

// ============================================
// PER-SHIFT ROOM CLOSURE
// ============================================

// When date+shift are supplied, returns overrides for that (date, shift).
// When both are omitted, returns future overrides ordered by (date, shift) —
// used by the "Chiusure programmate" panel.
export const getRoomClosed = async (
  date?: string,
  shift?: Shift,
  scope?: 'future' | 'all'
): Promise<RoomClosedOverride[]> => {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  if (shift) params.set('shift', shift);
  if (scope === 'all') params.set('scope', 'all');
  const qs = params.toString();
  return apiRequest<RoomClosedOverride[]>(`${API_URL}/room-closed${qs ? '?' + qs : ''}`, {
    headers: getHeaders(false),
  });
};

export const createRoomClosed = async (
  date: string,
  shift: Shift,
  room_id: number
): Promise<RoomClosedOverride> => {
  return apiRequest<RoomClosedOverride>(`${API_URL}/room-closed`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, room_id }),
  });
};

export const deleteRoomClosed = async (
  date: string,
  shift: Shift,
  room_id: number
): Promise<void> => {
  return apiRequest<void>(`${API_URL}/room-closed`, {
    method: 'DELETE',
    headers: getHeaders(),
    body: JSON.stringify({ date, shift, room_id }),
  }, false);
};

export const getRooms = async (): Promise<Room[]> => {
  return apiRequest<Room[]>(`${API_URL}/rooms`, {
    headers: getHeaders(false)
  });
};

export const createRoom = async (room: Omit<Room, 'id'>): Promise<Room> => {
  return apiRequest<Room>(`${API_URL}/rooms`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(room),
  });
};

export const setRoomClosed = async (id: number, is_closed: boolean): Promise<Room> => {
  return apiRequest<Room>(`${API_URL}/rooms/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ is_closed }),
  });
};

export const deleteRoom = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/rooms/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export const getDishes = async (): Promise<Dish[]> => {
  return apiRequest<Dish[]>(`${API_URL}/dishes`, {
    headers: getHeaders(false)
  });
};

export const createDish = async (dish: Omit<Dish, 'id'>): Promise<Dish> => {
  return apiRequest<Dish>(`${API_URL}/dishes`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(dish),
  });
};

export const updateDish = async (id: number, dish: Partial<Dish>): Promise<Dish> => {
  return apiRequest<Dish>(`${API_URL}/dishes/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(dish),
  });
};

export const deleteDish = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/dishes/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

/** Esito del sync menu dalla cassa Passepartout (feature 'passepartout'). */
export interface MenuImportResult {
  totale_cassa: number;
  importabili: number;
  creati: number;
  aggiornati: number;
  disattivati: number;
  /** Gruppi varianti sincronizzati (set distinti di varianti della cassa). */
  gruppi_varianti?: number;
}

/** Sincronizza l'anagrafica piatti col catalogo della cassa. Il server
 *  broadcasta 'dish:synced': la lista si aggiorna via socket, la risposta
 *  serve solo a raccontare l'esito. */
export const importMenuPassepartout = async (): Promise<MenuImportResult> => {
  return apiRequest<MenuImportResult>(`${API_URL}/menu/import/passepartout`, {
    method: 'POST',
    headers: getHeaders(false),
  });
};

/** URL pubblico del menu digitale (pagina servita dal backend, come /prenota). */
export const digitalMenuUrl = (): string => `${API_URL}/menu`;

export interface MenuTranslateResult {
  tradotte: number;
  lingue: string[];
  tokens: number;
}

/** Traduce con l'AI le voci del menu che non hanno ancora una traduzione
 *  (piatti attivi + categorie, en/fr/de). Idempotente. */
export const translateMenu = async (): Promise<MenuTranslateResult> => {
  return apiRequest<MenuTranslateResult>(`${API_URL}/menu/translate`, {
    method: 'POST',
    headers: getHeaders(false),
  });
};

export const getBanquetMenus = async (): Promise<BanquetMenu[]> => {
  return apiRequest<BanquetMenu[]>(`${API_URL}/banquet-menus`, {
    headers: getHeaders(false)
  });
};

export const createBanquetMenu = async (menu: Omit<BanquetMenu, 'id'>): Promise<BanquetMenu> => {
  return apiRequest<BanquetMenu>(`${API_URL}/banquet-menus`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(menu),
  });
};

export const updateBanquetMenu = async (id: number, menu: Partial<BanquetMenu>): Promise<BanquetMenu> => {
  return apiRequest<BanquetMenu>(`${API_URL}/banquet-menus/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(menu),
  });
};

export const deleteBanquetMenu = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/banquet-menus/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

// ============================================
// BANQUET PAYMENTS
// ============================================

export const getBanquetPayments = async (banquetId: number): Promise<BanquetPayment[]> => {
  return apiRequest<BanquetPayment[]>(`${API_URL}/banquet-menus/${banquetId}/payments`, {
    headers: getHeaders(false),
  });
};

export const createBanquetPayment = async (
  banquetId: number,
  payment: Omit<BanquetPayment, 'id' | 'banquet_id' | 'created_at' | 'created_by_user_id' | 'created_by_user_name'>
): Promise<BanquetPayment> => {
  return apiRequest<BanquetPayment>(`${API_URL}/banquet-menus/${banquetId}/payments`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(payment),
  });
};

export const deleteBanquetPayment = async (banquetId: number, paymentId: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/banquet-menus/${banquetId}/payments/${paymentId}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

// ============================================
// CUSTOMERS (rubrica)
// ============================================

export const getCustomers = async (search?: string): Promise<Customer[]> => {
  const url = search && search.trim()
    ? `${API_URL}/customers?q=${encodeURIComponent(search.trim())}`
    : `${API_URL}/customers`;
  return apiRequest<Customer[]>(url, {
    headers: getHeaders(false),
  });
};

export const createCustomer = async (customer: Omit<Customer, 'id'>): Promise<Customer> => {
  return apiRequest<Customer>(`${API_URL}/customers`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(customer),
  });
};

export const updateCustomer = async (id: number, customer: Partial<Customer>): Promise<Customer> => {
  return apiRequest<Customer>(`${API_URL}/customers/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(customer),
  });
};

export const deleteCustomer = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/customers/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export interface CustomerDuplicateGroup {
  key: string;
  customers: Customer[];
}

export const getCustomerDuplicates = async (): Promise<{ groups: CustomerDuplicateGroup[] }> => {
  return apiRequest<{ groups: CustomerDuplicateGroup[] }>(`${API_URL}/customers/duplicates`, {
    headers: getHeaders(false),
  });
};

export const mergeCustomers = async (sourceId: number, targetId: number): Promise<Customer> => {
  return apiRequest<Customer>(`${API_URL}/customers/${sourceId}/merge-into/${targetId}`, {
    method: 'POST',
    headers: getHeaders(),
  });
};

// ============================================
// PAYMENT REQUESTS (Revolut hosted checkout)
// ============================================

export const getPaymentRequests = async (reservationId: number): Promise<PaymentRequest[]> => {
  return apiRequest<PaymentRequest[]>(`${API_URL}/payments/requests?reservation_id=${reservationId}`, {
    headers: getHeaders(false),
  });
};

export const createPaymentRequest = async (
  input: { reservation_id: number; amount: number; description?: string; channel?: 'email' | 'whatsapp' | 'sms' }
): Promise<PaymentRequest> => {
  return apiRequest<PaymentRequest>(`${API_URL}/payments/requests`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });
};

// Card #28 — revoca manuale di un link inviato (solo PENDING/AUTHORISED,
// mai quote del conto al tavolo). 409 se il pagamento è già chiuso.
export const revokePaymentRequest = async (
  paymentRequestId: number
): Promise<{ ok: true; payment_request: PaymentRequest }> => {
  return apiRequest<{ ok: true; payment_request: PaymentRequest }>(`${API_URL}/payments/${paymentRequestId}/revoke`, {
    method: 'POST',
    headers: getHeaders(),
  });
};

// ============================================
// OUTBOUND MESSAGES (SMS / WhatsApp log)
// ============================================

export interface OutboundMessage {
  id: number;
  provider: string;
  channel: 'sms' | 'whatsapp' | 'email';
  // Inbound rows (email replies received via IMAP, incoming SMS/WhatsApp)
  // set direction='inbound' and leave to_* NULL; outbound rows leave from_* NULL.
  direction: 'outbound' | 'inbound';
  to_phone: string | null;
  to_email: string | null;
  from_email: string | null;
  subject: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  reservation_id: number | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

// Reminder manuale della prenotazione: WhatsApp col template approvato,
// SMS finché non lo è (decide il server). Ritorna il canale usato davvero.
export const sendReservationReminder = async (
  reservationId: number
): Promise<{ ok: true; channel: 'whatsapp' | 'sms' }> => {
  return apiRequest(`${API_URL}/reservations/${reservationId}/send-reminder`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({}),
  });
};

export const getReservationMessages = async (reservationId: number): Promise<OutboundMessage[]> => {
  const response = await apiRequest<{ items: OutboundMessage[] }>(
    `${API_URL}/reservations/${reservationId}/messages`,
    { headers: getHeaders(false) }
  );
  return response.items;
};

// ============================================
// INVENTORY
// ============================================

export const getInventoryLocations = async (area?: InventoryArea): Promise<InventoryLocation[]> => {
  const url = area ? `${API_URL}/inventory/locations?area=${area}` : `${API_URL}/inventory/locations`;
  return apiRequest<InventoryLocation[]>(url, { headers: getHeaders(false) });
};

export const createInventoryLocation = async (loc: { area: InventoryArea; name: string; sort_order?: number }): Promise<InventoryLocation> => {
  return apiRequest<InventoryLocation>(`${API_URL}/inventory/locations`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(loc),
  });
};

export const updateInventoryLocation = async (id: number, loc: { name: string; sort_order?: number }): Promise<InventoryLocation> => {
  return apiRequest<InventoryLocation>(`${API_URL}/inventory/locations/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(loc),
  });
};

export const deleteInventoryLocation = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/inventory/locations/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export const getInventoryCategories = async (area?: InventoryArea): Promise<InventoryCategory[]> => {
  const url = area ? `${API_URL}/inventory/categories?area=${area}` : `${API_URL}/inventory/categories`;
  return apiRequest<InventoryCategory[]>(url, { headers: getHeaders(false) });
};

export const createInventoryCategory = async (cat: { area: InventoryArea; name: string; sort_order?: number }): Promise<InventoryCategory> => {
  return apiRequest<InventoryCategory>(`${API_URL}/inventory/categories`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(cat),
  });
};

export const updateInventoryCategory = async (id: number, cat: { name: string; sort_order?: number }): Promise<InventoryCategory> => {
  return apiRequest<InventoryCategory>(`${API_URL}/inventory/categories/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(cat),
  });
};

export const deleteInventoryCategory = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/inventory/categories/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export const getInventoryProducts = async (area?: InventoryArea): Promise<InventoryProduct[]> => {
  const url = area ? `${API_URL}/inventory/products?area=${area}` : `${API_URL}/inventory/products`;
  return apiRequest<InventoryProduct[]>(url, { headers: getHeaders(false) });
};

export const createInventoryProduct = async (prod: { area: InventoryArea; name: string; unit?: string | null; notes?: string | null; category_id?: number | null }): Promise<InventoryProduct> => {
  return apiRequest<InventoryProduct>(`${API_URL}/inventory/products`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(prod),
  });
};

export const updateInventoryProduct = async (id: number, prod: { name: string; unit?: string | null; notes?: string | null; category_id?: number | null }): Promise<InventoryProduct> => {
  return apiRequest<InventoryProduct>(`${API_URL}/inventory/products/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(prod),
  });
};

export const deleteInventoryProduct = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/inventory/products/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export const getInventoryStock = async (area?: InventoryArea): Promise<InventoryStockRow[]> => {
  const url = area ? `${API_URL}/inventory/stock?area=${area}` : `${API_URL}/inventory/stock`;
  return apiRequest<InventoryStockRow[]>(url, { headers: getHeaders(false) });
};

export interface LowStockItem {
  id: number;
  area: InventoryArea;
  name: string;
  unit: string | null;
  category_id: number | null;
  category_name: string | null;
  total_quantity: number;
}

export const getLowStockInventory = async (area?: InventoryArea): Promise<{ threshold: number; items: LowStockItem[] }> => {
  const url = area ? `${API_URL}/inventory/low-stock?area=${area}` : `${API_URL}/inventory/low-stock`;
  return apiRequest<{ threshold: number; items: LowStockItem[] }>(url, { headers: getHeaders(false) });
};

export const postInventoryMovement = async (move: {
  product_id: number;
  location_id: number;
  delta: number;
  reason: InventoryMovementReason;
  notes?: string | null;
}): Promise<{ movement: InventoryMovement; stock: InventoryStockRow }> => {
  return apiRequest<{ movement: InventoryMovement; stock: InventoryStockRow }>(`${API_URL}/inventory/movements`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(move),
  });
};

// `status_changed` is true when the backend flipped the reservation from
// PENDING to CONFIRMED as part of this confirmation send. The UI uses it to
// contextualise the toast ("Prenotazione confermata e SMS inviato").
// `reservation` echoes back the freshly promoted row so the originating
// client can patch its cache without relying on the socket broadcast
// (mobile Safari on shaky wifi was dropping the event, leaving the card
// stuck on "Da confermare" even after the send succeeded).
export interface ConfirmationSendResult {
  success: boolean;
  message: string;
  channel?: string;
  status_changed?: boolean;
  reservation?: Reservation;
}

export const sendWhatsAppConfirmation = async (
  reservationId: number,
  channel?: 'sms' | 'whatsapp',
): Promise<ConfirmationSendResult> => {
  const qs = channel ? `?channel=${channel}` : '';
  return apiRequest<ConfirmationSendResult>(
    `${API_URL}/reservations/${reservationId}/confirm-whatsapp${qs}`,
    {
      method: 'POST',
      headers: getHeaders(),
    },
  );
};

export const sendEmailConfirmation = async (
  reservationId: number,
): Promise<ConfirmationSendResult> => {
  return apiRequest<ConfirmationSendResult>(
    `${API_URL}/reservations/${reservationId}/confirm-email`,
    {
      method: 'POST',
      headers: getHeaders(),
    },
  );
};

// Free-form email to the reservation's email address. Subject + body are
// staff-composed; the server wraps them in the branded template and logs the
// send into outbound_messages so it shows up in the customer timeline.
export const sendCustomEmail = async (
  reservationId: number,
  subject: string,
  body: string,
): Promise<{ success: boolean; message: string; channel?: string }> => {
  return apiRequest<{ success: boolean; message: string; channel?: string }>(
    `${API_URL}/reservations/${reservationId}/send-custom-email`,
    {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ subject, body }),
    },
  );
};

// ============================================
// OPENING HOURS & SPECIAL CLOSURES
// ============================================

export interface OpeningHoursRow {
  weekday: number;
  lunch_open: string | null;
  lunch_close: string | null;
  dinner_open: string | null;
  dinner_close: string | null;
  slot_minutes: number;
  disabled_lunch_slots: string[];
  disabled_dinner_slots: string[];
}

export interface SpecialClosure {
  id: number;
  date: string;
  shift: Shift | null;
  reason: string | null;
}

export const getOpeningHours = async (): Promise<OpeningHoursRow[]> => {
  return apiRequest<OpeningHoursRow[]>(`${API_URL}/opening-hours`, {
    headers: getHeaders(false),
  });
};

export const updateOpeningHours = async (
  weekday: number,
  data: Omit<OpeningHoursRow, 'weekday'>
): Promise<OpeningHoursRow> => {
  return apiRequest<OpeningHoursRow>(`${API_URL}/opening-hours/${weekday}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(data),
  });
};

export const getClosures = async (fromDate?: string): Promise<SpecialClosure[]> => {
  const qs = fromDate ? `?from=${encodeURIComponent(fromDate)}` : '';
  return apiRequest<SpecialClosure[]>(`${API_URL}/closures${qs}`, {
    headers: getHeaders(false),
  });
};

export const createClosure = async (closure: { date: string; shift: Shift | null; reason?: string | null }): Promise<SpecialClosure> => {
  return apiRequest<SpecialClosure>(`${API_URL}/closures`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(closure),
  });
};

export const deleteClosure = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/closures/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
};

export interface FeatureFlags {
  public_bookings_enabled: boolean;
  voice_agent_enabled: boolean;
  voice_bookings_suspended: boolean;
  /** Doppio turno voce: secondo giro sullo stesso tavolo nello stesso shift. */
  voice_double_seating_enabled: boolean;
  pay_at_table_enabled: boolean;
  table_orders_enabled: boolean;
  /** Risposte suggerite ai messaggi dei clienti. */
  ai_messages_enabled: boolean;
  /** Menu digitale pubblico (QR al tavolo). Gestito dal QR modal della pagina Menu. */
  digital_menu_enabled: boolean;
  /** Postazione passe. Spenta: la pagina Passe sparisce e i verbi
   *  chiama/servito passano alla comanda del cameriere. */
  passe_enabled: boolean;
}

export const getFeatureFlags = async (): Promise<FeatureFlags> => {
  return apiRequest<FeatureFlags>(`${API_URL}/settings/features`, {
    headers: getHeaders(false),
  });
};

export const updateFeatureFlags = async (updates: Partial<FeatureFlags>): Promise<FeatureFlags> => {
  return apiRequest<FeatureFlags>(`${API_URL}/settings/features`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// Per-channel settings — numeric or free-text (HH:MM). Kept separate from
// FeatureFlags so the booleans stay boolean; add new fields here when a
// channel gains editable knobs beyond enabled/disabled.
export interface ScheduledSuspension {
  date: string;       // YYYY-MM-DD (Europe/Rome)
  start_time: string; // HH:MM
  end_time: string;   // HH:MM (> start_time, same day)
  // Time Sofia announces to the caller ("richiamare dopo le HH:MM"). Optional
  // for back-compat with rows saved before the field existed; when missing the
  // backend falls back to end_time.
  callback_time?: string; // HH:MM
}
// Blocca le prenotazioni web per uno specifico turno o per l'intera giornata.
// L'operatore edita da Impostazioni → Prenotazioni web; il backend rifiuta
// le POST /public/reservations che ricadono in un blocco e nasconde gli
// slot corrispondenti dalla GET /public/availability.
export interface PublicBookingBlock {
  date: string;                             // YYYY-MM-DD (Europe/Rome)
  shift: 'LUNCH' | 'DINNER' | 'ALL';        // ALL = intera giornata
}
// Limite di occupazione per sala applicato SOLO ai canali self-service
// (agente vocale + modulo /prenota). Quando l'occupazione della sala
// raggiunge `percent`, quei canali smettono di proporla; lo staff continua a
// prenotarla normalmente dal gestionale. Le sale senza voce in questo array
// non hanno limiti.
export type OccupancyBasis = 'TABLES' | 'SEATS';
export interface RoomOccupancyCap {
  room_id: number;
  percent: number;              // 1-100
  basis: OccupancyBasis;        // TABLES = tavoli, SEATS = coperti
}
// Blocca l'agente vocale sulla *data richiesta* dal cliente (es. festività a
// menù fisso gestite a mano): Sofia resta attiva per tutte le altre date, ma
// per quella invita a richiamare negli orari indicati per parlare con un
// operatore. Diverso dalle sospensioni programmate, che silenziano Sofia
// mentre la finestra è in corso.
export interface VoiceDateBlock {
  date: string;                             // YYYY-MM-DD (Europe/Rome)
  shift: 'LUNCH' | 'DINNER' | 'ALL';        // ALL = intera giornata
  // Testo libero letto da Sofia ("dalle 9:00 alle 12:00"); se assente dice
  // "negli orari di apertura del ristorante".
  callback_hours?: string;
}
export interface ChannelSettings {
  voice_large_group_threshold: number;
  voice_bookings_suspension_callback_time: string;
  voice_bookings_suspension_schedule: ScheduledSuspension[];
  public_bookings_blocks: PublicBookingBlock[];
  voice_bookings_date_blocks: VoiceDateBlock[];
  room_occupancy_caps: RoomOccupancyCap[];
  // Messaggio iniziale di Sofia; '' = default di sistema. {nome} → nome del
  // chiamante quando noto.
  voice_first_message: string;
}

// Occupazione corrente per sala, mostrata accanto al limite in Impostazioni.
export interface RoomOccupancyShift {
  used_tables: number;
  used_seats: number;
  percent_tables: number;
  percent_seats: number;
  at_cap: boolean;
  closed_for_shift: boolean;
}
export interface RoomOccupancyRow {
  room_id: number;
  room_name: string;
  is_closed: boolean;
  capacity_tables: number;
  capacity_seats: number;
  lunch: RoomOccupancyShift;
  dinner: RoomOccupancyShift;
}

export const getRoomsOccupancy = async (date?: string): Promise<{ date: string; rooms: RoomOccupancyRow[] }> => {
  const qs = date ? `?date=${encodeURIComponent(date)}` : '';
  return apiRequest<{ date: string; rooms: RoomOccupancyRow[] }>(`${API_URL}/settings/rooms-occupancy${qs}`, {
    headers: getHeaders(false),
  });
};

export const getChannelSettings = async (): Promise<ChannelSettings> => {
  return apiRequest<ChannelSettings>(`${API_URL}/settings/channels`, {
    headers: getHeaders(false),
  });
};

export const updateChannelSettings = async (updates: Partial<ChannelSettings>): Promise<ChannelSettings> => {
  return apiRequest<ChannelSettings>(`${API_URL}/settings/channels`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// ============================================
// INTEGRATION SETTINGS (Revolut)
// ============================================
export type RevolutEnvironment = 'sandbox' | 'production';

export interface RevolutIntegrationStatus {
  environment: RevolutEnvironment;
  api_base: string;
  api_version: string;
  has_api_key: boolean;
  has_webhook_secret: boolean;
  api_key_last4: string | null;
  webhook_secret_last4: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export interface RevolutIntegrationUpdate {
  environment?: RevolutEnvironment;
  api_key?: string;
  webhook_secret?: string;
  api_version?: string;
}

export const getRevolutIntegration = async (): Promise<RevolutIntegrationStatus> => {
  return apiRequest<RevolutIntegrationStatus>(`${API_URL}/settings/integrations/revolut`, {
    headers: getHeaders(false),
  });
};

export const updateRevolutIntegration = async (
  updates: RevolutIntegrationUpdate
): Promise<RevolutIntegrationStatus> => {
  return apiRequest<RevolutIntegrationStatus>(`${API_URL}/settings/integrations/revolut`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// ============================================
// INTEGRATION SETTINGS (SumUp)
// ============================================
export type SumUpEnvironment = 'sandbox' | 'production';
export type PaymentProviderId = 'revolut' | 'sumup';

export interface SumUpIntegrationStatus {
  // Which credential pair is live. SumUp serves sandbox and production from
  // the same host, so this selects the key/merchant-code pair rather than a
  // base URL — both pairs stay saved.
  environment: SumUpEnvironment;
  api_base: string;
  // True when the ACTIVE environment has both a key and a merchant code.
  configured: boolean;
  has_api_key: boolean;
  has_merchant_code: boolean;
  api_key_last4: string | null;
  merchant_code: string;
  production_configured: boolean;
  sandbox_configured: boolean;
  production_api_key_last4: string | null;
  sandbox_api_key_last4: string | null;
  production_merchant_code: string;
  sandbox_merchant_code: string;
  has_callback_secret: boolean;
  callback_secret_last4: string | null;
  // Masked form of the URL SumUp calls back on, for a visual sanity check.
  callback_url: string | null;
  // Which gateway new payments currently go through.
  active_provider: PaymentProviderId;
  is_active_provider: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SumUpIntegrationUpdate {
  environment?: SumUpEnvironment;
  // Production credentials.
  api_key?: string;
  merchant_code?: string;
  // Sandbox credentials.
  sandbox_api_key?: string;
  sandbox_merchant_code?: string;
  callback_secret?: string;
  // true → route new payments through SumUp, false → back to Revolut.
  set_active?: boolean;
}

export const getSumUpIntegration = async (): Promise<SumUpIntegrationStatus> => {
  return apiRequest<SumUpIntegrationStatus>(`${API_URL}/settings/integrations/sumup`, {
    headers: getHeaders(false),
  });
};

export const updateSumUpIntegration = async (
  updates: SumUpIntegrationUpdate
): Promise<SumUpIntegrationStatus> => {
  return apiRequest<SumUpIntegrationStatus>(`${API_URL}/settings/integrations/sumup`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

export type PaymentFlowId = 'deposit' | 'bill';

export interface ActivePaymentProvider {
  provider: PaymentProviderId;
  // Human name of the active gateway ("Revolut" / "SumUp"), for UI labels.
  label: string;
  providers: PaymentProviderId[];
  configured: Record<PaymentProviderId, boolean>;
  // Preferenza per flusso: override esplicito (null = segue il globale) e
  // provider effettivo che verrà usato per il prossimo incasso del flusso.
  flows: Record<PaymentFlowId, { override: PaymentProviderId | null; effective: PaymentProviderId; label: string }>;
}

export const getActivePaymentProvider = async (): Promise<ActivePaymentProvider> => {
  return apiRequest<ActivePaymentProvider>(`${API_URL}/settings/payments/provider`, {
    headers: getHeaders(false),
  });
};

export const setActivePaymentProvider = async (
  provider: PaymentProviderId
): Promise<{ provider: PaymentProviderId }> => {
  return apiRequest<{ provider: PaymentProviderId }>(`${API_URL}/settings/payments/provider`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ provider }),
  });
};

// Preferenza provider per un singolo flusso (caparre o conti al tavolo).
// provider null = rimuovi l'override, il flusso segue il predefinito.
export const setPaymentProviderForFlow = async (
  flow: PaymentFlowId,
  provider: PaymentProviderId | null
): Promise<{ flow: PaymentFlowId; provider: PaymentProviderId | null }> => {
  return apiRequest<{ flow: PaymentFlowId; provider: PaymentProviderId | null }>(`${API_URL}/settings/payments/provider`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ flow, provider }),
  });
};

// ============================================
// INTEGRATION SETTINGS (SMTP)
// ============================================
export type EmailProvider = 'smtp' | 'resend';

export interface SmtpIntegrationStatus {
  provider: EmailProvider;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  from_email: string;
  from_name: string;
  reply_to: string;
  has_password: boolean;
  password_last4: string | null;
  has_resend_api_key: boolean;
  resend_api_key_last4: string | null;
  configured: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface SmtpIntegrationUpdate {
  provider?: EmailProvider;
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  resend_api_key?: string;
  from_email?: string;
  from_name?: string;
  reply_to?: string;
}

export const getSmtpIntegration = async (): Promise<SmtpIntegrationStatus> => {
  return apiRequest<SmtpIntegrationStatus>(`${API_URL}/settings/integrations/smtp`, {
    headers: getHeaders(false),
  });
};

export const updateSmtpIntegration = async (
  updates: SmtpIntegrationUpdate
): Promise<SmtpIntegrationStatus> => {
  return apiRequest<SmtpIntegrationStatus>(`${API_URL}/settings/integrations/smtp`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

export const sendSmtpTestEmail = async (to: string): Promise<{ success: boolean }> => {
  return apiRequest<{ success: boolean }>(`${API_URL}/settings/integrations/smtp/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ to }),
  });
};

// ============================================
// INTEGRATION SETTINGS (IMAP inbound polling)
// ============================================
export interface ImapIntegrationStatus {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  enabled: boolean;
  has_password: boolean;
  password_last4: string | null;
  last_seen_uid: number | null;
  configured: boolean;
  connected: boolean;
  updated_at: string | null;
  updated_by: string | null;
}

export interface ImapIntegrationUpdate {
  host?: string;
  port?: number;
  secure?: boolean;
  user?: string;
  password?: string;
  enabled?: boolean;
  reset_last_seen_uid?: boolean;
}

export const getImapIntegration = async (): Promise<ImapIntegrationStatus> => {
  return apiRequest<ImapIntegrationStatus>(`${API_URL}/settings/integrations/imap`, {
    headers: getHeaders(false),
  });
};

export const updateImapIntegration = async (
  updates: ImapIntegrationUpdate
): Promise<ImapIntegrationStatus> => {
  return apiRequest<ImapIntegrationStatus>(`${API_URL}/settings/integrations/imap`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

export const testImapConnection = async (): Promise<{ success: boolean }> => {
  return apiRequest<{ success: boolean }>(`${API_URL}/settings/integrations/imap/test`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({}),
  });
};

// ============================================
// AUTO-DEPOSIT POLICY (public web bookings)
// ============================================
export interface AutoDepositSettings {
  enabled: boolean;
  min_guests: number;
  /** Quota di caparra per persona, in centesimi. Assente su backend vecchi. */
  per_person_cents?: number;
  // True when the ACTIVE payment gateway has usable credentials (env or DB).
  // The toggle can still be enabled without them, but the deposit link won't
  // actually be generated — used by the UI to warn the operator. The name is
  // historical (Revolut was the only gateway); `payment_configured` is the
  // same value under a provider-neutral key.
  revolut_configured: boolean;
  payment_configured?: boolean;
  // Which gateway the deposit link will be created with. Absent on backends
  // predating the SumUp integration.
  active_provider?: PaymentProviderId;
  active_provider_label?: string;
}

export const getAutoDepositSettings = async (): Promise<AutoDepositSettings> => {
  return apiRequest<AutoDepositSettings>(`${API_URL}/settings/auto-deposit`, {
    headers: getHeaders(false),
  });
};

export const updateAutoDepositSettings = async (
  updates: Partial<Pick<AutoDepositSettings, 'enabled' | 'min_guests' | 'per_person_cents'>>
): Promise<AutoDepositSettings> => {
  return apiRequest<AutoDepositSettings>(`${API_URL}/settings/auto-deposit`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// Card #27 — comportamento della blacklist per fonte di prenotazione.
export type BlacklistBehavior = 'block' | 'warn';
export type BlacklistPolicySource = 'MANUAL' | 'GOOGLE' | 'VOICE' | 'WHATSAPP';
export type BlacklistPolicySettings = Record<BlacklistPolicySource, BlacklistBehavior>;

export const getBlacklistPolicySettings = async (): Promise<BlacklistPolicySettings> => {
  return apiRequest<BlacklistPolicySettings>(`${API_URL}/settings/blacklist-policy`, {
    headers: getHeaders(false),
  });
};

export const updateBlacklistPolicySettings = async (
  updates: Partial<BlacklistPolicySettings>
): Promise<BlacklistPolicySettings> => {
  return apiRequest<BlacklistPolicySettings>(`${API_URL}/settings/blacklist-policy`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// Card #28 — scadenza automatica dei link di pagamento (per tenant).
export interface PaymentLinkExpirySettings {
  enabled: boolean;
  hours: number;
  message: 'declined' | 'none';
}

export const getPaymentLinkExpirySettings = async (): Promise<PaymentLinkExpirySettings> => {
  return apiRequest<PaymentLinkExpirySettings>(`${API_URL}/settings/payment-link-expiry`, {
    headers: getHeaders(false),
  });
};

export const updatePaymentLinkExpirySettings = async (
  updates: Partial<PaymentLinkExpirySettings>
): Promise<PaymentLinkExpirySettings> => {
  return apiRequest<PaymentLinkExpirySettings>(`${API_URL}/settings/payment-link-expiry`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// ============================================
// LEGAL SETTINGS (per-tenant identity used to generate legal documents)
// ============================================
export interface LegalSettings {
  legal_mode: 'simple' | 'advanced' | string;
  company_name: string;
  company_address: string;
  vat_number: string;
  fiscal_code: string;
  privacy_email: string;
  privacy_phone: string;
  dpo_name: string;
  dpo_contact: string;
  website_url: string;
  app_name: string;
  voice_business_name: string;
  business_name: string;
  business_tagline: string;
  public_phone: string;
  public_whatsapp: string;
  public_address: string;
  maps_url: string;
  logo_url: string;
  logo_dark_url: string;
  data_processors: string;
  retention_customer: string;
  retention_calls: string;
  retention_marketing: string;
  extra_eu_note: string;
  governing_law: string;
  last_updated: string;
  uses_analytics_cookies: boolean;
  records_calls: boolean;
  /** Show the allergy/health-data consent checkbox in the reservation modal (default true). */
  ask_health_consent: boolean;
}

export const getLegalSettings = async (): Promise<LegalSettings> => {
  return apiRequest<LegalSettings>(`${API_URL}/settings/legal`, {
    headers: getHeaders(false),
  });
};

export const updateLegalSettings = async (
  updates: Partial<LegalSettings>
): Promise<LegalSettings> => {
  return apiRequest<LegalSettings>(`${API_URL}/settings/legal`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// Logo del ristorante (pagina prenota). L'upload passa da una route sua:
// legal_config tiene solo il path, i byte stanno in outbound_media.
export type TenantLogoVariant = 'light' | 'dark';

export const uploadTenantLogo = async (
  contentType: string,
  base64Data: string,
  variant: TenantLogoVariant = 'light',
): Promise<{ logo_url: string }> => {
  return apiRequest<{ logo_url: string }>(`${API_URL}/settings/logo`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ content_type: contentType, data: base64Data, variant }),
  });
};

export const removeTenantLogo = async (variant: TenantLogoVariant = 'light'): Promise<{ ok: true }> => {
  return apiRequest<{ ok: true }>(`${API_URL}/settings/logo?variant=${variant}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  });
};

// Path relativo dal server (/public/media/… o /prenota/logo.png) → URL
// assoluto sul backend, per le anteprime nel CRM (che gira su altro dominio).
export const tenantLogoSrc = (logoUrl: string): string =>
  /^https?:\/\//.test(logoUrl) ? logoUrl : `${API_URL}${logoUrl}`;

export const getTableAssignmentAiPrompt = async (): Promise<string> => {
  const { prompt } = await apiRequest<{ prompt: string }>(
    `${API_URL}/settings/table-assignment-ai-prompt`,
    { headers: getHeaders(false) }
  );
  return prompt;
};

export const updateTableAssignmentAiPrompt = async (prompt: string): Promise<string> => {
  const result = await apiRequest<{ prompt: string }>(
    `${API_URL}/settings/table-assignment-ai-prompt`,
    {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ prompt }),
    }
  );
  return result.prompt;
};

// Canali di risposta prenotazioni (Impostazioni → Canali di prenotazione):
// per ogni fonte, l'ordine dei canali con cui rispondere all'ospite.
export type BookingChannel = 'email' | 'whatsapp' | 'sms';
export type BookingSource = 'GOOGLE' | 'VOICE' | 'WHATSAPP' | 'MANUAL';
export interface SourceChannelPolicy {
  priority: BookingChannel[];
  email_copy: boolean;
}
export type BookingChannelPolicyMap = Record<BookingSource, SourceChannelPolicy>;

export const getBookingChannelSettings = async (): Promise<BookingChannelPolicyMap> => {
  return apiRequest<BookingChannelPolicyMap>(`${API_URL}/settings/booking-channels`, {
    headers: getHeaders(false),
  });
};

export const updateBookingChannelSettings = async (
  updates: Partial<BookingChannelPolicyMap>
): Promise<BookingChannelPolicyMap> => {
  return apiRequest<BookingChannelPolicyMap>(`${API_URL}/settings/booking-channels`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(updates),
  });
};

// Wizard di primo accesso (Fase D1): marca l'onboarding come completato.
// Solo OWNER lato server; idempotente.
export const completeOnboarding = async (): Promise<void> => {
  await apiRequest<{ ok: boolean }>(`${API_URL}/onboarding/complete`, {
    method: 'POST',
    headers: getHeaders(),
  });
};

// ============================================
// PANNELLO PIATTAFORMA (Fase D2) — rotte /admin/tenants
// ============================================
// Autenticate col JWT PLATFORM_ADMIN via il normale bearer di getHeaders():
// il server prova prima il JWT, l'env token resta per gli script.

export type AdminTenantFeature = 'voice' | 'whatsapp' | 'web_booking' | 'pay_at_table' | 'passepartout';
export const ADMIN_TENANT_FEATURES: AdminTenantFeature[] = ['voice', 'whatsapp', 'web_booking', 'pay_at_table', 'passepartout'];

export interface AdminTenant {
  id: number;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  // NULL = tenant non a pagamento (grandfathered), da distinguere da un
  // pagante moroso.
  billing_status: string | null;
  // Link al customer sul Dashboard Stripe (test/live deciso dal server);
  // null per i tenant senza billing.
  stripe_customer_url: string | null;
  created_at: string;
  features: AdminTenantFeature[];
  user_count: number;
}

export interface AdminBillingSummary {
  mrr_cents: number;
  paying_tenants: number;
  past_due_tenants: number;
  trialing_tenants: number;
  grandfathered_tenants: number;
}

export const adminBillingSummary = async (): Promise<AdminBillingSummary> => {
  return apiRequest<AdminBillingSummary>(`${API_URL}/admin/billing/summary`, {
    headers: getHeaders(false),
  });
};

export interface AdminTenantProvisioned {
  tenant: { id: number; slug: string; name: string; status: string; timezone: string; created_at: string };
  // Escono SOLO da questa risposta: il pannello li mostra una volta e basta.
  owner_temp_password: string;
  webhook_token: string;
  print_agent_token: string;
  booking_url: string;
}

export const adminListTenants = async (): Promise<AdminTenant[]> => {
  return apiRequest<AdminTenant[]>(`${API_URL}/admin/tenants`, {
    headers: getHeaders(false),
  });
};

export const adminCreateTenant = async (input: {
  name: string;
  slug: string;
  owner_email: string;
  features?: Partial<Record<AdminTenantFeature, boolean>>;
}): Promise<AdminTenantProvisioned> => {
  return apiRequest<AdminTenantProvisioned>(`${API_URL}/admin/tenants`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });
};

export const adminUpdateTenant = async (
  id: number,
  patch: { status?: 'active' | 'suspended'; features?: Partial<Record<AdminTenantFeature, boolean>> }
): Promise<{ tenant: AdminTenantProvisioned['tenant']; features: Record<AdminTenantFeature, boolean> }> => {
  return apiRequest(`${API_URL}/admin/tenants/${id}`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify(patch),
  });
};

export const adminImpersonateTenant = async (id: number): Promise<{
  accessToken: string;
  expires_in_seconds: number;
  user: { email: string; role: string };
  tenant: { id: number; slug: string };
}> => {
  return apiRequest(`${API_URL}/admin/tenants/${id}/impersonate`, {
    method: 'POST',
    headers: getHeaders(),
  });
};

// Billing Stripe (Fase D3): il server risponde 503 billing_disabled finché
// le env Stripe non ci sono — il chiamante lo intercetta via err.status.
export const adminBillingCheckout = async (id: number): Promise<{ url: string; session_id?: string }> => {
  return apiRequest(`${API_URL}/admin/tenants/${id}/billing/checkout`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({}),
  });
};

export const adminBillingPortal = async (id: number): Promise<{ url: string }> => {
  return apiRequest(`${API_URL}/admin/tenants/${id}/billing/portal`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({}),
  });
};

// Picker add-on: modifica gli item della subscription Stripe del tenant
// (prorazione automatica) e ritorna le feature risultanti.
export const adminUpdateAddons = async (
  id: number,
  features: Partial<Record<AdminTenantFeature, boolean>>
): Promise<{ billing_status: string | null; features: Record<AdminTenantFeature, boolean> }> => {
  return apiRequest(`${API_URL}/admin/tenants/${id}/billing/addons`, {
    method: 'PATCH',
    headers: getHeaders(),
    body: JSON.stringify({ features }),
  });
};

export interface MarketingRecipient {
  id: number;
  name: string;
  phone: string | null;
  email: string | null;
  consent_marketing_updated_at: string | null;
}

export interface MarketingAudience {
  mode: string;
  count: number;
  recipients: MarketingRecipient[];
}

// Returns only marketing-consenting, contactable customers. Throws (409) when
// the legal layer runs in "simple" mode.
export const getMarketingAudience = async (): Promise<MarketingAudience> => {
  return apiRequest<MarketingAudience>(`${API_URL}/customers/marketing-audience`, {
    headers: getHeaders(false),
  });
};

export interface ReservationNotePresetVariant {
  // id is present when the variant already exists in the DB. New variants
  // added in the editor are sent to PUT without an id and get one back.
  id?: number;
  label: string;
}

export interface ReservationNotePreset {
  id: number;
  label: string;
  icon?: string | null;
  // When true the chip opens a picker for quantity (and variant, if any)
  // instead of appending plain text to the note. Structured selections
  // land in Reservation.note_selections and feed the kitchen aggregation.
  has_quantity?: boolean;
  variants?: ReservationNotePresetVariant[];
}

export const getReservationNotePresets = async (): Promise<ReservationNotePreset[]> => {
  return apiRequest<ReservationNotePreset[]>(`${API_URL}/settings/reservation-notes`, {
    headers: getHeaders(false),
  });
};

export const updateReservationNotePresets = async (
  items: Array<{
    label: string;
    icon?: string | null;
    has_quantity?: boolean;
    variants?: Array<{ label: string }>;
  }>,
): Promise<ReservationNotePreset[]> => {
  return apiRequest<ReservationNotePreset[]>(`${API_URL}/settings/reservation-notes`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ items }),
  });
};

export interface ReservationAllergenPreset {
  id: number;
  label: string;
}

export const getReservationAllergenPresets = async (): Promise<ReservationAllergenPreset[]> => {
  return apiRequest<ReservationAllergenPreset[]>(`${API_URL}/settings/reservation-allergens`, {
    headers: getHeaders(false),
  });
};

export const updateReservationAllergenPresets = async (
  labels: string[],
): Promise<ReservationAllergenPreset[]> => {
  return apiRequest<ReservationAllergenPreset[]>(`${API_URL}/settings/reservation-allergens`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ labels }),
  });
};

export interface KitchenServiceSummary {
  service_date: string;
  shift: 'LUNCH' | 'DINNER';
  reservations: number;
  dietary: Array<{
    label: string;
    variant: string | null;
    quantity: number;
    // Ripartizione per tavolo; `table` è null quando il tavolo non è ancora
    // assegnato e resta solo il nome del cliente.
    tables: Array<{ table: string | null; customer: string; quantity: number }>;
  }>;
  dietary_lines: Array<{ reservation_id: number; customer_name: string; text: string }>;
}

export const getKitchenServiceSummary = async (
  params?: { date?: string; shift?: 'LUNCH' | 'DINNER' },
): Promise<KitchenServiceSummary> => {
  const qs = new URLSearchParams();
  if (params?.date) qs.set('date', params.date);
  if (params?.shift) qs.set('shift', params.shift);
  const query = qs.toString();
  return apiRequest<KitchenServiceSummary>(
    `${API_URL}/kitchen/service-summary${query ? `?${query}` : ''}`,
    { headers: getHeaders(false) },
  );
};
