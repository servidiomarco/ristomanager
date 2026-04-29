import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = "https://ristomanager-production.up.railway.app";

export type ShoppingCategory = 'CUCINA' | 'BAR' | 'ALTRO';

export interface ShoppingItem {
  id: string;
  name: string;
  category: ShoppingCategory;
  checked: boolean;
  date: string;
  createdAt?: string;
  createdByUserId?: number;
  createdByUserName?: string;
}

// Helper function to get headers with socket ID and auth token
const getHeaders = (includeContentType = true): HeadersInit => {
  const headers: HeadersInit = {};

  if (includeContentType) {
    headers['Content-Type'] = 'application/json';
  }

  const socketId = socketClient.getSocket()?.id;
  if (socketId) {
    headers['X-Socket-ID'] = socketId;
  }

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

class ShoppingApiService {
  /**
   * Get shopping items for a specific date
   */
  async getItemsByDate(date: string): Promise<ShoppingItem[]> {
    return apiRequest<ShoppingItem[]>(`${API_URL}/shopping?date=${date}`, {
      headers: getHeaders(false)
    });
  }

  /**
   * Create a new shopping item
   */
  async createItem(item: { name: string; category: ShoppingCategory; date: string }): Promise<ShoppingItem> {
    return apiRequest<ShoppingItem>(`${API_URL}/shopping`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(item),
    });
  }

  /**
   * Toggle item checked status
   */
  async toggleItem(id: string): Promise<ShoppingItem> {
    return apiRequest<ShoppingItem>(`${API_URL}/shopping/${id}/toggle`, {
      method: 'PUT',
      headers: getHeaders(false),
    });
  }

  /**
   * Delete a shopping item
   */
  async deleteItem(id: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/shopping/${id}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }

  /**
   * Clear all checked items for a specific date
   */
  async clearChecked(date: string): Promise<void> {
    return apiRequest<void>(`${API_URL}/shopping/clear-checked?date=${date}`, {
      method: 'DELETE',
      headers: getHeaders(false),
    }, false);
  }
}

export const shoppingApiService = new ShoppingApiService();
