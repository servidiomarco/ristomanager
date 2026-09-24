import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { displayLocale } from '../utils/formatLocale';
import { AlertTriangle, Building2, Check, Copy, Lock, Plus, RefreshCw } from 'lucide-react';
import {
  ModalShell, FormCard, Field, Callout, EmptyState, StatusPill, CountBadge, StatStrip,
  dsInput, dsButton,
} from './ds';
import { useAuth } from '../contexts/AuthContext';
import { authApiService } from '../services/authApiService';
import {
  adminListTenants, adminCreateTenant, adminUpdateTenant, adminImpersonateTenant, adminEnterTenant,
  adminGetPermissionLocks, adminSetPermissionLocks,
  adminBillingCheckout, adminBillingPortal, adminBillingSummary, adminUpdateAddons, adminUpdateVoicePlan,
  ADMIN_TENANT_FEATURES,
  type AdminTenant, type AdminTenantFeature, type AdminTenantProvisioned, type AdminBillingSummary,
} from '../services/apiService';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA (Fase D2)
   ============================================
   La vista dei tenant per il PLATFORM_ADMIN: lista clienti con stato,
   feature e billing; provisioning di un cliente nuovo; impersonation.
   Parla con le rotte /admin/tenants — vedi services/apiService.ts. */

// Sessione del platform admin messa da parte durante l'impersonation: la
// chiave vive qui perché solo il pannello la scrive e solo il banner la legge.
export const PLATFORM_SESSION_KEY = 'ristocrm_platform_session';

interface SavedPlatformSession {
  snapshot: Record<string, string | null>;
  tenant: { id: number; slug: string; name?: string };
}

const readSavedPlatformSession = (): SavedPlatformSession | null => {
  try {
    const raw = localStorage.getItem(PLATFORM_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.snapshot ? parsed : null;
  } catch {
    return null;
  }
};

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

/* ── Etichette ────────────────────────────────────────────────────────── */

/* I valori (voice, pay_at_table…) sono entitlement: si traduce l'etichetta,
   mai la chiave. `t` a parametro perché queste sono costanti di modulo. */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const FEATURE_LABEL: Record<AdminTenantFeature, string> = {
  voice: 'voce',
  whatsapp: 'whatsapp',
  web_booking: 'web',
  pay_at_table: 'conto al tavolo',
  passepartout: 'cassa passepartout',
  reviews: 'recensioni',
  sala_node: 'nodo di sala',
};

const featureLabel = (f: AdminTenantFeature, t?: TFunc): string =>
  t ? t(`feature.${f}`, FEATURE_LABEL[f]) : FEATURE_LABEL[f];

// billing_status arriva da Stripe via webhook; NULL è il tenant storico senza
// piano, che non è un moroso — per lui niente pill.
const billingPill = (status: string | null, t?: TFunc): { label: string; tone: 'positive' | 'pending' | 'critical' | 'neutral' } | null => {
  const lab = (k: string, it: string) => (t ? t(k, it) : it);
  if (!status) return null;
  switch (status) {
    case 'active': return { label: lab('billing.active', 'abbonato'), tone: 'positive' };
    case 'trialing': return { label: lab('billing.trialing', 'in prova'), tone: 'pending' };
    case 'past_due':
    case 'unpaid': return { label: lab('billing.past_due', 'pagamento scaduto'), tone: 'critical' };
    case 'canceled': return { label: lab('billing.canceled', 'disdetto'), tone: 'neutral' };
    default: return { label: status, tone: 'neutral' };
  }
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString(displayLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
};

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;

/* ── Riga copiabile del pannello una-tantum ─────────────────────────────── */
const SecretRow: React.FC<{ label: string; value: string; showToast: ShowToast }> = ({ label, value, showToast }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast(t('errCopy', 'Copia non riuscita — seleziona e copia a mano'), 'error');
    }
  };
  return (
    <div className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-[var(--ds-text-muted)]">{label}</p>
        <p className="break-all font-mono text-[13px] text-[var(--ds-text-primary)]">{value}</p>
      </div>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copia ${label}`}
        className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        {copied ? <Check className="h-4 w-4 text-[var(--ds-seated-text)]" /> : <Copy className="h-4 w-4" />}
      </button>
    </div>
  );
};

/* ── Card di un tenant ───────────────────────────────────────────────── */
const TenantCard: React.FC<{
  tenant: AdminTenant;
  onPatched: (next: AdminTenant) => void;
  onRevert: (prev: AdminTenant) => void;
  showToast: ShowToast;
}> = ({ tenant, onPatched, onRevert, showToast }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const [confirmingStatus, setConfirmingStatus] = useState(false);
  const [busy, setBusy] = useState<'status' | 'enter' | 'impersonate' | 'billing' | 'addon' | null>(null);
  // Add-on in attesa di conferma: su un tenant abbonato la chip non scatta
  // da sola — cambia la fattura, e i soldi non si toccano per sbaglio.
  const [pendingAddon, setPendingAddon] = useState<AdminTenantFeature | null>(null);
  // Permessi riservati alla piattaforma: editor inline, aperto a richiesta.
  // Bozza separata dal dato caricato, così «Annulla» non lascia residui.
  const [locksOpen, setLocksOpen] = useState(false);
  const [locksCatalog, setLocksCatalog] = useState<{ feature: string; permissions: string[] }[]>([]);
  const [locksDraft, setLocksDraft] = useState<string[]>([]);
  const [locksRevoke, setLocksRevoke] = useState(false);
  const [locksBusy, setLocksBusy] = useState<'load' | 'save' | null>(null);
  // Piano minuti di Sofia: editor inline come i permessi. Campo vuoto =
  // listino (null al server), così un accordo si toglie svuotandolo.
  const [planOpen, setPlanOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState({ price: '', included: '', overage: '' });
  const [planBusy, setPlanBusy] = useState(false);
  const suspended = tenant.status === 'suspended';
  const billing = billingPill(tenant.billing_status, t);
  const abbonato = tenant.billing_status !== null;

  // Toggle feature: PATCH ottimistico — la chip si accende subito, e se il
  // server dice di no si torna com'era, con il motivo nel toast.
  // Solo per i tenant SENZA billing (grandfathered): su un abbonato lo
  // stesso toggle verrebbe riallineato agli item Stripe dal prossimo
  // webhook, quindi lì la chip passa dal picker qui sotto.
  const toggleFeature = async (feature: AdminTenantFeature) => {
    if (abbonato) {
      setPendingAddon(prev => (prev === feature ? null : feature));
      return;
    }
    const enabled = !tenant.features.includes(feature);
    const prev = tenant;
    const optimistic: AdminTenant = {
      ...tenant,
      features: enabled
        ? [...tenant.features, feature].sort()
        : tenant.features.filter(f => f !== feature),
    };
    onPatched(optimistic);
    try {
      const res = await adminUpdateTenant(tenant.id, { features: { [feature]: enabled } });
      // Il server è l'autorità: si riallinea alla sua risposta.
      onPatched({
        ...optimistic,
        features: ADMIN_TENANT_FEATURES.filter(f => res.features[f]),
      });
    } catch (err) {
      onRevert(prev);
      showToast((err as ApiError).message || t('errFeature', 'Aggiornamento feature non riuscito'), 'error');
    }
  };

  // Picker add-on: modifica gli item della subscription (prorazione Stripe)
  // e riallinea la card alla risposta. Niente ottimismo qui: è denaro.
  const confirmAddon = async () => {
    if (!pendingAddon) return;
    const feature = pendingAddon;
    const enabling = !tenant.features.includes(feature);
    setBusy('addon');
    try {
      const res = await adminUpdateAddons(tenant.id, { [feature]: enabling });
      onPatched({
        ...tenant,
        billing_status: res.billing_status,
        features: ADMIN_TENANT_FEATURES.filter(f => res.features[f]),
      });
      showToast(t('moduleToggled', "Modulo {{modulo}} {{azione}} dall'abbonamento", { modulo: featureLabel(feature, t), azione: enabling ? t('added', 'aggiunto') : t('removed', 'rimosso') }), 'success');
      setPendingAddon(null);
    } catch (err) {
      showToast((err as ApiError).message || t('errSub', 'Aggiornamento abbonamento non riuscito'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const changeStatus = async () => {
    const next = suspended ? 'active' : 'suspended';
    setBusy('status');
    try {
      await adminUpdateTenant(tenant.id, { status: next });
      onPatched({ ...tenant, status: next });
      showToast(next === 'suspended' ? `${tenant.name} sospeso` : `${tenant.name} riattivato`, 'success');
    } catch (err) {
      showToast((err as ApiError).message || t('errStatus', 'Cambio stato non riuscito'), 'error');
    } finally {
      setBusy(null);
      setConfirmingStatus(false);
    }
  };

  const openLocks = async () => {
    if (locksOpen) { setLocksOpen(false); return; }
    setLocksBusy('load');
    try {
      const res = await adminGetPermissionLocks(tenant.id);
      setLocksCatalog(res.features);
      setLocksDraft(res.locks);
      setLocksRevoke(false);
      setLocksOpen(true);
    } catch (err) {
      showToast((err as ApiError).message || t('errLocks', 'Permessi riservati non caricati'), 'error');
    } finally {
      setLocksBusy(null);
    }
  };

  const toggleLock = (permission: string) => {
    setLocksDraft(prev => prev.includes(permission) ? prev.filter(p => p !== permission) : [...prev, permission]);
  };

  const saveLocks = async () => {
    setLocksBusy('save');
    try {
      const res = await adminSetPermissionLocks(tenant.id, locksDraft, locksRevoke);
      setLocksDraft(res.locks);
      setLocksOpen(false);
      showToast(locksRevoke ? t('locksSavedRevoked', 'Permessi riservati salvati e revocati ai ruoli') : t('locksSaved', 'Permessi riservati salvati'), 'success');
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Salvataggio non riuscito'), 'error');
    } finally {
      setLocksBusy(null);
    }
  };

  // Sessione di piattaforma: dentro il tenant con la propria identità,
  // sopra la matrice permessi. Stessa foto della sessione dell'impersonation
  // ("torna al pannello" la ripristina), ma qui il refresh token c'è.
  const enterTenant = async () => {
    setBusy('enter');
    try {
      const res = await adminEnterTenant(tenant.id);
      const saved: SavedPlatformSession = {
        snapshot: authApiService.getSessionSnapshot(),
        tenant: res.tenant,
      };
      localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(saved));
      authApiService.enterPlatformSession(res.accessToken, res.refreshToken);
      window.location.reload();
    } catch (err) {
      setBusy(null);
      showToast((err as ApiError).message || t('errEnter', 'Ingresso non riuscito'), 'error');
    }
  };

  const impersonate = async () => {
    setBusy('impersonate');
    try {
      const res = await adminImpersonateTenant(tenant.id);
      // Prima la foto della sessione corrente, poi il token corto: il banner
      // la ripristina con "torna al pannello".
      const saved: SavedPlatformSession = {
        snapshot: authApiService.getSessionSnapshot(),
        tenant: res.tenant,
      };
      localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify(saved));
      authApiService.enterImpersonation(res.accessToken);
      window.location.reload();
    } catch (err) {
      setBusy(null);
      showToast((err as ApiError).message || t('errImpersonate', 'Impersonation non riuscita'), 'error');
    }
  };

  const openBilling = async () => {
    setBusy('billing');
    try {
      // Con un billing_status c'è già un customer Stripe: si apre il portal.
      // Senza, si parte dal checkout che lo crea.
      const res = tenant.billing_status
        ? await adminBillingPortal(tenant.id)
        : await adminBillingCheckout(tenant.id);
      window.open(res.url, '_blank', 'noopener');
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 503) showToast('billing non configurato', 'info');
      else showToast(apiErr.message || t('errBilling', 'Apertura billing non riuscita'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{tenant.name}</h3>
        <StatusPill tone={suspended ? 'critical' : 'positive'}>{suspended ? 'sospeso' : 'attivo'}</StatusPill>
        {billing && <StatusPill tone={billing.tone}>{billing.label}</StatusPill>}
      </div>
      <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
        <span className="font-mono">{tenant.slug}</span>
        {' · '}{tenant.user_count} {tenant.user_count === 1 ? 'utente' : 'utenti'}
        {' · '}creato il {formatDate(tenant.created_at)}
      </p>

      {/* Sofia: piano del ristorante e mese in corso (minuti, costo
          ElevenLabs, ricavo stimato). I numeri arrivano dal server. */}
      {(tenant.features.includes('voice') || tenant.voice_month) && (() => {
        const eur = (cents: number) => `${(cents / 100).toFixed(2).replace('.', ',').replace(/,00$/, '')} €`;
        const plan = tenant.voice_plan;
        const v = tenant.voice_month;
        const toCents = (x: string) => (x.trim() === '' ? null : Math.round(Number(x.replace(',', '.')) * 100));
        const toInt = (x: string) => (x.trim() === '' ? null : Number(x));
        const openPlan = () => {
          setPlanDraft({
            price: plan?.custom ? String((plan.priceCents) / 100) : '',
            included: plan?.custom ? String(plan.includedMinutes) : '',
            overage: plan?.custom ? String(plan.overageCentsPerMinute / 100) : '',
          });
          setPlanOpen(true);
        };
        const savePlan = async () => {
          const body = {
            price_cents: toCents(planDraft.price),
            included_minutes: toInt(planDraft.included),
            overage_cents_per_minute: toCents(planDraft.overage),
          };
          if (Object.values(body).some(n => n !== null && (!Number.isInteger(n) || n < 0))) {
            showToast(t('badPlan', 'Valori del piano non validi'), 'error');
            return;
          }
          setPlanBusy(true);
          try {
            const next = await adminUpdateVoicePlan(tenant.id, body);
            onPatched({ ...tenant, voice_plan: next });
            setPlanOpen(false);
            showToast(t('planSaved', 'Piano Sofia aggiornato'), 'success');
          } catch (err) {
            showToast((err as ApiError).message || t('errPlan', 'Aggiornamento piano non riuscito'), 'error');
          } finally {
            setPlanBusy(false);
          }
        };
        return (
          <div className="mt-2 text-[13px] tabular-nums text-[var(--ds-text-secondary)]">
            <p>
              {plan
                ? <>{t('plan.summary', 'Piano Sofia: {{prezzo}} · {{minuti}} min · {{extra}}/min extra · tetto {{tetto}}', { prezzo: eur(plan.priceCents), minuti: plan.includedMinutes, extra: eur(plan.overageCentsPerMinute), tetto: eur(plan.extraCapCents) })}{plan.custom ? t('plan.custom', ' (su misura)') : ''}</>
                : t('plan.listPrice', 'Piano Sofia: listino')}
              {!planOpen && (
                <button type="button" onClick={openPlan} className="ml-2 font-medium text-[var(--ds-text-primary)] underline underline-offset-4 hover:no-underline">
                  {t('plan.edit', 'Modifica')}
                </button>
              )}
            </p>
            {v && (
              <p className="mt-0.5">
                Questo mese: {v.billable_minutes} / {v.included_minutes} min · costo {eur(v.cost_eur_cents)} · ricavo stimato {eur(v.estimated_revenue_cents)} · margine {eur(v.estimated_revenue_cents - v.cost_eur_cents)}
                {v.priced_calls < v.calls && <span className="text-[var(--ds-text-muted)]"> (costo noto per {v.priced_calls} chiamate su {v.calls})</span>}
              </p>
            )}
            {planOpen && (
              <div className="mt-2 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  <Field label={t('plan.fee', 'Canone (€/mese)')}>
                    <input className={dsInput} inputMode="decimal" placeholder={t('plan.listHint', 'listino')} value={planDraft.price} onChange={e => setPlanDraft(d => ({ ...d, price: e.target.value }))} />
                  </Field>
                  <Field label={t('plan.included', 'Minuti inclusi')}>
                    <input className={dsInput} inputMode="numeric" placeholder={t('plan.listHint', 'listino')} value={planDraft.included} onChange={e => setPlanDraft(d => ({ ...d, included: e.target.value }))} />
                  </Field>
                  <Field label={t('plan.overage', 'Minuto extra (€)')}>
                    <input className={dsInput} inputMode="decimal" placeholder={t('plan.listHint', 'listino')} value={planDraft.overage} onChange={e => setPlanDraft(d => ({ ...d, overage: e.target.value }))} />
                  </Field>
                </div>
                <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">Campo vuoto = listino. Il tetto degli extra lo sceglie il ristoratore.</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={savePlan} disabled={planBusy} className={`${dsButton.primary} h-10 px-4 text-[14px]`}>Salva piano</button>
                  <button type="button" onClick={() => setPlanOpen(false)} disabled={planBusy} className={`${dsButton.secondary} h-10 px-4 text-[14px]`}>Annulla</button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Feature: le tre chip sono i toggle. Accesa = tinta seated con spunta,
          il colore non è l'unico segnale. */}
      <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={t('featuresAria', 'Feature di {{nome}}', { nome: tenant.name })}>
        {ADMIN_TENANT_FEATURES.map(feature => {
          const on = tenant.features.includes(feature);
          return (
            <button
              key={feature}
              type="button"
              onClick={() => toggleFeature(feature)}
              aria-pressed={on}
              className={`inline-flex h-11 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                on
                  ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                  : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
              }`}
            >
              {on && <Check className="h-3.5 w-3.5" aria-hidden />}
              {featureLabel(feature, t)}
            </button>
          );
        })}
      </div>

      {/* Conferma add-on (solo tenant abbonati): tocca la fattura, quindi
          niente scatto diretto della chip — stessa forma della conferma di
          sospensione. */}
      {pendingAddon && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
          <p className="min-w-0 flex-1 text-[14px] text-[var(--ds-text-primary)]">
            {tenant.features.includes(pendingAddon)
              ? t('addonRemove', "Rimuovere «{{modulo}}» dall'abbonamento? Il credito residuo viene prorato.", { modulo: featureLabel(pendingAddon, t) })
              : t('addonAdd', "Aggiungere «{{modulo}}» all'abbonamento? L'addebito parte prorato da oggi.", { modulo: featureLabel(pendingAddon, t) })}
          </p>
          <div className="flex flex-shrink-0 gap-2">
            <button type="button" className={dsButton.secondary} onClick={() => setPendingAddon(null)} disabled={busy === 'addon'}>
              {t('cancel', 'Annulla')}
            </button>
            <button type="button" className={dsButton.primary} onClick={confirmAddon} disabled={busy === 'addon'}>
              {busy === 'addon' ? t('updating', 'Aggiorno…') : t('confirm', 'Conferma')}
            </button>
          </div>
        </div>
      )}

      {/* Permessi riservati alla piattaforma: chip per permesso, raggruppate
          per funzionalità. Una chip accesa = voce col lucchetto nella matrice
          del tenant; «revoca anche ai ruoli» è l'isolamento in un gesto. */}
      {locksOpen && (
        <div className="mt-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
          <p className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{t('locks.title', 'Permessi riservati alla piattaforma')}</p>
          <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">{t('locks.hint', 'La matrice del tenant li mostra col lucchetto e non può toccarli.')}</p>
          <div className="mt-3 space-y-2.5">
            {locksCatalog.map(group => (
              <div key={group.feature}>
                <p className="mb-1 text-[12px] font-medium text-[var(--ds-text-muted)]">{group.feature}</p>
                <div className="flex flex-wrap gap-1.5">
                  {group.permissions.map(permission => {
                    const on = locksDraft.includes(permission);
                    return (
                      <button
                        key={permission}
                        type="button"
                        onClick={() => toggleLock(permission)}
                        aria-pressed={on}
                        className={`inline-flex h-9 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 font-mono text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                          on
                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                            : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                        }`}
                      >
                        {on && <Lock className="h-3 w-3" aria-hidden />}
                        {permission}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-2 text-[14px] text-[var(--ds-text-primary)]">
              <input
                type="checkbox"
                checked={locksRevoke}
                onChange={() => setLocksRevoke(v => !v)}
                className="h-4 w-4 rounded accent-[var(--ds-action-bg)]"
              />
              {t('locks.revokeAll', 'Revoca anche a tutti i ruoli del tenant')}
            </label>
            <div className="flex flex-shrink-0 gap-2">
              <button type="button" className={dsButton.secondary} onClick={() => setLocksOpen(false)} disabled={locksBusy === 'save'}>
                {t('cancel', 'Annulla')}
              </button>
              <button type="button" className={dsButton.primary} onClick={saveLocks} disabled={locksBusy === 'save'}>
                {locksBusy === 'save' ? t('locks.saving', 'Salvo…') : t('locks.save', 'Salva')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Azioni. La conferma di sospensione è inline: prende il posto della
          riga, niente window.confirm. */}
      {confirmingStatus ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-3">
          <p className="min-w-0 flex-1 text-[14px] text-[var(--ds-text-primary)]">
            {suspended
              ? t('reactivateAsk', 'Riattivare {{nome}}?', { nome: tenant.name })
              : t('suspendAsk', 'Sospendere {{nome}}? Gli accessi e la pagina pubblica si bloccano subito.', { nome: tenant.name })}
          </p>
          <div className="flex flex-shrink-0 gap-2">
            <button type="button" className={dsButton.secondary} onClick={() => setConfirmingStatus(false)}>
              {t('cancel', 'Annulla')}
            </button>
            <button
              type="button"
              className={suspended ? dsButton.primary : dsButton.critical}
              onClick={changeStatus}
              disabled={busy === 'status'}
            >
              {suspended ? t('reactivate', 'Riattiva') : t('suspend', 'Sospendi')}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={dsButton.secondary} onClick={enterTenant} disabled={busy === 'enter'}>
            {t('enter', 'Entra')}
          </button>
          <button type="button" className={dsButton.quiet} onClick={impersonate} disabled={busy === 'impersonate'} title={t('enterAsTitle', 'Sessione di 15 minuti come il titolare')}>
            {t('enterAs', 'Entra come')}
          </button>
          <button type="button" className={dsButton.quiet} onClick={openLocks} disabled={locksBusy === 'load'} aria-expanded={locksOpen}>
            <Lock className="h-3.5 w-3.5" aria-hidden />
            {t('permissions', 'Permessi')}
          </button>
          <button type="button" className={dsButton.quiet} onClick={openBilling} disabled={busy === 'billing'}>
            {tenant.billing_status ? t('billingBtn', 'Fatturazione') : t('activateSub', 'Attiva abbonamento')}
          </button>
          {tenant.stripe_customer_url && (
            <a
              href={tenant.stripe_customer_url}
              target="_blank"
              rel="noreferrer"
              className={dsButton.quiet}
              title={t('stripeTitle', 'Apri il customer sul Dashboard Stripe')}
            >
              Stripe
            </a>
          )}
          <button type="button" className={dsButton.quiet} onClick={() => setConfirmingStatus(true)}>
            {suspended ? t('reactivate', 'Riattiva') : t('suspend', 'Sospendi')}
          </button>
        </div>
      )}
    </div>
  );
};

/* ── Modale "Nuovo cliente" ──────────────────────────────────────────────
   Form essenziale, e a provisioning riuscito il pannello UNA-TANTUM con
   password temporanea, token e URL prenotazioni: escono solo da questa
   risposta e non verranno rimostrati. */
const NewTenantModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  showToast: ShowToast;
}> = ({ open, onClose, onCreated, showToast }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [email, setEmail] = useState('');
  const [features, setFeatures] = useState<Record<AdminTenantFeature, boolean>>({
    voice: false, whatsapp: false, web_booking: false, pay_at_table: false, passepartout: false, reviews: false, sala_node: false,
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<AdminTenantProvisioned | null>(null);

  const reset = () => {
    setName(''); setSlug(''); setSlugTouched(false); setEmail('');
    setFeatures({ voice: false, whatsapp: false, web_booking: false, pay_at_table: false, passepartout: false, reviews: false, sala_node: false });
    setError(null); setCreated(null);
  };

  const close = () => { reset(); onClose(); };

  const valid = name.trim().length > 0 && SLUG_REGEX.test(slug) && email.includes('@');

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await adminCreateTenant({
        name: name.trim(),
        slug,
        owner_email: email.trim(),
        features,
      });
      setCreated(res);
      onCreated();
    } catch (err) {
      setError((err as ApiError).message || t('errCreate', 'Creazione non riuscita'));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  if (created) {
    return (
      <ModalShell
        open
        onClose={close}
        title={created.tenant.name}
        subtitle={t('created.subtitle', 'Dati di accesso del nuovo cliente')}
        size="md"
        bodyClassName="p-5 sm:p-6"
        footer={
          <button type="button" className={dsButton.primary} onClick={close}>
            {t('created.done', 'Fatto')}
          </button>
        }
      >
        <div className="space-y-4">
          <Callout tone="pending" icon={AlertTriangle}>
            Compaiono solo ora — copiali prima di chiudere, non verranno rimostrati.
          </Callout>
          <FormCard>
            <div className="divide-y divide-[var(--ds-border)]">
              <SecretRow label={t('created.tempPassword', "Password temporanea dell'owner")} value={created.owner_temp_password} showToast={showToast} />
              <SecretRow label={t('created.webhookToken', 'Token webhook')} value={created.webhook_token} showToast={showToast} />
              <SecretRow label={t('created.printToken', 'Token print agent')} value={created.print_agent_token} showToast={showToast} />
              <SecretRow label={t('created.bookingUrl', 'URL prenotazioni')} value={created.booking_url} showToast={showToast} />
            </div>
          </FormCard>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell
      open
      onClose={close}
      title={t('newTenant', 'Nuovo cliente')}
      size="md"
      bodyClassName="p-5 sm:p-6"
      footer={
        <>
          <button type="button" className={dsButton.secondary} onClick={close}>
            {t('cancel', 'Annulla')}
          </button>
          <button type="button" className={dsButton.primary} onClick={submit} disabled={!valid || submitting}>
            {submitting ? t('creating', 'Creazione…') : t('createTenant', 'Crea cliente')}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {error && (
          <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>
        )}
        <FormCard>
          <div className="space-y-4">
            <Field label={t('restaurantName', 'Nome del ristorante')} htmlFor="pt-name" required>
              <input
                id="pt-name"
                type="text"
                className={dsInput}
                value={name}
                autoFocus
                onChange={e => {
                  setName(e.target.value);
                  if (!slugTouched) setSlug(slugify(e.target.value));
                }}
              />
            </Field>
            <Field
              label={t('slug', 'Slug')}
              htmlFor="pt-slug"
              required
              hint={t('slugHint', "Nell'URL pubblico delle prenotazioni: minuscole, cifre e trattini.")}
            >
              <input
                id="pt-slug"
                type="text"
                className={`${dsInput} font-mono`}
                value={slug}
                onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase()); }}
              />
            </Field>
            <Field label={t('ownerEmail', "Email dell'owner")} htmlFor="pt-email" required>
              <input
                id="pt-email"
                type="email"
                className={dsInput}
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </Field>
          </div>
        </FormCard>
        <FormCard title={t('activeFeatures', 'Feature attive')}>
          <div className="flex flex-wrap gap-2">
            {ADMIN_TENANT_FEATURES.map(feature => {
              const on = features[feature];
              return (
                <button
                  key={feature}
                  type="button"
                  onClick={() => setFeatures(prev => ({ ...prev, [feature]: !prev[feature] }))}
                  aria-pressed={on}
                  className={`inline-flex h-11 items-center gap-1.5 rounded-[var(--ds-radius-control)] px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    on
                      ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                  }`}
                >
                  {on && <Check className="h-3.5 w-3.5" aria-hidden />}
                  {featureLabel(feature, t)}
                </button>
              );
            })}
          </div>
        </FormCard>
      </div>
    </ModalShell>
  );
};

/* ── Pannello ────────────────────────────────────────────────────────── */
export const PlatformPanel: React.FC<{ showToast: ShowToast }> = ({ showToast }) => {
  const { t } = useTranslation('piattaforma', { useSuspense: false });
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  // Riepilogo billing (MRR da Stripe): null finché non arriva, e resta null
  // se il billing non è configurato (503) — la strip semplicemente non c'è.
  const [summary, setSummary] = useState<AdminBillingSummary | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTenants(await adminListTenants());
    } catch (err) {
      setError((err as ApiError).message || t('errLoad', 'Caricamento non riuscito'));
    } finally {
      setLoading(false);
    }
    // Fuori dal try della lista: un errore Stripe non deve oscurare i clienti.
    adminBillingSummary().then(setSummary).catch(() => setSummary(null));
  }, []);

  useEffect(() => { load(); }, [load]);

  const patchTenant = useCallback((next: AdminTenant) => {
    setTenants(prev => prev.map(t => (t.id === next.id ? next : t)));
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
          <div className="mb-4 flex items-center gap-3">
            <h2 className="text-[20px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{t('customers', 'Clienti')}</h2>
            {!loading && !error && <CountBadge count={tenants.length} />}
            <button
              type="button"
              className={`${dsButton.primary} ml-auto`}
              onClick={() => setShowNew(true)}
            >
              <Plus className="h-4 w-4" aria-hidden />
              {t('newTenant', 'Nuovo cliente')}
            </button>
          </div>

          {/* La strip vive solo quando il billing risponde: MRR dalla verità
              Stripe, conteggi dal nostro DB. past_due tinge il segmento — è
              l'unico numero qui che chiede un'azione. */}
          {summary && (
            <StatStrip
              layout="stacked"
              className="mb-4"
              stats={[
                {
                  /* L'euro resta: è il ricavo di Sympotia, che fattura in
                     euro qualunque lingua legga chi guarda. Il separatore
                     decimale invece segue la lingua. */
                  value: `€ ${(summary.mrr_cents / 100).toLocaleString(displayLocale(), { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`,
                  label: 'MRR',
                },
                { value: summary.paying_tenants, label: t('stat.paying', 'paganti') },
                {
                  value: summary.past_due_tenants,
                  label: t('stat.pastDue', 'past due'),
                  tone: summary.past_due_tenants > 0 ? 'critical' : undefined,
                  tint: summary.past_due_tenants > 0,
                },
                { value: summary.trialing_tenants, label: t('stat.trialing', 'in prova'), hideBelow: 'sm' },
                { value: summary.grandfathered_tenants, label: t('stat.noBilling', 'senza billing'), hideBelow: 'sm' },
              ]}
            />
          )}

          {loading && (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="h-36 animate-pulse rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]" />
              ))}
            </div>
          )}

          {!loading && error && (
            <Callout
              tone="critical"
              icon={AlertTriangle}
              action={
                <button type="button" className={dsButton.secondary} onClick={() => { setLoading(true); load(); }}>
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  {t('retry', 'Riprova')}
                </button>
              }
            >
              {error}
            </Callout>
          )}

          {!loading && !error && tenants.length === 0 && (
            <EmptyState icon={Building2}>{t('empty', 'Nessun cliente ancora.')}</EmptyState>
          )}

          {!loading && !error && tenants.length > 0 && (
            <div className="space-y-3">
              {tenants.map(t => (
                <TenantCard
                  key={t.id}
                  tenant={t}
                  onPatched={patchTenant}
                  onRevert={patchTenant}
                  showToast={showToast}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <NewTenantModal
        open={showNew}
        onClose={() => setShowNew(false)}
        onCreated={load}
        showToast={showToast}
      />
    </div>
  );
};
