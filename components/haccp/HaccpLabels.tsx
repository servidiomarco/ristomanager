import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArchiveRestore, Pencil, Plus, Tag } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { haccpApiService, HaccpLabelKind, HaccpLabelPreset } from '../../services/haccpApiService';
import { HACCP_EU_ALLERGENS, HACCP_LABEL_KINDS, HACCP_LABEL_KIND_LABELS_IT, addDaysToIso } from '../../utils/haccp';
import { printHaccpLabel } from '../../utils/printHaccpLabel';
import { Callout, ModalShell, SegmentedControl, dsButton, dsInput, dsSelect } from '../ds';
import { Card, CardHeader, TFunc, chip, emptyNote, quietIconButton, rowList } from './haccpUi';

/* L'etichetta di un contenitore: prodotto, quando è stato fatto o aperto,
   fino a quando si usa, lotto, conservazione, allergeni. I modelli (Configura
   → Etichette) danno durata e conservazione con un tocco; la scadenza si
   calcola dalla data di partenza e resta correggibile. Ogni etichetta si
   registra (chi, quando, cosa) e va sulla termica scelta, o si stampa dal
   browser se non ce n'è una. */

export interface LabelPrefill {
  kind?: HaccpLabelKind;
  product?: string;
  lot?: string | null;
  expiryDate?: string | null;
  allergens?: string[];
  sourceEntity?: string;
  sourceId?: string;
}

export const labelKindLabel = (k: HaccpLabelKind, t: TFunc) => t(`labelKind.${k}`, HACCP_LABEL_KIND_LABELS_IT[k]);

const PRINTER_KEY = 'haccp.labelPrinter';
const readPrinter = (): string => { try { return localStorage.getItem(PRINTER_KEY) ?? ''; } catch { return ''; } };
const writePrinter = (v: string) => { try { localStorage.setItem(PRINTER_KEY, v); } catch { /* niente memoria: si sceglie ogni volta */ } };

const nowLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const AllergenChips: React.FC<{ value: string[]; onToggle: (a: string) => void }> = ({ value, onToggle }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  return (
    <div className="flex flex-wrap gap-1.5">
      {HACCP_EU_ALLERGENS.map(a => {
        const on = value.includes(a);
        return (
          <button
            key={a}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(a)}
            className={`inline-flex h-9 items-center rounded-[var(--ds-radius-control)] px-3 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              on ? 'bg-[var(--ds-pending-tint)] font-medium text-[var(--ds-pending-text)] ring-1 ring-inset ring-[var(--ds-pending-solid)]' : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
            }`}
          >
            {t(`allergen.${a}`, a)}
          </button>
        );
      })}
    </div>
  );
};

export const LabelDialog: React.FC<{
  prefill: LabelPrefill | null;
  onClose: () => void;
  onDone: (message: string) => void;
}> = ({ prefill, onClose, onDone }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [presets, setPresets] = useState<HaccpLabelPreset[]>([]);
  const [printers, setPrinters] = useState<string[]>([]);
  const [kind, setKind] = useState<HaccpLabelKind>('PRODUZIONE');
  const [product, setProduct] = useState('');
  const [preparedAt, setPreparedAt] = useState(nowLocal());
  const [expiry, setExpiry] = useState('');
  const [lot, setLot] = useState('');
  const [storage, setStorage] = useState('');
  const [allergens, setAllergens] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [copies, setCopies] = useState('1');
  const [printer, setPrinter] = useState('');
  // La durata del modello scelto: finché la scadenza non si tocca a mano,
  // segue la data di partenza.
  const [shelfDays, setShelfDays] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!prefill) return;
    setKind(prefill.kind ?? 'PRODUZIONE');
    setProduct(prefill.product ?? '');
    setPreparedAt(nowLocal());
    setExpiry(prefill.expiryDate ?? '');
    setLot(prefill.lot ?? '');
    setStorage('');
    setAllergens(prefill.allergens ?? []);
    setNote('');
    setCopies('1');
    setShelfDays(null);
    setError(null);
    setBusy(false);
    haccpApiService.getLabelConfig()
      .then(c => {
        setPresets(c.presets.filter(p => p.active));
        setPrinters(c.printers);
        const remembered = readPrinter();
        setPrinter(c.printers.includes(remembered) ? remembered : '');
      })
      .catch(() => { setPresets([]); setPrinters([]); });
  }, [prefill]);

  if (!prefill) return null;

  const applyPreset = (p: HaccpLabelPreset) => {
    setKind(p.kind);
    if (!product.trim() || presets.some(x => x.name === product)) setProduct(p.name);
    setStorage(p.storage ?? '');
    setAllergens(p.allergens);
    setExpiry(addDaysToIso(preparedAt.slice(0, 10), p.shelfLifeDays));
    setShelfDays(p.shelfLifeDays);
  };

  const changePreparedAt = (v: string) => {
    setPreparedAt(v);
    if (shelfDays !== null && v) setExpiry(addDaysToIso(v.slice(0, 10), shelfDays));
  };

  const toggleAllergen = (a: string) =>
    setAllergens(prev => (prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]));

  const save = async () => {
    if (!product.trim()) { setError(t('labels.productRequired', 'Serve il prodotto.')); return; }
    if (!expiry) { setError(t('labels.expiryRequired', 'Serve la scadenza.')); return; }
    setBusy(true);
    setError(null);
    try {
      const label = await haccpApiService.createLabel({
        kind,
        product: product.trim(),
        preparedAt: new Date(preparedAt).toISOString(),
        expiryDate: expiry,
        lot: lot.trim() || null,
        storage: storage.trim() || null,
        allergens,
        note: note.trim() || null,
        copies: Math.max(1, Math.min(20, parseInt(copies, 10) || 1)),
        printer: printer || null,
        sourceEntity: prefill.sourceEntity ?? null,
        sourceId: prefill.sourceId ?? null,
      });
      writePrinter(printer);
      if (!printer) printHaccpLabel(label);
      onDone(printer
        ? t('labels.sent', 'Etichetta inviata a {{stampante}}', { stampante: printer })
        : t('labels.printed', 'Etichetta registrata'));
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  const label = 'mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]';

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('labels.title', 'Etichetta')}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      closeOnEscape
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('labels.print', 'Stampa')}</button>
        </>
      }
    >
      <div className="space-y-4">
        {presets.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {presets.map(p => (
              <button key={p.id} type="button" className={chip} onClick={() => applyPreset(p)}>
                {p.name}
                <span className="ml-1.5 tabular-nums text-[var(--ds-text-muted)]">{t('labels.days', '{{n}} gg', { n: p.shelfLifeDays })}</span>
              </button>
            ))}
          </div>
        )}
        <SegmentedControl<HaccpLabelKind>
          value={kind}
          onChange={setKind}
          ariaLabel={t('labels.kind', 'Tipo di etichetta')}
          options={HACCP_LABEL_KINDS.map(k => ({ value: k, label: labelKindLabel(k, t) }))}
        />
        <div>
          <label htmlFor="haccp-label-product" className={label}>{t('product', 'Prodotto')}</label>
          <input id="haccp-label-product" value={product} onChange={e => setProduct(e.target.value)} className={dsInput} autoFocus />
        </div>
        <div className="grid grid-cols-[3fr_2fr] gap-3">
          <div>
            <label htmlFor="haccp-label-from" className={label}>{labelKindLabel(kind, t)}</label>
            <input id="haccp-label-from" type="datetime-local" value={preparedAt} onChange={e => changePreparedAt(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
          <div>
            <label htmlFor="haccp-label-expiry" className={label}>{t('labels.expiry', 'Scade il')}</label>
            <input id="haccp-label-expiry" type="date" value={expiry} onChange={e => { setExpiry(e.target.value); setShelfDays(null); }} className={`${dsInput} tabular-nums`} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-label-lot" className={label}>{t('lot', 'Lotto')}</label>
            <input id="haccp-label-lot" value={lot} onChange={e => setLot(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
          <div>
            <label htmlFor="haccp-label-storage" className={label}>{t('labels.storage', 'Conservare')}</label>
            <input id="haccp-label-storage" value={storage} onChange={e => setStorage(e.target.value)} placeholder="0/+4 °C" className={dsInput} />
          </div>
        </div>
        <div>
          <span className={label}>{t('labels.allergens', 'Allergeni')}</span>
          <AllergenChips value={allergens} onToggle={toggleAllergen} />
        </div>
        <div>
          <label htmlFor="haccp-label-note" className={label}>{t('notePlaceholder', 'Note (opzionale)')}</label>
          <input id="haccp-label-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label htmlFor="haccp-label-printer" className={label}>{t('labels.printer', 'Stampante')}</label>
            <select id="haccp-label-printer" value={printer} onChange={e => setPrinter(e.target.value)} className={dsSelect}>
              <option value="">{t('labels.browser', 'Dal browser')}</option>
              {printers.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="haccp-label-copies" className={label}>{t('labels.copies', 'Copie')}</label>
            <input id="haccp-label-copies" inputMode="numeric" value={copies} onChange={e => setCopies(e.target.value)} className={`${dsInput} text-right tabular-nums`} />
          </div>
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};

// =============================================================================
// Modelli (Configura)
// =============================================================================

interface PresetDraft { id: number | null; name: string; kind: HaccpLabelKind; days: string; storage: string; allergens: string[]; active: boolean }

const emptyDraft = (): PresetDraft => ({ id: null, name: '', kind: 'PRODUZIONE', days: '3', storage: '0/+4 °C', allergens: [], active: true });

/** Durate di riferimento per partire: quella giusta è la shelf-life del
 *  manuale del locale, e si corregge nel dialogo. */
const starterPresets = (t: TFunc): PresetDraft[] => [
  { ...emptyDraft(), name: t('labels.starter.cooked', 'Preparazione cotta'), days: '3' },
  { ...emptyDraft(), name: t('labels.starter.opened', 'Conserva aperta'), kind: 'APERTURA', days: '3' },
  { ...emptyDraft(), name: t('labels.starter.thawed', 'Prodotto scongelato'), kind: 'SCONGELAMENTO', days: '1' },
];

export const HaccpLabelPresetsCard: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [presets, setPresets] = useState<HaccpLabelPreset[] | null>(null);
  const [draft, setDraft] = useState<PresetDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getLabelConfig();
      setPresets(r.presets);
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const save = async () => {
    if (!draft) return;
    const days = parseInt(draft.days, 10);
    if (!draft.name.trim() || !Number.isFinite(days) || days < 0) {
      setError(t('labels.presetInvalid', 'Servono il nome e i giorni di durata.'));
      return;
    }
    setBusy(true);
    try {
      const input = { name: draft.name.trim(), kind: draft.kind, shelfLifeDays: days, storage: draft.storage.trim() || null, allergens: draft.allergens, active: draft.active };
      if (draft.id === null) await haccpApiService.createLabelPreset(input);
      else await haccpApiService.updateLabelPreset(draft.id, input);
      setDraft(null);
      setError(null);
      load();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
    } finally {
      setBusy(false);
    }
  };

  const edit = (p: HaccpLabelPreset) => setDraft({
    id: p.id, name: p.name, kind: p.kind, days: String(p.shelfLifeDays), storage: p.storage ?? '', allergens: p.allergens, active: p.active,
  });

  const active = (presets ?? []).filter(p => p.active);
  const archived = (presets ?? []).filter(p => !p.active);
  const label = 'mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]';

  return (
    <Card>
      <CardHeader
        title={t('labels.presets', 'Modelli di etichetta')}
        icon={<Tag className="h-4 w-4" />}
        aside={
          <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => setDraft(emptyDraft())}>
            <Plus className="h-4 w-4" aria-hidden />
            {t('config.add', 'Aggiungi')}
          </button>
        }
      />
      {error && !draft && <div className="mb-3"><Callout tone="critical" icon={AlertTriangle}>{error}</Callout></div>}
      {presets === null && !error && <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>}
      {presets !== null && active.length === 0 && (
        <div className="space-y-3 py-2">
          <p className="text-[14px] text-[var(--ds-text-muted)]">{t('config.startFrom', 'Parti da un modello:')}</p>
          <div className="flex flex-wrap gap-2">
            {starterPresets(t).map(p => (
              <button key={p.name} type="button" className={chip} onClick={() => setDraft(p)}>
                {p.name}
                <span className="ml-1.5 tabular-nums text-[var(--ds-text-muted)]">{t('labels.days', '{{n}} gg', { n: p.days })}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {active.length > 0 && (
        <ul className={rowList}>
          {active.map(p => (
            <li key={p.id} className="flex items-center gap-2 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{p.name}</div>
                <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                  {[labelKindLabel(p.kind, t), t('labels.daysLong', '{{n}} giorni', { n: p.shelfLifeDays }), p.storage, p.allergens.join(', ')].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button type="button" className={quietIconButton} onClick={() => edit(p)} aria-label={t('config.edit', 'Modifica {{nome}}', { nome: p.name })}>
                <Pencil className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {archived.length > 0 && (
        <details className="mt-3 border-t border-[var(--ds-border)] pt-2">
          <summary className="flex h-11 cursor-pointer items-center text-[14px] text-[var(--ds-text-muted)]">
            {t('config.archived', 'Archiviati ({{count}})', { count: archived.length })}
          </summary>
          <ul className={rowList}>
            {archived.map(p => (
              <li key={p.id} className="flex items-center gap-2 py-2">
                <div className="min-w-0 flex-1 truncate text-[15px] text-[var(--ds-text-muted)]">{p.name}</div>
                <button
                  type="button"
                  className={`${dsButton.quiet} h-9 px-3 text-[14px]`}
                  onClick={() => haccpApiService.updateLabelPreset(p.id, { active: true }).then(load).catch((e: any) => setError(e?.message || t('err.save', 'Salvataggio non riuscito')))}
                >
                  <ArchiveRestore className="h-4 w-4" aria-hidden />
                  {t('config.restore', 'Ripristina')}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {draft && (
        <ModalShell
          open
          onClose={() => { setDraft(null); setError(null); }}
          title={draft.id === null ? t('labels.newPreset', 'Nuovo modello') : draft.name}
          size="sm"
          bodyClassName="px-5 py-5 sm:px-6"
          closeOnEscape
          footer={
            <>
              {draft.id !== null && draft.active && (
                <button
                  type="button"
                  className={`${dsButton.quiet} mr-auto`}
                  disabled={busy}
                  onClick={() => { setDraft({ ...draft, active: false }); }}
                >
                  {t('config.archive', 'Archivia')}
                </button>
              )}
              <button type="button" className={dsButton.quiet} onClick={() => { setDraft(null); setError(null); }} disabled={busy}>{t('cancel', 'Annulla')}</button>
              <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('save', 'Salva')}</button>
            </>
          }
        >
          <div className="space-y-4">
            {!draft.active && (
              <Callout tone="info" icon={ArchiveRestore}>{t('labels.willArchive', 'Salvando, il modello va tra gli archiviati.')}</Callout>
            )}
            <div>
              <label htmlFor="haccp-preset-name" className={label}>{t('product', 'Prodotto')}</label>
              <input id="haccp-preset-name" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} className={dsInput} autoFocus />
            </div>
            <SegmentedControl<HaccpLabelKind>
              value={draft.kind}
              onChange={kind => setDraft({ ...draft, kind })}
              ariaLabel={t('labels.kind', 'Tipo di etichetta')}
              options={HACCP_LABEL_KINDS.map(k => ({ value: k, label: labelKindLabel(k, t) }))}
            />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="haccp-preset-days" className={label}>{t('labels.shelfLife', 'Durata (giorni)')}</label>
                <input id="haccp-preset-days" inputMode="numeric" value={draft.days} onChange={e => setDraft({ ...draft, days: e.target.value })} className={`${dsInput} text-right tabular-nums`} />
              </div>
              <div>
                <label htmlFor="haccp-preset-storage" className={label}>{t('labels.storage', 'Conservare')}</label>
                <input id="haccp-preset-storage" value={draft.storage} onChange={e => setDraft({ ...draft, storage: e.target.value })} className={dsInput} />
              </div>
            </div>
            <div>
              <span className={label}>{t('labels.allergens', 'Allergeni')}</span>
              <AllergenChips
                value={draft.allergens}
                onToggle={a => setDraft({ ...draft, allergens: draft.allergens.includes(a) ? draft.allergens.filter(x => x !== a) : [...draft.allergens, a] })}
              />
            </div>
            {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
          </div>
        </ModalShell>
      )}
    </Card>
  );
};
