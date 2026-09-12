import React, { useState } from 'react';
import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ── Toast (§Toast del design system) ─────────────────────────────────────
   Una sola voce per "è appena successo qualcosa". Due forme:

   - ToastPill: il toast che porta un'azione singola (Annulla, Ricarica) è
     una pillola solida, non una card — un bottone primario con una frase
     attaccata. L'inversione compra i cinque secondi di attenzione su uno
     schermo il cui contenuto non è cambiato visibilmente.
   - ToastCard: tutto il resto. Surface, hairline nella tint-border della
     famiglia, icona in testa. Gli errori persistono finché non vengono
     chiusi; per questo ogni card porta la chiusura.

   L'undo corre in avanti: l'azione è già committata quando la pillola
   appare, e il bottone emette la chiamata compensativa. Il posizionamento
   (centrato sopra la bottom nav su telefono, in basso a destra da md) vive
   in .ds-toast-viewport dentro index.css. */

export type ToastTone = 'success' | 'error' | 'info';

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  success: CheckCircle,
  error: AlertTriangle,
  info: Info,
};

const TONE_TEXT: Record<ToastTone, string> = {
  success: 'text-[var(--ds-seated-text)]',
  error: 'text-[var(--ds-critical-text)]',
  info: 'text-[var(--ds-text-primary)]',
};

const TONE_BORDER: Record<ToastTone, string> = {
  success: 'border-[var(--ds-seated-tint-border)]',
  error: 'border-[var(--ds-critical-tint-border)]',
  info: 'border-[var(--ds-border)]',
};

/** L'ancora fissa. Renderizzata sempre, così la regione aria-live esiste
 *  prima che arrivi il primo annuncio. */
export const ToastViewport: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ds-toast-viewport" role="region" aria-label="Notifiche" aria-live="polite">
    {children}
  </div>
);

export const ToastPill: React.FC<{
  icon?: LucideIcon;
  tone?: ToastTone;
  message: string;
  actionLabel: string;
  onAction: () => void | Promise<void>;
  /** Chiamata a fine azione (o per chiudere): rimuove il toast. */
  onDismiss: () => void;
}> = ({ icon, tone = 'success', message, actionLabel, onAction, onDismiss }) => {
  const [busy, setBusy] = useState(false);
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <div
      className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-[var(--ds-action-bg)] py-2.5 pl-4 pr-2 shadow-[var(--ds-shadow-raised)]"
      style={{ animation: 'tileIn 200ms ease-out both' }}
      role="status"
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-[var(--ds-action-fg)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-action-fg)]">{message}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try { await onAction(); } finally { onDismiss(); }
        }}
        className="inline-flex h-9 flex-shrink-0 items-center rounded-full px-3 text-[14px] font-semibold text-[var(--ds-action-accent)] transition-colors hover:bg-white/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        {actionLabel}
      </button>
    </div>
  );
};

export const ToastCard: React.FC<{
  tone: ToastTone;
  message: string;
  title?: string;
  details?: string[];
  icon?: LucideIcon;
  /** Un'azione su un toast ricco (titolo/dettagli). Quella singola su un
   *  messaggio secco spetta alla pillola, non a questa card. */
  action?: { label: string; onClick: () => void | Promise<void> };
  onDismiss: () => void;
}> = ({ tone, message, title, details, icon, action, onDismiss }) => {
  const Icon = icon ?? TONE_ICON[tone];
  const hasDetails = !!(title || (details && details.length > 0));
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`pointer-events-auto w-full max-w-md rounded-[16px] border bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] ${TONE_BORDER[tone]} ${
        hasDetails ? 'p-3.5' : 'py-2.5 pl-3.5 pr-2'
      }`}
      style={{ animation: 'tileIn 200ms ease-out both' }}
    >
      <div className={`flex ${hasDetails ? 'items-start' : 'items-center'} gap-2.5`}>
        <Icon className={`h-4 w-4 flex-shrink-0 ${TONE_TEXT[tone]} ${hasDetails ? 'mt-0.5' : ''}`} aria-hidden />
        <div className="min-w-0 flex-1">
          {title && <p className="text-[13px] font-semibold text-[var(--ds-text-primary)]">{title}</p>}
          <p className="text-[14px] text-[var(--ds-text-primary)]">{message}</p>
          {details && details.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {details.map((d, i) => (
                <li key={i} className="text-[13px] leading-snug text-[var(--ds-text-muted)]">{d}</li>
              ))}
            </ul>
          )}
          {action && (
            <button
              type="button"
              onClick={async () => {
                try { await action.onClick(); } finally { onDismiss(); }
              }}
              className="mt-2 inline-flex h-9 items-center rounded-full bg-[var(--ds-action-bg)] px-3 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Chiudi notifica"
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
};
