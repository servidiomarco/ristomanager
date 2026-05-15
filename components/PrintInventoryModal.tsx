import React, { useMemo, useState, useEffect } from 'react';
import {
  InventoryArea,
  InventoryLocation,
  InventoryProduct,
  InventoryStockRow,
  InventoryCategory,
} from '../types';
import { Printer, X } from 'lucide-react';
import { toTitleCase } from '../utils/text';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  area: InventoryArea;
  locations: InventoryLocation[];
  products: InventoryProduct[];
  stock: InventoryStockRow[];
  categories: InventoryCategory[];
  // Pre-selected by the inventory page when opening the modal
  initialLocationId: number | null; // null = Totale
  initialCategoryFilter: number | null; // null = Tutte, -1 = Senza categoria, n = id
}

const AREA_LABEL: Record<InventoryArea, string> = {
  [InventoryArea.CUCINA]: 'Cucina',
  [InventoryArea.SALA]: 'Sala',
  [InventoryArea.BAR]: 'Bar',
};

const UNCATEGORIZED_ID = -1;

const stockKey = (productId: number, locationId: number) => `${productId}:${locationId}`;

export const PrintInventoryModal: React.FC<Props> = ({
  isOpen,
  onClose,
  area,
  locations,
  products,
  stock,
  categories,
  initialLocationId,
  initialCategoryFilter,
}) => {
  const [locationId, setLocationId] = useState<number | null>(initialLocationId);
  const [categoryFilter, setCategoryFilter] = useState<number | null>(initialCategoryFilter);

  useEffect(() => {
    if (isOpen) {
      setLocationId(initialLocationId);
      setCategoryFilter(initialCategoryFilter);
    }
  }, [isOpen, initialLocationId, initialCategoryFilter]);

  const stockMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stock) m.set(stockKey(s.product_id, s.location_id), s.quantity);
    return m;
  }, [stock]);

  const quantityFor = (productId: number): number => {
    if (locationId != null) return stockMap.get(stockKey(productId, locationId)) ?? 0;
    let total = 0;
    for (const loc of locations) total += stockMap.get(stockKey(productId, loc.id)) ?? 0;
    return total;
  };

  const breakdownFor = (productId: number): { locationName: string; quantity: number }[] => {
    return locations
      .map(loc => ({ locationName: loc.name, quantity: stockMap.get(stockKey(productId, loc.id)) ?? 0 }))
      .filter(b => b.quantity !== 0);
  };

  // Group filtered products by category, preserving category sort_order.
  // categoryFilter null → all categories (plus uncategorized bucket at end)
  // categoryFilter -1 → only uncategorized
  // categoryFilter <id> → only that category
  const groups = useMemo(() => {
    let candidate = products;
    if (categoryFilter === UNCATEGORIZED_ID) {
      candidate = candidate.filter(p => p.category_id == null);
    } else if (categoryFilter != null) {
      candidate = candidate.filter(p => p.category_id === categoryFilter);
    }

    const sortedCats = [...categories].sort((a, b) => a.sort_order - b.sort_order);
    const out: { id: number; name: string; products: InventoryProduct[] }[] = [];

    for (const cat of sortedCats) {
      if (categoryFilter != null && categoryFilter !== UNCATEGORIZED_ID && categoryFilter !== cat.id) continue;
      const inCat = candidate
        .filter(p => p.category_id === cat.id)
        .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
      if (inCat.length > 0) out.push({ id: cat.id, name: cat.name, products: inCat });
    }

    if (categoryFilter == null || categoryFilter === UNCATEGORIZED_ID) {
      const uncat = candidate
        .filter(p => p.category_id == null)
        .sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
      if (uncat.length > 0) out.push({ id: UNCATEGORIZED_ID, name: 'Senza categoria', products: uncat });
    }

    return out;
  }, [products, categories, categoryFilter]);

  const totalProducts = groups.reduce((acc, g) => acc + g.products.length, 0);

  const locationLabel = locationId == null
    ? 'Totale (tutte le aree)'
    : (locations.find(l => l.id === locationId)?.name || 'Area');

  const categoryLabel = categoryFilter == null
    ? 'Tutte le categorie'
    : categoryFilter === UNCATEGORIZED_ID
      ? 'Senza categoria'
      : (categories.find(c => c.id === categoryFilter)?.name || 'Categoria');

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <>
      {/* Modal — visible on screen, hidden in print */}
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] p-4 no-print" onClick={onClose}>
        <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
          <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] flex items-center gap-2">
              <Printer className="h-4 w-4 text-[var(--color-fg-muted)]" />
              Stampa inventario — {AREA_LABEL[area]}
            </h3>
            <button onClick={onClose} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]" aria-label="Chiudi">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto flex-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Area di stoccaggio</label>
                <select
                  value={locationId == null ? 'ALL' : String(locationId)}
                  onChange={(e) => setLocationId(e.target.value === 'ALL' ? null : Number(e.target.value))}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="ALL">Totale (tutte le aree)</option>
                  {locations.map(loc => (
                    <option key={loc.id} value={loc.id}>{toTitleCase(loc.name)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Categoria</label>
                <select
                  value={categoryFilter == null ? 'ALL' : String(categoryFilter)}
                  onChange={(e) => {
                    const v = e.target.value;
                    setCategoryFilter(v === 'ALL' ? null : Number(v));
                  }}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="ALL">Tutte le categorie</option>
                  {[...categories].sort((a, b) => a.sort_order - b.sort_order).map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                  {products.some(p => p.category_id == null) && (
                    <option value={UNCATEGORIZED_ID}>Senza categoria</option>
                  )}
                </select>
              </div>
            </div>

            <div className="border-t border-[var(--color-line)] pt-4">
              <p className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-2">Anteprima</p>
              <div className="bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md p-3 text-sm space-y-1">
                <p className="font-semibold text-[var(--color-fg)]">{AREA_LABEL[area]} · {locationLabel}</p>
                <p className="text-[var(--color-fg-muted)]">{categoryLabel}</p>
                <p className="text-[var(--color-fg-subtle)]">
                  {totalProducts} prodotti · {groups.length} {groups.length === 1 ? 'sezione' : 'sezioni'}
                </p>
              </div>
            </div>
          </div>

          <div className="p-4 border-t border-[var(--color-line)] flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
            >
              Annulla
            </button>
            <button
              onClick={handlePrint}
              disabled={totalProducts === 0}
              className="rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Printer className="h-4 w-4" />
              Stampa
            </button>
          </div>
        </div>
      </div>

      {/* Print-only area — hidden on screen, shown when printing */}
      <div id="print-area" className="print-only">
        <header style={{ marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '2px solid #0f172a' }}>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>Inventario — {AREA_LABEL[area]}</h1>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.95rem', color: '#475569' }}>
            {locationLabel} · {categoryLabel}
          </p>
        </header>

        {totalProducts === 0 ? (
          <p style={{ fontStyle: 'italic', color: '#64748b' }}>Nessun prodotto corrispondente ai filtri.</p>
        ) : (
          groups.map(group => (
            <section key={group.id} style={{ marginBottom: '1.25rem', pageBreakInside: 'avoid' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 0.4rem', borderBottom: '1px solid #cbd5e1', paddingBottom: '0.25rem' }}>
                {group.name}
                <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.8rem', color: '#64748b' }}>
                  · {group.products.length} {group.products.length === 1 ? 'prodotto' : 'prodotti'}
                </span>
              </h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: '#f1f5f9', borderBottom: '1px solid #cbd5e1' }}>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left' }}>Prodotto</th>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left', width: '80px' }}>Unità</th>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'right', width: '100px' }}>
                      {locationId == null ? 'Q.tà Totale' : 'Quantità'}
                    </th>
                    {locationId == null && (
                      <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left' }}>Distribuzione</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {group.products.map(p => {
                    const qty = quantityFor(p.id);
                    const breakdown = locationId == null ? breakdownFor(p.id) : [];
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                        <td style={{ padding: '0.4rem 0.5rem' }}>{toTitleCase(p.name)}</td>
                        <td style={{ padding: '0.4rem 0.5rem', textTransform: 'uppercase', fontSize: '0.75rem', color: '#475569' }}>{p.unit}</td>
                        <td style={{ padding: '0.4rem 0.5rem', textAlign: 'right', fontWeight: 600 }}>{qty}</td>
                        {locationId == null && (
                          <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.78rem', color: '#475569' }}>
                            {breakdown.length === 0
                              ? '—'
                              : breakdown.map(b => `${toTitleCase(b.locationName)}: ${b.quantity}`).join(' · ')}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))
        )}

        <footer style={{ marginTop: '2rem', paddingTop: '0.5rem', borderTop: '1px solid #e2e8f0', fontSize: '0.7rem', color: '#94a3b8', textAlign: 'right' }}>
          Stampato il {new Date().toLocaleString('it-IT')}
        </footer>
      </div>
    </>
  );
};
