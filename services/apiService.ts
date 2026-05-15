import { Reservation, Table, Room, Dish, BanquetMenu, BanquetPayment, TableMerge, TableHiddenOverride, Shift, Customer, InventoryArea, InventoryLocation, InventoryProduct, InventoryStockRow, InventoryMovement, InventoryMovementReason, InventoryCategory } from '../types';
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

export const getTableHidden = async (date: string, shift: Shift): Promise<TableHiddenOverride[]> => {
  const params = new URLSearchParams({ date, shift });
  return apiRequest<TableHiddenOverride[]>(`${API_URL}/table-hidden?${params.toString()}`, {
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

export const sendWhatsAppConfirmation = async (reservationId: number): Promise<{ success: boolean; message: string }> => {
  return apiRequest<{ success: boolean; message: string }>(`${API_URL}/reservations/${reservationId}/confirm-whatsapp`, {
    method: 'POST',
    headers: getHeaders(),
  });
};
