import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType,
  Shift, TimeOffType
} from '../types';
import { staffApiService, CreateStaffInput, CreateTimeOffInput } from '../services/staffApiService';
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
  [StaffCategory.SALA]: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  [StaffCategory.CUCINA]: 'bg-orange-100 text-orange-700 border-orange-200'
};

const STAFF_TYPE_LABELS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'Fisso',
  [StaffType.STAGIONALE]: 'Stagionale',
  [StaffType.EXTRA]: 'Extra'
};

const STAFF_TYPE_COLORS: Record<StaffType, string> = {
  [StaffType.FISSO]: 'bg-blue-100 text-blue-700',
  [StaffType.STAGIONALE]: 'bg-amber-100 text-amber-700',
  [StaffType.EXTRA]: 'bg-purple-100 text-purple-700'
};

const TIME_OFF_LABELS: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'Riposo',
  [TimeOffType.VACANZA]: 'Vacanza',
  [TimeOffType.MALATTIA]: 'Malattia',
  [TimeOffType.PERMESSO]: 'Permesso'
};

const TIME_OFF_COLORS: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'bg-slate-200 text-slate-700',
  [TimeOffType.VACANZA]: 'bg-cyan-100 text-cyan-700',
  [TimeOffType.MALATTIA]: 'bg-rose-100 text-rose-700',
  [TimeOffType.PERMESSO]: 'bg-violet-100 text-violet-700'
};

const TIME_OFF_DAY_BG: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'border-slate-300 bg-slate-100',
  [TimeOffType.VACANZA]: 'border-cyan-300 bg-cyan-50',
  [TimeOffType.MALATTIA]: 'border-rose-300 bg-rose-50',
  [TimeOffType.PERMESSO]: 'border-violet-300 bg-violet-50'
};

const TIME_OFF_LEGEND_DOT: Record<TimeOffType, string> = {
  [TimeOffType.RIPOSO]: 'bg-slate-300',
  [TimeOffType.VACANZA]: 'bg-cyan-300',
  [TimeOffType.MALATTIA]: 'bg-rose-300',
  [TimeOffType.PERMESSO]: 'bg-violet-300'
};

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
}

export const StaffManagement: React.FC<StaffManagementProps> = ({ showToast }) => {
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
    notes: '',
    approved: true
  });

  // ============================================
  // DATA FETCHING
  // ============================================

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
      showToast('Errore nel caricamento del personale', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

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
      notes: staff.notes || ''
    });
    setShowStaffModal(true);
  };

  const handleSaveStaff = async () => {
    if (!staffForm.name.trim() || !staffForm.surname.trim()) {
      showToast('Nome e cognome sono obbligatori', 'error');
      return;
    }

    try {
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
    }
  };

  const handleDeleteStaff = async (id: string) => {
    if (!confirm('Sei sicuro di voler eliminare questo dipendente?')) return;

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
    setShiftForm({
      staffId: selectedStaff.id,
      date: formatLocalDate(date || new Date()),
      lunch: true,
      dinner: false,
      present: true,
      notes: ''
    });
    setShowShiftModal(true);
  };

  const handleSaveShift = async () => {
    if (!shiftForm.lunch && !shiftForm.dinner) {
      showToast('Seleziona almeno un turno (Pranzo o Cena)', 'error');
      return;
    }

    const shiftsToCreate: Shift[] = [];
    if (shiftForm.lunch) shiftsToCreate.push(Shift.LUNCH);
    if (shiftForm.dinner) shiftsToCreate.push(Shift.DINNER);

    try {
      const created = await Promise.all(
        shiftsToCreate.map(shift =>
          staffApiService.createShift({
            staffId: shiftForm.staffId,
            date: shiftForm.date,
            shift,
            present: shiftForm.present,
            notes: shiftForm.notes
          })
        )
      );
      setShifts(prev => {
        // Replace existing shifts for the same staff/date/shift, append new ones
        const filtered = prev.filter(s => !created.some(c =>
          c.staffId === s.staffId && c.date === s.date && c.shift === s.shift
        ));
        return [...filtered, ...created];
      });
      setShowShiftModal(false);
      showToast(
        shiftsToCreate.length === 2 ? 'Turni Pranzo e Cena aggiunti' : 'Turno aggiunto',
        'success'
      );
    } catch (error) {
      showToast('Errore nel salvataggio del turno', 'error');
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
      notes: '',
      approved: true
    });
    setShowTimeOffModal(true);
  };

  const handleSaveTimeOff = async () => {
    try {
      const created = await staffApiService.createTimeOff(timeOffForm);
      setTimeOffs(prev => [...prev, created]);
      setShowTimeOffModal(false);
      showToast('Assenza registrata', 'success');
    } catch (error) {
      showToast('Errore nel salvataggio', 'error');
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
        <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl lg:text-4xl font-bold text-slate-800">Personale</h1>
          <p className="text-slate-500">Gestione dipendenti, turni e assenze</p>
        </div>
        <button
          onClick={handleOpenAddStaff}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
        >
          <UserPlus className="h-5 w-5" />
          Aggiungi Dipendente
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex flex-wrap gap-4 items-center">
          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <input
              type="text"
              placeholder="Cerca dipendente..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
            />
          </div>

          {/* Category Filter */}
          <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
            <button
              onClick={() => setCategoryFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                categoryFilter === 'ALL' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Tutti
            </button>
            <button
              onClick={() => setCategoryFilter(StaffCategory.SALA)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                categoryFilter === StaffCategory.SALA ? 'bg-emerald-100 text-emerald-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Sala
            </button>
            <button
              onClick={() => setCategoryFilter(StaffCategory.CUCINA)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                categoryFilter === StaffCategory.CUCINA ? 'bg-orange-100 text-orange-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Cucina
            </button>
          </div>

          {/* Type Filter */}
          <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
            <button
              onClick={() => setTypeFilter('ALL')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                typeFilter === 'ALL' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Tutti
            </button>
            {Object.entries(STAFF_TYPE_LABELS).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTypeFilter(key as StaffType)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  typeFilter === key ? `${STAFF_TYPE_COLORS[key as StaffType]} shadow-sm` : 'text-slate-500 hover:text-slate-700'
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
              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm text-slate-600">Mostra inattivi</span>
          </label>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Staff Lists */}
        <div className="lg:col-span-1 space-y-6">
          {/* Sala Section */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 bg-gradient-to-r from-emerald-50 to-teal-50 border-b border-emerald-100">
              <div className="flex items-center gap-2">
                <Users className="h-5 w-5 text-emerald-600" />
                <h2 className="font-semibold text-emerald-800">Sala</h2>
                <span className="ml-auto text-sm text-emerald-600 font-medium">{salaStaff.length}</span>
              </div>
            </div>
            <div className="p-2 max-h-[300px] overflow-y-auto">
              {salaStaff.length === 0 ? (
                <p className="text-center text-slate-400 py-4 text-sm">Nessun dipendente</p>
              ) : (
                salaStaff.map(staff => (
                  <div
                    key={staff.id}
                    onClick={() => setSelectedStaff(staff)}
                    className={`p-3 rounded-xl cursor-pointer transition-all mb-1 ${
                      selectedStaff?.id === staff.id
                        ? 'bg-emerald-100 border border-emerald-200'
                        : 'hover:bg-slate-50 border border-transparent'
                    } ${!staff.isActive ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-600 font-semibold">
                        {staff.name[0]}{staff.surname[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 truncate">{staff.name} {staff.surname}</p>
                        <p className="text-xs text-slate-500">{staff.role || 'Cameriere'}</p>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${STAFF_TYPE_COLORS[staff.staffType]}`}>
                        {STAFF_TYPE_LABELS[staff.staffType]}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Cucina Section */}
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="p-4 bg-gradient-to-r from-orange-50 to-amber-50 border-b border-orange-100">
              <div className="flex items-center gap-2">
                <ChefHat className="h-5 w-5 text-orange-600" />
                <h2 className="font-semibold text-orange-800">Cucina</h2>
                <span className="ml-auto text-sm text-orange-600 font-medium">{cucinaStaff.length}</span>
              </div>
            </div>
            <div className="p-2 max-h-[300px] overflow-y-auto">
              {cucinaStaff.length === 0 ? (
                <p className="text-center text-slate-400 py-4 text-sm">Nessun dipendente</p>
              ) : (
                cucinaStaff.map(staff => (
                  <div
                    key={staff.id}
                    onClick={() => setSelectedStaff(staff)}
                    className={`p-3 rounded-xl cursor-pointer transition-all mb-1 ${
                      selectedStaff?.id === staff.id
                        ? 'bg-orange-100 border border-orange-200'
                        : 'hover:bg-slate-50 border border-transparent'
                    } ${!staff.isActive ? 'opacity-50' : ''}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center text-orange-600 font-semibold">
                        {staff.name[0]}{staff.surname[0]}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-slate-800 truncate">{staff.name} {staff.surname}</p>
                        <p className="text-xs text-slate-500">{staff.role || 'Cuoco'}</p>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${STAFF_TYPE_COLORS[staff.staffType]}`}>
                        {STAFF_TYPE_LABELS[staff.staffType]}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Staff Detail & Calendar */}
        <div className="lg:col-span-2">
          {selectedStaff ? (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
              {/* Staff Detail Header */}
              <div className={`p-6 ${selectedStaff.category === StaffCategory.SALA ? 'bg-gradient-to-r from-emerald-50 to-teal-50' : 'bg-gradient-to-r from-orange-50 to-amber-50'}`}>
                <div className="flex items-start gap-4">
                  <div className={`w-16 h-16 rounded-2xl flex items-center justify-center text-2xl font-bold ${
                    selectedStaff.category === StaffCategory.SALA ? 'bg-emerald-200 text-emerald-700' : 'bg-orange-200 text-orange-700'
                  }`}>
                    {selectedStaff.name[0]}{selectedStaff.surname[0]}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-xl font-bold text-slate-800">{selectedStaff.name} {selectedStaff.surname}</h2>
                      {!selectedStaff.isActive && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">Inattivo</span>
                      )}
                    </div>
                    <p className="text-slate-600">{selectedStaff.role || (selectedStaff.category === StaffCategory.SALA ? 'Cameriere' : 'Cuoco')}</p>
                    <div className="flex gap-2 mt-2">
                      <span className={`text-xs px-2 py-1 rounded-full border ${STAFF_CATEGORY_COLORS[selectedStaff.category]}`}>
                        {STAFF_CATEGORY_LABELS[selectedStaff.category]}
                      </span>
                      <span className={`text-xs px-2 py-1 rounded-full ${STAFF_TYPE_COLORS[selectedStaff.staffType]}`}>
                        {STAFF_TYPE_LABELS[selectedStaff.staffType]}
                      </span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleOpenEditStaff(selectedStaff)}
                      className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-white rounded-lg transition-colors"
                    >
                      <Edit2 className="h-5 w-5" />
                    </button>
                    <button
                      onClick={() => handleToggleStaffActive(selectedStaff)}
                      className={`p-2 rounded-lg transition-colors ${
                        selectedStaff.isActive
                          ? 'text-slate-500 hover:text-amber-600 hover:bg-white'
                          : 'text-emerald-600 hover:bg-white'
                      }`}
                    >
                      {selectedStaff.isActive ? <AlertTriangle className="h-5 w-5" /> : <Check className="h-5 w-5" />}
                    </button>
                    <button
                      onClick={() => handleDeleteStaff(selectedStaff.id)}
                      className="p-2 text-slate-500 hover:text-rose-600 hover:bg-white rounded-lg transition-colors"
                    >
                      <Trash2 className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                {/* Contact Info */}
                <div className="flex gap-4 mt-4 text-sm">
                  {selectedStaff.phone && (
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Phone className="h-4 w-4" />
                      {selectedStaff.phone}
                    </div>
                  )}
                  {selectedStaff.email && (
                    <div className="flex items-center gap-1.5 text-slate-600">
                      <Mail className="h-4 w-4" />
                      {selectedStaff.email}
                    </div>
                  )}
                </div>
              </div>

              {/* Calendar Navigation */}
              <div className="p-4 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button onClick={goToPreviousMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
                    <ChevronLeft className="h-5 w-5 text-slate-600" />
                  </button>
                  <span className="font-semibold text-slate-800 min-w-[150px] text-center capitalize">
                    {calendarDate.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}
                  </span>
                  <button onClick={goToNextMonth} className="p-1.5 hover:bg-slate-100 rounded-lg">
                    <ChevronRight className="h-5 w-5 text-slate-600" />
                  </button>
                  <button onClick={goToCurrentMonth} className="ml-2 text-xs text-indigo-600 hover:underline">
                    Oggi
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleOpenAddTimeOff}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
                  >
                    <Calendar className="h-4 w-4" />
                    Assenza
                  </button>
                  <button
                    onClick={() => handleOpenAddShift()}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-indigo-100 text-indigo-700 rounded-lg hover:bg-indigo-200 transition-colors"
                  >
                    <Plus className="h-4 w-4" />
                    Turno
                  </button>
                </div>
              </div>

              {/* Calendar Grid */}
              <div className="p-4">
                {/* Day Headers */}
                <div className="grid grid-cols-7 gap-1 mb-2">
                  {['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(day => (
                    <div key={day} className="text-center text-xs font-medium text-slate-500 py-2">
                      {day}
                    </div>
                  ))}
                </div>

                {/* Calendar Days */}
                <div className="grid grid-cols-7 gap-1">
                  {calendarDays.map((day, idx) => {
                    const isCurrentMonth = day.getMonth() === calendarDate.getMonth();
                    const isToday = day.toDateString() === new Date().toDateString();
                    const dayShifts = getShiftsForDay(day, selectedStaff.id);
                    const dayTimeOff = getTimeOffForDay(day, selectedStaff.id);
                    const lunchShift = dayShifts.find(s => s.shift === Shift.LUNCH);
                    const dinnerShift = dayShifts.find(s => s.shift === Shift.DINNER);

                    const dayBgClass = !isCurrentMonth
                      ? 'border-transparent bg-slate-50/50 opacity-40'
                      : dayTimeOff
                        ? TIME_OFF_DAY_BG[dayTimeOff.type]
                        : isToday
                          ? 'border-indigo-300 bg-indigo-50'
                          : 'border-slate-100 hover:border-slate-200 hover:bg-slate-50';

                    return (
                      <div
                        key={idx}
                        onClick={() => handleOpenAddShift(day)}
                        className={`min-h-[72px] p-1.5 rounded-lg border cursor-pointer transition-all flex flex-col ${dayBgClass}`}
                      >
                        <div className={`text-xs font-semibold mb-1 ${isToday ? 'text-indigo-600' : 'text-slate-700'}`}>
                          {day.getDate()}
                        </div>

                        {dayTimeOff ? (
                          <div className={`text-[9px] font-medium px-1 py-0.5 rounded text-center ${TIME_OFF_COLORS[dayTimeOff.type]}`}>
                            {TIME_OFF_LABELS[dayTimeOff.type]}
                          </div>
                        ) : (
                          <div className="space-y-0.5">
                            {lunchShift && (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-semibold px-1 py-0.5 rounded ${
                                  lunchShift.present
                                    ? 'bg-amber-200 text-amber-800'
                                    : 'bg-slate-100 text-slate-400 line-through'
                                }`}
                                title={lunchShift.present ? 'Presente a Pranzo' : 'Assente a Pranzo'}
                              >
                                <Sun className="h-2.5 w-2.5 shrink-0" />
                                <span className="truncate">Pranzo</span>
                              </div>
                            )}
                            {dinnerShift && (
                              <div
                                className={`flex items-center gap-1 text-[9px] font-semibold px-1 py-0.5 rounded ${
                                  dinnerShift.present
                                    ? 'bg-indigo-200 text-indigo-800'
                                    : 'bg-slate-100 text-slate-400 line-through'
                                }`}
                                title={dinnerShift.present ? 'Presente a Cena' : 'Assente a Cena'}
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

                {/* Legend */}
                <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4 justify-center text-xs text-slate-500">
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-amber-200 rounded-sm flex items-center justify-center">
                      <Sun className="h-2 w-2 text-amber-800" />
                    </div>
                    Presente Pranzo
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-indigo-200 rounded-sm flex items-center justify-center">
                      <Moon className="h-2 w-2 text-indigo-800" />
                    </div>
                    Presente Cena
                  </div>
                  <div className="flex items-center gap-1.5">
                    <div className="w-3 h-3 bg-slate-100 rounded-sm border border-slate-200" />
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
              {timeOffs.filter(t => t.staffId === selectedStaff.id).length > 0 && (
                <div className="px-4 pb-4">
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Assenze Programmate</h3>
                  <div className="space-y-2">
                    {timeOffs.filter(t => t.staffId === selectedStaff.id).map(timeOff => (
                      <div key={timeOff.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
                        <div className="flex items-center gap-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${TIME_OFF_COLORS[timeOff.type]}`}>
                            {TIME_OFF_LABELS[timeOff.type]}
                          </span>
                          <span className="text-sm text-slate-600">
                            {new Date(timeOff.startDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                            {timeOff.startDate !== timeOff.endDate && (
                              <> - {new Date(timeOff.endDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</>
                            )}
                          </span>
                        </div>
                        <button
                          onClick={() => handleDeleteTimeOff(timeOff.id)}
                          className="p-1 text-slate-400 hover:text-rose-500"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex items-center justify-center h-[500px]">
              <div className="text-center">
                <UserCircle className="h-16 w-16 text-slate-300 mx-auto mb-4" />
                <p className="text-slate-500">Seleziona un dipendente per vedere i dettagli</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Staff Modal */}
      {showStaffModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">
                {editingStaff ? 'Modifica Dipendente' : 'Nuovo Dipendente'}
              </h3>
              <button onClick={() => { setShowStaffModal(false); resetStaffForm(); }} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Nome *</label>
                  <input
                    type="text"
                    value={staffForm.name}
                    onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="Mario"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Cognome *</label>
                  <input
                    type="text"
                    value={staffForm.surname}
                    onChange={(e) => setStaffForm({ ...staffForm, surname: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="Rossi"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Categoria *</label>
                  <select
                    value={staffForm.category}
                    onChange={(e) => setStaffForm({ ...staffForm, category: e.target.value as StaffCategory })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    {Object.entries(STAFF_CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Tipo *</label>
                  <select
                    value={staffForm.staffType}
                    onChange={(e) => setStaffForm({ ...staffForm, staffType: e.target.value as StaffType })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    {Object.entries(STAFF_TYPE_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Ruolo</label>
                <input
                  type="text"
                  value={staffForm.role}
                  onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="es. Chef, Cameriere, Lavapiatti"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Telefono</label>
                  <input
                    type="tel"
                    value={staffForm.phone}
                    onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="+39 333 1234567"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Email</label>
                  <input
                    type="email"
                    value={staffForm.email}
                    onChange={(e) => setStaffForm({ ...staffForm, email: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                    placeholder="mario@esempio.com"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Data Assunzione</label>
                  <input
                    type="date"
                    value={staffForm.hireDate}
                    onChange={(e) => setStaffForm({ ...staffForm, hireDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Fine Contratto</label>
                  <input
                    type="date"
                    value={staffForm.contractEndDate}
                    onChange={(e) => setStaffForm({ ...staffForm, contractEndDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Note</label>
                <textarea
                  value={staffForm.notes}
                  onChange={(e) => setStaffForm({ ...staffForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none h-20 resize-none"
                  placeholder="Note aggiuntive..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-3">
              <button
                onClick={() => { setShowStaffModal(false); resetStaffForm(); }}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveStaff}
                className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                {editingStaff ? 'Salva' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Shift Modal */}
      {showShiftModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">Aggiungi Turno</h3>
              <button onClick={() => setShowShiftModal(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Data</label>
                <input
                  type="date"
                  value={shiftForm.date}
                  onChange={(e) => setShiftForm({ ...shiftForm, date: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Turno</label>
                <p className="text-[11px] text-slate-400 mb-2">Seleziona uno o entrambi i turni</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setShiftForm({ ...shiftForm, lunch: !shiftForm.lunch })}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border-2 transition-colors ${
                      shiftForm.lunch
                        ? 'border-amber-500 bg-amber-50 text-amber-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {shiftForm.lunch && <Check className="h-4 w-4" />}
                    <Sun className="h-5 w-5" />
                    Pranzo
                  </button>
                  <button
                    type="button"
                    onClick={() => setShiftForm({ ...shiftForm, dinner: !shiftForm.dinner })}
                    className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-lg border-2 transition-colors ${
                      shiftForm.dinner
                        ? 'border-indigo-500 bg-indigo-50 text-indigo-700'
                        : 'border-slate-200 text-slate-500 hover:border-slate-300'
                    }`}
                  >
                    {shiftForm.dinner && <Check className="h-4 w-4" />}
                    <Moon className="h-5 w-5" />
                    Cena
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Note</label>
                <input
                  type="text"
                  value={shiftForm.notes}
                  onChange={(e) => setShiftForm({ ...shiftForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="Note opzionali..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-3">
              <button
                onClick={() => setShowShiftModal(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveShift}
                className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                Aggiungi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Time Off Modal */}
      {showTimeOffModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">Registra Assenza</h3>
              <button onClick={() => setShowTimeOffModal(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Tipo</label>
                <select
                  value={timeOffForm.type}
                  onChange={(e) => setTimeOffForm({ ...timeOffForm, type: e.target.value as TimeOffType })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  {Object.entries(TIME_OFF_LABELS).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Da</label>
                  <input
                    type="date"
                    value={timeOffForm.startDate}
                    onChange={(e) => setTimeOffForm({ ...timeOffForm, startDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">A</label>
                  <input
                    type="date"
                    value={timeOffForm.endDate}
                    onChange={(e) => setTimeOffForm({ ...timeOffForm, endDate: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Note</label>
                <input
                  type="text"
                  value={timeOffForm.notes}
                  onChange={(e) => setTimeOffForm({ ...timeOffForm, notes: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder="Note opzionali..."
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-3">
              <button
                onClick={() => setShowTimeOffModal(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Annulla
              </button>
              <button
                onClick={handleSaveTimeOff}
                className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                Registra
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
