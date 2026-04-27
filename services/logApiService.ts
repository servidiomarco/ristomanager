import { ActivityLog, LogFilters, ActivityStats } from '../types';
import { authApiService } from './authApiService';

const API_URL = "https://ristomanager-production.up.railway.app";

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
}

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
    if (filters.action) params.append('action', filters.action);
    if (filters.from_date) params.append('from_date', filters.from_date);
    if (filters.to_date) params.append('to_date', filters.to_date);
    if (filters.limit) params.append('limit', filters.limit.toString());
    if (filters.offset) params.append('offset', filters.offset.toString());

    const queryString = params.toString();
    const url = `${API_URL}/activity-logs${queryString ? `?${queryString}` : ''}`;

    const response = await fetchWithAuth(url, {
      headers: getHeaders()
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Failed to fetch logs' }));
      throw new Error(error.error || 'Failed to fetch logs');
    }

    return response.json();
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
      throw new Error(error.error || 'Failed to fetch stats');
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
      throw new Error(error.error || 'Failed to fetch users');
    }

    return response.json();
  }
}

export const logApiService = new LogApiService();
