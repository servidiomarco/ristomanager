import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { parseDietary } from '../utils/dietary';

// Renders a reservation's dietary flags as chips: allergies take the critical
// family (serious, safety-critical) and intolerances take pending. Reads the
// labelled segments from the free-text notes. Renders nothing when there are none.
interface DietaryChipsProps {
  notes: string | null | undefined;
  presets?: string[];
  size?: 'sm' | 'md';
  className?: string;
}

export const DietaryChips: React.FC<DietaryChipsProps> = ({ notes, presets, size = 'md', className = '' }) => {
  const { allergies, intolerances } = parseDietary(notes, presets);
  if (allergies.length === 0 && intolerances.length === 0) return null;

  const pad = size === 'sm' ? 'h-5 px-1.5 text-[10px] gap-0.5' : 'h-6 px-2 text-[11px] gap-1';
  const icon = size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3';

  return (
    <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {allergies.length > 0 && (
        <span
          className={`inline-flex items-center rounded-full font-medium bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ${pad}`}
          title={`Allergie: ${allergies.join(', ')}`}
        >
          <AlertTriangle className={`${icon} flex-shrink-0`} />
          <span className="font-semibold">Allergie:</span> {allergies.join(', ')}
        </span>
      )}
      {intolerances.length > 0 && (
        <span
          className={`inline-flex items-center rounded-full font-medium bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ${pad}`}
          title={`Intolleranze: ${intolerances.join(', ')}`}
        >
          <Info className={`${icon} flex-shrink-0`} />
          <span className="font-semibold">Intoll.:</span> {intolerances.join(', ')}
        </span>
      )}
    </div>
  );
};
