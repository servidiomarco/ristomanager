import React, { useState, useMemo, useEffect } from 'react';
import { Reservation, Table, Dish, Room, Shift, ArrivalStatus, TodoItem, TodoPriority, TodoCategory, UserRole, User } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { getTodos, createTodo, deleteTodo, toggleTodoComplete, saveTodos } from '../services/todoService';
import { authApiService } from '../services/authApiService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, TrendingUp, Users, Utensils, ChevronLeft, ChevronRight, Calendar, Plus, Check, Trash2, Clock, Flag, X, AlertTriangle, CheckCircle2, Circle, ListTodo, UserCircle, UsersRound, Edit2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../contexts/AuthContext';

const CATEGORY_LABELS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'Generale',
  [TodoCategory.RESERVATION]: 'Prenotazione',
  [TodoCategory.INVENTORY]: 'Inventario',
  [TodoCategory.STAFF]: 'Staff',
  [TodoCategory.MAINTENANCE]: 'Manutenzione',
  [TodoCategory.EVENT]: 'Evento',
};

const CATEGORY_COLORS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'bg-slate-100 text-slate-600',
  [TodoCategory.RESERVATION]: 'bg-indigo-100 text-indigo-600',
  [TodoCategory.INVENTORY]: 'bg-amber-100 text-amber-600',
  [TodoCategory.STAFF]: 'bg-emerald-100 text-emerald-600',
  [TodoCategory.MAINTENANCE]: 'bg-orange-100 text-orange-600',
  [TodoCategory.EVENT]: 'bg-purple-100 text-purple-600',
};

const PRIORITY_COLORS: Record<TodoPriority, string> = {
  [TodoPriority.LOW]: 'text-slate-400',
  [TodoPriority.MEDIUM]: 'text-amber-500',
  [TodoPriority.HIGH]: 'text-rose-500',
};

const TEAM_LABELS: Record<UserRole, string> = {
  [UserRole.OWNER]: 'Proprietario',
  [UserRole.MANAGER]: 'Manager',
  [UserRole.WAITER]: 'Camerieri',
  [UserRole.KITCHEN]: 'Cucina',
};

const TEAM_COLORS: Record<UserRole, string> = {
  [UserRole.OWNER]: 'bg-purple-100 text-purple-700',
  [UserRole.MANAGER]: 'bg-blue-100 text-blue-700',
  [UserRole.WAITER]: 'bg-emerald-100 text-emerald-700',
  [UserRole.KITCHEN]: 'bg-orange-100 text-orange-700',
};

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
  rooms: Room[];
}

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms }) => {
  const { user } = useAuth();
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [chartShiftFilter, setChartShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>('ALL');

  // Todo State
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoFilter, setTodoFilter] = useState<'all' | 'pending' | 'completed' | 'overdue' | 'mine'>('mine');
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [editingTodo, setEditingTodo] = useState<TodoItem | null>(null);
  const [staffUsers, setStaffUsers] = useState<User[]>([]);
  const [todoForm, setTodoForm] = useState({
    title: '',
    description: '',
    priority: TodoPriority.MEDIUM,
    category: TodoCategory.GENERAL,
    dueDate: '',
    assignedToUserId: undefined as number | undefined,
    assignedToTeam: undefined as UserRole | undefined,
  });

  useEffect(() => {
    setTodos(getTodos());
    // Load staff users for assignment
    authApiService.getUsers().then(users => {
      setStaffUsers(users.filter(u => u.is_active));
    }).catch(() => {
      // Ignore error if not authorized to view users
    });
  }, []);

  const handleGenerateReport = async () => {
    setLoading(true);
    const result = await generateRestaurantReport(reservations, tables, dishes);
    setReport(result);
    setLoading(false);
  };

  const resetTodoForm = () => {
    setTodoForm({ title: '', description: '', priority: TodoPriority.MEDIUM, category: TodoCategory.GENERAL, dueDate: '', assignedToUserId: undefined, assignedToTeam: undefined });
    setEditingTodo(null);
  };

  const handleOpenAddTodo = () => {
    resetTodoForm();
    setShowTodoModal(true);
  };

  const handleOpenEditTodo = (todo: TodoItem) => {
    setEditingTodo(todo);
    setTodoForm({
      title: todo.title,
      description: todo.description || '',
      priority: todo.priority,
      category: todo.category,
      dueDate: todo.dueDate || '',
      assignedToUserId: todo.assignedToUserId,
      assignedToTeam: todo.assignedToTeam,
    });
    setShowTodoModal(true);
  };

  const handleSaveTodo = () => {
    if (!todoForm.title.trim()) return;
    const assignedUser = staffUsers.find(u => u.id === todoForm.assignedToUserId);

    if (editingTodo) {
      // Update existing todo
      const updatedTodo: TodoItem = {
        ...editingTodo,
        title: todoForm.title,
        description: todoForm.description || undefined,
        priority: todoForm.priority,
        category: todoForm.category,
        dueDate: todoForm.dueDate || undefined,
        assignedToUserId: todoForm.assignedToUserId,
        assignedToUserName: assignedUser?.full_name,
        assignedToTeam: todoForm.assignedToTeam,
      };
      const allTodos = getTodos();
      const updatedTodos = allTodos.map(t => t.id === editingTodo.id ? updatedTodo : t);
      saveTodos(updatedTodos);
      setTodos(updatedTodos);
    } else {
      // Create new todo
      const todo = createTodo({
        title: todoForm.title,
        description: todoForm.description || undefined,
        priority: todoForm.priority,
        category: todoForm.category,
        dueDate: todoForm.dueDate || undefined,
        assignedToUserId: todoForm.assignedToUserId,
        assignedToUserName: assignedUser?.full_name,
        assignedToTeam: todoForm.assignedToTeam,
        createdByUserId: user?.id,
        createdByUserName: user?.full_name,
      });
      setTodos([todo, ...todos]);
    }

    resetTodoForm();
    setShowTodoModal(false);
  };

  const handleToggleTodo = (id: string) => {
    const updated = toggleTodoComplete(id);
    if (updated) setTodos(todos.map(t => t.id === id ? updated : t));
  };

  const handleDeleteTodo = (id: string) => {
    deleteTodo(id);
    setTodos(todos.filter(t => t.id !== id));
  };

  const todayStr = new Date().toISOString().split('T')[0];

  // Helper to check if task is assigned to current user
  const isAssignedToMe = (todo: TodoItem) => {
    // Check by ID first
    if (todo.assignedToUserId && user?.id) {
      if (Number(todo.assignedToUserId) === Number(user.id)) {
        return true;
      }
    }
    // Fallback: check by name if ID comparison fails
    if (todo.assignedToUserName && user?.full_name) {
      if (todo.assignedToUserName.toLowerCase() === user.full_name.toLowerCase()) {
        return true;
      }
    }
    return false;
  };

  const isAssignedToMyTeam = (todo: TodoItem) => {
    return todo.assignedToTeam === user?.role;
  };

  // My assigned todos (assigned to me or my team)
  const myTodos = todos.filter(t =>
    !t.completed && (isAssignedToMe(t) || isAssignedToMyTeam(t))
  );

  const filteredTodos = todos.filter(todo => {
    if (todoFilter === 'mine') return !todo.completed && (isAssignedToMe(todo) || isAssignedToMyTeam(todo));
    if (todoFilter === 'pending') return !todo.completed;
    if (todoFilter === 'completed') return todo.completed;
    if (todoFilter === 'overdue') return !todo.completed && todo.dueDate && todo.dueDate < todayStr;
    return true;
  });
  const todaysTodos = todos.filter(t => t.dueDate === todayStr && !t.completed);
  const overdueTodos = todos.filter(t => !t.completed && t.dueDate && t.dueDate < todayStr);
  const pendingCount = todos.filter(t => !t.completed).length;

  // Format date for display
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  // Navigate to previous/next day
  const goToPreviousDay = () => {
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() - 1);
      return newDate;
    });
  };

  const goToNextDay = () => {
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + 1);
      return newDate;
    });
  };

  const goToToday = () => {
    setSelectedDate(new Date());
  };

  // Get selected date string for filtering
  const selectedDateStr = selectedDate.toISOString().split('T')[0];
  const isToday = selectedDateStr === new Date().toISOString().split('T')[0];

  // Filter reservations for selected date
  const selectedDayReservations = useMemo(() => {
    return Array.isArray(reservations)
      ? reservations.filter(r => r.reservation_time.startsWith(selectedDateStr))
      : [];
  }, [reservations, selectedDateStr]);

  // Calculate stats for selected day
  const totalTables = Array.isArray(tables) ? tables.length : 0;
  const totalCapacity = Array.isArray(tables) ? tables.reduce((acc, t) => acc + (Number(t.seats) || 0), 0) : 0;

  // Current occupancy (real-time status)
  const occupiedTables = Array.isArray(tables) ? tables.filter(t => t.status === 'OCCUPIED').length : 0;
  const occupancyRate = totalTables > 0 ? Math.round((occupiedTables / totalTables) * 100) : 0;

  // Selected day stats
  const selectedDayGuests = selectedDayReservations.reduce((acc, r) => acc + r.guests, 0);
  const arrivedGuests = selectedDayReservations
    .filter(r => r.arrival_status === ArrivalStatus.ARRIVED)
    .reduce((acc, r) => acc + r.guests, 0);

  // Reservations by shift for selected day
  const lunchReservations = selectedDayReservations.filter(r => r.shift === Shift.LUNCH);
  const dinnerReservations = selectedDayReservations.filter(r => r.shift === Shift.DINNER);

  const lunchTableIds = new Set(lunchReservations.map(r => r.table_id).filter(Boolean));
  const dinnerTableIds = new Set(dinnerReservations.map(r => r.table_id).filter(Boolean));

  const lunchOccupancy = totalTables > 0 ? Math.round((lunchTableIds.size / totalTables) * 100) : 0;
  const dinnerOccupancy = totalTables > 0 ? Math.round((dinnerTableIds.size / totalTables) * 100) : 0;

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
      const dateStr = date.toISOString().split('T')[0];

      let dayReservations = Array.isArray(reservations)
        ? reservations.filter(r => r.reservation_time.startsWith(dateStr))
        : [];

      // Filter by shift if not ALL
      if (chartShiftFilter !== 'ALL') {
        dayReservations = dayReservations.filter(r => r.shift === chartShiftFilter);
      }

      const dayGuests = dayReservations.reduce((acc, r) => acc + r.guests, 0);

      data.push({
        name: days[i],
        date: date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }),
        guests: dayGuests
      });
    }

    return data;
  }, [reservations, chartShiftFilter, selectedDate]);

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
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header with Calendar Navigation */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500">Benvenuto su RistoCRM, {user?.full_name}</p>
        </div>

        {/* Date Navigation */}
        <div className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 p-1">
          <button
            onClick={goToPreviousDay}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="h-5 w-5 text-slate-600" />
          </button>

          <div className="flex items-center gap-2 px-3 py-1.5">
            <Calendar className="h-4 w-4 text-indigo-600" />
            <span className="font-medium text-slate-700 capitalize min-w-[200px] text-center">
              {formatDate(selectedDate)}
            </span>
          </div>

          <button
            onClick={goToNextDay}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ChevronRight className="h-5 w-5 text-slate-600" />
          </button>

          {!isToday && (
            <button
              onClick={goToToday}
              className="px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              Oggi
            </button>
          )}
        </div>
      </div>

      {/* My Tasks Alert Banner */}
      {myTodos.length > 0 && (
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white p-4 rounded-2xl shadow-lg">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/20 rounded-lg">
                <UserCircle className="h-6 w-6" />
              </div>
              <div>
                <h3 className="font-semibold">Hai {myTodos.length} {myTodos.length === 1 ? 'attività assegnata' : 'attività assegnate'}</h3>
                <p className="text-sm text-white/80">
                  {myTodos.filter(isAssignedToMe).length > 0 && (
                    <span>{myTodos.filter(isAssignedToMe).length} personali</span>
                  )}
                  {myTodos.filter(isAssignedToMe).length > 0 && myTodos.filter(isAssignedToMyTeam).length > 0 && ' · '}
                  {myTodos.filter(isAssignedToMyTeam).length > 0 && (
                    <span>{myTodos.filter(isAssignedToMyTeam).length} del team {user?.role && TEAM_LABELS[user.role]}</span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={() => setTodoFilter('mine')}
              className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-xl text-sm font-medium transition-colors"
            >
              Visualizza
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Ospiti Attesi</p>
            <p className="text-xl font-bold text-slate-800">{selectedDayGuests}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Ospiti Arrivati</p>
            <p className="text-xl font-bold text-slate-800">{arrivedGuests}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-rose-50 text-rose-600 rounded-lg">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Occupazione</p>
            <p className="text-xl font-bold text-slate-800">{occupancyRate}%</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-amber-50 text-amber-600 rounded-lg">
            <Utensils className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Coperti Totali</p>
            <p className="text-xl font-bold text-slate-800">{totalCapacity}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <Calendar className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Prenotazioni</p>
            <p className="text-xl font-bold text-slate-800">{selectedDayReservations.length}</p>
          </div>
        </div>
      </div>

      {/* Charts Section - Swapped: Table Status is now larger */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table Status by Room - Now expanded (2 columns) */}
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">Stato Tavoli</h2>

          {/* Shift Occupancy Summary */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 border border-amber-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-amber-800">Pranzo</span>
                <span className="text-xs text-amber-600">{lunchTableIds.size}/{totalTables} tavoli</span>
              </div>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold text-amber-700">{lunchOccupancy}%</span>
                <span className="text-sm text-amber-600 mb-1">occupazione</span>
              </div>
              <div className="mt-2 h-2 bg-amber-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-500"
                  style={{ width: `${lunchOccupancy}%` }}
                />
              </div>
              <p className="text-xs text-amber-600 mt-2">
                {lunchReservations.length} prenotazioni · {lunchReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti
              </p>
            </div>

            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-indigo-800">Cena</span>
                <span className="text-xs text-indigo-600">{dinnerTableIds.size}/{totalTables} tavoli</span>
              </div>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold text-indigo-700">{dinnerOccupancy}%</span>
                <span className="text-sm text-indigo-600 mb-1">occupazione</span>
              </div>
              <div className="mt-2 h-2 bg-indigo-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${dinnerOccupancy}%` }}
                />
              </div>
              <p className="text-xs text-indigo-600 mt-2">
                {dinnerReservations.length} prenotazioni · {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti
              </p>
            </div>
          </div>

          {/* Room by Room Status */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {rooms.map(room => {
              const roomTables = tables.filter(t => t.room_id === room.id);
              const roomTableIds = new Set(roomTables.map(t => t.id));

              // Calculate room-specific availability per shift for selected day
              const roomLunchReserved = lunchReservations.filter(r => roomTableIds.has(r.table_id)).length;
              const roomDinnerReserved = dinnerReservations.filter(r => roomTableIds.has(r.table_id)).length;
              const roomLunchAvailable = roomTables.length - roomLunchReserved;
              const roomDinnerAvailable = roomTables.length - roomDinnerReserved;

              return (
                <div key={room.id} className="border border-slate-100 rounded-lg p-3 hover:border-slate-200 transition-colors bg-slate-50/50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-slate-700 text-sm">{room.name}</h3>
                    <span className="text-xs text-slate-400">{roomTables.length} tavoli</span>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-amber-50 rounded-md px-2 py-1.5 border border-amber-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-amber-700">Pranzo</span>
                        <span className={`text-xs font-bold ${roomLunchAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {roomLunchAvailable}/{roomTables.length}
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 bg-indigo-50 rounded-md px-2 py-1.5 border border-indigo-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-indigo-700">Cena</span>
                        <span className={`text-xs font-bold ${roomDinnerAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {roomDinnerAvailable}/{roomTables.length}
                        </span>
                      </div>
                    </div>
                  </div>
                  {roomTables.length === 0 && (
                    <span className="text-xs text-slate-400">Nessun tavolo</span>
                  )}
                </div>
              );
            })}
            {rooms.length === 0 && (
              <div className="col-span-full text-center text-slate-400 py-8">
                Nessuna sala configurata
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-4 mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-600">Disponibilità tavoli per turno del giorno selezionato</span>
            </div>
          </div>
        </div>

        {/* Todo List - Compact version in sidebar */}
        <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
                <ListTodo className="h-4 w-4" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-slate-800">Attività</h2>
                <p className="text-xs text-slate-500">{pendingCount} da completare</p>
                {/* Debug info - remove after testing */}
                <p className="text-[9px] text-slate-400">User: {user?.id} - {user?.full_name} | Todos: {todos.length}</p>
              </div>
            </div>
            <button onClick={handleOpenAddTodo} className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
              <Plus className="h-4 w-4" />
            </button>
          </div>
          <div className="flex gap-1 mb-3 overflow-x-auto">
            {[
              { key: 'mine', label: 'Le mie', icon: UserCircle, count: myTodos.length },
              { key: 'pending', label: 'Tutte', icon: Circle },
              { key: 'overdue', label: 'Scadute', icon: AlertTriangle, count: overdueTodos.length },
            ].map(tab => (
              <button key={tab.key} onClick={() => setTodoFilter(tab.key as typeof todoFilter)} className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium whitespace-nowrap transition-colors ${todoFilter === tab.key ? 'bg-indigo-100 text-indigo-700' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}>
                <tab.icon className="h-3 w-3" />
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && <span className={`text-[10px] px-1 rounded-full ${tab.key === 'mine' ? 'bg-indigo-500 text-white' : 'bg-rose-500 text-white'}`}>{tab.count}</span>}
              </button>
            ))}
          </div>
          <div className="flex-1 divide-y divide-slate-100 overflow-y-auto max-h-[280px]">
            {filteredTodos.length === 0 ? (
              <div className="py-6 text-center">
                <CheckCircle2 className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                <p className="text-slate-400 text-xs">Nessuna attività</p>
                {/* Debug: show first todo assignment info */}
                {todos.length > 0 && (
                  <p className="text-[8px] text-slate-300 mt-2">
                    1st todo: ID={todos[0].assignedToUserId} Name={todos[0].assignedToUserName}
                  </p>
                )}
              </div>
            ) : (
              filteredTodos.slice(0, 5).map(todo => {
                const isOverdue = !todo.completed && todo.dueDate && todo.dueDate < todayStr;
                return (
                  <div key={todo.id} className={`py-2 ${todo.completed ? 'opacity-50' : ''}`}>
                    <div className="flex items-start gap-2">
                      <button onClick={() => handleToggleTodo(todo.id)} className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors ${todo.completed ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 hover:border-indigo-400'}`}>
                        {todo.completed && <Check className="h-2 w-2" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-1">
                          <p className={`text-xs font-medium truncate ${todo.completed ? 'line-through text-slate-400' : 'text-slate-700'}`}>{todo.title}</p>
                          <div className="flex items-center gap-0.5 flex-shrink-0">
                            <Flag className={`h-3 w-3 ${PRIORITY_COLORS[todo.priority]}`} />
                            <button onClick={() => handleOpenEditTodo(todo)} className="p-0.5 text-slate-400 hover:text-indigo-500 rounded"><Edit2 className="h-3 w-3" /></button>
                            <button onClick={() => handleDeleteTodo(todo.id)} className="p-0.5 text-slate-400 hover:text-rose-500 rounded"><Trash2 className="h-3 w-3" /></button>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_COLORS[todo.category]}`}>{CATEGORY_LABELS[todo.category]}</span>
                          {todo.assignedToUserName && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 flex items-center gap-0.5">
                              <UserCircle className="h-2.5 w-2.5" />{todo.assignedToUserName}
                            </span>
                          )}
                          {todo.assignedToTeam && (
                            <span className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${TEAM_COLORS[todo.assignedToTeam]}`}>
                              <UsersRound className="h-2.5 w-2.5" />{TEAM_LABELS[todo.assignedToTeam]}
                            </span>
                          )}
                          {todo.dueDate && <span className={`text-[10px] ${isOverdue ? 'text-rose-600' : 'text-slate-400'}`}>{new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</span>}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            {filteredTodos.length > 5 && (
              <div className="py-2 text-center">
                <span className="text-xs text-indigo-600">+{filteredTodos.length - 5} altre attività</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Weekly Chart - Full width section */}
      <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">Affluenza Settimanale</h2>
            <p className="text-sm text-slate-500 mt-1">{weekRange}</p>
          </div>
          <div className="flex rounded-lg border border-slate-200 p-1 bg-slate-50">
            <button
              onClick={() => setChartShiftFilter('ALL')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                chartShiftFilter === 'ALL'
                  ? 'bg-white text-slate-800 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Tutti
            </button>
            <button
              onClick={() => setChartShiftFilter('LUNCH')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                chartShiftFilter === 'LUNCH'
                  ? 'bg-amber-100 text-amber-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Pranzo
            </button>
            <button
              onClick={() => setChartShiftFilter('DINNER')}
              className={`px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                chartShiftFilter === 'DINNER'
                  ? 'bg-indigo-100 text-indigo-700 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Cena
            </button>
          </div>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeklyChartData}>
              <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
              <XAxis
                dataKey="name"
                axisLine={false}
                tickLine={false}
                tick={{fill: '#64748b', fontSize: 12}}
              />
              <YAxis
                domain={[0, 'auto']}
                axisLine={false}
                tickLine={false}
                tick={{fill: '#64748b', fontSize: 12}}
                width={40}
              />
              <Tooltip
                cursor={{fill: '#f1f5f9'}}
                contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
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
                fill={chartShiftFilter === 'LUNCH' ? '#f59e0b' : chartShiftFilter === 'DINNER' ? '#6366f1' : '#6366f1'}
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Add/Edit Todo Modal */}
      {showTodoModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">{editingTodo ? 'Modifica Attività' : 'Nuova Attività'}</h3>
              <button onClick={() => { setShowTodoModal(false); resetTodoForm(); }} className="p-1 hover:bg-slate-100 rounded-lg"><X className="h-5 w-5 text-slate-500" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Titolo</label>
                <input type="text" value={todoForm.title} onChange={e => setTodoForm({ ...todoForm, title: e.target.value })} placeholder="Es: Chiamare fornitore vini" className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none" autoFocus />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Descrizione (opzionale)</label>
                <textarea value={todoForm.description} onChange={e => setTodoForm({ ...todoForm, description: e.target.value })} placeholder="Aggiungi dettagli..." className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none h-20 resize-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Priorità</label>
                  <select value={todoForm.priority} onChange={e => setTodoForm({ ...todoForm, priority: e.target.value as TodoPriority })} className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                    <option value={TodoPriority.LOW}>Bassa</option>
                    <option value={TodoPriority.MEDIUM}>Media</option>
                    <option value={TodoPriority.HIGH}>Alta</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Categoria</label>
                  <select value={todoForm.category} onChange={e => setTodoForm({ ...todoForm, category: e.target.value as TodoCategory })} className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Scadenza (opzionale)</label>
                <input type="date" value={todoForm.dueDate} onChange={e => setTodoForm({ ...todoForm, dueDate: e.target.value })} className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Assegna a Persona</label>
                  <select
                    value={todoForm.assignedToUserId || ''}
                    onChange={e => setTodoForm({ ...todoForm, assignedToUserId: e.target.value ? Number(e.target.value) : undefined, assignedToTeam: undefined })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value="">Nessuno</option>
                    {staffUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name} ({TEAM_LABELS[u.role]})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Assegna a Team</label>
                  <select
                    value={todoForm.assignedToTeam || ''}
                    onChange={e => setTodoForm({ ...todoForm, assignedToTeam: e.target.value ? e.target.value as UserRole : undefined, assignedToUserId: undefined })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value="">Nessun team</option>
                    {Object.entries(TEAM_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => { setShowTodoModal(false); resetTodoForm(); }} className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium">Annulla</button>
              <button onClick={handleSaveTodo} disabled={!todoForm.title.trim()} className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed">
                {editingTodo ? 'Salva' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Today's Tasks Summary */}
      {todaysTodos.length > 0 && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-4 rounded-2xl border border-amber-100">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-amber-600" />
            <h3 className="font-semibold text-amber-900">Attività di oggi</h3>
            <span className="bg-amber-200 text-amber-800 text-xs px-2 py-0.5 rounded-full font-medium">{todaysTodos.length}</span>
          </div>
          <div className="space-y-2">
            {todaysTodos.slice(0, 3).map(todo => (
              <div key={todo.id} className="flex items-center gap-2 text-sm text-amber-800">
                <div className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[todo.priority].replace('text-', 'bg-')}`} />
                {todo.title}
              </div>
            ))}
            {todaysTodos.length > 3 && <p className="text-xs text-amber-600">+{todaysTodos.length - 3} altre attività</p>}
          </div>
        </div>
      )}

      {/* AI Report Section */}
      {report && (
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 p-6 rounded-2xl border border-indigo-100 animate-fade-in">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-bold text-indigo-900">Analisi AI Gemini</h2>
          </div>
          <div className="prose prose-indigo max-w-none text-slate-700">
            <ReactMarkdown>{report}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
};
