import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || "https://ristomanager-production.up.railway.app";

export type RoadmapPhaseKey = 'domini' | 'legale' | 'euipo' | 'branding';

/** todo → queued (approvato per Claude) → in_progress → done.
 *  I task manuali (claude_prompt null) saltano da todo a done. */
export type RoadmapTaskStatus = 'todo' | 'queued' | 'in_progress' | 'done';

export interface RoadmapTask {
  id: number;
  phase_key: RoadmapPhaseKey;
  title: string;
  description: string | null;
  claude_prompt: string | null;
  result_note: string | null;
  status: RoadmapTaskStatus;
  position: number;
  created_at: string;
  updated_at: string;
}

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
    throw buildApiError(response.status, errorData);
  }
  if (expectJson) {
    return response.json();
  }
  return undefined as T;
};

export const getRoadmapTasks = (): Promise<RoadmapTask[]> =>
  apiRequest(`${API_URL}/roadmap/tasks`, { headers: getHeaders(false), cache: 'no-store' });

export const createRoadmapTask = (input: {
  title: string;
  description?: string | null;
  phase_key: RoadmapPhaseKey;
  claude_prompt?: string | null;
}): Promise<RoadmapTask> =>
  apiRequest(`${API_URL}/roadmap/tasks`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });

export const updateRoadmapTask = (id: number, input: {
  title?: string;
  description?: string | null;
  phase_key?: RoadmapPhaseKey;
  claude_prompt?: string | null;
  result_note?: string | null;
  status?: RoadmapTaskStatus;
}): Promise<RoadmapTask> =>
  apiRequest(`${API_URL}/roadmap/tasks/${id}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(input),
  });

export const deleteRoadmapTask = (id: number): Promise<void> =>
  apiRequest(`${API_URL}/roadmap/tasks/${id}`, {
    method: 'DELETE',
    headers: getHeaders(false),
  }, false);
