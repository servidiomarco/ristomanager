import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, Loader2, Plus, Trash2, Wand2, X } from 'lucide-react';
import {
  haccpApiService,
  type HaccpDdtProposal,
  type HaccpGoodsReceipt,
  type HaccpLimits,
  type HaccpNonConformity,
  type HaccpReceiptCategory,
} from '../../services/haccpApiService';
import type { Supplier } from '../../services/shoppingApiService';
import { HACCP_RECEIPT_CATEGORIES, HACCP_RECEIPT_CATEGORY_LABELS_IT, evaluateHaccpReceipt } from '../../utils/haccp';
import { Callout, ModalShell, dsButton, dsSelect } from '../ds';
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
        <DdtScan
          date={date}
          suppliers={suppliers}
          limits={limits}
          onAdd={onAdd}
          onFillForm={(sup, ddt) => { setSupplier(sup); setDdtNumber(ddt); }}
        />
      )}
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

// =============================================================================
// Lettura AI della bolla
// =============================================================================

const DDT_MAX_BYTES = 5 * 1024 * 1024;

const readAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

interface DdtLine {
  key: number;
  include: boolean;
  product: string;
  category: HaccpReceiptCategory | '';
  lotNumber: string;
  expiryDate: string;
  temperature: string;
  quantity: string | null;
}

/** La foto (o il PDF) della bolla: il modello propone fornitore, documento
 *  e righe; si correggono, si aggiunge la temperatura misurata e si
 *  registrano. Niente va a registro senza il tocco di chi riceve. */
const DdtScan: React.FC<{
  date: string;
  suppliers: Supplier[];
  limits: HaccpLimits | undefined;
  onAdd: (input: ReceiptInput) => Promise<boolean>;
  /** Fornitore e documento passano anche al modulo, per le righe che il
   *  modello non ha letto. */
  onFillForm: (supplier: string, ddtNumber: string) => void;
}> = ({ date, suppliers, limits, onAdd, onFillForm }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const inputRef = useRef<HTMLInputElement>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<HaccpDdtProposal | null>(null);
  const [supplier, setSupplier] = useState('');
  const [ddtNumber, setDdtNumber] = useState('');
  const [lines, setLines] = useState<DdtLine[]>([]);
  const [saving, setSaving] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > DDT_MAX_BYTES) { setError(t('ddtScan.tooBig', 'File troppo grande: massimo 5 MB.')); return; }
    setScanning(true);
    setError(null);
    try {
      const data = await readAsBase64(file);
      const p = await haccpApiService.scanDdt({ contentType: file.type || 'application/octet-stream', data });
      if (p.lines.length === 0) {
        setError(t('ddtScan.empty', 'Nessuna riga letta: prova con una foto più nitida.'));
        return;
      }
      setProposal(p);
      setSupplier(p.supplierMatch?.name ?? p.supplier ?? '');
      setDdtNumber(p.ddtNumber ?? '');
      setLines(p.lines.map((l, i) => ({
        key: i,
        include: true,
        product: l.product,
        category: l.category ?? '',
        lotNumber: l.lotNumber ?? '',
        expiryDate: l.expiryDate ?? '',
        temperature: '',
        quantity: l.quantity,
      })));
    } catch (e: any) {
      const code = e?.data?.code;
      setError(code === 'ddt_not_configured'
        ? t('ddtScan.notConfigured', 'La lettura delle bolle non è attiva.')
        : e?.message || t('ddtScan.failed', 'Lettura non riuscita'));
    } finally {
      setScanning(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const setLine = (key: number, patch: Partial<DdtLine>) =>
    setLines(prev => prev.map(l => (l.key === key ? { ...l, ...patch } : l)));

  const close = () => {
    onFillForm(supplier, ddtNumber);
    setProposal(null);
    setLines([]);
  };

  const save = async () => {
    setSaving(true);
    const name = supplier.trim();
    const match = suppliers.find(s => s.name.trim().toLowerCase() === name.toLowerCase());
    for (const l of lines.filter(x => x.include && x.product.trim())) {
      const ok = await onAdd({
        product: l.product.trim(),
        lotNumber: l.lotNumber.trim() || null,
        temperature: parseNumber(l.temperature),
        accepted: true,
        note: l.quantity,
        supplierId: match?.id ?? null,
        supplierName: name || null,
        ddtNumber: ddtNumber.trim() || null,
        expiryDate: l.expiryDate || null,
        packagingOk: true,
        category: l.category || null,
      });
      // Una riga che non passa ferma il giro: le registrate escono dal
      // dialogo, così riprovare non le scrive due volte.
      if (!ok) { setSaving(false); return; }
      setLines(prev => prev.filter(x => x.key !== l.key));
    }
    setSaving(false);
    close();
  };

  const count = lines.filter(l => l.include && l.product.trim()).length;
  const small = 'h-10 w-full min-w-0 rounded-[var(--ds-radius-control)] bg-[var(--ds-surface-row)] px-3 text-[14px] text-[var(--ds-text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="hidden"
        onChange={e => pick(e.target.files?.[0])}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={scanning}
        className={`${dsButton.secondary} h-9 px-3 text-[14px]`}
      >
        {scanning ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Wand2 className="h-4 w-4 text-[var(--ds-arriving-text)]" aria-hidden />}
        {scanning ? t('ddtScan.reading', 'Lettura della bolla…') : t('ddtScan.read', 'Leggi la bolla')}
      </button>
      {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}

      {proposal && (
        <ModalShell
          open
          onClose={close}
          title={t('ddtScan.title', 'Bolla letta')}
          size="lg"
          bodyClassName="px-5 py-5 sm:px-6"
          footer={
            <>
              <button type="button" className={dsButton.quiet} onClick={close} disabled={saving}>{t('cancel', 'Annulla')}</button>
              <button type="button" className={dsButton.primary} onClick={save} disabled={saving || count === 0}>
                {t('ddtScan.register', 'Registra {{count}} righe', { count })}
              </button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-12 sm:col-span-8">
                <label className={fieldLabel} htmlFor="haccp-ddt-supplier">{t('supplier', 'Fornitore')}</label>
                <input id="haccp-ddt-supplier" value={supplier} onChange={e => setSupplier(e.target.value)} list="haccp-receipt-suppliers" className={field} />
              </div>
              <div className="col-span-12 sm:col-span-4">
                <label className={fieldLabel} htmlFor="haccp-ddt-number">{t('ddt', 'Documento (DDT)')}</label>
                <input id="haccp-ddt-number" value={ddtNumber} onChange={e => setDdtNumber(e.target.value)} className={`${field} tabular-nums`} />
              </div>
            </div>
            {proposal.warnings.length > 0 && (
              <Callout tone="pending" icon={AlertTriangle}>{proposal.warnings.join(' · ')}</Callout>
            )}
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              {t('ddtScan.check', 'Controlla le righe e aggiungi la temperatura misurata.')}
            </p>
            <ul className="space-y-2">
              {lines.map(l => {
                const problems = limits && l.include ? evaluateHaccpReceipt({
                  date,
                  category: l.category || null,
                  temperature: parseNumber(l.temperature),
                  expiryDate: l.expiryDate || null,
                  packagingOk: true,
                }, limits) : [];
                const max = l.category && limits ? limits.receipt[l.category] : null;
                return (
                  <li key={l.key} className={`grid grid-cols-12 gap-2 rounded-[var(--ds-radius-sm)] p-3 ring-1 ring-inset ring-[var(--ds-border)] ${l.include ? '' : 'opacity-60'}`}>
                    <label className="col-span-12 flex min-h-[44px] items-center gap-3 sm:col-span-5">
                      <input
                        type="checkbox"
                        checked={l.include}
                        onChange={e => setLine(l.key, { include: e.target.checked })}
                        className="h-5 w-5 flex-shrink-0 accent-[var(--ds-action-bg)]"
                        aria-label={t('ddtScan.include', 'Registra {{nome}}', { nome: l.product })}
                      />
                      <input
                        value={l.product}
                        onChange={e => setLine(l.key, { product: e.target.value })}
                        aria-label={t('product', 'Prodotto')}
                        className={`${small} font-medium`}
                      />
                    </label>
                    <select
                      value={l.category}
                      onChange={e => setLine(l.key, { category: e.target.value as HaccpReceiptCategory | '' })}
                      aria-label={t('category', 'Tipo di merce')}
                      className={`${small} col-span-6 sm:col-span-2`}
                    >
                      <option value="">—</option>
                      {HACCP_RECEIPT_CATEGORIES.map(c => <option key={c} value={c}>{receiptCategoryLabel(c, t)}</option>)}
                    </select>
                    <input
                      value={l.lotNumber}
                      onChange={e => setLine(l.key, { lotNumber: e.target.value })}
                      placeholder={t('lot', 'Lotto')}
                      aria-label={t('lot', 'Lotto')}
                      className={`${small} col-span-6 tabular-nums sm:col-span-2`}
                    />
                    <input
                      type="date"
                      value={l.expiryDate}
                      onChange={e => setLine(l.key, { expiryDate: e.target.value })}
                      aria-label={t('expiry', 'Scadenza')}
                      className={`${small} col-span-6 tabular-nums sm:col-span-2`}
                    />
                    <input
                      inputMode="decimal"
                      value={l.temperature}
                      onChange={e => setLine(l.key, { temperature: e.target.value })}
                      placeholder={max != null ? t('ddtScan.tempMax', '≤ {{gradi}} °C', { gradi: formatNumber(max) }) : '°C'}
                      aria-label={t('temp', 'Temp. (°C)')}
                      className={`${small} col-span-6 text-right tabular-nums sm:col-span-1`}
                    />
                    {(l.quantity || problems.length > 0) && (
                      <div className="col-span-12 text-[13px]">
                        {l.quantity && <span className="text-[var(--ds-text-muted)]">{l.quantity}</span>}
                        {l.quantity && problems.length > 0 && <span className="text-[var(--ds-text-muted)]"> · </span>}
                        {problems.length > 0 && (
                          <span className="text-[var(--ds-critical-text)]">
                            {t('ddtScan.problem', 'Fuori norma ({{problemi}}): apre una non conformità.', { problemi: problems.join(', ') })}
                          </span>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </ModalShell>
      )}
    </div>
  );
};
