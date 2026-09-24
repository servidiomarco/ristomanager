import React, { useMemo, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { displayLocale } from '../utils/formatLocale';
import { createPortal } from 'react-dom';
import {
  InventoryArea,
  InventoryLocation,
  InventoryProduct,
  InventoryStockRow,
  InventoryCategory,
} from '../types';
import { Printer } from 'lucide-react';
import { toTitleCase } from '../utils/text';
import { ModalShell, FormCard, Field, dsSelect, dsButton } from './ds';

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

/* `t` a parametro: AREA_LABEL è una costante di modulo. Il valore
   (CUCINA, SALA) è dell'enum e non si tocca. */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

const areaLabel = (a: InventoryArea, t?: TFunc): string =>
  t ? t(`stampa.area.${a}`, AREA_LABEL[a]) : AREA_LABEL[a];

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
  const { t } = useTranslation('inventario', { useSuspense: false });
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
        .sort((a, b) => a.name.localeCompare(b.name, displayLocale(), { sensitivity: 'base' }));
      if (inCat.length > 0) out.push({ id: cat.id, name: cat.name, products: inCat });
    }

    if (categoryFilter == null || categoryFilter === UNCATEGORIZED_ID) {
      const uncat = candidate
        .filter(p => p.category_id == null)
        .sort((a, b) => a.name.localeCompare(b.name, displayLocale(), { sensitivity: 'base' }));
      if (uncat.length > 0) out.push({ id: UNCATEGORIZED_ID, name: t('stampa.uncategorized', 'Senza categoria'), products: uncat });
    }

    return out;
  }, [products, categories, categoryFilter, t]);

  const totalProducts = groups.reduce((acc, g) => acc + g.products.length, 0);

  const locationLabel = locationId == null
    ? t('stampa.totalAllAreas', 'Totale (tutte le aree)')
    : (locations.find(l => l.id === locationId)?.name || t('stampa.areaFallback', 'Area'));

  const categoryLabel = categoryFilter == null
    ? t('stampa.allCategories', 'Tutte le categorie')
    : categoryFilter === UNCATEGORIZED_ID
      ? t('stampa.uncategorized', 'Senza categoria')
      : (categories.find(c => c.id === categoryFilter)?.name || t('stampa.categoryFallback', 'Categoria'));

  if (!isOpen) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <>
      {/* On screen only. The print stylesheet hides every direct body child
          that is not .print-portal, and ModalShell portals to the body — so
          this needs no no-print class of its own. */}
      <ModalShell
        open={isOpen}
        onClose={onClose}
        title={t('stampa.title', 'Stampa inventario')}
        subtitle={`${areaLabel(area, t)} · ${new Date().toLocaleDateString(displayLocale(), { day: 'numeric', month: 'long', year: 'numeric' })}`}
        size="sm"
        closeOnEscape
        bodyClassName="px-5 py-5 sm:px-6"
        footer={
          <>
            <button type="button" onClick={onClose} className={dsButton.secondary}>
              {t('stampa.cancel', 'Annulla')}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={totalProducts === 0}
              className={dsButton.primary}
            >
              <Printer className="h-4 w-4" aria-hidden />
              {t('stampa.print', 'Stampa')}
            </button>
          </>
        }
      >
        <FormCard className="space-y-4">
          <Field label={t('stampa.what', 'Cosa stampare')} htmlFor="print-location">
            <select
              id="print-location"
              value={locationId == null ? 'ALL' : String(locationId)}
              onChange={(e) => setLocationId(e.target.value === 'ALL' ? null : Number(e.target.value))}
              className={dsSelect}
            >
              <option value="ALL">{t('stampa.wholeArea', "Tutta l'area (totale per prodotto)")}</option>
              {locations.map(loc => (
                <option key={loc.id} value={loc.id}>{t('stampa.onlyOne', 'Solo {{posto}}', { posto: toTitleCase(loc.name) })}</option>
              ))}
            </select>
          </Field>

          <Field label={t('stampa.category', 'Categoria')} htmlFor="print-category">
            <select
              id="print-category"
              value={categoryFilter == null ? 'ALL' : String(categoryFilter)}
              onChange={(e) => {
                const v = e.target.value;
                setCategoryFilter(v === 'ALL' ? null : Number(v));
              }}
              className={dsSelect}
            >
              <option value="ALL">{t('stampa.allCategories', 'Tutte le categorie')}</option>
              {[...categories].sort((a, b) => a.sort_order - b.sort_order).map(cat => (
                <option key={cat.id} value={cat.id}>{cat.name}</option>
              ))}
              {products.some(p => p.category_id == null) && (
                <option value={UNCATEGORIZED_ID}>{t('stampa.uncategorized', 'Senza categoria')}</option>
              )}
            </select>
          </Field>

          {/* What will come out of the printer, before the paper is spent. */}
          <div className="rounded-[var(--ds-radius)] bg-[var(--ds-surface-row)] p-4">
            <p className="text-[15px] font-medium text-[var(--ds-text-primary)]">
              {areaLabel(area, t)} · {locationId == null ? t('stampa.wholeAreaShort', "Tutta l'area") : toTitleCase(locationLabel)}
            </p>
            <p className="mt-0.5 text-[14px] text-[var(--ds-text-muted)]">{categoryLabel}</p>
            <p className="mt-0.5 text-[14px] text-[var(--ds-text-muted)]">
              {t('stampa.counts', '{{prodotti}} · {{sezioni}}', {
                prodotti: t('stampa.products', '{{count}} prodotti', { count: totalProducts }),
                sezioni: t('stampa.sections', '{{count}} sezioni', { count: groups.length }),
              })}
            </p>
          </div>
        </FormCard>
      </ModalShell>

      {/* Print-only area — portaled to <body> so it's a direct body child.
          Combined with the @media print CSS that hides every other body child,
          this lets the document flow grow to the print content's full height
          (avoids the single-page clipping caused by App's h-screen layout). */}
      {createPortal(
        <div className="print-portal">
          <div id="print-area" className="print-only">
            <header style={{ marginBottom: '1.25rem', paddingBottom: '0.75rem', borderBottom: '2px solid var(--ds-print-ink)' }}>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 700, margin: 0 }}>{t('stampa.sheetTitle', 'Inventario — {{area}}', { area: areaLabel(area, t) })}</h1>
              <p style={{ margin: '0.25rem 0 0', fontSize: '0.95rem', color: 'var(--ds-print-ink-secondary)' }}>
                {locationLabel} · {categoryLabel}
              </p>
            </header>

        {totalProducts === 0 ? (
          <p style={{ fontStyle: 'italic', color: 'var(--ds-print-ink-muted)' }}>{t('stampa.empty', 'Nessun prodotto corrispondente ai filtri.')}</p>
        ) : (
          groups.map(group => (
            <section key={group.id} style={{ marginBottom: '1.25rem' }}>
              <h2 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '0 0 0.4rem', borderBottom: '1px solid var(--ds-print-rule-strong)', paddingBottom: '0.25rem' }}>
                {group.name}
                <span style={{ marginLeft: 8, fontWeight: 400, fontSize: '0.8rem', color: 'var(--ds-print-ink-muted)' }}>
                  · {group.products.length} {group.products.length === 1 ? 'prodotto' : 'prodotti'}
                </span>
              </h2>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ background: 'var(--ds-print-fill)', borderBottom: '1px solid var(--ds-print-rule-strong)' }}>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left' }}>{t('stampa.colProduct', 'Prodotto')}</th>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left', width: '80px' }}>{t('stampa.colUnit', 'Unità')}</th>
                    <th style={{ padding: '0.4rem 0.5rem', textAlign: 'right', width: '100px' }}>
                      {locationId == null ? t('stampa.colQtyTotal', 'Q.tà totale') : t('stampa.colQty', 'Quantità')}
                    </th>
                    {locationId == null && (
                      <th style={{ padding: '0.4rem 0.5rem', textAlign: 'left' }}>{t('stampa.colSpread', 'Distribuzione')}</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {group.products.map(p => {
                    const qty = quantityFor(p.id);
                    const breakdown = locationId == null ? breakdownFor(p.id) : [];
                    return (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--ds-print-rule)' }}>
                        <td style={{ padding: '0.4rem 0.5rem' }}>{toTitleCase(p.name)}</td>
                        <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.75rem', color: 'var(--ds-print-ink-secondary)' }}>{p.unit}</td>
                        <td style={{ padding: '0.4rem 0.5rem', textAlign: 'right', fontWeight: 600 }}>{qty}</td>
                        {locationId == null && (
                          <td style={{ padding: '0.4rem 0.5rem', fontSize: '0.78rem', color: 'var(--ds-print-ink-secondary)' }}>
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

            <footer style={{ marginTop: '2rem', paddingTop: '0.5rem', borderTop: '1px solid var(--ds-print-rule)', fontSize: '0.7rem', color: 'var(--ds-print-ink-subtle)', textAlign: 'right' }}>
              {t('stampa.printedOn', 'Stampato il {{quando}}', { quando: new Date().toLocaleString(displayLocale()) })}
            </footer>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
