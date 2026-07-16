import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, X, Calendar, User, Phone, Mail, Loader2, ArrowRight } from 'lucide-react';
import { Reservation, Customer, ReservationStatus } from '../types';
import { getCustomers } from '../services/apiService';

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
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' });
};

const formatResTime = (iso: string): string => {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
};

const statusChip = (r: Reservation): { label: string; cls: string } | null => {
  const s = r.reservation_status;
  if (s === ReservationStatus.CANCELLED || s === ReservationStatus.DECLINED) {
    return { label: 'Annullata', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' };
  }
  if (s === ReservationStatus.NO_SHOW) {
    return { label: 'No show', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300' };
  }
  if (s === ReservationStatus.PENDING) {
    return { label: 'Da confermare', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300' };
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
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[10vh] px-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Ricerca globale"
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div
        className="relative w-full max-w-2xl bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] overflow-hidden flex flex-col max-h-[75vh]"
        onClick={e => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--color-line)]">
          <Search className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Cerca prenotazioni o clienti (nome, telefono, email)..."
            className="flex-1 bg-transparent outline-none text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)]"
          />
          {customersLoading && <Loader2 className="h-4 w-4 text-[var(--color-fg-muted)] animate-spin flex-shrink-0" />}
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors"
            aria-label="Chiudi"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Results */}
        <div ref={listRef} className="flex-1 overflow-y-auto">
          {showHint && (
            <div className="px-6 py-10 text-center text-[13px] text-[var(--color-fg-muted)]">
              Cerca in tutte le prenotazioni e nei clienti in rubrica. La data non conta.
            </div>
          )}

          {showEmpty && (
            <div className="px-6 py-10 text-center text-[13px] text-[var(--color-fg-muted)]">
              Nessun risultato per <span className="font-medium text-[var(--color-fg)]">"{query.trim()}"</span>.
            </div>
          )}

          {reservationHits.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-semibold">
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
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isActive ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 flex items-center justify-center">
                      <Calendar className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[14px] font-medium text-[var(--color-fg)] truncate">
                          {r.customer_name || '—'}
                        </span>
                        {chip && (
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0 ${chip.cls}`}>
                            {chip.label}
                          </span>
                        )}
                      </div>
                      <div className="text-[12px] text-[var(--color-fg-muted)] truncate tabular">
                        {formatResDate(r.reservation_time)} · {formatResTime(r.reservation_time)} · {r.guests || 0} {r.guests === 1 ? 'ospite' : 'ospiti'}
                        {r.phone ? ` · ${r.phone}` : ''}
                      </div>
                    </div>
                    {isActive && <ArrowRight className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}

          {customerHits.length > 0 && (
            <div>
              <div className="px-4 pt-3 pb-1 text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-semibold">
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
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                      isActive ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 flex items-center justify-center">
                      <User className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[14px] font-medium text-[var(--color-fg)] truncate">
                        {c.name}
                        {c.is_vip && <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">VIP</span>}
                      </div>
                      <div className="text-[12px] text-[var(--color-fg-muted)] truncate flex items-center gap-2 tabular">
                        {c.phone && <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{c.phone}</span>}
                        {c.email && <span className="inline-flex items-center gap-1 truncate"><Mail className="h-3 w-3 flex-shrink-0" /><span className="truncate">{c.email}</span></span>}
                      </div>
                    </div>
                    {isActive && <ArrowRight className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-[var(--color-line)] bg-[var(--color-surface-2)] text-[11px] text-[var(--color-fg-muted)]">
          <div className="flex items-center gap-3">
            <span><kbd className="px-1 py-0.5 rounded border border-[var(--color-line)] bg-[var(--color-surface)] font-mono text-[10px]">↑↓</kbd> Naviga</span>
            <span><kbd className="px-1 py-0.5 rounded border border-[var(--color-line)] bg-[var(--color-surface)] font-mono text-[10px]">⏎</kbd> Apri</span>
            <span><kbd className="px-1 py-0.5 rounded border border-[var(--color-line)] bg-[var(--color-surface)] font-mono text-[10px]">Esc</kbd> Chiudi</span>
          </div>
          <span className="hidden sm:inline"><kbd className="px-1 py-0.5 rounded border border-[var(--color-line)] bg-[var(--color-surface)] font-mono text-[10px]">⌘K</kbd> per aprire</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
