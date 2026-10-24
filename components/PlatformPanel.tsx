import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Building2 } from 'lucide-react';
import { SegmentedControl } from './ds';
import { PlatformSupportTab } from './PlatformSupportTab';
import { PlatformHealthTab } from './PlatformHealthTab';
import { PlatformCrmOverview } from './PlatformCrmOverview';
import { PlatformCrmAccounts } from './PlatformCrmAccounts';
import { PlatformCrmPipeline } from './PlatformCrmPipeline';
import { PlatformCrmTasks } from './PlatformCrmTasks';
import { todayRome } from './PlatformCrmShared';
import {
  PLATFORM_SESSION_KEY, enterTenantSession, impersonateTenantOwner, readSavedPlatformSession,
} from './PlatformTenantAdmin';
import { healthApiService } from '../services/healthApiService';
import { onSocketEvent } from '../services/socketEvents';
import { supportApiService, onSupportSocketEvent } from '../services/supportApiService';
import { platformCrmApi, type CrmAccount, type CrmAccountDetail } from '../services/platformCrmApiService';
import { useAuth } from '../contexts/AuthContext';
import { authApiService } from '../services/authApiService';
import { adminListTenants, type AdminTenant } from '../services/apiService';
import type { ApiError } from '../services/apiError';

// Le sessioni dentro un tenant e la card del ristorante stanno in
// PlatformTenantAdmin.tsx; i nomi restano esportati anche da qui.
export { PLATFORM_SESSION_KEY, enterTenantSession, impersonateTenantOwner };

/* ============================================
   PANNELLO PIATTAFORMA (Fase D2, CRM dal 24/10/2026)
   ============================================
   Il pannello del PLATFORM_ADMIN è il CRM dei clienti di Sympotia:
   Panoramica (MRR, cosa fare oggi, chi è a rischio), Clienti (lead e
   ristoranti, scheda completa), Pipeline (opportunità), Promemoria, più
   Supporto e Salute. Rotte /admin/crm (services/platformCrmRoutes.ts) e
   /admin/tenants (services/apiService.ts). */

/** Solo il payload, senza verificare la firma: qui serve leggere un claim,
 *  la validità la decide il server a ogni richiesta. */
export const decodeJwtPayload = (token: string | null): Record<string, unknown> | null => {
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
};

/* ── Banner di impersonation e sessione di piattaforma ────────────────────
   Fisso in alto su OGNI vista finché il token porta il claim impersonated_by
   (impersonation: sei l'OWNER per 15 minuti) oppure scopedTenantId (sessione
   di piattaforma: sei tu, dentro il tenant, sopra la matrice permessi).
   Il fondo è il solid delle azioni: deve essere impossibile dimenticare di
   stare dentro il tenant di qualcun altro. */
export const ImpersonationBanner: React.FC = () => {
  const { user } = useAuth();
  const claims = useMemo(() => decodeJwtPayload(authApiService.getAccessToken()), []);
  const isImpersonation = !!claims?.impersonated_by;
  const isPlatformScope = !isImpersonation && !!claims?.scopedTenantId;
  if (!claims || (!isImpersonation && !isPlatformScope)) return null;

  const saved = readSavedPlatformSession();
  const tenantLabel = user?.tenant?.name || saved?.tenant.slug || 'il tenant';
  const email = user?.email || String(claims.email || '');

  const backToPanel = () => {
    if (saved) authApiService.restoreSessionSnapshot(saved.snapshot);
    // Senza sessione salvata (tab diversa, storage pulito) non c'è niente da
    // ripristinare: si esce e si rientra dal login.
    else authApiService.clearAuth();
    localStorage.removeItem(PLATFORM_SESSION_KEY);
    window.location.reload();
  };

  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 z-[70] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]"
    >
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-3 py-2 sm:px-4">
        <Building2 className="h-4 w-4 flex-shrink-0" aria-hidden />
        <p className="min-w-0 flex-1 truncate text-[13px]">
          {isImpersonation ? (
            <>stai vedendo <span className="font-semibold">{tenantLabel}</span> come {email} · sessione di 15 minuti</>
          ) : (
            <>operi su <span className="font-semibold">{tenantLabel}</span> come {email} · sessione piattaforma</>
          )}
        </p>
        <button
          type="button"
          onClick={backToPanel}
          className="inline-flex h-8 flex-shrink-0 items-center rounded-[var(--ds-radius-control)] bg-[var(--ds-action-fg)] px-3 text-[12px] font-semibold text-[var(--ds-action-bg)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          torna al pannello
        </button>
      </div>
    </div>
  );
};


/* ── Pannello ────────────────────────────────────────────────────────── */
type Tab = 'panoramica' | 'clienti' | 'pipeline' | 'promemoria' | 'supporto' | 'salute';
const TABS: Tab[] = ['panoramica', 'clienti', 'pipeline', 'promemoria', 'supporto', 'salute'];
type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;

export const PlatformPanel: React.FC<{
  showToast: ShowToast;
  /** Deep link della push di supporto (?support=): apre la tab su quella richiesta. */
  initialSupportTicketId?: number | null;
  onInitialSupportTicketConsumed?: () => void;
  /** Deep link degli avvisi di salute (?salute=1): apre la tab Salute. */
  initialHealth?: boolean;
  onInitialHealthConsumed?: () => void;
}> = ({ showToast, initialSupportTicketId = null, onInitialSupportTicketConsumed, initialHealth = false, onInitialHealthConsumed }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const { t: ts } = useTranslation('supporto', { useSuspense: false });
  const [tab, setTab] = useState<Tab>(initialHealth ? 'salute' : initialSupportTicketId ? 'supporto' : 'panoramica');
  // Avvisi di salute aperti: il numero sul segmento «Salute», come i non
  // letti su «Supporto».
  const [healthOpen, setHealthOpen] = useState(0);
  // Le richieste da leggere, anche a tab chiusa: il numero sul segmento è
  // il motivo per aprirla. La tab, quando è aperta, lo tiene aggiornato.
  const [supportUnread, setSupportUnread] = useState(0);
  // Promemoria in ritardo o di oggi: il numero sul segmento «Promemoria».
  const [tasksDue, setTasksDue] = useState(0);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  // Le schede del CRM: le legge la lista Clienti, e Pipeline e Promemoria
  // per scegliere l'azienda. null finché non arrivano.
  const [accounts, setAccounts] = useState<CrmAccount[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null);

  const loadTenants = useCallback(async () => {
    try {
      setTenants(await adminListTenants());
    } catch (err) {
      showToast((err as ApiError).message || t('errLoad', 'Caricamento non riuscito'), 'error');
    }
  }, [showToast, t]);

  const loadAccounts = useCallback(async () => {
    try {
      setAccountsError(null);
      setAccounts(await platformCrmApi.listAccounts());
    } catch (err) {
      setAccountsError((err as ApiError).message || t('errLoad', 'Caricamento non riuscito'));
    }
  }, [t]);

  const refreshTasksDue = useCallback(() => {
    const today = todayRome();
    platformCrmApi.listTasks('open')
      .then(list => setTasksDue(list.filter(x => x.due_date <= today).length))
      .catch(() => {});
  }, []);

  useEffect(() => { loadTenants(); }, [loadTenants]);
  // Ogni ritorno su una tab del CRM riallinea la lista: fasi, promemoria e
  // salute cambiano anche da un'altra tab (o da un altro dispositivo).
  useEffect(() => {
    if (tab === 'supporto' || tab === 'salute') return;
    loadAccounts();
    refreshTasksDue();
  }, [tab, loadAccounts, refreshTasksDue]);

  // Fuori dalla tab Supporto il numero sul segmento segue gli eventi del
  // supporto; a tab Supporto aperta ci pensa la tab stessa.
  useEffect(() => {
    const refresh = () => {
      supportApiService.adminList().then(r => setSupportUnread(typeof r.unread === 'number' ? r.unread : 0)).catch(() => {});
    };
    refresh();
    if (tab === 'supporto') return;
    return onSupportSocketEvent('support:admin-updated', refresh);
  }, [tab]);

  // Una notifica toccata a pannello già aperto: si passa alla tab.
  useEffect(() => {
    if (initialSupportTicketId) setTab('supporto');
  }, [initialSupportTicketId]);
  useEffect(() => {
    if (!initialHealth) return;
    setTab('salute');
    onInitialHealthConsumed?.();
  }, [initialHealth, onInitialHealthConsumed]);

  // Fuori dalla tab Salute il conteggio degli avvisi segue health:changed;
  // dentro, lo tiene aggiornato la tab stessa.
  useEffect(() => {
    const refresh = () => {
      healthApiService.adminHealth(24).then(h => setHealthOpen(h.alerts_open.length)).catch(() => {});
    };
    refresh();
    if (tab === 'salute') return;
    return onSocketEvent('health:changed', refresh);
  }, [tab]);

  const consumeSupportDeepLink = useCallback(() => onInitialSupportTicketConsumed?.(), [onInitialSupportTicketConsumed]);

  const patchTenant = useCallback((next: AdminTenant) => {
    setTenants(prev => prev.map(x => (x.id === next.id ? next : x)));
  }, []);

  // La scheda aperta riscrive la sua riga: la lista resta allineata senza
  // ricaricarla tutta a ogni nota.
  const accountChanged = useCallback((detail: CrmAccountDetail) => {
    setAccounts(prev => {
      if (!prev) return prev;
      const { contacts: _c, tasks: _k, deals: _d, timeline: _t, onboarding_steps: _o, ...row } = detail;
      return prev.some(a => a.id === row.id) ? prev.map(a => (a.id === row.id ? row : a)) : [...prev, row];
    });
  }, []);

  const accountRemoved = useCallback((id: number) => {
    setAccounts(prev => prev?.filter(a => a.id !== id) ?? prev);
  }, []);

  const openAccount = useCallback((id: number) => {
    setSelectedAccountId(id);
    setTab('clienti');
  }, []);

  const accountOptions = useMemo(
    () => (accounts ?? []).filter(a => a.stage !== 'perso').map(a => ({ id: a.id, name: a.name })),
    [accounts],
  );
  const tenantOptions = useMemo(() => tenants.map(x => ({ id: x.id, name: x.name })), [tenants]);

  const tabSwitch = (
    <div className="flex-shrink-0 px-4 pt-4 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl">
        <SegmentedControl
          value={tab}
          onChange={next => setTab(TABS.includes(next) ? next : 'panoramica')}
          ariaLabel={ts('platform.tabsAria', 'Sezione del pannello')}
          equalWidth={false}
          overflow="scroll"
          options={[
            { value: 'panoramica', label: 'Panoramica' },
            { value: 'clienti', label: t('customers', 'Clienti') },
            { value: 'pipeline', label: 'Pipeline' },
            { value: 'promemoria', label: 'Promemoria', badge: tasksDue || undefined, badgeTone: 'alert' },
            { value: 'supporto', label: ts('platform.tab', 'Supporto'), badge: supportUnread || undefined, badgeTone: 'alert' },
            { value: 'salute', label: ts('platform.health.tab', 'Salute'), badge: healthOpen || undefined, badgeTone: 'alert' },
          ]}
        />
      </div>
    </div>
  );

  const page = (children: React.ReactNode) => (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl p-4 sm:p-6 lg:p-8">{children}</div>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {tabSwitch}
      {tab === 'panoramica' && page(
        <PlatformCrmOverview
          onOpenAccount={openAccount}
          onOpenTasks={() => setTab('promemoria')}
          onOpenPipeline={() => setTab('pipeline')}
          showToast={showToast}
        />,
      )}
      {tab === 'clienti' && (
        <div className="min-h-0 flex-1 pt-3">
          <PlatformCrmAccounts
            accounts={accounts}
            error={accountsError}
            onReload={loadAccounts}
            onAccountChanged={accountChanged}
            onAccountRemoved={accountRemoved}
            selectedId={selectedAccountId}
            onSelect={setSelectedAccountId}
            tenants={tenants}
            onTenantPatched={patchTenant}
            onTenantsChanged={() => { loadTenants(); loadAccounts(); }}
            showToast={showToast}
          />
        </div>
      )}
      {tab === 'pipeline' && page(
        <PlatformCrmPipeline accounts={accountOptions} onOpenAccount={openAccount} showToast={showToast} />,
      )}
      {tab === 'promemoria' && page(
        <PlatformCrmTasks accounts={accountOptions} onOpenAccount={openAccount} showToast={showToast} />,
      )}
      {tab === 'supporto' && (
        <div className="min-h-0 flex-1 pt-3">
          <PlatformSupportTab
            tenants={tenantOptions}
            initialTicketId={initialSupportTicketId}
            onInitialTicketConsumed={consumeSupportDeepLink}
            onUnreadChange={setSupportUnread}
            onEnter={enterTenantSession}
            onImpersonate={impersonateTenantOwner}
            showToast={showToast}
          />
        </div>
      )}
      {tab === 'salute' && (
        <div className="min-h-0 flex-1">
          <PlatformHealthTab
            tenants={tenantOptions}
            onOpenAlertsChange={setHealthOpen}
            showToast={showToast}
          />
        </div>
      )}
    </div>
  );
};
