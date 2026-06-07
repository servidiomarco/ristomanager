import React from 'react';
import { Users, Clock, Armchair, BookOpen } from 'lucide-react';
import { TableShape } from '../types';
import { formatShortName } from '../utils/text';
import { TableGlyph } from './TableGlyph';

export type CardStatus = 'attesa' | 'arrivato' | 'banchetto';

const PALETTE: Record<CardStatus, { bg: string; stroke: string; name: string; chair: string }> = {
  attesa:    { bg: 'var(--tg-attesa-bg)',    stroke: 'var(--tg-attesa-stroke)',    name: 'var(--tg-attesa-name)',    chair: 'var(--tg-attesa-chair)' },
  arrivato:  { bg: 'var(--tg-arrivato-bg)',  stroke: 'var(--tg-arrivato-stroke)',  name: 'var(--tg-arrivato-name)',  chair: 'var(--tg-arrivato-chair)' },
  banchetto: { bg: 'var(--color-banquet-bg)', stroke: 'var(--color-banquet-border)', name: 'var(--color-banquet-fg-strong)', chair: 'var(--color-banquet-accent)' },
};

export interface ReservationCardProps {
  width: number;
  selected?: boolean;
  status: CardStatus;
  // Table glyph (drawn inside the card, like the booking modal)
  tableLabel: string;
  shape: TableShape;
  seats: number;
  rotation?: number | null;
  capacity: number;
  // Reservation info — omitted for banquet tables (glyph + capacity only).
  name?: string | null;
  covers?: number | null;
  childrenCount?: number | null;
  time?: string | null;
}

// Floor-plan card — the table glyph is WRAPPED inside the card, like the
// booking-modal card: glyph, capacity row, then (for reservations) divider,
// guest name, covers·time. Tinted by status (attesa = blue, arrivato = green,
// banchetto = violet). No booker badge.
export const ReservationCard: React.FC<ReservationCardProps> = ({
  width, selected, status, tableLabel, shape, seats, rotation, name, capacity, covers, childrenCount, time,
}) => {
  const p = PALETTE[status];
  const hasInfo = !!name;
  return (
    <div
      style={{ width, background: p.bg, borderColor: p.stroke }}
      className={`flex flex-col items-center rounded-2xl border px-3 py-2.5 text-center shadow-[var(--shadow-md)] ${selected ? 'ring-2 ring-[var(--color-fg)] ring-offset-1' : ''}`}
    >
      <div style={{ transform: rotation ? `rotate(${rotation}deg)` : undefined }}>
        <TableGlyph name={tableLabel} seats={seats} shape={shape} status="libera" party={covers ?? undefined} chairColor={p.chair} />
      </div>
      <div className="mt-1 flex items-center justify-center gap-1.5 text-[17px] font-medium" style={{ color: 'var(--tg-covers)' }}>
        <Armchair size={20} className="flex-shrink-0" />
        <span>{capacity}</span>
      </div>
      {hasInfo && (
        <>
          <div className="my-1.5 w-full border-t" style={{ borderColor: p.stroke }} />
          <div className="w-full truncate text-[20px] font-semibold leading-tight" style={{ color: p.name }}>
            {formatShortName(name!)}
          </div>
          <div className="mt-1.5 flex items-center justify-center gap-2 whitespace-nowrap text-[19px] font-semibold leading-tight" style={{ color: p.name }}>
            <Users size={20} className="flex-shrink-0 opacity-80" />
            <span>{covers}{childrenCount && childrenCount > 0 ? ` (${childrenCount}b)` : ''}</span>
            {time && (
              <>
                <span className="opacity-40">·</span>
                <Clock size={20} className="flex-shrink-0 opacity-80" />
                <span>{time}</span>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export interface ReservationInfoPillProps {
  width: number;
  selected?: boolean;
  status: 'attesa' | 'arrivato';
  name: string;
  covers: number;
  childrenCount?: number | null;
  time?: string | null;
}

// Compact floating pill used as a fallback when the wrap-card would overlap a
// neighbour table (e.g. merged tables in tight manual layouts). Carries the
// reservation info without the glyph; the table is drawn separately in its
// usual spot, tinted by status. The collision-aware placement engine
// (utils/labelPlacement.ts) decides where to park it.
export const ReservationInfoPill: React.FC<ReservationInfoPillProps> = ({
  width, selected, status, name, covers, childrenCount, time,
}) => {
  const p = PALETTE[status];
  return (
    <div
      style={{ width, background: p.bg, borderColor: p.stroke }}
      className={`flex flex-col items-center rounded-2xl border px-3 py-2 text-center shadow-[var(--shadow-md)] ${selected ? 'ring-2 ring-[var(--color-fg)] ring-offset-1' : ''}`}
    >
      <div className="w-full truncate text-[20px] font-semibold leading-tight" style={{ color: p.name }}>
        {formatShortName(name)}
      </div>
      <div className="mt-1 flex items-center justify-center gap-2 whitespace-nowrap text-[19px] font-semibold leading-tight" style={{ color: p.name }}>
        <Users size={20} className="flex-shrink-0 opacity-80" />
        <span>{covers}{childrenCount && childrenCount > 0 ? ` (${childrenCount}b)` : ''}</span>
        {time && (
          <>
            <span className="opacity-40">·</span>
            <Clock size={20} className="flex-shrink-0 opacity-80" />
            <span>{time}</span>
          </>
        )}
      </div>
    </div>
  );
};

export interface BanquetLabelProps {
  width: number;
  name: string;
  guests?: number | null;
  colorClass: string;           // banquet-color-N class assigned by the parent view
}

// Single event label for a banquet: name + covers (one per banquet, anchored
// to the primary cluster's hull — see utils/labelPlacement.ts). The
// banquet-color-X wrapper class redefines --color-banquet-* so the label tint
// matches the hulls of the same banquet.
export const BanquetLabel: React.FC<BanquetLabelProps> = ({ width, name, guests, colorClass }) => (
  <div
    style={{ width }}
    className={`${colorClass} flex items-center gap-2.5 rounded-xl border border-[var(--color-banquet-border)] bg-[var(--color-banquet-bg)] px-4 py-3 shadow-[var(--shadow-sm)]`}
  >
    <BookOpen size={22} className="flex-shrink-0 text-[var(--color-banquet-accent)]" />
    <span className="min-w-0 flex-1 truncate text-[20px] font-semibold text-[var(--color-banquet-fg-strong)]">{name}</span>
    {guests != null && (
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[19px] font-semibold text-[var(--color-banquet-fg)]">
        <Users size={20} className="opacity-80" />
        {guests}
      </span>
    )}
  </div>
);
