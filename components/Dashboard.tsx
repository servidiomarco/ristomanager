import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Reservation, Table, Dish, Room, Shift, ArrivalStatus, ReservationStatus, ReservationSource, TodoPriority, TodoCategory, StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType, BanquetMenu } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { ShoppingCategory, ShoppingItem } from '../services/shoppingApiService';
import { getLowStockInventory, LowStockItem, getReservationAllergenPresets } from '../services/apiService';
import { staffApiService } from '../services/staffApiService';
import { DateNavigator } from './DateNavigator';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, ChevronRight, Calendar, Plus, Check, Clock, Flag, AlertTriangle, CheckCircle2, ListTodo, ShoppingCart, Coffee, ChefHat, Package, Sun, Sunset, Armchair, Trees, Mountain, Waves, TreePine, Tent, Columns3, MapPin, StickyNote, Wheat, ListChecks, Phone as PhoneIcon, Globe, Mic, MessageCircle, User as UserIcon, Users as UsersIcon, X, ArrowRight, Ban, HelpCircle } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../contexts/AuthContext';
import { useShopping } from '../contexts/ShoppingContext';
import { useTodos } from '../contexts/TodosContext';
import { CookingPotLoader } from './CookingPotLoader';

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
}

// Shopping List Labels and Colors
const SHOPPING_CATEGORY_LABELS: Record<ShoppingCategory, string> = {
  'CUCINA': 'Cucina',
  'BAR': 'Bar',
  'ALTRO': 'Altro'
};

const SHOPPING_CATEGORY_ICONS: Record<ShoppingCategory, React.ReactNode> = {
  'CUCINA': <ChefHat className="h-4 w-4" />,
  'BAR': <Coffee className="h-4 w-4" />,
  'ALTRO': <Package className="h-4 w-4" />
};

const SHOPPING_CATEGORY_COLORS: Record<ShoppingCategory, string> = {
  'CUCINA': 'bg-orange-100 dark:bg-orange-500/20 text-orange-700 dark:text-orange-300 border-orange-200 dark:border-orange-500/30',
  'BAR': 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-500/30',
  'ALTRO': 'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-500/30'
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

const KPI_TONES = {
  amber: {
    bg: 'bg-amber-50 dark:bg-amber-500/10',
    chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300',
    value: 'text-[var(--color-fg)]',
  },
  blue: {
    bg: 'bg-blue-50 dark:bg-blue-500/10',
    chip: 'bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300',
    value: 'text-[var(--color-fg)]',
  },
  rose: {
    bg: 'bg-rose-50 dark:bg-rose-500/10',
    chip: 'bg-rose-100 text-rose-600 dark:bg-rose-500/25 dark:text-rose-300',
    value: 'text-rose-600 dark:text-rose-300',
  },
} as const;

const KpiBlock: React.FC<{ tone: keyof typeof KPI_TONES; icon: React.ReactNode; value: number | string }> = ({ tone, icon, value }) => {
  const t = KPI_TONES[tone];
  return (
    <div className={`flex-1 min-w-0 rounded-xl ${t.bg} px-3 py-3 flex flex-col justify-between min-h-[78px] sm:min-h-[88px]`}>
      <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${t.chip}`}>
        {icon}
      </span>
      <span className={`tabular text-[24px] sm:text-[28px] leading-none font-semibold self-end ${t.value}`}>{value}</span>
    </div>
  );
};

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms, banquetMenus, onNavigateToBanquets, onNavigateToReservations, onNavigateToInventario, onNavigateToShoppingList, onNavigateToAttivita, globalDate, globalShiftFilter: globalShiftFilterProp, onDateChange, onShiftFilterChange, onUpdateReservation, onOpenReservationInList }) => {
  const { user } = useAuth();
  const { items: shoppingItems, addItem: addShoppingItemCtx, toggleItem: toggleShoppingItemCtx } = useShopping();
  const { todos, addTodo: addTodoCtx, toggleTodo: toggleTodoCtx } = useTodos();
  const [report, setReport] = useState<string | null>(null);
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

  const handleGenerateReport = async () => {
    setLoading(true);
    const result = await generateRestaurantReport(reservations, tables, dishes);
    setReport(result);
    setLoading(false);
  };

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
  const handlePendingDecision = useCallback(async (action: 'confirm' | 'decline') => {
    if (!pendingModalRes || !onUpdateReservation) return;
    setPendingActionBusy(action);
    try {
      await onUpdateReservation({
        ...pendingModalRes,
        reservation_status: action === 'confirm' ? ReservationStatus.CONFIRMED : ReservationStatus.DECLINED,
      });
      setPendingModalRes(null);
    } catch {
      // Toast already shown by handleUpdateReservation in App.
    } finally {
      setPendingActionBusy(null);
    }
  }, [pendingModalRes, onUpdateReservation]);

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
          r.reservation_time.startsWith(selectedDateStr) &&
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

  // Banchetti scheduled for the selected day
  const banquetsToday = Array.isArray(banquetMenus)
    ? banquetMenus.filter(m => m.event_date === selectedDateStr).length
    : 0;

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
  const lunchArrivedRes = lunchReservations.filter(r => r.arrival_status === ArrivalStatus.ARRIVED);
  const dinnerArrivedRes = dinnerReservations.filter(r => r.arrival_status === ArrivalStatus.ARRIVED);
  const lunchArrivedGuests = lunchArrivedRes.reduce((acc, r) => acc + r.guests, 0);
  const dinnerArrivedGuests = dinnerArrivedRes.reduce((acc, r) => acc + r.guests, 0);
  const lunchArrivedTableIds = new Set(lunchArrivedRes.map(r => r.table_id).filter(Boolean));
  const dinnerArrivedTableIds = new Set(dinnerArrivedRes.map(r => r.table_id).filter(Boolean));

  const lunchOccupancy = totalTables > 0 ? Math.round((lunchTableIds.size / totalTables) * 100) : 0;
  const dinnerOccupancy = totalTables > 0 ? Math.round((dinnerTableIds.size / totalTables) * 100) : 0;

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

    const getTimeFromReservation = (r: Reservation) => {
      const match = r.reservation_time.match(/T(\d{2}:\d{2})/);
      return match ? match[1] : '';
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

      // Lunch slots for this room
      const lunchSlots = LUNCH_SLOTS.map(slot => {
        const reservationsAtSlot = lunchReservations.filter(r =>
          getRoomForReservation(r) === room.id && getTimeFromReservation(r) === slot
        );
        const guests = reservationsAtSlot.reduce((acc, r) => acc + r.guests, 0);
        return { time: slot, guests, percentage: maxCapacity > 0 ? Math.round((guests / maxCapacity) * 100) : 0 };
      });

      // Dinner slots for this room
      const dinnerSlots = DINNER_SLOTS.map(slot => {
        const reservationsAtSlot = dinnerReservations.filter(r =>
          getRoomForReservation(r) === room.id && getTimeFromReservation(r) === slot
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
        ? reservations.filter(r => r.reservation_time.startsWith(dateStr))
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

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6 lg:space-y-8 bg-[var(--color-surface-2)]">
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
        // Service window: lunch 11:00-15:30, dinner 18:00-23:30
        const minutes = hour * 60 + currentTime.getMinutes();
        const inLunch = minutes >= 11 * 60 && minutes < 15 * 60 + 30;
        const inDinner = minutes >= 18 * 60 && minutes < 23 * 60 + 30;
        const serviceLabel = inLunch
          ? { text: 'Servizio pranzo · In corso', dot: 'bg-emerald-500', color: 'text-emerald-700 dark:text-emerald-300' }
          : inDinner
          ? { text: 'Servizio cena · In corso', dot: 'bg-emerald-500', color: 'text-emerald-700 dark:text-emerald-300' }
          : { text: 'Fuori servizio', dot: 'bg-[var(--color-fg-subtle)]', color: 'text-[var(--color-fg-muted)]' };
        return (
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-2">
            <div className="flex items-center justify-between w-full gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${serviceLabel.dot}`} aria-hidden />
                  <span className={`text-[12px] font-medium ${serviceLabel.color}`}>
                    {serviceLabel.text}
                  </span>
                </div>
                <h1 className="text-[22px] sm:text-[28px] lg:text-[32px] font-semibold text-[var(--color-fg)] tracking-tight mt-1.5">
                  {greeting}, {firstName}.
                </h1>
              </div>
              {todaysTodos.length > 0 && (
                <button
                  onClick={() => onNavigateToAttivita?.()}
                  className="inline-flex items-center gap-2 p-2.5 rounded-xl text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-500/10 transition-colors flex-shrink-0 self-end"
                  aria-label={`${todaysTodos.length} attività di oggi`}
                  title="Attività di oggi"
                >
                  <ListTodo className="h-7 w-7" />
                  <span className="hidden md:inline text-sm font-semibold">Attività di oggi</span>
                  <span className="tabular inline-flex items-center justify-center min-w-[20px] h-[20px] px-1 rounded-full text-[11px] font-bold bg-violet-500 text-[#ffffff]">
                    {todaysTodos.length}
                  </span>
                </button>
              )}
            </div>

            {/* Date navigator + time chip + shift filter — mobile only (desktop uses header) */}
            <div className="flex flex-wrap items-start gap-2 self-stretch w-full md:hidden">
              <DateNavigator
                value={selectedDateStr}
                onChange={(dateOnly) => {
                  const [y, m, d] = dateOnly.split('-').map(Number);
                  if (y && m && d) setSelectedDate(new Date(y, m - 1, d));
                }}
                className="flex-1 min-w-0"
              />

              {/* Separate time chip — always shows live current time */}
              <div className="flex items-center gap-1.5 bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] px-4 h-10 flex-shrink-0">
                <Clock className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
                <span className="tabular font-medium text-sm text-[var(--color-fg)] whitespace-nowrap">
                  {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* Global meal filter — drives KPI cards, Stato Tavoli, Affluenza, Note, Personale */}
              <div className="basis-full md:basis-auto flex items-center justify-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5">
                {([
                  { key: 'ALL', label: 'Tutti', icon: null as React.ReactNode },
                  { key: 'LUNCH', label: 'Pranzo', icon: <Sun className="h-4 w-4" /> },
                  { key: 'DINNER', label: 'Cena', icon: <Sunset className="h-4 w-4" /> },
                ] as const).map(opt => (
                  <button
                    key={opt.key}
                    onClick={() => setGlobalShiftFilter(opt.key)}
                    className={`inline-flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors flex-1 md:flex-none ${
                      globalShiftFilter === opt.key
                        ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                        : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
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

      {/* KPI Cards — Ospiti / Tavoli / Prenotazioni & Banchetti, follow the global meal filter */}
      {(() => {
        const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
        const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';
        const cols = (showLunch && showDinner) ? 'grid-cols-2' : 'grid-cols-1';

        // One tinted block per active meal — matches Prenotazioni & banchetti style.
        // Shift identity comes from the bg tone + icon (no "Pranzo"/"Cena" label).
        // Attesi and Arrivati sit side-by-side inside the block.
        const renderShiftBreakdown = (
          shift: 'lunch' | 'dinner',
          attesiValue: number,
          arrivatiValue: number,
        ) => {
          const tone = shift === 'lunch' ? KPI_TONES.amber : KPI_TONES.blue;
          const icon = shift === 'lunch' ? <Sun className="h-3.5 w-3.5" /> : <Sunset className="h-3.5 w-3.5" />;
          return (
            <div key={shift} className={`min-w-0 rounded-xl ${tone.bg} p-3 sm:p-4 flex flex-col gap-3`}>
              <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${tone.chip}`}>
                {icon}
              </span>
              <div className="grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] text-[var(--color-fg-muted)]">Attesi</div>
                  <div className="tabular text-2xl sm:text-3xl font-semibold text-[var(--color-fg)] leading-none mt-1">{attesiValue}</div>
                </div>
                <div className="min-w-0">
                  <div className="text-[11px] text-[var(--color-fg-muted)]">Arrivati</div>
                  <div className="tabular text-2xl sm:text-3xl font-semibold text-[var(--color-fg)] leading-none mt-1">{arrivatiValue}</div>
                </div>
              </div>
            </div>
          );
        };

        return (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 lg:gap-5">
            {/* Ospiti */}
            <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-4 sm:p-5 flex flex-col gap-3">
              <h3 className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Ospiti</h3>
              <div className={`grid ${cols} gap-4 sm:gap-5`}>
                {showLunch && renderShiftBreakdown('lunch', lunchExpectedGuests, lunchArrivedGuests)}
                {showDinner && renderShiftBreakdown('dinner', dinnerExpectedGuests, dinnerArrivedGuests)}
              </div>
            </div>

            {/* Tavoli */}
            <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-4 sm:p-5 flex flex-col gap-3">
              <h3 className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Tavoli</h3>
              <div className={`grid ${cols} gap-4 sm:gap-5`}>
                {showLunch && renderShiftBreakdown('lunch', lunchTableIds.size, lunchArrivedTableIds.size)}
                {showDinner && renderShiftBreakdown('dinner', dinnerTableIds.size, dinnerArrivedTableIds.size)}
              </div>
            </div>

            {/* Prenotazioni */}
            <button
              type="button"
              onClick={onNavigateToReservations}
              className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-4 sm:p-5 flex flex-col gap-3 text-left hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              <h3 className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Prenotazioni</h3>
              <div className="flex flex-wrap gap-2 flex-1 items-stretch">
                {showLunch && (
                  <KpiBlock tone="amber" icon={<Sun className="h-3.5 w-3.5" />} value={lunchReservations.length} />
                )}
                {showDinner && (
                  <KpiBlock tone="blue" icon={<Sunset className="h-3.5 w-3.5" />} value={dinnerReservations.length} />
                )}
              </div>
            </button>

            {/* Banchetti */}
            <button
              type="button"
              onClick={onNavigateToBanquets}
              className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-4 sm:p-5 flex flex-col gap-3 text-left hover:bg-[var(--color-surface-hover)] transition-colors"
            >
              <h3 className="text-[15px] sm:text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Banchetti</h3>
              <div className="flex flex-wrap gap-2 flex-1 items-stretch">
                <KpiBlock tone="rose" icon={<Calendar className="h-3.5 w-3.5" />} value={banquetsToday} />
              </div>
            </button>
          </div>
        );
      })()}

      {/* Row 1: Stato Tavoli + Note & Allergeni + Da confermare */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 lg:gap-8">
      {/* Stato Tavoli — Pranzo / Cena side by side */}
      <div className="lg:col-span-2 bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
        <h2 className="text-base lg:text-lg font-semibold mb-4 text-[var(--color-fg)]">Stato Tavoli</h2>

        <div className={`grid grid-cols-1 ${globalShiftFilter === 'ALL' ? 'lg:grid-cols-2' : 'lg:grid-cols-1'} gap-4 lg:gap-5`}>
          {([
            {
              key: 'lunch',
              label: 'Pranzo',
              icon: <Sun className="h-4 w-4" />,
              chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300',
              barFill: 'bg-amber-500',
              roomBar: 'bg-amber-400',
              cardBg: 'bg-amber-50/40 border-amber-200/60 dark:bg-amber-500/[0.06] dark:border-amber-500/20',
              divider: 'border-amber-200/60 dark:border-amber-500/20',
              occupancy: lunchOccupancy,
              occupiedTables: lunchTableIds.size,
              reservations: lunchReservations,
              reservationCount: lunchReservations.length,
              guestCount: lunchReservations.reduce((acc, r) => acc + r.guests, 0),
            },
            {
              key: 'dinner',
              label: 'Cena',
              icon: <Sunset className="h-4 w-4" />,
              chip: 'bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300',
              barFill: 'bg-blue-500',
              roomBar: 'bg-blue-400',
              cardBg: 'bg-blue-50/40 border-blue-200/60 dark:bg-blue-500/[0.06] dark:border-blue-500/20',
              divider: 'border-blue-200/60 dark:border-blue-500/20',
              occupancy: dinnerOccupancy,
              occupiedTables: dinnerTableIds.size,
              reservations: dinnerReservations,
              reservationCount: dinnerReservations.length,
              guestCount: dinnerReservations.reduce((acc, r) => acc + r.guests, 0),
            },
          ] as const)
            .filter(m => globalShiftFilter === 'ALL' || globalShiftFilter === (m.key === 'lunch' ? 'LUNCH' : 'DINNER'))
            .map(meal => {
            const roomStats = rooms.filter(room => !room.is_closed).map(room => {
              const roomTables = tables.filter(t => t.room_id === room.id);
              const roomTableIds = new Set(roomTables.map(t => t.id));
              const occupied = meal.reservations.filter(r => r.table_id && roomTableIds.has(r.table_id))
                .reduce((set, r) => { set.add(r.table_id!); return set; }, new Set<number>()).size;
              const total = roomTables.length;
              const pct = total > 0 ? Math.round((occupied / total) * 100) : 0;
              return { id: room.id, name: room.name, occupied, total, pct };
            }).sort((a, b) => b.pct - a.pct);

            return (
              <div
                key={meal.key}
                className={`rounded-xl border ${meal.cardBg} p-4 sm:p-5 flex flex-col gap-4`}
              >
                {/* Header: meal chip + label + total tavoli */}
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <span className={`inline-flex h-8 w-8 items-center justify-center rounded-full ${meal.chip}`}>
                      {meal.icon}
                    </span>
                    <span className="text-[15px] font-semibold text-[var(--color-fg)] tracking-tight">{meal.label}</span>
                  </div>
                  <span className="tabular text-xs text-[var(--color-fg-muted)] whitespace-nowrap">{meal.occupiedTables}/{totalTables} tavoli</span>
                </div>

                {/* Big % + bar with threshold ticks + annotations */}
                <div>
                  <div className="flex items-end gap-2">
                    <span className="tabular text-3xl font-semibold leading-none text-[var(--color-fg)]">{meal.occupancy}%</span>
                    <span className="text-sm text-[var(--color-fg-muted)] mb-0.5">occupazione</span>
                  </div>
                  <div className="relative mt-2 h-2 bg-[var(--color-surface-3)] rounded-full overflow-hidden">
                    <div className={`absolute inset-y-0 left-0 ${meal.barFill} rounded-full transition-all duration-500`} style={{ width: `${meal.occupancy}%` }} />
                    {/* threshold ticks */}
                    <span className="absolute top-0 bottom-0 w-px bg-[var(--color-line-strong)]/60" style={{ left: '40%' }} aria-hidden />
                    <span className="absolute top-0 bottom-0 w-px bg-[var(--color-line-strong)]/60" style={{ left: '80%' }} aria-hidden />
                  </div>
                  <div className="relative mt-1.5 h-3 text-[10px] text-[var(--color-fg-subtle)]">
                    <span className="absolute left-0">Calmo</span>
                    <span className="absolute" style={{ left: '40%', transform: 'translateX(-50%)' }}>Pieno</span>
                    <span className="absolute right-0">Sold out</span>
                  </div>
                  <p className="tabular text-xs text-[var(--color-fg-muted)] mt-2">
                    {meal.reservationCount} prenotazioni · {meal.guestCount} ospiti
                  </p>
                </div>

                {/* Per-room rows */}
                <div className={`border-t ${meal.divider} pt-3 space-y-1.5`}>
                  {roomStats.map(room => {
                    const Icon = getRoomIcon(room.name);
                    return (
                      <div key={room.id} className="flex items-center gap-3">
                        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0">
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-sm text-[var(--color-fg)] flex-shrink-0 w-20 truncate">{room.name}</span>
                        <div className="flex-1 h-1.5 bg-[var(--color-surface-3)] rounded-full overflow-hidden">
                          <div className={`h-full ${meal.roomBar} rounded-full transition-all duration-500`} style={{ width: `${room.pct}%` }} />
                        </div>
                        <span className="tabular text-xs text-[var(--color-fg-muted)] w-12 text-right flex-shrink-0">{room.occupied}/{room.total}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Note & Allergeni */}
      <div className="lg:col-span-1 bg-[var(--color-surface)] p-4 lg:p-5 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center mb-3 gap-2">
            <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">
              Note &amp; Allergeni
            </h2>
          </div>
          {reservationNotes.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-center py-8">
              <div>
                <StickyNote className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
                <p className="text-xs text-[var(--color-fg-subtle)]">
                  Nessuna nota {globalShiftFilter === 'LUNCH' ? 'per il pranzo' : globalShiftFilter === 'DINNER' ? 'per la cena' : 'per oggi'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
              {reservationNotes.map(({ reservation, table, room, allergens }) => {
                const isLunch = reservation.shift === Shift.LUNCH;
                const time = reservation.reservation_time.match(/T(\d{2}:\d{2})/)?.[1];
                const circleBg = isLunch ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300' : 'bg-indigo-100 dark:bg-[#4f46e5]/20 text-indigo-700 dark:text-[#a5b4fc]';
                const isExpanded = expandedNoteIds.has(reservation.id);
                const noteText = reservation.notes || '';
                const isTruncatable = noteText.length > 80;
                return (
                  <div key={reservation.id} className="border border-[var(--color-line)] rounded-lg p-3 bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] transition-colors">
                    {/* Row 1: Table circle + Name/Time + Warning */}
                    <div className="flex items-center gap-3">
                      <div className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${circleBg}`}>
                        {table ? table.name.replace(/[^0-9]/g, '') || table.name.charAt(0) : '–'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--color-fg)] truncate">{reservation.customer_name}</p>
                        <div className="flex items-center gap-1 mt-0.5">
                          <Clock className="h-3 w-3 text-[var(--color-fg-subtle)] flex-shrink-0" />
                          <span className="text-xs text-[var(--color-fg-muted)]">{time || '—'}</span>
                          {room && (
                            <>
                              <span className="text-[var(--color-fg-subtle)] text-xs mx-0.5">·</span>
                              <span className="text-xs text-[var(--color-fg-muted)] truncate">{room.name}</span>
                            </>
                          )}
                        </div>
                      </div>
                      {!table && (
                        <div className="flex-shrink-0 flex items-center gap-1 px-2 py-1 rounded-full bg-amber-50 dark:bg-amber-500/15 border border-amber-200 dark:border-amber-500/30">
                          <AlertTriangle className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                          <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 whitespace-nowrap">Non assegnato</span>
                        </div>
                      )}
                    </div>

                    {/* Row 2: Allergen chips */}
                    {allergens.length > 0 && (
                      <div className="flex items-center gap-1.5 mt-2.5 flex-wrap">
                        {allergens.map(a => (
                          <span key={a} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-500/30">
                            {a}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Row 3: Notes (truncatable) */}
                    {noteText && (
                      <div className="mt-2">
                        <p className="text-xs text-[var(--color-fg-muted)] leading-relaxed whitespace-pre-wrap break-words">
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
                            className="text-[11px] font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] mt-1 transition-colors"
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

      {/* Da confermare — pending reservations across the whole DB (not just
          today), ordered by reservation time ascending. Click opens a quick
          confirm/decline modal; full editing lives in Prenotazioni.
          When non-empty the card wears an amber accent (background + border
          + ring) so it reads as "needs attention" at a glance; empty stays
          neutral so an idle Dashboard doesn't scream. */}
      <div className={`lg:col-span-1 p-4 lg:p-5 rounded-xl border shadow-[var(--shadow-sm)] flex flex-col ${
        pendingReservations.length > 0
          ? 'bg-amber-50 border-amber-300 ring-1 ring-amber-200 dark:bg-amber-500/[0.08] dark:border-amber-500/40 dark:ring-amber-500/20'
          : 'bg-[var(--color-surface)] border-[var(--color-line)]'
      }`}>
        <div className="flex items-center justify-between mb-3 gap-2">
          <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Da confermare</h2>
          {pendingReservations.length > 0 && (
            <span className="text-sm font-bold min-w-[28px] h-7 inline-flex items-center justify-center px-2 rounded-full bg-amber-500 text-white shadow-sm dark:bg-amber-500 dark:text-white tabular">
              {pendingReservations.length}
            </span>
          )}
        </div>
        {pendingReservations.length === 0 ? (
          <div className="flex-1 flex items-center justify-center text-center py-8">
            <div>
              <CheckCircle2 className="h-8 w-8 text-emerald-500/70 mx-auto mb-2" />
              <p className="text-xs text-[var(--color-fg-subtle)]">Nessuna prenotazione da confermare</p>
            </div>
          </div>
        ) : (
          <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
            {pendingReservations.map(res => {
              const source = res.source || ReservationSource.MANUAL;
              const channel = source === ReservationSource.WHATSAPP
                ? { Icon: MessageCircle, label: 'WhatsApp', cls: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400' }
                : source === ReservationSource.GOOGLE
                ? { Icon: Globe, label: 'Web', cls: 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]' }
                : source === ReservationSource.VOICE
                ? { Icon: Mic, label: 'Agente vocale', cls: 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]' }
                : { Icon: PhoneIcon, label: 'Telefono', cls: 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]' };
              const resDate = new Date(res.reservation_time);
              const dateLabel = !Number.isNaN(resDate.getTime())
                ? resDate.toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
                : '';
              const timeLabel = res.reservation_time.match(/T(\d{2}:\d{2})/)?.[1] || '';
              return (
                <button
                  key={res.id}
                  type="button"
                  onClick={() => setPendingModalRes(res)}
                  className="w-full text-left border border-[var(--color-line)] rounded-lg p-3 bg-[var(--color-surface-2)] hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <span className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${channel.cls}`} title={`Canale: ${channel.label}`}>
                      <channel.Icon className="h-4 w-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--color-fg)] truncate">{res.customer_name || '—'}</p>
                      <div className="flex items-center gap-1.5 mt-0.5 text-xs text-[var(--color-fg-muted)] tabular">
                        <Clock className="h-3 w-3 text-[var(--color-fg-subtle)] flex-shrink-0" />
                        <span>{dateLabel} · {timeLabel}</span>
                        <span className="text-[var(--color-fg-subtle)] mx-0.5">·</span>
                        <span>{res.guests || 0} {res.guests === 1 ? 'ospite' : 'ospiti'}</span>
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--color-fg-subtle)] flex-shrink-0" />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
      </div>

      {/* Row 2: Affluenza — merged Orario + Settimana with shared shift filter */}
      <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
        {/* Header: title, view tabs, shift filter */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Affluenza</h2>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-2">
              {([
                { key: 'ORARIO', label: 'Orario' },
                { key: 'SETTIMANA', label: 'Settimana' },
              ] as const).map(t => (
                <button
                  key={t.key}
                  onClick={() => setAffluenceTab(t.key)}
                  className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors border ${
                    affluenceTab === t.key
                      ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                      : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        {affluenceTab === 'ORARIO' && (() => {
          const showLunch = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
          const showDinner = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';
          const cellColor = (p: number, isLunch: boolean) => {
            if (p === 0) return 'bg-[var(--color-surface-3)]';
            if (isLunch) {
              if (p < 25) return 'bg-amber-200 dark:bg-amber-500/30';
              if (p < 50) return 'bg-amber-300 dark:bg-amber-500/45';
              if (p < 75) return 'bg-amber-400 dark:bg-amber-500/65';
              return 'bg-amber-500 dark:bg-amber-500/85';
            }
            if (p < 25) return 'bg-blue-200 dark:bg-blue-500/30';
            if (p < 50) return 'bg-blue-300 dark:bg-blue-500/45';
            if (p < 75) return 'bg-blue-400 dark:bg-blue-500/65';
            return 'bg-blue-500 dark:bg-blue-500/85';
          };

          const renderShift = (
            shift: 'lunch' | 'dinner',
            slots: { time: string; guests: number; percentage: number }[],
            total: number,
            pct: number,
            roomMax: number,
          ) => {
            const isLunch = shift === 'lunch';
            const tone = isLunch
              ? { chip: 'bg-amber-100 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300', icon: <Sun className="h-3 w-3" />, label: 'Pranzo', text: 'text-amber-900 dark:text-amber-100' }
              : { chip: 'bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300', icon: <Sunset className="h-3 w-3" />, label: 'Cena', text: 'text-blue-900 dark:text-blue-100' };

            return (
              <div className="flex items-center gap-2">
                {/* Fixed left chip */}
                <span className={`inline-flex h-5 w-5 items-center justify-center rounded ${tone.chip} flex-shrink-0 self-end mb-[6px]`} aria-label={tone.label}>
                  {tone.icon}
                </span>
                {/* Scrollable middle: labels + cells */}
                <div className="flex-1 min-w-0 overflow-x-auto">
                  <div className="flex flex-col gap-1" style={{ minWidth: `${slots.length * 44}px` }}>
                    <div className="flex gap-1">
                      {slots.map(s => (
                        <span key={s.time} className="tabular text-[10px] text-[var(--color-fg-subtle)] text-center flex-1 min-w-[40px]">{s.time}</span>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      {slots.map(slot => (
                        <div
                          key={slot.time}
                          className={`relative flex-1 min-w-[40px] ${cellColor(slot.percentage, isLunch)} rounded h-7 sm:h-8 flex items-center justify-center transition-colors`}
                          title={`${slot.time} · ${slot.guests} ospiti (${slot.percentage}%)`}
                        >
                          <span className={`tabular text-[11px] font-semibold ${slot.guests > 0 ? tone.text : 'text-[var(--color-fg-subtle)]'}`}>
                            {slot.guests}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
                {/* Fixed right total */}
                <span className="tabular text-[11px] text-[var(--color-fg-muted)] w-20 text-right flex-shrink-0 self-end mb-[6px]">{total}/{roomMax} · {pct}%</span>
              </div>
            );
          };

          return (
            <>
              <div className="space-y-3 max-h-[460px] overflow-y-auto">
                {timeSlotAffluence.roomTimeSlots.map(room => {
                  const Icon = getRoomIcon(room.roomName);
                  return (
                    <div key={room.roomId} className="border border-[var(--color-line)] rounded-md p-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0">
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <h3 className="font-medium text-sm text-[var(--color-fg)] truncate">{room.roomName}</h3>
                        </div>
                        <span className="tabular text-xs text-[var(--color-fg-subtle)] flex-shrink-0">Max {room.maxCapacity} coperti</span>
                      </div>
                      {showLunch && renderShift('lunch', room.lunchSlots, room.totalLunchGuests, room.lunchPercentage, room.maxCapacity)}
                      {showDinner && renderShift('dinner', room.dinnerSlots, room.totalDinnerGuests, room.dinnerPercentage, room.maxCapacity)}
                    </div>
                  );
                })}
              </div>

              {/* Totals */}
              <div className={`mt-4 pt-3 border-t border-[var(--color-line)] grid gap-3 ${globalShiftFilter === 'ALL' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
                {showLunch && (
                  <div className="rounded-md p-2.5 border border-amber-200/60 bg-amber-50/40 dark:bg-amber-500/[0.06] dark:border-amber-500/20">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg)]">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-amber-100 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300">
                          <Sun className="h-3 w-3" />
                        </span>
                        Totale Pranzo
                      </span>
                      <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                        {lunchReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                      </span>
                    </div>
                  </div>
                )}
                {showDinner && (
                  <div className="rounded-md p-2.5 border border-blue-200/60 bg-blue-50/40 dark:bg-blue-500/[0.06] dark:border-blue-500/20">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg)]">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300">
                          <Sunset className="h-3 w-3" />
                        </span>
                        Totale Cena
                      </span>
                      <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                        {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                      </span>
                    </div>
                  </div>
                )}
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
                    contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-line)', borderRadius: '8px', fontSize: '12px' }}
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

            {/* Totals — same pattern as Orario */}
            <div className={`mt-4 pt-3 border-t border-[var(--color-line)] grid gap-3 ${globalShiftFilter === 'ALL' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
              {(globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH') && (
                <div className="rounded-md p-2.5 border border-amber-200/60 bg-amber-50/40 dark:bg-amber-500/[0.06] dark:border-amber-500/20">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg)]">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-amber-100 text-amber-600 dark:bg-amber-500/25 dark:text-amber-300">
                        <Sun className="h-3 w-3" />
                      </span>
                      Totale Pranzo (settimana)
                    </span>
                    <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                      {weeklyChartData.reduce((acc, d) => acc + d.guests, 0)} ospiti
                    </span>
                  </div>
                </div>
              )}
              {(globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER') && (
                <div className="rounded-md p-2.5 border border-blue-200/60 bg-blue-50/40 dark:bg-blue-500/[0.06] dark:border-blue-500/20">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg)]">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-blue-100 text-blue-600 dark:bg-blue-500/25 dark:text-blue-300">
                        <Sunset className="h-3 w-3" />
                      </span>
                      Totale Cena (settimana)
                    </span>
                    <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                      {weeklyChartData.reduce((acc, d) => acc + d.guests, 0)} ospiti
                    </span>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>


      {/* Row 3: Attività + Spesa del giorno + Sotto Scorta */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
        {/* Attività — compact summary */}
        <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Attività</h2>
              <p className="tabular text-xs text-[var(--color-fg-muted)]">
                {overdueTodos.length > 0 && (
                  <span className="text-rose-600 dark:text-rose-400 font-medium">{overdueTodos.length} scadute</span>
                )}
                {overdueTodos.length > 0 && (todaysTodos.length > 0 || pendingCount > 0) && <span> · </span>}
                {todaysTodos.length > 0 && <span>{todaysTodos.length} oggi</span>}
                {overdueTodos.length === 0 && todaysTodos.length === 0 && (
                  <span>{pendingCount} da fare</span>
                )}
              </p>
            </div>
            {onNavigateToAttivita && (
              <button
                onClick={onNavigateToAttivita}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
              >
                Apri <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {overdueTodos.length > 0 && (
            <div className="mb-3 p-2.5 bg-rose-50 dark:bg-rose-500/15 border border-rose-100 dark:border-rose-500/30 rounded-lg">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 flex-shrink-0" />
                <p className="text-xs text-rose-700 dark:text-rose-300 truncate">
                  {overdueTodos.slice(0, 2).map(t => t.title).join(', ')}{overdueTodos.length > 2 ? '…' : ''}
                </p>
              </div>
            </div>
          )}

          <div className="flex-1 space-y-1.5 mb-3 min-h-[120px]">
            {urgentTasks.length === 0 ? (
              <div className="py-6 text-center">
                <CheckCircle2 className="h-7 w-7 text-emerald-500 mx-auto mb-2" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Tutto sotto controllo</p>
              </div>
            ) : (
              urgentTasks.map(todo => {
                const isOverdue = todo.dueDate && todo.dueDate < todayStr;
                return (
                  <div
                    key={todo.id}
                    className="group flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-[var(--color-surface-hover)] transition-colors"
                  >
                    <button
                      onClick={() => handleToggleTodo(todo.id)}
                      className="flex-shrink-0 w-4 h-4 rounded-full border border-[var(--color-line-strong)] hover:border-[var(--color-fg)] transition-colors"
                      aria-label="Completa attività"
                    />
                    <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_DOT_COLORS[todo.category]} flex-shrink-0`} />
                    <span className="flex-1 min-w-0 text-sm text-[var(--color-fg)] truncate">{todo.title}</span>
                    {todo.priority !== TodoPriority.LOW && (
                      <Flag className={`h-3 w-3 flex-shrink-0 ${PRIORITY_COLORS[todo.priority]}`} />
                    )}
                    {todo.dueDate && (
                      <span className={`tabular text-[11px] flex-shrink-0 ${isOverdue ? 'text-rose-600 dark:text-rose-400 font-medium' : 'text-[var(--color-fg-subtle)]'}`}>
                        {new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Quick-add inline */}
          <div className="border-t border-[var(--color-line)] pt-3">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-[var(--color-fg-subtle)] flex-shrink-0" />
              <input
                type="text"
                value={newTaskTitle}
                onChange={e => setNewTaskTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddTask(); } }}
                placeholder="Nuova attività…"
                className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddTask}
                disabled={!newTaskTitle.trim() || isAddingTask}
                aria-label="Aggiungi attività"
                className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {isAddingTask ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Spesa — compact summary */}
        <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Spesa</h2>
              <p className="tabular text-xs text-[var(--color-fg-muted)]">{checkedItems}/{totalItems} completati</p>
            </div>
            {onNavigateToShoppingList && (
              <button
                onClick={onNavigateToShoppingList}
                className="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
              >
                Apri <ChevronRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Pane del giorno */}
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-3 py-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-500/25 text-amber-600 dark:text-amber-300 flex-shrink-0">
              <Wheat className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-[var(--color-fg)]">
                Pane{' '}
                {breadEstimate.coperti > 0 ? (
                  <span className="tabular font-semibold text-amber-700 dark:text-amber-300">{breadEstimate.kg} kg</span>
                ) : (
                  <span className="text-[var(--color-fg-subtle)]">— nessuna prenotazione</span>
                )}
              </p>
              <p className="text-[11px] text-[var(--color-fg-muted)]">
                {breadEstimate.coperti > 0
                  ? `${breadEstimate.coperti} coperti · 1 kg ogni 10`
                  : 'Si aggiorna in base alle prenotazioni del giorno'}
              </p>
            </div>
          </div>

          {/* Category counts */}
          <div className="flex-1 mb-3 min-h-[120px]">
            {totalItems === 0 ? (
              <div className="py-6 text-center">
                <ShoppingCart className="h-7 w-7 text-[var(--color-fg-subtle)] mx-auto mb-2" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Lista vuota</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {(['CUCINA', 'BAR', 'ALTRO'] as ShoppingCategory[]).map(cat => {
                  const items = shoppingByCategory[cat];
                  if (items.length === 0) return null;
                  const remaining = items.filter(i => !i.checked).length;
                  return (
                    <div key={cat} className="flex items-center gap-2 px-2 py-1.5 rounded-md">
                      <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${SHOPPING_CATEGORY_COLORS[cat]}`}>
                        {SHOPPING_CATEGORY_ICONS[cat]}
                        {SHOPPING_CATEGORY_LABELS[cat]}
                      </span>
                      <span className="tabular text-xs text-[var(--color-fg-muted)] ml-auto">
                        {remaining}/{items.length} da prendere
                      </span>
                    </div>
                  );
                })}
                {/* Latest 3 items preview */}
                <div className="pt-1 space-y-0.5">
                  {shoppingItems
                    .filter(i => !i.checked)
                    .slice(-3)
                    .reverse()
                    .map(item => (
                      <div key={item.id} className="group flex items-center gap-2 px-2 py-1 rounded-md hover:bg-[var(--color-surface-hover)] transition-colors">
                        <button
                          onClick={() => handleToggleShoppingItem(item.id)}
                          className="flex-shrink-0 w-3.5 h-3.5 rounded border border-[var(--color-line-strong)] hover:border-[var(--color-fg)] transition-colors"
                          aria-label="Completa"
                        />
                        <span className="flex-1 min-w-0 text-sm text-[var(--color-fg)] truncate">{item.name}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>

          {/* Quick-add inline */}
          <div className="border-t border-[var(--color-line)] pt-3">
            <div className="flex items-center gap-2">
              <Plus className="h-4 w-4 text-[var(--color-fg-subtle)] flex-shrink-0" />
              <input
                type="text"
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddShoppingItem(); } }}
                placeholder="Aggiungi prodotto…"
                className="flex-1 min-w-0 bg-transparent text-sm text-[var(--color-fg)] placeholder:text-[var(--color-fg-subtle)] focus:outline-none"
              />
              <select
                value={newItemCategory}
                onChange={e => setNewItemCategory(e.target.value as ShoppingCategory)}
                className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-full px-2 py-1 text-xs font-medium text-[var(--color-fg-muted)] focus:outline-none focus:border-[var(--color-fg)] flex-shrink-0"
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
                className="flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {isAddingShoppingItem ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-4 w-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Sotto Scorta (Low Stock) */}
        <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Sotto Scorta</h2>
              <p className="tabular text-xs text-[var(--color-fg-muted)]">
                {lowStockLoading ? 'Caricamento…' : `${lowStockItems.length} ${lowStockItems.length === 1 ? 'articolo' : 'articoli'} ≤ 5`}
              </p>
            </div>
            <button
              type="button"
              onClick={onNavigateToInventario}
              className="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
              title="Vai all'inventario"
            >
              Apri
            </button>
          </div>

          <div className="flex-1 overflow-y-auto max-h-[300px] space-y-1.5">
            {lowStockLoading ? (
              <div className="py-8 text-center">
                <CookingPotLoader label="Caricamento..." size={40} />
              </div>
            ) : lowStockItems.length === 0 ? (
              <div className="py-8 text-center">
                <Package className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Tutte le scorte sono in regola</p>
              </div>
            ) : (
              lowStockItems.map(item => (
                <div
                  key={item.id}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-rose-50 dark:bg-red-950/20 border border-rose-100 dark:border-red-900/40"
                >
                  <AlertTriangle className="h-4 w-4 text-rose-600 dark:text-rose-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-rose-700 dark:text-rose-300 truncate">{item.name}</div>
                    {(item.category_name || item.area) && (
                      <div className="text-[11px] uppercase tracking-wide text-rose-500/80 dark:text-rose-400/70 truncate">
                        {[item.area, item.category_name].filter(Boolean).join(' · ')}
                      </div>
                    )}
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-semibold tabular-nums text-rose-700 dark:text-rose-300">
                      {Number.isInteger(item.total_quantity) ? item.total_quantity : item.total_quantity.toFixed(1)}
                    </div>
                    {item.unit && (
                      <div className="text-[10px] uppercase tracking-wide text-rose-500/80 dark:text-rose-400/70">{item.unit}</div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Row 4: Staff Presence */}
      <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
        <div className="mb-4">
          <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Personale in Servizio</h2>
        </div>

        {staffLoading ? (
          <div className="flex items-center justify-center py-8">
            <CookingPotLoader label="Caricamento..." size={40} />
          </div>
        ) : (
          (() => {
            const renderChip = (s: StaffMember, _isLive: boolean) => {
              const initials = `${(s.name || '').charAt(0)}${(s.surname || '').charAt(0)}`.toUpperCase();
              return (
                <div
                  key={s.id}
                  className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-xs text-[var(--color-fg)]"
                  title={s.role ? `${s.name} ${s.surname} · ${s.role}` : `${s.name} ${s.surname}`}
                >
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex items-center justify-center text-[10px] font-semibold">
                    {initials}
                  </span>
                  <span className="truncate max-w-[8rem]">{s.name}</span>
                </div>
              );
            };

            const renderShiftCard = (
              shiftKey: 'lunch' | 'dinner',
              label: string,
              icon: React.ReactNode,
              iconWrap: string,
              cardWash: string,
              liveAccent: string,
              restBorder: string,
            ) => {
              const data = staffPresence[shiftKey];
              const total = data.sala.length + data.cucina.length;
              const isLive = liveShift === shiftKey;
              return (
                <div
                  className={`relative rounded-lg p-4 transition ${
                    isLive ? `border ${cardWash} ${liveAccent} shadow-[var(--shadow-sm)]` : `border ${restBorder}`
                  }`}
                >
                  <div className="flex items-center gap-2 mb-3">
                    <div className={`w-7 h-7 rounded-md flex items-center justify-center ${iconWrap}`}>{icon}</div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-sm font-semibold text-[var(--color-fg)]">{label}</span>
                      <span className="tabular text-xs text-[var(--color-fg-muted)]">({total})</span>
                    </div>
                    {isLive && (
                      <span className="inline-flex items-center gap-1.5 ml-auto text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
                        </span>
                        In corso
                      </span>
                    )}
                  </div>
                  <div className="space-y-2.5">
                    <div>
                      <div className="text-[11px] font-medium text-[var(--color-fg-muted)] mb-1.5">
                        Sala <span className="tabular text-[var(--color-fg-subtle)]">({data.sala.length})</span>
                      </div>
                      {data.sala.length === 0 ? (
                        <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {data.sala.map(s => renderChip(s, isLive))}
                        </div>
                      )}
                    </div>
                    <div>
                      <div className="text-[11px] font-medium text-[var(--color-fg-muted)] mb-1.5">
                        Cucina <span className="tabular text-[var(--color-fg-subtle)]">({data.cucina.length})</span>
                      </div>
                      {data.cucina.length === 0 ? (
                        <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {data.cucina.map(s => renderChip(s, isLive))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            };

            const showLunchPersonale = globalShiftFilter === 'ALL' || globalShiftFilter === 'LUNCH';
            const showDinnerPersonale = globalShiftFilter === 'ALL' || globalShiftFilter === 'DINNER';
            return (
              <div className={`grid grid-cols-1 ${(showLunchPersonale && showDinnerPersonale) ? 'md:grid-cols-2' : 'md:grid-cols-1'} gap-4`}>
                {showLunchPersonale && renderShiftCard(
                  'lunch',
                  'Pranzo',
                  <Sun className="h-4 w-4 text-amber-700 dark:text-amber-300" />,
                  'bg-amber-100 dark:bg-amber-500/20',
                  'bg-amber-50 dark:bg-amber-500/10',
                  'border-amber-300/70 ring-1 ring-amber-200/60 dark:ring-amber-400/20',
                  'bg-amber-50 border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/20',
                )}
                {showDinnerPersonale && renderShiftCard(
                  'dinner',
                  'Cena',
                  <Sunset className="h-4 w-4 text-blue-600 dark:text-blue-400" />,
                  'bg-blue-100 dark:bg-blue-500/20',
                  'bg-blue-50 dark:bg-blue-500/10',
                  'border-blue-300/70 ring-1 ring-blue-200/60 dark:ring-blue-400/20',
                  'bg-blue-50 border-blue-200 dark:bg-blue-500/10 dark:border-blue-500/20',
                )}
              </div>
            );
          })()
        )}
      </div>

      {/* AI Report Section */}
      {report && (
        <div className="bg-[var(--color-surface)] p-4 sm:p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] animate-fade-in">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="h-4 w-4 text-[var(--color-fg-muted)]" />
            <h2 className="text-base font-semibold text-[var(--color-fg)]">Analisi AI Gemini</h2>
          </div>
          <div className="prose prose-sm max-w-none text-[var(--color-fg-muted)]">
            <ReactMarkdown>{report}</ReactMarkdown>
          </div>
        </div>
      )}

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
            ? resDate.toLocaleDateString('it-IT', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
            : '';
          const timeLabel = res.reservation_time.match(/T(\d{2}:\d{2})/)?.[1] || '';
          const closeDisabled = pendingActionBusy !== null;
          return (
            <div
              className="fixed inset-0 z-[100] flex items-center justify-center px-4"
              onClick={() => { if (!closeDisabled) setPendingModalRes(null); }}
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
                  </div>
                  <button
                    type="button"
                    onClick={() => setPendingModalRes(null)}
                    disabled={closeDisabled}
                    className="p-1 rounded-md text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors disabled:opacity-50"
                    aria-label="Chiudi"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="px-5 py-4 space-y-3">
                  <div>
                    <p className="text-base font-semibold text-[var(--color-fg)]">{res.customer_name || '—'}</p>
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

                {onOpenReservationInList && (
                  <div className="px-5 py-2 border-t border-[var(--color-line)] bg-[var(--color-surface-2)] text-center">
                    <button
                      type="button"
                      onClick={() => {
                        onOpenReservationInList(res.id);
                        setPendingModalRes(null);
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
