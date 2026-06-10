import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Reservation,
  Table,
  Room,
  ArrivalStatus,
  ReservationStatus,
  ReservationSource,
  PaymentStatus,
  TableStatus,
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
  X as XIcon
} from 'lucide-react';
import { getReservations, getTables, getRooms, updateReservation, createReservation } from '../services/apiService';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';

// Local-date helper (avoid UTC drift)
const formatLocalDate = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseReservationTime = (iso: string): Date => {
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  }
  return new Date(iso);
};

const formatHHMM = (iso: string): string => {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '—';
};

const formatPhone = (phone?: string): string => {
  if (!phone) return '';
  return phone.replace(/^\+39/, '').trim();
};

const tableStatusForGlyph = (
  res: Reservation | undefined,
  table: Table
): TableDisplayStatus => {
  if (!res) return 'libera';
  const arr = res.arrival_status || ArrivalStatus.WAITING;
  if (arr === ArrivalStatus.ARRIVED) return 'arrivato';
  if (res.reservation_status === ReservationStatus.NO_SHOW) return 'noshow';
  return 'attesa';
};

interface ReceptionPageProps {
  globalDate: Date;
  globalShiftFilter: 'ALL' | 'LUNCH' | 'DINNER';
  onBack?: () => void;
}

const ReceptionPage: React.FC<ReceptionPageProps> = ({ globalDate, globalShiftFilter, onBack }) => {
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
  const [showWalkIn, setShowWalkIn] = useState(false);
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
    }
  }, [activeRoomId]);

  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bookings for the date+shift chosen in the global top-bar control.
  // 'ALL' shows both shifts; any other value filters to that shift.
  const todayReservations = useMemo(() => {
    const dateStr = formatLocalDate(globalDate);
    return reservations
      .filter(r => r.reservation_time?.startsWith(dateStr))
      .filter(r => r.reservation_status !== ReservationStatus.CANCELLED)
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
      list = list.filter(r => r.arrival_status === ArrivalStatus.ARRIVED);
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

  // Header stats
  const stats = useMemo(() => ({
    count: todayReservations.length,
    guests: todayReservations.reduce((s, r) => s + (r.guests || 0), 0),
    arrived: todayReservations.filter(r => r.arrival_status === ArrivalStatus.ARRIVED).length,
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
  const renderCard = (r: Reservation) => {
    const isSelected = r.id === selectedReservationId;
    const arr = r.arrival_status || ArrivalStatus.WAITING;
    const noShow = r.reservation_status === ReservationStatus.NO_SHOW;
    const table = r.table_id ? tables.find(t => t.id === r.table_id) : null;

    const badgeColor =
      noShow ? 'bg-rose-100 text-rose-700 border-rose-300 dark:bg-rose-500/20 dark:text-rose-300 dark:border-rose-500/40'
      : arr === ArrivalStatus.ARRIVED ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300 dark:border-emerald-500/40'
      : arr === ArrivalStatus.DEPARTED ? 'bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-500/20 dark:text-slate-300 dark:border-slate-500/40'
      : 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-500/20 dark:text-amber-300 dark:border-amber-500/40';

    const badgeLabel =
      noShow ? 'No-show'
      : arr === ArrivalStatus.ARRIVED ? 'Arrivato'
      : arr === ArrivalStatus.DEPARTED ? 'Liberato'
      : 'In attesa';

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
          <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full border ${badgeColor}`}>
            {badgeLabel}
          </span>
        </div>
        <div className="text-base font-medium text-[var(--color-fg)] truncate mb-0.5">
          {r.customer_name || 'Senza nome'}
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
      {/* Top header bar (stays on top, sits above the split) */}
      <div className="flex-shrink-0 border-b border-[var(--color-line)] bg-[var(--color-surface-2)] px-4 py-3 flex items-center gap-3">
        {onBack && (
          <button
            onClick={onBack}
            className="p-2 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]"
            aria-label="Indietro"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Reception</h1>
        <div className="flex-1 flex items-center justify-center gap-6 text-sm">
          <div className="text-center">
            <div className="text-2xl font-bold text-[var(--color-fg)] tabular-nums">{stats.count}</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">Prenotazioni</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-[var(--color-fg)] tabular-nums">{stats.guests}</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">Coperti</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-emerald-600 dark:text-emerald-400 tabular-nums">{stats.arrived}</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">Arrivati</div>
          </div>
          <div className="text-center">
            <div className={`text-2xl font-bold tabular-nums ${stats.noTable > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--color-fg)]'}`}>
              {stats.noTable}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--color-fg-muted)]">Senza tavolo</div>
          </div>
        </div>
        <button
          onClick={() => setShowWalkIn(true)}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold text-sm shadow-sm"
          title="Cliente senza prenotazione"
        >
          <Zap className="h-4 w-4" />
          Walk-in
        </button>
        <button
          onClick={loadAll}
          className="p-2 rounded-xl hover:bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]"
          aria-label="Aggiorna"
          title="Aggiorna"
        >
          <RefreshCw className={`h-5 w-5 ${busy ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error && (
        <div className="flex-shrink-0 bg-rose-50 border-b border-rose-200 text-rose-700 dark:bg-rose-500/10 dark:border-rose-500/30 dark:text-rose-300 px-4 py-2 text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Split 40/60 */}
      <div className="flex-1 flex min-h-0">
        {/* LEFT 40% — search + list */}
        <div className="w-2/5 min-w-[320px] flex flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]">
          <div className="flex-shrink-0 px-3 pt-3 pb-2 space-y-2 border-b border-[var(--color-line)]">
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
                ['waiting', 'In attesa'],
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
            {filtered.length === 0 ? (
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

        {/* RIGHT 60% — detail */}
        <div className="flex-1 flex flex-col bg-[var(--color-surface)] min-w-0">
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
              onFreeTable={handleFreeTable}
            />
          )}
        </div>
      </div>

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
          onCancel={() => setShowTablePicker(false)}
          onSelect={handleAssignTable}
          busy={busy}
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
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--color-line)]">
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-amber-500" />
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
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)] mb-1.5">
              Nome cliente <span className="text-rose-500">*</span>
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Es. Mario Rossi"
              className="w-full px-3 py-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-amber-500/40"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)] mb-1.5">
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
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)] mb-1.5">
                Telefono
              </label>
              <input
                type="tel"
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="Opzionale"
                className="w-full h-11 px-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-amber-500/40"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-muted)] mb-1.5">
              Note
            </label>
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Allergie, preferenze, …"
              rows={2}
              className="w-full px-3 py-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-2)] text-[var(--color-fg)] text-base focus:outline-none focus:ring-2 focus:ring-amber-500/40 resize-none"
            />
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-5 py-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] font-medium hover:bg-[var(--color-surface-3)] disabled:opacity-50"
          >
            Annulla
          </button>
          <button
            onClick={() => onSubmit({ name, guests, phone, notes })}
            disabled={busy || !canSubmit}
            className="px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
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
  onFreeTable
}) => {
  const arr = reservation.arrival_status || ArrivalStatus.WAITING;
  const noShow = reservation.reservation_status === ReservationStatus.NO_SHOW;

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Big info header */}
      <div className="flex-shrink-0 px-8 pt-8 pb-6 border-b border-[var(--color-line)]">
        <div className="flex items-start justify-between gap-6 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <h2 className="text-3xl font-bold text-[var(--color-fg)] truncate">
                {reservation.customer_name || 'Senza nome'}
              </h2>
              {reservation.customer_is_vip && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 text-xs font-semibold">
                  <Star className="h-3.5 w-3.5 fill-current" /> VIP
                </span>
              )}
            </div>
            <div className="flex items-center gap-6 text-base text-[var(--color-fg-muted)] flex-wrap">
              <span className="inline-flex items-center gap-2">
                <Clock className="h-4 w-4" />
                <span className="font-semibold text-[var(--color-fg)]">
                  {formatHHMM(reservation.reservation_time)}
                </span>
              </span>
              <span className="inline-flex items-center gap-2">
                <Users className="h-4 w-4" />
                <span className="font-semibold text-[var(--color-fg)]">
                  {reservation.guests}{reservation.children ? ` + ${reservation.children} bimbi` : ''} coperti
                </span>
              </span>
              {reservation.phone && (
                <a
                  href={`tel:${reservation.phone}`}
                  className="inline-flex items-center gap-2 text-indigo-600 dark:text-indigo-400 hover:underline"
                >
                  <Phone className="h-4 w-4" />
                  <span className="font-semibold">{formatPhone(reservation.phone)}</span>
                </a>
              )}
            </div>
          </div>
          {table ? (
            <div className="flex-shrink-0 flex flex-col items-center px-6 py-4 rounded-2xl bg-indigo-50 border border-indigo-200 dark:bg-indigo-500/15 dark:border-indigo-500/40">
              <div className="text-[10px] uppercase tracking-wider text-indigo-700 dark:text-indigo-300 font-semibold mb-1">
                Tavolo
              </div>
              <div className="text-4xl font-extrabold text-indigo-700 dark:text-indigo-200 tabular-nums">
                {table.name}
              </div>
              <div className="text-xs text-indigo-600 dark:text-indigo-300 mt-1">
                {table.seats} posti
              </div>
            </div>
          ) : (
            <div className="flex-shrink-0 px-6 py-4 rounded-2xl bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 text-amber-800 dark:text-amber-300 text-sm font-medium">
              Nessun tavolo assegnato
            </div>
          )}
        </div>

        {/* Customer notes / preferences */}
        {(reservation.notes || reservation.customer_dietary_notes || reservation.customer_preferences_notes) && (
          <div className="mt-5 space-y-2">
            {reservation.notes && (
              <NotesLine label="Note prenotazione" text={reservation.notes} />
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
      <div className="flex-shrink-0 px-8 py-6">
        <div className="grid grid-cols-2 gap-4">
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
          {arr === ArrivalStatus.ARRIVED ? (
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
  <div className={`text-sm px-3 py-2 rounded-xl border ${
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
  variant?: 'success' | 'danger' | 'neutral';
}

const ActionButton: React.FC<ActionButtonProps> = ({ onClick, disabled, icon, label, primary, variant }) => {
  let cls = 'bg-[var(--color-surface-2)] text-[var(--color-fg)] border-[var(--color-line)] hover:bg-[var(--color-surface-3)]';
  if (primary) {
    cls = 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700';
  } else if (variant === 'success') {
    cls = 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700';
  } else if (variant === 'danger') {
    cls = 'bg-rose-600 text-white border-rose-600 hover:bg-rose-700';
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-3 px-4 py-5 rounded-2xl border text-lg font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[80px] ${cls}`}
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
  onCancel: () => void;
  onSelect: (tableId: number) => void;
  busy: boolean;
}

const TablePicker: React.FC<TablePickerProps> = ({
  reservation,
  tables,
  rooms,
  activeRoomId,
  setActiveRoomId,
  occupiedTableIds,
  onCancel,
  onSelect,
  busy
}) => {
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

  // Fit the full room into the available viewport — scale on the tighter axis
  // so nothing ever scrolls. Allow upscaling past 1× on small rooms.
  const PAD = 32;
  const scale = activeRoom && activeRoom.width > 0 && activeRoom.height > 0
    ? Math.min(
        (containerSize.width - PAD * 2) / activeRoom.width,
        (containerSize.height - PAD * 2) / activeRoom.height
      )
    : 1;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--color-surface)]">
      <div className="flex-shrink-0 px-6 py-4 border-b border-[var(--color-line)] flex items-center justify-between gap-4 bg-[var(--color-surface-2)]">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-[var(--color-fg-muted)] font-semibold">
            Assegna tavolo a
          </div>
          <div className="text-2xl font-bold text-[var(--color-fg)] truncate">
            {reservation.customer_name || 'Senza nome'} · {reservation.guests} coperti
          </div>
        </div>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-5 py-3 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-3)] font-medium inline-flex items-center gap-2"
        >
          <XIcon className="h-5 w-5" />
          Chiudi
        </button>
      </div>

      {visibleRooms.length > 1 && (
        <div className="flex-shrink-0 px-6 pt-3 flex gap-2 overflow-x-auto">
          {visibleRooms.map(room => (
            <button
              key={room.id}
              onClick={() => setActiveRoomId(room.id)}
              className={`px-4 py-2 rounded-xl text-sm font-medium whitespace-nowrap border ${
                room.id === activeRoom?.id
                  ? 'bg-indigo-600 text-white border-indigo-600'
                  : 'bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
              }`}
            >
              {room.name}
            </button>
          ))}
        </div>
      )}

      <div className="flex-shrink-0 px-6 pt-3">
        <Legend />
      </div>

      <div ref={containerRef} className="flex-1 min-h-0 overflow-hidden px-6 pb-6 flex items-center justify-center">
        {activeRoom && (
          <div
            className="relative rounded-2xl bg-[var(--color-surface-2)] border border-[var(--color-line)]"
            style={{
              width: activeRoom.width * scale,
              height: activeRoom.height * scale
            }}
          >
              {roomTables.map(t => {
                const occupied = occupiedTableIds.has(t.id);
                const tooSmall = (t.max_seats ?? t.seats) < reservation.guests;
                const isCurrent = reservation.table_id === t.id;
                const dim = getGlyphDimensions(t.shape, t.seats);
                const glyphW = dim.width * scale;
                const glyphH = dim.height * scale;

                let badgeBg = 'bg-emerald-500/15 ring-emerald-500/40';
                let chairColor: string | undefined = '#10b981'; // emerald-500
                let disabled = false;
                let cornerNote: string | null = null;

                if (isCurrent) {
                  badgeBg = 'bg-indigo-500/20 ring-indigo-500/50';
                  chairColor = '#6366f1';
                  cornerNote = 'Attuale';
                } else if (occupied) {
                  badgeBg = 'bg-rose-500/15 ring-rose-500/40';
                  chairColor = '#f43f5e';
                  disabled = true;
                  cornerNote = 'Occupato';
                } else if (tooSmall) {
                  badgeBg = 'bg-slate-500/10 ring-slate-400/40';
                  chairColor = '#94a3b8';
                  cornerNote = `${t.seats} posti`;
                }

                return (
                  <button
                    key={t.id}
                    onClick={() => !disabled && onSelect(t.id)}
                    disabled={busy || disabled}
                    className={`absolute rounded-2xl ring-2 ring-inset transition-all ${badgeBg} ${
                      disabled ? 'cursor-not-allowed opacity-60' : 'hover:scale-105 hover:z-10 cursor-pointer'
                    }`}
                    style={{
                      left: t.x * scale,
                      top: t.y * scale,
                      width: glyphW,
                      height: glyphH
                    }}
                    title={`${t.name} · ${t.seats} posti`}
                  >
                    <div style={{ width: glyphW, height: glyphH }} className="flex items-center justify-center">
                      <TableGlyph
                        name={t.name}
                        seats={t.seats}
                        shape={t.shape}
                        status="libera"
                        fit
                        chairColor={chairColor}
                      />
                    </div>
                    {cornerNote && (
                      <span className="absolute -top-2 -right-2 px-1.5 py-0.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] text-[10px] font-semibold text-[var(--color-fg)] whitespace-nowrap">
                        {cornerNote}
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

const Legend: React.FC = () => (
  <div className="flex items-center gap-4 mb-4 text-xs text-[var(--color-fg-muted)] flex-wrap">
    <span className="inline-flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-full bg-emerald-500/40 ring-2 ring-emerald-500/60" /> Libero
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-full bg-rose-500/40 ring-2 ring-rose-500/60" /> Occupato
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-full bg-slate-400/40 ring-2 ring-slate-400/60" /> Troppo piccolo
    </span>
    <span className="inline-flex items-center gap-1.5">
      <span className="w-3 h-3 rounded-full bg-indigo-500/40 ring-2 ring-indigo-500/60" /> Attuale
    </span>
  </div>
);

export default ReceptionPage;
