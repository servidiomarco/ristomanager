import React, { useMemo, useRef, useState } from 'react';
import { ArrowLeft, Cake, ChefHat, ChevronDown, ChevronRight, CornerDownRight, Minus, Plus, Search, Trash2, Wine } from 'lucide-react';
import type { Dish } from '../../types';
import { SearchField } from '../ds';
import { euro } from './orderView';
import { isBarCourse, isDessertCourse, ordinal } from '../../utils/courses';
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
  /** true se il TAP apre il foglio invece di aggiungere (peso, obbligatori):
   *  esclude il «−» rapido. Default: hasVariants — il comportamento storico,
   *  che la Cassa conserva senza passare la prop. */
  tapOpensSheet?: (dishId: number) => boolean;
  onAdd: (dish: Dish) => void;
  onRemove: (dish: Dish) => void;
  /** L'uscita dove una battuta di questo piatto finisce (forzata o in
   *  composizione): col battuto in corso compare sul piatto come chip. */
  courseOf?: (dish: Dish) => number;
  /** Tocco sul chip dell'uscita: sposta il battuto di quel piatto — apre il
   *  selettore «dove» di OrderPad. Senza handler il chip non compare. */
  onCourseTap?: (dish: Dish) => void;
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
  /** 'pages' è la variante a pagine (stile cassa, preferenza per utente):
   *  con category null si vede la pagina delle categorie a righe grandi,
   *  con una categoria scelta la sua lista piatti col ritorno in testa —
   *  la geografia di chi arriva da Passepartout. Solo per il layout 'list';
   *  'chips' resta la pista orizzontale di sempre. */
  nav?: 'chips' | 'pages';
  /** Ritorno alla pagina delle categorie (nav 'pages'): azzera la categoria. */
  onCategoryBack?: () => void;
  /** Come si presenta la pagina delle categorie (nav 'pages'): lista a righe,
   *  o bottoni in griglia da 3 o 4 per riga. Preferenza personale
   *  dell'operatore (menu ⋮), catalogo chiuso. */
  catView?: 'list' | 'grid3' | 'grid4';
  /** Le spunte «bar» e «dolci» del catalogo: nella vista a bottoni dividono
   *  la pagina in sezioni vere — Cucina, Bar, Dolci — le stesse che decidono
   *  l'uscita forzata. Niente sezioni inventate: se il catalogo non le ha,
   *  la griglia resta una. */
  barCategories?: Set<string>;
  dessertCategories?: Set<string>;
  /** L'uscita in composizione (nav 'pages'): con Bar selezionato le sezioni
   *  Cucina e Dolci si attenuano, con Dolci si attenuano Cucina e Bar — un
   *  invito dell'occhio, non un divieto: le categorie restano toccabili, e
   *  le uscite forzate fanno comunque la cosa giusta. */
  course?: number;
  /** Le combinazioni battute del piatto nell'uscita di battuta, per le
   *  sotto-righe alla Passepartout: compaiono solo quando il contatore
   *  nasconde struttura (due righe, o una con varianti/nota/peso). Ogni
   *  sotto-riga ha il suo stepper e il tap apre il SUO foglio. */
  draftLinesFor?: (dishId: number) => { key: string; qty: number; label: string }[];
  onBumpLine?: (key: string, delta: number) => void;
  onTapLine?: (key: string) => void;
}

export const DishBrowser: React.FC<DishBrowserProps> = ({
  dishes, categories, category, onCategory, query, onQuery,
  qtyInCourse, markedCategories, hasVariants, tapOpensSheet = hasVariants, onAdd, onRemove, courseOf, onCourseTap, onLongPress, layout,
  showSearch = true, density = 'comfortable', nav = 'chips', onCategoryBack, catView = 'list',
  barCategories, dessertCategories, course,
  draftLinesFor, onBumpLine, onTapLine,
}) => {
  // Categoria «fuori uscita»: non della sezione che l'uscita in composizione
  // sta servendo. Solo per Bar e Dolci — le uscite numerate sono di cucina e
  // insieme, quindi lì non si attenua niente.
  const mutedCat = (c: string): boolean =>
    course != null && isBarCourse(course) ? !(barCategories?.has(c) ?? false)
    : course != null && isDessertCourse(course) ? !(dessertCategories?.has(c) ?? false)
    : false;
  const q = query.trim().toLowerCase();
  const [searchOpen, setSearchOpen] = useState(false);

  const courseTag = (n: number): string =>
    isBarCourse(n) ? 'Bar' : isDessertCourse(n) ? 'Dolci' : `${ordinal(n)} uscita`;
  const courseTagShort = (n: number): string =>
    isBarCourse(n) ? 'Bar' : isDessertCourse(n) ? 'Dolci' : ordinal(n);

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
    // Il «−» opera dove il tap aggiunge: sui piatti che aprono il foglio al
    // tap (peso, obbligatori) non si toglie da qui. Fra più righe con varianti
    // diverse decide removeFromCart in OrderPad, o si toglie dalla comanda.
    const canRemove = qty > 0 && !tapOpensSheet(d.id);
    return (
      <div className="flex flex-shrink-0 items-center gap-2">
        {/* Dove sta andando il battuto: compare al primo pezzo, e si tocca
            per spostarlo — «gli antipasti in seconda» senza aprire niente. */}
        {qty > 0 && courseOf && onCourseTap && (
          <button
            type="button"
            onClick={() => onCourseTap(d)}
            aria-label={`Sposta ${d.name} in un'altra uscita`}
            className="inline-flex h-11 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--ds-arriving-tint)] px-3 text-[13px] font-semibold text-[var(--ds-arriving-text)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <CornerDownRight size={14} aria-hidden />
            {courseTag(courseOf(d))}
          </button>
        )}
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

  // La pillola di ricerca del palmare col suo foglio: serve identica alla
  // pista di sempre e alla pagina delle categorie della variante a pagine.
  const searchPill = showSearch && (
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
        tapOpensSheet={tapOpensSheet}
        onAdd={onAdd}
        onClose={() => setSearchOpen(false)}
      />
    </>
  );

  // Le sotto-righe alla Passepartout: le combinazioni del battuto sotto il
  // piatto, ognuna col suo stepper e il tap che apre il SUO foglio. SEMPRE,
  // dal primo pezzo — anche la sola «liscia»: è lei l'ingresso per
  // differenziare («tap → qty 1 + variante → Aggiorna» e la riga si divide),
  // e in cassa il titolare la vede da vent'anni. bumpCart fa già tutto:
  // qty a 0 toglie la riga, il «+» su un pezzo al peso ne aggiunge un altro
  // dello stesso peso.
  const subRows = (d: Dish) => {
    if (!draftLinesFor || !onBumpLine || !onTapLine) return null;
    const lines = draftLinesFor(d.id);
    if (lines.length === 0) return null;
    return lines.map(l => (
      <div key={l.key} className="flex min-h-[52px] items-center gap-2 border-t border-[var(--ds-border)] py-1 pl-5 pr-2">
        <CornerDownRight size={14} className="flex-shrink-0 text-[var(--ds-text-subtle)]" aria-hidden />
        <button
          type="button"
          onClick={() => onTapLine(l.key)}
          className="min-w-0 flex-1 self-stretch py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)]"
        >
          <span className="block truncate text-[13px] font-medium text-[var(--ds-text-secondary)]">{l.label}</span>
        </button>
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => onBumpLine(l.key, -1)}
            aria-label={l.qty === 1 ? `Togli ${l.label}` : `Uno in meno di ${l.label}`}
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {l.qty === 1 ? <Trash2 size={15} /> : <Minus size={15} />}
          </button>
          <span className="min-w-[16px] text-center text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
            {l.qty}
          </span>
          <button
            type="button"
            onClick={() => onBumpLine(l.key, +1)}
            aria-label={`Un altro ${l.label}`}
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Plus size={15} />
          </button>
        </div>
      </div>
    ));
  };

  // La scheda unica a righe divise da hairline: è la vista compatta, ed è
  // anche la pagina piatti della variante a pagine — stessa anatomia,
  // stessi controlli, bersagli a 44px.
  const compactCard = (
    <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
      {visible.map((d, i) => (
        <React.Fragment key={d.id}>
          <div
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
          {subRows(d)}
        </React.Fragment>
      ))}
    </div>
  );

  // ---------------- variante a pagine (stile cassa, solo palmare) ----------
  if (nav === 'pages' && layout === 'list') {
    if (category === null && !q) {
      // La pagina delle categorie. Niente pillola di ricerca: la lente sta
      // nella testata, accanto ai puntini. Tre vesti a scelta dell'operatore:
      // righe in una scheda sola, o bottoni in griglia da 3 o 4 per riga —
      // il pallino dice sempre «qui c'è roba nell'uscita in composizione».
      return (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
            {catView !== 'list' && categories.length > 0 ? (() => {
              // Le sezioni della pagina a bottoni: le spunte «bar» e «dolci»
              // del catalogo — le stesse che forzano l'uscita — dividono la
              // sala dalla cucina. Ordine di servizio: cucina, bar, dolci;
              // dentro ogni sezione resta l'ordine scelto in pagina Menu.
              const groups = [
                { key: 'cucina', items: categories.filter(c => !barCategories?.has(c) && !dessertCategories?.has(c)) },
                { key: 'bar', items: categories.filter(c => barCategories?.has(c) ?? false) },
                { key: 'dolci', items: categories.filter(c => dessertCategories?.has(c) ?? false) },
              ].filter(g => g.items.length > 0);
              // I toni sono categorie, non stati (§3.5): tinte diverse perché
              // le sezioni sono semplicemente diverse fra loro. Stringhe
              // intere: Tailwind estrae i nomi staticamente.
              const chrome: Record<string, { icon: typeof ChefHat; label: string; chip: string }> = {
                cucina: { icon: ChefHat, label: 'Cucina', chip: 'bg-[var(--ds-cat-6-tint)] text-[var(--ds-cat-6-text)]' },
                bar: { icon: Wine, label: 'Bar', chip: 'bg-[var(--ds-cat-2-tint)] text-[var(--ds-cat-2-text)]' },
                dolci: { icon: Cake, label: 'Dolci', chip: 'bg-[var(--ds-cat-4-tint)] text-[var(--ds-cat-4-text)]' },
              };
              // L'ingresso a cascata attraversa le sezioni: un solo indice,
              // stesso passo del monitor cucina (45 ms, tetto a 450).
              let tileNo = 0;
              // `dimSelf` false dentro le sezioni: lì attenua la sezione
              // intera, e un secondo velo sulla tessera farebbe il doppio.
              const catTile = (c: string, dimSelf = true) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => { onQuery(''); onCategory(c); }}
                  style={{ animation: 'tileIn 260ms ease-out both', animationDelay: `${Math.min(tileNo++ * 45, 450)}ms` }}
                  className={`flex min-h-[76px] select-none flex-col items-center justify-center gap-1 rounded-[16px] bg-[var(--ds-surface)] p-2 text-center shadow-[var(--ds-shadow-card)] transition-[transform,opacity] hover:bg-[var(--ds-surface-row)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    dimSelf && mutedCat(c) ? 'opacity-45' : ''
                  }`}
                >
                  <span className={`${catView === 'grid4' ? 'text-[13px]' : 'text-[15px]'} font-semibold leading-tight text-[var(--ds-text-primary)] [overflow-wrap:anywhere]`}>
                    {c}
                  </span>
                  {markedCategories.has(c) && (
                    <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-text-muted)]" aria-hidden />
                  )}
                </button>
              );
              const gridClass = `grid gap-3 ${catView === 'grid4' ? 'grid-cols-4' : 'grid-cols-3'}`;
              // Una sezione sola (catalogo senza spunte bar/dolci): niente
              // intestazione — un titolo su tutto non divide niente.
              if (groups.length <= 1) {
                // map con lambda: l'indice di map non deve finire in dimSelf.
                return <div className={gridClass}>{categories.map(c => catTile(c, true))}</div>;
              }
              return (
                <div className="flex flex-col gap-6">
                  {groups.map(g => {
                    const { icon: Icon, label, chip } = chrome[g.key];
                    // La sezione fuori uscita si attenua intera, testata
                    // compresa: le sue categorie sono tutte dello stesso
                    // mestiere, basta chiederlo alla prima.
                    const secMuted = g.items.length > 0 && mutedCat(g.items[0]);
                    return (
                      <section key={g.key} className={`flex flex-col gap-3 transition-opacity ${secMuted ? 'opacity-45' : ''}`}>
                        {/* Intestazione leggera: cerchietto tinto, parola,
                            filetto che prende il resto della riga. */}
                        <div className="flex items-center gap-2.5">
                          <span className={`flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${chip}`}>
                            <Icon size={14} aria-hidden />
                          </span>
                          <span className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">{label}</span>
                          <span className="h-px min-w-0 flex-1 bg-[var(--ds-border)]" aria-hidden />
                          <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">{g.items.length}</span>
                        </div>
                        <div className={gridClass}>{g.items.map(c => catTile(c, false))}</div>
                      </section>
                    );
                  })}
                </div>
              );
            })() : (
              <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                {categories.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => { onQuery(''); onCategory(c); }}
                    className={`flex min-h-[56px] w-full items-center gap-2 py-1 pl-4 pr-3 text-left transition-[background-color,opacity] hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
                      i > 0 ? 'border-t border-[var(--ds-border)]' : ''
                    } ${mutedCat(c) ? 'opacity-45' : ''}`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      <span className="truncate text-[16px] font-semibold text-[var(--ds-text-primary)]">{c}</span>
                      {markedCategories.has(c) && (
                        <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-text-muted)]" aria-hidden />
                      )}
                    </span>
                    <ChevronRight size={18} className="flex-shrink-0 text-[var(--ds-text-subtle)]" aria-hidden />
                  </button>
                ))}
                {categories.length === 0 && empty}
              </div>
            )}
          </div>
        </div>
      );
    }
    // La pagina di una categoria: ritorno in testa, poi la scheda a righe.
    return (
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <div className="flex flex-shrink-0 items-center gap-2.5">
          {/* Cerchio pieno in accent, come la freccia indietro del tavolo:
              il ritorno è un gesto, non una parola — il titolo accanto dice
              già dove sei. */}
          <button
            type="button"
            onClick={onCategoryBack}
            aria-label="Torna alle categorie"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <ArrowLeft size={20} aria-hidden />
          </button>
          <h2 className="min-w-0 flex-1 truncate text-[17px] font-bold text-[var(--ds-text-primary)]">
            {q ? 'Ricerca' : category}
          </h2>
        </div>
        <div className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
          {visible.length === 0 ? empty : compactCard}
        </div>
      </div>
    );
  }

  return (
    // Sul palmare i blocchi respirano di più: sono decisioni diverse in fila,
    // e a 12px si leggono come una fascia sola di controlli. In vista
    // compatta il respiro lo cede ai piatti — lì è la sagoma della scheda
    // unica a separare le zone.
    <div className={`flex min-h-0 flex-1 flex-col ${layout === 'list' && density !== 'compact' ? 'gap-4' : 'gap-3'}`}>
      {layout === 'list' ? (
        searchPill
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
              // Il chip dell'uscita è un FRATELLO in overlay, non un figlio:
              // un bottone dentro il bottone della scheda non è HTML valido.
              const tappableBadge = qty > 0 && courseOf && onCourseTap;
              return (
                <div key={d.id} className="relative">
                  <button
                    type="button"
                    {...press(d)}
                    className={`flex min-h-[76px] w-full select-none flex-col justify-center gap-0.5 rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 text-left shadow-[var(--ds-shadow-card)] transition-transform hover:bg-[var(--ds-surface-row)] active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                      qty > 0 ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                    }`}
                  >
                    <span className={`truncate text-[15px] font-semibold text-[var(--ds-text-primary)] ${tappableBadge ? 'pr-16' : 'pr-8'}`}>
                      {d.name}
                    </span>
                    <span className="flex items-center gap-1 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                      {euro(Math.round(Number(d.price) * 100))}
                      {hasVariants(d.id) && <ChevronDown size={15} aria-hidden />}
                    </span>
                  </button>
                  {/* Due badge, due mestieri: il conteggio dice «quanti», il
                      badge dell'uscita (icona di destinazione) dice «dove» e
                      si tocca per spostare. */}
                  {qty > 0 && (
                    <span className="absolute right-2.5 top-2.5 flex items-center gap-1.5">
                      {tappableBadge && (
                        <button
                          type="button"
                          onClick={() => onCourseTap!(d)}
                          aria-label={`Sposta ${d.name} in un'altra uscita`}
                          className="inline-flex h-9 items-center gap-1 whitespace-nowrap rounded-full bg-[var(--ds-arriving-tint)] px-2.5 text-[12px] font-semibold text-[var(--ds-arriving-text)] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                        >
                          <CornerDownRight size={13} aria-hidden />
                          {courseTagShort(courseOf!(d))}
                        </button>
                      )}
                      <span className="inline-flex h-6 min-w-[24px] items-center justify-center rounded-full bg-[var(--ds-action-bg)] px-1.5 text-[12px] font-semibold tabular-nums text-[var(--ds-action-fg)]">
                        {qty}
                      </span>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ) : density === 'compact' && visible.length > 0 ? (
          // Vista compatta, a scelta dell'operatore (menu ⋮). Niente ring
          // sulla riga piena: in una lista divisa lo dicono già il più
          // scuro e la quantità.
          compactCard
        ) : (
          <div className="flex flex-col gap-2">
            {visible.length === 0 ? empty : visible.map(d => {
              const qty = qtyInCourse.get(d.id) ?? 0;
              return (
                // Colonna: la prima riga è il piatto di sempre, sotto le
                // eventuali sotto-righe delle combinazioni battute.
                <div
                  key={d.id}
                  className={`flex flex-col rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)] ${
                    qty > 0 ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                  }`}
                >
                  <div className="flex min-h-[48px] items-center gap-3">
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
                  {subRows(d)}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
