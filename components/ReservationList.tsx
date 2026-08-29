import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  ModalShell, FormCard, Field, Stepper, StepNav, SegmentedControl, dsInput, dsSelect, dsTextarea, dsButton, dsStepArrow,
  SearchField, SectionHeader, StatusPill, StatStrip, EmptyState, Callout, dsIconButton, CountBadge, useMediaQuery,
} from './ds';
import type { SectionTone, Stat } from './ds';
import { BillSheet } from './pagamenti/BillSheet';
import { BillFigures, billStateLabel } from './prenotazione/BillFigures';
import { PaymentRequestRow } from './prenotazione/PaymentRequestRow';
import { MessaggiPanel } from './prenotazione/MessaggiPanel';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus, ReservationStatus, ReservationSource, TableMerge, TableHiddenOverride, RoomClosedOverride, Customer, PaymentRequest, TableBillWithSplits, TableBill, NoteSelection, TableAssignmentSuggestion } from '../types';
import { Banknote, Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, Sunset, MapPin, ListFilter, Map as MapIcon, List, MessageCircle, Mail, Armchair, BellRing, CheckSquare, Square, UserCheck, UserX, Combine, Scissors, Check, CheckCheck, ChevronDown, ChevronLeft, ChevronRight, AlertTriangle, AlertOctagon, StickyNote, Mic, Loader2, Info, ArrowUpDown, RotateCcw, Printer, Eye, EyeOff, BookUser, BookOpen, MoreHorizontal, Ban, Globe, Phone, Send, Star, Copy, ExternalLink, SlidersHorizontal, DoorClosed, CornerDownLeft, ArrowDownLeft, ArrowUpRight, Reply, Receipt, QrCode } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { sendWhatsAppConfirmation, sendEmailConfirmation, sendCustomEmail, getTableMerges, getTableHidden, createTableHidden, deleteTableHidden, getRoomClosed, getCustomers, getReservationNotePresets, getReservationAllergenPresets, getPaymentRequests, createPaymentRequest, revokePaymentRequest, getReservationMessages, sendReservationReminder, OutboundMessage, getLegalSettings, getFeatureFlags, getOpeningHours, OpeningHoursRow, getActivePaymentProvider, getChannelSettings, RoomOccupancyCap, getTableAssignmentSuggestions, confirmTableAssignmentSuggestion, dismissTableAssignmentSuggestion } from '../services/apiService';
import { billsApiService, printBill } from '../services/billsApiService';
import { swrConfig } from '../services/configCache';
import { CustomerPickerModal } from './CustomerPickerModal';
import { Loader } from './Loader';
import { getReservationNoteIcon } from './reservationNoteIcons';
import { isVoiceSupported, startListening, parseReservationText } from '../services/voiceInputService';
import { saveDraft, loadDraft, clearDraft, DRAFT_KEYS } from '../services/draftService';
import { applyMerges } from '../utils/tableMerge';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from './TableGlyph';
import {
  getReservationState, getTimedReservationState, RESERVATION_STATE_META,
  reservationStatePatch, deriveTableDisplayStatus, isSeated,
  DsStatusChip, reservationStateDs,
  isOverdue, extendedDurationMin, OVERDUE_EXTEND_MIN, getEffectiveDurationMin,
  type ReservationStateKey,
} from './reservationState';
import { useNow } from '../hooks/useNow';
import { SwipeToCheckIn } from './SwipeToCheckIn';
import { DietaryChips } from './DietaryChips';
import { buildDietaryNote, parseDietary, stripDietaryNote } from '../utils/dietary';
import { computeAutoLayout } from '../utils/tableLayout';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { PaymentBadge } from './PaymentBadge';
import { SkeletonReservationList } from './SkeletonCards';
import { buildFloorLabels } from '../utils/labelPlacement';
import { buildBanquetColorClassMap } from '../utils/banquetColors';
import { BanquetLabel } from './ReservationCard';
import { toTitleCase, getInitials, formatShortName } from '../utils/text';
import { useSocket } from '../hooks/useSocket';
import { PrintReservationsModal } from './PrintReservationsModal';
import { BookingChannelsBar } from './BookingChannelsBar';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { DateNavigator } from './DateNavigator';
import { useAuth } from '../contexts/AuthContext';

// Helpers for local-date formatting (avoid UTC shift from toISOString)
const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Client-side mirror of utils/slots.ts::generateSlots. Kept small so the
// modal dropdown + arrival heatmap can derive the slot list without
// round-tripping to the backend.
const generateSlotList = (open: string | null, close: string | null, stepMinutes: number): string[] => {
  if (!open || !close || !Number.isFinite(stepMinutes) || stepMinutes <= 0) return [];
  const [oh, om] = open.split(':').map(Number);
  const [ch, cm] = close.split(':').map(Number);
  const startMin = oh * 60 + om;
  const endMin = ch * 60 + cm;
  if (!Number.isFinite(startMin) || !Number.isFinite(endMin) || endMin < startMin) return [];
  const out: string[] = [];
  for (let m = startMin; m <= endMin; m += stepMinutes) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
};

const LEGACY_LUNCH_SLOTS = ['13:00', '13:30', '14:00'];
const LEGACY_DINNER_SLOTS = ['19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

// Derives the allowed HH:MM slot list for a given ISO date + shift given the
// opening-hours config. Applies both per-weekday hours and the disabled-slot
// blacklist. Falls back to the historic hardcoded list when opening_hours
// hasn't loaded yet, so the modal always has *something* usable.
const getSlotsForDateShift = (
  isoDate: string | null | undefined,
  shift: Shift | null | undefined,
  openingHours: OpeningHoursRow[],
): string[] => {
  const legacy = shift === Shift.LUNCH ? LEGACY_LUNCH_SLOTS : LEGACY_DINNER_SLOTS;
  if (!isoDate || !shift || openingHours.length === 0) return legacy;
  const weekday = new Date(isoDate + 'T00:00:00').getDay();
  const row = openingHours.find(r => r.weekday === weekday);
  if (!row) return [];
  const open = shift === Shift.LUNCH ? row.lunch_open : row.dinner_open;
  const close = shift === Shift.LUNCH ? row.lunch_close : row.dinner_close;
  const disabled = new Set(shift === Shift.LUNCH ? row.disabled_lunch_slots : row.disabled_dinner_slots);
  return generateSlotList(open, close, row.slot_minutes).filter(s => !disabled.has(s));
};

/** Minutes a dismissal quiets the overdue-table prompt on this device. */
const OVERDUE_SNOOZE_MIN = 15;

/* ── Form steps (edit only) ───────────────────────────────────────────────
   The same three sections the edit form has always had, given a screen each.
   Payments and the message log used to sit below the table grid, so reaching
   them meant scrolling past the whole floor plan — on a phone that is a long
   way to go for the two things you open a saved booking to do.

   Steps never gate each other: any one is reachable from the header at any
   time and Salva stays live on all of them, because an edit is usually one
   field, not a journey. Validation still runs once, on save. */
const RESERVATION_STEPS = [
  { label: 'Dettagli', icon: Calendar },
  { label: 'Pagamenti', icon: CreditCard },
  { label: 'Comunicazione', icon: MessageCircle },
] as const;

// Sezione conto-al-tavolo nel modal prenotazione. Interruttore lato client
// sopra al feature flag backend `pay_at_table_enabled`: con entrambi attivi
// la sezione compare in modalità edit per chi ha `payments:view`. Tenuto
// come kill-switch rapido (già servito più volte) — mettere `false` per
// nascondere l'operatività ai camerieri senza toccare l'endpoint QR.
const PAY_AT_TABLE_UI_VISIBLE = true;

const formatLocalDateTime = (date: Date): string => {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${formatLocalDate(date)}T${h}:${min}`;
};

// Helper to format datetime without timezone conversion
const formatDateTime = (isoString: string): string => {
  const dateStr = getRomeDatePart(isoString);
  const timeStr = getRomeTimePart(isoString);
  if (dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}/${month}/${year}, ${timeStr || '00:00'}`;
  }
  return new Date(isoString).toLocaleString();
};

// Two-letter initials from a full name (falls back to '?' on empty)
// Small circular badge showing who took the reservation:
// voice-agent bookings get a Mic icon, manual bookings get user initials.
const renderOperatorBadge = (res: Reservation): React.ReactNode => {
  if (res.source === ReservationSource.VOICE) {
    return (
      <span
        className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]"
        title="Presa dall'agente vocale"
        aria-label="Presa dall'agente vocale"
      >
        <Mic className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (res.created_by_user_name) {
    return (
      <span
        className="inline-flex h-5 min-w-[20px] flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] px-1 text-[10px] font-semibold text-[var(--ds-text-secondary)]"
        title={`Presa da ${toTitleCase(res.created_by_user_name)}`}
        aria-label={`Presa da ${toTitleCase(res.created_by_user_name)}`}
      >
        {getInitials(res.created_by_user_name)}
      </span>
    );
  }
  return null;
};

// Tier 3 attribute: small circular badge showing how the booking arrived
// (channel). Phone for manually-entered calls, WhatsApp, web for the public
// booking page, mic for the voice agent. Quiet/secondary by design.
// The badge shell every attribute icon on a card shares. Neutral by default:
// how a booking arrived is context, not a warning, and four tinted circles in
// a row would each claim to be the important one.
const ATTR_BADGE =
  'inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]';

const renderChannelIcon = (res: Reservation): React.ReactNode => {
  const source = res.source || ReservationSource.MANUAL;
  if (source === ReservationSource.WHATSAPP) {
    return (
      <span className={`${ATTR_BADGE} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]`} title="WhatsApp" aria-label="Canale: WhatsApp">
        <MessageCircle className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (source === ReservationSource.GOOGLE) {
    return (
      <span className={ATTR_BADGE} title="Web" aria-label="Canale: Web">
        <Globe className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (source === ReservationSource.VOICE) {
    return (
      <span className={ATTR_BADGE} title="Agente vocale" aria-label="Canale: Agente vocale">
        <Mic className="h-3.5 w-3.5" />
      </span>
    );
  }
  return (
    <span className={ATTR_BADGE} title="Telefono" aria-label="Canale: Telefono">
      <Phone className="h-3.5 w-3.5" />
    </span>
  );
};

// Helper to format only time (Europe/Rome wall clock)
const formatTime = (isoString: string): string => getRomeTimePart(isoString);

// Human-readable "dd/mm alle HH:MM" for a Twilio callback timestamp (may be
// null/invalid on legacy rows). Returns '—' when unparseable.
const formatConfirmationTs = (iso: string | null | undefined): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' })} alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
};

// Tier 3 attribute: delivery status of the outbound booking-confirmation
// message (SMS or WhatsApp). Twilio's StatusCallback drives the state; we
// mirror it here as a small icon:
//   - queued / sent  → Send (grey)   tooltip: "Inviato il ..."
//   - delivered      → CheckCheck (green) tooltip: "Consegnato il ..."
//   - failed / undelivered → AlertOctagon (red) tooltip: "Consegna fallita"
// Renders nothing when we never sent a confirmation for this reservation.
const renderConfirmationIcon = (res: Reservation): React.ReactNode => {
  const status = res.confirmation_status;
  if (!status) return null;
  const channelLabel = res.confirmation_channel === 'sms' ? 'SMS' : 'WhatsApp';

  if (status === 'delivered') {
    const ts = formatConfirmationTs(res.confirmation_delivered_at);
    const title = `${channelLabel} consegnato il ${ts}`;
    return (
      <span className={`${ATTR_BADGE} bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]`} title={title} aria-label={title}>
        <CheckCheck className="h-3.5 w-3.5" />
      </span>
    );
  }

  if (status === 'failed' || status === 'undelivered') {
    const err = res.confirmation_error ? ` — ${res.confirmation_error}` : '';
    const title = `${channelLabel}: consegna fallita${err}`;
    return (
      <span className={`${ATTR_BADGE} bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]`} title={title} aria-label={title}>
        <AlertOctagon className="h-3.5 w-3.5" />
      </span>
    );
  }

  // queued / sent (or any unknown intermediate state)
  const ts = formatConfirmationTs(res.confirmation_sent_at);
  const title = `${channelLabel} inviato il ${ts} — in attesa di consegna`;
  return (
    <span className={ATTR_BADGE} title={title} aria-label={title}>
      <Send className="h-3.5 w-3.5" />
    </span>
  );
};

// Tier 3 attribute: a reminder went out for this booking (manual button in the
// modal's Comunicazione tab). Boolean only — the per-message delivery outcome
// lives in the timeline, so the badge stays a quiet "already done" marker that
// spares the staff a second reminder to the same customer.
const renderReminderIcon = (res: Reservation): React.ReactNode => {
  if (!res.reminder_sent) return null;
  return (
    <span className={ATTR_BADGE} title="Reminder inviato" aria-label="Reminder inviato">
      <BellRing className="h-3.5 w-3.5" />
    </span>
  );
};

// Payment badge (icon + tooltip) is now a shared component in
// PaymentBadge.tsx so the Dashboard's pending-reservations card and the
// Prenotazioni list can render the exact same chip without drift.
// `md` matches ATTR_BADGE, so the payment circle is the same size as the
// channel and confirmation ones sitting beside it.
const renderPaymentIcon = (res: Reservation): React.ReactNode => (
  <PaymentBadge reservation={res} size="md" />
);

// Tooltip label for the booking timestamp icon. Falls back gracefully when
// created_at is missing (pre-migration rows with no CREATE log to backfill).
// formatBookedAtBy folds in who took the booking — the card used to carry a
// separate initials circle for that, one glyph too many on a crowded row.
const formatBookedAtBy = (res: Reservation): string => {
  const base = formatBookedAt(res.created_at);
  if (res.source === ReservationSource.VOICE) return `${base} · presa dall'agente vocale`;
  if (res.created_by_user_name) return `${base} · presa da ${toTitleCase(res.created_by_user_name)}`;
  return base;
};

const formatBookedAt = (createdAt?: string | null): string => {
  if (!createdAt) return 'Data di prenotazione non disponibile';
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return 'Data di prenotazione non disponibile';
  return `Prenotata il ${d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' })} alle ${d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;
};

// Helper to calculate lateness in minutes (returns negative if reservation is in the future)
const getMinutesLate = (reservationTime: string): number => {
  const now = new Date();
  const match = reservationTime.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return 0;
  const [, year, month, day, hour, minute] = match;
  const resDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Math.floor((now.getTime() - resDate.getTime()) / 60000);
};

// Returns a Date whose wall-clock components (year, month, day, hour, minute)
// match the reservation's Europe/Rome wall clock. Used for day-diff math
// (e.g. "is this booking today or tomorrow?") without letting the viewer's
// browser timezone drift the answer.
const parseLocalDate = (iso: string): Date | null => {
  if (!iso) return null;
  const dateStr = getRomeDatePart(iso);
  if (!dateStr) return null;
  const timeStr = getRomeTimePart(iso);
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = (timeStr || '00:00').split(':').map(Number);
  return new Date(y, mo - 1, d, h, mi);
};

const startOfDay = (d: Date): Date => {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
};

// Default expected table-hold time in minutes when a reservation has no
// explicit `duration_minutes`. Kept in sync with the SQL fallback in
// server.ts (SHIFT_DEFAULT_DURATION_SQL).
const defaultDurationForShift = (shift: Shift | undefined | null): number =>
  shift === Shift.LUNCH ? 90 : 120;

const resolveDurationMinutes = (r: Pick<Reservation, 'duration_minutes' | 'shift'>): number => {
  const raw = r.duration_minutes;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return raw;
  return defaultDurationForShift(r.shift);
};

// Barra di riempimento della sala. Il colore segue quanto è piena; la tacca
// scura, quando la sala ha un limite configurato (Impostazioni → Canali di
// prenotazione), segna la soglia oltre la quale agente vocale e prenotazioni
// web smettono di assegnare tavoli da soli.
const RoomOccupancyMeter: React.FC<{
  percent: number;
  capPercent?: number | null;
  onBrand?: boolean;
  className?: string;
}> = ({ percent, capPercent, onBrand = false, className = '' }) => {
  const pct = Math.max(0, Math.min(100, Math.round(percent)));
  const cap = typeof capPercent === 'number' ? Math.max(0, Math.min(100, capPercent)) : null;
  const fill = pct >= 90
    ? 'bg-[var(--ds-critical-solid)]'
    : pct >= 60
      ? 'bg-[var(--ds-pending-solid)]'
      : 'bg-[var(--ds-seated-solid)]';
  return (
    <span
      className={`relative inline-block h-1.5 rounded-full overflow-hidden align-middle ${onBrand ? 'bg-white/30' : 'bg-[var(--ds-border)]'} ${className}`}
      role="img"
      aria-label={`Occupazione ${pct}%${cap !== null ? `, limite ${cap}%` : ''}`}
    >
      <span className={`block h-full rounded-full transition-[width] duration-300 ${fill}`} style={{ width: `${pct}%` }} />
      {cap !== null && cap < 100 && (
        <span
          aria-hidden="true"
          className={`absolute top-0 bottom-0 w-[2px] ${onBrand ? 'bg-white' : 'bg-[var(--ds-text-primary)]'}`}
          style={{ left: `calc(${cap}% - 1px)` }}
        />
      )}
    </span>
  );
};

// [start, start+duration) time-window overlap. Two windows overlap iff
// aStart < bEnd AND bStart < aEnd. Wall-clock ISO strings only (via
// parseLocalDate — avoids UTC drift).
const reservationsOverlap = (
  aStart: string,
  aDurationMin: number,
  bStart: string,
  bDurationMin: number,
): boolean => {
  const aStartDate = parseLocalDate(aStart);
  const bStartDate = parseLocalDate(bStart);
  if (!aStartDate || !bStartDate) return false;
  const aEnd = aStartDate.getTime() + aDurationMin * 60_000;
  const bEnd = bStartDate.getTime() + bDurationMin * 60_000;
  return aStartDate.getTime() < bEnd && bStartDate.getTime() < aEnd;
};

type PreflightWarning =
  | { kind: 'futureDate'; isoDate: string; weekday: string; date: string; time: string; daysAhead: number }
  | { kind: 'pastTime'; isoDate: string; date: string; time: string; minutesAgo: number }
  | { kind: 'sameDayDuplicate'; match: Reservation }
  | { kind: 'nearDuplicate'; match: Reservation; dayDiff: number };

// Looks for previously-booked entries that share the phone (or the name, when
// no phone is given) on the same day or within ±2 days. Also flags future
// dates so the host confirms when they're booking ahead. Skips CANCELLED
// rows — those should not block a new booking.
const computePreflightWarnings = (
  payload: Pick<Reservation, 'customer_name' | 'phone' | 'reservation_time'>,
  reservations: Reservation[],
): PreflightWarning[] => {
  const warnings: PreflightWarning[] = [];
  if (!payload.reservation_time) return warnings;

  const target = parseLocalDate(payload.reservation_time);
  if (!target) return warnings;
  const now = new Date();
  const targetDay = startOfDay(target);
  const today = startOfDay(now);
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysAhead = Math.round((targetDay.getTime() - today.getTime()) / msPerDay);

  if (daysAhead >= 1) {
    warnings.push({
      kind: 'futureDate',
      isoDate: payload.reservation_time,
      weekday: target.toLocaleDateString('it-IT', { weekday: 'long' }),
      date: target.toLocaleDateString('it-IT', { day: '2-digit', month: 'long', year: 'numeric' }),
      time: target.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      daysAhead,
    });
  } else if (daysAhead === 0 && target.getTime() < now.getTime()) {
    // Same-day booking whose time has already passed — e.g. it's 20:00 and the
    // host is entering a 13:00 slot for today. Almost always a mistake (wrong
    // day, or lunch when they meant dinner), so surface a confirmation.
    warnings.push({
      kind: 'pastTime',
      isoDate: payload.reservation_time,
      date: target.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long' }),
      time: target.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }),
      minutesAgo: Math.round((now.getTime() - target.getTime()) / 60000),
    });
  }

  const phoneDigits = (payload.phone || '').replace(/\D/g, '');
  const formName = (payload.customer_name || '').trim().toLowerCase();
  const seen = new Set<number>();

  for (const r of reservations) {
    if (!r.id || seen.has(r.id)) continue;
    if (r.reservation_status === ReservationStatus.CANCELLED) continue;
    if (r.reservation_status === ReservationStatus.DECLINED) continue;

    const rPhoneDigits = (r.phone || '').replace(/\D/g, '');
    const rName = (r.customer_name || '').trim().toLowerCase();

    const phoneMatch = phoneDigits.length >= 6 && rPhoneDigits === phoneDigits;
    const nameMatch = !phoneMatch && !!formName && rName === formName;
    if (!phoneMatch && !nameMatch) continue;

    const rDay = parseLocalDate(r.reservation_time);
    if (!rDay) continue;
    const diff = Math.abs(Math.round((startOfDay(rDay).getTime() - targetDay.getTime()) / msPerDay));
    if (diff > 2) continue;

    seen.add(r.id);
    if (diff === 0) {
      warnings.push({ kind: 'sameDayDuplicate', match: r });
    } else {
      warnings.push({ kind: 'nearDuplicate', match: r, dayDiff: diff });
    }
  }

  return warnings;
};

// Prefill applied when the new-reservation form auto-opens. Beyond
// name/phone it can carry a parsed booking (from a voice call or the inbox
// AI): date/time/guests/zone/notes pre-populate the form so staff only
// confirm. All fields optional — what's missing falls back to the defaults.
export interface NewReservationPrefill {
  customer_name?: string;
  phone?: string;
  date?: string;   // YYYY-MM-DD
  time?: string;   // HH:MM
  shift?: Shift;
  guests?: number;
  children?: number;
  notes?: string;
  location_preference?: 'INDOOR' | 'OUTDOOR';
}

interface ReservationListProps {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  onUpdateReservation: (r: Reservation) => void;
  // Silent local patch (no PUT). Used to reflect server-side promotions
  // that the socket broadcast might miss on the originating client.
  onPatchReservationLocal?: (r: Reservation) => void;
  onAddReservation: (r: Omit<Reservation, 'id'>) => Promise<Reservation>;
  onDeleteReservation: (id: number) => void;
  onMergeTables: (tableIds: number[], date: string, shift: Shift) => Promise<void>;
  onSplitTable: (tableId: number, date: string, shift: Shift) => Promise<void>;
  onUpdateTable: (table: Table) => Promise<void>;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  canEdit?: boolean;
  autoOpenNew?: boolean;
  // Optional pre-fill mode for the new-reservation form. Defaults to 'standard';
  // 'walkin' opens it with customer="Walk-in", arrival=ARRIVED, time=now.
  autoOpenNewKind?: 'standard' | 'walkin';
  // Optional prefill applied when the form auto-opens (used when converting a
  // voice call into a booking).
  newReservationPrefill?: NewReservationPrefill;
  onAutoOpenNewHandled?: () => void;
  modalOnly?: boolean;
  onModalClose?: () => void;
  // Pre-fill search term when navigating in from the global header search
  initialSearchTerm?: string;
  onInitialSearchTermHandled?: () => void;
  // When set (e.g. from a notification deep-link), open this booking's detail drawer.
  openReservationId?: number | null;
  onOpenReservationHandled?: () => void;
  // Global date/shift from App header (desktop)
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  onDateChange?: (date: Date) => void;
  onShiftFilterChange?: (filter: 'ALL' | 'LUNCH' | 'DINNER') => void;
  // True while the parent's first fetchData() hasn't returned yet. When true
  // and `reservations` is empty we render skeleton cards instead of the
  // "Nessuna prenotazione per questo servizio" empty state.
  isInitialLoading?: boolean;
}

export const ReservationList: React.FC<ReservationListProps> = ({
  reservations,
  banquetMenus,
  tables,
  rooms,
  onUpdateReservation,
  onPatchReservationLocal,
  onAddReservation,
  onDeleteReservation,
  onMergeTables,
  onSplitTable,
  onUpdateTable,
  showToast,
  canEdit = true,
  autoOpenNew = false,
  autoOpenNewKind = 'standard',
  newReservationPrefill,
  onAutoOpenNewHandled,
  modalOnly = false,
  onModalClose,
  initialSearchTerm,
  onInitialSearchTermHandled,
  openReservationId,
  onOpenReservationHandled,
  globalDate,
  globalShiftFilter: globalShiftFilterProp,
  onDateChange,
  onShiftFilterChange,
  isInitialLoading = false,
}) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  // Main View State
  const [viewMode, setViewMode] = useState<'LIST' | 'MAP'>('LIST');
  const [selectedDate, setSelectedDateLocal] = useState<string>(() => {
    if (globalDate) return formatLocalDate(globalDate) + 'T' + (new Date().getHours() < 17 ? '13:00' : '20:00');
    return formatLocalDateTime(new Date());
  });
  const setSelectedDate = (val: string) => {
    setSelectedDateLocal(val);
    const [datePart] = val.split('T');
    if (datePart && onDateChange) {
      const [y, m, d] = datePart.split('-').map(Number);
      if (y && m && d) onDateChange(new Date(y, m - 1, d));
    }
  };
  const [selectedShift, setSelectedShiftLocal] = useState<Shift | 'ALL'>(() => {
    if (globalShiftFilterProp === 'LUNCH') return Shift.LUNCH;
    if (globalShiftFilterProp === 'DINNER') return Shift.DINNER;
    return 'ALL';
  });
  const setSelectedShift = (val: Shift | 'ALL') => {
    setSelectedShiftLocal(val);
    if (onShiftFilterChange) {
      if (val === Shift.LUNCH) onShiftFilterChange('LUNCH');
      else if (val === Shift.DINNER) onShiftFilterChange('DINNER');
    }
  };

  // Sync from global header changes
  useEffect(() => {
    if (globalDate) {
      const time = selectedDate.split('T')[1] || '12:00';
      const newDateStr = formatLocalDate(globalDate) + 'T' + time;
      if (newDateStr.split('T')[0] !== selectedDate.split('T')[0]) {
        setSelectedDateLocal(newDateStr);
      }
    }
  }, [globalDate]);
  useEffect(() => {
    if (globalShiftFilterProp === 'LUNCH') setSelectedShiftLocal(Shift.LUNCH);
    else if (globalShiftFilterProp === 'DINNER') setSelectedShiftLocal(Shift.DINNER);
  }, [globalShiftFilterProp]);
  const [filterRoomId, setFilterRoomId] = useState<string | number>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterArrivalStatus, setFilterArrivalStatus] = useState<ArrivalStatus | 'ALL'>('ALL');
  const [filterGuestRange, setFilterGuestRange] = useState<'ALL' | '1-2' | '3-4' | '5-6' | '7+'>('ALL');
  const [filterHasAllergens, setFilterHasAllergens] = useState(false);
  const [filterHasNotes, setFilterHasNotes] = useState(false);
  const [filterNoTable, setFilterNoTable] = useState(false);
  const [filterSource, setFilterSource] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<'created-asc' | 'created-desc' | 'time-asc' | 'time-desc' | 'name-asc' | 'name-desc' | 'guests-asc' | 'guests-desc'>('created-asc');
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm ?? '');
  // Apply prefill from global header search, then notify the parent to clear it
  // so it doesn't re-apply on remount.
  useEffect(() => {
    if (initialSearchTerm !== undefined) {
      setSearchTerm(initialSearchTerm);
      onInitialSearchTermHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearchTerm]);
    const [activeMapRoomId, setActiveMapRoomId] = useState<string | number>('ALL');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  // Tick the header clock once per minute (aligned to start of each minute)
  useEffect(() => {
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      setCurrentTime(new Date());
      interval = setInterval(() => setCurrentTime(new Date()), 60_000);
    }, msUntilNextMinute);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  // Auto-advance the selected date when midnight rolls over while the user
  // is still viewing the previous "today". Manual navigation away from today
  // is preserved.
  const prevTodayRef = useRef<string>(formatLocalDate(new Date()));
  useEffect(() => {
    const newToday = formatLocalDate(currentTime);
    if (newToday !== prevTodayRef.current) {
      const selectedOnly = selectedDate.split('T')[0];
      if (selectedOnly === prevTodayRef.current) {
        const time = selectedDate.split('T')[1] || '12:00';
        setSelectedDate(`${newToday}T${time}`);
      }
      prevTodayRef.current = newToday;
    }
  }, [currentTime, selectedDate]);

  // Rooms closed only for the focused (date, shift) — the per-shift closures
  // managed from Sala & Tavoli. Kept separate from the extended
  // `rooms.is_closed` flag; `isRoomClosed` below combines the two. Loaded and
  // kept in sync further down, once focalDate/focalShift are known.
  const [closedRoomIdsForShift, setClosedRoomIdsForShift] = useState<Set<number>>(new Set());

  // A room is closed when it is either closed for an extended period or just
  // for the date+shift currently in focus.
  const isRoomClosed = (room: Room) => room.is_closed === true || closedRoomIdsForShift.has(room.id);
  const isRoomIdClosed = (roomId: number | null | undefined) =>
    roomId != null && rooms.some(r => r.id === roomId && isRoomClosed(r));

  useEffect(() => {
    const openRoomsList = rooms.filter(r => !isRoomClosed(r));
    if (openRoomsList.length === 0) return;
    const current = activeMapRoomId !== 'ALL' ? rooms.find(r => r.id === activeMapRoomId) : undefined;
    if (activeMapRoomId === 'ALL' || (current && isRoomClosed(current))) {
      setActiveMapRoomId(openRoomsList[0].id);
    }
  }, [rooms, activeMapRoomId, closedRoomIdsForShift]);

  // Auto-switch from 'ALL' to a specific shift (no 'Tutte' option in UI)
  useEffect(() => {
    if (selectedShift === 'ALL') {
      const hour = new Date().getHours();
      setSelectedShift(hour >= 11 && hour < 17 ? Shift.LUNCH : Shift.DINNER);
    }
  }, [selectedShift]);

  // Modal/Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  // Which screen of the edit form is showing. Editing only: a new booking is
  // still one scroll, and its payment and message sections do not exist yet.
  // Sections are never unmounted, only hidden — the table grid, the customer
  // lookup and every field keep their state while you move between steps.
  const [formStep, setFormStep] = useState(0);
  const formStepScrollRef = useRef<HTMLDivElement | null>(null);

  // Every open starts on Dettagli. Reopening a booking on the step you left
  // last time would put you on the message log with no idea why.
  useEffect(() => {
    if (isFormOpen) setFormStep(0);
  }, [isFormOpen]);

  // Each step starts at its own top. ModalShell owns the scroll container, so
  // we bring a sentinel into view rather than reaching for a ref it does not
  // expose — the same approach the banquet form uses.
  useEffect(() => {
    formStepScrollRef.current?.scrollIntoView({ block: 'start' });
  }, [formStep]);
  const [isSavingReservation, setIsSavingReservation] = useState(false);
  // Preflight modal: future-date confirmation + duplicate-booking warnings.
  // Holds the warnings list and the already-prepared payload, so a confirm
  // tap just calls onAddReservation without re-running validation.
  const [preflightModal, setPreflightModal] = useState<{
    warnings: PreflightWarning[];
    payload: Omit<Reservation, 'id'>;
  } | null>(null);
  // Channel picker shown after a successful save (both new bookings and edits).
  // `reservation` is the saved row so the picker knows the id + which channels
  // are available. Setting to null closes the picker and, when it was opened
  // from the save path, closes the parent form as well.
  const [confirmationPicker, setConfirmationPicker] = useState<{
    reservation: Reservation;
    fromSave: boolean;
  } | null>(null);
  const [sendingConfirmation, setSendingConfirmation] = useState<'sms' | 'whatsapp' | 'email' | null>(null);
  // `selectedAllergens` holds the INTOLERANCES (kept for the notes "Intolleranze:"
  // segment and backward compat); `selectedAllergies` holds the serious ALLERGIES.
  const [selectedAllergens, setSelectedAllergens] = useState<string[]>([]);
  const [selectedAllergies, setSelectedAllergies] = useState<string[]>([]);
  // Which of the two dietary tabs is active in the form.
  const [dietaryTab, setDietaryTab] = useState<'allergie' | 'intolleranze'>('allergie');
  const [selectedQuickNotes, setSelectedQuickNotes] = useState<string[]>([]);
  // Fetched from /settings/reservation-notes on mount so admins can edit the
  // chip list from Impostazioni. Each preset carries an optional lucide icon
  // key that we render both as a chip and next to the customer's name in the
  // reservation card. `has_quantity`/`variants` opt-in a small picker (e.g.
  // Stinco → 2 × maiale) that populates the structured `note_selections`
  // mirror on the reservation; chips without them keep the old toggle
  // behaviour and only feed `selectedQuickNotes` (free-text join).
  const [quickNotes, setQuickNotes] = useState<Array<{
    id: number;
    label: string;
    icon: string | null;
    has_quantity: boolean;
    variants: string[];
  }>>([]);
  // Structured picks made through the quantity/variant picker. Kept in sync
  // with the mirrored chips in the form and serialized to Reservation.note_selections.
  const [noteSelections, setNoteSelections] = useState<NoteSelection[]>([]);
  // Which chip's popover is open. Null = closed. Value = quickNotes.id.
  const [notePickerFor, setNotePickerFor] = useState<number | null>(null);
  // Fetched from /settings/reservation-allergens on mount, same rationale as
  // quickNotes: admins edit the list in Impostazioni → Opzioni prenotazioni.
  const [allergenPresets, setAllergenPresets] = useState<string[]>([]);
  const [showAllergensSection, setShowAllergensSection] = useState(false);
  const [showNotesSection, setShowNotesSection] = useState(false);
  // GDPR consent gating, read once from the legal settings:
  //  - marketing consent only in "advanced" mode;
  //  - allergy/health consent shown unless the tenant turned it off
  //    (Impostazioni → Legale). Both default ON until the fetch resolves.
  const [marketingEnabled, setMarketingEnabled] = useState(true);
  const [askHealthConsent, setAskHealthConsent] = useState(true);
  // Le sei config qui sotto passano da swrConfig: valore in cache applicato
  // subito, fetch di rinfresco in background — al rientro nella pagina niente
  // più sei round-trip che gocciolano re-render.
  useEffect(() => swrConfig('legalSettings', getLegalSettings, l => {
    setMarketingEnabled(l.legal_mode !== 'simple');
    setAskHealthConsent(l.ask_health_consent !== false); // undefined (old config) → true
  }), []);
  const [modalRoomFilter, setModalRoomFilter] = useState<string | number>('ALL');
  const [selectedTablesForMerge, setSelectedTablesForMerge] = useState<number[]>([]);
  const [mergeMode, setMergeMode] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{show: boolean, reservationId: number | null, customerName: string}>({show: false, reservationId: null, customerName: ''});

  // Revolut payment-link requests attached to the reservation currently open
  // in the modal. Loaded on open (only when editing) and mutated by the
  // "Richiedi acconto" flow. Socket updates keep the list live.
  const [paymentRequests, setPaymentRequests] = useState<PaymentRequest[]>([]);
  // Gateway that will actually take the deposit. The box used to be labelled
  // "Richiedi acconto (Revolut)" unconditionally, which lied once SumUp was
  // switched on. Defaults to the historical label until the fetch lands.
  const [paymentProviderLabel, setPaymentProviderLabel] = useState('Revolut');
  const [paymentAmount, setPaymentAmount] = useState<string>('');
  const [paymentDescription, setPaymentDescription] = useState<string>('');
  // Canale con cui inviare il link caparra. Un solo canale per invio: la scelta
  // è dell'operatore, non più un automatismo silenzioso WhatsApp→SMS. Email
  // esige un indirizzo, WhatsApp/SMS un telefono — vedi paymentChannelAvailable.
  const [paymentChannel, setPaymentChannel] = useState<'email' | 'whatsapp' | 'sms'>('whatsapp');
  const [isCreatingPayment, setIsCreatingPayment] = useState(false);
  const [copiedPaymentId, setCopiedPaymentId] = useState<number | null>(null);

  // Conto al tavolo (Fase 1 pay-at-table). One active bill per reservation
  // at a time; the waiter opens it with a total, guests scan the QR to pay
  // their share. Loaded on modal open (edit mode).
  const [bill, setBill] = useState<TableBillWithSplits | null>(null);
  const [billLoading, setBillLoading] = useState(false);
  const [billTotalInput, setBillTotalInput] = useState<string>('');
  const [billCoversInput, setBillCoversInput] = useState<string>('');
  const [billActionLoading, setBillActionLoading] = useState<'open' | 'open-and-notify' | 'notify' | 'close' | 'void' | 'import-pp' | 'print-qr' | 'print-preconto' | null>(null);
  // The QR and the pre-bill print live in the shared BillSheet rather than
  // inline in the card, so a bill looks and behaves the same here, on the
  // Pagamenti page and in OrderPad.
  const [billSheetOpen, setBillSheetOpen] = useState(false);
  // The bill stores a table_id; the card and the sheet want the number printed
  // on the table in the room.
  const billTableName = bill?.bill.table_id != null
    ? (tables.find(t => t.id === bill.bill.table_id)?.name ?? null)
    : null;
  // Whole pay-at-table UI is gated behind this flag; fetched once on mount.
  // Default false so we don't briefly flash the section before flags load.
  const [payAtTableEnabled, setPayAtTableEnabled] = useState(false);
  useEffect(() => swrConfig('featureFlags', getFeatureFlags, f => {
    setPayAtTableEnabled(PAY_AT_TABLE_UI_VISIBLE && !!f.pay_at_table_enabled);
  }), []);

  // Limiti di occupazione per sala: servono solo a disegnare la tacca sulla
  // barra di riempimento di ogni sala, così lo staff vede a colpo d'occhio
  // quali sale hanno superato la soglia oltre la quale le prenotazioni web
  // arrivano da confermare a mano. Nessun limite = nessuna tacca.
  const [roomCaps, setRoomCaps] = useState<RoomOccupancyCap[]>([]);
  useEffect(() => swrConfig('channelSettings', getChannelSettings, s => {
    setRoomCaps(s.room_occupancy_caps ?? []);
  }), []);

  // Opening hours drive the reservation-modal time dropdown and the arrival
  // heatmap. Fetched once on mount — the SettingsPage save flow invalidates
  // by full page reload today, so no live refresh needed here.
  const [openingHours, setOpeningHours] = useState<OpeningHoursRow[]>([]);
  useEffect(() => swrConfig('openingHours', getOpeningHours, setOpeningHours), []);

  // Outbound SMS/WhatsApp log for the reservation currently open in the modal.
  // Loaded on open (edit mode only). Same lifecycle as paymentRequests above.
  const [outboundMessages, setOutboundMessages] = useState<OutboundMessage[]>([]);
  const [outboundMessagesLoading, setOutboundMessagesLoading] = useState(false);
  // Free-form email composer: opened from the "Nuova email" button in the
  // Comunicazione con il cliente section. State stays hoisted so the compose
  // draft survives accidental clicks outside the modal (we close only on
  // explicit Annulla / Invia).
  const [customEmailOpen, setCustomEmailOpen] = useState(false);
  const [customEmailSubject, setCustomEmailSubject] = useState('');
  const [customEmailBody, setCustomEmailBody] = useState('');
  const [customEmailSending, setCustomEmailSending] = useState(false);
  const [unhideAllConfirm, setUnhideAllConfirm] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [showSortModal, setShowSortModal] = useState(false);
  // Mobile-only: sheet with per-shift channel toggles (voice + web). The
  // desktop header already carries these icons inline (BookingChannelsBar),
  // but there's no room in the mobile header — so we tuck them behind an
  // "Opzioni" button in the search+sort+filter row.
  const [showChannelsSheet, setShowChannelsSheet] = useState(false);
  const [cardMenuOpenId, setCardMenuOpenId] = useState<number | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cardMenuOpenId === null) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
        setCardMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [cardMenuOpenId]);

  // Load configurable quick-notes chips (editable from Impostazioni →
  // Opzioni prenotazioni). One-shot fetch on mount; failure keeps the list
  // empty rather than falling back to hardcoded defaults, since the backend
  // seeds the default set on first migration.
  useEffect(() => swrConfig('reservationNotePresets', getReservationNotePresets, rows => {
    setQuickNotes(rows.map(r => ({
      id: r.id,
      label: r.label,
      icon: r.icon || null,
      has_quantity: !!r.has_quantity,
      variants: (r.variants || []).map(v => v.label),
    })));
  }), []);

  useEffect(() => swrConfig('reservationAllergenPresets', getReservationAllergenPresets, rows => {
    setAllergenPresets(rows.map(r => r.label));
  }), []);

  // Split-view state
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);

  // Deep-link from a notification: highlight the target booking in the list
  // (read-only), don't open the edit modal — avoids accidental edits when the
  // user is just checking a new-reservation notification.
  useEffect(() => {
    if (openReservationId == null) return;
    const target = reservations.find(r => r.id === openReservationId);
    if (!target) {
      // Reservations may still be loading; wait. Once some are loaded but the
      // booking still isn't found, give up so the flag doesn't linger.
      if (reservations.length > 0) onOpenReservationHandled?.();
      return;
    }
    // Align the day filter so the booking is visible. Use target.shift instead
    // of 'ALL' so the auto-switch effect (which snaps 'ALL' to the current-hour
    // shift) doesn't drop us on the wrong turno for the booking.
    try {
      const dt = new Date(target.reservation_time);
      if (!isNaN(dt.getTime())) {
        const [, timePart] = selectedDate.split('T');
        setSelectedDate(formatLocalDate(dt) + 'T' + (timePart || '20:00'));
        if (target.shift) setSelectedShift(target.shift);
      }
    } catch { /* ignore */ }
    // Make sure the group containing the target is expanded so the row renders.
    // Grouping mirrors groupedReservations: DECLINED goes into 'cancelled'
    // (rejected requests share the annullate bucket), everything else keeps its
    // own state key.
    const targetGroupKey = (() => {
      const state = getReservationState(target);
      if (state === 'declined') return 'cancelled';
      return state;
    })();
    setExpandedGroups(prev => prev.has(targetGroupKey) ? prev : new Set(prev).add(targetGroupKey));
    setSelectedReservationId(target.id as number);
    setDetailDrawerOpen(true);
    setNewReservationFlashId(target.id as number);
    // Scroll after the row has had a chance to render/expand.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`reservation-row-${target.id}`);
        el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
    onOpenReservationHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openReservationId, reservations]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['pending', 'waiting', 'arrived', 'departing', 'noshow']));
  // Ticking clock (1/min) — drives the time-derived chip/glyph states
  // (In arrivo / In uscita) so the list and map update by themselves.
  const nowTick = useNow(60_000);
  // Time-derived states (In arrivo / In uscita) only apply to today's
  // service — past and future dates must read their persisted enum state.
  const isViewingToday = selectedDate.split('T')[0] === formatLocalDate(new Date(nowTick));

  const [newReservationFlashId, setNewReservationFlashId] = useState<number | null>(null);
  const [hoveredReservationId, setHoveredReservationId] = useState<number | null>(null);
  const [hoveredMapTableId, setHoveredMapTableId] = useState<number | null>(null);
  // Long-press support for touch (no hover on iPad). Holding a tavolo ~450ms
  // shows the name pill peek; tap continues to open the detail drawer. The
  // wasLongPressRef flag suppresses the synthetic click that follows touchend.
  const longPressTimerRef = useRef<number | null>(null);
  const wasLongPressRef = useRef(false);
  const longPressHideTimerRef = useRef<number | null>(null);
  const startMapLongPress = (tableId: number) => {
    wasLongPressRef.current = false;
    if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
    if (longPressHideTimerRef.current) window.clearTimeout(longPressHideTimerRef.current);
    longPressTimerRef.current = window.setTimeout(() => {
      wasLongPressRef.current = true;
      setHoveredMapTableId(tableId);
    }, 450);
  };
  const cancelMapLongPress = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const endMapLongPress = () => {
    cancelMapLongPress();
    if (wasLongPressRef.current) {
      if (longPressHideTimerRef.current) window.clearTimeout(longPressHideTimerRef.current);
      longPressHideTimerRef.current = window.setTimeout(() => setHoveredMapTableId(null), 1200);
    }
  };
  const [tooltipReservation, setTooltipReservation] = useState<{ id: number; type: 'allergen' | 'note' | 'tables' | 'bookedAt'; text: string; x: number; y: number } | null>(null);

  // Desktop breakpoint for split-view (>= 1024px)
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  // Draft restore banner — only shown while creating a new reservation
  const [draftBanner, setDraftBanner] = useState<{ savedAt: number } | null>(null);
  // True while the open form was started as a walk-in. Walk-ins must never
  // touch the RESERVATION_NEW draft: they open pre-filled ("Walk-in" + ora
  // corrente), so the debounced save considered them "typed content" and the
  // next standard booking restored a walk-in's current-time slot as its own.
  const [openedAsWalkIn, setOpenedAsWalkIn] = useState(false);

  // Map-view: assign a free table to an unassigned reservation
  const [assignTableModal, setAssignTableModal] = useState<Table | null>(null);
  // When a table has multiple non-cancelled reservations (double-seating),
  // clicking the table opens this chooser instead of jumping straight into
  // one specific reservation's edit view.
  const [tableChooserModal, setTableChooserModal] = useState<{ table: Table; reservations: Reservation[] } | null>(null);
  // Map-view: list of reservations without an assigned table for the selected date+shift
  const [showUnassignedModal, setShowUnassignedModal] = useState(false);

  // Map view canvas size tracking for responsive scaling.
  // Use a state-based callback ref so the measurement re-runs whenever the
  // canvas element mounts/unmounts (e.g. when viewMode or isPhone changes).
  const [mapCanvasNode, setMapCanvasNode] = useState<HTMLDivElement | null>(null);
  const [mapCanvasSize, setMapCanvasSize] = useState({ width: 0, height: 0 });
  // Mirror the layout mode chosen in Sale & Tavoli so both maps stay in sync.
  // 'auto' = tidy rows via computeAutoLayout; 'manual' = saved x/y positions.
  const [layoutMode, setLayoutMode] = useState<'auto' | 'manual'>(() => {
    if (typeof window === 'undefined') return 'auto';
    try {
      const saved = window.localStorage.getItem('floorPlan.layoutMode');
      return saved === 'manual' ? 'manual' : 'auto';
    } catch { return 'auto'; }
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => {
      try {
        const saved = window.localStorage.getItem('floorPlan.layoutMode');
        setLayoutMode(saved === 'manual' ? 'manual' : 'auto');
      } catch {}
    };
    // Re-check when the tab regains focus so toggles made elsewhere stick.
    window.addEventListener('focus', sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  useEffect(() => {
    if (!mapCanvasNode) {
      setMapCanvasSize({ width: 0, height: 0 });
      return;
    }
    const rect = mapCanvasNode.getBoundingClientRect();
    setMapCanvasSize({ width: rect.width, height: rect.height });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setMapCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(mapCanvasNode);
    return () => observer.disconnect();
  }, [mapCanvasNode]);

  // Phone breakpoint detection (< 640px = Tailwind's sm) for list-style Map view on smartphones
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setIsPhone(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Portal target for the page-level title/actions inside the global sticky header
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderSlot(document.getElementById('page-header-slot'));
  }, []);

  // Confirmation modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    suggestions?: Array<{ label: string; table: Table }>;
    onConfirm: () => void;
    onCancel: () => void;
    onSelectSuggestion?: (table: Table) => void;
  } | null>(null);

  // Customer picker (rubrica) modal
  const [isCustomerPickerOpen, setIsCustomerPickerOpen] = useState(false);

  // Inline customer autocomplete (name & phone fields in the reservation form)
  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([]);
  const [activeSuggestField, setActiveSuggestField] = useState<'name' | 'phone' | null>(null);
  const [matchedCustomerNoShows, setMatchedCustomerNoShows] = useState<number>(0);
  // Card #27 — blacklist: null = nessun match, altrimenti il motivo (anche '').
  const [matchedCustomerBlacklist, setMatchedCustomerBlacklist] = useState<string | null>(null);
  // Tracks which value we last queried for, so the dropdown closes on selection
  // (we set this to the just-selected name/phone to skip re-querying for it).
  const lastSuggestQueryRef = useRef<string>('');

  // Time slot options
  const LUNCH_TIMES = ['13:00', '13:30', '14:00'];
  const DINNER_TIMES = ['19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

  const getDefaultTime = (shift: Shift) => shift === Shift.LUNCH ? '13:00' : '20:00';

  const [formData, setFormData] = useState<Partial<Reservation>>({
      customer_name: '',
      guests: 2,
      children: 0,
      reservation_time: `${new Date().toISOString().split('T')[0]}T20:00`,
      shift: Shift.DINNER,
      duration_minutes: defaultDurationForShift(Shift.DINNER),
      payment_status: PaymentStatus.PENDING,
      table_id: undefined,
      enable_reminder: true,
      reminder_sent: false,
      arrival_status: ArrivalStatus.WAITING
  });

  // Debounced customer lookup for the active autocomplete field
  useEffect(() => {
    if (!activeSuggestField) {
      setCustomerSuggestions([]);
      return;
    }
    const raw = activeSuggestField === 'name'
      ? (formData.customer_name || '')
      : (formData.phone || '');
    const query = raw.trim();
    if (query.length < 2 || query === lastSuggestQueryRef.current) {
      setCustomerSuggestions([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const data = await getCustomers(query);
        if (!cancelled) setCustomerSuggestions(data.slice(0, 6));
      } catch {
        if (!cancelled) setCustomerSuggestions([]);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [activeSuggestField, formData.customer_name, formData.phone]);

  // Auto-detect exact phone match against fetched suggestions, so the no-show
  // warning surfaces even when the user types/pastes a known number directly.
  useEffect(() => {
    const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
    const typedPhone = digits(formData.phone);
    if (typedPhone.length < 6 || customerSuggestions.length === 0) return;
    const exact = customerSuggestions.find(c => digits(c.phone) === typedPhone);
    if (exact && (exact.no_show_count || 0) > 0) {
      setMatchedCustomerNoShows(exact.no_show_count || 0);
    }
    if (exact?.is_blacklisted) {
      setMatchedCustomerBlacklist(exact.blacklist_reason || '');
    }
  }, [customerSuggestions, formData.phone]);

  // Decide whether the rubrica's preferred table can be auto-assigned to the
  // booking currently in the form. Falls through silently if any condition
  // fails — the form keeps whatever the user already chose, and the floor
  // card will flag the mismatch later.
  const resolvePreferredTableForForm = (preferredTableId: number | null | undefined): { tableId: number; tableName: string } | null => {
    if (preferredTableId == null) return null;
    const table = tables.find(t => t.id === preferredTableId);
    if (!table) return null;
    if (isRoomIdClosed((table as any).room_id)) return null;
    const guests = Number(formData.guests || 0);
    const cap = Number((table as any).max_seats ?? table.seats ?? 0);
    if (guests > 0 && cap > 0 && guests > cap) return null;
    if (!formData.reservation_time || !formData.shift) return null;
    const date = formData.reservation_time.split('T')[0];
    if (isTableOccupied(table.id as number, date, formData.shift)) return null;
    return { tableId: table.id as number, tableName: table.name };
  };

  // Apply rubrica preferences after the user picks (or autocompletes) a
  // customer: prefill the table when free, and prepend allergie/dietary notes
  // to the booking notes so the kitchen sees them without an extra click.
  const applyCustomerPreferences = (c: Customer) => {
    const dietary = (c.dietary_notes || '').trim();
    let assigned: { tableId: number; tableName: string } | null = null;
    setFormData(prev => {
      const next: typeof prev = { ...prev };
      if ((prev.table_id == null || prev.table_id === undefined) && c.preferred_table_id) {
        assigned = resolvePreferredTableForForm(c.preferred_table_id);
        if (assigned) next.table_id = assigned.tableId;
      }
      if (dietary) {
        const existing = (prev.notes || '').trim();
        if (!existing.toLowerCase().includes(dietary.toLowerCase())) {
          next.notes = existing ? `${dietary}\n${existing}` : dietary;
        }
      }
      return next;
    });
    if (assigned) {
      showToast(`Tavolo preferito ${assigned.tableName} assegnato automaticamente.`, 'success');
    }
  };

  const applyCustomerSuggestion = (c: Customer) => {
    lastSuggestQueryRef.current = activeSuggestField === 'phone' ? (c.phone || '') : c.name;
    setFormData(prev => ({
      ...prev,
      customer_name: c.name,
      phone: c.phone || prev.phone || '',
      email: c.email || prev.email || '',
    }));
    setMatchedCustomerNoShows(c.no_show_count || 0);
    setMatchedCustomerBlacklist(c.is_blacklisted ? (c.blacklist_reason || '') : null);
    setActiveSuggestField(null);
    setCustomerSuggestions([]);
    applyCustomerPreferences(c);
  };

  // Per-shift table merges. Use the form's date+shift while the modal is open;
  // otherwise scope to the page's selectedDate/selectedShift (fallback if 'ALL').
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  const [isLoadingMerges, setIsLoadingMerges] = useState(false);
  const [hiddenTableIds, setHiddenTableIds] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  // Proposte AI di assegnazione tavolo (card dev board #26): poche per
  // natura (una per prenotazione senza tavolo), quindi si caricano tutte le
  // pendenti del tenant una volta e si tengono aggiornate via socket, senza
  // legarle al focalDate/focalShift del form (che con selectedShift='ALL'
  // coprirebbe solo metà servizio).
  const [tableAssignmentSuggestions, setTableAssignmentSuggestions] = useState<Map<number, TableAssignmentSuggestion>>(new Map());

  const focalDate = isFormOpen && formData.reservation_time
    ? formData.reservation_time.split('T')[0]
    : selectedDate.split('T')[0];
  const focalShift: Shift = isFormOpen && formData.shift
    ? formData.shift
    : (selectedShift !== 'ALL' ? selectedShift : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER));

  // Arrival heat-map for the reservation form's date+shift. One entry per
  // 30-min slot, summing covers across rooms; excludes the reservation being
  // edited plus no-shows/cancelled so the host sees expected arrivals only.
  // Thresholds scale with total dining-room seats so the coloring adapts to
  // restaurants of different sizes; fall back to fixed numbers if tables
  // haven't loaded yet.
  // Slot list for the reservation-form's current date+shift. Filters
  // opening_hours + disabled slots so operator-side choices match /prenota
  // and the voice-agent's `check-availability` output.
  const formSlots = useMemo(() => {
    const date = formData.reservation_time?.split('T')[0] ?? null;
    return getSlotsForDateShift(date, formData.shift, openingHours);
  }, [formData.reservation_time, formData.shift, openingHours]);

  const slotArrivalStats = useMemo(() => {
    if (!formData.reservation_time || !formData.shift) return null;
    const date = formData.reservation_time.split('T')[0];
    const slots = formSlots;
    if (slots.length === 0) return null;
    const totals = new Map<string, number>(slots.map(s => [s, 0]));
    for (const r of reservations) {
      if (r.id === (formData as Reservation).id) continue;
      if (r.reservation_status === ReservationStatus.CANCELLED) continue;
      if (r.reservation_status === ReservationStatus.DECLINED) continue;
      if (r.reservation_status === ReservationStatus.NO_SHOW) continue;
      if (r.shift !== formData.shift) continue;
      if (getRomeDatePart(r.reservation_time) !== date) continue;
      const hhmm = getRomeTimePart(r.reservation_time);
      if (hhmm && totals.has(hhmm)) {
        totals.set(hhmm, (totals.get(hhmm) || 0) + ((r.guests || 0) + (r.children || 0)));
      }
    }
    const totalSeats = tables.reduce((sum, t) => sum + (t.seats || 0), 0);
    const lowMax = totalSeats > 0 ? Math.max(4, Math.round(totalSeats * 0.15)) : 6;
    const highMin = totalSeats > 0 ? Math.max(lowMax + 1, Math.round(totalSeats * 0.30)) : 15;
    return slots.map(time => {
      const guests = totals.get(time) || 0;
      let level: 'empty' | 'low' | 'medium' | 'high';
      if (guests === 0) level = 'empty';
      else if (guests <= lowMax) level = 'low';
      else if (guests < highMin) level = 'medium';
      else level = 'high';
      return { time, guests, level };
    });
  }, [reservations, tables, formData.reservation_time, formData.shift, (formData as Reservation).id, formSlots]);

  // Refresh merges from the server. Used after local merge/split actions so
  // the originating client updates immediately even when the socket is offline.
  const refreshMerges = async (date: string, shift: Shift) => {
    try {
      const merges = await getTableMerges(date, shift);
      setTableMerges(merges);
    } catch (err) {
      console.error('Error fetching table merges:', err);
    }
  };

  const handleToggleTableHidden = async (table: Table) => {
    const isCurrentlyHidden = hiddenTableIds.has(table.id);
    try {
      if (isCurrentlyHidden) {
        await deleteTableHidden(focalDate, focalShift, table.id);
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          next.delete(table.id);
          return next;
        });
        showToast(`Tavolo ${table.name} riattivato`, 'success');
      } else {
        await createTableHidden(focalDate, focalShift, table.id);
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          next.add(table.id);
          return next;
        });
        showToast(`Tavolo ${table.name} nascosto per questo turno`, 'success');
      }
    } catch (err: any) {
      showToast(err?.message || 'Operazione non riuscita', 'error');
    }
  };

  const handleUnhideAllTables = async () => {
    if (hiddenTableIds.size === 0) return;
    const ids = [...hiddenTableIds];
    try {
      await Promise.all(ids.map(id => deleteTableHidden(focalDate, focalShift, id)));
      setHiddenTableIds(new Set());
      setShowHidden(false);
      showToast(`${ids.length} ${ids.length === 1 ? 'tavolo riattivato' : 'tavoli riattivati'} per questo turno`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Operazione non riuscita', 'error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoadingMerges(true);
    getTableMerges(focalDate, focalShift)
      .then(merges => { if (!cancelled) setTableMerges(merges); })
      .catch(err => {
        console.error('Error fetching table merges:', err);
        if (!cancelled) setTableMerges([]);
      })
      .finally(() => { if (!cancelled) setIsLoadingMerges(false); });
    return () => { cancelled = true; };
  }, [focalDate, focalShift]);

  useEffect(() => {
    let cancelled = false;
    getTableHidden(focalDate, focalShift)
      .then(rows => { if (!cancelled) setHiddenTableIds(new Set(rows.map(r => r.table_id))); })
      .catch(err => {
        console.error('Error fetching hidden tables:', err);
        if (!cancelled) setHiddenTableIds(new Set());
      });
    return () => { cancelled = true; };
  }, [focalDate, focalShift]);

  // Per-shift room closures for the focused date+shift, so a room closed from
  // Sala & Tavoli reads as closed here too (greyed tab, no new assignments).
  useEffect(() => {
    let cancelled = false;
    getRoomClosed(focalDate, focalShift)
      .then(rows => { if (!cancelled) setClosedRoomIdsForShift(new Set(rows.map(r => r.room_id))); })
      .catch(err => {
        console.error('Error fetching closed rooms:', err);
        if (!cancelled) setClosedRoomIdsForShift(new Set());
      });
    return () => { cancelled = true; };
  }, [focalDate, focalShift]);

  const { socket, isConnected } = useSocket();

  useEffect(() => {
    if (!socket) return;
    const matches = (m: TableMerge) => m.date === focalDate && m.shift === focalShift;
    const onCreated = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => {
        const existing = prev.findIndex(p => p.primary_id === m.primary_id);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = m;
          return next;
        }
        return [...prev, m];
      });
    };
    const onDeleted = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => prev.filter(p => p.primary_id !== m.primary_id));
    };
    socket.on('tableMerge:created', onCreated);
    socket.on('tableMerge:deleted', onDeleted);
    return () => {
      socket.off('tableMerge:created', onCreated);
      socket.off('tableMerge:deleted', onDeleted);
    };
  }, [socket, focalDate, focalShift]);

  useEffect(() => {
    if (!socket) return;
    const matches = (h: TableHiddenOverride) => h.date === focalDate && h.shift === focalShift;
    const onCreated = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.add(h.table_id);
        return next;
      });
    };
    const onDeleted = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.delete(h.table_id);
        return next;
      });
    };
    socket.on('tableHidden:created', onCreated);
    socket.on('tableHidden:deleted', onDeleted);
    return () => {
      socket.off('tableHidden:created', onCreated);
      socket.off('tableHidden:deleted', onDeleted);
    };
  }, [socket, focalDate, focalShift]);

  useEffect(() => {
    if (!socket) return;
    const matches = (c: RoomClosedOverride) => c.date === focalDate && c.shift === focalShift;
    const onCreated = (c: RoomClosedOverride) => {
      if (!matches(c)) return;
      setClosedRoomIdsForShift(prev => {
        const next = new Set(prev);
        next.add(c.room_id);
        return next;
      });
    };
    const onDeleted = (c: RoomClosedOverride) => {
      if (!matches(c)) return;
      setClosedRoomIdsForShift(prev => {
        const next = new Set(prev);
        next.delete(c.room_id);
        return next;
      });
    };
    socket.on('roomClosed:created', onCreated);
    socket.on('roomClosed:deleted', onDeleted);
    return () => {
      socket.off('roomClosed:created', onCreated);
      socket.off('roomClosed:deleted', onDeleted);
    };
  }, [socket, focalDate, focalShift]);

  useEffect(() => {
    let cancelled = false;
    getTableAssignmentSuggestions()
      .then(rows => {
        if (cancelled) return;
        setTableAssignmentSuggestions(new Map(rows.map(s => [s.reservation_id, s])));
      })
      .catch(err => console.error('Error fetching table assignment suggestions:', err));
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!socket) return;
    const onCreated = (s: TableAssignmentSuggestion) => {
      setTableAssignmentSuggestions(prev => new Map(prev).set(s.reservation_id, s));
    };
    const onResolved = (s: TableAssignmentSuggestion) => {
      setTableAssignmentSuggestions(prev => {
        if (prev.get(s.reservation_id)?.id !== s.id) return prev;
        const next = new Map(prev);
        next.delete(s.reservation_id);
        return next;
      });
    };
    socket.on('tableAssignmentSuggestion:created', onCreated);
    socket.on('tableAssignmentSuggestion:resolved', onResolved);
    return () => {
      socket.off('tableAssignmentSuggestion:created', onCreated);
      socket.off('tableAssignmentSuggestion:resolved', onResolved);
    };
  }, [socket]);

  const handleConfirmTableSuggestion = async (suggestion: TableAssignmentSuggestion) => {
    try {
      const { reservation } = await confirmTableAssignmentSuggestion(suggestion.id);
      setTableAssignmentSuggestions(prev => {
        const next = new Map(prev);
        next.delete(suggestion.reservation_id);
        return next;
      });
      showToast(`Tavolo ${suggestion.table_name || ''} assegnato a ${toTitleCase(reservation.customer_name)}`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Impossibile confermare il tavolo suggerito', 'error');
    }
  };

  const handleDismissTableSuggestion = async (suggestion: TableAssignmentSuggestion) => {
    setTableAssignmentSuggestions(prev => {
      const next = new Map(prev);
      next.delete(suggestion.reservation_id);
      return next;
    });
    try {
      await dismissTableAssignmentSuggestion(suggestion.id);
    } catch (err: any) {
      showToast(err?.message || 'Impossibile ignorare il suggerimento', 'error');
    }
  };

  const displayTables = useMemo(
    () => applyMerges(tables, tableMerges),
    [tables, tableMerges]
  );

  // For each reservation that shares its table with at least one other booking
  // in the same date+shift, compute its 1-based turno position and the total
  // number of turns. Cancelled bookings are ignored (they never happened);
  // DEPARTED ones stay in the count so the operator still sees who came first.
  const turnoIndexById = useMemo((): Map<number, { position: number; total: number }> => {
    const map = new Map<number, { position: number; total: number }>();
    const groups = new Map<string, Reservation[]>();
    for (const r of reservations) {
      if (r.table_id == null) continue;
      if (r.reservation_status === ReservationStatus.CANCELLED) continue;
      if (r.reservation_status === ReservationStatus.DECLINED) continue;
      const date = getRomeDatePart(r.reservation_time);
      const key = `${r.table_id}|${date}|${r.shift}`;
      const arr = groups.get(key);
      if (arr) arr.push(r); else groups.set(key, [r]);
    }
    for (const arr of groups.values()) {
      if (arr.length < 2) continue;
      arr.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
      arr.forEach((r, i) => map.set(r.id, { position: i + 1, total: arr.length }));
    }
    return map;
  }, [reservations]);

  // Filter Logic for Main List
  const activeFilterCount =
    (filterRoomId !== 'ALL' ? 1 : 0) +
    (filterStatus !== 'ALL' ? 1 : 0) +
    (filterArrivalStatus !== 'ALL' ? 1 : 0) +
    (filterGuestRange !== 'ALL' ? 1 : 0) +
    (filterHasAllergens ? 1 : 0) +
    (filterHasNotes ? 1 : 0) +
    (filterNoTable ? 1 : 0) +
    (filterSource !== 'ALL' ? 1 : 0);

  const matchesGuestRange = (guests: number): boolean => {
    switch (filterGuestRange) {
      case '1-2': return guests >= 1 && guests <= 2;
      case '3-4': return guests >= 3 && guests <= 4;
      case '5-6': return guests >= 5 && guests <= 6;
      case '7+': return guests >= 7;
      default: return true;
    }
  };

  const resetFilters = () => {
    setFilterRoomId('ALL');
    setFilterStatus('ALL');
    setFilterArrivalStatus('ALL');
    setFilterGuestRange('ALL');
    setFilterHasAllergens(false);
    setFilterHasNotes(false);
    setFilterNoTable(false);
    setFilterSource('ALL');
    setSortBy('created-asc');
  };

  // --- Grouped reservation list for split-view ---
  // Groups: waiting (in attesa), arrived (arrivati, no table), seated (seduti, has table), completed (departed)
  type ReservationGroup = { key: string; label: string; dotClass: string; items: Reservation[] };
  const groupedReservations = useMemo((): ReservationGroup[] => {
    const dateFiltered = reservations.filter(r => {
      const matchesDate = getRomeDatePart(r.reservation_time) === selectedDate.split('T')[0];
      const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
      const matchesRoom = filterRoomId === 'ALL'
        ? true
        : (() => {
            const table = r.table_id ? displayTables.find(t => t.id === r.table_id) : undefined;
            return !!table && table.room_id === filterRoomId;
          })();
      const matchesStatus = filterStatus === 'ALL' ? true : r.payment_status === filterStatus;
      const matchesArrival = filterArrivalStatus === 'ALL'
        ? true
        : (r.arrival_status || ArrivalStatus.WAITING) === filterArrivalStatus;
      const matchesGuests = matchesGuestRange(r.guests || 0);
      const matchesAllergens = !filterHasAllergens || (typeof r.notes === 'string' && /(Allergie|Intolleranze):/i.test(r.notes));
      const matchesNotes = !filterHasNotes || (typeof r.notes === 'string' && r.notes.trim().length > 0);
      const matchesNoTable = !filterNoTable || !r.table_id;
      const matchesSource = filterSource === 'ALL'
        ? true
        : (r.source ?? ReservationSource.MANUAL) === filterSource;
      const trimmedSearch = searchTerm.trim().toLowerCase();
      let matchesSearch = true;
      if (trimmedSearch) {
        const nameHit = !!r.customer_name && r.customer_name.toLowerCase().includes(trimmedSearch);
        const table = r.table_id ? displayTables.find(t => t.id === r.table_id) : undefined;
        const tableHit = !!table && table.name.toLowerCase().includes(trimmedSearch);
        matchesSearch = nameHit || tableHit;
      }
      return matchesDate && matchesShift && matchesRoom && matchesStatus && matchesArrival && matchesGuests && matchesAllergens && matchesNotes && matchesNoTable && matchesSource && matchesSearch;
    });

    const pending: Reservation[] = [];
    const waiting: Reservation[] = [];
    const arrived: Reservation[] = [];
    const departing: Reservation[] = [];
    const freed: Reservation[] = [];
    const noshow: Reservation[] = [];
    const cancelled: Reservation[] = [];

    // Group by the same timed state the row chips render, so a row can never
    // sit under an "Arrivato" header while its own badge reads "In uscita".
    for (const r of dateFiltered) {
      const state = isViewingToday ? getTimedReservationState(r, nowTick) : getReservationState(r);
      switch (state) {
        case 'pending':   pending.push(r); break;
        case 'cancelled':
        case 'declined':  cancelled.push(r); break;
        case 'noshow':    noshow.push(r); break;
        case 'freed':     freed.push(r); break;
        case 'departing': departing.push(r); break;
        case 'arrived':   arrived.push(r); break;
        default:          waiting.push(r); break; // 'waiting' + clock-derived 'arriving'
      }
    }

    // Each group respects the global sort selector so the toolbar actually
    // does something on the grouped card lists (desktop split + mobile).
    // 'freed' keeps its reverse-time bias only when sorting by reservation
    // time, so the most recently departed table surfaces first.
    const compare = (a: Reservation, b: Reservation): number => {
      switch (sortBy) {
        case 'created-asc': {
          const at = a.created_at ?? '';
          const bt = b.created_at ?? '';
          if (at && bt) return at.localeCompare(bt);
          if (at) return -1;
          if (bt) return 1;
          return a.id - b.id;
        }
        case 'created-desc': {
          const at = a.created_at ?? '';
          const bt = b.created_at ?? '';
          if (at && bt) return bt.localeCompare(at);
          if (at) return -1;
          if (bt) return 1;
          return b.id - a.id;
        }
        case 'time-asc': return a.reservation_time.localeCompare(b.reservation_time);
        case 'time-desc': return b.reservation_time.localeCompare(a.reservation_time);
        case 'name-asc': return (a.customer_name || '').localeCompare(b.customer_name || '', 'it', { sensitivity: 'base' });
        case 'name-desc': return (b.customer_name || '').localeCompare(a.customer_name || '', 'it', { sensitivity: 'base' });
        case 'guests-asc': return (a.guests || 0) - (b.guests || 0);
        case 'guests-desc': return (b.guests || 0) - (a.guests || 0);
        default: return 0;
      }
    };
    pending.sort(compare);
    waiting.sort(compare);
    arrived.sort(compare);
    departing.sort(compare);
    // Freed: keep "most recently departed first" only when the user is
    // sorting by reservation time; otherwise honor the global sort.
    freed.sort(sortBy === 'time-asc'
      ? (a, b) => b.reservation_time.localeCompare(a.reservation_time)
      : compare);
    noshow.sort(compare);
    cancelled.sort(compare);

    // Labels/dots come from the shared state meta so group headers can never
    // drift from the chips below them ('cancelled' keeps its plural label).
    const meta = (k: Exclude<ReservationStateKey, 'arriving'>) => RESERVATION_STATE_META[k];
    const dot = (k: Exclude<ReservationStateKey, 'arriving'>) => reservationStateDs(k).solid;
    return [
      { key: 'pending', label: meta('pending').label, dotClass: dot('pending'), items: pending },
      { key: 'waiting', label: meta('waiting').label, dotClass: dot('waiting'), items: waiting },
      { key: 'arrived', label: meta('arrived').label, dotClass: dot('arrived'), items: arrived },
      { key: 'departing', label: meta('departing').label, dotClass: dot('departing'), items: departing },
      { key: 'noshow', label: meta('noshow').label, dotClass: dot('noshow'), items: noshow },
      { key: 'freed', label: meta('freed').label, dotClass: dot('freed'), items: freed },
      { key: 'cancelled', label: 'Annullate', dotClass: dot('cancelled'), items: cancelled },
    ].filter(g => g.items.length > 0);
  }, [reservations, selectedDate, selectedShift, filterRoomId, filterStatus, filterArrivalStatus, filterGuestRange, filterHasAllergens, filterHasNotes, filterNoTable, filterSource, searchTerm, displayTables, sortBy, isViewingToday, nowTick]);

  const totalGroupedCount = groupedReservations.reduce((s, g) => s + g.items.length, 0);

  /* The headline numbers for the service. Deliberately NOT derived from
     `groupedReservations`: those are filtered by the search box and the filter
     panel, and a total that moves while you type isn't a total. Held at
     component scope because both the floor plan's strip and the phone's read
     the same three figures. */
  const dayShiftTotals = useMemo(() => {
    const forDayShift = reservations.filter(r =>
      getRomeDatePart(r.reservation_time) === selectedDate.split('T')[0]
      && (selectedShift === 'ALL' ? true : r.shift === selectedShift)
    );
    return {
      rows: forDayShift,
      guests: forDayShift.reduce((sum, r) => sum + (Number(r.guests) || 0), 0),
      count: forDayShift.length,
      unassigned: forDayShift.filter(r =>
        !r.table_id
        && r.reservation_status !== ReservationStatus.CANCELLED
        && r.reservation_status !== ReservationStatus.DECLINED
      ).length,
    };
  }, [reservations, selectedDate, selectedShift]);
  const totalGuestsForDayShift = dayShiftTotals.guests;
  const reservationCountForDayShift = dayShiftTotals.count;
  const unassignedCountForDayShift = dayShiftTotals.unassigned;

  // --- Search-first check-in (desktop cassa) ---
  // "/" focuses the search from anywhere; with a search term active, Enter
  // marks the single matching confirmed booking as arrived. Two keystrokes
  // and a surname: that's the whole check-in.
  const searchInputRef = useRef<HTMLInputElement>(null);
  const quickArriveCandidates = useMemo(() => {
    // Today only: browsing another date to look something up must never
    // check anyone in (Enter is muscle-memory for "run the search").
    if (!searchTerm.trim() || !isViewingToday) return [];
    return groupedReservations.find(g => g.key === 'waiting')?.items ?? [];
  }, [groupedReservations, searchTerm, isViewingToday]);

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setSearchTerm('');
      e.currentTarget.blur();
      return;
    }
    if (e.key !== 'Enter' || !searchTerm.trim()) return;
    e.preventDefault();
    if (quickArriveCandidates.length === 1) {
      handleSetReservationState(quickArriveCandidates[0], 'arrived');
      setSearchTerm(''); // input keeps focus: ready for the next surname
    } else if (quickArriveCandidates.length > 1) {
      showToast(`${quickArriveCandidates.length} prenotazioni confermate corrispondono — affina la ricerca`, 'info');
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      e.preventDefault();
      searchInputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const selectedReservation = selectedReservationId
    ? reservations.find(r => r.id === selectedReservationId) ?? null
    : null;

  // When a reservation with a table is selected, switch the map to that
  // reservation's room so the highlighted table is actually visible.
  useEffect(() => {
    if (!selectedReservation?.table_id) return;
    const table = displayTables.find(t => t.id === selectedReservation.table_id);
    if (!table) return;
    if (table.room_id !== activeMapRoomId) {
      setActiveMapRoomId(table.room_id);
    }
  }, [selectedReservation?.id, selectedReservation?.table_id, displayTables]);

  // Flash animation for newly arriving reservations
  useEffect(() => {
    if (newReservationFlashId !== null) {
      const timer = setTimeout(() => setNewReservationFlashId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [newReservationFlashId]);

  const selectedDateStr = selectedDate.split('T')[0];

  // --- Actions ---

  const handlePaymentAction = (reservation: Reservation) => {
    let newStatus = PaymentStatus.PAID_FULL;
    if (reservation.payment_status === PaymentStatus.PENDING) {
        newStatus = PaymentStatus.PAID_DEPOSIT; 
    } else if (reservation.payment_status === PaymentStatus.PAID_DEPOSIT) {
        newStatus = PaymentStatus.PAID_FULL;
    }

    onUpdateReservation({
        ...reservation,
        payment_status: newStatus
    });
  };

  const handleSendWhatsapp = async (res: Reservation) => {
      if (!res.phone) {
          showToast('Numero di telefono mancante per questa prenotazione.', 'error');
          return;
      }

      try {
          await sendWhatsAppConfirmation(res.id);
          showToast(`Conferma WhatsApp inviata a ${toTitleCase(res.customer_name)}`, 'success');
      } catch (error) {
          console.error('Error sending WhatsApp confirmation:', error);
          showToast('Errore durante l\'invio della conferma WhatsApp', 'error');
      }
  };

  // (Il vecchio handleSendReminder che marcava reminder_sent SENZA inviare
  // niente è stato rimosso: il reminder vero vive nel tab Comunicazione e
  // passa dal server — WhatsApp col template approvato, SMS finché non c'è.)

  // State keys, colors and the field patches live in ./reservationState —
  // the single source of truth shared with Reception, FloorPlan & co.

  const [stateChangeReservation, setStateChangeReservation] = useState<Reservation | null>(null);
  const [declineReservation, setDeclineReservation] = useState<Reservation | null>(null);

  const handleSetReservationState = (res: Reservation, state: Exclude<ReservationStateKey, 'arriving'>) => {
    const patch = reservationStatePatch(state);
    // Choosing "Arrivato" on an already-overdue table must stick: grant more
    // time, or the timed layer re-labels it "In uscita" on the next tick.
    if (state === 'arrived' && isOverdue(res, nowTick)) {
      patch.duration_minutes = extendedDurationMin(res, nowTick);
    }
    onUpdateReservation({ ...res, ...patch });
    showToast(`${toTitleCase(res.customer_name)}: stato → ${RESERVATION_STATE_META[state].label}`, 'success');
  };

  // --- Overdue-table prompt ------------------------------------------------
  // A seated party past its expected duration whose state nobody touched:
  // ask the room whether the guests are still there (+30') or the table is
  // actually free. Answers persist and sync to every device; a plain dismiss
  // only snoozes the question on this screen.
  const [overdueSnoozes, setOverdueSnoozes] = useState<Record<number, number>>({});
  // Tutti i tavoli in attesa di risposta, non solo il primo: a fine servizio
  // ne scadono parecchi insieme e chi e' in sala vuole sapere quanti ne restano
  // — e poterli togliere di mezzo in un colpo invece che uno per volta.
  const overdueQueue = useMemo(() => {
    if (!canEdit) return [] as Reservation[];
    const today = formatLocalDate(new Date(nowTick));
    return reservations.filter(r =>
      getRomeDatePart(r.reservation_time) === today &&
      getReservationState(r) === 'arrived' &&
      isOverdue(r, nowTick) &&
      (overdueSnoozes[r.id] ?? 0) <= nowTick
    );
  }, [reservations, nowTick, canEdit, overdueSnoozes]);
  const overduePromptRes = overdueQueue[0] ?? null;
  const snoozeOverduePrompt = (res: Reservation) => {
    setOverdueSnoozes(prev => ({ ...prev, [res.id]: nowTick + OVERDUE_SNOOZE_MIN * 60_000 }));
  };
  // Rimanda tutta la coda insieme. Come il rinvio singolo non cambia lo stato
  // di nessuna prenotazione: e' un "non ora", non un "libera i tavoli".
  const snoozeAllOverduePrompts = () => {
    const scadenza = nowTick + OVERDUE_SNOOZE_MIN * 60_000;
    setOverdueSnoozes(prev => {
      const next = { ...prev };
      for (const r of overdueQueue) next[r.id] = scadenza;
      return next;
    });
  };

  // Voice input handler
  const handleVoiceInput = async () => {
    if (!isVoiceSupported()) {
      showToast('Riconoscimento vocale non supportato dal browser', 'error');
      return;
    }

    setIsListening(true);
    showToast('Parla ora...', 'info');

    try {
      const transcript = await startListening();
      console.log('Voice transcript:', transcript);
      const parsed = parseReservationText(transcript);
      console.log('Parsed reservation:', parsed);

      // Update form with parsed values, keeping existing values if not parsed
      setFormData(prev => {
        const nextGuests = parsed.guests || prev.guests;
        const rawChildren = parsed.children ?? prev.children;
        const nextChildren = rawChildren != null && nextGuests != null
          ? Math.max(0, Math.min(rawChildren, nextGuests))
          : rawChildren;
        return {
          ...prev,
          customer_name: parsed.customer_name || prev.customer_name,
          guests: nextGuests,
          children: nextChildren,
          reservation_time: parsed.reservation_time || prev.reservation_time,
          shift: parsed.shift || prev.shift,
          phone: parsed.phone || prev.phone,
          notes: parsed.notes ? (prev.notes ? `${prev.notes}, ${parsed.notes}` : parsed.notes) : prev.notes,
        };
      });

      // Build summary of what was parsed
      const parsedFields: string[] = [];
      if (parsed.customer_name) parsedFields.push(`Nome: ${parsed.customer_name}`);
      if (parsed.guests) parsedFields.push(`${parsed.guests} persone`);
      if (parsed.children) parsedFields.push(`${parsed.children} bambin${parsed.children === 1 ? 'o' : 'i'}`);
      if (parsed.reservation_time) {
        const dt = new Date(parsed.reservation_time);
        parsedFields.push(`${dt.toLocaleDateString('it-IT')} ${dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
      }
      if (parsed.shift) parsedFields.push(parsed.shift === Shift.LUNCH ? 'Pranzo' : 'Cena');

      if (parsedFields.length > 0) {
        showToast(`Compilato: ${parsedFields.join(' · ')}`, 'success');
      } else {
        showToast(`Riconosciuto: "${transcript}"`, 'info');
      }
    } catch (error: any) {
      if (error.message === 'no-speech') {
        showToast('Nessun audio rilevato, riprova', 'error');
      } else if (error.message === 'audio-capture') {
        showToast('Microfono non disponibile', 'error');
      } else if (error.message === 'not-allowed') {
        showToast('Permesso microfono negato', 'error');
      } else {
        showToast('Errore riconoscimento vocale', 'error');
      }
    } finally {
      setIsListening(false);
    }
  };

  const handleEditClick = (res: Reservation) => {
      // Populate the form with the Europe/Rome wall-clock (naive local string
      // "YYYY-MM-DDTHH:MM"). The <input type="datetime-local"> and the shift
      // slot grid both expect this format. Using toISOString() here would
      // return UTC and shift the hour by the local offset.
      const romeDate = getRomeDatePart(res.reservation_time);
      const romeTime = getRomeTimePart(res.reservation_time);
      const formattedReservation = {
        ...res,
        reservation_time: romeDate && romeTime ? `${romeDate}T${romeTime}` : res.reservation_time,
      };
      setFormData(formattedReservation);

      // Extract allergies + intolerances from the notes' labelled segments.
      const dietary = parseDietary(res.notes, allergenPresets);
      setSelectedAllergies(dietary.allergies);
      setSelectedAllergens(dietary.intolerances);
      const existingAllergens = [...dietary.allergies, ...dietary.intolerances];

      // Structured picks are the authoritative source for chips with
      // has_quantity/varianti — take them straight from the reservation and
      // skip the free-text scan for those, so we don't double-count.
      const existingStructured = Array.isArray(res.note_selections) ? res.note_selections : [];
      setNoteSelections(existingStructured);
      const structuredIds = new Set(existingStructured.map(s => s.preset_id));
      // Extract quick notes (chips senza struttura): riconosciute per etichetta
      // nel testo libero, come nel vecchio flusso.
      const existingQuickNotes = quickNotes
        .filter(n => !structuredIds.has(n.id) && !n.has_quantity && n.variants.length === 0)
        .filter(n => res.notes?.toLowerCase().includes(n.label.toLowerCase()))
        .map(n => n.label);
      setSelectedQuickNotes(existingQuickNotes);

      // Clean notes: remove dietary + quick-note segments to avoid duplication
      let cleanedNotes = stripDietaryNote(res.notes);
      // Remove quick notes
      existingQuickNotes.forEach(note => {
        cleanedNotes = cleanedNotes.replace(new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|?\\s*', 'gi'), '');
      });
      // Clean up remaining separators and whitespace
      cleanedNotes = cleanedNotes.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/\s*\|\s*\|\s*/g, ' | ').trim();

      // Update formData with cleaned notes
      setFormData(prev => ({ ...prev, notes: cleanedNotes || '' }));

      // Show sections if they have content
      setShowAllergensSection(existingAllergens.length > 0);
      setShowNotesSection(existingQuickNotes.length > 0 || cleanedNotes.length > 0);

      const table = tables.find(t => t.id === res.table_id);
      setModalRoomFilter(table ? table.room_id : 'ALL');
      setIsEditing(true);
      setIsFormOpen(true);
  };

  const handleDeleteClick = (id: number, customerName: string) => {
      setDeleteConfirmModal({show: true, reservationId: id, customerName});
  }

  const handleConfirmDelete = () => {
      if (deleteConfirmModal.reservationId !== null) {
          onDeleteReservation(deleteConfirmModal.reservationId);
          showToast('Prenotazione eliminata', 'success');
      }
      setDeleteConfirmModal({show: false, reservationId: null, customerName: ''});
  }

  const handleCancelDelete = () => {
      setDeleteConfirmModal({show: false, reservationId: null, customerName: ''});
  }


  const handleOpenNew = (opts: { walkIn?: boolean; prefill?: NewReservationPrefill } = {}) => {
      const walkIn = !!opts.walkIn;
      const prefill = opts.prefill;
      // For a walk-in we use "now" (and derive the shift from current time), so the
      // operator only has to pick a table and confirm. For standard bookings we keep
      // the date/shift currently in view — unless the prefill carries a parsed
      // date/time/shift (inbox AI or voice call), which then wins.
      const now = new Date();
      const walkInShift: Shift = now.getHours() < 17 ? Shift.LUNCH : Shift.DINNER;
      // Shift from prefill: explicit, or derived from the prefilled time
      // (matches the backend rule hh<17 → LUNCH).
      const prefillShift: Shift | undefined = prefill?.shift
        ?? (prefill?.time ? (parseInt(prefill.time.split(':')[0], 10) < 17 ? Shift.LUNCH : Shift.DINNER) : undefined);
      const newShift = walkIn
        ? walkInShift
        : (prefillShift ?? (selectedShift === 'ALL' ? Shift.DINNER : selectedShift));
      const dateOnly = (!walkIn && prefill?.date) ? prefill.date : selectedDate.split('T')[0];
      // Walk-in = "adesso", ma dentro la finestra del turno: registrato alle
      // 11:18 il tavolo parte all'apertura (13:00), non a metà mattina.
      const clampToShiftWindow = (d: Date, shift: Shift): string => {
        const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const slots = shift === Shift.LUNCH ? LUNCH_TIMES : DINNER_TIMES;
        return hhmm < slots[0] ? slots[0] : hhmm > slots[slots.length - 1] ? slots[slots.length - 1] : hhmm;
      };
      // L'orario estratto dal messaggio può cadere su uno slot disabilitato:
      // il form non deve proporre un orario che non si può prenotare, quindi
      // aggancia lo slot disponibile più vicino e lascia la richiesta
      // originale in nota, così lo staff propone l'alternativa in chat.
      const daySlots = getSlotsForDateShift(dateOnly, newShift, openingHours);
      let prefillTime = prefill?.time;
      let requestedTimeNote = '';
      if (!walkIn && prefillTime && daySlots.length > 0 && !daySlots.includes(prefillTime)) {
        const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
        const requested = toMin(prefillTime);
        const nearest = daySlots.reduce((best, s) =>
          Math.abs(toMin(s) - requested) < Math.abs(toMin(best) - requested) ? s : best, daySlots[0]);
        requestedTimeNote = `Orario richiesto: ${prefillTime}`;
        prefillTime = nearest;
      }
      const reservationTime = walkIn
        ? `${formatLocalDate(now)}T${clampToShiftWindow(now, walkInShift)}`
        : `${dateOnly}T${prefillTime || getDefaultTime(newShift)}`;
      // Zona richiesta → nota leggibile: il form assegna il tavolo a mano, ma
      // così lo staff vede subito "esterno/interno" accanto alla richiesta.
      const zoneHint = prefill?.location_preference === 'OUTDOOR' ? 'Zona: esterno'
        : prefill?.location_preference === 'INDOOR' ? 'Zona: interno' : '';
      const prefillNotes = walkIn ? '' : [zoneHint, requestedTimeNote, prefill?.notes?.trim()].filter(Boolean).join(' · ');
      setFormData({
        customer_name: prefill?.customer_name || (walkIn ? 'Walk-in' : ''),
        phone: prefill?.phone || undefined,
        guests: (!walkIn && prefill?.guests && prefill.guests > 0) ? Math.trunc(prefill.guests) : 2,
        children: (!walkIn && prefill?.children && prefill.children > 0) ? Math.trunc(prefill.children) : 0,
        reservation_time: reservationTime,
        shift: newShift,
        payment_status: PaymentStatus.PENDING,
        table_id: undefined,
        enable_reminder: walkIn ? false : true,
        reminder_sent: false,
        arrival_status: walkIn ? ArrivalStatus.ARRIVED : ArrivalStatus.WAITING,
        notes: prefillNotes,
        duration_minutes: defaultDurationForShift(newShift),
        // Il consenso allergie compare (e si auto-spunta) solo quando viene
        // inserito un allergene — vedi l'effect dedicato. Una nuova prenotazione
        // parte senza allergeni, quindi senza consenso.
        consent_data_health: undefined,
      });
      setSelectedAllergens([]);
      setSelectedAllergies([]);
      setDietaryTab('allergie');
      setSelectedQuickNotes([]);
      setNoteSelections([]);
      setNotePickerFor(null);
      setShowAllergensSection(false);
      setShowNotesSection(false);
      setModalRoomFilter('ALL');
      setMatchedCustomerNoShows(0);
      setMatchedCustomerBlacklist(null);
      setIsEditing(false);
      setIsFormOpen(true);

      setOpenedAsWalkIn(walkIn);

      // Drafts only apply to standard bookings — a walk-in is always "now".
      if (!walkIn) {
        const existing = loadDraft<{
          formData: Partial<Reservation>;
          selectedAllergens: string[];
          selectedQuickNotes: string[];
        }>(DRAFT_KEYS.RESERVATION_NEW);
        // Una bozza nata da un walk-in (arrivo già segnato) non è una bozza:
        // è lo stato iniziale di un altro flusso, salvato per sbaglio prima
        // che i walk-in venissero esclusi dal salvataggio. Scartala invece
        // di proporre "riprendi" con l'orario corrente di ieri.
        const isWalkInRelic = existing?.data?.formData?.arrival_status === ArrivalStatus.ARRIVED;
        if (isWalkInRelic) {
          clearDraft(DRAFT_KEYS.RESERVATION_NEW);
          setDraftBanner(null);
        } else {
          setDraftBanner(existing ? { savedAt: existing.savedAt } : null);
        }
      } else {
        setDraftBanner(null);
      }
  };

  // Auto-open new reservation form when triggered from outside (e.g. Dashboard CTA)
  useEffect(() => {
    if (autoOpenNew) {
      handleOpenNew({ walkIn: autoOpenNewKind === 'walkin', prefill: newReservationPrefill });
      onAutoOpenNewHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenNew]);

  // In modal-only mode, notify parent when the form closes
  const wasFormOpenRef = useRef(false);
  useEffect(() => {
    if (modalOnly && wasFormOpenRef.current && !isFormOpen) {
      onModalClose?.();
    }
    wasFormOpenRef.current = isFormOpen;
  }, [isFormOpen, modalOnly, onModalClose]);

  // Load the reservation's payment requests when the modal opens in edit
  // mode. Resets when closed / when creating a new reservation.
  useEffect(() => {
    if (!isFormOpen || !isEditing || !formData.id) {
      setPaymentRequests([]);
      setPaymentAmount('');
      setPaymentDescription('');
      return;
    }
    let cancelled = false;
    getPaymentRequests(formData.id as number)
      .then(rows => { if (!cancelled) setPaymentRequests(rows); })
      .catch(err => console.warn('[payments] load failed:', err?.message || err));
    return () => { cancelled = true; };
  }, [isFormOpen, isEditing, formData.id]);

  // Which gateway is live, for the deposit box label. Cheap and auth-only;
  // refetched per open so flipping the provider in Settings shows up without
  // a page reload.
  useEffect(() => {
    if (!isFormOpen || !isEditing) return;
    let cancelled = false;
    getActivePaymentProvider()
      .then(r => { if (!cancelled && r?.label) setPaymentProviderLabel(r.label); })
      .catch(err => console.warn('[payments] active provider load failed:', err?.message || err));
    return () => { cancelled = true; };
  }, [isFormOpen, isEditing]);

  // Load outbound SMS/WhatsApp log for this reservation. Same trigger as
  // paymentRequests — only in edit mode, once per open.
  useEffect(() => {
    if (!isFormOpen || !isEditing || !formData.id) {
      setOutboundMessages([]);
      return;
    }
    let cancelled = false;
    setOutboundMessagesLoading(true);
    getReservationMessages(formData.id as number)
      .then(rows => { if (!cancelled) setOutboundMessages(rows); })
      .catch(err => console.warn('[outbound-messages] load failed:', err?.message || err))
      .finally(() => { if (!cancelled) setOutboundMessagesLoading(false); });
    return () => { cancelled = true; };
  }, [isFormOpen, isEditing, formData.id]);

  // Live inbound-email delivery: when the IMAP service (or the Resend inbound
  // webhook) inserts a new inbound row for this reservation, append it to the
  // timeline without waiting for a refetch.
  useEffect(() => {
    if (!socket || !isFormOpen || !isEditing || !formData.id) return;
    const reservationId = formData.id as number;
    const onInbound = (row: OutboundMessage) => {
      if (!row || row.reservation_id !== reservationId) return;
      setOutboundMessages(prev => {
        if (prev.some(m => m.id === row.id)) return prev;
        // Keep chronological order (oldest first) so the newly arrived reply
        // slots into the right position instead of always jumping to the end.
        const next = [...prev, row];
        next.sort((a, b) => new Date(a.sent_at).getTime() - new Date(b.sent_at).getTime());
        return next;
      });
    };
    socket.on('inboundEmail:received', onInbound);
    return () => { socket.off('inboundEmail:received', onInbound); };
  }, [socket, isFormOpen, isEditing, formData.id]);

  // Quali canali possono ricevere il link, dato ciò che la prenotazione ha in
  // rubrica: email serve un indirizzo, WhatsApp/SMS un telefono. Il server
  // rifiuta comunque un canale non configurato (SMTP/Twilio spenti) con un 400
  // chiaro — qui muto solo ciò che l'operatore vede mancare.
  const paymentChannelAvailable = {
    email: !!(formData.email && formData.email.trim()),
    whatsapp: !!(formData.phone && formData.phone.trim()),
    sms: !!(formData.phone && formData.phone.trim()),
  };

  // Se il canale selezionato diventa indisponibile (l'operatore cancella il
  // telefono o l'email mentre compila), ripiega sul primo disponibile invece
  // di lasciare selezionato un canale che fallirebbe.
  useEffect(() => {
    if (paymentChannelAvailable[paymentChannel]) return;
    const fallback = (['whatsapp', 'email', 'sms'] as const).find(c => paymentChannelAvailable[c]);
    if (fallback) setPaymentChannel(fallback);
  }, [paymentChannelAvailable.email, paymentChannelAvailable.whatsapp, paymentChannelAvailable.sms, paymentChannel]);

  // Card #28 — revoca del link dalla lista "Richieste già inviate". La
  // conferma two-tap sta nella riga; qui solo la chiamata e il refresh.
  const [revokingPaymentId, setRevokingPaymentId] = useState<number | null>(null);
  const handleRevokePaymentRequest = async (paymentRequestId: number) => {
    setRevokingPaymentId(paymentRequestId);
    try {
      const result = await revokePaymentRequest(paymentRequestId);
      setPaymentRequests(prev => prev.map(pr => pr.id === paymentRequestId ? result.payment_request : pr));
      showToast('Link revocato: non è più pagabile', 'success');
    } catch (err) {
      showToast((err as Error).message || 'Revoca fallita', 'error');
    } finally {
      setRevokingPaymentId(null);
    }
  };

  const handleCreatePaymentRequest = async () => {
    if (!formData.id) return;
    const amount = Number(String(paymentAmount).replace(',', '.'));
    if (!Number.isFinite(amount) || amount <= 0) {
      showToast('Inserisci un importo valido', 'error');
      return;
    }
    if (!paymentChannelAvailable[paymentChannel]) {
      showToast('Canale di invio non disponibile per questa prenotazione', 'error');
      return;
    }
    setIsCreatingPayment(true);
    try {
      const created = await createPaymentRequest({
        reservation_id: formData.id as number,
        amount,
        description: paymentDescription.trim() || undefined,
        channel: paymentChannel,
      });
      setPaymentRequests(prev => [created, ...prev]);
      setPaymentAmount('');
      setPaymentDescription('');
      const channelLabel = paymentChannel === 'email' ? 'via email' : paymentChannel === 'sms' ? 'via SMS' : 'via WhatsApp';
      showToast(`Link di pagamento inviato ${channelLabel}`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore creazione link di pagamento', 'error');
    } finally {
      setIsCreatingPayment(false);
    }
  };

  const copyPaymentLink = async (pr: PaymentRequest) => {
    if (!pr.checkout_url) return;
    try {
      await navigator.clipboard.writeText(pr.checkout_url);
      setCopiedPaymentId(pr.id);
      setTimeout(() => setCopiedPaymentId(prev => prev === pr.id ? null : prev), 1500);
    } catch {
      showToast('Copia non riuscita, apri il link manualmente', 'error');
    }
  };

  // Load the reservation's active bill (if any) when the modal opens in
  // edit mode. 404 → no active bill, so the form to open one is shown.
  // Skipped entirely when the pay-at-table feature is off — the section
  // won't render anyway and we avoid a wasted 403.
  useEffect(() => {
    if (!isFormOpen || !isEditing || !formData.id || !payAtTableEnabled) {
      setBill(null);
      setBillTotalInput('');
      setBillCoversInput('');
      return;
    }
    let cancelled = false;
    setBillLoading(true);
    billsApiService.getBill(formData.id as number)
      .then(row => { if (!cancelled) setBill(row); })
      .catch(err => console.warn('[bill] load failed:', err?.message || err))
      .finally(() => { if (!cancelled) setBillLoading(false); });
    return () => { cancelled = true; };
  }, [isFormOpen, isEditing, formData.id, payAtTableEnabled]);

  // Live bill events from the backend: apply only to the bill currently
  // displayed. Life-cycle events (opened/closed/voided) carry the TableBill
  // row directly; split events (claimed/paid/released/abandoned/settled)
  // carry only {bill_id, split_id, ...} — we react by refetching, which is
  // cheap and gives us the authoritative paid_cents/claimed_cents/residual.
  useEffect(() => {
    if (!socket || !isFormOpen || !isEditing || !formData.id) return;
    const reservationId = formData.id as number;

    const refetch = () => {
      billsApiService.getBill(reservationId)
        .then(row => setBill(row))
        .catch(err => console.warn('[bill] refetch failed:', err?.message || err));
    };

    const onOpened = (row: TableBill) => {
      if (!row || row.reservation_id !== reservationId) return;
      setBill({ bill: row, splits: [], paid_cents: 0, claimed_cents: 0, residual_cents: row.total_cents });
    };
    const onClosedOrVoided = (row: TableBill) => {
      if (!row || row.reservation_id !== reservationId) return;
      setBill(prev => (prev && prev.bill.id === row.id ? null : prev));
    };
    const onSplitEvent = (payload: { bill_id?: number }) => {
      setBill(prev => {
        if (!prev || !payload || prev.bill.id !== payload.bill_id) return prev;
        refetch();
        return prev;
      });
    };
    const onSettled = (row: TableBill) => {
      if (!row || row.reservation_id !== reservationId) return;
      setBill(prev => {
        if (!prev || prev.bill.id !== row.id) return prev;
        return { ...prev, bill: row, paid_cents: prev.bill.total_cents, residual_cents: 0 };
      });
    };

    socket.on('bill:opened', onOpened);
    socket.on('bill:closed', onClosedOrVoided);
    socket.on('bill:voided', onClosedOrVoided);
    socket.on('bill:split-claimed', onSplitEvent);
    socket.on('bill:split-paid', onSplitEvent);
    socket.on('bill:split-released', onSplitEvent);
    socket.on('bill:split-abandoned', onSplitEvent);
    socket.on('bill:split-refunded', onSplitEvent);
    socket.on('bill:settled', onSettled);
    return () => {
      socket.off('bill:opened', onOpened);
      socket.off('bill:closed', onClosedOrVoided);
      socket.off('bill:voided', onClosedOrVoided);
      socket.off('bill:split-claimed', onSplitEvent);
      socket.off('bill:split-paid', onSplitEvent);
      socket.off('bill:split-released', onSplitEvent);
      socket.off('bill:split-abandoned', onSplitEvent);
      socket.off('bill:split-refunded', onSplitEvent);
      socket.off('bill:settled', onSettled);
    };
  }, [socket, isFormOpen, isEditing, formData.id]);

  const handleOpenBill = async (opts?: { notify?: boolean }) => {
    if (!formData.id) return;
    const euros = Number(String(billTotalInput).replace(',', '.'));
    if (!Number.isFinite(euros) || euros <= 0) {
      showToast('Inserisci un totale valido', 'error');
      return;
    }
    const coversNum = Number(billCoversInput);
    const notify = !!opts?.notify;
    setBillActionLoading(notify ? 'open-and-notify' : 'open');
    try {
      const created = await billsApiService.openBill(formData.id as number, {
        total_cents: Math.round(euros * 100),
        covers: Number.isFinite(coversNum) && coversNum > 0 ? coversNum : undefined,
      });
      setBill(created);
      setBillTotalInput('');
      setBillCoversInput('');
      if (!notify) {
        showToast('Conto aperto', 'success');
        return;
      }
      // The bill row is committed; the notify call is a best-effort follow-up.
      // If it fails, the bill is still open and the waiter can retry via
      // "Invia link al cliente" without re-opening the bill.
      try {
        const delivery = await billsApiService.notifyBillLink(formData.id as number);
        showToast(`Conto aperto e link inviato via ${delivery.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`, 'success');
      } catch (notifyErr: any) {
        showToast(notifyErr?.message || 'Conto aperto, ma invio del link non riuscito', 'error');
      }
    } catch (err: any) {
      showToast(err?.message || 'Errore apertura conto', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  // Fase 2 ibrida: il conto arriva già compilato dalla comanda Passepartout
  // (righe + totale + coperti). Il nome tavolo del gestionale di norma
  // coincide con quello del tavolo CRM assegnato alla prenotazione.
  const handleImportBillFromPassepartout = async (ppTavolo: string) => {
    if (!formData.id) return;
    const tavolo = ppTavolo.trim();
    if (!tavolo) {
      showToast('Assegna un tavolo alla prenotazione per importare il conto', 'error');
      return;
    }
    setBillActionLoading('import-pp');
    try {
      const created = await billsApiService.openBill(formData.id as number, {
        source: 'passepartout',
        pp_tavolo: tavolo,
      });
      setBill(created);
      showToast(`Conto importato dal gestionale: €${(created.bill.total_cents / 100).toFixed(2).replace('.', ',')}`, 'success');
    } catch (err: any) {
      // Nome tavolo che non combacia col gestionale (il server ha già provato
      // le varianti tipografiche): si chiede all'operatore il nome esatto e
      // si ritenta, invece di lasciarlo davanti a un vicolo cieco.
      if (err?.data?.error === 'no_comanda') {
        const manual = window.prompt(
          `Nessuna comanda trovata sul tavolo "${tavolo}" nel gestionale.\n` +
          'Scrivi il nome ESATTO del tavolo come appare in Passepartout (punto e spazi compresi):',
          tavolo
        );
        const retry = manual?.trim();
        setBillActionLoading(null);
        if (retry && retry !== tavolo) {
          await handleImportBillFromPassepartout(retry);
          return;
        }
      }
      showToast(err?.data?.message || err?.message || 'Importazione dal gestionale non riuscita', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  const handleNotifyBill = async () => {
    if (!formData.id || !bill) return;
    setBillActionLoading('notify');
    try {
      const delivery = await billsApiService.notifyBillLink(formData.id as number);
      showToast(`Link inviato al cliente via ${delivery.channel === 'whatsapp' ? 'WhatsApp' : 'SMS'}`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Invio del link non riuscito', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  // Due stampe sulla termica in sala: il foglietto solo-QR da appoggiare al
  // tavolo e il preconto completo con le righe (che il QR ce l'ha in fondo).
  const handlePrintBill = async (kind: 'QR' | 'PRECONTO') => {
    if (!bill) return;
    setBillActionLoading(kind === 'QR' ? 'print-qr' : 'print-preconto');
    try {
      await printBill(bill.bill.id, kind);
      // "in coda", non "stampato": la conferma vera e' la termica che parte.
      showToast(kind === 'QR' ? 'QR inviato alla stampante' : 'Preconto inviato alla stampante', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Stampa non riuscita', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  // Refund di una quota (PR 6): il bottone chiede conferma al secondo tap.
  const [refundConfirmSplitId, setRefundConfirmSplitId] = useState<number | null>(null);
  const [refundingSplitId, setRefundingSplitId] = useState<number | null>(null);
  const handleRefundSplit = async (splitId: number) => {
    if (refundConfirmSplitId !== splitId) {
      setRefundConfirmSplitId(splitId);
      return;
    }
    setRefundConfirmSplitId(null);
    setRefundingSplitId(splitId);
    try {
      const result = await billsApiService.refundSplit(splitId);
      if (formData.id) {
        const fresh = await billsApiService.getBill(formData.id as number).catch(() => null);
        setBill(fresh);
      }
      showToast(result.reopened ? 'Quota rimborsata, conto riaperto' : 'Quota rimborsata', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Rimborso non riuscito', 'error');
    } finally {
      setRefundingSplitId(null);
    }
  };

  const handleCloseBill = async (opts?: { cash_settled_cents?: number; tip_cents?: number }) => {
    if (!bill) return;
    setBillActionLoading('close');
    try {
      await billsApiService.closeBill(bill.bill.id, opts);
      setBill(null);
      showToast('Conto chiuso', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore chiusura conto', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  const handleVoidBill = async () => {
    if (!bill) return;
    if (!window.confirm('Annullare il conto? Il QR non sarà più valido.')) return;
    setBillActionLoading('void');
    try {
      await billsApiService.voidBill(bill.bill.id);
      setBill(null);
      showToast('Conto annullato', 'success');
    } catch (err: any) {
      showToast(err?.message || 'Errore annullamento conto', 'error');
    } finally {
      setBillActionLoading(null);
    }
  };

  const closeBookingForm = useCallback(() => {
    setIsFormOpen(false);
    setMergeMode(false);
    setSelectedTablesForMerge([]);
  }, []);

  const handleRestoreDraft = () => {
      const existing = loadDraft<{
        formData: Partial<Reservation>;
        selectedAllergens: string[];
        selectedAllergies?: string[];
        selectedQuickNotes: string[];
        noteSelections?: NoteSelection[];
      }>(DRAFT_KEYS.RESERVATION_NEW);
      if (!existing) {
        setDraftBanner(null);
        return;
      }
      setFormData(existing.data.formData);
      setSelectedAllergens(existing.data.selectedAllergens || []);
      setSelectedAllergies(existing.data.selectedAllergies || []);
      setSelectedQuickNotes(existing.data.selectedQuickNotes || []);
      setNoteSelections(existing.data.noteSelections || []);
      setShowAllergensSection((existing.data.selectedAllergens || []).length > 0 || (existing.data.selectedAllergies || []).length > 0);
      setShowNotesSection(
        (existing.data.selectedQuickNotes || []).length > 0 ||
        (existing.data.noteSelections || []).length > 0 ||
        !!existing.data.formData?.notes
      );
      setDraftBanner(null);
      showToast('Bozza ripristinata', 'success');
  };

  const handleDiscardDraft = () => {
      clearDraft(DRAFT_KEYS.RESERVATION_NEW);
      setDraftBanner(null);
  };

  // Persist a draft of the new-reservation form (debounced).
  // Only while creating (not editing) and only if the user has typed something
  // meaningful. Walk-ins are excluded: open pre-filled, so "has content" is
  // true dal primo render e la bozza inquinava le prenotazioni standard.
  useEffect(() => {
    if (!isFormOpen || isEditing || openedAsWalkIn) return;

    const hasContent =
      (formData.customer_name && formData.customer_name.trim() !== '') ||
      (formData.phone && formData.phone.trim() !== '') ||
      (formData.email && formData.email.trim() !== '') ||
      (formData.notes && formData.notes.trim() !== '') ||
      selectedAllergens.length > 0 ||
      selectedAllergies.length > 0 ||
      selectedQuickNotes.length > 0 ||
      noteSelections.length > 0;
    if (!hasContent) return;

    const timer = setTimeout(() => {
      saveDraft(DRAFT_KEYS.RESERVATION_NEW, {
        formData,
        selectedAllergens,
        selectedAllergies,
        selectedQuickNotes,
        noteSelections,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [isFormOpen, isEditing, openedAsWalkIn, formData, selectedAllergens, selectedAllergies, selectedQuickNotes, noteSelections]);

  // The allergy/health-data consent is only relevant when the booking actually
  // records an allergen (special-category data, art. 9 GDPR). Auto-tick it the
  // moment an allergen is added — staff shouldn't confirm it every time — and
  // clear it when none remain. A manual un-tick (false) is preserved (the
  // guard only acts on a null/undefined value).
  useEffect(() => {
    if (!isFormOpen || !askHealthConsent) return;
    const hasAllergens = selectedAllergens.length > 0 || selectedAllergies.length > 0;
    setFormData(prev => {
      if (hasAllergens && prev.consent_data_health == null) return { ...prev, consent_data_health: true };
      if (!hasAllergens && prev.consent_data_health != null) return { ...prev, consent_data_health: undefined };
      return prev;
    });
  }, [selectedAllergens, selectedAllergies, askHealthConsent, isFormOpen]);

  // --- Helper Logic ---

  const getBanquetForTable = (table_id: number, checkDate: string, checkShift: Shift): BanquetMenu | null => {
    for (const b of banquetMenus) {
      if (b.event_date !== checkDate) continue;
      if (b.shift !== checkShift) continue;
      const ids = Array.isArray(b.table_ids) ? b.table_ids : [];
      if (ids.includes(table_id)) return b;
    }
    return null;
  };

  // Double-seating aware: a table is "occupied" for the currently-edited
  // reservation only if some other booking's [start, start+duration) window
  // overlaps ours. Banquets still lock the whole shift (they have no
  // duration column).
  const isTableOccupied = (table_id: number, checkDate: string, checkShift: Shift) => {
    const myStart = formData.reservation_time;
    const myShift = formData.shift || checkShift;
    const myDuration = resolveDurationMinutes({ duration_minutes: formData.duration_minutes, shift: myShift });
    const occupiedByReservation = myStart ? reservations.some(r => {
      if (r.table_id !== table_id) return false;
      if (r.id === formData.id) return false;
      if (r.arrival_status === ArrivalStatus.DEPARTED) return false;
      if (r.reservation_status === ReservationStatus.CANCELLED) return false;
      if (r.reservation_status === ReservationStatus.DECLINED) return false;
      if (getRomeDatePart(r.reservation_time) !== checkDate) return false;
      return reservationsOverlap(myStart, myDuration, r.reservation_time, resolveDurationMinutes(r));
    }) : false;
    if (occupiedByReservation) return true;
    return !!getBanquetForTable(table_id, checkDate, checkShift);
  };

  const getReservationForTable = (table_id: number) => {
      return reservations.find(r =>
          r.table_id === table_id &&
          getRomeDatePart(r.reservation_time) === selectedDate.split('T')[0] &&
          (selectedShift === 'ALL' || r.shift === selectedShift) &&
          r.arrival_status !== ArrivalStatus.DEPARTED &&
          r.reservation_status !== ReservationStatus.CANCELLED &&
          r.reservation_status !== ReservationStatus.DECLINED
      );
  }

  // All non-cancelled, non-departed reservations for a table in the current
  // date+shift, sorted by time. Used by the Map view to render the multi-turno
  // badge and open the chooser when the operator clicks a shared table.
  const getReservationsForTable = (table_id: number): Reservation[] => {
      const dateOnly = selectedDate.split('T')[0];
      return reservations
          .filter(r =>
              r.table_id === table_id &&
              getRomeDatePart(r.reservation_time) === dateOnly &&
              (selectedShift === 'ALL' || r.shift === selectedShift) &&
              r.arrival_status !== ArrivalStatus.DEPARTED &&
              r.reservation_status !== ReservationStatus.CANCELLED &&
              r.reservation_status !== ReservationStatus.DECLINED
          )
          .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
  };

  // Returns either a reservation OR a banquet that occupies this table for the
  // currently selected date+shift in the map view. Used by Map view to render
  // banquet-occupied tables with their own visual state.
  const getOccupierForTable = (table_id: number): { kind: 'reservation'; data: Reservation } | { kind: 'banquet'; data: BanquetMenu } | null => {
      const date = selectedDate.split('T')[0];
      const res = getReservationForTable(table_id);
      if (res) return { kind: 'reservation', data: res };
      if (selectedShift === 'ALL') {
          const banquetLunch = getBanquetForTable(table_id, date, Shift.LUNCH);
          if (banquetLunch) return { kind: 'banquet', data: banquetLunch };
          const banquetDinner = getBanquetForTable(table_id, date, Shift.DINNER);
          if (banquetDinner) return { kind: 'banquet', data: banquetDinner };
          return null;
      }
      const banquet = getBanquetForTable(table_id, date, selectedShift);
      if (banquet) return { kind: 'banquet', data: banquet };
      return null;
  };

  // Returns either a reservation OR a banquet that occupies this table for the
  // form's date+shift. The picker uses the result to mark the table as occupied
  // and to display the occupier's name in the red pill.
  const getOccupierForTableInForm = (table_id: number): { kind: 'reservation'; data: Reservation } | { kind: 'banquet'; data: BanquetMenu } | null => {
      if (!formData.reservation_time || !formData.shift) return null;
      const date = formData.reservation_time.split('T')[0];
      const myDuration = resolveDurationMinutes({ duration_minutes: formData.duration_minutes, shift: formData.shift });
      const res = reservations.find(r =>
          r.table_id === table_id &&
          getRomeDatePart(r.reservation_time) === date &&
          r.id !== formData.id &&
          r.arrival_status !== ArrivalStatus.DEPARTED &&
          r.reservation_status !== ReservationStatus.CANCELLED &&
          r.reservation_status !== ReservationStatus.DECLINED &&
          reservationsOverlap(formData.reservation_time!, myDuration, r.reservation_time, resolveDurationMinutes(r))
      );
      if (res) return { kind: 'reservation', data: res };
      const banquet = getBanquetForTable(table_id, date, formData.shift);
      if (banquet) return { kind: 'banquet', data: banquet };
      return null;
  };

  // Backwards-compatible: returns only the reservation (or null) for legacy callers.
  const getReservationForTableInForm = (table_id: number): Reservation | null => {
      const occ = getOccupierForTableInForm(table_id);
      return occ && occ.kind === 'reservation' ? occ.data : null;
  };

  const handleTableSelection = (table: Table) => {
      const guests = formData.guests || 1;

      // Check if table is too small
      if (table.seats < guests) {
          const closedRoomIds = new Set(rooms.filter(isRoomClosed).map(r => r.id));
          // Find suitable alternatives (use displayTables for current shift context)
          const suitableTables = displayTables
              .filter(t => !closedRoomIds.has(t.room_id))
              .filter(t => t.seats >= guests)
              .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
              .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
              .filter(t => !displayTables.some(other =>
                  other.merged_with && other.merged_with.length > 0 &&
                  other.merged_with.map(id => Number(id)).includes(Number(t.id))
              ))
              .filter(t => !hiddenTableIds.has(t.id))
              .sort((a, b) => a.seats - b.seats);

          if (suitableTables.length > 0) {
              const suggestions = suitableTables.slice(0, 3).map(t => {
                  const room = rooms.find(r => r.id === t.room_id);
                  return {
                      label: `${t.name} - ${t.seats} posti (${room?.name})`,
                      table: t
                  };
              });

              setConfirmModal({
                  isOpen: true,
                  title: '⚠️ Capienza Insufficiente',
                  message: `Il tavolo ${table.name} ha solo ${table.seats} posti ma la prenotazione è per ${guests} ospiti.`,
                  suggestions: suggestions,
                  onConfirm: () => {
                      setFormData({...formData, table_id: table.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                      showToast(`Tavolo ${table.name} assegnato`, 'success');
                  },
                  onCancel: () => {
                      showToast('Selezione annullata. Scegli un tavolo più grande.', 'info');
                      setConfirmModal(null);
                  },
                  onSelectSuggestion: (suggestedTable: Table) => {
                      setFormData({...formData, table_id: suggestedTable.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                      showToast(`Tavolo ${suggestedTable.name} assegnato automaticamente`, 'success');
                  }
              });
          } else {
              // No suitable tables available - warn but allow
              setConfirmModal({
                  isOpen: true,
                  title: '⚠️ Capienza Insufficiente',
                  message: `Il tavolo ${table.name} ha solo ${table.seats} posti ma la prenotazione è per ${guests} ospiti.\n\nNon ci sono tavoli disponibili più grandi.`,
                  onConfirm: () => {
                      setFormData({...formData, table_id: table.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                  },
                  onCancel: () => {
                      showToast('Selezione annullata.', 'info');
                      setConfirmModal(null);
                  }
              });
          }
          return;
      }

      // Assign the table (if capacity is sufficient)
      setFormData({...formData, table_id: table.id});
      setSelectedTablesForMerge([]);
  };

  const handleAutoAssign = () => {
      if (!formData.guests || !formData.reservation_time || !formData.shift) return;

      const closedRoomIds = new Set(rooms.filter(isRoomClosed).map(r => r.id));

      const availableTables = displayTables
        .filter(t => !closedRoomIds.has(t.room_id))
        .filter(t => t.seats >= (formData.guests || 0))
        .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
        .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
        .filter(t => !displayTables.some(other =>
            other.merged_with && other.merged_with.length > 0 &&
            other.merged_with.map(id => Number(id)).includes(Number(t.id))
        ))
        .filter(t => !hiddenTableIds.has(t.id))
        .sort((a, b) => a.seats - b.seats);

      if (availableTables.length > 0) {
          setFormData({ ...formData, table_id: availableTables[0].id });
          showToast(`Tavolo ${availableTables[0].name} assegnato automaticamente.`, 'success');
      } else {
          showToast("Nessun tavolo ottimale trovato.", 'error');
      }
  };

  // Dispatch a confirmation message on the chosen channel. Called by the
  // picker modal after either a fresh save or a click on the "Invia conferma"
  // button on the card. All three channels hit the backend now — email uses
  // the SMTP config from Impostazioni.
  // Pull the freshest outbound_messages for the given reservation and drop
  // them into local state. Used to refresh the "Comunicazione con il cliente"
  // timeline immediately after a send (conferma email/WA/SMS, mail libera)
  // so the new row shows up without a page refresh. Only touches state when
  // the reservation is currently open in the form; otherwise the load-on-
  // open effect will refetch anyway.
  const refreshOutboundTimeline = async (reservationId: number) => {
      if (formData.id !== reservationId) return;
      try {
          const rows = await getReservationMessages(reservationId);
          setOutboundMessages(rows);
      } catch { /* non-fatal — timeline will refresh on next open */ }
  };

  // Reminder manuale dal tab Comunicazione: il server sceglie il canale
  // (WhatsApp col template approvato, SMS finché non c'è) e marca
  // reminder_sent — qui si specchia lo stato e si aggiorna la timeline.
  const [reminderSending, setReminderSending] = useState(false);
  const handleSendReminder = async () => {
      const id = formData.id;
      if (!id || reminderSending) return;
      setReminderSending(true);
      try {
          const res = await sendReservationReminder(id as number);
          setFormData(prev => ({ ...prev, reminder_sent: true }));
          showToast(res.channel === 'whatsapp' ? 'Reminder inviato su WhatsApp' : 'Reminder inviato via SMS', 'success');
          refreshOutboundTimeline(id as number);
      } catch (err: any) {
          showToast(err?.data?.message || err?.message || 'Invio reminder non riuscito', 'error');
      } finally {
          setReminderSending(false);
      }
  };

  const handlePickConfirmationChannel = async (channel: 'sms' | 'whatsapp' | 'email') => {
      const target = confirmationPicker?.reservation;
      if (!target) return;
      const fromSave = confirmationPicker?.fromSave === true;

      // Toast wording depends on whether the backend actually flipped the
      // status. On PENDING → CONFIRMED we surface both facts in one line so
      // the operator sees "confermata e inviata" instead of just "inviata".
      const buildToast = (channelLabel: string, promoted: boolean) =>
        promoted
          ? `Prenotazione confermata e ${channelLabel} inviato a ${toTitleCase(target.customer_name)}`
          : `Conferma ${channelLabel} inviata a ${toTitleCase(target.customer_name)}`;

      if (channel === 'email') {
          if (!target.email) {
              showToast('Email cliente mancante.', 'error');
              return;
          }
          if (!target.id) {
              showToast('Prenotazione non ancora salvata.', 'error');
              return;
          }
          try {
              setSendingConfirmation('email');
              const result = await sendEmailConfirmation(target.id);
              showToast(buildToast('email', !!result.status_changed), 'success');
              // Patch local state from the response so the card flips off
              // "Da confermare" even if the socket:updated broadcast is
              // dropped (was happening on tablets with flaky wifi).
              if (result.reservation && onPatchReservationLocal) {
                  onPatchReservationLocal(result.reservation);
              }
              setConfirmationPicker(null);
              if (fromSave) setIsFormOpen(false);
              else await refreshOutboundTimeline(target.id);
          } catch (err: any) {
              console.error('Errore invio conferma email:', err);
              showToast(err?.message || 'Errore invio conferma email', 'error');
          } finally {
              setSendingConfirmation(null);
          }
          return;
      }

      if (!target.phone) {
          showToast('Numero di telefono mancante per questa prenotazione.', 'error');
          return;
      }
      if (!target.id) {
          showToast('Prenotazione non ancora salvata.', 'error');
          return;
      }

      try {
          setSendingConfirmation(channel);
          const result = await sendWhatsAppConfirmation(target.id, channel);
          const label = channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
          showToast(buildToast(label, !!result.status_changed), 'success');
          // Same defensive patch as the email branch — see comment above.
          if (result.reservation && onPatchReservationLocal) {
              onPatchReservationLocal(result.reservation);
          }
          setConfirmationPicker(null);
          if (fromSave) setIsFormOpen(false);
          else await refreshOutboundTimeline(target.id);
      } catch (err: any) {
          console.error('Errore invio conferma:', err);
          showToast(err?.message || `Errore invio conferma ${channel}`, 'error');
      } finally {
          setSendingConfirmation(null);
      }
  };

  // Send the free-form email composed in the custom-email modal. Refreshes
  // the outbound_messages list on success so the new row shows up in the
  // timeline immediately without waiting for the next open.
  const handleSendCustomEmail = async () => {
      if (!formData.id) {
          showToast('Prenotazione non ancora salvata.', 'error');
          return;
      }
      if (!formData.email) {
          showToast('Email cliente mancante.', 'error');
          return;
      }
      const subject = customEmailSubject.trim();
      const body = customEmailBody.trim();
      if (!subject) {
          showToast('Inserisci un oggetto per la mail.', 'error');
          return;
      }
      if (!body) {
          showToast('Il corpo della mail non può essere vuoto.', 'error');
          return;
      }
      try {
          setCustomEmailSending(true);
          await sendCustomEmail(formData.id as number, subject, body);
          showToast(`Email inviata a ${formData.email}`, 'success');
          setCustomEmailOpen(false);
          setCustomEmailSubject('');
          setCustomEmailBody('');
          await refreshOutboundTimeline(formData.id as number);
      } catch (err: any) {
          console.error('Errore invio email libera:', err);
          showToast(err?.message || 'Errore invio email', 'error');
      } finally {
          setCustomEmailSending(false);
      }
  };

  // Performs the actual save and closes the form. Shared between the direct
  // submit path (no warnings) and the preflight confirm button.
  const performSave = async (dataToSave: Omit<Reservation, 'id'> | Reservation) => {
      try {
          setIsSavingReservation(true);
          let saved: Reservation;
          if (isEditing) {
              await onUpdateReservation(dataToSave as Reservation);
              saved = dataToSave as Reservation;
          } else {
              saved = await onAddReservation(dataToSave as Omit<Reservation, 'id'>);
              clearDraft(DRAFT_KEYS.RESERVATION_NEW);
          }

          setDraftBanner(null);
          setPreflightModal(null);

          // If the booking is contactable, offer to send a confirmation before
          // closing the form. Otherwise close directly — nothing to prompt for.
          const canContact = !!(saved.phone && saved.phone.trim()) || !!(saved.email && saved.email.trim());
          if (canContact && !saved.confirmation_sent_at) {
              setConfirmationPicker({ reservation: saved, fromSave: true });
          } else {
              setIsFormOpen(false);
          }
      } finally {
          setIsSavingReservation(false);
      }
  };

  const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      // Every field these checks guard lives on step 1, and Salva is live on
      // all three. Without this jump, saving from Pagamenti or Comunicazione
      // would refuse and leave the operator staring at a screen with nothing
      // wrong on it — the first check does not even raise a toast.
      if (!formData.customer_name || !formData.reservation_time) { setFormStep(0); return; }
      // Almeno un canale di contatto è richiesto (telefono OPPURE email).
      // Le prenotazioni web arrivano spesso con sola email — non forziamo il
      // telefono quando l'email è già presente.
      const hasPhone = !!(formData.phone && formData.phone.trim());
      const hasEmail = !!(formData.email && formData.email.trim());
      if (!hasPhone && !hasEmail) {
          setFormStep(0);
          showToast('Inserisci un contatto (telefono o email).', 'error');
          return;
      }
      if (isSavingReservation) return;

      // Combine dietary flags, quick notes, and additional notes.
      // Le scelte strutturate finiscono ANCHE in `notes` in forma leggibile
      // ("2× Stinco (maiale)"), così restano visibili nelle vecchie viste che
      // non conoscono ancora note_selections; l'aggregazione cucina usa solo
      // il campo strutturato, quindi niente rischio di doppio conteggio.
      const allergensText = buildDietaryNote(selectedAllergies, selectedAllergens);
      const structuredText = noteSelections.length > 0
          ? noteSelections.map(s => `${s.quantity}× ${s.label}${s.variant ? ` (${s.variant})` : ''}`).join(', ')
          : '';
      const quickNotesText = selectedQuickNotes.length > 0
          ? selectedQuickNotes.join(', ')
          : '';
      const additionalNotes = formData.notes || '';
      const combinedNotes = [allergensText, structuredText, quickNotesText, additionalNotes].filter(Boolean).join(' | ');

      const dataToSave = {
          ...formData,
          notes: combinedNotes || undefined,
          note_selections: noteSelections,
      };

      // Skip preflight checks when editing — duplicates/future dates only matter
      // for new bookings. The edit path can hit the same date deliberately.
      if (!isEditing) {
          const warnings = computePreflightWarnings(
              {
                  customer_name: dataToSave.customer_name || '',
                  phone: dataToSave.phone,
                  reservation_time: dataToSave.reservation_time || '',
              },
              reservations,
          );
          if (warnings.length > 0) {
              setPreflightModal({ warnings, payload: dataToSave as Omit<Reservation, 'id'> });
              return;
          }
      }

      await performSave(dataToSave as Omit<Reservation, 'id'>);
  };

  const getStatusColor = (status: PaymentStatus) => {
    switch (status) {
      case PaymentStatus.PAID_FULL: return 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]';
      case PaymentStatus.PAID_DEPOSIT: return 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]';
      case PaymentStatus.PENDING: return 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]';
      case PaymentStatus.REFUNDED: return 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]';
      default: return 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] border-[var(--ds-border)]';
    }
  };

  // Rooms available for new assignments: neither closed for an extended
  // period nor closed for the date+shift currently in focus.
  const openRooms = rooms.filter(r => !isRoomClosed(r));
  const displayedRooms = modalRoomFilter === 'ALL' ? openRooms : openRooms.filter(r => r.id === modalRoomFilter);
  const selectedTableObj = displayTables.find(t => t.id === formData.table_id);

  // Calculate Free Tables for the form header
  // Helper to check if a table is merged into another table (and thus should be hidden)
  const isTableMergedIntoAnother = (tableId: number) => {
    return displayTables.some(other =>
      other.merged_with &&
      other.merged_with.length > 0 &&
      other.merged_with.map(id => Number(id)).includes(Number(tableId))
    );
  };

  // Get visible tables (not merged into another table, not hidden for this shift)
  const visibleTables = displayTables.filter(t =>
    (modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter) &&
    !isTableMergedIntoAnother(t.id) &&
    !hiddenTableIds.has(t.id)
  );

  const totalTablesInFilter = visibleTables.length;

  // Count occupied tables only if we have valid form data
  // Include tables occupied by OTHER reservations + the table currently selected in formData
  const occupiedTablesInFilter = (formData.reservation_time && formData.shift)
    ? visibleTables.filter(t => {
        // Check if occupied by another reservation
        const occupiedByOther = isTableOccupied(t.id, formData.reservation_time!.split('T')[0], formData.shift!);
        // Check if this is the table selected in the current form
        const selectedInForm = formData.table_id === t.id;
        return occupiedByOther || selectedInForm;
      }).length
    : 0;

  const freeTablesCount = totalTablesInFilter - occupiedTablesInFilter;

  // Render logic for Map Table
  const renderMapTable = (
    table: Table,
    layoutPositions?: Map<number, { x: number; y: number }>,
    mapScale: number = 1,
  ) => {
      const occupier = getOccupierForTable(table.id);
      const reservation = occupier?.kind === 'reservation' ? occupier.data : null;
      const banquet = occupier?.kind === 'banquet' ? occupier.data : null;
      const allReservations = getReservationsForTable(table.id);
      const hasMultipleReservations = allReservations.length > 1;
      const isOccupied = !!occupier;
      const isHidden = hiddenTableIds.has(table.id);
      const trimmedSearch = searchTerm.trim().toLowerCase();
      const isSearchMatch = !!(trimmedSearch && (
        (reservation && reservation.customer_name.toLowerCase().includes(trimmedSearch)) ||
        (banquet && banquet.name.toLowerCase().includes(trimmedSearch)) ||
        table.name.toLowerCase().includes(trimmedSearch)
      ));

      // Map reservation/banquet occupancy → glyph display status (shared,
      // time-aware derivation — but only when viewing today's service: past
      // or future dates must not read as "In arrivo"/"In uscita").
      const displayStatus: TableDisplayStatus = deriveTableDisplayStatus(reservation, {
          banquet: !reservation && !!banquet,
          now: isViewingToday ? nowTick : undefined,
      });
      const reservationTime = reservation
          ? (getRomeTimePart(reservation.reservation_time) || null)
          : null;

      const dims = getGlyphDimensions(table.shape, table.seats);
      const { width: svgW, height: svgH } = dims;

      const rotationRad = ((table.rotation || 0) * Math.PI) / 180;
      const rotatedHalfH = (Math.abs(svgW * Math.sin(rotationRad)) + Math.abs(svgH * Math.cos(rotationRad))) / 2;
      const captionTopPx = svgH / 2 + rotatedHalfH + 6;

      const isHighlighted = selectedReservation?.table_id === table.id && detailDrawerOpen;
      const hoveredRes = hoveredReservationId ? reservations.find(r => r.id === hoveredReservationId) : null;
      const isHoverMatch = hoveredRes?.table_id === table.id;
      const isMapHovered = hoveredMapTableId === table.id;

      const accentVar = displayStatus !== 'libera' ? `var(--tg-${displayStatus}-accent)` : undefined;
      // With double-seating the pill lists each customer on its own line so
      // the operator sees all turni at a glance, not just the first booking.
      const hoverPillNames = hasMultipleReservations
          ? allReservations.map(r => toTitleCase(r.customer_name))
          : reservation
              ? [toTitleCase(reservation.customer_name)]
              : banquet
                  ? [banquet.name]
                  : [];
      const showHoverPill = isMapHovered && hoverPillNames.length > 0 && !isHighlighted && !isHoverMatch;

      const tooltipText = isHidden
          ? 'Tavolo nascosto per questo turno — clicca per riattivarlo'
          : hasMultipleReservations
              ? `Doppio turno · ${allReservations.map(r => {
                    const t = getRomeTimePart(r.reservation_time);
                    const covers = `${r.guests}${r.children && r.children > 0 ? ` (${r.children}b)` : ''} coperti`;
                    return `${toTitleCase(r.customer_name)}${t ? ` (${t})` : ''} · ${covers}`;
                }).join(' · ')}`
              : reservation
                  ? `Occupato da: ${toTitleCase(reservation.customer_name)} · ${reservation.guests}${reservation.children && reservation.children > 0 ? ` (${reservation.children}b)` : ''} coperti${reservationTime ? ` · ${reservationTime}` : ''}`
                  : banquet
                      ? `Banchetto: ${banquet.name}`
                      : 'Libero — clicca per assegnare una prenotazione';

      const pos = layoutPositions?.get(table.id) || { x: table.x, y: table.y };

      return (
        <div
            key={table.id}
            className={`absolute ${isOccupied ? 'z-10' : ''} ${(isSearchMatch || isHoverMatch) ? 'z-20' : ''} ${isMapHovered ? 'z-[25]' : ''} ${isHighlighted ? 'z-30' : ''} ${isHidden ? 'opacity-40 grayscale' : ''} ${canEdit || reservation ? 'cursor-pointer' : 'cursor-default'}`}
            style={{
                left: pos.x,
                top: pos.y,
                width: `${svgW}px`,
                height: `${svgH}px`,
            }}
            title={tooltipText}
            onMouseEnter={() => setHoveredMapTableId(table.id)}
            onMouseLeave={() => setHoveredMapTableId(prev => prev === table.id ? null : prev)}
            onTouchStart={() => startMapLongPress(table.id)}
            onTouchEnd={endMapLongPress}
            onTouchMove={cancelMapLongPress}
            onTouchCancel={cancelMapLongPress}
            onClick={(e) => {
                if (wasLongPressRef.current) {
                    wasLongPressRef.current = false;
                    e.preventDefault();
                    return;
                }
                if (hasMultipleReservations) {
                    setTableChooserModal({ table, reservations: allReservations });
                } else if (reservation) {
                    handleEditClick(reservation);
                } else if (banquet) {
                    // Banquet-occupied tables are not assignable from this view.
                } else if (canEdit) {
                    setAssignTableModal(table);
                }
            }}
        >
            <div
                className={`${isHighlighted ? 'rounded-[12px] outline outline-3 outline-[var(--ds-arriving-solid)] outline-offset-2 animate-pulse-ring' : ''} ${(isSearchMatch || isHoverMatch) && !isHighlighted ? 'rounded-[12px] outline outline-2 outline-[var(--ds-pending-solid)] outline-offset-2 animate-search-pulse' : ''} ${isMapHovered && isOccupied && !isHighlighted && !isHoverMatch ? 'animate-hover-pulse' : ''}`}
                style={{ transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined, ['--pulse-color' as string]: accentVar }}
            >
                <TableGlyph
                    name={table.name}
                    seats={table.seats}
                    shape={table.shape}
                    status={displayStatus}
                    party={reservation
                      ? (reservation.reservation_status === ReservationStatus.NO_SHOW ? 0 : reservation.guests)
                      : banquet ? (banquet.guests ?? 0) : 0}
                />
            </div>

            {isHidden && (
                <div className="absolute bg-[var(--ds-text-muted)] text-[#ffffff] text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm flex items-center gap-0.5 border border-[#ffffff] pointer-events-none" style={{ top: -4, left: -4 }}>
                    <EyeOff size={8} />
                </div>
            )}
            {hasMultipleReservations && (
                <div
                    className="absolute bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)] text-[13px] font-bold px-2 py-0.5 rounded-full shadow-sm border-2 border-[#ffffff] pointer-events-none tabular"
                    style={{ top: -10, right: -10 }}
                    aria-label={`${allReservations.length} prenotazioni sullo stesso tavolo`}
                >
                    ×{allReservations.length}
                </div>
            )}
            {/* Capacity chip (seat + N) under the table. Always shown — the
                floor plan is now a status canvas, so details live in the
                tooltip / detail drawer rather than overlaying the glyph. */}
            <div
                className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none flex items-center gap-1.5"
                style={{ top: captionTopPx, fontSize: 18 }}
            >
                <Armchair size={22} style={{ color: 'var(--tg-covers)' }} className="flex-shrink-0" />
                <span style={{ color: 'var(--tg-covers)' }}>{table.seats}</span>
            </div>
            {hasMultipleReservations && (
                <div
                    className="absolute left-1/2 -translate-x-1/2 pointer-events-none flex flex-col items-center gap-1"
                    style={{ top: captionTopPx + 30 }}
                >
                    {allReservations.map((r, i) => {
                        const t = getRomeTimePart(r.reservation_time);
                        return (
                            <span
                                key={r.id}
                                className="text-[14px] font-semibold leading-tight px-2.5 py-1 rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] whitespace-nowrap shadow-[var(--ds-shadow-card)]"
                            >
                                <span className="opacity-70 tabular mr-1">{i + 1}°</span>
                                {toTitleCase(r.customer_name).split(' ')[0]}
                                {t && <span className="opacity-70 ml-1.5 tabular">{t}</span>}
                            </span>
                        );
                    })}
                </div>
            )}
            {showHoverPill && (() => {
                // Counter-scale so the pill stays at a constant screen size
                // even when the canvas is zoomed out (dense rooms like Veranda
                // render at scale ~0.4, which made the pill unreadable).
                const invScale = Math.min(2.2, Math.max(1, 1 / Math.max(0.0001, mapScale)));
                const isMulti = hoverPillNames.length > 1;
                return (
                    <div
                        className={`absolute left-1/2 ${isMulti ? 'px-2 py-1 rounded-lg' : 'px-2 py-0.5 rounded-full'} border text-[12px] font-semibold whitespace-nowrap pointer-events-none shadow-[var(--ds-shadow-card)]`}
                        style={{
                            top: -8,
                            background: accentVar || 'var(--ds-surface)',
                            color: '#fff',
                            borderColor: 'var(--ds-surface)',
                            transform: `translate(-50%, -100%) scale(${invScale})`,
                            transformOrigin: 'bottom center',
                        }}
                    >
                        {isMulti ? (
                            <div className="flex flex-col items-center leading-tight gap-0.5">
                                {allReservations.map((r, i) => {
                                    const t = getRomeTimePart(r.reservation_time);
                                    return (
                                        <span key={r.id} className="text-[11px] inline-flex items-center">
                                            <span className="opacity-70 tabular mr-1">{i + 1}°</span>
                                            {toTitleCase(r.customer_name)}
                                            {t && <span className="opacity-70 ml-1 tabular">· {t}</span>}
                                            <span className="opacity-90 ml-1.5 inline-flex items-center gap-0.5 tabular">
                                                <Armchair size={11} className="flex-shrink-0" />{r.guests}{r.children && r.children > 0 ? ` (${r.children}b)` : ''}
                                            </span>
                                        </span>
                                    );
                                })}
                            </div>
                        ) : reservation ? (
                            <span className="inline-flex items-center">
                                {toTitleCase(reservation.customer_name)}
                                <span className="opacity-90 ml-1.5 inline-flex items-center gap-0.5 tabular">
                                    <Armchair size={11} className="flex-shrink-0" />{reservation.guests}{reservation.children && reservation.children > 0 ? ` (${reservation.children}b)` : ''}
                                </span>
                            </span>
                        ) : (
                            hoverPillNames[0]
                        )}
                    </div>
                );
            })()}
        </div>
      );
  };

  // --- Helpers for reservation rows ---
  const handleRowClick = (res: Reservation) => {
    if (selectedReservationId === res.id) {
      setSelectedReservationId(null);
      setDetailDrawerOpen(false);
    } else {
      setSelectedReservationId(res.id);
      setDetailDrawerOpen(true);
    }
  };

  const closeDetailDrawer = () => {
    setSelectedReservationId(null);
    setDetailDrawerOpen(false);
  };

  // Renders the table number(s) inside a reservation's table strip. A merged
  // assignment carries a "74+70+71" name, which is unreadable in a narrow cell
  // and, at three or more tables, wider than the strip itself. Any union now
  // collapses to the first table plus a quiet "+N": the count is the part you
  // scan for, the full list is one tap away in the tooltip. `textClass` keeps
  // the colour in sync with the strip's state styling; the "+N" rides the same
  // colour at reduced opacity so it stays inside the state family in both
  // themes instead of needing a token of its own.
  const renderTableStripContent = (res: Reservation, table: Table, tableRoom: Room | null | undefined, textClass: string) => {
    const names = table.name.split('+').map(n => n.trim()).filter(Boolean);
    const extraCount = names.length - 1;
    return (
      <>
        {extraCount > 0 ? (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'tables', text: table.name, x: e.clientX, y: e.clientY }); }}
            className="flex items-center justify-center gap-0.5 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            title={`Tavoli uniti: ${names.join(', ')}`}
            aria-label={`${names.length} tavoli uniti: ${names.join(', ')}. Tocca per i dettagli.`}
          >
            <span className={`text-base font-bold leading-tight ${textClass}`}>{names[0]}</span>
            <span className={`text-[11px] font-semibold leading-none opacity-60 ${textClass}`}>+{extraCount}</span>
          </button>
        ) : (
          <span className={`text-base font-bold leading-tight text-center break-words ${textClass}`}>{table.name}</span>
        )}
        {tableRoom && <span className="text-xs text-[var(--ds-text-muted)] text-center leading-4">{tableRoom.name}</span>}
      </>
    );
  };

  /**
   * One reservation, one card — the same one on the phone and in the desktop
   * column. The two used to be separate blocks of near-identical JSX, which is
   * how they drifted: different name sizes, different table chips, different
   * badges on show.
   *
   * Reading order is the order a host needs it in: when and how many, who,
   * where they're sitting, then what state the booking is in.
   */
  const renderReservationCard = (res: Reservation, group: ReservationGroup) => {
    const table = displayTables.find(t => t.id === res.table_id);
    const tableRoom = table ? rooms.find(r => r.id === table.room_id) : null;
    const isSelected = selectedReservationId === res.id;
    const noteText = stripDietaryNote(res.notes);
    // Preset notes whose label appears in res.notes AND that carry an icon.
    // Each becomes a badge in the attribute cluster so common requests
    // (seggiolone, cane, compleanno, ...) are visible without opening the card.
    const matchedNoteIcons = res.notes
      ? quickNotes
          .filter(n => n.icon && res.notes!.toLowerCase().includes(n.label.toLowerCase()))
          .map(n => ({ label: n.label, Icon: getReservationNoteIcon(n.icon) }))
          .filter(m => !!m.Icon)
      : [];
    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
    const isFlashing = newReservationFlashId === res.id;
    const state = isViewingToday ? getTimedReservationState(res, nowTick) : getReservationState(res);
    const ds = reservationStateDs(state);
    const turno = turnoIndexById.get(res.id);
    const isVoided = group.key === 'noshow' || group.key === 'cancelled';
    const preferredMatch = res.customer_preferred_table_id != null && res.customer_preferred_table_id === res.table_id;
    const preferredMissed = res.customer_preferred_table_id != null && res.customer_preferred_table_id !== res.table_id;
    const dietary = parseDietary(res.notes, allergenPresets);
    // Solo se il tavolo è ancora libero: appena qualcuno lo assegna (a mano o
    // confermando questa stessa proposta) res.table_id smette di essere
    // null e il chip sparisce da solo, senza bisogno di un evento dedicato.
    const tableSuggestion = res.table_id == null ? tableAssignmentSuggestions.get(res.id) : undefined;
    // The third line only exists when something needs it — an empty flex row
    // still costs its gap, and most bookings carry none of these.
    const hasWideAttributes = !!turno || preferredMatch || preferredMissed || !!tableSuggestion
      || dietary.allergies.length > 0 || dietary.intolerances.length > 0;

    // One set of glyphs, rendered in two spots: beside the name on ≥sm, on
    // their own row under it below sm — so phone and desktop can't drift.
    const attrGlyphs = (
      <>
        {renderChannelIcon(res)}
        {renderConfirmationIcon(res)}
        {renderReminderIcon(res)}
        {matchedNoteIcons.map(m => {
          const Icon = m.Icon!;
          return (
            <span key={m.label} className={ATTR_BADGE} title={m.label} aria-label={m.label}>
              <Icon className="h-3.5 w-3.5" />
            </span>
          );
        })}
        {noteText && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'note', text: noteText, x: e.clientX, y: e.clientY }); }}
            className={`${ATTR_BADGE} transition-colors hover:text-[var(--ds-text-primary)]`}
            title="Nota"
            aria-label="Nota"
          >
            <StickyNote className="h-3.5 w-3.5" />
          </button>
        )}
        {renderPaymentIcon(res)}
        {menu && (
          <span className={`${ATTR_BADGE} bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]`} title={menu.name} aria-label={`Menù: ${menu.name}`}>
            <BookOpen className="h-3.5 w-3.5" />
          </span>
        )}
      </>
    );

    return (
      <div
        key={res.id}
        id={`reservation-row-${res.id}`}
        className={`w-full cursor-pointer rounded-[20px] shadow-[var(--ds-shadow-card)] transition-shadow p-3.5 ${
          isVoided ? 'bg-[var(--ds-critical-tint)]' : 'bg-[var(--ds-surface)]'
        } ${isSelected ? 'ring-2 ring-[var(--ds-border-focus)]' : ''} ${
          group.key === 'freed' || group.key === 'cancelled' ? 'opacity-60' : ''
        } ${isFlashing ? 'animate-flash-row' : ''}`}
        onMouseEnter={() => setHoveredReservationId(res.id)}
        onMouseLeave={() => setHoveredReservationId(null)}
        onClick={() => handleRowClick(res)}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            {/* When, how many, and who took it */}
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex-shrink-0 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                {formatTime(res.reservation_time)}
              </span>
              <span
                className="inline-flex h-6 flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2 text-[12px] font-medium text-[var(--ds-text-secondary)]"
                title={`${res.guests} coperti${res.children ? ` (${res.children} bambini)` : ''}`}
              >
                <Users className="h-3.5 w-3.5" aria-hidden />
                <span className="tabular-nums">{res.guests}</span>
                {res.children && res.children > 0 ? (
                  <span className="text-[var(--ds-text-muted)]">({res.children}b)</span>
                ) : null}
              </span>
              {/* Operator folded into the info tooltip — the separate initials
                  circle was one glyph too many on an already crowded row. */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'bookedAt', text: formatBookedAtBy(res), x: e.clientX, y: e.clientY }); }}
                className="flex-shrink-0 text-[var(--ds-text-subtle)] transition-colors hover:text-[var(--ds-text-primary)]"
                title={formatBookedAtBy(res)}
                aria-label={formatBookedAtBy(res)}
              >
                <Info className="h-4 w-4" />
              </button>
            </div>

            {/* Who */}
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
              {res.customer_is_vip && (
                <Star className="h-4 w-4 flex-shrink-0 fill-[var(--ds-pending-solid)] text-[var(--ds-pending-solid)]" aria-label="Cliente VIP" />
              )}
              {res.customer_is_blacklisted && (
                <span title={res.customer_blacklist_reason || 'Cliente in blacklist'}>
                  <Ban className="h-4 w-4 flex-shrink-0 text-[var(--ds-critical-text)]" aria-label="Cliente in blacklist" />
                </span>
              )}
              <p className={`truncate text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)] ${group.key === 'cancelled' ? 'line-through' : ''}`}>
                {toTitleCase(res.customer_name)}
              </p>
            </div>

            {/* Anything that needs words rather than a glyph */}
            {hasWideAttributes && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {turno && (
                  <StatusPill tone="info" title={`Doppio turno sullo stesso tavolo (${turno.total} prenotazioni)`}>
                    {turno.position}° turno
                  </StatusPill>
                )}
                <DietaryChips notes={res.notes} presets={allergenPresets} size="sm" />
                {preferredMatch && (
                  <StatusPill tone="positive" title={`Tavolo preferito: ${res.customer_preferred_table_name || ''}`}>
                    <Armchair className="h-3 w-3 flex-shrink-0" aria-hidden /> Tavolo preferito
                  </StatusPill>
                )}
                {preferredMissed && (
                  <StatusPill tone="pending" title={`Preferito: ${res.customer_preferred_table_name || ''}`}>
                    <Armchair className="h-3 w-3 flex-shrink-0" aria-hidden /> Preferito non disponibile
                  </StatusPill>
                )}
                {tableSuggestion && (
                  <StatusPill tone="info" title={tableSuggestion.summary} className="pr-1">
                    <Wand2 className="h-3 w-3 flex-shrink-0" aria-hidden />
                    Tavolo {tableSuggestion.table_name || tableSuggestion.table_id}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleConfirmTableSuggestion(tableSuggestion); }}
                      className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                      title="Conferma tavolo suggerito"
                      aria-label="Conferma tavolo suggerito"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); handleDismissTableSuggestion(tableSuggestion); }}
                      className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10"
                      title="Ignora suggerimento"
                      aria-label="Ignora suggerimento"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </StatusPill>
                )}
              </div>
            )}

            {/* Same glyphs as the ≥sm strip, on their own row where the top
                one has no width to spare. */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 sm:hidden">
              {attrGlyphs}
            </div>
          </div>

          {/* Attributes, as glyphs. Beside the name from sm up, where the row
              has width to spare — below sm they render on their own row in
              the left column instead. */}
          <div className="hidden flex-shrink-0 items-center gap-1.5 self-start sm:flex">
            {attrGlyphs}
          </div>

          {/* Where they're sitting. Takes the booking's own colour family, so
              the table reads as occupied-by-this-state at a glance. */}
          {table ? (
            <div
              className={`flex min-h-[56px] w-[64px] max-w-[120px] flex-shrink-0 flex-col items-center justify-center rounded-[14px] px-2 py-1.5 ${ds.tint} ${ds.text}`}
            >
              {renderTableStripContent(res, table, tableRoom, ds.text)}
            </div>
          ) : canEdit ? (
            // The dashed box is the affordance for the assign-table action the
            // row already had buried in its action band.
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
              title="Assegna un tavolo"
              aria-label="Assegna un tavolo"
              className={`flex min-h-[56px] w-[64px] flex-shrink-0 items-center justify-center rounded-[14px] border border-dashed border-[var(--ds-pending-solid)] text-[var(--ds-pending-text)] transition-colors hover:bg-[var(--ds-pending-tint)]`}
            >
              <Plus className="h-4 w-4" />
            </button>
          ) : (
            <div className={`flex min-h-[56px] w-[64px] flex-shrink-0 items-center justify-center rounded-[14px] bg-[var(--ds-surface-row)] text-[13px] text-[var(--ds-text-muted)]`}>
              —
            </div>
          )}
        </div>

        {/* State and the two actions, below a hairline so they read as
            operating on the card rather than describing it. The band renders
            without edit rights too — a read-only viewer still has to be able
            to tell a no-show from a confirmed booking. */}
        <div className={`flex flex-wrap items-center gap-x-2 gap-y-2 border-t border-[var(--ds-border)] mt-3 pt-3`}>
          <DsStatusChip
            state={state}
            onClick={canEdit ? (e) => { e.stopPropagation(); setStateChangeReservation(res); } : undefined}
            title={canEdit ? 'Cambia stato' : undefined}
            trailing={canEdit ? <ChevronDown className="h-3.5 w-3.5 opacity-60" /> : undefined}
          />
          {canEdit && (
            <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
              className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
              aria-label="Modifica"
              title="Modifica"
            >
              <Edit2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); handleDeleteClick(res.id, res.customer_name); }}
              className="ml-auto inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]"
              aria-label="Annulla"
              title="Annulla"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            </>
          )}
        </div>
      </div>
    );
  };

  // --- Detail drawer content ---
  const renderDetailDrawer = (res: Reservation) => {
    const table = displayTables.find(t => t.id === res.table_id);
    const tableRoomName = table ? rooms.find(r => r.id === table.room_id)?.name : null;
    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
    const noteText = stripDietaryNote(res.notes);
    const matchedNoteIcons = res.notes
      ? quickNotes
          .filter(n => n.icon && res.notes!.toLowerCase().includes(n.label.toLowerCase()))
          .map(n => ({ label: n.label, Icon: getReservationNoteIcon(n.icon) }))
          .filter(m => !!m.Icon)
      : [];

    return (
 <div className="bg-[var(--ds-surface)] border-t border-[var(--ds-border)] shadow-[0_-4px_12px_rgba(0,0,0,0.08)] rounded-t-xl overflow-hidden duration-200">
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
        </div>

        <div className="px-4 pb-4 space-y-3 max-h-[50vh] lg:max-h-none overflow-y-auto">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-semibold text-[var(--ds-text-primary)] inline-flex items-center gap-1.5">
                {res.customer_is_vip && (
                  <Star className="h-4 w-4 text-[var(--ds-pending-solid)] fill-[var(--ds-pending-solid)] flex-shrink-0" aria-label="Cliente VIP" />
                )}
                {res.customer_is_blacklisted && (
                  <Ban className="h-4 w-4 flex-shrink-0 text-[var(--ds-critical-text)]" aria-label="Cliente in blacklist" />
                )}
                {toTitleCase(res.customer_name)}
                {(() => {
                  const turno = turnoIndexById.get(res.id);
                  if (!turno) return null;
                  return (
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] text-[10px] font-semibold"
                      title={`Doppio turno sullo stesso tavolo (${turno.total} prenotazioni)`}
                    >
                      {turno.position}° turno
                    </span>
                  );
                })()}
              </h3>
              <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {res.guests} {res.guests === 1 ? 'ospite' : 'ospiti'}{res.children && res.children > 0 ? ` (${res.children} bambin${res.children === 1 ? 'o' : 'i'})` : ''}</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(res.reservation_time)}</span>
                {table && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> T.{table.name}{tableRoomName ? ` · ${tableRoomName}` : ''}</span>}
              </div>
            </div>
            <button type="button" onClick={closeDetailDrawer} className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Info badges */}
          <div className="flex flex-wrap gap-1.5">
            {res.payment_status !== PaymentStatus.PENDING && (
              <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${getStatusColor(res.payment_status)}`}>
                <CreditCard className="h-2.5 w-2.5" />
                {res.payment_status === PaymentStatus.PAID_FULL ? 'Saldato' : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'Acconto' : 'Rimborsato'}
              </span>
            )}
            {menu && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] text-[10px] font-medium">
                <BookOpen className="h-2.5 w-2.5" /> {menu.name}
              </span>
            )}
            <DietaryChips notes={res.notes} presets={allergenPresets} size="sm" />
            {res.customer_preferred_table_id != null && res.customer_preferred_table_id === res.table_id && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] text-[10px] font-medium" title={`Tavolo preferito: ${res.customer_preferred_table_name || ''}`}>
                <Armchair className="h-2.5 w-2.5" /> Tavolo preferito
              </span>
            )}
            {res.customer_preferred_table_id != null && res.customer_preferred_table_id !== res.table_id && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] text-[10px] font-medium" title={`Preferito: ${res.customer_preferred_table_name || ''}`}>
                <Armchair className="h-2.5 w-2.5" /> Preferito non disponibile
              </span>
            )}
            {matchedNoteIcons.map(m => {
              const Icon = m.Icon!;
              return (
                <span
                  key={m.label}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] text-[10px] font-medium"
                >
                  <Icon className="h-2.5 w-2.5" /> {m.label}
                </span>
              );
            })}
          </div>

          {/* Contact info */}
          {(res.phone || res.email) && (
            <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)]">
              {res.phone && <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {res.phone}</span>}
              {res.email && <span className="flex items-center gap-1 truncate"><Mail className="h-3 w-3 flex-shrink-0" /> {res.email}</span>}
            </div>
          )}

          {/* Notes */}
          {noteText && (
            <div className="text-xs text-[var(--ds-text-muted)] bg-[var(--ds-surface-row)] rounded-md px-3 py-2">
              <StickyNote className="h-3 w-3 inline mr-1" />{noteText}
            </div>
          )}

          {/* Consensi privacy (read-only) — mostrati solo se registrati almeno una volta */}
          {(res.consent_marketing != null || res.consent_data_health != null || res.consent_updated_at) && (
            <div className="text-xs bg-[var(--ds-surface-row)] rounded-md px-3 py-2 space-y-1">
              <div className="font-medium text-[var(--ds-text-muted)]">Consensi privacy</div>
              {[
                { label: 'Allergie / dati sanitari', v: res.consent_data_health },
                { label: 'Marketing', v: res.consent_marketing },
              ].map(({ label, v }) => (
                <div key={label} className="flex items-center gap-1.5 text-[var(--ds-text-primary)]">
                  {v === true ? (
                    <Check className="h-3 w-3 text-[var(--ds-seated-solid)] flex-shrink-0" />
                  ) : v === false ? (
                    <X className="h-3 w-3 text-[var(--ds-critical-solid)] flex-shrink-0" />
                  ) : (
                    <span className="h-3 w-3 inline-flex items-center justify-center text-[var(--ds-text-subtle)] flex-shrink-0">—</span>
                  )}
                  <span>{label}: <span className="text-[var(--ds-text-muted)]">{v === true ? 'concesso' : v === false ? 'negato' : 'non registrato'}</span></span>
                </div>
              ))}
              {res.consent_updated_at && (
                <div className="text-[11px] text-[var(--ds-text-subtle)]">
                  Aggiornati il {new Date(res.consent_updated_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              )}
            </div>
          )}

          {/* Actions */}
          {canEdit && (
            <div className="flex items-center gap-2.5 pt-1 flex-wrap">
              <DsStatusChip
                state={isViewingToday ? getTimedReservationState(res, nowTick) : getReservationState(res)}
                onClick={() => setStateChangeReservation(res)}
                title="Cambia stato"
                trailing={<ChevronDown className="h-3 w-3 opacity-60" />}
              />
              {isSeated(res) && !res.table_id && (
                <button onClick={() => { handleEditClick(res); closeDetailDrawer(); }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)] transition-colors">
                  <MapPin className="h-3.5 w-3.5" /> Assegna tavolo
                </button>
              )}
              <button onClick={() => { handleEditClick(res); closeDetailDrawer(); }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] transition-colors">
                <Edit2 className="h-3.5 w-3.5" /> Modifica
              </button>
              <button onClick={() => { handleDeleteClick(res.id, res.customer_name); closeDetailDrawer(); }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-[var(--ds-critical-solid)] hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] transition-colors">
                <Trash2 className="h-3.5 w-3.5" /> Annulla
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  /** Which family a group belongs to. Same mapping as the state pill on the
   *  cards inside it, so a section and its contents agree on colour. */
  const groupTone = (key: string): SectionTone =>
    key === 'pending' ? 'pending'
    : key === 'waiting' ? 'info'
    : key === 'arrived' || key === 'departing' ? 'positive'
    : key === 'noshow' || key === 'cancelled' ? 'attention'
    : 'muted';

  /* --- Toolbar (shared by the desktop column and the mobile list) ---------
     One set of controls, shown at both widths. Density is desktop-only (a
     cashier wants rows, a tablet wants air) and the channel sheet is
     mobile-only — on desktop the same toggles sit inline in the header. */
  const renderListToolbar = () => (
    <div className="flex items-center gap-2">
      <SearchField
        value={searchTerm}
        onChange={setSearchTerm}
        inputRef={searchInputRef}
        onKeyDown={handleSearchKeyDown}
        placeholder="Cerca per nome o telefono"
        ariaLabel="Cerca prenotazioni"
        className="min-w-0 flex-1"
        hint={searchTerm && quickArriveCandidates.length === 1 ? (
          <StatusPill tone="positive">↵ Arrivato</StatusPill>
        ) : undefined}
      />

      <button type="button" onClick={() => setShowSortModal(true)} className={dsIconButton} aria-label="Ordina" title="Ordina">
        <ArrowUpDown className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => setShowFiltersPanel(true)}
        aria-label="Filtri"
        title="Filtri"
        className={activeFilterCount > 0
          ? 'relative inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-card)] transition-colors'
          : `relative ${dsIconButton}`}
      >
        <ListFilter className="h-4 w-4" />
        {activeFilterCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5">
            <CountBadge count={activeFilterCount} tone="alert" className="h-5 min-w-[20px] text-[11px] ring-2 ring-[var(--ds-canvas)]" />
          </span>
        )}
      </button>

      <button type="button" onClick={() => setIsPrintModalOpen(true)} className={dsIconButton} aria-label="Stampa" title="Stampa">
        <Printer className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={() => setShowChannelsSheet(true)}
        className={`${dsIconButton} lg:hidden`}
        aria-label="Opzioni canali di prenotazione"
        title="Opzioni canali di prenotazione"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
    </div>
  );

  /* --- The grouped cards, without any chrome of their own ----------------
     Used inside the desktop column and the mobile page alike; each caller
     owns its own padding and scrolling. */
  const renderGroupedCards = (wrapRow?: (res: Reservation, group: ReservationGroup, card: React.ReactNode) => React.ReactNode) => {
    if (isInitialLoading && reservations.length === 0) {
      return (
        <SkeletonReservationList
          groups={[
            { count: 3, titleWidth: 'lg' },
            { count: 4, titleWidth: 'md' },
            { count: 2, titleWidth: 'sm' },
          ]}
        />
      );
    }
    if (totalGroupedCount === 0) {
      return (
        <EmptyState
          icon={selectedShift === Shift.LUNCH ? Sun : Sunset}
          action={canEdit ? (
            <button type="button" onClick={() => handleOpenNew()} className={dsButton.primary}>
              <Plus className="h-4 w-4" aria-hidden /> Nuova prenotazione
            </button>
          ) : undefined}
        >
          Nessuna prenotazione per il turno di {selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} in questa data.
        </EmptyState>
      );
    }
    return groupedReservations.map(group => {
      const covers = group.items.reduce((s, r) => s + (r.guests || 0), 0);
      const children = group.items.reduce((s, r) => s + (r.children || 0), 0);
      const expanded = expandedGroups.has(group.key);
      return (
        // Groups were siblings with no gap of their own: collapsed, two headers
        // sat flush against each other and read as one control. The margin is on
        // the group rather than the inner list so it applies whether or not the
        // group is open.
        <div key={group.key} className="mb-3 last:mb-0">
          <SectionHeader
            tone={groupTone(group.key)}
            onToggle={() => toggleGroup(group.key)}
            expanded={expanded}
            meta={`${group.items.length} ${group.items.length === 1 ? 'prenotazione' : 'prenotazioni'} · ${covers} coperti${
              children > 0 ? ` (${children} bambin${children === 1 ? 'o' : 'i'})` : ''
            }`}
          >
            {group.label}
          </SectionHeader>
          {expanded && (
            <div className="space-y-2.5">
              {group.items.map(res => {
                const card = renderReservationCard(res, group);
                return wrapRow ? wrapRow(res, group, card) : card;
              })}
            </div>
          )}
        </div>
      );
    });
  };

  // --- Desktop header controls (date/shift moved to App header) ---
  const renderHeaderControls = () => null;

  // --- Grouped list panel (desktop left column) ---
  // The toolbar is pinned and the cards scroll under it. Its bottom padding is
  // load-bearing: the scrolling region below is opaque and paints later, so
  // without it the toolbar's shadow gets sliced off by a hard line.
  const renderGroupedList = () => (
    <>
      <div className="flex-shrink-0 px-4 pb-4 pt-4">
        {renderListToolbar()}
      </div>

      {/* -mr-4 extends the scroll container 16px past the column edge so the
          scrollbar disappears under the column's overflow-hidden; pr-8 gives
          those 16px back so the cards stay inset like the toolbar above and
          the selection ring (drawn outside the card) isn't clipped. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 md:-mr-4 md:pr-8">
        {renderGroupedCards()}
      </div>

      {/* Sort modal — slides up within list column on desktop */}
      {showSortModal && (
        <div className="absolute inset-0 z-50 flex items-end" onClick={() => setShowSortModal(false)}>
          <div className="absolute inset-0 bg-black/30" />
 <div className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-raised)] pb-6 duration-200"onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
            </div>
            <div className="px-5 pb-2">
              <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Ordina per</h3>
            </div>
            <div className="px-3">
              {[
                { value: 'created-asc' as const, label: 'Prenotata prima → dopo' },
                { value: 'created-desc' as const, label: 'Prenotata dopo → prima' },
                { value: 'time-asc' as const, label: 'Orario (prima → dopo)' },
                { value: 'time-desc' as const, label: 'Orario (dopo → prima)' },
                { value: 'name-asc' as const, label: 'Nome A → Z' },
                { value: 'name-desc' as const, label: 'Nome Z → A' },
                { value: 'guests-asc' as const, label: 'Coperti (meno → più)' },
                { value: 'guests-desc' as const, label: 'Coperti (più → meno)' },
              ].map(opt => (
                <button key={opt.value} type="button"
                  onClick={() => { setSortBy(opt.value); setShowSortModal(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm rounded-lg transition-colors ${
                    sortBy === opt.value ? 'bg-[var(--ds-surface-row)] font-medium text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                  }`}>
                  {opt.label}
                  {sortBy === opt.value && <Check className="h-4 w-4 text-[var(--ds-text-primary)]" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Filter modal — slides up within list column on desktop */}
      {showFiltersPanel && (
        <div className="absolute inset-0 z-50 flex items-end" onClick={() => setShowFiltersPanel(false)}>
          <div className="absolute inset-0 bg-black/30" />
 <div className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-raised)] pb-6 duration-200"onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
            </div>
            <div className="px-5 pb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Filtri</h3>
              {activeFilterCount > 0 && (
                <button type="button" onClick={resetFilters} className="flex items-center gap-1.5 text-xs font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]">
                  <RotateCcw className="h-3.5 w-3.5" /> Reimposta
                </button>
              )}
            </div>
            <div className="px-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Sala</label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setFilterRoomId('ALL')}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                      filterRoomId === 'ALL'
                        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                        : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                    }`}>Tutte</button>
                  {rooms.filter(rm => !rm.is_closed).map(rm => (
                    <button key={rm.id} type="button" onClick={() => setFilterRoomId(rm.id)}
                      className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                        filterRoomId === rm.id
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                          : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                      }`}>{rm.name}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Stato pagamento</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: 'ALL', label: 'Tutti' },
                    { value: PaymentStatus.PENDING, label: 'Sospeso' },
                    { value: PaymentStatus.PAID_DEPOSIT, label: 'Acconto' },
                    { value: PaymentStatus.PAID_FULL, label: 'Saldato' },
                  ].map(opt => (
                    <button key={opt.value} type="button" onClick={() => setFilterStatus(opt.value)}
                      className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                        filterStatus === opt.value
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                          : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Canale</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: 'ALL', label: 'Tutti' },
                    { value: ReservationSource.MANUAL, label: 'Utente' },
                    { value: ReservationSource.GOOGLE, label: 'Web' },
                    { value: ReservationSource.VOICE, label: 'Agente vocale' },
                    { value: ReservationSource.WHATSAPP, label: 'WhatsApp' },
                  ].map(opt => (
                    <button key={opt.value} type="button" onClick={() => setFilterSource(opt.value)}
                      className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                        filterSource === opt.value
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                          : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Altro</label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setFilterHasAllergens(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasAllergens ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                    Allergeni
                  </button>
                  <button type="button" onClick={() => setFilterHasNotes(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasNotes ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                    Con note
                  </button>
                  <button type="button" onClick={() => setFilterNoTable(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterNoTable ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                    Senza tavolo
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // --- Map panel (shared between desktop right column and mobile map view) ---
  const renderMapPanel = () => {
    const tablesInRoom = displayTables
      .filter(t => t.room_id === activeMapRoomId)
      .filter(t => !displayTables.some(other =>
        other.merged_with && other.merged_with.length > 0 &&
        other.merged_with.map(id => Number(id)).includes(Number(t.id))
      ))
      .filter(t => showHidden || !hiddenTableIds.has(t.id));

    const occupiedTablesCount = tablesInRoom.filter(t => getOccupierForTable(t.id)).length;
    const totalTablesInRoom = tablesInRoom.length;
    const occupancyPercentage = totalTablesInRoom > 0 ? Math.round((occupiedTablesCount / totalTablesInRoom) * 100) : 0;

    // The day+shift totals now live at component scope (dayShiftTotals), so
    // the phone's strip and this one can't disagree.
    const reservationsForDayShift = dayShiftTotals.rows;

    // Coperti per sala per il turno corrente — usato come badge accanto al
    // nome della sala nei tab del map view. Solo prenotazioni con tavolo
    // assegnato e non cancellate/rifiutate; le altre non pesano sulla
    // capienza fisica della sala.
    const guestsByRoomId = new Map<string | number, number>();
    for (const r of reservationsForDayShift) {
      if (!r.table_id) continue;
      if (r.reservation_status === ReservationStatus.CANCELLED) continue;
      if (r.reservation_status === ReservationStatus.DECLINED) continue;
      const table = displayTables.find(t => t.id === r.table_id);
      if (!table) continue;
      const rid = table.room_id;
      guestsByRoomId.set(rid, (guestsByRoomId.get(rid) || 0) + (Number(r.guests) || 0));
    }

    // Riempimento di ogni sala per il turno mostrato. Stessa definizione usata
    // dal backend per i limiti: tavoli occupati sul totale dei tavoli
    // utilizzabili, coperti prenotati sul totale dei posti. La sala mostra la
    // metrica del proprio limite, così la tacca e la barra parlano la stessa
    // lingua; senza limite mostra i tavoli.
    const capByRoomId = new Map<number, RoomOccupancyCap>(roomCaps.map(c => [c.room_id, c]));
    const roomFillById = new Map<string | number, { percent: number; label: string; capPercent: number | null; overCap: boolean }>();
    for (const room of rooms) {
      const roomTables = displayTables
        .filter(t => t.room_id === room.id)
        .filter(t => !displayTables.some(other =>
          other.merged_with && other.merged_with.length > 0 &&
          other.merged_with.map(id => Number(id)).includes(Number(t.id))
        ))
        // I tavoli nascosti restano fuori anche quando "mostra nascosti" è
        // attivo: il backend calcola i limiti sulla capienza reale del turno,
        // e barra e tacca devono raccontare la stessa cosa.
        .filter(t => !hiddenTableIds.has(t.id));
      const totalTables = roomTables.length;
      const busyTables = roomTables.filter(t => getOccupierForTable(t.id)).length;
      const totalSeats = roomTables.reduce((sum, t) => sum + (Number(t.seats) || 0), 0);
      const busySeats = guestsByRoomId.get(room.id) || 0;
      const cap = capByRoomId.get(Number(room.id)) ?? null;
      const useSeats = cap?.basis === 'SEATS';
      const total = useSeats ? totalSeats : totalTables;
      const busy = useSeats ? busySeats : busyTables;
      const percent = total > 0 ? Math.min(100, Math.round((busy / total) * 100)) : 0;
      roomFillById.set(room.id, {
        percent,
        label: `${busy}/${total} ${useSeats ? 'coperti' : 'tavoli'} (${percent}%)`,
        capPercent: cap?.percent ?? null,
        overCap: cap ? percent >= cap.percent : false,
      });
    }
    const activeRoomFill = typeof activeMapRoomId === 'number' ? roomFillById.get(activeMapRoomId) : undefined;

    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    // Layout mirrors the choice made in Sale & Tavoli (floorPlan.layoutMode):
    //  - auto: tidy flowing rows via computeAutoLayout, shaped to the canvas
    //  - manual: the saved x/y of each table, so this map shows the same
    //    planimetry the user drew in the editor.
    const layoutAspect = mapCanvasSize.width > 0 && mapCanvasSize.height > 0
      ? Math.min(2.6, Math.max(0.6, mapCanvasSize.width / mapCanvasSize.height))
      : 1.6;
    // Mirror the layout chosen in Sale & Tavoli so both views match:
    //  - manual: the saved x/y of each table (the real planimetry)
    //  - auto: tidy spaced rows via computeAutoLayout
    const mapLayout = computeAutoLayout(tablesInRoom, layoutAspect);
    let extentWidth: number;
    let extentHeight: number;
    let layoutPositions: Map<number, { x: number; y: number }> | undefined;
    if (layoutMode === 'manual' && tablesInRoom.length > 0) {
      // Pad the extent for the wrapped card's overhang (wider than the glyph and
      // extending below it) so edge cards aren't clipped.
      let maxRight = 0;
      let maxBottom = 0;
      for (const t of tablesInRoom) {
        const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
        maxRight = Math.max(maxRight, t.x + w);
        maxBottom = Math.max(maxBottom, t.y + h);
      }
      extentWidth = maxRight + 90;
      extentHeight = maxBottom + 160;
      layoutPositions = undefined; // renderMapTable falls back to table.x/y
    } else {
      extentWidth = mapLayout.width;
      extentHeight = mapLayout.height;
      layoutPositions = mapLayout.positions;
    }

    // Collision-aware reservation cards + banquet hulls/labels for this room.
    const labelTables = tablesInRoom.map(t => {
      const p = layoutPositions?.get(t.id) || { x: t.x, y: t.y };
      return { id: t.id, shape: t.shape, seats: t.seats, rotation: t.rotation ?? 0, x: p.x, y: p.y };
    });
    const banquetTableIds = new Map<number, number[]>();
    const banquetDataById = new Map<number, BanquetMenu>();
    for (const t of tablesInRoom) {
      const occ = getOccupierForTable(t.id);
      if (occ?.kind === 'banquet') {
        const arr = banquetTableIds.get(occ.data.id) || [];
        arr.push(t.id);
        banquetTableIds.set(occ.data.id, arr);
        banquetDataById.set(occ.data.id, occ.data);
      }
    }
    const banquetGroups = [...banquetTableIds.entries()].map(([id, tableIds]) => ({ id, tableIds }));
    const mapSelectedTableId = detailDrawerOpen ? (selectedReservation?.table_id ?? null) : null;
    // The floor plan is a pure status canvas: glyphs carry status tint + a
    // corner time chip; reservation details live in the tooltip / detail
    // drawer. So buildFloorLabels only needs to position banquet labels.
    const floorLabels = buildFloorLabels({
      tables: labelTables,
      reservationTableIds: [],
      banquets: banquetGroups,
      selectedTableId: mapSelectedTableId,
    });
    // Scoped sequential color assignment so two banquets in the same room are
    // guaranteed distinct (id % palette could collide; e.g. ids 5 and 10).
    const banquetColorByBanquetId = buildBanquetColorClassMap(banquetGroups.map(b => b.id));

    // Fit into the canvas minus a safe margin so tables never touch the edges
    // or collide with the floating Legenda button in the corner. Manual layout
    // mirrors Sale & Tavoli: never zoom past 1:1 — the user laid the room out
    // at real size and an artificial zoom would skew their intent.
    const FIT_M = 28;
    const scaleCap = layoutMode === 'manual' ? 1.5 : 2;
    const scale = (!isMobile && mapCanvasSize.width > 0 && mapCanvasSize.height > 0)
      ? Math.min(
          Math.max(1, mapCanvasSize.width - FIT_M * 2) / extentWidth,
          Math.max(1, mapCanvasSize.height - FIT_M * 2) / extentHeight,
          scaleCap
        )
      : 1;
    // Center the scaled content so leftover space is even on all sides.
    const offsetX = (!isMobile && mapCanvasSize.width > 0)
      ? Math.max(0, (mapCanvasSize.width - extentWidth * scale) / 2) : 0;
    const offsetY = (!isMobile && mapCanvasSize.height > 0)
      ? Math.max(0, (mapCanvasSize.height - extentHeight * scale) / 2) : 0;

    return (
      <div className="flex h-full min-h-0 flex-col gap-3 px-4 pb-4 pt-4 sm:px-6 lg:px-8">
        {/* Which room you're looking at. A scope switch, not a filter: the
            active room takes the solid fill so "you are here" reads before the
            names do. */}
        <div className="flex flex-shrink-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-hide rounded-full bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
            {/* Extended-closed rooms drop out entirely; rooms closed just for
                this date+shift stay visible but greyed out (same treatment as
                Sala & Tavoli), so the closure is obvious and the host can still
                open the room to move guests already seated there. */}
            {rooms.filter(r => !r.is_closed).map(room => {
              const roomGuests = guestsByRoomId.get(room.id) || 0;
              const isActive = activeMapRoomId === room.id;
              const isClosedForShift = closedRoomIdsForShift.has(room.id);
              const fill = roomFillById.get(room.id);
              const fillTitle = fill
                ? `${room.name} — ${fill.label}${fill.capPercent !== null ? ` · limite web ${fill.capPercent}%${fill.overCap ? ' (superato: le prenotazioni web arrivano da confermare)' : ''}` : ''}`
                : room.name;
              return (
                <button key={room.id} onClick={() => setActiveMapRoomId(room.id)}
                  type="button"
                  aria-pressed={isActive}
                  title={isClosedForShift ? `${room.name} (Chiusa per questo turno)` : fillTitle}
                  className={`inline-flex h-9 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    isActive
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : isClosedForShift
                        ? 'text-[var(--ds-text-subtle)] line-through hover:bg-[var(--ds-surface-row)]'
                        : 'text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                  }`}>
                  {isClosedForShift && <DoorClosed size={14} aria-hidden />}
                  <span>{room.name}</span>
                  {fill && !isClosedForShift && (
                    <RoomOccupancyMeter
                      percent={fill.percent}
                      capPercent={fill.capPercent}
                      onBrand={isActive}
                      className="w-8 flex-shrink-0"
                    />
                  )}
                  {roomGuests > 0 && (
                    <CountBadge
                      count={roomGuests}
                      max={999}
                      className="h-5 min-w-[20px] text-[11px]"
                    />
                  )}
                </button>
              );
            })}
          </div>

          {activeRoomFill?.overCap && (
            <StatusPill
              tone="pending"
              className="hidden xl:inline-flex"
              title={`Sala oltre il limite del ${activeRoomFill.capPercent}%: le prenotazioni web e telefoniche non assegnano più tavoli qui da sole.`}
            >
              Oltre il limite web
            </StatusPill>
          )}

          {hiddenTableIds.size > 0 && canEdit && (
            <button type="button" onClick={() => setUnhideAllConfirm(true)}
              className="inline-flex h-11 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-full bg-[var(--ds-seated-tint)] px-4 text-[14px] font-medium text-[var(--ds-seated-text)] transition-opacity hover:opacity-80"
              title="Riattiva tutti i tavoli nascosti per questo turno">
              <RotateCcw size={16} aria-hidden />
              <span>Riattiva tutti</span>
            </button>
          )}
        </div>

        {/* The service in four numbers. One card rather than four: they're one
            reading of the same shift. Only the segment that costs money is
            tinted, and only that one is a button. */}
        <StatStrip
          className="flex-shrink-0"
          stats={[
            { value: totalGuestsForDayShift, label: 'coperti' },
            {
              value: reservationCountForDayShift,
              label: reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni',
            },
            ...(unassignedCountForDayShift > 0 ? [{
              value: unassignedCountForDayShift,
              label: unassignedCountForDayShift === 1 ? 'senza tavolo' : 'senza tavoli',
              tone: 'pending' as const,
              tint: true,
              onClick: () => setShowUnassignedModal(true),
              title: 'Tocca per vedere le prenotazioni senza tavolo',
            }] : []),
            {
              value: `${occupiedTablesCount}/${totalTablesInRoom}`,
              label: `tavoli (${occupancyPercentage}%)`,
              hideBelow: 'md' as const,
            },
          ]}
        />

        {/* Per-shift closure banner for the room currently shown on the map */}
        {typeof activeMapRoomId === 'number' && closedRoomIdsForShift.has(activeMapRoomId) && (
          <Callout tone="pending" icon={DoorClosed} className="flex-shrink-0">
            Sala chiusa per questo turno
          </Callout>
        )}

        {/* Map canvas */}
        {isPhone ? (
          <div className="flex-1 overflow-y-auto rounded-md border border-[var(--ds-border)] bg-[var(--ds-surface)] relative m-3">
            {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-[var(--ds-surface)]/70 backdrop-blur-[1px] flex items-center justify-center">
                <div className="flex items-center gap-2 px-4 py-2 bg-[var(--ds-surface)] rounded-md shadow-[var(--ds-shadow-card)] border border-[var(--ds-border)]">
                  <Loader label="Caricamento tavoli…" size={40} />
                </div>
              </div>
            )}
            {tablesInRoom.length === 0 ? (
              <div className="text-center py-10 px-4 text-sm text-[var(--ds-text-muted)]">
                Nessun tavolo in questa sala.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--ds-border)]">
                {[...tablesInRoom]
                  .sort((a, b) => {
                    const oa = getOccupierForTable(a.id);
                    const ob = getOccupierForTable(b.id);
                    if (!!oa !== !!ob) return oa ? -1 : 1;
                    const ra = oa?.kind === 'reservation' ? oa.data : null;
                    const rb = ob?.kind === 'reservation' ? ob.data : null;
                    if (ra && rb) return ra.reservation_time.localeCompare(rb.reservation_time);
                    if (ra && !rb) return -1;
                    if (!ra && rb) return 1;
                    return a.name.localeCompare(b.name, 'it', { numeric: true });
                  })
                  .map(table => {
                    const occupier = getOccupierForTable(table.id);
                    const reservation = occupier?.kind === 'reservation' ? occupier.data : null;
                    const banquet = occupier?.kind === 'banquet' ? occupier.data : null;
                    const isOccupied = !!occupier;
                    // "Seated" covers both ARRIVED and DEPARTING — the party
                    // is still physically at the table either way.
                    const isArrived = !!reservation && isSeated(reservation);
                    const trimmedSearch = searchTerm.trim().toLowerCase();
                    const isSearchMatch = !!(trimmedSearch && (
                      (reservation && reservation.customer_name.toLowerCase().includes(trimmedSearch)) ||
                      (banquet && banquet.name.toLowerCase().includes(trimmedSearch)) ||
                      table.name.toLowerCase().includes(trimmedSearch)
                    ));
                    const mergedNames = (table.merged_with && table.merged_with.length > 0)
                      ? table.merged_with.map(id => tables.find(t => Number(t.id) === Number(id))?.name).filter((n): n is string => !!n)
                      : [];
                    const displayName = mergedNames.length > 0 ? `${table.name}+${mergedNames.join('+')}` : table.name;
                    const isMerged = mergedNames.length > 0;
                    return (
                      <li key={table.id}>
                        <button
                          onClick={() => {
                            if (reservation) handleEditClick(reservation);
                            else if (banquet) { /* not assignable */ }
                            else if (canEdit) setAssignTableModal(table);
                          }}
                          className={`w-full text-left px-3 py-3 flex items-center gap-3 transition-colors ${
                            isSearchMatch ? 'bg-[var(--ds-surface-row)]' : 'hover:bg-[var(--ds-surface-row)]'
                          }`}>
                          <div className={`min-w-[4.5rem] h-16 px-2 rounded-md flex items-center justify-center flex-shrink-0 border font-semibold ${isMerged ? 'text-base' : 'text-xl'} ${
                            isArrived ? 'bg-[var(--ds-seated-tint)] border-[var(--ds-seated-solid)] text-[var(--ds-seated-text)]'
                              : reservation ? 'bg-[var(--ds-arriving-tint)] border-[var(--ds-arriving-solid)] text-[var(--ds-arriving-text)]'
                              : banquet ? 'bg-[var(--ds-arriving-tint)] border-[var(--ds-arriving-solid)] text-[var(--ds-arriving-text)]'
                              : 'bg-[var(--ds-surface)] border-[var(--ds-border-strong)] text-[var(--ds-text-secondary)]'
                          }`}>
                            <span className="text-center leading-tight break-all">{displayName}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            {reservation ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-[var(--ds-text-primary)] truncate">{toTitleCase(reservation.customer_name)}</span>
                                  {isArrived && <span className="text-[10px] font-medium bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] px-1.5 py-0.5 rounded-full flex-shrink-0">Arrivato</span>}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(reservation.reservation_time)}</span>
                                  <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {reservation.guests}{reservation.children && reservation.children > 0 ? ` (${reservation.children}b)` : ''}</span>
                                  <span className="flex items-center gap-1 text-[var(--ds-text-subtle)]"><Armchair className="h-3 w-3" /> {table.seats}</span>
                                </div>
                              </>
                            ) : banquet ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <BookOpen className="h-3.5 w-3.5 text-[var(--ds-arriving-solid)] flex-shrink-0" aria-hidden />
                                  <span className="font-medium text-[var(--ds-arriving-text)] truncate">{banquet.name}</span>
                                  <span className="text-[10px] font-medium bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] px-1.5 py-0.5 rounded-full flex-shrink-0">Banchetto</span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                                  {typeof banquet.guests === 'number' && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {banquet.guests}</span>}
                                  <span className="flex items-center gap-1 text-[var(--ds-text-subtle)]"><Armchair className="h-3 w-3" /> {table.seats}</span>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="font-medium text-[var(--ds-text-secondary)]">Libero</div>
                                <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                                  <span className="flex items-center gap-1"><Armchair className="h-3 w-3" /> {table.seats} posti</span>
                                  {canEdit && <span className="text-[var(--ds-text-primary)] font-medium">Tocca per assegnare</span>}
                                </div>
                              </>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-[var(--ds-text-subtle)] flex-shrink-0" />
                        </button>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        ) : (
          // The floor is a card like everything else on this page, not a
          // pinned-down plan: the dashed border read as a drop target even
          // where nothing can be dropped.
          <div ref={setMapCanvasNode}
            className="relative min-h-0 flex-1 overflow-auto rounded-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] md:overflow-hidden"
            style={{ backgroundImage: 'radial-gradient(var(--floor-dot) 1px, transparent 1px)', backgroundSize: window.innerWidth < 768 ? '15px 15px' : '20px 20px' }}>
            {isLoadingMerges && (
              <div className="absolute inset-0 z-30 flex items-center justify-center bg-[var(--ds-surface)]/70 backdrop-blur-[1px]">
                <div className="flex items-center gap-2 rounded-[16px] bg-[var(--ds-surface)] px-4 py-2 shadow-[var(--ds-shadow-card)]">
                  <Loader label="Caricamento tavoli…" size={40} />
                </div>
              </div>
            )}

            {/* Hidden tables live on the floor they're hidden from, so the
                toggle sits on the floor too rather than in the header. */}
            {hiddenTableIds.size > 0 && (
              <div className="absolute left-4 top-4 z-10 select-none">
                <button type="button" onClick={() => setShowHidden(v => !v)}
                  aria-pressed={showHidden}
                  className={`inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium shadow-[var(--ds-shadow-card)] transition-colors ${
                    showHidden
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                  }`}
                  title={showHidden ? 'Nascondi tavoli disabilitati' : 'Mostra tavoli nascosti per questo turno'}>
                  {showHidden ? <Eye size={16} aria-hidden /> : <EyeOff size={16} aria-hidden />}
                  <span className="tabular-nums">{hiddenTableIds.size}</span>
                  <span>{hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}</span>
                </button>
              </div>
            )}
            <div style={{ width: extentWidth, height: extentHeight, transform: `translate(${offsetX}px, ${offsetY}px) scale(${scale})`, transformOrigin: 'top left', position: 'relative' }}>
              {/* Banquet hulls (behind tables) — tinted per banquet so two
                  events in the same room are visually distinct. */}
              {floorLabels.hulls.map((h, i) => (
                <div key={`hull-${h.banquetId}-${i}`}
                  className={`${banquetColorByBanquetId.get(h.banquetId) || 'banquet-color-0'} absolute rounded-2xl border border-[var(--ds-banquet-border)] bg-[var(--ds-banquet-bg)] pointer-events-none`}
                  style={{ left: h.box.x, top: h.box.y, width: h.box.w, height: h.box.h, zIndex: 0 }} />
              ))}
              {tablesInRoom.map(t => renderMapTable(t, layoutPositions, scale))}
              {/* Banquet event labels (one per banquet) */}
              {floorLabels.banquetLabels.map((bl, i) => {
                const data = banquetDataById.get(bl.banquetId);
                if (!data) return null;
                const colorClass = banquetColorByBanquetId.get(bl.banquetId) || 'banquet-color-0';
                return (
                  <div key={`blabel-${bl.banquetId}-${i}`} className="absolute" style={{ left: bl.x, top: bl.y, zIndex: 15 }}>
                    <BanquetLabel width={bl.w} name={data.name} guests={data.guests} colorClass={colorClass} />
                  </div>
                );
              })}
            </div>

            {/* Legend */}
            <div className="absolute bottom-4 right-4 z-10 select-none">
              <button type="button" onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                className="inline-flex h-9 items-center gap-2 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:text-[var(--ds-text-primary)]"
                aria-expanded={isLegendOpen}>
                <Info size={16} aria-hidden /> Legenda
              </button>
              {isLegendOpen && (
 <div className="absolute bottom-full right-0 mb-2 w-60 space-y-2 rounded-[20px] bg-[var(--ds-surface)] p-4 text-[13px] shadow-[var(--ds-shadow-raised)] duration-150"
                  onClick={(e) => e.stopPropagation()}>
                  <div className="text-[14px] font-semibold text-[var(--ds-text-primary)]">Stato dei tavoli</div>
                  <div className="flex items-center gap-2 text-[var(--ds-text-secondary)]"><div className="h-3 w-3 rounded-[4px] border" style={{ background: 'var(--tg-libera-bg)', borderColor: 'var(--tg-libera-stroke)' }}></div> Libera</div>
                  <div className="flex items-center gap-2 text-[var(--ds-text-secondary)]"><div className="h-3 w-3 rounded-[4px] border" style={{ background: 'var(--tg-attesa-bg)', borderColor: 'var(--tg-attesa-stroke)' }}></div> In attesa <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--tg-attesa-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></div>
                  <div className="flex items-center gap-2 text-[var(--ds-text-secondary)]"><div className="h-3 w-3 rounded-[4px] border" style={{ background: 'var(--tg-arrivato-bg)', borderColor: 'var(--tg-arrivato-stroke)' }}></div> Arrivato</div>
                  <div className="flex items-center gap-2 text-[var(--ds-text-secondary)]"><div className="flex h-3 w-3 items-center justify-center rounded-[4px] border" style={{ background: 'var(--tg-attesa-bg)', borderColor: 'var(--tg-attesa-stroke)' }}><BookOpen size={8} style={{ color: 'var(--ds-arriving-solid)' }} /></div> Banchetto</div>
                  <div className="mt-1 border-t border-[var(--ds-border)] pt-2">
                    <div className="font-semibold text-[var(--ds-text-primary)]">Occupazione</div>
                    <div className="text-[var(--ds-text-secondary)]"><span className="font-semibold tabular-nums text-[var(--ds-text-primary)]">{occupiedTablesCount}</span> / {totalTablesInRoom} tavoli (<span className="font-semibold tabular-nums text-[var(--ds-text-primary)]">{occupancyPercentage}%</span>)</div>
                  </div>
                  <div className="mt-1 border-t border-[var(--ds-border)] pt-2">
                    <div className="font-semibold text-[var(--ds-text-primary)]">Coperti</div>
                    <div className="text-[var(--ds-text-secondary)]"><span className="font-semibold tabular-nums text-[var(--ds-text-primary)]">{totalGuestsForDayShift}</span> in <span className="font-semibold tabular-nums text-[var(--ds-text-primary)]">{reservationCountForDayShift}</span> {reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={modalOnly ? 'contents' : 'h-full flex flex-col overflow-hidden'}>
      {!modalOnly && (
      <React.Fragment>

      {/* ===== DESKTOP: Two-column split view (>= 1024px) ===== */}
      {isDesktop ? (
        <div className="flex h-full min-h-0 min-w-0 bg-[var(--ds-canvas)]">
          {/* Left column — the bookings. A percentage width made this column
              shrink to a phone shape on a laptop and sprawl on a 27" screen;
              fixed steps keep a name, a time and a table chip on one line at
              every size. */}
          <div className="relative flex w-[340px] flex-shrink-0 flex-col overflow-hidden border-r border-[var(--ds-border)] lg:w-[400px] xl:w-[440px]">
            {renderGroupedList()}
          </div>

          {/* Right column — the floor */}
          <div className="min-w-0 flex-1">
            {renderMapPanel()}
          </div>
        </div>
      ) : (
        /* ===== MOBILE / TABLET: List only (< 1024px) ===== */
        <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)]">
          {/* Date and shift stay pinned — they name what the whole list below
              is about, and losing them on scroll is how you end up reading
              yesterday's service. */}
          <div className="flex flex-shrink-0 items-center gap-2 px-4 pb-3 pt-3">
            <DateNavigator
              value={selectedDateStr}
              onChange={(dateOnly) => {
                const time = selectedDate.split('T')[1] || '12:00';
                setSelectedDate(`${dateOnly}T${time}`);
              }}
              className="min-w-0 flex-1"
              onCanvas
            />
            <div className="flex h-11 flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-card)]">
              {[
                { shift: Shift.LUNCH, label: 'Pranzo', Icon: Sun },
                { shift: Shift.DINNER, label: 'Cena', Icon: Sunset },
              ].map(({ shift, label, Icon }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setSelectedShift(shift)}
                  aria-pressed={selectedShift === shift}
                  aria-label={label}
                  title={label}
                  className={`inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors ${
                    selectedShift === shift
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
            {/* The same three numbers the floor plan shows on desktop. There's
                no map on a phone, so without this the shift had no headline at
                all — you had to count the cards. */}
            <StatStrip
              className="mb-3"
              stats={[
                { value: totalGuestsForDayShift, label: 'coperti' },
                { value: reservationCountForDayShift, label: 'pren.' },
                ...(unassignedCountForDayShift > 0 ? [{
                  value: unassignedCountForDayShift,
                  label: 'senza tav.',
                  tone: 'pending' as const,
                  tint: true,
                  onClick: () => setShowUnassignedModal(true),
                  title: 'Tocca per vedere le prenotazioni senza tavolo',
                }] : []),
              ]}
            />

            {/* pb-1 left the search row all but touching the first group header
                on a phone, which is where the toolbar and the list are closest. */}
            <div className="pb-4">{renderListToolbar()}</div>

            {renderGroupedCards((res, group, card) => (
              <SwipeToCheckIn
                key={res.id}
                enabled={!!canEdit && group.key === 'waiting' && isViewingToday}
                onConfirm={() => handleSetReservationState(res, 'arrived')}
              >
                {card}
              </SwipeToCheckIn>
            ))}
          </div>

          {/* Sort modal — slide up (mobile/tablet) */}
          {showSortModal && (
            <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowSortModal(false)}>
              <div className="absolute inset-0 bg-black/30" />
 <div className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-raised)] pb-8 duration-200"onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-2">
                  <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
                </div>
                <div className="px-5 pb-2">
                  <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Ordina per</h3>
                </div>
                <div className="px-3">
                  {[
                    { value: 'created-asc' as const, label: 'Prenotata prima → dopo' },
                    { value: 'created-desc' as const, label: 'Prenotata dopo → prima' },
                    { value: 'time-asc' as const, label: 'Orario (prima → dopo)' },
                    { value: 'time-desc' as const, label: 'Orario (dopo → prima)' },
                    { value: 'name-asc' as const, label: 'Nome A → Z' },
                    { value: 'name-desc' as const, label: 'Nome Z → A' },
                    { value: 'guests-asc' as const, label: 'Coperti (meno → più)' },
                    { value: 'guests-desc' as const, label: 'Coperti (più → meno)' },
                  ].map(opt => (
                    <button key={opt.value} type="button"
                      onClick={() => { setSortBy(opt.value); setShowSortModal(false); }}
                      className={`w-full flex items-center justify-between px-4 py-3 text-sm rounded-lg transition-colors ${
                        sortBy === opt.value ? 'bg-[var(--ds-surface-row)] font-medium text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                      }`}>
                      {opt.label}
                      {sortBy === opt.value && <Check className="h-4 w-4 text-[var(--ds-text-primary)]" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Filter modal — slide up (mobile/tablet) */}
          {showFiltersPanel && (
            <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowFiltersPanel(false)}>
              <div className="absolute inset-0 bg-black/30" />
 <div className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-raised)] pb-8 duration-200"onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-2">
                  <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
                </div>
                <div className="px-5 pb-3 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Filtri</h3>
                  {activeFilterCount > 0 && (
                    <button type="button" onClick={resetFilters} className="flex items-center gap-1.5 text-xs font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]">
                      <RotateCcw className="h-3.5 w-3.5" /> Reimposta
                    </button>
                  )}
                </div>
                <div className="px-5 space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Sala</label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setFilterRoomId('ALL')}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                          filterRoomId === 'ALL'
                            ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                            : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                        }`}>Tutte</button>
                      {rooms.filter(rm => !rm.is_closed).map(rm => (
                        <button key={rm.id} type="button" onClick={() => setFilterRoomId(rm.id)}
                          className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                            filterRoomId === rm.id
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                              : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                          }`}>{rm.name}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Stato pagamento</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 'ALL', label: 'Tutti' },
                        { value: PaymentStatus.PENDING, label: 'Sospeso' },
                        { value: PaymentStatus.PAID_DEPOSIT, label: 'Acconto' },
                        { value: PaymentStatus.PAID_FULL, label: 'Saldato' },
                      ].map(opt => (
                        <button key={opt.value} type="button" onClick={() => setFilterStatus(opt.value)}
                          className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                            filterStatus === opt.value
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                              : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                          }`}>{opt.label}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Canale</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 'ALL', label: 'Tutti' },
                        { value: ReservationSource.MANUAL, label: 'Utente' },
                        { value: ReservationSource.GOOGLE, label: 'Web' },
                        { value: ReservationSource.VOICE, label: 'Agente vocale' },
                        { value: ReservationSource.WHATSAPP, label: 'WhatsApp' },
                      ].map(opt => (
                        <button key={opt.value} type="button" onClick={() => setFilterSource(opt.value)}
                          className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                            filterSource === opt.value
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]'
                              : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'
                          }`}>{opt.label}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-[var(--ds-text-primary)] mb-2 block">Altro</label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setFilterHasAllergens(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasAllergens ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                        Allergeni
                      </button>
                      <button type="button" onClick={() => setFilterHasNotes(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasNotes ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                        Con note
                      </button>
                      <button type="button" onClick={() => setFilterNoTable(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterNoTable ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-action-bg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)]'}`}>
                        Senza tavolo
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      </React.Fragment>
      )}
      {/* Reservation Modal */}
      {isFormOpen && (
        <ModalShell
          open={isFormOpen}
          onClose={closeBookingForm}
          size="fluid"
          // The stepper shows on a new booking too, with Pagamenti and
          // Comunicazione greyed: both need a saved reservation to attach to,
          // and saying so up front beats a form that silently grows two extra
          // sections the first time you reopen it.
          //
          // Height is pinned with the steps: the table grid makes Dettagli far
          // taller than the other two, and a panel that resizes under the
          // cursor moves the footer buttons out from under the thumb.
          subheader={
            <StepNav
              steps={isEditing
                ? RESERVATION_STEPS
                : RESERVATION_STEPS.map((s, i) => ({ ...s, disabled: i > 0 }))}
              current={formStep}
              onSelect={setFormStep}
              ariaLabel="Sezioni della prenotazione"
            />
          }
          fixedHeight
          // One row at every width: back, the save, forward. Stacked, the two
          // arrows became two lonely rows around the button.
          footerLayout="row"
          title={isEditing ? 'Modifica prenotazione' : 'Nuova prenotazione'}
          subtitle={(() => {
            // Restates what's about to be booked, straight from the form state,
            // so the header stays true as the fields change.
            const iso = formData.reservation_time?.split('T')[0];
            const time = formData.reservation_time?.split('T')[1]?.substring(0, 5);
            const asDay = (d: Date) =>
              `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            const now = new Date();
            const todayIso = asDay(now);
            const tomorrowIso = asDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
            const [yy, mm, dd] = (iso || '').split('-').map(Number);
            const dayLabel = !iso ? null
              : iso === todayIso ? 'Oggi'
              : iso === tomorrowIso ? 'Domani'
              : new Date(yy, mm - 1, dd).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
            const shiftLabel = formData.shift === Shift.LUNCH ? 'Pranzo' : formData.shift === Shift.DINNER ? 'Cena' : null;
            return [dayLabel, shiftLabel, time].filter(Boolean).join(' · ');
          })()}
          /* Same pair as the banquet form: back on the far left, forward past
             the save. Only while editing — on a new booking Pagamenti and
             Comunicazione are greyed in the stepper because they need a saved
             reservation, so step 0 is the only reachable one and two dead
             arrows would say otherwise. */
          footerStart={isEditing ? (
            <button
              type="button"
              onClick={() => setFormStep(s => Math.max(0, s - 1))}
              disabled={formStep === 0}
              aria-label="Sezione precedente"
              title="Sezione precedente"
              className={dsStepArrow}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : undefined}
          footer={
            <>
              {mergeMode && selectedTablesForMerge.length > 0 && (
                <span className="rounded-full bg-[var(--ds-pending-tint)] px-3 py-1.5 text-center text-[13px] text-[var(--ds-pending-text)]">
                  Conferma l'unione tavoli prima di salvare
                </span>
              )}
              {/* No Annulla: the X in the header closes the modal, and one exit
                  is enough. */}
              <button
                onClick={handleSubmit}
                disabled={(mergeMode && selectedTablesForMerge.length > 0) || isSavingReservation}
                className={`min-w-0 flex-1 sm:w-auto sm:flex-none ${dsButton.primary}`}
              >
                {isSavingReservation && <Loader2 className="h-4 w-4 animate-spin" />}
                {isEditing ? 'Salva modifiche' : 'Crea prenotazione'}
              </button>
              {isEditing && (
                <button
                  type="button"
                  onClick={() => setFormStep(s => Math.min(RESERVATION_STEPS.length - 1, s + 1))}
                  disabled={formStep === RESERVATION_STEPS.length - 1}
                  aria-label="Sezione successiva"
                  title="Sezione successiva"
                  className={dsStepArrow}
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </>
          }
        >
                <div>
                    {/* Scroll sentinel: each step starts at its own top. */}
                    <div ref={formStepScrollRef} aria-hidden />
                    {/* The banners stay outside the steps on purpose. A no-show
                        warning is about the customer, not about one section, and
                        hiding it behind step 1 would let someone take a deposit
                        on step 2 without ever having seen it. */}
                    {matchedCustomerNoShows > 0 && (
                        <div className="mx-4 sm:mx-5 mt-4 flex items-start gap-3 rounded-[16px] bg-[var(--ds-critical-tint)] p-4">
                            <UserX className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-critical-text)]" />
                            <div className="flex-1 min-w-0">
                                <p className="text-[15px] font-semibold text-[var(--ds-critical-text)]">
                                    Attenzione: cliente con {matchedCustomerNoShows} no-show
                                </p>
                                <p className="mt-0.5 text-[13px] text-[var(--ds-critical-text)]">
                                    Questo cliente non si è presentato {matchedCustomerNoShows === 1 ? 'una volta' : `${matchedCustomerNoShows} volte`} in passato.
                                </p>
                            </div>
                        </div>
                    )}
                    {(matchedCustomerBlacklist != null || formData.customer_is_blacklisted) && (
                        <div className="mx-4 sm:mx-5 mt-4 flex items-start gap-3 rounded-[16px] bg-[var(--ds-critical-tint)] p-4">
                            <Ban className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-critical-text)]" />
                            <div className="flex-1 min-w-0">
                                <p className="text-[15px] font-semibold text-[var(--ds-critical-text)]">
                                    Cliente in blacklist
                                </p>
                                <p className="mt-0.5 text-[13px] text-[var(--ds-critical-text)]">
                                    {(matchedCustomerBlacklist || formData.customer_blacklist_reason || '').trim()
                                        || 'Web e agente vocale rifiutano questo numero; a mano decidi tu se procedere.'}
                                </p>
                            </div>
                        </div>
                    )}
                    {!isEditing && draftBanner && (
                        <div className="mx-4 sm:mx-5 mt-4 flex items-start gap-3 rounded-[16px] bg-[var(--ds-pending-tint)] p-4">
                            <Info className="mt-0.5 h-5 w-5 flex-shrink-0 text-[var(--ds-pending-text)]" />
                            <div className="flex-1 min-w-0">
                                <p className="text-[15px] font-semibold text-[var(--ds-pending-text)]">Bozza non salvata trovata</p>
                                <p className="mt-0.5 text-[13px] text-[var(--ds-pending-text)]">
                                    Salvata {new Date(draftBanner.savedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
                                </p>
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                                <button
                                    type="button"
                                    onClick={handleRestoreDraft}
                                    className="h-9 flex-shrink-0 rounded-full bg-[var(--ds-pending-solid)] px-3.5 text-[14px] font-semibold text-[var(--ds-pending-fg)] transition-all hover:brightness-95"
                                >
                                    Riprendi
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDiscardDraft}
                                    className="h-9 flex-shrink-0 rounded-full bg-[var(--ds-surface)] px-3.5 text-[14px] font-semibold text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                >
                                    Scarta
                                </button>
                            </div>
                        </div>
                    )}
                    {/* Step 1 — Dettagli. The wrapper carries the visibility so
                        the form keeps its own `grid` display; putting `hidden`
                        on the form itself would race the grid class. */}
                    <section className={!isEditing || formStep === 0 ? 'block' : 'hidden'}>
                    <form id="reservation-form" onSubmit={handleSubmit} className="grid grid-cols-1 gap-5 p-4 sm:p-6 lg:grid-cols-12">
                        {/* Left Column: Details (5 cols) */}
                        <div className="lg:col-span-5 flex flex-col gap-5 min-w-0">
                            <FormCard>
                                <div className="grid grid-cols-2 gap-3">
                                    <Field label="Numero ospiti">
                                        <Stepper
                                            value={formData.guests}
                                            min={1}
                                            required
                                            ariaLabel="Numero ospiti"
                                            onChange={next => setFormData({
                                                ...formData,
                                                guests: next,
                                                children: next != null ? Math.min(formData.children || 0, next) : formData.children,
                                            })}
                                        />
                                    </Field>
                                    <Field label="Di cui bambini">
                                        <Stepper
                                            value={formData.children ?? 0}
                                            min={0}
                                            max={formData.guests || 0}
                                            ariaLabel="Di cui bambini"
                                            onChange={next => setFormData({ ...formData, children: next ?? 0 })}
                                        />
                                    </Field>
                                </div>

                                <div className="mt-5">
                                    <Field label="Turno">
                                        <SegmentedControl
                                            ariaLabel="Turno"
                                            value={formData.shift === Shift.LUNCH ? Shift.LUNCH : Shift.DINNER}
                                            onChange={next => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                const isLunch = next === Shift.LUNCH;
                                                setFormData({
                                                    ...formData,
                                                    shift: next,
                                                    reservation_time: `${currentDate}T${isLunch ? '13:00' : '20:00'}`,
                                                    duration_minutes: defaultDurationForShift(next),
                                                });
                                            }}
                                            options={[
                                                { value: Shift.LUNCH, label: 'Pranzo', icon: <Sun className="h-3.5 w-3.5" /> },
                                                { value: Shift.DINNER, label: 'Cena', icon: <Sunset className="h-3.5 w-3.5" /> },
                                            ]}
                                        />
                                    </Field>
                                </div>

                                <div className="mt-5 grid grid-cols-2 gap-3">
                                    <Field label="Data">
                                        <input
                                            type="date"
                                            required
                                            className={`${dsInput} ds-date-input`}
                                            value={formData.reservation_time?.split('T')[0] || ''}
                                            onChange={e => {
                                                const currentTime = formData.reservation_time?.split('T')[1] || '20:00';
                                                setFormData({...formData, reservation_time: `${e.target.value}T${currentTime}`});
                                            }}
                                        />
                                    </Field>
                                    <Field label="Ora">
                                        <select
                                            required
                                            className={dsSelect}
                                            value={formData.reservation_time?.split('T')[1]?.substring(0, 5) || ''}
                                            onChange={e => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, reservation_time: `${currentDate}T${e.target.value}`});
                                            }}
                                        >
                                            {(() => {
                                                // Keep the currently-selected time visible even if it's
                                                // been disabled since the reservation was created — so
                                                // editing an existing row doesn't silently blank the field.
                                                const current = formData.reservation_time?.split('T')[1]?.substring(0, 5) || '';
                                                const options = [...formSlots];
                                                if (current && !options.includes(current)) options.push(current);
                                                options.sort();
                                                if (options.length === 0) {
                                                    return <option value="" disabled>Nessuno slot disponibile</option>;
                                                }
                                                return options.map(s => <option key={s} value={s}>{s}</option>);
                                            })()}
                                        </select>
                                    </Field>
                                </div>

                                <div className="mt-5">
                                    <Field
                                        label="Durata"
                                        aside={(() => {
                                            const start = formData.reservation_time ? parseLocalDate(formData.reservation_time) : null;
                                            const dur = resolveDurationMinutes({ duration_minutes: formData.duration_minutes, shift: formData.shift });
                                            if (!start) return null;
                                            const end = new Date(start.getTime() + dur * 60_000);
                                            const hh = String(end.getHours()).padStart(2, '0');
                                            const mm = String(end.getMinutes()).padStart(2, '0');
                                            return (
                                                <span className="tabular-nums">
                                                    Tavolo libero alle <span className="font-semibold text-[var(--ds-text-primary)]">{hh}:{mm}</span>
                                                </span>
                                            );
                                        })()}
                                    >
                                        <select
                                            className={dsSelect}
                                            value={formData.duration_minutes ?? defaultDurationForShift(formData.shift)}
                                            onChange={e => setFormData({ ...formData, duration_minutes: Number(e.target.value) })}
                                        >
                                            {[45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 210, 240].map(min => {
                                                const label = min < 60
                                                    ? `${min} min`
                                                    : min % 60 === 0
                                                        ? `${min / 60}h`
                                                        : `${Math.floor(min / 60)}h ${min % 60}`;
                                                return <option key={min} value={min}>{label}</option>;
                                            })}
                                        </select>
                                    </Field>
                                </div>

                                {slotArrivalStats && (
                                    <div className="mt-5">
                                        <Field
                                            label="Affluenza arrivi"
                                            aside={
                                                <span className="hidden sm:inline-flex items-center gap-2.5">
                                                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--ds-seated-solid)]" /> scarsa</span>
                                                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--ds-pending-solid)]" /> media</span>
                                                    <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-[var(--ds-critical-solid)]" /> alta</span>
                                                </span>
                                            }
                                        >
                                            <div className="flex gap-1">
                                                {slotArrivalStats.map(s => {
                                                    const bg = s.level === 'high' ? 'bg-[var(--ds-critical-solid)]'
                                                        : s.level === 'medium' ? 'bg-[var(--ds-pending-solid)]'
                                                        : s.level === 'low' ? 'bg-[var(--ds-seated-solid)]'
                                                        : 'bg-[var(--ds-surface-row)]';
                                                    const isSelected = formData.reservation_time?.split('T')[1]?.substring(0, 5) === s.time;
                                                    return (
                                                        <button
                                                            type="button"
                                                            key={s.time}
                                                            onClick={() => {
                                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                                setFormData({ ...formData, reservation_time: `${currentDate}T${s.time}` });
                                                            }}
                                                            className={`flex min-w-0 flex-1 flex-col items-center rounded-[10px] px-1 py-1.5 transition-colors ${isSelected ? 'bg-[var(--ds-surface-row)] ring-1 ring-inset ring-[var(--ds-border-strong)]' : 'hover:bg-[var(--ds-surface-row)]'}`}
                                                            title={`${s.time} — ${s.guests} coperti`}
                                                        >
                                                            <div className={`h-2.5 w-full rounded-full ${bg}`} />
                                                            <div className="mt-1 text-[11px] leading-tight tabular-nums text-[var(--ds-text-muted)]">{s.time}</div>
                                                            <div className="text-[12px] font-semibold leading-tight tabular-nums text-[var(--ds-text-primary)]">{s.guests}</div>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </Field>
                                    </div>
                                )}
                            </FormCard>

                            {/* Dettagli cliente — grouped in a fieldset so the legend
                                sits on the border ("cuts" it) and gives visual
                                weight to the block. Light grey fill + soft border
                                separates it from the datetime / table pickers above
                                without adding another card shadow. */}
                            <FormCard title="Dettagli cliente">
                            <div className="flex flex-col gap-5">
                            {/* Customer Name with Voice Input */}
                            <div>
                                <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">Nome cliente</label>
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 relative">
                                        <input
                                            required
                                            className={dsInput}
                                            value={formData.customer_name}
                                            onChange={e => {
                                                lastSuggestQueryRef.current = '';
                                                setMatchedCustomerNoShows(0);
                                                setMatchedCustomerBlacklist(null);
                                                setFormData({...formData, customer_name: e.target.value});
                                            }}
                                            onFocus={() => setActiveSuggestField('name')}
                                            onBlur={() => setTimeout(() => setActiveSuggestField(prev => prev === 'name' ? null : prev), 150)}
                                            placeholder="Mario Rossi"
                                            autoComplete="off"
                                        />
                                        {activeSuggestField === 'name' && customerSuggestions.length > 0 && (
                                            <ul className="absolute left-0 right-0 z-30 mt-1.5 max-h-60 overflow-y-auto rounded-[14px] bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-raised)]">
                                                {customerSuggestions.map(c => (
                                                    <li key={c.id}>
                                                        <button
                                                            type="button"
                                                            onMouseDown={e => e.preventDefault()}
                                                            onClick={() => applyCustomerSuggestion(c)}
                                                            className="w-full rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[15px] font-medium text-[var(--ds-text-primary)]">{c.name}</span>
                                                                {(c.no_show_count || 0) > 0 && (
                                                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-critical-tint)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ds-critical-text)]">
                                                                        <UserX className="h-2.5 w-2.5" />
                                                                        {c.no_show_count} no-show
                                                                    </span>
                                                                )}
                                                                {c.is_blacklisted && (
                                                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-critical-tint)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ds-critical-text)]">
                                                                        <Ban className="h-2.5 w-2.5" />
                                                                        blacklist
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="mt-0.5 flex flex-wrap gap-3 text-[13px] text-[var(--ds-text-muted)]">
                                                                {c.phone && <span>{c.phone}</span>}
                                                                {c.email && <span className="truncate">{c.email}</span>}
                                                            </div>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsCustomerPickerOpen(true)}
                                        className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                        title="Rubrica clienti"
                                    >
                                        <BookUser className="h-[18px] w-[18px]" />
                                    </button>
                                    {isVoiceSupported() && (
                                        <button
                                            type="button"
                                            onClick={handleVoiceInput}
                                            disabled={isListening}
                                            className={`inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                                                isListening
                                                    ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] animate-pulse motion-reduce:animate-none'
                                                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]'
                                            }`}
                                            title="Dettatura vocale"
                                        >
                                            <Mic className="h-[18px] w-[18px]" />
                                        </button>
                                    )}
                                </div>
                                {isVoiceSupported() && (
                                    <p className="mt-2 text-[13px] text-[var(--ds-text-muted)]">
                                        Premi il microfono e detta: "Prenotazione per Mario Rossi domani alle 20 per 4 persone"
                                    </p>
                                )}
                            </div>

                            {/* Phone & Email */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">
                                        Telefono
                                        {!(formData.email && formData.email.trim()) && <span className="text-[var(--ds-critical-text)]"> *</span>}
                                    </label>
                                    <div className="relative">
                                        <input
                                            type="tel"
                                            required={!(formData.email && formData.email.trim())}
                                            className={`${dsInput} ${formData.phone ? 'pr-10' : ''}`}
                                            value={formData.phone || ''}
                                            onChange={e => {
                                                lastSuggestQueryRef.current = '';
                                                setMatchedCustomerNoShows(0);
                                                setMatchedCustomerBlacklist(null);
                                                setFormData({...formData, phone: e.target.value});
                                            }}
                                            onFocus={() => setActiveSuggestField('phone')}
                                            onBlur={() => setTimeout(() => setActiveSuggestField(prev => prev === 'phone' ? null : prev), 150)}
                                            placeholder="+39 333..."
                                            autoComplete="off"
                                        />
                                        {formData.phone && (
                                            <a
                                                href={`tel:${formData.phone.replace(/[^\d+]/g, '')}`}
                                                onMouseDown={e => e.preventDefault()}
                                                className="absolute right-1.5 top-1/2 inline-flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[10px] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)] transition-all hover:brightness-95"
                                                aria-label="Chiama"
                                                title="Chiama"
                                            >
                                                <Phone className="h-3.5 w-3.5" />
                                            </a>
                                        )}
                                        {activeSuggestField === 'phone' && customerSuggestions.length > 0 && (
                                            <ul className="absolute left-0 right-0 z-30 mt-1.5 max-h-60 overflow-y-auto rounded-[14px] bg-[var(--ds-surface)] p-1 shadow-[var(--ds-shadow-raised)]">
                                                {customerSuggestions.map(c => (
                                                    <li key={c.id}>
                                                        <button
                                                            type="button"
                                                            onMouseDown={e => e.preventDefault()}
                                                            onClick={() => applyCustomerSuggestion(c)}
                                                            className="w-full rounded-[10px] px-3 py-2 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-[15px] font-medium text-[var(--ds-text-primary)]">{c.name}</span>
                                                                {(c.no_show_count || 0) > 0 && (
                                                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-critical-tint)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ds-critical-text)]">
                                                                        <UserX className="h-2.5 w-2.5" />
                                                                        {c.no_show_count} no-show
                                                                    </span>
                                                                )}
                                                                {c.is_blacklisted && (
                                                                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-critical-tint)] px-2 py-0.5 text-[12px] font-semibold text-[var(--ds-critical-text)]">
                                                                        <Ban className="h-2.5 w-2.5" />
                                                                        blacklist
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="mt-0.5 flex flex-wrap gap-3 text-[13px] text-[var(--ds-text-muted)]">
                                                                {c.phone && <span>{c.phone}</span>}
                                                                {c.email && <span className="truncate">{c.email}</span>}
                                                            </div>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">Email</label>
                                    <input
                                        type="email"
                                        className={dsInput}
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@email.com"
                                    />
                                </div>
                            </div>
                            </div>
                            </FormCard>

                            {/* Banchetto - shown only if there are banquets on the chosen date */}
                            {(() => {
                                const formDate = formData.reservation_time?.split('T')[0];
                                const banquetsForDate = formDate
                                    ? banquetMenus.filter(m => m.event_date === formDate)
                                    : [];
                                if (banquetsForDate.length === 0) return null;
                                return (
                                    <div>
                                        <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">Banchetto</label>
                                        <div className="relative">
                                            <select
                                                className={dsSelect}
                                                value={formData.banquet_menu_id ?? ''}
                                                onChange={e => setFormData({
                                                    ...formData,
                                                    banquet_menu_id: e.target.value ? Number(e.target.value) : undefined
                                                })}
                                            >
                                                <option value="">Nessuno</option>
                                                {banquetsForDate.map(m => (
                                                    <option key={m.id} value={m.id}>
                                                        {m.name}{canViewBanquetPrice && ` — €${Number(m.price_per_person).toFixed(2)}/persona`}
                                                    </option>
                                                ))}
                                            </select>
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ds-text-muted)] pointer-events-none" />
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Expandable Sections */}
                            <div className="space-y-3">
                                {/* Allergie & Intolleranze — two tabs, same preset list.
                                    Selecting an item is exclusive: it moves between the
                                    two lists. Allergie (serious) = rose, Intolleranze = amber. */}
                                <div className="overflow-hidden rounded-[16px] bg-[var(--ds-surface)]">
                                    <button
                                        type="button"
                                        onClick={() => setShowAllergensSection(!showAllergensSection)}
                                        className={`w-full flex items-center justify-between p-3 transition-colors ${
                                            showAllergensSection ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <AlertTriangle className={`h-4 w-4 ${(selectedAllergies.length + selectedAllergens.length) > 0 ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-secondary)]'}`} />
                                            <div className="text-left">
                                                <span className="text-sm font-medium text-[var(--ds-text-primary)]">Allergie &amp; Intolleranze</span>
                                                {(selectedAllergies.length + selectedAllergens.length) > 0 && (
                                                    <p className="text-xs text-[var(--ds-text-secondary)]">
                                                        {[selectedAllergies.length > 0 && `${selectedAllergies.length} allergie`, selectedAllergens.length > 0 && `${selectedAllergens.length} intolleranze`].filter(Boolean).join(' · ')}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-4 h-4 text-[var(--ds-text-muted)] transition-transform ${showAllergensSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showAllergensSection && (
                                        <div className="p-3 pt-0 space-y-3 border-t border-[var(--ds-border)] bg-[var(--ds-surface)]">
                                            {/* Tab switcher */}
                                            <div className="grid grid-cols-2 gap-0.5 p-1 mt-3 rounded-full bg-[var(--ds-surface-row)]">
                                                {([['allergie', 'Allergie', selectedAllergies.length], ['intolleranze', 'Intolleranze', selectedAllergens.length]] as const).map(([key, label, count]) => (
                                                    <button
                                                        key={key}
                                                        type="button"
                                                        onClick={() => setDietaryTab(key)}
                                                        className={`inline-flex items-center justify-center gap-1.5 h-9 rounded-full text-[14px] font-semibold transition-colors ${
                                                            dietaryTab === key
                                                                ? (key === 'allergie' ? 'bg-[var(--ds-critical-solid)] text-white' : 'bg-[var(--ds-pending-solid)] text-white')
                                                                : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                                                        }`}
                                                        aria-pressed={dietaryTab === key}
                                                    >
                                                        {label}
                                                        {count > 0 && (
                                                            <span className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold ${
                                                                dietaryTab === key ? 'bg-white/25' : (key === 'allergie' ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] ' : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ')
                                                            }`}>{count}</span>
                                                        )}
                                                    </button>
                                                ))}
                                            </div>

                                            {/* Preset grid for the active tab */}
                                            <div className="grid grid-cols-2 gap-2">
                                                {allergenPresets.map(item => {
                                                    const inActive = (dietaryTab === 'allergie' ? selectedAllergies : selectedAllergens).includes(item);
                                                    const inOther = (dietaryTab === 'allergie' ? selectedAllergens : selectedAllergies).includes(item);
                                                    const onCls = dietaryTab === 'allergie'
                                                        ? 'border-[var(--ds-critical-tint)] bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] '
                                                        : 'border-[var(--ds-pending-tint)] bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ';
                                                    const boxCls = dietaryTab === 'allergie'
                                                        ? 'bg-[var(--ds-critical-solid)] border-[var(--ds-critical-solid)] '
                                                        : 'bg-[var(--ds-pending-solid)] border-[var(--ds-pending-solid)] ';
                                                    return (
                                                        <button
                                                            key={item}
                                                            type="button"
                                                            onClick={() => {
                                                                // Exclusive: assigning to one tab removes it from the other.
                                                                if (dietaryTab === 'allergie') {
                                                                    setSelectedAllergens(prev => prev.filter(a => a !== item));
                                                                    setSelectedAllergies(prev => prev.includes(item) ? prev.filter(a => a !== item) : [...prev, item]);
                                                                } else {
                                                                    setSelectedAllergies(prev => prev.filter(a => a !== item));
                                                                    setSelectedAllergens(prev => prev.includes(item) ? prev.filter(a => a !== item) : [...prev, item]);
                                                                }
                                                            }}
                                                            className={`flex items-center gap-2 px-3.5 h-9 rounded-full transition-colors text-left ${
                                                                inActive ? onCls : 'border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)]'
                                                            }`}
                                                        >
                                                            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                                                inActive ? boxCls : 'border-[var(--ds-border)] bg-[var(--ds-surface)]'
                                                            }`}>
                                                                {inActive && <Check className="text-[#ffffff] w-2.5 h-2.5" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{item}</span>
                                                            {inOther && !inActive && (
                                                                <span className="ml-auto text-[10px] font-semibold text-[var(--ds-text-muted)] flex-shrink-0">
                                                                    {dietaryTab === 'allergie' ? 'intoll.' : 'allergia'}
                                                                </span>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {/* Combined summary — allergie (rose) + intolleranze (amber) */}
                                            {(selectedAllergies.length > 0 || selectedAllergens.length > 0) && (
                                                <div className="pt-1">
                                                    <DietaryChips notes={buildDietaryNote(selectedAllergies, selectedAllergens)} presets={allergenPresets} />
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Notes Button */}
                                <div className="overflow-hidden rounded-[16px] bg-[var(--ds-surface)]">
                                    <button
                                        type="button"
                                        onClick={() => setShowNotesSection(!showNotesSection)}
                                        className={`w-full flex items-center justify-between p-3 transition-colors ${
                                            showNotesSection ? 'bg-[var(--ds-surface-row)]' : 'bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <StickyNote className={`h-4 w-4 ${(selectedQuickNotes.length > 0 || noteSelections.length > 0 || formData.notes) ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-secondary)]'}`} />
                                            <div className="text-left">
                                                <span className="text-sm font-medium text-[var(--ds-text-primary)]">Note</span>
                                                {(selectedQuickNotes.length > 0 || noteSelections.length > 0) && (
                                                    <p className="text-xs text-[var(--ds-text-secondary)]">
                                                        {[
                                                          ...noteSelections.map(s => `${s.quantity}× ${s.label}${s.variant ? ` (${s.variant})` : ''}`),
                                                          ...selectedQuickNotes,
                                                        ].join(', ')}
                                                    </p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-4 h-4 text-[var(--ds-text-muted)] transition-transform ${showNotesSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showNotesSection && (
                                        <div className="p-3 pt-0 space-y-4 border-t border-[var(--ds-border)] bg-[var(--ds-surface)]">
                                            {/* Quick Notes. Chip senza has_quantity/varianti = toggle
                                                (dietro le quinte alimenta selectedQuickNotes → notes libere).
                                                Chip con struttura = apre un popover che chiede quantità e,
                                                se presente, la variante; il risultato entra in noteSelections. */}
                                            <div className="grid grid-cols-2 gap-2 pt-3">
                                                {quickNotes.map(note => {
                                                    const NoteIcon = getReservationNoteIcon(note.icon);
                                                    const structured = note.has_quantity || note.variants.length > 0;
                                                    const structuredPicks = structured
                                                      ? noteSelections.filter(s => s.preset_id === note.id)
                                                      : [];
                                                    const structuredTotalQty = structuredPicks.reduce((sum, s) => sum + s.quantity, 0);
                                                    const isSelected = structured
                                                      ? structuredPicks.length > 0
                                                      : selectedQuickNotes.includes(note.label);
                                                    return (
                                                        <NoteChip
                                                            key={`chip-${note.id}`}
                                                            note={note}
                                                            NoteIcon={NoteIcon}
                                                            structured={structured}
                                                            structuredPicks={structuredPicks}
                                                            structuredTotalQty={structuredTotalQty}
                                                            isSelected={isSelected}
                                                            isOpen={notePickerFor === note.id}
                                                            onChipClick={() => {
                                                                if (structured) {
                                                                    setNotePickerFor(prev => prev === note.id ? null : note.id);
                                                                } else {
                                                                    setSelectedQuickNotes(prev =>
                                                                        isSelected
                                                                            ? prev.filter(n => n !== note.label)
                                                                            : [...prev, note.label]
                                                                    );
                                                                }
                                                            }}
                                                            onCommit={(nextPicks) => {
                                                                setNoteSelections(prev => {
                                                                    const others = prev.filter(s => s.preset_id !== note.id);
                                                                    return [...others, ...nextPicks];
                                                                });
                                                                setNotePickerFor(null);
                                                            }}
                                                            onCancel={() => setNotePickerFor(null)}
                                                        />
                                                    );
                                                })}
                                            </div>

                                            {/* Free text notes */}
                                            <div>
                                                <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">Altre note</label>
                                                <textarea
                                                    className={`${dsTextarea} h-20 resize-none`}
                                                    placeholder="Richieste speciali..."
                                                    value={formData.notes || ''}
                                                    onChange={e => setFormData({...formData, notes: e.target.value})}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {/* GDPR consents — captured at booking and stored with a timestamp as proof (art. 7 GDPR).
                                    Health/allergy consent is gated by the "Chiedi consenso allergie" legal setting;
                                    the whole card hides when neither consent applies. */}
                                {((askHealthConsent && selectedAllergens.length > 0) || marketingEnabled) && (
                                <div className="mt-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3">
                                    <label className="mb-1.5 block text-[14px] font-medium text-[var(--ds-text-secondary)]">Consensi privacy (GDPR)</label>
                                    <div className="space-y-1.5">
                                        {askHealthConsent && selectedAllergens.length > 0 && (
                                        <label className="flex items-start gap-2 text-sm text-[var(--ds-text-primary)] cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="mt-0.5 h-4 w-4 rounded flex-shrink-0"
                                                checked={formData.consent_data_health === true}
                                                onChange={e => setFormData({ ...formData, consent_data_health: e.target.checked })}
                                            />
                                            <span>Consenso al trattamento di allergie / intolleranze <span className="text-[var(--ds-text-secondary)]">(dati sanitari, art. 9 GDPR)</span></span>
                                        </label>
                                        )}
                                        {marketingEnabled && (
                                        <label className="flex items-start gap-2 text-sm text-[var(--ds-text-primary)] cursor-pointer">
                                            <input
                                                type="checkbox"
                                                className="mt-0.5 h-4 w-4 rounded flex-shrink-0"
                                                checked={formData.consent_marketing === true}
                                                onChange={e => setFormData({ ...formData, consent_marketing: e.target.checked })}
                                            />
                                            <span>Consenso all'invio di comunicazioni commerciali <span className="text-[var(--ds-text-secondary)]">(marketing)</span></span>
                                        </label>
                                        )}
                                    </div>
                                    {formData.consent_updated_at && (
                                        <p className="text-[11px] text-[var(--ds-text-muted)] mt-1.5">
                                            Consensi aggiornati il {new Date(formData.consent_updated_at).toLocaleString('it-IT', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </p>
                                    )}
                                </div>
                                )}
                            </div>
                        </div>

                        {/* Right Column: Table Selection (7 cols) */}
                        <div className="lg:col-span-7 flex flex-col min-w-0 h-full rounded-[20px] bg-[var(--ds-surface)] p-5 sm:p-6">
                             {/* Section Header */}
                             <div className="flex flex-wrap items-center gap-3 pb-4 mb-4 border-b border-[var(--ds-border)]">
                                <MapPin className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-secondary)]" />
                                <div className="flex-1">
                                    <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Seleziona tavolo</h3>
                                    <p className="text-[14px] text-[var(--ds-text-muted)]">
                                        {formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'} — {' '}
                                        <span className="font-semibold text-[var(--ds-seated-text)]">{freeTablesCount} tavoli liberi</span> su {totalTablesInFilter}
                                    </p>
                                </div>
                                {selectedTableObj && (
                                    /* Solid pill: table name, its capacity, and a clear action.
                                       Green rather than near-black — near-black is this system's
                                       "action" colour, and an assigned table is a state, not a
                                       button. White on this green measures 6.7:1; the secondary
                                       "posti" text at 80% still clears AA at 4.9:1. */
                                    <div className="inline-flex flex-shrink-0 items-center gap-2 rounded-full bg-[var(--ds-seated-solid)] py-1.5 pl-4 pr-1.5">
                                        <span className="whitespace-nowrap text-[15px] font-semibold text-white">
                                            Tavolo {selectedTableObj.name}
                                        </span>
                                        <span className="whitespace-nowrap text-[14px] text-white/80">
                                            {selectedTableObj.seats} posti
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFormData({...formData, table_id: undefined});
                                                showToast('Tavolo scollegato dalla prenotazione', 'info');
                                            }}
                                            className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                                            title="Scollega il tavolo dalla prenotazione"
                                            aria-label="Scollega tavolo dalla prenotazione"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                )}
                             </div>

                             {/* Auto-assign & Actions */}
                             <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                <div className="flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleAutoAssign}
                                        className={dsButton.primary}
                                    >
                                        <Wand2 className="h-4 w-4" /> Assegna automatico
                                    </button>

                                    {/* Merge Mode Toggle */}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (mergeMode) {
                                                setMergeMode(false);
                                                setSelectedTablesForMerge([]);
                                            } else {
                                                setMergeMode(true);
                                                if (formData.table_id) {
                                                    setSelectedTablesForMerge([formData.table_id]);
                                                }
                                            }
                                        }}
                                        className={mergeMode ? dsButton.primary : dsButton.secondary}
                                    >
                                        <Combine className="h-4 w-4" /> {mergeMode ? 'Esci unione' : 'Unisci tavoli'}
                                    </button>
                                </div>
                                <div className="flex gap-2 items-center">
                                    {/* Show selected tables count and total capacity */}
                                    {selectedTablesForMerge.length >= 1 && (
                                        <div className="text-xs text-[var(--ds-text-secondary)] bg-[var(--ds-surface-row)] border border-[var(--ds-border)] px-3 py-1.5 rounded-full font-medium">
                                            {selectedTablesForMerge.length} {selectedTablesForMerge.length === 1 ? 'tavolo' : 'tavoli'} = {tables.filter(t => selectedTablesForMerge.includes(t.id)).reduce((sum, t) => sum + t.seats, 0)} posti
                                        </div>
                                    )}

                                    {selectedTablesForMerge.length >= 2 && (
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!formData.reservation_time || !formData.shift) {
                                                    showToast('Imposta data e turno della prenotazione prima di unire i tavoli', 'error');
                                                    return;
                                                }
                                                try {
                                                    const primaryTableId = selectedTablesForMerge[0];
                                                    const mergeDate = formData.reservation_time.split('T')[0];
                                                    await onMergeTables(selectedTablesForMerge, mergeDate, formData.shift);
                                                    await refreshMerges(mergeDate, formData.shift);
                                                    // Auto-select the merged table for the reservation
                                                    setFormData(prev => ({ ...prev, table_id: primaryTableId }));
                                                    showToast(`Tavoli uniti e assegnati alla prenotazione`, 'success');
                                                    setSelectedTablesForMerge([]);
                                                    setMergeMode(false);
                                                } catch (error) {
                                                    showToast('Errore durante l\'unione dei tavoli', 'error');
                                                }
                                            }}
                                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 bg-[var(--ds-text-primary)] text-[var(--ds-action-fg)] text-sm font-medium hover:opacity-90 transition-opacity"
                                        >
                                            <Combine className="h-4 w-4" /> Conferma Unione
                                        </button>
                                    )}

                                    {selectedTableObj?.merged_with && selectedTableObj.merged_with.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!formData.reservation_time || !formData.shift) {
                                                    showToast('Imposta data e turno della prenotazione prima di dividere i tavoli', 'error');
                                                    return;
                                                }
                                                try {
                                                    const splitDate = formData.reservation_time.split('T')[0];
                                                    await onSplitTable(selectedTableObj.id, splitDate, formData.shift);
                                                    await refreshMerges(splitDate, formData.shift);
                                                    showToast('Tavoli divisi con successo', 'success');
                                                    setFormData({...formData, table_id: undefined});
                                                } catch (error) {
                                                    showToast('Errore durante la divisione dei tavoli', 'error');
                                                }
                                            }}
                                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 border border-[var(--ds-pending-tint)] bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] dark:text-sm font-medium transition-colors"
                                        >
                                            <Scissors className="h-4 w-4" /> Dividi
                                        </button>
                                    )}
                                </div>
                             </div>

                             {/* Room Tabs */}
                             <div className="mb-4">
                                 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                                     <button
                                        type="button"
                                        onClick={() => setModalRoomFilter('ALL')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${modalRoomFilter === 'ALL' ? 'bg-[var(--ds-text-primary)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'}`}
                                     >
                                         Tutte le sale
                                     </button>
                                     {openRooms.map(room => (
                                         <button
                                            key={room.id}
                                            type="button"
                                            onClick={() => setModalRoomFilter(room.id)}
                                            className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${modalRoomFilter === room.id ? 'bg-[var(--ds-text-primary)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'}`}
                                         >
                                             {room.name}
                                         </button>
                                     ))}
                                 </div>
                             </div>

                             <div className="flex-1 min-h-0 rounded-lg overflow-y-auto relative max-h-[50vh] lg:max-h-none">
                                {isLoadingMerges && (
                                    <div className="absolute inset-0 z-30 bg-[var(--ds-surface-row)]/70 backdrop-blur-[1px] flex items-center justify-center rounded-lg">
                                        <div className="flex items-center gap-2 rounded-full bg-[var(--ds-surface)] px-4 py-2 shadow-[var(--ds-shadow-card)]">
                                            <Loader label="Caricamento tavoli…" size={40} />
                                        </div>
                                    </div>
                                )}
                                {displayedRooms.map(room => {
                                    const baseRoomTables = displayTables
                                        .filter(t => t.room_id === room.id)
                                        .filter(t => !displayTables.some(other =>
                                            other.merged_with && other.merged_with.length > 0 &&
                                            other.merged_with.map(id => Number(id)).includes(Number(t.id))
                                        ))
                                        .filter(t => !hiddenTableIds.has(t.id))
                                        // Show tables in natural ascending order by name (e.g. 0, 1, 2,
                                        // 3, 3 Bis, 4, 10, 11, 20…) instead of raw DB/insertion order,
                                        // which can be scattered for rooms like "Fuori".
                                        .sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));

                                    // Partition the room's tables: banquet tables collapse into one
                                    // grouped container per event; the rest render as selectable cards.
                                    const banquetGroups = new Map<number, { banquet: BanquetMenu; tables: typeof baseRoomTables }>();
                                    const normalEntries: { table: (typeof baseRoomTables)[number]; reservation: Reservation | null }[] = [];
                                    baseRoomTables.forEach(table => {
                                        const occupier = getOccupierForTableInForm(table.id);
                                        if (occupier?.kind === 'banquet') {
                                            const g = banquetGroups.get(occupier.data.id) ?? { banquet: occupier.data, tables: [] };
                                            g.tables.push(table);
                                            banquetGroups.set(occupier.data.id, g);
                                        } else {
                                            normalEntries.push({ table, reservation: occupier?.kind === 'reservation' ? occupier.data : null });
                                        }
                                    });

                                    const tavoliCount = baseRoomTables.length;
                                    const eventiCount = banquetGroups.size;
                                    const occupatiCount = normalEntries.filter(e => e.reservation).length;
                                    const liberiCount = normalEntries.length - occupatiCount;
                                    const guests = formData.guests || 1;
                                    // Sequential per-room color assignment so the modal matches the floor plan.
                                    const modalBanquetColorByBanquetId = buildBanquetColorClassMap([...banquetGroups.keys()]);

                                    return (
                                    <div key={room.id} className="mb-3 last:mb-0 rounded-[16px] bg-[var(--ds-surface-row)] p-4">
                                        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5">
                                            <h4 className="min-w-0 text-[15px] font-semibold text-[var(--ds-text-primary)]">
                                                {room.name}
                                                <span className="font-normal text-[var(--ds-text-muted)]">
                                                    {' · '}{tavoliCount} {tavoliCount === 1 ? 'tavolo' : 'tavoli'}
                                                    {eventiCount > 0 ? ` · ${eventiCount} ${eventiCount === 1 ? 'evento' : 'eventi'}` : ''}
                                                </span>
                                            </h4>
                                            <div className="ml-auto flex flex-shrink-0 items-center gap-2">
                                                <span className={`inline-flex h-8 flex-shrink-0 items-baseline gap-1.5 rounded-full border px-3 leading-8 ${
                                                    liberiCount > 0
                                                        ? 'border-[var(--ds-seated-solid)] bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                                                        : 'border-[var(--ds-border-strong)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]'
                                                }`}>
                                                    <span className="text-[17px] font-bold tabular-nums">{liberiCount}</span>
                                                    <span className="text-[13px] font-medium">{liberiCount === 1 ? 'libero' : 'liberi'}</span>
                                                </span>
                                                {occupatiCount > 0 && (
                                                    <span className="inline-flex h-8 flex-shrink-0 items-baseline gap-1.5 rounded-full border border-[var(--ds-critical-solid)] bg-[var(--ds-critical-tint)] px-3 leading-8 text-[var(--ds-critical-text)]">
                                                        <span className="text-[17px] font-bold tabular-nums">{occupatiCount}</span>
                                                        <span className="text-[13px] font-medium">{occupatiCount === 1 ? 'occupato' : 'occupati'}</span>
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        {/* Banquet / event containers — one grouped card per event,
                                            tinted with the same per-banquet color used on the floor plan. */}
                                        {[...banquetGroups.values()].map(({ banquet, tables: bTables }) => (
                                            <div key={`banq-${banquet.id}`} className={`${modalBanquetColorByBanquetId.get(banquet.id) || 'banquet-color-0'} mb-4 rounded-xl border border-[var(--ds-arriving-solid)] bg-[var(--ds-arriving-tint)] p-3`}>
                                                <div className="flex items-start gap-2 mb-3">
                                                    <span className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-[var(--ds-arriving-solid)] text-white">
                                                        <Calendar size={14} />
                                                    </span>
                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold text-[var(--ds-arriving-text)] truncate">{banquet.name}</p>
                                                        <p className="text-xs text-[var(--ds-arriving-text)]">
                                                            {bTables.length} {bTables.length === 1 ? 'tavolo' : 'tavoli'} · {banquet.guests ?? 0} coperti · {banquet.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'}
                                                        </p>
                                                    </div>
                                                </div>
                                                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-3">
                                                    {bTables.map(t => (
                                                        <div key={t.id} className="flex min-h-[44px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--ds-arriving-solid)] px-2 py-2 text-center">
                                                            <TableGlyph name={t.name} seats={t.seats} shape={t.shape} status="libera" fit />
                                                            <span className="inline-flex items-center gap-1 text-[11px] text-[var(--ds-arriving-text)]">
                                                                <Armchair size={11} /> {t.seats}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        ))}

                                        {/* Selectable tables */}
                                        {normalEntries.length > 0 && (
                                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-2 gap-y-3 sm:gap-x-3 sm:gap-y-4 pt-2">
                                            {normalEntries.map(({ table, reservation }) => {
                                                const isOccupied = !!reservation;
                                                const occLabel = reservation ? formatShortName(reservation.customer_name) : '';
                                                const occGuests = reservation?.guests;
                                                const occTime = reservation ? getRomeTimePart(reservation.reservation_time) : '';
                                                const isSelected = formData.table_id === table.id;
                                                const isSelectedForMerge = selectedTablesForMerge.includes(table.id);
                                                const isMerged = table.merged_with && table.merged_with.length > 0;
                                                const insufficient = table.seats < guests;
                                                const recommended = !isOccupied && table.seats >= guests && table.seats <= guests + 1;

                                                return (
                                                    <button
                                                        key={table.id}
                                                        type="button"
                                                        disabled={isOccupied || (insufficient && !mergeMode)}
                                                        onClick={(e) => {
                                                            if (mergeMode || e.ctrlKey || e.metaKey) {
                                                                e.preventDefault();
                                                                setSelectedTablesForMerge(prev =>
                                                                    prev.includes(table.id)
                                                                        ? prev.filter(id => id !== table.id)
                                                                        : [...prev, table.id]
                                                                );
                                                            } else if (formData.table_id === table.id) {
                                                                // Toggle off: clicking the selected table again clears it.
                                                                setFormData(prev => ({ ...prev, table_id: undefined }));
                                                            } else {
                                                                handleTableSelection(table);
                                                            }
                                                        }}
                                                        className={`relative flex w-full min-h-[88px] flex-col items-center justify-center gap-1.5 rounded-[14px] p-2 sm:p-3 text-center transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                                                            isSelectedForMerge
                                                                ? 'z-10 bg-[var(--ds-arriving-tint)] ring-2 ring-inset ring-[var(--ds-arriving-solid)]'
                                                                : isSelected
                                                                    ? 'z-10 bg-[var(--ds-seated-solid)] text-white'
                                                                    : isOccupied
                                                                        ? 'cursor-not-allowed bg-[var(--ds-critical-tint)]'
                                                                        : recommended
                                                                            ? 'bg-[var(--ds-seated-tint)] ring-1 ring-inset ring-[var(--ds-seated-solid)]/40 hover:brightness-[0.97]'
                                                                            : insufficient
                                                                                ? 'cursor-not-allowed bg-[var(--ds-surface)] opacity-50'
                                                                                : 'bg-[var(--ds-surface)] ring-1 ring-inset ring-[var(--ds-border)] hover:ring-[var(--ds-border-strong)]'
                                                        }`}
                                                    >
                                                        {recommended && !isSelected && !isSelectedForMerge && (
                                                            <span className="absolute -top-2 left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-full bg-[var(--ds-seated-solid)] px-2 py-0.5 text-[10px] font-semibold text-white">
                                                                Consigliato
                                                            </span>
                                                        )}

                                                        {isMerged && !isSelectedForMerge && (
                                                            <span className={`absolute -top-1.5 sm:-top-2 -left-1.5 sm:-left-2 z-20 flex items-center gap-0.5 rounded-full px-1 sm:px-1.5 py-0.5 text-[8px] sm:text-[10px] font-bold shadow-[var(--ds-shadow-card)] ${isSelected ? 'bg-[var(--ds-surface)] text-[var(--ds-seated-text)]' : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'}`}>
                                                                <Combine size={8} />
                                                            </span>
                                                        )}

                                                        <TableGlyph
                                                            name={table.name}
                                                            seats={table.seats}
                                                            shape={table.shape}
                                                            status="libera"
                                                            fit
                                                        />

                                                        {/* Capacity (chair icon) — shown on every table */}
                                                        <span className={`inline-flex items-center gap-1 text-[11px] sm:text-xs ${isSelected ? 'text-white/80' : 'text-[var(--ds-text-muted)]'}`}>
                                                            <Armchair size={11} /> {table.seats}
                                                        </span>

                                                        {/* Occupied footer: actual covers (people icon) + time */}
                                                        {isOccupied && (
                                                            <div className="mt-1 w-full pt-1">
                                                                <p className="truncate text-[11px] sm:text-xs font-medium text-[var(--ds-text-primary)]">{occLabel}</p>
                                                                <p className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] text-[var(--ds-text-secondary)]">
                                                                    <Users size={10} /> {occGuests}{occTime ? ` · ${occTime}` : ''}
                                                                </p>
                                                            </div>
                                                        )}

                                                        {isSelected && !isSelectedForMerge && (
                                                            <span className="absolute top-1.5 right-1.5 z-20 text-[var(--ds-action-fg)]">
                                                                <Check size={15} strokeWidth={3} />
                                                            </span>
                                                        )}
                                                        {isSelectedForMerge && (
                                                            <span className="absolute -top-2 -right-2 z-20 flex items-center justify-center rounded-full bg-[var(--ds-arriving-solid)] p-1 shadow-[var(--ds-shadow-card)]">
                                                                <Combine size={10} className="text-white" />
                                                            </span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        )}
                                    </div>
                                    );
                                })}
                                {displayedRooms.length === 0 && (
                                    <div className="text-center py-10 text-[var(--ds-text-muted)]">
                                        Nessuna sala trovata.
                                    </div>
                                )}
                             </div>
                             <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mt-4 pt-4 border-t border-[var(--ds-border)] text-[12px] text-[var(--ds-text-secondary)]">
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-surface)] ring-1 ring-inset ring-[var(--ds-border-strong)]"></span> Libero</div>
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-seated-tint)] ring-1 ring-inset ring-[var(--ds-seated-solid)]"></span> Consigliato</div>
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-seated-solid)]"></span> Selezionato</div>
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-critical-tint)]"></span> Occupato</div>
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-surface)] opacity-50"></span> Capienza insuff.</div>
                                 <div className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-[4px] bg-[var(--ds-arriving-tint)]"></span> Evento / Banchetto</div>
                             </div>
                             {mergeMode && (
                                 <div className="mt-3 rounded-full bg-[var(--ds-surface-row)] px-3.5 py-2 text-[13px] font-medium text-[var(--ds-text-secondary)]">
                                     Modalità unione attiva: clicca sui tavoli da unire, poi premi "Conferma Unione"
                                 </div>
                             )}
                        </div>
                    </form>
                    </section>

                    {/* Step 2 — Pagamenti: the table bill, then the deposit
                        request. Both were already edit-only, so this section
                        renders nothing at all on a new booking. */}
                    <section className={!isEditing || formStep === 1 ? 'block' : 'hidden'}>
                    {/* Conto al tavolo (pay-at-table + split bill) — edit mode only.
                        Hidden entirely when the feature flag is off; the toggle
                        lives in Settings → Conto al tavolo. */}
                    {isEditing && formData.id && hasPermission('payments:view') && payAtTableEnabled && (
                      <div className="px-4 pb-4 sm:px-6">
                        <FormCard>
                          <div className="mb-4 flex flex-wrap items-center gap-2">
                            <Receipt className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                            <h4 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Conto al tavolo</h4>
                            {bill && (() => {
                              const state = billStateLabel(bill.bill.total_cents, bill.paid_cents);
                              return <StatusPill tone={state.tone}>{state.label}</StatusPill>;
                            })()}
                            {bill && (
                              <span className="ml-auto text-[13px] text-[var(--ds-text-muted)]">
                                {billTableName ? `Tav. ${billTableName} · ` : ''}{bill.bill.covers} coperti
                              </span>
                            )}
                          </div>

                          {billLoading && !bill && (
                            <div className="flex items-center gap-2 text-[13px] text-[var(--ds-text-muted)]">
                              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Caricamento…
                            </div>
                          )}

                          {!billLoading && !bill && hasPermission('payments:full') && (() => {
                            const busy = billActionLoading === 'open' || billActionLoading === 'open-and-notify' || billActionLoading === 'import-pp';
                            // Fase 2 ibrida: righe e totale dalla comanda del
                            // gestionale di sala. Visibile solo con un tavolo
                            // assegnato — il nome è la chiave su Passepartout.
                            const resvTableName = formData.table_id != null
                              ? (tables.find(t => t.id === formData.table_id)?.name ?? null)
                              : null;
                            return (
                              <div className="space-y-3">
                                <p className="text-[14px] text-[var(--ds-text-muted)]">
                                  Apri il conto per generare un QR che gli ospiti possono scansionare per pagare la propria quota.
                                </p>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,140px)_minmax(0,120px)_auto]">
                                  <Field label="Totale">
                                    <div className="relative">
                                      <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        placeholder="0,00"
                                        value={billTotalInput}
                                        onChange={e => setBillTotalInput(e.target.value)}
                                        disabled={busy}
                                        className={`${dsInput} pl-7`}
                                      />
                                    </div>
                                  </Field>
                                  <Field label="Coperti">
                                    <input
                                      type="number"
                                      min={1}
                                      placeholder={formData.guests ? `${formData.guests}` : 'Coperti'}
                                      value={billCoversInput}
                                      onChange={e => setBillCoversInput(e.target.value)}
                                      disabled={busy}
                                      className={dsInput}
                                    />
                                  </Field>
                                  <div className="flex items-end">
                                    <button
                                      type="button"
                                      onClick={() => handleOpenBill()}
                                      disabled={busy}
                                      className={`w-full sm:w-auto ${dsButton.primary}`}
                                    >
                                      {billActionLoading === 'open' ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                                      Apri conto
                                    </button>
                                  </div>
                                </div>
                                {/* One-tap combo: open the bill AND immediately push the link
                                    to the customer (SMS today; WhatsApp when a template lands).
                                    Disabled if the reservation has no phone. */}
                                <button
                                  type="button"
                                  onClick={() => handleOpenBill({ notify: true })}
                                  disabled={busy || !formData.phone}
                                  title={!formData.phone ? 'La prenotazione non ha un numero di telefono' : undefined}
                                  className={`w-full ${dsButton.secondary}`}
                                >
                                  {billActionLoading === 'open-and-notify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                  Apri e invia link al cliente
                                </button>
                                {resvTableName && (
                                  <button
                                    type="button"
                                    onClick={() => handleImportBillFromPassepartout(resvTableName)}
                                    disabled={busy}
                                    className={`w-full ${dsButton.secondary}`}
                                  >
                                    {billActionLoading === 'import-pp' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Receipt className="h-4 w-4" />}
                                    Importa dal gestionale (tav. {resvTableName})
                                  </button>
                                )}
                              </div>
                            );
                          })()}

                          {!billLoading && !bill && !hasPermission('payments:full') && (
                            <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun conto attivo.</p>
                          )}

                          {bill && (
                            <>
                              <BillFigures
                                totalCents={bill.bill.total_cents}
                                paidCents={bill.paid_cents}
                                residualCents={bill.residual_cents}
                              />

                              {/* The QR and the printed pre-bill moved behind this
                                  button, into the same BillSheet the Pagamenti page
                                  opens. One panel for a bill everywhere, and the card
                                  leads with the figures instead of a 128px code. */}
                              <div className="mt-4 flex flex-wrap items-center gap-2">
                                {bill.bill.share_token && (
                                  <button
                                    type="button"
                                    onClick={() => setBillSheetOpen(true)}
                                    className={dsButton.primary}
                                  >
                                    <QrCode className="h-4 w-4" /> Mostra QR al tavolo
                                  </button>
                                )}
                                {hasPermission('payments:full') && (
                                  <>
                                    <button
                                      type="button"
                                      onClick={handleNotifyBill}
                                      disabled={billActionLoading !== null || !formData.phone}
                                      title={!formData.phone ? 'La prenotazione non ha un numero di telefono' : undefined}
                                      className={dsButton.secondary}
                                    >
                                      {billActionLoading === 'notify' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                                      Invia link
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handlePrintBill('QR')}
                                      disabled={billActionLoading !== null || !bill.bill.share_token}
                                      title={!bill.bill.share_token ? 'Conto chiuso: il QR non è più valido' : undefined}
                                      className={dsButton.secondary}
                                    >
                                      {billActionLoading === 'print-qr' ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                                      Stampa QR
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => handlePrintBill('PRECONTO')}
                                      disabled={billActionLoading !== null}
                                      className={dsButton.secondary}
                                    >
                                      {billActionLoading === 'print-preconto' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                                      Stampa preconto
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setBillSheetOpen(true)}
                                      disabled={billActionLoading !== null}
                                      className="inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[var(--ds-seated-tint)] px-5 text-[15px] font-semibold text-[var(--ds-seated-text)] transition-colors hover:brightness-95 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                    >
                                      {billActionLoading === 'close' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Banknote className="h-4 w-4" />}
                                      Incassa e chiudi
                                    </button>
                                    <button
                                      type="button"
                                      onClick={handleVoidBill}
                                      disabled={billActionLoading !== null}
                                      className="ml-auto inline-flex h-11 items-center justify-center gap-2 rounded-full px-4 text-[15px] font-medium text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                                    >
                                      {billActionLoading === 'void' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                                      Annulla conto
                                    </button>
                                  </>
                                )}
                              </div>

                              {bill.splits.filter(s => s.status === 'CLAIMED' || s.status === 'PAID').length > 0 && (
                                <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
                                  <h5 className="mb-2 text-[13px] font-semibold text-[var(--ds-text-primary)]">
                                    Quote
                                    <span className="ml-1 font-normal text-[var(--ds-text-muted)]">
                                      {bill.splits.filter(s => s.status === 'PAID').length} pagate
                                    </span>
                                  </h5>
                                  <ul className="space-y-1.5">
                                    {bill.splits.filter(s => s.status === 'CLAIMED' || s.status === 'PAID').map(s => {
                                      const eur = (s.amount_cents / 100).toFixed(2).replace('.', ',');
                                      return (
                                        <li key={s.id} className="flex items-center gap-2 rounded-[12px] bg-[var(--ds-surface-row)] px-3 py-2 text-[14px]">
                                          {s.status === 'PAID'
                                            ? <Check className="h-4 w-4 shrink-0 text-[var(--ds-seated-text)]" />
                                            : <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--ds-pending-text)]" />}
                                          <span className="min-w-0 flex-1 truncate text-[var(--ds-text-primary)]">{s.claimant_label || 'Anonimo'}</span>
                                          <span className="text-[13px] text-[var(--ds-text-muted)]">
                                            {s.status === 'PAID' ? 'Pagata' : 'In attesa'}
                                          </span>
                                          <span className="font-medium tabular-nums text-[var(--ds-text-primary)]">€ {eur}</span>
                                          {s.status === 'PAID' && hasPermission('payments:full') && (
                                            <button
                                              type="button"
                                              onClick={() => handleRefundSplit(s.id)}
                                              onBlur={() => setRefundConfirmSplitId(prev => prev === s.id ? null : prev)}
                                              disabled={refundingSplitId !== null}
                                              title={refundConfirmSplitId === s.id ? 'Tocca di nuovo per confermare il rimborso' : 'Rimborsa quota'}
                                              className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2 text-[12px] font-semibold transition-colors disabled:opacity-50 ${
                                                refundConfirmSplitId === s.id
                                                  ? 'bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] hover:brightness-95'
                                                  : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]'
                                              }`}
                                            >
                                              {refundingSplitId === s.id
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                : <RotateCcw className="h-3.5 w-3.5" />}
                                              {refundConfirmSplitId === s.id && 'Confermi?'}
                                            </button>
                                          )}
                                        </li>
                                      );
                                    })}
                                  </ul>
                                </div>
                              )}
                            </>
                          )}
                        </FormCard>
                      </div>
                    )}

                    {/* Payment link (active gateway) — only in edit mode (needs a saved reservation to attach to) */}
                    {isEditing && formData.id && (
                      <div className="px-4 pb-4 sm:px-6 sm:pb-6">
                        <FormCard>
                          <div className="mb-4 flex flex-wrap items-center gap-2">
                            <CreditCard className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                            <h4 className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Richiedi un acconto</h4>
                            <span className="ml-auto text-[13px] text-[var(--ds-text-muted)]">
                              {paymentProviderLabel}
                            </span>
                          </div>

                          {/* Canale di invio del link. Radio: un solo canale per
                              invio. I canali senza recapito sul booking sono mutati
                              (email→nessuna email, WhatsApp/SMS→nessun telefono). */}
                          <div className="mb-4">
                            <span className="mb-1.5 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Invia il link tramite</span>
                            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                              {([
                                { key: 'email' as const, label: 'Email', icon: Mail, target: formData.email, missing: 'Nessuna email sul contatto' },
                                { key: 'whatsapp' as const, label: 'WhatsApp', icon: MessageCircle, target: formData.phone, missing: 'Nessun telefono sul contatto' },
                                { key: 'sms' as const, label: 'SMS', icon: Phone, target: formData.phone, missing: 'Nessun telefono sul contatto' },
                              ]).map(({ key, label, icon: Icon, target, missing }) => {
                                const available = paymentChannelAvailable[key];
                                const selected = paymentChannel === key && available;
                                return (
                                  <button
                                    key={key}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    disabled={!available || isCreatingPayment}
                                    onClick={() => setPaymentChannel(key)}
                                    title={available ? (target || undefined) : missing}
                                    className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                                      selected
                                        ? 'border-[var(--ds-accent)] bg-[var(--ds-accent-subtle)] ring-1 ring-[var(--ds-accent)]'
                                        : 'border-[var(--ds-border)] bg-[var(--ds-surface-2)] hover:bg-[var(--ds-surface-hover)]'
                                    }`}
                                  >
                                    <Icon className={`h-4 w-4 flex-shrink-0 ${selected ? 'text-[var(--ds-accent)]' : 'text-[var(--ds-text-muted)]'}`} aria-hidden />
                                    <span className="min-w-0 flex-1">
                                      <span className="block text-[13px] font-semibold text-[var(--ds-text-primary)]">{label}</span>
                                      <span className="block truncate text-[11px] text-[var(--ds-text-muted)]">{available ? (target || '') : missing}</span>
                                    </span>
                                    {selected && <Check className="h-4 w-4 flex-shrink-0 text-[var(--ds-accent)]" aria-hidden />}
                                  </button>
                                );
                              })}
                            </div>
                          </div>

                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,150px)_1fr]">
                            <Field label="Importo">
                              <div className="relative">
                                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[15px] text-[var(--ds-text-muted)]">€</span>
                                <input
                                  type="text"
                                  inputMode="decimal"
                                  placeholder="0,00"
                                  value={paymentAmount}
                                  onChange={e => setPaymentAmount(e.target.value)}
                                  disabled={isCreatingPayment}
                                  className={`${dsInput} pl-7`}
                                />
                              </div>
                            </Field>
                            <Field label="Descrizione">
                              <input
                                type="text"
                                placeholder="Es. acconto cena del 15/08"
                                value={paymentDescription}
                                onChange={e => setPaymentDescription(e.target.value)}
                                disabled={isCreatingPayment}
                                className={dsInput}
                              />
                            </Field>
                          </div>

                          <div className="mt-4 flex justify-end">
                            <button
                              type="button"
                              onClick={handleCreatePaymentRequest}
                              disabled={isCreatingPayment || !paymentChannelAvailable[paymentChannel]}
                              className={`w-full sm:w-auto ${dsButton.primary}`}
                              title={!paymentChannelAvailable[paymentChannel]
                                ? 'Nessun canale disponibile: aggiungi email o telefono'
                                : `Genera il link e invia ${paymentChannel === 'email' ? 'via email' : paymentChannel === 'sms' ? 'via SMS' : 'via WhatsApp'}`}
                            >
                              {isCreatingPayment ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                              Invia link
                            </button>
                          </div>

                          {!formData.phone && !formData.email && (
                            <p className="mt-2 text-[13px] text-[var(--ds-critical-text)]">
                              Aggiungi un'email o un numero di telefono per inviare il link di pagamento.
                            </p>
                          )}

                          {paymentRequests.length > 0 && (
                            <div className="mt-4 border-t border-[var(--ds-border)] pt-4">
                              <h5 className="mb-2 text-[13px] font-semibold text-[var(--ds-text-primary)]">
                                Richieste già inviate
                                <span className="ml-1 font-normal text-[var(--ds-text-muted)] tabular-nums">
                                  {paymentRequests.length}
                                </span>
                              </h5>
                              <ul className="space-y-1.5">
                                {paymentRequests.map(pr => (
                                  <PaymentRequestRow
                                    key={pr.id}
                                    request={pr}
                                    copied={copiedPaymentId === pr.id}
                                    onCopy={() => copyPaymentLink(pr)}
                                    onRevoke={hasPermission('payments:full') ? () => handleRevokePaymentRequest(pr.id) : undefined}
                                    revoking={revokingPaymentId === pr.id}
                                  />
                                ))}
                              </ul>
                            </div>
                          )}
                        </FormCard>
                      </div>
                    )}

                    {/* Portals to <body>, so the hidden step wrapper around it
                        does not affect it. */}
                    {billSheetOpen && bill && (
                      <BillSheet
                        bill={{
                          id: bill.bill.id,
                          table_name: billTableName,
                          total_cents: bill.bill.total_cents,
                          covers: bill.bill.covers,
                          share_token: bill.bill.share_token,
                          items: bill.bill.items,
                          paid_cents: bill.paid_cents,
                          cash_settled_cents: bill.bill.cash_settled_cents,
                          deposit_credit_cents: bill.deposit_credit_cents,
                          deposit_paid_cents: bill.deposit_paid_cents,
                          refund_due_cents: bill.refund_due_cents,
                          residual_cents: bill.residual_cents,
                          external_ref: bill.bill.external_ref,
                        }}
                        busy={billActionLoading === 'close'}
                        onClose={() => setBillSheetOpen(false)}
                        onSettle={(opts) => { setBillSheetOpen(false); handleCloseBill(opts); }}
                      />
                    )}
                    </section>

                    {/* Step 3 — Comunicazione. The SMS, WhatsApp and email
                        history for this booking. The accordion this used to sit
                        behind is gone: the step is the section, so a header you
                        had to click to reveal the only thing on screen was one
                        tap that bought nothing. */}
                    <section className={!isEditing || formStep === 2 ? 'block' : 'hidden'}>
                    {isEditing && formData.id && (
                      <div className="px-4 pb-4 sm:px-6 sm:pb-6">
                        <MessaggiPanel
                          messages={outboundMessages}
                          loading={outboundMessagesLoading}
                          phone={formData.phone}
                          email={formData.email}
                          onNewEmail={() => {
                            setCustomEmailSubject('');
                            setCustomEmailBody('');
                            setCustomEmailOpen(true);
                          }}
                          onSendConfirmation={() => setConfirmationPicker({
                            reservation: { ...(formData as Reservation) },
                            fromSave: false,
                          })}
                          onSendReminder={handleSendReminder}
                          reminderSending={reminderSending}
                          reminderSent={formData.reminder_sent === true}
                        />
                      </div>
                    )}
                    </section>
                </div>

        </ModalShell>
      )}

      {/* Confirmation Modal — portaled: it opens above the (portaled) booking
          form, so inside the list subtree it would paint underneath it. */}
      {confirmModal?.isOpen && createPortal(
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={confirmModal.onCancel}>
            <div className="bg-[var(--ds-surface)] rounded-2xl shadow-2xl border border-[var(--ds-border)] w-full max-w-md max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--ds-border)]">
                    <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)] flex items-center gap-2">
                        {confirmModal.title}
                    </h3>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <p className="text-sm text-[var(--ds-text-primary)] leading-relaxed whitespace-pre-line">
                        {confirmModal.message}
                    </p>

                    {confirmModal.suggestions && confirmModal.suggestions.length > 0 && (
                        <div className="bg-[var(--ds-surface-row)] border border-[var(--ds-border)] rounded-lg p-3">
                            <p className="text-sm font-semibold text-[var(--ds-text-primary)] mb-3">
                                Tavoli disponibili con capienza adeguata
                            </p>
                            <div className="space-y-2">
                                {confirmModal.suggestions.map((suggestion, index) => (
                                    <button
                                        key={index}
                                        onClick={() => confirmModal.onSelectSuggestion?.(suggestion.table)}
                                        className="w-full flex items-center justify-between gap-3 p-3 bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md hover:border-[var(--ds-action-bg)] hover:bg-[var(--ds-surface-row)] transition-colors group"
                                    >
                                        <div className="flex items-center gap-2 text-[var(--ds-text-primary)]">
                                            <Armchair size={16} className="text-[var(--ds-text-muted)]" />
                                            <span className="text-sm font-medium">{suggestion.label}</span>
                                        </div>
                                        <div className="text-[var(--ds-text-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Check size={16} />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-[var(--ds-border)] flex flex-col sm:flex-row justify-end gap-2">
                    <button
                        onClick={confirmModal.onCancel}
                        className="w-full sm:w-auto px-4 py-2 rounded-full border border-[var(--ds-border)] text-[var(--ds-text-primary)] text-sm font-medium hover:bg-[var(--ds-surface-row)]"
                    >
                        Annulla
                    </button>
                    <button
                        onClick={confirmModal.onConfirm}
                        className="w-full sm:w-auto px-4 py-2 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-sm font-medium hover:opacity-90"
                    >
                        Procedi Comunque
                    </button>
                </div>
            </div>
        </div>,
        document.body
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={deleteConfirmModal.show}
        message="Stai per eliminare la prenotazione di:"
        itemName={toTitleCase(deleteConfirmModal.customerName)}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />

      <ConfirmDeleteModal
        isOpen={unhideAllConfirm}
        title="Riattiva tutti i tavoli"
        message={`Stai per riattivare ${hiddenTableIds.size} ${hiddenTableIds.size === 1 ? 'tavolo nascosto' : 'tavoli nascosti'} per questo turno.`}
        confirmLabel="Riattiva tutti"
        icon={<Eye className="h-5 w-5 text-[var(--ds-seated-text)]" />}
        iconWrapperClassName="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ds-seated-tint)]"
        confirmClassName="inline-flex items-center justify-center gap-2 h-11 px-5 rounded-full bg-[var(--ds-seated-solid)] text-[var(--ds-seated-fg)] text-[15px] font-semibold hover:opacity-90 transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        showIrreversibleWarning={false}
        onCancel={() => setUnhideAllConfirm(false)}
        onConfirm={async () => {
          setUnhideAllConfirm(false);
          await handleUnhideAllTables();
        }}
      />

      {/* Preflight modal: future-date confirmation + duplicate-booking warning */}
      {preflightModal && (() => {
        const futureWarning = preflightModal.warnings.find(w => w.kind === 'futureDate') as Extract<PreflightWarning, { kind: 'futureDate' }> | undefined;
        const pastWarning = preflightModal.warnings.find(w => w.kind === 'pastTime') as Extract<PreflightWarning, { kind: 'pastTime' }> | undefined;
        const sameDayMatches = preflightModal.warnings.filter(w => w.kind === 'sameDayDuplicate') as Extract<PreflightWarning, { kind: 'sameDayDuplicate' }>[];
        const nearMatches = preflightModal.warnings.filter(w => w.kind === 'nearDuplicate') as Extract<PreflightWarning, { kind: 'nearDuplicate' }>[];
        const hasDuplicate = sameDayMatches.length + nearMatches.length > 0;

        const formatMatchLine = (r: Reservation): string => {
          const dt = parseLocalDate(r.reservation_time);
          if (!dt) return r.reservation_time;
          const datePart = dt.toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
          const timePart = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
          return `${datePart} · ${timePart} · ${r.guests || '?'} ospiti`;
        };

        // Portaled: opens on top of the portaled booking form; rendered in the
        // list subtree it would end up behind it (invisible "Conferma" tap).
        return createPortal(
          <div
            className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] sm:px-4"
            onClick={() => { if (!isSavingReservation) setPreflightModal(null); }}
          >
            <div
 className="bg-[var(--ds-surface)] w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] overflow-hidden duration-200 pb-[env(safe-area-inset-bottom)] sm:pb-0"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-center pt-3 pb-1 sm:hidden">
                <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
              </div>
              <div className="flex items-start justify-between p-4 border-b border-[var(--ds-border)]">
                <div className="flex items-start gap-3 min-w-0">
                  <span className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] flex-shrink-0">
                    <AlertTriangle className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">
                      {hasDuplicate ? 'Verifica prenotazione' : 'Conferma prenotazione'}
                    </h3>
                    <p className="text-xs text-[var(--ds-text-muted)] mt-0.5 truncate">
                      {toTitleCase(preflightModal.payload.customer_name || '')}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => { if (!isSavingReservation) setPreflightModal(null); }}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-4 space-y-4">
                {futureWarning && (
                  <div className="rounded-[16px] bg-[var(--ds-arriving-tint)] p-4">
                    <p className="text-[13px] font-semibold text-[var(--ds-arriving-text)]">
                      Prenotazione futura
                      {futureWarning.daysAhead === 1 ? ' · domani' : ` · tra ${futureWarning.daysAhead} giorni`}
                    </p>
                    <p className="mt-2 text-[20px] font-semibold text-[var(--ds-text-primary)] capitalize leading-tight">
                      {futureWarning.weekday} {futureWarning.date}
                    </p>
                    <p className="mt-1 text-[28px] font-bold text-[var(--ds-text-primary)] tabular-nums">
                      {futureWarning.time}
                    </p>
                    <p className="mt-2 text-sm text-[var(--ds-text-muted)]">
                      Conferma che la data e l'ora siano corrette.
                    </p>
                  </div>
                )}

                {pastWarning && (
                  <div className="rounded-[16px] bg-[var(--ds-critical-tint)] p-4">
                    <p className="text-[13px] font-semibold text-[var(--ds-critical-text)]">
                      Orario già passato
                      {pastWarning.minutesAgo >= 60
                        ? ` · ${Math.floor(pastWarning.minutesAgo / 60)}h fa`
                        : ` · ${pastWarning.minutesAgo} min fa`}
                    </p>
                    <p className="mt-2 text-[20px] font-semibold text-[var(--ds-text-primary)] capitalize leading-tight">
                      {pastWarning.date}
                    </p>
                    <p className="mt-1 text-[28px] font-bold text-[var(--ds-text-primary)] tabular-nums">
                      {pastWarning.time}
                    </p>
                    <p className="mt-2 text-sm text-[var(--ds-text-muted)]">
                      Questo orario di oggi è già trascorso. Verifica di non aver sbagliato giorno o turno (es. pranzo invece di cena).
                    </p>
                  </div>
                )}

                {hasDuplicate && (
                  <div className="rounded-[16px] bg-[var(--ds-pending-tint)] p-4">
                    <p className="text-[13px] font-semibold text-[var(--ds-pending-text)]">
                      Possibile duplicato
                    </p>
                    <p className="mt-2 text-sm text-[var(--ds-text-primary)]">
                      Una prenotazione simile esiste già per <strong>{toTitleCase(preflightModal.payload.customer_name || '')}</strong>:
                    </p>
                    <ul className="mt-2 space-y-1.5">
                      {sameDayMatches.map(w => (
                        <li key={`s-${w.match.id}`} className="text-sm text-[var(--ds-text-primary)] flex items-center gap-2">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--ds-pending-solid)]" />
                          <span>Stesso giorno · {formatMatchLine(w.match)}</span>
                        </li>
                      ))}
                      {nearMatches.map(w => (
                        <li key={`n-${w.match.id}`} className="text-sm text-[var(--ds-text-primary)] flex items-center gap-2">
                          <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--ds-pending-solid)]" />
                          <span>{w.dayDiff === 1 ? 'A 1 giorno' : `A ${w.dayDiff} giorni`} · {formatMatchLine(w.match)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--ds-border)] bg-[var(--ds-surface-row)]">
                <button
                  type="button"
                  onClick={() => setPreflightModal(null)}
                  disabled={isSavingReservation}
                  className="px-4 py-2 rounded-full text-sm font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={async () => { await performSave(preflightModal.payload); }}
                  disabled={isSavingReservation}
                  className="px-4 py-2 rounded-full text-sm font-medium bg-[var(--ds-action-bg)] text-[var(--ds-surface)] hover:opacity-90 disabled:opacity-50 inline-flex items-center gap-2"
                >
                  {isSavingReservation && <Loader2 className="h-4 w-4 animate-spin" />}
                  Conferma e salva
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Confirmation-channel picker — shown after a save (fromSave=true) or via
          the "Invia conferma" button on the card (fromSave=false). Options are
          filtered by which contact fields are filled on the booking. */}
      {confirmationPicker && (() => {
        const target = confirmationPicker.reservation;
        const hasPhone = !!(target.phone && target.phone.trim());
        const hasEmail = !!(target.email && target.email.trim());
        // A PENDING reservation is one that arrived via the public booking
        // form and is waiting for staff to approve. When the operator picks
        // a channel here, the backend flips it to CONFIRMED — so the labels
        // and the header change to reflect the dual action.
        const isPending = (target.reservation_status as any) === 'PENDING';
        const actionPrefix = isPending ? 'Conferma e invia' : 'Invia';
        const closePicker = () => {
          if (sendingConfirmation) return;
          setConfirmationPicker(null);
          if (confirmationPicker.fromSave) setIsFormOpen(false);
        };
        return createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4"
            onClick={closePicker}
          >
            <div
              className="bg-[var(--ds-surface)] rounded-2xl shadow-[var(--ds-shadow-raised)] w-full max-w-md overflow-hidden"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-5 border-b border-[var(--ds-border)]">
                <h3 className="text-lg font-semibold text-[var(--ds-text-primary)]">
                  {isPending ? 'Conferma la prenotazione' : 'Invia conferma al cliente?'}
                </h3>
                <p className="mt-1 text-sm text-[var(--ds-text-muted)]">
                  {isPending ? (
                    <>Scegli il canale per confermare la prenotazione di <strong>{toTitleCase(target.customer_name || '')}</strong>: lo stato passerà da "Da confermare" a "Confermata".</>
                  ) : (
                    <>Vuoi mandare una conferma della prenotazione a <strong>{toTitleCase(target.customer_name || '')}</strong>?</>
                  )}
                </p>
              </div>
              <div className="p-5 space-y-2">
                {hasPhone && (
                  <button
                    type="button"
                    onClick={() => handlePickConfirmationChannel('sms')}
                    disabled={sendingConfirmation !== null}
                    className="w-full flex items-center gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-row)] hover:bg-[var(--ds-surface-row)] px-4 py-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {sendingConfirmation === 'sms'
                      ? <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-seated-solid)]" />
                      : <MessageCircle className="h-5 w-5 text-[var(--ds-seated-solid)]" />}
                    <div className="text-left flex-1">
                      <div className="text-sm font-semibold text-[var(--ds-text-primary)]">{actionPrefix} SMS</div>
                      <div className="text-[11px] text-[var(--ds-text-muted)]">{target.phone}</div>
                    </div>
                  </button>
                )}
                {hasPhone && (
                  <button
                    type="button"
                    onClick={() => handlePickConfirmationChannel('whatsapp')}
                    disabled={sendingConfirmation !== null}
                    className="w-full flex items-center gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-row)] hover:bg-[var(--ds-surface-row)] px-4 py-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {sendingConfirmation === 'whatsapp'
                      ? <Loader2 className="h-5 w-5 animate-spin text-[var(--ds-seated-solid)]" />
                      : <MessageCircle className="h-5 w-5 text-[var(--ds-seated-solid)]" />}
                    <div className="text-left flex-1">
                      <div className="text-sm font-semibold text-[var(--ds-text-primary)]">{actionPrefix} WhatsApp</div>
                      <div className="text-[11px] text-[var(--ds-text-muted)]">{target.phone}</div>
                    </div>
                  </button>
                )}
                {hasEmail && (
                  <button
                    type="button"
                    onClick={() => handlePickConfirmationChannel('email')}
                    disabled={sendingConfirmation !== null}
                    className="w-full flex items-center gap-3 rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface-row)] hover:bg-[var(--ds-surface-row)] px-4 py-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <Send className="h-5 w-5 text-[var(--ds-arriving-solid)]" />
                    <div className="text-left flex-1">
                      <div className="text-sm font-semibold text-[var(--ds-text-primary)]">{actionPrefix} Email</div>
                      <div className="text-[11px] text-[var(--ds-text-muted)]">{target.email}</div>
                    </div>
                  </button>
                )}
              </div>
              <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-[var(--ds-border)] bg-[var(--ds-surface-row)]">
                {isPending ? (
                  <span className="text-[11px] text-[var(--ds-text-subtle)]">
                    La conferma parte solo dopo la tua scelta di canale.
                  </span>
                ) : <span />}
                <button
                  type="button"
                  onClick={closePicker}
                  disabled={sendingConfirmation !== null}
                  className="px-4 py-2 rounded-full text-sm font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
                >
                  {isPending ? 'Salva senza confermare' : 'Non ora'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Free-form email composer — opened from the "Nuova email" button in
          the Comunicazione con il cliente section. Kept intentionally simple:
          subject + textarea, live char counters, no rich formatting (the
          server wraps the body in the shared branded HTML template). */}
      {customEmailOpen && formData.email && (() => {
        const closeComposer = () => {
          if (customEmailSending) return;
          setCustomEmailOpen(false);
        };
        const subjectLimit = 200;
        const bodyLimit = 5000;
        const canSend = customEmailSubject.trim().length > 0
          && customEmailBody.trim().length > 0
          && !customEmailSending;
        return createPortal(
          <div
            className="fixed inset-0 z-[80] bg-black/50 flex items-center justify-center p-4"
            onClick={closeComposer}
          >
            <div
              className="bg-[var(--ds-surface)] rounded-2xl shadow-[var(--ds-shadow-raised)] w-full max-w-lg overflow-hidden flex flex-col max-h-[92vh]"
              onClick={e => e.stopPropagation()}
            >
              <div className="p-5 border-b border-[var(--ds-border)]">
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-[var(--ds-arriving-solid)]" />
                  <h3 className="text-lg font-semibold text-[var(--ds-text-primary)]">Nuova email</h3>
                </div>
                <p className="mt-1 text-sm text-[var(--ds-text-muted)]">
                  Invia un'email libera a <strong className="text-[var(--ds-text-primary)]">{formData.email}</strong>.
                </p>
              </div>
              <div className="p-5 space-y-3 overflow-y-auto">
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-[var(--ds-text-muted)]">Oggetto</label>
                    <span className={`text-[10px] tabular ${customEmailSubject.length > subjectLimit ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                      {customEmailSubject.length}/{subjectLimit}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={customEmailSubject}
                    onChange={e => setCustomEmailSubject(e.target.value.slice(0, subjectLimit))}
                    disabled={customEmailSending}
                    placeholder="Es. Correzione orario prenotazione"
                    className="w-full h-10 px-3 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] text-sm focus:outline-none focus:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus:border-transparent"
                    autoFocus
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-xs font-medium text-[var(--ds-text-muted)]">Messaggio</label>
                    <span className={`text-[10px] tabular ${customEmailBody.length > bodyLimit ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-subtle)]'}`}>
                      {customEmailBody.length}/{bodyLimit}
                    </span>
                  </div>
                  <textarea
                    value={customEmailBody}
                    onChange={e => setCustomEmailBody(e.target.value.slice(0, bodyLimit))}
                    disabled={customEmailSending}
                    rows={8}
                    placeholder="Ciao Francesca, ci scusiamo: l'email precedente riportava un orario errato. La prenotazione è confermata per le 21:00, non le 23:00. Grazie!"
                    className="w-full px-3 py-2 rounded-lg border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] text-sm leading-relaxed focus:outline-none focus:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus:border-transparent resize-y"
                  />
                  <p className="mt-1.5 text-[11px] text-[var(--ds-text-subtle)]">
                    L'email userà il template grafico standard con logo e footer. Il saluto iniziale ("Ciao {toTitleCase((formData.customer_name || '').split(' ')[0] || 'cliente')}") e la firma finale vengono aggiunti automaticamente.
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--ds-border)] bg-[var(--ds-surface-row)]">
                <button
                  type="button"
                  onClick={closeComposer}
                  disabled={customEmailSending}
                  className="px-4 py-2 rounded-full text-sm font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] disabled:opacity-50"
                >
                  Annulla
                </button>
                <button
                  type="button"
                  onClick={handleSendCustomEmail}
                  disabled={!canSend}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] text-sm font-medium hover:bg-[var(--ds-action-bg-hover)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  {customEmailSending
                    ? <><Loader2 className="h-4 w-4 animate-spin" /> Invio…</>
                    : <><Send className="h-4 w-4" /> Invia</>}
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      <PrintReservationsModal
        isOpen={isPrintModalOpen}
        onClose={() => setIsPrintModalOpen(false)}
        reservations={reservations}
        banquetMenus={banquetMenus}
        rooms={rooms}
        tables={tables}
        initialDate={selectedDate.split('T')[0]}
        initialShift={selectedShift}
      />

      {/* Mobile bottom-sheet per i toggle canali. Su desktop la stessa UI vive
          inline nell'header (BookingChannelsBar), quindi qui è mobile-only. */}
      {showChannelsSheet && createPortal(
        <div className="fixed inset-0 z-[80] flex items-end" onClick={() => setShowChannelsSheet(false)} role="dialog" aria-modal="true" aria-label="Canali di prenotazione">
          <div className="absolute inset-0 bg-black/40" />
 <div className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-raised)] pb-6 duration-200"onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
            </div>
            <div className="px-5 pb-3 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Canali di prenotazione</h3>
                <p className="text-[12px] text-[var(--ds-text-muted)] mt-0.5">
                  {selectedDate.split('T')[0]} · {selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'}
                </p>
              </div>
              <button type="button" onClick={() => setShowChannelsSheet(false)} className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]" aria-label="Chiudi">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-5 flex items-center gap-3">
              <BookingChannelsBar
                date={selectedDate.split('T')[0]}
                shift={selectedShift === Shift.LUNCH ? 'LUNCH' : 'DINNER'}
                showToast={(msg, kind) => showToast(msg, kind ?? 'info')}
              />
              <p className="text-[12px] text-[var(--ds-text-muted)] leading-tight">
                Tocca l'icona per bloccare o riattivare il canale per questo turno.
              </p>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Overdue-table prompt: a seated party is past its expected duration
          and the state was never updated — ask whether they're still there.
          Yields to the pickers so it never stacks over an open modal. */}
      {overduePromptRes && !stateChangeReservation && !declineReservation && (() => {
        const res = overduePromptRes;
        const table = res.table_id ? displayTables.find(t => t.id === res.table_id) : undefined;
        const end = new Date(new Date(res.reservation_time).getTime() + getEffectiveDurationMin(res) * 60_000);
        const endLabel = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;
        // Portaled to <body>: inside the list's stacking context the mobile
        // bottom nav paints over the sheet and hides the action buttons.
        return createPortal(
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[var(--ds-backdrop)] sm:px-4" onClick={() => snoozeOverduePrompt(res)}>
 <div className="bg-[var(--ds-surface)] w-full sm:max-w-md rounded-t-[24px] sm:rounded-[24px] shadow-[var(--ds-shadow-raised)] overflow-hidden duration-200 pb-[env(safe-area-inset-bottom)] sm:pb-0"onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-center pt-3 pb-1 sm:hidden">
                <div className="w-9 h-1 rounded-full bg-[var(--ds-border-strong)]" />
              </div>

              {/* Testata: solo titolo e chiusura. "Chiudi tutti" stava qui e
                  rubava larghezza al titolo, che andava a capo e portava con
                  se' il troncamento del sottotitolo — ora sta in fondo. */}
              <div className="flex items-start gap-4 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
                <div className="min-w-0 flex-1">
                  <h3 className="text-[18px] font-semibold leading-snug tracking-[-0.01em] text-[var(--ds-text-primary)]">
                    Tavolo ancora occupato?
                  </h3>
                  <p className="mt-1 truncate text-[14px] text-[var(--ds-text-muted)]">
                    {toTitleCase(res.customer_name)} · {formatTime(res.reservation_time)}{table ? ` · Tavolo ${table.name}` : ''}
                  </p>
                </div>
                <button onClick={() => snoozeOverduePrompt(res)}
                  aria-label="Chiudi questo avviso"
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="px-5 pb-5 sm:px-6 sm:pb-6">
                <p className="text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">
                  Il tempo previsto è terminato alle {endLabel} e lo stato non è stato aggiornato.
                </p>
                <p className="mt-4 text-[15px] leading-relaxed text-[var(--ds-text-secondary)]">
                  I clienti sono ancora al tavolo?
                </p>

                {/* Impilati e a tutta larghezza: affiancati, "Ancora qui · +30
                    min" non ci sta e va a capo dentro il bottone. */}
                <div className="mt-3 flex flex-col gap-2.5">
                  <button type="button"
                    onClick={() => {
                      snoozeOverduePrompt(res);
                      onUpdateReservation({ ...res, duration_minutes: extendedDurationMin(res, nowTick) });
                      showToast(`${toTitleCase(res.customer_name)}: +${OVERDUE_EXTEND_MIN} minuti al tavolo`, 'success');
                    }}
                    className="inline-flex w-full items-center justify-center gap-2 h-11 rounded-full text-[15px] font-semibold bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                    <UserCheck className="h-4 w-4" aria-hidden /> Ancora qui · +{OVERDUE_EXTEND_MIN} min
                  </button>
                  <button type="button"
                    onClick={() => { snoozeOverduePrompt(res); handleSetReservationState(res, 'freed'); }}
                    className="inline-flex w-full items-center justify-center gap-2 h-11 rounded-full text-[15px] font-medium bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                    <Armchair className="h-4 w-4" aria-hidden /> Libera il tavolo
                  </button>
                </div>

                {/* Compare solo quando ce n'e' piu' d'uno: con un tavolo solo
                    farebbe esattamente quello che fa la X in testata. */}
                {overdueQueue.length > 1 && (
                  <button type="button" onClick={snoozeAllOverduePrompts}
                    title={`Rimanda tutti i ${overdueQueue.length} avvisi di ${OVERDUE_SNOOZE_MIN} minuti`}
                    className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-full text-[14px] font-medium text-[var(--ds-text-secondary)] underline underline-offset-2 transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                    Chiudi tutti · {overdueQueue.length}
                  </button>
                )}
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* State picker modal */}
      {stateChangeReservation && (() => {
        const res = stateChangeReservation;
        // Mirror the timed state the list chip shows, so the checked option
        // never disagrees with the badge that opened this modal. The derived
        // 'arriving' isn't a pickable option: it checks 'waiting', its base.
        const timed = isViewingToday ? getTimedReservationState(res, nowTick) : getReservationState(res);
        const current: ReservationStateKey = timed === 'arriving' ? 'waiting' : timed;
        const isPending = (res.reservation_status || ReservationStatus.CONFIRMED) === ReservationStatus.PENDING;
        // For PENDING web bookings the only sensible actions are Conferma / Non confermata.
        const options: Exclude<ReservationStateKey, 'arriving'>[] = isPending
          ? ['waiting', 'declined']
          : ['pending', 'waiting', 'arrived', 'departing', 'freed', 'noshow', 'cancelled', 'declined'];
        const title = isPending ? 'Rispondi al cliente' : 'Cambia stato';
        return createPortal(
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] sm:px-4" onClick={() => setStateChangeReservation(null)}>
 <div className="bg-[var(--ds-surface)] w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] overflow-hidden duration-200 pb-[env(safe-area-inset-bottom)] sm:pb-0"onClick={(e) => e.stopPropagation()}>
              {/* Drag handle (mobile only) */}
              <div className="flex justify-center pt-3 pb-1 sm:hidden">
                <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
              </div>
              <div className="flex items-start justify-between p-4 border-b border-[var(--ds-border)]">
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">{title}</h3>
                    <p className="text-xs text-[var(--ds-text-muted)] mt-0.5 truncate">
                      {toTitleCase(res.customer_name)} · {formatTime(res.reservation_time)}
                    </p>
                  </div>
                  <button onClick={() => setStateChangeReservation(null)}
                    className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                    <X className="h-4 w-4" />
                  </button>
              </div>
              <div className="p-3 space-y-1.5">
                {options.map(opt => {
                  const meta = RESERVATION_STATE_META[opt];
                  const ds = reservationStateDs(opt);
                  const isCurrent = opt === current;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        if (isCurrent) {
                          setStateChangeReservation(null);
                          return;
                        }
                        // 'declined' always routes through the SMS-warning confirmation modal.
                        if (opt === 'declined') {
                          setStateChangeReservation(null);
                          setDeclineReservation(res);
                          return;
                        }
                        handleSetReservationState(res, opt);
                        setStateChangeReservation(null);
                      }}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                        isCurrent
                          ? `${ds.tint} ${ds.text} border-transparent ring-2 ring-offset-1 ring-[var(--ds-action-bg)]/20`
                          : 'border-[var(--ds-border)] bg-[var(--ds-surface)] hover:bg-[var(--ds-surface-row)]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <span className={`w-2 h-2 rounded-full ${ds.solid}`} />
                        <span className="text-sm font-medium text-[var(--ds-text-primary)]">{meta.label}</span>
                      </span>
                      {isCurrent && <Check className="h-4 w-4 text-[var(--ds-text-muted)]" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Decline confirmation modal: warns the operator that an SMS will be sent */}
      {declineReservation && (() => {
        const res = declineReservation;
        return createPortal(
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] sm:px-4" onClick={() => setDeclineReservation(null)}>
 <div className="bg-[var(--ds-surface)] w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] overflow-hidden duration-200 pb-[env(safe-area-inset-bottom)] sm:pb-0"onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-center pt-3 pb-1 sm:hidden">
                <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
              </div>
              <div className="flex items-start justify-between p-4 border-b border-[var(--ds-border)]">
                <div className="min-w-0">
                  <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">Non confermare</h3>
                  <p className="text-xs text-[var(--ds-text-muted)] mt-0.5 truncate">
                    {toTitleCase(res.customer_name)} · {formatTime(res.reservation_time)}
                  </p>
                </div>
                <button onClick={() => setDeclineReservation(null)}
                  className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-sm text-[var(--ds-text-primary)]">
                  Verrà inviato un SMS al cliente per informarlo che non è stato possibile confermare la prenotazione. Procedere?
                </p>
                <div className="flex items-center justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setDeclineReservation(null)}
                    className="px-3 h-9 rounded-lg text-sm font-medium border border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] transition-colors">
                    Annulla
                  </button>
                  <button type="button" onClick={() => { handleSetReservationState(res, 'declined'); setDeclineReservation(null); }}
                    className="inline-flex items-center gap-1.5 px-3 h-9 rounded-lg text-sm font-semibold bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] hover:opacity-90 transition-opacity">
                    <X className="h-4 w-4" /> Non confermare
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}

      {/* Unassigned-reservations modal: opened from the map header badge */}
      {showUnassignedModal && (() => {
          const dateOnly = selectedDate.split('T')[0];
          const effectiveShift: Shift = selectedShift !== 'ALL'
            ? selectedShift
            : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER);
          const unassigned = reservations
            .filter(r => getRomeDatePart(r.reservation_time) === dateOnly)
            .filter(r => r.shift === effectiveShift)
            .filter(r => !r.table_id)
            .filter(r => r.reservation_status !== ReservationStatus.CANCELLED && r.reservation_status !== ReservationStatus.DECLINED)
            .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));

          return (
            <ModalShell
              open
              onClose={() => setShowUnassignedModal(false)}
              closeOnEscape
              size="sm"
              title="Prenotazioni senza tavolo"
              subtitle={`${effectiveShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} · ${new Date(dateOnly).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' })}`}
              bodyClassName="p-4"
            >
              {unassigned.length === 0 ? (
                <EmptyState icon={Check}>
                  Tutte le prenotazioni hanno un tavolo per questo turno.
                </EmptyState>
              ) : (
                // Cards, not a divided list: each row is a booking you're about
                // to open, and it should look like the ones on the page behind.
                <div className="space-y-2">
                  {unassigned.map(r => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { setShowUnassignedModal(false); handleEditClick(r); }}
                      className="flex w-full items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] p-3.5 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)]"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">
                            {toTitleCase(r.customer_name)}
                          </span>
                          {renderOperatorBadge(r)}
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-[13px] text-[var(--ds-text-muted)]">
                          <span className="flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" aria-hidden /> {formatTime(r.reservation_time)}
                          </span>
                          <span className="flex items-center gap-1">
                            <Users className="h-3.5 w-3.5" aria-hidden /> {r.guests}
                          </span>
                          {r.phone && <span className="truncate">{r.phone}</span>}
                        </div>
                      </div>
                      <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                    </button>
                  ))}
                </div>
              )}
            </ModalShell>
          );
      })()}

      {/* Reservation chooser: click on a shared table (double-seating). */}
      {tableChooserModal && (() => {
          const { table, reservations: rows } = tableChooserModal;
          const dateOnly = selectedDate.split('T')[0];
          const dateLabel = new Date(dateOnly).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' });
          return (
            <div
                className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4"
                onClick={() => setTableChooserModal(null)}
            >
              <div
                  className="bg-[var(--ds-surface)] rounded-2xl shadow-2xl border border-[var(--ds-border)] w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col"
                  onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between p-4 border-b border-[var(--ds-border)]">
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)]">
                      Tavolo {table.name} · {rows.length} turni
                    </h3>
                    <p className="text-xs text-[var(--ds-text-muted)] mt-0.5">
                      {dateLabel} — scegli quale prenotazione aprire
                    </p>
                  </div>
                  <button
                      onClick={() => setTableChooserModal(null)}
                      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <ul className="flex-1 overflow-y-auto divide-y divide-[var(--ds-border)]">
                  {rows.map((r, i) => {
                    const t = getRomeTimePart(r.reservation_time);
                    const duration = resolveDurationMinutes(r);
                    const start = parseLocalDate(r.reservation_time);
                    const endLabel = start ? (() => {
                      const e = new Date(start.getTime() + duration * 60_000);
                      return `${String(e.getHours()).padStart(2, '0')}:${String(e.getMinutes()).padStart(2, '0')}`;
                    })() : '';
                    return (
                      <li key={r.id}>
                        <button
                            onClick={() => {
                              setTableChooserModal(null);
                              handleEditClick(r);
                            }}
                            className="w-full text-left px-4 py-3 hover:bg-[var(--ds-surface-row)] transition-colors flex items-center gap-3"
                        >
                          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] text-xs font-bold flex-shrink-0">
                            {i + 1}°
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {r.customer_is_vip && <Star className="h-3.5 w-3.5 text-[var(--ds-pending-solid)] fill-[var(--ds-pending-solid)] flex-shrink-0" />}
                              <span className="font-semibold text-[var(--ds-text-primary)] truncate">{toTitleCase(r.customer_name)}</span>
                            </div>
                            <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                              <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {t}{endLabel ? ` → ${endLabel}` : ''}</span>
                              <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {r.guests}</span>
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 text-[var(--ds-text-muted)] flex-shrink-0" />
                        </button>
                      </li>
                    );
                  })}
                </ul>

                {canEdit && (
                  <div className="p-3 border-t border-[var(--ds-border)]">
                    <button
                        onClick={() => {
                          setTableChooserModal(null);
                          setAssignTableModal(table);
                        }}
                        className="w-full px-4 py-2 rounded-full border border-[var(--ds-border)] text-[var(--ds-text-primary)] text-sm font-medium hover:bg-[var(--ds-surface-row)]"
                    >
                      Aggiungi un altro turno
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
      })()}

      {/* Assign-to-free-table modal: click on a free table in Map view */}
      {assignTableModal && (() => {
          const table = assignTableModal;
          const dateOnly = selectedDate.split('T')[0];
          const effectiveShift: Shift = selectedShift !== 'ALL'
            ? selectedShift
            : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER);
          const unassigned = reservations
            .filter(r => getRomeDatePart(r.reservation_time) === dateOnly)
            .filter(r => r.shift === effectiveShift)
            .filter(r => !r.table_id)
            .filter(r => r.reservation_status !== ReservationStatus.CANCELLED && r.reservation_status !== ReservationStatus.DECLINED)
            .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));

          const assign = (r: Reservation) => {
              onUpdateReservation({ ...r, table_id: table.id });
              showToast(`Tavolo ${table.name} assegnato a ${toTitleCase(r.customer_name)}`, 'success');
              setAssignTableModal(null);
          };

          const isHidden = hiddenTableIds.has(table.id);
          const isMerged = !!(table.merged_with && table.merged_with.length > 0);

          return (
            <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setAssignTableModal(null)}>
              <div className="bg-[var(--ds-surface)] rounded-2xl shadow-2xl border border-[var(--ds-border)] w-full max-w-md max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--ds-border)]">
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--ds-text-primary)] flex items-center gap-2">
                      <span className="truncate">Assegna Tavolo {table.name}</span>
                      {isHidden && (
                        <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-bold tracking-wide bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] px-1.5 py-0.5 rounded">
                          <EyeOff size={10} /> Nascosto
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-[var(--ds-text-muted)] mt-0.5 flex items-center gap-1.5">
                      <Armchair className="h-3 w-3" /> {table.seats} posti · {effectiveShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} · {new Date(dateOnly).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {canEdit && isMerged && (
                      <button
                        onClick={async () => {
                          try {
                            await onSplitTable(table.id, dateOnly, effectiveShift);
                            await refreshMerges(dateOnly, effectiveShift);
                            showToast('Tavoli divisi con successo', 'success');
                            setAssignTableModal(null);
                          } catch {
                            showToast('Errore durante la divisione dei tavoli', 'error');
                          }
                        }}
                        className="p-2 rounded-lg text-[var(--ds-pending-text)] hover:bg-[var(--ds-pending-tint)] transition-colors"
                        title={`Dividi i tavoli uniti (${table.name})`}
                      >
                        <Scissors className="h-5 w-5" />
                      </button>
                    )}
                    {canEdit && (
                      <button
                        onClick={async () => {
                          await handleToggleTableHidden(table);
                          setAssignTableModal(null);
                        }}
                        className={`p-2 rounded-lg transition-colors ${
                          isHidden
                            ? 'text-[var(--ds-seated-text)] hover:bg-[var(--ds-seated-tint)]'
                            : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
                        }`}
                        title={isHidden ? 'Riattiva tavolo per questo turno' : 'Nascondi tavolo per questo turno'}
                      >
                        {isHidden ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                      </button>
                    )}
                    <button
                      onClick={() => setAssignTableModal(null)}
                      className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                  <button
                    onClick={async () => {
                        const walkIn: Omit<Reservation, 'id'> = {
                            customer_name: 'Walk-in',
                            guests: Math.min(2, table.seats || 2),
                            reservation_time: formatLocalDateTime(new Date()),
                            shift: effectiveShift,
                            table_id: table.id,
                            payment_status: PaymentStatus.PENDING,
                            arrival_status: ArrivalStatus.ARRIVED,
                            enable_reminder: false,
                            reminder_sent: false,
                        };
                        try {
                            await onAddReservation(walkIn);
                            showToast(`Walk-in al tavolo ${table.name} registrato`, 'success');
                        } catch {
                            showToast('Errore nella registrazione del walk-in', 'error');
                        }
                        setAssignTableModal(null);
                    }}
                    className="w-full text-left px-3 py-3 mb-2 bg-[var(--ds-seated-tint)] hover:opacity-90  rounded-lg transition-colors flex items-center gap-3"
                  >
                    <div className="w-9 h-9 bg-[var(--ds-seated-solid)] rounded-lg flex items-center justify-center flex-shrink-0">
                      <UserCheck className="h-5 w-5 text-[#ffffff]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[var(--ds-seated-text)]">Walk-in</div>
                      <div className="text-xs text-[var(--ds-seated-text)] mt-0.5">Occupa subito il tavolo {table.name} con un cliente senza prenotazione</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--ds-seated-text)] flex-shrink-0" />
                  </button>

                  <button
                    onClick={() => {
                        setAssignTableModal(null);
                        handleOpenNew();
                        setFormData(prev => ({ ...prev, table_id: table.id }));
                    }}
                    className="w-full text-left px-3 py-3 mb-2 bg-[var(--ds-arriving-tint)] hover:opacity-90 rounded-lg transition-opacity flex items-center gap-3"
                  >
                    <div className="w-9 h-9 bg-[var(--ds-arriving-solid)] rounded-lg flex items-center justify-center flex-shrink-0">
                      <Plus className="h-5 w-5 text-[#ffffff]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-[var(--ds-arriving-text)]">Nuova prenotazione</div>
                      <div className="text-xs text-[var(--ds-arriving-text)] mt-0.5">Crea e assegna direttamente al tavolo {table.name}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--ds-arriving-text)] flex-shrink-0" />
                  </button>

                  {unassigned.length === 0 ? (
                    <div className="text-center py-6 px-4">
                      <p className="text-xs text-[var(--ds-text-muted)]">Nessuna prenotazione senza tavolo per questo turno.</p>
                    </div>
                  ) : (
                    <>
                      <div className="px-1 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--ds-text-muted)]">
                        Oppure assegna a una prenotazione esistente
                      </div>
                      <ul className="divide-y divide-[var(--ds-border)]">
                        {unassigned.map(r => {
                          const insufficient = (r.guests || 0) > table.seats;
                          return (
                            <li key={r.id}>
                              <button
                                onClick={() => assign(r)}
                                className="w-full text-left px-3 py-3 hover:bg-[var(--ds-surface-row)] rounded-lg transition-colors flex items-center gap-3"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-[var(--ds-text-primary)] truncate">{toTitleCase(r.customer_name)}</span>
                                    {renderOperatorBadge(r)}
                                    {insufficient && (
                                      <span className="text-[10px] font-bold tracking-wide bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] px-1.5 py-0.5 rounded">
                                        Capienza insufficiente
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-[var(--ds-text-muted)] mt-0.5">
                                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(r.reservation_time)}</span>
                                    <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {r.guests}</span>
                                    {r.phone && <span className="truncate">{r.phone}</span>}
                                  </div>
                                </div>
                                <ChevronRight className="h-4 w-4 text-[var(--ds-text-muted)] flex-shrink-0" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>

                <div className="p-4 border-t border-[var(--ds-border)]">
                  <button
                    onClick={() => setAssignTableModal(null)}
                    className="w-full px-4 py-2 rounded-full border border-[var(--ds-border)] text-[var(--ds-text-primary)] text-sm font-medium hover:bg-[var(--ds-surface-row)]"
                  >
                    Annulla
                  </button>
                </div>
              </div>
            </div>
          );
      })()}

      <CustomerPickerModal
        isOpen={isCustomerPickerOpen}
        initialQuery={formData.customer_name || ''}
        onClose={() => setIsCustomerPickerOpen(false)}
        onSelect={(c: Customer) => {
          setFormData(prev => ({
            ...prev,
            customer_name: c.name,
            phone: c.phone || prev.phone || '',
            email: c.email || prev.email || '',
          }));
          applyCustomerPreferences(c);
        }}
      />

      {/* Tooltip for allergens / notes */}
      {tooltipReservation && (
        <div className="fixed inset-0 z-[9999]" onClick={() => setTooltipReservation(null)}>
          <div
            className="absolute bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-xl shadow-[var(--ds-shadow-raised)] px-4 py-3 max-w-xs min-w-[200px]"
            style={{
              left: Math.min(tooltipReservation.x, window.innerWidth - 280),
              top: tooltipReservation.y + 8,
              ...(tooltipReservation.y + 150 > window.innerHeight ? { top: undefined, bottom: window.innerHeight - tooltipReservation.y + 8 } as any : {}),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                {tooltipReservation.type === 'allergen'
                  ? <AlertTriangle className="h-4 w-4 text-[var(--ds-critical-solid)] flex-shrink-0" />
                  : tooltipReservation.type === 'tables'
                  ? <MapPin className="h-4 w-4 text-[var(--ds-arriving-solid)] flex-shrink-0" />
                  : tooltipReservation.type === 'bookedAt' ? <Info className="h-4 w-4 text-[var(--ds-arriving-solid)] flex-shrink-0" /> : <StickyNote className="h-4 w-4 text-[var(--ds-pending-solid)] flex-shrink-0" />}
                <span className="text-xs font-semibold text-[var(--ds-text-primary)]">
                  {tooltipReservation.type === 'allergen' ? 'Intolleranze'
                    : tooltipReservation.type === 'tables' ? `Tavoli uniti (${tooltipReservation.text.split('+').filter(Boolean).length})`
                    : tooltipReservation.type === 'bookedAt' ? 'Prenotazione' : 'Note'}
                </span>
              </div>
              <button type="button" onClick={() => setTooltipReservation(null)}
                className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]">
                <X className="h-4 w-4" />
              </button>
            </div>
            {tooltipReservation.type === 'tables' ? (
              <div className="flex flex-wrap gap-1.5">
                {tooltipReservation.text.split('+').map(n => n.trim()).filter(Boolean).map((name, i) => (
                  <span key={i} className="inline-flex items-center justify-center min-w-[2.25rem] px-2 py-1 rounded-md bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] text-sm font-bold tabular">
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-sm text-[var(--ds-text-muted)] leading-relaxed">{tooltipReservation.text}</p>
            )}
          </div>
        </div>
      )}

    </div>
  );
};

// Popover ancorato al chip della nota (es. Stinco). Il modello è:
//  - `quantity` sempre presente (default 1, min 1);
//  - `variant` opzionale — se il preset ha varianti, l'operatore sceglie una
//    tipologia per volta e può aggiungere ulteriori righe per l'altra
//    variante ("2 stinchi maiale + 1 stinco vitello");
//  - `preset_id` mantiene il collegamento anche se l'etichetta viene rinominata
//    in Impostazioni; l'aggregazione lato cucina raggruppa comunque per label
//    (le rinominazioni non fanno drift storico).
type QuickNotePreset = {
    id: number;
    label: string;
    icon: string | null;
    has_quantity: boolean;
    variants: string[];
};

interface NoteChipProps {
    note: QuickNotePreset;
    NoteIcon: React.ComponentType<{ className?: string }> | null;
    structured: boolean;
    structuredPicks: NoteSelection[];
    structuredTotalQty: number;
    isSelected: boolean;
    isOpen: boolean;
    onChipClick: () => void;
    onCommit: (next: NoteSelection[]) => void;
    onCancel: () => void;
}

// Isolato in un componente per catturare il ref del pulsante: il picker viene
// portalato al body per non essere clippato dal card contenitore e ha bisogno
// del bounding rect del chip per posizionarsi.
const NoteChip: React.FC<NoteChipProps> = ({
    note, NoteIcon, structured, structuredPicks, structuredTotalQty,
    isSelected, isOpen, onChipClick, onCommit, onCancel,
}) => {
    const btnRef = useRef<HTMLButtonElement | null>(null);
    return (
        <div className="relative">
            <button
                ref={btnRef}
                type="button"
                onClick={onChipClick}
                className={`w-full flex items-center gap-2 px-3.5 h-9 rounded-full transition-colors text-left ${
                    isSelected
                        ? 'border-[var(--ds-text-primary)] bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
                        : 'border-[var(--ds-border)] bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)]'
                }`}
            >
                <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                    isSelected ? 'bg-[var(--ds-text-primary)] border-[var(--ds-text-primary)]' : 'border-[var(--ds-border)] bg-[var(--ds-surface)]'
                }`}>
                    {isSelected && !structured && <Check className="text-[var(--ds-action-fg)] w-2.5 h-2.5" />}
                    {isSelected && structured && (
                        <span className="text-[10px] font-bold text-[var(--ds-action-fg)] tabular-nums">{structuredTotalQty}</span>
                    )}
                </div>
                {NoteIcon && <NoteIcon className="w-4 h-4 flex-shrink-0" />}
                <span className="text-sm font-medium truncate">{note.label}</span>
            </button>
            {structured && isOpen && (
                <NotePickerPopover
                    preset={note}
                    picks={structuredPicks}
                    anchorEl={btnRef.current}
                    onCommit={onCommit}
                    onCancel={onCancel}
                />
            )}
        </div>
    );
};

interface NotePickerPopoverProps {
    preset: QuickNotePreset;
    picks: NoteSelection[];
    anchorEl: HTMLElement | null;
    onCommit: (next: NoteSelection[]) => void;
    onCancel: () => void;
}

// Posiziona il popover sotto il chip, ma se non c'e' spazio nel viewport si
// sposta sopra o clampa al bordo. Portalato al body per evitare che i card
// contenitori con overflow lo taglino (bug visto in Note prenotazione).
const usePopoverPosition = (
    anchorEl: HTMLElement | null,
    enabled: boolean,
    popoverWidth: number,
    popoverHeightEstimate: number,
): { top: number; left: number } => {
    const [pos, setPos] = useState({ top: 0, left: 0 });
    useEffect(() => {
        if (!enabled || !anchorEl) return;
        const compute = () => {
            const rect = anchorEl.getBoundingClientRect();
            const margin = 8;
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            const preferBelow = rect.bottom + popoverHeightEstimate + margin <= vh;
            const top = preferBelow
                ? rect.bottom + 6
                : Math.max(margin, rect.top - popoverHeightEstimate - 6);
            const rawLeft = rect.left;
            const left = Math.min(Math.max(margin, rawLeft), vw - popoverWidth - margin);
            setPos({ top, left });
        };
        compute();
        window.addEventListener('resize', compute);
        window.addEventListener('scroll', compute, true);
        return () => {
            window.removeEventListener('resize', compute);
            window.removeEventListener('scroll', compute, true);
        };
    }, [anchorEl, enabled, popoverWidth, popoverHeightEstimate]);
    return pos;
};

const NotePickerPopover: React.FC<NotePickerPopoverProps> = ({ preset, picks, anchorEl, onCommit, onCancel }) => {
    // Se il preset ha varianti trattiamo il popover come editor di più righe
    // (una per variante scelta). Altrimenti è una singola quantità.
    const hasVariants = preset.variants.length > 0;
    const initial: Record<string, number> = {};
    for (const p of picks) initial[p.variant ?? ''] = p.quantity;
    const [qtyByVariant, setQtyByVariant] = useState<Record<string, number>>(() => {
        if (hasVariants) return initial;
        return { '': picks[0]?.quantity ?? 1 };
    });
    // Su schermi stretti il popover ancorato al chip finisce fuori viewport e
    // viene tagliato: renderizziamo come bottom-sheet full-width, con touch
    // target 44px come da design system.
    const isWide = useMediaQuery('(min-width: 768px)');

    const bump = (variant: string, delta: number) => {
        setQtyByVariant(prev => {
            const cur = prev[variant] ?? 0;
            const next = Math.max(0, Math.min(99, cur + delta));
            return { ...prev, [variant]: next };
        });
    };
    const setQty = (variant: string, value: number) => {
        setQtyByVariant(prev => ({ ...prev, [variant]: Math.max(0, Math.min(99, Math.floor(value) || 0)) }));
    };

    const commit = () => {
        const rows: NoteSelection[] = [];
        if (hasVariants) {
            for (const v of preset.variants) {
                const q = qtyByVariant[v] ?? 0;
                if (q > 0) rows.push({ preset_id: preset.id, label: preset.label, variant: v, quantity: q });
            }
        } else {
            const q = qtyByVariant[''] ?? 0;
            if (q > 0) rows.push({ preset_id: preset.id, label: preset.label, variant: null, quantity: q });
        }
        onCommit(rows);
    };

    const clear = () => onCommit([]);

    const body = (
        <>
            <div className={`flex items-center justify-between pb-2 mb-2 border-b border-[var(--ds-border)] ${isWide ? '' : 'px-1'}`}>
                <span className={`font-semibold text-[var(--ds-text-primary)] ${isWide ? 'text-[13px]' : 'text-[16px]'}`}>
                    {preset.label}
                </span>
                <button
                    type="button"
                    onClick={onCancel}
                    className={`rounded-full flex items-center justify-center hover:bg-[var(--ds-surface-row)] ${isWide ? 'w-7 h-7' : 'w-11 h-11'}`}
                    aria-label="Chiudi"
                >
                    <X className={`text-[var(--ds-text-muted)] ${isWide ? 'w-3.5 h-3.5' : 'w-5 h-5'}`} />
                </button>
            </div>
            {hasVariants ? (
                <ul className={isWide ? 'space-y-2' : 'space-y-1'}>
                    {preset.variants.map(v => (
                        <li key={v} className={`flex items-center gap-3 ${isWide ? '' : 'py-1'}`}>
                            <span className={`flex-1 text-[var(--ds-text-primary)] truncate ${isWide ? 'text-[13px]' : 'text-[15px]'}`}>{v}</span>
                            <QuantityStepper
                                large={!isWide}
                                value={qtyByVariant[v] ?? 0}
                                onIncrement={() => bump(v, 1)}
                                onDecrement={() => bump(v, -1)}
                                onChange={(n) => setQty(v, n)}
                            />
                        </li>
                    ))}
                </ul>
            ) : (
                <div className="flex items-center justify-between gap-3 py-1">
                    <span className={`text-[var(--ds-text-secondary)] ${isWide ? 'text-[13px]' : 'text-[15px]'}`}>Quantità</span>
                    <QuantityStepper
                        large={!isWide}
                        value={qtyByVariant[''] ?? 0}
                        onIncrement={() => bump('', 1)}
                        onDecrement={() => bump('', -1)}
                        onChange={(n) => setQty('', n)}
                    />
                </div>
            )}
            <div className={`mt-3 pt-2 border-t border-[var(--ds-border)] flex items-center justify-between gap-2 ${isWide ? '' : 'px-1'}`}>
                <button
                    type="button"
                    onClick={clear}
                    className={`text-[var(--ds-critical-solid)] hover:text-[var(--ds-critical-text)] font-medium ${isWide ? 'text-[12px]' : 'text-[15px] min-h-11 px-2'}`}
                >
                    Rimuovi
                </button>
                <button
                    type="button"
                    onClick={commit}
                    className={`rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] font-semibold hover:bg-[var(--ds-action-bg-hover)] ${
                        isWide ? 'px-3 py-1.5 text-[12px]' : 'px-5 min-h-11 text-[15px]'
                    }`}
                >
                    Conferma
                </button>
            </div>
        </>
    );

    const desktopWidth = 288;
    const desktopHeightEstimate = Math.max(180, 90 + (hasVariants ? preset.variants.length : 1) * 48);
    const pos = usePopoverPosition(anchorEl, isWide, desktopWidth, desktopHeightEstimate);
    if (isWide) {
        return createPortal(
            <>
                <div className="fixed inset-0 z-[80]" onClick={onCancel} />
                <div
                    className="fixed z-[81] rounded-xl border border-[var(--ds-border)] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-overlay)]"
                    style={{ top: pos.top, left: pos.left, width: desktopWidth }}
                    onClick={(e) => e.stopPropagation()}
                    role="dialog"
                    aria-label={preset.label}
                >
                    {body}
                </div>
            </>,
            document.body,
        );
    }

    // Mobile: bottom sheet portalato al body — l'ancoraggio absolute veniva
    // tagliato dal contenitore della card e la funzionalità restava bloccata.
    return createPortal(
        <div
            className="fixed inset-0 z-[80] flex items-end"
            onClick={onCancel}
            role="dialog"
            aria-modal="true"
            aria-label={preset.label}
        >
            <div className="absolute inset-0 bg-black/40" />
            <div
 className="relative w-full bg-[var(--ds-surface)] rounded-t-2xl shadow-[var(--ds-shadow-overlay)] px-4 pt-3 pb-[max(env(safe-area-inset-bottom),1rem)] duration-200"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex justify-center pb-2">
                    <div className="w-10 h-1 rounded-full bg-[var(--ds-border-strong)]" />
                </div>
                {body}
            </div>
        </div>,
        document.body,
    );
};

const QuantityStepper: React.FC<{
    value: number;
    onIncrement: () => void;
    onDecrement: () => void;
    onChange: (n: number) => void;
    large?: boolean;
}> = ({ value, onIncrement, onDecrement, onChange, large = false }) => {
    const btn = large ? 'w-11 h-11 text-[18px]' : 'w-8 h-8';
    const input = large ? 'w-12 h-11 text-[16px]' : 'w-10 h-8 text-[13px]';
    return (
        <div className="inline-flex items-center rounded-full border border-[var(--ds-border)] bg-[var(--ds-surface)]">
            <button
                type="button"
                onClick={onDecrement}
                disabled={value <= 0}
                className={`${btn} flex items-center justify-center text-[var(--ds-text-primary)] disabled:opacity-30`}
                aria-label="Diminuisci"
            >−</button>
            <input
                type="number"
                min={0}
                max={99}
                value={value}
                onChange={(e) => onChange(Number(e.target.value))}
                className={`${input} text-center font-semibold tabular-nums bg-transparent focus:outline-none appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
            />
            <button
                type="button"
                onClick={onIncrement}
                className={`${btn} flex items-center justify-center text-[var(--ds-text-primary)]`}
                aria-label="Aumenta"
            >+</button>
        </div>
    );
};
