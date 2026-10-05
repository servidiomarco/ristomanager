import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  HaccpCalibration,
  HaccpCalibrationMethod,
  HaccpCalibrationOutcome,
  HaccpLimits,
  HaccpPoint,
} from '../../services/haccpApiService';
import { haccpCalibrationDeviation, haccpPeriodRange } from '../../utils/haccp';
import { ModalShell, SegmentedControl, StatusPill, dsButton, dsInput, dsSelect } from '../ds';
import { TFunc, formatLongDate, formatNumber, frequencyLabel, parseNumber, rowList } from './haccpUi';

/* La taratura dei termometri: è la verifica che i numeri del registro siano
   veri. Ogni termometro ha la sua frequenza (di solito ogni sei mesi); la
   scheda dice quale è ancora da fare nel suo periodo. Uno scarto oltre il
   limite apre una non conformità, già chiusa se il termometro è stato
   ricalibrato o sostituito sul momento. */

const METHOD_LABELS_IT: Record<HaccpCalibrationMethod, string> = {
  GHIACCIO: 'Ghiaccio fondente (0 °C)',
  EBOLLIZIONE: 'Acqua in ebollizione (100 °C)',
  RIFERIMENTO: 'Termometro di riferimento',
};
const OUTCOME_LABELS_IT: Record<HaccpCalibrationOutcome, string> = {
  OK: 'Nei limiti',
  CORRETTO: 'Ricalibrato',
  SOSTITUITO: 'Sostituito',
};

export const calibrationMethodLabel = (m: HaccpCalibrationMethod, t: TFunc) => t(`calibration.method.${m}`, METHOD_LABELS_IT[m]);
export const calibrationOutcomeLabel = (o: HaccpCalibrationOutcome, t: TFunc) => t(`calibration.outcome.${o}`, OUTCOME_LABELS_IT[o]);

export const CalibrationsList: React.FC<{
  date: string;
  thermometers: HaccpPoint[];
  last: Map<number, HaccpCalibration>;
  limits: HaccpLimits | undefined;
  editable: boolean;
  onSave: (input: {
    pointId: number; method: HaccpCalibrationMethod; referenceTemp: number; measuredTemp: number;
    outcome: HaccpCalibrationOutcome; note: string | null;
  }) => Promise<boolean>;
}> = ({ date, thermometers, last, limits, editable, onSave }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [target, setTarget] = useState<HaccpPoint | null>(null);

  return (
    <>
      <ul className={rowList}>
        {thermometers.map(p => {
          const c = last.get(p.id);
          const range = haccpPeriodRange(p.frequency, date);
          const done = !!c && c.date >= range.from && c.date <= range.to;
          const dev = c ? haccpCalibrationDeviation(c.referenceTemp, c.measuredTemp) : null;
          return (
            <li key={p.id} className="flex flex-wrap items-center gap-2 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{p.label}</div>
                <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                  {frequencyLabel(p.frequency, t)}
                  {c && ` · ${t('calibration.last', 'ultima {{giorno}}, scarto {{scarto}} °C', { giorno: formatLongDate(c.date), scarto: formatNumber(dev) })}`}
                  {c && c.outcome !== 'OK' && ` · ${calibrationOutcomeLabel(c.outcome, t).toLowerCase()}`}
                </div>
              </div>
              {done
                ? <StatusPill tone="positive">{t('calibration.done', 'Fatta')}</StatusPill>
                : <StatusPill tone="pending">{t('calibration.due', 'Da fare')}</StatusPill>}
              {editable && (
                <button type="button" onClick={() => setTarget(p)} className={`${dsButton.quiet} h-9 px-3 text-[14px]`}>
                  {t('calibration.record', 'Registra')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <CalibrationDialog
        point={target}
        maxDeviation={limits?.calibration.maxDeviation ?? 1}
        onClose={() => setTarget(null)}
        onSave={async input => {
          if (!target) return false;
          const ok = await onSave({ pointId: target.id, ...input });
          if (ok) setTarget(null);
          return ok;
        }}
      />
    </>
  );
};

const CalibrationDialog: React.FC<{
  point: HaccpPoint | null;
  maxDeviation: number;
  onClose: () => void;
  onSave: (input: { method: HaccpCalibrationMethod; referenceTemp: number; measuredTemp: number; outcome: HaccpCalibrationOutcome; note: string | null }) => Promise<boolean>;
}> = ({ point, maxDeviation, onClose, onSave }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [method, setMethod] = useState<HaccpCalibrationMethod>('GHIACCIO');
  const [reference, setReference] = useState('0');
  const [measured, setMeasured] = useState('');
  const [outcome, setOutcome] = useState<HaccpCalibrationOutcome>('OK');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!point) return;
    setMethod('GHIACCIO'); setReference('0'); setMeasured(''); setOutcome('OK'); setNote(''); setBusy(false); setError(null);
  }, [point]);

  // Ghiaccio fondente ed ebollizione hanno il riferimento fisso; il
  // termometro di riferimento si legge e si scrive.
  useEffect(() => {
    if (method === 'GHIACCIO') setReference('0');
    if (method === 'EBOLLIZIONE') setReference('100');
  }, [method]);

  if (!point) return null;
  const ref = parseNumber(reference);
  const meas = parseNumber(measured);
  const deviation = ref !== null && meas !== null ? haccpCalibrationDeviation(ref, meas) : null;
  const over = deviation !== null && deviation > maxDeviation;

  const save = async () => {
    if (ref === null || meas === null) {
      setError(t('calibration.required', 'Servono il riferimento e la lettura del termometro.'));
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onSave({ method, referenceTemp: ref, measuredTemp: meas, outcome, note: note.trim() || null });
    if (!ok) setBusy(false);
  };

  return (
    <ModalShell
      open
      onClose={onClose}
      title={t('calibration.title', 'Taratura')}
      subtitle={point.label}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      closeOnEscape
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('save', 'Salva')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="haccp-cal-method" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('calibration.methodLabel', 'Metodo')}</label>
          <select id="haccp-cal-method" value={method} onChange={e => setMethod(e.target.value as HaccpCalibrationMethod)} className={dsSelect}>
            {(['GHIACCIO', 'EBOLLIZIONE', 'RIFERIMENTO'] as HaccpCalibrationMethod[]).map(m => (
              <option key={m} value={m}>{calibrationMethodLabel(m, t)}</option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-cal-ref" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('calibration.reference', 'Riferimento °C')}</label>
            <input id="haccp-cal-ref" inputMode="decimal" value={reference} disabled={method !== 'RIFERIMENTO'} onChange={e => setReference(e.target.value)} className={`${dsInput} text-right tabular-nums disabled:opacity-60`} />
          </div>
          <div>
            <label htmlFor="haccp-cal-meas" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('calibration.measured', 'Letto °C')}</label>
            <input id="haccp-cal-meas" inputMode="decimal" value={measured} onChange={e => setMeasured(e.target.value)} className={`${dsInput} text-right tabular-nums`} autoFocus />
          </div>
        </div>
        {deviation !== null && (
          <p className={`text-[13px] ${over ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-seated-text)]'}`} role="status">
            {over
              ? t('calibration.over', 'Scarto {{scarto}} °C, oltre il massimo di {{massimo}} °C: si apre una non conformità.', { scarto: formatNumber(deviation), massimo: formatNumber(maxDeviation) })
              : t('calibration.ok', 'Scarto {{scarto}} °C, nei limiti.', { scarto: formatNumber(deviation) })}
          </p>
        )}
        <div>
          <span className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('calibration.outcomeLabel', 'Esito')}</span>
          <SegmentedControl<HaccpCalibrationOutcome>
            value={outcome}
            onChange={setOutcome}
            ariaLabel={t('calibration.outcomeLabel', 'Esito')}
            options={(['OK', 'CORRETTO', 'SOSTITUITO'] as HaccpCalibrationOutcome[]).map(o => ({ value: o, label: calibrationOutcomeLabel(o, t) }))}
          />
        </div>
        <div>
          <label htmlFor="haccp-cal-note" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('notePlaceholder', 'Note (opzionale)')}</label>
          <input id="haccp-cal-note" value={note} onChange={e => setNote(e.target.value)} className={dsInput} />
        </div>
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
