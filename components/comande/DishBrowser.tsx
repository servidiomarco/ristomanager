import React, { useMemo, useRef, useState } from 'react';
import { ChevronDown, Minus, Plus, Search, Trash2 } from 'lucide-react';
import type { Dish } from '../../types';
import { SearchField } from '../ds';
import { euro } from './orderView';
import { DishSearchSheet } from './DishSearchSheet';

// ---------------------------------------------------------------------------
// Il menu, da toccare. Ricerca sempre a portata, categorie in una pista che
// scorre, e i piatti dell'uscita in composizione contati sul piatto stesso —
// così si sa di averlo già messo senza guardare dall'altra parte.
//
// Sul palmare la pillola di ricerca non è un campo ma un bottone: apre lo
// stesso foglio della ricerca globale (velo e trasparenza compresi), dove la
// tastiera non spinge in giro la pagina. Su desktop il campo resta inline —
// c'è spazio, e la tastiera è fisica.
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
  /** Tocco lungo sul piatto: apre le varianti anche dove il tocco semplice
   *  aggiunge al volo — è la via alla variante libera sui piatti senza
   *  varianti di menu. */
  onLongPress: (dish: Dish) => void;
  /** 'grid' affianca la comanda su desktop, 'list' sta sotto il pollice. */
  layout: 'grid' | 'list';
  /** false quando la ricerca vive altrove (la lente nella testata del tavolo):
   *  qui non compare la pillola e le categorie salgono di una riga. */
  showSearch?: boolean;
  /** Preferenza personale dell'operatore, solo per il layout 'list':
   *  'comfortable' è la scheda per piatto (default), 'compact' una scheda
   *  unica a righe da 56px — 6–7 piatti in vista invece di 3, bersagli
   *  comunque a 44px. Catalogo chiuso: due varianti, non un tema libero. */
  density?: 'comfortable' | 'compact';
}

export const DishBrowser: React.FC<DishBrowserProps> = ({
  dishes, categories, category, onCategory, query, onQuery,
  qtyInCourse, markedCategories, hasVariants, onAdd, onRemove, onLongPress, layout,
  showSearch = true, density = 'comfortable',
}) => {
  const q = query.trim().toLowerCase();
  const [searchOpen, setSearchOpen] = useState(false);

  // Tocco lungo con ref (non closure): un re-render a metà pressione — il
  // carrello ne provoca di continuo — non deve lasciare timer orfani che
  // aprono la sheet a dito già sollevato. Il movimento oltre soglia annulla:
  // è uno scroll, non una pressione.
  const lpTimer = useRef<number | null>(null);
  const lpFired = useRef(false);
  const lpStart = useRef<{ x: number; y: number } | null>(null);
  const pressCancel = () => {
    if (lpTimer.current != null) { clearTimeout(lpTimer.current); lpTimer.current = null; }
    lpStart.current = null;
  };
  const press = (d: Dish) => ({
    onPointerDown: (e: React.PointerEvent) => {
      lpFired.current = false;
      lpStart.current = { x: e.clientX, y: e.clientY };
      if (lpTimer.current != null) clearTimeout(lpTimer.current);
      lpTimer.current = window.setTimeout(() => { lpFired.current = true; onLongPress(d); }, 450);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = lpStart.current;
      if (s && (Math.abs(e.clientX - s.x) > 12 || Math.abs(e.clientY - s.y) > 12)) pressCancel();
    },
    onPointerUp: pressCancel,
    onPointerLeave: pressCancel,
    onPointerCancel: pressCancel,
    // Sul touch il tocco lungo evoca il menu contestuale del browser: qui è
    // un gesto nostro.
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    onClick: () => { if (lpFired.current) { lpFired.current = false; return; } onAdd(d); },
  });

  // I controlli di riga sono gli stessi nelle due densità della lista: la
  // preferenza cambia quanto si vede, mai come si tocca.
  const rowControls = (d: Dish) => {
    const qty = qtyInCourse.get(d.id) ?? 0;
    // Con le varianti non si toglie da qui: quale delle due «al sangue»
    // andrebbe via non lo sa nessuno. Si toglie dalla comanda, dove le righe
    // sono distinte.
    const canRemove = qty > 0 && !hasVariants(d.id);
    return (
      <div className="flex flex-shrink-0 items-center gap-2">
        {canRemove && (
          // L'ultimo pezzo si toglie con il cestino, non con il meno: «meno
          // uno» da uno è togliere il piatto, e dirlo con l'icona giusta
          // evita il tocco di troppo.
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
    );
  };

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
    // Sul palmare i blocchi respirano di più: sono decisioni diverse in fila,
    // e a 12px si leggono come una fascia sola di controlli. In vista
    // compatta il respiro lo cede ai piatti — lì è la sagoma della scheda
    // unica a separare le zone.
    <div className={`flex min-h-0 flex-1 flex-col ${layout === 'list' && density !== 'compact' ? 'gap-4' : 'gap-3'}`}>
      {layout === 'list' ? (
        showSearch && (
          <>
            {/* Stessa pelle di SearchField, ma è un bottone: il testo muto e
                la lente dicono «ricerca», il velo fa il resto. */}
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="relative h-11 w-full flex-shrink-0 rounded-full bg-[var(--ds-surface)] pl-11 pr-4 text-left text-[15px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)] transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <Search
                className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]"
                aria-hidden
              />
              Cerca un piatto
            </button>
            <DishSearchSheet
              open={searchOpen}
              dishes={dishes}
              qtyInCourse={qtyInCourse}
              hasVariants={hasVariants}
              onAdd={onAdd}
              onClose={() => setSearchOpen(false)}
            />
          </>
        )
      ) : (
        <SearchField
          value={query}
          onChange={onQuery}
          placeholder="Cerca un piatto"
          ariaLabel="Cerca un piatto"
          className="flex-shrink-0"
        />
      )}
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
                  {...press(d)}
                  className={`relative flex min-h-[76px] select-none flex-col justify-center gap-0.5 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 text-left shadow-[var(--ds-shadow-card)] transition-transform hover:bg-[var(--ds-surface-row)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
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
        ) : density === 'compact' && visible.length > 0 ? (
          // Vista compatta, a scelta dell'operatore (menu ⋮): una scheda sola
          // con righe divise da hairline invece di una scheda per piatto —
          // 6–7 piatti in vista invece di 3, controlli identici, bersagli
          // sempre a 44px. Niente ring sulla riga piena: in una lista divisa
          // lo dicono già il più scuro e la quantità.
          <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
            {visible.map((d, i) => (
              <div
                key={d.id}
                className={`flex min-h-[56px] items-center gap-2 py-1 pl-4 pr-2 ${
                  i > 0 ? 'border-t border-[var(--ds-border)]' : ''
                }`}
              >
                <button
                  type="button"
                  {...press(d)}
                  className="min-w-0 flex-1 select-none self-stretch py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <div className="truncate text-[15px] font-semibold leading-snug text-[var(--ds-text-primary)]">
                    {d.name}
                  </div>
                  <div className="flex items-center gap-1 text-[13px] leading-snug tabular-nums text-[var(--ds-text-muted)]">
                    {euro(Math.round(Number(d.price) * 100))}
                    {hasVariants(d.id) && <ChevronDown size={14} aria-hidden />}
                  </div>
                </button>
                {rowControls(d)}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {visible.length === 0 ? empty : visible.map(d => {
              const qty = qtyInCourse.get(d.id) ?? 0;
              return (
                <div
                  key={d.id}
                  className={`flex min-h-[72px] items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)] ${
                    qty > 0 ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                  }`}
                >
                  <button
                    type="button"
                    {...press(d)}
                    className="min-w-0 flex-1 select-none text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <div className="truncate text-[16px] font-semibold text-[var(--ds-text-primary)]">
                      {d.name}
                    </div>
                    <div className="flex items-center gap-1 text-[15px] tabular-nums text-[var(--ds-text-muted)]">
                      {euro(Math.round(Number(d.price) * 100))}
                      {hasVariants(d.id) && <ChevronDown size={15} aria-hidden />}
                    </div>
                  </button>
                  {rowControls(d)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
