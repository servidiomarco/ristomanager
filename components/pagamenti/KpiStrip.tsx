import React from 'react';

/* La striscia di cifre in testata di Pagamenti e Fiscalità. Era copiata in
   tutte e due le pagine: una sola, così le due testate restano la stessa
   grammatica — a sinistra di cosa si parla, a destra i numeri. */

export type KpiTone = 'positive' | 'pending' | 'critical';

export const Kpi: React.FC<{ label: string; value: string; tone?: KpiTone }> = ({ label, value, tone }) => (
  // flex-1 + min-w-0: on a phone the three share the row evenly and the labels
  // truncate rather than pushing the third figure onto a line of its own.
  <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 py-2 lg:flex-none lg:px-4 lg:py-2.5 lg:first:pl-0 lg:last:pr-0">
    {/* nowrap: «€ 832,00» spezzato lasciava l'euro da solo su una riga. */}
    <span className={`whitespace-nowrap text-[17px] leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[20px] ${
      tone === 'positive' ? 'text-[var(--ds-seated-text)]'
      : tone === 'pending' ? 'text-[var(--ds-pending-text)]'
      : tone === 'critical' ? 'text-[var(--ds-critical-text)]'
      : 'text-[var(--ds-text-primary)]'
    }`}>
      {value}
    </span>
    {/* Sentence case, not the caps the mockup showed: at 12px capitals lose the
        word shape that makes a label scannable, and screen readers spell short
        ones out letter by letter. */}
    <span className="truncate text-[11px] text-[var(--ds-text-muted)] sm:text-[12px]">{label}</span>
  </div>
);

/* Hairline-split figures rather than one card each: they are one reading of
   the same money, and boxing each gave competing objects. No wrapping either —
   a figure dropping to its own line reads as a separate object. They compress
   instead. */
export const KpiStrip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex w-full flex-shrink-0 items-center divide-x divide-[var(--ds-border)] rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-1 py-1 shadow-[var(--ds-shadow-card)] lg:w-auto lg:px-4">
    {children}
  </div>
);
