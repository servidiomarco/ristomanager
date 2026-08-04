import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Trash2 } from 'lucide-react';

/* ── Annulla ──────────────────────────────────────────────────────────────
   Ticking an item and deleting one were both immediate and final. Ticking is
   cheap to reverse by hand; deleting was not reversible at all, and this list
   is used one-handed in a supermarket aisle with a trolley in the other.

   The undo is optimistic in the honest direction: the action has already
   happened on the server by the time the toast appears, and Annulla issues
   the compensating call. Nothing is held back waiting for the timer, so
   closing the page mid-countdown loses the undo, not the action. */

const DURATION_MS = 5000;

export type UndoState = {
  id: number;
  message: string;
  kind: 'done' | 'deleted';
  onUndo: () => void | Promise<void>;
};

export const UndoToast: React.FC<{
  state: UndoState | null;
  onDismiss: () => void;
}> = ({ state, onDismiss }) => {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!state) return;
    setBusy(false);
    const t = setTimeout(onDismiss, DURATION_MS);
    return () => clearTimeout(t);
    // Keyed on id so a second action restarts the countdown rather than
    // inheriting the remainder of the first one's.
  }, [state?.id, onDismiss]);

  if (!state) return null;

  const Icon = state.kind === 'deleted' ? Trash2 : Check;

  return createPortal(
    <div
      // Sits above the mobile bottom bar, using the same clearance the scroll
      // regions use, so it never hides the nav or the raised "+".
      className="pointer-events-none fixed inset-x-4 z-[60] flex justify-center sm:inset-x-0"
      style={{ bottom: 'var(--ds-bottom-nav-clear)' }}
      role="status"
      aria-live="polite"
    >
      <div
        className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-full bg-[var(--ds-action-bg)] py-2.5 pl-4 pr-2 shadow-[var(--ds-shadow-raised)]"
        style={{ animation: 'tileIn 200ms ease-out both' }}
      >
        <Icon className="h-4 w-4 flex-shrink-0 text-[var(--ds-action-fg)]" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-action-fg)]">
          {state.message}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try { await state.onUndo(); } finally { onDismiss(); }
          }}
          className="inline-flex h-9 flex-shrink-0 items-center rounded-full px-3 text-[14px] font-semibold text-[var(--ds-pending-solid)] transition-colors hover:bg-white/10 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          Annulla
        </button>
      </div>
    </div>,
    document.body,
  );
};

/** Owns the toast state and hands back a `run` that performs an action and
 *  offers its inverse. */
export const useUndo = () => {
  const [state, setState] = useState<UndoState | null>(null);
  const seq = useRef(0);

  const offer = useCallback((message: string, kind: UndoState['kind'], onUndo: () => void | Promise<void>) => {
    seq.current += 1;
    setState({ id: seq.current, message, kind, onUndo });
  }, []);

  const dismiss = useCallback(() => setState(null), []);

  return { state, offer, dismiss };
};
