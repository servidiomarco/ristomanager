import { Reservation, Table, Room, Dish, BanquetMenu, TableMerge, Shift } from '../types';
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
  const response = await fetchWithAuth(url, options);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
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

export const sendWhatsAppConfirmation = async (reservationId: number): Promise<{ success: boolean; message: string }> => {
  return apiRequest<{ success: boolean; message: string }>(`${API_URL}/reservations/${reservationId}/confirm-whatsapp`, {
    method: 'POST',
    headers: getHeaders(),
  });
};
