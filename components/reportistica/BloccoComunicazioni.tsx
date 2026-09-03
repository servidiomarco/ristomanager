import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Phone, Clock, CalendarCheck, AlertTriangle } from 'lucide-react';
import { CommunicationsReport } from '../../services/reportsApiService';
import {
  SectionCard, StatTile, EmptyChart, DeltaBadge,
  chartTooltip, BAR_FILL, BAR_MAX,
  formatInt, formatDuration, shortDay, eachDayIso, nf,
} from './shared';

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'Sms',
  email: 'Email',
};

export const BloccoComunicazioni: React.FC<{ data: CommunicationsReport }> = ({ data }) => {
  const { voce, voce_precedente } = data;

  const perGiorno = React.useMemo(() => {
    const byDay = new Map(data.voce_per_giorno.map(d => [d.giorno, d]));
    return eachDayIso(data.from, data.to).map(giorno => ({
      giorno,
      label: shortDay(giorno),
      chiamate: byDay.get(giorno)?.chiamate ?? 0,
    }));
  }, [data]);

  const conversione = voce.chiamate > 0 ? Math.round((voce.con_prenotazione / voce.chiamate) * 100) : 0;
  const conversionePrec = voce_precedente.chiamate > 0 ? voce_precedente.con_prenotazione / voce_precedente.chiamate : 0;

  return (
    <SectionCard
      icon={<Phone className="h-5 w-5" />}
      title="Sofia e comunicazioni"
      subtitle="Chiamate dell'agente vocale e messaggi in uscita nel periodo"
    >
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile
          icon={<Phone className="h-3.5 w-3.5" />}
          label="Chiamate"
          value={formatInt(voce.chiamate)}
          delta={<DeltaBadge current={voce.chiamate} previous={voce_precedente.chiamate} />}
        />
        <StatTile
          icon={<Clock className="h-3.5 w-3.5" />}
          label="Minuti al telefono"
          value={formatDuration(voce.secondi)}
          delta={<DeltaBadge current={voce.secondi} previous={voce_precedente.secondi} />}
        />
        <StatTile
          icon={<CalendarCheck className="h-3.5 w-3.5" />}
          label="Convertite"
          value={`${nf.format(conversione)}%`}
          hint={`${formatInt(voce.con_prenotazione)} prenotazioni da chiamata`}
          delta={<DeltaBadge current={voce.chiamate > 0 ? voce.con_prenotazione / voce.chiamate : 0} previous={conversionePrec} />}
        />
        <StatTile
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          label="Da ricontrollare"
          value={formatInt(voce.phantom + voce.gruppi_grandi)}
          hint={`${formatInt(voce.phantom)} phantom · ${formatInt(voce.gruppi_grandi)} gruppi grandi`}
          delta={<DeltaBadge current={voce.phantom + voce.gruppi_grandi} previous={voce_precedente.phantom + voce_precedente.gruppi_grandi} invert />}
        />
      </div>

      {perGiorno.some(g => g.chiamate > 0) ? (
        <div className="mb-4 h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={perGiorno} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" horizontal vertical={false} stroke="var(--ds-border)" />
              <XAxis dataKey="label" axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis domain={[0, 'auto']} allowDecimals={false} axisLine={false} tickLine={false} stroke="var(--ds-border-strong)" tick={{ fill: 'var(--ds-text-muted)', fontSize: 11 }} width={30} />
              <Tooltip {...chartTooltip} formatter={(v: number) => [formatInt(v), 'Chiamate']} />
              <Bar dataKey="chiamate" fill={BAR_FILL} radius={[4, 4, 0, 0]} maxBarSize={BAR_MAX} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="mb-4"><EmptyChart message="Nessuna chiamata nel periodo scelto." /></div>
      )}

      <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3">
        <div className="mb-1 text-[13px] font-medium text-[var(--ds-text-secondary)]">Messaggi in uscita</div>
        {data.messaggi.length > 0 ? (
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[var(--ds-text-muted)]">
                <th className="py-1.5 pr-2 font-medium">Canale</th>
                <th className="py-1.5 pr-2 text-right font-medium">Inviati</th>
                <th className="py-1.5 pr-2 text-right font-medium">Consegnati</th>
                <th className="py-1.5 text-right font-medium">Falliti</th>
              </tr>
            </thead>
            <tbody>
              {data.messaggi.map(m => (
                <tr key={m.canale} className="border-t border-[var(--ds-border)]">
                  <td className="py-1.5 pr-2 text-[var(--ds-text-primary)]">{CHANNEL_NAMES[m.canale] ?? m.canale}</td>
                  <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">{formatInt(m.inviati)}</td>
                  <td className="tabular py-1.5 pr-2 text-right text-[var(--ds-text-secondary)]">
                    {formatInt(m.consegnati)}
                    {m.inviati > 0 && <span className="ml-1 text-[11px] text-[var(--ds-text-muted)]">{Math.round((m.consegnati / m.inviati) * 100)}%</span>}
                  </td>
                  <td className={`tabular py-1.5 text-right font-semibold ${m.falliti > 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-secondary)]'}`}>
                    {formatInt(m.falliti)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-4 text-center text-[13px] text-[var(--ds-text-muted)]">Nessun messaggio inviato nel periodo.</div>
        )}
      </div>
    </SectionCard>
  );
};
