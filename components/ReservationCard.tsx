import React from 'react';
import { Users, BookOpen } from 'lucide-react';

export interface BanquetLabelProps {
  width: number;
  name: string;
  guests?: number | null;
  colorClass: string;           // banquet-color-N class assigned by the parent view
}

// Single event label for a banquet: name + covers (one per banquet, anchored
// to the primary cluster's hull — see utils/labelPlacement.ts). The
// banquet-color-X wrapper class redefines --ds-banquet-* so the label tint
// matches the hulls of the same banquet.
export const BanquetLabel: React.FC<BanquetLabelProps> = ({ width, name, guests, colorClass }) => (
  <div
    style={{ minWidth: width }}
    className={`${colorClass} inline-flex items-center gap-2.5 rounded-xl border border-[var(--ds-banquet-border)] bg-[var(--ds-banquet-bg)] px-4 py-3 shadow-[var(--ds-shadow-card)]`}
  >
    <BookOpen size={22} className="flex-shrink-0 text-[var(--ds-banquet-accent)]" />
    <span className="whitespace-nowrap text-[20px] font-semibold text-[var(--ds-banquet-fg-strong)]">{name}</span>
    {guests != null && (
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap text-[19px] font-semibold text-[var(--ds-banquet-fg)]">
        <Users size={20} className="opacity-80" />
        {guests}
      </span>
    )}
  </div>
);
