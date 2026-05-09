import React, { useEffect, useMemo, useState } from 'react';
import {
  InventoryArea,
  InventoryLocation,
  InventoryProduct,
  InventoryStockRow,
  InventoryMovementReason,
} from '../types';
import {
  getInventoryLocations,
  getInventoryProducts,
  getInventoryStock,
  createInventoryLocation,
  updateInventoryLocation,
  deleteInventoryLocation,
  createInventoryProduct,
  updateInventoryProduct,
  deleteInventoryProduct,
  postInventoryMovement,
} from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import {
  Loader2, Plus, Minus, Pencil, Trash2, X, Settings, Boxes,
  ChefHat, Wine, GlassWater, AlertTriangle,
} from 'lucide-react';

interface Props {
  showToast: (message: string, type?: 'success' | 'error' | 'info') => void;
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

export const Inventory: React.FC<Props> = ({ showToast }) => {
  const { hasPermission } = useAuth();
  const canEdit = hasPermission('inventory:full');

  const [activeArea, setActiveArea] = useState<InventoryArea>(InventoryArea.CUCINA);
  // null = "Totale" tab (sum across all locations of the area)
  const [activeLocationId, setActiveLocationId] = useState<number | null>(null);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  const [products, setProducts] = useState<InventoryProduct[]>([]);
  const [stock, setStock] = useState<InventoryStockRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Locations modal
  const [locationsModalOpen, setLocationsModalOpen] = useState(false);
  const [locationDraftName, setLocationDraftName] = useState('');
  const [editingLocationId, setEditingLocationId] = useState<number | null>(null);
  const [editingLocationName, setEditingLocationName] = useState('');
  const [confirmDeleteLocationId, setConfirmDeleteLocationId] = useState<number | null>(null);

  // Product create/edit modal
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [productEditing, setProductEditing] = useState<InventoryProduct | null>(null);
  const [productForm, setProductForm] = useState<{ name: string; unit: string; notes: string }>({ name: '', unit: '', notes: '' });
  const [confirmDeleteProductId, setConfirmDeleteProductId] = useState<number | null>(null);

  // Per-row pending state for the +/- stepper buttons so the user gets immediate
  // feedback while the request is in flight. Keyed by stockKey.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());

  const [search, setSearch] = useState('');

  // Load everything for the active area whenever it changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    Promise.all([
      getInventoryLocations(activeArea),
      getInventoryProducts(activeArea),
      getInventoryStock(activeArea),
    ])
      .then(([locs, prods, st]) => {
        if (cancelled) return;
        setLocations(locs);
        setProducts(prods);
        setStock(st);
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

  // For a product, the quantity in the active location, or the total across
  // all locations when "Totale" is selected.
  const quantityFor = (productId: number): number => {
    if (activeLocationId != null) {
      return stockMap.get(stockKey(productId, activeLocationId)) ?? 0;
    }
    let total = 0;
    for (const loc of locations) {
      total += stockMap.get(stockKey(productId, loc.id)) ?? 0;
    }
    return total;
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
    if (!q) return products;
    return products.filter(p => p.name.toLowerCase().includes(q));
  }, [products, search]);

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
      showToast('Seleziona una cella per modificare le quantità', 'info');
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
      showToast('Cella creata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione cella', 'error');
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
      showToast('Cella aggiornata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore aggiornamento cella', 'error');
    }
  };

  const handleDeleteLocation = async (id: number) => {
    try {
      await deleteInventoryLocation(id);
      setLocations(prev => prev.filter(l => l.id !== id));
      setStock(prev => prev.filter(s => s.location_id !== id));
      if (activeLocationId === id) setActiveLocationId(null);
      setConfirmDeleteLocationId(null);
      showToast('Cella eliminata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore eliminazione cella', 'error');
      setConfirmDeleteLocationId(null);
    }
  };

  // ---------- Product modal handlers ----------
  const openCreateProduct = () => {
    setProductEditing(null);
    setProductForm({ name: '', unit: '', notes: '' });
    setProductModalOpen(true);
  };
  const openEditProduct = (p: InventoryProduct) => {
    setProductEditing(p);
    setProductForm({ name: p.name, unit: p.unit || '', notes: p.notes || '' });
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
        });
        setProducts(prev => prev.map(p => (p.id === updated.id ? updated : p)));
        showToast('Prodotto aggiornato', 'success');
      } else {
        const created = await createInventoryProduct({
          area: activeArea,
          name,
          unit: productForm.unit.trim() || null,
          notes: productForm.notes.trim() || null,
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
    <div className="p-4 lg:p-8 max-w-6xl mx-auto pb-24 lg:pb-8">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-fg)]">Inventario</h2>
          <p className="text-sm text-[var(--color-fg-muted)] mt-0.5">
            Gestisci la merce per Cucina, Sala e Bar.
          </p>
        </div>
      </div>

      {/* Area tabs */}
      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.values(InventoryArea) as InventoryArea[]).map(area => (
          <button
            key={area}
            onClick={() => setActiveArea(area)}
            className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[14px] font-medium border transition-colors ${
              activeArea === area
                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                : 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-line)] hover:border-[var(--color-fg)]'
            }`}
          >
            {AREA_ICON[area]}
            {AREA_LABEL[area]}
          </button>
        ))}
      </div>

      {/* Location tabs (always show "Totale", then each location, then "Gestisci celle") */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setActiveLocationId(null)}
          className={`px-3 py-1.5 rounded-md text-[13px] font-medium border transition-colors ${
            isTotale
              ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)] border-[var(--color-fg)]'
              : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
          }`}
        >
          Totale
        </button>
        {locations.map(loc => (
          <button
            key={loc.id}
            onClick={() => setActiveLocationId(loc.id)}
            className={`px-3 py-1.5 rounded-md text-[13px] font-medium border transition-colors ${
              activeLocationId === loc.id
                ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)] border-[var(--color-fg)]'
                : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
            }`}
          >
            {loc.name}
          </button>
        ))}
        {canEdit && (
          <button
            onClick={() => setLocationsModalOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[13px] font-medium border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:border-[var(--color-fg)]"
            title="Gestisci celle"
          >
            <Settings className="h-4 w-4" />
            Gestisci celle
          </button>
        )}
      </div>

      {/* Search + add product */}
      <div className="mb-4 flex flex-col sm:flex-row gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Cerca prodotto..."
          className="flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]"
        />
        {canEdit && (
          <button
            onClick={openCreateProduct}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[14px] font-medium hover:opacity-90"
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
        <div className="p-4 rounded-lg bg-rose-50 text-rose-700 border border-rose-100">
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
            return (
              <div
                key={p.id}
                className={`flex items-center gap-3 p-3 sm:p-4 ${idx > 0 ? 'border-t border-[var(--color-line)]' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-[14px] text-[var(--color-fg)] truncate">{p.name}</span>
                    {p.unit && (
                      <span className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)]">{p.unit}</span>
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
                    <div className="font-semibold tabular-nums text-[15px] text-[var(--color-fg)]">{qty}</div>
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setLocationsModalOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Celle / Posizioni — {AREA_LABEL[activeArea]}</h3>
              <button onClick={() => setLocationsModalOpen(false)} className="p-1 hover:bg-[var(--color-surface-hover)] rounded">
                <X className="h-5 w-5 text-[var(--color-fg-muted)]" />
              </button>
            </div>
            <div className="p-4 space-y-3">
              {locations.length === 0 && (
                <div className="text-[13px] text-[var(--color-fg-muted)] text-center py-2">
                  Nessuna cella. Aggiungine una qui sotto.
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
                      <button onClick={handleSaveLocationEdit} className="px-3 py-2 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[13px] font-medium">Salva</button>
                      <button onClick={() => { setEditingLocationId(null); setEditingLocationName(''); }} className="px-3 py-2 rounded-md border border-[var(--color-line)] text-[13px]">Annulla</button>
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
                  placeholder="Nome cella (es. Cella 1)"
                  className="flex-1 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px]"
                />
                <button
                  onClick={handleAddLocation}
                  disabled={!locationDraftName.trim()}
                  className="px-4 py-2 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[13px] font-medium disabled:opacity-50"
                >
                  <Plus className="h-4 w-4 inline" /> Aggiungi
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ----- Confirm delete location ----- */}
      {confirmDeleteLocationId != null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare la cella?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              Tutte le quantità in questa cella verranno cancellate. L'azione non è reversibile.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteLocationId(null)} className="px-3 py-2 rounded-md border border-[var(--color-line)] text-[13px]">Annulla</button>
              <button onClick={() => handleDeleteLocation(confirmDeleteLocationId)} className="px-3 py-2 rounded-md bg-rose-600 text-white text-[13px] font-medium hover:bg-rose-700">Elimina</button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Product modal ----- */}
      {productModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setProductModalOpen(false)}>
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {productEditing ? 'Modifica prodotto' : `Nuovo prodotto — ${AREA_LABEL[activeArea]}`}
              </h3>
              <button onClick={() => setProductModalOpen(false)} className="p-1 hover:bg-[var(--color-surface-hover)] rounded">
                <X className="h-5 w-5 text-[var(--color-fg-muted)]" />
              </button>
            </div>
            <div className="p-4 space-y-3">
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
              <button onClick={() => setProductModalOpen(false)} className="px-3 py-2 rounded-md border border-[var(--color-line)] text-[13px]">Annulla</button>
              <button onClick={handleSaveProduct} className="px-4 py-2 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[13px] font-medium">Salva</button>
            </div>
          </div>
        </div>
      )}

      {/* ----- Confirm delete product ----- */}
      {confirmDeleteProductId != null && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
          <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-sm p-5">
            <h4 className="font-semibold text-[15px] text-[var(--color-fg)] mb-2">Eliminare il prodotto?</h4>
            <p className="text-[13px] text-[var(--color-fg-muted)] mb-4">
              Verrà rimosso dall'inventario in tutte le celle. L'azione non è reversibile.
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDeleteProductId(null)} className="px-3 py-2 rounded-md border border-[var(--color-line)] text-[13px]">Annulla</button>
              <button onClick={() => handleDeleteProduct(confirmDeleteProductId)} className="px-3 py-2 rounded-md bg-rose-600 text-white text-[13px] font-medium hover:bg-rose-700">Elimina</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Inventory;
