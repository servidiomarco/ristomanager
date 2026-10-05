import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CalendarRange, Printer } from 'lucide-react';
import { haccpApiService, HaccpReportData } from '../../services/haccpApiService';
import { addDaysToIso, haccpDaysBetween, haccpPeriodRange, isOutOfRange } from '../../utils/haccp';
import { printHaccpReport } from '../../utils/printHaccpReport';
import { Callout, SegmentedControl, StatStrip, dsButton, dsInput } from '../ds';
import { Card, CardHeader, emptyNote, formatLongDate, todayISO } from './haccpUi';

/* Il report per periodo. L'ispettore chiede mesi: la scelta di default è il
   mese in corso, e il riepilogo dice prima di stampare quello che lui
   noterebbe per primo — i giorni senza registrazioni, i fuori soglia, le non
   conformità ancora aperte. */

type Preset = 'today' | 'week' | 'month' | 'lastMonth' | 'custom';

const rangeOf = (preset: Preset, custom: { from: string; to: string }): { from: string; to: string } => {
  const today = todayISO();
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'week') return { from: haccpPeriodRange('WEEKLY', today).from, to: today };
  if (preset === 'month') return { from: haccpPeriodRange('MONTHLY', today).from, to: today };
  if (preset === 'lastMonth') {
    const lastDayPrev = addDaysToIso(haccpPeriodRange('MONTHLY', today).from, -1);
    return haccpPeriodRange('MONTHLY', lastDayPrev);
  }
  return custom;
};

export const HaccpReport: React.FC<{ refreshKey: number }> = ({ refreshKey }) => {
  const { t } = useTranslation('haccp', { useSuspense: false });
  const [preset, setPreset] = useState<Preset>('month');
  const [custom, setCustom] = useState(() => ({ from: haccpPeriodRange('MONTHLY', todayISO()).from, to: todayISO() }));
  const [data, setData] = useState<HaccpReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const range = useMemo(() => rangeOf(preset, custom), [preset, custom]);
  const validRange = range.from <= range.to;

  const seq = useRef(0);
  useEffect(() => {
    if (!validRange) return;
    const mine = ++seq.current;
    setLoading(true);
    haccpApiService.getReport(range.from, range.to)
      .then(d => { if (mine === seq.current) { setData(d); setError(null); } })
      .catch(e => { if (mine === seq.current) setError(e?.message || t('err.load', 'Errore nel caricamento')); })
      .finally(() => { if (mine === seq.current) setLoading(false); });
  }, [range.from, range.to, validRange, refreshKey, t]);

  const summary = useMemo(() => {
    if (!data) return null;
    const live = <T extends { voidedAt?: string | null }>(rows: T[]) => rows.filter(r => !r.voidedAt);
    const temps = live(data.temperatures);
    const today = todayISO();
    const days = haccpDaysBetween(data.from, data.to > today ? today : data.to);
    const withRecords = new Set<string>([
      ...temps.map(r => r.date),
      ...live(data.oil).map(r => r.date),
      ...live(data.cleaning).map(r => r.date),
      ...live(data.receipts).map(r => r.date),
      ...live(data.production).map(r => r.date),
    ]);
    const tempDays = new Set(temps.map(r => r.date));
    return {
      days: days.length,
      emptyDays: days.filter(d => !withRecords.has(d)),
      daysWithoutTemps: days.filter(d => !tempDays.has(d)).length,
      temps: temps.length,
      out: temps.filter(r => isOutOfRange(r.temperature, r.targetMin, r.targetMax)).length,
      openNc: data.nonconformities.filter(n => n.status === 'OPEN').length,
      closedNc: data.nonconformities.filter(n => n.status === 'CLOSED').length,
      changes: data.changes.length,
    };
  }, [data]);

  return (
    <div className="space-y-4">
      <SegmentedControl<Preset>
        value={preset}
        onChange={setPreset}
        ariaLabel={t('report.period', 'Periodo')}
        overflow="scroll"
        equalWidth={false}
        options={[
          { value: 'today', label: t('report.today', 'Oggi') },
          { value: 'week', label: t('report.week', 'Questa settimana') },
          { value: 'month', label: t('report.month', 'Questo mese') },
          { value: 'lastMonth', label: t('report.lastMonth', 'Mese scorso') },
          { value: 'custom', label: t('report.custom', 'Intervallo') },
        ]}
      />

      {preset === 'custom' && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="haccp-report-from" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('report.from', 'Dal')}</label>
            <input id="haccp-report-from" type="date" value={custom.from} max={todayISO()} onChange={e => e.target.value && setCustom(c => ({ ...c, from: e.target.value }))} className={dsInput} />
          </div>
          <div>
            <label htmlFor="haccp-report-to" className="mb-2 block text-[14px] font-medium text-[var(--ds-text-secondary)]">{t('report.to', 'Al')}</label>
            <input id="haccp-report-to" type="date" value={custom.to} max={todayISO()} onChange={e => e.target.value && setCustom(c => ({ ...c, to: e.target.value }))} className={dsInput} />
          </div>
        </div>
      )}

      {!validRange && <Callout tone="pending" icon={CalendarRange}>{t('report.badRange', 'La data di inizio viene dopo quella di fine.')}</Callout>}
      {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

      <Card>
        <CardHeader
          title={range.from === range.to
            ? formatLongDate(range.from)
            : t('report.rangeTitle', '{{dal}} – {{al}}', { dal: formatLongDate(range.from), al: formatLongDate(range.to) })}
          icon={<CalendarRange className="h-4 w-4" />}
          aside={
            <button
              type="button"
              className={dsButton.primary}
              disabled={!data || loading || !validRange}
              onClick={() => data && printHaccpReport(data)}
            >
              <Printer className="h-4 w-4" aria-hidden />
              {t('printReport', 'Stampa report')}
            </button>
          }
        />
        {loading && !summary ? (
          <p className={emptyNote}>{t('loading', 'Caricamento…')}</p>
        ) : summary && (
          <div className="space-y-3">
            <StatStrip
              stats={[
                { label: t('report.statTemps', 'Temperature'), value: summary.temps },
                { label: t('report.statOut', 'Fuori soglia'), value: summary.out, tone: summary.out > 0 ? 'critical' : undefined },
                { label: t('report.statOpenNc', 'Non conformità aperte'), value: summary.openNc, tone: summary.openNc > 0 ? 'critical' : undefined },
                { label: t('report.statChanges', 'Correzioni'), value: summary.changes },
              ]}
            />
            {summary.emptyDays.length > 0 && (
              <Callout tone="pending" icon={AlertTriangle}>
                {t('report.emptyDays', '{{count}} giorni senza nessuna registrazione', { count: summary.emptyDays.length })}
                {summary.emptyDays.length <= 7 && `: ${summary.emptyDays.map(formatLongDate).join(', ')}`}
              </Callout>
            )}
            {summary.openNc > 0 && (
              <Callout tone="critical" icon={AlertTriangle}>
                {t('report.openNcWarn', 'Il report stampa anche le non conformità ancora senza azione correttiva.')}
              </Callout>
            )}
          </div>
        )}
      </Card>
    </div>
  );
};
