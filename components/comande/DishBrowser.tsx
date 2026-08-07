import React, { useMemo } from 'react';
import { ChevronDown, Minus, Plus, Trash2 } from 'lucide-react';
import type { Dish } from '../../types';
import { SearchField } from '../ds';
import { euro } from './orderView';

// ---------------------------------------------------------------------------
// Il menu, da toccare. Ricerca sempre in vista, categorie in una pista che
// scorre, e i piatti dell'uscita in composizione contati sul piatto stesso —
// così si sa di averlo già messo senza guardare dall'altra parte.
// ---------------------------------------------------------------------------

interface DishBrowserProps {
  dishes: Dish[];
  categories: string[];
  category: string | null;
  onCategory: (next: string) => void;
  query: string;
  onQuery: (next: string) => void;
  /** Quanti pezzi di ogni piatto ci sono nell'uscita in composizione. */
  qtyInCourse: Map<number, number>;
  /** Categorie che hanno righe nell'uscita in composizione. Il pallino serve
   *  sul palmare, dove la comanda è dietro un foglio e non a fianco. */
  markedCategories: Set<string>;
  hasVariants: (dishId: number) => boolean;
  onAdd: (dish: Dish) => void;
  onRemove: (dish: Dish) => void;
  /** 'grid' affianca la comanda su desktop, 'list' sta sotto il pollice. */
  layout: 'grid' | 'list';
}

export const DishBrowser: React.FC<DishBrowserProps> = ({
  dishes, categories, category, onCategory, query, onQuery,
  qtyInCourse, markedCategories, hasVariants, onAdd, onRemove, layout,
}) => {
  const q = query.trim().toLowerCase();

  // Cercando si cerca in tutto il menu: se il piatto è fra i primi e la pista
  // è ferma sugli antipasti, una ricerca che non lo trova è una ricerca rotta.
  const visible = useMemo(
    () => dishes.filter(d => (q ? d.name.toLowerCase().includes(q) : d.category === category)),
    [dishes, q, category]
  );

  const chips = (
    // Lo scorrimento orizzontale ritaglia anche in verticale: senza il margine
    // negativo con padding uguale, l'ombra sotto ogni chip esce tagliata di
    // netto e la pista legge come troncata (regola 11, sull'altro asse).
    <div className="-my-1.5 flex flex-shrink-0 gap-2 overflow-x-auto py-1.5 scrollbar-hide">
      {categories.map(c => {
        const active = !q && c === category;
        return (
          <button
            key={c}
            type="button"
            onClick={() => { onQuery(''); onCategory(c); }}
            aria-pressed={active}
            className={`inline-flex h-11 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              active
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {c}
            {layout === 'list' && markedCategories.has(c) && (
              <span
                className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                  active ? 'bg-[var(--ds-action-fg)]' : 'bg-[var(--ds-text-muted)]'
                }`}
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );

  const empty = (
    <p className="col-span-full py-10 text-center text-[14px] text-[var(--ds-text-muted)]">
      {q ? 'Nessun piatto con questo nome.' : 'Nessun piatto in questa categoria.'}
    </p>
  );

  return (
    // Sul palmare i tre blocchi — ricerca, categorie, piatti — respirano di
    // più: sono tre decisioni diverse in fila, e a 12px si leggono come una
    // fascia sola di controlli.
    <div className={`flex min-h-0 flex-1 flex-col ${layout === 'list' ? 'gap-4' : 'gap-3'}`}>
      <SearchField
        value={query}
        onChange={onQuery}
        placeholder="Cerca un piatto"
        ariaLabel="Cerca un piatto"
        className="flex-shrink-0"
      />
      {chips}

      {/* Lo scorrimento verticale ritaglia anche in orizzontale, quindi le
          ombre delle schede uscirebbero tagliate di netto ai due bordi: il
          margine negativo con padding uguale ridà spazio all'elevazione. */}
      <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {layout === 'grid' ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.length === 0 ? empty : visible.map(d => {
              const qty = qtyInCourse.get(d.id) ?? 0;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onAdd(d)}
                  className={`relative flex min-h-[76px] flex-col justify-center gap-0.5 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 text-left shadow-[var(--ds-shadow-card)] transition-transform hover:bg-[var(--ds-surface-row)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    qty > 0 ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                  }`}
                >
                  <span className="truncate pr-8 text-[15px] font-semibold text-[var(--ds-text-primary)]">
                    {d.name}
                  </span>
                  <span className="flex items-center gap-1 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                    {euro(Math.round(Number(d.price) * 100))}
                    {hasVariants(d.id) && <ChevronDown size={15} aria-hidden />}
                  </span>
                  {qty > 0 && (
                    <span className="absolute right-3 top-3 inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-[var(--ds-action-bg)] px-1.5 text-[12px] font-semibold tabular-nums text-[var(--ds-action-fg)]">
                      {qty}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.length === 0 ? empty : visible.map(d => {
              const qty = qtyInCourse.get(d.id) ?? 0;
              // Con le varianti non si toglie da qui: quale delle due «al
              // sangue» andrebbe via non lo sa nessuno. Si toglie dalla
              // comanda, dove le righe sono distinte.
              const canRemove = qty > 0 && !hasVariants(d.id);
              return (
                <div
                  key={d.id}
                  className={`flex min-h-[72px] items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)] ${
                    qty > 0 ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onAdd(d)}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <div className="truncate text-[16px] font-semibold text-[var(--ds-text-primary)]">
                      {d.name}
                    </div>
                    <div className="flex items-center gap-1 text-[15px] tabular-nums text-[var(--ds-text-muted)]">
                      {euro(Math.round(Number(d.price) * 100))}
                      {hasVariants(d.id) && <ChevronDown size={15} aria-hidden />}
                    </div>
                  </button>

                  <div className="flex flex-shrink-0 items-center gap-2">
                    {canRemove && (
                      // L'ultimo pezzo si toglie con il cestino, non con il
                      // meno: «meno uno» da uno è togliere il piatto, e dirlo
                      // con l'icona giusta evita il tocco di troppo.
                      <button
                        type="button"
                        onClick={() => onRemove(d)}
                        aria-label={qty === 1 ? `Togli ${d.name}` : `Uno in meno di ${d.name}`}
                        className={`inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                          qty === 1
                            ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
                            : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                        }`}
                      >
                        {qty === 1 ? <Trash2 size={16} /> : <Minus size={16} />}
                      </button>
                    )}
                    {qty > 0 && (
                      <span className="min-w-[16px] text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                        {qty}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onAdd(d)}
                      aria-label={`Aggiungi ${d.name}`}
                      className={`inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                        qty > 0
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
                      }`}
                    >
                      <Plus size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
