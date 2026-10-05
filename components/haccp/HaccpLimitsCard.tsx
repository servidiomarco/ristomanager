import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, SlidersHorizontal } from 'lucide-react';
import { haccpApiService, HaccpLimits, HaccpReceiptCategory } from '../../services/haccpApiService';
import { HACCP_RECEIPT_CATEGORIES } from '../../utils/haccp';
import { Callout, dsButton, dsInput } from '../ds';
import { Card, CardHeader, emptyNote, fieldLabel, formatNumber, parseNumber } from './haccpUi';
import { receiptCategoryLabel } from './HaccpReceipts';

/* I limiti del manuale del locale: su questi il server calcola l'esito dei
   processi, dell'olio, del ricevimento e della taratura. Partono dai valori
   di riferimento dei manuali correnti; chi li cambia lascia il motivo nello
   storico, come per i limiti delle postazioni. */

type Draft = Record<string, string>;

const toDraft = (l: HaccpLimits): Draft => {
  const d: Draft = {
    blastTarget: formatNumber(l.blastChill.targetTemp),
    blastMinutes: formatNumber(l.blastChill.maxMinutes),
    freezeTarget: formatNumber(l.deepFreeze.targetTemp),
    freezeMinutes: formatNumber(l.deepFreeze.maxMinutes),
    anisakis1Temp: formatNumber(l.anisakis[0]?.temp),
    anisakis1Hours: formatNumber(l.anisakis[0]?.hours),
    anisakis2Temp: formatNumber(l.anisakis[1]?.temp),
    anisakis2Hours: formatNumber(l.anisakis[1]?.hours),
    cooking: formatNumber(l.cooking.minCore),
    reheating: formatNumber(l.reheating.minCore),
    hotHolding: formatNumber(l.hotHolding.minTemp),
    thawing: formatNumber(l.thawing.maxTemp),
    oilPolar: formatNumber(l.oil.maxPolar),
    oilTemp: formatNumber(l.oil.maxTemp),
    calibration: formatNumber(l.calibration.maxDeviation),
    sampleHours: formatNumber(l.sample.keepHours),
  };
  for (const c of HACCP_RECEIPT_CATEGORIES) d[`receipt_${c}`] = formatNumber(l.receipt[c]);
  return d;
};

const fromDraft = (d: Draft, base: HaccpLimits): HaccpLimits => {
  const n = (k: string, fallback: number): number => parseNumber(d[k] ?? '') ?? fallback;
  const anisakis = [
    { temp: parseNumber(d.anisakis1Temp ?? ''), hours: parseNumber(d.anisakis1Hours ?? '') },
    { temp: parseNumber(d.anisakis2Temp ?? ''), hours: parseNumber(d.anisakis2Hours ?? '') },
  ].filter((r): r is { temp: number; hours: number } => r.temp !== null && r.hours !== null && r.hours > 0);
  const receipt = { ...base.receipt };
  for (const c of HACCP_RECEIPT_CATEGORIES) receipt[c] = parseNumber(d[`receipt_${c}`] ?? '');
  return {
    blastChill: { targetTemp: n('blastTarget', base.blastChill.targetTemp), maxMinutes: n('blastMinutes', base.blastChill.maxMinutes) },
    deepFreeze: { targetTemp: n('freezeTarget', base.deepFreeze.targetTemp), maxMinutes: n('freezeMinutes', base.deepFreeze.maxMinutes) },
    anisakis: anisakis.length > 0 ? anisakis : base.anisakis,
    cooking: { minCore: n('cooking', base.cooking.minCore) },
    reheating: { minCore: n('reheating', base.reheating.minCore) },
    hotHolding: { minTemp: n('hotHolding', base.hotHolding.minTemp) },
    thawing: { maxTemp: n('thawing', base.thawing.maxTemp) },
    oil: { maxPolar: n('oilPolar', base.oil.maxPolar), maxTemp: n('oilTemp', base.oil.maxTemp) },
    receipt,
    calibration: { maxDeviation: n('calibration', base.calibration.maxDeviation) },
    sample: { keepHours: n('sampleHours', base.sample.keepHours) },
  };
};

export const HaccpLimitsCard: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [limits, setLimits] = useState<HaccpLimits | null>(null);
  const [defaults, setDefaults] = useState<HaccpLimits | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await haccpApiService.getSettings();
      setLimits(r.limits);
      setDefaults(r.defaults);
      setDraft(toDraft(r.limits));
      setError(null);
    } catch (e: any) {
      setError(e?.message || t('err.load', 'Errore nel caricamento'));
    }
  }, [t]);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (error && !limits) return <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>;
  if (!limits || !defaults) return <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>;

  const dirty = JSON.stringify(fromDraft(draft, limits)) !== JSON.stringify(limits);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => { setDraft(d => ({ ...d, [k]: e.target.value })); setSaved(false); };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await haccpApiService.saveSettings(fromDraft(draft, limits), reason.trim() || null);
      setLimits(r.limits);
      setDraft(toDraft(r.limits));
      setReason('');
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || t('err.save', 'Salvataggio non riuscito'));
    } finally {
      setBusy(false);
    }
  };

  const num = (id: string, label: string, unit: string) => (
    <div>
      <label htmlFor={`haccp-limit-${id}`} className={fieldLabel}>{label}</label>
      <div className="relative">
        <input
          id={`haccp-limit-${id}`}
          inputMode="decimal"
          value={draft[id] ?? ''}
          onChange={set(id)}
          placeholder="—"
          className={`${dsInput} pr-12 text-right tabular-nums`}
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-[13px] text-[var(--ds-text-muted)]">{unit}</span>
      </div>
    </div>
  );

  const group = (title: string, children: React.ReactNode) => (
    <div className="space-y-2">
      <h3 className="text-[14px] font-semibold text-[var(--ds-text-secondary)]">{title}</h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{children}</div>
    </div>
  );

  return (
    <Card>
      <CardHeader title={t('limits.title', 'Limiti del manuale')} icon={<SlidersHorizontal className="h-4 w-4" />} />
      <div className="space-y-5">
        <p className="text-[14px] text-[var(--ds-text-muted)]">
          {t('limits.intro', 'Su questi valori si calcola l\'esito di processi, olio, ricevimento e tarature. Partono dai riferimenti dei manuali correnti.')}
        </p>
        {group(t('limits.chilling', 'Abbattimento e surgelazione'), <>
          {num('blastTarget', t('limits.blastTarget', 'Abbattimento: al cuore'), '°C')}
          {num('blastMinutes', t('limits.within', 'entro'), 'min')}
          {num('freezeTarget', t('limits.freezeTarget', 'Surgelazione: al cuore'), '°C')}
          {num('freezeMinutes', t('limits.within', 'entro'), 'min')}
        </>)}
        {group(t('limits.anisakis', 'Bonifica anti-Anisakis (una delle due)'), <>
          {num('anisakis1Temp', t('limits.atMost', 'Al massimo'), '°C')}
          {num('anisakis1Hours', t('limits.forAtLeast', 'per almeno'), 'h')}
          {num('anisakis2Temp', t('limits.atMost', 'Al massimo'), '°C')}
          {num('anisakis2Hours', t('limits.forAtLeast', 'per almeno'), 'h')}
        </>)}
        {group(t('limits.heat', 'Cottura, caldo, scongelamento'), <>
          {num('cooking', t('limits.cooking', 'Cottura al cuore ≥'), '°C')}
          {num('reheating', t('limits.reheating', 'Rinvenimento ≥'), '°C')}
          {num('hotHolding', t('limits.hotHolding', 'Mantenimento a caldo ≥'), '°C')}
          {num('thawing', t('limits.thawing', 'Fine scongelamento ≤'), '°C')}
        </>)}
        {group(t('limits.oilAndTools', 'Olio, termometri, campioni'), <>
          {num('oilPolar', t('limits.oilPolar', 'Composti polari ≤'), '%')}
          {num('oilTemp', t('limits.oilTemp', 'Olio ≤'), '°C')}
          {num('calibration', t('limits.calibration', 'Scarto taratura ≤'), '°C')}
          {num('sampleHours', t('limits.sample', 'Campione testimone'), 'h')}
        </>)}
        <div className="space-y-2">
          <h3 className="text-[14px] font-semibold text-[var(--ds-text-secondary)]">{t('limits.receipt', 'Ricevimento: temperatura massima per tipo di merce')}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {HACCP_RECEIPT_CATEGORIES.map((c: HaccpReceiptCategory) => (
              <React.Fragment key={c}>{num(`receipt_${c}`, receiptCategoryLabel(c, t), '°C')}</React.Fragment>
            ))}
          </div>
          <p className="text-[13px] text-[var(--ds-text-muted)]">{t('limits.receiptHint', 'Vuoto: nessuna soglia per quel tipo.')}</p>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-[var(--ds-border)] pt-4">
          <div className="min-w-[200px] flex-1">
            <label htmlFor="haccp-limits-reason" className={fieldLabel}>{t('limits.reason', 'Perché cambiano (resta nello storico)')}</label>
            <input id="haccp-limits-reason" value={reason} onChange={e => setReason(e.target.value)} className={dsInput} />
          </div>
          <button type="button" className={dsButton.quiet} onClick={() => { setDraft(toDraft(defaults)); setSaved(false); }} disabled={busy}>
            {t('limits.reset', 'Valori di riferimento')}
          </button>
          <button type="button" className={dsButton.primary} onClick={save} disabled={busy || !dirty}>
            {t('save', 'Salva')}
          </button>
        </div>
        {saved && !dirty && <p className="text-[13px] text-[var(--ds-seated-text)]" role="status">{t('limits.saved', 'Limiti salvati.')}</p>}
        {error && <p className="text-[13px] text-[var(--ds-critical-text)]" role="alert">{error}</p>}
      </div>
    </Card>
  );
};
