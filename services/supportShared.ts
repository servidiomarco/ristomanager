// Supporto clienti (Aiuto): il vocabolario che server e client condividono.
// Nessun import, così il file vale per entrambi i lati senza la regola delle
// estensioni .js (vedi CLAUDE.md).

export const SUPPORT_CATEGORIES = ['stampa', 'cassa_fiscale', 'sofia', 'prenotazioni', 'menu', 'fatturazione', 'altro'] as const;
export type SupportCategory = typeof SUPPORT_CATEGORIES[number];

export const SUPPORT_PRIORITIES = ['urgente', 'normale'] as const;
export type SupportPriority = typeof SUPPORT_PRIORITIES[number];

export const SUPPORT_STATUSES = ['nuovo', 'in_corso', 'attesa_cliente', 'risolto'] as const;
export type SupportStatus = typeof SUPPORT_STATUSES[number];

export const SUPPORT_SUBJECT_MAX = 160;
export const SUPPORT_BODY_MAX = 5000;
export const SUPPORT_ATTACHMENTS_MAX = 3;

export interface SupportAttachment {
  token: string;
  content_type: string;
  filename: string | null;
}

export interface SupportMessage {
  id: number;
  author_type: 'utente' | 'piattaforma';
  author_name: string | null;
  body: string;
  attachments: SupportAttachment[];
  created_at: string;
}

export interface SupportTicket {
  id: number;
  tenant_id: number;
  category: SupportCategory;
  priority: SupportPriority;
  status: SupportStatus;
  subject: string;
  created_by_user_id: number | null;
  created_by_name: string | null;
  tenant_unread: boolean;
  platform_unread: boolean;
  dev_card_id: number | null;
  created_at: string;
  updated_at: string;
  last_message_at: string;
  resolved_at: string | null;
  /** Fase 4: com'è andata, detto da chi ha aperto la richiesta (1 / -1). */
  rating?: 1 | -1 | null;
  rating_comment?: string | null;
  rated_at?: string | null;
  /** Solo nella vista di piattaforma. */
  tenant_name?: string;
  tenant_slug?: string;
}

export const SUPPORT_RATING_COMMENT_MAX = 500;

export interface SupportMetrics {
  days: number;
  opened: number;
  resolved: number;
  /** Mediane: null quando nel periodo non c'è niente da misurare. */
  median_first_reply_minutes: number | null;
  median_resolution_hours: number | null;
  rating_up: number;
  rating_down: number;
  by_category: Array<{ category: SupportCategory; n: number }>;
}

export interface NewsEntry {
  date: string;
  section: string;
  text: string;
}

export interface SupportTicketDetail extends SupportTicket {
  context: Record<string, unknown>;
  messages: SupportMessage[];
}

// Il contesto che il client manda da sé: solo queste chiavi, solo valori
// semplici. Tutto il resto lo raccoglie il server, che è l'unico di cui
// fidarsi su tenant, utente e versione.
const CLIENT_CONTEXT_KEYS = [
  'origin_view', 'app_version', 'user_agent', 'viewport', 'dpr', 'standalone',
  'language', 'timezone', 'online', 'socket_connected', 'offline_queue',
  'node_hybrid', 'node_in_use',
] as const;
const CLIENT_CONTEXT_MAX_BYTES = 4096;

export function sanitizeClientContext(input: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  for (const key of CLIENT_CONTEXT_KEYS) {
    const v = src[key];
    if (v === null) out[key] = null;
    else if (typeof v === 'boolean') out[key] = v;
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
    else if (typeof v === 'string') out[key] = v.slice(0, 300);
  }
  // Il tetto vale sul risultato: con 13 chiavi da 300 caratteri al massimo
  // non si arriva a 4 KB, ma la guardia resta se la lista cresce.
  if (JSON.stringify(out).length > CLIENT_CONTEXT_MAX_BYTES) return {};
  return out;
}

/** Il tag della notifica al ristorante: una riga per ticket, si riaccende a
 *  ogni risposta della piattaforma. */
export const supportTenantTag = (ticketId: number): string => `support-${ticketId}`;
/** Il tag dell'avviso ai platform admin, distinto da quello del ristorante:
 *  le due righe vivono su tenant diversi e si chiudono in momenti diversi. */
export const supportPlatformTag = (ticketId: number): string => `support-admin-${ticketId}`;
