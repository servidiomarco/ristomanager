import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface VoiceCallSummary {
  id: number;
  conversation_id: string;
  phone: string | null;
  duration_seconds: number | null;
  summary: string | null;
  reservation_id: number | null;
  created_at: string;
  reservation_customer_name: string | null;
  reservation_time: string | null;
  reservation_guests: number | null;
  reservation_status: string | null;
}

export interface VoiceCallDetail extends VoiceCallSummary {
  transcript: string | null;
}

export interface VoiceCallsListResponse {
  items: VoiceCallSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface VoiceCallsListParams {
  from?: string;
  to?: string;
  q?: string;
  linked?: 'true' | 'false';
  limit?: number;
  offset?: number;
}

export interface VoiceCallsSyncResult {
  imported: number;
  skipped: number;
  failed: number;
  total_fetched: number;
}

const getHeaders = (): HeadersInit => {
  const headers: Record<string, string> = {};
  const socketId = socketClient.getSocket()?.id;
  if (socketId) headers['X-Socket-ID'] = socketId;
  const token = authApiService.getAccessToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
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
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }
  return response.json();
};

const buildQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    search.set(k, String(v));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
};

class VoiceCallsApiService {
  async list(params: VoiceCallsListParams = {}): Promise<VoiceCallsListResponse> {
    const qs = buildQuery({
      from: params.from,
      to: params.to,
      q: params.q,
      linked: params.linked,
      limit: params.limit,
      offset: params.offset,
    });
    return apiRequest<VoiceCallsListResponse>(`${API_URL}/voice-calls${qs}`, {
      headers: getHeaders(),
    });
  }

  async getById(id: number): Promise<VoiceCallDetail> {
    return apiRequest<VoiceCallDetail>(`${API_URL}/voice-calls/${id}`, {
      headers: getHeaders(),
    });
  }

  // Audio is streamed; we fetch as a blob and produce an object URL so the
  // <audio> element doesn't have to send the auth header itself.
  async getAudioBlobUrl(id: number): Promise<string> {
    const response = await fetchWithAuth(`${API_URL}/voice-calls/${id}/audio`, {
      headers: getHeaders(),
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Audio non disponibile' }));
      throw new Error(errorData.error || 'Audio non disponibile');
    }
    const blob = await response.blob();
    return URL.createObjectURL(blob);
  }

  async sync(): Promise<VoiceCallsSyncResult> {
    return apiRequest<VoiceCallsSyncResult>(`${API_URL}/voice-calls/sync`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }
}

export const voiceCallsApiService = new VoiceCallsApiService();
