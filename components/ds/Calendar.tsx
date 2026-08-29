import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

/* ── Calendario ───────────────────────────────────────────────────────────
   Una griglia del mese sola per tutta l'app. Viveva dentro PeriodPicker, che
   sceglie un intervallo per i pagamenti; da qui la usa anche il modal
   prenotazione, che di giorni ne sceglie uno. Due calendari disegnati a mano
   sarebbero divergiti al primo ritocco.

   L'intervallo resta il modello anche per il giorno singolo: `from` e `to`
   uguali danno una cella sola accesa, senza un secondo componente che fa
   quasi la stessa cosa. */

export const asIsoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);

/** Monday-first, the Italian week. `getDay()` is Sunday-first, hence the shift. */
export const mondayIndex = (d: Date): number => (d.getDay() + 6) % 7;

export const MONTHS = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];
export const WEEKDAYS = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

export const MonthGrid: React.FC<{
  month: Date;
  from: string;
  to: string;
  todayIso: string;
  onPick: (iso: string) => void;
  /** Aggiunge l'anno accanto al mese: serve quando si puo' navigare lontano. */
  showYear?: boolean;
  /** Il titolo lo mette il chiamante — in DayPicker sta fra le due frecce. */
  hideTitle?: boolean;
  /** Giorno minimo selezionabile (ISO). Prima di questo le celle sono spente. */
  minIso?: string;
}> = ({ month, from, to, todayIso, onPick, showYear = false, hideTitle = false, minIso }) => {
  const first = startOfMonth(month);
  const leading = mondayIndex(first);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  return (
    <div className="min-w-0">
      {!hideTitle && (
        <div className="mb-2 text-center text-[14px] font-semibold text-[var(--ds-text-primary)]">
          {MONTHS[month.getMonth()]}{showYear ? ` ${month.getFullYear()}` : ''}
        </div>
      )}
      <div className="grid grid-cols-7 gap-y-1">
        {WEEKDAYS.map((w, i) => (
          <div key={i} className="pb-1 text-center text-[12px] text-[var(--ds-text-muted)]">{w}</div>
        ))}
        {Array.from({ length: leading }, (_, i) => <div key={`pad-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const day = new Date(month.getFullYear(), month.getMonth(), i + 1);
          const iso = asIsoDay(day);
          const isStart = iso === from;
          const isEnd = iso === to;
          const inRange = !!from && !!to && iso > from && iso < to;
          // Today stays marked even with nothing selected — clearing the draft
          // to pick a custom range otherwise left a grid of identical numbers
          // with no anchor to count from.
          const isToday = iso === todayIso;
          // Un giorno gia' passato non si prenota. Resta visibile — il mese
          // bucato si legge peggio di un mese con dei numeri spenti — ma non
          // risponde al clic e non finisce nella tabulazione.
          const isPast = !!minIso && iso < minIso;
          return (
            <button
              key={iso}
              type="button"
              disabled={isPast}
              onClick={() => onPick(iso)}
              aria-pressed={isStart || isEnd}
              aria-current={isToday ? 'date' : undefined}
              // 36px, not 44: a month grid at 44 does not fit two months side by
              // side on a tablet, and the cells sit in a dense field of
              // identical targets where the row/column alignment does the
              // aiming. The shortcuts above are the 44px path.
              className={`mx-auto inline-flex h-9 w-9 items-center justify-center rounded-full text-[14px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                isPast
                  ? 'cursor-not-allowed text-[var(--ds-text-subtle)] opacity-50'
                  : isStart || isEnd
                  ? 'bg-[var(--ds-action-bg)] font-semibold text-[var(--ds-action-fg)]'
                  : inRange
                    ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
                    : isToday
                      ? 'font-semibold text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)]'
                      : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)]'
              }`}
            >
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/* ── DayPicker ────────────────────────────────────────────────────────────
   MonthGrid piu' la navigazione fra i mesi, per scegliere un giorno solo.
   Il mese mostrato parte da quello del valore corrente, non da oggi: aprendo
   il calendario su una prenotazione di novembre si vuole vedere novembre. */
export const DayPicker: React.FC<{
  value: string;
  onPick: (iso: string) => void;
  className?: string;
  /** Giorno minimo selezionabile. Con `minIso` sparisce anche la freccia che
   *  porterebbe in mesi interamente passati: una pagina di celle spente. */
  minIso?: string;
}> = ({ value, onPick, className = '', minIso }) => {
  const today = new Date();
  const initial = React.useMemo(() => {
    const [y, m, d] = (value || '').split('-').map(Number);
    return y && m && d ? new Date(y, m - 1, 1) : startOfMonth(today);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const [month, setMonth] = React.useState<Date>(initial);
  // Riallinea se il valore salta a un altro mese mentre il calendario e' aperto.
  React.useEffect(() => { setMonth(initial); }, [initial]);

  const arrow =
    'inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

  return (
    <div className={`rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-raised)] ${className}`}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className={arrow}
          disabled={!!minIso && asIsoDay(new Date(month.getFullYear(), month.getMonth(), 0)) < minIso}
          onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1))}
          aria-label="Mese precedente"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
          {MONTHS[month.getMonth()]} {month.getFullYear()}
        </span>
        <button type="button" className={arrow} onClick={() => setMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1))} aria-label="Mese successivo">
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
      <MonthGrid
        month={month}
        from={value}
        to={value}
        todayIso={asIsoDay(today)}
        onPick={onPick}
        hideTitle
        minIso={minIso}
      />
    </div>
  );
};
