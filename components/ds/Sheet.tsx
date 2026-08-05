import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * A detail panel that enters from the edge instead of the middle.
 *
 * ModalShell is the right frame for something you came to do — a form, a
 * confirmation — where the page behind it stops mattering. A sheet is for
 * something you came to *read about*: one row out of a list, where the list
 * itself is still the context. Anchoring it to the edge keeps that list on
 * screen on a wide monitor, so picking through ten payments in a row does not
 * mean ten full-screen takeovers.
 *
 * Below sm there is no room for that trick, so it becomes a bottom sheet — the
 * gesture a phone already expects, and the same shape the "Altro" and create
 * sheets use elsewhere in the app.
 *
 * Portaled to <body> for the same reason ModalShell is: rendering inside the
 * parent's subtree inherits its stacking context and can paint underneath a
 * sibling.
 */

interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** The headline. Usually the one number or name the row is about. */
  title: React.ReactNode;
  /** Context under the title — who, when, which provider. */
  subtitle?: React.ReactNode;
  /** Status pills and the like, under the subtitle and above the scroll. */
  meta?: React.ReactNode;
  /** Sticky actions at the bottom. The primary action of a sheet is nearly
   *  always one tap, so this stays a simple stack rather than a footer bar. */
  footer?: React.ReactNode;
  /** Ships with no padding of its own — pass it here, as with ModalShell. */
  bodyClassName?: string;
  ariaLabel?: string;
  children: React.ReactNode;
}

export const Sheet: React.FC<SheetProps> = ({
  open,
  onClose,
  title,
  subtitle,
  meta,
  footer,
  bodyClassName = '',
  ariaLabel,
  children,
}) => {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Escape closes, unlike ModalShell where it is opt-in. Nothing here is
  // half-typed work that a stray key could throw away — a sheet shows a record
  // and offers actions on it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div
        className="absolute inset-0 bg-[var(--ds-backdrop)]"
        style={{ animation: 'fadeIn 200ms ease-out both' }}
        onClick={onClose}
      />
      {/* Two anchorings in one element: bottom on a phone, right from sm up.
          The animation swaps with them — a panel that slides up on desktop or
          in from the right on a phone both read as the wrong gesture. */}
      <div
        onClick={e => e.stopPropagation()}
        className="ds-sheet absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[min(30rem,100vw)] sm:rounded-none sm:rounded-l-[24px]"
      >
        {/* Grab handle — phone only. It is the affordance that says this panel
            came from the bottom edge and goes back there. */}
        <div className="flex flex-shrink-0 justify-center pt-2.5 sm:hidden" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[var(--ds-border-strong)]" />
        </div>

        <header className="flex flex-shrink-0 items-start justify-between gap-4 px-5 pb-4 pt-4 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <h2 className="text-[24px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
              {title}
            </h2>
            {subtitle && (
              <div className="mt-1 text-[14px] text-[var(--ds-text-muted)]">{subtitle}</div>
            )}
            {meta && <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* Canvas tone, like ModalShell's body: the sections inside are cards,
            and a card is only raised if there is something for it to sit on.
            Ships with no padding of its own — pass it via bodyClassName. */}
        <div className={`min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)] ${bodyClassName}`}>
          {children}
        </div>

        {footer && (
          // pb accounts for the home indicator on a phone; on desktop the extra
          // is harmless and keeps the primary action off the very edge.
          <footer className="flex flex-shrink-0 flex-col gap-2 px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-5">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
};
