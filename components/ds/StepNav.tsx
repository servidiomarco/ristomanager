import React from 'react';
import { Check } from 'lucide-react';

/* ── StepNav ──────────────────────────────────────────────────────────────
   The header for a form split across screens. Lifted out of the banquet form,
   which was the first to need it, so the second wizard cannot drift from the
   first — the two were about to differ in tick colour and rail weight alone,
   which is the kind of difference nobody notices and everybody feels.

   Steps never gate each other: every one is reachable from here at any time,
   and validation runs once on save exactly as it did when the form was a
   single scroll. That is why each step is a button rather than a read-only
   indicator, and why there is no "completed" concept beyond "already behind
   you".

   Belongs in ModalShell's `subheader` slot: pinned above the scroll, so it
   stays put while the body moves and does not shift as steps change length. */

export const StepNav: React.FC<{
  /** `label` and the optional `disabled` are read; extra keys are fine.
   *  A disabled step still shows — it tells you the form has a Pagamenti
   *  section without pretending you can fill it in before the record exists. */
  steps: readonly { label: string; disabled?: boolean }[];
  current: number;
  onSelect: (index: number) => void;
  ariaLabel?: string;
}> = ({ steps, current, onSelect, ariaLabel = 'Passi' }) => (
  <nav className="flex gap-2 overflow-x-auto scrollbar-hide" aria-label={ariaLabel}>
    {steps.map((step, i) => {
      const isCurrent = i === current;
      const isDone = i < current && !step.disabled;
      return (
        <button
          key={step.label}
          type="button"
          onClick={() => onSelect(i)}
          disabled={step.disabled}
          className="group flex min-w-[150px] flex-1 flex-col gap-2 text-left focus-visible:outline-none disabled:cursor-not-allowed"
          aria-current={isCurrent ? 'step' : undefined}
        >
          {/* The rail, not a number, is what carries progress at a glance —
              filled behind you, empty ahead. */}
          <span className={`h-[3px] w-full rounded-full ${
            step.disabled ? 'bg-[var(--ds-border)]'
            : isCurrent || isDone ? 'bg-[var(--ds-action-bg)]'
            : 'bg-[var(--ds-border)]'
          }`} />
          <span className="flex items-center gap-2">
            <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[12px] font-semibold tabular-nums ${
              step.disabled
                ? 'bg-[var(--ds-surface)] text-[var(--ds-text-subtle)]'
                : isDone
                  ? 'bg-[var(--ds-seated-solid)] text-[#ffffff]'
                  : isCurrent
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)]'
            }`}>
              {isDone ? <Check className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={`truncate text-[14px] ${
              step.disabled ? 'text-[var(--ds-text-subtle)]'
              : isCurrent ? 'font-semibold text-[var(--ds-text-primary)]'
              : 'text-[var(--ds-text-muted)] group-hover:text-[var(--ds-text-primary)]'
            }`}>
              {step.label}
            </span>
          </span>
        </button>
      );
    })}
  </nav>
);
