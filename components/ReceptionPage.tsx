import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Reservation,
  Table,
  Room,
  ArrivalStatus,
  ReservationStatus,
  ReservationSource,
  PaymentStatus,
  TableShape,
  Shift
} from '../types';
import {
  Search,
  Users,
  Clock,
  Phone,
  MapPin,
  MapPinOff,
  CheckCircle2,
  XCircle,
  Armchair,
  UserPlus,
  ChevronLeft,
  RefreshCw,
  AlertTriangle,
  Star,
  Zap,
  List,
  LayoutGrid,
  LogOut,
  X as XIcon
} from 'lucide-react';
import { getReservations, getTables, getRooms, updateReservation, createReservation, swapReservationTables } from '../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';
import { StatusChip, PulseDot, getReservationState, getTimedReservationState, isSeated, deriveTableDisplayStatus, TABLE_STATUS_LABEL } from './reservationState';
import { DietaryChips } from './DietaryChips';
import { stripDietaryNote } from '../utils/dietary';
import { toTitleCase } from '../utils/text';
import { useNow } from '../hooks/useNow';

// Local-date helper (avoid UTC drift)
const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseReservationTime = (iso: string): Date => new Date(iso);

const formatHHMM = (iso: string): string => getRomeTimePart(iso) || '—';

const formatPhone = (phone?: string): string => {
  if (!phone) return '';
  return phone.replace(/^\+39/, '').trim();
};

interface ReceptionPageProps {
  globalDate: Date;
  globalShiftFilter: 'ALL' | 'LUNCH' | 'DINNER';
  onBack?: () => void;
  /** When true, open the walk-in modal (e.g. triggered from the global "+" create menu). */
  autoOpenWalkIn?: boolean;
  onAutoOpenWalkInHandled?: () => void;
}

const ReceptionPage: React.FC<ReceptionPageProps> = ({ globalDate, globalShiftFilter, onBack, autoOpenWalkIn, onAutoOpenWalkInHandled }) => {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'waiting' | 'arrived' | 'noTable'>('all');
  const [showTablePicker, setShowTablePicker] = useState(false);
  const [activeRoomId, setActiveRoomId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Flips to false the first time loadAll() completes. Used to swap the empty
  // "no matches" copy for skeleton cards during the initial fetch — otherwise
  // Reception opens blank for ~800ms and then pops in the list. Stays false
  // on background refetches (visibilitychange, socket reconnect) so the
  // existing list doesn't flicker into skeleton state each time.
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [showWalkIn, setShowWalkIn] = useState(false);
  // Open the walk-in modal when triggered from the global "+" create menu, then clear the flag.
  useEffect(() => {
    if (autoOpenWalkIn) {
      setShowWalkIn(true);
      onAutoOpenWalkInHandled?.();
    }
  }, [autoOpenWalkIn]);
  // Right-pane mode toggle. Lista = reservation detail (default).
  // Mappa = live room map, host taps a table to jump to its booking.
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [, setTick] = useState(0);

  // Re-render every 60s so the time-band grouping (Adesso / Prossima ora / …) stays accurate.
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const loadAll = useCallback(async () => {
    setError(null);
    try {
      const [r, t, ro] = await Promise.all([getReservations(), getTables(), getRooms()]);
      setReservations(r);
      setTables(t);
      setRooms(ro);
      if (ro.length > 0 && activeRoomId === null) {
        setActiveRoomId(ro[0].id);
      }
    } catch (err) {
      setError((err as Error)?.message || 'Errore di caricamento');
    } finally {
      setIsInitialLoading(false);
    }
  }, [activeRoomId]);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ticking clock (1/min) — drives the time-derived states (In arrivo /
  // In uscita) on cards and the room map.
  const nowTick = useNow(60_000);
  const isViewingToday = formatLocalDate(globalDate) === formatLocalDate(new Date(nowTick));

  // Bookings for the date+shift chosen in the global top-bar control.
  // 'ALL' shows both shifts; any other value filters to that shift.
  const todayReservations = useMemo(() => {
    const dateStr = formatLocalDate(globalDate);
    return reservations
      .filter(r => getRomeDatePart(r.reservation_time) === dateStr)
      .filter(r => r.reservation_status !== ReservationStatus.CANCELLED && r.reservation_status !== ReservationStatus.DECLINED)
      .filter(r => globalShiftFilter === 'ALL' || r.shift === globalShiftFilter)
      .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
  }, [reservations, globalDate, globalShiftFilter]);

  // Apply text search + status filter
  const filtered = useMemo(() => {
    let list = todayReservations;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        (r.customer_name || '').toLowerCase().includes(q) ||
        (r.phone || '').toLowerCase().includes(q)
      );
    }
    if (statusFilter === 'waiting') {
      list = list.filter(r => (r.arrival_status || ArrivalStatus.WAITING) === ArrivalStatus.WAITING);
    } else if (statusFilter === 'arrived') {
      // "Arrivati" = everyone in house: ARRIVED and DEPARTING alike.
      list = list.filter(r => isSeated(r));
    } else if (statusFilter === 'noTable') {
      list = list.filter(r => !r.table_id);
    }
    return list;
  }, [todayReservations, search, statusFilter]);

  // Group by time band
  const grouped = useMemo(() => {
    const now = new Date();
    const adesso: Reservation[] = [];
    const prossima: Reservation[] = [];
    const piuTardi: Reservation[] = [];
    for (const r of filtered) {
      const t = parseReservationTime(r.reservation_time);
      const diffMin = (t.getTime() - now.getTime()) / 60_000;
      if (diffMin < 60) adesso.push(r);
      else if (diffMin < 180) prossima.push(r);
      else piuTardi.push(r);
    }
    return { adesso, prossima, piuTardi };
  }, [filtered]);

  // "In arrivo adesso" — the bookings whose party is due right now (from
  // T−20′ until they show up). Most-overdue first: that's who's probably
  // standing at the door. Powers the one-tap check-in rail.
  const arrivingNow = useMemo(() => {
    if (!isViewingToday) return [];
    return todayReservations
      .filter(r => getTimedReservationState(r, nowTick) === 'arriving')
      .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time))
      .slice(0, 12);
  }, [todayReservations, nowTick, isViewingToday]);

  // Header stats
  const stats = useMemo(() => ({
    count: todayReservations.length,
    guests: todayReservations.reduce((s, r) => s + (r.guests || 0), 0),
    arrived: todayReservations.filter(r => isSeated(r)).length,
    noTable: todayReservations.filter(r => !r.table_id).length
  }), [todayReservations]);

  const selectedReservation = useMemo(
    () => reservations.find(r => r.id === selectedReservationId) || null,
    [reservations, selectedReservationId]
  );
  const selectedTable = useMemo(
    () => selectedReservation?.table_id
      ? tables.find(t => t.id === selectedReservation.table_id) || null
      : null,
    [selectedReservation, tables]
  );

  // Which tables are taken by some non-departed booking today (excluding the
  // currently-selected reservation, so its own table doesn't look occupied).
  const occupiedTableIds = useMemo(() => {
    const set = new Set<number>();
    for (const r of todayReservations) {
      if (!r.table_id) continue;
      if (r.id === selectedReservationId) continue;
      if (r.arrival_status === ArrivalStatus.DEPARTED) continue;
      set.add(r.table_id);
    }
    return set;
  }, [todayReservations, selectedReservationId]);

  // Map view: tableId → its current reservation (if any). Prefers the next
  // upcoming reservation for the table — ARRIVED beats WAITING beats DEPARTED.
  const reservationByTableId = useMemo(() => {
    const m = new Map<number, Reservation>();
    const priority = (r: Reservation) => {
      if (isSeated(r)) return 3; // ARRIVED or DEPARTING — party at the table
      if (r.reservation_status === ReservationStatus.NO_SHOW) return 1;
      if (r.arrival_status === ArrivalStatus.DEPARTED) return 0;
      return 2; // WAITING
    };
    for (const r of todayReservations) {
      if (!r.table_id) continue;
      const existing = m.get(r.table_id);
      if (!existing || priority(r) > priority(existing)) {
        m.set(r.table_id, r);
      }
    }
    return m;
  }, [todayReservations]);

  // The PUT /reservations/:id endpoint is a *full* replace — it destructures
  // the body into fixed columns, so a partial body would null out NOT NULL
  // columns (customer_name) and trip a 500. We always merge the patch onto
  // the current row before sending.
  const patchReservation = async (id: number, patch: Partial<Reservation>) => {
    setBusy(true);
    setError(null);
    try {
      const current = reservations.find(r => r.id === id);
      if (!current) throw new Error('Prenotazione non trovata');
      const body = { ...current, ...patch };
      const updated = await updateReservation(id, body);
      setReservations(prev => prev.map(r => r.id === id ? { ...r, ...updated } : r));
    } catch (err) {
      setError((err as Error)?.message || 'Errore aggiornamento');
    } finally {
      setBusy(false);
    }
  };

  const handleAssignTable = async (tableId: number) => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { table_id: tableId });
    setShowTablePicker(false);
  };

  // One-tap check-in from the "In arrivo adesso" rail: mark arrived, focus
  // the booking, and — if it has no table yet — jump straight into the
  // table picker so seating happens in the same motion (walk-in pattern).
  const handleQuickArrive = async (r: Reservation) => {
    if (navigator.vibrate) navigator.vibrate(30);
    setSelectedReservationId(r.id);
    await patchReservation(r.id, { arrival_status: ArrivalStatus.ARRIVED });
    if (!r.table_id) setShowTablePicker(true);
  };

  // Swap the selected reservation's table with another reservation's. One
  // round-trip, server-side TX — see POST /reservations/:id/swap-table.
  const handleSwapTable = async (otherReservationId: number) => {
    if (!selectedReservation) return;
    setBusy(true);
    setError(null);
    try {
      const { a, b } = await swapReservationTables(selectedReservation.id, otherReservationId);
      setReservations(prev => prev.map(r => {
        if (r.id === a.id) return { ...r, ...a };
        if (r.id === b.id) return { ...r, ...b };
        return r;
      }));
      setShowTablePicker(false);
    } catch (err) {
      setError((err as Error)?.message || 'Errore scambio tavoli');
    } finally {
      setBusy(false);
    }
  };

  // Walk-in: create a brand-new reservation for "right now", already marked
  // as arrived. After the booking is on file we jump straight into the table
  // picker so the host can seat the guests in one motion.
  const handleCreateWalkIn = async (input: { name: string; guests: number; phone: string; notes: string }) => {
    setBusy(true);
    setError(null);
    try {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const reservationTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
      const shift = now.getHours() < 16 ? Shift.LUNCH : Shift.DINNER;
      const created = await createReservation({
        customer_name: input.name.trim(),
        reservation_time: reservationTime,
        shift,
        guests: input.guests,
        phone: input.phone.trim() || undefined,
        notes: input.notes.trim() || undefined,
        payment_status: PaymentStatus.PENDING,
        arrival_status: ArrivalStatus.ARRIVED,
        reservation_status: ReservationStatus.CONFIRMED,
        source: ReservationSource.MANUAL,
      } as Omit<Reservation, 'id'>);
      setReservations(prev => [...prev, created]);
      setSelectedReservationId(created.id);
      setShowWalkIn(false);
      setShowTablePicker(true);
    } catch (err) {
      setError((err as Error)?.message || 'Errore creazione walk-in');
    } finally {
      setBusy(false);
    }
  };

  const handleMarkArrived = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { arrival_status: ArrivalStatus.ARRIVED });
  };

  // Toggle "In uscita" — the party is at dolce/caffè/conto: the table is
  // still busy but the host knows it's about to turn over.
  const handleMarkDeparting = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { arrival_status: ArrivalStatus.DEPARTING });
  };

  const handleMarkWaiting = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { arrival_status: ArrivalStatus.WAITING });
  };

  const handleMarkNoShow = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, {
      reservation_status: ReservationStatus.NO_SHOW
    });
  };

  const handleFreeTable = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { arrival_status: ArrivalStatus.DEPARTED });
  };

  // Detach the table from the reservation without touching arrival status —
  // the booking stays in the list, just without a seat. The PUT handler
  // coerces `table_id` to NULL via `(table_id ?? null)`.
  const handleRemoveTable = async () => {
    if (!selectedReservation) return;
    await patchReservation(selectedReservation.id, { table_id: undefined });
  };

  // Render a reservation card in the left list
  // Placeholder card mirroring the real one's layout (min-h, header row with
  // time/status chip, name line, meta line, optional table pill) so the
  // initial load doesn't cause visual reflow when data actually arrives.
  // Slight per-card variance keeps the group looking like real content.
  const renderCardSkeleton = (key: string, variant: 'wide' | 'narrow' = 'wide') => (
    <div
      key={key}
      aria-hidden="true"
      className="w-full rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 min-h-[88px] motion-safe:animate-pulse"
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="h-5 w-14 rounded bg-[var(--color-surface-3)]" />
        <div className="h-4 w-16 rounded-full bg-[var(--color-surface-3)]" />
      </div>
      <div className={`h-4 rounded bg-[var(--color-surface-3)] mb-2 ${variant === 'wide' ? 'w-3/5' : 'w-2/5'}`} />
      <div className="flex items-center gap-3">
        <div className="h-3 w-10 rounded bg-[var(--color-surface-3)]" />
        <div className="h-3 w-24 rounded bg-[var(--color-surface-3)]" />
      </div>
    </div>
  );

  const renderListSkeleton = () => (
    <>
      <div className="mb-3">
        <div className="h-3 w-32 rounded bg-[var(--color-surface-3)] mb-2 motion-safe:animate-pulse" aria-hidden="true" />
        <div className="space-y-2">
          {renderCardSkeleton('sk-1', 'wide')}
          {renderCardSkeleton('sk-2', 'narrow')}
          {renderCardSkeleton('sk-3', 'wide')}
        </div>
      </div>
      <div className="mb-3">
        <div className="h-3 w-24 rounded bg-[var(--color-surface-3)] mb-2 motion-safe:animate-pulse" aria-hidden="true" />
        <div className="space-y-2">
          {renderCardSkeleton('sk-4', 'wide')}
          {renderCardSkeleton('sk-5', 'narrow')}
        </div>
      </div>
    </>
  );

  const renderCard = (r: Reservation) => {
    const isSelected = r.id === selectedReservationId;
    const table = r.table_id ? tables.find(t => t.id === r.table_id) : null;
    // Shared, time-aware badge — same visual language as the reservations
    // list and the floor map (an imminent booking pulses as "In arrivo").
    // Time-derived states only apply when viewing today's service.
    const timedState = isViewingToday ? getTimedReservationState(r, nowTick) : getReservationState(r);

    return (
      <button
        key={r.id}
        onClick={() => setSelectedReservationId(r.id)}
        className={`w-full text-left rounded-2xl border p-3 transition-colors min-h-[88px] ${
          isSelected
            ? 'bg-indigo-50 border-indigo-300 dark:bg-indigo-500/15 dark:border-indigo-500/50 shadow-sm'
            : 'bg-[var(--color-surface-2)] border-[var(--color-line)] hover:bg-[var(--color-surface-3)]'
        }`}
      >
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-lg font-semibold text-[var(--color-fg)] tabular-nums">
              {formatHHMM(r.reservation_time)}
            </span>
            {r.customer_is_vip && <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500 flex-shrink-0" />}
          </div>
          <StatusChip state={timedState} size="sm" />
        </div>
        <div className="text-base font-medium text-[var(--color-fg)] truncate mb-0.5">
          {toTitleCase(r.customer_name) || 'Senza nome'}
        </div>
        <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
          <span className="inline-flex items-center gap-1">
            <Users className="h-3.5 w-3.5" />
            {r.guests}{r.children ? `+${r.children}` : ''}
          </span>
          {r.phone && (
            <span className="inline-flex items-center gap-1 truncate">
              <Phone className="h-3.5 w-3.5" />
              {formatPhone(r.phone)}
            </span>
          )}
        </div>
        {table && (
          <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300 text-sm font-semibold">
            <MapPin className="h-3.5 w-3.5" />
            {table.name}
          </div>
        )}
      </button>
    );
  };

  const renderGroup = (title: string, items: Reservation[]) => {
    if (items.length === 0) return null;
    return (
      <div className="mb-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-fg-muted)] px-1 mb-2">
          {title} · {items.length}
        </div>
        <div className="space-y-2">{items.map(renderCard)}</div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col bg-[var(--color-surface)]">
      {/* Top header. Desktop: title · centred stats · Walk-in · refresh on one
          row. Mobile: title + actions on row 1, a compact 4-up stats strip on
          row 2 (the centred desktop stats overflow a phone). */}
      <div className="flex-shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface-2)]">
        <div className="px-4 py-3 flex items-center gap-3">
          {onBack && (
            <button
              onClick={onBack}
              className="pressable p-2 -ml-1 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]"
              aria-label="Indietro"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          <h1 className="text-lg lg:text-xl font-semibold text-[var(--color-fg)]">Reception</h1>

          {/* Desktop centred stats */}
          <div className="hidden lg:flex flex-1 items-center justify-center gap-6 text-sm">
            <HeaderStat value={stats.count} label="Prenotazioni" />
            <HeaderStat value={stats.guests} label="Coperti" />
            <HeaderStat value={stats.arrived} label="Arrivati" tone="emerald" />
            <HeaderStat value={stats.noTable} label="Senza tavolo" tone={stats.noTable > 0 ? 'amber' : undefined} />
          </div>

          {/* Mobile spacer pushes the actions to the right */}
          <div className="flex-1 lg:hidden" />

          <button
            onClick={() => setShowWalkIn(true)}
            className="pressable inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm shadow-sm flex-shrink-0"
            title="Cliente senza prenotazione"
          >
            <Zap className="h-4 w-4" />
            Walk-in
          </button>
          <button
            onClick={loadAll}
            className="pressable p-2 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0"
            aria-label="Aggiorna"
            title="Aggiorna"
          >
            <RefreshCw className={`h-5 w-5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Mobile stats strip */}
        <div className="grid grid-cols-4 gap-2 px-4 pb-3 lg:hidden">
          <HeaderStat value={stats.count} label="Prenot." compact />
          <HeaderStat value={stats.guests} label="Coperti" compact />
          <HeaderStat value={stats.arrived} label="Arrivati" tone="emerald" compact />
          <HeaderStat value={stats.noTable} label="Senza tav." tone={stats.noTable > 0 ? 'amber' : undefined} compact />
        </div>
      </div>

      {error && (
        <div className="flex-shrink-0 bg-rose-50 border-b border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-300 px-4 py-2 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* "In arrivo adesso" — one-tap check-in rail. The next parties due at
          the door, most overdue first; a single tap seats them. */}
      {arrivingNow.length > 0 && (
        <div className="flex-shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface-2)] px-3 py-2.5">
          <div className="flex items-center gap-2 mb-2 px-1">
            <PulseDot dotClass="bg-booked-600" pulse sizeClass="h-2 w-2" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-muted)]">
              In arrivo adesso
            </span>
            <span className="text-[11px] text-[var(--color-fg-subtle)] tabular-nums">· {arrivingNow.length}</span>
          </div>
          <div className="flex gap-2 overflow-x-auto pb-0.5 scrollbar-hide">
            {arrivingNow.map(r => {
              const start = new Date(r.reservation_time).getTime();
              const deltaMin = Math.round((nowTick - start) / 60_000);
              const table = r.table_id ? tables.find(t => t.id === r.table_id) : null;
              return (
                <div
                  key={r.id}
                  className={`flex-shrink-0 flex items-center gap-3 pl-3.5 pr-2 py-2 rounded-2xl border transition-colors cursor-pointer ${
                    r.id === selectedReservationId
                      ? 'bg-booked-50 border-booked-300 dark:bg-booked-600/25 dark:border-booked-600/50'
                      : 'bg-[var(--color-surface)] border-[var(--color-line)] hover:border-[var(--color-line-strong)]'
                  }`}
                  onClick={() => setSelectedReservationId(r.id)}
                >
                  <div className="min-w-0">
                    <div className="flex items-baseline gap-2">
                      <span className="text-base font-bold text-[var(--color-fg)] tabular-nums">{formatHHMM(r.reservation_time)}</span>
                      <span className={`text-[11px] font-semibold tabular-nums ${
                        deltaMin > 5 ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--color-fg-subtle)]'
                      }`}>
                        {deltaMin > 0 ? `+${deltaMin}′` : deltaMin < 0 ? `tra ${-deltaMin}′` : 'ora'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-sm text-[var(--color-fg)] max-w-[180px]">
                      <span className="font-medium truncate">{toTitleCase(r.customer_name) || 'Senza nome'}</span>
                      <span className="text-xs text-[var(--color-fg-muted)] flex items-center gap-0.5 flex-none">
                        <Users className="h-3 w-3" />{r.guests}
                      </span>
                      {table && (
                        <span className="text-xs font-semibold text-[var(--color-fg-muted)] flex-none">· {table.name}</span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={(e) => { e.stopPropagation(); handleQuickArrive(r); }}
                    aria-label={`Segna ${toTitleCase(r.customer_name) || 'prenotazione'} come arrivato`}
                    className="flex-none inline-flex items-center gap-1.5 h-11 px-3.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 active:scale-95 transition disabled:opacity-50"
                  >
                    <CheckCircle2 className="h-4.5 w-4.5" />
                    Arrivato
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Desktop: 40/60 split. Mobile: the list is full-width and tapping a
          card opens the detail as a full-screen drawer (below). */}
      <div className="flex-1 flex min-h-0">
        {/* LEFT — full width on mobile, 40% on desktop */}
        <div className="w-full lg:w-2/5 lg:min-w-[320px] flex flex-col lg:border-r border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="flex-shrink-0 px-3 pt-3 pb-2 space-y-2 border-b border-[var(--color-line)]">
            {/* Lista / Mappa toggle — controls the right pane so the host can
                check the floor at any time without leaving the list view. */}
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-[var(--color-surface-2)] border border-[var(--color-line)]">
              {([
                ['list', 'Lista', <List key="l" className="h-4 w-4" />],
                ['map', 'Mappa', <LayoutGrid key="m" className="h-4 w-4" />]
              ] as const).map(([key, label, icon]) => (
                <button
                  key={key}
                  onClick={() => setViewMode(key)}
                  className={`inline-flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-semibold transition-colors ${
                    viewMode === key
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-sm'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  }`}
                  aria-pressed={viewMode === key}
                >
                  {icon}
                  {label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-muted)]" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Cerca nome o telefono…"
                className="w-full pl-10 pr-3 py-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] placeholder:text-[var(--color-fg-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500/40 text-base"
              />
            </div>
            <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
              {([
                ['all', 'Tutte'],
                ['waiting', 'Confermate'],
                ['arrived', 'Arrivati'],
                ['noTable', 'Senza tavolo']
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setStatusFilter(key)}
                  className={`flex-shrink-0 text-xs font-medium px-3 py-1.5 rounded-full border whitespace-nowrap ${
                    statusFilter === key
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pt-3 pb-4">
            {isInitialLoading && reservations.length === 0 ? (
              renderListSkeleton()
            ) : filtered.length === 0 ? (
              <div className="text-center text-sm text-[var(--color-fg-muted)] py-10">
                Nessuna prenotazione corrisponde ai filtri.
              </div>
            ) : (
              <>
                {renderGroup('Adesso · prossima ora', grouped.adesso)}
                {renderGroup('Tra 1–3 ore', grouped.prossima)}
                {renderGroup('Più tardi', grouped.piuTardi)}
              </>
            )}
          </div>
        </div>

        {/* RIGHT 60% — detail (desktop inline) */}
        <div className="hidden lg:flex flex-1 flex-col bg-[var(--color-surface)] min-w-0">
          {!selectedReservation ? (
            <EmptyState count={filtered.length} />
          ) : (
            <DetailPanel
              reservation={selectedReservation}
              table={selectedTable}
              busy={busy}
              onAssignTable={() => setShowTablePicker(true)}
              onRemoveTable={handleRemoveTable}
              onMarkArrived={handleMarkArrived}
              onMarkWaiting={handleMarkWaiting}
              onMarkNoShow={handleMarkNoShow}
              onMarkDeparting={handleMarkDeparting}
              onFreeTable={handleFreeTable}
            />
          )}
        </div>
      </div>

      {/* Mobile detail drawer — full-screen over the list; a back chevron
          returns to the list. Sits above the bottom nav (z-30). */}
      {selectedReservation && (
        <div className="lg:hidden fixed inset-0 z-40 flex flex-col bg-[var(--color-surface)] animate-view-in">
          <div className="flex-shrink-0 flex items-center gap-2 px-3 h-14 border-b border-[var(--color-line)] bg-[var(--color-surface-2)]">
            <button
              onClick={() => setSelectedReservationId(null)}
              className="pressable p-2 -ml-1 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]"
              aria-label="Torna alla lista"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <span className="font-semibold text-[var(--color-fg)]">Dettaglio prenotazione</span>
          </div>
          <DetailPanel
            reservation={selectedReservation}
            table={selectedTable}
            busy={busy}
            onAssignTable={() => setShowTablePicker(true)}
            onRemoveTable={handleRemoveTable}
            onMarkArrived={handleMarkArrived}
            onMarkWaiting={handleMarkWaiting}
            onMarkNoShow={handleMarkNoShow}
            onMarkDeparting={handleMarkDeparting}
            onFreeTable={handleFreeTable}
          />
        </div>
      )}

      {/* Full-screen table picker so every table in a room is visible without
          horizontal scroll — the spatial map needs the whole viewport. */}
      {showTablePicker && selectedReservation && (
        <TablePicker
          reservation={selectedReservation}
          tables={tables}
          rooms={rooms}
          activeRoomId={activeRoomId}
          setActiveRoomId={setActiveRoomId}
          occupiedTableIds={occupiedTableIds}
          reservationByTableId={reservationByTableId}
          onCancel={() => setShowTablePicker(false)}
          onSelect={handleAssignTable}
          onSwap={handleSwapTable}
          busy={busy}
        />
      )}

      {/* Mappa mode opens the same full-viewport canvas as the assign-table
          picker, but coloured by today's reservation state instead of fit. */}
      {viewMode === 'map' && (
        <RoomMap
          tables={tables}
          rooms={rooms}
          reservationByTableId={reservationByTableId}
          activeRoomId={activeRoomId}
          setActiveRoomId={setActiveRoomId}
          onClose={() => setViewMode('list')}
          onPickReservation={(id) => {
            setSelectedReservationId(id);
            setViewMode('list');
          }}
          now={isViewingToday ? nowTick : undefined}
        />
      )}

      {showWalkIn && (
        <WalkInModal
          busy={busy}
          onCancel={() => setShowWalkIn(false)}
          onSubmit={handleCreateWalkIn}
        />
      )}
    </div>
  );
};

interface WalkInModalProps {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: { name: string; guests: number; phone: string; notes: string }) => void;
}

const WalkInModal: React.FC<WalkInModalProps> = ({ busy, onCancel, onSubmit }) => {
  const [name, setName] = useState('');
  const [guests, setGuests] = useState(2);
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  const canSubmit = name.trim().length > 0 && guests > 0;

  return (
    <div
      className="fixed inset-0 z-50 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center p-4"
      onClick={() => { if (!busy) onCancel(); }}
    >
      <div
        className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-[var(--color-fg)]" />
            <h3 className="text-lg font-semibold text-[var(--color-fg)]">Walk-in</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-2 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]"
            aria-label="Chiudi"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-sm text-[var(--color-fg-muted)]">
            Crea una prenotazione "adesso" già marcata come arrivata. Subito dopo potrai assegnare il tavolo.
          </p>

          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1.5">
              Nome cliente <span className="text-rose-500">*</span>
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Es. Mario Rossi"
              className="w-full px-3 py-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-[var(--color-fg)] mb-1.5">
                Coperti <span className="text-rose-500">*</span>
              </label>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setGuests(g => Math.max(1, g - 1))}
                  className="w-11 h-11 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-xl font-semibold hover:bg-[var(--color-surface-3)]"
                  aria-label="Meno"
                >−</button>
                <div className="flex-1 text-center text-2xl font-bold text-[var(--color-fg)] tabular-nums">{guests}</div>
                <button
                  type="button"
                  onClick={() => setGuests(g => g + 1)}
                  className="w-11 h-11 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-xl font-semibold hover:bg-[var(--color-surface-3)]"
                  aria-label="Più"
                >+</button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-[var(--color-fg)] mb-1.5">
                Telefono
              </label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Opzionale"
                className="w-full h-11 px-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-[var(--color-fg)] mb-1.5">
              Note
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Allergie, preferenze, …"
              rows={2}
              className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]/20 resize-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 py-2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            onClick={() => onSubmit({ name, guests, phone, notes })}
            disabled={busy || !canSubmit}
            className="px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Crea e assegna tavolo
          </button>
        </div>
      </div>
    </div>
  );
};

const EmptyState: React.FC<{ count: number }> = ({ count }) => (
  <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
    <div className="w-20 h-20 rounded-full bg-[var(--color-surface-2)] border border-[var(--color-line)] flex items-center justify-center mb-4">
      <UserPlus className="h-10 w-10 text-[var(--color-fg-muted)]" />
    </div>
    <h2 className="text-xl font-semibold text-[var(--color-fg)] mb-1">
      {count > 0 ? 'Seleziona una prenotazione' : 'Nessuna prenotazione'}
    </h2>
    <p className="text-sm text-[var(--color-fg-muted)] max-w-sm">
      {count > 0
        ? 'Tocca un nome nell\'elenco a sinistra per vedere i dettagli e assegnare il tavolo.'
        : 'Per oggi non risultano prenotazioni. Quando arriveranno i clienti compariranno qui.'}
    </p>
  </div>
);

interface DetailPanelProps {
  reservation: Reservation;
  table: Table | null;
  busy: boolean;
  onAssignTable: () => void;
  onRemoveTable: () => void;
  onMarkArrived: () => void;
  onMarkWaiting: () => void;
  onMarkNoShow: () => void;
  onMarkDeparting: () => void;
  onFreeTable: () => void;
}

const DetailPanel: React.FC<DetailPanelProps> = ({
  reservation,
  table,
  busy,
  onAssignTable,
  onRemoveTable,
  onMarkArrived,
  onMarkWaiting,
  onMarkNoShow,
  onMarkDeparting,
  onFreeTable
}) => {
  const arr = reservation.arrival_status || ArrivalStatus.WAITING;
  const noShow = reservation.reservation_status === ReservationStatus.NO_SHOW;
  const seated = isSeated(reservation);

  return (
    <div className="flex-1 flex flex-col overflow-y-auto">
      {/* Info header. Compact on mobile so the action buttons stay in view even
          with notes: smaller name, single meta row, table as a horizontal bar.
          Desktop keeps the roomy layout with the big square table card. */}
      <div className="flex-shrink-0 px-5 lg:px-8 pt-4 lg:pt-8 pb-4 lg:pb-6 border-b border-[var(--color-line)]">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-3 lg:gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2 lg:gap-3 mb-1.5 lg:mb-2">
              <h2 className="text-2xl lg:text-3xl font-bold text-[var(--color-fg)] truncate">
                {toTitleCase(reservation.customer_name) || 'Senza nome'}
              </h2>
              {reservation.customer_is_vip && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 text-xs font-semibold flex-shrink-0">
                  <Star className="h-3.5 w-3.5 fill-current" /> VIP
                </span>
              )}
            </div>
            <div className="flex items-center gap-x-4 gap-y-1 text-sm lg:text-base text-[var(--color-fg-muted)] flex-wrap">
              <span className="inline-flex items-center gap-1.5 lg:gap-2">
                <Clock className="h-4 w-4 flex-shrink-0" />
                <span className="font-semibold text-[var(--color-fg)]">
                  {formatHHMM(reservation.reservation_time)}
                </span>
              </span>
              <span className="inline-flex items-center gap-1.5 lg:gap-2">
                <Users className="h-4 w-4 flex-shrink-0" />
                <span className="font-semibold text-[var(--color-fg)] whitespace-nowrap">
                  {reservation.guests}{reservation.children ? ` +${reservation.children} bimbi` : ''} coperti
                </span>
              </span>
              {reservation.phone && (
                <a
                  href={`tel:${reservation.phone}`}
                  className="inline-flex items-center gap-1.5 lg:gap-2 text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  <Phone className="h-4 w-4 flex-shrink-0" />
                  <span className="font-semibold">{formatPhone(reservation.phone)}</span>
                </a>
              )}
            </div>
          </div>
          {table ? (
            <div className="flex-shrink-0 w-full lg:w-auto flex flex-row lg:flex-col items-center justify-between lg:justify-center gap-3 lg:gap-0 px-4 lg:px-6 py-2.5 lg:py-4 rounded-xl lg:rounded-2xl bg-indigo-50 border border-indigo-200 dark:bg-indigo-500/15 dark:border-indigo-500/40">
              <div className="flex items-baseline lg:flex-col lg:items-center gap-2 lg:gap-0">
                <span className="text-[10px] uppercase tracking-wider text-indigo-700 dark:text-indigo-300 font-semibold lg:mb-1">Tavolo</span>
                <span className="text-2xl lg:text-4xl font-extrabold text-indigo-700 dark:text-indigo-200 tabular-nums leading-none">
                  {table.name}
                </span>
              </div>
              <div className="text-xs text-indigo-600 dark:text-indigo-300 lg:mt-1">
                {table.seats} posti
              </div>
            </div>
          ) : (
            <div className="flex-shrink-0 w-full lg:w-auto px-4 lg:px-6 py-2.5 lg:py-4 rounded-xl lg:rounded-2xl bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 text-sm font-medium text-center">
              Nessun tavolo assegnato
            </div>
          )}
        </div>

        {/* Customer notes / preferences */}
        {(reservation.notes || reservation.customer_dietary_notes || reservation.customer_preferences_notes) && (
          <div className="mt-3 lg:mt-5 space-y-1.5 lg:space-y-2">
            <DietaryChips notes={reservation.notes} />
            {stripDietaryNote(reservation.notes) && (
              <NotesLine label="Note prenotazione" text={stripDietaryNote(reservation.notes)} />
            )}
            {reservation.customer_dietary_notes && (
              <NotesLine label="Dieta / allergie" text={reservation.customer_dietary_notes} tone="amber" />
            )}
            {reservation.customer_preferences_notes && (
              <NotesLine label="Preferenze cliente" text={reservation.customer_preferences_notes} />
            )}
          </div>
        )}
      </div>

      {/* Action buttons — big touch targets */}
      <div className="flex-shrink-0 px-5 lg:px-8 py-4 lg:py-6">
        <div className="grid grid-cols-2 gap-2.5 lg:gap-4">
          <ActionButton
            primary
            disabled={busy}
            onClick={onAssignTable}
            icon={<MapPin className="h-6 w-6" />}
            label={table ? 'Cambia tavolo' : 'Assegna tavolo'}
          />
          {table && (
            <ActionButton
              disabled={busy}
              onClick={onRemoveTable}
              icon={<MapPinOff className="h-6 w-6" />}
              label="Rimuovi tavolo"
              variant="neutral"
            />
          )}
          {seated ? (
            <ActionButton
              disabled={busy}
              onClick={onFreeTable}
              icon={<Armchair className="h-6 w-6" />}
              label="Tavolo liberato"
              variant="neutral"
            />
          ) : (
            <ActionButton
              disabled={busy || noShow}
              onClick={onMarkArrived}
              icon={<CheckCircle2 className="h-6 w-6" />}
              label="Arrivato"
              variant="success"
            />
          )}
          {arr === ArrivalStatus.WAITING && !noShow && (
            <ActionButton
              disabled={busy}
              onClick={onMarkNoShow}
              icon={<XCircle className="h-6 w-6" />}
              label="No-show"
              variant="danger"
            />
          )}
          {arr === ArrivalStatus.ARRIVED && (
            <ActionButton
              disabled={busy}
              onClick={onMarkDeparting}
              icon={<LogOut className="h-6 w-6" />}
              label="In uscita"
              variant="info"
            />
          )}
          {arr === ArrivalStatus.DEPARTING && (
            <ActionButton
              disabled={busy}
              onClick={onMarkArrived}
              icon={<CheckCircle2 className="h-6 w-6" />}
              label="Annulla in uscita"
              variant="neutral"
            />
          )}
          {arr === ArrivalStatus.ARRIVED && (
            <ActionButton
              disabled={busy}
              onClick={onMarkWaiting}
              icon={<Clock className="h-6 w-6" />}
              label="In attesa"
              variant="neutral"
            />
          )}
          {noShow && (
            <ActionButton
              disabled={busy}
              onClick={onMarkArrived}
              icon={<CheckCircle2 className="h-6 w-6" />}
              label="Annulla no-show"
              variant="neutral"
            />
          )}
        </div>
      </div>
    </div>
  );
};

const NotesLine: React.FC<{ label: string; text: string; tone?: 'amber' }> = ({ label, text, tone }) => (
  <div className={`text-[13px] lg:text-sm px-3 py-1.5 lg:py-2 rounded-lg lg:rounded-xl border ${
    tone === 'amber'
      ? 'bg-amber-50 border-amber-200 text-amber-800 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200'
      : 'bg-[var(--color-surface-2)] border-[var(--color-line)] text-[var(--color-fg)]'
  }`}>
    <span className="text-[10px] uppercase tracking-wider font-semibold opacity-70 mr-2">{label}</span>
    {text}
  </div>
);

interface ActionButtonProps {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  primary?: boolean;
  variant?: 'success' | 'danger' | 'neutral' | 'info';
}

const ActionButton: React.FC<ActionButtonProps> = ({ onClick, disabled, icon, label, primary, variant }) => {
  let cls = 'bg-[var(--color-surface-2)] text-[var(--color-fg)] border-[var(--color-line)] hover:bg-[var(--color-surface-3)]';
  if (primary) {
    cls = 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700';
  } else if (variant === 'success') {
    cls = 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700';
  } else if (variant === 'danger') {
    cls = 'bg-rose-600 text-white border-rose-600 hover:bg-rose-700';
  } else if (variant === 'info') {
    // "In uscita" — cyan, matching the departing table state on the map.
    cls = 'bg-cyan-700 text-white border-cyan-700 hover:bg-cyan-800';
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`pressable flex items-center justify-center gap-2.5 lg:gap-3 px-4 py-3.5 lg:py-5 rounded-xl lg:rounded-2xl border text-base lg:text-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed min-h-[60px] lg:min-h-[80px] ${cls}`}
    >
      {icon}
      {label}
    </button>
  );
};

interface TablePickerProps {
  reservation: Reservation;
  tables: Table[];
  rooms: Room[];
  activeRoomId: number | null;
  setActiveRoomId: (id: number) => void;
  occupiedTableIds: Set<number>;
  reservationByTableId: Map<number, Reservation>;
  onCancel: () => void;
  onSelect: (tableId: number) => void;
  onSwap: (otherReservationId: number) => void;
  busy: boolean;
}

const TablePicker: React.FC<TablePickerProps> = ({
  reservation,
  tables,
  rooms,
  activeRoomId,
  setActiveRoomId,
  occupiedTableIds,
  reservationByTableId,
  onCancel,
  onSelect,
  onSwap,
  busy
}) => {
  // Tapping an occupied tile arms a swap confirmation — the host pairs the
  // current reservation with the booking sitting at that tile.
  const [swapCandidate, setSwapCandidate] = useState<Reservation | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setContainerSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const visibleRooms = rooms.filter(r => !r.is_closed);
  const activeRoom = visibleRooms.find(r => r.id === activeRoomId) || visibleRooms[0];
  const roomTables = activeRoom ? tables.filter(t => t.room_id === activeRoom.id) : [];

  // Compute the true bounding box from the placed tables (room.width/height
  // is a stored ceiling but tables can be positioned right at the edge, which
  // is why earlier versions clipped tables 34 & 36 on the Veranda).
  const PAD = 48;
  const extent = useMemo(() => {
    let maxR = activeRoom?.width || 0;
    let maxB = activeRoom?.height || 0;
    for (const t of roomTables) {
      const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
      maxR = Math.max(maxR, t.x + w);
      maxB = Math.max(maxB, t.y + h);
    }
    return { width: maxR + PAD, height: maxB + PAD };
  }, [activeRoom, roomTables]);

  const scale = extent.width > 0 && extent.height > 0
    ? Math.min(
        (containerSize.width - PAD * 2) / extent.width,
        (containerSize.height - PAD * 2) / extent.height,
        1.6 // allow modest upscaling so a sparse room still fills the canvas
      )
    : 1;

  // Bucket each table for the picker so the host can scan the room in two
  // glances: which ones fit, which ones are out, which one is the current.
  type TableState = 'ideal' | 'big' | 'tooSmall' | 'occupied' | 'current';
  const bucketize = (t: Table): TableState => {
    if (reservation.table_id === t.id) return 'current';
    if (occupiedTableIds.has(t.id)) return 'occupied';
    const cap = t.max_seats ?? t.seats;
    if (cap < reservation.guests) return 'tooSmall';
    if (t.seats > reservation.guests + 2) return 'big';
    return 'ideal';
  };

  const counts = useMemo(() => {
    const c = { ideal: 0, big: 0, tooSmall: 0, occupied: 0 };
    for (const t of roomTables) {
      const s = bucketize(t);
      if (s === 'current') continue;
      if (s === 'ideal') c.ideal++;
      else if (s === 'big') c.big++;
      else if (s === 'tooSmall') c.tooSmall++;
      else if (s === 'occupied') c.occupied++;
    }
    return c;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomTables, occupiedTableIds, reservation.table_id, reservation.guests]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
      {/* Header — compact, party-size hint sits where the host's eye lands. */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-[var(--color-line)] flex items-center justify-between gap-4 bg-[var(--color-surface-2)]">
        <div className="min-w-0 flex items-baseline gap-3 flex-wrap">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-semibold">
            Tavolo per
          </div>
          <div className="text-xl font-bold text-[var(--color-fg)] truncate">
            {toTitleCase(reservation.customer_name) || 'Senza nome'}
          </div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] text-sm font-semibold text-[var(--color-fg)]">
            <Users className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
            {reservation.guests} coperti
          </div>
        </div>
        <button
          onClick={onCancel}
          disabled={busy}
          aria-label="Chiudi"
          className="h-10 w-10 flex-shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] inline-flex items-center justify-center"
        >
          <XIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Room tabs + scan summary on the same row to save vertical space. */}
      <div className="flex-shrink-0 px-6 py-3 flex items-center justify-between gap-4 border-b border-[var(--color-line)] flex-wrap">
        {visibleRooms.length > 1 ? (
          <div className="flex gap-1.5 overflow-x-auto">
            {visibleRooms.map(room => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                className={`px-4 h-9 rounded-full text-sm font-medium whitespace-nowrap border transition-colors ${
                  room.id === activeRoom?.id
                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-transparent'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
          <LegendDot tone="emerald" label={`${counts.ideal} adatti`} />
          <LegendDot tone="slate" label={`${counts.big} grandi`} />
          <LegendDot tone="rose" label={`${counts.occupied} occupati`} />
          {reservation.table_id && (
            <LegendDot tone="amber" label="tocca occupato → scambia" />
          )}
        </div>
      </div>

      {/* Canvas. Floor-dot background so the room reads as space, not a card. */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden flex items-center justify-center"
        style={{
          backgroundImage: 'radial-gradient(var(--floor-dot) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      >
        {activeRoom && (
          <div
            className="relative"
            style={{
              width: extent.width * scale,
              height: extent.height * scale,
            }}
          >
            {roomTables.map(t => {
              const state = bucketize(t);
              // Swap is offered only when *we* already have a table to give away.
              // Without it the swap would be a one-way reassignment, which the
              // server (correctly) refuses.
              const occupantRes = state === 'occupied' ? reservationByTableId.get(t.id) : null;
              const swappable = state === 'occupied' && !!reservation.table_id && !!occupantRes;
              const disabled = state === 'tooSmall' || (state === 'occupied' && !swappable);
              const dim = getGlyphDimensions(t.shape, t.seats);
              const glyphW = dim.width * scale;
              const glyphH = dim.height * scale;

              // Match the natural glyph radius so the halo follows the table
              // shape (circle ≈ pill; rectangle ≈ rounded square).
              const haloRadius = t.shape === TableShape.CIRCLE ? '9999px' : '20px';

              // Decoration per state. The glyph itself stays in 'libera' so the
              // room reads as a coherent floor plan — colour is conveyed by the
              // halo + opacity, not by recolouring the chairs.
              let haloClass = '';
              let glyphOpacity = 'opacity-100';
              let grayscale = '';
              let badge: { text: string; tone: 'emerald' | 'slate' | 'rose' | 'indigo' | 'amber' } | null = null;

              if (state === 'current') {
                haloClass = 'ring-2 ring-indigo-500 shadow-[0_0_0_4px_rgba(99,102,241,0.18)]';
                badge = { text: 'Attuale', tone: 'indigo' };
              } else if (state === 'occupied') {
                if (swappable) {
                  haloClass = 'ring-2 ring-amber-400/70 hover:ring-amber-500 hover:shadow-[0_8px_24px_-8px_rgba(245,158,11,0.45)]';
                  glyphOpacity = 'opacity-80';
                  badge = { text: 'Scambia', tone: 'amber' };
                } else {
                  haloClass = 'ring-1 ring-rose-300';
                  glyphOpacity = 'opacity-50';
                  badge = { text: 'Occupato', tone: 'rose' };
                }
              } else if (state === 'tooSmall') {
                haloClass = '';
                glyphOpacity = 'opacity-40';
                grayscale = 'grayscale';
                badge = { text: `${t.seats} posti`, tone: 'slate' };
              } else if (state === 'ideal') {
                haloClass = 'ring-2 ring-emerald-400/70 hover:ring-emerald-500 hover:shadow-[0_8px_24px_-8px_rgba(16,185,129,0.45)]';
              } else if (state === 'big') {
                haloClass = 'ring-1 ring-slate-300 hover:ring-slate-400';
              }

              const handleClick = () => {
                if (disabled) return;
                if (swappable && occupantRes) {
                  setSwapCandidate(occupantRes);
                } else {
                  onSelect(t.id);
                }
              };

              return (
                <button
                  key={t.id}
                  onClick={handleClick}
                  disabled={busy || disabled}
                  className={`absolute transition-all duration-150 ${
                    disabled ? 'cursor-not-allowed' : 'cursor-pointer hover:-translate-y-0.5 hover:z-10'
                  }`}
                  style={{
                    left: t.x * scale,
                    top: t.y * scale,
                    width: glyphW,
                    height: glyphH,
                  }}
                  title={`${t.name} · ${t.seats} posti${t.max_seats && t.max_seats !== t.seats ? ` (max ${t.max_seats})` : ''}`}
                >
                  <div
                    className={`relative ${haloClass} ${glyphOpacity} ${grayscale}`}
                    style={{ width: glyphW, height: glyphH, borderRadius: haloRadius }}
                  >
                    <div className="absolute inset-0 flex items-center justify-center">
                      <TableGlyph
                        name={t.name}
                        seats={t.seats}
                        shape={t.shape}
                        status="libera"
                        fit
                      />
                    </div>
                  </div>
                  {badge && (
                    <span
                      className={`absolute left-1/2 -translate-x-1/2 -bottom-3 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider whitespace-nowrap shadow-sm border ${
                        badge.tone === 'rose'    ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-200 dark:border-rose-500/40'
                      : badge.tone === 'slate'   ? 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30'
                      : badge.tone === 'indigo'  ? 'bg-indigo-600 text-white border-indigo-600'
                      : badge.tone === 'amber'   ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/40'
                                                 : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {badge.text}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Swap confirmation — sits over the picker so the host can verify the
          two parties before committing the atomic exchange. */}
      {swapCandidate && (
        <SwapConfirmDialog
          source={reservation}
          target={swapCandidate}
          tables={tables}
          busy={busy}
          onCancel={() => setSwapCandidate(null)}
          onConfirm={() => {
            const otherId = swapCandidate.id;
            setSwapCandidate(null);
            onSwap(otherId);
          }}
        />
      )}
    </div>
  );
};

interface SwapConfirmDialogProps {
  source: Reservation;
  target: Reservation;
  tables: Table[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

const SwapConfirmDialog: React.FC<SwapConfirmDialogProps> = ({
  source, target, tables, busy, onCancel, onConfirm,
}) => {
  const tableName = (id?: number | null) =>
    tables.find(t => t.id === id)?.name ?? '—';
  return (
    <div className="fixed inset-0 z-[60] bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center p-4">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md overflow-hidden">
        <div className="p-4 border-b border-[var(--color-line)]">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-semibold mb-1">
            Conferma scambio tavoli
          </div>
          <div className="text-lg font-bold text-[var(--color-fg)]">
            Inverti i due tavoli?
          </div>
        </div>
        <div className="p-5 space-y-3">
          <SwapRow
            name={toTitleCase(source.customer_name) || 'Senza nome'}
            from={tableName(source.table_id)}
            to={tableName(target.table_id)}
          />
          <SwapRow
            name={toTitleCase(target.customer_name) || 'Senza nome'}
            from={tableName(target.table_id)}
            to={tableName(source.table_id)}
          />
        </div>
        <div className="p-4 bg-[var(--color-surface-2)] flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-4 h-10 rounded-xl border border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] font-medium disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 h-10 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold disabled:opacity-50 inline-flex items-center gap-2"
          >
            <RefreshCw className="h-4 w-4" />
            Inverti tavoli
          </button>
        </div>
      </div>
    </div>
  );
};

const SwapRow: React.FC<{ name: string; from: string; to: string }> = ({ name, from, to }) => (
  <div className="flex items-center gap-2 text-sm">
    <div className="flex-1 min-w-0 truncate font-medium text-[var(--color-fg)]">{name}</div>
    <span className="px-2 py-0.5 rounded-md bg-[var(--color-surface-2)] border border-[var(--color-line)] text-[var(--color-fg-muted)] text-xs font-semibold tabular-nums">
      {from}
    </span>
    <span className="text-[var(--color-fg-muted)]">→</span>
    <span className="px-2 py-0.5 rounded-md bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs font-semibold tabular-nums dark:bg-emerald-500/15 dark:text-emerald-200 dark:border-emerald-500/40">
      {to}
    </span>
  </div>
);

// Reception KPI — shared by the desktop centred row and the mobile 4-up strip
// so the two never drift. `compact` shrinks it for the phone layout.
const HeaderStat: React.FC<{ value: number; label: string; tone?: 'emerald' | 'amber'; compact?: boolean }> = ({ value, label, tone, compact }) => {
  const valueColor = tone === 'emerald' ? 'text-emerald-600 dark:text-emerald-400'
    : tone === 'amber' ? 'text-amber-600 dark:text-amber-400'
    : 'text-[var(--color-fg)]';
  return (
    <div className={compact ? 'text-center rounded-xl bg-[var(--color-surface)] border border-[var(--color-line)] py-1.5' : 'text-center'}>
      <div className={`${compact ? 'text-xl' : 'text-2xl'} font-bold tabular-nums ${valueColor}`}>{value}</div>
      <div className={`${compact ? 'text-[9px]' : 'text-[10px]'} uppercase tracking-wider text-[var(--color-fg-muted)]`}>{label}</div>
    </div>
  );
};

const LegendDot: React.FC<{ tone: 'emerald' | 'slate' | 'rose' | 'indigo' | 'amber' | 'cyan'; label: string }> = ({ tone, label }) => {
  const dot =
    tone === 'emerald' ? 'bg-emerald-500'
    : tone === 'rose'  ? 'bg-rose-400'
    : tone === 'indigo' ? 'bg-indigo-500'
    : tone === 'amber' ? 'bg-amber-400'
    : tone === 'cyan'  ? 'bg-cyan-600'
                       : 'bg-slate-300';
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
};

interface RoomMapProps {
  tables: Table[];
  rooms: Room[];
  reservationByTableId: Map<number, Reservation>;
  activeRoomId: number | null;
  setActiveRoomId: (id: number) => void;
  onClose: () => void;
  onPickReservation: (id: number) => void;
  /** Epoch ms for time-derived states; undefined = not viewing today. */
  now?: number;
}

// Full-viewport live room map — shares the visual shell with the assign-table
// picker, but each table is colour-coded by today's reservation state instead
// of fit. Tapping a booked table jumps to that reservation in the list and
// closes the map; tapping a free table is a no-op.
const RoomMap: React.FC<RoomMapProps> = ({
  tables,
  rooms,
  reservationByTableId,
  activeRoomId,
  setActiveRoomId,
  onClose,
  onPickReservation,
  now,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 600, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setContainerSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const visibleRooms = rooms.filter(r => !r.is_closed);
  const activeRoom = visibleRooms.find(r => r.id === activeRoomId) || visibleRooms[0];
  const roomTables = activeRoom ? tables.filter(t => t.room_id === activeRoom.id) : [];

  const PAD = 40;
  const extent = useMemo(() => {
    let maxR = activeRoom?.width || 0;
    let maxB = activeRoom?.height || 0;
    for (const t of roomTables) {
      const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
      maxR = Math.max(maxR, t.x + w);
      maxB = Math.max(maxB, t.y + h);
    }
    return { width: maxR + PAD, height: maxB + PAD };
  }, [activeRoom, roomTables]);

  const scale = extent.width > 0 && extent.height > 0
    ? Math.min(
        (containerSize.width - PAD * 2) / extent.width,
        (containerSize.height - PAD * 2) / extent.height,
        1.6
      )
    : 1;

  // Stats for the active room — gives the host a one-glance read on capacity.
  const stats = useMemo(() => {
    let arrived = 0, departing = 0, waiting = 0, free = 0;
    for (const t of roomTables) {
      const r = reservationByTableId.get(t.id);
      // A DEPARTED-only table is free again — the glyph beside this counter
      // renders it as libera, and the legend must agree.
      if (!r || r.arrival_status === ArrivalStatus.DEPARTED) { free++; continue; }
      if (r.arrival_status === ArrivalStatus.DEPARTING) departing++;
      else if (r.arrival_status === ArrivalStatus.ARRIVED) arrived++;
      else if (r.reservation_status !== ReservationStatus.NO_SHOW) waiting++;
    }
    return { arrived, departing, waiting, free };
  }, [roomTables, reservationByTableId]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
      {/* Header — mirrors the TablePicker shell so the two views feel paired. */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-[var(--color-line)] flex items-center justify-between gap-4 bg-[var(--color-surface-2)]">
        <div className="min-w-0 flex items-baseline gap-3 flex-wrap">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-semibold">
            Stato sala
          </div>
          <div className="text-xl font-bold text-[var(--color-fg)] truncate">
            {activeRoom?.name || 'Sala'}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Chiudi"
          className="h-10 w-10 flex-shrink-0 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] inline-flex items-center justify-center"
        >
          <XIcon className="h-5 w-5" />
        </button>
      </div>

      {/* Room tabs + stats on a single header row */}
      <div className="flex-shrink-0 px-6 py-3 border-b border-[var(--color-line)] flex items-center justify-between gap-4 flex-wrap">
        {visibleRooms.length > 1 ? (
          <div className="flex gap-1.5 overflow-x-auto">
            {visibleRooms.map(room => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                className={`px-4 h-9 rounded-full text-sm font-medium whitespace-nowrap border transition-colors ${
                  room.id === activeRoom?.id
                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-transparent'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)]'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
          <LegendDot tone="emerald" label={`${stats.arrived} arrivati`} />
          {stats.departing > 0 && <LegendDot tone="cyan" label={`${stats.departing} in uscita`} />}
          <LegendDot tone="indigo" label={`${stats.waiting} in attesa`} />
          <LegendDot tone="slate" label={`${stats.free} liberi`} />
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-hidden flex items-center justify-center"
        style={{
          backgroundImage: 'radial-gradient(var(--floor-dot) 1px, transparent 1px)',
          backgroundSize: '18px 18px',
        }}
      >
        {activeRoom && (
          <div
            className="relative"
            style={{
              width: extent.width * scale,
              height: extent.height * scale,
            }}
          >
            {roomTables.map(t => {
              const res = reservationByTableId.get(t.id);
              const dim = getGlyphDimensions(t.shape, t.seats);
              const glyphW = dim.width * scale;
              const glyphH = dim.height * scale;
              const haloRadius = t.shape === TableShape.CIRCLE ? '9999px' : '20px';

              // Shared, time-aware derivation so the room reads exactly like
              // the floor plan view (In arrivo pulses, In uscita reads cyan).
              const status: TableDisplayStatus = deriveTableDisplayStatus(res, { now });
              let haloClass = '';
              let caption: string | null = null;

              if (res) {
                const firstName = toTitleCase(res.customer_name)?.split(' ')[0] || 'Ospite';
                switch (status) {
                  case 'arrivato':
                    haloClass = 'ring-2 ring-emerald-400/70';
                    caption = `${firstName} · ${res.guests}p`;
                    break;
                  case 'uscita':
                    haloClass = 'ring-2 ring-cyan-400/70';
                    caption = `${TABLE_STATUS_LABEL.uscita} · ${firstName}`;
                    break;
                  case 'noshow':
                    haloClass = 'ring-2 ring-rose-400/70';
                    caption = 'No-show';
                    break;
                  case 'inarrivo':
                  case 'attesa':
                    haloClass = 'ring-2 ring-indigo-400/70';
                    caption = `${formatHHMM(res.reservation_time)} · ${firstName}`;
                    break;
                }
              }

              const disabled = !res;

              return (
                <button
                  key={t.id}
                  onClick={() => res && onPickReservation(res.id)}
                  disabled={disabled}
                  className={`absolute transition-all duration-150 ${
                    disabled ? 'cursor-default' : 'cursor-pointer hover:-translate-y-0.5 hover:z-10'
                  }`}
                  style={{
                    left: t.x * scale,
                    top: t.y * scale,
                    width: glyphW,
                    height: glyphH,
                  }}
                  title={res ? `${t.name} · ${toTitleCase(res.customer_name)}` : `${t.name} · libero`}
                >
                  <div
                    className={`relative ${haloClass}`}
                    style={{ width: glyphW, height: glyphH, borderRadius: haloRadius }}
                  >
                    <div className="absolute inset-0 flex items-center justify-center">
                      <TableGlyph
                        name={t.name}
                        seats={t.seats}
                        shape={t.shape}
                        status={status}
                        party={res ? res.guests : undefined}
                        fit
                      />
                    </div>
                  </div>
                  {caption && (
                    <span className="absolute left-1/2 -translate-x-1/2 -bottom-3 px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap shadow-sm border bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-line)] tabular-nums">
                      {caption}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default ReceptionPage;
