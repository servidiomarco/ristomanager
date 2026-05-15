import React, { useEffect, useMemo, useState } from 'react';
import {
  InventoryArea,
  InventoryLocation,
  InventoryProduct,
  InventoryStockRow,
  InventoryMovementReason,
  InventoryCategory,
} from '../types';
import {
  getInventoryLocations,
  getInventoryProducts,
  getInventoryStock,
  getInventoryCategories,
  createInventoryLocation,
  updateInventoryLocation,
  deleteInventoryLocation,
  createInventoryProduct,
  updateInventoryProduct,
  deleteInventoryProduct,
  createInventoryCategory,
  updateInventoryCategory,
  deleteInventoryCategory,
  postInventoryMovement,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { toTitleCase } from '../utils/text';
import {
  Loader2, Plus, Minus, Pencil, Trash2, X, Settings, Boxes,
  ChefHat, Wine, GlassWater, AlertTriangle, Tag, Search, Printer,
} from 'lucide-react';
import { PrintInventoryModal } from './PrintInventoryModal';

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
  autoOpenNewProduct?: boolean;
  onAutoOpenNewProductHandled?: () => void;
}

const AREA_LABEL: Record<InventoryArea, string> = {
  [InventoryArea.CUCINA]: 'Cucina',
  [InventoryArea.SALA]: 'Sala',
  [InventoryArea.BAR]: 'Bar',
};

const AREA_ICON: Record<InventoryArea, React.ReactNode> = {
  [InventoryArea.CUCINA]: <ChefHat className="h-4 w-4" />,
  [InventoryArea.SALA]: <GlassWater className="h-4 w-4" />,
  [InventoryArea.BAR]: <Wine className="h-4 w-4" />,
};

// Compose a stable key for a (product, location) entry in the stock map.
const stockKey = (productId: number, locationId: number): string => `${productId}:${locationId}`;

export const Inventory: React.FC<Props> = ({ showToast, autoOpenNewProduct, onAutoOpenNewProductHandled }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('inventory:full');

  const [activeArea, setActiveArea] = useState<InventoryArea>(InventoryArea.CUCINA);
  // null = "Totale" tab (sum across all locations of the area)
  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stock, setStock] = useState<InventoryStockRow[]>([]);
  const [categories, setCategories] = useState<InventoryCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Category filter — null = all, -1 = "Senza categoria", number = category id
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);

  // Locations modal
  const [locationsModalOpen, setLocationsModalOpen] = useState(false);
  const [locationDraftName, setLocationDraftName] = useState('');
  const [editingLocationId, setEditingLocationId] = useState<number | null>(null);
  const [editingLocationName, setEditingLocationName] = useState('');
  const [confirmDeleteLocationId, setConfirmDeleteLocationId] = useState<number | null>(null);

  // Categories modal
  const [categoriesModalOpen, setCategoriesModalOpen] = useState(false);
  const [categoryDraftName, setCategoryDraftName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [confirmDeleteCategoryId, setConfirmDeleteCategoryId] = useState<number | null>(null);

  // Product create/edit modal
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productEditing, setProductEditing] = useState<InventoryProduct | null>(null);
  const [productForm, setProductForm] = useState<{ name: string; unit: string; notes: string; category_id: number | null }>({ name: '', unit: '', notes: '', category_id: null });
  const [confirmDeleteProductId, setConfirmDeleteProductId] = useState<number | null>(null);

  // Per-row pending state for the +/- stepper buttons so the user gets immediate
  // feedback while the request is in flight. Keyed by stockKey.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');

  // Print modal
  const [printModalOpen, setPrintModalOpen] = useState(false);

  // Load everything for the active area whenever it changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    Promise.all([
      getInventoryLocations(activeArea),
      getInventoryProducts(activeArea),
      getInventoryStock(activeArea),
      getInventoryCategories(activeArea),
    ])
      .then(([locs, prods, st, cats]) => {
        if (cancelled) return;
        setLocations(locs);
        setProducts(prods);
        setStock(st);
        setCategories(cats);
        setCategoryFilter(null);
        // If the previously active location is gone (or we changed area), reset
        // to Totale so the UI doesn't show an empty grid.
        setActiveLocationId(prev => {
          if (prev != null && locs.some(l => l.id === prev && l.area === activeArea)) return prev;
          return null;
        });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setError(err?.message || 'Errore caricamento inventario');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeArea]);

  // Quick lookup map: stockKey → quantity
  const stockMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stock) m.set(stockKey(s.product_id, s.location_id), s.quantity);
    return m;
  }, [stock]);

  // Sum across all locations — used for the low-stock indicator regardless
  // of which location filter is active.
  const totalQuantityFor = (productId: number): number => {
    let total = 0;
    for (const loc of locations) {
      total += stockMap.get(stockKey(productId, loc.id)) ?? 0;
    }
    return total;
  };

  const LOW_STOCK_THRESHOLD = 5;
  const isLowStock = (productId: number): boolean => totalQuantityFor(productId) <= LOW_STOCK_THRESHOLD;

  // For a product, the quantity in the active location, or the total across
  // all locations when "Totale" is selected.
  const quantityFor = (productId: number): number => {
    if (activeLocationId != null) {
      return stockMap.get(stockKey(productId, activeLocationId)) ?? 0;
    }
    return totalQuantityFor(productId);
  };

  // Per-product breakdown across locations — used in the Totale view as a
  // secondary line so users can see WHERE the stock lives.
  const breakdownFor = (productId: number): { locationName: string; quantity: number }[] => {
    return locations
      .map(loc => ({ locationName: loc.name, quantity: stockMap.get(stockKey(productId, loc.id)) ?? 0 }))
      .filter(b => b.quantity !== 0);
  };

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = products;
    if (categoryFilter === -1) {
      list = list.filter(p => p.category_id == null);
    } else if (categoryFilter != null) {
      list = list.filter(p => p.category_id === categoryFilter);
    }
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
    return list;
  }, [products, search, categoryFilter]);

  const applyMovement = async (productId: number, locationId: number, delta: number, reason: InventoryMovementReason) => {
    const key = stockKey(productId, locationId);
    setPendingKeys(prev => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
    try {
      const res = await postInventoryMovement({ product_id: productId, location_id: locationId, delta, reason });
      setStock(prev => {
        const idx = prev.findIndex(s => s.product_id === productId && s.location_id === locationId);
        if (idx === -1) return [...prev, res.stock];
        const next = prev.slice();
        next[idx] = res.stock;
        return next;
      });
    } catch (err: any) {
      showToast(err?.message || 'Errore aggiornamento stock', 'error');
    } finally {
      setPendingKeys(prev => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const handleStep = (productId: number, sign: 1 | -1) => {
    if (activeLocationId == null) {
      showToast("Seleziona un'area per modificare le quantità", 'info');
      return;
    }
    const reason = sign > 0 ? InventoryMovementReason.CARICO : InventoryMovementReason.SCARICO;
    applyMovement(productId, activeLocationId, sign, reason);
  };

  const handleSetQuantity = async (productId: number, raw: string) => {
    if (activeLocationId == null) return;
    const target = Number(raw);
    if (!Number.isFinite(target)) {
      showToast('Quantità non valida', 'error');
      return;
    }
    const current = stockMap.get(stockKey(productId, activeLocationId)) ?? 0;
    const delta = target - current;
    if (delta === 0) return;
    await applyMovement(productId, activeLocationId, delta, InventoryMovementReason.RETTIFICA);
  };

  // ---------- Locations modal handlers ----------
  const handleAddLocation = async () => {
    if (!locationDraftName.trim()) return;
    try {
      const created = await createInventoryLocation({
        area: activeArea,
        name: locationDraftName.trim(),
        sort_order: locations.length,
      });
      setLocations(prev => [...prev, created]);
      setLocationDraftName('');
      showToast('Area creata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione area', 'error');
    }
  };

  const handleSaveLocationEdit = async () => {
    if (editingLocationId == null || !editingLocationName.trim()) return;
    try {
      const sortOrder = locations.find(l => l.id === editingLocationId)?.sort_order ?? 0;
      const updated = await updateInventoryLocation(editingLocationId, {
        name: editingLocationName.trim(),
        sort_order: sortOrder,
      });
      setLocations(prev => prev.map(l => (l.id === updated.id ? updated : l)));
      setEditingLocationId(null);
      setEditingLocationName('');
      showToast('Area aggiornata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore aggiornamento area', 'error');
    }
  };

  const handleDeleteLocation = async (id: number) => {
    try {
      await deleteInventoryLocation(id);
      setLocations(prev => prev.filter(l => l.id !== id));
      setStock(prev => prev.filter(s => s.location_id !== id));
      if (activeLocationId === id) setActiveLocationId(null);
      setConfirmDeleteLocationId(null);
      showToast('Area eliminata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione area', 'error');
      setConfirmDeleteLocationId(null);
    }
  };

  // ---------- Categories modal handlers ----------
  const handleAddCategory = async () => {
    if (!categoryDraftName.trim()) return;
    try {
      const created = await createInventoryCategory({
        area: activeArea,
        name: categoryDraftName.trim(),
        sort_order: categories.length,
      });
      setCategories(prev => [...prev, created]);
      setCategoryDraftName('');
      showToast('Categoria creata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione categoria', 'error');
    }
  };

  const handleSaveCategoryEdit = async () => {
    if (editingCategoryId == null || !editingCategoryName.trim()) return;
    try {
      const sortOrder = categories.find(c => c.id === editingCategoryId)?.sort_order ?? 0;
      const updated = await updateInventoryCategory(editingCategoryId, {
        name: editingCategoryName.trim(),
        sort_order: sortOrder,
      });
      setCategories(prev => prev.map(c => (c.id === updated.id ? updated : c)));
      // Refresh products' category_name in-place where they referenced this category.
      setProducts(prev => prev.map(p => p.category_id === updated.id ? { ...p, category_name: updated.name } : p));
      setEditingCategoryId(null);
      setEditingCategoryName('');
      showToast('Categoria aggiornata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore aggiornamento categoria', 'error');
    }
  };

  const handleDeleteCategory = async (id: number) => {
    try {
      await deleteInventoryCategory(id);
      setCategories(prev => prev.filter(c => c.id !== id));
      // Products keep existing — backend ON DELETE SET NULL clears their FK.
      setProducts(prev => prev.map(p => p.category_id === id ? { ...p, category_id: null, category_name: null } : p));
      if (categoryFilter === id) setCategoryFilter(null);
      setConfirmDeleteCategoryId(null);
      showToast('Categoria eliminata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione categoria', 'error');
      setConfirmDeleteCategoryId(null);
    }
  };

  // ---------- Product modal handlers ----------
  const openCreateProduct = () => {
    setProductEditing(null);
    // Pre-select the currently filtered category, if any, for fast bulk-add.
    const presetCategory = (categoryFilter != null && categoryFilter !== -1) ? categoryFilter : null;
    setProductForm({ name: '', unit: '', notes: '', category_id: presetCategory });
    setProductModalOpen(true);
  };
  useEffect(() => {
    if (autoOpenNewProduct) {
      openCreateProduct();
      onAutoOpenNewProductHandled?.();
    }
  }, [autoOpenNewProduct]);

  const openEditProduct = (p: InventoryProduct) => {
    setProductEditing(p);
    setProductForm({
      name: p.name,
      unit: p.unit || '',
      notes: p.notes || '',
      category_id: p.category_id ?? null,
    });
    setProductModalOpen(true);
  };

  const handleSaveProduct = async () => {
    const name = productForm.name.trim();
    if (!name) {
      showToast('Inserisci un nome prodotto', 'error');
      return;
    }
    try {
      if (productEditing) {
        const updated = await updateInventoryProduct(productEditing.id, {
          name,
          unit: productForm.unit.trim() || null,
          notes: productForm.notes.trim() || null,
          category_id: productForm.category_id,
        });
        setProducts(prev => prev.map(p => (p.id === updated.id ? updated : p)));
        showToast('Prodotto aggiornato', 'success');
      } else {
        const created = await createInventoryProduct({
          area: activeArea,
          name,
          unit: productForm.unit.trim() || null,
          notes: productForm.notes.trim() || null,
          category_id: productForm.category_id,
        });
        setProducts(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
        showToast('Prodotto creato', 'success');
      }
      setProductModalOpen(false);
    } catch (err: any) {
      showToast(err?.message || 'Errore salvataggio prodotto', 'error');
    }
  };

  const handleDeleteProduct = async (id: number) => {
    try {
      await deleteInventoryProduct(id);
      setProducts(prev => prev.filter(p => p.id !== id));
      setStock(prev => prev.filter(s => s.product_id !== id));
      setConfirmDeleteProductId(null);
      showToast('Prodotto eliminato', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione prodotto', 'error');
      setConfirmDeleteProductId(null);
    }
  };

  // ---------- Render ----------

  const isTotale = activeLocationId == null;

  return (
    <div className="p-4 sm:p-6 lg:p-8 pb-24 lg:pb-8 space-y-3">
      {/* Filters row: area pills + location pills + management buttons */}
      <div className="flex items-center gap-2 overflow-x-auto scrollbar-hide">
        <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full flex-shrink-0">
          {(Object.values(InventoryArea) as InventoryArea[]).map(area => (
            <button
              key={area}
              onClick={() => setActiveArea(area)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition ${
                activeArea === area
                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                  : 'text-[var(--color-fg-muted)]'
              }`}
            >
              {AREA_ICON[area]}
              {AREA_LABEL[area]}
            </button>
          ))}
        </div>

        <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full flex-shrink-0">
          <button
            onClick={() => setActiveLocationId(null)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition whitespace-nowrap ${
              isTotale
                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                : 'text-[var(--color-fg-muted)]'
            }`}
          >
            Totale
          </button>
          {locations.map(loc => (
            <button
              key={loc.id}
              onClick={() => setActiveLocationId(loc.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition whitespace-nowrap ${
                activeLocationId === loc.id
                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                  : 'text-[var(--color-fg-muted)]'
              }`}
            >
              {toTitleCase(loc.name)}
            </button>
          ))}
        </div>

        <div className="hidden md:flex items-center gap-2 ml-auto flex-shrink-0">
          <button
            onClick={() => setPrintModalOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
            title="Stampa inventario"
          >
            <Printer className="h-3.5 w-3.5" />
            Stampa
          </button>
          {canEdit && (
            <>
              <button
                onClick={() => setCategoriesModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
                title="Gestione categorie"
              >
                <Tag className="h-3.5 w-3.5" />
                Gestione categorie
              </button>
              <button
                onClick={() => setLocationsModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
                title="Gestione aree"
              >
                <Settings className="h-3.5 w-3.5" />
                Gestione aree
              </button>
            </>
          )}
        </div>
      </div>

      {/* Category filter pills */}
      {(categories.length > 0 || products.some(p => p.category_id == null)) && (
        <div className="overflow-x-auto scrollbar-hide">
          <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full">
          <button
            onClick={() => setCategoryFilter(null)}
            className={`px-3 py-1.5 text-xs font-medium rounded-full transition whitespace-nowrap ${
              categoryFilter === null
                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                : 'text-[var(--color-fg-muted)]'
            }`}
          >
            Tutte
          </button>
          {categories.map(cat => (
            <button
              key={cat.id}
              onClick={() => setCategoryFilter(cat.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition whitespace-nowrap ${
                categoryFilter === cat.id
                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                  : 'text-[var(--color-fg-muted)]'
              }`}
            >
              {cat.name}
            </button>
          ))}
          {products.some(p => p.category_id == null) && (
            <button
              onClick={() => setCategoryFilter(-1)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition whitespace-nowrap ${
                categoryFilter === -1
                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                  : 'text-[var(--color-fg-muted)]'
              }`}
            >
              Senza categoria
            </button>
          )}
          </div>
        </div>
      )}

      {/* Search + mobile add + mobile management */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca prodotto..."
              className="w-full h-9 rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface-2)] dark:bg-white/[0.04] pl-9 pr-3 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />
          </div>
          <div className="flex md:hidden items-center gap-1.5">
            <button
              onClick={() => setPrintModalOpen(true)}
              className="p-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
              title="Stampa inventario"
            >
              <Printer className="h-4 w-4" />
            </button>
            {canEdit && (
              <>
                <button
                  onClick={() => setCategoriesModalOpen(true)}
                  className="p-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
                  title="Gestione categorie"
                >
                  <Tag className="h-4 w-4" />
                </button>
                <button
                  onClick={() => setLocationsModalOpen(true)}
                  className="p-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)] transition"
                  title="Gestione aree"
                >
                  <Settings className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
        {canEdit && (
          <button
            onClick={openCreateProduct}
            className="md:hidden w-full inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Aggiungi prodotto
          </button>
        )}
      </div>

      {/* Loading / Error / Empty */}
      {isLoading && (
        <div className="flex items-center justify-center py-12 text-[var(--color-fg-muted)]">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Caricamento...
        </div>
      )}
      {!isLoading && error && (
        <div className="p-4 rounded-lg bg-rose-50 text-rose-700 border border-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30">
          <AlertTriangle className="inline h-4 w-4 mr-2" />
          {error}
        </div>
      )}
      {!isLoading && !error && filteredProducts.length === 0 && (
        <div className="p-12 text-center text-[var(--color-fg-muted)] border border-dashed border-[var(--color-line)] rounded-lg">
          <Boxes className="h-8 w-8 mx-auto mb-3 text-[var(--color-fg-subtle)]" />
          <p className="text-[14px]">Nessun prodotto in {AREA_LABEL[activeArea]}.</p>
          {canEdit && (
            <button
              onClick={openCreateProduct}
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] border border-[var(--color-line)] hover:border-[var(--color-fg)]"
            >
              <Plus className="h-4 w-4" />
              Aggiungi il primo
            </button>
          )}
        </div>
      )}

      {/* Product list */}
      {!isLoading && !error && filteredProducts.length > 0 && (
        <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
          {filteredProducts.map((p, idx) => {
            const qty = quantityFor(p.id);
            const breakdown = isTotale ? breakdownFor(p.id) : [];
            const key = activeLocationId != null ? stockKey(p.id, activeLocationId) : '';
            const isPending = key && pendingKeys.has(key);
            const lowStock = isLowStock(p.id);
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 p-3 sm:p-4 ${idx > 0 ? 'border-t border-[var(--color-line)]' : ''} ${lowStock ? 'bg-red-50 dark:bg-red-950/20' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`font-medium text-[14px] truncate ${lowStock ? 'text-red-700 dark:text-red-300' : 'text-[var(--color-fg)]'}`}>{p.name}</span>
                    {lowStock && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 border border-red-200 dark:border-red-800 rounded-full px-2 py-0.5">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        Scorta bassa
                      </span>
                    )}
                    {p.unit && (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{p.unit}</span>
                    )}
                    {p.category_name && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wide text-[var(--color-fg-muted)] bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full px-2 py-0.5">
                        <Tag className="h-2.5 w-2.5" />
                        {p.category_name}
                      </span>
                    )}
                  </div>
                  {isTotale && breakdown.length > 0 && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] mt-1 truncate">
                      {breakdown.map(b => `${b.locationName}: ${b.quantity}`).join(' · ')}
                    </div>
                  )}
                  {p.notes && !isTotale && (
                    <div className="text-[12px] text-[var(--color-fg-muted)] mt-1 truncate">{p.notes}</div>
                  )}
                </div>

                {/* Quantity controls — stepper only when a specific location is selected */}
                {!isTotale ? (
                  <div className="flex items-center gap-1">
                    {canEdit && (
                      <button
                        onClick={() => handleStep(p.id, -1)}
                        disabled={!!isPending}
                        className="h-9 w-9 flex items-center justify-center rounded-md border border-[var(--color-line)] hover:border-[var(--color-fg)] disabled:opacity-40"
                        aria-label="Scarico (-1)"
                      >
                        <Minus className="h-4 w-4" />
                      </button>
                    )}
                    <input
                      type="number"
                      step="any"
                      defaultValue={qty}
                      key={`${p.id}-${activeLocationId}-${qty}`}
                      onBlur={(e) => {
                        if (canEdit) {
                          handleSetQuantity(p.id, e.target.value);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      readOnly={!canEdit || !!isPending}
                      className="w-16 sm:w-20 text-center font-medium tabular-nums rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2 py-1.5 text-[14px] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]"
                    />
                    {canEdit && (
                      <button
                        onClick={() => handleStep(p.id, 1)}
                        disabled={!!isPending}
                        className="h-9 w-9 flex items-center justify-center rounded-md border border-[var(--color-line)] hover:border-[var(--color-fg)] disabled:opacity-40"
                        aria-label="Carico (+1)"
                      >
                        <Plus className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="text-right">
                    <div className={`font-semibold tabular-nums text-[15px] ${lowStock ? 'text-red-700 dark:text-red-300' : 'text-[var(--color-fg)]'}`}>{qty}</div>
                    {p.unit && <div className="text-[11px] text-[var(--color-fg-subtle)] uppercase">{p.unit}</div>}
                  </div>
                )}

                {canEdit && (
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => openEditProduct(p)}
                      className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
                      title="Modifica"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setConfirmDeleteProductId(p.id)}
                      className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-[var(--color-surface-hover)]"
                      title="Elimina"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ----- Locations modal ----- */}
      {locationsModalOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => setLocationsModalOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-md h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Aree — {AREA_LABEL[activeArea]}</h3>
              <button onClick={() => setLocationsModalOpen(false)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3 flex-1 overflow-y-auto">
              {locations.length === 0 && (
                <div className="text-[13px] text-[var(--color-fg-muted)] text-center py-2">
                  Nessuna area. Aggiungine una qui sotto.
                </div>
              )}
              {locations.map(loc => (
                <div key={loc.id} className="flex items-center gap-2">
                  {editingLocationId === loc.id ? (
                    <>
                      <input
                        type="text"
                        value={editingLocationName}
                        onChange={(e) => setEditingLocationName(e.target.value)}
                        className="flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                        autoFocus
                      />
                      <button onClick={handleSaveLocationEdit} className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90">Salva</button>
                      <button onClick={() => { setEditingLocationId(null); setEditingLocationName(''); }} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-[14px] text-[var(--color-fg)]">{loc.name}</span>
                      <button
                        onClick={() => { setEditingLocationId(loc.id); setEditingLocationName(loc.name); }}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteLocationId(loc.id)}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-[var(--color-surface-hover)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}

              <div className="pt-3 border-t border-[var(--color-line)] flex items-center gap-2">
                <input
                  type="text"
                  value={locationDraftName}
                  onChange={(e) => setLocationDraftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddLocation(); }}
                  placeholder="Nome area (es. Area 1)"
                  className="flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
                <button
                  onClick={handleAddLocation}
                  disabled={!locationDraftName.trim()}
                  className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium disabled:opacity-50 hover:opacity-90"
                >
                  <Plus className="h-4 w-4 inline" /> Aggiungi
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----- Categories modal ----- */}
      {categoriesModalOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => setCategoriesModalOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-md h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Categorie — {AREA_LABEL[activeArea]}</h3>
              <button onClick={() => setCategoriesModalOpen(false)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3 flex-1 overflow-y-auto">
              {categories.length === 0 && (
                <div className="text-[13px] text-[var(--color-fg-muted)] text-center py-2">
                  Nessuna categoria. Aggiungine una qui sotto.
                </div>
              )}
              {categories.map(cat => (
                <div key={cat.id} className="flex items-center gap-2">
                  {editingCategoryId === cat.id ? (
                    <>
                      <input
                        type="text"
                        value={editingCategoryName}
                        onChange={(e) => setEditingCategoryName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCategoryEdit(); }}
                        className="flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                        autoFocus
                      />
                      <button onClick={handleSaveCategoryEdit} className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90">Salva</button>
                      <button onClick={() => { setEditingCategoryId(null); setEditingCategoryName(''); }} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 text-[14px] text-[var(--color-fg)]">{cat.name}</span>
                      <button
                        onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => setConfirmDeleteCategoryId(cat.id)}
                        className="h-8 w-8 flex items-center justify-center rounded-md text-[var(--color-fg-muted)] hover:text-rose-600 hover:bg-[var(--color-surface-hover)]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </>
                  )}
                </div>
              ))}

              <div className="pt-3 border-t border-[var(--color-line)] flex items-center gap-2">
                <input
                  type="text"
                  value={categoryDraftName}
                  onChange={(e) => setCategoryDraftName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
                  placeholder="Nome categoria (es. Verdure)"
                  className="flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
                <button
                  onClick={handleAddCategory}
                  disabled={!categoryDraftName.trim()}
                  className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium disabled:opacity-50 hover:opacity-90"
                >
                  <Plus className="h-4 w-4 inline" /> Aggiungi
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----- Confirm delete category ----- */}
      {confirmDeleteCategoryId != null && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setConfirmDeleteCategoryId(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare la categoria?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              I prodotti associati resteranno, ma diventeranno "Senza categoria".
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteCategoryId(null)} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
              <button onClick={() => handleDeleteCategory(confirmDeleteCategoryId)} className="px-4 py-2 rounded-full bg-rose-600 text-[#ffffff] text-sm font-medium hover:bg-rose-700">Elimina</button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Confirm delete location ----- */}
      {confirmDeleteLocationId != null && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setConfirmDeleteLocationId(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare l'area?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              Tutte le quantità in quest'area verranno cancellate. L'azione non è reversibile.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteLocationId(null)} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
              <button onClick={() => handleDeleteLocation(confirmDeleteLocationId)} className="px-4 py-2 rounded-full bg-rose-600 text-[#ffffff] text-sm font-medium hover:bg-rose-700">Elimina</button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Product modal ----- */}
      {productModalOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => setProductModalOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-md h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {productEditing ? 'Modifica prodotto' : `Nuovo prodotto — ${AREA_LABEL[activeArea]}`}
              </h3>
              <button onClick={() => setProductModalOpen(false)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-3 flex-1 overflow-y-auto">
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1">Nome *</label>
                <input
                  type="text"
                  value={productForm.name}
                  onChange={(e) => setProductForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="Es. Pomodori pelati"
                  className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1">Unità di misura</label>
                <input
                  type="text"
                  value={productForm.unit}
                  onChange={(e) => setProductForm(f => ({ ...f, unit: e.target.value }))}
                  placeholder="kg, lt, pz, ..."
                  className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1">Categoria</label>
                <select
                  value={productForm.category_id ?? ''}
                  onChange={(e) => setProductForm(f => ({ ...f, category_id: e.target.value ? Number(e.target.value) : null }))}
                  className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                >
                  <option value="">Senza categoria</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                {categories.length === 0 && (
                  <p className="text-[11px] text-[var(--color-fg-muted)] mt-1">
                    Nessuna categoria. Aggiungine una da "Gestione categorie".
                  </p>
                )}
              </div>
              <div>
                <label className="block text-[12px] font-medium text-[var(--color-fg)] mb-1">Note</label>
                <textarea
                  value={productForm.notes}
                  onChange={(e) => setProductForm(f => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex gap-2 justify-end">
              <button onClick={() => setProductModalOpen(false)} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
              <button onClick={handleSaveProduct} className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90">Salva</button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Print inventory modal ----- */}
      <PrintInventoryModal
        isOpen={printModalOpen}
        onClose={() => setPrintModalOpen(false)}
        area={activeArea}
        locations={locations}
        products={products}
        stock={stock}
        categories={categories}
        initialLocationId={activeLocationId}
        initialCategoryFilter={categoryFilter}
      />

      {/* ----- Confirm delete product ----- */}
      {confirmDeleteProductId != null && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setConfirmDeleteProductId(null)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare il prodotto?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              Verrà rimosso dall'inventario in tutte le aree. L'azione non è reversibile.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteProductId(null)} className="px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
              <button onClick={() => handleDeleteProduct(confirmDeleteProductId)} className="px-4 py-2 rounded-full bg-rose-600 text-[#ffffff] text-sm font-medium hover:bg-rose-700">Elimina</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Inventory;
