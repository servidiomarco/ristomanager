import React, { useEffect, useState } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import type {
  ShoppingCategory, ShoppingItem, ShoppingUnit, Supplier,
} from '../../services/shoppingApiService';
import { SHOPPING_UNITS } from '../../services/shoppingApiService';
import { Field, ModalShell, SegmentedControl, dsButton, dsInput, dsSelect } from '../ds';
import { ALL_CATEGORIES, CATEGORY_LABELS, parseQty } from './shoppingView';

/* ── Modifica prodotto ────────────────────────────────────────────────────
   Editing used to happen in the row itself: the line turned into a cluster of
   inputs, the list reflowed under your thumb, and on a phone the supplier
   select ended up about 90px wide. A sheet gives every field a full line and
   leaves the list where it was.

   Delete lives here as well as on the swipe — it is the same call, and this is
   where you end up when you opened the row to fix a name and decided the item
   should not be there at all. */

export const EditItemSheet: React.FC<{
  item: ShoppingItem | null;
  suppliers: Supplier[];
  saving: boolean;
  onSave: (patch: {
    name: string;
    category: ShoppingCategory;
    supplierId: string | null;
    quantity: number | null;
    unit: ShoppingUnit | null;
  }) => void;
  onDelete: () => void;
  onClose: () => void;
}> = ({ item, suppliers, saving, onSave, onDelete, onClose }) => {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<ShoppingCategory>('CUCINA');
  const [supplierId, setSupplierId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState<ShoppingUnit>('pz');

  // Re-seed on every open, so cancelling really does leave the item alone.
  useEffect(() => {
    if (!item) return;
    setName(item.name);
    setCategory(item.category);
    setSupplierId(item.supplierId || '');
    setQty(item.quantity != null && item.quantity > 0 ? String(item.quantity).replace('.', ',') : '');
    setUnit(item.unit || 'pz');
  }, [item?.id]);

  // A supplier that does not serve the chosen category would be saved and then
  // silently dropped, so it clears the moment the category moves away from it.
  useEffect(() => {
    if (!supplierId) return;
    const s = suppliers.find(x => x.id === supplierId);
    if (!s || !s.categories.includes(category)) setSupplierId('');
  }, [category, supplierId, suppliers]);

  if (!item) return null;

  const eligible = suppliers
    .filter(s => s.categories.includes(category))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    const q = parseQty(qty);
    onSave({
      name: trimmed,
      category,
      supplierId: supplierId || null,
      quantity: q,
      unit: q != null ? unit : null,
    });
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title="Modifica prodotto"
      size="sm"
      closeOnEscape
      bodyClassName="p-5 sm:p-6"
      // Delete and save share the footer row instead of stacking. In the
      // footerStart slot the destructive action sat on its own line directly
      // above Salva on a phone — two full-width buttons, the dangerous one
      // first, and nothing but colour to tell them apart under the thumb.
      // Icon-only keeps it present without giving it equal weight.
      footer={
        <div className="flex w-full items-center gap-3">
          <button
            type="button"
            onClick={onDelete}
            aria-label="Elimina prodotto"
            title="Elimina prodotto"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!name.trim() || saving}
            className={`flex-1 ${dsButton.primary}`}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Salva
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field label="Nome">
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }}
            autoFocus
            className={dsInput}
          />
        </Field>

        <div className="grid grid-cols-[1fr_minmax(0,120px)] gap-3">
          <Field label="Quantità">
            <input
              type="text"
              inputMode="decimal"
              placeholder="—"
              value={qty}
              onChange={e => setQty(e.target.value)}
              className={dsInput}
            />
          </Field>
          <Field label="Unità">
            <select value={unit} onChange={e => setUnit(e.target.value as ShoppingUnit)} className={dsSelect}>
              {SHOPPING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Categoria">
          <SegmentedControl<ShoppingCategory>
            value={category}
            onChange={setCategory}
            ariaLabel="Categoria"
            options={ALL_CATEGORIES.map(c => ({ value: c, label: CATEGORY_LABELS[c] }))}
          />
        </Field>

        <Field label="Fornitore">
          <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className={dsSelect}>
            <option value="">Senza fornitore</option>
            {eligible.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
      </div>
    </ModalShell>
  );
};
