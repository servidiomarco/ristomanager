import React, { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { Loader2, RefreshCw, AlertTriangle, Printer, Wand2 } from 'lucide-react';
import { asIsoDay, addDays } from '../ds';
import { PeriodPicker, PeriodTrigger, Period } from '../pagamenti/PeriodPicker';
import { generateAiReport } from '../../services/aiMessagesApiService';
import { printReportistica } from '../../utils/printReportistica';
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
  const [aiReport, setAiReport] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

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

  const stampa = () => printReportistica({
    from: period.from,
    to: period.to,
    prenotazioni: prenotazioni.data,
    incassi: incassi.data,
    cucina: cucina.data,
    comunicazioni: comunicazioni.data,
  });

  // Il report AI narrativo ancora sempre a oggi: l'endpoint accetta solo un
  // numero di giorni (7–90), non un range. La didascalia lo dichiara.
  const aiDays = Math.min(90, Math.max(7, Math.round((Date.parse(period.to) - Date.parse(period.from)) / 86400000) + 1));

  const generaAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const { report } = await generateAiReport(aiDays);
      setAiReport(report);
    } catch (err: any) {
      setAiError(err?.message || 'Errore nella generazione del report');
    } finally {
      setAiLoading(false);
    }
  };

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
                onClick={stampa}
                disabled={loading || nothingYet}
                className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
                aria-label="Stampa il report"
              >
                <Printer className="h-4 w-4" />
              </button>
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

              {/* Report AI narrativo: stesso motore della Dashboard. Marcato
                  Wand2 + famiglia arriving come ogni cosa scritta dall'AI. */}
              <section className="ds-ai-frame rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                      <Wand2 className="h-5 w-5" />
                    </span>
                    <div>
                      <h2 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Lettura AI</h2>
                      <p className="text-[13px] text-[var(--ds-text-muted)]">
                        Copre sempre gli ultimi {aiDays} giorni da oggi, non il periodo scelto sopra.
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={generaAi}
                    disabled={aiLoading}
                    className="inline-flex h-10 flex-shrink-0 items-center gap-2 rounded-[10px] bg-[var(--ds-text-primary)] px-4 text-[14px] font-semibold text-[var(--ds-surface)] transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {aiLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                    {aiLoading ? 'Ci penso…' : aiReport ? 'Rigenera' : 'Genera'}
                  </button>
                </div>
                {aiError && (
                  <p className="mt-3 rounded-[10px] bg-[var(--ds-surface-row)] px-3 py-2 text-[13px] text-[var(--ds-text-muted)]">
                    {aiError}
                  </p>
                )}
                {aiReport && (
                  <div className="prose prose-sm mt-4 max-w-none text-[var(--ds-text-muted)]">
                    <ReactMarkdown>{aiReport}</ReactMarkdown>
                  </div>
                )}
              </section>
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
