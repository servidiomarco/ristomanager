import React from 'react';
import { money } from '../../utils/displayMoney';

/* ── Le tre cifre del conto ───────────────────────────────────────────────
   Totale, incassato, residuo — read as one line, which is why they share a
   row rather than sitting in three boxes. The residual is the one that
   decides whether anyone has to do anything, so it carries the critical tone
   until it reaches zero and turns green.

   Labels are sentence case, not the caps of the mockup: at 12px capitals lose
   the word shape that makes a label scannable, and screen readers spell short
   ones out letter by letter. */

const euro = (cents: number): string => money(cents);

const Figure: React.FC<{ label: string; value: string; tone?: 'positive' | 'critical' }> = ({
  label, value, tone,
}) => (
  <div className="min-w-0 flex-1">
    <div className="truncate text-[12px] text-[var(--ds-text-muted)]">{label}</div>
    <div className={`mt-0.5 text-[22px] font-semibold leading-none tracking-[-0.02em] tabular-nums ${
      tone === 'positive' ? 'text-[var(--ds-seated-text)]'
      : tone === 'critical' ? 'text-[var(--ds-critical-text)]'
      : 'text-[var(--ds-text-primary)]'
    }`}>
      {value}
    </div>
  </div>
);

export const BillFigures: React.FC<{
  totalCents: number;
  paidCents: number;
  residualCents: number;
}> = ({ totalCents, paidCents, residualCents }) => {
  const pct = totalCents > 0 ? Math.min(100, Math.round((paidCents / totalCents) * 100)) : 0;
  const settled = residualCents <= 0;
  return (
    <>
      <div className="flex items-start gap-4">
        <Figure label="Totale" value={euro(totalCents)} />
        <Figure label="Incassato" value={euro(paidCents)} tone={paidCents > 0 ? 'positive' : undefined} />
        <Figure
          label="Residuo"
          value={euro(Math.max(0, residualCents))}
          tone={settled ? 'positive' : 'critical'}
        />
      </div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-[var(--ds-border)]">
        <div
          className="h-full rounded-[var(--ds-radius-control)] bg-[var(--ds-seated-solid)] transition-all"
          style={{ width: `${pct}%` }}
        />
      </div>
    </>
  );
};

/** Bill state as a word rather than the raw enum the card used to print.
 *  "OPEN" told the operator nothing they could act on. */
export const billStateLabel = (
  totalCents: number,
  paidCents: number,
): { labelKey: string; fallback: string; tone: 'positive' | 'pending' | 'neutral' } => {
  if (totalCents > 0 && paidCents >= totalCents) return { labelKey: 'billState.paid', fallback: 'Saldato', tone: 'positive' };
  if (paidCents > 0) return { labelKey: 'billState.partial', fallback: 'Saldato in parte', tone: 'pending' };
  return { labelKey: 'billState.unpaid', fallback: 'Da saldare', tone: 'neutral' };
};
