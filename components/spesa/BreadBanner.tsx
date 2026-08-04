import React from 'react';
import { Wheat } from 'lucide-react';

/* ── Pane oggi ────────────────────────────────────────────────────────────
   Not a shopping line: a quantity the kitchen derives from tonight's covers,
   one kilo per ten. It lived only in the desktop column, which is the one
   place it is least needed — the person who has to remember the bread is the
   one holding the phone. */

export const BreadBanner: React.FC<{
  bread: { coperti: number; kg: number };
  className?: string;
}> = ({ bread, className = '' }) => (
  <div className={`flex items-start gap-3 rounded-[20px] bg-[var(--ds-pending-tint)] p-4 ${className}`}>
    <Wheat className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-pending-text)]" aria-hidden />
    <div className="min-w-0">
      <p className="text-[15px] font-semibold text-[var(--ds-pending-text)]">
        Pane oggi {bread.coperti > 0 ? `${bread.kg} kg` : '—'}
      </p>
      <p className="mt-0.5 text-[13px] text-[var(--ds-pending-text)]">
        {bread.coperti > 0
          ? `${bread.coperti} coperti previsti · 1 kg ogni 10`
          : 'Nessun coperto previsto per oggi'}
      </p>
    </div>
  </div>
);
