import React from 'react';
import { Check, Edit2, Trash2 } from 'lucide-react';
import type { ShoppingItem } from '../../services/shoppingApiService';
import { Avatar, StatusPill, SwipeRow } from '../ds';
import { formatAddedAt, formatQty, personName } from './shoppingView';

/* ── Una riga della lista ─────────────────────────────────────────────────
   Quantity first when there is one, because "30 kg" is what you are checking
   against the trolley; the supplier and who added it sit underneath in the
   muted line, present but out of the reading path.

   Checked items are struck through and greyed rather than removed: the
   Acquistati tab is a record of what was done, and a strikethrough says
   "handled" in a way a plain grey row does not.

   Swipe mirrors the rest of the app's lists — right is the forgiving action,
   left is removal. SwipeRow carries one action per side, so Modifica is the
   row tap rather than a second left action; the edit sheet holds a delete of
   its own, which is the mockup's other route to the same place. */

export const ShoppingRow: React.FC<{
  item: ShoppingItem;
  /** Selection mode replaces the whole interaction: tapping picks, not edits. */
  selectionMode?: boolean;
  selected?: boolean;
  hint?: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelect: () => void;
}> = ({ item, selectionMode, selected, hint, onToggle, onEdit, onDelete, onSelect }) => {
  const qty = formatQty(item.quantity, item.unit);
  const who = personName(item.createdByUserName);
  const added = formatAddedAt(item.createdAt || item.date);

  const body = (
    <div
      className={`flex items-center gap-3 px-4 py-3.5 ${
        selected ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)]'
      }`}
    >
      <button
        type="button"
        onClick={selectionMode ? onSelect : onToggle}
        aria-pressed={selectionMode ? selected : item.checked}
        aria-label={selectionMode
          ? `Seleziona ${item.name}`
          : item.checked ? `Segna ${item.name} da acquistare` : `Segna ${item.name} come preso`}
        className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[9px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
          (selectionMode ? selected : item.checked)
            ? 'bg-[var(--ds-seated-solid)] text-[#ffffff]'
            : 'bg-[var(--ds-surface)] ring-1 ring-inset ring-[var(--ds-border-strong)]'
        }`}
      >
        {(selectionMode ? selected : item.checked) && <Check className="h-4 w-4" />}
      </button>

      <button
        type="button"
        onClick={selectionMode ? onSelect : onEdit}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:rounded-[8px]"
      >
        <span className="flex flex-wrap items-baseline gap-x-2">
          {qty && (
            <span className="inline-flex flex-shrink-0 items-center rounded-full bg-[var(--ds-pending-tint)] px-2 py-0.5 text-[13px] font-semibold tabular-nums text-[var(--ds-pending-text)]">
              {qty}
            </span>
          )}
          <span className={`min-w-0 text-[16px] ${
            item.checked
              ? 'text-[var(--ds-text-muted)] line-through'
              : 'font-medium text-[var(--ds-text-primary)]'
          }`}>
            {item.name}
          </span>
        </span>
        {/* Stacked, not wrapped: the supplier chip owns its line, and who added
            it — as an avatar rather than a login address — sits underneath with
            the day. Two facts about provenance, one line, no wrapping. */}
        {(item.supplierName || who || added) && (
          <span className="mt-1.5 flex flex-col items-start gap-1.5">
            {item.supplierName && <StatusPill tone="neutral">{item.supplierName}</StatusPill>}
            {(who || added) && (
              <span className="flex items-center gap-1.5">
                {who && <Avatar name={who} size="sm" />}
                {added && <span className="text-[13px] text-[var(--ds-text-muted)]">{added}</span>}
              </span>
            )}
          </span>
        )}
      </button>

      {/* Pointer-only: on touch the same two actions are the swipe, and two
          more 40px targets in a row this dense is what made it hard to tick
          the right box with a trolley in the other hand. */}
      {!selectionMode && (
        <span className="hidden flex-shrink-0 items-center gap-1 sm:flex">
          <button
            type="button"
            onClick={onEdit}
            aria-label={`Modifica ${item.name}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Edit2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Elimina ${item.name}`}
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </span>
      )}
    </div>
  );

  // Selection mode has no swipe, so the card framing SwipeRow normally supplies
  // has to come from here or the rows lose their edges mid-selection.
  if (selectionMode) {
    return (
      <div className="overflow-hidden rounded-[16px] shadow-[var(--ds-shadow-card)]">{body}</div>
    );
  }

  return (
    <SwipeRow
      hint={hint}
      left={{
        label: item.checked ? 'Da fare' : 'Preso',
        icon: <Check className="h-5 w-5" />,
        tone: 'confirm',
        onAction: onToggle,
      }}
      right={{
        label: 'Elimina',
        icon: <Trash2 className="h-5 w-5" />,
        tone: 'danger',
        onAction: onDelete,
      }}
    >
      {body}
    </SwipeRow>
  );
};
