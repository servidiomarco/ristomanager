import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check } from 'lucide-react';

/* ── StepNav ──────────────────────────────────────────────────────────────
   The header for a form split across screens. Lifted out of the banquet form,
   which was the first to need it, so the second wizard cannot drift from the
   first — the two were about to differ in tick colour and rail weight alone,
   which is the kind of difference nobody notices and everybody feels.

   Steps never gate each other: every one is reachable from here at any time,
   and validation runs once on save exactly as it did when the form was a
   single scroll. That is why each step is a button rather than a read-only
   indicator.

   By default the tick means "already behind you", nothing more. A form that
   knows better passes `status` on its steps, and then the circle tells the
   truth instead: a tick only where the step is filled in, an amber mark where
   a required field is still empty. Behind-you ticks lied in the banquet form —
   four green ticks over a form that would not save, because the price was 0
   two steps back.

   Belongs in ModalShell's `subheader` slot: pinned above the scroll, so it
   stays put while the body moves and does not shift as steps change length. */

export const StepNav: React.FC<{
  /** `label` and the optional `disabled`/`icon` are read; extra keys are fine.
   *  A disabled step still shows — it tells you the form has a Pagamenti
   *  section without pretending you can fill it in before the record exists.
   *  `icon` replaces the step number in the circle (done keeps the tick):
   *  a glyph says what the step is about, a number only says how far it is —
   *  and the rail already carries that.
   *
   *  `status`, when given, replaces "behind you" as the meaning of the tick:
   *  'done' ticks, 'missing' marks the step amber (a required field is empty),
   *  'todo' shows the plain icon. Pass it on every step or on none. */
  steps: readonly {
    label: string;
    disabled?: boolean;
    icon?: React.ComponentType<{ className?: string }>;
    status?: 'done' | 'missing' | 'todo';
  }[];
  current: number;
  onSelect: (index: number) => void;
  ariaLabel?: string;
}> = ({ steps, current, onSelect, ariaLabel }) => {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const navRef = React.useRef<HTMLElement>(null);
  // Su mobile la nav scorre e il passo attivo può stare fuori schermo: dopo
  // un «Avanti» sembra che il form non sia cambiato. Il passo attivo si
  // centra da solo; `block: 'nearest'` lascia in pace lo scroll verticale
  // del corpo, che ha già il suo aggancio per-step.
  React.useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[aria-current="step"]')
      ?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [current]);
  return (
  <nav ref={navRef} className="flex gap-2 overflow-x-auto scrollbar-hide" aria-label={ariaLabel ?? t('aria.steps', 'Passi')}>
    {steps.map((step, i) => {
      const isCurrent = i === current;
      // Where you are wins over what the step holds: the current step keeps
      // its "you are here" fill whatever its fields say.
      const state = step.disabled ? 'todo' : (step.status ?? (i < current ? 'done' : 'todo'));
      const isDone = !isCurrent && state === 'done';
      const isMissing = !isCurrent && state === 'missing';
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
          <span className={`h-[3px] w-full rounded-[var(--ds-radius-control)] ${
            step.disabled ? 'bg-[var(--ds-border)]'
            : isMissing ? 'bg-[var(--ds-pending-solid)]'
            : isCurrent || isDone ? 'bg-[var(--ds-action-bg)]'
            : 'bg-[var(--ds-border)]'
          }`} />
          <span className="flex items-center gap-2">
            <span className={`flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] text-[12px] font-semibold tabular-nums ${
              step.disabled
                ? 'bg-[var(--ds-surface)] text-[var(--ds-text-subtle)]'
                : isDone
                  ? 'bg-[var(--ds-seated-solid)] text-[#ffffff]'
                  : isMissing
                    // Amber takes dark text (§3.3): tint and text, not solid.
                    ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                  : isCurrent
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)]'
            }`}>
              {isDone ? <Check className="h-3.5 w-3.5" />
                : isMissing ? <AlertCircle className="h-3.5 w-3.5" />
                : step.icon ? <step.icon className="h-3.5 w-3.5" /> : i + 1}
            </span>
            <span className={`truncate text-[14px] ${
              step.disabled ? 'text-[var(--ds-text-subtle)]'
              : isCurrent ? 'font-semibold text-[var(--ds-text-primary)]'
              : isMissing ? 'text-[var(--ds-pending-text)]'
              : 'text-[var(--ds-text-muted)] group-hover:text-[var(--ds-text-primary)]'
            }`}>
              {step.label}
              {/* The circle says it by shape and colour; a screen reader gets
                  the words. Only when the form passed a status — the
                  positional tick has nothing to add to "step 3 of 5". */}
              {step.status && !isCurrent && (
                <span className="sr-only">
                  {' — '}{isMissing ? t('aria.stepMissing', 'da completare') : isDone ? t('aria.stepDone', 'completato') : ''}
                </span>
              )}
            </span>
          </span>
        </button>
      );
    })}
  </nav>
  );
};
