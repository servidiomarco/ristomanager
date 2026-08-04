import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Calendar, User, Phone, Mail, Loader2, ArrowRight } from 'lucide-react';
import { Reservation, Customer, ReservationStatus } from '../types';
import { getCustomers } from '../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { toTitleCase } from '../utils/text';

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  reservations: Reservation[];
  onSelectReservation: (reservation: Reservation) => void;
  onSelectCustomer: (customer: Customer) => void;
}

type PaletteItem =
  | { kind: 'reservation'; data: Reservation }
  | { kind: 'customer'; data: Customer };

const MAX_PER_GROUP = 25;

const formatResDate = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};

const formatResTime = (iso: string): string => getRomeTimePart(iso);

const statusChip = (r: Reservation): { label: string; cls: string } | null => {
  const s = r.reservation_status;
  if (s === ReservationStatus.CANCELLED || s === ReservationStatus.DECLINED) {
    return { label: 'Annullata', cls: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]' };
  }
  if (s === ReservationStatus.NO_SHOW) {
    return { label: 'No show', cls: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]' };
  }
  if (s === ReservationStatus.PENDING) {
    return { label: 'Da confermare', cls: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]' };
  }
  return null;
};

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  reservations,
  onSelectReservation,
  onSelectCustomer,
}) => {
  const [query, setQuery] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoaded, setCustomersLoaded] = useState(false);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch customers on first open. They're cached for the session so
  // subsequent opens are instant. If a customer is created/edited during
  // the session the palette won't see it until a full reload — acceptable
  // for a quick-search tool; the source of truth remains the Clienti page.
  useEffect(() => {
    if (!isOpen || customersLoaded || customersLoading) return;
    setCustomersLoading(true);
    getCustomers()
      .then(data => {
        setCustomers(data);
        setCustomersLoaded(true);
      })
      .catch(() => {
        setCustomers([]);
        setCustomersLoaded(true);
      })
      .finally(() => setCustomersLoading(false));
  }, [isOpen, customersLoaded, customersLoading]);

  // Reset state each time the palette opens so the user always starts fresh.
  useEffect(() => {
    if (!isOpen) return;
    setQuery('');
    setActiveIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(t);
  }, [isOpen]);

  const q = query.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');

  const reservationHits = useMemo((): Reservation[] => {
    if (!q) return [];
    const scored: { r: Reservation; score: number }[] = [];
    for (const r of reservations) {
      let hit = false;
      const name = (r.customer_name || '').toLowerCase();
      const email = (r.email || '').toLowerCase();
      const phoneDigits = (r.phone || '').replace(/\D/g, '');
      if (name.includes(q)) hit = true;
      else if (email && email.includes(q)) hit = true;
      // Require at least 3 digits for phone match so "Mario 2" doesn't pull
      // in every phone containing a "2".
      else if (qDigits.length >= 3 && phoneDigits.includes(qDigits)) hit = true;
      if (!hit) continue;
      // Rank by recency (most recent first). We use the reservation time
      // rather than created_at so future bookings surface before old ones.
      scored.push({ r, score: -new Date(r.reservation_time).getTime() });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, MAX_PER_GROUP).map(s => s.r);
  }, [q, qDigits, reservations]);

  const customerHits = useMemo((): Customer[] => {
    if (!q) return [];
    const hits: Customer[] = [];
    for (const c of customers) {
      const name = (c.name || '').toLowerCase();
      const email = (c.email || '').toLowerCase();
      const phoneDigits = (c.phone || '').replace(/\D/g, '');
      let hit = false;
      if (name.includes(q)) hit = true;
      else if (email && email.includes(q)) hit = true;
      else if (qDigits.length >= 3 && phoneDigits && phoneDigits.includes(qDigits)) hit = true;
      if (hit) hits.push(c);
      if (hits.length >= MAX_PER_GROUP) break;
    }
    return hits;
  }, [q, qDigits, customers]);

  // Flat list drives keyboard navigation; sections are visual only.
  const flatItems = useMemo((): PaletteItem[] => [
    ...reservationHits.map<PaletteItem>(r => ({ kind: 'reservation', data: r })),
    ...customerHits.map<PaletteItem>(c => ({ kind: 'customer', data: c })),
  ], [reservationHits, customerHits]);

  useEffect(() => {
    setActiveIndex(0);
  }, [q]);

  const commit = useCallback((item: PaletteItem) => {
    if (item.kind === 'reservation') onSelectReservation(item.data);
    else onSelectCustomer(item.data);
  }, [onSelectReservation, onSelectCustomer]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, Math.max(0, flatItems.length - 1)));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = flatItems[activeIndex];
      if (item) commit(item);
      return;
    }
  }, [flatItems, activeIndex, commit, onClose]);

  // Keep the active row scrolled into view as the user navigates with the keyboard.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-palette-index="${activeIndex}"]`);
    if (el && 'scrollIntoView' in el) {
      (el as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  if (!isOpen) return null;

  const showEmpty = q.length > 0 && flatItems.length === 0 && !customersLoading;
  const showHint = q.length === 0;

  // Index offset for the customer section: keyboard navigation is on the
  // flat list, so customers start at reservationHits.length.
  const customerBaseIndex = reservationHits.length;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[6vh] sm:pt-[10vh] px-3 sm:px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Ricerca globale"
    >
      <div className="absolute inset-0 bg-[var(--ds-backdrop)]" />
      <div
        className="relative flex w-full max-w-2xl flex-col overflow-hidden rounded-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] max-h-[85vh] sm:max-h-[75vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input — 16px font on mobile keeps iOS Safari from zooming
            the viewport on focus; taller vertical padding gives fingers a
            comfortable tap target. */}
        <div className="flex flex-shrink-0 items-center gap-3 px-5 py-4">
          <Search className="h-5 w-5 flex-shrink-0 text-[var(--ds-text-muted)] sm:h-4 sm:w-4" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Cerca prenotazioni o clienti…"
            className="flex-1 bg-transparent text-[16px] text-[var(--ds-text-primary)] outline-none placeholder:text-[var(--ds-text-muted)] sm:text-[15px]"
          />
          {customersLoading && <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-[var(--ds-text-muted)]" />}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results. Canvas-toned like every other scrolling modal body, so the
            input row above reads as chrome rather than the first result. */}
        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)] pb-2">
          {showHint && (
            <div className="px-6 py-12 sm:py-10 text-center text-[14px] sm:text-[13px] text-[var(--ds-text-muted)] leading-relaxed">
              Cerca in tutte le prenotazioni e nei clienti in rubrica.
              <br className="hidden sm:inline" />
              <span className="block sm:inline sm:ml-1 text-[var(--ds-text-subtle)]">La data non conta.</span>
            </div>
          )}

          {showEmpty && (
            <div className="px-6 py-12 sm:py-10 text-center text-[14px] sm:text-[13px] text-[var(--ds-text-muted)]">
              Nessun risultato per <span className="font-medium text-[var(--ds-text-primary)]">"{query.trim()}"</span>.
            </div>
          )}

          {reservationHits.length > 0 && (
            <div>
              <div className="px-4 pt-4 pb-1 text-[13px] font-semibold text-[var(--ds-text-muted)]">
                Prenotazioni · {reservationHits.length}
              </div>
              {reservationHits.map((r, i) => {
                const chip = statusChip(r);
                const isActive = i === activeIndex;
                return (
                  <button
                    key={`res-${r.id}`}
                    data-palette-index={i}
                    type="button"
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => commit({ kind: 'reservation', data: r })}
                    className={`mx-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-[14px] px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                      isActive ? 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]' : 'hover:bg-[var(--ds-surface)]'
                    }`}
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                      <Calendar className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[15px] sm:text-[14px] font-medium text-[var(--ds-text-primary)] truncate">
                          {toTitleCase(r.customer_name) || '—'}
                        </span>
                        {chip && (
                          <span className={`flex-shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.cls}`}>
                            {chip.label}
                          </span>
                        )}
                      </div>
                      <div className="text-[13px] sm:text-[12px] text-[var(--ds-text-muted)] truncate tabular">
                        {formatResDate(r.reservation_time)} · {formatResTime(r.reservation_time)} · {r.guests || 0} {r.guests === 1 ? 'ospite' : 'ospiti'}
                        {r.phone ? ` · ${r.phone}` : ''}
                      </div>
                    </div>
                    {isActive && <ArrowRight className="h-4 w-4 text-[var(--ds-text-muted)] flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          {customerHits.length > 0 && (
            <div>
              <div className="px-4 pt-4 pb-1 text-[13px] font-semibold text-[var(--ds-text-muted)]">
                Clienti · {customerHits.length}
              </div>
              {customerHits.map((c, i) => {
                const flatIndex = customerBaseIndex + i;
                const isActive = flatIndex === activeIndex;
                return (
                  <button
                    key={`cust-${c.id}`}
                    data-palette-index={flatIndex}
                    type="button"
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                    onClick={() => commit({ kind: 'customer', data: c })}
                    className={`mx-3 flex w-[calc(100%-1.5rem)] items-center gap-3 rounded-[14px] px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                      isActive ? 'bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]' : 'hover:bg-[var(--ds-surface)]'
                    }`}
                  >
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]">
                      <User className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[15px] sm:text-[14px] font-medium text-[var(--ds-text-primary)] truncate">
                        {toTitleCase(c.name)}
                        {c.is_vip && <span className="ml-1.5 rounded-full bg-[var(--ds-pending-tint)] px-1.5 py-0.5 text-[11px] font-semibold text-[var(--ds-pending-text)]">VIP</span>}
                      </div>
                      <div className="text-[12px] text-[var(--ds-text-muted)] truncate flex items-center gap-2 tabular">
                        {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
                        {c.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="h-3 w-3 flex-shrink-0" /><span className="truncate">{c.email}</span></span>}
                      </div>
                    </div>
                    {isActive && <ArrowRight className="h-4 w-4 text-[var(--ds-text-muted)] flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer — kbd hints on desktop. On mobile the keyboard shortcuts
            aren't useful (there's no ⌘K, ↑↓ or Esc), so we hide the whole
            row to reclaim vertical space for results. */}
        <div className="hidden flex-shrink-0 items-center justify-between px-5 py-3 text-[13px] text-[var(--ds-text-muted)] sm:flex">
          <div className="flex items-center gap-3">
            <span><kbd className="rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ds-text-secondary)]">↑↓</kbd> Naviga</span>
            <span><kbd className="rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ds-text-secondary)]">⏎</kbd> Apri</span>
            <span><kbd className="rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ds-text-secondary)]">Esc</kbd> Chiudi</span>
          </div>
          <span><kbd className="rounded-[6px] bg-[var(--ds-surface-row)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ds-text-secondary)]">⌘K</kbd> per aprire</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
