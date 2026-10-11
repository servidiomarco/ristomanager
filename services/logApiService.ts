import { ActivityLog, LogFilters, ActivityStats, LogRefs } from '../types';
import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

// Helper function to get headers with auth token
const getHeaders = (): HeadersInit => {
  const headers: HeadersInit = {
    'Content-Type': 'application/json'
  };

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

export interface LogsResponse {
  logs: ActivityLog[];
  total: number;
  refs: LogRefs;
}

export interface ReservationHistoryResponse {
  logs: ActivityLog[];
  refs: LogRefs;
}

// Un backend di prima di questa versione non manda refs: la pagina resta
// leggibile con gli id al posto dei nomi.
const EMPTY_REFS: LogRefs = { tables: {}, rooms: {}, reservations: {}, merge_reservations: {} };
const withRefs = (refs: unknown): LogRefs => {
  const r = (refs && typeof refs === 'object' ? refs : {}) as Partial<LogRefs>;
  return {
    tables: r.tables ?? EMPTY_REFS.tables,
    rooms: r.rooms ?? EMPTY_REFS.rooms,
    reservations: r.reservations ?? EMPTY_REFS.reservations,
    merge_reservations: r.merge_reservations ?? EMPTY_REFS.merge_reservations,
  };
};

export interface LogUser {
  id: number;
  name: string;
  email: string;
}

class LogApiService {
  /**
   * Get activity logs with filters and pagination
   */
  async getActivityLogs(filters: LogFilters = {}): Promise<LogsResponse> {
    const params = new URLSearchParams();

    if (filters.user_id) params.append('user_id', filters.user_id.toString());
    if (filters.resource_type) params.append('resource_type', filters.resource_type);
    if (filters.resource_id) params.append('resource_id', filters.resource_id.toString());
    if (filters.action) params.append('action', filters.action);
    if (filters.from_date) params.append('from_date', filters.from_date);
    if (filters.to_date) params.append('to_date', filters.to_date);
    if (filters.search && filters.search.trim()) params.append('search', filters.search.trim());
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.offset) params.append('offset', filters.offset.toString());

    const queryString = params.toString();
    const url = `${API_URL}/activity-logs${queryString ? `?${queryString}` : ''}`;

    const response = await fetchWithAuth(url, {
      headers: getHeaders()
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch logs' }));
      throw buildApiError(response.status, error, 'Failed to fetch logs');
    }

    const body = await response.json();
    return { logs: body.logs ?? [], total: Number(body.total) || 0, refs: withRefs(body.refs) };
  }

  /**
   * La storia di una prenotazione, dalla più vecchia: i suoi log più unioni
   * e divisioni dei suoi tavoli in quel turno.
   */
  async getReservationHistory(reservationId: number): Promise<ReservationHistoryResponse> {
    const response = await fetchWithAuth(`${API_URL}/activity-logs/reservation/${reservationId}`, {
      headers: getHeaders()
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch history' }));
      throw buildApiError(response.status, error, 'Failed to fetch history');
    }

    const body = await response.json();
    return { logs: body.logs ?? [], refs: withRefs(body.refs) };
  }

  /**
   * Get activity statistics
   */
  async getActivityStats(): Promise<ActivityStats> {
    const response = await fetchWithAuth(`${API_URL}/activity-logs/stats`, {
      headers: getHeaders()
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch stats' }));
      throw buildApiError(response.status, error, 'Failed to fetch stats');
    }

    return response.json();
  }

  /**
   * Get list of users with activity logs (for filter dropdown)
   */
  async getLogUsers(): Promise<LogUser[]> {
    const response = await fetchWithAuth(`${API_URL}/activity-logs/users`, {
      headers: getHeaders()
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch users' }));
      throw buildApiError(response.status, error, 'Failed to fetch users');
    }

    return response.json();
  }
}

export const logApiService = new LogApiService();
