import { Shift } from '../types';

export interface ServiceTurn {
  code: string;        // 'T1', 'T2', …
  label: string;       // 'Primo turno'
  shortLabel: string;  // '1°', '2°'
  start: string;       // 'HH:MM' — local time
  end: string;         // 'HH:MM' — local time
}

// Hardcoded defaults. A future iteration will move these to app_settings so
// each restaurant can edit them from the Settings page.
export const SERVICE_TURNS: Record<Shift, ServiceTurn[]> = {
  [Shift.LUNCH]: [
    { code: 'T1', label: 'Pranzo', shortLabel: '1°', start: '12:30', end: '14:30' },
  ],
  [Shift.DINNER]: [
    { code: 'T1', label: '1° turno', shortLabel: '1°', start: '19:00', end: '20:45' },
    { code: 'T2', label: '2° turno', shortLabel: '2°', start: '21:00', end: '23:00' },
  ],
};

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

const extractHHMM = (reservationTime: string): string => {
  if (reservationTime.includes('T')) {
    return reservationTime.split('T')[1].substring(0, 5);
  }
  return reservationTime.substring(0, 5);
};

export function getTurnsForShift(shift: Shift): ServiceTurn[] {
  return SERVICE_TURNS[shift] || [];
}

export function getTurn(shift: Shift, code?: string | null): ServiceTurn | null {
  if (!code) return null;
  return getTurnsForShift(shift).find(t => t.code === code) || null;
}

/**
 * Pick the turn for a reservation_time within a shift.
 * - Inside a turn window (start inclusive, end exclusive) → that turn.
 * - Outside any window → nearest turn by start time.
 * - Shift with no turns → null.
 */
export function inferTurnCode(shift: Shift, reservationTime: string): string | null {
  const turns = getTurnsForShift(shift);
  if (turns.length === 0) return null;
  const mins = toMinutes(extractHHMM(reservationTime));
  for (const t of turns) {
    if (mins >= toMinutes(t.start) && mins < toMinutes(t.end)) return t.code;
  }
  let best = turns[0];
  let bestGap = Math.abs(toMinutes(best.start) - mins);
  for (const t of turns.slice(1)) {
    const gap = Math.abs(toMinutes(t.start) - mins);
    if (gap < bestGap) { bestGap = gap; best = t; }
  }
  return best.code;
}
