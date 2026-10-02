import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Plus, X } from 'lucide-react';
import type { MyLeave } from '../types';
import { staffApiService } from '../services/staffApiService';
import { socketClient } from '../services/socketClient';
import { countLeaveDays, isIsoDay, makeServiceOpen } from '../utils/leavePlan';
import { Field, FormCard, StatStrip, StatusPill, dsButton, dsInput } from './ds';
import {
  LEAVE_STATUS_TONE, formatLeaveDays, formatLeaveRange, leaveErrorText, leaveStatusLabel,
} from './ferieShared';

/**
 * «Le mie ferie», nel profilo self-service. Compare solo a chi ha l'account
 * collegato a una scheda del personale (lo decide il responsabile dalla
 * scheda): per tutti gli altri non esiste, niente card vuota da spiegare.
 *
 * Il conteggio dei giorni mentre si scelgono le date è lo stesso del server
 * (utils/leavePlan.ts, col calendario del ristorante che arriva con la
 * risposta): il numero visto prima di inviare è quello che si scala.
 */
export const LeMieFerieCard: React.FC<{ open: boolean }> = ({ open }) => {
  const { t } = useTranslation('ferie', { useSuspense: false });
  const [data, setData] = useState<MyLeave | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const openRef = useRef(open);
  useEffect(() => { openRef.current = open; }, [open]);

  const load = useCallback(async () => {
    try {
      setData(await staffApiService.getMyLeave());
    } catch (err) {
      // Backend precedente o rete giù: la card semplicemente non c'è.
      console.warn('getMyLeave failed', err);
      setData(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setFormOpen(false);
    setMessage(null);
    load();
  }, [open, load]);

  // La decisione del responsabile arriva mentre il profilo è aperto.
  useEffect(() => {
    const onChange = () => { if (openRef.current) load(); };
    const attach = (socket: ReturnType<typeof socketClient.getSocket>) => {
      if (!socket) return () => {};
      socket.on('leave:changed', onChange);
      return () => { socket.off('leave:changed', onChange); };
    };
    let detach = attach(socketClient.getSocket());
    const unsubscribe = socketClient.onSocketChange(s => { detach(); detach = attach(s); });
    return () => { detach(); unsubscribe(); };
  }, [load]);

  const isOpen = useMemo(
    () => (data?.calendar ? makeServiceOpen(data.calendar) : null),
    [data]
  );
  const liveDays = useMemo(() => {
    if (!isOpen || !isIsoDay(startDate) || !isIsoDay(endDate) || endDate < startDate) return null;
    return countLeaveDays(data?.weeklyRestDay ?? null, startDate, endDate, isOpen);
  }, [isOpen, startDate, endDate, data]);

  if (!data || !data.linked) return null;

  const today = data.today ?? '';
  const balance = data.balance;
  const requests = data.requests ?? [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await staffApiService.requestMyLeave({ startDate, endDate, note: note.trim() || undefined });
      setFormOpen(false);
      setStartDate('');
      setEndDate('');
      setNote('');
      setMessage({ tone: 'ok', text: t('requestSent') });
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: leaveErrorText(err, t) });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (id: string) => {
    setBusyId(id);
    setMessage(null);
    try {
      await staffApiService.cancelMyLeave(id);
      await load();
    } catch (err) {
      setMessage({ tone: 'error', text: leaveErrorText(err, t) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <FormCard
      title={t('myLeaveTitle')}
      aside={balance && balance.remaining !== null ? (
        <span className={`text-[13px] tabular-nums ${balance.remaining < 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>
          {t('remainingShort', { days: formatLeaveDays(balance.remaining, t) })}
        </span>
      ) : undefined}
    >
      <div className="space-y-4">
        {balance && (
          <StatStrip
            stats={[
              ...(balance.entitled !== null ? [{ value: balance.entitled, label: t('col.entitled') }] : []),
              { value: balance.approved, label: t('col.approved') },
              { value: balance.pending, label: t('col.pending'), tone: balance.pending > 0 ? 'pending' as const : 'neutral' as const },
            ]}
          />
        )}

        {formOpen ? (
          <form onSubmit={submit} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('from')} htmlFor="mie-ferie-dal" required>
                <input
                  id="mie-ferie-dal"
                  type="date"
                  value={startDate}
                  min={today || undefined}
                  onChange={e => {
                    setStartDate(e.target.value);
                    if (!endDate || endDate < e.target.value) setEndDate(e.target.value);
                  }}
                  required
                  disabled={busy}
                  className={dsInput}
                />
              </Field>
              <Field label={t('to')} htmlFor="mie-ferie-al" required>
                <input
                  id="mie-ferie-al"
                  type="date"
                  value={endDate}
                  min={startDate || today || undefined}
                  onChange={e => setEndDate(e.target.value)}
                  required
                  disabled={busy}
                  className={dsInput}
                />
              </Field>
            </div>
            <Field label={t('note')} htmlFor="mie-ferie-nota">
              <input
                id="mie-ferie-nota"
                type="text"
                value={note}
                maxLength={500}
                onChange={e => setNote(e.target.value)}
                disabled={busy}
                className={dsInput}
              />
            </Field>
            {liveDays !== null && (
              <p className="text-[14px] text-[var(--ds-text-secondary)]" aria-live="polite">
                {liveDays > 0
                  ? t('willCost', { days: formatLeaveDays(liveDays, t) })
                  : t('error.no_working_days')}
                {liveDays > 0 && balance?.remaining != null && balance.remaining - balance.pending - liveDays < 0 && (
                  <span className="text-[var(--ds-critical-text)]"> · {t('overBalance')}</span>
                )}
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" onClick={() => setFormOpen(false)} disabled={busy} className={`${dsButton.secondary} flex-1`}>
                {t('cancel')}
              </button>
              <button type="submit" disabled={busy || !liveDays} className={`${dsButton.primary} flex-1`}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {t('send')}
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => { setMessage(null); setFormOpen(true); }} className={`${dsButton.secondary} w-full`}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('askLeave')}
          </button>
        )}

        {message && (
          <p
            role={message.tone === 'error' ? 'alert' : 'status'}
            className={`text-[13px] ${message.tone === 'ok' ? 'text-[var(--ds-seated-text)]' : 'text-[var(--ds-critical-text)]'}`}
          >
            {message.text}
          </p>
        )}

        {requests.length > 0 && (
          <ul className="divide-y divide-[var(--ds-border)]">
            {requests.map(r => (
              <li key={r.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="text-[15px] tabular-nums text-[var(--ds-text-primary)]">
                    {formatLeaveRange(r.startDate, r.endDate, data.year)}
                    <span className="text-[var(--ds-text-muted)]"> · {formatLeaveDays(r.days, t)}</span>
                  </div>
                  {(r.decisionNote || r.note) && (
                    <div className="truncate text-[13px] text-[var(--ds-text-muted)]">{r.decisionNote || r.note}</div>
                  )}
                </div>
                <StatusPill tone={LEAVE_STATUS_TONE[r.status]}>{leaveStatusLabel(r.status, t)}</StatusPill>
                {r.status === 'PENDING' && (
                  <button
                    type="button"
                    onClick={() => withdraw(r.id)}
                    disabled={busyId === r.id}
                    aria-label={t('withdraw')}
                    title={t('withdraw')}
                    className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-40"
                  >
                    {busyId === r.id ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <X className="h-4 w-4" aria-hidden />}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormCard>
  );
};
