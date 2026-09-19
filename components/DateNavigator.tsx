import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Calendar, ChevronDown, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';
import { DayPicker, Sheet, useCalendarLabels, useMediaQuery } from './ds';

interface DateNavigatorProps {
  value: string;
  onChange: (value: string) => void;
  widthClass?: string;
  backToToday?: 'below' | 'inline' | 'none';
  className?: string;
  /** Set when the navigator sits directly on the canvas rather than inside a
   *  white card. The recessed grey it uses by default measures about 1.03:1
   *  against the canvas and simply vanishes there, so on canvas it takes the
   *  white-plus-shadow treatment the search field and icon buttons use. */
  onCanvas?: boolean;
}

const formatLocalDate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

/* ── Il giorno della testata ──────────────────────────────────────────────
   Le frecce per il giorno prima e dopo, la pastiglia al centro per saltare
   altrove. La pastiglia apriva il calendario NATIVO del browser: una finestra
   che non conosce i token, non conosce la lingua dell'app (in inglese anche
   con l'app in italiano) e cambia faccia fra Chrome, Safari e Windows. Adesso
   apre il DayPicker del design system — lo stesso calendario del resto
   dell'app — in una tendina col puntatore e in un foglio sul telefono. */

export const DateNavigator: React.FC<DateNavigatorProps> = ({
  value,
  onChange,
  widthClass = 'flex-1 min-w-0',
  backToToday = 'below',
  className = '',
  onCanvas = false,
}) => {
  const { t } = useTranslation('common', { useSuspense: false });
  const { locale } = useCalendarLabels();
  const isPhone = !useMediaQuery('(min-width: 640px)');
  const [open, setOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const surface = onCanvas
    ? 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]'
    : 'bg-[var(--ds-surface-row)]';
  const selectedDate = new Date(`${value}T00:00:00`);
  const todayStr = formatLocalDate(new Date());
  const isToday = value === todayStr;

  const formatDateShort = (date: Date) =>
    date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });

  const relativeLabel = (() => {
    if (isToday) return t('date.today');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(selectedDate);
    target.setHours(0, 0, 0, 0);
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    if (diff === 1) return t('date.tomorrow');
    if (diff === -1) return t('date.yesterday');
    return null;
  })();

  const navigate = (offset: number) => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + offset);
    onChange(formatLocalDate(next));
  };
  const goToToday = () => onChange(todayStr);

  // Fuori e Esc chiudono la tendina. Sul telefono ci pensa il foglio, che
  // porta con sé il suo velo e il suo Escape.
  useEffect(() => {
    if (!open || isPhone) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, isPhone]);

  const pick = (iso: string) => {
    onChange(iso);
    setOpen(false);
  };

  const backChip = (
    <button
      type="button"
      onClick={goToToday}
      className={`inline-flex items-center gap-1.5 h-8 px-3 rounded-[var(--ds-radius-control)] ${surface} text-[13px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors flex-shrink-0`}
    >
      <RotateCcw className="h-3 w-3" />
      {t('date.backToToday')}
    </button>
  );

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={t('date.previousDay')}
          className={`h-10 w-10 flex-shrink-0 rounded-[var(--ds-radius-control)] ${surface} text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] active:scale-[0.96] transition-all flex items-center justify-center`}
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className={`relative ${widthClass}`}>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={t('date.chooseDate')}
            className={`w-full h-10 px-4 rounded-[var(--ds-radius-control)] transition-colors flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              isToday
                ? surface
                : `${surface} ring-1 ring-inset ring-[var(--ds-border-strong)]`
            }`}
          >
            <Calendar
              className={`h-4 w-4 flex-shrink-0 ${isToday ? 'text-[var(--ds-text-secondary)]' : 'text-[var(--ds-text-primary)]'}`}
              aria-hidden
            />
            {relativeLabel ? (
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)] whitespace-nowrap">{relativeLabel}</span>
                <span className="text-[13px] text-[var(--ds-text-secondary)] capitalize whitespace-nowrap hidden sm:inline">
                  · {formatDateShort(selectedDate)}
                </span>
              </span>
            ) : (
              <span className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)] capitalize whitespace-nowrap truncate">
                {formatDateShort(selectedDate)}
              </span>
            )}
            {/* La pastiglia prima non diceva di essere premibile: si scopriva
                il calendario per caso. */}
            <ChevronDown
              className={`h-3.5 w-3.5 flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${open ? 'rotate-180' : ''}`}
              aria-hidden
            />
          </button>

          {open && !isPhone && (
            <div
              ref={popoverRef}
              role="dialog"
              aria-label={t('date.chooseDate')}
              className="absolute left-1/2 top-full z-40 mt-2 w-[300px] -translate-x-1/2"
            >
              <DayPicker value={value} onPick={pick} shortcuts />
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => navigate(1)}
          aria-label={t('date.nextDay')}
          className={`h-10 w-10 flex-shrink-0 rounded-[var(--ds-radius-control)] ${surface} text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] active:scale-[0.96] transition-all flex items-center justify-center`}
        >
          <ChevronRight className="h-4 w-4" />
        </button>

        {!isToday && backToToday === 'inline' && backChip}
      </div>

      {!isToday && backToToday === 'below' && (
        <div className="flex justify-center mt-2 animate-[fadeIn_180ms_ease-out]">
          {backChip}
        </div>
      )}

      {/* Sul telefono la tendina starebbe stretta contro il bordo: il
          calendario sale dal basso, dove il pollice arriva. */}
      {isPhone && (
        <Sheet open={open} onClose={() => setOpen(false)} title={t('date.chooseDate')} bodyClassName="px-4 pb-4">
          <DayPicker value={value} onPick={pick} shortcuts bare />
        </Sheet>
      )}
    </div>
  );
};
