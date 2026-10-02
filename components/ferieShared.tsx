import type { TFunction } from 'i18next';
import type { LeaveProposalReason, LeaveRequestStatus } from '../types';
import type { PillTone } from './ds';
import { displayLocale } from '../utils/formatLocale';

/* Quello che il piano ferie (Personale → Ferie) e «Le mie ferie» (profilo)
   dicono allo stesso modo: come si scrive un intervallo, quanti giorni,
   che faccia ha uno stato, cosa significa un codice d'errore del server.
   Le chiavi vivono nella namespace `ferie`. */

// Mezzogiorno e non mezzanotte: una data letta a 00:00 locale può finire
// sul giorno prima in un fuso a ovest di Greenwich.
const asDate = (iso: string) => new Date(`${iso}T12:00:00`);

export const formatLeaveDay = (iso: string, withYear = false): string =>
  asDate(iso).toLocaleDateString(displayLocale(), {
    day: 'numeric',
    month: 'short',
    ...(withYear ? { year: 'numeric' } : {}),
  });

/** «10–17 ago», «28 dic – 3 gen», «5 ago». L'anno solo se non è `year`. */
export const formatLeaveRange = (start: string, end: string, year?: number): string => {
  const withYear = year !== undefined && (Number(start.slice(0, 4)) !== year || Number(end.slice(0, 4)) !== year);
  if (start === end) return formatLeaveDay(start, withYear);
  if (start.slice(0, 7) === end.slice(0, 7) && !withYear) {
    return `${asDate(start).getDate()}–${formatLeaveDay(end)}`;
  }
  return `${formatLeaveDay(start, withYear)} – ${formatLeaveDay(end, withYear)}`;
};

export const formatLeaveDays = (n: number, t: TFunction): string => {
  const value = new Intl.NumberFormat(displayLocale(), { maximumFractionDigits: 1 }).format(n);
  return t('days', { count: n, value });
};

export const LEAVE_STATUS_TONE: Record<LeaveRequestStatus, PillTone> = {
  PENDING: 'pending',
  APPROVED: 'positive',
  REJECTED: 'critical',
  CANCELLED: 'neutral',
};

export const leaveStatusLabel = (s: LeaveRequestStatus, t: TFunction): string => t(`status.${s}`);

export const leaveReasonText = (r: LeaveProposalReason, t: TFunction): string =>
  r.kind === 'COVERAGE'
    ? t('reason.coverage', {
        date: formatLeaveDay(r.date),
        where: t(`categoryLower.${r.category}`),
        service: t(`serviceLower.${r.service}`),
        left: r.left,
        min: r.min,
      })
    : t('reason.balance', { year: r.year, days: formatLeaveDays(r.over, t) });

/** Il codice che il server mette in `error`, detto per chi deve correggere. */
export const leaveErrorText = (err: unknown, t: TFunction): string => {
  const code = (err as { data?: { error?: string } })?.data?.error;
  switch (code) {
    case 'overlap':
    case 'invalid_dates':
    case 'too_long':
    case 'in_the_past':
    case 'no_working_days':
    case 'staff_inactive':
    case 'not_linked':
    case 'not_pending':
      return t(`error.${code}`);
    default:
      return t('error.generic');
  }
};
