import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType,
  Shift, TimeOffType
} from '../types';
import { staffApiService, CreateStaffInput, CreateTimeOffInput } from '../services/staffApiService';
import { toTitleCase } from '../utils/text';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import {
  Users, UserPlus, Edit2, Trash2, X, Plus, ChevronLeft, ChevronRight,
  Calendar, Clock, Sun, Moon, Coffee, UtensilsCrossed, Check, AlertTriangle,
  Phone, Mail, FileText, Filter, Search, Loader2, ChefHat, UserCircle
} from 'lucide-react';

// ============================================
// CONSTANTS
// ============================================

const STAFF_CATEGORY_LABELS: Record<StaffCategory, string> = {
  [StaffCategory.SALA]: 'Sala',
  [StaffCategory.CUCINA]: 'Cucina'
};

const STAFF_CATEGORY_COLORS: Record<StaffCategory, string> = {
  [StaffCategory.SALA]: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-100 dark:border-emerald-500/30',
  [StaffCategory.CUCINA]: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-100 dark:border-amber-500/30'
};

const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'Fisso',
  [StaffType.STAGIONALE]: 'Stagionale',
  [StaffType.EXTRA]: 'Extra'
};

const STAFF_TYPE_COLORS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-500/30',
  [StaffType.STAGIONALE]: 'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-100 dark:border-amber-500/30',
  [StaffType.EXTRA]: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-100 dark:border-violet-500/30'
};

const TIME_OFF_LABELS: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'Riposo',
  [TimeOffType.VACANZA]: 'Vacanza',
  [TimeOffType.MALATTIA]: 'Malattia',
  [TimeOffType.PERMESSO]: 'Permesso'
};

const TIME_OFF_COLORS: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]',
  [TimeOffType.VACANZA]: 'bg-cyan-50 dark:bg-cyan-500/15 text-cyan-700 dark:text-cyan-300 border border-cyan-100 dark:border-cyan-500/30',
  [TimeOffType.MALATTIA]: 'bg-rose-50 dark:bg-rose-500/15 text-rose-700 dark:text-rose-300 border border-rose-100 dark:border-rose-500/30',
  [TimeOffType.PERMESSO]: 'bg-violet-50 dark:bg-violet-500/15 text-violet-700 dark:text-violet-300 border border-violet-100 dark:border-violet-500/30'
};

const TIME_OFF_DAY_BG: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'border-slate-300 dark:border-slate-500/40 bg-slate-100 dark:bg-slate-500/20',
  [TimeOffType.VACANZA]: 'border-cyan-300 dark:border-cyan-500/40 bg-cyan-50 dark:bg-cyan-500/15',
  [TimeOffType.MALATTIA]: 'border-rose-300 dark:border-rose-500/40 bg-rose-50 dark:bg-rose-500/15',
  [TimeOffType.PERMESSO]: 'border-violet-300 dark:border-violet-500/40 bg-violet-50 dark:bg-violet-500/15'
};

const TIME_OFF_LEGEND_DOT: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'bg-slate-300 dark:bg-slate-500/40',
  [TimeOffType.VACANZA]: 'bg-cyan-300 dark:bg-cyan-500/40',
  [TimeOffType.MALATTIA]: 'bg-rose-300 dark:bg-rose-500/40',
  [TimeOffType.PERMESSO]: 'bg-violet-300 dark:bg-violet-500/40'
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

  // Selected staff for calendar view
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null);
  const [calendarDate, setCalendarDate] = useState(new Date());

  // Modals
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [editingStaff, setEditingStaff] = useState<StaffMember | null>(null);
  const [showShiftModal, setShowShiftModal] = useState(false);
  const [showTimeOffModal, setShowTimeOffModal] = useState(false);
  const [deleteStaffConfirm, setDeleteStaffConfirm] = useState<StaffMember | null>(null);
  const [deleteTimeOffConfirm, setDeleteTimeOffConfirm] = useState<{ id: string; label: string } | null>(null);
  const [isSavingStaff, setIsSavingStaff] = useState(false);
  const [isSavingShift, setIsSavingShift] = useState(false);
  const [isSavingTimeOff, setIsSavingTimeOff] = useState(false);

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

  const salaStaff = filteredStaff.filter(s => s.category === StaffCategory.SALA);
  const cucinaStaff = filteredStaff.filter(s => s.category === StaffCategory.CUCINA);

  const STAFF_TYPE_ORDER: StaffType[] = [StaffType.FISSO, StaffType.STAGIONALE, StaffType.EXTRA];
  const groupByType = (list: StaffMember[]): { type: StaffType; members: StaffMember[] }[] =>
    STAFF_TYPE_ORDER
      .map(type => ({ type, members: list.filter(s => s.staffType === type) }))
      .filter(g => g.members.length > 0);

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
  // selected staff's "Assenze Programmate" list.
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
  };

  const handleOpenAddStaff = () => {
    resetStaffForm();
    setShowStaffModal(true);
  };

  const handleOpenEditStaff = (staff: StaffMember) => {
    setEditingStaff(staff);
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

  const handleOpenAddShift = (date?: Date) => {
    if (!selectedStaff) return;
    const targetDate = date || new Date();
    const dateStr = formatLocalDate(targetDate);
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

  const handleDeleteShift = async (id: string) => {
    try {
      await staffApiService.deleteShift(id);
      setShifts(prev => prev.filter(s => s.id !== id));
      showToast('Turno eliminato', 'success');
    } catch (error) {
      showToast('Errore nell\'eliminazione', 'error');
    }
  };

  const handleOpenAddTimeOff = () => {
    if (!selectedStaff) return;
    const today = formatLocalDate(new Date());
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
  // RENDER
  // ============================================

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-[var(--color-fg-muted)]" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      <button
        onClick={handleOpenAddStaff}
        className="w-full lg:hidden justify-center rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition flex items-center gap-2"
      >
        <UserPlus className="h-4 w-4" />
        Aggiungi Dipendente
      </button>

      {/* Filters */}
      <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-lg p-4">
        <div className="flex flex-wrap gap-3 items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)]" />
            <input
              type="text"
              placeholder="Cerca dipendente..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-2.5 bg-[var(--color-surface-2)] dark:bg-white/[0.04] border border-[var(--color-line-strong)] rounded-full text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />
          </div>

          {/* Category Filter */}
          <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full">
            <button
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                categoryFilter === 'ALL' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
              }`}
            >
              Tutti
            </button>
            <button
              onClick={() => setCategoryFilter(StaffCategory.SALA)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                categoryFilter === StaffCategory.SALA ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
              }`}
            >
              Sala
            </button>
            <button
              onClick={() => setCategoryFilter(StaffCategory.CUCINA)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                categoryFilter === StaffCategory.CUCINA ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
              }`}
            >
              Cucina
            </button>
          </div>

          {/* Type Filter */}
          <div className="inline-flex p-0.5 bg-[var(--color-surface-3)] rounded-full">
            <button
              onClick={() => setTypeFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                typeFilter === 'ALL' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
              }`}
            >
              Tutti
            </button>
            {Object.entries(STAFF_TYPE_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTypeFilter(key as StaffType)}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition ${
                  typeFilter === key ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Show Inactive Toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="w-4 h-4 rounded border-[var(--color-line)]"
            />
            <span className="text-sm text-[var(--color-fg-muted)]">Mostra inattivi</span>
          </label>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Staff Lists */}
        <div className="lg:col-span-1 space-y-6">
          {/* Sala Section */}
          <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--color-line)]">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-[var(--color-fg-muted)]" />
                <h2 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Sala</h2>
                <span className="ml-auto text-xs text-[var(--color-fg-muted)] font-medium">{salaStaff.length}</span>
              </div>
            </div>
            <div className="p-2 max-h-[400px] overflow-y-auto">
              {salaStaff.length === 0 ? (
                <p className="text-center text-[var(--color-fg-subtle)] py-4 text-sm">Nessun dipendente</p>
              ) : (
                groupByType(salaStaff).map(group => (
                  <div key={group.type} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STAFF_TYPE_COLORS[group.type]}`}>
                        {STAFF_TYPE_LABELS[group.type]}
                      </span>
                      <span className="text-[11px] text-[var(--color-fg-subtle)]">{group.members.length}</span>
                      <div className="flex-1 h-px bg-[var(--color-line)]" />
                    </div>
                    {group.members.map(staff => (
                      <div
                        key={staff.id}
                        onClick={() => setSelectedStaff(staff)}
                        className={`p-2.5 rounded-md cursor-pointer transition mb-1 ${
                          selectedStaff?.id === staff.id
                            ? 'bg-[var(--color-surface-3)] border border-[var(--color-line-strong)]'
                            : 'hover:bg-[var(--color-surface-hover)] border border-transparent'
                        } ${!staff.isActive ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg)] font-medium flex items-center justify-center text-sm">
                            {staff.name[0]?.toUpperCase()}{staff.surname[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-[var(--color-fg)] truncate text-sm">{toTitleCase(staff.name)} {toTitleCase(staff.surname)}</p>
                            <p className="text-xs text-[var(--color-fg-muted)]">{staff.role || 'Cameriere'}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Cucina Section */}
          <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
            <div className="px-4 py-3 border-b border-[var(--color-line)]">
              <div className="flex items-center gap-2">
                <ChefHat className="h-4 w-4 text-[var(--color-fg-muted)]" />
                <h2 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Cucina</h2>
                <span className="ml-auto text-xs text-[var(--color-fg-muted)] font-medium">{cucinaStaff.length}</span>
              </div>
            </div>
            <div className="p-2 max-h-[400px] overflow-y-auto">
              {cucinaStaff.length === 0 ? (
                <p className="text-center text-[var(--color-fg-subtle)] py-4 text-sm">Nessun dipendente</p>
              ) : (
                groupByType(cucinaStaff).map(group => (
                  <div key={group.type} className="mb-3 last:mb-0">
                    <div className="flex items-center gap-2 px-2 py-1.5 mb-1">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STAFF_TYPE_COLORS[group.type]}`}>
                        {STAFF_TYPE_LABELS[group.type]}
                      </span>
                      <span className="text-[11px] text-[var(--color-fg-subtle)]">{group.members.length}</span>
                      <div className="flex-1 h-px bg-[var(--color-line)]" />
                    </div>
                    {group.members.map(staff => (
                      <div
                        key={staff.id}
                        onClick={() => setSelectedStaff(staff)}
                        className={`p-2.5 rounded-md cursor-pointer transition mb-1 ${
                          selectedStaff?.id === staff.id
                            ? 'bg-[var(--color-surface-3)] border border-[var(--color-line-strong)]'
                            : 'hover:bg-[var(--color-surface-hover)] border border-transparent'
                        } ${!staff.isActive ? 'opacity-50' : ''}`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg)] font-medium flex items-center justify-center text-sm">
                            {staff.name[0]?.toUpperCase()}{staff.surname[0]?.toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-[var(--color-fg)] truncate text-sm">{toTitleCase(staff.name)} {toTitleCase(staff.surname)}</p>
                            <p className="text-xs text-[var(--color-fg-muted)]">{staff.role || 'Cuoco'}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Staff Detail & Calendar */}
        <div className="lg:col-span-2">
          {selectedStaff ? (
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
              {/* Staff Detail Header */}
              <div className="px-5 py-4 border-b border-[var(--color-line)]">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 rounded-lg bg-[var(--color-surface-3)] text-[var(--color-fg)] flex items-center justify-center text-xl font-medium">
                    {selectedStaff.name[0]?.toUpperCase()}{selectedStaff.surname[0]?.toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">{toTitleCase(selectedStaff.name)} {toTitleCase(selectedStaff.surname)}</h2>
                      {!selectedStaff.isActive && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]">Inattivo</span>
                      )}
                    </div>
                    <p className="text-sm text-[var(--color-fg-muted)]">{selectedStaff.role || (selectedStaff.category === StaffCategory.SALA ? 'Cameriere' : 'Cuoco')}</p>
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${STAFF_CATEGORY_COLORS[selectedStaff.category]}`}>
                        {STAFF_CATEGORY_LABELS[selectedStaff.category]}
                      </span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${STAFF_TYPE_COLORS[selectedStaff.staffType]}`}>
                        {STAFF_TYPE_LABELS[selectedStaff.staffType]}
                      </span>
                      {selectedStaff.weeklyRestDay !== undefined && selectedStaff.weeklyRestDay !== null && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]">
                          Riposo: {WEEKDAY_LABELS[selectedStaff.weeklyRestDay]}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => handleOpenEditStaff(selectedStaff)}
                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"
                    >
                      <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleToggleStaffActive(selectedStaff)}
                      className={`p-1.5 rounded-md hover:bg-[var(--color-surface-hover)] ${
                        selectedStaff.isActive
                          ? 'text-[var(--color-fg-muted)] hover:text-amber-600'
                          : 'text-emerald-600'
                      }`}
                    >
                      {selectedStaff.isActive ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                    </button>
                    <button
                      onClick={() => setDeleteStaffConfirm(selectedStaff)}
                      className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Contact Info */}
                <div className="flex gap-4 mt-3 text-sm">
                  {selectedStaff.phone && (
                    <div className="flex items-center gap-1.5 text-[var(--color-fg-muted)]">
                      <Phone className="h-3.5 w-3.5" />
                      {selectedStaff.phone}
                    </div>
                  )}
                  {selectedStaff.email && (
                    <div className="flex items-center gap-1.5 text-[var(--color-fg-muted)]">
                      <Mail className="h-3.5 w-3.5" />
                      {selectedStaff.email}
                    </div>
                  )}
                </div>
              </div>

              {/* Calendar Navigation */}
              <div className="px-4 py-3 border-b border-[var(--color-line)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button onClick={goToPreviousMonth} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]">
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-medium text-[var(--color-fg)] min-w-[150px] text-center capitalize">
                    {calendarDate.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}
                  </span>
                  <button onClick={goToNextMonth} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                  <button onClick={goToCurrentMonth} className="ml-2 text-xs text-[var(--color-fg)] hover:underline">
                    Oggi
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenAddTimeOff}
                    className="rounded-full px-3 py-1.5 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-xs font-medium hover:bg-[var(--color-surface-hover)] transition flex items-center gap-1"
                  >
                    <Calendar className="h-3.5 w-3.5" />
                    Assenza
                  </button>
                  <button
                    onClick={() => handleOpenAddShift()}
                    className="rounded-full px-3 py-1.5 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-xs font-medium hover:opacity-90 transition flex items-center gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Turno
                  </button>
                </div>
              </div>

              {/* Calendar Grid */}
              <div className="p-4 overflow-x-auto">
                <div className="min-w-[560px]">
                {/* Day Headers */}
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(day => (
                    <div key={day} className="text-center text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] py-2">
                      {day}
                    </div>
                  ))}
                </div>

                {/* Calendar Days */}
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((day, idx) => {
                    const isCurrentMonth = day.getMonth() === calendarDate.getMonth();
                    const isToday = day.toDateString() === new Date().toDateString();
                    const dateStr = formatLocalDate(day);
                    const dayShifts = getShiftsForDay(day, selectedStaff.id);
                    const dayTimeOff = getTimeOffForDay(day, selectedStaff.id);
                    const lunchShift = dayShifts.find(s => s.shift === Shift.LUNCH);
                    const dinnerShift = dayShifts.find(s => s.shift === Shift.DINNER);

                    // A time-off entry can be full-day (shift=null) or scoped to a single shift.
                    const timeOffShift = dayTimeOff?.shift ?? null;
                    const isFullDayOff = !!dayTimeOff && timeOffShift === null;
                    const lunchOff = !!dayTimeOff && (timeOffShift === null || timeOffShift === Shift.LUNCH);
                    const dinnerOff = !!dayTimeOff && (timeOffShift === null || timeOffShift === Shift.DINNER);

                    const isWeeklyRest = selectedStaff.weeklyRestDay !== undefined
                      && selectedStaff.weeklyRestDay !== null
                      && day.getDay() === selectedStaff.weeklyRestDay;

                    const inHirePeriod = hasAutoShifts(selectedStaff)
                      && !isWeeklyRest
                      && isWithinHirePeriod(selectedStaff, dateStr);

                    // Show shift if explicit DB row exists OR FISSO implicit presence applies (and not on time-off for that shift)
                    const showLunch = !!lunchShift || (inHirePeriod && !lunchOff);
                    const lunchPresent = lunchShift ? lunchShift.present : inHirePeriod;
                    const lunchImplicit = !lunchShift && inHirePeriod;

                    const showDinner = !!dinnerShift || (inHirePeriod && !dinnerOff);
                    const dinnerPresent = dinnerShift ? dinnerShift.present : inHirePeriod;
                    const dinnerImplicit = !dinnerShift && inHirePeriod;

                    const dayBgClass = !isCurrentMonth
                      ? 'border-transparent bg-slate-50/50 opacity-40'
                      : isFullDayOff
                        ? TIME_OFF_DAY_BG[dayTimeOff!.type]
                        : isWeeklyRest && !lunchShift && !dinnerShift
                          ? 'border-slate-300 dark:border-slate-500/40 bg-slate-100 dark:bg-slate-500/20'
                          : isToday
                            ? 'border-indigo-300 dark:border-[#4f46e5]/40 bg-indigo-50 dark:bg-[#4f46e5]/15'
                            : 'border-slate-100 dark:border-slate-500/30 hover:border-slate-200 dark:hover:border-slate-500/30 hover:bg-slate-50 dark:hover:bg-slate-500/15';

                    return (
                      <div
                        key={idx}
                        onClick={() => handleOpenAddShift(day)}
                        className={`min-h-[72px] p-1.5 rounded-lg border cursor-pointer transition-all flex flex-col ${dayBgClass}`}
                      >
                        <div className={`text-xs font-semibold mb-1 ${isToday ? 'text-indigo-600 dark:text-[#818cf8]' : 'text-slate-700 dark:text-slate-300'}`}>
                          {day.getDate()}
                        </div>

                        {isFullDayOff ? (
                          <div className={`text-[9px] font-medium px-1 py-0.5 rounded text-center ${TIME_OFF_COLORS[dayTimeOff!.type]}`}>
                            {TIME_OFF_LABELS[dayTimeOff!.type]}
                          </div>
                        ) : isWeeklyRest && !showLunch && !showDinner ? (
                          <div className="text-[9px] font-medium px-1 py-0.5 rounded text-center bg-slate-200 dark:bg-slate-500/25 text-slate-700 dark:text-slate-300">
                            Riposo
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {lunchOff && !lunchShift ? (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-medium px-1 py-0.5 rounded ${TIME_OFF_COLORS[dayTimeOff!.type]}`}
                                title={`${TIME_OFF_LABELS[dayTimeOff!.type]} — Pranzo`}
                              >
                                <Sun className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{TIME_OFF_LABELS[dayTimeOff!.type]}</span>
                              </div>
                            ) : showLunch && (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-semibold px-1 py-0.5 rounded ${
                                  lunchPresent
                                    ? lunchImplicit
                                      ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-dashed border-amber-300 dark:border-amber-500/40'
                                      : 'bg-amber-200 dark:bg-amber-500/25 text-amber-800 dark:text-amber-200'
                                    : 'bg-slate-100 dark:bg-slate-500/20 text-slate-400 dark:text-slate-500 line-through'
                                }`}
                                title={
                                  lunchImplicit ? `Presenza automatica (${STAFF_TYPE_LABELS[selectedStaff.staffType]}) — Pranzo`
                                  : lunchPresent ? 'Presente a Pranzo'
                                  : 'Assente a Pranzo'
                                }
                              >
                                <Sun className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">Pranzo</span>
                              </div>
                            )}
                            {dinnerOff && !dinnerShift ? (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-medium px-1 py-0.5 rounded ${TIME_OFF_COLORS[dayTimeOff!.type]}`}
                                title={`${TIME_OFF_LABELS[dayTimeOff!.type]} — Cena`}
                              >
                                <Moon className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">{TIME_OFF_LABELS[dayTimeOff!.type]}</span>
                              </div>
                            ) : showDinner && (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-semibold px-1 py-0.5 rounded ${
                                  dinnerPresent
                                    ? dinnerImplicit
                                      ? 'bg-indigo-100 dark:bg-[#4f46e5]/20 text-indigo-700 dark:text-[#a5b4fc] border border-dashed border-indigo-300 dark:border-[#4f46e5]/40'
                                      : 'bg-indigo-200 dark:bg-[#4f46e5]/25 text-indigo-800 dark:text-[#c7d2fe]'
                                    : 'bg-slate-100 dark:bg-slate-500/20 text-slate-400 dark:text-slate-500 line-through'
                                }`}
                                title={
                                  dinnerImplicit ? `Presenza automatica (${STAFF_TYPE_LABELS[selectedStaff.staffType]}) — Cena`
                                  : dinnerPresent ? 'Presente a Cena'
                                  : 'Assente a Cena'
                                }
                              >
                                <Moon className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">Cena</span>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                </div>

                {/* Legend */}
                <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 justify-center text-xs text-slate-500 dark:text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-amber-200 dark:bg-amber-500/25 rounded-sm flex items-center justify-center">
                      <Sun className="h-2 w-2 text-amber-800 dark:text-amber-200" />
                    </div>
                    Presente Pranzo
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-indigo-200 dark:bg-[#4f46e5]/25 rounded-sm flex items-center justify-center">
                      <Moon className="h-2 w-2 text-indigo-800 dark:text-[#c7d2fe]" />
                    </div>
                    Presente Cena
                  </div>
                  {hasAutoShifts(selectedStaff) && (
                    <div className="flex items-center gap-1.5">
                      <div className="w-3 h-3 bg-amber-100 dark:bg-amber-500/20 rounded-sm border border-dashed border-amber-300 dark:border-amber-500/40" />
                      Auto ({STAFF_TYPE_LABELS[selectedStaff.staffType]})
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-slate-100 dark:bg-slate-500/20 rounded-sm border border-slate-200 dark:border-slate-500/30" />
                    Assente
                  </div>
                  {Object.entries(TIME_OFF_LABELS).map(([key, label]) => (
                    <div key={key} className="flex items-center gap-1.5">
                      <div className={`w-3 h-3 rounded-sm ${TIME_OFF_LEGEND_DOT[key as TimeOffType]}`} />
                      {label}
                    </div>
                  ))}
                </div>
              </div>

              {/* Time Off List */}
              {timeOffsByMonth.length > 0 && (
                <div className="px-4 pb-4">
                  <h3 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-2">Assenze Programmate</h3>
                  <div className="space-y-3">
                    {timeOffsByMonth.map(group => (
                      <div key={group.key}>
                        <div className="text-[10px] tracking-[0.06em] font-semibold uppercase text-[var(--color-fg-subtle)] mb-1.5 px-0.5">
                          {group.label}
                        </div>
                        <div className="space-y-1.5">
                          {group.items.map(timeOff => (
                            <div key={timeOff.id} className="flex items-center justify-between p-2 bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-md">
                              <div className="flex items-center gap-2">
                                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium ${TIME_OFF_COLORS[timeOff.type]}`}>
                                  {TIME_OFF_LABELS[timeOff.type]}
                                </span>
                                {timeOff.shift && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]">
                                    {timeOff.shift === Shift.LUNCH ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
                                    {timeOff.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'}
                                  </span>
                                )}
                                <span className="text-sm text-[var(--color-fg-muted)]">
                                  {formatTimeOffDayLabel(timeOff, group.key)}
                                </span>
                              </div>
                              <button
                                onClick={() => {
                                  const dateRange = timeOff.startDate === timeOff.endDate
                                    ? new Date(timeOff.startDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })
                                    : `${new Date(timeOff.startDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} - ${new Date(timeOff.endDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
                                  setDeleteTimeOffConfirm({ id: timeOff.id, label: `${TIME_OFF_LABELS[timeOff.type]} · ${dateRange}` });
                                }}
                                className="p-1 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 dark:hover:bg-rose-500/15 hover:text-rose-600"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] flex items-center justify-center h-[500px]">
              <div className="text-center">
                <UserCircle className="h-12 w-12 text-[var(--color-fg-subtle)] mx-auto mb-3" />
                <p className="text-sm text-[var(--color-fg-muted)]">Seleziona un dipendente per vedere i dettagli</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Staff Modal */}
      {showStaffModal && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => { setShowStaffModal(false); resetStaffForm(); }}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-lg h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {editingStaff ? 'Modifica Dipendente' : 'Nuovo Dipendente'}
              </h3>
              <button onClick={() => { setShowStaffModal(false); resetStaffForm(); }} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome *</label>
                  <input
                    type="text"
                    value={staffForm.name}
                    onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    placeholder="Mario"
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Cognome *</label>
                  <input
                    type="text"
                    value={staffForm.surname}
                    onChange={(e) => setStaffForm({ ...staffForm, surname: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    placeholder="Rossi"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Categoria *</label>
                  <select
                    value={staffForm.category}
                    onChange={(e) => setStaffForm({ ...staffForm, category: e.target.value as StaffCategory })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    {Object.entries(STAFF_CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Tipo *</label>
                  <select
                    value={staffForm.staffType}
                    onChange={(e) => setStaffForm({ ...staffForm, staffType: e.target.value as StaffType })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    {Object.entries(STAFF_TYPE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Ruolo</label>
                <input
                  type="text"
                  value={staffForm.role}
                  onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  placeholder="es. Chef, Cameriere, Lavapiatti"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Telefono</label>
                  <input
                    type="tel"
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    placeholder="+39 333 1234567"
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Email</label>
                  <input
                    type="email"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                    placeholder="mario@esempio.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Data Assunzione</label>
                  <input
                    type="date"
                    value={staffForm.hireDate}
                    onChange={(e) => setStaffForm({ ...staffForm, hireDate: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Fine Contratto</label>
                  <input
                    type="date"
                    value={staffForm.contractEndDate}
                    onChange={(e) => setStaffForm({ ...staffForm, contractEndDate: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Giorno di Riposo Settimanale</label>
                <select
                  value={staffForm.weeklyRestDay ?? ''}
                  onChange={(e) => setStaffForm({
                    ...staffForm,
                    weeklyRestDay: e.target.value === '' ? null : Number(e.target.value)
                  })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="">Nessuno</option>
                  {WEEKDAY_LABELS.map((label, idx) => (
                    <option key={idx} value={idx}>{label}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note</label>
                <textarea
                  value={staffForm.notes}
                  onChange={(e) => setStaffForm({ ...staffForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-500/40 p-2.5 focus:ring-2 focus:ring-indigo-500 dark:focus:ring-[#818cf8] outline-none h-20 resize-none"
                  placeholder="Note aggiuntive..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row sm:justify-end gap-2">
              <button
                onClick={() => { setShowStaffModal(false); resetStaffForm(); }}
                className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveStaff}
                disabled={isSavingStaff}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingStaff && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingStaff ? 'Salva' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Shift Modal */}
      {showShiftModal && (() => {
        const modalExistingShifts = shifts.filter(s => s.staffId === shiftForm.staffId && toDateOnly(s.date) === shiftForm.date);
        const hasExistingShifts = modalExistingShifts.length > 0;
        return (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => setShowShiftModal(false)}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-sm h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">{hasExistingShifts ? 'Modifica Turni' : 'Aggiungi Turno'}</h3>
              <button onClick={() => setShowShiftModal(false)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Data</label>
                <input
                  type="date"
                  value={shiftForm.date}
                  onChange={(e) => setShiftForm({ ...shiftForm, date: e.target.value })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)]">Turno</label>
                  <button
                    type="button"
                    onClick={() => setShiftForm({ ...shiftForm, lunch: false, dinner: false })}
                    disabled={!shiftForm.lunch && !shiftForm.dinner}
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] text-[11px] font-medium hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--color-surface)] disabled:hover:text-[var(--color-fg-muted)]"
                  >
                    <X className="h-3 w-3" />
                    Deseleziona tutto
                  </button>
                </div>
                <p className="text-[11px] text-[var(--color-fg-subtle)] mb-2">Seleziona uno o entrambi i turni</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShiftForm({ ...shiftForm, lunch: !shiftForm.lunch })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md border text-sm font-medium transition ${
                      shiftForm.lunch
                        ? 'border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300'
                        : 'border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {shiftForm.lunch && <Check className="h-4 w-4" />}
                    <Sun className="h-4 w-4" />
                    Pranzo
                  </button>
                  <button
                    type="button"
                    onClick={() => setShiftForm({ ...shiftForm, dinner: !shiftForm.dinner })}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 rounded-md border text-sm font-medium transition ${
                      shiftForm.dinner
                        ? 'border-indigo-200 dark:border-[#4f46e5]/30 bg-indigo-50 dark:bg-[#4f46e5]/15 text-indigo-700 dark:text-[#a5b4fc]'
                        : 'border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {shiftForm.dinner && <Check className="h-4 w-4" />}
                    <Moon className="h-4 w-4" />
                    Cena
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note</label>
                <input
                  type="text"
                  value={shiftForm.notes}
                  onChange={(e) => setShiftForm({ ...shiftForm, notes: e.target.value })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  placeholder="Note opzionali..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row sm:justify-end gap-2">
              <button
                onClick={() => setShowShiftModal(false)}
                className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveShift}
                disabled={isSavingShift}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingShift && <Loader2 className="h-4 w-4 animate-spin" />}
                {hasExistingShifts ? 'Aggiorna turni' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* Add Time Off Modal */}
      {showTimeOffModal && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => setShowTimeOffModal(false)}>
          <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-sm h-full sm:max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Registra Assenza</h3>
              <button onClick={() => setShowTimeOffModal(false)} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-4 flex-1 overflow-y-auto">
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Tipo</label>
                <select
                  value={timeOffForm.type}
                  onChange={(e) => setTimeOffForm({ ...timeOffForm, type: e.target.value as TimeOffType })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  {Object.entries(TIME_OFF_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Turno</label>
                <select
                  value={timeOffForm.shift ?? 'ALL'}
                  onChange={(e) => {
                    const v = e.target.value;
                    setTimeOffForm({ ...timeOffForm, shift: v === 'ALL' ? null : (v as Shift) });
                  }}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                >
                  <option value="ALL">Tutto il giorno</option>
                  <option value={Shift.LUNCH}>Solo Pranzo</option>
                  <option value={Shift.DINNER}>Solo Cena</option>
                </select>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Da</label>
                  <input
                    type="date"
                    value={timeOffForm.startDate}
                    onChange={(e) => setTimeOffForm({ ...timeOffForm, startDate: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  />
                </div>
                <div>
                  <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">A</label>
                  <input
                    type="date"
                    value={timeOffForm.endDate}
                    onChange={(e) => setTimeOffForm({ ...timeOffForm, endDate: e.target.value })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[12px] tracking-[0.02em] font-medium text-[var(--color-fg-subtle)] mb-1">Note</label>
                <input
                  type="text"
                  value={timeOffForm.notes}
                  onChange={(e) => setTimeOffForm({ ...timeOffForm, notes: e.target.value })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  placeholder="Note opzionali..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row sm:justify-end gap-2">
              <button
                onClick={() => setShowTimeOffModal(false)}
                className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveTimeOff}
                disabled={isSavingTimeOff}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSavingTimeOff && <Loader2 className="h-4 w-4 animate-spin" />}
                Registra
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteStaffConfirm}
        title="Elimina Dipendente"
        message="Stai per eliminare il dipendente:"
        itemName={deleteStaffConfirm ? `${toTitleCase(deleteStaffConfirm.name)} ${toTitleCase(deleteStaffConfirm.surname)}` : undefined}
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
    </div>
  );
};
