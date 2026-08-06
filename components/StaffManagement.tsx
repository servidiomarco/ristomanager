import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType,
  Shift, TimeOffType
} from '../types';
import { staffApiService, CreateStaffInput, CreateTimeOffInput } from '../services/staffApiService';
import { toTitleCase } from '../utils/text';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { SkeletonStaffColumn } from './SkeletonCards';
import {
  UserPlus, Edit2, Trash2, Plus, ChevronLeft, ChevronRight, MoreVertical,
  Sun, Moon, AlertTriangle, Phone, Mail, Loader2, ChefHat, Users, ListFilter,
  UserCircle, CalendarDays, User, Ban, RotateCcw, X,
} from 'lucide-react';
import {
  SplitPane, PaneHeader, PanePlaceholder, SearchField, SegmentedControl,
  SectionHeader, StatStrip, StatusPill, Callout, EmptyState, ModalShell,
  StepNav, FormCard, Field, CountBadge, useMediaQuery,
  dsButton, dsIconButton, dsInput, dsSelect, dsTextarea,
} from './ds';

// ============================================
// CONSTANTS
// ============================================

const STAFF_CATEGORY_LABELS: Record<StaffCategory, string> = {
  [StaffCategory.SALA]: 'Sala',
  [StaffCategory.CUCINA]: 'Cucina'
};

const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'Fisso',
  [StaffType.STAGIONALE]: 'Stagionale',
  [StaffType.EXTRA]: 'Extra'
};

// What each contract means for the calendar. Shown under the option in the
// form, because the difference is invisible until a month has been filled in.
const STAFF_TYPE_HINTS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'turni automatici',
  [StaffType.STAGIONALE]: 'con data di fine',
  [StaffType.EXTRA]: 'a chiamata'
};

const TIME_OFF_LABELS: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'Riposo',
  [TimeOffType.VACANZA]: 'Vacanza',
  [TimeOffType.MALATTIA]: 'Malattia',
  [TimeOffType.PERMESSO]: 'Permesso'
};

/* Absence types map onto the design system's state families rather than four
   invented hues: vacation is a planned good thing, illness is the one that
   costs a shift tonight, permission is informational and riposo is routine.
   Written out in full because Tailwind extracts class names statically. */
const TIME_OFF_CHIP: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]',
  [TimeOffType.VACANZA]: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  [TimeOffType.MALATTIA]: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]',
  [TimeOffType.PERMESSO]: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
};

const TIME_OFF_PILL_TONE: Record<TimeOffType, 'neutral' | 'positive' | 'critical' | 'info'> = {
  [TimeOffType.RIPOSO]: 'neutral',
  [TimeOffType.VACANZA]: 'positive',
  [TimeOffType.MALATTIA]: 'critical',
  [TimeOffType.PERMESSO]: 'info'
};

// Indices match JS Date.getDay(): 0=Sunday, 1=Monday, ..., 6=Saturday
const WEEKDAY_LABELS = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];

// Format Date as YYYY-MM-DD using local components (avoids UTC timezone shift)
const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

// Server may return dates as either YYYY-MM-DD or full ISO strings; take first 10 chars
const toDateOnly = (date: string): string => date.substring(0, 10);

// Parse a YYYY-MM-DD back to a local Date. The explicit time is what keeps a
// bare date string from being read as UTC midnight and landing on the day
// before in Rome.
const fromDateOnly = (date: string): Date => new Date(`${date}T00:00:00`);

const eachDate = (start: string, end: string): string[] => {
  const out: string[] = [];
  const d = fromDateOnly(start);
  const last = fromDateOnly(end);
  while (d <= last && out.length < 400) {
    out.push(formatLocalDate(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** How a single service on a single day reads for one person.
 *  'present'  explicit shift row, present
 *  'absent'   explicit shift row, marked not present
 *  'off'      covered by an absence
 *  'rest'     the weekly rest day
 *  'implicit' no row, but the contract puts them on shift anyway
 *  'none'     nothing */
type SlotState = 'present' | 'absent' | 'off' | 'rest' | 'implicit' | 'none';


const rowIconButton =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

const rowIconButtonDanger =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

/** The filter chip inside the sheet. Outlined when off, solid when on — the
 *  same pair Prenotazioni uses, so a filter panel reads the same wherever it
 *  slides up. 44px floor, because this is a thumb target first. */
const Chip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex h-11 max-w-full items-center gap-1.5 rounded-full px-4 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
      active
        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
        : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)]'
    }`}
  >
    {children}
  </button>
);

interface StaffManagementProps {
  showToast: (message: string, type: 'success' | 'error' | 'info') => void;
  autoOpenNew?: boolean;
  onAutoOpenNewHandled?: () => void;
}

export const StaffManagement: React.FC<StaffManagementProps> = ({ showToast, autoOpenNew, onAutoOpenNewHandled }) => {
  // ============================================
  // STATE
  // ============================================

  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [shifts, setShifts] = useState<StaffShift[]>([]);
  const [timeOffs, setTimeOffs] = useState<StaffTimeOff[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [categoryFilter, setCategoryFilter] = useState<StaffCategory | 'ALL'>('ALL');
  const [typeFilter, setTypeFilter] = useState<StaffType | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const activeFilterCount =
    (categoryFilter !== 'ALL' ? 1 : 0) + (typeFilter !== 'ALL' ? 1 : 0) + (showInactive ? 1 : 0);
  const resetFilters = () => {
    setCategoryFilter('ALL');
    setTypeFilter('ALL');
    setShowInactive(false);
  };

  // The box the filters sheet is confined to — the list column, measured from
  // the toolbar's own ancestor so it keeps working if the pane is resized.
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const [filterHost, setFilterHost] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  const measureFilterHost = () => {
    const host = toolbarRef.current?.closest('aside');
    if (!host) return null;
    const r = host.getBoundingClientRect();
    // Width comes from the column, height runs to the bottom of the window.
    // The column stops short of the bottom bar on a phone, and a sheet that
    // stopped with it left the nav sitting bright underneath the dimmed list.
    return { left: r.left, top: r.top, width: r.width, height: window.innerHeight - r.top };
  };

  const openFilters = () => {
    setFilterHost(measureFilterHost());
    setFiltersOpen(true);
  };

  // Selected staff for calendar view
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [detailTab, setDetailTab] = useState<'TURNI' | 'ASSENZE'>('TURNI');

  // Modals
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [staffStep, setStaffStep] = useState(0);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [showTimeOffModal, setShowTimeOffModal] = useState(false);
  const [deleteStaffConfirm, setDeleteStaffConfirm] = useState<StaffMember | null>(null);
  const [deleteTimeOffConfirm, setDeleteTimeOffConfirm] = useState<{ id: string; label: string } | null>(null);
  const [isSavingStaff, setIsSavingStaff] = useState(false);
  const [isSavingShift, setIsSavingShift] = useState(false);
  const [isSavingTimeOff, setIsSavingTimeOff] = useState(false);

  // The "…" menu on the person header.
  const [personMenuOpen, setPersonMenuOpen] = useState(false);
  const personMenuRef = useRef<HTMLDivElement | null>(null);
  const personMenuTriggerRef = useRef<HTMLButtonElement | null>(null);

  // The quick-set menu on a calendar day. Positioned from the cell's rect and
  // portaled, because the grid scrolls inside its own card.
  const [dayMenu, setDayMenu] = useState<{ date: string; top: number; left: number } | null>(null);
  const dayMenuRef = useRef<HTMLDivElement | null>(null);
  const [applyingDay, setApplyingDay] = useState<string | null>(null);

  // Picks the container for the day actions, not their styling: a menu
  // anchored to a cell and a bottom sheet are different trees.
  const isWide = useMediaQuery('(min-width: 1024px)');

  // Forms
  const [staffForm, setStaffForm] = useState<CreateStaffInput>({
    name: '',
    surname: '',
    category: StaffCategory.SALA,
    staffType: StaffType.FISSO,
    phone: '',
    email: '',
    role: '',
    hireDate: '',
    contractEndDate: '',
    weeklyRestDay: null,
    notes: ''
  });

  const [shiftForm, setShiftForm] = useState({
    staffId: '',
    date: '',
    lunch: true,
    dinner: false,
    present: true,
    notes: ''
  });

  const [timeOffForm, setTimeOffForm] = useState<CreateTimeOffInput>({
    staffId: '',
    startDate: '',
    endDate: '',
    type: TimeOffType.RIPOSO,
    shift: null,
    notes: '',
    approved: true
  });

  // ============================================
  // DATA FETCHING
  // ============================================

  // Keep latest showToast in a ref so fetchData stays stable across renders.
  // The parent (App) recreates addToast every render, so depending on it
  // directly would re-fire the fetch effect indefinitely.
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; }, [showToast]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [staffData, shiftsData, timeOffData] = await Promise.all([
        staffApiService.getStaffMembers(),
        staffApiService.getShifts(),
        staffApiService.getTimeOff()
      ]);
      setStaffMembers(staffData);
      setShifts(shiftsData);
      setTimeOffs(timeOffData);
    } catch (error) {
      console.error('Error fetching staff data:', error);
      showToastRef.current('Errore nel caricamento del personale', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (autoOpenNew) {
      handleOpenAddStaff();
      onAutoOpenNewHandled?.();
    }
  }, [autoOpenNew]);

  // Keep the open record in step with the list — a rename or a toggle would
  // otherwise leave the header showing the version from before the save.
  useEffect(() => {
    if (!selectedStaff) return;
    const fresh = staffMembers.find(s => s.id === selectedStaff.id);
    if (fresh && fresh !== selectedStaff) setSelectedStaff(fresh);
  }, [staffMembers]);

  // ============================================
  // FILTERED DATA
  // ============================================

  const filteredStaff = useMemo(() => {
    return staffMembers.filter(staff => {
      if (!showInactive && !staff.isActive) return false;
      if (categoryFilter !== 'ALL' && staff.category !== categoryFilter) return false;
      if (typeFilter !== 'ALL' && staff.staffType !== typeFilter) return false;
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const fullName = `${staff.name} ${staff.surname}`.toLowerCase();
        const role = (staff.role || '').toLowerCase();
        if (!fullName.includes(query) && !role.includes(query)) return false;
      }
      return true;
    });
  }, [staffMembers, categoryFilter, typeFilter, searchQuery, showInactive]);

  // One list, two bands. The contract type is a badge on the row rather than a
  // third level of grouping: nesting Sala > Fisso > people put three headings
  // above every name and pushed the list itself off the screen.
  const listGroups = useMemo(() => {
    const order: StaffCategory[] = [StaffCategory.SALA, StaffCategory.CUCINA];
    return order
      .map(category => ({
        category,
        members: filteredStaff.filter(s => s.category === category),
      }))
      .filter(g => g.members.length > 0);
  }, [filteredStaff]);

  const inactiveCount = useMemo(
    () => staffMembers.filter(s => !s.isActive).length,
    [staffMembers]
  );

  const countByType = (type: StaffType | 'ALL'): number => {
    const base = staffMembers.filter(s => showInactive || s.isActive);
    return type === 'ALL' ? base.length : base.filter(s => s.staffType === type).length;
  };

  // ============================================
  // CALENDAR HELPERS
  // ============================================

  const calendarDays = useMemo(() => {
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startPadding = (firstDay.getDay() + 6) % 7; // Monday = 0

    const days: Date[] = [];

    // Add padding days from previous month
    for (let i = startPadding - 1; i >= 0; i--) {
      const d = new Date(year, month, -i);
      days.push(d);
    }

    // Add days of current month
    for (let i = 1; i <= lastDay.getDate(); i++) {
      days.push(new Date(year, month, i));
    }

    // Add padding days to complete last week
    const remaining = 7 - (days.length % 7);
    if (remaining < 7) {
      for (let i = 1; i <= remaining; i++) {
        days.push(new Date(year, month + 1, i));
      }
    }

    return days;
  }, [calendarDate]);

  // Time-offs grouped by month (YYYY-MM), most recent first, for the
  // selected staff's "Assenze" tab.
  const timeOffsByMonth = useMemo(() => {
    if (!selectedStaff) return [] as Array<{ key: string; label: string; items: StaffTimeOff[] }>;
    const filtered = timeOffs
      .filter(t => t.staffId === selectedStaff.id)
      .sort((a, b) => b.startDate.localeCompare(a.startDate));

    const groups: Array<{ key: string; label: string; items: StaffTimeOff[] }> = [];
    for (const t of filtered) {
      const key = t.startDate.slice(0, 7);
      let group = groups[groups.length - 1];
      if (!group || group.key !== key) {
        const [year, month] = key.split('-').map(Number);
        const label = new Date(year, month - 1, 1)
          .toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
        group = { key, label, items: [] };
        groups.push(group);
      }
      group.items.push(t);
    }
    return groups;
  }, [timeOffs, selectedStaff?.id]);

  const formatTimeOffDayLabel = (timeOff: StaffTimeOff, groupKey: string): string => {
    const startKey = timeOff.startDate.slice(0, 7);
    const endKey = timeOff.endDate.slice(0, 7);
    const startD = new Date(timeOff.startDate);
    const endD = new Date(timeOff.endDate);
    if (timeOff.startDate === timeOff.endDate) {
      return startKey === groupKey
        ? String(startD.getDate())
        : startD.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    }
    if (startKey === groupKey && endKey === groupKey) {
      return `${startD.getDate()} - ${endD.getDate()}`;
    }
    return `${startD.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} - ${endD.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
  };

  const getShiftsForDay = (date: Date, staffId: string) => {
    const dateStr = formatLocalDate(date);
    return shifts.filter(s => s.staffId === staffId && toDateOnly(s.date) === dateStr);
  };

  const getTimeOffForDay = (date: Date, staffId: string) => {
    const dateStr = formatLocalDate(date);
    return timeOffs.find(t =>
      t.staffId === staffId &&
      dateStr >= toDateOnly(t.startDate) &&
      dateStr <= toDateOnly(t.endDate)
    );
  };

  // FISSO and STAGIONALE staff are implicitly present on both shifts during
  // their contract period unless there's a time-off entry or an explicit
  // absent shift. If hireDate or contractEndDate are missing, that boundary
  // is treated as open (no date = currently active).
  const isWithinHirePeriod = (staff: StaffMember, dateStr: string): boolean => {
    if (staff.hireDate && dateStr < toDateOnly(staff.hireDate)) return false;
    if (staff.contractEndDate && dateStr > toDateOnly(staff.contractEndDate)) return false;
    return true;
  };

  const hasAutoShifts = (staff: StaffMember): boolean =>
    staff.staffType === StaffType.FISSO || staff.staffType === StaffType.STAGIONALE;

  /* Indexed rather than scanned. The coverage note asks "is this person on
     that service" once per peer per day per service — a thirty-day holiday for
     a twenty-strong brigade is over a thousand lookups, and a linear pass over
     every shift ever recorded turned typing a date into a visible stall. */
  const shiftIndex = useMemo(() => {
    const m = new Map<string, StaffShift>();
    for (const s of shifts) m.set(`${s.staffId}|${toDateOnly(s.date)}|${s.shift}`, s);
    return m;
  }, [shifts]);

  const timeOffByStaff = useMemo(() => {
    const m = new Map<string, StaffTimeOff[]>();
    for (const t of timeOffs) {
      const arr = m.get(t.staffId);
      if (arr) arr.push(t);
      else m.set(t.staffId, [t]);
    }
    return m;
  }, [timeOffs]);

  const findShift = (staffId: string, dateStr: string, shift: Shift): StaffShift | undefined =>
    shiftIndex.get(`${staffId}|${dateStr}|${shift}`);

  const findTimeOff = (staffId: string, dateStr: string, shift?: Shift): StaffTimeOff | undefined =>
    timeOffByStaff.get(staffId)?.find(t =>
      dateStr >= toDateOnly(t.startDate) &&
      dateStr <= toDateOnly(t.endDate) &&
      (shift === undefined || t.shift == null || t.shift === shift)
    );

  const isWeeklyRestDay = (staff: StaffMember, dateStr: string): boolean =>
    staff.weeklyRestDay !== undefined &&
    staff.weeklyRestDay !== null &&
    fromDateOnly(dateStr).getDay() === staff.weeklyRestDay;

  /* The single reading of "is this person on this service that day", used by
     the month grid, the header counters and the coverage note in the absence
     modal. An explicit row always wins over an absence — that is how the
     calendar has always resolved the two, and three copies of the rule was one
     copy too many. */
  const slotState = (staff: StaffMember, dateStr: string, shift: Shift): SlotState => {
    const explicit = findShift(staff.id, dateStr, shift);
    if (explicit) return explicit.present ? 'present' : 'absent';
    if (findTimeOff(staff.id, dateStr, shift)) return 'off';
    if (isWeeklyRestDay(staff, dateStr)) return 'rest';
    if (hasAutoShifts(staff) && isWithinHirePeriod(staff, dateStr)) return 'implicit';
    return 'none';
  };

  const isOnDuty = (staff: StaffMember, dateStr: string, shift: Shift): boolean => {
    const state = slotState(staff, dateStr, shift);
    return state === 'present' || state === 'implicit';
  };

  // The three numbers over the calendar, all for the month on screen.
  const monthStats = useMemo(() => {
    if (!selectedStaff) return { shifts: 0, rest: 0, holiday: 0 };
    const year = calendarDate.getFullYear();
    const month = calendarDate.getMonth();
    const last = new Date(year, month + 1, 0).getDate();
    let shiftCount = 0;
    let restDays = 0;
    let holidayDays = 0;
    for (let d = 1; d <= last; d++) {
      const dateStr = formatLocalDate(new Date(year, month, d));
      for (const sh of [Shift.LUNCH, Shift.DINNER]) {
        if (isOnDuty(selectedStaff, dateStr, sh)) shiftCount++;
      }
      const off = findTimeOff(selectedStaff.id, dateStr);
      if (off?.type === TimeOffType.VACANZA) holidayDays++;
      else if (off?.type === TimeOffType.RIPOSO || (!off && isWeeklyRestDay(selectedStaff, dateStr))) restDays++;
    }
    return { shifts: shiftCount, rest: restDays, holiday: holidayDays };
  }, [selectedStaff, calendarDate, shifts, timeOffs]);

  /* What the rest of the brigade looks like once this absence is registered.
     Not a rule being broken — there is no minimum staffing anywhere in the
     data — just the number you would want to know before pressing Registra. */
  const coverageNote = useMemo(() => {
    if (!showTimeOffModal || !selectedStaff) return null;
    const { startDate, endDate } = timeOffForm;
    if (!startDate || !endDate || endDate < startDate) return null;
    const dates = eachDate(startDate, endDate);
    if (dates.length === 0) return null;

    const peers = staffMembers.filter(
      s => s.isActive && s.category === selectedStaff.category && s.id !== selectedStaff.id
    );
    const services = timeOffForm.shift ? [timeOffForm.shift] : [Shift.LUNCH, Shift.DINNER];
    const lines: string[] = [];

    for (const service of services) {
      let min = Infinity;
      let worst: string[] = [];
      for (const dateStr of dates) {
        const count = peers.filter(p => isOnDuty(p, dateStr, service)).length;
        if (count < min) { min = count; worst = [dateStr]; }
        else if (count === min) worst.push(dateStr);
      }
      if (min === Infinity) continue;
      const days = worst.map(d => fromDateOnly(d).getDate());
      const when = days.length === 1
        ? `Il ${days[0]}`
        : days.length <= 4
          ? `Il ${days.slice(0, -1).join(', ')} e il ${days[days.length - 1]}`
          : `Per ${days.length} giorni`;
      const where = STAFF_CATEGORY_LABELS[selectedStaff.category].toLowerCase();
      const service_ = service === Shift.LUNCH ? 'a pranzo' : 'a cena';
      lines.push(
        min === 0
          ? `${when} non resta nessuno in ${where} ${service_}.`
          : `${when} la ${where} resta con ${plural(min, 'persona', 'persone')} ${service_}.`
      );
    }
    return lines.length > 0 ? lines : null;
  }, [showTimeOffModal, selectedStaff, timeOffForm.startDate, timeOffForm.endDate, timeOffForm.shift, staffMembers, shifts, timeOffs]);

  // ============================================
  // HANDLERS
  // ============================================

  const resetStaffForm = () => {
    setStaffForm({
      name: '',
      surname: '',
      category: StaffCategory.SALA,
      staffType: StaffType.FISSO,
      phone: '',
      email: '',
      role: '',
      hireDate: '',
      contractEndDate: '',
      weeklyRestDay: null,
      notes: ''
    });
    setEditingStaff(null);
    setStaffStep(0);
  };

  const handleOpenAddStaff = () => {
    resetStaffForm();
    setShowStaffModal(true);
  };

  const handleOpenEditStaff = (staff: StaffMember) => {
    setEditingStaff(staff);
    setStaffStep(0);
    setStaffForm({
      name: staff.name,
      surname: staff.surname,
      category: staff.category,
      staffType: staff.staffType,
      phone: staff.phone || '',
      email: staff.email || '',
      role: staff.role || '',
      hireDate: staff.hireDate || '',
      contractEndDate: staff.contractEndDate || '',
      weeklyRestDay: staff.weeklyRestDay ?? null,
      notes: staff.notes || ''
    });
    setShowStaffModal(true);
  };

  const handleSaveStaff = async () => {
    if (!staffForm.name.trim() || !staffForm.surname.trim()) {
      setStaffStep(0);
      showToast('Nome e cognome sono obbligatori', 'error');
      return;
    }
    if (isSavingStaff) return;

    try {
      setIsSavingStaff(true);
      if (editingStaff) {
        const updated = await staffApiService.updateStaffMember(editingStaff.id, staffForm);
        setStaffMembers(prev => prev.map(s => s.id === editingStaff.id ? updated : s));
        showToast('Dipendente aggiornato', 'success');
      } else {
        const created = await staffApiService.createStaffMember(staffForm);
        setStaffMembers(prev => [...prev, created]);
        showToast('Dipendente aggiunto', 'success');
      }
      setShowStaffModal(false);
      resetStaffForm();
    } catch (error) {
      showToast('Errore nel salvataggio', 'error');
    } finally {
      setIsSavingStaff(false);
    }
  };

  const handleDeleteStaff = async (id: string) => {
    try {
      await staffApiService.deleteStaffMember(id);
      setStaffMembers(prev => prev.filter(s => s.id !== id));
      if (selectedStaff?.id === id) setSelectedStaff(null);
      showToast('Dipendente eliminato', 'success');
    } catch (error) {
      showToast('Errore nell\'eliminazione', 'error');
    }
  };

  const handleToggleStaffActive = async (staff: StaffMember) => {
    try {
      const updated = await staffApiService.updateStaffMember(staff.id, { isActive: !staff.isActive });
      setStaffMembers(prev => prev.map(s => s.id === staff.id ? updated : s));
      showToast(updated.isActive ? 'Dipendente riattivato' : 'Dipendente disattivato', 'success');
    } catch (error) {
      showToast('Errore nell\'aggiornamento', 'error');
    }
  };

  const handleOpenAddShift = (date?: Date | string) => {
    if (!selectedStaff) return;
    const dateStr = typeof date === 'string' ? date : formatLocalDate(date || new Date());
    const existing = shifts.filter(s => s.staffId === selectedStaff.id && toDateOnly(s.date) === dateStr);
    const lunchExisting = existing.find(s => s.shift === Shift.LUNCH);
    const dinnerExisting = existing.find(s => s.shift === Shift.DINNER);
    setShiftForm({
      staffId: selectedStaff.id,
      date: dateStr,
      lunch: !!lunchExisting,
      dinner: !!dinnerExisting,
      present: true,
      notes: lunchExisting?.notes || dinnerExisting?.notes || ''
    });
    setShowShiftModal(true);
  };

  const handleSaveShift = async () => {
    if (isSavingShift) return;

    const existing = shifts.filter(s => s.staffId === shiftForm.staffId && toDateOnly(s.date) === shiftForm.date);
    const lunchExisting = existing.find(s => s.shift === Shift.LUNCH);
    const dinnerExisting = existing.find(s => s.shift === Shift.DINNER);

    const shiftsToCreate: Shift[] = [];
    if (shiftForm.lunch && !lunchExisting) shiftsToCreate.push(Shift.LUNCH);
    if (shiftForm.dinner && !dinnerExisting) shiftsToCreate.push(Shift.DINNER);

    const shiftsToDelete: StaffShift[] = [];
    if (!shiftForm.lunch && lunchExisting) shiftsToDelete.push(lunchExisting);
    if (!shiftForm.dinner && dinnerExisting) shiftsToDelete.push(dinnerExisting);

    // Existing shifts that remain selected — update notes if changed
    const shiftsToUpdate: StaffShift[] = [];
    if (shiftForm.lunch && lunchExisting && (lunchExisting.notes || '') !== shiftForm.notes) {
      shiftsToUpdate.push(lunchExisting);
    }
    if (shiftForm.dinner && dinnerExisting && (dinnerExisting.notes || '') !== shiftForm.notes) {
      shiftsToUpdate.push(dinnerExisting);
    }

    if (shiftsToCreate.length === 0 && shiftsToDelete.length === 0 && shiftsToUpdate.length === 0) {
      if (!shiftForm.lunch && !shiftForm.dinner && existing.length === 0) {
        showToast('Seleziona almeno un turno (Pranzo o Cena)', 'error');
        return;
      }
      setShowShiftModal(false);
      return;
    }

    try {
      setIsSavingShift(true);
      const [created] = await Promise.all([
        Promise.all(
          shiftsToCreate.map(shift =>
            staffApiService.createShift({
              staffId: shiftForm.staffId,
              date: shiftForm.date,
              shift,
              present: shiftForm.present,
              notes: shiftForm.notes
            })
          )
        ),
        Promise.all(shiftsToDelete.map(s => staffApiService.deleteShift(s.id))),
        Promise.all(
          shiftsToUpdate.map(s =>
            staffApiService.createShift({
              staffId: s.staffId,
              date: toDateOnly(s.date),
              shift: s.shift,
              present: s.present,
              notes: shiftForm.notes
            })
          )
        )
      ]);

      const deletedIds = new Set(shiftsToDelete.map(s => s.id));
      setShifts(prev => {
        const next = prev.filter(s => !deletedIds.has(s.id) && !created.some(c =>
          c.staffId === s.staffId && c.date === s.date && c.shift === s.shift
        ));
        // Apply updated notes for remaining shifts that were re-upserted
        const updatedMap = new Map<string, string>();
        shiftsToUpdate.forEach(s => updatedMap.set(s.id, shiftForm.notes));
        const remapped = next.map(s => updatedMap.has(s.id) ? { ...s, notes: updatedMap.get(s.id)! } : s);
        return [...remapped, ...created];
      });
      setShowShiftModal(false);

      const parts: string[] = [];
      if (shiftsToCreate.length > 0) parts.push(`${shiftsToCreate.length} aggiunt${shiftsToCreate.length === 1 ? 'o' : 'i'}`);
      if (shiftsToDelete.length > 0) parts.push(`${shiftsToDelete.length} rimoss${shiftsToDelete.length === 1 ? 'o' : 'i'}`);
      if (shiftsToUpdate.length > 0) parts.push(`${shiftsToUpdate.length} aggiornat${shiftsToUpdate.length === 1 ? 'o' : 'i'}`);
      showToast(`Turni: ${parts.join(', ')}`, 'success');
    } catch (error) {
      showToast('Errore nel salvataggio del turno', 'error');
    } finally {
      setIsSavingShift(false);
    }
  };

  /* ── Quick set from a calendar cell ────────────────────────────────────────
     Same two calls the Turno modal makes, just without the round trip through
     a form for the case that is most of the month: this person works both
     services, or only one, or not at all.

     The one subtlety is contracts that carry automatic presence. For those,
     removing a service cannot be done by deleting the row — there is no row,
     and the contract would put them straight back on. It writes the explicit
     "non presente" the model already has and the grid already draws struck
     through, which is exactly what "solo pranzo" has to mean for a Fisso. */
  const applyDayShifts = async (dateStr: string, wantLunch: boolean, wantDinner: boolean) => {
    if (!selectedStaff || applyingDay) return;
    const staff = selectedStaff;
    const auto = hasAutoShifts(staff) && isWithinHirePeriod(staff, dateStr) && !isWeeklyRestDay(staff, dateStr);

    const creates: Promise<StaffShift>[] = [];
    const deletes: { promise: Promise<void>; id: string }[] = [];

    for (const [shift, want] of [[Shift.LUNCH, wantLunch], [Shift.DINNER, wantDinner]] as const) {
      const existing = findShift(staff.id, dateStr, shift);
      const blockedByAbsence = !!findTimeOff(staff.id, dateStr, shift);

      if (want) {
        if (existing?.present) continue;
        // An absence or the weekly rest day would otherwise win: an explicit
        // present row is the only thing that outranks them.
        if (!existing && auto && !blockedByAbsence) continue;
        creates.push(staffApiService.createShift({
          staffId: staff.id, date: dateStr, shift, present: true, notes: existing?.notes || ''
        }));
      } else {
        if (auto && !blockedByAbsence) {
          if (existing && !existing.present) continue;
          creates.push(staffApiService.createShift({
            staffId: staff.id, date: dateStr, shift, present: false, notes: existing?.notes || ''
          }));
        } else if (existing) {
          deletes.push({ promise: staffApiService.deleteShift(existing.id), id: existing.id });
        }
      }
    }

    if (creates.length === 0 && deletes.length === 0) return;

    try {
      setApplyingDay(dateStr);
      const [created] = await Promise.all([Promise.all(creates), Promise.all(deletes.map(d => d.promise))]);
      const deletedIds = new Set(deletes.map(d => d.id));
      setShifts(prev => {
        const next = prev.filter(s => !deletedIds.has(s.id) && !created.some(c =>
          c.staffId === s.staffId && toDateOnly(c.date) === toDateOnly(s.date) && c.shift === s.shift
        ));
        return [...next, ...created];
      });
    } catch (error) {
      showToast('Errore nel salvataggio del turno', 'error');
    } finally {
      setApplyingDay(null);
    }
  };

  /** Riposo and Malattia straight from a cell: a one-day absence, the same
   *  record the Assenza modal writes over a range. */
  const applyDayAbsence = async (dateStr: string, type: TimeOffType) => {
    if (!selectedStaff || applyingDay) return;
    try {
      setApplyingDay(dateStr);
      const created = await staffApiService.createTimeOff({
        staffId: selectedStaff.id,
        startDate: dateStr,
        endDate: dateStr,
        type,
        shift: null,
        notes: '',
        approved: true,
      });
      setTimeOffs(prev => [...prev, created]);
      showToast(`${TIME_OFF_LABELS[type]} registrat${type === TimeOffType.MALATTIA ? 'a' : 'o'}`, 'success');
    } catch (error) {
      showToast('Errore nel salvataggio', 'error');
    } finally {
      setApplyingDay(null);
    }
  };

  /** Puts a day back to nothing: drops explicit shifts and any absence that
   *  covers that day alone. A multi-day absence is left to the Assenze tab —
   *  clearing one day of it would silently split someone's holiday in two. */
  const clearDay = async (dateStr: string) => {
    if (!selectedStaff || applyingDay) return;
    const dayShifts = shifts.filter(s => s.staffId === selectedStaff.id && toDateOnly(s.date) === dateStr);
    const singleDayOff = timeOffs.find(t =>
      t.staffId === selectedStaff.id &&
      toDateOnly(t.startDate) === dateStr &&
      toDateOnly(t.endDate) === dateStr
    );
    if (dayShifts.length === 0 && !singleDayOff) return;
    try {
      setApplyingDay(dateStr);
      await Promise.all([
        ...dayShifts.map(s => staffApiService.deleteShift(s.id)),
        ...(singleDayOff ? [staffApiService.deleteTimeOff(singleDayOff.id)] : []),
      ]);
      const removed = new Set(dayShifts.map(s => s.id));
      setShifts(prev => prev.filter(s => !removed.has(s.id)));
      if (singleDayOff) setTimeOffs(prev => prev.filter(t => t.id !== singleDayOff.id));
    } catch (error) {
      showToast('Errore nella rimozione', 'error');
    } finally {
      setApplyingDay(null);
    }
  };

  const handleOpenAddTimeOff = (date?: string) => {
    if (!selectedStaff) return;
    const today = date || formatLocalDate(new Date());
    setTimeOffForm({
      staffId: selectedStaff.id,
      startDate: today,
      endDate: today,
      type: TimeOffType.RIPOSO,
      shift: null,
      notes: '',
      approved: true
    });
    setShowTimeOffModal(true);
  };

  const handleSaveTimeOff = async () => {
    if (isSavingTimeOff) return;
    try {
      setIsSavingTimeOff(true);
      const created = await staffApiService.createTimeOff(timeOffForm);
      setTimeOffs(prev => [...prev, created]);
      setShowTimeOffModal(false);
      showToast('Assenza registrata', 'success');
    } catch (error: any) {
      console.error('createTimeOff failed', error);
      showToast(`Errore nel salvataggio: ${error?.message || 'sconosciuto'}`, 'error');
    } finally {
      setIsSavingTimeOff(false);
    }
  };

  const handleDeleteTimeOff = async (id: string) => {
    try {
      await staffApiService.deleteTimeOff(id);
      setTimeOffs(prev => prev.filter(t => t.id !== id));
      showToast('Assenza eliminata', 'success');
    } catch (error) {
      showToast('Errore nell\'eliminazione', 'error');
    }
  };

  const goToPreviousMonth = () => {
    setCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1));
  };

  const goToNextMonth = () => {
    setCalendarDate(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1));
  };

  const goToCurrentMonth = () => {
    setCalendarDate(new Date());
  };

  // ============================================
  // MENUS
  // ============================================

  // The column moves when the window is resized or the detail pane opens.
  useEffect(() => {
    if (!filtersOpen) return;
    const remeasure = () => setFilterHost(measureFilterHost());
    window.addEventListener('resize', remeasure);
    return () => window.removeEventListener('resize', remeasure);
  }, [filtersOpen]);

  useEffect(() => {
    if (!personMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!personMenuRef.current?.contains(t) && !personMenuTriggerRef.current?.contains(t)) setPersonMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPersonMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [personMenuOpen]);

  useEffect(() => {
    if (!dayMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDayMenu(null); };
    document.addEventListener('keydown', onKey);
    // Only the anchored menu needs the rest: the sheet has its own backdrop,
    // and closing it on scroll would fight the scroll inside the sheet.
    if (!isWide) {
      return () => document.removeEventListener('keydown', onKey);
    }
    const onDown = (e: MouseEvent) => {
      if (!dayMenuRef.current?.contains(e.target as Node)) setDayMenu(null);
    };
    // Fixed positioning does not follow a scrolling grid, so close rather than
    // let the menu drift off its day.
    const onScroll = () => setDayMenu(null);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [dayMenu, isWide]);

  const DAY_MENU_WIDTH = 248;
  const DAY_MENU_HEIGHT = 300;

  const openDayMenu = (e: React.MouseEvent<HTMLButtonElement>, dateStr: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    const below = r.bottom + 6;
    setDayMenu({
      date: dateStr,
      top: below + DAY_MENU_HEIGHT > window.innerHeight ? Math.max(8, r.top - DAY_MENU_HEIGHT - 6) : below,
      left: Math.min(Math.max(8, r.left), window.innerWidth - DAY_MENU_WIDTH - 8),
    });
  };

  // ============================================
  // RENDER
  // ============================================

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-1">
            <SkeletonStaffColumn label="Sala" />
            <SkeletonStaffColumn label="Cucina" />
          </div>
          <div className="hidden rounded-[20px] bg-[var(--ds-surface)] p-8 shadow-[var(--ds-shadow-card)] lg:col-span-2 lg:block">
            <div className="space-y-4 motion-safe:animate-pulse" aria-hidden="true">
              <div className="h-6 w-1/3 rounded bg-[var(--ds-surface-row)]" />
              <div className="h-4 w-2/3 rounded bg-[var(--ds-surface-row)]" />
              <div className="h-4 w-1/2 rounded bg-[var(--ds-surface-row)]" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const fullName = (s: StaffMember) => `${toTitleCase(s.name)} ${toTitleCase(s.surname)}`;
  const initials = (s: StaffMember) =>
    `${s.name[0]?.toUpperCase() ?? ''}${s.surname[0]?.toUpperCase() ?? ''}`;
  // Roles were typed in over the years, some in caps. Title-cased on the way
  // out rather than left as "CAMERIERE" shouting from a metadata line.
  const defaultRole = (s: StaffMember) =>
    toTitleCase(s.role) || (s.category === StaffCategory.SALA ? 'Cameriere' : 'Cuoco');

  /* ── Toolbar ─────────────────────────────────────────────────────────── */
  const toolbar = (
    <div ref={toolbarRef} className="space-y-3">
      {/* On a pointer the top bar's + is the one way in, as everywhere else.
          On touch it leads the column: the top bar is a thumb-stretch away
          from the list you are actually working in. */}
      <button
        type="button"
        onClick={handleOpenAddStaff}
        className={`${dsButton.primary} w-full lg:hidden`}
      >
        <UserPlus className="h-4 w-4" aria-hidden />
        Nuovo dipendente
      </button>

      <div className="flex items-center gap-3">
        <SearchField
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="Cerca dipendente"
          ariaLabel="Cerca dipendente"
          className="min-w-0 flex-1"
        />
        {/* Two filter tracks parked permanently above the list cost more room
            than they earn — most of the time nothing is filtered. They live
            behind this at every width. */}
        <button
          type="button"
          onClick={() => (filtersOpen ? setFiltersOpen(false) : openFilters())}
          aria-expanded={filtersOpen}
          aria-label="Filtri"
          title="Filtri"
          className={activeFilterCount > 0 || filtersOpen
            ? 'relative inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]'
            : `relative ${dsIconButton}`}
        >
          <ListFilter className="h-4 w-4" />
          {/* A filter you can't see is a filter you forget you set. */}
          {activeFilterCount > 0 && !filtersOpen && (
            <span className="absolute -right-0.5 -top-0.5">
              <CountBadge
                count={activeFilterCount}
                tone="alert"
                className="h-5 min-w-[20px] text-[11px] ring-2 ring-[var(--ds-canvas)]"
              />
            </span>
          )}
        </button>
      </div>

    </div>
  );

  /* ── Filtri ───────────────────────────────────────────────────────────
     Slides up over the list, same as Prenotazioni: changes apply as you make
     them and the backdrop dismisses. No apply button — there is nothing to
     commit.

     Held to the list column rather than the viewport. On Prenotazioni the list
     IS the screen, so a full-width sheet reads as "over the list"; here the
     list is a 400px column beside an open record, and covering the record too
     would darken the thing the filters have nothing to do with. Measured
     rather than positioned by CSS: an absolutely placed child of a scrolling
     column anchors to its scroll height, not to the part you can see. */
  const filtersSheet = filtersOpen ? createPortal(
    <div
      className="fixed z-50 flex items-end"
      style={filterHost ?? { inset: 0 }}
      onClick={() => setFiltersOpen(false)}
    >
      <div
        className="absolute inset-0 bg-[var(--ds-backdrop)]"
        style={{ animation: 'fadeIn 200ms ease-out both' }}
      />
      <div
        onClick={e => e.stopPropagation()}
        style={{ animation: 'slideUpSheet 260ms cubic-bezier(0.32, 0.72, 0, 1) both' }}
        className="relative max-h-full w-full overflow-y-auto rounded-t-[24px] bg-[var(--ds-surface)] pb-[max(1.5rem,env(safe-area-inset-bottom))] shadow-[var(--ds-shadow-raised)]"
      >
        <div className="flex justify-center pb-2 pt-3" aria-hidden>
          <span className="h-1 w-9 rounded-full bg-[var(--ds-border-strong)]" />
        </div>
        <div className="flex items-center justify-between gap-3 px-5 pb-3 sm:px-6">
          <h3 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Filtri</h3>
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={resetFilters}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              Reimposta
            </button>
          )}
        </div>
        <div className="space-y-4 px-5 sm:px-6">
          <div>
            <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-primary)]">Reparto</span>
            <div className="flex flex-wrap gap-2">
              <Chip active={categoryFilter === 'ALL'} onClick={() => setCategoryFilter('ALL')}>Tutti</Chip>
              <Chip active={categoryFilter === StaffCategory.SALA} onClick={() => setCategoryFilter(StaffCategory.SALA)}>
                <Users className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                Sala
              </Chip>
              <Chip active={categoryFilter === StaffCategory.CUCINA} onClick={() => setCategoryFilter(StaffCategory.CUCINA)}>
                <ChefHat className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                Cucina
              </Chip>
            </div>
          </div>
          <div>
            <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-primary)]">Contratto</span>
            <div className="flex flex-wrap gap-2">
              <Chip active={typeFilter === 'ALL'} onClick={() => setTypeFilter('ALL')}>
                Tutti
                <span className="tabular-nums opacity-70">{countByType('ALL')}</span>
              </Chip>
              {(Object.keys(STAFF_TYPE_LABELS) as StaffType[]).map(type => (
                <Chip key={type} active={typeFilter === type} onClick={() => setTypeFilter(type)}>
                  {STAFF_TYPE_LABELS[type]}
                  <span className="tabular-nums opacity-70">{countByType(type)}</span>
                </Chip>
              ))}
            </div>
          </div>
          {/* A checkbox, not a pair of chips: this is one thing that is on or
              off, and "Nascondi" as a selectable option made the default look
              like a choice someone had made. */}
          <label className="flex min-h-[44px] cursor-pointer items-center gap-3">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-4 w-4 flex-shrink-0 rounded accent-[var(--ds-action-bg)]"
            />
            <span className="min-w-0 flex-1 text-[14px] text-[var(--ds-text-secondary)]">Mostra inattivi</span>
            <span className="flex-shrink-0 text-[14px] tabular-nums text-[var(--ds-text-muted)]">{inactiveCount}</span>
          </label>
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  /* ── List ────────────────────────────────────────────────────────────── */
  const list = (
    <div className="space-y-3">
      {listGroups.length === 0 ? (
        <EmptyState icon={UserCircle}>
          {searchQuery.trim()
            ? `Nessun dipendente per "${searchQuery.trim()}".`
            : 'Nessun dipendente con questi filtri.'}
        </EmptyState>
      ) : (
        listGroups.map(group => (
          <div key={group.category}>
            <SectionHeader meta={String(group.members.length)}>
              {STAFF_CATEGORY_LABELS[group.category]}
            </SectionHeader>
            <div className="space-y-2">
              {group.members.map(staff => {
                const active = selectedStaff?.id === staff.id;
                return (
                  <button
                    key={staff.id}
                    type="button"
                    onClick={() => { setSelectedStaff(staff); setDetailTab('TURNI'); }}
                    // The selected ring is inset. Drawn outside the box it sits
                    // in the scroll container's gutter and gets clipped at both
                    // edges, so the card reads as cut off rather than picked.
                    className={`flex w-full items-center gap-3 rounded-[16px] bg-[var(--ds-surface)] p-3 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
                      active ? 'ring-2 ring-inset ring-[var(--ds-action-bg)]' : ''
                    } ${staff.isActive ? '' : 'opacity-60'}`}
                  >
                    <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[13px] font-semibold text-[var(--ds-text-secondary)]">
                      {initials(staff)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium text-[var(--ds-text-primary)]">
                        {fullName(staff)}
                      </span>
                      <span className="block truncate text-[13px] text-[var(--ds-text-muted)]">
                        {defaultRole(staff)}
                      </span>
                    </span>
                    {!staff.isActive && <StatusPill tone="neutral">Inattivo</StatusPill>}
                    <StatusPill tone={staff.staffType === StaffType.FISSO ? 'neutral' : staff.staffType === StaffType.STAGIONALE ? 'pending' : 'info'}>
                      {STAFF_TYPE_LABELS[staff.staffType]}
                    </StatusPill>
                  </button>
                );
              })}
            </div>
          </div>
        ))
      )}

    </div>
  );

  /* ── Calendar cell ───────────────────────────────────────────────────── */
  const renderDayCell = (day: Date, idx: number) => {
    if (!selectedStaff) return null;
    const dateStr = formatLocalDate(day);
    const isCurrentMonth = day.getMonth() === calendarDate.getMonth();
    const isToday = dateStr === formatLocalDate(new Date());
    const dayShifts = getShiftsForDay(day, selectedStaff.id);
    const dayTimeOff = getTimeOffForDay(day, selectedStaff.id);
    const fullDayOff = dayTimeOff && dayTimeOff.shift == null && dayShifts.length === 0;

    const lunch = slotState(selectedStaff, dateStr, Shift.LUNCH);
    const dinner = slotState(selectedStaff, dateStr, Shift.DINNER);
    const busy = applyingDay === dateStr;

    /* One row per service, each in its own colour — the same gold and indigo
       the Turno modal gives Pranzo and Cena, so the pairing is not invented
       here. Two rows instead of one "P+C" because the two services drift
       apart constantly: lunch written by hand, dinner taken away, dinner on
       holiday while lunch is worked. Merged, all of that collapsed into a
       sigla plus a footnote.

       Filled means someone wrote that shift; dashed means it comes from the
       contract. Written out in full for both services — Tailwind extracts
       class names statically, so a composed `bg-[var(--ds-${x}-tint)]` would
       never ship. */
    const serviceRow = (state: SlotState, label: string, service: 'lunch' | 'dinner') => {
      if (state === 'absent') {
        return (
          <span key={label} className="block truncate text-center text-[11px] text-[var(--ds-text-muted)] line-through">
            {label}
          </span>
        );
      }
      if (state === 'off' && dayTimeOff) {
        return (
          <span
            key={label}
            className={`block truncate rounded-full px-2 py-1 text-center text-[11px] font-medium ${TIME_OFF_CHIP[dayTimeOff.type]}`}
            title={`${TIME_OFF_LABELS[dayTimeOff.type]} — ${label.toLowerCase()}`}
          >
            {TIME_OFF_LABELS[dayTimeOff.type]}
          </span>
        );
      }
      if (state !== 'present' && state !== 'implicit') return null;
      const implicit = state === 'implicit';
      const tone = service === 'lunch'
        ? implicit
          ? 'border border-dashed border-[var(--ds-pending-text)] px-[7px] py-[3px] text-[var(--ds-pending-text)] opacity-75'
          : 'bg-[var(--ds-pending-tint)] px-2 py-1 text-[var(--ds-pending-text)]'
        : implicit
          ? 'border border-dashed border-[var(--ds-arriving-text)] px-[7px] py-[3px] text-[var(--ds-arriving-text)] opacity-75'
          : 'bg-[var(--ds-arriving-tint)] px-2 py-1 text-[var(--ds-arriving-text)]';
      return (
        <span
          key={label}
          className={`block truncate rounded-full text-center text-[11px] font-semibold ${tone}`}
          title={implicit ? `${label} dal contratto (${STAFF_TYPE_LABELS[selectedStaff.staffType]})` : label}
        >
          {label}
        </span>
      );
    };

    // A day given over entirely to an absence, or to the weekly rest, is one
    // statement about the day — not two identical rows.
    let rows: React.ReactNode;
    if (fullDayOff) {
      rows = (
        <span className={`block truncate rounded-full px-2 py-1 text-center text-[12px] font-medium ${TIME_OFF_CHIP[dayTimeOff!.type]}`}>
          {TIME_OFF_LABELS[dayTimeOff!.type]}
        </span>
      );
    } else if (lunch === 'rest' && dinner === 'rest') {
      rows = (
        <span className="block truncate rounded-full bg-[var(--ds-surface)] px-2 py-1 text-center text-[12px] font-medium text-[var(--ds-text-muted)]">
          Riposo
        </span>
      );
    } else {
      rows = (
        <>
          {serviceRow(lunch, 'Pranzo', 'lunch')}
          {serviceRow(dinner, 'Cena', 'dinner')}
        </>
      );
    }

    return (
      <button
        key={idx}
        type="button"
        onClick={(e) => openDayMenu(e, dateStr)}
        aria-label={`${day.getDate()} ${calendarDate.toLocaleDateString('it-IT', { month: 'long' })} — modifica`}
        // Taller than the merged cell was: two rows need the room, and a grid
        // whose cells resize as shifts change would jump under the cursor.
        className={`flex min-h-[92px] flex-col gap-1 rounded-[14px] p-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
          !isCurrentMonth
            ? 'opacity-40'
            : fullDayOff
              ? TIME_OFF_CHIP[dayTimeOff!.type]
              : 'bg-[var(--ds-surface-row)] hover:bg-[var(--ds-border)]'
        } ${isToday ? 'ring-2 ring-[var(--ds-action-bg)]' : ''} ${busy ? 'opacity-60' : ''}`}
      >
        <span className="flex items-center justify-between gap-1">
          <span className={`text-[12px] font-semibold tabular-nums ${isToday ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-secondary)]'}`}>
            {day.getDate()}
          </span>
          {isToday && <span className="text-[11px] text-[var(--ds-text-muted)]">oggi</span>}
          {busy && <Loader2 className="h-3 w-3 animate-spin text-[var(--ds-text-muted)]" aria-hidden />}
        </span>
        {rows}
      </button>
    );
  };

  /* ── Detail ──────────────────────────────────────────────────────────── */
  const detail = !selectedStaff ? (
    <PanePlaceholder icon={UserCircle}>
      Seleziona un dipendente per vedere turni e assenze.
    </PanePlaceholder>
  ) : (
    <div className="flex h-full min-h-0 flex-col">
      <PaneHeader
        onBack={() => setSelectedStaff(null)}
        backLabel="Torna all'elenco"
        title={fullName(selectedStaff)}
        subtitle={`${defaultRole(selectedStaff)} · ${STAFF_CATEGORY_LABELS[selectedStaff.category]} · ${STAFF_TYPE_LABELS[selectedStaff.staffType]}`}
        badge={!selectedStaff.isActive ? <StatusPill tone="neutral">Inattivo</StatusPill> : undefined}
        actions={
          <>
            {/* Una sola cosa da premere in testa alla scheda. Modifica è
                scesa nel menu insieme alle altre due azioni sulla persona:
                erano tre pesi diversi sulla stessa riga per tre cose che si
                fanno con la stessa frequenza, cioè di rado. */}
            <div className="relative">
              <button
                ref={personMenuTriggerRef}
                type="button"
                onClick={() => setPersonMenuOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={personMenuOpen}
                aria-label="Altre azioni"
                title="Altre azioni"
                className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              {personMenuOpen && (
                <div
                  ref={personMenuRef}
                  role="menu"
                  className="absolute right-0 top-full z-30 mt-2 w-[240px] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setPersonMenuOpen(false); handleOpenEditStaff(selectedStaff); }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                  >
                    <Edit2 className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                    Modifica scheda
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setPersonMenuOpen(false); handleToggleStaffActive(selectedStaff); }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                  >
                    {selectedStaff.isActive
                      ? <Ban className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                      : <RotateCcw className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />}
                    {selectedStaff.isActive ? 'Disattiva' : 'Riattiva'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => { setPersonMenuOpen(false); setDeleteStaffConfirm(selectedStaff); }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
                  >
                    <Trash2 className="h-4 w-4 flex-shrink-0" aria-hidden />
                    Elimina dipendente
                  </button>
                </div>
              )}
            </div>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-6 sm:px-6 lg:px-8">
        {/* Contact — a number you can dial rather than a number you retype. */}
        {(selectedStaff.phone || selectedStaff.email) && (
          <div className="flex flex-wrap gap-2">
            {selectedStaff.phone && (
              <a
                href={`tel:${selectedStaff.phone.replace(/\s/g, '')}`}
                className={`${dsButton.secondary} px-4`}
              >
                <Phone className="h-4 w-4" aria-hidden />
                {selectedStaff.phone}
              </a>
            )}
            {selectedStaff.email && (
              <a
                href={`mailto:${selectedStaff.email}`}
                className={`${dsButton.secondary} min-w-0 px-4`}
              >
                <Mail className="h-4 w-4 flex-shrink-0" aria-hidden />
                <span className="truncate">{selectedStaff.email}</span>
              </a>
            )}
          </div>
        )}

        <StatStrip
          layout="stacked"
          stats={[
            { value: monthStats.shifts, label: 'turni nel mese' },
            { value: monthStats.rest, label: 'riposi' },
            { value: monthStats.holiday, label: 'vacanza', tone: monthStats.holiday > 0 ? 'positive' : 'neutral' },
          ]}
        />

        <SegmentedControl
          value={detailTab}
          onChange={(next: 'TURNI' | 'ASSENZE') => setDetailTab(next)}
          options={[
            { value: 'TURNI' as const, label: 'Turni', badge: monthStats.shifts, badgeTone: 'neutral' as const },
            {
              value: 'ASSENZE' as const,
              label: 'Assenze',
              badge: timeOffs.filter(t => t.staffId === selectedStaff.id).length,
              badgeTone: 'neutral' as const,
            },
          ]}
          ariaLabel="Sezione della scheda"
        />

        {detailTab === 'TURNI' ? (
          <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <button type="button" onClick={goToPreviousMonth} className={rowIconButton} aria-label="Mese precedente">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="min-w-[150px] text-center text-[16px] font-semibold capitalize text-[var(--ds-text-primary)]">
                {calendarDate.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}
              </span>
              <button type="button" onClick={goToNextMonth} className={rowIconButton} aria-label="Mese successivo">
                <ChevronRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={goToCurrentMonth}
                className="inline-flex h-9 items-center rounded-full bg-[var(--ds-surface-row)] px-3 text-[14px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-border)] hover:text-[var(--ds-text-primary)]"
              >
                Oggi
              </button>
              <div className="ml-auto flex items-center gap-2">
                <button type="button" onClick={() => handleOpenAddTimeOff()} className={`${dsButton.secondary} px-4`}>
                  <CalendarDays className="h-4 w-4" aria-hidden />
                  Assenza
                </button>
                <button type="button" onClick={() => handleOpenAddShift()} className={`${dsButton.primary} px-4`}>
                  <Plus className="h-4 w-4" aria-hidden />
                  Turno
                </button>
              </div>
            </div>

            {/* Wider than it was: "Pranzo" needs about 52px of cell to sit on
                one line, and a clipped label defeats the point of writing the
                service out. Below that the grid scrolls sideways. */}
            <div className="overflow-x-auto">
              <div className="min-w-[600px]">
                <div className="mb-2 grid grid-cols-7 gap-1.5">
                  {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(day => (
                    <div key={day} className="py-1 text-center text-[13px] text-[var(--ds-text-muted)]">
                      {day}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-7 gap-1.5">
                  {calendarDays.map((day, idx) => renderDayCell(day, idx))}
                </div>
              </div>
            </div>

            {/* Legend. Only the marks that can actually appear for this person —
                the automatic one means nothing for an Extra. */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[13px] text-[var(--ds-text-muted)]">
              <span className="flex items-center gap-1.5">
                <span className="rounded-full bg-[var(--ds-pending-tint)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-pending-text)]">Pranzo</span>
                <span className="rounded-full bg-[var(--ds-arriving-tint)] px-2 py-0.5 text-[11px] font-semibold text-[var(--ds-arriving-text)]">Cena</span>
                turno assegnato
              </span>
              {hasAutoShifts(selectedStaff) && (
                <span className="flex items-center gap-1.5">
                  <span className="rounded-full border border-dashed border-[var(--ds-pending-text)] px-[7px] py-[1px] text-[11px] font-semibold text-[var(--ds-pending-text)] opacity-75">Pranzo</span>
                  dal contratto
                </span>
              )}
              {(Object.keys(TIME_OFF_LABELS) as TimeOffType[]).map(type => (
                <span key={type} className="flex items-center gap-1.5">
                  <span className={`h-3 w-3 rounded-full ${TIME_OFF_CHIP[type]}`} aria-hidden />
                  {TIME_OFF_LABELS[type].toLowerCase()}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {timeOffsByMonth.length === 0 ? (
              <EmptyState
                icon={CalendarDays}
                action={
                  <button type="button" onClick={() => handleOpenAddTimeOff()} className={dsButton.primary}>
                    <Plus className="h-4 w-4" aria-hidden />
                    Registra un'assenza
                  </button>
                }
              >
                Nessuna assenza registrata.
              </EmptyState>
            ) : (
              timeOffsByMonth.map(group => (
                <div key={group.key}>
                  <SectionHeader meta={plural(group.items.length, 'assenza', 'assenze')}>
                    <span className="capitalize">{group.label}</span>
                  </SectionHeader>
                  <div className="space-y-2">
                    {group.items.map(timeOff => (
                      <div
                        key={timeOff.id}
                        className="flex items-center gap-2 rounded-[16px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]"
                      >
                        <StatusPill tone={TIME_OFF_PILL_TONE[timeOff.type]}>
                          {TIME_OFF_LABELS[timeOff.type]}
                        </StatusPill>
                        {timeOff.shift && (
                          <StatusPill tone="neutral">
                            {timeOff.shift === Shift.LUNCH ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
                            {timeOff.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'}
                          </StatusPill>
                        )}
                        <span className="min-w-0 flex-1 truncate text-[15px] text-[var(--ds-text-primary)]">
                          {formatTimeOffDayLabel(timeOff, group.key)}
                          {timeOff.notes && (
                            <span className="text-[var(--ds-text-muted)]"> · {timeOff.notes}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            const dateRange = timeOff.startDate === timeOff.endDate
                              ? new Date(timeOff.startDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
                              : `${new Date(timeOff.startDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} - ${new Date(timeOff.endDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
                            setDeleteTimeOffConfirm({ id: timeOff.id, label: `${TIME_OFF_LABELS[timeOff.type]} · ${dateRange}` });
                          }}
                          className={rowIconButtonDanger}
                          aria-label={`Elimina ${TIME_OFF_LABELS[timeOff.type]}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );

  const dayMenuStaff = selectedStaff;
  const dayMenuHasSomething = dayMenu && dayMenuStaff
    ? shifts.some(s => s.staffId === dayMenuStaff.id && toDateOnly(s.date) === dayMenu.date) ||
      timeOffs.some(t => t.staffId === dayMenuStaff.id && toDateOnly(t.startDate) === dayMenu.date && toDateOnly(t.endDate) === dayMenu.date)
    : false;

  const dayMenuItem =
    'flex w-full items-center gap-3 px-4 py-2.5 text-left text-[15px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]';

  /* One list, two containers. A dot in the service's colour rather than a
     "P+C" sigla, so the menu speaks the same language the grid now does. */
  const swatch = (tone: string) => (
    <span className={`h-2.5 w-2.5 flex-shrink-0 rounded-full ${tone}`} aria-hidden />
  );

  const dayActions = dayMenu
    ? [
        {
          key: 'both',
          label: 'Pranzo e cena',
          mark: (
            <span className="flex flex-shrink-0 items-center gap-1">
              {swatch('bg-[var(--ds-pending-solid)]')}
              {swatch('bg-[var(--ds-arriving-solid)]')}
            </span>
          ),
          run: (d: string) => applyDayShifts(d, true, true),
        },
        {
          key: 'lunch',
          label: 'Solo pranzo',
          mark: swatch('bg-[var(--ds-pending-solid)]'),
          run: (d: string) => applyDayShifts(d, true, false),
        },
        {
          key: 'dinner',
          label: 'Solo cena',
          mark: swatch('bg-[var(--ds-arriving-solid)]'),
          run: (d: string) => applyDayShifts(d, false, true),
        },
        {
          key: 'rest',
          label: 'Riposo',
          mark: swatch('bg-[var(--ds-text-subtle)]'),
          run: (d: string) => applyDayAbsence(d, TimeOffType.RIPOSO),
        },
        {
          key: 'sick',
          label: 'Malattia',
          mark: swatch('bg-[var(--ds-critical-solid)]'),
          run: (d: string) => applyDayAbsence(d, TimeOffType.MALATTIA),
        },
        { key: 'sep', separator: true as const },
        ...(dayMenuHasSomething
          ? [{
              key: 'clear',
              label: 'Svuota il giorno',
              danger: true,
              mark: <X className="h-4 w-4 flex-shrink-0" aria-hidden />,
              run: (d: string) => clearDay(d),
            }]
          : []),
        {
          key: 'notes',
          label: 'Turno con note…',
          mark: <Edit2 className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />,
          run: (d: string) => handleOpenAddShift(d),
        },
        {
          key: 'range',
          label: 'Assenza su più giorni…',
          mark: <CalendarDays className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />,
          run: (d: string) => handleOpenAddTimeOff(d),
        },
      ]
    : [];

  const dayMenuTitle = dayMenu
    ? fromDateOnly(dayMenu.date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })
    : '';

  const runDayAction = (run: (d: string) => void) => {
    const d = dayMenu!.date;
    setDayMenu(null);
    run(d);
  };

  return (
    <>
      <SplitPane
        detailOpen={!!selectedStaff}
        toolbar={toolbar}
        list={list}
        detail={detail}
      />

      {filtersSheet}

      {/* ----- Quick set on a day, with a pointer ----- */}
      {dayMenu && dayMenuStaff && isWide && createPortal(
        <div
          ref={dayMenuRef}
          role="menu"
          style={{ top: dayMenu.top, left: dayMenu.left, width: DAY_MENU_WIDTH }}
          className="fixed z-[60] overflow-hidden rounded-[20px] bg-[var(--ds-surface)] py-1.5 shadow-[var(--ds-shadow-raised)]"
        >
          <div className="px-4 pb-1.5 pt-1 text-[13px] capitalize text-[var(--ds-text-muted)]">
            {dayMenuTitle}
          </div>
          {dayActions.map(a =>
            'separator' in a ? (
              <div key={a.key} className="my-1.5 h-px bg-[var(--ds-border)]" />
            ) : (
              <button
                key={a.key}
                type="button"
                role="menuitem"
                className={`${dayMenuItem} ${a.danger ? 'text-[var(--ds-critical-text)]' : ''}`}
                onClick={() => runDayAction(a.run)}
              >
                {a.mark}
                {a.label}
              </button>
            )
          )}
        </div>,
        document.body
      )}

      {/* ----- Quick set on a day, on touch -----
          A menu floating beside a cell is the wrong shape here: the grid
          scrolls sideways under it, and with nothing dimmed there is no
          visible way out. Same sheet as everywhere else on touch — backdrop,
          handle, an explicit way to close. */}
      {dayMenu && dayMenuStaff && !isWide && createPortal(
        <div className="fixed inset-0 z-[60] flex items-end" onClick={() => setDayMenu(null)}>
          <div
            className="absolute inset-0 bg-[var(--ds-backdrop)]"
            style={{ animation: 'fadeIn 200ms ease-out both' }}
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={dayMenuTitle}
            onClick={e => e.stopPropagation()}
            style={{ animation: 'slideUpSheet 260ms cubic-bezier(0.32, 0.72, 0, 1) both' }}
            className="relative max-h-full w-full overflow-y-auto rounded-t-[24px] bg-[var(--ds-surface)] pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[var(--ds-shadow-raised)]"
          >
            <div className="flex justify-center pb-2 pt-3" aria-hidden>
              <span className="h-1 w-9 rounded-full bg-[var(--ds-border-strong)]" />
            </div>
            <h3 className="px-5 pb-3 text-[17px] font-semibold capitalize text-[var(--ds-text-primary)]">
              {dayMenuTitle}
            </h3>
            <div className="px-4">
              <div className="overflow-hidden rounded-[20px] bg-[var(--ds-canvas)]">
                {dayActions.map(a =>
                  'separator' in a ? null : (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => runDayAction(a.run)}
                      className={`flex min-h-[56px] w-full items-center gap-3 border-b border-[var(--ds-border)] px-4 text-left text-[16px] transition-colors last:border-b-0 hover:bg-[var(--ds-surface-row)] ${
                        a.danger ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'
                      }`}
                    >
                      {a.mark}
                      {a.label}
                    </button>
                  )
                )}
              </div>
              <button
                type="button"
                onClick={() => setDayMenu(null)}
                className={`${dsButton.secondary} mt-3 w-full`}
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ----- Staff modal ----- */}
      <ModalShell
        open={showStaffModal}
        onClose={() => { setShowStaffModal(false); resetStaffForm(); }}
        title={editingStaff ? 'Modifica dipendente' : 'Nuovo dipendente'}
        subtitle="Nome, reparto e tipo di contratto bastano per iniziare"
        size="md"
        subheader={
          <StepNav
            steps={[
              { label: 'Anagrafica e contratto', icon: User },
              { label: 'Turno base', icon: CalendarDays },
            ]}
            current={staffStep}
            onSelect={setStaffStep}
            ariaLabel="Passi del dipendente"
          />
        }
        bodyClassName="px-5 pb-5 pt-4 sm:px-6"
        footerStart={
          staffStep === 1 ? (
            <button
              type="button"
              onClick={() => setStaffStep(0)}
              className="inline-flex items-center gap-1.5 text-[15px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              Anagrafica
            </button>
          ) : undefined
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => { setShowStaffModal(false); resetStaffForm(); }}
              className={dsButton.secondary}
            >
              Annulla
            </button>
            {staffStep === 0 ? (
              <button type="button" onClick={() => setStaffStep(1)} className={dsButton.primary}>
                Avanti · Turno base
                <ChevronRight className="h-4 w-4" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSaveStaff}
                disabled={isSavingStaff}
                className={dsButton.primary}
              >
                {isSavingStaff && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {editingStaff ? 'Salva' : 'Aggiungi dipendente'}
              </button>
            )}
          </>
        }
      >
        {staffStep === 0 ? (
          <div className="space-y-4">
            <FormCard title="Anagrafica" aside="chi è e come si raggiunge" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Nome" htmlFor="staff-name" required>
                  <input
                    id="staff-name"
                    type="text"
                    value={staffForm.name}
                    onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
                    placeholder="Giulia"
                    className={dsInput}
                    autoFocus
                  />
                </Field>
                <Field label="Cognome" htmlFor="staff-surname" required>
                  <input
                    id="staff-surname"
                    type="text"
                    value={staffForm.surname}
                    onChange={(e) => setStaffForm({ ...staffForm, surname: e.target.value })}
                    placeholder="Ferraro"
                    className={dsInput}
                  />
                </Field>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Telefono" htmlFor="staff-phone">
                  <input
                    id="staff-phone"
                    type="tel"
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                    placeholder="348 771 2205"
                    className={dsInput}
                  />
                </Field>
                <Field label="Email" htmlFor="staff-email">
                  <input
                    id="staff-email"
                    type="email"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    placeholder="nome@ristorante.it"
                    className={dsInput}
                  />
                </Field>
              </div>
            </FormCard>

            <FormCard title="Reparto e ruolo" aside="decide dove appare nell'elenco" className="space-y-4">
              <Field label="Reparto" required>
                <SegmentedControl
                  value={staffForm.category}
                  onChange={(next: StaffCategory) => setStaffForm({ ...staffForm, category: next })}
                  options={[
                    { value: StaffCategory.SALA, label: 'Sala', icon: <Users className="h-4 w-4" /> },
                    { value: StaffCategory.CUCINA, label: 'Cucina', icon: <ChefHat className="h-4 w-4" /> },
                  ]}
                  ariaLabel="Reparto"
                />
              </Field>
              <Field label="Ruolo" htmlFor="staff-role" hint="Come compare sotto il nome nell'elenco">
                <input
                  id="staff-role"
                  type="text"
                  value={staffForm.role}
                  onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                  placeholder="es. Chef, Cameriere, Lavapiatti"
                  className={dsInput}
                />
              </Field>
              <Field label="Tipo di contratto" required>
                {/* Cards, not a select: the difference between the three is what
                    the calendar does on its own, and that has to be readable
                    before the choice, not after a month of empty days. */}
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                  {(Object.keys(STAFF_TYPE_LABELS) as StaffType[]).map(type => {
                    const active = staffForm.staffType === type;
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setStaffForm({ ...staffForm, staffType: type })}
                        aria-pressed={active}
                        className={`rounded-[16px] px-4 py-3 text-left transition-colors ${
                          active
                            ? 'bg-[var(--ds-pending-tint)] ring-2 ring-inset ring-[var(--ds-pending-solid)]'
                            : 'bg-[var(--ds-surface-row)] hover:bg-[var(--ds-border)]'
                        }`}
                      >
                        <span className={`block text-[15px] font-semibold ${active ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-primary)]'}`}>
                          {STAFF_TYPE_LABELS[type]}
                        </span>
                        <span className={`block text-[13px] ${active ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-text-muted)]'}`}>
                          {STAFF_TYPE_HINTS[type]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </Field>
            </FormCard>
          </div>
        ) : (
          <div className="space-y-4">
            <FormCard title="Contratto" aside="entro quali date valgono i turni" className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Data di assunzione" htmlFor="staff-hire">
                  <input
                    id="staff-hire"
                    type="date"
                    value={staffForm.hireDate}
                    onChange={(e) => setStaffForm({ ...staffForm, hireDate: e.target.value })}
                    className={dsInput}
                  />
                </Field>
                <Field
                  label="Fine contratto"
                  htmlFor="staff-end"
                  hint={staffForm.staffType === StaffType.STAGIONALE ? 'Dopo questa data non compaiono più turni automatici' : undefined}
                >
                  <input
                    id="staff-end"
                    type="date"
                    value={staffForm.contractEndDate}
                    onChange={(e) => setStaffForm({ ...staffForm, contractEndDate: e.target.value })}
                    className={dsInput}
                  />
                </Field>
              </div>
            </FormCard>

            <FormCard title="Turno base" aside="quello che il calendario dà per scontato" className="space-y-4">
              {staffForm.staffType === StaffType.EXTRA ? (
                <Callout tone="info">
                  Un contratto extra non ha turni automatici: ogni servizio si assegna dal calendario.
                </Callout>
              ) : (
                <Callout tone="info">
                  Con un contratto {STAFF_TYPE_LABELS[staffForm.staffType].toLowerCase()} il calendario segna pranzo e cena
                  tutti i giorni dentro il periodo di contratto, tranne il giorno di riposo e le assenze.
                </Callout>
              )}
              <Field label="Giorno di riposo settimanale" htmlFor="staff-rest">
                <select
                  id="staff-rest"
                  value={staffForm.weeklyRestDay ?? ''}
                  onChange={(e) => setStaffForm({
                    ...staffForm,
                    weeklyRestDay: e.target.value === '' ? null : Number(e.target.value)
                  })}
                  className={dsSelect}
                >
                  <option value="">Nessuno</option>
                  {WEEKDAY_LABELS.map((label, idx) => (
                    <option key={idx} value={idx}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Note" htmlFor="staff-notes">
                <textarea
                  id="staff-notes"
                  value={staffForm.notes}
                  onChange={(e) => setStaffForm({ ...staffForm, notes: e.target.value })}
                  rows={3}
                  placeholder="Disponibilità, accordi, contatti di emergenza…"
                  className={dsTextarea}
                />
              </Field>
            </FormCard>
          </div>
        )}
      </ModalShell>

      {/* ----- Shift modal ----- */}
      <ModalShell
        open={showShiftModal}
        onClose={() => setShowShiftModal(false)}
        title={selectedStaff ? `Turno · ${fullName(selectedStaff)}` : 'Turno'}
        subtitle={shiftForm.date
          ? fromDateOnly(shiftForm.date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
          : undefined}
        size="sm"
        closeOnEscape
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footerStart={
          (shiftForm.lunch || shiftForm.dinner) ? (
            <button
              type="button"
              onClick={() => setShiftForm({ ...shiftForm, lunch: false, dinner: false })}
              className="text-[15px] font-medium text-[var(--ds-critical-text)] hover:opacity-80"
            >
              Rimuovi turno
            </button>
          ) : undefined
        }
        footer={
          <>
            <button type="button" onClick={() => setShowShiftModal(false)} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSaveShift}
              disabled={isSavingShift}
              className={dsButton.primary}
            >
              {isSavingShift && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Salva
            </button>
          </>
        }
      >
        <FormCard className="space-y-4">
          <Field label="Data" htmlFor="shift-date">
            <input
              id="shift-date"
              type="date"
              value={shiftForm.date}
              onChange={(e) => setShiftForm({ ...shiftForm, date: e.target.value })}
              className={dsInput}
            />
          </Field>

          <Field label="Turno" hint="Puoi selezionare uno o entrambi i servizi">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setShiftForm({ ...shiftForm, lunch: !shiftForm.lunch })}
                aria-pressed={shiftForm.lunch}
                className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-[16px] text-[15px] font-semibold transition-colors ${
                  shiftForm.lunch
                    ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)] ring-2 ring-inset ring-[var(--ds-pending-solid)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                }`}
              >
                <Sun className="h-4 w-4" aria-hidden />
                Pranzo
              </button>
              <button
                type="button"
                onClick={() => setShiftForm({ ...shiftForm, dinner: !shiftForm.dinner })}
                aria-pressed={shiftForm.dinner}
                className={`flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-[16px] text-[15px] font-semibold transition-colors ${
                  shiftForm.dinner
                    ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)] ring-2 ring-inset ring-[var(--ds-arriving-solid)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                }`}
              >
                <Moon className="h-4 w-4" aria-hidden />
                Cena
              </button>
            </div>
          </Field>

          <Field label="Note" htmlFor="shift-notes">
            <input
              id="shift-notes"
              type="text"
              value={shiftForm.notes}
              onChange={(e) => setShiftForm({ ...shiftForm, notes: e.target.value })}
              placeholder="Postazione, orario concordato…"
              className={dsInput}
            />
          </Field>
        </FormCard>
      </ModalShell>

      {/* ----- Time off modal ----- */}
      <ModalShell
        open={showTimeOffModal}
        onClose={() => setShowTimeOffModal(false)}
        title={selectedStaff ? `Assenza · ${fullName(selectedStaff)}` : 'Assenza'}
        subtitle="I turni nel periodo vengono sostituiti"
        size="sm"
        closeOnEscape
        bodyClassName="px-5 pb-5 pt-1 sm:px-6"
        footerStart={
          timeOffForm.startDate && timeOffForm.endDate && timeOffForm.endDate >= timeOffForm.startDate
            ? plural(eachDate(timeOffForm.startDate, timeOffForm.endDate).length, 'giorno', 'giorni')
            : undefined
        }
        footer={
          <>
            <button type="button" onClick={() => setShowTimeOffModal(false)} className={dsButton.secondary}>
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSaveTimeOff}
              disabled={isSavingTimeOff}
              className={dsButton.primary}
            >
              {isSavingTimeOff && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              Registra
            </button>
          </>
        }
      >
        <FormCard className="space-y-4">
          <Field label="Tipo" required>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(TIME_OFF_LABELS) as TimeOffType[]).map(type => {
                const active = timeOffForm.type === type;
                return (
                  <button
                    key={type}
                    type="button"
                    onClick={() => setTimeOffForm({ ...timeOffForm, type })}
                    aria-pressed={active}
                    className={`inline-flex h-11 items-center rounded-full px-4 text-[15px] font-medium transition-colors ${
                      active
                        ? `${TIME_OFF_CHIP[type]} ring-2 ring-inset ring-current`
                        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
                    }`}
                  >
                    {TIME_OFF_LABELS[type]}
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Dal" htmlFor="off-start">
              <input
                id="off-start"
                type="date"
                value={timeOffForm.startDate}
                onChange={(e) => {
                  const startDate = e.target.value;
                  setTimeOffForm(f => ({
                    ...f,
                    startDate,
                    // A range that ends before it starts saves nothing and warns
                    // about nothing; drag the end along instead.
                    endDate: f.endDate && f.endDate >= startDate ? f.endDate : startDate,
                  }));
                }}
                className={dsInput}
              />
            </Field>
            <Field label="Al" htmlFor="off-end">
              <input
                id="off-end"
                type="date"
                value={timeOffForm.endDate}
                min={timeOffForm.startDate}
                onChange={(e) => setTimeOffForm({ ...timeOffForm, endDate: e.target.value })}
                className={dsInput}
              />
            </Field>
          </div>

          <Field label="Solo un turno" hint="Lascia «tutto il giorno» per l'intera giornata">
            <SegmentedControl
              value={timeOffForm.shift ?? 'ALL'}
              onChange={(next: string) => setTimeOffForm({ ...timeOffForm, shift: next === 'ALL' ? null : (next as Shift) })}
              options={[
                { value: 'ALL', label: 'Tutto il giorno' },
                { value: Shift.LUNCH, label: 'Pranzo' },
                { value: Shift.DINNER, label: 'Cena' },
              ]}
              ariaLabel="Turno interessato"
              equalWidth={false}
            />
          </Field>

          {/* Who is left. Not a rule being broken — there is no minimum staffing
              in the data — just the number worth seeing before pressing save. */}
          {coverageNote && (
            <Callout tone="pending" icon={AlertTriangle}>
              {coverageNote.map(line => <div key={line}>{line}</div>)}
            </Callout>
          )}

          <Field label="Note" htmlFor="off-notes">
            <input
              id="off-notes"
              type="text"
              value={timeOffForm.notes ?? ''}
              onChange={(e) => setTimeOffForm({ ...timeOffForm, notes: e.target.value })}
              placeholder="Note opzionali"
              className={dsInput}
            />
          </Field>
        </FormCard>
      </ModalShell>

      <ConfirmDeleteModal
        isOpen={!!deleteStaffConfirm}
        title="Elimina Dipendente"
        message="Stai per eliminare il dipendente:"
        itemName={deleteStaffConfirm ? fullName(deleteStaffConfirm) : undefined}
        onCancel={() => setDeleteStaffConfirm(null)}
        onConfirm={() => {
          if (deleteStaffConfirm) handleDeleteStaff(deleteStaffConfirm.id);
          setDeleteStaffConfirm(null);
        }}
      />

      <ConfirmDeleteModal
        isOpen={!!deleteTimeOffConfirm}
        title="Elimina Assenza"
        message="Stai per eliminare l'assenza:"
        itemName={deleteTimeOffConfirm?.label}
        onCancel={() => setDeleteTimeOffConfirm(null)}
        onConfirm={() => {
          if (deleteTimeOffConfirm) handleDeleteTimeOff(deleteTimeOffConfirm.id);
          setDeleteTimeOffConfirm(null);
        }}
      />
    </>
  );
};
