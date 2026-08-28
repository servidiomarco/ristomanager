import { authApiService } from './authApiService';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import type { StaffChannel, StaffMessage } from './staffChat';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface StaffUploadedAttachment {
  token: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
}

// Le foto stanno in outbound_media dietro token non indovinabile: l'URL
// pubblico basta a <img>, niente fetch autenticato.
export const staffMediaUrl = (token: string): string =>
  `${API_URL}/public/media/${encodeURIComponent(token)}`;

export interface StaffThreadSummary {
  threadKey: string;
  kind: 'channel' | 'direct';
  channel?: StaffChannel;
  otherUser?: { id: number; fullName: string | null; role: string | null; isActive: boolean };
  lastMessage: StaffMessage | null;
  unreadCount: number;
}

export interface StaffPreset {
  key: string;
  label: string;
}

export interface StaffColleague {
  id: number;
  fullName: string;
  role: string;
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
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

class StaffChatApiService {
  async listThreads(): Promise<{ threads: StaffThreadSummary[]; colleagues: StaffColleague[] }> {
    return apiRequest(`${API_URL}/staff-chat/threads`, { headers: getHeaders() });
  }

  async getMessages(threadKey: string, before?: number): Promise<{ messages: StaffMessage[] }> {
    const qs = before ? `?before=${before}` : '';
    return apiRequest(`${API_URL}/staff-chat/threads/${encodeURIComponent(threadKey)}/messages${qs}`, {
      headers: getHeaders(),
    });
  }

  async send(threadKey: string, body: string, presetKey?: string | null, mentionedUserIds?: number[], attachments?: string[]): Promise<StaffMessage> {
    return apiRequest(`${API_URL}/staff-chat/messages`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        threadKey, body,
        presetKey: presetKey ?? undefined,
        mentionedUserIds: mentionedUserIds && mentionedUserIds.length > 0 ? mentionedUserIds : undefined,
        attachments: attachments && attachments.length > 0 ? attachments : undefined,
      }),
    });
  }

  async markRead(threadKey: string, lastReadMessageId: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/staff-chat/threads/${encodeURIComponent(threadKey)}/read`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastReadMessageId }),
    });
  }

  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/staff-chat/unread-count`, { headers: getHeaders() });
  }

  // Ridimensiona come l'inbox: le foto dal telefono pesano 3-5 MB e in chat
  // non servono a quella risoluzione.
  async uploadAttachment(file: File): Promise<StaffUploadedAttachment> {
    const dataUrl = await resizeImageToDataUrl(file, 1600, 0.82);
    const data = dataUrl.split(',')[1] || '';
    const filename = file.name.replace(/\.[^.]+$/, '') + '.jpg';
    return apiRequest(`${API_URL}/staff-chat/attachments`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg', filename, data }),
    });
  }

  async getPresets(): Promise<{ presets: StaffPreset[]; custom: boolean }> {
    return apiRequest(`${API_URL}/staff-chat/presets`, { headers: getHeaders() });
  }

  // Sostituzione integrale della lista; vuota = torna ai default.
  async savePresets(labels: string[]): Promise<{ presets: StaffPreset[]; custom: boolean }> {
    return apiRequest(`${API_URL}/staff-chat/presets`, {
      method: 'PUT',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ labels }),
    });
  }
}

export const staffChatApiService = new StaffChatApiService();
