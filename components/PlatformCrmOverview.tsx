import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, HeartPulse, RefreshCw, TrendingUp } from 'lucide-react';
import { Callout, SectionHeader, StatStrip, dsButton } from './ds';
import { Loader } from './Loader';
import { platformCrmApi, CRM_STAGES, type CrmOverview, type CrmTask } from '../services/platformCrmApiService';
import {
  ACTIVITY_ICON, ACTIVITY_LABEL, HealthPill, STAGE_LABEL, StagePill, crmRowButton, dueLabel, eur, formatDay,
  formatInstant, type ShowToast,
} from './PlatformCrmShared';
import type { ApiError } from '../services/apiError';

/* ============================================
   PANNELLO PIATTAFORMA — CRM, Panoramica
   ============================================
   La prima cosa che si apre: quanto incassa la piattaforma, cosa c'è da
   fare oggi, chi sta scivolando via. Ogni riga porta alla scheda. Demo e
   locali interni non entrano in nessun numero (lo decide il server). */

export const CrmCard: React.FC<{
  title: string;
  meta?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, meta, action, className = '', children }) => (
  <section className={`rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5 ${className}`}>
    <div className="mb-2 flex items-center gap-2">
      <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">{title}</h3>
      {meta && <span className="flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">{meta}</span>}
      {action}
    </div>
    {children}
  </section>
);

export const PlatformCrmOverview: React.FC<{
  onOpenAccount: (id: number) => void;
  onOpenTasks: () => void;
  onOpenPipeline: () => void;
  showToast: ShowToast;
}> = ({ onOpenAccount, onOpenTasks, onOpenPipeline, showToast }) => {
  const [data, setData] = useState<CrmOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doneIds, setDoneIds] = useState<number[]>([]);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await platformCrmApi.overview());
    } catch (err) {
      setError((err as ApiError).message || 'Caricamento non riuscito');
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Spunta dalla panoramica: la riga resta barrata fino al prossimo giro,
  // così si vede cosa si è appena chiuso.
  const complete = async (task: CrmTask) => {
    setDoneIds(prev => [...prev, task.id]);
    try {
      await platformCrmApi.updateTask(task.id, { done: true });
    } catch (err) {
      setDoneIds(prev => prev.filter(id => id !== task.id));
      showToast((err as ApiError).message || 'Promemoria non aggiornato', 'error');
    }
  };

  if (error) {
    return (
      <Callout
        tone="critical"
        icon={AlertTriangle}
        action={<button type="button" className={dsButton.secondary} onClick={load}><RefreshCw className="h-4 w-4" aria-hidden />Riprova</button>}
      >
        {error}
      </Callout>
    );
  }
  if (!data) return <div className="flex h-40 items-center justify-center"><Loader /></div>;

  const funnel = CRM_STAGES.filter(s => s !== 'perso' && s !== 'disdetto');
  const funnelMax = Math.max(1, ...funnel.map(s => data.by_stage[s] ?? 0));
  const overdue = data.tasks_due.filter(t => dueLabel(t.due_date) !== 'oggi').length;

  return (
    <div className="space-y-4">
      <StatStrip
        layout="stacked"
        stats={[
          { value: eur(data.mrr_cents), label: 'MRR', title: data.stripe ? 'Canoni Stripe, o quello della scheda per i clienti senza abbonamento' : 'Stripe non configurato: canoni scritti nelle schede' },
          { value: data.customers, label: 'clienti' },
          { value: data.trials, label: 'in prova', tone: data.trials > 0 ? 'pending' : undefined },
          { value: data.open_leads, label: 'lead aperti', hideBelow: 'sm' },
          { value: eur(data.arpa_cents), label: 'per cliente', hideBelow: 'md', title: 'Canone medio (ARPA)' },
        ]}
      />
      <StatStrip
        stats={[
          { value: eur(data.pipeline.weighted_mrr_cents), label: 'pipeline pesata', onClick: onOpenPipeline, title: `${data.pipeline.open_deals} opportunità aperte · ${eur(data.pipeline.mrr_cents)} al mese in tutto` },
          { value: data.new_customers_month, label: 'nuovi nel mese', tone: data.new_customers_month > 0 ? 'positive' : undefined },
          {
            value: data.churned_month,
            label: 'disdette nel mese',
            tone: data.churned_month > 0 ? 'critical' : undefined,
            tint: data.churned_month > 0,
            hideBelow: 'sm',
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <CrmCard
          title="Da fare oggi"
          meta={data.tasks_due.length > 0 ? `${data.tasks_due.length}${overdue ? ` · ${overdue} in ritardo` : ''}` : undefined}
          action={<button type="button" onClick={onOpenTasks} className="text-[13px] font-medium text-[var(--ds-text-secondary)] underline underline-offset-4 hover:text-[var(--ds-text-primary)]">Tutti</button>}
        >
          {data.tasks_due.length === 0 ? (
            <p className="py-2 text-[14px] text-[var(--ds-text-muted)]">Niente in scadenza.</p>
          ) : (
            <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
              {data.tasks_due.slice(0, 8).map(task => {
                const done = doneIds.includes(task.id);
                const late = dueLabel(task.due_date) !== 'oggi';
                return (
                  <li key={task.id} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => !done && complete(task)}
                      aria-label={`Fatto: ${task.title}`}
                      aria-pressed={done}
                      className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <span className={`inline-flex h-5 w-5 items-center justify-center rounded-[var(--ds-radius-sm)] ring-1 ring-inset ${done ? 'bg-[var(--ds-seated-solid)] ring-[var(--ds-seated-solid)] text-[var(--ds-seated-fg)]' : 'ring-[var(--ds-border-strong)]'}`}>
                        {done && <Check className="h-3.5 w-3.5" aria-hidden />}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={!task.account_id}
                      onClick={() => task.account_id && onOpenAccount(task.account_id)}
                      className="flex min-h-[44px] min-w-0 flex-1 flex-col justify-center py-1.5 pr-3 text-left disabled:cursor-default"
                    >
                      <span className={`truncate text-[14px] ${done ? 'text-[var(--ds-text-muted)] line-through' : 'text-[var(--ds-text-primary)]'}`}>
                        {task.priority === 'alta' && !done && <span className="mr-1 font-semibold text-[var(--ds-critical-text)]">!</span>}
                        {task.title}
                      </span>
                      <span className="truncate text-[12px] text-[var(--ds-text-muted)]">
                        <span className={late && !done ? 'font-medium text-[var(--ds-critical-text)]' : ''}>{dueLabel(task.due_date)}</span>
                        {task.account_name ? ` · ${task.account_name}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CrmCard>

        <CrmCard title="Clienti da seguire" meta={data.at_risk.length || undefined}>
          {data.at_risk.length === 0 ? (
            <p className="flex items-center gap-2 py-2 text-[14px] text-[var(--ds-text-muted)]">
              <HeartPulse className="h-4 w-4" aria-hidden />Tutti i clienti stanno bene.
            </p>
          ) : (
            <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
              {data.at_risk.map(a => (
                <li key={a.id}>
                  <button type="button" className={crmRowButton} onClick={() => onOpenAccount(a.id)}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{a.name}</span>
                      <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">{a.health?.signals.join(' · ') || '—'}</span>
                    </span>
                    <HealthPill health={a.health} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CrmCard>

        <CrmCard title="Imbuto" meta={`${data.open_leads + data.trials + data.customers} aziende`}>
          <ul className="space-y-1.5 pt-1">
            {funnel.map(stage => {
              const n = data.by_stage[stage] ?? 0;
              return (
                <li key={stage} className="flex items-center gap-3 text-[13px]">
                  <span className="w-20 flex-shrink-0 text-[var(--ds-text-secondary)]">{STAGE_LABEL[stage]}</span>
                  <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--ds-surface-row)]">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-[var(--ds-arriving-solid)]"
                      style={{ width: `${(n / funnelMax) * 100}%` }}
                    />
                  </span>
                  <span className="w-8 flex-shrink-0 text-right font-semibold tabular-nums text-[var(--ds-text-primary)]">{n}</span>
                </li>
              );
            })}
          </ul>
          {(data.by_stage.perso > 0 || data.by_stage.disdetto > 0) && (
            <p className="mt-2 text-[12px] text-[var(--ds-text-muted)]">
              Persi {data.by_stage.perso} · disdetti {data.by_stage.disdetto}
            </p>
          )}
        </CrmCard>

        <CrmCard title="Prove e rinnovi in scadenza" meta={data.expiring.length || undefined}>
          {data.expiring.length === 0 ? (
            <p className="flex items-center gap-2 py-2 text-[14px] text-[var(--ds-text-muted)]">
              <CalendarClock className="h-4 w-4" aria-hidden />Nessuna scadenza vicina.
            </p>
          ) : (
            <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
              {data.expiring.map(a => {
                const why = a.billing?.trial_end && a.stage === 'prova'
                  ? `prova fino al ${formatDay(a.billing.trial_end.slice(0, 10))}`
                  : a.billing?.cancel_at_period_end && a.billing.current_period_end
                    ? `disdetta dal ${formatDay(a.billing.current_period_end.slice(0, 10))}`
                    : a.renewal_date ? `rinnovo il ${formatDay(a.renewal_date)}` : '';
                return (
                  <li key={a.id}>
                    <button type="button" className={crmRowButton} onClick={() => onOpenAccount(a.id)}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{a.name}</span>
                        <span className="block truncate text-[12px] text-[var(--ds-text-muted)]">{why}</span>
                      </span>
                      <StagePill stage={a.stage} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </CrmCard>
      </div>

      <CrmCard
        title="Ultime attività"
        meta={data.pipeline.won_month > 0 ? (
          <span className="inline-flex items-center gap-1 text-[var(--ds-seated-text)]">
            <TrendingUp className="h-3.5 w-3.5" aria-hidden />
            {data.pipeline.won_month} vinte nel mese · {eur(data.pipeline.won_month_mrr_cents)}/mese
          </span>
        ) : undefined}
      >
        {data.recent_activities.length === 0 ? (
          <p className="py-2 text-[14px] text-[var(--ds-text-muted)]">Ancora niente: le note, le chiamate e i cambi di fase compaiono qui.</p>
        ) : (
          <ul className="-mx-3 divide-y divide-[var(--ds-border)]">
            {data.recent_activities.map(x => {
              const Icon = ACTIVITY_ICON[x.kind] ?? ACTIVITY_ICON.nota;
              return (
                <li key={x.id}>
                  <button type="button" className={`${crmRowButton} items-start`} onClick={() => onOpenAccount(x.account_id)}>
                    <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-label={ACTIVITY_LABEL[x.kind]} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-[var(--ds-text-secondary)]">{x.account_name}</span>
                      <span className="line-clamp-2 text-[14px] text-[var(--ds-text-primary)]">{x.body}</span>
                    </span>
                    <span className="flex-shrink-0 whitespace-nowrap text-[12px] text-[var(--ds-text-muted)]">{formatInstant(x.occurred_at)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </CrmCard>

      <SectionHeader tone="muted" action={
        <button type="button" className={dsButton.quiet} onClick={load} aria-label="Aggiorna">
          <RefreshCw className="h-4 w-4" aria-hidden />
        </button>
      }>
        {data.stripe ? 'Canoni da Stripe' : 'Stripe non configurato: canoni dalle schede'}
      </SectionHeader>
    </div>
  );
};

export default PlatformCrmOverview;
