import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';
import type { Dish } from '../../types';
import { euro } from './orderView';

// ---------------------------------------------------------------------------
// La ricerca piatti del palmare, nella stessa forma della ricerca globale
// (CommandPalette) sul velo: nessun foglio pieno, solo la pillola che
// galleggia e, sotto, il pannello dei risultati quando c'è qualcosa da
// mostrare. Il velo è trasparente apposta: dietro si continua a vedere la
// comanda, e il contatore che sale sul risultato toccato è la conferma.
// La ricerca resta aperta a ogni aggiunta, così «due bruschette e una
// burrata» è una ricerca sola. Si chiude da sola solo sui piatti con
// varianti, perché la sheet delle varianti (z-50) vive sotto questo velo
// (z-100).
// ---------------------------------------------------------------------------

interface DishSearchSheetProps {
  open: boolean;
  dishes: Dish[];
  /** Quanti pezzi di ogni piatto ci sono nell'uscita in composizione: il
   *  contatore sul risultato è la conferma che il tocco ha aggiunto. */
  qtyInCourse: Map<number, number>;
  hasVariants: (dishId: number) => boolean;
  onAdd: (dish: Dish) => void;
  onClose: () => void;
}

const MAX_HITS = 30;

export const DishSearchSheet: React.FC<DishSearchSheetProps> = ({
  open, dishes, qtyInCourse, hasVariants, onAdd, onClose,
}) => {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [open]);

  const q = query.trim().toLowerCase();
  const hits = useMemo(
    () => (q ? dishes.filter(d => d.name.toLowerCase().includes(q)).slice(0, MAX_HITS) : []),
    [q, dishes]
  );

  if (!open) return null;

  const showEmpty = q.length > 0 && hits.length === 0;
  const showResultsPanel = hits.length > 0 || showEmpty;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center px-4 pb-6 pt-[max(4rem,env(safe-area-inset-top))] sm:pt-[10vh]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Cerca un piatto"
    >
      <div className="absolute inset-0 bg-[var(--ds-backdrop)]" style={{ animation: 'fadeIn 200ms ease-out both' }} />

      {/* Solo pillola e risultati sul velo, come la palette da sm in su:
          niente foglio pieno, la comanda dietro resta leggibile. */}
      <div
        className="ds-veil-panel relative flex max-h-full w-full max-w-2xl flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Stessa pillola della palette: `text-[16px]` sul telefono evita lo
            zoom di iOS Safari al focus. */}
        <div className="relative flex-shrink-0">
          <Search
            className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
            aria-hidden
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } }}
            placeholder="Cerca un piatto…"
            className="h-12 w-full rounded-full bg-[var(--ds-surface)] pl-11 pr-11 text-[16px] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-raised)] outline-none placeholder:text-[var(--ds-text-muted)] focus-visible:outline-none sm:text-[15px]"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Svuota ricerca"
              className="absolute right-3 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {showResultsPanel && (
          <div className="mt-2 min-h-0 flex-shrink overflow-y-auto rounded-[20px] bg-[var(--ds-surface)] py-1 shadow-[var(--ds-shadow-raised)] sm:max-h-[min(60vh,30rem)]">
            {showEmpty && (
              <div className="px-6 py-12 text-center text-[14px] text-[var(--ds-text-muted)] sm:py-10 sm:text-[13px]">
                Nessun piatto per <span className="font-medium text-[var(--ds-text-primary)]">"{query.trim()}"</span>.
              </div>
            )}

            {hits.map(d => {
              const qty = qtyInCourse.get(d.id) ?? 0;
              const variants = hasVariants(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => { onAdd(d); if (variants) onClose(); }}
                  className="mx-3 flex min-h-[52px] w-[calc(100%-1.5rem)] items-center gap-3 rounded-[14px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                      {d.name}
                    </div>
                    <div className="flex items-center gap-1 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                      {euro(Math.round(Number(d.price) * 100))}
                      {variants && <ChevronDown size={14} aria-hidden />}
                    </div>
                  </div>
                  {qty > 0 && (
                    <span className="inline-flex h-6 min-w-[24px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] px-1.5 text-[12px] font-semibold tabular-nums text-[var(--ds-action-fg)]">
                      {qty}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
