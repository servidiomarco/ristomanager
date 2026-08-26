import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import { resizeImageToDataUrl } from '../utils/resizeImage';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export type MessageChannel = 'sms' | 'whatsapp';
export type MessageDirection = 'inbound' | 'outbound';

export interface ConversationSummary {
  phone_digits: string;
  phone: string | null;
  last_channel: MessageChannel;
  last_direction: MessageDirection;
  last_body: string;
  last_sent_at: string;
  last_reservation_id: number | null;
  unread_count: number;
  last_inbound_at: string | null;
  customer_name: string | null;
}

export interface InboxMessage {
  id: number;
  provider: string;
  channel: MessageChannel;
  direction: MessageDirection;
  from_phone: string | null;
  to_phone: string | null;
  body: string;
  status: string | null;
  provider_sid: string | null;
  reservation_id: number | null;
  sent_at: string;
  delivered_at: string | null;
  failed_at: string | null;
  read_at: string | null;
  error_code: string | null;
  error_message: string | null;
  from_phone_digits?: string | null;
  to_phone_digits?: string | null;
  /** Allegati del messaggio in arrivo (foto, vocali, posizione). */
  media?: MessageMedia[] | null;
}

export interface MessageMedia {
  url: string;
  content_type?: string;
  /** Presente sugli allegati in uscita: riferimento al file che abbiamo caricato. */
  token?: string;
}

export interface UploadedAttachment {
  id: number;
  token: string;
  content_type: string;
  filename: string | null;
  size_bytes: number;
}

/** Gli allegati stanno su Twilio dietro autenticazione: si passa dal backend. */
export const mediaUrl = (messageId: number, index: number): string =>
  `${API_URL}/messages/${messageId}/media/${index}`;


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

/**
 * Scarica un allegato come blob. Serve il fetch autenticato: un <img src>
 * non manda l'header Authorization, quindi l'immagine si mostra da un
 * object URL creato qui (da revocare a smontaggio).
 */
/** Carica un allegato: il file resta sul nostro backend e Twilio lo scarica
 *  dall'URL pubblico col token restituito qui. */
export const uploadAttachment = async (file: File): Promise<UploadedAttachment> => {
  // Le foto dal telefono pesano 3-5 MB e non servono a quella risoluzione su
  // WhatsApp: ridimensionate stanno sotto il mezzo mega e partono subito.
  let contentType = file.type;
  let filename = file.name;
  let data: string;
  if (file.type.startsWith('image/') && file.type !== 'image/gif') {
    const dataUrl = await resizeImageToDataUrl(file, 1600, 0.82);
    data = dataUrl.split(',')[1] || '';
    contentType = 'image/jpeg';
    filename = filename.replace(/\.[^.]+$/, '') + '.jpg';
  } else {
    data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
      reader.onerror = () => reject(new Error('Lettura del file fallita'));
      reader.readAsDataURL(file);
    });
  }
  return apiRequest<UploadedAttachment>(`${API_URL}/messages/attachments`, {
    method: 'POST',
    headers: { ...getHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: contentType, filename, data }),
  });
};

export const fetchMedia = async (messageId: number, index: number): Promise<Blob> => {
  const res = await fetchWithAuth(mediaUrl(messageId, index), { headers: getHeaders() });
  if (!res.ok) throw new Error('Allegato non disponibile');
  return res.blob();
};

const apiRequest = async <T>(url: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

class MessagesApiService {
  async listConversations(): Promise<{ conversations: ConversationSummary[] }> {
    return apiRequest(`${API_URL}/messages/conversations`, { headers: getHeaders() });
  }

  async unreadCount(): Promise<{ count: number }> {
    return apiRequest(`${API_URL}/messages/unread-count`, { headers: getHeaders() });
  }

  async getTimeline(phoneDigits: string): Promise<{ messages: InboxMessage[] }> {
    return apiRequest(`${API_URL}/messages/conversations/${encodeURIComponent(phoneDigits)}`, {
      headers: getHeaders(),
    });
  }

  async markRead(phoneDigits: string): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/messages/conversations/${encodeURIComponent(phoneDigits)}/read`, {
      method: 'POST',
      headers: getHeaders(),
    });
  }

  // Aggancia una prenotazione al thread così lo staff può riaprirla dalla
  // chat. Usato dopo la creazione rapida dalla conversazione.
  async linkReservation(phoneDigits: string, reservationId: number): Promise<{ ok: true; reservation_id: number }> {
    return apiRequest(`${API_URL}/messages/conversations/${encodeURIComponent(phoneDigits)}/link`, {
      method: 'PATCH',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservation_id: reservationId }),
    });
  }

  async send(params: {
    phone: string;
    text: string;
    channel?: MessageChannel;
    /** Token restituiti da uploadAttachment: solo WhatsApp. */
    attachment_tokens?: string[];
  }): Promise<{ ok: true; message: InboxMessage | null; channel: MessageChannel; sid: string | null }> {
    return apiRequest(`${API_URL}/messages/send`, {
      method: 'POST',
      headers: { ...getHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
  }
}

export const messagesApiService = new MessagesApiService();
