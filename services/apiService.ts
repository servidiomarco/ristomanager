import { Reservation, Table, Room, Dish, BanquetMenu, BanquetPayment, TableMerge, TableHiddenOverride, RoomClosedOverride, Shift, Customer, InventoryArea, InventoryLocation, InventoryProduct, InventoryStockRow, InventoryMovement, InventoryMovementReason, InventoryCategory, PaymentRequest } from '../types';
import { socketClient } from './socketClient';
import { authApiService } from './authApiService';

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

// Helper to make authenticated requests with error handling
const apiRequest = async <T>(
  url: string,
  options: RequestInit = {},
  expectJson = true
): Promise<T> => {
  // Bypass the browser HTTP cache by default. iOS Safari in PWA mode can
  // otherwise serve stale GET responses after the app is backgrounded.
  // Callers can still override by passing an explicit `cache` option.
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    const baseMessage = errorData.error || `Request failed with status ${response.status}`;
    const message = errorData.detail ? `${baseMessage}: ${errorData.detail}` : baseMessage;
    const error = new Error(message) as Error & { status?: number; data?: any };
    error.status = response.status;
    error.data = errorData;
    throw error;
  }

  if (expectJson) {
    return response.json();
  }

  return undefined as T;
};

export const getReservations = async (): Promise<Reservation[]> => {
  return apiRequest<Reservation[]>(`${API_URL}/reservations`, {
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
  });
};

export const deleteReservation = async (id: number): Promise<void> => {
  return apiRequest<void>(`${API_URL}/reservations/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
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
  input: { reservation_id: number; amount: number; description?: string }
): Promise<PaymentRequest> => {
  return apiRequest<PaymentRequest>(`${API_URL}/payments/requests`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });
};

// ============================================
// OUTBOUND MESSAGES (SMS / WhatsApp log)
// ============================================

export interface OutboundMessage {
  id: number;
  provider: string;
  channel: 'sms' | 'whatsapp' | 'email';
  to_phone: string | null;
  to_email: string | null;
  subject: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  reservation_id: number | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  error_code: string | null;
  error_message: string | null;
}

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
export interface ConfirmationSendResult {
  success: boolean;
  message: string;
  channel?: string;
  status_changed?: boolean;
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
export interface ChannelSettings {
  voice_large_group_threshold: number;
  voice_bookings_suspension_callback_time: string;
  voice_bookings_suspension_schedule: ScheduledSuspension[];
  public_bookings_blocks: PublicBookingBlock[];
}

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
// AUTO-DEPOSIT POLICY (public web bookings)
// ============================================
export interface AutoDepositSettings {
  enabled: boolean;
  min_guests: number;
  // True when a Revolut API key is stored (env or DB). The toggle can still be
  // enabled without it, but the deposit link won't actually be generated —
  // used by the UI to warn the operator.
  revolut_configured: boolean;
}

export const getAutoDepositSettings = async (): Promise<AutoDepositSettings> => {
  return apiRequest<AutoDepositSettings>(`${API_URL}/settings/auto-deposit`, {
    headers: getHeaders(false),
  });
};

export const updateAutoDepositSettings = async (
  updates: Partial<Pick<AutoDepositSettings, 'enabled' | 'min_guests'>>
): Promise<AutoDepositSettings> => {
  return apiRequest<AutoDepositSettings>(`${API_URL}/settings/auto-deposit`, {
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

export interface ReservationNotePreset {
  id: number;
  label: string;
  icon?: string | null;
}

export const getReservationNotePresets = async (): Promise<ReservationNotePreset[]> => {
  return apiRequest<ReservationNotePreset[]>(`${API_URL}/settings/reservation-notes`, {
    headers: getHeaders(false),
  });
};

export const updateReservationNotePresets = async (
  items: Array<{ label: string; icon?: string | null }>,
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
