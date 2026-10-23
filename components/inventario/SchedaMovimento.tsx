import React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { InventoryArea, InventoryLocation, InventoryProduct, InventoryStockRow } from '../../types';
import { toTitleCase } from '../../utils/text';
import { Callout, SegmentedControl, StatusPill, dsButton, dsSelect } from '../ds';
import { dateLocale, formatQuantity } from './Movimenti';

/* ── Carica o scarica un prodotto ──────────────────────────────────────────
   La stessa scheda per le due strade: il codice letto dal lettore
   (LettoreCodici) e i tasti − e + accanto al totale nella lista. Chi la usa
   tiene lo stato (direzione, quantità, cella): il lettore lo deve poter
   toccare da fuori, perché ripassare lo stesso articolo aggiunge uno. */

export type Direction = 'in' | 'out';

const CELL_KEY = (area: InventoryArea) => `inventario.lettore.cella.${area}`;

export const readRememberedCell = (area: InventoryArea): number | null => {
  try {
    const v = Number(localStorage.getItem(CELL_KEY(area)));
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};

export const rememberCell = (area: InventoryArea, id: number) => {
  try { localStorage.setItem(CELL_KEY(area), String(id)); } catch { /* navigazione privata */ }
};

/** La cella proposta: quella che la pagina sta contando; poi quella dove il
 *  prodotto c'è già (il riso sta in dispensa, non dove è finito l'ultimo
 *  prodotto toccato); poi l'ultima usata in quell'area; poi la prima. */
export const proposeCell = (
  area: InventoryArea,
  locations: InventoryLocation[],
  stock: InventoryStockRow[],
  pageCell: number | null,
): number | null => {
  const home = [...stock].filter(s => s.quantity > 0).sort((a, b) => b.quantity - a.quantity)[0]?.location_id ?? null;
  return [pageCell, home, readRememberedCell(area)].find(id => id != null && locations.some(l => l.id === id))
    ?? locations[0]?.id
    ?? null;
};

export const parseQty = (raw: string): number => Number(raw.replace(',', '.'));

interface Props {
  product: InventoryProduct;
  /** Le celle dell'area del prodotto. */
  locations: InventoryLocation[];
  /** Le giacenze del prodotto (anche di altre celle: servono al totale). */
  stock: InventoryStockRow[];
  direction: Direction;
  onDirection: (d: Direction) => void;
  qty: string;
  onQty: (q: string) => void;
  cellId: number | null;
  onCell: (id: number) => void;
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Il nome in testa: sì nel lettore, no in un foglio che lo ha già nel titolo. */
  showName?: boolean;
  /** Una pillola d'area quando il prodotto non è dell'area aperta. */
  areaBadge?: string | null;
  areaLabel: (area: InventoryArea) => string;
  footnote?: React.ReactNode;
  autoFocusQty?: boolean;
}

// Il piede: Annulla largo quanto la sua parola, l'azione principale prende il
// resto e su un telefono stretto si accorcia con i puntini (vedi #970).
const footerCancel = `${dsButton.secondary} flex-none`;
const footerMain = `${dsButton.primary} min-w-0 flex-1 whitespace-nowrap`;
const stepButton =
  'inline-flex h-11 w-11 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] text-[20px] font-medium leading-none text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const SchedaMovimento: React.FC<Props> = ({
  product, locations, stock, direction, onDirection, qty, onQty, cellId, onCell,
  saving, onConfirm, onCancel, showName = true, areaBadge, areaLabel, footnote, autoFocusQty,
}) => {
  const { t, i18n } = useTranslation('inventario', { useSuspense: false });
  const locale = dateLocale(i18n.language);
  const unit = product.unit?.trim() || '';
  const cell = locations.find(l => l.id === cellId) ?? null;
  const here = cellId == null ? 0 : stock.find(s => s.location_id === cellId)?.quantity ?? 0;
  const total = stock.reduce((sum, s) => sum + (s.quantity ?? 0), 0);
  const qtyNumber = parseQty(qty);
  const qtyValid = Number.isFinite(qtyNumber) && qtyNumber > 0;
  const canConfirm = !saving && qtyValid && cellId != null;

  const stepQty = (d: number) => {
    const n = parseQty(qty);
    onQty(String(Math.max(1, Math.round(((Number.isFinite(n) ? n : 0) + d) * 1000) / 1000)));
  };

  return (
    <div className="space-y-3">
      <div className="min-w-0">
        {showName && (
          <div className="text-[18px] font-semibold leading-tight text-[var(--ds-text-primary)]">{product.name}</div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[13px] text-[var(--ds-text-muted)]">
          {areaBadge && <StatusPill tone="info">{areaBadge}</StatusPill>}
          <span className="tabular-nums">
            {product.category_name ? `${product.category_name} · ` : ''}
            {cell
              ? t('lettore.stockHere', {
                  cell: toTitleCase(cell.name),
                  qty: formatQuantity(here, unit, locale),
                  total: formatQuantity(total, unit, locale),
                  defaultValue: '{{qty}} in {{cell}} · {{total}} in tutto',
                })
              : t('lettore.stockTotal', { total: formatQuantity(total, unit, locale), defaultValue: '{{total}} in tutto' })}
          </span>
        </div>
      </div>

      {locations.length === 0 ? (
        <Callout tone="pending">
          {t('lettore.noCells', { area: areaLabel(product.area), defaultValue: 'Nessuna cella in {{area}}: creala da Gestisci celle e aree.' })}
        </Callout>
      ) : (
        <>
          <SegmentedControl<Direction>
            value={direction}
            onChange={onDirection}
            options={[
              { value: 'in', label: t('lettore.in', 'Carica') },
              { value: 'out', label: t('lettore.out', 'Scarica') },
            ]}
            ariaLabel={t('lettore.direction', 'Carica o scarica')}
          />
          <div className="flex items-center gap-2">
            {locations.length > 1 && (
              <select
                value={cellId ?? ''}
                onChange={e => onCell(Number(e.target.value))}
                aria-label={t('lettore.cell', 'Cella')}
                className={`${dsSelect} min-w-0 flex-1`}
              >
                {locations.map(l => (
                  <option key={l.id} value={l.id}>{toTitleCase(l.name)}</option>
                ))}
              </select>
            )}
            <div className={`flex flex-shrink-0 items-center gap-1.5 ${locations.length > 1 ? '' : 'ml-auto'}`} role="group" aria-label={t('lettore.qty', 'Quantità')}>
              <button type="button" onClick={() => stepQty(-1)} aria-label={t('lettore.less', 'Uno in meno')} className={stepButton}>
                −
              </button>
              <input
                type="text"
                inputMode="decimal"
                value={qty}
                autoFocus={autoFocusQty}
                onChange={e => onQty(e.target.value)}
                onFocus={e => e.currentTarget.select()}
                onKeyDown={e => {
                  if (e.key === 'Enter' && canConfirm) {
                    e.preventDefault();
                    onConfirm();
                  }
                }}
                aria-label={t('lettore.qty', 'Quantità')}
                className="h-11 w-[68px] rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-2 text-center text-[17px] font-semibold tabular-nums text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              />
              <button type="button" onClick={() => stepQty(1)} aria-label={t('lettore.more', 'Uno in più')} className={stepButton}>
                +
              </button>
            </div>
          </div>
        </>
      )}

      <div className="flex gap-2">
        <button type="button" onClick={onCancel} className={footerCancel}>
          {t('lettore.cancel', 'Annulla')}
        </button>
        <button type="button" onClick={onConfirm} disabled={!canConfirm} className={footerMain}>
          {saving && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden />}
          <span className="truncate">
            {direction === 'in'
              ? t('lettore.confirmIn', { qty: qtyValid ? formatQuantity(qtyNumber, unit, locale) : '', defaultValue: 'Carica {{qty}}' })
              : t('lettore.confirmOut', { qty: qtyValid ? formatQuantity(qtyNumber, unit, locale) : '', defaultValue: 'Scarica {{qty}}' })}
          </span>
        </button>
      </div>
      {footnote && <p className="text-center text-[12px] text-[var(--ds-text-muted)]">{footnote}</p>}
    </div>
  );
};
