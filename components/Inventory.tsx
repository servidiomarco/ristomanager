import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2, Plus, Pencil, Trash2, Boxes, GripVertical, Check, MoreVertical,
  ChefHat, Wine, GlassWater, AlertTriangle, Tag, Search, Printer, Container,
} from 'lucide-react';
import { PrintInventoryModal } from './PrintInventoryModal';
import { SkeletonProductList } from './SkeletonCards';
import {
  ModalShell, Sheet, SegmentedControl, SearchField, SectionHeader, StatStrip,
  StatusPill, Callout, EmptyState, FormCard, Field, useMediaQuery,
  dsButton, dsInput, dsSelect, dsTextarea,
} from './ds';

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

// The category filter and the group list share this sentinel for products with
// no category, so "Senza categoria" behaves like any other group.
const UNCATEGORIZED = -1;


// The quiet round control that sits at the end of a row.
const rowIconButton =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

const rowIconButtonDanger =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

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

  // Category filter — null = all, UNCATEGORIZED = "Senza categoria", number = category id
  const [categoryFilter, setCategoryFilter] = useState<number | null>(null);
  // Narrows the list to what is about to run out. Client-side, over data that
  // is already loaded — the same set the banner names.
  const [onlyLowStock, setOnlyLowStock] = useState(false);

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
  // Rows already touched in this counting pass. Kept until the cell or the area
  // changes: during a count the useful question is "which shelves have I done",
  // and a badge that fades after two seconds cannot answer it.
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');

  // Products from the other two areas, loaded only when someone asks for them
  // from the no-results state. null = never asked.
  const [crossArea, setCrossArea] = useState<{ loading: boolean; results: InventoryProduct[] } | null>(null);

  // Drag-to-reorder inside the Categorie / Aree modals.
  const [dragCat, setDragCat] = useState<{ from: number; over: number } | null>(null);
  const [dragLoc, setDragLoc] = useState<{ from: number; over: number } | null>(null);

  // Which area the Categorie / Aree modals are editing. It starts on the one you
  // are looking at, but you can move to another without closing and losing your
  // place on the page behind — reorganising Sala is not a reason to leave Cucina.
  const [manageArea, setManageArea] = useState<InventoryArea>(InventoryArea.CUCINA);
  // That other area's data, fetched on demand through the same endpoints the
  // page uses. Empty while manageArea === activeArea, which reads from the page
  // state instead so an edit shows up behind the modal immediately.
  const [foreign, setForeign] = useState<{
    categories: InventoryCategory[];
    locations: InventoryLocation[];
    products: InventoryProduct[];
    stock: InventoryStockRow[];
  }>({ categories: [], locations: [], products: [], stock: [] });
  const [foreignLoading, setForeignLoading] = useState(false);

  // Print modal
  const [printModalOpen, setPrintModalOpen] = useState(false);

  // The "gestisci" menu behind the ⋮ in the page head.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  // Picks the container, not the styling: a dropdown anchored to the trigger and
  // a bottom sheet are different trees, which CSS cannot swap between.
  const isWide = useMediaQuery('(min-width: 1024px)');

  // Quantity fields in the counting view, in render order, so Enter can hand
  // focus to the next product without the caller knowing the grouping.
  const qtyInputs = useRef<Map<number, HTMLInputElement>>(new Map());
  const orderedIds = useRef<number[]>([]);

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
        setOnlyLowStock(false);
        setSavedKeys(new Set());
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

  // A new search is a new question — the previous cross-area answer would be
  // about a term nobody typed any more.
  useEffect(() => { setCrossArea(null); }, [search, activeArea]);

  // Dismiss the dropdown the way every other menu in the app does. Not needed
  // for the sheet, which has its own backdrop.
  useEffect(() => {
    if (!menuOpen || !isWide) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !menuTriggerRef.current?.contains(t)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, isWide]);

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

  const lowStockProducts = useMemo(
    () => products.filter(p => isLowStock(p.id)),
    [products, stockMap, locations]
  );

  const filteredProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = products;
    if (categoryFilter === UNCATEGORIZED) {
      list = list.filter(p => p.category_id == null);
    } else if (categoryFilter != null) {
      list = list.filter(p => p.category_id === categoryFilter);
    }
    if (onlyLowStock) list = list.filter(p => isLowStock(p.id));
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
    return list;
  }, [products, search, categoryFilter, onlyLowStock, stockMap, locations]);

  // The list, cut into category bands in the order the categories were arranged
  // in the Categorie modal. Uncategorised products close the list rather than
  // opening it — they are the leftovers, not the headline.
  const groups = useMemo(() => {
    const byCategory = new Map<number, InventoryProduct[]>();
    for (const p of filteredProducts) {
      const key = p.category_id ?? UNCATEGORIZED;
      const bucket = byCategory.get(key);
      if (bucket) bucket.push(p);
      else byCategory.set(key, [p]);
    }
    const out: { id: number; name: string; products: InventoryProduct[] }[] = [];
    for (const cat of categories) {
      const items = byCategory.get(cat.id);
      if (items?.length) out.push({ id: cat.id, name: cat.name, products: items });
    }
    const loose = byCategory.get(UNCATEGORIZED);
    if (loose?.length) out.push({ id: UNCATEGORIZED, name: 'Senza categoria', products: loose });
    return out;
  }, [filteredProducts, categories]);

  // Rebuilt on every render so Enter always walks the list you are looking at,
  // not the one you filtered away.
  orderedIds.current = groups.flatMap(g => g.products.map(p => p.id));

  const productCountFor = (categoryId: number): number =>
    products.filter(p => (p.category_id ?? UNCATEGORIZED) === categoryId).length;

  // How many products actually sit in a cell. Zero-quantity rows are not "in"
  // it — that is the number the cell tab promises.
  const stockedCountFor = (locationId: number): number =>
    products.filter(p => (stockMap.get(stockKey(p.id, locationId)) ?? 0) !== 0).length;

  // Units already in use in this area, most common first. A fixed list would go
  // stale the day someone starts counting something by the crate.
  const unitSuggestions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of products) {
      const u = (p.unit || '').trim();
      if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u]) => u);
  }, [products]);

  /* ── What the Categorie / Aree modals are looking at ───────────────────────
     One switch, four lists. When the modal is on the area the page is showing,
     it reads and writes the page's own state so an edit lands behind it without
     a refetch; on any other area it works on the fetched copy. Every handler
     below goes through these, so there is one place where that choice is made
     rather than a branch in each. */
  const isForeign = manageArea !== activeArea;
  const mCategories = isForeign ? foreign.categories : categories;
  const mLocations = isForeign ? foreign.locations : locations;
  const mProducts = isForeign ? foreign.products : products;
  const mStock = isForeign ? foreign.stock : stock;

  const setMCategories = (updater: (prev: InventoryCategory[]) => InventoryCategory[]) => {
    if (isForeign) setForeign(f => ({ ...f, categories: updater(f.categories) }));
    else setCategories(updater);
  };
  const setMLocations = (updater: (prev: InventoryLocation[]) => InventoryLocation[]) => {
    if (isForeign) setForeign(f => ({ ...f, locations: updater(f.locations) }));
    else setLocations(updater);
  };
  const setMProducts = (updater: (prev: InventoryProduct[]) => InventoryProduct[]) => {
    if (isForeign) setForeign(f => ({ ...f, products: updater(f.products) }));
    else setProducts(updater);
  };

  const mStockMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of mStock) m.set(stockKey(s.product_id, s.location_id), s.quantity);
    return m;
  }, [mStock]);

  const mProductCountFor = (categoryId: number): number =>
    mProducts.filter(p => (p.category_id ?? UNCATEGORIZED) === categoryId).length;

  const mStockedCountFor = (locationId: number): number =>
    mProducts.filter(p => (mStockMap.get(stockKey(p.id, locationId)) ?? 0) !== 0).length;

  const manageModalOpen = categoriesModalOpen || locationsModalOpen;

  // Pull the other area in only when a modal is actually pointed at it.
  useEffect(() => {
    if (!manageModalOpen || !isForeign) return;
    let cancelled = false;
    setForeignLoading(true);
    Promise.all([
      getInventoryLocations(manageArea),
      getInventoryProducts(manageArea),
      getInventoryStock(manageArea),
      getInventoryCategories(manageArea),
    ])
      .then(([locs, prods, st, cats]) => {
        if (!cancelled) setForeign({ locations: locs, products: prods, stock: st, categories: cats });
      })
      .catch((err: any) => {
        if (!cancelled) showToast(err?.message || 'Errore caricamento area', 'error');
      })
      .finally(() => {
        if (!cancelled) setForeignLoading(false);
      });
    return () => { cancelled = true; };
  }, [manageModalOpen, isForeign, manageArea]);

  const openCategoriesModal = () => {
    setManageArea(activeArea);
    setEditingCategoryId(null);
    setCategoryDraftName('');
    setCategoriesModalOpen(true);
  };
  const openLocationsModal = () => {
    setManageArea(activeArea);
    setEditingLocationId(null);
    setLocationDraftName('');
    setLocationsModalOpen(true);
  };
  // Switching area inside a modal abandons whatever row was being renamed and
  // whatever name was half-typed — both belong to the area you just left, and a
  // draft carried over would be created in the wrong one.
  const switchManageArea = (next: InventoryArea) => {
    setManageArea(next);
    setEditingCategoryId(null);
    setEditingLocationId(null);
    setCategoryDraftName('');
    setLocationDraftName('');
    setDragCat(null);
    setDragLoc(null);
    // Drop the previous area's rows in the same tick as the switch. The fetch
    // below only starts after this render, so without it the list would show
    // the area you just left for a frame before the spinner appears.
    if (next !== activeArea) {
      setForeign({ categories: [], locations: [], products: [], stock: [] });
      setForeignLoading(true);
    } else {
      setForeignLoading(false);
    }
  };

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
      setSavedKeys(prev => new Set(prev).add(key));
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

  // Enter commits the field and moves to the next product, so a count is one
  // hand on the number pad instead of a reach for the mouse per shelf.
  const focusNext = (productId: number) => {
    const idx = orderedIds.current.indexOf(productId);
    const nextId = idx >= 0 ? orderedIds.current[idx + 1] : undefined;
    if (nextId == null) return;
    const el = qtyInputs.current.get(nextId);
    el?.focus();
    el?.select();
  };

  // ---------- Locations modal handlers ----------
  const handleAddLocation = async () => {
    if (!locationDraftName.trim()) return;
    try {
      const created = await createInventoryLocation({
        area: manageArea,
        name: locationDraftName.trim(),
        sort_order: mLocations.length,
      });
      setMLocations(prev => [...prev, created]);
      setLocationDraftName('');
      showToast('Area creata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione area', 'error');
    }
  };

  const handleSaveLocationEdit = async () => {
    if (editingLocationId == null || !editingLocationName.trim()) return;
    try {
      const sortOrder = mLocations.find(l => l.id === editingLocationId)?.sort_order ?? 0;
      const updated = await updateInventoryLocation(editingLocationId, {
        name: editingLocationName.trim(),
        sort_order: sortOrder,
      });
      setMLocations(prev => prev.map(l => (l.id === updated.id ? updated : l)));
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
      setMLocations(prev => prev.filter(l => l.id !== id));
      // The page's stock and cell tab only matter when the modal is editing the
      // area the page is showing; the other area is reloaded when you go to it.
      if (isForeign) {
        setForeign(f => ({ ...f, stock: f.stock.filter(s => s.location_id !== id) }));
      } else {
        setStock(prev => prev.filter(s => s.location_id !== id));
        if (activeLocationId === id) setActiveLocationId(null);
      }
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
        area: manageArea,
        name: categoryDraftName.trim(),
        sort_order: mCategories.length,
      });
      setMCategories(prev => [...prev, created]);
      setCategoryDraftName('');
      showToast('Categoria creata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione categoria', 'error');
    }
  };

  const handleSaveCategoryEdit = async () => {
    if (editingCategoryId == null || !editingCategoryName.trim()) return;
    try {
      const sortOrder = mCategories.find(c => c.id === editingCategoryId)?.sort_order ?? 0;
      const updated = await updateInventoryCategory(editingCategoryId, {
        name: editingCategoryName.trim(),
        sort_order: sortOrder,
      });
      setMCategories(prev => prev.map(c => (c.id === updated.id ? updated : c)));
      // Refresh products' category_name in-place where they referenced this category.
      setMProducts(prev => prev.map(p => p.category_id === updated.id ? { ...p, category_name: updated.name } : p));
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
      setMCategories(prev => prev.filter(c => c.id !== id));
      // Products keep existing — backend ON DELETE SET NULL clears their FK.
      setMProducts(prev => prev.map(p => p.category_id === id ? { ...p, category_id: null, category_name: null } : p));
      if (!isForeign && categoryFilter === id) setCategoryFilter(null);
      setConfirmDeleteCategoryId(null);
      showToast('Categoria eliminata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione categoria', 'error');
      setConfirmDeleteCategoryId(null);
    }
  };

  // ---------- Reordering ----------
  // The list is moved locally first, then every row whose position actually
  // changed is written back through the same PUT that renames it. On failure the
  // previous order is restored — a half-applied order is worse than none.
  const reorder = <T,>(list: T[], from: number, to: number): T[] => {
    const next = list.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  const handleDropCategory = async (to: number) => {
    const from = dragCat?.from;
    setDragCat(null);
    if (from == null || from === to) return;
    const previous = mCategories;
    const next = reorder(mCategories, from, to);
    setMCategories(() => next.map((c, i) => ({ ...c, sort_order: i })));
    try {
      await Promise.all(
        next
          .map((c, i) => (c.sort_order === i ? null : updateInventoryCategory(c.id, { name: c.name, sort_order: i })))
          .filter(Boolean) as Promise<InventoryCategory>[]
      );
    } catch (err: any) {
      setMCategories(() => previous);
      showToast(err?.message || 'Errore riordino categorie', 'error');
    }
  };

  const handleDropLocation = async (to: number) => {
    const from = dragLoc?.from;
    setDragLoc(null);
    if (from == null || from === to) return;
    const previous = mLocations;
    const next = reorder(mLocations, from, to);
    setMLocations(() => next.map((l, i) => ({ ...l, sort_order: i })));
    try {
      await Promise.all(
        next
          .map((l, i) => (l.sort_order === i ? null : updateInventoryLocation(l.id, { name: l.name, sort_order: i })))
          .filter(Boolean) as Promise<InventoryLocation>[]
      );
    } catch (err: any) {
      setMLocations(() => previous);
      showToast(err?.message || 'Errore riordino aree', 'error');
    }
  };

  // ---------- Product modal handlers ----------
  const openCreateProduct = (presetName?: string) => {
    setProductEditing(null);
    // Pre-select the currently filtered category, if any, for fast bulk-add.
    const presetCategory = (categoryFilter != null && categoryFilter !== UNCATEGORIZED) ? categoryFilter : null;
    setProductForm({ name: presetName ?? '', unit: '', notes: '', category_id: presetCategory });
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

  // ---------- Cross-area search ----------
  const searchEverywhere = async () => {
    setCrossArea({ loading: true, results: [] });
    try {
      const all = await getInventoryProducts();
      const q = search.trim().toLowerCase();
      setCrossArea({
        loading: false,
        results: all.filter(p => p.area !== activeArea && p.name.toLowerCase().includes(q)),
      });
    } catch (err: any) {
      setCrossArea(null);
      showToast(err?.message || 'Errore ricerca', 'error');
    }
  };

  // ---------- Render ----------

  const isTotale = activeLocationId == null;
  const activeLocation = locations.find(l => l.id === activeLocationId) ?? null;
  const searchTerm = search.trim();

  const areaOptions = (Object.values(InventoryArea) as InventoryArea[]).map(area => ({
    value: area,
    label: AREA_LABEL[area],
    icon: AREA_ICON[area],
  }));

  // Everything that manages the inventory rather than counts it. One list, two
  // containers: a dropdown where there is a pointer, a bottom sheet where there
  // is a thumb.
  const manageActions = [
    { icon: Printer, label: 'Stampa inventario', meta: null as string | null, onClick: () => setPrintModalOpen(true) },
    ...(canEdit
      ? [
          { icon: Tag, label: 'Gestisci categorie', meta: String(categories.length), onClick: openCategoriesModal },
          { icon: Container, label: 'Gestisci celle e aree', meta: String(locations.length), onClick: openLocationsModal },
        ]
      : []),
  ];

  // Sits in both management modals' subheader. Changing area here does not move
  // the page behind: you can tidy up Sala's shelves and go back to counting
  // Cucina exactly where you left off.
  const manageAreaSwitcher = (
    <SegmentedControl
      value={manageArea}
      onChange={(next: InventoryArea) => switchManageArea(next)}
      options={areaOptions}
      ariaLabel="Area da gestire"
      equalWidth={false}
    />
  );

  const menuTrigger = (
    <button
      ref={menuTriggerRef}
      type="button"
      onClick={() => setMenuOpen(v => !v)}
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      aria-label="Gestisci inventario"
      title="Gestisci inventario"
      className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
    >
      <MoreVertical className="h-4 w-4" aria-hidden />
    </button>
  );

  const cellOptions = [
    { value: 'ALL', label: 'Totale', badge: products.length, badgeTone: 'neutral' as const },
    ...locations.map(loc => ({
      value: String(loc.id),
      label: toTitleCase(loc.name),
      badge: stockedCountFor(loc.id),
      badgeTone: 'neutral' as const,
    })),
  ];

  const categoryOptions = [
    { value: 'ALL', label: 'Tutte', badge: products.length, badgeTone: 'neutral' as const },
    ...categories.map(cat => ({
      value: String(cat.id),
      label: cat.name,
      badge: productCountFor(cat.id),
      badgeTone: 'neutral' as const,
    })),
    ...(products.some(p => p.category_id == null)
      ? [{ value: String(UNCATEGORIZED), label: 'Senza categoria', badge: productCountFor(UNCATEGORIZED), badgeTone: 'neutral' as const }]
      : []),
  ];

  const renderRow = (p: InventoryProduct, firstInGroup: boolean) => {
    const qty = quantityFor(p.id);
    const breakdown = isTotale ? breakdownFor(p.id) : [];
    const key = activeLocationId != null ? stockKey(p.id, activeLocationId) : '';
    const isPending = !!key && pendingKeys.has(key);
    const isSaved = !!key && savedKeys.has(key);
    const lowStock = isLowStock(p.id);

    return (
      <div
        key={p.id}
        className={`relative flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 sm:flex-nowrap sm:px-5 ${
          firstInGroup ? '' : 'border-t border-[var(--ds-border)]'
        } ${lowStock ? 'bg-[var(--ds-critical-tint)]' : ''}`}
      >
        {/* The marker is the second signal on a low-stock row, so the state
            survives a colour-blind reader even before the pill is read. */}
        {lowStock && (
          <span className="absolute inset-y-0 left-0 w-[3px] bg-[var(--ds-critical-solid)]" aria-hidden />
        )}

        {/* In a cell view the name takes the whole first line on a phone: a
            176px stepper and two round actions leave it about seventy pixels
            otherwise, which is four characters of "Costine agnello tagliate". */}
        <div className={`min-w-0 flex-1 ${isTotale ? '' : 'basis-full sm:basis-auto'}`}>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={`truncate text-[15px] font-medium ${
                lowStock ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
              }`}
            >
              {p.name}
            </span>
            {lowStock && (
              <StatusPill tone="critical">
                <AlertTriangle className="h-3 w-3" aria-hidden />
                Scorta bassa
              </StatusPill>
            )}
            {p.unit && (
              <span className="text-[13px] text-[var(--ds-text-muted)]">{p.unit}</span>
            )}
            {isPending && <StatusPill tone="info">Salvo…</StatusPill>}
            {!isPending && isSaved && (
              <StatusPill tone="positive">
                <Check className="h-3 w-3" aria-hidden />
                Aggiornato
              </StatusPill>
            )}
          </div>
          {/* Category under the name in a cell view: the bands are gone there,
              so it is the only thing saying what the product is. */}
          {!isTotale && p.category_name && (
            <div className="mt-0.5 truncate text-[13px] text-[var(--ds-text-muted)]">{p.category_name}</div>
          )}
          {/* Where the stock lives. A column of its own from md up; under the
              name on a phone, where a third column would crush the name. */}
          {isTotale && breakdown.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1 md:hidden">
              {breakdown.map(b => (
                <StatusPill key={b.locationName} tone="neutral">
                  {toTitleCase(b.locationName)}
                  <span className="font-semibold tabular-nums">{b.quantity}</span>
                </StatusPill>
              ))}
            </div>
          )}
          {p.notes && !isTotale && (
            <div className="mt-0.5 truncate text-[13px] text-[var(--ds-text-muted)]">{p.notes}</div>
          )}
        </div>

        {isTotale && (
          <div className="hidden min-w-0 flex-wrap items-center justify-end gap-1 md:flex md:w-[260px] lg:w-[320px]">
            {breakdown.map(b => (
              <StatusPill key={b.locationName} tone="neutral">
                {toTitleCase(b.locationName)}
                <span className="font-semibold tabular-nums">{b.quantity}</span>
              </StatusPill>
            ))}
          </div>
        )}

        {isTotale ? (
          <div
            className={`w-14 flex-shrink-0 text-right text-[17px] font-semibold tabular-nums ${
              lowStock ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
            }`}
          >
            {qty}
          </div>
        ) : (
          // The counting control. Not ds/Stepper: that one owns its value and
          // fires on every keystroke, and here each change is a movement posted
          // to the server — the field has to commit on blur, not on typing.
          <div className="flex flex-shrink-0 items-center gap-1.5" role="group" aria-label={`Quantità ${p.name}`}>
            {canEdit && (
              <button
                type="button"
                onClick={() => handleStep(p.id, -1)}
                disabled={isPending}
                aria-label={`${p.name}: togli uno`}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[20px] font-medium leading-none text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                −
              </button>
            )}
            <input
              type="number"
              step="any"
              inputMode="decimal"
              defaultValue={qty}
              key={`${p.id}-${activeLocationId}-${qty}`}
              ref={el => {
                if (el) qtyInputs.current.set(p.id, el);
                else qtyInputs.current.delete(p.id);
              }}
              aria-label={`Quantità ${p.name}`}
              onFocus={e => e.currentTarget.select()}
              onBlur={(e) => {
                if (canEdit) {
                  handleSetQuantity(p.id, e.target.value);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  e.currentTarget.blur();
                  focusNext(p.id);
                } else if (e.key === 'Escape') {
                  // Put the served value back before blurring, so leaving the
                  // row cannot post a movement you were in the middle of typing.
                  e.currentTarget.value = String(qty);
                  e.currentTarget.blur();
                }
              }}
              readOnly={!canEdit || isPending}
              className="ds-stepper-input h-11 w-[76px] rounded-full bg-[var(--ds-surface-row)] px-2 text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            />
            {canEdit && (
              <button
                type="button"
                onClick={() => handleStep(p.id, 1)}
                disabled={isPending}
                aria-label={`${p.name}: aggiungi uno`}
                className="inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[20px] font-medium leading-none text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                +
              </button>
            )}
          </div>
        )}

        {canEdit && (
          <div className="ml-auto flex w-[84px] flex-shrink-0 items-center justify-end gap-0.5">
            <button
              type="button"
              onClick={() => openEditProduct(p)}
              className={rowIconButton}
              aria-label={`Modifica ${p.name}`}
              title="Modifica"
            >
              <Pencil className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setConfirmDeleteProductId(p.id)}
              className={rowIconButtonDanger}
              aria-label={`Elimina ${p.name}`}
              title="Elimina"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    // La pagina possiede il proprio scorrimento invece di lasciar scorrere il
    // contenitore dell'app: è quello che tiene il contenuto SOPRA la barra di
    // navigazione flottante del telefono. Il contenitore dell'app le riserva il
    // suo spazio (.pb-mobile-nav), quindi un riquadro alto quanto quel box
    // finisce già sopra la barra e le card si tagliano lì, invece di passarle
    // dietro e ricomparire sotto.
    <div className="flex h-full min-h-0 flex-col">
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6 lg:p-8">
      {/* Page head — what you are looking at, and the two numbers that decide
          whether you need to do something about it. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center justify-between gap-2 lg:flex-1">
          <div className="min-w-0">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] sm:text-[26px]">
              Inventario
            </h1>
          </div>
          {/* On a phone the top bar's + is a reach away from where the thumb is
              working, so the action you take most from this page sits with the
              title. On desktop the + in the top bar is the only entry point. */}
          {!isWide && (
            <div className="flex flex-shrink-0 items-center gap-2">
              {canEdit && (
                <button type="button" onClick={() => openCreateProduct()} className={`${dsButton.primary} px-4`}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Nuovo prodotto
                </button>
              )}
              {menuTrigger}
            </div>
          )}
        </div>

        <div className="flex flex-shrink-0 items-center gap-2">
          <StatStrip
            layout="stacked"
            className="min-w-0 flex-1 lg:w-[300px] lg:flex-none"
            stats={[
              { value: products.length, label: 'prodotti' },
              {
                value: lowStockProducts.length,
                label: 'scorta bassa',
                tone: lowStockProducts.length > 0 ? 'critical' : 'neutral',
                tint: lowStockProducts.length > 0,
                onClick: lowStockProducts.length > 0 ? () => setOnlyLowStock(v => !v) : undefined,
                title: onlyLowStock ? 'Mostra tutti i prodotti' : 'Mostra solo i prodotti sotto soglia',
              },
            ]}
          />
          {/* Everything you do to the inventory rather than in it. A dropdown on
              a pointer, an action sheet on touch — the same entries either way. */}
          {isWide && (
            <div className="relative flex-shrink-0">
              {menuTrigger}
              {menuOpen && (
                <div
                  ref={menuRef}
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-2 w-[264px] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
                >
                  {manageActions.map(a => (
                    <button
                      key={a.label}
                      type="button"
                      role="menuitem"
                      onClick={() => { setMenuOpen(false); a.onClick(); }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                    >
                      <a.icon className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{a.label}</span>
                      {a.meta != null && (
                        <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">{a.meta}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* The two scopes, at opposite ends: which area you are in, and which of
          its cells you are looking at. Stacked full width on a phone. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex-shrink-0">
          <SegmentedControl
            value={activeArea}
            onChange={(next: InventoryArea) => setActiveArea(next)}
            options={areaOptions}
            ariaLabel="Area dell'inventario"
            // Segments start from their own text width and share what is left
            // over: with equal widths "Cucina" plus its icon is the longest of
            // the three and gets clipped to fit "Bar".
            equalWidth={false}
          />
        </div>
        {/* min-w-0 so the track can actually shrink and scroll — a flex child
            defaults to min-width:auto and would push the row wider instead. */}
        <div className="min-w-0">
          <SegmentedControl
            value={activeLocationId == null ? 'ALL' : String(activeLocationId)}
            onChange={v => setActiveLocationId(v === 'ALL' ? null : Number(v))}
            options={cellOptions}
            ariaLabel="Cella o ripiano"
            equalWidth={false}
            overflow="scroll"
          />
        </div>
      </div>

      {/* Search and the category chips are one act — you narrow by name or by
          course, rarely by both — so from lg they share a line. Below that the
          field would be left with about a third of a phone's width, so they
          stack. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <SearchField
          value={search}
          onChange={setSearch}
          placeholder="Cerca prodotto"
          ariaLabel="Cerca prodotto"
          className="min-w-0 lg:w-[260px] lg:flex-shrink-0"
        />
        {categoryOptions.length > 1 && (
          <div className="min-w-0 lg:flex-1">
            <SegmentedControl
              value={categoryFilter == null ? 'ALL' : String(categoryFilter)}
              onChange={v => setCategoryFilter(v === 'ALL' ? null : Number(v))}
              options={categoryOptions}
              ariaLabel="Filtra per categoria"
              equalWidth={false}
              overflow="scroll"
              size="sm"
            />
          </div>
        )}
        {/* Edits the row it sits at the end of. Dashed, so it reads as changing
            the chips rather than as an eighth filter among them. Pointer only —
            on touch the same thing lives in the sheet. */}
        {canEdit && isWide && categoryOptions.length > 1 && (
          <button
            type="button"
            onClick={openCategoriesModal}
            className="inline-flex h-10 flex-shrink-0 items-center gap-2 rounded-full border border-dashed border-[var(--ds-border-strong)] px-4 text-[14px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:border-solid hover:bg-[var(--ds-surface)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Pencil className="h-3.5 w-3.5" aria-hidden />
            Modifica
          </button>
        )}
      </div>

      {/* What is about to run out, named. The list below can be scrolled past;
          this cannot. */}
      {!isLoading && !error && lowStockProducts.length > 0 && (
        <Callout
          tone="critical"
          icon={AlertTriangle}
          title={`${plural(lowStockProducts.length, 'prodotto', 'prodotti')} sotto soglia (≤ ${LOW_STOCK_THRESHOLD})`}
          action={
            <button
              type="button"
              onClick={() => setOnlyLowStock(v => !v)}
              className="inline-flex h-10 items-center rounded-full bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-critical-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {onlyLowStock ? 'Mostra tutti' : 'Mostra solo questi'}
            </button>
          }
        >
          <span className="text-[14px]">
            {lowStockProducts.slice(0, 6).map(p => p.name).join(' · ')}
            {lowStockProducts.length > 6 && ` · +${lowStockProducts.length - 6} altri`}
          </span>
        </Callout>
      )}

      {isLoading && <SkeletonProductList count={7} />}

      {!isLoading && error && (
        <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>
      )}

      {/* Empty — nothing in the area at all */}
      {!isLoading && !error && products.length === 0 && (
        <EmptyState
          icon={Boxes}
          action={
            canEdit ? (
              <div className="flex flex-col items-stretch gap-2 sm:flex-row">
                <button type="button" onClick={openLocationsModal} className={dsButton.secondary}>
                  Gestisci aree
                </button>
                <button type="button" onClick={() => openCreateProduct()} className={dsButton.primary}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Aggiungi il primo
                </button>
              </div>
            ) : undefined
          }
        >
          <span className="mb-1 block text-[16px] font-semibold text-[var(--ds-text-primary)]">
            Nessun prodotto in {AREA_LABEL[activeArea]}
          </span>
          Crea le celle o i ripiani dell'area, poi aggiungi i primi prodotti da contare.
        </EmptyState>
      )}

      {/* Empty — the search found nothing here */}
      {!isLoading && !error && products.length > 0 && groups.length === 0 && searchTerm !== '' && (
        <div className="space-y-3">
          <EmptyState
            icon={Search}
            action={
              <div className="flex flex-col items-stretch gap-2 sm:flex-row">
                <button
                  type="button"
                  onClick={searchEverywhere}
                  disabled={crossArea?.loading}
                  className={dsButton.secondary}
                >
                  {crossArea?.loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                  Cerca in tutte le aree
                </button>
                {canEdit && (
                  <button type="button" onClick={() => openCreateProduct(searchTerm)} className={dsButton.primary}>
                    <Plus className="h-4 w-4" aria-hidden />
                    Crea “{searchTerm}”
                  </button>
                )}
              </div>
            }
          >
            <span className="mb-1 block text-[16px] font-semibold text-[var(--ds-text-primary)]">
              Nessun risultato per “{searchTerm}”
            </span>
            In {AREA_LABEL[activeArea]} non c'è un prodotto con questo nome.
          </EmptyState>

          {crossArea && !crossArea.loading && (
            crossArea.results.length === 0 ? (
              <p className="text-center text-[14px] text-[var(--ds-text-muted)]">
                Nemmeno nelle altre aree.
              </p>
            ) : (
              <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                {crossArea.results.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setActiveArea(p.area)}
                    className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] sm:px-5 ${
                      i > 0 ? 'border-t border-[var(--ds-border)]' : ''
                    }`}
                  >
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                      {p.name}
                    </span>
                    <StatusPill tone="neutral">{AREA_LABEL[p.area]}</StatusPill>
                  </button>
                ))}
              </div>
            )
          )}
        </div>
      )}

      {/* Empty — the filters excluded everything */}
      {!isLoading && !error && products.length > 0 && groups.length === 0 && searchTerm === '' && (
        <EmptyState
          icon={Boxes}
          action={
            <button
              type="button"
              onClick={() => { setCategoryFilter(null); setOnlyLowStock(false); }}
              className={dsButton.secondary}
            >
              Rimuovi i filtri
            </button>
          }
        >
          Nessun prodotto con questi filtri.
        </EmptyState>
      )}

      {/* The list */}
      {!isLoading && !error && groups.length > 0 && (
        <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          {/* Column names, from md up. On a phone the row carries its own
              labels, so a header would be a line of text with nothing under it. */}
          <div className="hidden items-center gap-3 px-5 py-3 text-[13px] text-[var(--ds-text-muted)] md:flex">
            <span className="min-w-0 flex-1">Prodotto</span>
            {isTotale && <span className="w-[260px] text-right lg:w-[320px]">Dove</span>}
            <span className={isTotale ? 'w-14 text-right' : canEdit ? 'w-[176px] text-right' : 'w-[76px] text-right'}>
              {isTotale ? 'Totale' : `Quantità in ${toTitleCase(activeLocation?.name ?? '')}`}
            </span>
            {canEdit && <span className="w-[84px]" aria-hidden />}
          </div>

          {groups.map(group => {
            const lowInGroup = group.products.filter(p => isLowStock(p.id)).length;
            return (
              <div key={group.id}>
                <div className="border-t border-[var(--ds-border)] bg-[var(--ds-surface-row)] px-4 sm:px-5">
                  <SectionHeader
                    tone={lowInGroup > 0 ? 'attention' : 'muted'}
                    meta={plural(group.products.length, 'prodotto', 'prodotti')}
                    action={
                      lowInGroup > 0 ? (
                        <StatusPill tone="critical">{lowInGroup} sotto soglia</StatusPill>
                      ) : undefined
                    }
                  >
                    {group.name}
                  </SectionHeader>
                </div>
                {group.products.map((p, i) => renderRow(p, i === 0))}
              </div>
            );
          })}

          {!isTotale && canEdit && (
            <div className="border-t border-[var(--ds-border)] px-4 py-3 text-[13px] text-[var(--ds-text-muted)] sm:px-5">
              Invio conferma e passa al prodotto successivo · Esc annulla la riga
            </div>
          )}
        </div>
      )}

      {/* ----- Manage sheet (touch) ----- */}
      <Sheet
        open={menuOpen && !isWide}
        onClose={() => setMenuOpen(false)}
        title="Gestisci inventario"
        subtitle={AREA_LABEL[activeArea]}
        ariaLabel="Gestisci inventario"
        bodyClassName="px-4 py-4"
        footer={
          <button type="button" onClick={() => setMenuOpen(false)} className={dsButton.secondary}>
            Chiudi
          </button>
        }
      >
        <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          {manageActions.map((a, i) => (
            <button
              key={a.label}
              type="button"
              onClick={() => { setMenuOpen(false); a.onClick(); }}
              className={`flex min-h-[56px] w-full items-center gap-3 px-4 text-left text-[16px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)] ${
                i > 0 ? 'border-t border-[var(--ds-border)]' : ''
              }`}
            >
              <a.icon className="h-5 w-5 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{a.label}</span>
              {a.meta != null && (
                <span className="flex-shrink-0 text-[15px] tabular-nums text-[var(--ds-text-muted)]">{a.meta}</span>
              )}
            </button>
          ))}
        </div>
      </Sheet>

      {/* ----- Locations modal ----- */}
      <ModalShell
        open={locationsModalOpen}
        onClose={() => setLocationsModalOpen(false)}
        title="Aree"
        subtitle="Celle e ripiani in cui si conta la merce"
        size="sm"
        closeOnEscape
        subheader={manageAreaSwitcher}
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footer={
          canEdit ? (
            <>
              <input
                type="text"
                value={locationDraftName}
                onChange={(e) => setLocationDraftName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddLocation(); }}
                placeholder="Nome area (es. Cella 4)"
                aria-label="Nome della nuova area"
                className={`${dsInput} sm:w-56`}
              />
              <button
                type="button"
                onClick={handleAddLocation}
                disabled={!locationDraftName.trim()}
                className={dsButton.primary}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Aggiungi
              </button>
            </>
          ) : undefined
        }
      >
        {foreignLoading ? (
          <p className="flex items-center justify-center gap-2 py-6 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Carico {AREA_LABEL[manageArea]}…
          </p>
        ) : mLocations.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-[var(--ds-text-muted)]">
            Nessuna area in {AREA_LABEL[manageArea]}. Aggiungine una qui sotto.
          </p>
        ) : (
          <ul className="space-y-2">
            {mLocations.map((loc, i) => (
              <li
                key={loc.id}
                draggable={canEdit && editingLocationId == null}
                onDragStart={() => setDragLoc({ from: i, over: i })}
                onDragOver={(e) => { e.preventDefault(); setDragLoc(d => (d ? { ...d, over: i } : d)); }}
                onDrop={(e) => { e.preventDefault(); handleDropLocation(i); }}
                onDragEnd={() => setDragLoc(null)}
                className={`flex items-center gap-2 rounded-[16px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-colors ${
                  dragLoc?.over === i && dragLoc.from !== i ? 'bg-[var(--ds-arriving-tint)]' : ''
                }`}
              >
                {editingLocationId === loc.id ? (
                  <>
                    <input
                      type="text"
                      value={editingLocationName}
                      onChange={(e) => setEditingLocationName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveLocationEdit(); }}
                      className={`${dsInput} min-w-0 flex-1`}
                      aria-label={`Nuovo nome per ${loc.name}`}
                      autoFocus
                    />
                    <button type="button" onClick={handleSaveLocationEdit} className={dsButton.primary}>Salva</button>
                    <button
                      type="button"
                      onClick={() => { setEditingLocationId(null); setEditingLocationName(''); }}
                      className={dsButton.quiet}
                    >
                      Annulla
                    </button>
                  </>
                ) : (
                  <>
                    {canEdit && (
                      <GripVertical
                        className="h-4 w-4 flex-shrink-0 cursor-grab text-[var(--ds-text-subtle)] active:cursor-grabbing"
                        aria-hidden
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                        {toTitleCase(loc.name)}
                      </div>
                      <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                        {plural(mStockedCountFor(loc.id), 'prodotto', 'prodotti')} con giacenza
                      </div>
                    </div>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setEditingLocationId(loc.id); setEditingLocationName(loc.name); }}
                          className={rowIconButton}
                          aria-label={`Modifica ${loc.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteLocationId(loc.id)}
                          className={rowIconButtonDanger}
                          aria-label={`Elimina ${loc.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </ModalShell>

      {/* ----- Categories modal ----- */}
      <ModalShell
        open={categoriesModalOpen}
        onClose={() => setCategoriesModalOpen(false)}
        title="Categorie"
        subtitle="Trascina per riordinare l'elenco prodotti"
        size="sm"
        closeOnEscape
        subheader={manageAreaSwitcher}
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footer={
          canEdit ? (
            <>
              <input
                type="text"
                value={categoryDraftName}
                onChange={(e) => setCategoryDraftName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddCategory(); }}
                placeholder="Nome categoria (es. Verdure)"
                aria-label="Nome della nuova categoria"
                className={`${dsInput} sm:w-56`}
              />
              <button
                type="button"
                onClick={handleAddCategory}
                disabled={!categoryDraftName.trim()}
                className={dsButton.primary}
              >
                <Plus className="h-4 w-4" aria-hidden />
                Aggiungi
              </button>
            </>
          ) : undefined
        }
      >
        {foreignLoading ? (
          <p className="flex items-center justify-center gap-2 py-6 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Carico {AREA_LABEL[manageArea]}…
          </p>
        ) : mCategories.length === 0 ? (
          <p className="py-6 text-center text-[14px] text-[var(--ds-text-muted)]">
            Nessuna categoria in {AREA_LABEL[manageArea]}. Aggiungine una qui sotto.
          </p>
        ) : (
          <ul className="space-y-2">
            {mCategories.map((cat, i) => (
              <li
                key={cat.id}
                draggable={canEdit && editingCategoryId == null}
                onDragStart={() => setDragCat({ from: i, over: i })}
                onDragOver={(e) => { e.preventDefault(); setDragCat(d => (d ? { ...d, over: i } : d)); }}
                onDrop={(e) => { e.preventDefault(); handleDropCategory(i); }}
                onDragEnd={() => setDragCat(null)}
                className={`flex items-center gap-2 rounded-[16px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-colors ${
                  dragCat?.over === i && dragCat.from !== i ? 'bg-[var(--ds-arriving-tint)]' : ''
                }`}
              >
                {editingCategoryId === cat.id ? (
                  <>
                    <input
                      type="text"
                      value={editingCategoryName}
                      onChange={(e) => setEditingCategoryName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleSaveCategoryEdit(); }}
                      className={`${dsInput} min-w-0 flex-1`}
                      aria-label={`Nuovo nome per ${cat.name}`}
                      autoFocus
                    />
                    <button type="button" onClick={handleSaveCategoryEdit} className={dsButton.primary}>Salva</button>
                    <button
                      type="button"
                      onClick={() => { setEditingCategoryId(null); setEditingCategoryName(''); }}
                      className={dsButton.quiet}
                    >
                      Annulla
                    </button>
                  </>
                ) : (
                  <>
                    {canEdit && (
                      <GripVertical
                        className="h-4 w-4 flex-shrink-0 cursor-grab text-[var(--ds-text-subtle)] active:cursor-grabbing"
                        aria-hidden
                      />
                    )}
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                      {cat.name}
                    </span>
                    <span className="flex-shrink-0 text-[13px] text-[var(--ds-text-muted)]">
                      {plural(mProductCountFor(cat.id), 'prodotto', 'prodotti')}
                    </span>
                    {canEdit && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setEditingCategoryId(cat.id); setEditingCategoryName(cat.name); }}
                          className={rowIconButton}
                          aria-label={`Modifica ${cat.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteCategoryId(cat.id)}
                          className={rowIconButtonDanger}
                          aria-label={`Elimina ${cat.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </ModalShell>

      {/* ----- Product modal ----- */}
      <ModalShell
        open={productModalOpen}
        onClose={() => setProductModalOpen(false)}
        title={productEditing ? 'Modifica prodotto' : 'Nuovo prodotto'}
        subtitle={
          productEditing
            ? `${AREA_LABEL[activeArea]} · ${productEditing.name}`
            : `${AREA_LABEL[activeArea]} · sarà disponibile in tutte le aree`
        }
        size="sm"
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setProductModalOpen(false)} className={dsButton.secondary}>
              Annulla
            </button>
            <button type="button" onClick={handleSaveProduct} className={dsButton.primary}>
              Salva prodotto
            </button>
          </>
        }
      >
        <FormCard className="space-y-4">
          <Field label="Nome" htmlFor="inv-name" required>
            <input
              id="inv-name"
              type="text"
              value={productForm.name}
              onChange={(e) => setProductForm(f => ({ ...f, name: e.target.value }))}
              placeholder="Es. Pomodori pelati"
              className={dsInput}
              autoFocus
            />
          </Field>

          {/* One per row, not side by side: at half the modal's width the unit
              chips wrapped two to a line and the select clipped "Senza
              categoria" mid-word. */}
          <div className="space-y-4">
            <Field label="Unità di misura" htmlFor="inv-unit">
              <input
                id="inv-unit"
                type="text"
                value={productForm.unit}
                onChange={(e) => setProductForm(f => ({ ...f, unit: e.target.value }))}
                placeholder="kg, lt, pz…"
                className={dsInput}
              />
              {/* The units this area already uses — typing them again is how two
                  spellings of the same thing end up in the list. */}
              {unitSuggestions.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {unitSuggestions.map(u => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setProductForm(f => ({ ...f, unit: u }))}
                      className="inline-flex h-8 items-center rounded-full bg-[var(--ds-surface-row)] px-3 text-[13px] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]"
                    >
                      {u}
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <Field
              label="Categoria"
              htmlFor="inv-category"
              hint={categories.length === 0 ? 'Nessuna categoria. Aggiungine una da "Categorie".' : undefined}
            >
              <select
                id="inv-category"
                value={productForm.category_id ?? ''}
                onChange={(e) => setProductForm(f => ({ ...f, category_id: e.target.value ? Number(e.target.value) : null }))}
                className={dsSelect}
              >
                <option value="">Senza categoria</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="Note" htmlFor="inv-notes">
            <textarea
              id="inv-notes"
              value={productForm.notes}
              onChange={(e) => setProductForm(f => ({ ...f, notes: e.target.value }))}
              rows={3}
              placeholder="Fornitore, soglia, dove si trova…"
              className={dsTextarea}
            />
          </Field>
        </FormCard>
      </ModalShell>

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

      {/* ----- Confirm delete category ----- */}
      <ModalShell
        open={confirmDeleteCategoryId != null}
        onClose={() => setConfirmDeleteCategoryId(null)}
        title="Eliminare la categoria?"
        size="sm"
        closeOnEscape
        className="z-[60]"
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setConfirmDeleteCategoryId(null)} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={() => confirmDeleteCategoryId != null && handleDeleteCategory(confirmDeleteCategoryId)}
              className={dsButton.critical}
            >
              Elimina
            </button>
          </>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-secondary)]">
          I prodotti associati resteranno, ma diventeranno "Senza categoria".
        </p>
      </ModalShell>

      {/* ----- Confirm delete location ----- */}
      <ModalShell
        open={confirmDeleteLocationId != null}
        onClose={() => setConfirmDeleteLocationId(null)}
        title="Eliminare l'area?"
        size="sm"
        closeOnEscape
        className="z-[60]"
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setConfirmDeleteLocationId(null)} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={() => confirmDeleteLocationId != null && handleDeleteLocation(confirmDeleteLocationId)}
              className={dsButton.critical}
            >
              Elimina
            </button>
          </>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-secondary)]">
          Tutte le quantità in quest'area verranno cancellate. L'azione non è reversibile.
        </p>
      </ModalShell>

      {/* ----- Confirm delete product ----- */}
      <ModalShell
        open={confirmDeleteProductId != null}
        onClose={() => setConfirmDeleteProductId(null)}
        title="Eliminare il prodotto?"
        size="sm"
        closeOnEscape
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={() => setConfirmDeleteProductId(null)} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={() => confirmDeleteProductId != null && handleDeleteProduct(confirmDeleteProductId)}
              className={dsButton.critical}
            >
              Elimina
            </button>
          </>
        }
      >
        <p className="text-[15px] text-[var(--ds-text-secondary)]">
          Verrà rimosso dall'inventario in tutte le aree. L'azione non è reversibile.
        </p>
      </ModalShell>
    </div>
    </div>
  );
};

export default Inventory;
