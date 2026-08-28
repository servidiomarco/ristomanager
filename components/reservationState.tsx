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
  /** The dot pings — reserved for 'arriving', the only animated state. */
  pulse?: boolean;
}

export const RESERVATION_STATE_META: Record<ReservationStateKey, ReservationStateMeta> = {
  pending:   { label: 'Da confermare' },
  waiting:   { label: 'Confermata' },
  arriving:  { label: 'In arrivo', pulse: true },
  arrived:   { label: 'Arrivato' },
  departing: { label: 'In uscita' },
  freed:     { label: 'Libera' },
  noshow:    { label: 'No show' },
  cancelled: { label: 'Annullata' },
  declined:  { label: 'Non confermata' },
};

/* ---------------------------------------------------------------------------
   Stato -> famiglia del design system.

   La mappa che c'era prima portava una tinta per stato (ambra, booked,
   emerald, cyan, rose, slate). Il design system ha quattro famiglie piu'
   neutral, quindi ogni stato ne sceglie una invece di possedere un colore.
   Dove due stati finiscono nella stessa famiglia e' l'etichetta a portare la
   differenza: "In uscita" e' pur sempre un tavolo occupato, quindi resta
   verde invece di scivolare sul neutro che vuol dire "libero".

   Unica eccezione al riempimento tinta: 'arriving' — vedi DsStatusChip.
   ------------------------------------------------------------------------- */

export type ReservationStateFamily = 'pending' | 'arriving' | 'seated' | 'critical' | 'neutral';

export const RESERVATION_STATE_FAMILY: Record<ReservationStateKey, ReservationStateFamily> = {
  pending:   'pending',
  waiting:   'arriving',
  arriving:  'arriving',
  arrived:   'seated',
  departing: 'seated',
  freed:     'neutral',
  noshow:    'critical',
  cancelled: 'critical',
  declined:  'critical',
};

interface FamilyClasses {
  /** Tinted surface + the text colour proven against it. */
  tint: string;
  text: string;
  /** Full-strength fill, for dots and meters. */
  solid: string;
}

const FAMILY_CLASSES: Record<ReservationStateFamily, FamilyClasses> = {
  pending:  { tint: 'bg-[var(--ds-pending-tint)]',  text: 'text-[var(--ds-pending-text)]',   solid: 'bg-[var(--ds-pending-solid)]' },
  arriving: { tint: 'bg-[var(--ds-arriving-tint)]', text: 'text-[var(--ds-arriving-text)]',  solid: 'bg-[var(--ds-arriving-solid)]' },
  seated:   { tint: 'bg-[var(--ds-seated-tint)]',   text: 'text-[var(--ds-seated-text)]',    solid: 'bg-[var(--ds-seated-solid)]' },
  critical: { tint: 'bg-[var(--ds-critical-tint)]', text: 'text-[var(--ds-critical-text)]',  solid: 'bg-[var(--ds-critical-solid)]' },
  neutral:  { tint: 'bg-[var(--ds-surface-row)]',   text: 'text-[var(--ds-text-secondary)]', solid: 'bg-[var(--ds-text-muted)]' },
};

/** Tint / text / solid classes for a state, in design-system tokens. */
export const reservationStateDs = (state: ReservationStateKey): FamilyClasses =>
  FAMILY_CLASSES[RESERVATION_STATE_FAMILY[state]];

/** The state pill on a reservation card. Same truth as StatusChip, drawn in
 *  design-system tokens and sentence case. */
export const DsStatusChip: React.FC<{
  state: ReservationStateKey;
  onClick?: (e: React.MouseEvent) => void;
  title?: string;
  /** Rendered after the label — a ChevronDown on pills that open the picker. */
  trailing?: React.ReactNode;
  className?: string;
}> = ({ state, onClick, title, trailing, className = '' }) => {
  const meta = RESERVATION_STATE_META[state];
  const ds = reservationStateDs(state);
  const Tag = onClick ? 'button' : 'span';
  // 'arriving' e' l'unico stato disegnato pieno invece che a tinta: e' la
  // comitiva che sta entrando adesso, e a colpo d'occhio deve pesare piu'
  // delle altre. Bianco su arriving-solid misura 6.27:1 (§4.1); il pallino
  // passa al bianco perche' indaco su indaco non si vedrebbe.
  const solid = state === 'arriving';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      title={title}
      className={`inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium ${
        solid ? 'bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)]' : `${ds.tint} ${ds.text}`
      } ${
        onClick ? 'transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]' : ''
      } ${className}`}
    >
      <PulseDot dotClass={solid ? 'bg-[var(--ds-arriving-fg)]' : ds.solid} pulse={meta.pulse} />
      {meta.label}
      {trailing}
    </Tag>
  );
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
