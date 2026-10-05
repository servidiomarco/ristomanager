import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, ArchiveRestore, ArrowDown, ArrowUp, Flame, Pencil, Plus, Sparkles, Thermometer } from 'lucide-react';
import {
  haccpApiService,
  HaccpFrequency,
  HaccpPoint,
  HaccpRegister,
} from '../../services/haccpApiService';
import { formatHaccpLimit } from '../../utils/haccp';
import { Callout, ModalShell, SegmentedControl, dsButton, dsInput, dsTextarea } from '../ds';
import { Card, CardHeader, TFunc, chip, emptyNote, formatNumber, parseNumber, quietIconButton, rowList } from './haccpUi';
import { frequencyLabel } from './HaccpToday';

/* I punti di controllo del locale: sono il manuale di autocontrollo tradotto
   in righe del modulo. Un punto non si cancella — si archivia, e lo storico
   resta agganciato: la cella dismessa a marzo deve ancora comparire nel
   report di febbraio. Cambiare un limite resta nello storico con il motivo. */

type PointRegister = Extract<HaccpRegister, 'TEMPERATURE' | 'OIL' | 'CLEANING'>;

interface Preset { label: string; minTemp?: number | null; maxTemp?: number | null; frequency?: HaccpFrequency }

/** Modelli per chi parte da zero: un tocco e il dialogo è precompilato, il
 *  nome si corregge («Frigorifero» → «Frigo antipasti»). Valori di
 *  riferimento dei manuali correnti; il limite giusto è quello del manuale
 *  del locale. */
const presetsFor = (register: PointRegister, t: TFunc): Preset[] => {
  if (register === 'TEMPERATURE') {
    return [
      { label: t('preset.fridge', 'Frigorifero'), maxTemp: 4 },
      { label: t('preset.coldRoom', 'Cella frigo'), maxTemp: 4 },
      { label: t('preset.fish', 'Frigo pesce'), maxTemp: 2 },
      { label: t('preset.freezer', 'Congelatore'), maxTemp: -18 },
      { label: t('preset.display', 'Vetrina refrigerata'), maxTemp: 4 },
      { label: t('preset.hot', 'Banco caldo'), minTemp: 65 },
    ];
  }
  if (register === 'OIL') return [{ label: t('preset.fryer', 'Friggitrice') }];
  return [
    { label: t('preset.counters', 'Banchi di lavoro'), frequency: 'DAILY' },
    { label: t('preset.slicer', 'Affettatrice'), frequency: 'DAILY' },
    { label: t('preset.sinks', 'Lavandini'), frequency: 'DAILY' },
    { label: t('preset.floors', 'Pavimenti'), frequency: 'DAILY' },
    { label: t('preset.fridgesInside', 'Interno frigoriferi'), frequency: 'WEEKLY' },
    { label: t('preset.hoods', 'Cappe e filtri'), frequency: 'MONTHLY' },
    { label: t('preset.afterAllergens', 'Pulizia dopo allergeni'), frequency: 'ON_DEMAND' },
  ];
};

export const HaccpConfig: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [points, setPoints] = useState<HaccpPoint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ register: PointRegister; point: HaccpPoint | null; preset?: Preset } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getPoints(true);
      setPoints(r.points);
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const sections: Array<{ register: PointRegister; title: string; icon: React.ReactNode }> = [
    { register: 'TEMPERATURE', title: t('config.temperatures', 'Postazioni di temperatura'), icon: <Thermometer className="h-4 w-4" /> },
    { register: 'OIL', title: t('config.fryers', 'Friggitrici'), icon: <Flame className="h-4 w-4" /> },
    { register: 'CLEANING', title: t('config.cleaning', 'Punti di pulizia'), icon: <Sparkles className="h-4 w-4" /> },
  ];

  const move = async (register: PointRegister, list: HaccpPoint[], index: number, dir: -1 | 1) => {
    const next = [...list];
    const j = index + dir;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    setPoints(prev => prev && prev.map(p => {
      const k = next.findIndex(n => n.id === p.id);
      return k >= 0 ? { ...p, sortOrder: k + 1 } : p;
    }));
    try {
      await haccpApiService.reorderPoints(register, next.map(p => p.id));
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      load();
    }
  };

  const restore = async (p: HaccpPoint) => {
    try {
      await haccpApiService.updatePoint(p.id, { active: true });
      load();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[14px] text-[var(--ds-text-muted)]">
        {t('config.intro', 'I punti di controllo del tuo manuale di autocontrollo. Il registro del giorno chiede questi, con questi limiti.')}
      </p>
      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}
      {points === null && !error && <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>}
      {points && sections.map(section => {
        const list = points.filter(p => p.register === section.register && p.active).sort((a, b) => a.sortOrder - b.sortOrder);
        const archived = points.filter(p => p.register === section.register && !p.active);
        return (
          <Card key={section.register}>
            <CardHeader
              title={section.title}
              icon={section.icon}
              aside={
                <button
                  type="button"
                  className={`${dsButton.quiet} h-9 px-3 text-[14px]`}
                  onClick={() => setEditing({ register: section.register, point: null })}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('config.add', 'Aggiungi')}
                </button>
              }
            />
            {list.length === 0 ? (
              <div className="space-y-3 py-2">
                <p className="text-[14px] text-[var(--ds-text-muted)]">{t('config.startFrom', 'Parti da un modello:')}</p>
                <div className="flex flex-wrap gap-2">
                  {presetsFor(section.register, t).map(preset => (
                    <button
                      key={preset.label}
                      type="button"
                      className={chip}
                      onClick={() => setEditing({ register: section.register, point: null, preset })}
                    >
                      {preset.label}
                      {(preset.minTemp != null || preset.maxTemp != null) && (
                        <span className="ml-1.5 tabular-nums text-[var(--ds-text-muted)]">{formatHaccpLimit(preset.minTemp ?? null, preset.maxTemp ?? null)}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ul className={rowList}>
                {list.map((p, i) => (
                  <li key={p.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-medium text-[var(--ds-text-primary)]">{p.label}</div>
                      <div className="truncate text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                        {pointSummary(p, t)}
                      </div>
                    </div>
                    <button type="button" className={quietIconButton} disabled={i === 0} onClick={() => move(section.register, list, i, -1)} aria-label={t('config.up', 'Sposta su')}>
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" className={quietIconButton} disabled={i === list.length - 1} onClick={() => move(section.register, list, i, 1)} aria-label={t('config.down', 'Sposta giù')}>
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button type="button" className={quietIconButton} onClick={() => setEditing({ register: section.register, point: p })} aria-label={t('config.edit', 'Modifica {{nome}}', { nome: p.label })}>
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
                      <div className="min-w-0 flex-1 truncate text-[15px] text-[var(--ds-text-muted)]">{p.label}</div>
                      <button type="button" className={`${dsButton.quiet} h-9 px-3 text-[14px]`} onClick={() => restore(p)}>
                        <ArchiveRestore className="h-4 w-4" aria-hidden />
                        {t('config.restore', 'Ripristina')}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </Card>
        );
      })}
      <PointDialog target={editing} onClose={() => setEditing(null)} onSaved={load} />
    </div>
  );
};

const pointSummary = (p: HaccpPoint, t: TFunc): string => {
  const parts: string[] = [];
  if (p.register === 'TEMPERATURE') {
    parts.push(formatHaccpLimit(p.minTemp, p.maxTemp));
    if (p.checksPerDay > 1) parts.push(t('config.checksN', '{{n}} rilevazioni al giorno', { n: p.checksPerDay }));
  }
  if (p.register === 'CLEANING') parts.push(frequencyLabel(p.frequency, t));
  if (p.instructions) parts.push(p.instructions);
  return parts.filter(Boolean).join(' · ');
};

const PointDialog: React.FC<{
  target: { register: PointRegister; point: HaccpPoint | null; preset?: Preset } | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ target, onClose, onSaved }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [label, setLabel] = useState('');
  const [minTemp, setMinTemp] = useState('');
  const [maxTemp, setMaxTemp] = useState('');
  const [checksPerDay, setChecksPerDay] = useState<'1' | '2' | '3'>('1');
  const [frequency, setFrequency] = useState<HaccpFrequency>('DAILY');
  const [instructions, setInstructions] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const p = target.point;
    const preset = target.preset;
    setLabel(p?.label ?? preset?.label ?? '');
    setMinTemp(formatNumber(p ? p.minTemp : preset?.minTemp ?? null));
    setMaxTemp(formatNumber(p ? p.maxTemp : preset?.maxTemp ?? null));
    setChecksPerDay(String(p?.checksPerDay ?? 1) as '1' | '2' | '3');
    setFrequency(p?.frequency ?? preset?.frequency ?? 'DAILY');
    setInstructions(p?.instructions ?? '');
    setReason('');
    setError(null);
    setBusy(false);
  }, [target]);

  const limitsChanged = useMemo(() => {
    const p = target?.point;
    if (!p || p.register !== 'TEMPERATURE') return false;
    return parseNumber(minTemp) !== p.minTemp || parseNumber(maxTemp) !== p.maxTemp;
  }, [target, minTemp, maxTemp]);

  if (!target) return null;
  const { register, point } = target;
  const isTemp = register === 'TEMPERATURE';
  const isCleaning = register === 'CLEANING';

  const save = async () => {
    const cleanLabel = label.trim();
    if (!cleanLabel) { setError(t('config.nameRequired', 'Serve un nome.')); return; }
    const min = parseNumber(minTemp);
    const max = parseNumber(maxTemp);
    if (isTemp && min === null && max === null) { setError(t('config.limitRequired', 'Indica almeno un limite.')); return; }
    if (isTemp && min !== null && max !== null && min > max) { setError(t('config.minOverMax', 'Il minimo supera il massimo.')); return; }
    setBusy(true);
    setError(null);
    const input = {
      label: cleanLabel,
      minTemp: isTemp ? min : null,
      maxTemp: isTemp ? max : null,
      checksPerDay: isTemp ? Number(checksPerDay) : 1,
      frequency: isCleaning ? frequency : 'DAILY' as HaccpFrequency,
      instructions: instructions.trim() || null,
    };
    try {
      if (point) await haccpApiService.updatePoint(point.id, { ...input, reason: reason.trim() || null });
      else await haccpApiService.createPoint({ register, ...input });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!point) return;
    setBusy(true);
    try {
      await haccpApiService.updatePoint(point.id, { active: false, reason: reason.trim() || null });
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
      setBusy(false);
    }
  };

  const title = point
    ? t('config.editTitle', 'Modifica punto di controllo')
    : t('config.newTitle', 'Nuovo punto di controllo');

  return (
    <ModalShell
      open
      onClose={onClose}
      title={title}
      size="sm"
      bodyClassName="px-5 py-5 sm:px-6"
      footerStart={point && (
        <button type="button" className={dsButton.quiet} onClick={archive} disabled={busy}>
          {t('config.archive', 'Archivia')}
        </button>
      )}
      footer={
        <>
          <button type="button" className={dsButton.quiet} onClick={onClose} disabled={busy}>{t('cancel', 'Annulla')}</button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy}>{t('save', 'Salva')}</button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="haccp-point-label" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('config.name', 'Nome')}</label>
          <input id="haccp-point-label" value={label} onChange={e => setLabel(e.target.value)} className={dsInput} autoFocus />
        </div>
        {isTemp && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="haccp-point-min" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('config.min', 'Minimo °C')}</label>
                <input id="haccp-point-min" inputMode="decimal" value={minTemp} onChange={e => setMinTemp(e.target.value)} className={`${dsInput} tabular-nums`} placeholder="—" />
              </div>
              <div>
                <label htmlFor="haccp-point-max" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('config.max', 'Massimo °C')}</label>
                <input id="haccp-point-max" inputMode="decimal" value={maxTemp} onChange={e => setMaxTemp(e.target.value)} className={`${dsInput} tabular-nums`} placeholder="—" />
              </div>
            </div>
            <p className="-mt-2 text-[13px] text-[var(--ds-text-muted)]">
              {t('config.limitsHint', 'Frigoriferi e congelatori hanno il massimo, i banchi caldi il minimo.')}
            </p>
            <div>
              <span className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('config.checks', 'Rilevazioni al giorno')}</span>
              <SegmentedControl<'1' | '2' | '3'>
                value={checksPerDay}
                onChange={setChecksPerDay}
                ariaLabel={t('config.checks', 'Rilevazioni al giorno')}
                options={[{ value: '1', label: '1' }, { value: '2', label: '2' }, { value: '3', label: '3' }]}
              />
            </div>
          </>
        )}
        {isCleaning && (
          <div>
            <span className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('config.frequency', 'Frequenza')}</span>
            <SegmentedControl<HaccpFrequency>
              value={frequency}
              onChange={setFrequency}
              ariaLabel={t('config.frequency', 'Frequenza')}
              overflow="scroll"
              equalWidth={false}
              options={(['DAILY', 'WEEKLY', 'MONTHLY', 'ON_DEMAND'] as HaccpFrequency[]).map(f => ({ value: f, label: frequencyLabel(f, t) }))}
            />
          </div>
        )}
        <div>
          <label htmlFor="haccp-point-instr" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">
            {isCleaning ? t('config.instructionsCleaning', 'Prodotto e metodo (facoltativo)') : t('config.instructions', 'Istruzioni (facoltativo)')}
          </label>
          <textarea id="haccp-point-instr" rows={2} value={instructions} onChange={e => setInstructions(e.target.value)} className={dsTextarea} />
        </div>
        {point && (
          <div>
            <label htmlFor="haccp-point-reason" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">
              {limitsChanged ? t('config.reasonLimits', 'Perché cambia il limite (resta nello storico)') : t('reason.labelOptional', 'Motivo (facoltativo)')}
            </label>
            <input id="haccp-point-reason" value={reason} onChange={e => setReason(e.target.value)} className={dsInput} />
          </div>
        )}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </ModalShell>
  );
};
