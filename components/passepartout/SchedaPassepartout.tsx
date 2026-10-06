import React from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { StatusPill } from '../ds';

/* Una scheda della sezione Impostazioni → Passepartout. Stessa anatomia di
   SettingsDisclosure (App.tsx), che le schede vicine usano: icona, titolo,
   riga di spiegazione, freccia. Vive qui perché ogni integrazione con la
   cassa ha la sua scheda, e in più c'è lo stato a destra («Attivo», la
   rotella mentre lavora). Resta un <details>: l'apertura non è stato
   applicativo e non passa per React. */
export const SchedaPassepartout: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  /** Testo della pastiglia verde a destra (es. «Attivo»), se c'è. */
  badge?: string | null;
  busy?: boolean;
  children: React.ReactNode;
}> = ({ icon: Icon, title, subtitle, badge, busy, children }) => (
  <details className="group overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
    <summary className="flex min-h-[64px] cursor-pointer select-none list-none items-center justify-between gap-3 p-3 transition-colors hover:bg-[var(--ds-surface-row)] [&::-webkit-details-marker]:hidden">
      <span className="flex min-w-0 items-center gap-3">
        <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">{title}</span>
          <span className="block text-[13px] leading-snug text-[var(--ds-text-muted)]">{subtitle}</span>
        </span>
      </span>
      <span className="flex flex-shrink-0 items-center gap-2">
        {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
        {badge && <StatusPill tone="positive">{badge}</StatusPill>}
        <span
          className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-transform group-open:rotate-180"
          aria-hidden
        >
          <ChevronDown className="h-4 w-4" />
        </span>
      </span>
    </summary>
    <div className="space-y-5 border-t border-[var(--ds-border)] px-3 pb-4 pt-3 sm:px-4">{children}</div>
  </details>
);

/** L'interruttore delle schede Passepartout: la forma è il gesto
 *  (rounded-full ammesso per binario e pomello, design system §radii). */
export const InterruttorePassepartout: React.FC<{
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}> = ({ checked, label, disabled, onToggle }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={onToggle}
    className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${
      checked ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
    }`}
  >
    <span
      aria-hidden="true"
      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${
        checked ? 'translate-x-5' : 'translate-x-0.5'
      } translate-y-0.5`}
    />
  </button>
);
