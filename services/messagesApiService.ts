import { authApiService } from './authApiService';
import { socketClient } from './socketClient';
import { buildApiError } from './apiError';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { phoneMatchKey } from '../utils/text';

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

// Cache a livello modulo dell'inbox. App monta InboxPage in modo condizionale
// (`view === MESSAGGI && ...`), quindi ogni cambio vista smonta tutto: senza
// questa cache ogni rientro ripartiva da zero — spinner e ~mezzo secondo di
// rete verso Railway per rivedere dati di dieci secondi prima. La pagina
// mostra subito l'ultimo stato noto e lo rinfresca in background
// (stale-while-revalidate); App la pre-riempie al login e la svuota al logout
// perché non sopravviva a un cambio utente sullo stesso browser.
const TIMELINE_CACHE_MAX = 30;
export const inboxCache = {
  conversations: null as ConversationSummary[] | null,
  timelines: new Map<string, InboxMessage[]>(),
  setTimeline(phoneDigits: string, messages: InboxMessage[]) {
    // Ri-inserire la chiave la sposta in coda: la Map mantiene l'ordine di
    // inserimento, quindi la prima chiave è sempre la meno recente.
    this.timelines.delete(phoneDigits);
    this.timelines.set(phoneDigits, messages);
    if (this.timelines.size > TIMELINE_CACHE_MAX) {
      const oldest = this.timelines.keys().next().value;
      if (oldest !== undefined) this.timelines.delete(oldest);
    }
  },
  clear() {
    this.conversations = null;
    this.timelines.clear();
  },
};

// ── Aggiornamento della cache dai messaggi che arrivano dal socket ──────────
// Le stesse funzioni le usano InboxPage (mentre è aperta) e App (mentre è
// altrove). Il messaggio è GIÀ nel browser quando il badge si accende: senza
// questo, chi tocca il badge riapriva Messaggi sulla lista di prima e
// aspettava un round trip verso Railway per vedere ciò che il client aveva
// già in mano.

/** Il thread di appartenenza di un messaggio: il numero dell'altra parte,
 *  ridotto alla stessa chiave nazionale usata dal server. */
export const inboxThreadKey = (msg: InboxMessage): string | null => {
  const raw = msg.direction === 'inbound' ? msg.from_phone_digits : msg.to_phone_digits;
  if (!raw) return null;
  return phoneMatchKey(String(raw));
};

/** Accoda il messaggio alla timeline già in cache. Se quel thread non è mai
 *  stato aperto non c'è niente da aggiornare: lo caricherà l'apertura. */
export const cacheAppendMessage = (msg: InboxMessage): void => {
  const key = inboxThreadKey(msg);
  if (!key) return;
  const cached = inboxCache.timelines.get(key);
  if (cached && !cached.some(m => m.id === msg.id)) {
    inboxCache.setTimeline(key, [...cached, msg]);
  }
};

/** Esito di consegna su un messaggio già in timeline (callback Twilio). */
export const cachePatchMessage = (msg: InboxMessage): void => {
  const key = inboxThreadKey(msg);
  if (!key) return;
  const cached = inboxCache.timelines.get(key);
  if (cached) {
    inboxCache.setTimeline(key, cached.map(m => (m.id === msg.id ? { ...m, ...msg } : m)));
  }
};

/** Applica un messaggio alla lista conversazioni: il thread sale in cima con
 *  l'ultima riga aggiornata. `openKey` è la chat aperta in quel momento — lì i
 *  non letti restano a zero perché la chat li sta già marcando letti.
 *  `isNewThread` segnala che il nome del cliente lo sa solo il server: chi
 *  chiama fa partire un refresh per riempirlo. */
export const applyMessageToConversations = (
  list: ConversationSummary[],
  msg: InboxMessage,
  openKey?: string | null,
): { conversations: ConversationSummary[]; isNewThread: boolean } => {
  const key = inboxThreadKey(msg);
  if (!key) return { conversations: list, isNewThread: false };
  const inbound = msg.direction === 'inbound';
  const existing = list.find(c => c.phone_digits === key);
  if (existing) {
    const updated: ConversationSummary = {
      ...existing,
      last_channel: msg.channel,
      last_direction: msg.direction,
      last_body: msg.body,
      last_sent_at: msg.sent_at,
      ...(inbound
        ? {
            last_inbound_at: msg.sent_at,
            unread_count: openKey === key ? 0 : existing.unread_count + 1,
          }
        : {}),
    };
    return {
      conversations: [updated, ...list.filter(c => c.phone_digits !== key)],
      isNewThread: false,
    };
  }
  // Un messaggio in uscita verso un numero mai visto non apre un thread qui:
  // lo porta il refresh, con nome e conteggi dal server.
  if (!inbound) return { conversations: list, isNewThread: false };
  const created: ConversationSummary = {
    phone_digits: key,
    phone: msg.from_phone,
    last_channel: msg.channel,
    last_direction: 'inbound',
    last_body: msg.body,
    last_sent_at: msg.sent_at,
    last_reservation_id: msg.reservation_id,
    unread_count: openKey === key ? 0 : 1,
    last_inbound_at: msg.sent_at,
    customer_name: null,
  };
  return { conversations: [created, ...list], isNewThread: true };
};

/** Lettura fatta altrove (altro operatore, altro dispositivo): azzera i non
 *  letti di quel thread nella lista in cache. */
export const cacheMarkThreadRead = (phoneDigits: string): void => {
  const key = phoneMatchKey(String(phoneDigits));
  if (!key || !inboxCache.conversations) return;
  inboxCache.conversations = inboxCache.conversations.map(c =>
    c.phone_digits === key ? { ...c, unread_count: 0 } : c
  );
};


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

  /** Pre-scalda la cache al login, così il primo ingresso in Messaggi trova la
   *  lista pronta invece dello spinner. Silenzioso: se fallisce, la pagina
   *  farà comunque il suo fetch. */
  async prefetchConversations(): Promise<void> {
    if (inboxCache.conversations) return;
    try {
      const { conversations } = await this.listConversations();
      inboxCache.conversations = conversations;
    } catch { /* niente: il caricamento normale copre */ }
  }

  /** Come sopra ma riscrive anche una cache già piena: serve quando la
   *  ricostruzione locale non basta (thread nuovo, nome cliente da riempire).
   *  Silenzioso come il prefetch. */
  async refreshConversationsCache(): Promise<void> {
    try {
      const { conversations } = await this.listConversations();
      inboxCache.conversations = conversations;
    } catch { /* niente: la pagina rifà il suo fetch all'apertura */ }
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
