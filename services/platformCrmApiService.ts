import { authApiService } from './authApiService';
import { buildApiError } from './apiError';

/* CRM della piattaforma: le rotte /admin/crm (services/platformCrmRoutes.ts)
   lette dal pannello Piattaforma. Stesso schema di healthApiService: bearer
   della sessione di pannello, un refresh al 401, il `message` del server
   nell'errore quando c'è. */

const API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

const headers = (json = false): Record<string, string> => {
  const h: Record<string, string> = {};
  const token = authApiService.getAccessToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
};

const fetchWithAuth = async (url: string, options: RequestInit = {}, retried = false): Promise<Response> => {
  const response = await fetch(url, options);
  if (response.status === 401 && !retried) {
    const refreshed = await authApiService.refreshToken();
    if (refreshed) {
      const next = { ...options.headers } as Record<string, string>;
      next['Authorization'] = `Bearer ${refreshed.accessToken}`;
      return fetchWithAuth(url, { ...options, headers: next }, true);
    }
  }
  return response;
};

const apiRequest = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithAuth(`${API_URL}/admin/crm${path}`, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    const err = buildApiError(response.status, errorData);
    if (typeof errorData?.message === 'string' && errorData.message.trim()) err.message = errorData.message;
    throw err;
  }
  if (response.status === 204) return undefined as T;
  return response.json();
};

const send = <T>(method: string, path: string, body?: unknown): Promise<T> =>
  apiRequest<T>(path, { method, headers: headers(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body) });

/* ── Tipi ─────────────────────────────────────────────────────────────── */

export const CRM_STAGES = ['lead', 'contattato', 'demo', 'proposta', 'prova', 'cliente', 'perso', 'disdetto'] as const;
export type CrmStage = typeof CRM_STAGES[number];
export const CRM_PRESALE_STAGES: CrmStage[] = ['lead', 'contattato', 'demo', 'proposta'];

export const CRM_ACTIVITY_KINDS = ['nota', 'chiamata', 'email', 'incontro', 'demo', 'whatsapp'] as const;
export type CrmActivityKind = typeof CRM_ACTIVITY_KINDS[number];

export const CRM_DEAL_STAGES = ['nuova', 'demo', 'proposta', 'trattativa', 'vinta', 'persa'] as const;
export type CrmDealStage = typeof CRM_DEAL_STAGES[number];
export const CRM_DEAL_KINDS = ['nuovo', 'upsell', 'rinnovo'] as const;
export type CrmDealKind = typeof CRM_DEAL_KINDS[number];

export type CrmHealthLevel = 'sano' | 'da_seguire' | 'a_rischio';

export interface CrmHealth {
  score: number;
  level: CrmHealthLevel;
  signals: string[];
  metrics: {
    users: number;
    active_users_7d: number;
    last_seen_at: string | null;
    reservations_30d: number;
    reservations_prev_30d: number;
    voice_calls_30d: number;
    open_tickets: number;
    urgent_tickets: number;
    open_alerts: number;
  };
}

export interface CrmBilling {
  status: string;
  mrr_cents: number;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

export interface CrmContactSummary {
  id: number;
  full_name: string;
  role: string | null;
  phone: string | null;
  email: string | null;
}

/** I campi che la scheda scrive: quelli che il form invia. */
export interface CrmAccountFields {
  name: string;
  stage: CrmStage;
  internal: boolean;
  business_type: string | null;
  source: string | null;
  current_software: string | null;
  city: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  legal_name: string | null;
  vat_number: string | null;
  sdi_code: string | null;
  pec: string | null;
  seats: number | null;
  locations: number | null;
  expected_mrr_cents: number | null;
  contract_start: string | null;
  renewal_date: string | null;
  lost_reason: string | null;
  notes: string | null;
  tags: string[];
}

export interface CrmAccount extends CrmAccountFields {
  id: number;
  onboarding: Record<string, string>;
  stage_changed_at: string;
  created_at: string;
  updated_at: string;
  customer_tenant_id: number | null;
  tenant: {
    id: number;
    slug: string;
    status: 'active' | 'suspended';
    billing_status: string | null;
    features: string[];
    user_count: number;
    created_at: string;
  } | null;
  health: CrmHealth | null;
  billing: CrmBilling | null;
  /** Stripe se c'è, altrimenti il canone scritto nella scheda (solo clienti). */
  mrr_cents: number;
  mrr_source: 'stripe' | 'accordo' | null;
  primary_contact: CrmContactSummary | null;
  open_tasks: number;
  overdue_tasks: number;
  next_task_due: string | null;
  open_deals: number;
  open_deals_mrr_cents: number;
  last_activity_at: string | null;
}

export interface CrmContact extends CrmContactSummary {
  is_primary: boolean;
  notes: string | null;
  created_at: string;
}

export interface CrmTask {
  id: number;
  account_id: number | null;
  account_name: string | null;
  title: string;
  due_date: string;
  priority: 'alta' | 'normale';
  done: boolean;
  done_at: string | null;
  created_at: string;
}

export interface CrmDeal {
  id: number;
  account_id: number;
  account_name: string | null;
  title: string;
  kind: CrmDealKind;
  stage: CrmDealStage;
  mrr_cents: number;
  setup_cents: number;
  probability: number | null;
  /** La probabilità scritta, o quella di default della fase. */
  effective_probability: number;
  expected_close: string | null;
  closed_at: string | null;
  lost_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrmTimelineItem {
  id: string;
  kind: CrmActivityKind | 'sistema' | 'supporto' | 'avviso';
  body: string;
  occurred_at: string;
  author_name: string | null;
  contact_name: string | null;
  activity_id: number | null;
  ticket_id: number | null;
}

export interface CrmOnboardingStep {
  key: string;
  label: string;
  done: boolean;
  /** Riconosciuto dai dati del ristorante: non si toglie a mano. */
  auto: boolean;
  done_at: string | null;
}

export interface CrmAccountDetail extends CrmAccount {
  contacts: CrmContact[];
  tasks: CrmTask[];
  deals: CrmDeal[];
  timeline: CrmTimelineItem[];
  onboarding_steps: CrmOnboardingStep[];
}

export interface CrmAccountSummary {
  id: number;
  name: string;
  stage: CrmStage;
  city: string | null;
  health: CrmHealth | null;
  mrr_cents: number;
  billing: CrmBilling | null;
  renewal_date: string | null;
}

export interface CrmOverview {
  stripe: boolean;
  mrr_cents: number;
  arpa_cents: number;
  by_stage: Record<CrmStage, number>;
  customers: number;
  trials: number;
  open_leads: number;
  new_customers_month: number;
  churned_month: number;
  pipeline: {
    open_deals: number;
    mrr_cents: number;
    weighted_mrr_cents: number;
    won_month: number;
    won_month_mrr_cents: number;
  };
  tasks_due: CrmTask[];
  at_risk: CrmAccountSummary[];
  expiring: CrmAccountSummary[];
  recent_activities: Array<{
    id: number;
    account_id: number;
    account_name: string;
    kind: CrmTimelineItem['kind'];
    body: string;
    occurred_at: string;
    author_name: string | null;
  }>;
}

export type CrmImportRow = Partial<Record<keyof CrmAccountFields | 'contact_name' | 'contact_role' | 'contact_email' | 'contact_phone', string>>;

/* ── Chiamate ─────────────────────────────────────────────────────────── */

export const platformCrmApi = {
  overview: () => apiRequest<CrmOverview>('/overview', { headers: headers() }),

  listAccounts: async (): Promise<CrmAccount[]> => {
    const res = await apiRequest<{ accounts: CrmAccount[] }>('/accounts', { headers: headers() });
    return Array.isArray(res.accounts) ? res.accounts : [];
  },
  getAccount: (id: number) => apiRequest<CrmAccountDetail>(`/accounts/${id}`, { headers: headers() }),
  createAccount: (input: Partial<CrmAccountFields> & { contact?: Partial<CrmContact> }) =>
    send<CrmAccountDetail>('POST', '/accounts', input),
  updateAccount: (id: number, patch: Partial<CrmAccountFields> & { onboarding?: Record<string, boolean> }) =>
    send<CrmAccountDetail>('PATCH', `/accounts/${id}`, patch),
  deleteAccount: (id: number) => send<void>('DELETE', `/accounts/${id}`),
  linkTenant: (id: number, tenantId: number) => send<CrmAccountDetail>('POST', `/accounts/${id}/link`, { tenant_id: tenantId }),
  importAccounts: (rows: CrmImportRow[]) =>
    send<{ created: number; skipped: number; errors: Array<{ row: number; message: string }> }>('POST', '/accounts/import', { rows }),

  addContact: (accountId: number, input: Partial<CrmContact>) => send<CrmAccountDetail>('POST', `/accounts/${accountId}/contacts`, input),
  updateContact: (id: number, patch: Partial<CrmContact>) => send<CrmAccountDetail>('PATCH', `/contacts/${id}`, patch),
  deleteContact: (id: number) => send<CrmAccountDetail>('DELETE', `/contacts/${id}`),

  addActivity: (accountId: number, input: { kind: CrmActivityKind; body: string; occurred_at?: string; contact_id?: number | null }) =>
    send<CrmAccountDetail>('POST', `/accounts/${accountId}/activities`, input),
  deleteActivity: (id: number) => send<CrmAccountDetail>('DELETE', `/activities/${id}`),

  listTasks: async (status: 'open' | 'done' = 'open'): Promise<CrmTask[]> => {
    const res = await apiRequest<{ tasks: CrmTask[] }>(`/tasks?status=${status}`, { headers: headers() });
    return Array.isArray(res.tasks) ? res.tasks : [];
  },
  createTask: (input: { title: string; due_date: string; priority?: CrmTask['priority']; account_id?: number | null }) =>
    send<CrmTask>('POST', '/tasks', input),
  updateTask: (id: number, patch: Partial<Pick<CrmTask, 'title' | 'due_date' | 'priority' | 'done'>>) =>
    send<CrmTask>('PATCH', `/tasks/${id}`, patch),
  deleteTask: (id: number) => send<void>('DELETE', `/tasks/${id}`),

  listDeals: async (): Promise<CrmDeal[]> => {
    const res = await apiRequest<{ deals: CrmDeal[] }>('/deals', { headers: headers() });
    return Array.isArray(res.deals) ? res.deals : [];
  },
  createDeal: (accountId: number, input: Partial<CrmDeal>) => send<CrmDeal>('POST', `/accounts/${accountId}/deals`, input),
  updateDeal: (id: number, patch: Partial<CrmDeal>) => send<CrmDeal>('PATCH', `/deals/${id}`, patch),
  deleteDeal: (id: number) => send<void>('DELETE', `/deals/${id}`),
};
