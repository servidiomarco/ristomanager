import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/**
 * The frame every modal in the app should share: backdrop, panel, header,
 * scrollable body, footer.
 *
 * Portaled to <body> on purpose. Most existing modals render inside their
 * parent's subtree, which means they inherit its stacking context and can end
 * up painting underneath a sibling — see the note on the confirmation modal in
 * ReservationList. Rendering at the document root removes that whole class of
 * bug rather than fighting it with z-index.
 */

export type ModalSize = 'sm' | 'md' | 'lg' | 'fluid';

const SIZE: Record<ModalSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-2xl',
  lg: 'sm:max-w-5xl',
  // Fills big monitors — where the floor map benefits most — without running
  // edge to edge on an ultrawide.
  fluid: 'sm:w-[92vw] sm:max-w-[1440px]',
};

interface ModalShellProps {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  /** Optional line under the title — context, not instruction. */
  subtitle?: React.ReactNode;
  /** Chrome that sits between the header and the scrolling body — a stepper, a
   *  filter row, a tab bar. Pinned, so it stays put while the body scrolls and
   *  does not shift as steps change length. Content belongs in `children`. */
  subheader?: React.ReactNode;
  /** Rendered in the sticky footer. Omit for a modal with no actions. */
  footer?: React.ReactNode;
  /** Pulled to the left of the footer, opposite the actions. */
  footerStart?: React.ReactNode;
  /** How the footer behaves below sm. 'stack' (the default) drops the two
   *  groups onto their own full-width rows — right for a modal whose actions
   *  are labelled buttons, where a phone wants them thumb-wide.
   *
   *  'row' keeps everything on one line at every width. For a footer built
   *  around a single primary action flanked by icon-only controls — a stepped
   *  form's back and forward arrows — where stacking turns three related
   *  controls into three separate rows and buries the one that matters. */
  footerLayout?: 'stack' | 'row';
  size?: ModalSize;
  /** Escape-to-close. Off by default: on a long form it can discard work, so
   *  each modal opts in deliberately. */
  closeOnEscape?: boolean;
  /** Pin the panel to a constant height instead of letting it size to its
   *  content. For anything whose body changes length in place — a wizard's
   *  steps, a list that filters down — where a panel that resizes under the
   *  cursor moves the footer buttons out from under the thumb between clicks. */
  fixedHeight?: boolean;
  /** The body sits on the canvas tone so cards inside it read as raised, and
   *  it ships with NO padding of its own — pass it here. Forgetting leaves the
   *  content flush against the panel edge, which is what it looks like when a
   *  modal "isn't breathing". Compose the body from FormCards rather than bare
   *  fields: the canvas tone is only worth having if something is raised on it. */
  bodyClassName?: string;
  /** Merged onto the backdrop. For the rare modal that opens over another one
   *  and needs to say so explicitly rather than rely on paint order. */
  className?: string;
  children: React.ReactNode;
}

export const ModalShell: React.FC<ModalShellProps> = ({
  open,
  onClose,
  title,
  subtitle,
  subheader,
  footer,
  footerStart,
  footerLayout = 'stack',
  size = 'md',
  closeOnEscape = false,
  fixedHeight = false,
  bodyClassName = '',
  className = '',
  children,
}) => {
  // Lock the page behind the modal so a scroll gesture over the backdrop
  // doesn't move the list underneath.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  useEffect(() => {
    if (!open || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-[var(--ds-backdrop)] p-0 sm:p-4 ${className}`}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={e => e.stopPropagation()}
        // Full-height on mobile either way — a phone sheet already fills the
        // screen, so only the desktop panel has a choice to make here.
        className={`flex w-full flex-col overflow-hidden bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] h-full rounded-none sm:max-h-[92vh] sm:rounded-[24px] ${fixedHeight ? 'sm:h-[86vh]' : 'sm:h-auto'} ${SIZE[size]}`}
      >
        <header className="flex flex-shrink-0 items-start justify-between gap-4 px-5 py-5 sm:px-6 sm:py-6">
          <div className="min-w-0">
            <h2 className="truncate text-[18px] sm:text-[20px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
              {title}
            </h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-[14px] text-[var(--ds-text-muted)]">{subtitle}</p>
            )}
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

        {subheader && (
          // Carries the canvas tone so it reads as the top of the content area
          // rather than a second header, but sits outside the scroll container
          // so it cannot drift.
          <div className="flex-shrink-0 bg-[var(--ds-canvas)] px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
            {subheader}
          </div>
        )}

        <div className={`min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)] ${bodyClassName}`}>
          {children}
        </div>

        {(footer || footerStart) && (
          <footer
            className={`flex flex-shrink-0 gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:py-5 ${
              footerLayout === 'row'
                ? 'flex-row items-center justify-between'
                : 'flex-col items-stretch'
            }`}
          >
            <div
              className={`text-[14px] text-[var(--ds-text-muted)] ${
                footerLayout === 'row' ? 'flex-shrink-0' : 'min-w-0'
              }`}
            >
              {footerStart}
            </div>
            {/* flex-wrap in row mode so a footer that also carries a warning
                does not force the primary action off the edge on a phone —
                the notice takes its own line and the buttons keep theirs. */}
            <div
              className={`flex gap-2 sm:flex-row sm:items-center ${
                footerLayout === 'row'
                  ? 'min-w-0 flex-1 flex-row flex-wrap items-center justify-end'
                  : 'flex-col items-stretch'
              }`}
            >
              {footer}
            </div>
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
};
