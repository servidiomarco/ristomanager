import React from 'react';
import { Clock, Loader2, Plus } from 'lucide-react';
import type { ShoppingCategory, ShoppingUnit, Supplier } from '../../services/shoppingApiService';
import { SHOPPING_UNITS } from '../../services/shoppingApiService';
import { dsSelect } from '../ds';
import { ALL_CATEGORIES, CATEGORY_LABELS } from './shoppingView';

/* ── Aggiungi prodotto ────────────────────────────────────────────────────
   One line, always in reach, because the common act on this page is adding
   the next thing you thought of — not opening a form to do it. The name field
   owns the row; quantity, unit, category and supplier sit beneath it as small
   controls and keep their last value between adds, so a run of ten Cucina
   items from the same supplier is ten names and ten Enters.

   Suggestions come from names already used on previous lists. They are a
   spelling aid, not an inventory: picking one adds it with the settings
   currently in the row, exactly as typing it would. */

export const AddItemBar: React.FC<{
  name: string;
  onName: (v: string) => void;
  qty: string;
  onQty: (v: string) => void;
  unit: ShoppingUnit;
  onUnit: (v: ShoppingUnit) => void;
  category: ShoppingCategory;
  onCategory: (v: ShoppingCategory) => void;
  supplierId: string;
  onSupplier: (v: string) => void;
  suppliers: Supplier[];
  suggestions: string[];
  showSuggestions: boolean;
  onShowSuggestions: (v: boolean) => void;
  adding: boolean;
  /** Dimmed and inert during selection mode. Rendered either way so the list
   *  below does not jump up the screen the moment you tap Seleziona. */
  disabled?: boolean;
  onAdd: (name?: string) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}> = ({
  name, onName, qty, onQty, unit, onUnit, category, onCategory, supplierId, onSupplier,
  suppliers, suggestions, showSuggestions, onShowSuggestions, adding, disabled, onAdd, inputRef,
}) => {
  const eligible = suppliers
    .filter(s => s.categories.includes(category))
    .sort((a, b) => a.name.localeCompare(b.name, 'it'));

  // h-10, not h-9: these sit under the thumb and the row is the one place on
  // the page where four controls compete for a phone's width.
  const control =
    'h-10 rounded-full bg-[var(--ds-surface-row)] pl-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
  // ds-select draws our own chevron and reserves room for it; without it the
  // browser's native arrow sits flush against the pill's right edge.
  const selectControl = `${control} pr-0 cursor-pointer ds-select ds-select-sm`;

  return (
    <div
      aria-hidden={disabled}
      className={`relative rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] transition-opacity ${
        disabled ? 'pointer-events-none opacity-40' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <Plus className="h-5 w-5 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={e => { onName(e.target.value); onShowSuggestions(true); }}
          onFocus={() => onShowSuggestions(true)}
          onBlur={() => window.setTimeout(() => onShowSuggestions(false), 120)}
          onKeyDown={e => { if (e.key === 'Enter') onAdd(); }}
          disabled={disabled}
          tabIndex={disabled ? -1 : undefined}
          placeholder="Aggiungi prodotto…"
          aria-label="Aggiungi prodotto"
          className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--ds-text-primary)] outline-none placeholder:text-[var(--ds-text-muted)]"
        />
        <button
          type="button"
          onClick={() => onAdd()}
          disabled={disabled || !name.trim() || adding}
          aria-label="Aggiungi"
          className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          {adding ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5" />}
        </button>
      </div>

      {/* Scrolls rather than wraps: four controls that rewrap as the supplier
          name changes length move the one you were aiming at.
          py-1.5 is load-bearing — overflow-x also clips vertically, and without
          the padding the focus ring was sliced off top and bottom. */}
      <div className="-mx-1 mt-2.5 flex items-center gap-2 overflow-x-auto px-1 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <label className={`inline-flex flex-shrink-0 items-center gap-1.5 pr-3.5 ${control}`}>
          <span className="text-[var(--ds-text-muted)]">Qtà</span>
          <input
            type="text"
            inputMode="decimal"
            value={qty}
            onChange={e => onQty(e.target.value)}
            placeholder="1"
            disabled={disabled}
            tabIndex={disabled ? -1 : undefined}
            aria-label="Quantità"
            className="w-8 bg-transparent text-center outline-none"
          />
        </label>
        <select
          value={unit}
          onChange={e => onUnit(e.target.value as ShoppingUnit)}
          disabled={disabled}
          tabIndex={disabled ? -1 : undefined}
          aria-label="Unità"
          className={`flex-shrink-0 ${selectControl}`}
        >
          {SHOPPING_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <select
          value={category}
          onChange={e => onCategory(e.target.value as ShoppingCategory)}
          disabled={disabled}
          tabIndex={disabled ? -1 : undefined}
          aria-label="Categoria"
          // Same quiet pill as its neighbours. The solid fill made it read as
          // the row's primary action when it is just one of four settings, and
          // the near-black is reserved for things that actually do something.
          className={`flex-shrink-0 ${selectControl}`}
        >
          {ALL_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
        </select>
        <select
          value={supplierId}
          onChange={e => onSupplier(e.target.value)}
          disabled={disabled}
          tabIndex={disabled ? -1 : undefined}
          aria-label="Fornitore"
          className={`max-w-[11rem] flex-shrink-0 ${selectControl}`}
        >
          <option value="">Senza fornitore</option>
          {eligible.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      {showSuggestions && !disabled && suggestions.length > 0 && (
        <div className="absolute inset-x-3 top-full z-20 mt-1 overflow-hidden rounded-[16px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)]">
          <div className="px-4 pt-3 text-[13px] font-semibold text-[var(--ds-text-muted)]">
            Già in lista in passato
          </div>
          {suggestions.map(s => (
            <button
              key={s}
              type="button"
              // mousedown, not click: the input's blur would close this list
              // before a click ever landed.
              onMouseDown={e => { e.preventDefault(); onShowSuggestions(false); onAdd(s); }}
              className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
            >
              <Clock className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
              <span className="min-w-0 truncate">{s}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
