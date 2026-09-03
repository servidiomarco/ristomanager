import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import { asIsoDay, addDays } from '../ds';
import { PeriodPicker, PeriodTrigger, Period } from '../pagamenti/PeriodPicker';
import {
  getReservationsReport, getRevenueReport, getDishesReport, getCommunicationsReport,
  ReservationsReport, RevenueReport, DishesReport, CommunicationsReport,
} from '../../services/reportsApiService';
import { BloccoPrenotazioni } from './BloccoPrenotazioni';
import { BloccoIncassi } from './BloccoIncassi';
import { BloccoCucina } from './BloccoCucina';
import { BloccoComunicazioni } from './BloccoComunicazioni';

/* La pagina Reportistica legge quattro endpoint indipendenti, uno per blocco:
   un errore in un'area mostra il suo banner e lascia in piedi le altre.
   Niente socket né polling — come Consumi AI, i numeri di un periodo non
   cambiano sotto gli occhi: c'è il bottone di aggiornamento. */

type Slot<T> = { data: T | null; error: string | null };
const emptySlot = <T,>(): Slot<T> => ({ data: null, error: null });

const settleSlot = <T,>(r: PromiseSettledResult<T>): Slot<T> =>
  r.status === 'fulfilled'
    ? { data: r.value, error: null }
    : { data: null, error: r.reason?.message || 'Errore nel caricamento' };

const BlockError: React.FC<{ title: string; message: string }> = ({ title, message }) => (
  <div className="flex items-center gap-2 rounded-[16px] bg-[var(--ds-critical-tint)] px-4 py-3 text-[13px] text-[var(--ds-critical-text)]">
    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
    <span><span className="font-semibold">{title}:</span> {message}</span>
  </div>
);

export const ReportisticaPage: React.FC = () => {
  const [period, setPeriod] = useState<Period>(() => {
    const today = new Date();
    return { from: asIsoDay(addDays(today, -29)), to: asIsoDay(today) };
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [prenotazioni, setPrenotazioni] = useState<Slot<ReservationsReport>>(emptySlot);
  const [incassi, setIncassi] = useState<Slot<RevenueReport>>(emptySlot);
  const [cucina, setCucina] = useState<Slot<DishesReport>>(emptySlot);
  const [comunicazioni, setComunicazioni] = useState<Slot<CommunicationsReport>>(emptySlot);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const range = { from: p.from, to: p.to };
    const [r1, r2, r3, r4] = await Promise.allSettled([
      getReservationsReport(range),
      getRevenueReport(range),
      getDishesReport(range),
      getCommunicationsReport(range),
    ]);
    setPrenotazioni(settleSlot(r1));
    setIncassi(settleSlot(r2));
    setCucina(settleSlot(r3));
    setComunicazioni(settleSlot(r4));
    setLoading(false);
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  const nothingYet = !prenotazioni.data && !incassi.data && !cucina.data && !comunicazioni.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">

          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[22px] font-bold text-[var(--ds-text-primary)]">Reportistica</h1>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                Ogni numero è confrontato col periodo precedente di pari durata.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <PeriodTrigger period={period} onClick={() => setPickerOpen(true)} />
              <button
                onClick={() => load(period)}
                disabled={loading}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                aria-label="Aggiorna"
              >
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>

          {loading && nothingYet ? (
            <div className="flex h-[240px] items-center justify-center text-[var(--ds-text-muted)]">
              <Loader2 className="h-6 w-6 animate-spin" />
            </div>
          ) : (
            <div className="space-y-5">
              {prenotazioni.data && <BloccoPrenotazioni data={prenotazioni.data} />}
              {prenotazioni.error && <BlockError title="Prenotazioni" message={prenotazioni.error} />}

              {incassi.data && <BloccoIncassi data={incassi.data} />}
              {incassi.error && <BlockError title="Incassi" message={incassi.error} />}

              {cucina.data && <BloccoCucina data={cucina.data} />}
              {cucina.error && <BlockError title="Cucina" message={cucina.error} />}

              {comunicazioni.data && <BloccoComunicazioni data={comunicazioni.data} />}
              {comunicazioni.error && <BlockError title="Comunicazioni" message={comunicazioni.error} />}
            </div>
          )}
        </div>
      </div>

      <PeriodPicker
        open={pickerOpen}
        period={period}
        onApply={next => {
          // Il periodo qui non è un filtro azzerabile: senza estremi si
          // ricade sugli ultimi 30 giorni, mai su "tutte le date".
          const today = new Date();
          const applied = next.from && next.to
            ? next
            : { from: asIsoDay(addDays(today, -29)), to: asIsoDay(today) };
          setPeriod(applied);
          setPickerOpen(false);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
};
