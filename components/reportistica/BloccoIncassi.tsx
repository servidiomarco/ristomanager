import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Banknote, Receipt, Users, HandCoins } from 'lucide-react';
import { RevenueReport } from '../../services/reportsApiService';
import { downloadCsv } from '../../utils/downloadCsv';
import {
  SectionCard, StatTile, EmptyChart, DeltaBadge, ShareRow, CsvButton,
  chartTooltip, BAR_MAX, CAT_DOTS,
  formatInt, formatEuroCents, shortDay, eachDayIso, methodLabel, nf,
} from './shared';

// Pranzo e cena sono categorie, non stati: due solidi categoria del ds.
const LUNCH_FILL = 'var(--ds-cat-4-solid)';
const DINNER_FILL = 'var(--ds-cat-1-solid)';

const euroTick = (v: number): string => {
  const eur = v / 100;
  return eur >= 1000 ? `${nf.format(Math.round(eur / 100) / 10)}k €` : `${nf.format(Math.round(eur))} €`;
};

export const BloccoIncassi: React.FC<{ data: RevenueReport }> = ({ data }) => {
  const { totali, precedente } = data;

  const perGiorno = React.useMemo(() => {
    const byDay = new Map<string, { pranzo: number; cena: number }>();
    for (const r of data.per_giorno) {
      const entry = byDay.get(r.giorno) ?? { pranzo: 0, cena: 0 };
      if (r.turno === 'LUNCH') entry.pranzo += r.incassato_cents; else entry.cena += r.incassato_cents;
      byDay.set(r.giorno, entry);
    }
    return eachDayIso(data.from, data.to).map(giorno => ({
      giorno,
      label: shortDay(giorno),
      pranzo: byDay.get(giorno)?.pranzo ?? 0,
      cena: byDay.get(giorno)?.cena ?? 0,
    }));
  }, [data]);

  const incassatoTot = data.per_metodo.filter(m => !m.non_cash).reduce((n, m) => n + m.amount_cents, 0);

  const esporta = () => downloadCsv(
    `incassi-per-giorno-${data.from}-${data.to}`,
    ['giorno', 'pranzo_eur', 'cena_eur', 'totale_eur'],
    perGiorno.map(g => [
      g.giorno,
      (g.pranzo / 100).toFixed(2),
      (g.cena / 100).toFixed(2),
      ((g.pranzo + g.cena) / 100).toFixed(2),
    ])
  );

  const esportaMetodi = () => downloadCsv(
    `metodi-pagamento-${data.from}-${data.to}`,
    ['metodo', 'importo_eur', 'movimenti', 'fuori_incassato'],
    data.per_metodo.map(m => [methodLabel(m.metodo), (m.amount_cents / 100).toFixed(2), m.movimenti, m.non_cash ? 'sì' : 'no'])
  );

  return (
    <SectionCard
      icon={<Banknote className="h-5 w-5" />}
      title="Incassi e cassa"
      subtitle="Dal libro cassa, per giorno di servizio: un conto incassato dopo mezzanotte appartiene alla sera prima"
      actions={<CsvButton onClick={esporta} />}
    >
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          icon={<Banknote className="h-3.5 w-3.5" />}
          label="Incassato"
          value={formatEuroCents(totali.incassato_cents)}
          hint={`${formatInt(totali.movimenti)} movimenti`}
          delta={<DeltaBadge current={totali.incassato_cents} previous={precedente.incassato_cents} />}
        />
        <StatTile
          icon={<Receipt className="h-3.5 w-3.5" />}
          label="Scontrino medio"
          value={formatEuroCents(totali.scontrino_medio_cents)}
          hint={`${formatInt(totali.conti)} conti chiusi`}
          delta={<DeltaBadge current={totali.scontrino_medio_cents} previous={precedente.scontrino_medio_cents} />}
        />
        <StatTile
          icon={<Users className="h-3.5 w-3.5" />}
          label="Coperto medio"
          value={formatEuroCents(totali.coperto_medio_cents)}
          hint={`${formatInt(totali.coperti)} coperti al conto`}
          delta={<DeltaBadge current={totali.coperto_medio_cents} previous={precedente.coperto_medio_cents} />}
        />
        <StatTile
          icon={<HandCoins className="h-3.5 w-3.5" />}
          label="Mance"
          value={formatEuroCents(totali.mance_cents)}
          delta={<DeltaBadge current={totali.mance_cents} previous={precedente.mance_cents} />}
        />
      </div>

      {perGiorno.some(g => g.pranzo + g.cena > 0) ? (
        <>
          <div className="mb-1 h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perGiorno} margin={{ top: 5, right: 5, left: -4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--ds-border)" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
                <YAxis domain={[0, 'auto']} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={52} tickFormatter={euroTick} />
                <Tooltip {...chartTooltip} formatter={(v: number, name: string) => [formatEuroCents(v), name === 'pranzo' ? 'Pranzo' : 'Cena']} />
                <Bar dataKey="pranzo" stackId="giorno" fill={LUNCH_FILL} maxBarSize={BAR_MAX} />
                <Bar dataKey="cena" stackId="giorno" fill={DINNER_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="mb-4 flex items-center gap-4 px-1 text-[12px] text-[var(--ds-text-muted)]">
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[var(--ds-cat-4-solid)]" aria-hidden />pranzo</span>
            <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-[var(--ds-cat-1-solid)]" aria-hidden />cena</span>
          </div>
        </>
      ) : (
        <div className="mb-4"><EmptyChart message="Nessun incasso registrato nel periodo scelto." /></div>
      )}

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="text-[13px] font-medium text-[var(--ds-text-secondary)]">Metodi di pagamento</span>
            <CsvButton onClick={esportaMetodi} label="csv" />
          </div>
          {data.per_metodo.length > 0 ? data.per_metodo.map((m, i) => (
            <ShareRow
              key={m.metodo}
              colorClass={CAT_DOTS[i % CAT_DOTS.length]}
              label={methodLabel(m.metodo)}
              value={formatEuroCents(m.amount_cents)}
              hint={m.non_cash ? 'fuori incassato' : `${formatInt(m.movimenti)} mov.`}
              share={incassatoTot > 0 && !m.non_cash ? m.amount_cents / incassatoTot : 0}
            />
          )) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessun movimento</div>
          )}
        </div>
        <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
          <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Differenze di cassa</div>
          <div className="mb-2 text-[12px] text-[var(--ds-text-muted)]">
            {formatInt(data.casse.chiuse)} sessioni chiuse su {formatInt(data.casse.sessioni)} ·
            saldo differenze {formatEuroCents(data.casse.differenza_totale_cents)}
          </div>
          {data.differenze.length > 0 ? (
            <table className="w-full text-[13px]">
              <tbody>
                {data.differenze.map(d => (
                  <tr key={`${d.giorno}-${d.turno}`} className="border-t border-[var(--ds-border)]">
                    <td className="py-1.5 pr-2 text-[var(--ds-text-primary)]">{shortDay(d.giorno)} · {d.turno === 'LUNCH' ? 'pranzo' : 'cena'}</td>
                    <td className={`tabular py-1.5 pr-2 text-right font-semibold ${d.differenza_cents < 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-seated-text)]'}`}>
                      {formatEuroCents(d.differenza_cents)}
                    </td>
                    <td className="max-w-32 truncate py-1.5 text-[12px] text-[var(--ds-text-muted)]">{d.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessuna differenza: i cassetti tornano.</div>
          )}
        </div>
      </div>
    </SectionCard>
  );
};
