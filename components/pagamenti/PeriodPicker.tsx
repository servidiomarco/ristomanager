import React, { useMemo, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { ModalShell, dsButton } from '../ds';

/* ── Period selector for the payment links ───────────────────────────────
   What this replaces: two bare `<input type="date">` sitting in a filter row.
   They worked, but the two questions actually asked of this page — "what came
   in today?" and "what is still open this week?" — both cost two date pickers
   and some arithmetic. The shortcuts answer them in one tap and the calendar
   stays for everything else.

   Deliberately still just `from`/`to` strings underneath: the list query is
   unchanged, this only changes how those two values get chosen. */

const asIsoDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const addDays = (d: Date, n: number): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const startOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);

/** Monday-first, the Italian week. `getDay()` is Sunday-first, hence the shift. */
const mondayIndex = (d: Date): number => (d.getDay() + 6) % 7;

const MONTHS = [
  'Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
  'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre',
];
const WEEKDAYS = ['L', 'M', 'M', 'G', 'V', 'S', 'D'];

export type Period = { from: string; to: string };

const shortDay = (iso: string): string => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
};

/**
 * The label the trigger shows: "Oggi", "Ieri", "1 – 4 ago".
 *
 * With no filter set there is no chosen range to name, and the word that stood
 * here before ("Sempre") told the operator nothing about what they were
 * looking at. `span` is the range the loaded results actually cover, so the
 * unfiltered case still names real dates rather than a category.
 */
export const periodLabel = (period: Period, today = new Date(), span?: Period | null): string => {
  if (!period.from && !period.to) {
    if (!span?.from || !span?.to) return 'Tutte le date';
    return span.from === span.to ? shortDay(span.from) : `${shortDay(span.from)} – ${shortDay(span.to)}`;
  }
  const todayIso = asIsoDay(today);
  const yesterdayIso = asIsoDay(addDays(today, -1));
  if (period.from === todayIso && period.to === todayIso) return 'Oggi';
  if (period.from === yesterdayIso && period.to === yesterdayIso) return 'Ieri';
  if (period.from && period.to && period.from === period.to) return shortDay(period.from);
  if (period.from && period.to) return `${shortDay(period.from)} – ${shortDay(period.to)}`;
  return period.from ? `dal ${shortDay(period.from)}` : `fino al ${shortDay(period.to)}`;
};

const MonthGrid: React.FC<{
  month: Date;
  from: string;
  to: string;
  todayIso: string;
  onPick: (iso: string) => void;
}> = ({ month, from, to, todayIso, onPick }) => {
  const first = startOfMonth(month);
  const leading = mondayIndex(first);
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();

  return (
    <div className="min-w-0">
      <div className="mb-2 text-center text-[14px] font-semibold text-[var(--ds-text-primary)]">
        {MONTHS[month.getMonth()]}
      </div>
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
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              aria-pressed={isStart || isEnd}
              aria-current={isToday ? 'date' : undefined}
              // 36px, not 44: a month grid at 44 does not fit two months side by
              // side on a tablet, and the cells sit in a dense field of
              // identical targets where the row/column alignment does the
              // aiming. The shortcuts above are the 44px path.
              className={`mx-auto inline-flex h-9 w-9 items-center justify-center rounded-full text-[14px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                isStart || isEnd
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

export const PeriodPicker: React.FC<{
  open: boolean;
  period: Period;
  /** The range the loaded results cover, used to name the unfiltered case. */
  span?: Period | null;
  /** Rendered under the range in the footer — "50 link · € 1.557,00 incassati". */
  summary?: React.ReactNode;
  onApply: (next: Period) => void;
  onClose: () => void;
}> = ({ open, period, span, summary, onApply, onClose }) => {
  const [draft, setDraft] = useState<Period>(period);
  const [anchor, setAnchor] = useState<Date>(() => {
    const [y, m] = (period.from || asIsoDay(new Date())).split('-').map(Number);
    return new Date(y, (m || 1) - 1, 1);
  });

  const today = useMemo(() => new Date(), []);
  const todayIso = asIsoDay(today);
  const yesterdayIso = asIsoDay(addDays(today, -1));

  // Re-seed the draft each time the sheet opens, so cancelling really does
  // leave the applied period alone.
  React.useEffect(() => {
    if (open) setDraft(period);
  }, [open, period]);

  /** Picking always extends an in-progress range rather than starting over:
   *  a second tap after the first sets the end, and any tap once both ends
   *  exist begins a new range. Tapping before the start moves the start. */
  const pick = (iso: string) => {
    setDraft(prev => {
      if (!prev.from || (prev.from && prev.to)) return { from: iso, to: '' };
      if (iso < prev.from) return { from: iso, to: prev.from };
      return { from: prev.from, to: iso };
    });
  };

  const shortcuts: { label: string; value: Period }[] = [
    { label: 'Oggi', value: { from: todayIso, to: todayIso } },
    { label: 'Ieri', value: { from: yesterdayIso, to: yesterdayIso } },
    { label: 'Ultimi 7 giorni', value: { from: asIsoDay(addDays(today, -6)), to: todayIso } },
  ];

  const isActive = (v: Period) => v.from === draft.from && v.to === draft.to;

  // "Periodo" is the mode, not a preset: it is on whenever the draft is not one
  // of the three fixed answers, and the calendar below is its input. It reads
  // back the range being built, so the chip and the grid never disagree about
  // what has been picked so far.
  const isCustom = !shortcuts.some(s => isActive(s.value));
  const customLabel = draft.from && draft.to
    ? (draft.from === draft.to ? shortDay(draft.from) : `${shortDay(draft.from)} – ${shortDay(draft.to)}`)
    : draft.from
      ? `dal ${shortDay(draft.from)}`
      : null;

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      title="Periodo"
      size="md"
      closeOnEscape
      bodyClassName="p-5 sm:p-6"
      footerStart={
        <span>
          <span className="font-semibold text-[var(--ds-text-primary)]">
            {periodLabel(draft, today, span)}
          </span>
          {summary && <span className="block text-[13px]">{summary}</span>}
        </span>
      }
      footer={
        <>
          <button type="button" onClick={onClose} className={`w-full sm:w-auto ${dsButton.quiet}`}>
            Annulla
          </button>
          <button
            type="button"
            // An open range (a start with no end) applies as a single day —
            // otherwise "Applica" after one tap silently widens to everything
            // after that date, which is not what the tap looked like.
            onClick={() => onApply(draft.from && !draft.to ? { from: draft.from, to: draft.from } : draft)}
            className={`w-full sm:w-auto ${dsButton.primary}`}
          >
            Applica
          </button>
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {shortcuts.map(s => (
          <button
            key={s.label}
            type="button"
            onClick={() => setDraft(s.value)}
            aria-pressed={isActive(s.value)}
            className={`inline-flex h-11 items-center rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              isActive(s.value)
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
            }`}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          // Tapping it from a preset clears the draft so the next tap on the
          // calendar starts a range rather than extending "Oggi". Tapping it
          // while already custom leaves a half-built range alone.
          onClick={() => { if (!isCustom) setDraft({ from: '', to: '' }); }}
          aria-pressed={isCustom}
          className={`inline-flex h-11 items-center gap-2 rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
            isCustom
              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
              : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
          }`}
        >
          Periodo
          {customLabel && <span className="font-normal opacity-70">{customLabel}</span>}
        </button>
      </div>

      {/* Clearing the filter is a distinct intention from picking a range, so
          it stops being a fourth look-alike chip and becomes a quiet reset —
          the only route back to an unbounded list. */}
      <div className="mt-2 flex justify-end">
        <button
          type="button"
          onClick={() => setDraft({ from: '', to: '' })}
          disabled={!draft.from && !draft.to}
          className="inline-flex h-9 items-center rounded-full px-3 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          Azzera
        </button>
      </div>

      <div className="mt-3 rounded-[20px] bg-[var(--ds-surface)] p-4 sm:p-5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() - 1, 1))}
            aria-label="Mese precedente"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            ‹
          </button>
          <span className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
            {anchor.getFullYear()}
          </span>
          <button
            type="button"
            onClick={() => setAnchor(a => new Date(a.getFullYear(), a.getMonth() + 1, 1))}
            aria-label="Mese successivo"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            ›
          </button>
        </div>
        {/* Two months side by side from sm up — a range that straddles a month
            boundary is the common case here, and one month at a time turns it
            into a paging exercise. */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
          <MonthGrid month={anchor} from={draft.from} to={draft.to} todayIso={todayIso} onPick={pick} />
          <div className="hidden sm:block">
            <MonthGrid
              month={new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1)}
              from={draft.from}
              to={draft.to}
              todayIso={todayIso}
              onPick={pick}
            />
          </div>
        </div>
      </div>
    </ModalShell>
  );
};

/** The button that opens the picker. Lives next to the status filters. */
export const PeriodTrigger: React.FC<{
  period: Period;
  span?: Period | null;
  count?: number;
  onClick: () => void;
}> = ({ period, span, count, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex h-9 flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
  >
    <CalendarDays className="h-4 w-4" aria-hidden />
    {periodLabel(period, new Date(), span)}
    {count != null && <span className="tabular-nums opacity-70">{count}</span>}
  </button>
);
