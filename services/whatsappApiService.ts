// Impostazioni › WhatsApp: stato del numero, template, consumi del mese.
// Le rotte stanno in services/whatsapp/routes.ts (backend).

import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

export interface WhatsAppStatus {
  connected: boolean;
  provider: 'twilio' | 'meta' | null;
  source: 'env' | null;
  phone: string | null;
  /** Il locale scrive con le credenziali Twilio in env (il Frantoio, o un
   *  demo ammesso esplicitamente). */
  shared_env_sender: boolean;
  sms_ready: boolean;
  webhooks: { inbound: string; status: string } | null;
}

export type TemplateApproval = 'approved' | 'pending' | 'rejected' | 'unsubmitted' | 'unknown';

export interface WhatsAppTemplateRow {
  key: string;
  label: string;
  group: 'prenotazioni' | 'caparre' | 'conto' | 'recensioni' | 'banchetti' | 'asporto' | 'marketing';
  category: 'UTILITY' | 'MARKETING';
  languages: Array<{
    language: 'it' | 'en';
    configured: boolean;
    approval: TemplateApproval | null;
    rejectionReason: string | null;
  }>;
}

export interface WhatsAppUsage {
  month: string;
  whatsapp: {
    inbound: number;
    outboundStaff: number;
    outboundAutomatic: number;
    failed: number;
    byKind: Record<string, number>;
  };
  sms: { outbound: number; failed: number };
  ai: { runs: number; costUsd: number; costEur: number; unpriced: number };
}

const getHeaders = (): HeadersInit => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
    throw buildApiError(response.status, errorData);
  }
  return response.json();
};

export const getWhatsAppStatus = (): Promise<WhatsAppStatus> =>
  apiRequest(`${API_URL}/whatsapp/status`, { headers: getHeaders() });

export const getWhatsAppTemplates = (): Promise<{ templates: WhatsAppTemplateRow[] }> =>
  apiRequest(`${API_URL}/whatsapp/templates`, { headers: getHeaders() });

export const getWhatsAppUsage = (): Promise<WhatsAppUsage> =>
  apiRequest(`${API_URL}/whatsapp/usage`, { headers: getHeaders() });

// ── L'agente che parte da solo ─────────────────────────────────────────

export type AgentMode = 'off' | 'draft' | 'reply' | 'actions';

export interface AgentAutoActions {
  create: boolean;
  modify: boolean;
  cancel: boolean;
  notes: boolean;
  /** Assente su un backend precedente alla Fase 10. */
  takeaway?: boolean;
}

export interface AgentPolicy {
  mode: AgentMode;
  debounce_seconds: number;
  max_wait_seconds: number;
  staff_quiet_minutes: number;
  max_replies_per_thread_24h: number;
  max_runs_per_day: number;
  daily_budget_eur: number;
  auto_actions: AgentAutoActions;
  confirm_cancel: boolean;
}

export const getAgentPolicy = (): Promise<{ agent: AgentPolicy }> =>
  apiRequest(`${API_URL}/whatsapp/settings`, { headers: getHeaders() });

export const saveAgentPolicy = (agent: Partial<AgentPolicy>): Promise<{ agent: AgentPolicy }> =>
  apiRequest(`${API_URL}/whatsapp/settings`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify({ agent }) });

export interface AgentThreadState {
  mode: AgentMode;
  paused: boolean;
  paused_until: string | null;
  pause_reason: 'manual' | 'bot_suspected' | string | null;
  draft: { run_id: number; text: string; at: string } | null;
  last_run: { status: string; outcome: string | null; skip_reason: string | null; finished_at: string | null } | null;
  proposal: {
    id: number; tool: string; args: Record<string, any>; summary: string;
    suggested_reply: string | null; status: string; expires_at: string; reservation_id: number | null;
  } | null;
  /** Assente su un backend precedente alla Fase 7. */
  actions?: AgentActionRow[];
}

/** Un'azione che l'agente ha fatto da solo, col suo «Annulla». */
export interface AgentActionRow {
  id: number;
  tool: string;
  summary: string;
  reservation_id: number | null;
  at: string;
  undone_at: string | null;
  undoable: boolean;
}

export const undoAgentAction = (actionId: number): Promise<{ ok: boolean; reservation_id: number }> =>
  apiRequest(`${API_URL}/whatsapp/agent/actions/${actionId}/undo`, { method: 'POST', headers: getHeaders() });

export const getAgentThread = (phoneDigits: string): Promise<AgentThreadState> =>
  apiRequest(`${API_URL}/whatsapp/agent/thread/${encodeURIComponent(phoneDigits)}`, { headers: getHeaders() });

export const pauseAgentThread = (phoneDigits: string, per: '1h' | 'tomorrow' | 'always' | 'resume'): Promise<{ ok: boolean }> =>
  apiRequest(`${API_URL}/whatsapp/agent/thread/${encodeURIComponent(phoneDigits)}/pause`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ for: per }),
  });

export const markAgentDraft = (runId: number, state: 'used' | 'discarded'): Promise<{ ok: boolean }> =>
  apiRequest(`${API_URL}/whatsapp/agent/runs/${runId}/draft`, {
    method: 'POST', headers: getHeaders(), body: JSON.stringify({ state }),
  });

export interface SimulationResult {
  outcome: 'would_reply' | 'drafted' | 'no_reply' | null;
  status: string;
  reply: string | null;
  proposal: { tool: string; summary: string } | null;
  actions?: Array<{ tool: string; summary: string }>;
  skipped: string | null;
  note: string | null;
}

export const simulateAgent = (text: string, mode: Exclude<AgentMode, 'off'>): Promise<SimulationResult> =>
  apiRequest(`${API_URL}/whatsapp/agent/simulate`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ text, mode }) });

export const resetAgentSimulation = (): Promise<{ ok: boolean }> =>
  apiRequest(`${API_URL}/whatsapp/agent/simulate`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ reset: true }) });

// ── Promemoria con tasti e «Farsi trovare» ─────────────────────────────

export interface RemindersPolicy {
  quick_replies: boolean;
}

export interface EntryPolicy {
  show_on_booking_page: boolean;
  show_on_menu: boolean;
  prefill_text: string;
}

export interface MediaPolicy {
  transcribe_voice: boolean;
  read_photos: boolean;
}

export interface WhatsAppSettings {
  agent: AgentPolicy;
  /** Assenti su un backend precedente alla Fase 8. */
  reminders?: RemindersPolicy;
  entry?: EntryPolicy;
  /** Assenti su un backend precedente alla Fase 9. */
  media?: MediaPolicy;
  transcription_ready?: boolean;
  /** Assenti su un backend precedente alla Fase 10. */
  takeaway?: TakeawayChatPolicy;
  takeaway_available?: boolean;
  /** Assente su un backend precedente alla Fase 11. */
  campaigns?: CampaignsPolicy;
}

export interface TakeawayChatPolicy {
  enabled: boolean;
  notify_ready: boolean;
}

export const getWhatsAppSettings = (): Promise<WhatsAppSettings> =>
  apiRequest(`${API_URL}/whatsapp/settings`, { headers: getHeaders() });

export const saveWhatsAppSettings = (patch: { reminders?: Partial<RemindersPolicy>; entry?: Partial<EntryPolicy>; media?: Partial<MediaPolicy>; takeaway?: Partial<TakeawayChatPolicy>; campaigns?: Partial<CampaignsPolicy> }): Promise<WhatsAppSettings> =>
  apiRequest(`${API_URL}/whatsapp/settings`, { method: 'PUT', headers: getHeaders(), body: JSON.stringify(patch) });

/** Il testo che il cliente trova già scritto, se il locale non ne sceglie uno. */
export const DEFAULT_WA_PREFILL = 'Ciao! Vorrei prenotare un tavolo.';

export const waMeUrl = (phoneE164: string, text?: string | null): string => {
  const digits = phoneE164.replace(/\D/g, '');
  const t = (text ?? '').trim();
  return `https://wa.me/${digits}${t ? `?text=${encodeURIComponent(t)}` : ''}`;
};

// ── Campagne ────────────────────────────────────────────────────────────

export interface CampaignsPolicy {
  enabled: boolean;
  send_from_hour: number;
  send_to_hour: number;
  pause_days: number;
  monthly_budget_eur: number;
}

export interface CampaignSegment {
  last_visit_days_min?: number | null;
  min_visits?: number | null;
  vip_only?: boolean;
  language?: 'it' | 'en' | null;
}

export interface CampaignRow {
  id: number;
  name: string;
  message: string;
  segment: CampaignSegment;
  status: 'draft' | 'sending' | 'paused' | 'done' | 'cancelled';
  pause_reason: string | null;
  recipients_count: number;
  estimated_cost_cents: number;
  created_at: string;
  confirmed_at: string | null;
  finished_at: string | null;
  sent: number;
  skipped: number;
  failed: number;
  waiting: number;
}

export interface CampaignsReadiness {
  enabled: boolean;
  legal_ok: boolean;
  template_ready: boolean;
  unit_cost_cents: number;
  month_spent_cents: number;
  monthly_budget_cents: number;
  pause_days: number;
  send_window: [number, number];
}

export const listCampaigns = (): Promise<{ campaigns: CampaignRow[]; readiness: CampaignsReadiness }> =>
  apiRequest(`${API_URL}/whatsapp/campaigns`, { headers: getHeaders() });

export const previewCampaign = (segment: CampaignSegment): Promise<{ count: number; sample: string[]; estimated_cost_cents: number }> =>
  apiRequest(`${API_URL}/whatsapp/campaigns/preview`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ segment }) });

export const createCampaign = (c: { name: string; message: string; segment: CampaignSegment }): Promise<{ campaign: CampaignRow }> =>
  apiRequest(`${API_URL}/whatsapp/campaigns`, { method: 'POST', headers: getHeaders(), body: JSON.stringify(c) });

export const startCampaign = (id: number, confirmCostCents: number): Promise<{ ok: boolean; recipients?: number; estimated_cost_cents?: number }> =>
  apiRequest(`${API_URL}/whatsapp/campaigns/${id}/start`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ confirm_cost_cents: confirmCostCents }) });

export const cancelCampaign = (id: number): Promise<{ ok: boolean }> =>
  apiRequest(`${API_URL}/whatsapp/campaigns/${id}/cancel`, { method: 'POST', headers: getHeaders() });
