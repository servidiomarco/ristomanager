import React from 'react';
import { ArrivalStatus, Reservation, ReservationStatus, Shift } from '../types';
import type { TableDisplayStatus } from './TableGlyph';

/* ===========================================================================
   Reservation state — single source of truth.

   Every surface (list chips, reception badges, table glyphs, dashboard
   counters) derives from here so a state always looks and reads the same
   across the app. Two layers:

   1. Enum state — what's persisted (`getReservationState`).
   2. Timed state — the enum state enriched by the clock
      (`getTimedReservationState`): a confirmed booking whose time is close
      becomes "In arrivo", a seated party past its expected duration becomes
      "In uscita". These move by themselves as the service progresses — the
      staff never has to babysit them (they can still override via the
      explicit DEPARTING status, or extend `duration_minutes` if a table is
      lingering intentionally).
   ========================================================================= */

export type ReservationStateKey =
  | 'pending'    // Da confermare (richiesta web)
  | 'waiting'    // Confermata, cliente non ancora qui
  | 'arriving'   // In arrivo — derivato dal tempo, non impostabile a mano
  | 'arrived'    // Arrivato / tavolo occupato
  | 'departing'  // In uscita — dolce/caffè/conto (manuale o derivato)
  | 'freed'      // Tavolo liberato
  | 'noshow'
  | 'cancelled'
  | 'declined';

/** Minutes before the booked time at which a WAITING booking starts reading
 *  as "In arrivo" (and keeps doing so while the party is late). */
export const ARRIVING_WINDOW_MIN = 20;
/** A WAITING booking stops reading as "In arrivo" this long after its time —
 *  by then it's either seated, a no-show call, or yesterday's row. */
export const ARRIVING_STALE_MIN = 120;

export const getEffectiveDurationMin = (res: Reservation): number =>
  res.duration_minutes && res.duration_minutes > 0
    ? res.duration_minutes
    : res.shift === Shift.LUNCH ? 90 : 120;

/** Enum-only state — no clock involved. */
export const getReservationState = (res: Reservation): ReservationStateKey => {
  const rs = res.reservation_status || ReservationStatus.CONFIRMED;
  if (rs === ReservationStatus.PENDING) return 'pending';
  if (rs === ReservationStatus.DECLINED) return 'declined';
  if (rs === ReservationStatus.CANCELLED) return 'cancelled';
  if (rs === ReservationStatus.NO_SHOW) return 'noshow';
  const a = res.arrival_status || ArrivalStatus.WAITING;
  if (a === ArrivalStatus.DEPARTED) return 'freed';
  if (a === ArrivalStatus.DEPARTING) return 'departing';
  if (a === ArrivalStatus.ARRIVED) return 'arrived';
  return 'waiting';
};

/** Party is still physically at the table (occupies a seat right now). */
export const isSeated = (res: Reservation): boolean =>
  res.arrival_status === ArrivalStatus.ARRIVED || res.arrival_status === ArrivalStatus.DEPARTING;

export const isArrivingSoon = (res: Reservation, now: number): boolean => {
  const start = new Date(res.reservation_time).getTime();
  if (!Number.isFinite(start)) return false;
  return now >= start - ARRIVING_WINDOW_MIN * 60_000
      && now <= start + ARRIVING_STALE_MIN * 60_000;
};

/** Seated past the expected duration → the table should be turning over. */
export const isOverdue = (res: Reservation, now: number): boolean => {
  const start = new Date(res.reservation_time).getTime();
  if (!Number.isFinite(start)) return false;
  return now >= start + getEffectiveDurationMin(res) * 60_000;
};

/** Minutes granted when staff re-asserts that an overdue table is still seated. */
export const OVERDUE_EXTEND_MIN = 30;

/** A `duration_minutes` that keeps an overdue seated party reading as
 *  "Arrivato" for another OVERDUE_EXTEND_MIN from `now` — the sanctioned way
 *  to override the clock-derived "In uscita" (see header comment). */
export const extendedDurationMin = (res: Reservation, now: number): number => {
  const start = new Date(res.reservation_time).getTime();
  if (!Number.isFinite(start)) return getEffectiveDurationMin(res) + OVERDUE_EXTEND_MIN;
  return Math.max(getEffectiveDurationMin(res), Math.ceil((now - start) / 60_000)) + OVERDUE_EXTEND_MIN;
};

/** Enum state + clock. Pass `now` from `useNow()` so the UI re-derives live. */
export const getTimedReservationState = (res: Reservation, now: number): ReservationStateKey => {
  const base = getReservationState(res);
  if (base === 'waiting' && isArrivingSoon(res, now)) return 'arriving';
  if (base === 'arrived' && isOverdue(res, now)) return 'departing';
  return base;
};

/* ---------------------------------------------------------------------------
   Visual meta — the only place a state gets a color.
   `booked-*` is the blue-violet family from @theme; "In arrivo" stays in the
   same family but filled + pulsing (motion is its unique cue — it never
   competes with the warm banquet palette). "In uscita" is cyan: perceptually
   between occupied-green and free-neutral, exactly like its meaning.
   ------------------------------------------------------------------------- */

export interface ReservationStateMeta {
  label: string;
  dotClass: string;
  chipClass: string;
  /** The dot pings — reserved for 'arriving', the only animated state. */
  pulse?: boolean;
}

export const RESERVATION_STATE_META: Record<ReservationStateKey, ReservationStateMeta> = {
  pending:   { label: 'Da confermare', dotClass: 'bg-amber-500', chipClass: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 dark:hover:bg-amber-500/25' },
  waiting:   { label: 'Confermata', dotClass: 'bg-booked-600', chipClass: 'bg-booked-50 text-booked-600 border-booked-200 hover:bg-booked-100 dark:bg-booked-600/25 dark:text-booked-300 dark:border-booked-600/40 dark:hover:bg-booked-600/35' },
  arriving:  { label: 'In arrivo', pulse: true, dotClass: 'bg-white', chipClass: 'bg-booked-600 text-white border-booked-600 hover:bg-booked-700 dark:bg-booked-500 dark:border-booked-500 dark:hover:bg-booked-600' },
  arrived:   { label: 'Arrivato', dotClass: 'bg-emerald-500', chipClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30 dark:hover:bg-emerald-500/25' },
  departing: { label: 'In uscita', dotClass: 'bg-cyan-600', chipClass: 'bg-cyan-50 text-cyan-700 border-cyan-200 hover:bg-cyan-100 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/30 dark:hover:bg-cyan-500/25' },
  freed:     { label: 'Libera',   dotClass: 'bg-slate-400', chipClass: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30 dark:hover:bg-slate-500/25' },
  noshow:    { label: 'No show',  dotClass: 'bg-rose-500',  chipClass: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25' },
  cancelled: { label: 'Annullata',dotClass: 'bg-rose-500',  chipClass: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25' },
  declined:  { label: 'Non confermata', dotClass: 'bg-rose-500',  chipClass: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25' },
};

/** States the staff can set by hand ('arriving' is clock-derived only). */
export const SETTABLE_RESERVATION_STATES: ReservationStateKey[] =
  ['pending', 'waiting', 'arrived', 'departing', 'freed', 'noshow', 'cancelled', 'declined'];

/** The field patch that moves a reservation into `state`. */
export const reservationStatePatch = (state: Exclude<ReservationStateKey, 'arriving'>): Partial<Reservation> => {
  switch (state) {
    case 'pending':   return { arrival_status: ArrivalStatus.WAITING,   reservation_status: ReservationStatus.PENDING };
    case 'waiting':   return { arrival_status: ArrivalStatus.WAITING,   reservation_status: ReservationStatus.CONFIRMED };
    case 'arrived':   return { arrival_status: ArrivalStatus.ARRIVED,   reservation_status: ReservationStatus.CONFIRMED };
    case 'departing': return { arrival_status: ArrivalStatus.DEPARTING, reservation_status: ReservationStatus.CONFIRMED };
    case 'freed':     return { arrival_status: ArrivalStatus.DEPARTED,  reservation_status: ReservationStatus.CONFIRMED };
    case 'noshow':    return { arrival_status: ArrivalStatus.WAITING,   reservation_status: ReservationStatus.NO_SHOW };
    case 'cancelled': return { arrival_status: ArrivalStatus.WAITING,   reservation_status: ReservationStatus.CANCELLED, table_id: undefined };
    case 'declined':  return { arrival_status: ArrivalStatus.WAITING,   reservation_status: ReservationStatus.DECLINED,  table_id: undefined };
  }
};

/* ---------------------------------------------------------------------------
   PulseDot + StatusChip — the one badge every surface renders.
   ------------------------------------------------------------------------- */

/** The status dot; when `pulse` it pings — the app's only ambient motion cue. */
export const PulseDot: React.FC<{ dotClass: string; pulse?: boolean; sizeClass?: string }> = ({ dotClass, pulse, sizeClass = 'h-1.5 w-1.5' }) => (
  <span className={`relative flex flex-none ${sizeClass}`}>
    {pulse && (
      <span className={`motion-safe:animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${dotClass}`} />
    )}
    <span className={`relative inline-flex rounded-full ${sizeClass} ${dotClass}`} />
  </span>
);

interface StatusChipProps {
  state: ReservationStateKey;
  size?: 'sm' | 'md';
  onClick?: (e: React.MouseEvent) => void;
  className?: string;
  title?: string;
  /** Rendered after the label — e.g. a ChevronDown on chips that open the state picker. */
  trailing?: React.ReactNode;
}

export const StatusChip: React.FC<StatusChipProps> = ({ state, size = 'md', onClick, className = '', title, trailing }) => {
  const meta = RESERVATION_STATE_META[state];
  const sizing = size === 'sm'
    ? 'text-[10px] px-2 py-0.5 gap-1.5'
    : 'text-xs px-2.5 py-1 gap-2';
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={`inline-flex items-center rounded-full border font-semibold uppercase tracking-wide whitespace-nowrap ${onClick ? 'pressable' : 'transition-colors'} ${sizing} ${meta.chipClass} ${className}`}
    >
      <PulseDot dotClass={meta.dotClass} pulse={meta.pulse} />
      {meta.label}
      {trailing}
    </Tag>
  );
};

/* ---------------------------------------------------------------------------
   Table glyph state — the floor-map projection of the same truth.
   ------------------------------------------------------------------------- */

export const TABLE_STATUS_LABEL: Record<TableDisplayStatus, string> = {
  libera:   'Libero',
  attesa:   'Prenotato',
  inarrivo: 'In arrivo',
  arrivato: 'Occupato',
  uscita:   'In uscita',
  noshow:   'No-show',
};

export function deriveTableDisplayStatus(
  reservation: Reservation | null | undefined,
  opts: { banquet?: boolean; tempLocked?: boolean; now?: number } = {},
): TableDisplayStatus {
  if (opts.banquet) return 'attesa';
  if (opts.tempLocked) return 'attesa';
  if (!reservation) return 'libera';
  const state = opts.now != null
    ? getTimedReservationState(reservation, opts.now)
    : getReservationState(reservation);
  switch (state) {
    case 'noshow':    return 'noshow';
    case 'departing': return 'uscita';
    case 'arrived':   return 'arrivato';
    case 'arriving':  return 'inarrivo';
    case 'freed':
    case 'cancelled':
    case 'declined':  return 'libera';
    default:          return 'attesa';
  }
}
