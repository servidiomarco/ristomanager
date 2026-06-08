import React, { useMemo, useRef, useState, useEffect } from 'react';
import { useShopping } from '../contexts/ShoppingContext';
import { ShoppingItem, ShoppingCategory, ShoppingUnit, SHOPPING_UNITS } from '../services/shoppingApiService';
import { Reservation, BanquetMenu, ReservationStatus } from '../types';
import { printShoppingList, shareShoppingList } from '../utils/printShoppingList';
import { SupplierManagementModal } from './SupplierManagementModal';
import {
  ShoppingCart, ChefHat, Coffee, Package, Plus, Check, Trash2, Edit2,
  Loader2, Clock, X, Search, Printer, Share2, ChevronDown, Wheat,
  CheckCircle2, Circle, Truck, Settings2, ListChecks,
} from 'lucide-react';

interface ShoppingListPageProps {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  autoOpenNewShoppingItem?: boolean;
  onAutoOpenNewShoppingItemHandled?: () => void;
}

const SHOPPING_CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  CUCINA: 'Cucina',
  BAR: 'Bar',
  ALTRO: 'Altro',
};

const SHOPPING_CATEGORY_ICONS: Record<ShoppingCategory, React.ReactNode> = {
  CUCINA: <ChefHat className="h-4 w-4" />,
  BAR: <Coffee className="h-4 w-4" />,
  ALTRO: <Package className="h-4 w-4" />,
};

const SHOPPING_CATEGORY_COLORS: Record<ShoppingCategory, string> = {
  CUCINA: 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-500/30',
  BAR: 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30',
  ALTRO: 'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-500/30',
};

const CATEGORY_ACCENT: Record<ShoppingCategory, string> = {
  CUCINA: '#c2410c',
  BAR: '#b45309',
  ALTRO: '#475569',
};

const ALL_CATEGORIES: ShoppingCategory[] = ['CUCINA', 'BAR', 'ALTRO'];

// Sentinel filter values for the supplier chip row
const NO_SUPPLIER = '__NONE__';
type SupplierFilter = 'ALL' | string;

interface MenuRowProps {
  label: string;
  count: number;
  hint?: string;
  icon?: React.ReactNode;
  onShare: () => void;
  onPrint: () => void;
}

const MenuRow: React.FC<MenuRowProps> = ({ label, count, hint, icon, onShare, onPrint }) => (
  <div className="flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-surface-hover)] transition-colors">
    {icon}
    <div className="flex-1 min-w-0">
      <p className="text-sm text-[var(--color-fg)] truncate">{label}</p>
      {hint && <p className="text-[11px] text-[var(--color-fg-subtle)] tabular truncate">{hint}</p>}
    </div>
    <span className="tabular text-[11px] text-[var(--color-fg-subtle)] flex-shrink-0">{count}</span>
    <button
      type="button"
      onClick={onShare}
      className="p-1 rounded text-[var(--color-fg-subtle)] hover:text-emerald-600 hover:bg-[var(--color-surface)] transition-colors flex-shrink-0"
      title="Condividi"
    >
      <Share2 className="h-3.5 w-3.5" />
    </button>
    <button
      type="button"
      onClick={onPrint}
      className="p-1 rounded text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface)] transition-colors flex-shrink-0"
      title="Stampa"
    >
      <Printer className="h-3.5 w-3.5" />
    </button>
  </div>
);

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Parse a localized number string ("1,5" or "1.5") into a positive float, or null when empty/invalid.
const parseQty = (text: string): number | null => {
  const t = text.trim().replace(',', '.');
  if (!t) return null;
  const n = parseFloat(t);
  return isFinite(n) && n > 0 ? n : null;
};

// Italian-style formatter: 1.5 → "1,5 kg", 2 → "2 pz".
const formatQty = (q?: number | null, u?: string | null): string => {
  if (q == null || q <= 0 || !u) return '';
  const s = q.toString().replace('.', ',');
  return `${s} ${u}`;
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
  const [supplierFilter, setSupplierFilter] = useState<SupplierFilter>('ALL');
  const [statusTab, setStatusTab] = useState<'TODO' | 'DONE'>('TODO');

  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<ShoppingCategory>('CUCINA');
  const [newItemSupplierId, setNewItemSupplierId] = useState<string | ''>('');
  const [newItemQty, setNewItemQty] = useState('');
  const [newItemUnit, setNewItemUnit] = useState<ShoppingUnit>('pz');
  const [isAdding, setIsAdding] = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editCategory, setEditCategory] = useState<ShoppingCategory>('CUCINA');
  const [editSupplierId, setEditSupplierId] = useState<string | ''>('');
  const [editQty, setEditQty] = useState('');
  const [editUnit, setEditUnit] = useState<ShoppingUnit>('pz');
  const [isSavingEdit, setIsSavingEdit] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectionMode, setSelectionMode] = useState(false);

  // Supplier UI state
  const [supplierModalOpen, setSupplierModalOpen] = useState(false);
  const [supplierModalCategory, setSupplierModalCategory] = useState<ShoppingCategory | undefined>(undefined);
  const [openMenuCategory, setOpenMenuCategory] = useState<ShoppingCategory | null>(null);
  const [supplierMenuOpen, setSupplierMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the per-category / global supplier dropdowns on outside click
  useEffect(() => {
    if (!openMenuCategory && !supplierMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuCategory(null);
        setSupplierMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openMenuCategory, supplierMenuOpen]);

  // Suppliers grouped by category for fast lookup (a supplier serving N categories appears in N buckets)
  const suppliersByCategory = useMemo(() => {
    const map: Record<ShoppingCategory, typeof suppliers> = { CUCINA: [], BAR: [], ALTRO: [] };
    suppliers.forEach(s => s.categories.forEach(c => map[c].push(s)));
    Object.values(map).forEach(list => list.sort((a, b) => a.name.localeCompare(b.name, 'it')));
    return map;
  }, [suppliers]);

  // All suppliers, sorted by name (used by the global "Fornitori" dropdown)
  const allSuppliersSorted = useMemo(
    () => [...suppliers].sort((a, b) => a.name.localeCompare(b.name, 'it')),
    [suppliers],
  );

  // When the user picks a category for "new item", reset supplier if it no longer matches
  useEffect(() => {
    if (!newItemSupplierId) return;
    const s = suppliers.find(x => x.id === newItemSupplierId);
    if (!s || !s.categories.includes(newItemCategory)) setNewItemSupplierId('');
  }, [newItemCategory, newItemSupplierId, suppliers]);

  // Same for the edit form
  useEffect(() => {
    if (!editSupplierId) return;
    const s = suppliers.find(x => x.id === editSupplierId);
    if (!s || !s.categories.includes(editCategory)) setEditSupplierId('');
  }, [editCategory, editSupplierId, suppliers]);

  // Reset supplier filter if it doesn't match the current category filter
  useEffect(() => {
    if (supplierFilter === 'ALL' || supplierFilter === NO_SUPPLIER) return;
    if (categoryFilter === 'ALL') return;
    const s = suppliers.find(x => x.id === supplierFilter);
    if (!s || !s.categories.includes(categoryFilter)) setSupplierFilter('ALL');
  }, [categoryFilter, supplierFilter, suppliers]);

  useEffect(() => {
    if (!autoOpenNewShoppingItem) return;
    const t = setTimeout(() => {
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inputRef.current?.focus();
      onAutoOpenNewShoppingItemHandled?.();
    }, 120);
    return () => clearTimeout(t);
  }, [autoOpenNewShoppingItem, onAutoOpenNewShoppingItemHandled]);

  const todayStr = formatLocalDate(new Date());

  const breadEstimate = useMemo(() => {
    const reservationGuests = (reservations || [])
      .filter(r =>
        r.reservation_time.startsWith(todayStr) &&
        r.reservation_status !== ReservationStatus.CANCELLED,
      )
      .reduce((acc, r) => acc + (r.guests || 0), 0);
    const banquetGuests = (banquetMenus || [])
      .filter(m => m.event_date === todayStr)
      .reduce((acc, m) => acc + (m.guests || 0), 0);
    const coperti = reservationGuests + banquetGuests;
    return { coperti, kg: Math.max(1, Math.ceil(coperti / 10)) };
  }, [reservations, banquetMenus, todayStr]);

  const filteredItems = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter(i => {
      if (statusTab === 'TODO' && i.checked) return false;
      if (statusTab === 'DONE' && !i.checked) return false;
      if (categoryFilter !== 'ALL' && i.category !== categoryFilter) return false;
      if (supplierFilter !== 'ALL') {
        if (supplierFilter === NO_SUPPLIER) {
          if (i.supplierId) return false;
        } else if (i.supplierId !== supplierFilter) {
          return false;
        }
      }
      if (query && !i.name.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [items, search, categoryFilter, supplierFilter, statusTab]);

  const grouped = useMemo(() => {
    const map: Record<ShoppingCategory, ShoppingItem[]> = { CUCINA: [], BAR: [], ALTRO: [] };
    filteredItems.forEach(i => map[i.category].push(i));
    return map;
  }, [filteredItems]);

  const totalCount = items.length;
  const checkedCount = items.filter(i => i.checked).length;

  const suggestions = useMemo(() => {
    const query = newItemName.trim().toLowerCase();
    if (!query) return [];
    const currentNames = new Set(items.map(i => i.name.toLowerCase()));
    return history
      .filter(name => name.toLowerCase().includes(query) && !currentNames.has(name.toLowerCase()))
      .slice(0, 5);
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

  const startEdit = (item: ShoppingItem) => {
    setEditingId(item.id);
    setEditName(item.name);
    setEditCategory(item.category);
    setEditSupplierId(item.supplierId || '');
    setEditQty(item.quantity != null && item.quantity > 0 ? String(item.quantity).replace('.', ',') : '');
    setEditUnit(item.unit || 'pz');
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditSupplierId('');
    setEditQty('');
  };
  const saveEdit = async () => {
    if (!editingId || isSavingEdit) return;
    const trimmed = editName.trim();
    if (!trimmed) return;
    try {
      setIsSavingEdit(true);
      const qty = parseQty(editQty);
      await updateItem(editingId, {
        name: trimmed,
        category: editCategory,
        supplierId: editSupplierId || null,
        quantity: qty,
        unit: qty != null ? editUnit : null,
      });
      setEditingId(null);
      setEditName('');
      setEditSupplierId('');
      setEditQty('');
    } finally {
      setIsSavingEdit(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const exitSelectionMode = () => {
    setSelected(new Set());
    setSelectionMode(false);
  };
  const enterSelectionMode = () => {
    setSelectionMode(true);
  };
  const bulkDelete = async () => {
    if (selected.size === 0) return;
    const ids = Array.from(selected);
    exitSelectionMode();
    await Promise.all(ids.map(id => deleteItem(id)));
  };

  const selectedItems = useMemo(
    () => items.filter(i => selected.has(i.id)),
    [items, selected],
  );

  const printSelected = () => {
    if (selectedItems.length === 0) return;
    const cats = new Set(selectedItems.map(i => i.category));
    const isSingleCat = cats.size === 1;
    const onlyCat = isSingleCat ? (selectedItems[0].category) : null;
    printShoppingList(selectedItems, {
      title: 'Selezione',
      eyebrow: onlyCat ? `Lista della spesa · ${SHOPPING_CATEGORY_LABELS[onlyCat]}` : 'Lista della spesa',
      date: todayStr,
      accent: onlyCat ? CATEGORY_ACCENT[onlyCat] : undefined,
      groupByCategory: !isSingleCat,
    });
  };

  const shareSelected = async () => {
    if (selectedItems.length === 0) return;
    const cats = new Set(selectedItems.map(i => i.category));
    const isSingleCat = cats.size === 1;
    const onlyCat = isSingleCat ? selectedItems[0].category : null;
    await shareShoppingList(selectedItems, {
      title: onlyCat
        ? `Lista della spesa — ${SHOPPING_CATEGORY_LABELS[onlyCat]} (selezione)`
        : 'Lista della spesa (selezione)',
      date: todayStr,
      groupByCategory: !isSingleCat,
    });
  };

  const printForCategory = (cat: ShoppingCategory) => {
    const list = items.filter(i => i.category === cat && !i.checked);
    if (list.length === 0) return;
    printShoppingList(list, {
      title: SHOPPING_CATEGORY_LABELS[cat],
      eyebrow: `Lista della spesa · ${SHOPPING_CATEGORY_LABELS[cat]}`,
      accent: CATEGORY_ACCENT[cat],
      date: todayStr,
    });
  };

  const shareForCategory = async (cat: ShoppingCategory) => {
    const list = items.filter(i => i.category === cat && !i.checked);
    if (list.length === 0) return;
    await shareShoppingList(list, {
      title: `Lista della spesa — ${SHOPPING_CATEGORY_LABELS[cat]}`,
      date: todayStr,
    });
  };

  // When `scope` is a category, filter items to that category; otherwise include all
  // items linked to the supplier across every category the supplier serves.
  const printForSupplier = (supplierId: string, scope?: ShoppingCategory) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    if (!supplier) return;
    const list = items.filter(
      i => i.supplierId === supplierId && !i.checked && (!scope || i.category === scope),
    );
    if (list.length === 0) return;
    const subtitleBits: string[] = [];
    if (supplier.phone) subtitleBits.push(supplier.phone);
    if (supplier.note) subtitleBits.push(supplier.note);
    const scopeLabel = scope
      ? SHOPPING_CATEGORY_LABELS[scope]
      : supplier.categories.map(c => SHOPPING_CATEGORY_LABELS[c]).join(' + ');
    const accent = scope
      ? CATEGORY_ACCENT[scope]
      : supplier.categories.length === 1
        ? CATEGORY_ACCENT[supplier.categories[0]]
        : undefined;
    printShoppingList(list, {
      title: supplier.name,
      eyebrow: `Lista della spesa · ${scopeLabel} · Fornitore`,
      subtitle: subtitleBits.join(' · ') || undefined,
      accent,
      date: todayStr,
      groupByCategory: !scope && supplier.categories.length > 1,
    });
  };

  const shareForSupplier = async (supplierId: string, scope?: ShoppingCategory) => {
    const supplier = suppliers.find(s => s.id === supplierId);
    if (!supplier) return;
    const list = items.filter(
      i => i.supplierId === supplierId && !i.checked && (!scope || i.category === scope),
    );
    if (list.length === 0) return;
    await shareShoppingList(list, {
      title: `Lista della spesa — ${supplier.name}`,
      subtitle: supplier.note || undefined,
      date: todayStr,
      whatsappPhone: supplier.phone || undefined,
      groupByCategory: !scope && supplier.categories.length > 1,
    });
  };

  const printNoSupplier = (cat: ShoppingCategory) => {
    const list = items.filter(i => i.category === cat && !i.supplierId && !i.checked);
    if (list.length === 0) return;
    printShoppingList(list, {
      title: `${SHOPPING_CATEGORY_LABELS[cat]} — Senza fornitore`,
      eyebrow: `Lista della spesa · ${SHOPPING_CATEGORY_LABELS[cat]}`,
      accent: CATEGORY_ACCENT[cat],
      date: todayStr,
    });
  };

  const shareNoSupplier = async (cat: ShoppingCategory) => {
    const list = items.filter(i => i.category === cat && !i.supplierId && !i.checked);
    if (list.length === 0) return;
    await shareShoppingList(list, {
      title: `Lista della spesa — ${SHOPPING_CATEGORY_LABELS[cat]} (senza fornitore)`,
      date: todayStr,
    });
  };

  const openSupplierModal = (cat?: ShoppingCategory) => {
    setSupplierModalCategory(cat);
    setSupplierModalOpen(true);
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 bg-[var(--color-surface-2)] min-h-full">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h1 className="text-[22px] sm:text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
              Lista della Spesa
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)] mt-1 tabular">
              {checkedCount}/{totalCount} completati
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap relative" ref={menuRef}>
            {ALL_CATEGORIES.map(cat => {
              const catItems = items.filter(i => i.category === cat && !i.checked);
              if (catItems.length === 0) return null;
              const catSuppliers = suppliersByCategory[cat];
              const hasNoSupplierItems = catItems.some(i => !i.supplierId);
              const isOpen = openMenuCategory === cat;
              return (
                <div key={cat}>
                  <button
                    type="button"
                    onClick={() => setOpenMenuCategory(isOpen ? null : cat)}
                    aria-haspopup="menu"
                    aria-expanded={isOpen}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border transition-colors ${
                      isOpen
                        ? SHOPPING_CATEGORY_COLORS[cat]
                        : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                    }`}
                    title={`Stampa o condividi ${SHOPPING_CATEGORY_LABELS[cat]}`}
                  >
                    {SHOPPING_CATEGORY_ICONS[cat]}
                    <span className="hidden sm:inline">{SHOPPING_CATEGORY_LABELS[cat]}</span>
                    <ChevronDown className="h-3 w-3" />
                  </button>
                  {isOpen && (
                    <div
                      role="menu"
                      className="absolute left-0 right-auto sm:left-auto sm:right-0 top-full mt-1 z-20 min-w-[260px] max-w-[calc(100vw-2rem)] sm:max-w-[88vw] bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg shadow-[var(--shadow-md)] overflow-hidden"
                    >
                      <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)] border-b border-[var(--color-line)]">
                        {SHOPPING_CATEGORY_LABELS[cat]} · stampa e condivisione
                      </div>
                      <div className="py-1">
                        <MenuRow
                          label="Tutta la categoria"
                          count={catItems.length}
                          onShare={() => { shareForCategory(cat); setOpenMenuCategory(null); }}
                          onPrint={() => { printForCategory(cat); setOpenMenuCategory(null); }}
                        />
                        {catSuppliers.map(s => {
                          const supItems = catItems.filter(i => i.supplierId === s.id);
                          if (supItems.length === 0) return null;
                          return (
                            <MenuRow
                              key={s.id}
                              label={s.name}
                              hint={s.phone || undefined}
                              count={supItems.length}
                              icon={<Truck className="h-3.5 w-3.5 text-[var(--color-fg-subtle)]" />}
                              onShare={() => { shareForSupplier(s.id, cat); setOpenMenuCategory(null); }}
                              onPrint={() => { printForSupplier(s.id, cat); setOpenMenuCategory(null); }}
                            />
                          );
                        })}
                        {hasNoSupplierItems && (
                          <MenuRow
                            label="Senza fornitore"
                            count={catItems.filter(i => !i.supplierId).length}
                            onShare={() => { shareNoSupplier(cat); setOpenMenuCategory(null); }}
                            onPrint={() => { printNoSupplier(cat); setOpenMenuCategory(null); }}
                          />
                        )}
                      </div>
                      <div className="border-t border-[var(--color-line)]">
                        <button
                          type="button"
                          onClick={() => { setOpenMenuCategory(null); openSupplierModal(cat); }}
                          className="w-full text-left px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] inline-flex items-center gap-2"
                        >
                          <Settings2 className="h-3.5 w-3.5" />
                          Gestisci fornitori {SHOPPING_CATEGORY_LABELS[cat]}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <div>
              <button
                type="button"
                onClick={() => { setSupplierMenuOpen(o => !o); setOpenMenuCategory(null); }}
                aria-haspopup="menu"
                aria-expanded={supplierMenuOpen}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border transition-colors ${
                  supplierMenuOpen
                    ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                }`}
                title="Fornitori — stampa, condividi o gestisci"
              >
                <Truck className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Fornitori</span>
                <ChevronDown className="h-3 w-3" />
              </button>
              {supplierMenuOpen && (
                <div
                  role="menu"
                  className="absolute left-0 right-auto sm:left-auto sm:right-0 top-full mt-1 z-20 min-w-[260px] max-w-[calc(100vw-2rem)] sm:max-w-[88vw] bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg shadow-[var(--shadow-md)] overflow-hidden"
                >
                  <div className="px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-fg-subtle)] border-b border-[var(--color-line)]">
                    Per fornitore · stampa e condivisione
                  </div>
                  <div className="py-1 max-h-[60vh] overflow-y-auto">
                    {allSuppliersSorted.length === 0 ? (
                      <p className="px-3 py-2 text-xs text-[var(--color-fg-subtle)]">
                        Nessun fornitore. Aggiungine uno dal pulsante qui sotto.
                      </p>
                    ) : (
                      allSuppliersSorted.map(s => {
                        const supItems = items.filter(i => i.supplierId === s.id && !i.checked);
                        if (supItems.length === 0) return null;
                        const catLabel = s.categories.map(c => SHOPPING_CATEGORY_LABELS[c]).join(' · ');
                        return (
                          <MenuRow
                            key={s.id}
                            label={s.name}
                            hint={catLabel}
                            count={supItems.length}
                            icon={<Truck className="h-3.5 w-3.5 text-[var(--color-fg-subtle)]" />}
                            onShare={() => { shareForSupplier(s.id); setSupplierMenuOpen(false); }}
                            onPrint={() => { printForSupplier(s.id); setSupplierMenuOpen(false); }}
                          />
                        );
                      })
                    )}
                  </div>
                  <div className="border-t border-[var(--color-line)]">
                    <button
                      type="button"
                      onClick={() => { setSupplierMenuOpen(false); openSupplierModal(); }}
                      className="w-full text-left px-3 py-2 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] inline-flex items-center gap-2"
                    >
                      <Settings2 className="h-3.5 w-3.5" />
                      Gestisci fornitori
                    </button>
                  </div>
                </div>
              )}
            </div>
            {!selectionMode && totalCount > 0 && (
              <button
                type="button"
                onClick={enterSelectionMode}
                className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
                title="Seleziona prodotti per stampare o condividere"
              >
                <ListChecks className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Seleziona</span>
              </button>
            )}
            {checkedCount > 0 && (
              <button
                onClick={clearChecked}
                className="text-xs px-2 py-1 rounded text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-[var(--color-surface-hover)] transition-colors"
              >
                Rimuovi completati
              </button>
            )}
          </div>
        </div>

        {/* Bread estimate (today) */}
        <div className="flex items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
          <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/25 text-amber-600 dark:text-amber-300 flex-shrink-0">
            <Wheat className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[var(--color-fg)]">
              Pane oggi{' '}
              {breadEstimate.coperti > 0 ? (
                <span className="tabular font-semibold text-amber-700 dark:text-amber-300">{breadEstimate.kg} kg</span>
              ) : (
                <span className="text-[var(--color-fg-subtle)]">— nessuna prenotazione</span>
              )}
            </p>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              {breadEstimate.coperti > 0
                ? `${breadEstimate.coperti} coperti previsti · 1 kg ogni 10`
                : 'Si aggiorna in base alle prenotazioni del giorno'}
            </p>
          </div>
        </div>

        {/* Filters bar */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-3 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)]" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Cerca prodotto..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg focus:outline-none focus:border-[var(--color-fg)]"
              />
            </div>
            <div className="inline-flex rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-0.5 text-sm self-start">
              {(['TODO', 'DONE'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusTab(tab)}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                    statusTab === tab
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {tab === 'TODO' ? `Da fare (${totalCount - checkedCount})` : `Fatte (${checkedCount})`}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                categoryFilter === 'ALL'
                  ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
              }`}
            >
              Tutte
            </button>
            {ALL_CATEGORIES.map(cat => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1 rounded-full text-xs font-medium border inline-flex items-center gap-1.5 transition-colors ${
                  categoryFilter === cat
                    ? SHOPPING_CATEGORY_COLORS[cat]
                    : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                }`}
              >
                {SHOPPING_CATEGORY_ICONS[cat]}
                {SHOPPING_CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          {/* Supplier filter chips — shown only when a single category is selected */}
          {categoryFilter !== 'ALL' && (suppliersByCategory[categoryFilter].length > 0 || items.some(i => i.category === categoryFilter && !i.supplierId)) && (
            <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-[var(--color-line)]">
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--color-fg-subtle)] uppercase tracking-wide mr-1">
                <Truck className="h-3 w-3" /> Fornitore
              </span>
              <button
                type="button"
                onClick={() => setSupplierFilter('ALL')}
                className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                  supplierFilter === 'ALL'
                    ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                    : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                }`}
              >
                Tutti
              </button>
              {suppliersByCategory[categoryFilter].map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSupplierFilter(s.id)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                    supplierFilter === s.id
                      ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                      : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {s.name}
                </button>
              ))}
              {items.some(i => i.category === categoryFilter && !i.supplierId) && (
                <button
                  type="button"
                  onClick={() => setSupplierFilter(NO_SUPPLIER)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-medium border transition-colors ${
                    supplierFilter === NO_SUPPLIER
                      ? 'bg-[var(--color-fg)] text-[var(--color-surface)] border-[var(--color-fg)]'
                      : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  Senza fornitore
                </button>
              )}
            </div>
          )}
        </div>

        {/* Selection mode toolbar */}
        {selectionMode && (
          <div className="sticky top-2 z-10 flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-fg)] text-[var(--color-surface)] flex-wrap shadow-[var(--shadow-md)]">
            <span className="text-sm font-medium tabular">
              {selected.size === 0 ? 'Tocca i prodotti da selezionare' : `${selected.size} selezionati`}
            </span>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={exitSelectionMode}
                className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface)]/10"
              >
                Annulla
              </button>
              <button
                onClick={shareSelected}
                disabled={selected.size === 0}
                className="text-xs px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-white inline-flex items-center gap-1.5"
                title="Condividi i prodotti selezionati"
              >
                <Share2 className="h-3.5 w-3.5" />
                Condividi
              </button>
              <button
                onClick={printSelected}
                disabled={selected.size === 0}
                className="text-xs px-2 py-1 rounded bg-[var(--color-surface)]/15 hover:bg-[var(--color-surface)]/25 disabled:opacity-40 disabled:cursor-not-allowed text-[var(--color-surface)] inline-flex items-center gap-1.5"
                title="Stampa i prodotti selezionati"
              >
                <Printer className="h-3.5 w-3.5" />
                Stampa
              </button>
              <button
                onClick={bulkDelete}
                disabled={selected.size === 0}
                className="text-xs px-2 py-1 rounded bg-rose-500 hover:bg-rose-600 disabled:opacity-40 disabled:cursor-not-allowed text-white inline-flex items-center gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Elimina
              </button>
            </div>
          </div>
        )}

        {/* Items list */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl divide-y divide-[var(--color-line)]">
          {loading ? (
            <div className="py-12 text-center">
              <Loader2 className="h-6 w-6 text-[var(--color-fg-subtle)] mx-auto mb-2 animate-spin" />
              <p className="text-[var(--color-fg-subtle)] text-sm">Caricamento...</p>
            </div>
          ) : filteredItems.length === 0 ? (
            <div className="py-12 text-center">
              <ShoppingCart className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
              <p className="text-[var(--color-fg-subtle)] text-sm">
                {search.trim() ? 'Nessun risultato' : 'Nessun prodotto'}
              </p>
            </div>
          ) : (
            ALL_CATEGORIES.map(cat => {
              const catItems = grouped[cat];
              if (catItems.length === 0) return null;
              return (
                <div key={cat} className="p-3 sm:p-4 space-y-1.5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-medium border ${SHOPPING_CATEGORY_COLORS[cat]}`}>
                      {SHOPPING_CATEGORY_ICONS[cat]}
                      {SHOPPING_CATEGORY_LABELS[cat]}
                      <span className="tabular opacity-70">({catItems.length})</span>
                    </span>
                  </div>
                  <div className="space-y-0.5">
                    {catItems.map(item => {
                      const meta = `${item.createdByUserName ? item.createdByUserName.split('@')[0] : 'Anonimo'}${
                        item.createdAt
                          ? ` · ${new Date(item.createdAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })} ${new Date(item.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
                          : ''
                      }`;
                      const isEditing = editingId === item.id;
                      const isSelected = selected.has(item.id);
                      if (isEditing) {
                        const editCatSuppliers = suppliersByCategory[editCategory];
                        return (
                          <div key={item.id} className="flex flex-col sm:flex-row sm:items-center gap-2 py-2 px-1">
                            <input
                              type="text"
                              value={editName}
                              onChange={e => setEditName(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveEdit();
                                if (e.key === 'Escape') cancelEdit();
                              }}
                              autoFocus
                              className="flex-1 text-sm bg-[var(--color-surface)] border border-[var(--color-line-strong)] rounded px-2 py-1 focus:outline-none focus:border-[var(--color-fg)]"
                            />
                            <div className="flex items-center gap-2 flex-wrap">
                              <input
                                type="text"
                                inputMode="decimal"
                                value={editQty}
                                onChange={e => setEditQty(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') saveEdit();
                                  if (e.key === 'Escape') cancelEdit();
                                }}
                                placeholder="Qtà"
                                className="w-16 text-xs bg-[var(--color-surface)] border border-[var(--color-line-strong)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--color-fg)] tabular"
                                title="Quantità (opzionale)"
                              />
                              <select
                                value={editUnit}
                                onChange={e => setEditUnit(e.target.value as ShoppingUnit)}
                                className="text-xs bg-[var(--color-surface)] border border-[var(--color-line-strong)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--color-fg)]"
                                title="Unità"
                              >
                                {SHOPPING_UNITS.map(u => (
                                  <option key={u} value={u}>{u}</option>
                                ))}
                              </select>
                              <select
                                value={editCategory}
                                onChange={e => setEditCategory(e.target.value as ShoppingCategory)}
                                className="text-xs bg-[var(--color-surface)] border border-[var(--color-line-strong)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--color-fg)]"
                              >
                                <option value="CUCINA">Cucina</option>
                                <option value="BAR">Bar</option>
                                <option value="ALTRO">Altro</option>
                              </select>
                              <select
                                value={editSupplierId}
                                onChange={e => setEditSupplierId(e.target.value)}
                                disabled={editCatSuppliers.length === 0}
                                className="text-xs bg-[var(--color-surface)] border border-[var(--color-line-strong)] rounded px-1.5 py-1 focus:outline-none focus:border-[var(--color-fg)] disabled:opacity-50"
                                title={editCatSuppliers.length === 0 ? 'Nessun fornitore in questa categoria' : 'Fornitore'}
                              >
                                <option value="">Senza fornitore</option>
                                {editCatSuppliers.map(s => (
                                  <option key={s.id} value={s.id}>{s.name}</option>
                                ))}
                              </select>
                              <button
                                onClick={saveEdit}
                                disabled={!editName.trim() || isSavingEdit}
                                className="p-1 rounded text-emerald-600 hover:bg-[var(--color-surface-hover)] disabled:opacity-40"
                                title="Salva"
                              >
                                {isSavingEdit ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                              </button>
                              <button
                                onClick={cancelEdit}
                                disabled={isSavingEdit}
                                className="p-1 rounded text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                                title="Annulla"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={item.id}
                          onClick={selectionMode ? () => toggleSelect(item.id) : undefined}
                          className={`group flex items-center gap-3 py-2 px-2 rounded-md transition-colors ${
                            selectionMode
                              ? `cursor-pointer ${isSelected ? 'bg-indigo-50 dark:bg-indigo-500/15' : 'hover:bg-[var(--color-surface-hover)]'}`
                              : 'hover:bg-[var(--color-surface-hover)]'
                          }`}
                          title={meta}
                        >
                          {selectionMode ? (
                            <span
                              className={`flex-shrink-0 transition-colors ${isSelected ? 'text-indigo-600 dark:text-indigo-400' : 'text-[var(--color-fg-subtle)]'}`}
                              aria-hidden="true"
                            >
                              {isSelected ? <CheckCircle2 className="h-5 w-5" /> : <Circle className="h-5 w-5" />}
                            </span>
                          ) : (
                            <button
                              onClick={() => toggleItem(item.id)}
                              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors flex-shrink-0 ${
                                item.checked
                                  ? 'bg-emerald-500 border-emerald-500 text-[#ffffff]'
                                  : 'border-[var(--color-line-strong)] hover:border-[var(--color-fg)]'
                              }`}
                              title={item.checked ? 'Segna come da fare' : 'Segna come comprato'}
                            >
                              {item.checked && <Check className="h-2.5 w-2.5" />}
                            </button>
                          )}
                          <span className={`flex-1 min-w-0 text-sm flex items-center gap-2 ${item.checked && !selectionMode ? 'line-through text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}>
                            {item.quantity != null && item.quantity > 0 && item.unit && (
                              <span
                                className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-semibold tabular flex-shrink-0 ${
                                  item.checked && !selectionMode
                                    ? 'bg-[var(--color-surface-2)] text-[var(--color-fg-subtle)]'
                                    : 'bg-[var(--color-surface-2)] text-[var(--color-fg)] border border-[var(--color-line)]'
                                }`}
                              >
                                {formatQty(item.quantity, item.unit)}
                              </span>
                            )}
                            <span className="truncate">{item.name}</span>
                          </span>
                          {item.supplierName && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-500/30 flex-shrink-0 max-w-[120px] truncate">
                              <Truck className="h-2.5 w-2.5 flex-shrink-0" />
                              <span className="truncate">{item.supplierName}</span>
                            </span>
                          )}
                          {!selectionMode && (
                            <>
                              <span className="hidden sm:inline text-[11px] text-[var(--color-fg-subtle)] tabular flex-shrink-0">
                                {item.createdByUserName ? item.createdByUserName.split('@')[0] : 'Anonimo'}
                              </span>
                              <button
                                onClick={() => startEdit(item)}
                                className="p-1 rounded text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all flex-shrink-0"
                                title="Modifica"
                              >
                                <Edit2 className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => deleteItem(item.id)}
                                className="p-1 rounded text-[var(--color-fg-subtle)] hover:text-rose-600 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all flex-shrink-0"
                                title="Elimina"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Add item — sticky at bottom of page */}
        <div className="sticky bottom-3 sm:bottom-4">
          <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl shadow-[var(--shadow-md)] p-3 relative">
            <div className="flex flex-wrap items-center gap-2">
              {/* Product name — own full-width line on mobile, flexes inline on sm+ */}
              <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-1">
                <Plus className="h-4 w-4 text-[var(--color-fg-subtle)] flex-shrink-0" />
                <input
                  ref={inputRef}
                  type="text"
                  value={newItemName}
                  onChange={e => { setNewItemName(e.target.value); setShowSuggestions(true); }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
                  }}
                  placeholder="Aggiungi prodotto..."
                  className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
                />
              </div>
              {/* Controls — second line on mobile, inline on sm+ via display:contents */}
              <div className="flex flex-wrap items-center gap-2 min-w-0 w-full sm:w-auto sm:contents">
                <input
                  type="text"
                  inputMode="decimal"
                  value={newItemQty}
                  onChange={e => setNewItemQty(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); handleAdd(); }
                  }}
                  placeholder="Qtà"
                  className="w-14 flex-shrink-0 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none focus:border-[var(--color-fg)] tabular text-center"
                  title="Quantità (opzionale)"
                />
                <div className="relative flex-shrink-0">
                  <select
                    value={newItemUnit}
                    onChange={e => setNewItemUnit(e.target.value as ShoppingUnit)}
                    className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full pl-3 pr-7 py-1 text-xs font-medium text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-fg)] appearance-none cursor-pointer"
                    title="Unità"
                  >
                    {SHOPPING_UNITS.map(u => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--color-fg-muted)]" />
                </div>
                <div className="relative flex-shrink-0">
                  <select
                    value={newItemCategory}
                    onChange={e => setNewItemCategory(e.target.value as ShoppingCategory)}
                    className="bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full pl-3 pr-7 py-1 text-xs font-medium text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-fg)] appearance-none cursor-pointer"
                  >
                    <option value="CUCINA">Cucina</option>
                    <option value="BAR">Bar</option>
                    <option value="ALTRO">Altro</option>
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--color-fg-muted)]" />
                </div>
                {suppliersByCategory[newItemCategory].length > 0 && (
                  <div className="relative flex-1 min-w-[120px] sm:flex-none sm:min-w-0">
                    <select
                      value={newItemSupplierId}
                      onChange={e => setNewItemSupplierId(e.target.value)}
                      className="w-full bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full pl-3 pr-7 py-1 text-xs font-medium text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-fg)] appearance-none cursor-pointer sm:max-w-[140px]"
                      title="Fornitore (opzionale)"
                    >
                      <option value="">Senza fornitore</option>
                      {suppliersByCategory[newItemCategory].map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-[var(--color-fg-muted)]" />
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleAdd()}
                  disabled={!newItemName.trim() || isAdding}
                  aria-label="Aggiungi prodotto"
                  className="flex-shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
                >
                  {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                </button>
              </div>
            </div>

            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute left-3 right-3 bottom-full mb-1 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg shadow-[var(--shadow-md)] overflow-hidden z-10">
                {suggestions.map(name => (
                  <button
                    key={name}
                    type="button"
                    onMouseDown={e => {
                      e.preventDefault();
                      setShowSuggestions(false);
                      handleAdd(name);
                    }}
                    className="w-full text-left px-3 py-2 text-sm text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors flex items-center gap-2"
                  >
                    <Clock className="h-3 w-3 text-[var(--color-fg-subtle)] flex-shrink-0" />
                    {name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <SupplierManagementModal
        open={supplierModalOpen}
        onClose={() => setSupplierModalOpen(false)}
        initialCategory={supplierModalCategory}
      />
    </div>
  );
};
