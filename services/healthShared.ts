// Supporto, fase 2 — il vocabolario della «salute» condiviso fra server e
// client. Nessun import (vedi supportShared.ts).

export const APP_ERROR_ORIGINS = ['client', 'sofia'] as const;
export type AppErrorOrigin = typeof APP_ERROR_ORIGINS[number];

export const PLATFORM_ALERT_KINDS = ['stampa', 'fiscale', 'sofia', 'nodo'] as const;
export type PlatformAlertKind = typeof PLATFORM_ALERT_KINDS[number];

export const INCIDENT_LEVELS = ['info', 'critico'] as const;
export type IncidentLevel = typeof INCIDENT_LEVELS[number];

export const INCIDENT_MESSAGE_MAX = 240;
/** Errori accettati per chiamata: il client li accumula e li manda a lotti. */
export const CLIENT_ERRORS_PER_BATCH = 10;

/** Un errore come lo manda il browser. */
export interface ClientErrorReport {
  source: 'boundary' | 'onerror' | 'rejection';
  message: string;
  stack?: string;
  view?: string;
  app_version?: string;
  /** Per le schede (CardErrorBoundary): quale pezzo di pagina è caduto. */
  label?: string;
}

export interface ActiveIncident {
  id: number;
  message: string;
  level: IncidentLevel;
  created_at: string;
}

export interface PlatformAlert {
  id: number;
  tenant_id: number;
  tenant_name: string;
  kind: PlatformAlertKind;
  detail: Record<string, unknown>;
  opened_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

export interface AppErrorGroup {
  fingerprint: string;
  origin: AppErrorOrigin;
  source: string;
  message: string;
  occurrences: number;
  tenants: Array<{ id: number; name: string }>;
  users: number;
  last_seen: string;
  last_version: string | null;
  last_view: string | null;
}

export interface AppErrorOccurrence {
  id: number;
  tenant_name: string;
  user_role: string | null;
  view: string | null;
  app_version: string | null;
  user_agent: string | null;
  stack: string | null;
  created_at: string;
}

export interface PlatformIncident extends ActiveIncident {
  target_tenant_ids: number[];
  resolved_at: string | null;
}

export interface PlatformHealth {
  alerts_open: PlatformAlert[];
  alerts_recent: PlatformAlert[];
  errors: AppErrorGroup[];
  incidents: PlatformIncident[];
}

const VALID_SOURCES = new Set(['boundary', 'onerror', 'rejection']);

/** Il lotto del client, ripulito: niente campi sconosciuti, testi tagliati.
 *  null se non è un lotto valido. */
export function sanitizeClientErrors(input: unknown): ClientErrorReport[] | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const list = (input as { errors?: unknown }).errors;
  if (!Array.isArray(list) || list.length === 0 || list.length > CLIENT_ERRORS_PER_BATCH) return null;
  const out: ClientErrorReport[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const source = String(r.source ?? '');
    const message = typeof r.message === 'string' ? r.message.trim() : '';
    if (!VALID_SOURCES.has(source) || !message) return null;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
    out.push({
      source: source as ClientErrorReport['source'],
      message: message.slice(0, 500),
      stack: str(r.stack, 4000),
      view: str(r.view, 40),
      app_version: str(r.app_version, 20),
      label: str(r.label, 60),
    });
  }
  return out;
}

/** La forma «stabile» di un messaggio: numeri, id e url cambiano a ogni
 *  occorrenza e spezzerebbero il raggruppamento dello stesso errore. */
export function normalizeErrorMessage(message: string): string {
  return message
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Il primo frame dello stack senza riga, colonna e hash del bundle: lo
 *  stesso errore dopo un deploy resta lo stesso gruppo. */
export function firstStackFrame(stack: string | undefined | null): string {
  if (!stack) return '';
  const line = stack.split('\n').map(s => s.trim()).find(s => s.startsWith('at ') || s.includes('@')) ?? '';
  return line
    .replace(/:\d+:\d+\)?$/, '')
    .replace(/-[A-Za-z0-9_]{6,}\.js/g, '.js')
    .replace(/https?:\/\/[^/\s]+/g, '')
    .slice(0, 160);
}
