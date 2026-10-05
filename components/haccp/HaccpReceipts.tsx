import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Plus, Trash2, X } from 'lucide-react';
import type {
  HaccpGoodsReceipt,
  HaccpLimits,
  HaccpNonConformity,
  HaccpReceiptCategory,
} from '../../services/haccpApiService';
import type { Supplier } from '../../services/shoppingApiService';
import { HACCP_RECEIPT_CATEGORIES, HACCP_RECEIPT_CATEGORY_LABELS_IT, evaluateHaccpReceipt } from '../../utils/haccp';
import { dsButton, dsSelect } from '../ds';
import {
  NcLine, RowStamp, TFunc, deleteButton, emptyNote, field, fieldLabel, formatNumber, formatShortDate,
  parseNumber, row, rowList,
} from './haccpUi';

/* Il ricevimento merci. Quello che serve a rintracciare «un passo indietro»
   (Reg. CE 178/2002, art. 18): da chi è arrivata la merce, con quale
   documento, quale lotto e scadenza. La soglia di temperatura dipende dal
   tipo di merce, e il modulo avvisa prima di registrare: una merce accettata
   fuori soglia apre comunque una non conformità. */

export const receiptCategoryLabel = (c: HaccpReceiptCategory, t: TFunc): string =>
  t(`receiptCategory.${c}`, HACCP_RECEIPT_CATEGORY_LABELS_IT[c]);

/* Accettato / Respinto restano due pastiglie colorate invece di un controllo
   segmentato: su un registro sanitario il verde e il rosso si leggono prima
   della parola. */
const outcomeChip = (active: boolean, tone: 'positive' | 'critical'): string => {
  const base =
    'inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-[var(--ds-radius-control)] px-3 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
  if (!active) return `${base} bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]`;
  return tone === 'positive'
    ? `${base} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] ring-2 ring-inset ring-[var(--ds-seated-solid)]`
    : `${base} bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ring-2 ring-inset ring-[var(--ds-critical-solid)]`;
};

export interface ReceiptInput {
  product: string;
  lotNumber: string | null;
  temperature: number | null;
  accepted: boolean;
  note: string | null;
  supplierId: string | null;
  supplierName: string | null;
  ddtNumber: string | null;
  expiryDate: string | null;
  packagingOk: boolean;
  category: HaccpReceiptCategory | null;
}

export const ReceiptsSection: React.FC<{
  date: string;
  rows: HaccpGoodsReceipt[];
  suppliers: Supplier[];
  limits: HaccpLimits | undefined;
  ncBySource: Map<string, HaccpNonConformity>;
  editable: boolean;
  onAdd: (input: ReceiptInput) => Promise<boolean>;
  onVoid: (r: HaccpGoodsReceipt) => void;
  onCloseNc: (nc: HaccpNonConformity) => void;
  onHistory: (r: HaccpGoodsReceipt) => void;
}> = ({ date, rows, suppliers, limits, ncBySource, editable, onAdd, onVoid, onCloseNc, onHistory }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [product, setProduct] = useState('');
  const [supplier, setSupplier] = useState('');
  const [ddtNumber, setDdtNumber] = useState('');
  const [category, setCategory] = useState<HaccpReceiptCategory | ''>('');
  const [lotNumber, setLotNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [temperature, setTemperature] = useState('');
  const [packagingOk, setPackagingOk] = useState(true);
  const [accepted, setAccepted] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const productInputRef = useRef<HTMLInputElement>(null);

  // Gli avvisi mentre si compila, con la stessa regola del server.
  const problems = useMemo(() => limits ? evaluateHaccpReceipt({
    date,
    category: category || null,
    temperature: parseNumber(temperature),
    expiryDate: expiryDate || null,
    packagingOk,
  }, limits) : [], [limits, date, category, temperature, expiryDate, packagingOk]);
  const maxForCategory = category && limits ? limits.receipt[category] : null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product.trim() || busy) return;
    setBusy(true);
    const supplierName = supplier.trim();
    const match = suppliers.find(s => s.name.trim().toLowerCase() === supplierName.toLowerCase());
    const ok = await onAdd({
      product: product.trim(),
      lotNumber: lotNumber.trim() || null,
      temperature: parseNumber(temperature),
      accepted,
      note: note.trim() || null,
      supplierId: match?.id ?? null,
      supplierName: supplierName || null,
      ddtNumber: ddtNumber.trim() || null,
      expiryDate: expiryDate || null,
      packagingOk,
      category: category || null,
    });
    setBusy(false);
    if (!ok) return;
    // Fornitore, documento e tipo restano: una consegna porta più prodotti.
    setProduct(''); setLotNumber(''); setExpiryDate(''); setTemperature('');
    setPackagingOk(true); setAccepted(true); setNote('');
    productInputRef.current?.focus();
  };

  return (
    <div className="space-y-2">
      {editable && (
        <form onSubmit={submit} className="grid grid-cols-12 items-end gap-2 border-b border-[var(--ds-border)] pb-4">
          <div className="col-span-12 sm:col-span-4">
            <label className={fieldLabel} htmlFor="haccp-receipt-product">{t('product', 'Prodotto')}</label>
            <input id="haccp-receipt-product" ref={productInputRef} type="text" value={product} onChange={e => setProduct(e.target.value)} className={field} />
          </div>
          <div className="col-span-12 sm:col-span-4">
            <label className={fieldLabel} htmlFor="haccp-receipt-supplier">{t('supplier', 'Fornitore')}</label>
            <input
              id="haccp-receipt-supplier"
              type="text"
              value={supplier}
              onChange={e => setSupplier(e.target.value)}
              list="haccp-receipt-suppliers"
              className={field}
            />
            <datalist id="haccp-receipt-suppliers">
              {suppliers.map(s => <option key={s.id} value={s.name} />)}
            </datalist>
          </div>
          <div className="col-span-6 sm:col-span-2">
            <label className={fieldLabel} htmlFor="haccp-receipt-ddt">{t('ddt', 'Documento (DDT)')}</label>
            <input id="haccp-receipt-ddt" type="text" value={ddtNumber} onChange={e => setDdtNumber(e.target.value)} className={`${field} tabular-nums`} />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <label className={fieldLabel} htmlFor="haccp-receipt-category">{t('category', 'Tipo di merce')}</label>
            <select id="haccp-receipt-category" value={category} onChange={e => setCategory(e.target.value as HaccpReceiptCategory | '')} className={dsSelect}>
              <option value="">—</option>
              {HACCP_RECEIPT_CATEGORIES.map(c => <option key={c} value={c}>{receiptCategoryLabel(c, t)}</option>)}
            </select>
          </div>
          <div className="col-span-6 sm:col-span-2">
            <label className={fieldLabel} htmlFor="haccp-receipt-lot">{t('lot', 'Lotto')}</label>
            <input id="haccp-receipt-lot" type="text" value={lotNumber} onChange={e => setLotNumber(e.target.value)} className={`${field} tabular-nums`} />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <label className={fieldLabel} htmlFor="haccp-receipt-expiry">{t('expiry', 'Scadenza')}</label>
            <input id="haccp-receipt-expiry" type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} className={`${field} tabular-nums`} />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <label className={fieldLabel} htmlFor="haccp-receipt-temp">
              {maxForCategory != null ? t('tempMax', 'Temp. (max {{gradi}} °C)', { gradi: formatNumber(maxForCategory) }) : t('temp', 'Temp. (°C)')}
            </label>
            <input
              id="haccp-receipt-temp"
              type="text"
              inputMode="decimal"
              value={temperature}
              onChange={e => setTemperature(e.target.value)}
              className={`${field} text-right tabular-nums`}
            />
          </div>
          <div className="col-span-6 sm:col-span-2">
            <span className={fieldLabel}>{t('packaging', 'Imballo integro')}</span>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setPackagingOk(true)} aria-pressed={packagingOk} className={outcomeChip(packagingOk, 'positive')}>{t('yesShort', 'Sì')}</button>
              <button type="button" onClick={() => setPackagingOk(false)} aria-pressed={!packagingOk} className={outcomeChip(!packagingOk, 'critical')}>{t('noShort', 'No')}</button>
            </div>
          </div>
          <div className="col-span-12 sm:col-span-2">
            <span className={fieldLabel}>{t('outcome', 'Esito')}</span>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => setAccepted(true)} aria-pressed={accepted} className={outcomeChip(accepted, 'positive')}>
                {t('accepted', 'Accettato')}
              </button>
              <button type="button" onClick={() => setAccepted(false)} aria-pressed={!accepted} className={outcomeChip(!accepted, 'critical')}>
                {t('rejected', 'Respinto')}
              </button>
            </div>
          </div>
          <div className="col-span-12 sm:col-span-10">
            <input
              type="text"
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={accepted ? t('notePlaceholder', 'Note (opzionale)') : t('rejectReasonPlaceholder', 'Perché è respinta')}
              aria-label={t('receiptNoteAria', 'Note ricevimento')}
              className={field}
            />
          </div>
          <div className="col-span-12 sm:col-span-2">
            <button type="submit" disabled={!product.trim() || busy} className={`w-full ${dsButton.primary}`}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('add', 'Aggiungi')}
            </button>
          </div>
          {problems.length > 0 && accepted && (
            <p className="col-span-12 text-[13px] text-[var(--ds-critical-text)]" role="status">
              {t('receiptWarn', 'Fuori norma ({{problemi}}): accettata, apre una non conformità.', { problemi: problems.join(', ') })}
            </p>
          )}
        </form>
      )}

      {rows.length === 0 ? (
        <div className={emptyNote}>{t('noRecords', 'Nessuna registrazione per oggi.')}</div>
      ) : (
        <ul className={rowList}>
          {rows.map(r => {
            const rowProblems = limits ? evaluateHaccpReceipt(r, limits) : [];
            const meta = [
              r.supplierName,
              r.ddtNumber ? t('ddtInline', 'DDT {{numero}}', { numero: r.ddtNumber }) : null,
              r.lotNumber ? t('lotShort', 'lotto {{numero}}', { numero: r.lotNumber }) : null,
              r.expiryDate ? t('expiryInline', 'scade {{giorno}}', { giorno: formatShortDate(r.expiryDate) }) : null,
              r.category ? receiptCategoryLabel(r.category, t) : null,
            ].filter(Boolean).join(' · ');
            return (
              <li key={r.id} className={row}>
                <div className="col-span-12 min-w-0 sm:col-span-6">
                  <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{r.product}</div>
                  {meta && <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">{meta}</div>}
                </div>
                <div className="col-span-4 text-right text-[15px] tabular-nums text-[var(--ds-text-secondary)] sm:col-span-2">
                  {r.temperature !== null ? `${formatNumber(r.temperature)} °C` : '—'}
                </div>
                <div className="col-span-7 sm:col-span-3">
                  <span className={`inline-flex items-center gap-1 rounded-[var(--ds-radius-control)] px-2.5 py-1 text-[13px] font-medium ${r.accepted ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]' : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'}`}>
                    {r.accepted ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                    {r.accepted ? t('accepted', 'Accettato') : t('rejected', 'Respinto')}
                  </span>
                </div>
                <div className="col-span-1 text-right">
                  {editable && (
                    <button
                      type="button"
                      onClick={() => onVoid(r)}
                      className={deleteButton}
                      title={t('void', 'Annulla')}
                      aria-label={t('voidNamed', 'Annulla la registrazione di {{nome}}', { nome: r.product })}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
                {(rowProblems.length > 0 || r.note) && (
                  <div className="col-span-12 text-[13px] text-[var(--ds-text-muted)]">
                    {[rowProblems.join(', '), r.note].filter(Boolean).join(' · ')}
                  </div>
                )}
                <RowStamp row={r} onHistory={() => onHistory(r)} />
                <NcLine nc={ncBySource.get(r.id)} onCloseNc={onCloseNc} editable={editable} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
