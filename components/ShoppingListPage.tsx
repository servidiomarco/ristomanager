import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useShopping } from '../contexts/ShoppingContext';
import { ShoppingItem, ShoppingCategory, ShoppingUnit } from '../services/shoppingApiService';
import { Reservation, BanquetMenu, ReservationStatus } from '../types';
import { printShoppingList, shareShoppingList } from '../utils/printShoppingList';
import { getRomeDatePart } from '../utils/reservationTime';
import { SupplierManagementModal } from './SupplierManagementModal';
import { ShoppingCart, Printer, Trash2, X, ListChecks, Send, Share2 } from 'lucide-react';
import { SkeletonTaskList } from './SkeletonCards';
import {
  EmptyState, SearchField, SectionHeader, useFirstRunHint, useMediaQuery,
} from './ds';
import { AddItemBar } from './spesa/AddItemBar';
import { EditItemSheet } from './spesa/EditItemSheet';
import { ShoppingRow } from './spesa/ShoppingRow';
import { BreadBanner } from './spesa/BreadBanner';
import { SupplierPanel } from './spesa/SupplierPanel';
import { UndoToast, useUndo } from './spesa/UndoToast';
import {
  ALL_CATEGORIES, CATEGORY_ACCENT, CATEGORY_DOT, CATEGORY_LABELS, CATEGORY_TONE,
  byNewest, itemSummary, parseQty,
} from './spesa/shoppingView';

/* ── Lista della spesa ────────────────────────────────────────────────────
   Two jobs wearing one name. On a phone it is used in the aisle, one-handed,
   to tick things off; on a desktop it is a preparation table where the list
   gets built, suppliers get assigned and orders get printed. The layout
   forks on that, not on how much room there happens to be: the supplier
   column is never the point while you are standing in a supermarket.

   Everything reversible is reversible now — ticking and deleting both offer
   an undo, which is what makes swipe safe enough to be the primary gesture. */

interface ShoppingListPageProps {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  autoOpenNewShoppingItem?: boolean;
  onAutoOpenNewShoppingItemHandled?: () => void;
}

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export const ShoppingListPage: React.FC<ShoppingListPageProps> = ({
  reservations,
  banquetMenus,
  autoOpenNewShoppingItem,
  onAutoOpenNewShoppingItemHandled,
}) => {
  const { items, loading, history, suppliers, addItem, updateItem, toggleItem, deleteItem, clearChecked } = useShopping();

  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<ShoppingCategory | 'ALL'>('ALL');
  // Checked items are never hidden behind a tab now — they sink to a
  // collapsible "Preso" section at the foot of the list, the way a notes app
  // handles a ticked line. One list, one scroll, no mode to be in.
  const [presoOpen, setPresoOpen] = useState(false);

  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<ShoppingCategory>('CUCINA');
  const [newItemSupplierId, setNewItemSupplierId] = useState('');
  const [newItemQty, setNewItemQty] = useState('');
  const [newItemUnit, setNewItemUnit] = useState<ShoppingUnit>('pz');
  const [isAdding, setIsAdding] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [editing, setEditing] = useState<ShoppingItem | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);

  const undo = useUndo();
  const swipeHint = useFirstRunHint('ds-swipe-hint-spesa');
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  const todayStr = formatLocalDate(new Date());

  // A supplier that does not serve the chosen category would be saved and then
  // dropped, so it clears when the category moves away from it.
  useEffect(() => {
    if (!newItemSupplierId) return;
    const s = suppliers.find(x => x.id === newItemSupplierId);
    if (!s || !s.categories.includes(newItemCategory)) setNewItemSupplierId('');
  }, [newItemCategory, newItemSupplierId, suppliers]);

  useEffect(() => {
    if (!autoOpenNewShoppingItem) return;
    const t = setTimeout(() => {
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputRef.current?.focus();
      onAutoOpenNewShoppingItemHandled?.();
    }, 120);
    return () => clearTimeout(t);
  }, [autoOpenNewShoppingItem, onAutoOpenNewShoppingItemHandled]);

  const breadEstimate = useMemo(() => {
    const reservationGuests = (reservations || [])
      .filter(r =>
        getRomeDatePart(r.reservation_time) === todayStr &&
        r.reservation_status !== ReservationStatus.CANCELLED &&
        r.reservation_status !== ReservationStatus.DECLINED,
      )
      .reduce((acc, r) => acc + (r.guests || 0), 0);
    const banquetGuests = (banquetMenus || [])
      .filter(m => m.event_date === todayStr)
      .reduce((acc, m) => acc + (m.guests || 0), 0);
    const coperti = reservationGuests + banquetGuests;
    return { coperti, kg: Math.max(1, Math.ceil(coperti / 10)) };
  }, [reservations, banquetMenus, todayStr]);

  const query = search.trim().toLowerCase();

  /* A search runs over the whole list, purchased included. The tab used to
     scope it, which meant looking for something you had already ticked off
     returned nothing and read as "not on the list" — the exact moment you
     were about to buy it twice. */
  const searching = query.length > 0;

  const filteredItems = useMemo(() => items.filter(i => {
    if (categoryFilter !== 'ALL' && i.category !== categoryFilter) return false;
    if (searching && !i.name.toLowerCase().includes(query)) return false;
    return true;
  }), [items, query, searching, categoryFilter]);

  /* Newest first, so the thing you just typed is at the top of its group
     rather than somewhere below the fold — adding three items in a row and
     watching none of them appear is what made the old order feel broken. */
  const grouped = useMemo(() => {
    const map: Record<ShoppingCategory, ShoppingItem[]> = { CUCINA: [], BAR: [], ALTRO: [] };
    filteredItems.filter(i => !i.checked).forEach(i => map[i.category].push(i));
    ALL_CATEGORIES.forEach(c => map[c].sort(byNewest));
    return map;
  }, [filteredItems]);

  const presoItems = useMemo(
    () => filteredItems.filter(i => i.checked).sort(byNewest),
    [filteredItems],
  );

  const todoCount = items.filter(i => !i.checked).length;
  const doneCount = items.filter(i => i.checked).length;
  const openItems = useMemo(() => items.filter(i => !i.checked), [items]);

  const suggestions = useMemo(() => {
    const q = newItemName.trim().toLowerCase();
    if (!q) return [];
    const current = new Set(items.map(i => i.name.toLowerCase()));
    return history.filter(n => n.toLowerCase().includes(q) && !current.has(n.toLowerCase())).slice(0, 5);
  }, [newItemName, history, items]);

  const handleAdd = async (overrideName?: string) => {
    const name = (overrideName ?? newItemName).trim();
    if (!name || isAdding) return;
    try {
      setIsAdding(true);
      const qty = parseQty(newItemQty);
      await addItem({
        name,
        category: newItemCategory,
        supplierId: newItemSupplierId || null,
        quantity: qty,
        unit: qty != null ? newItemUnit : null,
      });
      setNewItemName('');
      setNewItemQty('');
      setShowSuggestions(false);
      inputRef.current?.focus();
    } finally {
      setIsAdding(false);
    }
  };

  /* Both of these fire the real call immediately and then offer its inverse.
     Holding the action back for five seconds would mean a list that disagrees
     with the one in the other hand across the shop. */
  const handleToggle = async (item: ShoppingItem) => {
    await toggleItem(item.id);
    undo.offer(
      `${itemSummary(item)} ${item.checked ? 'da acquistare' : 'presa'}`,
      'done',
      () => toggleItem(item.id),
    );
  };

  const handleDelete = async (item: ShoppingItem) => {
    await deleteItem(item.id);
    setEditing(null);
    undo.offer(`${itemSummary(item)} eliminata`, 'deleted', () => addItem({
      name: item.name,
      category: item.category,
      supplierId: item.supplierId ?? null,
      quantity: item.quantity ?? null,
      unit: item.unit ?? null,
    }));
  };

  const handleSaveEdit = async (patch: {
    name: string; category: ShoppingCategory; supplierId: string | null;
    quantity: number | null; unit: ShoppingUnit | null;
  }) => {
    if (!editing) return;
    try {
      setIsSavingEdit(true);
      await updateItem(editing.id, patch);
      setEditing(null);
    } finally {
      setIsSavingEdit(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const exitSelectionMode = () => { setSelected(new Set()); setSelectionMode(false); };
  const bulkDelete = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    exitSelectionMode();
    await Promise.all(ids.map(id => deleteItem(id)));
  };
  const selectedItems = useMemo(() => items.filter(i => selected.has(i.id)), [items, selected]);

  const printSelected = () => {
    if (selectedItems.length === 0) return;
    const cats = new Set(selectedItems.map(i => i.category));
    const only = cats.size === 1 ? selectedItems[0].category : null;
    printShoppingList(selectedItems, {
      title: 'Selezione',
      eyebrow: only ? `Lista della spesa · ${CATEGORY_LABELS[only]}` : 'Lista della spesa',
      date: todayStr,
      accent: only ? CATEGORY_ACCENT[only] : undefined,
      groupByCategory: cats.size > 1,
    });
  };

  /* Share hands the selection to the OS sheet (or straight to WhatsApp when a
     supplier phone is known) as plain text. Printing needs a printer; this is
     the route that works from the aisle. */
  const shareSelected = async () => {
    if (selectedItems.length === 0) return;
    const cats = new Set(selectedItems.map(i => i.category));
    const only = cats.size === 1 ? selectedItems[0].category : null;
    await shareShoppingList(selectedItems, {
      title: only
        ? `Lista della spesa — ${CATEGORY_LABELS[only]} (selezione)`
        : 'Lista della spesa (selezione)',
      date: todayStr,
      groupByCategory: cats.size > 1,
    });
  };

  const printAll = () => {
    if (openItems.length === 0) return;
    printShoppingList(openItems, {
      title: 'Lista della spesa',
      eyebrow: 'Lista completa',
      date: todayStr,
      groupByCategory: true,
    });
  };

  const printForSupplier = (supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    if (!supplier) return;
    const list = openItems.filter(i => i.supplierId === supplierId);
    if (list.length === 0) return;
    const bits = [supplier.phone, supplier.note].filter(Boolean) as string[];
    printShoppingList(list, {
      title: supplier.name,
      eyebrow: 'Lista della spesa · Fornitore',
      subtitle: bits.join(' · ') || undefined,
      accent: supplier.categories.length === 1 ? CATEGORY_ACCENT[supplier.categories[0]] : undefined,
      date: todayStr,
      groupByCategory: supplier.categories.length > 1,
    });
  };

  const shareForSupplier = async (supplierId: string) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    if (!supplier) return;
    const list = openItems.filter(i => i.supplierId === supplierId);
    if (list.length === 0) return;
    await shareShoppingList(list, {
      title: `Lista della spesa — ${supplier.name}`,
      subtitle: supplier.note || undefined,
      date: todayStr,
      whatsappPhone: supplier.phone || undefined,
      groupByCategory: supplier.categories.length > 1,
    });
  };

  const printNoSupplier = () => {
    const list = openItems.filter(i => !i.supplierId);
    if (list.length === 0) return;
    printShoppingList(list, {
      title: 'Senza fornitore',
      eyebrow: 'Lista della spesa',
      date: todayStr,
      groupByCategory: true,
    });
  };

  const topAction =
    'inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  const categoryChips: { v: ShoppingCategory | 'ALL'; l: string; n: number }[] = [
    { v: 'ALL', l: 'Tutte', n: filteredItems.length },
    ...ALL_CATEGORIES.map(c => ({ v: c, l: CATEGORY_LABELS[c], n: grouped[c].length })),
  ];

  // The first group that actually renders — Seleziona rides on its header, so
  // it sits with the rows it acts on. Only the first: one entry point to the
  // mode is enough, and repeating it on every category would be noise.
  const firstVisibleCategory = ALL_CATEGORIES.find(c => grouped[c].length > 0);

  const list = (
    <div className="space-y-4">
      {ALL_CATEGORIES.map(cat => {
        const catItems = grouped[cat];
        if (catItems.length === 0) return null;
        return (
          <section key={cat}>
            <SectionHeader
              tone={CATEGORY_TONE[cat] === 'pending' ? 'pending' : CATEGORY_TONE[cat] === 'info' ? 'info' : 'muted'}
              meta={`${catItems.length}`}
              action={cat === firstVisibleCategory && items.length > 0 ? (
                // A toggle, not a one-way door: it stays put and lights up
                // rather than vanishing, so the header does not reflow the
                // instant you tap it.
                <button
                  type="button"
                  onClick={() => (selectionMode ? exitSelectionMode() : setSelectionMode(true))}
                  aria-pressed={selectionMode}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    selectionMode
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface)] hover:text-[var(--ds-text-primary)]'
                  }`}
                >
                  <ListChecks className="h-3.5 w-3.5" aria-hidden /> Seleziona
                </button>
              ) : undefined}
            >
              {CATEGORY_LABELS[cat]}
            </SectionHeader>
            {/* Each row is its own card with air around it. Joined into one
                block with hairlines they read as a single dense table, which
                is the wrong shape for something scanned at arm's length with a
                trolley in the other hand. */}
            <div className="space-y-2">
              {catItems.map((item, i) => (
                <ShoppingRow
                  key={item.id}
                  item={item}
                  hint={swipeHint && i === 0 && cat === firstVisibleCategory}
                  selectionMode={selectionMode}
                  selected={selected.has(item.id)}
                  onToggle={() => handleToggle(item)}
                  onEdit={() => setEditing(item)}
                  onDelete={() => handleDelete(item)}
                  onSelect={() => toggleSelect(item.id)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Everything already in the trolley, sunk to the foot of the list and
          collapsed. It is a record, not work — but deleting it outright would
          throw away the only evidence of what was bought today. */}
      {presoItems.length > 0 && (
        <section>
          <SectionHeader
            tone="positive"
            meta={`${presoItems.length}`}
            expanded={presoOpen}
            onToggle={() => setPresoOpen(v => !v)}
            action={presoOpen && !selectionMode ? (
              <span
                role="button"
                tabIndex={0}
                onClick={e => { e.stopPropagation(); clearChecked(); }}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); clearChecked(); } }}
                className="cursor-pointer text-[13px] font-medium text-[var(--ds-critical-text)]"
              >
                Rimuovi tutte
              </span>
            ) : undefined}
          >
            Preso
          </SectionHeader>
          {presoOpen && (
            <div className="space-y-2">
              {presoItems.map(item => (
                <ShoppingRow
                  key={item.id}
                  item={item}
                  selectionMode={selectionMode}
                  selected={selected.has(item.id)}
                  onToggle={() => handleToggle(item)}
                  onEdit={() => setEditing(item)}
                  onDelete={() => handleDelete(item)}
                  onSelect={() => toggleSelect(item.id)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );

  return (
    // Scorrimento della pagina, non del contenitore dell'app: è quello che
    // tiene il contenuto sopra la barra di navigazione flottante del telefono
    // invece di lasciarlo passare dietro e ricomparire sotto.
    <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
            Lista della spesa
          </h1>
          <p className="text-[15px] text-[var(--ds-text-muted)] tabular-nums">
            {searching
              ? `ricerca in ${items.length} prodotti`
              : `${todoCount} da acquistare · ${doneCount} fatti`}
          </p>
        </div>
        {/* Managing suppliers is page-level admin, not list work — it belongs
            with the title. On a desktop the supplier column carries its own
            Gestisci, so this would be the second route to one screen. */}
        {!isDesktop && suppliers.length > 0 && (
          <button
            type="button"
            onClick={() => setSupplierModalOpen(true)}
            className={`flex-shrink-0 ${topAction}`}
          >
            <Send className="h-3.5 w-3.5" aria-hidden /> Fornitori
          </button>
        )}
      </div>

      {/* The bread figure belongs to whoever is doing the shopping, and on a
          phone the supplier column that used to carry it does not exist. */}
      {!isDesktop && <BreadBanner bread={breadEstimate} className="mb-4" />}

      <div className={isDesktop ? 'grid grid-cols-[minmax(0,1fr)_320px] gap-6 items-start' : ''}>
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Cerca prodotto…"
              ariaLabel="Cerca prodotto"
              className="min-w-0 flex-1"
            />
            {/* Icon-only: printing is a one-tap errand and the word was taking
                a third of the row from the field people actually type in. */}
            {!isDesktop && items.length > 0 && (
              <button
                type="button"
                onClick={printAll}
                aria-label="Stampa la lista"
                title="Stampa la lista"
                className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <Printer className="h-4 w-4" />
              </button>
            )}
          </div>

        <div className="flex items-center gap-2">
          <div className="-mx-1 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-1 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {categoryChips.map(c => (
              <button
                key={c.v}
                type="button"
                onClick={() => setCategoryFilter(c.v)}
                aria-pressed={categoryFilter === c.v}
                className={`inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                  categoryFilter === c.v
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {c.v !== 'ALL' && (
                  <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${CATEGORY_DOT[c.v]}`} aria-hidden />
                )}
                {c.l}
                <span className="tabular-nums opacity-70">{c.n}</span>
              </button>
            ))}
          </div>
        </div>

          {(
            <AddItemBar
              name={newItemName}
              onName={setNewItemName}
              qty={newItemQty}
              onQty={setNewItemQty}
              unit={newItemUnit}
              onUnit={setNewItemUnit}
              category={newItemCategory}
              onCategory={setNewItemCategory}
              supplierId={newItemSupplierId}
              onSupplier={setNewItemSupplierId}
              suppliers={suppliers}
              suggestions={suggestions}
              showSuggestions={showSuggestions}
              onShowSuggestions={setShowSuggestions}
              adding={isAdding}
              onAdd={handleAdd}
              inputRef={inputRef}
              disabled={selectionMode}
            />
          )}

          {searching && (
            <p className="text-[14px] text-[var(--ds-text-muted)]">
              {filteredItems.length === 0
                ? 'Nessun risultato in tutta la lista.'
                : `${filteredItems.length} risultat${filteredItems.length === 1 ? 'o' : 'i'} in tutta la lista`}
            </p>
          )}

          {loading && items.length === 0 ? (
            <SkeletonTaskList count={6} />
          ) : filteredItems.length === 0 && !searching ? (
            <EmptyState icon={ShoppingCart}>
              Niente da acquistare. Aggiungi un prodotto qui sopra.
            </EmptyState>
          ) : (
            list
          )}
        </div>

        {isDesktop && (
          <div className="sticky top-6">
            <SupplierPanel
              suppliers={suppliers}
              items={openItems}
              bread={breadEstimate}
              onPrintSupplier={printForSupplier}
              onShareSupplier={shareForSupplier}
              onPrintNoSupplier={printNoSupplier}
              onPrintAll={printAll}
              onManageSuppliers={() => setSupplierModalOpen(true)}
            />
          </div>
        )}
      </div>

      {/* Selection is a mode, so it gets a bar of its own rather than buttons
          that appear and disappear inside the rows. */}
      {selectionMode && (
        <div
          className="fixed inset-x-4 z-40 flex items-center gap-2 rounded-full bg-[var(--ds-action-bg)] py-2 pl-4 pr-2 shadow-[var(--ds-shadow-raised)] lg:inset-x-auto lg:right-8"
          style={{ bottom: 'var(--ds-bottom-nav-clear)' }}
        >
          <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ds-action-fg)]">
            {selected.size === 0 ? 'Tocca i prodotti da selezionare' : `${selected.size} selezionati`}
          </span>
          <button
            type="button"
            onClick={printSelected}
            disabled={selected.size === 0}
            aria-label="Stampa selezione"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--ds-action-fg)] transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <Printer className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={shareSelected}
            disabled={selected.size === 0}
            aria-label="Condividi selezione"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--ds-action-fg)] transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <Share2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={bulkDelete}
            disabled={selected.size === 0}
            aria-label="Elimina selezione"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--ds-critical-fg)] transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <Trash2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={exitSelectionMode}
            aria-label="Esci dalla selezione"
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-[var(--ds-action-fg)] transition-colors hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <EditItemSheet
        item={editing}
        suppliers={suppliers}
        saving={isSavingEdit}
        onSave={handleSaveEdit}
        onDelete={() => editing && handleDelete(editing)}
        onClose={() => setEditing(null)}
      />

      <UndoToast state={undo.state} onDismiss={undo.dismiss} />

      {supplierModalOpen && (
        <SupplierManagementModal
          open={supplierModalOpen}
          onClose={() => setSupplierModalOpen(false)}
        />
      )}
    </div>
    </div>
  );
};

export default ShoppingListPage;
