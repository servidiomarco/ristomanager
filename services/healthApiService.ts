import { authApiService } from './authApiService';
import { buildApiError } from './apiError';
import type {
  ActiveIncident, AppErrorOccurrence, IncidentLevel, PlatformHealth, PlatformIncident,
} from './healthShared';

/* Supporto, fase 2: il banner «problema noto» letto dai ristoranti
   (/incidents/active) e la tab «Salute» del pannello (/admin/health,
   /admin/incidents). Stesso schema di supportApiService. */

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

const apiRequest = async <T>(url: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetchWithAuth(url, { cache: 'no-store', ...options });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Request failed' }));
    const err = buildApiError(response.status, errorData);
    // Le rotte del supporto mandano accanto al codice (`error`) una frase
    // per chi legge (`message`): è quella che va mostrata. Senza, la vista
    // Aiuto mostrava «ai_key_invalid» o «invalid_subject» al ristoratore.
    if (typeof errorData?.message === 'string' && errorData.message.trim()) err.message = errorData.message;
    throw err;
  }
  return response.json();
};

class HealthApiService {
  async activeIncidents(): Promise<ActiveIncident[]> {
    const res = await apiRequest<{ incidents: ActiveIncident[] }>(`${API_URL}/incidents/active`, { headers: headers() });
    return Array.isArray(res.incidents) ? res.incidents : [];
  }

  async adminHealth(hours = 24): Promise<PlatformHealth> {
    return apiRequest(`${API_URL}/admin/health?hours=${hours}`, { headers: headers() });
  }

  async runCheck(): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/admin/health/check`, { method: 'POST', headers: headers() });
  }

  async adminErrorOccurrences(fingerprint: string): Promise<AppErrorOccurrence[]> {
    const res = await apiRequest<{ occurrences: AppErrorOccurrence[] }>(
      `${API_URL}/admin/health/errors/${encodeURIComponent(fingerprint)}`, { headers: headers() });
    return res.occurrences;
  }

  async createIncident(input: { message: string; level: IncidentLevel; tenant_ids: number[] }): Promise<PlatformIncident> {
    return apiRequest(`${API_URL}/admin/incidents`, {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify(input),
    });
  }

  async resolveIncident(id: number): Promise<{ ok: true }> {
    return apiRequest(`${API_URL}/admin/incidents/${id}/resolve`, { method: 'POST', headers: headers() });
  }
}

export const healthApiService = new HealthApiService();
