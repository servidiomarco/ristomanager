import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, History, RefreshCw } from 'lucide-react';
import { Callout, EmptyState, SectionHeader, StatusPill } from '../ds';
import { Loader } from '../Loader';
import { ActivityLog, LogRefs } from '../../types';
import { logApiService } from '../../services/logApiService';
import { actorName, describeLog } from '../../utils/activityLogText';
import { datePart, timePart } from '../../utils/displayTime';
import { formatDate } from '../../utils/formatLocale';

/* ── Registro attività: righe, giorni, cronologia ─────────────────────────
   Una riga è una frase — chi, cosa, su quale prenotazione — non sette colonne
   di chiavi tecniche. Le stesse righe servono il registro (dal più recente) e
   la cronologia di una prenotazione (dal più vecchio, come una storia). */

type OpenReservation = (id: number, name: string) => void;

const linkClass =
  'inline-flex min-h-[32px] items-center gap-0.5 rounded-[var(--ds-radius-control)] text-[13px] font-medium text-[var(--ds-text-primary)] underline decoration-[var(--ds-border-strong)] underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

const formatValue = (v: unknown): string => {
  if (v == null) return '—';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const LogRow: React.FC<{
  log: ActivityLog;
  refs: LogRefs;
  onOpenReservation?: OpenReservation;
  /** La riga sta già dentro la cronologia di questa prenotazione: il suo
   *  nome non è un link verso sé stessa. */
  currentReservationId?: number;
}> = ({ log, refs, onOpenReservation, currentReservationId }) => {
  const { t } = useTranslation('log', { useSuspense: false });
  const [open, setOpen] = useState(false);
  const line = describeLog(log, refs, t);
  const details = log.details && typeof log.details === 'object' ? Object.entries(log.details) : [];
  const canOpen = (id?: number) => !!onOpenReservation && id != null && id !== currentReservationId;
  // Dentro la cronologia di una prenotazione il suo nome è già nel titolo:
  // ripeterlo su ogni riga è rumore.
  const subject = line.reservationId != null && line.reservationId === currentReservationId ? undefined : line.subject;
  const related = line.related.filter(r => r.id !== currentReservationId);

  return (
    <li className="flex gap-3 border-t border-[var(--ds-border)] px-4 py-3 first:border-t-0">
      <time
        dateTime={log.created_at}
        className="w-11 flex-shrink-0 pt-0.5 text-[13px] tabular-nums text-[var(--ds-text-muted)]"
      >
        {timePart(log.created_at)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] leading-snug text-[var(--ds-text-primary)]">
          <span className="font-semibold">{actorName(log)}</span>{' '}
          <span>{line.text}</span>
          {log.status === 'ERROR' && (
            <StatusPill tone="critical" className="ml-2 align-middle">{t('failed', 'Errore')}</StatusPill>
          )}
        </p>

        {(subject || line.meta.length > 0 || related.length > 0) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[var(--ds-text-muted)]">
            {subject && (canOpen(line.reservationId) ? (
              <button
                type="button"
                className={linkClass}
                onClick={() => onOpenReservation!(line.reservationId!, subject)}
              >
                {subject}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : (
              <span className="text-[var(--ds-text-secondary)]">{subject}</span>
            ))}
            {line.meta.length > 0 && <span>{line.meta.join(' · ')}</span>}
            {related.map(r => canOpen(r.id) ? (
              <button key={r.id} type="button" className={linkClass} onClick={() => onOpenReservation!(r.id, r.name)}>
                {r.name}
                <ChevronRight className="h-3.5 w-3.5" aria-hidden />
              </button>
            ) : (
              <span key={r.id} className="text-[var(--ds-text-secondary)]">{r.name}</span>
            ))}
          </div>
        )}

        {line.changes.length > 0 && (
          <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t('changes', 'Modifiche')}>
            {line.changes.map(c => (
              <li
                key={c.key}
                className="rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-2 py-0.5 text-[12px] text-[var(--ds-text-secondary)]"
              >
                {/* Senza valori (nome, telefono, email, note): basta il campo,
                    il «ha modificato» è già nella frase. */}
                {c.label}
                {c.from !== undefined && (
                  <>
                    {' '}<span className="text-[var(--ds-text-muted)] line-through decoration-[var(--ds-border-strong)]">{c.from}</span>
                    {' → '}<span className="font-medium text-[var(--ds-text-primary)]">{c.to}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}

        {log.status === 'ERROR' && log.error_message && (
          <p className="mt-1 text-[13px] text-[var(--ds-critical-text)]">{log.error_message}</p>
        )}

        {open && (
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-[var(--ds-radius-sm)] bg-[var(--ds-surface-row)] p-3 text-[12px]">
            <dt className="text-[var(--ds-text-muted)]">{t('raw.account', 'Account')}</dt>
            <dd className="min-w-0 break-words text-[var(--ds-text-secondary)]">{log.user_email || '—'}</dd>
            <dt className="text-[var(--ds-text-muted)]">{t('raw.record', 'Registrazione')}</dt>
            <dd className="min-w-0 break-words tabular-nums text-[var(--ds-text-secondary)]">
              #{log.id} · {log.action} {log.resource_type}{log.resource_id != null ? ` #${log.resource_id}` : ''}
            </dd>
            {log.resource_name && (
              <>
                <dt className="text-[var(--ds-text-muted)]">{t('raw.name', 'Nome')}</dt>
                <dd className="min-w-0 break-words text-[var(--ds-text-secondary)]">{log.resource_name}</dd>
              </>
            )}
            {details.map(([k, v]) => (
              <React.Fragment key={k}>
                <dt className="font-mono text-[var(--ds-text-muted)]">{k}</dt>
                <dd className="min-w-0 break-words font-mono text-[var(--ds-text-secondary)]">{formatValue(v)}</dd>
              </React.Fragment>
            ))}
          </dl>
        )}
      </div>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label={open ? t('hideRaw', 'Nascondi i dati registrati') : t('showRaw', 'Mostra i dati registrati')}
        title={open ? t('hideRaw', 'Nascondi i dati registrati') : t('showRaw', 'Mostra i dati registrati')}
        className="-my-1 -mr-2 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
    </li>
  );
};

/** «Oggi», «Ieri», «sabato 10 ottobre» nel fuso del ristorante. */
const useDayLabel = () => {
  const { t } = useTranslation('log', { useSuspense: false });
  return useCallback((iso: string): string => {
    const today = datePart(new Date());
    const yesterday = datePart(new Date(Date.now() - 86_400_000));
    if (iso === today) return t('today', 'Oggi');
    if (iso === yesterday) return t('yesterday', 'Ieri');
    const [y, m, d] = iso.split('-').map(Number);
    // L'anno solo quando non è quello in corso: il registro va indietro di mesi.
    const otherYear = String(y) !== today.slice(0, 4);
    return formatDate(new Date(y, m - 1, d), { weekday: 'long', day: 'numeric', month: 'long', ...(otherYear ? { year: 'numeric' } : {}) });
  }, [t]);
};

/** Righe raggruppate per giorno, nell'ordine in cui arrivano. */
export const LogList: React.FC<{
  logs: ActivityLog[];
  refs: LogRefs;
  onOpenReservation?: OpenReservation;
  currentReservationId?: number;
}> = ({ logs, refs, onOpenReservation, currentReservationId }) => {
  const dayLabel = useDayLabel();
  const groups: { day: string; logs: ActivityLog[] }[] = [];
  for (const log of logs) {
    const day = datePart(log.created_at);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.logs.push(log);
    else groups.push({ day, logs: [log] });
  }
  return (
    <div className="space-y-3">
      {groups.map(g => (
        <section key={g.day}>
          <SectionHeader>{dayLabel(g.day)}</SectionHeader>
          <ul className="overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {g.logs.map(log => (
              <LogRow
                key={log.id}
                log={log}
                refs={refs}
                onOpenReservation={onOpenReservation}
                currentReservationId={currentReservationId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
};

/**
 * Chi ha fatto cosa su una prenotazione, dalla creazione: le sue modifiche
 * più unioni e divisioni dei suoi tavoli in quel turno. Si carica quando
 * compare, non prima: chi non apre la cronologia non paga la query.
 */
export const ReservationHistory: React.FC<{
  reservationId: number;
  onOpenReservation?: OpenReservation;
}> = ({ reservationId, onOpenReservation }) => {
  const { t } = useTranslation('log', { useSuspense: false });
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; logs: ActivityLog[]; refs: LogRefs }
  >({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await logApiService.getReservationHistory(reservationId);
      setState({ kind: 'ready', logs: res.logs, refs: res.refs });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : t('errLoad', 'Errore nel caricamento dei log') });
    }
  }, [reservationId, t]);

  useEffect(() => { load(); }, [load]);

  if (state.kind === 'loading') {
    return <div className="p-8 text-center"><Loader size={40} /></div>;
  }
  if (state.kind === 'error') {
    return (
      <Callout
        tone="critical"
        action={
          <button type="button" onClick={load} className="text-[13px] font-medium underline underline-offset-2">
            {t('retry', 'Riprova')}
          </button>
        }
      >
        {state.message}
      </Callout>
    );
  }
  if (state.logs.length === 0) {
    return <EmptyState icon={History}>{t('historyEmpty', 'Nessuna operazione registrata')}</EmptyState>;
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <p className="text-[13px] text-[var(--ds-text-muted)]">
          {t('historyHint', 'Comprese le unioni dei suoi tavoli in quel turno.')}
        </p>
        <button
          type="button"
          onClick={load}
          className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          title={t('reload', 'Aggiorna')}
          aria-label={t('reload', 'Aggiorna')}
        >
          <RefreshCw className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <LogList
        logs={state.logs}
        refs={state.refs}
        onOpenReservation={onOpenReservation}
        currentReservationId={reservationId}
      />
    </div>
  );
};
