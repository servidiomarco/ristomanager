import React from 'react';
import { Loader2 } from 'lucide-react';
import { StatusPill } from '../ds';
import { SettingsSummary, settingsCardClass } from '../SettingsCard';

/* Una scheda della sezione Impostazioni → Passepartout: la card di
   Impostazioni (components/SettingsCard.tsx) con lo stato a destra — la
   pastiglia «Attivo», la rotella mentre lavora. Quando è attiva anche
   l'icona prende la tinta verde, come le card vicine con l'interruttore.
   Resta un <details>: l'apertura non è stato applicativo e non passa per
   React. */
export const SchedaPassepartout: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  /** Testo della pastiglia verde a destra (es. «Attivo»), se c'è. */
  badge?: string | null;
  busy?: boolean;
  children: React.ReactNode;
}> = ({ icon, title, subtitle, badge, busy, children }) => (
  <details className={settingsCardClass}>
    <SettingsSummary
      icon={icon}
      tone={badge ? 'positive' : 'neutral'}
      title={title}
      description={subtitle}
      trailing={(busy || badge) ? (
        <>
          {busy && <Loader2 className="h-4 w-4 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
          {badge && <StatusPill tone="positive">{badge}</StatusPill>}
        </>
      ) : undefined}
    />
    <div className="space-y-5 border-t border-[var(--ds-border)] px-4 pb-4 pt-3">{children}</div>
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
