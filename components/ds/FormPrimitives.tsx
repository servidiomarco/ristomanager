import React from 'react';

/**
 * Form building blocks shared across modals. Deliberately unopinionated about
 * layout — each one styles a single control and lets the caller place it.
 */

/* ── FormCard ─────────────────────────────────────────────────────────────
   A white group sitting on the modal's canvas body. Grouping is what turns a
   long flat form into something scannable: the eye lands on four blocks
   instead of fourteen fields. */
export const FormCard: React.FC<{
  title?: string;
  /** Rendered opposite the title — a count, a hint, a small action. */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, aside, className = '', children }) => (
  <section className={`rounded-[20px] bg-[var(--ds-surface)] p-5 sm:p-6 ${className}`}>
    {(title || aside) && (
      <div className="mb-5 flex items-center justify-between gap-3">
        {title && (
          <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            {title}
          </h3>
        )}
        {aside && <div className="flex-shrink-0">{aside}</div>}
      </div>
    )}
    {children}
  </section>
);

/* ── Field ────────────────────────────────────────────────────────────────
   Label + control + optional hint. `required` renders the asterisk in the
   critical tone so it's visible without relying on colour alone (the label
   text itself still reads normally). */
export const Field: React.FC<{
  label?: React.ReactNode;
  htmlFor?: string;
  required?: boolean;
  hint?: React.ReactNode;
  /** Rendered opposite the label — e.g. a computed "Tavolo libero alle 22:00". */
  aside?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ label, htmlFor, required, hint, aside, className = '', children }) => (
  <div className={`min-w-0 ${className}`}>
    {(label || aside) && (
      <div className="mb-2 flex items-baseline justify-between gap-2">
        {label && (
          <label htmlFor={htmlFor} className="text-[14px] font-medium text-[var(--ds-text-secondary)]">
            {label}
            {required && <span className="ml-0.5 text-[var(--ds-critical-text)]" aria-hidden>*</span>}
          </label>
        )}
        {aside && <span className="flex-shrink-0 text-[13px] text-[var(--ds-text-muted)]">{aside}</span>}
      </div>
    )}
    {children}
    {hint && <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">{hint}</p>}
  </div>
);

/** Shared input styling — exported so native inputs, selects and textareas in
 *  callers all land on the same surface without copying class strings. */
export const dsInput =
  'w-full h-11 px-4 rounded-full bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/** A select is dsInput plus our own chevron — see .ds-select in index.css. */
export const dsSelect =
  'w-full h-11 px-4 rounded-full bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] cursor-pointer transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ds-select';

export const dsTextarea =
  'w-full px-4 py-3 rounded-[16px] bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/* ── Stepper ──────────────────────────────────────────────────────────────
   [−] value [+]. The increment is the primary action, so it carries the solid
   fill while decrement stays quiet — you add covers far more often than you
   remove them. */
export const Stepper: React.FC<{
  value: number | undefined;
  onChange: (next: number | undefined) => void;
  min?: number;
  max?: number;
  required?: boolean;
  ariaLabel: string;
}> = ({ value, onChange, min = 0, max = 999, required, ariaLabel }) => {
  const btn =
    'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[20px] font-medium leading-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
  const current = value ?? min;
  return (
    <div className="flex items-center gap-2" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        onClick={() => onChange(Math.max(min, current - 1))}
        disabled={current <= min}
        aria-label={`${ariaLabel}: diminuisci`}
        className={`${btn} bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]`}
      >
        −
      </button>
      {/* An input, not a label: typing "14" beats fourteen taps on +, and the
          field it replaced was typeable. Native spinners are hidden — the
          buttons are the affordance. */}
      <input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        required={required}
        aria-label={ariaLabel}
        value={value ?? ''}
        onChange={e => {
          const raw = e.target.value;
          if (raw === '') return onChange(undefined);
          const n = parseInt(raw, 10);
          onChange(Number.isNaN(n) ? undefined : Math.max(min, Math.min(max, n)));
        }}
        className="ds-stepper-input h-11 min-w-0 flex-1 rounded-full bg-[var(--ds-surface-row)] px-3 text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      />
      <button
        type="button"
        onClick={() => onChange(Math.min(max, current + 1))}
        disabled={current >= max}
        aria-label={`${ariaLabel}: aumenta`}
        className={`${btn} bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]`}
      >
        +
      </button>
    </div>
  );
};

/* ── SegmentedControl ─────────────────────────────────────────────────────
   Two or three mutually exclusive options. The active segment is a raised
   white pill on a recessed track — the same treatment as the shift filter in
   the top bar and the Affluenza tabs, so a segmented control means the same
   thing wherever it appears. A solid near-black fill is reserved for actions;
   using it here made a filter look like a button. */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: string; icon?: React.ReactNode }[];
  ariaLabel: string;
}) {
  return (
    <div className="flex gap-0.5 rounded-full bg-[var(--ds-surface-row)] p-1" role="group" aria-label={ariaLabel}>
      {options.map(opt => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={`inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full px-4 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              active
                ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/* ── Buttons ──────────────────────────────────────────────────────────────
   Three weights, one shape. Anything that isn't one of these should probably
   be one of these. */
export const dsButton = {
  primary:
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full text-[15px] font-semibold bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]',
  secondary:
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full text-[15px] font-medium bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]',
  quiet:
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full text-[15px] font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]',
} as const;
