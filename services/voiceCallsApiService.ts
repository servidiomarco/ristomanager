import { authApiService } from './authApiService';
import { socketClient } from './socketClient';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type FollowUpStatus = 'PENDING' | 'CONTACTED';

export interface VoiceCallSummary {
  id: number;
  conversation_id: string;
  phone: string | null;
  duration_seconds: number | null;
  summary: string | null;
  reservation_id: number | null;
  created_at: string;
  follow_up_status: FollowUpStatus | null;
  notes: string | null;
  follow_up_updated_at: string | null;
  follow_up_updated_by_name: string | null;
  reservation_customer_name: string | null;
  reservation_time: string | null;
  reservation_guests: number | null;
  reservation_status: string | null;
  customer_id: number | null;
  customer_name: string | null;
  // True when the agent verbally confirmed a booking in the transcript but
  // never invoked the create-reservation tool (LLM hallucination). Flagged
  // by the post-call webhook, powers the "Da recuperare" filter.
  phantom_confirmation: boolean;
  // Flipped once staff has dealt with the phantom booking — either by
  // linking a manually-created reservation (auto) or by clicking the
  // "Segna come recuperata" button (manual). Collapses the red banner.
  phantom_recovered: boolean;
  // True when the call ended in the large-group handoff branch (guests
  // above the configurable threshold). The agent has already told the
  // caller they'll be called back — the badge on the card reminds staff
  // this is a callback request, not a plain follow-up.
  large_group_handoff: boolean;
}

export interface VoiceCallFollowUpUpdate {
  status?: FollowUpStatus;
  notes?: string | null;
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
  follow_up?: 'pending' | 'contacted';
  phantom?: 'true';
  limit?: number;
  offset?: number;
}

export interface VoiceCallsSyncResult {
  imported: number;
  backfilled: number;
  skipped: number;
  failed: number;
  total_fetched: number;
}

export interface OutboundMessage {
  id: number;
  provider: string;
  channel: 'sms' | 'whatsapp';
  to_phone: string;
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
      follow_up: params.follow_up,
      phantom: params.phantom,
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

  async pendingCount(): Promise<{ count: number }> {
    return apiRequest<{ count: number }>(`${API_URL}/voice-calls/pending-count`, {
      headers: getHeaders(),
    });
  }

  async updateFollowUp(id: number, patch: VoiceCallFollowUpUpdate): Promise<{
    id: number;
    follow_up_status: FollowUpStatus;
    notes: string | null;
    follow_up_updated_at: string;
  }> {
    return apiRequest(`${API_URL}/voice-calls/${id}/follow-up`, {
      method: 'PATCH',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  async linkReservation(id: number, reservationId: number): Promise<{
    id: number;
    reservation_id: number;
    follow_up_status: FollowUpStatus;
    follow_up_updated_at: string;
    phantom_recovered: boolean;
  }> {
    return apiRequest(`${API_URL}/voice-calls/${id}/link`, {
      method: 'PATCH',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservation_id: reservationId }),
    });
  }

  async markPhantomRecovered(id: number): Promise<{
    id: number;
    phantom_confirmation: boolean;
    phantom_recovered: boolean;
  }> {
    return apiRequest(`${API_URL}/voice-calls/${id}/recover`, {
      method: 'PATCH',
      headers: getHeaders(),
    });
  }

  async listMessages(id: number): Promise<{ items: OutboundMessage[] }> {
    return apiRequest(`${API_URL}/voice-calls/${id}/messages`, {
      headers: getHeaders(),
    });
  }
}

export const voiceCallsApiService = new VoiceCallsApiService();
