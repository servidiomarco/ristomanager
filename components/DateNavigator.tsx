import React, { useRef } from 'react';
import { Calendar, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';

interface DateNavigatorProps {
  value: string;
  onChange: (value: string) => void;
  widthClass?: string;
  backToToday?: 'below' | 'inline' | 'none';
  className?: string;
}

const formatLocalDate = (date: Date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatDateShort = (date: Date) =>
  date.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });

export const DateNavigator: React.FC<DateNavigatorProps> = ({
  value,
  onChange,
  widthClass = 'flex-1 min-w-0',
  backToToday = 'below',
  className = '',
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedDate = new Date(`${value}T00:00:00`);
  const todayStr = formatLocalDate(new Date());
  const isToday = value === todayStr;

  const relativeLabel = (() => {
    if (isToday) return 'Oggi';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(selectedDate);
    target.setHours(0, 0, 0, 0);
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000);
    if (diff === 1) return 'Domani';
    if (diff === -1) return 'Ieri';
    return null;
  })();

  const navigate = (offset: number) => {
    const next = new Date(selectedDate);
    next.setDate(next.getDate() + offset);
    onChange(formatLocalDate(next));
  };
  const goToToday = () => onChange(todayStr);

  const backChip = (
    <button
      type="button"
      onClick={goToToday}
      className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] border border-[var(--color-line)] text-[11px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors flex-shrink-0"
    >
      <RotateCcw className="h-3 w-3" />
      Torna a oggi
    </button>
  );

  return (
    <div className={className}>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Giorno precedente"
          className="h-10 w-10 flex-shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] active:scale-[0.96] transition-all flex items-center justify-center"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>

        <div className={`relative ${widthClass}`}>
          <input
            ref={inputRef}
            type="date"
            value={value}
            onChange={(e) => {
              if (e.target.value) onChange(e.target.value);
            }}
            onClick={(e) => {
              try {
                if (typeof e.currentTarget.showPicker === 'function') e.currentTarget.showPicker();
              } catch {
                // ignore — the native click on the input already triggers the picker
              }
            }}
            aria-label="Seleziona data"
            className="peer absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
          />
          <div
            aria-hidden="true"
            className={`pointer-events-none w-full h-10 px-3 rounded-full border bg-[var(--color-surface)] peer-hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center gap-2 ${
              isToday ? 'border-[var(--color-line)]' : 'border-[var(--color-line-strong)]'
            }`}
          >
            <Calendar
              className={`h-4 w-4 flex-shrink-0 ${isToday ? 'text-[var(--color-fg-muted)]' : 'text-[var(--color-fg)]'}`}
            />
            {relativeLabel ? (
              <span className="flex items-baseline gap-1.5 min-w-0">
                <span className="text-sm font-semibold text-[var(--color-fg)] whitespace-nowrap">{relativeLabel}</span>
                <span className="text-[11px] text-[var(--color-fg-muted)] capitalize whitespace-nowrap hidden sm:inline">
                  · {formatDateShort(selectedDate)}
                </span>
              </span>
            ) : (
              <span className="text-sm font-semibold text-[var(--color-fg)] capitalize whitespace-nowrap truncate">
                {formatDateShort(selectedDate)}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => navigate(1)}
          aria-label="Giorno successivo"
          className="h-10 w-10 flex-shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] active:scale-[0.96] transition-all flex items-center justify-center"
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
    </div>
  );
};
