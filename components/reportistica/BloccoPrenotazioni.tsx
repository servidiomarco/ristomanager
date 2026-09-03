import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { CalendarCheck, Users, UserX, Ban } from 'lucide-react';
import { ReservationsReport } from '../../services/reportsApiService';
import { downloadCsv } from '../../utils/downloadCsv';
import {
  SectionCard, StatTile, EmptyChart, DeltaBadge, ShareRow, CsvButton,
  chartTooltip, BAR_FILL, BAR_MAX, CAT_DOTS, DOW_LABELS,
  formatInt, shortDay, compactTick, eachDayIso, channelLabel, nf,
} from './shared';

const rate = (parte: number, totale: number): number => (totale > 0 ? parte / totale : 0);
const ratePct = (parte: number, totale: number): string => `${nf.format(Math.round(rate(parte, totale) * 100))}%`;

export const BloccoPrenotazioni: React.FC<{ data: ReservationsReport }> = ({ data }) => {
  const { totali, precedente } = data;

  const perGiorno = React.useMemo(() => {
    const byDay = new Map(data.per_giorno.map(d => [d.giorno, d]));
    return eachDayIso(data.from, data.to).map(giorno => ({
      giorno,
      label: shortDay(giorno),
      coperti: byDay.get(giorno)?.coperti ?? 0,
      prenotazioni: byDay.get(giorno)?.prenotazioni ?? 0,
    }));
  }, [data]);

  const perDow = React.useMemo(() => {
    const byDow = new Map(data.per_dow.map(d => [d.giorno, d]));
    // Settimana da lunedì: EXTRACT(DOW) ha la domenica a 0.
    return [1, 2, 3, 4, 5, 6, 0].map(dow => ({
      label: DOW_LABELS[dow],
      coperti: byDow.get(dow)?.coperti ?? 0,
    }));
  }, [data]);

  const perOra = React.useMemo(
    () => data.per_ora.map(o => ({ label: `${o.ora}:00`, coperti: o.coperti })),
    [data]
  );

  const canaliTot = data.per_canale.reduce((n, c) => n + c.prenotazioni, 0);
  const saleTot = data.per_sala.reduce((n, s) => n + s.coperti, 0);

  const esporta = () => downloadCsv(
    `prenotazioni-per-giorno-${data.from}-${data.to}`,
    ['giorno', 'prenotazioni', 'coperti'],
    perGiorno.map(g => [g.giorno, g.prenotazioni, g.coperti])
  );

  return (
    <SectionCard
      icon={<CalendarCheck className="h-5 w-5" />}
      title="Prenotazioni e canali"
      subtitle="Per giorno solare della prenotazione · cancellate e no-show contano nei tassi, non nei trend"
      actions={<CsvButton onClick={esporta} />}
    >
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          icon={<CalendarCheck className="h-3.5 w-3.5" />}
          label="Prenotazioni"
          value={formatInt(totali.prenotazioni)}
          delta={<DeltaBadge current={totali.prenotazioni} previous={precedente.prenotazioni} />}
        />
        <StatTile
          icon={<Users className="h-3.5 w-3.5" />}
          label="Coperti"
          value={formatInt(totali.coperti)}
          hint={totali.bambini > 0 ? `di cui ${formatInt(totali.bambini)} bambini` : undefined}
          delta={<DeltaBadge current={totali.coperti} previous={precedente.coperti} />}
        />
        <StatTile
          icon={<UserX className="h-3.5 w-3.5" />}
          label="No-show"
          value={ratePct(totali.no_show, totali.prenotazioni)}
          hint={`${formatInt(totali.no_show)} su ${formatInt(totali.prenotazioni)}`}
          delta={<DeltaBadge current={rate(totali.no_show, totali.prenotazioni)} previous={rate(precedente.no_show, precedente.prenotazioni)} invert />}
        />
        <StatTile
          icon={<Ban className="h-3.5 w-3.5" />}
          label="Cancellate"
          value={ratePct(totali.cancellate, totali.prenotazioni)}
          hint={`${formatInt(totali.cancellate)} su ${formatInt(totali.prenotazioni)}`}
          delta={<DeltaBadge current={rate(totali.cancellate, totali.prenotazioni)} previous={rate(precedente.cancellate, precedente.prenotazioni)} invert />}
        />
      </div>

      {perGiorno.some(g => g.coperti > 0) ? (
        <div className="mb-4 h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={perGiorno} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--ds-border)" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={34} tickFormatter={compactTick} />
              <Tooltip {...chartTooltip} formatter={(v: number, name: string) => [formatInt(v), name === 'coperti' ? 'Coperti' : 'Prenotazioni']} />
              <Bar dataKey="coperti" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyChart message="Nessuna prenotazione nel periodo scelto." />
      )}

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">Coperti per giorno della settimana</div>
          <div className="h-[140px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perDow} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} />
                <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={34} tickFormatter={compactTick} />
                <Tooltip {...chartTooltip} formatter={(v: number) => [formatInt(v), 'Coperti']} />
                <Bar dataKey="coperti" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">Coperti per ora di arrivo</div>
          {perOra.length > 0 ? (
            <div className="h-[140px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perOra} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} />
                  <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={34} tickFormatter={compactTick} />
                  <Tooltip {...chartTooltip} formatter={(v: number) => [formatInt(v), 'Coperti']} />
                  <Bar dataKey="coperti" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="flex h-[140px] items-center justify-center text-[13px] text-[var(--ds-text-muted)]">Nessun dato</div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Da dove arrivano</div>
          {data.per_canale.length > 0 ? data.per_canale.map((c, i) => (
            <ShareRow
              key={c.canale}
              colorClass={CAT_DOTS[i % CAT_DOTS.length]}
              label={channelLabel(c.canale)}
              value={formatInt(c.prenotazioni)}
              hint={ratePct(c.prenotazioni, canaliTot)}
              share={rate(c.prenotazioni, canaliTot)}
            />
          )) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessun dato</div>
          )}
        </div>
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Coperti per sala</div>
          {data.per_sala.length > 0 ? data.per_sala.map((s, i) => (
            <ShareRow
              key={s.sala}
              colorClass={CAT_DOTS[i % CAT_DOTS.length]}
              label={s.sala}
              value={formatInt(s.coperti)}
              hint={ratePct(s.coperti, saleTot)}
              share={rate(s.coperti, saleTot)}
            />
          )) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessun dato</div>
          )}
        </div>
      </div>
    </SectionCard>
  );
};
