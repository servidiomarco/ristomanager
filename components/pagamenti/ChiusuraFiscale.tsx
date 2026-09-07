import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { billsApiService } from '../../services/billsApiService';
import { socketClient } from '../../services/socketClient';
import { useAuth } from '../../contexts/AuthContext';
import type { FiscalClosureView } from '../../types';
import { Callout, Field, FormCard, StatusPill, dsButton, dsInput, dsTextarea } from '../ds';
import { formatEuro } from './paymentsView';

/* ── Chiusura fiscale della giornata ──────────────────────────────────────
   (docs/chiusura-fiscale-plan.md) L'atto che oggi si fa sul registratore,
   dalla pagina che già si legge a fine serata. Cosa fa il bottone dipende
   dal provider fiscale: la Z vera via agente (rt-local), la firma di un
   riscontro (openapi), la registrazione del tagliando (il ponte — dove la
   chiusura in cassa resta sempre possibile, e questa card la mette solo a
   registro col delta). */

const toCents = (s: string): number | null => {
  if (s.trim() === '') return null;
  const n = parseFloat(s.replace(/[^\d.,]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

const row = 'flex justify-between text-[14px] text-[var(--ds-text-secondary)]';

export const ChiusuraFiscale: React.FC<{ date?: string }> = ({ date }) => {
  const { hasPermission } = useAuth();
  const canClose = hasPermission('cash:close_session');

  const [view, setView] = useState<FiscalClosureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [zrep, setZrep] = useState('');
  const [rtTotal, setRtTotal] = useState('');
  const [note, setNote] = useState('');

  const fetchView = useCallback(async () => {
    try {
      setError(null);
      setView(await billsApiService.getFiscalClosure(date));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [date]);

  useEffect(() => { fetchView(); }, [fetchView]);

  // La conferma della Z arriva dall'ack dell'agente, via socket; anche ogni
  // documento emesso o annullato muove i numeri della fotografia.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchView(); }, 500);
    };
    const socket = socketClient.getSocket();
    const events = ['fiscal:closure-updated', 'fiscal:updated', 'bill:closed', 'bill:settled'];
    events.forEach(e => socket?.on(e, onEvent));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach(e => socket?.off(e, onEvent));
    };
  }, [fetchView]);

  if (error) return <Callout tone="critical" icon={AlertCircle}>{error}</Callout>;
  if (!view) return null;

  const closure = view.closure;
  const manual = view.provider !== 'rt-local' && view.provider !== 'openapi' && view.provider !== 'mock';
  const rtTotalCents = toCents(rtTotal);
  const delta = rtTotalCents != null ? rtTotalCents - view.receipts.total_cents : null;
  const needsNote = manual && delta != null && delta !== 0;
  const showAction = canClose && (!closure || closure.status === 'FAILED');

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setFormError(null);
    try {
      await billsApiService.closeFiscalDay(manual ? {
        date: view.date,
        zrep_number: zrep.trim() || undefined,
        rt_total_cents: rtTotalCents,
        note: note.trim() || undefined,
      } : { date: view.date });
      await fetchView();
    } catch (err) {
      setFormError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormCard
      title="Chiusura fiscale"
      aside={closure?.status === 'CONFIRMED' ? <StatusPill tone="positive">giornata chiusa</StatusPill>
        : closure?.status === 'PENDING' ? <StatusPill tone="pending">Z in corso</StatusPill>
        : undefined}
    >
      <div className="space-y-3">
        <dl className="space-y-1.5">
          <div className={row}>
            <dt>Scontrini emessi <span className="ml-1 text-[12px] text-[var(--ds-text-muted)]">×{view.receipts.count}</span></dt>
            <dd className="tabular-nums font-semibold text-[var(--ds-text-primary)]">{formatEuro(view.receipts.total_cents)}</dd>
          </div>
          {view.pending_count > 0 && (
            <div className={`${row} text-[var(--ds-pending-text)]`}>
              <dt>In emissione</dt>
              <dd className="tabular-nums">{view.pending_count}</dd>
            </div>
          )}
          {view.failed_count > 0 && (
            <div className={`${row} text-[var(--ds-critical-text)]`}>
              <dt>Emissioni fallite</dt>
              <dd className="tabular-nums">{view.failed_count}</dd>
            </div>
          )}
        </dl>

        {view.bills_without_doc > 0 && !closure && (
          <Callout tone="pending" icon={AlertCircle}>
            {view.bills_without_doc === 1
              ? '1 conto chiuso senza documento: si sistema dalla lista qui sopra.'
              : `${view.bills_without_doc} conti chiusi senza documento: si sistemano dalla lista qui sopra.`}
          </Callout>
        )}

        {closure && closure.status !== 'FAILED' && (
          <dl className="space-y-1.5 border-t border-[var(--ds-border)] pt-2">
            {closure.zrep_number && (
              <div className={row}><dt>Chiusura Z</dt><dd className="tabular-nums">{closure.zrep_number}</dd></div>
            )}
            <div className={row}><dt>Totale CRM alla chiusura</dt><dd className="tabular-nums">{formatEuro(closure.crm_total_cents)}</dd></div>
            {closure.rt_total_cents != null && (
              <>
                <div className={row}><dt>Totale registratore</dt><dd className="tabular-nums">{formatEuro(closure.rt_total_cents)}</dd></div>
                <div className={`${row} ${closure.rt_total_cents - closure.crm_total_cents !== 0 ? 'text-[var(--ds-pending-text)]' : ''}`}>
                  <dt>Differenza</dt>
                  <dd className="tabular-nums">{formatEuro(closure.rt_total_cents - closure.crm_total_cents)}</dd>
                </div>
              </>
            )}
            {closure.note && <p className="text-[13px] text-[var(--ds-text-muted)]">{closure.note}</p>}
            <p className="text-[12px] text-[var(--ds-text-muted)]">di {closure.requested_by_name}</p>
          </dl>
        )}

        {closure?.status === 'FAILED' && (
          <Callout tone="critical" icon={AlertCircle}>
            Chiusura fallita{closure.error ? `: ${closure.error}` : ''}.
          </Callout>
        )}

        {showAction && manual && (
          <div className="space-y-3 border-t border-[var(--ds-border)] pt-3">
            {/* Il ponte: la Z si fa in cassa come sempre, qui si mette a
                registro quello che dice il tagliando. */}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Numero Z" htmlFor="cf-zrep">
                <input id="cf-zrep" className={dsInput} value={zrep} onChange={e => setZrep(e.target.value)} inputMode="numeric" placeholder="0934" />
              </Field>
              <Field label="Totale registratore" htmlFor="cf-rt-total">
                <input id="cf-rt-total" className={`${dsInput} text-right tabular-nums`} value={rtTotal} onChange={e => setRtTotal(e.target.value)} inputMode="decimal" placeholder="0,00" />
              </Field>
            </div>
            {delta != null && delta !== 0 && (
              <p className="text-[13px] text-[var(--ds-pending-text)]">
                Differenza col CRM: {formatEuro(delta)} — serve una nota.
              </p>
            )}
            <Field label="Nota" htmlFor="cf-note" required={needsNote}>
              <textarea id="cf-note" className={dsTextarea} rows={2} value={note} onChange={e => setNote(e.target.value)} />
            </Field>
            <button type="button" className={`${dsButton.primary} w-full`} disabled={busy || (needsNote && note.trim() === '')} onClick={submit}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Registra la chiusura dell'RT
            </button>
          </div>
        )}

        {showAction && !manual && (
          <div className="space-y-2 border-t border-[var(--ds-border)] pt-3">
            <button
              type="button"
              className={`${dsButton.primary} w-full`}
              disabled={busy || (view.provider !== 'rt-local' && (view.pending_count > 0 || view.failed_count > 0))}
              onClick={submit}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Chiudi la giornata fiscale
            </button>
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {view.provider === 'rt-local'
                ? 'La chiusura Z parte sul registratore in sala.'
                : 'I documenti sono già trasmessi uno a uno: la chiusura firma il riscontro della giornata.'}
            </p>
          </div>
        )}

        {formError && <Callout tone="critical" icon={AlertCircle}>{formError}</Callout>}
      </div>
    </FormCard>
  );
};
