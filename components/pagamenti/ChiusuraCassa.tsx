import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { billsApiService } from '../../services/billsApiService';
import { socketClient } from '../../services/socketClient';
import type { CashClosureReport } from '../../types';
import { Callout, FormCard } from '../ds';
import { formatEuro } from './paymentsView';

/* ── Chiusura di cassa ────────────────────────────────────────────────────
   I totali del giorno per metodo di incasso, dal libro cassa
   (table_bill_payments). È la pagina che si legge a fine serata contando il
   cassetto: contanti da trovare fisicamente, POS da riscontrare coi totali
   del terminale, online già riconciliato dal gateway. Sotto, i dati dei
   conti chiusi nel giorno: mance, acconti maturati, ammanchi. */

const METHOD_LABELS: Record<string, string> = {
  CONTANTI: 'Contanti',
  POS_FISICO: 'POS',
  SATISPAY: 'Satispay',
  BUONO_PASTO: 'Buoni pasto',
  GIFT_CARD: 'Gift card',
  SOSPESO: 'Sospeso',
  OMAGGIO: 'Omaggio',
  LINK_ONLINE: 'Pagato online',
};

export const ChiusuraCassa: React.FC<{ date?: string }> = ({ date }) => {
  const [report, setReport] = useState<CashClosureReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchReport = useCallback(async () => {
    try {
      setError(null);
      setReport(await billsApiService.getCashClosure(date));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [date]);

  useEffect(() => { fetchReport(); }, [fetchReport]);

  // I numeri si muovono mentre il servizio incassa: ogni evento di conto
  // rilegge, con debounce perché una chiusura emette più eventi in raffica.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onEvent = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => { fetchReport(); }, 500);
    };
    const socket = socketClient.getSocket();
    const events = ['bill:closed', 'bill:settled', 'bill:split-paid', 'bill:payment-recorded', 'bill:payment-voided', 'bill:split-refunded'];
    events.forEach(e => socket?.on(e, onEvent));
    return () => {
      if (timer.current) clearTimeout(timer.current);
      events.forEach(e => socket?.off(e, onEvent));
    };
  }, [fetchReport]);

  if (error) {
    return <Callout tone="critical" icon={AlertCircle}>{error}</Callout>;
  }
  if (!report) return null;

  const hasMovements = report.methods.length > 0;

  return (
    <div className="space-y-3">
      <FormCard title={`Incassi del ${report.date.split('-').reverse().join('/')}`}>
        {hasMovements ? (
          <dl className="space-y-1.5 text-[14px]">
            {report.methods.map(m => (
              <div key={m.method} className="flex justify-between text-[var(--ds-text-secondary)]">
                <dt>
                  {METHOD_LABELS[m.method] ?? m.method}
                  <span className="ml-1.5 text-[12px] text-[var(--ds-text-muted)]">×{m.movements}</span>
                </dt>
                <dd className="tabular-nums">{formatEuro(m.amount_cents)}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t border-[var(--ds-border)] pt-1.5 font-semibold text-[var(--ds-text-primary)]">
              <dt>Totale</dt>
              <dd className="tabular-nums">{formatEuro(report.total_cents)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun incasso registrato.</p>
        )}
      </FormCard>

      <FormCard title="Conti chiusi">
        <dl className="space-y-1.5 text-[14px]">
          <div className="flex justify-between text-[var(--ds-text-secondary)]">
            <dt>Conti chiusi</dt>
            <dd className="tabular-nums">{report.bills_closed}</dd>
          </div>
          {report.tip_cents > 0 && (
            <div className="flex justify-between text-[var(--ds-text-secondary)]">
              <dt>Mance</dt>
              <dd className="tabular-nums">{formatEuro(report.tip_cents)}</dd>
            </div>
          )}
          {report.deposit_credit_cents > 0 && (
            <div className="flex justify-between text-[var(--ds-text-secondary)]">
              <dt>Acconti maturati</dt>
              <dd className="tabular-nums">{formatEuro(report.deposit_credit_cents)}</dd>
            </div>
          )}
          {report.shortfall_cents > 0 && (
            <div className="flex justify-between text-[var(--ds-critical-text)]">
              <dt>Ammanchi</dt>
              <dd className="tabular-nums">{formatEuro(report.shortfall_cents)}</dd>
            </div>
          )}
        </dl>
      </FormCard>
    </div>
  );
};
