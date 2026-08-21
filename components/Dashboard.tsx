import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Reservation, Table, Dish, Room, Shift, ReservationStatus, ReservationSource, TodoPriority, TodoCategory, StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType, BanquetMenu } from '../types';
import { ShoppingCategory, ShoppingItem } from '../services/shoppingApiService';
import { getLowStockInventory, LowStockItem, getReservationAllergenPresets } from '../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { isSeated, getTimedReservationState, PulseDot } from './reservationState';
import { DietaryChips } from './DietaryChips';
import { stripDietaryNote } from '../utils/dietary';
import { useNow } from '../hooks/useNow';
import { toTitleCase } from '../utils/text';
import { PaymentBadge, hasUnpaidDeposit } from './PaymentBadge';
import { SkeletonKpiRow, SkeletonReservationCard } from './SkeletonCards';
import { staffApiService } from '../services/staffApiService';
import { DateNavigator } from './DateNavigator';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, ChevronRight, Calendar, Plus, Check, Clock, Flag, AlertTriangle, CheckCircle2, ListTodo, ShoppingCart, Coffee, ChefHat, Package, Sun, Sunset, Armchair, Trees, Mountain, Waves, TreePine, Tent, Columns3, MapPin, StickyNote, Wheat, ListChecks, Phone as PhoneIcon, Globe, Mic, MessageCircle, User as UserIcon, Users as UsersIcon, X, ArrowRight, Ban, HelpCircle, LayoutGrid, UtensilsCrossed, BarChart3 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../contexts/AuthContext';
import { useShopping } from '../contexts/ShoppingContext';
import { useTodos } from '../contexts/TodosContext';
import { CookingPotLoader } from './CookingPotLoader';
import { ArrivalsTimeline } from './ArrivalsTimeline';

const CATEGORY_DOT_COLORS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'bg-slate-400',
  [TodoCategory.RESERVATION]: 'bg-indigo-500',
  [TodoCategory.INVENTORY]: 'bg-amber-500',
  [TodoCategory.STAFF]: 'bg-emerald-500',
  [TodoCategory.MAINTENANCE]: 'bg-orange-500',
  [TodoCategory.EVENT]: 'bg-purple-500',
};

const PRIORITY_RANK: Record<TodoPriority, number> = {
  [TodoPriority.HIGH]: 0,
  [TodoPriority.MEDIUM]: 1,
  [TodoPriority.LOW]: 2,
};

const PRIORITY_COLORS: Record<TodoPriority, string> = {
  [TodoPriority.LOW]: 'text-slate-400',
  [TodoPriority.MEDIUM]: 'text-amber-500',
  [TodoPriority.HIGH]: 'text-rose-500',
};

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
  rooms: Room[];
  banquetMenus: BanquetMenu[];
  onNavigateToBanquets: () => void;
  onNavigateToReservations?: () => void;
  onNavigateToInventario?: () => void;
  onNavigateToShoppingList?: () => void;
  onNavigateToAttivita?: () => void;
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  onDateChange?: (date: Date) => void;
  onShiftFilterChange?: (filter: 'ALL' | 'LUNCH' | 'DINNER') => void;
  // Persist a status/notes change for a reservation. Used by the pending
  // quick-action modal to Conferma/Rifiuta without leaving the Dashboard.
  onUpdateReservation?: (res: Reservation) => Promise<void>;
  // Deep-link a specific reservation in the Prenotazioni page (full editor).
  // Called from the pending modal's "Modifica completa" secondary link.
  onOpenReservationInList?: (id: number) => void;
  // True while the parent's first fetchData() hasn't returned yet. Gates the
  // initial-load skeletons for the KPI cards and the "Da confermare" list.
  isInitialLoading?: boolean;
}

// Shopping List Labels and Colors
const SHOPPING_CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  'CUCINA': 'Cucina',
  'BAR': 'Bar',
  'ALTRO': 'Altro'
};

// Room name → lucide icon. Scalable: extend the map for new rooms or fall back to MapPin.
const ROOM_ICON_BY_NAME: Record<string, React.ComponentType<{ className?: string }>> = {
  veranda: Trees,
  macine: Mountain,
  fiume: Waves,
  fuori: TreePine,
  tettoia: Tent,
  porticato: Columns3,
};
const getRoomIcon = (name: string): React.ComponentType<{ className?: string }> => {
  const key = name.trim().toLowerCase();
  return ROOM_ICON_BY_NAME[key] || MapPin;
};

// One metric inside the "Adesso in sala" deck. Neutral by default; only the
// state that needs a glance-level colour ("In arrivo") gets tinted, so the
// deck stays calm and the tint keeps its meaning.
const LiveTile: React.FC<{
  label: string;
  value: React.ReactNode;
  sub: string;
  tone?: 'neutral' | 'arriving';
  dot?: React.ReactNode;
}> = ({ label, value, sub, tone = 'neutral', dot }) => {
  const arriving = tone === 'arriving';
  return (
    <div className={`min-w-0 rounded-[16px] px-4 py-3.5 ${arriving ? 'bg-[var(--ds-arriving-tint)]' : 'bg-[var(--ds-surface-row)]'}`}>
      <div className={`flex items-center gap-1.5 text-[13px] font-medium ${arriving ? 'text-[var(--ds-arriving-text)]' : 'text-[var(--ds-text-secondary)]'}`}>
        {dot}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1 text-[28px] sm:text-[32px] leading-none font-bold tabular-nums tracking-[-0.02em] ${arriving ? 'text-[var(--ds-arriving-text)]' : 'text-[var(--ds-text-primary)]'}`}>
        {value}
      </div>
      <div className={`mt-2 text-[13px] truncate ${arriving ? 'text-[var(--ds-arriving-text)]' : 'text-[var(--ds-text-muted)]'}`}>
        {sub}
      </div>
    </div>
  );
};

// Lunch/dinner split rendered as one bar. `total` is the denominator the bar
// fills against — for share bars that's lunch+dinner (always full), for the
// Tavoli capacity bar it's the table count (leaves a remainder). `other` is the
// neutral bucket for records with no shift set.
const ShiftBar: React.FC<{ lunch: number; dinner: number; total: number; other?: number }> = ({ lunch, dinner, total, other = 0 }) => {
  const pct = (n: number) => (total > 0 ? Math.max(0, Math.min(100, (n / total) * 100)) : 0);
  return (
    <div className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-[var(--ds-surface-row)]" aria-hidden>
      {lunch > 0 && (
        <div className="h-full rounded-full bg-[var(--ds-pending-solid)]" style={{ width: `${pct(lunch)}%` }} />
      )}
      {dinner > 0 && (
        <div className="h-full rounded-full bg-[var(--ds-arriving-solid)]" style={{ width: `${pct(dinner)}%` }} />
      )}
      {other > 0 && (
        <div className="h-full rounded-full bg-[var(--ds-border-strong)]" style={{ width: `${pct(other)}%` }} />
      )}
    </div>
  );
};

// A per-shift line under the bar: tinted service icon + plain-language detail.
const SHIFT_ROW_STYLES = {
  lunch: { chip: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]', icon: <Sun className="h-3.5 w-3.5" /> },
  dinner: { chip: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]', icon: <Sunset className="h-3.5 w-3.5" /> },
  other: { chip: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]', icon: <HelpCircle className="h-3.5 w-3.5" /> },
} as const;

const ShiftRow: React.FC<{ shift: keyof typeof SHIFT_ROW_STYLES; children: React.ReactNode }> = ({ shift, children }) => {
  const s = SHIFT_ROW_STYLES[shift];
  return (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full ${s.chip}`}>
        {s.icon}
      </span>
      <span className="text-[13px] text-[var(--ds-text-secondary)] truncate">{children}</span>
    </div>
  );
};

// Shared shell for the four KPI cards. Renders as a button only when there's
// somewhere to navigate — keeps the non-interactive cards out of the tab order.
const KpiCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ title, icon, onClick, children }) => {
  const inner = (
    <>
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
          {icon}
        </span>
        <h3 className="text-[15px] sm:text-[16px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
          {title}
        </h3>
      </div>
      {children}
    </>
  );
  const shell =
    'bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-4';
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={`${shell} text-left hover:bg-[var(--ds-surface-row)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-canvas)]`}
    >
      {inner}
    </button>
  ) : (
    <div className={shell}>{inner}</div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms, banquetMenus, onNavigateToBanquets, onNavigateToReservations, onNavigateToInventario, onNavigateToShoppingList, onNavigateToAttivita, globalDate, globalShiftFilter: globalShiftFilterProp, onDateChange, onShiftFilterChange, onUpdateReservation, onOpenReservationInList, isInitialLoading = false }) => {
  const { user } = useAuth();
  const { items: shoppingItems, addItem: addShoppingItemCtx, toggleItem: toggleShoppingItemCtx } = useShopping();
  const { todos, addTodo: addTodoCtx, toggleTodo: toggleTodoCtx } = useTodos();
  const [loading, setLoading] = useState(false);

  // On desktop, date/shift are driven by App-level props (header controls).
  // On mobile, local state + inline controls.
  const [localDate, setLocalDate] = useState<Date>(globalDate ?? new Date());
  const [localShiftFilter, setLocalShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>(
    globalShiftFilterProp ?? (new Date().getHours() < 17 ? 'LUNCH' : 'DINNER')
  );

  useEffect(() => { if (globalDate) setLocalDate(globalDate); }, [globalDate]);
  useEffect(() => { if (globalShiftFilterProp) setLocalShiftFilter(globalShiftFilterProp); }, [globalShiftFilterProp]);

  const selectedDate = globalDate ?? localDate;
  const globalShiftFilter = globalShiftFilterProp ?? localShiftFilter;
  const setSelectedDate = (valOrFn: Date | ((prev: Date) => Date)) => {
    const next = typeof valOrFn === 'function' ? valOrFn(selectedDate) : valOrFn;
    setLocalDate(next);
    onDateChange?.(next);
  };
  const setGlobalShiftFilter = (v: 'ALL' | 'LUNCH' | 'DINNER') => {
    setLocalShiftFilter(v);
    onShiftFilterChange?.(v);
  };

  const [affluenceTab, setAffluenceTab] = useState<'ORARIO' | 'SETTIMANA'>('ORARIO');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

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

  // Get selected date string for filtering (defined early for use in shopping/todo functions)
  // Use local date components to avoid UTC timezone shift
  const formatLocalDate = (date: Date): string => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  const toDateOnly = (date: string): string => date.substring(0, 10);
  const selectedDateStr = formatLocalDate(selectedDate);
  const isToday = selectedDateStr === formatLocalDate(new Date());

  // Inline quick-add for shopping summary card
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<ShoppingCategory>('CUCINA');
  const [isAddingShoppingItem, setIsAddingShoppingItem] = useState(false);

  // Inline quick-add for attività summary card
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [isAddingTask, setIsAddingTask] = useState(false);

  // Reservation notes expand/collapse state
  const [expandedNoteIds, setExpandedNoteIds] = useState<Set<number>>(new Set());

  // Pending-reservation quick-action modal (Conferma / Rifiuta). Holds the
  // reservation being reviewed; null when the modal is closed.
  const [pendingModalRes, setPendingModalRes] = useState<Reservation | null>(null);
  const [pendingActionBusy, setPendingActionBusy] = useState<null | 'confirm' | 'decline'>(null);
  // Guard flag for the "the deposit hasn't been paid yet, confirm anyway?"
  // dialog. Flipped by handlePendingDecision when the first confirm click
  // hits a booking with an active-but-unpaid payment link; the second click
  // from the guard's Conferma comunque button bypasses it.
  const [unpaidDepositWarn, setUnpaidDepositWarn] = useState(false);

  // Low-stock inventory state
  const [lowStockItems, setLowStockItems] = useState<LowStockItem[]>([]);
  const [lowStockLoading, setLowStockLoading] = useState(true);

  // Staff Presence State
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [staffShifts, setStaffShifts] = useState<StaffShift[]>([]);
  const [staffTimeOffs, setStaffTimeOffs] = useState<StaffTimeOff[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);

  // Configurable allergen list (managed in Impostazioni → Opzioni
  // prenotazioni). Used to detect which words in a reservation's notes count
  // as intolerances for the "Intolleranze del giorno" widget. One-shot fetch;
  // empty on failure so the widget just shows no allergens rather than
  // pretending everything is an allergen.
  const [allergenPresets, setAllergenPresets] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await getReservationAllergenPresets();
        if (!cancelled) setAllergenPresets(rows.map(r => r.label));
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const fetchLowStock = useCallback(async () => {
    try {
      setLowStockLoading(true);
      const { items } = await getLowStockInventory();
      setLowStockItems(items);
    } catch (error) {
      console.error('Error fetching low stock:', error);
    } finally {
      setLowStockLoading(false);
    }
  }, []);

  const fetchStaff = useCallback(async (dateStr: string) => {
    try {
      setStaffLoading(true);
      const [members, shifts, timeOffs] = await Promise.all([
        staffApiService.getStaffMembers(),
        staffApiService.getShifts(dateStr),
        staffApiService.getTimeOffByDateRange(dateStr, dateStr)
      ]);
      setStaffMembers(members.filter(m => m.isActive));
      setStaffShifts(shifts);
      setStaffTimeOffs(timeOffs);
    } catch (error) {
      console.error('Error fetching staff data:', error);
    } finally {
      setStaffLoading(false);
    }
  }, []);

  const handleAddShoppingItem = async () => {
    const name = newItemName.trim();
    if (!name || isAddingShoppingItem) return;
    try {
      setIsAddingShoppingItem(true);
      await addShoppingItemCtx({ name, category: newItemCategory });
      setNewItemName('');
    } catch (error) {
      console.error('Error adding shopping item:', error);
    } finally {
      setIsAddingShoppingItem(false);
    }
  };

  const handleAddTask = async () => {
    const title = newTaskTitle.trim();
    if (!title || isAddingTask) return;
    try {
      setIsAddingTask(true);
      await addTodoCtx({
        title,
        priority: TodoPriority.MEDIUM,
        category: TodoCategory.GENERAL,
        dueDate: selectedDateStr,
      });
      setNewTaskTitle('');
    } catch (error) {
      console.error('Error adding task:', error);
    } finally {
      setIsAddingTask(false);
    }
  };

  // Group shopping items by category
  const shoppingByCategory = useMemo(() => {
    const grouped: Record<ShoppingCategory, ShoppingItem[]> = {
      'CUCINA': [],
      'BAR': [],
      'ALTRO': []
    };
    shoppingItems.forEach(item => {
      grouped[item.category].push(item);
    });
    return grouped;
  }, [shoppingItems]);

  const totalItems = shoppingItems.length;

  // Staff presence calculation:
  // - Explicit shift rows (with present=false) override everything else
  // - Time-off can be full-day (shift=null) or scoped to a single shift; a
  //   lunch-only Riposo must NOT remove the person from the dinner shift
  // - FISSO/STAGIONALE staff are implicitly present on both shifts during their
  //   hire period unless it's their weekly rest day
  const staffPresence = useMemo(() => {
    const dayOfWeek = new Date(`${selectedDateStr}T00:00:00`).getDay();
    const dayTimeOffs = staffTimeOffs.filter(
      t => toDateOnly(t.startDate) <= selectedDateStr && toDateOnly(t.endDate) >= selectedDateStr
    );

    // A time-off entry blocks a shift only when it's full-day (shift null/undefined)
    // or explicitly scoped to that same shift.
    const isOffForShift = (staffId: string, shift: Shift): boolean =>
      dayTimeOffs.some(t => t.staffId === staffId && (t.shift == null || t.shift === shift));

    const isPresent = (staff: StaffMember, shift: Shift): boolean => {
      const explicitShift = staffShifts.find(s =>
        s.staffId === staff.id && s.shift === shift && toDateOnly(s.date) === selectedDateStr
      );
      if (explicitShift) return explicitShift.present !== false;

      if (isOffForShift(staff.id, shift)) return false;

      if (staff.staffType !== StaffType.FISSO && staff.staffType !== StaffType.STAGIONALE) return false;
      if (staff.weeklyRestDay != null && staff.weeklyRestDay === dayOfWeek) return false;
      if (staff.hireDate && selectedDateStr < toDateOnly(staff.hireDate)) return false;
      if (staff.contractEndDate && selectedDateStr > toDateOnly(staff.contractEndDate)) return false;
      return true;
    };

    const getStaffForShift = (shift: Shift, category: StaffCategory) =>
      staffMembers.filter(m => m.category === category && isPresent(m, shift));

    return {
      lunch: {
        sala: getStaffForShift(Shift.LUNCH, StaffCategory.SALA),
        cucina: getStaffForShift(Shift.LUNCH, StaffCategory.CUCINA)
      },
      dinner: {
        sala: getStaffForShift(Shift.DINNER, StaffCategory.SALA),
        cucina: getStaffForShift(Shift.DINNER, StaffCategory.CUCINA)
      }
    };
  }, [staffMembers, staffShifts, staffTimeOffs, selectedDateStr]);

  // Which shift is currently "live" — drives the pulsing dot. Refreshes every minute.
  const [nowMinutes, setNowMinutes] = useState(() => {
    const n = new Date();
    return n.getHours() * 60 + n.getMinutes();
  });
  useEffect(() => {
    const id = setInterval(() => {
      const n = new Date();
      setNowMinutes(n.getHours() * 60 + n.getMinutes());
    }, 60_000);
    return () => clearInterval(id);
  }, []);
  const liveShift: 'lunch' | 'dinner' | null = !isToday
    ? null
    : nowMinutes >= 11 * 60 + 30 && nowMinutes < 15 * 60 + 30
      ? 'lunch'
      : nowMinutes >= 18 * 60 + 30 && nowMinutes < 23 * 60 + 30
        ? 'dinner'
        : null;

  const checkedItems = shoppingItems.filter(i => i.checked).length;

  useEffect(() => {
    fetchLowStock();
  }, [fetchLowStock]);

  // Fetch staff when selectedDate changes
  useEffect(() => {
    fetchStaff(selectedDateStr);
  }, [selectedDateStr, fetchStaff]);

  const handleToggleTodo = async (id: string) => {
    try {
      await toggleTodoCtx(id);
    } catch (error) {
      console.error('Error toggling todo:', error);
    }
  };

  const handleToggleShoppingItem = async (id: string) => {
    try {
      await toggleShoppingItemCtx(id);
    } catch (error) {
      console.error('Error toggling shopping item:', error);
    }
  };

  // Confirm/decline handlers for the pending quick-action modal. Uses the
  // App-level onUpdateReservation so state + toasts stay centralized.
  //
  // `forceConfirm` is set by the "Conferma comunque" button in the unpaid-
  // deposit guard so it bypasses the guard the second time around; the
  // first click routes into `setUnpaidDepositWarn(true)` instead of hitting
  // the API. Bookings without an active payment link (no deposit was ever
  // requested) or with a COMPLETED link skip the guard entirely.
  const handlePendingDecision = useCallback(async (
    action: 'confirm' | 'decline',
    opts?: { forceConfirm?: boolean },
  ) => {
    if (!pendingModalRes || !onUpdateReservation) return;
    if (action === 'confirm' && !opts?.forceConfirm && hasUnpaidDeposit(pendingModalRes)) {
      setUnpaidDepositWarn(true);
      return;
    }
    setPendingActionBusy(action);
    try {
      await onUpdateReservation({
        ...pendingModalRes,
        reservation_status: action === 'confirm' ? ReservationStatus.CONFIRMED : ReservationStatus.DECLINED,
      });
      setPendingModalRes(null);
      setUnpaidDepositWarn(false);
    } catch {
      // Toast already shown by handleUpdateReservation in App.
    } finally {
      setPendingActionBusy(null);
    }
  }, [pendingModalRes, onUpdateReservation]);

  // Inline confirm/decline from the "Da confermare" list. Mirrors the modal's
  // logic, except a booking with an unpaid deposit still routes INTO the modal
  // so the guard — and its "Conferma comunque" escape hatch — can't be skipped
  // by the shortcut.
  const [inlinePendingBusy, setInlinePendingBusy] = useState<number | null>(null);
  const handleInlinePending = useCallback(async (res: Reservation, action: 'confirm' | 'decline') => {
    if (!onUpdateReservation) return;
    if (action === 'confirm' && hasUnpaidDeposit(res)) {
      setPendingModalRes(res);
      setUnpaidDepositWarn(true);
      return;
    }
    setInlinePendingBusy(res.id);
    try {
      await onUpdateReservation({
        ...res,
        reservation_status: action === 'confirm' ? ReservationStatus.CONFIRMED : ReservationStatus.DECLINED,
      });
    } catch {
      // Toast already shown by handleUpdateReservation in App.
    } finally {
      setInlinePendingBusy(null);
    }
  }, [onUpdateReservation]);

  const todayStr = new Date().toISOString().split('T')[0];

  const todaysTodos = todos.filter(t => t.dueDate === todayStr && !t.completed);
  const overdueTodos = todos.filter(t => !t.completed && t.dueDate && t.dueDate < todayStr);
  const pendingCount = todos.filter(t => !t.completed).length;

  // Top urgent tasks for the summary card: overdue first (oldest due first),
  // then today, then upcoming by due date and priority.
  const urgentTasks = useMemo(() => {
    const pending = todos.filter(t => !t.completed);
    const score = (t: typeof pending[number]): number => {
      if (t.dueDate && t.dueDate < todayStr) return 0;
      if (t.dueDate === todayStr) return 1;
      if (t.dueDate && t.dueDate > todayStr) return 2;
      return 3;
    };
    return [...pending]
      .sort((a, b) => {
        const sa = score(a);
        const sb = score(b);
        if (sa !== sb) return sa - sb;
        if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) {
          return a.dueDate.localeCompare(b.dueDate);
        }
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      })
      .slice(0, 3);
  }, [todos, todayStr]);

  // Filter reservations for selected date (exclude cancelled bookings from KPIs/occupancy)
  const selectedDayReservations = useMemo(() => {
    return Array.isArray(reservations)
      ? reservations.filter(r =>
          getRomeDatePart(r.reservation_time) === selectedDateStr &&
          r.reservation_status !== ReservationStatus.CANCELLED &&
          r.reservation_status !== ReservationStatus.DECLINED
        )
      : [];
  }, [reservations, selectedDateStr]);

  // All PENDING reservations across the DB — the "Da confermare" card lists
  // them regardless of selectedDate because pending bookings need action
  // whether they're for today or next week. Sorted by reservation time
  // ascending so imminent ones surface first; past pending get pushed to
  // the bottom (usually empty since past PENDING is a data anomaly).
  const pendingReservations = useMemo((): Reservation[] => {
    if (!Array.isArray(reservations)) return [];
    return reservations
      .filter(r => r.reservation_status === ReservationStatus.PENDING)
      .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
  }, [reservations]);

  // Bread estimate for the selected day. Mirrors the server's daily bread
  // reminder formula (1 kg every 10 covers, min 1 kg) so the shopping list and
  // the 20:00 reminder always agree. Covers = non-cancelled reservations +
  // banquets scheduled for the day. Recomputes live as bookings change.
  const breadEstimate = useMemo(() => {
    const reservationGuests = selectedDayReservations.reduce((acc, r) => acc + (r.guests || 0), 0);
    const banquetGuests = Array.isArray(banquetMenus)
      ? banquetMenus
          .filter(m => m.event_date === selectedDateStr)
          .reduce((acc, m) => acc + (m.guests || 0), 0)
      : 0;
    const coperti = reservationGuests + banquetGuests;
    return { coperti, kg: Math.max(1, Math.ceil(coperti / 10)) };
  }, [selectedDayReservations, banquetMenus, selectedDateStr]);


  // Calculate stats for selected day (skip tables in closed rooms)
  const openRoomIds = useMemo(
    () => new Set((Array.isArray(rooms) ? rooms : []).filter(r => !r.is_closed).map(r => r.id)),
    [rooms]
  );
  const openTables = useMemo(
    () => (Array.isArray(tables) ? tables.filter(t => openRoomIds.has(t.room_id)) : []),
    [tables, openRoomIds]
  );
  const openTableIds = useMemo(() => new Set(openTables.map(t => t.id)), [openTables]);
  const totalTables = openTables.length;

  // --- "Adesso in sala" — live service pulse for the hero tile ---
  // Same time-derivation engine as the floor map: seated (ARRIVED/DEPARTING),
  // arriving (confirmed, due within the T−20′ window), departing (past the
  // expected duration or flagged by staff). Null on non-today dates: the
  // hero describes RIGHT NOW or it doesn't exist.
  const nowTick = useNow(60_000);
  const liveService = useMemo(() => {
    if (!isToday) return null;
    let seatedGuests = 0;
    let departingCount = 0;
    const seatedTableIds = new Set<number>();
    const arriving: Reservation[] = [];
    for (const r of selectedDayReservations) {
      const st = getTimedReservationState(r, nowTick);
      if (st === 'arrived' || st === 'departing') {
        seatedGuests += r.guests || 0;
        if (r.table_id && openTableIds.has(r.table_id)) seatedTableIds.add(r.table_id);
        if (st === 'departing') departingCount++;
      } else if (st === 'arriving') {
        arriving.push(r);
      }
    }
    arriving.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    return {
      seatedGuests,
      seatedTables: seatedTableIds.size,
      departingCount,
      arriving,
      freeTables: Math.max(0, totalTables - seatedTableIds.size),
    };
  }, [isToday, selectedDayReservations, nowTick, openTableIds, totalTables]);

  // Banchetti scheduled for the selected day, split the same way the other KPI
  // cards are. `shift` is optional on a banquet and the form lets you save
  // without picking one, so unassigned events get their own bucket rather than
  // being quietly dropped — otherwise the rows wouldn't add up to the headline.
  const dayBanquets = useMemo(
    () => (Array.isArray(banquetMenus) ? banquetMenus.filter(m => m.event_date === selectedDateStr) : []),
    [banquetMenus, selectedDateStr]
  );
  const banquetsToday = dayBanquets.length;
  const sumGuests = (list: BanquetMenu[]) => list.reduce((acc, m) => acc + (m.guests || 0), 0);
  const lunchBanquets = dayBanquets.filter(m => m.shift === Shift.LUNCH);
  const dinnerBanquets = dayBanquets.filter(m => m.shift === Shift.DINNER);
  const unassignedBanquets = dayBanquets.filter(m => m.shift !== Shift.LUNCH && m.shift !== Shift.DINNER);

  // Reservations by shift for selected day (only those on open-room tables for KPI math)
  const lunchReservations = selectedDayReservations.filter(r => r.shift === Shift.LUNCH);
  const dinnerReservations = selectedDayReservations.filter(r => r.shift === Shift.DINNER);

  // Subset that excludes reservations on tables in closed rooms (unassigned reservations are kept).
  const isOnOpenRoom = (tableId: number | null | undefined): boolean =>
    tableId == null || openTableIds.has(tableId);
  const lunchReservationsOpen = lunchReservations.filter(r => isOnOpenRoom(r.table_id));
  const dinnerReservationsOpen = dinnerReservations.filter(r => isOnOpenRoom(r.table_id));

  const lunchTableIds = new Set(
    lunchReservations.map(r => r.table_id).filter((id): id is number => id != null && openTableIds.has(id))
  );
  const dinnerTableIds = new Set(
    dinnerReservations.map(r => r.table_id).filter((id): id is number => id != null && openTableIds.has(id))
  );

  // Per-shift KPI stats (guests + tables, expected vs arrived)
  const lunchExpectedGuests = lunchReservations.reduce((acc, r) => acc + r.guests, 0);
  const dinnerExpectedGuests = dinnerReservations.reduce((acc, r) => acc + r.guests, 0);
  // "Arrivati" includes DEPARTING — the party is still in house until DEPARTED.
  const lunchArrivedRes = lunchReservations.filter(r => isSeated(r));
  const dinnerArrivedRes = dinnerReservations.filter(r => isSeated(r));
  const lunchArrivedGuests = lunchArrivedRes.reduce((acc, r) => acc + r.guests, 0);
  const dinnerArrivedGuests = dinnerArrivedRes.reduce((acc, r) => acc + r.guests, 0);
  const lunchArrivedTableIds = new Set(lunchArrivedRes.map(r => r.table_id).filter(Boolean));
  const dinnerArrivedTableIds = new Set(dinnerArrivedRes.map(r => r.table_id).filter(Boolean));

  const lunchOccupancy = totalTables > 0 ? Math.round((lunchTableIds.size / totalTables) * 100) : 0;
  const dinnerOccupancy = totalTables > 0 ? Math.round((dinnerTableIds.size / totalTables) * 100) : 0;

  // Rows for the arrivals timeline — the selected day, narrowed by the global
  // meal filter so it agrees with every other card on the page.
  const timelineReservations = useMemo(() => selectedDayReservations.filter(r => {
    if (globalShiftFilter === 'LUNCH') return r.shift === Shift.LUNCH;
    if (globalShiftFilter === 'DINNER') return r.shift === Shift.DINNER;
    return true;
  }), [selectedDayReservations, globalShiftFilter]);

  // Distinct tables in use across the day. A table booked at BOTH lunch and
  // dinner counts once here but twice in the per-shift rows, so the headline
  // can legitimately read lower than the two rows added together.
  const bookedTableIds = new Set([...lunchTableIds, ...dinnerTableIds]);

  // Pending bookings for the SELECTED DAY only — the "Da confermare" section
  // further down deliberately spans the whole DB, but the KPI card describes
  // the day you're looking at.
  const selectedDayPendingCount = selectedDayReservations.filter(
    r => r.reservation_status === ReservationStatus.PENDING
  ).length;

  // Reservations with notes/allergens for selected day, follows the global meal filter.
  const reservationNotes = useMemo(() => {
    const items = selectedDayReservations
      .filter(r => {
        if (!r.notes || r.notes.trim().length === 0) return false;
        if (globalShiftFilter === 'LUNCH') return r.shift === Shift.LUNCH;
        if (globalShiftFilter === 'DINNER') return r.shift === Shift.DINNER;
        return true; // ALL
      })
      .map(r => {
        const table = r.table_id ? tables.find(t => t.id === r.table_id) : undefined;
        const room = table ? rooms.find(rm => rm.id === table.room_id) : undefined;
        const noteLower = (r.notes || '').toLowerCase();
        const allergens = allergenPresets.filter(a => noteLower.includes(a.toLowerCase()));
        return { reservation: r, table, room, allergens };
      });
    items.sort((a, b) => a.reservation.reservation_time.localeCompare(b.reservation.reservation_time));
    return items;
  }, [selectedDayReservations, tables, rooms, globalShiftFilter, allergenPresets]);

  // Time slot and room affluence data
  const timeSlotAffluence = useMemo(() => {
    const LUNCH_SLOTS = ['13:00', '13:30', '14:00'];
    const DINNER_SLOTS = ['19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

    // Read wall-clock time in Europe/Rome. The naive regex used previously
    // extracted the raw UTC hour from the ISO string, so after the timezone
    // refactor a booking at 20:00 Rome (18:00 UTC in CEST) resolved to
    // "18:00" and never matched a DINNER_SLOT — deflating every room's
    // affluenza count.
    const getTimeFromReservation = (r: Reservation) => getRomeTimePart(r.reservation_time);

    // Bucket a HH:MM string to the nearest earlier canonical slot. Anything
    // before the first slot bunches into the first slot; anything after the
    // last stays on the last. Without this, off-slot bookings (e.g. 21:15,
    // typically imported / imported from ElevenLabs) would silently drop off
    // the grid — leaving the room total lower than the true guest count.
    const slotMinutes = (hhmm: string): number => {
        const m = hhmm.match(/^(\d{2}):(\d{2})$/);
        if (!m) return -1;
        return Number(m[1]) * 60 + Number(m[2]);
    };
    const bucketToSlot = (hhmm: string, slots: string[]): string | null => {
        const t = slotMinutes(hhmm);
        if (t < 0) return null;
        let chosen: string | null = null;
        for (const s of slots) {
            const sm = slotMinutes(s);
            if (sm <= t) chosen = s;
            else break;
        }
        // Time falls before the first slot → clip into the first slot so we
        // don't lose the reservation on the row entirely.
        return chosen ?? slots[0] ?? null;
    };

    // Get room for a reservation based on table_id
    const getRoomForReservation = (r: Reservation) => {
      if (!r.table_id) return null;
      const table = tables.find(t => t.id === r.table_id);
      return table ? table.room_id : null;
    };

    // Room-based affluence with time slots (skip closed rooms)
    const roomTimeSlots = rooms.filter(r => !r.is_closed).map(room => {
      const roomTables = tables.filter(t => t.room_id === room.id);
      const maxCapacity = roomTables.reduce((acc, t) => acc + t.seats, 0);

      // Lunch slots for this room — off-slot bookings get bucketed to the
      // nearest earlier canonical slot so nobody vanishes from the row.
      const lunchSlots = LUNCH_SLOTS.map(slot => {
        const reservationsAtSlot = lunchReservations.filter(r =>
          getRoomForReservation(r) === room.id
          && bucketToSlot(getTimeFromReservation(r), LUNCH_SLOTS) === slot
        );
        const guests = reservationsAtSlot.reduce((acc, r) => acc + r.guests, 0);
        return { time: slot, guests, percentage: maxCapacity > 0 ? Math.round((guests / maxCapacity) * 100) : 0 };
      });

      // Dinner slots for this room
      const dinnerSlots = DINNER_SLOTS.map(slot => {
        const reservationsAtSlot = dinnerReservations.filter(r =>
          getRoomForReservation(r) === room.id
          && bucketToSlot(getTimeFromReservation(r), DINNER_SLOTS) === slot
        );
        const guests = reservationsAtSlot.reduce((acc, r) => acc + r.guests, 0);
        return { time: slot, guests, percentage: maxCapacity > 0 ? Math.round((guests / maxCapacity) * 100) : 0 };
      });

      const totalLunchGuests = lunchSlots.reduce((acc, s) => acc + s.guests, 0);
      const totalDinnerGuests = dinnerSlots.reduce((acc, s) => acc + s.guests, 0);

      return {
        roomId: room.id,
        roomName: room.name,
        maxCapacity,
        lunchSlots,
        dinnerSlots,
        totalLunchGuests,
        totalDinnerGuests,
        lunchPercentage: maxCapacity > 0 ? Math.round((totalLunchGuests / maxCapacity) * 100) : 0,
        dinnerPercentage: maxCapacity > 0 ? Math.round((totalDinnerGuests / maxCapacity) * 100) : 0
      };
    });

    // Total capacity for percentage calculation (skip closed rooms)
    const totalCapacity = rooms.filter(r => !r.is_closed).reduce((acc, room) => {
      const roomTables = tables.filter(t => t.room_id === room.id);
      return acc + roomTables.reduce((sum, t) => sum + t.seats, 0);
    }, 0);

    return { roomTimeSlots, totalCapacity, LUNCH_SLOTS, DINNER_SLOTS };
  }, [lunchReservations, dinnerReservations, rooms, tables]);

  // Calculate weekly chart data from real reservations (based on selected date's week)
  const weeklyChartData = useMemo(() => {
    // Get start of selected date's week (Monday)
    const dayOfWeek = selectedDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);

    const days = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
    const data = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const dateStr = formatLocalDate(date);

      let dayReservations = Array.isArray(reservations)
        ? reservations.filter(r => getRomeDatePart(r.reservation_time) === dateStr)
        : [];

      // Filter by shift if not ALL
      if (globalShiftFilter !== 'ALL') {
        dayReservations = dayReservations.filter(r => r.shift === globalShiftFilter);
      }

      const dayGuests = dayReservations.reduce((acc, r) => acc + r.guests, 0);

      data.push({
        name: days[i],
        date: date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }),
        guests: dayGuests
      });
    }

    return data;
  }, [reservations, globalShiftFilter, selectedDate]);

  // Get week range for display (based on selected date's week)
  const weekRange = useMemo(() => {
    const dayOfWeek = selectedDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return `${monday.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} - ${sunday.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
  }, [selectedDate]);

  // Service window: lunch 11:00–15:30, dinner 18:00–23:30. Lives at component
  // scope because the chip that renders it now sits in the live deck, while the
  // greeting block that used to own it is higher up the tree.
  const serviceState = useMemo(() => {
    const minutes = currentTime.getHours() * 60 + currentTime.getMinutes();
    if (minutes >= 11 * 60 && minutes < 15 * 60 + 30) return { text: 'Servizio pranzo · In corso', kind: 'lunch' as const };
    if (minutes >= 18 * 60 && minutes < 23 * 60 + 30) return { text: 'Servizio cena · In corso', kind: 'dinner' as const };
    return { text: 'Fuori servizio', kind: 'off' as const };
  }, [currentTime]);

  // One 16px gutter everywhere, matching the m-4 on the header and sidebar
  // cards — so the bento column lines up with the chrome instead of sitting
  // 20px inside it (it was 32px before). No breakpoint ramp: the gutter is a constant of the shell,
  // not something that should grow with the viewport. pt-0 because the header's
  // own bottom margin already supplies the 12px above.
  return (
    <div className="px-4 pt-0 pb-4 space-y-4">
      {/* Header with Calendar Navigation */}
      {(() => {
        const hour = currentTime.getHours();
        const greeting =
          hour >= 5 && hour < 12 ? 'Buongiorno'
          : hour >= 12 && hour < 18 ? 'Buon pomeriggio'
          : hour >= 18 && hour < 23 ? 'Buonasera'
          : 'Buonanotte';
        const roleLabels: Record<string, string> = {
          OWNER: 'Proprietario',
          GENERAL_MANAGER: 'General Manager',
          MANAGER: 'Manager',
          RECEPTION: 'Reception',
          WAITER: 'Cameriere',
          KITCHEN: 'Cucina',
        };
        const emailPrefix = user?.email?.split('@')[0];
        const capitalizedEmail = emailPrefix
          ? emailPrefix.charAt(0).toUpperCase() + emailPrefix.slice(1)
          : null;
        const firstName =
          user?.full_name?.trim().split(' ')[0]
          || (user?.role ? roleLabels[user.role] : null)
          || capitalizedEmail
          || 'Utente';
        // The greeting is the page title, not a bento box — it gets more air
        // than the uniform 16px gutter so it doesn't read as crammed between
        // the header card and the live deck.
        return (
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 py-2 md:py-4">
            <div className="flex items-center justify-between w-full gap-4">
              <div className="min-w-0">
                {/* The service status used to sit here as an eyebrow; it now
                    rides in the "Adesso in sala" header, where the rest of the
                    right-now state already lives. */}
                <h1 className="text-[22px] sm:text-[28px] lg:text-[34px] font-semibold text-[var(--ds-text-primary)] tracking-[-0.02em] leading-[1.1]">
                  {greeting}, {firstName}.
                </h1>
              </div>
              {todaysTodos.length > 0 && (
                <button
                  onClick={() => onNavigateToAttivita?.()}
                  className="inline-flex items-center gap-2 md:gap-2.5 pl-4 md:pl-5 pr-1.5 h-11 rounded-full bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] transition-colors flex-shrink-0 self-center"
                  aria-label={`${todaysTodos.length} attività di oggi`}
                  title="Attività di oggi"
                >
                  {/* Mobile shows the icon; md+ shows the full label. */}
                  <ListTodo className="h-5 w-5 md:hidden text-[var(--ds-text-secondary)]" aria-hidden />
                  <span className="hidden md:inline text-[15px] font-semibold tracking-[-0.01em] whitespace-nowrap">Attività di oggi</span>
                  {/* KNOWN DEVIATION (see spec §3.3): white on amber is 3.25:1. At 16px
                      regular this is below WCAG's large-text threshold, so it does not meet
                      the 4.5:1 AA floor. Deliberate product decision. Switching the
                      foreground to var(--ds-pending-fg) would restore 5.80:1 at any size. */}
                  <span className="inline-flex items-center justify-center min-w-[32px] h-8 px-2 rounded-full text-[16px] font-normal leading-none tabular-nums bg-[var(--ds-pending-solid)] text-[#ffffff]">
                    {todaysTodos.length}
                  </span>
                </button>
              )}
            </div>

            {/* Date navigator + time chip + shift filter — mobile only (desktop uses header) */}
            <div className="flex flex-wrap items-start gap-2 self-stretch w-full md:hidden bg-[var(--ds-surface)] rounded-[24px] shadow-[var(--ds-shadow-card)] p-3">
              <DateNavigator
                value={selectedDateStr}
                onChange={(dateOnly) => {
                  const [y, m, d] = dateOnly.split('-').map(Number);
                  if (y && m && d) setSelectedDate(new Date(y, m - 1, d));
                }}
                className="flex-1 min-w-0"
              />

              {/* Separate time chip — always shows live current time */}
              <div className="flex items-center gap-1.5 bg-[var(--ds-surface-row)] rounded-full px-4 h-10 flex-shrink-0">
                <Clock className="h-4 w-4 text-[var(--ds-text-secondary)] flex-shrink-0" />
                <span className="tabular-nums font-semibold text-[15px] tracking-[-0.01em] text-[var(--ds-text-primary)] whitespace-nowrap">
                  {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* Global meal filter — drives KPI cards, Stato Tavoli, Affluenza, Note, Personale */}
              <div className="basis-full md:basis-auto flex items-center justify-center bg-[var(--ds-surface-row)] rounded-full p-1 gap-0.5">
                {([
                  { key: 'LUNCH', label: 'Pranzo', icon: <Sun className="h-4 w-4" /> },
                  { key: 'DINNER', label: 'Cena', icon: <Sunset className="h-4 w-4" /> },
                  { key: 'ALL', label: 'Tutti', icon: null as React.ReactNode },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setGlobalShiftFilter(opt.key)}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 h-9 rounded-full text-[15px] font-medium transition-colors flex-1 md:flex-none ${
                      globalShiftFilter === opt.key
                        ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                        : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                    }`}
                    aria-pressed={globalShiftFilter === opt.key}
                  >
                    {opt.icon}
                    {opt.label}
                  </button>
                ))}
              </div>

            </div>
          </div>
        );
      })()}

      {/* "Adesso in sala" — the live command deck. It's the only tile that
          describes RIGHT NOW, so it has to outrank the rest of the bento; the
          animated hairline frame (.ds-live-frame) does that job now that the
          surface is white. Counts come from the shared time-derivation engine,
          so this always agrees with the floor map and the Reception rail. */}
      {liveService && (
        <div className="ds-live-frame shadow-[var(--ds-shadow-card)]">
          <div className="ds-live-card overflow-hidden" style={{ animation: 'tileIn .35s ease-out both' }}>
            <div className="px-4 sm:px-5 pt-4 pb-3 flex items-center gap-2.5 min-w-0">
              <PulseDot dotClass="bg-[var(--ds-seated-solid)]" pulse sizeClass="h-2 w-2" />
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)] truncate">
                Adesso in sala
              </h2>
              {/* Service hue follows the DS convention: pranzo amber, cena
                  indigo, fuori servizio neutral. */}
              <span
                className={`inline-flex flex-shrink-0 items-center px-2.5 h-7 rounded-full text-[13px] font-medium whitespace-nowrap ${
                  serviceState.kind === 'lunch'
                    ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                    : serviceState.kind === 'dinner'
                    ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
                    : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
                }`}
              >
                {serviceState.text}
              </span>
            </div>

            <div className="px-4 sm:px-5 pb-4 grid grid-cols-2 lg:grid-cols-4 gap-2.5">
              <LiveTile
                label="In sala"
                value={liveService.seatedGuests}
                sub={`${liveService.seatedTables} ${liveService.seatedTables === 1 ? 'tavolo' : 'tavoli'}`}
              />
              <LiveTile
                tone="arriving"
                label="In arrivo"
                value={liveService.arriving.length}
                sub="entro 20 min"
                dot={<PulseDot dotClass="bg-[var(--ds-arriving-solid)]" pulse={liveService.arriving.length > 0} />}
              />
              <LiveTile
                label="In uscita"
                value={liveService.departingCount}
                sub="turnover in vista"
              />
              <LiveTile
                label="Tavoli liberi"
                value={`${liveService.freeTables}/${totalTables}`}
                sub="tavoli disponibili"
              />
            </div>
          </div>
        </div>
      )}

      {/* KPI Cards — Ospiti / Tavoli / Prenotazioni & Banchetti, follow the global meal filter */}
      {isInitialLoading && reservations.length === 0 ? (
        <SkeletonKpiRow count={4} className="!grid-cols-1 sm:!grid-cols-2 lg:!grid-cols-4 !gap-3 sm:!gap-4 lg:!gap-5" />
      ) : (() => {
        const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
        const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';

        // Only the active shifts feed the headline and the bar, so each card
        // always describes exactly what the filter claims it does.
        const pick = (l: number, d: number) => (showLunch ? l : 0) + (showDinner ? d : 0);
        const guestsTotal = pick(lunchExpectedGuests, dinnerExpectedGuests);
        const resTotal = pick(lunchReservations.length, dinnerReservations.length);

        // Tavoli fills against room capacity rather than against itself, so the
        // empty remainder means something. Segments are rescaled to the DISTINCT
        // table count — otherwise a table booked at both services would be drawn
        // twice and the bar would overrun the headline.
        const tablesShown = showLunch && showDinner
          ? bookedTableIds.size
          : (showLunch ? lunchTableIds.size : dinnerTableIds.size);
        const segSum = pick(lunchTableIds.size, dinnerTableIds.size);
        const segScale = segSum > 0 ? tablesShown / segSum : 0;

        // Unassigned-shift banquets belong to the whole day, so they're only in
        // scope when no shift filter is applied — that keeps the rows summing to
        // the headline in every filter state.
        const banquetsShown = showLunch && showDinner
          ? dayBanquets
          : (showLunch ? lunchBanquets : dinnerBanquets);

        const headline = 'tabular text-[30px] sm:text-[34px] leading-none font-bold tracking-[-0.02em] text-[var(--ds-text-primary)]';
        const qualifier = 'text-[14px] text-[var(--ds-text-muted)]';

        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Ospiti */}
            <KpiCard title="Ospiti" icon={<UsersIcon className="h-4 w-4" />}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={headline}>{guestsTotal}</span>
                <span className={qualifier}>attesi oggi</span>
              </div>
              <ShiftBar
                lunch={showLunch ? lunchExpectedGuests : 0}
                dinner={showDinner ? dinnerExpectedGuests : 0}
                total={guestsTotal}
              />
              <div className="flex flex-col gap-2.5 mt-auto">
                {showLunch && <ShiftRow shift="lunch">{lunchExpectedGuests} attesi · {lunchArrivedGuests} arrivati</ShiftRow>}
                {showDinner && <ShiftRow shift="dinner">{dinnerExpectedGuests} attesi · {dinnerArrivedGuests} arrivati</ShiftRow>}
              </div>
            </KpiCard>

            {/* Tavoli */}
            <KpiCard title="Tavoli" icon={<LayoutGrid className="h-4 w-4" />}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={headline}>{tablesShown}</span>
                <span className={qualifier}>prenotati su {totalTables}</span>
              </div>
              <ShiftBar
                lunch={showLunch ? lunchTableIds.size * segScale : 0}
                dinner={showDinner ? dinnerTableIds.size * segScale : 0}
                total={totalTables}
              />
              <div className="flex flex-col gap-2.5 mt-auto">
                {showLunch && <ShiftRow shift="lunch">{lunchTableIds.size} tavoli · {lunchArrivedTableIds.size} seduti</ShiftRow>}
                {showDinner && <ShiftRow shift="dinner">{dinnerTableIds.size} tavoli · {dinnerArrivedTableIds.size} seduti</ShiftRow>}
              </div>
            </KpiCard>

            {/* Prenotazioni */}
            <KpiCard title="Prenotazioni" icon={<Calendar className="h-4 w-4" />} onClick={onNavigateToReservations}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className={headline}>{resTotal}</span>
                <span className={qualifier}>
                  {selectedDayPendingCount > 0 ? `${selectedDayPendingCount} da confermare` : 'oggi'}
                </span>
              </div>
              <ShiftBar
                lunch={showLunch ? lunchReservations.length : 0}
                dinner={showDinner ? dinnerReservations.length : 0}
                total={resTotal}
              />
              <div className="flex flex-col gap-2.5 mt-auto">
                {showLunch && <ShiftRow shift="lunch">{lunchReservations.length} a pranzo</ShiftRow>}
                {showDinner && <ShiftRow shift="dinner">{dinnerReservations.length} a cena</ShiftRow>}
              </div>
            </KpiCard>

            {/* Banchetti */}
            {/* Stessa icona della voce "Menu & Banchetti" nella barra laterale:
                la scheda porta lì, e due glifi diversi per la stessa
                destinazione la fanno sembrare un'altra cosa. */}
            <KpiCard title="Banchetti" icon={<UtensilsCrossed className="h-4 w-4" />} onClick={onNavigateToBanquets}>
              {banquetsShown.length > 0 ? (
                <>
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={headline}>{banquetsShown.length}</span>
                    <span className={qualifier}>
                      {banquetsShown.length === 1 ? 'evento oggi' : 'eventi oggi'}
                    </span>
                  </div>
                  <ShiftBar
                    lunch={showLunch ? lunchBanquets.length : 0}
                    dinner={showDinner ? dinnerBanquets.length : 0}
                    other={showLunch && showDinner ? unassignedBanquets.length : 0}
                    total={banquetsShown.length}
                  />
                  <div className="flex flex-col gap-2.5 mt-auto">
                    {showLunch && lunchBanquets.length > 0 && (
                      <ShiftRow shift="lunch">
                        {lunchBanquets.length} {lunchBanquets.length === 1 ? 'evento' : 'eventi'} · {sumGuests(lunchBanquets)} ospiti
                      </ShiftRow>
                    )}
                    {showDinner && dinnerBanquets.length > 0 && (
                      <ShiftRow shift="dinner">
                        {dinnerBanquets.length} {dinnerBanquets.length === 1 ? 'evento' : 'eventi'} · {sumGuests(dinnerBanquets)} ospiti
                      </ShiftRow>
                    )}
                    {showLunch && showDinner && unassignedBanquets.length > 0 && (
                      <ShiftRow shift="other">
                        {unassignedBanquets.length} senza turno · {sumGuests(unassignedBanquets)} ospiti
                      </ShiftRow>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex-1 min-h-[92px] rounded-[16px] bg-[var(--ds-surface-row)] flex items-end p-4">
                    <span className="block h-1 w-6 rounded-full bg-[var(--ds-border-strong)]" />
                  </div>
                  <span className="text-[14px] text-[var(--ds-text-muted)]">
                    {banquetsToday > 0 ? 'Nessun banchetto in questo turno' : 'Nessun banchetto oggi'}
                  </span>
                </>
              )}
            </KpiCard>
          </div>
        );
      })()}

      {/* Row 1: Timeline arrivi — the reception's working view — with the two
          action lists (Da confermare, Note & allergeni) stacked beside it. */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 xl:h-[440px]">
        <div className="xl:col-span-2 min-w-0 flex min-h-0">
          <ArrivalsTimeline
            reservations={timelineReservations}
            tables={tables}
            rooms={rooms}
            banquetMenus={banquetMenus}
            selectedDateStr={selectedDateStr}
            nowTick={nowTick}
            onUpdateReservation={onUpdateReservation}
            onConfirmPending={setPendingModalRes}
            onNavigateToReservations={onNavigateToReservations}
          />
        </div>
        <div className="flex flex-col gap-4 min-w-0 min-h-0">
      {/* Da confermare — pending reservations across the whole DB (not just
          today), ordered by reservation time ascending. Confirm/decline act in
          place; a booking with an unpaid deposit still routes into the modal so
          the guard holds. Full editing lives in Prenotazioni. */}
      <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 xl:flex-1 xl:min-h-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Da confermare</h2>
          {pendingReservations.length > 0 && (
            <span className="inline-flex items-center justify-center min-w-[28px] h-7 px-2 rounded-full text-[14px] font-semibold tabular-nums bg-[var(--ds-pending-solid)] text-[#ffffff]">
              {pendingReservations.length}
            </span>
          )}
        </div>
        {isInitialLoading && reservations.length === 0 ? (
          <div className="space-y-2">
            <SkeletonReservationCard variant="wide" />
            <SkeletonReservationCard variant="narrow" />
          </div>
        ) : pendingReservations.length === 0 ? (
          <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center">
            <CheckCircle2 className="h-7 w-7 text-[var(--ds-seated-solid)] mx-auto mb-2" aria-hidden />
            <p className="text-[14px] text-[var(--ds-text-muted)]">Nessuna prenotazione da confermare</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[340px] xl:max-h-none xl:flex-1 xl:min-h-0 overflow-y-auto scrollbar-hide -mx-1 px-1">
            {pendingReservations.map(res => {
              const source = res.source || ReservationSource.MANUAL;
              const channelLabel = source === ReservationSource.WHATSAPP ? 'WhatsApp'
                : source === ReservationSource.GOOGLE ? 'Google'
                : source === ReservationSource.VOICE ? 'Agente vocale'
                : 'Telefono';
              // reservation_time is timestamptz; read it in Europe/Rome or a
              // 20:30 booking renders as its UTC hour.
              const timeLabel = getRomeTimePart(res.reservation_time);
              // The list spans the whole DB, not just today — without the
              // requested date, a 21:00 booking for next month reads as
              // tonight's. "oggi"/"domani" keep the common cases short.
              const resDateStr = getRomeDatePart(res.reservation_time);
              const todayStr = getRomeDatePart(new Date());
              const tomorrowStr = getRomeDatePart(new Date(Date.now() + 24 * 60 * 60 * 1000));
              const dateLabel = resDateStr === todayStr ? 'oggi'
                : resDateStr === tomorrowStr ? 'domani'
                : new Date(`${resDateStr}T12:00:00`).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
              const busy = inlinePendingBusy === res.id;
              return (
                <div key={res.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center gap-3 min-w-0">
                  <button
                    type="button"
                    onClick={() => setPendingModalRes(res)}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-lg"
                  >
                    <p className="text-[15px] font-semibold text-[var(--ds-text-primary)] truncate">
                      {toTitleCase(res.customer_name) || '—'}
                    </p>
                    <p
                      className="text-[13px] text-[var(--ds-text-muted)] truncate"
                      title={`${dateLabel} · ${timeLabel} · ${res.guests || 0} coperti · ${channelLabel}`}
                    >
                      {dateLabel} · {timeLabel} · {res.guests || 0} coperti · {channelLabel}
                    </p>
                  </button>
                  <PaymentBadge reservation={res} />
                  <button
                    type="button"
                    disabled={busy || !onUpdateReservation}
                    onClick={() => handleInlinePending(res, 'decline')}
                    className="flex-shrink-0 h-9 w-9 inline-flex items-center justify-center rounded-full bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)] hover:brightness-95 transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                    aria-label={`Rifiuta la prenotazione di ${toTitleCase(res.customer_name)}`}
                  >
                    <X className="h-4 w-4" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={busy || !onUpdateReservation}
                    onClick={() => handleInlinePending(res, 'confirm')}
                    className="flex-shrink-0 h-9 px-3.5 rounded-full text-[14px] font-semibold bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] transition-all disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    {busy ? '…' : 'Conferma'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* Note & Allergeni */}
      <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 xl:flex-1 xl:min-h-0">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            Note &amp; allergeni
          </h2>
          {reservationNotes.length > 0 && (
            <span className="text-[14px] tabular-nums text-[var(--ds-text-muted)]">{reservationNotes.length}</span>
          )}
        </div>
        {reservationNotes.length === 0 ? (
          <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center">
            <StickyNote className="h-7 w-7 text-[var(--ds-text-subtle)] mx-auto mb-2" aria-hidden />
            <p className="text-[14px] text-[var(--ds-text-muted)]">
              Nessuna nota {globalShiftFilter === 'LUNCH' ? 'per il pranzo' : globalShiftFilter === 'DINNER' ? 'per la cena' : 'per oggi'}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2 max-h-[340px] xl:max-h-none xl:flex-1 xl:min-h-0 overflow-y-auto scrollbar-hide -mx-1 px-1">
            {reservationNotes.map(({ reservation, table, room, allergens }) => {
              const time = getRomeTimePart(reservation.reservation_time);
              const isExpanded = expandedNoteIds.has(reservation.id);
              const noteText = stripDietaryNote(reservation.notes);
              const isTruncatable = noteText.length > 80;
              // "T31" when seated, "senza tavolo" when not — the unassigned
              // case is the one the kitchen needs to chase, so it says so in
              // words rather than hiding behind a dash.
              const tableLabel = table
                ? `T${table.name.replace(/[^0-9]/g, '') || table.name}`
                : 'senza tavolo';
              const meta = [tableLabel, time || '—', room?.name].filter(Boolean).join(' · ');
              return (
                <div key={reservation.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 min-w-0">
                  <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                    <span className={`text-[13px] ${table ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-pending-text)] font-medium'}`}>
                      {meta}
                    </span>
                    <span className="text-[15px] font-semibold text-[var(--ds-text-primary)] truncate">
                      {toTitleCase(reservation.customer_name)}
                    </span>
                  </div>

                  <DietaryChips notes={reservation.notes} presets={allergenPresets} size="sm" className="mt-2" />

                  {noteText && (
                    <div className="mt-1.5">
                      <p className="text-[13px] text-[var(--ds-text-secondary)] leading-relaxed whitespace-pre-wrap break-words">
                        {isTruncatable && !isExpanded ? noteText.slice(0, 80) + '…' : noteText}
                      </p>
                      {isTruncatable && (
                        <button
                          onClick={() => setExpandedNoteIds(prev => {
                            const next = new Set(prev);
                            if (next.has(reservation.id)) next.delete(reservation.id);
                            else next.add(reservation.id);
                            return next;
                          })}
                          className="text-[13px] font-medium text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] mt-1 transition-colors"
                        >
                          {isExpanded ? 'Mostra meno' : 'Mostra tutto'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
        </div>
      </div>

      {/* Row 2: Stato tavoli, then Affluenza — full width each. The heatmap
          needs the horizontal room to breathe; at half width its cells were
          scrolling almost immediately. */}
      <div className="flex flex-col gap-4">
      {/* Stato tavoli — one row per room, both services side by side, so a
          room's whole day reads in a single glance. Closed rooms stay hidden,
          as they always have. */}
      {(() => {
        const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
        const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';

        const roomStats = rooms.filter(room => !room.is_closed).map(room => {
          const roomTableIds = new Set(tables.filter(t => t.room_id === room.id).map(t => t.id));
          const seatedIn = (list: Reservation[]) =>
            new Set(list.filter(r => r.table_id && roomTableIds.has(r.table_id)).map(r => r.table_id!)).size;
          return {
            id: room.id,
            name: room.name,
            total: roomTableIds.size,
            lunch: seatedIn(lunchReservations),
            dinner: seatedIn(dinnerReservations),
          };
        }).sort((a, b) => (b.lunch + b.dinner) - (a.lunch + a.dinner));

        // Tables busy at least once in the visible services.
        const busyIds = new Set<number>([
          ...(showLunch ? lunchTableIds : []),
          ...(showDinner ? dinnerTableIds : []),
        ]);
        const dayPct = totalTables > 0 ? Math.round((busyIds.size / totalTables) * 100) : 0;

        const miniBar = (value: number, total: number, shift: 'lunch' | 'dinner') => (
          <div className="flex items-center gap-2 min-w-0">
            <span className={`text-[13px] w-14 flex-shrink-0 ${shift === 'lunch' ? 'text-[var(--ds-pending-text)]' : 'text-[var(--ds-arriving-text)]'}`}>
              {shift === 'lunch' ? 'pranzo' : 'cena'}
            </span>
            <div className="flex-1 min-w-0 h-2 rounded-full bg-[var(--ds-surface)] overflow-hidden">
              <div
                className={`h-full rounded-full ${shift === 'lunch' ? 'bg-[var(--ds-pending-solid)]' : 'bg-[var(--ds-arriving-solid)]'}`}
                style={{ width: `${total > 0 ? Math.min(100, (value / total) * 100) : 0}%` }}
              />
            </div>
          </div>
        );

        return (
          <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-4 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
                <LayoutGrid className="h-4 w-4" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Stato tavoli</h2>
                <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                  {busyIds.size} tavoli su {totalTables} impegnati
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-baseline gap-2">
                <span className="tabular text-[30px] sm:text-[34px] leading-none font-bold tracking-[-0.02em] text-[var(--ds-text-primary)]">{dayPct}%</span>
                <span className="text-[14px] text-[var(--ds-text-muted)]">occupazione giornaliera</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {showLunch && (
                  <span className="inline-flex items-center gap-1.5 pl-2 pr-3 h-8 rounded-full text-[13px] font-medium bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]">
                    <Sun className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                    Pranzo {lunchOccupancy}% · {lunchTableIds.size} tavoli
                  </span>
                )}
                {showDinner && (
                  <span className="inline-flex items-center gap-1.5 pl-2 pr-3 h-8 rounded-full text-[13px] font-medium bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                    <Sunset className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                    Cena {dinnerOccupancy}% · {dinnerTableIds.size} tavoli
                  </span>
                )}
              </div>
            </div>

            <div>
              <ShiftBar
                lunch={showLunch ? lunchTableIds.size : 0}
                dinner={showDinner ? dinnerTableIds.size : 0}
                total={totalTables}
              />
              {/* Named anchors, not just a percentage — "Pieno" means something
                  to a host mid-service in a way that "50%" does not. */}
              <div className="flex justify-between mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                <span>Calmo</span>
                <span>Pieno</span>
                <span>Sold out</span>
              </div>
            </div>

            <div className="flex flex-col gap-2 max-h-[340px] overflow-y-auto scrollbar-hide -mx-1 px-1">
              {roomStats.map(room => {
                const Icon = getRoomIcon(room.name);
                return (
                  <div key={room.id} className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center gap-3 min-w-0">
                    <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-[15px] font-semibold text-[var(--ds-text-primary)] w-20 sm:w-24 flex-shrink-0 truncate">
                      {room.name}
                    </span>
                    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                      {showLunch && miniBar(room.lunch, room.total, 'lunch')}
                      {showDinner && miniBar(room.dinner, room.total, 'dinner')}
                    </div>
                    <div className="flex-shrink-0 flex flex-col gap-1.5 items-end w-12 text-[14px] font-semibold tabular-nums">
                      {showLunch && (
                        <span className={room.lunch > 0 ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-subtle)]'}>
                          {room.lunch}/{room.total}
                        </span>
                      )}
                      {showDinner && (
                        <span className={room.dinner > 0 ? 'text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-subtle)]'}>
                          {room.dinner}/{room.total}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
      {/* Affluenza — coperti per fascia oraria, grouped by service. One aligned
          time axis per service instead of one per room, so the same 21:00 sits
          in the same column for every sala. */}
      <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-6 flex flex-col gap-5 min-w-0">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[10px] bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]">
              <BarChart3 className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Affluenza</h2>
              <p className="text-[13px] text-[var(--ds-text-muted)] truncate">
                Coperti per fascia · {globalShiftFilter === 'LUNCH' ? 'pranzo' : globalShiftFilter === 'DINNER' ? 'cena' : 'entrambi i servizi'}
              </p>
            </div>
          </div>
          <div className="inline-flex p-1 rounded-full bg-[var(--ds-surface-row)] flex-shrink-0">
            {([
              { key: 'ORARIO', label: 'Orario' },
              { key: 'SETTIMANA', label: 'Settimana' },
            ] as const).map(t => (
              <button
                key={t.key}
                onClick={() => setAffluenceTab(t.key)}
                className={`px-3.5 h-8 text-[14px] font-medium rounded-full whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                  affluenceTab === t.key
                    ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                    : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {affluenceTab === 'ORARIO' && (() => {
          const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
          const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';

          const renderService = (shift: 'lunch' | 'dinner') => {
            const isLunch = shift === 'lunch';
            const tone = isLunch
              ? { wash: 'bg-[var(--ds-pending-tint)]', text: 'text-[var(--ds-pending-text)]', solid: 'var(--ds-pending-solid)', icon: <Sun className="h-3.5 w-3.5" />, label: 'Pranzo' }
              : { wash: 'bg-[var(--ds-arriving-tint)]', text: 'text-[var(--ds-arriving-text)]', solid: 'var(--ds-arriving-solid)', icon: <Sunset className="h-3.5 w-3.5" />, label: 'Cena' };

            const all = timeSlotAffluence.roomTimeSlots;
            if (all.length === 0) return null;
            const slotsOf = (r: typeof all[number]) => isLunch ? r.lunchSlots : r.dinnerSlots;
            const totalOf = (r: typeof all[number]) => isLunch ? r.totalLunchGuests : r.totalDinnerGuests;
            const pctOf = (r: typeof all[number]) => isLunch ? r.lunchPercentage : r.dinnerPercentage;

            const active = all.filter(r => totalOf(r) > 0);
            const idle = all.filter(r => totalOf(r) === 0);
            const slots = slotsOf(all[0]) || [];
            if (slots.length === 0) return null;

            const serviceTotal = all.reduce((acc, r) => acc + totalOf(r), 0);
            const range = `${slots[0].time} – ${slots[slots.length - 1].time}`;
            // Peak = the busiest slot across every room in this service.
            const perSlot = slots.map((_, i) => all.reduce((acc, r) => acc + (slotsOf(r)[i]?.guests || 0), 0));
            const peakIdx = perSlot.indexOf(Math.max(...perSlot));
            const peak = perSlot[peakIdx] > 0 ? slots[peakIdx].time : null;

            // Intensity ramp painted as an overlay rather than a colour scale,
            // so the whole ramp derives from the one token per service.
            const intensity = (pct: number) => pct === 0 ? 0 : pct < 25 ? 0.18 : pct < 50 ? 0.38 : pct < 75 ? 0.62 : 0.92;
            // Amber stays dark-on-light at full strength (spec §3.3); indigo
            // is dark enough to flip to white.
            const cellText = (pct: number) =>
              pct === 0 ? 'text-[var(--ds-text-subtle)]'
              : intensity(pct) >= 0.62 && !isLunch ? 'text-white'
              : tone.text;

            return (
              <div key={shift} className={`rounded-[16px] p-4 sm:p-5 flex flex-col gap-4 min-w-0 ${tone.wash}`}>
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <span className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] ${tone.text}`}>
                    {tone.icon}
                  </span>
                  <h3 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{tone.label}</h3>
                  <span className={`text-[13px] ${tone.text}`}>
                    {range} · {serviceTotal} coperti{peak ? ` · picco alle ${peak}` : ''}
                  </span>
                </div>

                <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
                  <div style={{ minWidth: `${168 + slots.length * 64 + 92}px` }} className="flex flex-col gap-2.5">
                    <div className="flex gap-2 items-center">
                      <div className="w-[168px] flex-shrink-0" />
                      {slots.map((s, i) => (
                        <span
                          key={s.time}
                          className={`flex-1 min-w-[56px] text-center text-[12px] tabular-nums ${i === peakIdx && peak ? `font-semibold ${tone.text}` : 'text-[var(--ds-text-muted)]'}`}
                        >
                          {s.time}
                        </span>
                      ))}
                      <div className="w-[92px] flex-shrink-0" />
                    </div>

                    {active.map(room => {
                      const Icon = getRoomIcon(room.roomName);
                      return (
                        <div key={room.roomId} className="flex gap-2 items-center">
                          <div className="w-[168px] flex-shrink-0 flex items-center gap-2 min-w-0">
                            <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)]">
                              <Icon className="h-3.5 w-3.5" />
                            </span>
                            <div className="min-w-0">
                              <div className="text-[14px] font-semibold text-[var(--ds-text-primary)] truncate">{room.roomName}</div>
                              <div className="text-[12px] text-[var(--ds-text-muted)] truncate">max {room.maxCapacity} coperti</div>
                            </div>
                          </div>
                          {slotsOf(room).map(slot => (
                            <div
                              key={slot.time}
                              className="relative flex-1 min-w-[56px] h-11 rounded-[12px] bg-[var(--ds-surface)] overflow-hidden flex items-center justify-center"
                              title={`${room.roomName} · ${slot.time} · ${slot.guests} coperti (${slot.percentage}%)`}
                            >
                              {slot.percentage > 0 && (
                                <span className="absolute inset-0" style={{ backgroundColor: tone.solid, opacity: intensity(slot.percentage) }} aria-hidden />
                              )}
                              <span className={`relative tabular-nums text-[13px] font-semibold ${cellText(slot.percentage)}`}>
                                {slot.guests}
                              </span>
                            </div>
                          ))}
                          <span className="w-[92px] flex-shrink-0 text-right text-[13px] tabular-nums text-[var(--ds-text-secondary)]">
                            {totalOf(room)}/{room.maxCapacity} <span className="font-semibold text-[var(--ds-text-primary)]">{pctOf(room)}%</span>
                          </span>
                        </div>
                      );
                    })}

                    {idle.length > 0 && (
                      <div className="flex gap-2 items-center">
                        <div className="w-[168px] flex-shrink-0 text-[14px] font-medium text-[var(--ds-text-muted)] truncate">
                          {active.length === 0 ? 'Tutte le sale' : 'Altre sale'}
                        </div>
                        <div className="flex-1 h-11 rounded-[12px] bg-[var(--ds-surface)]/60 flex items-center justify-center text-[13px] text-[var(--ds-text-muted)] px-3 text-center">
                          Nessuna prenotazione a {isLunch ? 'pranzo' : 'cena'}
                        </div>
                        <span className="w-[92px] flex-shrink-0 text-right text-[13px] text-[var(--ds-text-muted)]">—</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          };

          const lunchGuests = lunchReservations.reduce((acc, r) => acc + r.guests, 0);
          const dinnerGuests = dinnerReservations.reduce((acc, r) => acc + r.guests, 0);
          const shownGuests = (showLunch ? lunchGuests : 0) + (showDinner ? dinnerGuests : 0);
          const shownCapacity = timeSlotAffluence.totalCapacity * ((showLunch ? 1 : 0) + (showDinner ? 1 : 0));

          return (
            <>
              <div className="flex flex-col gap-3">
                {showLunch && renderService('lunch')}
                {showDinner && renderService('dinner')}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2">
                {showLunch && (
                  <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center justify-between gap-2 min-w-0">
                    <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ds-text-primary)] min-w-0">
                      <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]">
                        <Sun className="h-3.5 w-3.5" />
                      </span>
                      <span className="truncate">Totale pranzo</span>
                    </span>
                    <span className="tabular text-[17px] font-bold text-[var(--ds-text-primary)] flex-shrink-0">
                      {lunchGuests}<span className="text-[14px] font-normal text-[var(--ds-text-muted)]">/{timeSlotAffluence.totalCapacity}</span>
                    </span>
                  </div>
                )}
                {showDinner && (
                  <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center justify-between gap-2 min-w-0">
                    <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ds-text-primary)] min-w-0">
                      <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                        <Sunset className="h-3.5 w-3.5" />
                      </span>
                      <span className="truncate">Totale cena</span>
                    </span>
                    <span className="tabular text-[17px] font-bold text-[var(--ds-text-primary)] flex-shrink-0">
                      {dinnerGuests}<span className="text-[14px] font-normal text-[var(--ds-text-muted)]">/{timeSlotAffluence.totalCapacity}</span>
                    </span>
                  </div>
                )}
                <div className="rounded-[16px] bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] p-3 flex items-center justify-between gap-2 min-w-0">
                  <span className="text-[14px] font-medium truncate">Totale giornata</span>
                  <span className="tabular text-[17px] font-bold flex-shrink-0">
                    {shownGuests}<span className="text-[14px] font-normal opacity-60">/{shownCapacity}</span>
                  </span>
                </div>
              </div>
            </>
          );
        })()}

        {affluenceTab === 'SETTIMANA' && (
          <>
            <p className="tabular text-xs text-[var(--color-fg-muted)] mb-3">{weekRange}</p>
            <div className="h-64 sm:h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={weeklyChartData} margin={{ top: 5, right: 5, left: -10, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="var(--color-chart-grid)" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} />
                  <YAxis domain={[0, 'auto']} axisLine={false} tickLine={false} stroke="var(--color-chart-axis)" tick={{ fill: 'var(--color-chart-axis)', fontSize: 11 }} width={30} />
                  <Tooltip
                    cursor={{ fill: 'var(--color-surface-hover)' }}
                    contentStyle={{ background: 'var(--ds-surface)', border: '1px solid var(--ds-border)', borderRadius: '12px', fontSize: '13px' }}
                    labelStyle={{ color: 'var(--color-fg-muted)' }}
                    formatter={(value: number) => [`${value} ospiti`, 'Ospiti']}
                    labelFormatter={(label, payload) => {
                      if (payload && payload[0]) {
                        return `${label} (${payload[0].payload.date})`;
                      }
                      return label;
                    }}
                  />
                  <Bar
                    dataKey="guests"
                    fill={globalShiftFilter === 'LUNCH' ? '#f59e0b' : globalShiftFilter === 'DINNER' ? '#3b82f6' : 'var(--color-chart-1)'}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Totals — same tiles as Orario, so toggling tabs doesn't change
                the shape of the card's footer. */}
            <div className={`grid gap-2 ${globalShiftFilter === 'ALL' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
              {(globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH') && (
                <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center justify-between gap-2 min-w-0">
                  <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ds-text-primary)] min-w-0">
                    <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]">
                      <Sun className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate">Totale pranzo (settimana)</span>
                  </span>
                  <span className="tabular text-[17px] font-bold text-[var(--ds-text-primary)] flex-shrink-0">
                    {weeklyChartData.reduce((acc, d) => acc + d.guests, 0)}
                  </span>
                </div>
              )}
              {(globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER') && (
                <div className="rounded-[16px] bg-[var(--ds-surface-row)] p-3 flex items-center justify-between gap-2 min-w-0">
                  <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--ds-text-primary)] min-w-0">
                    <span className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]">
                      <Sunset className="h-3.5 w-3.5" />
                    </span>
                    <span className="truncate">Totale cena (settimana)</span>
                  </span>
                  <span className="tabular text-[17px] font-bold text-[var(--ds-text-primary)] flex-shrink-0">
                    {weeklyChartData.reduce((acc, d) => acc + d.guests, 0)}
                  </span>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      </div>


      {/* Row 3: Attività + Spesa + Sotto scorta */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Attività */}
        <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 h-[440px]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Attività</h2>
              <p className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">
                {overdueTodos.length > 0 && (
                  <span className="text-[var(--ds-critical-text)] font-semibold">{overdueTodos.length} scadute</span>
                )}
                {overdueTodos.length > 0 && todaysTodos.length > 0 && <span> · </span>}
                {todaysTodos.length > 0 && <span>{todaysTodos.length} oggi</span>}
                {overdueTodos.length === 0 && todaysTodos.length === 0 && <span>{pendingCount} da fare</span>}
              </p>
            </div>
            {onNavigateToAttivita && (
              <button
                onClick={onNavigateToAttivita}
                className="flex-shrink-0 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-full px-1"
              >
                Apri <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          {overdueTodos.length > 0 && (
            <div className="rounded-[16px] bg-[var(--ds-critical-tint)] px-3 py-2.5 flex items-center gap-2.5 min-w-0">
              <AlertTriangle className="h-4 w-4 text-[var(--ds-critical-text)] flex-shrink-0" aria-hidden />
              <p className="text-[13px] text-[var(--ds-critical-text)] truncate flex-1 min-w-0">
                {overdueTodos[0].title}
              </p>
              {overdueTodos.length > 1 && (
                <span className="flex-shrink-0 text-[13px] font-semibold tabular-nums text-[var(--ds-critical-text)]">
                  +{overdueTodos.length - 1}
                </span>
              )}
            </div>
          )}

          <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-y-auto scrollbar-hide -mx-1 px-1">
            {urgentTasks.length === 0 ? (
              <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center">
                <CheckCircle2 className="h-7 w-7 text-[var(--ds-seated-solid)] mx-auto mb-2" aria-hidden />
                <p className="text-[14px] text-[var(--ds-text-muted)]">Tutto sotto controllo</p>
              </div>
            ) : (
              urgentTasks.map(todo => {
                const isOverdue = !!todo.dueDate && todo.dueDate < todayStr;
                const isToday = todo.dueDate === todayStr;
                return (
                  <div key={todo.id} className="flex items-center gap-2.5 rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5 min-w-0">
                    <button
                      onClick={() => handleToggleTodo(todo.id)}
                      className="flex-shrink-0 w-5 h-5 rounded-full border-2 border-[var(--ds-border-strong)] hover:border-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      aria-label={`Completa: ${todo.title}`}
                    />
                    <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${CATEGORY_DOT_COLORS[todo.category]}`} aria-hidden />
                    <span className="flex-1 min-w-0 text-[15px] text-[var(--ds-text-primary)] truncate">{todo.title}</span>
                    {todo.priority !== TodoPriority.LOW && (
                      <Flag className={`h-3.5 w-3.5 flex-shrink-0 ${PRIORITY_COLORS[todo.priority]}`} aria-hidden />
                    )}
                    {todo.dueDate && (
                      <span className={`text-[13px] font-semibold tabular-nums flex-shrink-0 ${
                        isOverdue ? 'text-[var(--ds-critical-text)]'
                        : isToday ? 'text-[var(--ds-text-muted)] font-normal'
                        : 'text-[var(--ds-pending-text)]'
                      }`}>
                        {isToday ? 'oggi' : new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={newTaskTitle}
              onChange={e => setNewTaskTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTask(); } }}
              placeholder="Nuova attività…"
              className="flex-1 min-w-0 h-11 px-3 rounded-full bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            />
            <button
              type="button"
              onClick={handleAddTask}
              disabled={!newTaskTitle.trim() || isAddingTask}
              aria-label="Aggiungi attività"
              className="flex-shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {isAddingTask ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Spesa */}
        <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 h-[440px]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Spesa</h2>
              <p className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">{checkedItems} di {totalItems} completati</p>
            </div>
            {onNavigateToShoppingList && (
              <button
                onClick={onNavigateToShoppingList}
                className="flex-shrink-0 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-full px-1"
              >
                Apri <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            )}
          </div>

          {/* Pane del giorno — the estimate, and a one-tap way to act on it */}
          <div className="rounded-[16px] bg-[var(--ds-pending-tint)] p-3 flex items-center gap-3 min-w-0">
            <span className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-surface)] text-[var(--ds-pending-text)]">
              <Wheat className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold text-[var(--ds-text-primary)] truncate">
                {breadEstimate.coperti > 0 ? `Pane ${breadEstimate.kg} kg` : 'Pane — nessuna prenotazione'}
              </p>
              <p className="text-[13px] text-[var(--ds-pending-text)] truncate">
                {breadEstimate.coperti > 0
                  ? `${breadEstimate.coperti} coperti · 1 kg ogni 10`
                  : 'Si aggiorna in base alle prenotazioni'}
              </p>
            </div>
          </div>

          <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-y-auto scrollbar-hide -mx-1 px-1">
            {totalItems === 0 ? (
              <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center">
                <ShoppingCart className="h-7 w-7 text-[var(--ds-text-subtle)] mx-auto mb-2" aria-hidden />
                <p className="text-[14px] text-[var(--ds-text-muted)]">Lista vuota</p>
              </div>
            ) : (
              <>
                {(['CUCINA', 'BAR', 'ALTRO'] as ShoppingCategory[]).map(cat => {
                  const items = shoppingByCategory[cat];
                  if (items.length === 0) return null;
                  const remaining = items.filter(i => !i.checked).length;
                  return (
                    <div key={cat} className="flex items-center gap-2 rounded-[14px] bg-[var(--ds-surface-row)] px-3 py-2.5 min-w-0">
                      <span className="inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full text-[13px] font-medium bg-[var(--ds-surface)] text-[var(--ds-text-primary)] flex-shrink-0">
                        {SHOPPING_CATEGORY_LABELS[cat]}
                      </span>
                      <span className="text-[13px] tabular-nums text-[var(--ds-text-muted)] ml-auto flex-shrink-0">
                        {remaining}/{items.length} da prendere
                      </span>
                    </div>
                  );
                })}
                {shoppingItems.filter(i => !i.checked).slice(-3).reverse().map(item => (
                  <div key={item.id} className="flex items-center gap-2.5 px-3 py-1.5 min-w-0">
                    <button
                      onClick={() => handleToggleShoppingItem(item.id)}
                      className="flex-shrink-0 w-5 h-5 rounded-[6px] border-2 border-[var(--ds-border-strong)] hover:border-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                      aria-label={`Completa: ${item.name}`}
                    />
                    <span className="flex-1 min-w-0 text-[15px] text-[var(--ds-text-primary)] truncate">{item.name}</span>
                  </div>
                ))}
              </>
            )}
          </div>

          <div className="flex items-center gap-2 pt-1">
            <input
              type="text"
              value={newItemName}
              onChange={e => setNewItemName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddShoppingItem(); } }}
              placeholder="Aggiungi prodotto…"
              className="flex-1 min-w-0 h-11 px-3 rounded-full bg-[var(--ds-surface-row)] text-[15px] text-[var(--ds-text-primary)] placeholder:text-[var(--ds-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            />
            <select
              value={newItemCategory}
              onChange={e => setNewItemCategory(e.target.value as ShoppingCategory)}
              // ds-select disegna la nostra freccia e le riserva lo spazio:
              // quella nativa restava incollata al bordo della pillola.
              className="flex-shrink-0 h-11 pl-3 pr-0 rounded-full bg-[var(--ds-surface-row)] text-[14px] font-medium text-[var(--ds-text-secondary)] cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ds-select ds-select-sm"
              aria-label="Categoria"
            >
              <option value="CUCINA">Cucina</option>
              <option value="BAR">Bar</option>
              <option value="ALTRO">Altro</option>
            </select>
            <button
              type="button"
              onClick={handleAddShoppingItem}
              disabled={!newItemName.trim() || isAddingShoppingItem}
              aria-label="Aggiungi prodotto"
              className="flex-shrink-0 inline-flex items-center justify-center w-11 h-11 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {isAddingShoppingItem ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Sotto scorta — sorted by criticality: empty first, then closest to
            the threshold. Rows go red at zero, amber while merely low, which is
            what signals the ordering now that the caption is gone. */}
        <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-3 min-w-0 h-[440px]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">Sotto scorta</h2>
              <p className="text-[13px] text-[var(--ds-text-muted)] mt-0.5">
                {lowStockLoading
                  ? 'Caricamento…'
                  : `${lowStockItems.length} ${lowStockItems.length === 1 ? 'articolo' : 'articoli'} sotto soglia${
                      lowStockItems.filter(i => i.total_quantity <= 0).length > 0
                        ? ` · ${lowStockItems.filter(i => i.total_quantity <= 0).length} esauriti`
                        : ''
                    }`}
              </p>
            </div>
            <button
              type="button"
              onClick={onNavigateToInventario}
              className="flex-shrink-0 inline-flex items-center gap-1.5 text-[14px] font-medium text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-full px-1"
              title="Vai all'inventario"
            >
              Apri <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </div>

          <div className="flex-1 min-h-0 flex flex-col gap-1.5 overflow-y-auto scrollbar-hide -mx-1 px-1">
            {lowStockLoading ? (
              <div className="py-8 text-center">
                <CookingPotLoader label="Caricamento..." size={40} />
              </div>
            ) : lowStockItems.length === 0 ? (
              <div className="rounded-[16px] bg-[var(--ds-surface-row)] px-4 py-8 text-center">
                <Package className="h-7 w-7 text-[var(--ds-text-subtle)] mx-auto mb-2" aria-hidden />
                <p className="text-[14px] text-[var(--ds-text-muted)]">Tutte le scorte sono in regola</p>
              </div>
            ) : (
              [...lowStockItems]
                .sort((a, b) => a.total_quantity - b.total_quantity)
                .map(item => {
                  const isOut = item.total_quantity <= 0;
                  const tone = isOut
                    ? { wash: 'bg-[var(--ds-critical-tint)]', text: 'text-[var(--ds-critical-text)]' }
                    : { wash: 'bg-[var(--ds-pending-tint)]', text: 'text-[var(--ds-pending-text)]' };
                  return (
                    <div key={item.id} className={`flex items-center gap-3 rounded-[14px] px-3 py-2.5 min-w-0 ${tone.wash}`}>
                      <div className="flex-1 min-w-0">
                        <div className="text-[15px] font-semibold text-[var(--ds-text-primary)] truncate">{item.name}</div>
                        {(item.category_name || item.area) && (
                          <div className={`text-[13px] truncate ${tone.text}`}>
                            {[item.area, item.category_name].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className={`text-[20px] font-bold tabular-nums leading-none ${tone.text}`}>
                          {Number.isInteger(item.total_quantity) ? item.total_quantity : item.total_quantity.toFixed(1)}
                        </div>
                        {item.unit && (
                          <div className="text-[12px] text-[var(--ds-text-muted)] mt-0.5">{item.unit}</div>
                        )}
                      </div>
                    </div>
                  );
                })
            )}
          </div>

        </div>
      </div>

      {/* Row 4: Personale in servizio — follows the page's shift filter, like
          every other card. "Tutti" shows both services side by side; picking
          one shows just that roster. The live service is marked with a pulse so
          it still stands out when both are on screen. */}
      {(() => {
        const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
        const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';
        const shownTotal =
          (showLunch ? staffPresence.lunch.sala.length + staffPresence.lunch.cucina.length : 0) +
          (showDinner ? staffPresence.dinner.sala.length + staffPresence.dinner.cucina.length : 0);

        const renderService = (shiftKey: 'lunch' | 'dinner') => {
          const isLunch = shiftKey === 'lunch';
          const data = staffPresence[shiftKey];
          const total = data.sala.length + data.cucina.length;
          const isLive = liveShift === shiftKey;
          const tone = isLunch
            ? { wash: 'bg-[var(--ds-pending-tint)]', text: 'text-[var(--ds-pending-text)]', icon: <Sun className="h-3.5 w-3.5" />, label: 'Pranzo', end: '15:30' }
            : { wash: 'bg-[var(--ds-arriving-tint)]', text: 'text-[var(--ds-arriving-text)]', icon: <Sunset className="h-3.5 w-3.5" />, label: 'Cena', end: '23:30' };
          const groups = [
            { label: 'Sala', people: data.sala },
            { label: 'Cucina', people: data.cucina },
          ].filter(g => g.people.length > 0);

          return (
            <div key={shiftKey} className={`rounded-[16px] p-4 flex flex-col gap-3 min-w-0 ${tone.wash}`}>
              <div className="flex items-center gap-2 flex-wrap min-w-0">
                <span className={`inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] ${tone.text}`}>
                  {tone.icon}
                </span>
                <h3 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">{tone.label}</h3>
                {isLive && (
                  <span className="inline-flex items-center gap-1.5 pl-1.5 pr-2.5 h-6 rounded-full bg-[var(--ds-surface)] text-[12px] font-medium text-[var(--ds-seated-text)]">
                    <PulseDot dotClass="bg-[var(--ds-seated-solid)]" pulse />
                    in corso
                  </span>
                )}
                <span className={`text-[13px] ${tone.text}`}>
                  {total} in turno{isLive ? ` · fine ${tone.end}` : ''}
                </span>
              </div>

              {groups.length === 0 ? (
                <p className="text-[14px] text-[var(--ds-text-muted)] py-2">Nessuno in turno</p>
              ) : (
                // Sotto lg i due servizi si impilano e una brigata da diciotto
                // spingeva il resto della dashboard fuori schermo. Il tetto sta
                // sul singolo servizio, non sulla card: con il filtro su
                // "Tutti" le intestazioni di Pranzo e Cena restano entrambe
                // visibili e scorre solo l'elenco sotto. Sopra lg vanno
                // affiancati e ci stanno, quindi il tetto sparisce.
                <div className="flex flex-col gap-2 max-h-[340px] lg:max-h-none overflow-y-auto scrollbar-hide -mx-1 px-1">
                  {groups.map(g => (
                    <div key={g.label} className="flex items-start gap-3 min-w-0">
                      <span className="text-[13px] text-[var(--ds-text-muted)] w-20 flex-shrink-0 pt-2">
                        {g.label} · {g.people.length}
                      </span>
                      <div className="flex flex-wrap gap-2 min-w-0">
                        {g.people.map(s => {
                          const initials = `${(s.name || '').charAt(0)}${(s.surname || '').charAt(0)}`.toUpperCase();
                          return (
                            <span
                              key={s.id}
                              className="inline-flex items-center gap-2 pl-1.5 pr-3 h-9 rounded-full bg-[var(--ds-surface)] text-[14px] text-[var(--ds-text-primary)]"
                              title={s.role ? `${toTitleCase(s.name)} ${toTitleCase(s.surname)} · ${s.role}` : `${toTitleCase(s.name)} ${toTitleCase(s.surname)}`}
                            >
                              <span className="flex-shrink-0 h-6 w-6 rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] flex items-center justify-center text-[11px] font-semibold">
                                {initials}
                              </span>
                              <span className="truncate max-w-[10rem]">{toTitleCase(s.name)}</span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        };

        return (
          <div className="bg-[var(--ds-surface)] rounded-[20px] shadow-[var(--ds-shadow-card)] p-4 sm:p-5 flex flex-col gap-4 min-w-0">
            <div className="flex items-baseline gap-2.5 flex-wrap">
              <h2 className="text-[15px] sm:text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
                Personale in servizio
              </h2>
              <span className="text-[13px] text-[var(--ds-text-muted)]">{shownTotal} in turno</span>
            </div>

            {staffLoading ? (
              <div className="flex items-center justify-center py-8">
                <CookingPotLoader label="Caricamento..." size={40} />
              </div>
            ) : (
              <div className={`grid gap-3 ${showLunch && showDinner ? 'grid-cols-1 lg:grid-cols-2' : 'grid-cols-1'}`}>
                {showLunch && renderService('lunch')}
                {showDinner && renderService('dinner')}
              </div>
            )}
          </div>
        );
      })()}

      {/* Pending reservation quick-action modal. Rendered via Portal so it
          escapes the Dashboard's stacking context. Handles the two common
          actions inline (Conferma / Rifiuta); for anything more we hand off
          to the full editor in Prenotazioni via onOpenReservationInList. */}
      {pendingModalRes && createPortal(
        (() => {
          const res = pendingModalRes;
          const source = res.source || ReservationSource.MANUAL;
          const channel = source === ReservationSource.WHATSAPP
            ? { Icon: MessageCircle, label: 'WhatsApp' }
            : source === ReservationSource.GOOGLE
            ? { Icon: Globe, label: 'Web' }
            : source === ReservationSource.VOICE
            ? { Icon: Mic, label: 'Agente vocale' }
            : { Icon: PhoneIcon, label: 'Telefono' };
          const resDate = new Date(res.reservation_time);
          const dateLabel = !Number.isNaN(resDate.getTime())
            ? resDate.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' })
            : '';
          const timeLabel = getRomeTimePart(res.reservation_time);
          const closeDisabled = pendingActionBusy !== null;
          const closeModal = () => {
            if (closeDisabled) return;
            setPendingModalRes(null);
            setUnpaidDepositWarn(false);
          };
          return (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center px-4"
              onClick={closeModal}
              role="dialog"
              aria-modal="true"
              aria-label="Prenotazione da confermare"
            >
              <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
              <div
                className="relative w-full max-w-md bg-[var(--color-surface)] rounded-2xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] overflow-hidden"
                onClick={e => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-line)]">
                  <div className="flex items-center gap-2 min-w-0">
                    <HelpCircle className="h-4 w-4 text-amber-500 flex-shrink-0" />
                    <h3 className="text-sm font-semibold text-[var(--color-fg)] truncate">Prenotazione da confermare</h3>
                    <PaymentBadge reservation={res} />
                  </div>
                  <button
                    type="button"
                    onClick={closeModal}
                    disabled={closeDisabled}
                    className="p-1 rounded-md text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
                    aria-label="Chiudi"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="px-5 py-4 space-y-3">
                  <div>
                    <p className="text-base font-semibold text-[var(--color-fg)]">{toTitleCase(res.customer_name) || '—'}</p>
                    <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 capitalize">{dateLabel} · {timeLabel}</p>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-[13px]">
                    <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                      <UsersIcon className="h-4 w-4 flex-shrink-0" />
                      <span>{res.guests || 0} {res.guests === 1 ? 'ospite' : 'ospiti'}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                      <channel.Icon className="h-4 w-4 flex-shrink-0" />
                      <span>{channel.label}</span>
                    </div>
                    {res.phone && (
                      <div className="flex items-center gap-2 text-[var(--color-fg-muted)] col-span-2">
                        <PhoneIcon className="h-4 w-4 flex-shrink-0" />
                        <a href={`tel:${res.phone}`} className="hover:underline tabular truncate">{res.phone}</a>
                      </div>
                    )}
                  </div>

                  {res.notes && (
                    <div className="border-t border-[var(--color-line)] pt-3">
                      <div className="text-[11px] uppercase tracking-wide text-[var(--color-fg-subtle)] font-semibold mb-1">Note</div>
                      <p className="text-[13px] text-[var(--color-fg)] whitespace-pre-wrap break-words">{res.notes}</p>
                    </div>
                  )}
                </div>

                {unpaidDepositWarn ? (
                  // Guard step: staff clicked Conferma but the deposit link
                  // is still unpaid. Force an explicit "Conferma comunque"
                  // to avoid the classic "confirmed by mistake without
                  // getting paid" mishap on large groups.
                  <div className="px-5 py-3 border-t border-amber-200 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10">
                    <div className="flex items-start gap-2 mb-3">
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                      <p className="text-[13px] text-amber-900 dark:text-amber-100 leading-snug">
                        Il pagamento della caparra ancora non è avvenuto. Vuoi confermare la prenotazione lo stesso?
                      </p>
                    </div>
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setUnpaidDepositWarn(false)}
                        disabled={closeDisabled}
                        className="inline-flex items-center h-9 px-3 rounded-lg text-[13px] font-medium border border-[var(--color-line)] text-[var(--color-fg)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] disabled:opacity-50 transition-colors"
                      >
                        Annulla
                      </button>
                      <button
                        type="button"
                        onClick={() => handlePendingDecision('confirm', { forceConfirm: true })}
                        disabled={closeDisabled || !onUpdateReservation}
                        className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 transition-colors"
                      >
                        {pendingActionBusy === 'confirm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                        Conferma comunque
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="px-5 py-3 border-t border-[var(--color-line)] bg-[var(--color-surface-2)] flex items-center justify-between gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={() => handlePendingDecision('decline')}
                      disabled={closeDisabled || !onUpdateReservation}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-500/40 dark:text-rose-300 dark:hover:bg-rose-500/10 transition-colors"
                    >
                      {pendingActionBusy === 'decline' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                      Rifiuta
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePendingDecision('confirm')}
                      disabled={closeDisabled || !onUpdateReservation}
                      className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg text-[13px] font-medium bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
                    >
                      {pendingActionBusy === 'confirm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      Conferma
                    </button>
                  </div>
                )}

                {onOpenReservationInList && (
                  <div className="px-5 py-2 border-t border-[var(--color-line)] bg-[var(--color-surface-2)] text-center">
                    <button
                      type="button"
                      onClick={() => {
                        onOpenReservationInList(res.id);
                        setPendingModalRes(null);
                        setUnpaidDepositWarn(false);
                      }}
                      disabled={closeDisabled}
                      className="inline-flex items-center gap-1 text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] disabled:opacity-50 transition-colors"
                    >
                      Modifica completa in Prenotazioni <ArrowRight className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })(),
        document.body
      )}
    </div>
  );
};
