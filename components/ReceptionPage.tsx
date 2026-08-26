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
  Users,
  Clock,
  Phone,
  MapPinOff,
  XCircle,
  Armchair,
  UserPlus,
  ChevronLeft,
  RefreshCw,
  AlertTriangle,
  Star,
  Zap,
  LayoutGrid,
  LogOut,
  StickyNote,
  Plus,
  Check,
  Shuffle,
  X as XIcon
} from 'lucide-react';
import { getReservations, getTables, getRooms, updateReservation, createReservation, swapReservationTables } from '../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';
import { PulseDot, getReservationState, getTimedReservationState, isSeated, deriveTableDisplayStatus, TABLE_STATUS_LABEL } from './reservationState';
import { DietaryChips } from './DietaryChips';
import { stripDietaryNote } from '../utils/dietary';
import { toTitleCase } from '../utils/text';
import { useNow } from '../hooks/useNow';
import {
  ModalShell, FormCard, Field, Stepper, SegmentedControl, SearchField, SectionHeader,
  StatStrip, StatusPill, Callout, EmptyState, dsIconButton, dsButton, dsInput, dsTextarea,
} from './ds';
import type { PillTone } from './ds';
import type { SectionTone } from './ds';

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
  // Folded bands, by key. Nothing is folded to start with: on arrival the host
  // wants the whole service, and it's mid-shift — once "Più tardi" is thirty
  // rows of people who aren't here yet — that folding one away earns its keep.
  const [collapsedBands, setCollapsedBands] = useState<Set<string>>(() => new Set());
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

  // Group by time band.
  //
  // "In ritardo" is its own band rather than the top of "Adesso": a party
  // whose time has passed and who still isn't here is the only row on this
  // page that needs a decision, and buried among the next hour's bookings it
  // reads as just another upcoming one. Sorted most-overdue first — that's the
  // order the host will work through them.
  //
  // Only for today, and only for parties still expected: a booking already
  // seated, departed or marked no-show can't be late.
  const grouped = useMemo(() => {
    const now = isViewingToday ? nowTick : Date.now();
    const inRitardo: Reservation[] = [];
    const adesso: Reservation[] = [];
    const prossima: Reservation[] = [];
    const piuTardi: Reservation[] = [];
    for (const r of filtered) {
      const t = parseReservationTime(r.reservation_time);
      const diffMin = (t.getTime() - now) / 60_000;
      const stillExpected = (r.arrival_status || ArrivalStatus.WAITING) === ArrivalStatus.WAITING
        && r.reservation_status !== ReservationStatus.NO_SHOW;
      if (isViewingToday && diffMin < 0 && stillExpected) inRitardo.push(r);
      else if (diffMin < 60) adesso.push(r);
      else if (diffMin < 180) prossima.push(r);
      else piuTardi.push(r);
    }
    inRitardo.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    return { inRitardo, adesso, prossima, piuTardi };
  }, [filtered, isViewingToday, nowTick]);

  /** Counts beside each filter chip. Derived from the unfiltered day so the
   *  numbers say what's there, not what survived the chip you already picked. */
  const filterCounts = useMemo(() => ({
    all: todayReservations.length,
    waiting: todayReservations.filter(r => (r.arrival_status || ArrivalStatus.WAITING) === ArrivalStatus.WAITING).length,
    arrived: todayReservations.filter(r => isSeated(r)).length,
    noTable: todayReservations.filter(r => !r.table_id).length,
  }), [todayReservations]);

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

  // Tutte le prenotazioni (non partite, escluse la selezionata) per tavolo:
  // un tavolo può ospitare due turni nella stessa serata, e lo scambio deve
  // poter scegliere QUALE prenotazione scambiare, non una a caso. Ordinate per
  // orario così il chooser le mostra in sequenza.
  const reservationsByTableId = useMemo(() => {
    const m = new Map<number, Reservation[]>();
    for (const r of todayReservations) {
      if (!r.table_id) continue;
      if (r.id === selectedReservationId) continue;
      if (r.arrival_status === ArrivalStatus.DEPARTED) continue;
      const list = m.get(r.table_id);
      if (list) list.push(r); else m.set(r.table_id, [r]);
    }
    for (const list of m.values()) {
      list.sort((a, b) => new Date(a.reservation_time).getTime() - new Date(b.reservation_time).getTime());
    }
    return m;
  }, [todayReservations, selectedReservationId]);

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
  const toggleBand = (key: string) => setCollapsedBands(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

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
    // Shaped like the row it stands in for: clock column, name, then the two
    // controls on the right. A skeleton that doesn't match causes a jump.
    <div
      key={key}
      aria-hidden="true"
      className="flex w-full items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] motion-safe:animate-pulse"
    >
      <div className="w-[58px] flex-shrink-0 space-y-1">
        <div className="h-4 w-11 rounded bg-[var(--ds-surface-row)]" />
        <div className="h-2.5 w-14 rounded bg-[var(--ds-surface-row)]" />
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className={`h-4 rounded bg-[var(--ds-surface-row)] ${variant === 'wide' ? 'w-3/5' : 'w-2/5'}`} />
        <div className="h-3 w-24 rounded bg-[var(--ds-surface-row)]" />
      </div>
      <div className="h-11 w-14 flex-shrink-0 rounded-[12px] bg-[var(--ds-surface-row)]" />
      <div className="h-11 w-11 flex-shrink-0 rounded-full bg-[var(--ds-surface-row)] sm:w-28" />
    </div>
  );

  const renderListSkeleton = () => (
    <>
      <div className="mb-3">
        <div className="mb-2 ml-1 h-3 w-32 rounded bg-[var(--ds-border)] motion-safe:animate-pulse" aria-hidden="true" />
        <div className="space-y-2">
          {renderCardSkeleton('sk-1', 'wide')}
          {renderCardSkeleton('sk-2', 'narrow')}
          {renderCardSkeleton('sk-3', 'wide')}
        </div>
      </div>
      <div className="mb-3">
        <div className="mb-2 ml-1 h-3 w-24 rounded bg-[var(--ds-border)] motion-safe:animate-pulse" aria-hidden="true" />
        <div className="space-y-2">
          {renderCardSkeleton('sk-4', 'wide')}
          {renderCardSkeleton('sk-5', 'narrow')}
        </div>
      </div>
    </>
  );

  /** Time band a row belongs to, for the colour of its clock column. */
  type RowBand = 'late' | 'soon' | 'later';

  /**
   * One booking, one line. The host reads down the left edge — time, then who,
   * then where — and acts on the right edge without ever moving their eye back.
   *
   * The check-in button is on the row itself. It used to live only in the
   * arrivals rail and in the detail panel, which meant seating someone from the
   * list cost a tap to select, a glance to confirm the right record opened, and
   * a second tap. At the door that's three seconds too many.
   */
  const renderCard = (r: Reservation, band: RowBand = 'later') => {
    const isSelected = r.id === selectedReservationId;
    const table = r.table_id ? tables.find(t => t.id === r.table_id) : null;
    // A table smaller than the party is the mistake worth catching before the
    // guests are walking to it, so the chip says so rather than just naming it.
    const tooSmall = !!table && typeof table.seats === 'number' && table.seats > 0 && table.seats < (r.guests || 0);
    const seated = isSeated(r);
    const noShow = r.reservation_status === ReservationStatus.NO_SHOW;
    const minsLate = Math.round((nowTick - parseReservationTime(r.reservation_time).getTime()) / 60_000);

    const clock =
      band === 'late' ? 'text-[var(--ds-critical-text)]'
      : band === 'soon' ? 'text-[var(--ds-pending-text)]'
      : 'text-[var(--ds-text-primary)]';

    return (
      <div
        key={r.id}
        onClick={() => setSelectedReservationId(r.id)}
        className={`flex w-full cursor-pointer items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)] transition-shadow ${
          isSelected ? 'ring-2 ring-[var(--ds-text-primary)]' : ''
        }`}
      >
        {/* When */}
        <div className="w-[58px] flex-shrink-0 text-left">
          <div className={`text-[15px] font-semibold tabular-nums ${clock}`}>
            {formatHHMM(r.reservation_time)}
          </div>
          {band !== 'later' && (
            <div className={`text-[11px] font-medium ${clock}`}>
              {band === 'late' ? 'in ritardo' : 'in arrivo'}
            </div>
          )}
        </div>

        {/* Who */}
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
              {toTitleCase(r.customer_name) || 'Senza nome'}
            </span>
            {r.customer_is_vip && (
              <span
                className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]"
                title="Cliente VIP"
                aria-label="Cliente VIP"
              >
                <Star className="h-3 w-3 fill-current" />
              </span>
            )}
            {stripDietaryNote(r.notes) && (
              <span
                className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]"
                title={stripDietaryNote(r.notes)}
                aria-label="Ha una nota"
              >
                <StickyNote className="h-3 w-3" />
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-[13px] text-[var(--ds-text-muted)]">
            <span className="inline-flex items-center gap-1">
              <Users className="h-3.5 w-3.5" aria-hidden />
              {r.guests}{r.children ? `+${r.children}` : ''}
            </span>
            {r.phone && (
              <span className="hidden min-w-0 items-center gap-1 sm:inline-flex">
                <Phone className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                <span className="truncate">{formatPhone(r.phone)}</span>
              </span>
            )}
          </div>
        </div>

        {/* Where */}
        {table ? (
          <div
            className={`flex h-11 min-w-[56px] flex-shrink-0 flex-col items-center justify-center rounded-[12px] px-2.5 ${
              tooSmall
                ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
            }`}
            title={tooSmall
              ? `Tavolo ${table.name}: ${table.seats} posti per ${r.guests} coperti`
              : `Tavolo ${table.name}`}
          >
            <span className="text-[15px] font-semibold leading-none tabular-nums">{table.name}</span>
            {tooSmall && <span className="mt-0.5 text-[10px] leading-none">{table.seats} posti</span>}
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setSelectedReservationId(r.id); setShowTablePicker(true); }}
            className="inline-flex h-11 flex-shrink-0 items-center gap-1 rounded-[12px] border border-dashed border-[var(--ds-pending-solid)] px-3 text-[13px] font-medium text-[var(--ds-pending-text)] transition-colors hover:bg-[var(--ds-pending-tint)]"
            title="Assegna un tavolo"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> tavolo
          </button>
        )}

        {/* Act. Solid green only for the parties already late — everyone else
            gets the quiet tint, so the eye goes to the row that needs it. */}
        {!seated && !noShow && (
          <button
            type="button"
            disabled={busy}
            onClick={(e) => { e.stopPropagation(); handleQuickArrive(r); }}
            aria-label={`Segna ${toTitleCase(r.customer_name) || 'prenotazione'} come arrivato`}
            title={minsLate > 0 ? `Atteso ${minsLate} minuti fa` : 'Segna come arrivato'}
            className={`inline-flex h-11 flex-shrink-0 items-center justify-center gap-1.5 rounded-full text-[14px] font-semibold transition-opacity disabled:opacity-50 sm:px-4 ${
              band === 'late'
                ? 'w-11 bg-[var(--ds-seated-solid)] text-white hover:opacity-90 sm:w-auto'
                : 'w-11 bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] hover:opacity-80 sm:w-auto'
            }`}
          >
            <Check className="h-4 w-4" aria-hidden />
            <span className="hidden sm:inline">Arrivato</span>
          </button>
        )}
        {(seated || noShow) && (
          <StatusPill tone={noShow ? 'critical' : 'positive'} className="h-11 flex-shrink-0 rounded-full px-3">
            {noShow ? 'No-show' : r.arrival_status === ArrivalStatus.DEPARTING ? 'In uscita' : 'Arrivato'}
          </StatusPill>
        )}
      </div>
    );
  };

  const renderGroup = (
    key: string,
    title: string,
    items: Reservation[],
    tone: SectionTone,
    band: RowBand,
    hint?: string,
  ) => {
    if (items.length === 0) return null;
    const covers = items.reduce((s, r) => s + (r.guests || 0), 0);
    const expanded = !collapsedBands.has(key);
    return (
      <div key={key}>
        <SectionHeader
          tone={tone}
          onToggle={() => toggleBand(key)}
          expanded={expanded}
          meta={`${items.length} · ${covers} coperti${hint ? ` · ${hint}` : ''}`}
        >
          {title}
        </SectionHeader>
        {expanded && (
          <div className="space-y-2 pb-3">{items.map(r => renderCard(r, band))}</div>
        )}
      </div>
    );
  };

  const shiftLabel = globalShiftFilter === 'LUNCH' ? 'Pranzo'
    : globalShiftFilter === 'DINNER' ? 'Cena'
    : 'Tutti i turni';
  const dateLabel = globalDate.toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });

  const walkInButton = (
    <button
      type="button"
      onClick={() => setShowWalkIn(true)}
      className={`${dsButton.primary} flex-shrink-0`}
      title="Cliente senza prenotazione"
    >
      <Zap className="h-4 w-4" aria-hidden />
      Registra walk-in
    </button>
  );

  /* The door queue. Parties due now, most overdue first, each one tap from
     seated. On desktop it's a column that's always there — "who's at the
     door" is half of what this page is for, and it shouldn't need scrolling
     to. On a phone it's gone: every row in the list carries the same check-in
     button, and a horizontal scroller spent a third of the screen showing
     three of them. */
  const allaPorta = (
    <section className="flex min-h-0 flex-1 flex-col rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="mb-3 flex flex-shrink-0 items-center gap-2">
        <PulseDot dotClass="bg-[var(--ds-critical-solid)]" pulse={arrivingNow.length > 0} sizeClass="h-2 w-2" />
        <h2 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">Alla porta</h2>
        <span
          className="text-[13px] text-[var(--ds-text-muted)]"
          title="Prenotazioni attese in questo momento: da 20 minuti prima dell'orario in poi"
        >
          {arrivingNow.length === 1 ? '1 atteso ora' : `${arrivingNow.length} attesi ora`}
        </span>
        <button
          type="button"
          onClick={loadAll}
          className="ml-auto inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)]"
          aria-label="Aggiorna"
          title="Aggiorna"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="-mr-2 min-h-0 flex-1 overflow-y-auto pr-2">
        {arrivingNow.length === 0 ? (
          <p className="py-8 text-center text-[14px] text-[var(--ds-text-muted)]">
            Nessuno atteso in questo momento.
          </p>
        ) : (
          <ul className="space-y-1">
            {arrivingNow.map(r => {
              const start = parseReservationTime(r.reservation_time).getTime();
              const late = nowTick > start;
              const table = r.table_id ? tables.find(t => t.id === r.table_id) : null;
              return (
                <li key={r.id}>
                  {/* The row selects; the circle seats. Two targets, because
                      mixing them is how a host checks in the wrong party. */}
                  <div
                    className={`flex items-center gap-3 rounded-[14px] p-3 transition-colors ${
                      late ? 'bg-[var(--ds-critical-tint)]' : 'hover:bg-[var(--ds-surface-row)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedReservationId(r.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                        {toTitleCase(r.customer_name) || 'Senza nome'}
                      </div>
                      <div className={`truncate text-[13px] ${late ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>
                        {formatHHMM(r.reservation_time)} · {r.guests} · {table ? `tav. ${table.name}` : 'senza tavolo'}
                      </div>
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => handleQuickArrive(r)}
                      aria-label={`Segna ${toTitleCase(r.customer_name) || 'prenotazione'} come arrivato`}
                      title="Segna come arrivato"
                      className={`inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-85 disabled:opacity-50 ${
                        late
                          ? 'bg-[var(--ds-seated-solid)] text-white'
                          : 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                      }`}
                    >
                      <Check className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)]">
      {/* The phone has no room for the global date control, so the page names
          the service it's showing. On desktop the top bar already does. */}
      <div className="flex flex-shrink-0 items-center gap-3 px-4 pt-4 lg:hidden">
        {onBack && (
          <button
            onClick={onBack}
            className={dsIconButton}
            aria-label="Indietro"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            Reception
          </h1>
          <p className="truncate text-[13px] capitalize text-[var(--ds-text-muted)]">
            {dateLabel} · {shiftLabel}
          </p>
        </div>
        <button
          type="button"
          onClick={loadAll}
          className={dsIconButton}
          aria-label="Aggiorna"
          title="Aggiorna"
        >
          <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          onClick={() => setShowWalkIn(true)}
          className={`${dsButton.primary} flex-shrink-0 px-4`}
          title="Cliente senza prenotazione"
        >
          <Zap className="h-4 w-4" aria-hidden />
          Walk-in
        </button>
      </div>

      {error && (
        <div className="flex-shrink-0 px-4 pt-3 lg:px-6">
          <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:gap-4 lg:px-6 lg:pb-4 lg:pt-4">
        {/* LEFT — the service, in order */}
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex-shrink-0 space-y-3 px-4 pt-3 lg:px-0 lg:pt-0">
            <StatStrip
              layout="stacked"
              stats={[
                { value: stats.count, label: 'prenotazioni' },
                { value: stats.guests, label: 'coperti' },
                // Tone only once there's something to report: a green "0
                // arrivati" claims a win before service has started.
                { value: stats.arrived, label: 'arrivati', tone: stats.arrived > 0 ? 'positive' : 'neutral' },
                { value: stats.noTable, label: 'senza tavolo', tone: stats.noTable > 0 ? 'pending' : 'neutral' },
              ]}
            />

            <div className="flex items-center gap-2">
              <SearchField
                value={search}
                onChange={setSearch}
                placeholder="Cerca nome o telefono"
                ariaLabel="Cerca prenotazioni"
                className="min-w-0 flex-1"
              />
              {/* Lista / Mappa switches the canvas, not the filter, so it sits
                  apart from the status chips rather than beside them. */}
              <div className="hidden flex-shrink-0 sm:block">
                <SegmentedControl
                  value={viewMode}
                  onChange={(next) => setViewMode(next)}
                  ariaLabel="Vista"
                  equalWidth={false}
                  options={[
                    { value: 'list' as const, label: 'Lista' },
                    { value: 'map' as const, label: 'Mappa' },
                  ]}
                />
              </div>
              <button
                type="button"
                onClick={() => setViewMode(viewMode === 'map' ? 'list' : 'map')}
                className={`${dsIconButton} sm:hidden`}
                aria-label="Mappa sala"
                title="Mappa sala"
              >
                <LayoutGrid className="h-4 w-4" />
              </button>
            </div>

            <SegmentedControl
              value={statusFilter}
              onChange={(next) => setStatusFilter(next)}
              ariaLabel="Filtra prenotazioni"
              overflow="scroll"
              options={[
                { value: 'all' as const, label: 'Tutte', badge: filterCounts.all, badgeTone: 'neutral' },
                { value: 'waiting' as const, label: 'In attesa', badge: filterCounts.waiting, badgeTone: 'neutral' },
                { value: 'arrived' as const, label: 'Arrivati', badge: filterCounts.arrived, badgeTone: 'neutral' },
                { value: 'noTable' as const, label: 'Senza tavolo', badge: filterCounts.noTable, badgeTone: 'neutral' },
              ]}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 pt-3 lg:-mx-3 lg:px-3">
            {isInitialLoading && reservations.length === 0 ? (
              renderListSkeleton()
            ) : filtered.length === 0 ? (
              <EmptyState icon={UserPlus}>
                Nessuna prenotazione corrisponde ai filtri.
              </EmptyState>
            ) : (
              <>
                {renderGroup('inRitardo', 'In ritardo', grouped.inRitardo, 'attention', 'late', 'attesi e non ancora arrivati')}
                {renderGroup('adesso', 'Adesso · prossima ora', grouped.adesso, 'pending', 'soon')}
                {renderGroup('prossima', 'Tra 1–3 ore', grouped.prossima, 'info', 'later')}
                {renderGroup('piuTardi', 'Più tardi', grouped.piuTardi, 'muted', 'later')}
              </>
            )}
          </div>
        </div>

        {/* RIGHT — the one button this page exists to offer, over the detail
            of what's selected, over the door queue. */}
        <aside className="hidden w-[340px] flex-shrink-0 flex-col gap-4 lg:flex xl:w-[380px]">
          {walkInButton}
          {selectedReservation && (
            <DetailPanel
              reservation={selectedReservation}
              table={selectedTable}
              busy={busy}
              onClose={() => setSelectedReservationId(null)}
              onAssignTable={() => setShowTablePicker(true)}
              onRemoveTable={handleRemoveTable}
              onMarkArrived={handleMarkArrived}
              onMarkWaiting={handleMarkWaiting}
              onMarkNoShow={handleMarkNoShow}
              onMarkDeparting={handleMarkDeparting}
              onFreeTable={handleFreeTable}
            />
          )}
          {allaPorta}
        </aside>
      </div>

      {/* Mobile detail drawer — full-screen over the list; a back chevron
          returns to the list. Sits above the bottom nav (z-30). */}
      {selectedReservation && (
        <div
          className="animate-view-in fixed inset-0 z-40 flex flex-col bg-[var(--ds-canvas)] lg:hidden"
          role="dialog"
          aria-modal="true"
          style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        >
          {/* A card, not a flush bar — the header is built from the same block
              as everything under it. Its bottom padding is load-bearing: the
              scrolling region below is opaque and would otherwise slice the
              shadow off with a hard line. */}
          <div className="flex flex-shrink-0 items-center gap-3 px-4 pb-4 pt-4">
            <div className="flex flex-1 items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
              <button
                onClick={() => setSelectedReservationId(null)}
                className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)]"
                aria-label="Torna alla lista"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
                Dettaglio
              </span>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
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
          reservationsByTableId={reservationsByTableId}
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
          reservationsByTableId={reservationsByTableId}
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
  const [guests, setGuests] = useState<number | undefined>(2);
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  const canSubmit = name.trim().length > 0 && !!guests && guests > 0;

  return (
    <ModalShell
      open
      onClose={() => { if (!busy) onCancel(); }}
      title="Walk-in"
      size="sm"
      bodyClassName="p-4 sm:p-6"
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={dsButton.quiet}>
            Annulla
          </button>
          <button
            type="button"
            onClick={() => onSubmit({ name, guests: guests ?? 1, phone, notes })}
            disabled={busy || !canSubmit}
            className={dsButton.primary}
          >
            Crea e assegna tavolo
          </button>
        </>
      }
    >
      <FormCard>
        <div className="space-y-5">
          <Field label="Nome cliente" htmlFor="walkin-name" required>
            <input
              id="walkin-name"
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Es. Mario Rossi"
              className={dsInput}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Coperti" required>
              <Stepper value={guests} onChange={setGuests} min={1} ariaLabel="Coperti" required />
            </Field>
            <Field label="Telefono" htmlFor="walkin-phone">
              <input
                id="walkin-phone"
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Opzionale"
                className={dsInput}
              />
            </Field>
          </div>

          <Field label="Note" htmlFor="walkin-notes">
            <textarea
              id="walkin-notes"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Allergie, preferenze, …"
              rows={2}
              className={`${dsTextarea} resize-none`}
            />
          </Field>
        </div>
      </FormCard>
    </ModalShell>
  );
};

interface DetailPanelProps {
  reservation: Reservation;
  table: Table | null;
  busy: boolean;
  /** Desktop only — dismisses the card and leaves the door queue in place. */
  onClose?: () => void;
  onAssignTable: () => void;
  onRemoveTable: () => void;
  onMarkArrived: () => void;
  onMarkWaiting: () => void;
  onMarkNoShow: () => void;
  onMarkDeparting: () => void;
  onFreeTable: () => void;
}

/**
 * What to do with the booking you just picked.
 *
 * One primary action, sized so it can be hit without looking, and the rest as
 * quiet secondaries below it. The old panel gave seven buttons the same weight
 * and the same 80px height, so the one you needed — seat them — had to be
 * hunted for among six you didn't.
 */
const DetailPanel: React.FC<DetailPanelProps> = ({
  reservation,
  table,
  busy,
  onClose,
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
  const tooSmall = !!table && typeof table.seats === 'number' && table.seats > 0
    && table.seats < (reservation.guests || 0);
  const notes = stripDietaryNote(reservation.notes);

  return (
    <section className="flex-shrink-0 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
              {toTitleCase(reservation.customer_name) || 'Senza nome'}
            </h2>
            {reservation.customer_is_vip && (
              <StatusPill tone="pending" title="Cliente VIP">
                <Star className="h-3 w-3 fill-current" aria-hidden /> VIP
              </StatusPill>
            )}
          </div>
          <p className="mt-0.5 truncate text-[14px] text-[var(--ds-text-muted)]">
            {formatHHMM(reservation.reservation_time)} · {reservation.guests}
            {reservation.children ? ` +${reservation.children} bimbi` : ''} coperti
            {reservation.phone ? ` · ${formatPhone(reservation.phone)}` : ''}
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi dettaglio"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)]"
          >
            <XIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Where they're sitting — the one fact the host is holding in their head
          while they walk the party across the room. */}
      {table ? (
        <div
          className={`mt-4 flex items-center gap-3 rounded-[16px] px-4 py-3 ${
            tooSmall
              ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
              : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
          }`}
        >
          <span className="text-[28px] font-semibold leading-none tabular-nums">{table.name}</span>
          <div className="min-w-0 text-[13px] leading-tight">
            <div className="font-medium">Tavolo</div>
            <div>{table.seats} posti{tooSmall ? ` · meno dei ${reservation.guests} coperti` : ''}</div>
          </div>
        </div>
      ) : (
        <Callout tone="pending" className="mt-4">Nessun tavolo assegnato</Callout>
      )}

      {/* The action you came here for. */}
      <div className="mt-4 space-y-2">
        {seated ? (
          <button
            type="button"
            disabled={busy}
            onClick={onFreeTable}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-seated-solid)] text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Armchair className="h-5 w-5" aria-hidden />
            Tavolo liberato
          </button>
        ) : (
          <button
            type="button"
            disabled={busy || noShow}
            onClick={onMarkArrived}
            className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-full bg-[var(--ds-seated-solid)] text-[16px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            <Check className="h-5 w-5" aria-hidden />
            Arrivato
          </button>
        )}

        {/* Everything else, equal and quiet. Only the ones that apply to the
            current state are rendered — the same rule as before. */}
        <div className="grid grid-cols-3 gap-2">
          <SecondaryAction
            disabled={busy}
            onClick={onAssignTable}
            icon={<Shuffle className="h-4 w-4" />}
            label={table ? 'Cambia' : 'Assegna'}
          />
          {table && (
            <SecondaryAction
              disabled={busy}
              onClick={onRemoveTable}
              icon={<MapPinOff className="h-4 w-4" />}
              label="Rimuovi"
            />
          )}
          {arr === ArrivalStatus.WAITING && !noShow && (
            <SecondaryAction
              disabled={busy}
              onClick={onMarkNoShow}
              icon={<XCircle className="h-4 w-4" />}
              label="No-show"
              tone="critical"
            />
          )}
          {arr === ArrivalStatus.ARRIVED && (
            <SecondaryAction
              disabled={busy}
              onClick={onMarkDeparting}
              icon={<LogOut className="h-4 w-4" />}
              label="In uscita"
            />
          )}
          {arr === ArrivalStatus.DEPARTING && (
            <SecondaryAction
              disabled={busy}
              onClick={onMarkArrived}
              icon={<Check className="h-4 w-4" />}
              label="Ancora a tavola"
            />
          )}
          {arr === ArrivalStatus.ARRIVED && (
            <SecondaryAction
              disabled={busy}
              onClick={onMarkWaiting}
              icon={<Clock className="h-4 w-4" />}
              label="In attesa"
            />
          )}
          {noShow && (
            <SecondaryAction
              disabled={busy}
              onClick={onMarkArrived}
              icon={<Check className="h-4 w-4" />}
              label="Annulla no-show"
            />
          )}
        </div>
      </div>

      {/* Anything the kitchen or the host needs to know before seating them. */}
      {(notes || reservation.customer_dietary_notes || reservation.customer_preferences_notes
        || reservation.notes) && (
        <div className="mt-4 space-y-2 border-t border-[var(--ds-border)] pt-4">
          <DietaryChips notes={reservation.notes} />
          {notes && <NotesLine label="Note prenotazione" text={notes} />}
          {reservation.customer_dietary_notes && (
            <NotesLine label="Dieta / allergie" text={reservation.customer_dietary_notes} tone="pending" />
          )}
          {reservation.customer_preferences_notes && (
            <NotesLine label="Preferenze cliente" text={reservation.customer_preferences_notes} />
          )}
        </div>
      )}

      {/* On a phone the panel is the whole screen, so the number is worth a
          real tap target rather than a line of grey text up in the header. */}
      {reservation.phone && (
        <a
          href={`tel:${reservation.phone}`}
          className="mt-3 flex items-center gap-3 rounded-[16px] bg-[var(--ds-surface-row)] p-3 lg:hidden"
        >
          <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]">
            <Phone className="h-4 w-4" />
          </span>
          <span className="min-w-0">
            <span className="block text-[12px] text-[var(--ds-text-muted)]">Telefono</span>
            <span className="block truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
              {formatPhone(reservation.phone)}
            </span>
          </span>
        </a>
      )}
    </section>
  );
};

const NotesLine: React.FC<{ label: string; text: string; tone?: 'pending' }> = ({ label, text, tone }) => (
  <div className={`rounded-[12px] px-3 py-2 text-[13px] ${
    tone === 'pending'
      ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
  }`}>
    <span className="mr-2 font-semibold">{label}</span>
    {text}
  </div>
);

const SecondaryAction: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  icon: React.ReactNode;
  label: string;
  tone?: 'neutral' | 'critical';
}> = ({ onClick, disabled, icon, label, tone = 'neutral' }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    className={`inline-flex min-h-[56px] flex-col items-center justify-center gap-1 rounded-[14px] px-2 py-2 text-[12px] font-medium transition-opacity hover:opacity-80 disabled:opacity-50 ${
      tone === 'critical'
        ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
    }`}
  >
    {icon}
    <span className="w-full truncate text-center">{label}</span>
  </button>
);

interface TablePickerProps {
  reservation: Reservation;
  tables: Table[];
  rooms: Room[];
  activeRoomId: number | null;
  setActiveRoomId: (id: number) => void;
  occupiedTableIds: Set<number>;
  reservationByTableId: Map<number, Reservation>;
  reservationsByTableId: Map<number, Reservation[]>;
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
  reservationsByTableId,
  onCancel,
  onSelect,
  onSwap,
  busy
}) => {
  // Tapping an occupied tile arms a swap confirmation — the host pairs the
  // current reservation with the booking sitting at that tile.
  const [swapCandidate, setSwapCandidate] = useState<Reservation | null>(null);
  // Quando il tavolo toccato ha più prenotazioni, prima si sceglie QUALE
  // scambiare: qui stanno i candidati da mostrare nel chooser.
  const [swapChoices, setSwapChoices] = useState<Reservation[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 800, height: 600 });

  // On phones the floor plan scales down until the glyphs collapse into each
  // other, so the picker switches to a list — same states, same actions.
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setIsPhone(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setContainerSize({ width: e.contentRect.width, height: e.contentRect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [isPhone]);

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

  // Everything the two renderers need to know about a table, in one place, so
  // the map and the phone list can't disagree on what's tappable.
  const decorate = (t: Table) => {
    const state = bucketize(t);
    // Swap is offered only when *we* already have a table to give away.
    // Without it the swap would be a one-way reassignment, which the
    // server (correctly) refuses.
    const occupantRes = state === 'occupied' ? reservationByTableId.get(t.id) : null;
    // Tutti i candidati allo scambio sul tavolo (un tavolo può avere due turni).
    const swapTargets = state === 'occupied'
      ? (reservationsByTableId.get(t.id) ?? []).filter(o => o.id !== reservation.id)
      : [];
    const swappable = state === 'occupied' && !!reservation.table_id && swapTargets.length > 0;
    const disabled = state === 'tooSmall' || (state === 'occupied' && !swappable);
    const onTap = () => {
      if (disabled) return;
      if (swappable) {
        // Una sola prenotazione → conferma diretta; più d'una → prima si sceglie.
        if (swapTargets.length === 1) setSwapCandidate(swapTargets[0]);
        else setSwapChoices(swapTargets);
      } else {
        onSelect(t.id);
      }
    };
    return { state, occupantRes, swappable, disabled, onTap };
  };

  // List order: best options first, dead options last. Within a group the
  // smallest table wins — least wasted seats for this party.
  const STATE_RANK: Record<TableState, number> = { current: 0, ideal: 1, big: 2, occupied: 3, tooSmall: 4 };
  const listTables = useMemo(() => {
    if (!isPhone) return [];
    return [...roomTables].sort((a, b) => {
      const ra = STATE_RANK[bucketize(a)];
      const rb = STATE_RANK[bucketize(b)];
      if (ra !== rb) return ra - rb;
      if (a.seats !== b.seats) return a.seats - b.seats;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPhone, roomTables, occupiedTableIds, reservation.table_id, reservation.guests]);

  const LIST_PILL: Record<TableState, { text: string; tone: PillTone }> = {
    current: { text: 'Attuale', tone: 'info' },
    ideal: { text: 'Adatto', tone: 'positive' },
    big: { text: 'Grande', tone: 'neutral' },
    occupied: { text: 'Occupato', tone: 'critical' },
    tooSmall: { text: 'Piccolo', tone: 'neutral' },
  };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--ds-canvas)]">
      {/* Header — who this table is for, and how many of them. The party size
          sits where the host's eye lands, because that's what they're matching
          against every glyph below. */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-[var(--ds-text-muted)]">Tavolo per</p>
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
              {toTitleCase(reservation.customer_name) || 'Senza nome'}
            </h2>
          </div>
          <StatusPill tone="neutral" className="h-8 px-3 text-[13px]">
            <Users className="h-3.5 w-3.5" aria-hidden />
            {reservation.guests} coperti
          </StatusPill>
          <button
            onClick={onCancel}
            disabled={busy}
            aria-label="Chiudi"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)] disabled:opacity-50"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Room tabs and the scan summary share a row — vertical space here is
          the floor plan's, not the chrome's. */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 px-4 pb-3 sm:px-6">
        {visibleRooms.length > 1 ? (
          <div className="flex min-w-0 gap-1 overflow-x-auto scrollbar-hide rounded-full bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
            {visibleRooms.map(room => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                aria-pressed={room.id === activeRoom?.id}
                className={`inline-flex h-9 flex-shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[14px] font-medium transition-colors ${
                  room.id === activeRoom?.id
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--ds-text-muted)]">
          <LegendDot tone="seated" label={`${counts.ideal} adatti`} />
          <LegendDot tone="neutral" label={`${counts.big} grandi`} />
          <LegendDot tone="critical" label={`${counts.occupied} occupati`} />
          {reservation.table_id && (
            <LegendDot tone="pending" label="tocca occupato → scambia" />
          )}
        </div>
      </div>

      {/* Phone: the same picker as a list. One row per table, best fits on
          top, with the occupant's name on occupied rows so a swap is an
          informed choice, not a guess. */}
      {isPhone ? (
        <div className="mx-4 mb-4 min-h-0 flex-1 overflow-y-auto rounded-[24px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)]">
          <div className="flex flex-col gap-1">
            {listTables.map(t => {
              const { state, occupantRes, disabled, onTap } = decorate(t);
              const pill = state === 'occupied' && !disabled
                ? { text: 'Scambia', tone: 'pending' as PillTone }
                : LIST_PILL[state];
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={onTap}
                  disabled={busy || disabled}
                  className={`flex w-full items-center gap-3 rounded-[16px] p-3 text-left transition-colors ${
                    disabled
                      ? 'cursor-not-allowed opacity-45'
                      : 'hover:bg-[var(--ds-surface-row)] active:bg-[var(--ds-surface-row)]'
                  } ${state === 'current' ? 'ring-2 ring-inset ring-[var(--ds-arriving-solid)]' : ''}`}
                >
                  <div className={`w-14 flex-shrink-0 ${state === 'tooSmall' ? 'grayscale' : ''}`}>
                    <TableGlyph name={t.name} seats={t.seats} shape={t.shape} status="libera" fit />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[15px] font-medium text-[var(--ds-text-primary)]">Tavolo {t.name}</p>
                    <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
                      {t.seats} posti
                      {t.max_seats && t.max_seats !== t.seats ? ` · max ${t.max_seats}` : ''}
                      {occupantRes ? ` · ${toTitleCase(occupantRes.customer_name)}` : ''}
                    </p>
                  </div>
                  <StatusPill tone={pill.tone}>{pill.text}</StatusPill>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
      /* Canvas. Floor-dot background so the room reads as space, not a card. */
      <div
        ref={containerRef}
        className="mx-4 mb-4 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] sm:mx-6"
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
              const { state, swappable, disabled, onTap } = decorate(t);
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
              let badge: { text: string; tone: PillTone } | null = null;

              if (state === 'current') {
                haloClass = 'ring-2 ring-[var(--ds-arriving-solid)]';
                badge = { text: 'Attuale', tone: 'info' };
              } else if (state === 'occupied') {
                if (swappable) {
                  haloClass = 'ring-2 ring-[var(--ds-pending-solid)] hover:ring-[3px]';
                  glyphOpacity = 'opacity-80';
                  badge = { text: 'Scambia', tone: 'pending' };
                } else {
                  haloClass = 'ring-1 ring-[var(--ds-critical-solid)]';
                  glyphOpacity = 'opacity-50';
                  badge = { text: 'Occupato', tone: 'critical' };
                }
              } else if (state === 'tooSmall') {
                haloClass = '';
                glyphOpacity = 'opacity-40';
                grayscale = 'grayscale';
                badge = { text: `${t.seats} posti`, tone: 'neutral' };
              } else if (state === 'ideal') {
                haloClass = 'ring-2 ring-[var(--ds-seated-solid)] hover:ring-[3px]';
              } else if (state === 'big') {
                haloClass = 'ring-1 ring-[var(--ds-border-strong)] hover:ring-2';
              }

              return (
                <button
                  key={t.id}
                  onClick={onTap}
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
                    <span className="absolute -bottom-3 left-1/2 -translate-x-1/2">
                      <StatusPill tone={badge.tone} className="h-5 px-2 text-[10px] font-semibold shadow-[var(--ds-shadow-card)]">
                        {badge.text}
                      </StatusPill>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
      )}

      {/* Chooser — quando il tavolo ha più prenotazioni, si sceglie con quale
          scambiare prima della conferma. */}
      {swapChoices && (
        <ModalShell
          open
          onClose={() => { if (!busy) setSwapChoices(null); }}
          title="Quale prenotazione scambiare?"
          subtitle="Questo tavolo ha più prenotazioni: scegli quella con cui invertire"
          size="sm"
          className="z-[60]"
          bodyClassName="p-4 sm:p-6"
          footer={
            <button type="button" onClick={() => setSwapChoices(null)} disabled={busy} className={dsButton.quiet}>
              Annulla
            </button>
          }
        >
          <div className="flex flex-col gap-2">
            {swapChoices.map(choice => (
              <button
                key={choice.id}
                type="button"
                disabled={busy}
                onClick={() => { setSwapChoices(null); setSwapCandidate(choice); }}
                className="flex w-full items-center justify-between gap-3 rounded-[16px] bg-[var(--ds-surface)] p-3 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
              >
                <span className="min-w-0 truncate font-medium text-[var(--ds-text-primary)]">
                  {toTitleCase(choice.customer_name) || 'Senza nome'}
                </span>
                <span className="flex-shrink-0 text-[13px] text-[var(--ds-text-muted)]">
                  {formatHHMM(choice.reservation_time)} · {choice.guests} ospiti
                </span>
              </button>
            ))}
          </div>
        </ModalShell>
      )}

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
    // z-[60] on purpose: this sits over the table picker, which is already at
    // z-50 — the host has to be able to check both parties before an exchange
    // that moves two bookings at once.
    <ModalShell
      open
      onClose={() => { if (!busy) onCancel(); }}
      title="Inverti i due tavoli?"
      subtitle="Le due prenotazioni si scambiano il posto"
      size="sm"
      className="z-[60]"
      bodyClassName="p-4 sm:p-6"
      footer={
        <>
          <button type="button" onClick={onCancel} disabled={busy} className={dsButton.quiet}>
            Annulla
          </button>
          <button type="button" onClick={onConfirm} disabled={busy} className={dsButton.primary}>
            <RefreshCw className="h-4 w-4" aria-hidden />
            Inverti tavoli
          </button>
        </>
      }
    >
      <div className="space-y-2 rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
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
    </ModalShell>
  );
};

const SwapRow: React.FC<{ name: string; from: string; to: string }> = ({ name, from, to }) => (
  <div className="flex items-center gap-2 text-[14px]">
    <div className="min-w-0 flex-1 truncate font-medium text-[var(--ds-text-primary)]">{name}</div>
    <StatusPill tone="neutral" className="text-[12px] tabular-nums">{from}</StatusPill>
    <span className="text-[var(--ds-text-muted)]" aria-label="diventa">→</span>
    <StatusPill tone="positive" className="text-[12px] tabular-nums">{to}</StatusPill>
  </div>
);

/** A dot plus a count. The tone names a family, not a colour, so the legend
 *  can't drift from the halos and glyphs it's explaining. */
const LegendDot: React.FC<{ tone: 'seated' | 'arriving' | 'pending' | 'critical' | 'neutral'; label: string }> = ({ tone, label }) => {
  const dot =
    tone === 'seated'   ? 'bg-[var(--ds-seated-solid)]'
    : tone === 'critical' ? 'bg-[var(--ds-critical-solid)]'
    : tone === 'arriving' ? 'bg-[var(--ds-arriving-solid)]'
    : tone === 'pending'  ? 'bg-[var(--ds-pending-solid)]'
                          : 'bg-[var(--ds-border-strong)]';
  return (
    <span className="inline-flex items-center gap-1.5 tabular-nums">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
};

interface RoomMapProps {
  tables: Table[];
  rooms: Room[];
  reservationByTableId: Map<number, Reservation>;
  reservationsByTableId: Map<number, Reservation[]>;
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
  reservationsByTableId,
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
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--ds-canvas)]">
      {/* Header — the same shell as the TablePicker, so the two full-screen
          floor views read as one pair rather than two separate features. */}
      <div className="flex flex-shrink-0 items-center justify-between gap-4 px-4 pb-3 pt-4 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-[var(--ds-text-muted)]">Stato sala</p>
            <h2 className="truncate text-[18px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
              {activeRoom?.name || 'Sala'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Chiudi"
            className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:text-[var(--ds-text-primary)]"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Room tabs and the live tally on one row */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3 px-4 pb-3 sm:px-6">
        {visibleRooms.length > 1 ? (
          <div className="flex min-w-0 gap-1 overflow-x-auto scrollbar-hide rounded-full bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
            {visibleRooms.map(room => (
              <button
                key={room.id}
                onClick={() => setActiveRoomId(room.id)}
                aria-pressed={room.id === activeRoom?.id}
                className={`inline-flex h-9 flex-shrink-0 items-center whitespace-nowrap rounded-full px-3.5 text-[14px] font-medium transition-colors ${
                  room.id === activeRoom?.id
                    ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                    : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {room.name}
              </button>
            ))}
          </div>
        ) : <div />}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-[var(--ds-text-muted)]">
          <LegendDot tone="seated" label={`${stats.arrived} arrivati`} />
          {stats.departing > 0 && <LegendDot tone="pending" label={`${stats.departing} in uscita`} />}
          <LegendDot tone="arriving" label={`${stats.waiting} in attesa`} />
          <LegendDot tone="neutral" label={`${stats.free} liberi`} />
        </div>
      </div>

      <div
        ref={containerRef}
        className="mx-4 mb-4 flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] sm:mx-6"
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

              // Un tavolo può avere due turni nella stessa serata: la mappa
              // mostrava solo la prenotazione prioritaria. Contiamo le altre per
              // segnalarle con un badge "+N" e listarle nel tooltip.
              const otherAtTable = (reservationsByTableId.get(t.id) ?? []).filter(o => o.id !== res?.id);
              const extraCount = otherAtTable.length;

              if (res) {
                const firstName = toTitleCase(res.customer_name)?.split(' ')[0] || 'Ospite';
                switch (status) {
                  case 'arrivato':
                    haloClass = 'ring-2 ring-[var(--ds-seated-solid)]';
                    caption = `${firstName} · ${res.guests}p`;
                    break;
                  case 'uscita':
                    // Still a seated party, so still the seated family — the
                    // caption carries the difference, not a fifth colour.
                    haloClass = 'ring-2 ring-[var(--ds-seated-text)]';
                    caption = `${TABLE_STATUS_LABEL.uscita} · ${firstName}`;
                    break;
                  case 'noshow':
                    haloClass = 'ring-2 ring-[var(--ds-critical-solid)]';
                    caption = 'No-show';
                    break;
                  case 'inarrivo':
                  case 'attesa':
                    haloClass = 'ring-2 ring-[var(--ds-arriving-solid)]';
                    caption = `${formatHHMM(res.reservation_time)} · ${firstName}`;
                    break;
                }
                // Segnala i turni successivi sullo stesso tavolo.
                if (caption && extraCount > 0) caption = `${caption} +${extraCount}`;
              }

              // Tooltip: tutte le prenotazioni del tavolo, in ordine di orario.
              const titleText = res
                ? `${t.name} · ${[res, ...otherAtTable]
                    .sort((x, y) => new Date(x.reservation_time).getTime() - new Date(y.reservation_time).getTime())
                    .map(x => `${formatHHMM(x.reservation_time)} ${toTitleCase(x.customer_name) || 'Senza nome'} (${x.guests}p)`)
                    .join(' · ')}`
                : `${t.name} · libero`;

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
                  title={titleText}
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
                    {extraCount > 0 && (
                      <span
                        className="absolute -right-1.5 -top-1.5 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-[var(--ds-arriving-solid)] px-1 text-[10px] font-bold text-white shadow-[var(--ds-shadow-card)]"
                        aria-label={`${extraCount + 1} prenotazioni su questo tavolo`}
                      >
                        +{extraCount}
                      </span>
                    )}
                  </div>
                  {caption && (
                    <span className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--ds-surface)] px-2 py-0.5 text-[10px] font-semibold tabular-nums text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]">
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
