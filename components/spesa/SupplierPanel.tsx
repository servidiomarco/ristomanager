import React from 'react';
import { Printer, Send, Truck } from 'lucide-react';
import type { ShoppingItem, Supplier } from '../../services/shoppingApiService';
import { BreadBanner } from './BreadBanner';

/* ── Per fornitore ────────────────────────────────────────────────────────
   The desktop column that turns a list into orders. Printing and sending per
   supplier already existed, but only inside a dropdown hanging off each
   category header — so ordering from one supplier who serves both Cucina and
   Bar meant finding them twice, in two menus, and printing two sheets.

   Here a supplier is one row with everything owed to them, regardless of
   which category each line sits in.

   "Senza fornitore" is listed with the rest and marked, because it is the
   pile that silently never gets ordered: it prints, but nobody receives it. */

export const SupplierPanel: React.FC<{
  suppliers: Supplier[];
  /** Unpurchased items only — you do not re-order what is already in the van. */
  items: ShoppingItem[];
  bread: { coperti: number; kg: number };
  onPrintSupplier: (supplierId: string) => void;
  onShareSupplier: (supplierId: string) => void;
  onPrintNoSupplier: () => void;
  onPrintAll: () => void;
  onManageSuppliers: () => void;
}> = ({
  suppliers, items, bread, onPrintSupplier, onShareSupplier, onPrintNoSupplier, onPrintAll,
  onManageSuppliers,
}) => {
  const withSupplier = suppliers
    .map(s => ({ supplier: s, count: items.filter(i => i.supplierId === s.id).length }))
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);
  const orphanCount = items.filter(i => !i.supplierId).length;

  const action =
    'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <div className="flex flex-col gap-4">
      <BreadBanner bread={bread} />

      <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            Per fornitore
          </h2>
          <button
            type="button"
            onClick={onManageSuppliers}
            className="text-[13px] font-medium text-[var(--ds-text-primary)] underline underline-offset-2"
          >
            Gestisci
          </button>
        </div>

        {withSupplier.length === 0 && orphanCount === 0 ? (
          <p className="text-[14px] text-[var(--ds-text-muted)]">
            Nessun prodotto da ordinare.
          </p>
        ) : (
          <div className="space-y-3">
            {withSupplier.map(({ supplier, count }) => (
              <div key={supplier.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
                <div className="mb-2 flex items-start gap-2">
                  <Truck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-semibold text-[var(--ds-text-primary)]">
                      {supplier.name}
                    </div>
                    <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                      {count} prodott{count === 1 ? 'o' : 'i'}
                      {supplier.phone ? ` · ${supplier.phone}` : ''}
                    </div>
                  </div>
                  <span className="text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                    {count}
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => onPrintSupplier(supplier.id)}
                    className={`${action} bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]`}
                  >
                    <Printer className="h-3.5 w-3.5" aria-hidden /> Stampa
                  </button>
                  <button
                    type="button"
                    onClick={() => onShareSupplier(supplier.id)}
                    className={`${action} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:brightness-95`}
                  >
                    <Send className="h-3.5 w-3.5" aria-hidden /> Invia
                  </button>
                </div>
              </div>
            ))}

            {orphanCount > 0 && (
              <div className="rounded-[16px] bg-[var(--ds-critical-tint)] p-3">
                <div className="mb-2 flex items-start gap-2">
                  <Truck className="mt-0.5 h-4 w-4 flex-shrink-0 text-[var(--ds-critical-text)]" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-semibold text-[var(--ds-critical-text)]">Senza fornitore</div>
                    <div className="text-[13px] text-[var(--ds-critical-text)]">da assegnare prima di ordinare</div>
                  </div>
                  <span className="text-[17px] font-semibold tabular-nums text-[var(--ds-critical-text)]">
                    {orphanCount}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={onPrintNoSupplier}
                  className={`${action} w-full bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]`}
                >
                  <Printer className="h-3.5 w-3.5" aria-hidden /> Stampa
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onPrintAll}
        className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-action-bg)] text-[15px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <Printer className="h-4 w-4" aria-hidden /> Stampa lista completa
      </button>
    </div>
  );
};
