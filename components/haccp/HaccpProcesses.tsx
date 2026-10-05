import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Tag, Timer, Trash2 } from 'lucide-react';
import type {
  HaccpLimits,
  HaccpNonConformity,
  HaccpPoint,
  HaccpProcess,
  HaccpProcessInput,
  HaccpProductionLog,
} from '../../services/haccpApiService';
import {
  HACCP_PROCESSES,
  HACCP_PROCESS_LABELS_IT,
  HACCP_TWO_STEP_PROCESSES,
  evaluateHaccpProcess,
  formatHaccpDuration,
} from '../../utils/haccp';
import { ModalShell, StatusPill, dsButton, dsInput, dsSelect } from '../ds';
import {
  NcLine, RowStamp, TFunc, deleteButton, quietIconButton, emptyNote, field, fieldLabel, formatLongDate, formatNumber,
  formatShortDate, formatTime, parseNumber, personName, row, rowList,
} from './haccpUi';

/* I processi della cucina con orari e temperature veri, al posto del vecchio
   «range / durata»: un abbattimento che non dice da quanti gradi è partito e
   in quanto tempo è arrivato non dimostra niente. L'esito lo calcola il
   server sui limiti del locale (Configura → Limiti); qui lo si mostra già
   mentre si compila, con la stessa regola (utils/haccp.ts). */

export const processLabel = (p: HaccpProcess, t: TFunc): string => t(`process.${p}`, HACCP_PROCESS_LABELS_IT[p]);

const isTwoStep = (p: HaccpProcess): boolean => HACCP_TWO_STEP_PROCESSES.includes(p);
const isCoreMeasure = (p: HaccpProcess): boolean => p === 'COTTURA' || p === 'RINVENIMENTO' || p === 'MANTENIMENTO_CALDO';
const usesEquipment = (p: HaccpProcess): boolean => (isTwoStep(p) && p !== 'SCONGELAMENTO') || p === 'COTTURA' || p === 'RINVENIMENTO';

const nowTime = (): string => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const nowLocal = (): string => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Il giorno del registro più l'ora del campo, come istante. */
const instantOf = (date: string, time: string): string | null => {
  if (!time) return null;
  const d = new Date(`${date}T${time}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const localInstant = (value: string): string | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const signed = (n: number | null | undefined): string =>
  typeof n === 'number' ? `${n > 0 ? '+' : ''}${formatNumber(n)} °C` : '—';

const minutesBetween = (a?: string | null, b?: string | null): number | null =>
  a && b ? Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60000) : null;

/** La riga di dettaglio di un processo, per tipo. */
export const processSummary = (r: HaccpProductionLog, t: TFunc): string => {
  const process = (r.process ?? 'LEGACY') as HaccpProcess;
  if (process === 'LEGACY') return [r.blastTempRange, r.blastDuration].filter(Boolean).join(' · ');
  if (isTwoStep(process)) {
    const start = r.startedAt ? `${formatTime(r.startedAt)} ${signed(r.startTemp)}` : '';
    if (!r.endedAt) return t('cycleStarted', 'Avviato {{inizio}}', { inizio: start });
    const mins = minutesBetween(r.startedAt, r.endedAt);
    const end = `${formatTime(r.endedAt)} ${signed(r.endTemp)}`;
    const closer = r.endedByUserName && r.endedByUserName !== r.recordedByUserName
      ? ` · ${t('closedByName', 'chiuso da {{nome}}', { nome: personName(r.endedByUserName) })}`
      : '';
    return `${start} → ${end}${mins !== null ? ` (${formatHaccpDuration(mins)})` : ''}${closer}`;
  }
  if (isCoreMeasure(process)) {
    return t('coreAt', 'Al cuore {{gradi}} alle {{ora}}', { gradi: signed(r.endTemp), ora: formatTime(r.endedAt) });
  }
  if (process === 'SANIFICAZIONE') {
    return [r.sanitizer, r.concentration, typeof r.contactMinutes === 'number' ? t('contactMin', '{{n}} minuti', { n: r.contactMinutes }) : null]
      .filter(Boolean).join(' · ');
  }
  if (process === 'CAMPIONE') {
    return [r.eventLabel, r.keepUntil ? t('keepUntil', 'conservare fino a {{quando}}', { quando: `${formatLongDate(r.keepUntil.slice(0, 10))} ${formatTime(r.keepUntil)}` }) : null]
      .filter(Boolean).join(' · ');
  }
  return '';
};

export interface ProcessDraft extends HaccpProcessInput {
  product: string;
}

export const ProcessesSection: React.FC<{
  date: string;
  rows: HaccpProductionLog[];
  equipment: HaccpPoint[];
  limits: HaccpLimits | undefined;
  ncBySource: Map<string, HaccpNonConformity>;
  editable: boolean;
  onAdd: (input: ProcessDraft) => Promise<boolean>;
  onCloseCycle: (r: HaccpProductionLog, input: { endedAt: string; endTemp: number; expiryDate: string | null }) => Promise<boolean>;
  onVoid: (r: HaccpProductionLog) => void;
  onCloseNc: (nc: HaccpNonConformity) => void;
  onHistory: (r: HaccpProductionLog) => void;
  /** L'etichetta del contenitore, con prodotto, lotto e scadenza del ciclo. */
  onLabel?: (r: HaccpProductionLog) => void;
}> = ({ date, rows, equipment, limits, ncBySource, editable, onAdd, onCloseCycle, onVoid, onCloseNc, onHistory, onLabel }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [process, setProcess] = useState<HaccpProcess>('ABBATTIMENTO');
  const [product, setProduct] = useState('');
  const [internalLot, setInternalLot] = useState('');
  const [equipmentId, setEquipmentId] = useState('');
  const [startTime, setStartTime] = useState(nowTime());
  const [startTemp, setStartTemp] = useState('');
  const [endTime, setEndTime] = useState('');
  const [endTemp, setEndTemp] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sourceLots, setSourceLots] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [sanitizer, setSanitizer] = useState('');
  const [concentration, setConcentration] = useState('');
  const [contactMinutes, setContactMinutes] = useState('');
  const [eventLabel, setEventLabel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<HaccpProductionLog | null>(null);
  const productInputRef = useRef<HTMLInputElement>(null);

  const twoStep = isTwoStep(process);
  const core = isCoreMeasure(process);

  // L'ora proposta è quella di quando si apre il modulo: si aggiorna al
  // cambio di processo, che è il gesto di chi sta per registrare.
  useEffect(() => { setStartTime(nowTime()); setEndTime(core || process === 'CAMPIONE' ? nowTime() : ''); }, [process, core]);

  const draft = useMemo((): ProcessDraft => {
    const base: ProcessDraft = {
      process,
      product: product.trim(),
      internalLot: internalLot.trim() || null,
      note: note.trim() || null,
      quantity: quantity.trim() || null,
      expiryDate: expiryDate || null,
      sourceLots: sourceLots.trim() || null,
      equipmentPointId: usesEquipment(process) && equipmentId ? Number(equipmentId) : null,
    };
    if (twoStep) {
      base.startedAt = instantOf(date, startTime);
      base.startTemp = parseNumber(startTemp);
      base.endedAt = endTime ? instantOf(date, endTime) : null;
      base.endTemp = endTime ? parseNumber(endTemp) : null;
    } else if (core || process === 'CAMPIONE') {
      base.endedAt = instantOf(date, endTime || nowTime());
      base.endTemp = core ? parseNumber(endTemp) : null;
    }
    if (process === 'SANIFICAZIONE') {
      base.sanitizer = sanitizer.trim() || null;
      base.concentration = concentration.trim() || null;
      base.contactMinutes = parseNumber(contactMinutes);
    }
    if (process === 'CAMPIONE') base.eventLabel = eventLabel.trim() || null;
    return base;
  }, [process, product, internalLot, note, quantity, expiryDate, sourceLots, equipmentId, twoStep, core, date, startTime, startTemp, endTime, endTemp, sanitizer, concentration, contactMinutes, eventLabel]);

  const preview = limits ? evaluateHaccpProcess({ process, startedAt: draft.startedAt, startTemp: draft.startTemp, endedAt: draft.endedAt, endTemp: draft.endTemp }, limits) : null;
  const missingCore = core && parseNumber(endTemp) === null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!product.trim() || busy || missingCore) return;
    setBusy(true);
    const ok = await onAdd(draft);
    setBusy(false);
    if (!ok) return;
    setProduct(''); setInternalLot(''); setStartTemp(''); setEndTemp(''); setEndTime(core || process === 'CAMPIONE' ? nowTime() : '');
    setQuantity(''); setSourceLots(''); setExpiryDate(''); setNote(''); setStartTime(nowTime());
    productInputRef.current?.focus();
  };

  const openCycles = rows.filter(r => r.process && isTwoStep(r.process) && !r.endedAt);
  const others = rows.filter(r => !openCycles.includes(r));

  return (
    <div className="space-y-2">
      {editable && (
        <form onSubmit={submit} className="grid grid-cols-12 items-end gap-2 border-b border-[var(--ds-border)] pb-4">
          <div className="col-span-12 sm:col-span-4">
            <label className={fieldLabel} htmlFor="haccp-process-type">{t('processType', 'Processo')}</label>
            <select id="haccp-process-type" value={process} onChange={e => setProcess(e.target.value as HaccpProcess)} className={dsSelect}>
              {HACCP_PROCESSES.map(p => <option key={p} value={p}>{processLabel(p, t)}</option>)}
            </select>
          </div>
          <div className="col-span-12 sm:col-span-5">
            <label className={fieldLabel} htmlFor="haccp-process-product">{process === 'SANIFICAZIONE' ? t('vegetables', 'Verdure') : t('product', 'Prodotto')}</label>
            <input id="haccp-process-product" ref={productInputRef} type="text" value={product} onChange={e => setProduct(e.target.value)} className={field} />
          </div>
          <div className="col-span-12 sm:col-span-3">
            <label className={fieldLabel} htmlFor="haccp-process-lot">{t('internalLot', 'Lotto interno')}</label>
            <input id="haccp-process-lot" type="text" value={internalLot} onChange={e => setInternalLot(e.target.value)} className={`${field} tabular-nums`} />
          </div>

          {usesEquipment(process) && equipment.length > 0 && (
            <div className="col-span-12 sm:col-span-4">
              <label className={fieldLabel} htmlFor="haccp-process-equipment">{t('equipment', 'Attrezzatura')}</label>
              <select id="haccp-process-equipment" value={equipmentId} onChange={e => setEquipmentId(e.target.value)} className={dsSelect}>
                <option value="">—</option>
                {equipment.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </div>
          )}

          {twoStep && (
            <>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-start">{t('start', 'Inizio')}</label>
                <input id="haccp-process-start" type="time" value={startTime} onChange={e => setStartTime(e.target.value)} className={`${field} tabular-nums`} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-start-temp">{t('startTemp', 'Al cuore (°C)')}</label>
                <input id="haccp-process-start-temp" inputMode="decimal" value={startTemp} onChange={e => setStartTemp(e.target.value)} className={`${field} text-right tabular-nums`} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-end">{t('endOptional', 'Fine (se già finito)')}</label>
                <input id="haccp-process-end" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className={`${field} tabular-nums`} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-end-temp">{t('endTemp', 'Fine al cuore (°C)')}</label>
                <input id="haccp-process-end-temp" inputMode="decimal" value={endTemp} disabled={!endTime} onChange={e => setEndTemp(e.target.value)} className={`${field} text-right tabular-nums disabled:opacity-50`} />
              </div>
            </>
          )}

          {core && (
            <>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-core">{t('coreTemp', 'Al cuore (°C)')}</label>
                <input id="haccp-process-core" inputMode="decimal" value={endTemp} onChange={e => setEndTemp(e.target.value)} className={`${field} text-right tabular-nums`} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-time">{t('time', 'Ora')}</label>
                <input id="haccp-process-time" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className={`${field} tabular-nums`} />
              </div>
            </>
          )}

          {process === 'SANIFICAZIONE' && (
            <>
              <div className="col-span-12 sm:col-span-4">
                <label className={fieldLabel} htmlFor="haccp-process-sanitizer">{t('sanitizer', 'Prodotto sanificante')}</label>
                <input id="haccp-process-sanitizer" value={sanitizer} onChange={e => setSanitizer(e.target.value)} className={field} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-conc">{t('concentration', 'Concentrazione')}</label>
                <input id="haccp-process-conc" value={concentration} onChange={e => setConcentration(e.target.value)} className={field} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-contact">{t('contactTime', 'Contatto (min)')}</label>
                <input id="haccp-process-contact" inputMode="numeric" value={contactMinutes} onChange={e => setContactMinutes(e.target.value)} className={`${field} text-right tabular-nums`} />
              </div>
            </>
          )}

          {process === 'CAMPIONE' && (
            <>
              <div className="col-span-12 sm:col-span-6">
                <label className={fieldLabel} htmlFor="haccp-process-event">{t('event', 'Evento o banchetto')}</label>
                <input id="haccp-process-event" value={eventLabel} onChange={e => setEventLabel(e.target.value)} className={field} />
              </div>
              <div className="col-span-6 sm:col-span-2">
                <label className={fieldLabel} htmlFor="haccp-process-sample-time">{t('sampleTime', 'Prelievo')}</label>
                <input id="haccp-process-sample-time" type="time" value={endTime} onChange={e => setEndTime(e.target.value)} className={`${field} tabular-nums`} />
              </div>
            </>
          )}

          {(twoStep || process === 'COTTURA') && (
            <div className="col-span-12 sm:col-span-4">
              <label className={fieldLabel} htmlFor="haccp-process-sources">{t('sourceLots', 'Lotti degli ingredienti')}</label>
              <input id="haccp-process-sources" value={sourceLots} onChange={e => setSourceLots(e.target.value)} className={field} />
            </div>
          )}
          {(twoStep || process === 'COTTURA') && (
            <div className="col-span-6 sm:col-span-2">
              <label className={fieldLabel} htmlFor="haccp-process-qty">{t('quantity', 'Quantità')}</label>
              <input id="haccp-process-qty" value={quantity} onChange={e => setQuantity(e.target.value)} className={field} />
            </div>
          )}
          {(twoStep || process === 'COTTURA') && (
            <div className="col-span-6 sm:col-span-2">
              <label className={fieldLabel} htmlFor="haccp-process-expiry">{t('expiry', 'Scadenza')}</label>
              <input id="haccp-process-expiry" type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} className={`${field} tabular-nums`} />
            </div>
          )}

          <div className="col-span-12 sm:col-span-10">
            <input type="text" value={note} onChange={e => setNote(e.target.value)} placeholder={t('notePlaceholder', 'Note (opzionale)')} aria-label={t('productionNoteAria', 'Note produzione')} className={field} />
          </div>
          <div className="col-span-12 sm:col-span-2">
            <button type="submit" disabled={!product.trim() || busy || missingCore} className={`w-full ${dsButton.primary}`}>
              {twoStep && !endTime ? <Timer className="h-4 w-4" aria-hidden /> : <Plus className="h-4 w-4" aria-hidden />}
              {twoStep && !endTime ? t('startCycle', 'Avvia') : t('add', 'Aggiungi')}
            </button>
          </div>
          {preview?.compliant === false && (
            <p className="col-span-12 text-[13px] text-[var(--ds-critical-text)]" role="status">
              {t('processWarn', 'Fuori limite: {{problema}}. Si apre una non conformità.', { problema: preview.problem })}
            </p>
          )}
        </form>
      )}

      {openCycles.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="text-[13px] font-medium text-[var(--ds-text-secondary)]">{t('openCycles', 'In corso')}</div>
          <ul className={rowList}>
            {openCycles.map(r => (
              <ProcessRow key={r.id} r={r} date={date} ncBySource={ncBySource} editable={editable}
                onCloseCycle={() => setClosing(r)} onVoid={onVoid} onCloseNc={onCloseNc} onHistory={onHistory} />
            ))}
          </ul>
        </div>
      )}

      {others.length === 0 && openCycles.length === 0 ? (
        <div className={emptyNote}>{t('noRecords', 'Nessuna registrazione per oggi.')}</div>
      ) : others.length > 0 && (
        <ul className={rowList}>
          {others.map(r => (
            <ProcessRow key={r.id} r={r} date={date} ncBySource={ncBySource} editable={editable}
              onVoid={onVoid} onCloseNc={onCloseNc} onHistory={onHistory} onLabel={onLabel} />
          ))}
        </ul>
      )}

      <CloseCycleDialog
        row={closing}
        limits={limits}
        onClose={() => setClosing(null)}
        onSave={async input => {
          if (!closing) return false;
          const ok = await onCloseCycle(closing, input);
          if (ok) setClosing(null);
          return ok;
        }}
      />
    </div>
  );
};

const ProcessRow: React.FC<{
  r: HaccpProductionLog;
  date: string;
  ncBySource: Map<string, HaccpNonConformity>;
  editable: boolean;
  onCloseCycle?: () => void;
  onVoid: (r: HaccpProductionLog) => void;
  onCloseNc: (nc: HaccpNonConformity) => void;
  onHistory: (r: HaccpProductionLog) => void;
  onLabel?: (r: HaccpProductionLog) => void;
}> = ({ r, date, ncBySource, editable, onCloseCycle, onVoid, onCloseNc, onHistory, onLabel }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const process = (r.process ?? 'LEGACY') as HaccpProcess;
  const extra = [
    r.equipmentLabel,
    r.quantity,
    r.sourceLots ? t('sourceLotsInline', 'ingredienti {{lotti}}', { lotti: r.sourceLots }) : null,
    r.expiryDate ? t('expiryInline', 'scade {{giorno}}', { giorno: formatShortDate(r.expiryDate) }) : null,
    r.date !== date ? t('startedOn', 'avviato {{giorno}}', { giorno: formatLongDate(r.date) }) : null,
  ].filter(Boolean).join(' · ');
  return (
    <li className={row}>
      <div className="col-span-12 min-w-0 sm:col-span-7">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{r.product}</span>
          {r.internalLot && <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)]">{t('lotInline', '· lotto {{numero}}', { numero: r.internalLot })}</span>}
          <StatusPill>{processLabel(process, t)}</StatusPill>
        </div>
        <div className="text-[13px] tabular-nums text-[var(--ds-text-secondary)]">{processSummary(r, t)}</div>
        {extra && <div className="text-[13px] text-[var(--ds-text-muted)]">{extra}</div>}
      </div>
      <div className="col-span-8 sm:col-span-4">
        {r.compliant === true && <StatusPill tone="positive">{t('compliant', 'Conforme')}</StatusPill>}
        {r.compliant === false && <StatusPill tone="critical">{t('notCompliant', 'Fuori limite')}</StatusPill>}
        {onCloseCycle && editable && (
          <button type="button" onClick={onCloseCycle} className={`${dsButton.secondary} h-9 px-3 text-[14px]`}>
            {t('closeCycle', 'Chiudi il ciclo')}
          </button>
        )}
        {onCloseCycle && !editable && <StatusPill tone="pending">{t('inProgress', 'In corso')}</StatusPill>}
      </div>
      <div className="col-span-4 flex justify-end gap-1 sm:col-span-1">
        {onLabel && (
          <button
            type="button"
            onClick={() => onLabel(r)}
            className={quietIconButton}
            title={t('labels.title', 'Etichetta')}
            aria-label={t('labels.forNamed', 'Etichetta per {{nome}}', { nome: r.product })}
          >
            <Tag className="h-4 w-4" />
          </button>
        )}
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
      {r.compliant === false && r.problem && (
        <div className="col-span-12 text-[13px] text-[var(--ds-critical-text)]">{r.problem}</div>
      )}
      {r.note && <div className="col-span-12 text-[13px] text-[var(--ds-text-muted)]">{r.note}</div>}
      <RowStamp row={r} onHistory={() => onHistory(r)} />
      <NcLine nc={ncBySource.get(r.id)} onCloseNc={onCloseNc} editable={editable} />
    </li>
  );
};

/** Il secondo tempo di un ciclo: fine e temperatura al cuore. Può arrivare
 *  il giorno dopo (la bonifica in congelatore), quindi data e ora. */
const CloseCycleDialog: React.FC<{
  row: HaccpProductionLog | null;
  limits: HaccpLimits | undefined;
  onClose: () => void;
  onSave: (input: { endedAt: string; endTemp: number; expiryDate: string | null }) => Promise<boolean>;
}> = ({ row: target, limits, onClose, onSave }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [ended, setEnded] = useState(nowLocal());
  const [temp, setTemp] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setEnded(nowLocal()); setTemp(''); setExpiry(target.expiryDate ?? ''); setBusy(false); setError(null);
  }, [target]);

  if (!target) return null;
  const process = (target.process ?? 'LEGACY') as HaccpProcess;
  const endedAt = localInstant(ended);
  const endTemp = parseNumber(temp);
  const preview = limits && endedAt && endTemp !== null
    ? evaluateHaccpProcess({ process, startedAt: target.startedAt, startTemp: target.startTemp, endedAt, endTemp }, limits)
    : null;

  const save = async () => {
    if (!endedAt || endTemp === null) {
      setError(t('closeCycleRequired', 'Servono l\'ora di fine e la temperatura al cuore.'));
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onSave({ endedAt, endTemp, expiryDate: expiry || null });
    if (!ok) setBusy(false);
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('closeCycleTitle', 'Chiudi il ciclo')}
      subtitle={`${processLabel(process, t)} · ${target.product}`}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      closeOnEscape
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('closeCycle', 'Chiudi il ciclo')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[14px] text-[var(--ds-text-muted)]">{processSummary(target, t)}</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-cycle-end" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('end', 'Fine')}</label>
            <input id="haccp-cycle-end" type="datetime-local" value={ended} onChange={e => setEnded(e.target.value)} className={`${dsInput} tabular-nums`} />
          </div>
          <div>
            <label htmlFor="haccp-cycle-temp" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('endTemp', 'Fine al cuore (°C)')}</label>
            <input id="haccp-cycle-temp" inputMode="decimal" value={temp} onChange={e => setTemp(e.target.value)} className={`${dsInput} text-right tabular-nums`} autoFocus />
          </div>
        </div>
        <div>
          <label htmlFor="haccp-cycle-expiry" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('expiryOptional', 'Scadenza (facoltativa)')}</label>
          <input id="haccp-cycle-expiry" type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={`${dsInput} tabular-nums`} />
        </div>
        {preview?.compliant === false && (
          <p className="text-[13px] text-[var(--ds-critical-text)]" role="status">
            {t('processWarn', 'Fuori limite: {{problema}}. Si apre una non conformità.', { problema: preview.problem })}
          </p>
        )}
        {preview?.compliant === true && (
          <p className="text-[13px] text-[var(--ds-seated-text)]" role="status">{t('processOk', 'Nei limiti del locale.')}</p>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
