import React, { useState } from 'react';
import { AlertTriangle, CheckCircle, Info, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/* ── Toast (§Toast del design system) ─────────────────────────────────────
   Una sola voce per "è appena successo qualcosa", ed è la pillola invertita
   dell'Annulla della Lista della spesa: fill action-bg, testo action-fg,
   icona in testa che dice cosa è successo. L'inversione è ciò che compra
   cinque secondi di attenzione su uno schermo il cui contenuto non è
   cambiato visibilmente — vale per ogni notifica, non solo per quelle con
   un'azione.

   Due forme dello stesso vestito:
   - ToastPill: una riga — icona, messaggio, e in coda l'azione (Annulla,
     Ricarica) in action-accent e/o la chiusura quando il toast persiste.
   - ToastCard: la versione estesa per titolo/dettagli, stesso fill, angoli
     larghi invece del tondo pieno.

   Gli errori persistono finché non vengono chiusi. L'undo corre in avanti:
   l'azione è già committata quando la pillola appare, e il bottone emette
   la chiamata compensativa. Il posizionamento (centrato sopra la bottom
   nav su telefono, in basso a destra da md) vive in .ds-toast-viewport
   dentro index.css. */

export type ToastTone = 'success' | 'error' | 'info';

const TONE_ICON: Record<ToastTone, LucideIcon> = {
  success: CheckCircle,
  error: AlertTriangle,
  info: Info,
};

/** L'ancora fissa. Renderizzata sempre, così la regione aria-live esiste
 *  prima che arrivi il primo annuncio. */
export const ToastViewport: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="ds-toast-viewport" role="region" aria-label="Notifiche" aria-live="polite">
    {children}
  </div>
);

const CloseButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label="Chiudi notifica"
    className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-action-fg)] transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
  >
    <X className="h-4 w-4" aria-hidden />
  </button>
);

const ActionButton: React.FC<{
  label: string;
  onAction: () => void | Promise<void>;
  onDone: () => void;
}> = ({ label, onAction, onDone }) => {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try { await onAction(); } finally { onDone(); }
      }}
      className="inline-flex h-9 flex-shrink-0 items-center rounded-full px-3 text-[14px] font-semibold text-[var(--ds-action-accent)] transition-colors hover:bg-white/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    >
      {label}
    </button>
  );
};

export const ToastPill: React.FC<{
  tone?: ToastTone;
  icon?: LucideIcon;
  message: string;
  action?: { label: string; onClick: () => void | Promise<void> };
  /** Mostrata quando il toast non si auto-dismette (errori). */
  dismissible?: boolean;
  onDismiss: () => void;
}> = ({ tone = 'info', icon, message, action, dismissible, onDismiss }) => {
  const Icon = icon ?? TONE_ICON[tone];
  const trailing = !!action || dismissible;
  return (
    <div
      className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-[var(--ds-action-bg)] py-2.5 pl-4 shadow-[var(--ds-shadow-raised)] ${trailing ? 'pr-2' : 'pr-4'}`}
      style={{ animation: 'tileIn 200ms ease-out both' }}
      role={tone === 'error' ? 'alert' : 'status'}
    >
      <Icon className="h-4 w-4 flex-shrink-0 text-[var(--ds-action-fg)]" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-action-fg)]">{message}</span>
      {action && <ActionButton label={action.label} onAction={action.onClick} onDone={onDismiss} />}
      {dismissible && <CloseButton onClick={onDismiss} />}
    </div>
  );
};

export const ToastCard: React.FC<{
  tone: ToastTone;
  message: string;
  title?: string;
  details?: string[];
  icon?: LucideIcon;
  action?: { label: string; onClick: () => void | Promise<void> };
  dismissible?: boolean;
  onDismiss: () => void;
}> = ({ tone, message, title, details, icon, action, dismissible, onDismiss }) => {
  const Icon = icon ?? TONE_ICON[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className="pointer-events-auto w-full max-w-md rounded-[24px] bg-[var(--ds-action-bg)] py-3 pl-4 pr-3 shadow-[var(--ds-shadow-raised)]"
      style={{ animation: 'tileIn 200ms ease-out both' }}
    >
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-action-fg)]" aria-hidden />
        <div className="min-w-0 flex-1">
          {title && <p className="text-[13px] font-semibold text-[var(--ds-action-fg)]">{title}</p>}
          <p className="text-[14px] text-[var(--ds-action-fg)]">{message}</p>
          {details && details.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {details.map((d, i) => (
                <li key={i} className="text-[13px] leading-snug text-[var(--ds-action-fg)] opacity-70">{d}</li>
              ))}
            </ul>
          )}
          {action && (
            <div className="-ml-3 mt-1">
              <ActionButton label={action.label} onAction={action.onClick} onDone={onDismiss} />
            </div>
          )}
        </div>
        {dismissible && <CloseButton onClick={onDismiss} />}
      </div>
    </div>
  );
};
