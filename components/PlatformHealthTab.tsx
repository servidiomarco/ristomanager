import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle, Bug, ChevronDown, CircleCheck, Loader2, Megaphone, Phone, Printer, Receipt, RefreshCw, Router,
} from 'lucide-react';
import {
  Callout, FormCard, Field, SegmentedControl, StatusPill, CountBadge,
  dsButton, dsSelect, dsTextarea,
} from './ds';
import { Loader } from './Loader';
import { healthApiService } from '../services/healthApiService';
import { onSocketEvent } from '../services/socketEvents';
import {
  INCIDENT_MESSAGE_MAX,
  type AppErrorGroup, type AppErrorOccurrence, type IncidentLevel, type PlatformAlert, type PlatformAlertKind, type PlatformHealth,
} from '../services/healthShared';
import { relativeTime } from '../utils/relativeTime';
import { formatSupportDateTime } from './SupportThread';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — tab Salute (supporto, fase 2)
   ============================================
   Tre cose, nell'ordine in cui servono: il banner da mostrare ai ristoranti
   quando un problema è noto, gli avvisi che il cane da guardia ha aperto
   (stampa, scontrini, Sofia, nodo), e gli errori raggruppati — del browser
   di chi lavora e dei tool di Sofia. Si aggiorna da sola (health:changed
   sulla stanza degli admin), al rientro e ogni minuto. */

type ShowToast = (message: string, type?: 'success' | 'error' | 'info') => void;
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const REFRESH_MS = 60_000;

const KIND_ICON: Record<PlatformAlertKind, React.ComponentType<{ className?: string }>> = {
  stampa: Printer,
  fiscale: Receipt,
  sofia: Phone,
  nodo: Router,
};

const KIND_LABEL_IT: Record<PlatformAlertKind, string> = {
  stampa: 'Stampa',
  fiscale: 'Scontrini',
  sofia: 'Sofia',
  nodo: 'Nodo di sala',
};

/** Una riga che dice cosa succede, dai numeri che il cane da guardia ha
 *  salvato: stessa sostanza della push, senza il nome del ristorante. */
const alertSummary = (a: PlatformAlert, t: TFunc): string => {
  const d = a.detail as Record<string, any>;
  const err = d.last_error ? ` — ${String(d.last_error).slice(0, 140)}` : '';
  switch (a.kind) {
    case 'stampa':
      return t('platform.health.alert.stampa', '{{failed}} fallite, {{stuck}} ferme in 30 min', { failed: d.failed ?? 0, stuck: d.stuck ?? 0 }) + err;
    case 'fiscale':
      return t('platform.health.alert.fiscale', '{{failed}} documenti falliti nell\'ultima ora', { failed: d.failed ?? 0 }) + err;
    case 'sofia':
      return t('platform.health.alert.sofia', '{{failures}} errori dei tool in 30 min', { failures: d.failures ?? 0 }) + err;
    case 'nodo':
      return d.last_seen_seconds != null
        ? t('platform.health.alert.nodo', 'muto da {{min}} min mentre il locale lavora', { min: Math.round(Number(d.last_seen_seconds) / 60) })
        : t('platform.health.alert.nodoNever', 'non si è presentato dal riavvio del server');
  }
};

const AlertRow: React.FC<{ alert: PlatformAlert; t: TFunc }> = ({ alert, t }) => {
  const Icon = KIND_ICON[alert.kind] ?? AlertTriangle;
  const open = alert.resolved_at == null;
  return (
    <div className="flex items-start gap-3 py-3">
      <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-sm)] ${
        open ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]' : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
      }`}>
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-[15px] font-medium text-[var(--ds-text-primary)]">{alert.tenant_name}</span>
          <span className="text-[13px] text-[var(--ds-text-muted)]">
            {t(`platform.health.kind.${alert.kind}`, KIND_LABEL_IT[alert.kind])}
            {' · '}
            {open
              ? t('platform.health.since', 'aperto {{when}}', { when: relativeTime(alert.opened_at, t) })
              : t('platform.health.resolved', 'rientrato {{when}}', { when: relativeTime(alert.resolved_at, t) })}
          </span>
        </div>
        <p className="mt-0.5 break-words text-[14px] text-[var(--ds-text-secondary)]">{alertSummary(alert, t)}</p>
      </div>
    </div>
  );
};

const ErrorRow: React.FC<{ group: AppErrorGroup; t: TFunc }> = ({ group, t }) => {
  const [open, setOpen] = useState(false);
  const [occurrences, setOccurrences] = useState<AppErrorOccurrence[] | null>(null);
  const [loadError, setLoadError] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && occurrences == null) {
      healthApiService.adminErrorOccurrences(group.fingerprint)
        .then(setOccurrences)
        .catch(() => setLoadError(true));
    }
  };

  const tenants = Array.isArray(group.tenants) ? group.tenants : [];
  return (
    <div className="py-3">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-start gap-3 rounded-[var(--ds-radius-sm)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
          {group.origin === 'sofia' ? <Phone className="h-4 w-4" aria-hidden /> : <Bug className="h-4 w-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 break-words text-[14px] font-medium text-[var(--ds-text-primary)]">{group.message}</p>
          <p className="mt-0.5 text-[13px] text-[var(--ds-text-muted)]">
            {group.origin === 'sofia' ? `Sofia · ${group.source}` : `${t('platform.health.app', 'App')} · ${group.source}${group.last_view ? ` · ${group.last_view}` : ''}`}
            {' · '}{tenants.map(x => x.name).join(', ')}
            {group.users > 0 ? ` · ${t('platform.health.users', '{{count}} utenti', { count: group.users })}` : ''}
            {' · '}{relativeTime(group.last_seen, t)}
            {group.last_version ? ` · v${group.last_version}` : ''}
          </p>
        </div>
        <CountBadge count={group.occurrences} />
        <ChevronDown className={`mt-2 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open && (
        <div className="mt-2 pl-12">
          {loadError ? (
            <p className="text-[13px] text-[var(--ds-critical-text)]">{t('platform.health.errLoadOne', 'Dettaglio non caricato')}</p>
          ) : occurrences == null ? (
            <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />
          ) : (
            <div className="space-y-2">
              {occurrences[0]?.stack && (
                <pre className="max-h-64 overflow-auto rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3 text-[12px] leading-relaxed text-[var(--ds-text-secondary)]">
                  {occurrences[0].stack}
                </pre>
              )}
              <ul className="space-y-1 text-[13px] text-[var(--ds-text-secondary)]">
                {occurrences.map(o => (
                  <li key={o.id} className="break-words">
                    {formatSupportDateTime(o.created_at)} · {o.tenant_name}
                    {o.user_role ? ` · ${o.user_role}` : ''}{o.view ? ` · ${o.view}` : ''}{o.app_version ? ` · v${o.app_version}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/* ── Banner ai ristoranti ─────────────────────────────────────────────── */

const IncidentCard: React.FC<{
  health: PlatformHealth;
  tenants: Array<{ id: number; name: string }>;
  onChanged: () => void;
  showToast: ShowToast;
}> = ({ health, tenants, onChanged, showToast }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [message, setMessage] = useState('');
  const [level, setLevel] = useState<IncidentLevel>('info');
  const [target, setTarget] = useState<number>(0);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const active = health.incidents.filter(i => i.resolved_at == null);
  const nameOf = (id: number) => tenants.find(x => x.id === id)?.name ?? `#${id}`;

  const publish = async () => {
    if (!message.trim()) return;
    setBusy('new');
    try {
      await healthApiService.createIncident({ message: message.trim(), level, tenant_ids: target ? [target] : [] });
      setMessage('');
      showToast(t('platform.health.incidentPublished', 'Avviso pubblicato'), 'success');
      onChanged();
    } catch (err) {
      showToast((err as ApiError).message || t('platform.health.errIncident', 'Avviso non pubblicato'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const resolve = async (id: number) => {
    setBusy(id);
    try {
      await healthApiService.resolveIncident(id);
      onChanged();
    } catch (err) {
      showToast((err as ApiError).message || t('errSave', 'Modifica non salvata'), 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <FormCard title={t('platform.health.incidentTitle', 'Avviso ai ristoranti')}>
      <div className="space-y-4">
        {active.length > 0 && (
          <div className="divide-y divide-[var(--ds-border)]">
            {active.map(i => (
              <div key={i.id} className="flex items-start gap-3 py-2.5">
                <StatusPill tone={i.level === 'critico' ? 'critical' : 'info'}>
                  {i.level === 'critico' ? t('platform.health.levelCritical', 'Critico') : t('platform.health.levelInfo', 'Informazione')}
                </StatusPill>
                <div className="min-w-0 flex-1">
                  <p className="break-words text-[14px] text-[var(--ds-text-primary)]">{i.message}</p>
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    {i.target_tenant_ids.length === 0
                      ? t('platform.health.allTenants', 'Tutti i ristoranti')
                      : i.target_tenant_ids.map(nameOf).join(', ')}
                    {' · '}{relativeTime(i.created_at, t)}
                  </p>
                </div>
                <button type="button" className={dsButton.quiet} onClick={() => resolve(i.id)} disabled={busy !== null}>
                  {busy === i.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <CircleCheck className="h-4 w-4" aria-hidden />}
                  {t('platform.health.incidentResolve', 'Togli')}
                </button>
              </div>
            ))}
          </div>
        )}
        <Field label={t('platform.health.incidentMessage', 'Messaggio')} htmlFor="hl-incident" hint={t('platform.health.incidentHint', 'Compare sotto la testata di ogni vista, finché non lo togli.')}>
          <textarea
            id="hl-incident"
            rows={2}
            maxLength={INCIDENT_MESSAGE_MAX}
            className={dsTextarea}
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder={t('platform.health.incidentPlaceholder', 'Es. Sofia non risponde: ci stiamo lavorando.')}
          />
        </Field>
        <div className="flex flex-wrap items-end gap-3">
          <SegmentedControl
            value={level}
            onChange={next => setLevel(next === 'critico' ? 'critico' : 'info')}
            ariaLabel={t('platform.health.levelAria', 'Gravità')}
            options={[
              { value: 'info', label: t('platform.health.levelInfo', 'Informazione') },
              { value: 'critico', label: t('platform.health.levelCritical', 'Critico') },
            ]}
            equalWidth={false}
          />
          {tenants.length > 1 && (
            <select
              className={`${dsSelect} w-auto min-w-[200px]`}
              value={target}
              onChange={e => setTarget(Number(e.target.value))}
              aria-label={t('platform.health.incidentTarget', 'Destinatari')}
            >
              <option value={0}>{t('platform.health.allTenants', 'Tutti i ristoranti')}</option>
              {tenants.map(tn => <option key={tn.id} value={tn.id}>{tn.name}</option>)}
            </select>
          )}
          <button type="button" className={`${dsButton.primary} ml-auto`} onClick={publish} disabled={!message.trim() || busy !== null}>
            {busy === 'new' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Megaphone className="h-4 w-4" aria-hidden />}
            {t('platform.health.incidentPublish', 'Pubblica')}
          </button>
        </div>
      </div>
    </FormCard>
  );
};

/* ── Tab ─────────────────────────────────────────────────────────────── */

export const PlatformHealthTab: React.FC<{
  tenants: Array<{ id: number; name: string }>;
  onOpenAlertsChange: (n: number) => void;
  showToast: ShowToast;
}> = ({ tenants, onOpenAlertsChange, showToast }) => {
  const { t } = useTranslation('supporto', { useSuspense: false });
  const [hours, setHours] = useState<24 | 168>(24);
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const h = await healthApiService.adminHealth(hours);
      setHealth(h);
      setError(null);
      onOpenAlertsChange(h.alerts_open.length);
    } catch (err) {
      const apiErr = err as ApiError;
      // Backend più vecchio del frontend: la rotta non c'è ancora.
      if (apiErr.status === 404) setHealth({ alerts_open: [], alerts_recent: [], errors: [], incidents: [] });
      else setError(apiErr.message || t('errLoad', 'Richieste non caricate'));
    }
  }, [hours, onOpenAlertsChange, t]);

  useEffect(() => { load(); }, [load]);

  const checkNow = async () => {
    setChecking(true);
    try {
      await healthApiService.runCheck();
      await load();
    } catch (err) {
      showToast((err as ApiError).message || t('platform.health.errCheck', 'Controllo non riuscito'), 'error');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') load(); };
    const timer = window.setInterval(refresh, REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    const unsub = onSocketEvent('health:changed', () => load());
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      unsub();
    };
  }, [load]);

  if (!health && !error) {
    return <div className="flex h-40 items-center justify-center"><Loader /></div>;
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6 lg:p-8">
        {error && (
          <Callout
            tone="critical"
            icon={AlertTriangle}
            action={
              <button type="button" className={dsButton.secondary} onClick={load}>
                <RefreshCw className="h-4 w-4" aria-hidden />
                {t('platform.health.retry', 'Riprova')}
              </button>
            }
          >
            {error}
          </Callout>
        )}

        {health && (
          <>
            <IncidentCard health={health} tenants={tenants} onChanged={load} showToast={showToast} />

            <FormCard
              title={t('platform.health.alertsTitle', 'Avvisi')}
              aside={
                <button type="button" className={dsButton.quiet} onClick={checkNow} disabled={checking}>
                  <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} aria-hidden />
                  {t('platform.health.checkNow', 'Controlla adesso')}
                </button>
              }
            >
              {health.alerts_open.length === 0 ? (
                <p className="text-[14px] text-[var(--ds-text-muted)]">{t('platform.health.noAlerts', 'Nessun avviso aperto.')}</p>
              ) : (
                <div className="divide-y divide-[var(--ds-border)]">
                  {health.alerts_open.map(a => <AlertRow key={a.id} alert={a} t={t} />)}
                </div>
              )}
              {health.alerts_recent.length > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    onClick={() => setShowResolved(s => !s)}
                    aria-expanded={showResolved}
                    className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[var(--ds-radius-sm)] text-[13px] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <ChevronDown className={`h-4 w-4 transition-transform ${showResolved ? 'rotate-180' : ''}`} aria-hidden />
                    {t('platform.health.recentResolved', 'Rientrati nelle ultime 48 ore ({{n}})', { n: health.alerts_recent.length })}
                  </button>
                  {showResolved && (
                    <div className="divide-y divide-[var(--ds-border)]">
                      {health.alerts_recent.map(a => <AlertRow key={a.id} alert={a} t={t} />)}
                    </div>
                  )}
                </div>
              )}
            </FormCard>

            <FormCard title={t('platform.health.errorsTitle', 'Errori')}>
              <div className="mb-2">
                <SegmentedControl
                  value={String(hours)}
                  onChange={next => setHours(next === '168' ? 168 : 24)}
                  ariaLabel={t('platform.health.windowAria', 'Periodo')}
                  options={[
                    { value: '24', label: t('platform.health.window24', '24 ore') },
                    { value: '168', label: t('platform.health.window7', '7 giorni') },
                  ]}
                  equalWidth={false}
                  size="sm"
                />
              </div>
              {health.errors.length === 0 ? (
                <p className="text-[14px] text-[var(--ds-text-muted)]">{t('platform.health.noErrors', 'Nessun errore nel periodo.')}</p>
              ) : (
                <div className="divide-y divide-[var(--ds-border)]">
                  {health.errors.map(g => <ErrorRow key={`${g.fingerprint}-${g.origin}`} group={g} t={t} />)}
                </div>
              )}
            </FormCard>
          </>
        )}
      </div>
    </div>
  );
};

export default PlatformHealthTab;
