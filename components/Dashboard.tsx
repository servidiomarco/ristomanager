import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Reservation, Table, Dish, Room, Shift, ArrivalStatus, TodoItem, TodoPriority, TodoCategory, UserRole, User, StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType, BanquetMenu } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { todoApiService } from '../services/todoApiService';
import { shoppingApiService, ShoppingItem, ShoppingCategory } from '../services/shoppingApiService';
import { staffApiService } from '../services/staffApiService';
import { authApiService } from '../services/authApiService';
import { socketClient } from '../services/socketClient';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, Users, Utensils, ChevronLeft, ChevronRight, Calendar, Plus, Check, Trash2, Clock, Flag, X, AlertTriangle, CheckCircle2, Circle, ListTodo, UserCircle, UsersRound, Edit2, ShoppingCart, Coffee, ChefHat, Package, Sun, Moon, Armchair } from 'lucide-react';
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
  banquetMenus: BanquetMenu[];
  onNavigateToBanquets: () => void;
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
  'CUCINA': 'bg-orange-100 text-orange-700 border-orange-200',
  'BAR': 'bg-amber-100 text-amber-700 border-amber-200',
  'ALTRO': 'bg-slate-100 text-slate-700 border-slate-200'
};

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms, banquetMenus, onNavigateToBanquets }) => {
  const { user } = useAuth();
  const todoSectionRef = useRef<HTMLDivElement>(null);
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [chartShiftFilter, setChartShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>('ALL');
  const [affluenceShiftFilter, setAffluenceShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>('ALL');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const dateInputRef = useRef<HTMLInputElement>(null);

  // Tick the header clock once per minute (start of each minute)
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

  // Todo State
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todosLoading, setTodosLoading] = useState(true);
  const [todoFilter, setTodoFilter] = useState<'all' | 'pending' | 'completed' | 'overdue' | 'mine'>('mine');
  const [showTodoModal, setShowTodoModal] = useState(false);
  const [showMyTasksModal, setShowMyTasksModal] = useState(false);
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

  // Shopping List State
  const [shoppingItems, setShoppingItems] = useState<ShoppingItem[]>([]);
  const [shoppingLoading, setShoppingLoading] = useState(true);
  const [newItemName, setNewItemName] = useState('');
  const [newItemCategory, setNewItemCategory] = useState<ShoppingCategory>('CUCINA');

  // Staff Presence State
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([]);
  const [staffShifts, setStaffShifts] = useState<StaffShift[]>([]);
  const [staffTimeOffs, setStaffTimeOffs] = useState<StaffTimeOff[]>([]);
  const [staffLoading, setStaffLoading] = useState(true);

  // Socket connection state - used to re-subscribe when socket reconnects
  const [socketConnected, setSocketConnected] = useState(socketClient.isConnected());

  // Fetch shopping items from API
  const fetchShopping = useCallback(async (dateStr: string) => {
    try {
      setShoppingLoading(true);
      const items = await shoppingApiService.getItemsByDate(dateStr);
      setShoppingItems(items);
    } catch (error) {
      console.error('Error fetching shopping items:', error);
    } finally {
      setShoppingLoading(false);
    }
  }, []);

  // Fetch staff members, shifts, and time-off for selected date
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

  const addShoppingItem = async () => {
    if (!newItemName.trim()) return;
    try {
      // Don't add to state here - let the socket event handle it
      // This prevents duplicates on the creating device
      await shoppingApiService.createItem({
        name: newItemName.trim(),
        category: newItemCategory,
        date: selectedDateStr
      });
      setNewItemName('');
    } catch (error) {
      console.error('Error adding shopping item:', error);
    }
  };

  const toggleShoppingItem = async (id: string) => {
    try {
      const updated = await shoppingApiService.toggleItem(id);
      setShoppingItems(prev => prev.map(item =>
        item.id === id ? updated : item
      ));
    } catch (error) {
      console.error('Error toggling shopping item:', error);
    }
  };

  const deleteShoppingItem = async (id: string) => {
    try {
      await shoppingApiService.deleteItem(id);
      setShoppingItems(prev => prev.filter(item => item.id !== id));
    } catch (error) {
      console.error('Error deleting shopping item:', error);
    }
  };

  const clearCheckedItems = async () => {
    try {
      await shoppingApiService.clearChecked(selectedDateStr);
      setShoppingItems(prev => prev.filter(item => !item.checked));
    } catch (error) {
      console.error('Error clearing checked items:', error);
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
  // - Excludes staff with time-off covering the selected date
  // - FISSO staff are implicitly present on both shifts during their hire period
  //   unless it's their weekly rest day
  // - Explicit shift rows (with present=false) override the implicit rule
  const staffPresence = useMemo(() => {
    const dayOfWeek = new Date(`${selectedDateStr}T00:00:00`).getDay();
    const onTimeOff = new Set(
      staffTimeOffs
        .filter(t => toDateOnly(t.startDate) <= selectedDateStr && toDateOnly(t.endDate) >= selectedDateStr)
        .map(t => t.staffId)
    );

    const isPresent = (staff: StaffMember, shift: Shift): boolean => {
      if (onTimeOff.has(staff.id)) return false;

      const explicitShift = staffShifts.find(s =>
        s.staffId === staff.id && s.shift === shift && toDateOnly(s.date) === selectedDateStr
      );
      if (explicitShift) return explicitShift.present !== false;

      if (staff.staffType !== StaffType.FISSO) return false;
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
  const checkedItems = shoppingItems.filter(i => i.checked).length;

  // Fetch todos from API (filtered by selected date)
  const fetchTodos = useCallback(async (dateStr: string) => {
    try {
      setTodosLoading(true);
      const fetchedTodos = await todoApiService.getTodosByDate(dateStr);
      setTodos(fetchedTodos);
    } catch (error) {
      console.error('Error fetching todos:', error);
    } finally {
      setTodosLoading(false);
    }
  }, []);

  // Fetch todos when selectedDate changes
  useEffect(() => {
    fetchTodos(selectedDateStr);
  }, [selectedDateStr, fetchTodos]);

  // Load staff users for assignment (once on mount)
  useEffect(() => {
    authApiService.getUsers().then(users => {
      setStaffUsers(users.filter(u => u.is_active));
    }).catch(() => {
      // Ignore error if not authorized to view users
    });
  }, []);

  // Track socket connection state to re-subscribe when socket reconnects
  useEffect(() => {
    console.log('🔌 Setting up socket connection tracker...');
    const unsubscribe = socketClient.onSocketChange((socket, connected) => {
      console.log('🔌 Socket connection changed - id:', socket?.id, 'connected:', connected);
      setSocketConnected(connected);
    });

    // Also check current state
    const currentSocket = socketClient.getSocket();
    console.log('🔌 Current socket state - id:', currentSocket?.id, 'connected:', currentSocket?.connected);
    if (currentSocket?.connected && !socketConnected) {
      console.log('🔌 Socket already connected, updating state');
      setSocketConnected(true);
    }

    return unsubscribe;
  }, []);

  // Socket.IO real-time updates for todos
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;

    const handleTodoCreated = (todo: TodoItem) => {
      // Only add if it's for the currently selected date
      if (todo.dueDate === selectedDateStr) {
        setTodos(prev => {
          if (prev.some(t => t.id === todo.id)) return prev;
          return [todo, ...prev];
        });
      }
    };

    const handleTodoUpdated = (todo: TodoItem) => {
      // Update if it exists in current list, or add if it's for today's date
      setTodos(prev => {
        const exists = prev.some(t => t.id === todo.id);
        if (exists) {
          // If the date changed and it's no longer for selected date, remove it
          if (todo.dueDate !== selectedDateStr) {
            return prev.filter(t => t.id !== todo.id);
          }
          return prev.map(t => t.id === todo.id ? todo : t);
        } else if (todo.dueDate === selectedDateStr) {
          // New todo for selected date
          return [todo, ...prev];
        }
        return prev;
      });
    };

    const handleTodoDeleted = (data: { id: string }) => {
      setTodos(prev => prev.filter(t => t.id !== data.id));
    };

    socket.on('todo:created', handleTodoCreated);
    socket.on('todo:updated', handleTodoUpdated);
    socket.on('todo:deleted', handleTodoDeleted);

    return () => {
      socket.off('todo:created', handleTodoCreated);
      socket.off('todo:updated', handleTodoUpdated);
      socket.off('todo:deleted', handleTodoDeleted);
    };
  }, [selectedDateStr, socketConnected]);

  // Fetch shopping items when selectedDate changes
  useEffect(() => {
    fetchShopping(selectedDateStr);
  }, [selectedDateStr, fetchShopping]);

  // Fetch staff when selectedDate changes
  useEffect(() => {
    fetchStaff(selectedDateStr);
  }, [selectedDateStr, fetchStaff]);

  // Socket.IO real-time updates for shopping
  useEffect(() => {
    const socket = socketClient.getSocket();
    console.log('🛒 Shopping socket setup - socket id:', socket?.id, 'connected:', socket?.connected, 'socketConnected state:', socketConnected);

    if (!socket) {
      console.log('🛒 No socket available, skipping listener setup');
      return;
    }

    if (!socket.connected) {
      console.log('🛒 Socket not connected, skipping listener setup');
      return;
    }

    console.log('🛒 Setting up shopping socket listeners...');

    const handleShoppingCreated = (item: ShoppingItem) => {
      console.log('🛒 Socket: shopping:created received', item, 'selectedDate:', selectedDateStr);
      // Only add if it's for the currently selected date
      if (item.date === selectedDateStr) {
        setShoppingItems(prev => {
          if (prev.some(i => i.id === item.id)) return prev;
          return [...prev, item];
        });
      }
    };

    const handleShoppingUpdated = (item: ShoppingItem) => {
      console.log('Socket: shopping:updated received', item);
      setShoppingItems(prev => prev.map(i => i.id === item.id ? item : i));
    };

    const handleShoppingDeleted = (data: { id: string }) => {
      console.log('Socket: shopping:deleted received', data);
      setShoppingItems(prev => prev.filter(i => i.id !== data.id));
    };

    const handleShoppingCleared = (data: { date: string }) => {
      console.log('Socket: shopping:cleared received', data);
      if (data.date === selectedDateStr) {
        setShoppingItems(prev => prev.filter(i => !i.checked));
      }
    };

    socket.on('shopping:created', handleShoppingCreated);
    socket.on('shopping:updated', handleShoppingUpdated);
    socket.on('shopping:deleted', handleShoppingDeleted);
    socket.on('shopping:cleared', handleShoppingCleared);
    console.log('🛒 Shopping socket listeners registered successfully');

    // Debug: Listen for any event
    const debugHandler = (...args: any[]) => {
      console.log('🛒 Socket received event:', args);
    };
    socket.onAny(debugHandler);

    return () => {
      console.log('🛒 Cleaning up shopping socket listeners');
      socket.off('shopping:created', handleShoppingCreated);
      socket.off('shopping:updated', handleShoppingUpdated);
      socket.off('shopping:deleted', handleShoppingDeleted);
      socket.off('shopping:cleared', handleShoppingCleared);
      socket.offAny(debugHandler);
    };
  }, [selectedDateStr, socketConnected]);

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
    // Default to selected date for new todos
    setTodoForm(prev => ({ ...prev, dueDate: selectedDateStr }));
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

  const handleSaveTodo = async () => {
    if (!todoForm.title.trim()) return;
    const assignedUser = staffUsers.find(u => u.id === todoForm.assignedToUserId);

    try {
      if (editingTodo) {
        // Update existing todo
        const updated = await todoApiService.updateTodo(editingTodo.id, {
          title: todoForm.title,
          description: todoForm.description || undefined,
          priority: todoForm.priority,
          category: todoForm.category,
          dueDate: todoForm.dueDate || undefined,
          assignedToUserId: todoForm.assignedToUserId,
          assignedToUserName: assignedUser?.full_name,
          assignedToTeam: todoForm.assignedToTeam,
        });
        setTodos(todos.map(t => t.id === editingTodo.id ? updated : t));
      } else {
        // Create new todo
        const todo = await todoApiService.createTodo({
          title: todoForm.title,
          description: todoForm.description || undefined,
          priority: todoForm.priority,
          category: todoForm.category,
          dueDate: todoForm.dueDate || undefined,
          assignedToUserId: todoForm.assignedToUserId,
          assignedToUserName: assignedUser?.full_name,
          assignedToTeam: todoForm.assignedToTeam,
        });
        setTodos([todo, ...todos]);
      }

      resetTodoForm();
      setShowTodoModal(false);
    } catch (error) {
      console.error('Error saving todo:', error);
    }
  };

  const handleToggleTodo = async (id: string) => {
    try {
      const updated = await todoApiService.toggleTodoComplete(id);
      setTodos(todos.map(t => t.id === id ? updated : t));
    } catch (error) {
      console.error('Error toggling todo:', error);
    }
  };

  const handleDeleteTodo = async (id: string) => {
    try {
      await todoApiService.deleteTodo(id);
      setTodos(todos.filter(t => t.id !== id));
    } catch (error) {
      console.error('Error deleting todo:', error);
    }
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

  const handleDateInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) return;
    const [y, m, d] = value.split('-').map(Number);
    if (y && m && d) setSelectedDate(new Date(y, m - 1, d));
  };

  // Filter reservations for selected date
  const selectedDayReservations = useMemo(() => {
    return Array.isArray(reservations)
      ? reservations.filter(r => r.reservation_time.startsWith(selectedDateStr))
      : [];
  }, [reservations, selectedDateStr]);

  // Calculate stats for selected day
  const totalTables = Array.isArray(tables) ? tables.length : 0;

  // Banchetti scheduled for the selected day
  const banquetsToday = Array.isArray(banquetMenus)
    ? banquetMenus.filter(m => m.event_date === selectedDateStr).length
    : 0;

  // Reservations by shift for selected day
  const lunchReservations = selectedDayReservations.filter(r => r.shift === Shift.LUNCH);
  const dinnerReservations = selectedDayReservations.filter(r => r.shift === Shift.DINNER);

  const lunchTableIds = new Set(lunchReservations.map(r => r.table_id).filter(Boolean));
  const dinnerTableIds = new Set(dinnerReservations.map(r => r.table_id).filter(Boolean));

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

    // Room-based affluence with time slots
    const roomTimeSlots = rooms.map(room => {
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

    // Total capacity for percentage calculation
    const totalCapacity = rooms.reduce((acc, room) => {
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
    <div className="p-6 lg:p-8 space-y-6 lg:space-y-8">
      {/* Header with Calendar Navigation */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="text-3xl lg:text-4xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500 text-base lg:text-lg">Hello on RistoCRM, {user?.full_name}</p>
        </div>

        {/* Clock + Date Navigation */}
        <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2 sm:gap-2 md:gap-3 w-full md:w-auto">
          <div className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-4 py-2.5 self-start sm:self-auto">
            <Clock className="h-5 w-5 text-indigo-600" />
            <span className="font-mono text-lg font-semibold text-slate-700 tabular-nums">
              {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div className="flex items-center justify-between sm:justify-start gap-1 bg-white rounded-xl border border-slate-200 p-1.5">
            {!isToday && (
              <button
                onClick={goToToday}
                className="px-3 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
              >
                Oggi
              </button>
            )}

            <button
              onClick={goToPreviousDay}
              className="p-2.5 hover:bg-slate-100 rounded-lg transition-colors"
              aria-label="Giorno precedente"
            >
              <ChevronLeft className="h-5 w-5 text-slate-600" />
            </button>

            <div className="relative">
              <div className="flex items-center gap-2 px-3 sm:px-4 py-2 hover:bg-slate-50 rounded-lg transition-colors pointer-events-none">
                <Calendar className="h-5 w-5 text-indigo-600 flex-shrink-0" />
                <span className="font-semibold text-sm sm:text-base lg:text-lg text-slate-700 capitalize sm:min-w-[220px] lg:min-w-[260px] text-center whitespace-nowrap">
                  {formatDate(selectedDate)}
                </span>
              </div>
              <input
                ref={dateInputRef}
                type="date"
                value={selectedDateStr}
                onChange={handleDateInputChange}
                onClick={(e) => {
                  // Desktop Chrome: clicking an opacity:0 date input doesn't
                  // open the picker; force it via showPicker (mobile opens
                  // natively on tap and treats this as a no-op or harmless).
                  const input = e.currentTarget;
                  try {
                    if (typeof input.showPicker === 'function') input.showPicker();
                  } catch {
                    // ignore — fall back to native focus
                  }
                }}
                aria-label="Seleziona data"
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>

            <button
              onClick={goToNextDay}
              className="p-2.5 hover:bg-slate-100 rounded-lg transition-colors"
              aria-label="Giorno successivo"
            >
              <ChevronRight className="h-5 w-5 text-slate-600" />
            </button>
          </div>
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
              onClick={() => setShowMyTasksModal(true)}
              className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-xl text-sm font-medium transition-colors"
            >
              Visualizza
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards — per shift (Pranzo / Cena) */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 sm:gap-4 lg:gap-6">
        <div className="bg-white p-3 sm:p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-3 sm:gap-4">
          <div className="p-2 sm:p-3 bg-indigo-50 text-indigo-600 rounded-xl flex-shrink-0">
            <Users className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 truncate">Ospiti Attesi</p>
            <div className="flex items-center gap-2 sm:gap-3 mt-0.5">
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{lunchExpectedGuests}</span>
              </div>
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{dinnerExpectedGuests}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white p-3 sm:p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-3 sm:gap-4">
          <div className="p-2 sm:p-3 bg-emerald-50 text-emerald-600 rounded-xl flex-shrink-0">
            <Users className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 truncate">Ospiti Arrivati</p>
            <div className="flex items-center gap-2 sm:gap-3 mt-0.5">
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{lunchArrivedGuests}</span>
              </div>
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{dinnerArrivedGuests}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white p-3 sm:p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-3 sm:gap-4">
          <div className="p-2 sm:p-3 bg-sky-50 text-sky-600 rounded-xl flex-shrink-0">
            <Armchair className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 truncate">Tavoli Attesi</p>
            <div className="flex items-center gap-2 sm:gap-3 mt-0.5">
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{lunchTableIds.size}</span>
              </div>
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{dinnerTableIds.size}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="bg-white p-3 sm:p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-3 sm:gap-4">
          <div className="p-2 sm:p-3 bg-teal-50 text-teal-600 rounded-xl flex-shrink-0">
            <Armchair className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 truncate">Tavoli Arrivati</p>
            <div className="flex items-center gap-2 sm:gap-3 mt-0.5">
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{lunchArrivedTableIds.size}</span>
              </div>
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{dinnerArrivedTableIds.size}</span>
              </div>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={onNavigateToBanquets}
          className="bg-white p-3 sm:p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-3 sm:gap-4 text-left hover:bg-slate-50 hover:border-rose-200 transition-colors group col-span-2 md:col-span-1"
        >
          <div className="p-2 sm:p-3 bg-rose-50 text-rose-600 rounded-xl flex-shrink-0">
            <Calendar className="h-5 w-5 sm:h-6 sm:w-6 lg:h-7 lg:w-7" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs sm:text-sm lg:text-base text-slate-500 truncate">Prenotazioni & Banchetti</p>
            <div className="flex items-center gap-2 sm:gap-3 mt-0.5">
              <div className="flex items-center gap-1">
                <Sun className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-amber-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{lunchReservations.length}</span>
              </div>
              <div className="flex items-center gap-1">
                <Moon className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-indigo-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-slate-800 tabular-nums">{dinnerReservations.length}</span>
              </div>
              <div className="flex items-center gap-1 pl-1 sm:pl-2 border-l border-slate-200">
                <Calendar className="h-3 w-3 sm:h-3.5 sm:w-3.5 text-rose-500 flex-shrink-0" />
                <span className="text-base sm:text-xl lg:text-2xl font-bold text-rose-600 tabular-nums">{banquetsToday}</span>
              </div>
            </div>
          </div>
          <ChevronRight className="h-4 w-4 sm:h-5 sm:w-5 text-slate-400 group-hover:text-rose-600 group-hover:translate-x-0.5 transition-all flex-shrink-0" />
        </button>
      </div>

      {/* Row 1: Stato Tavoli (full width) */}
      <div className="bg-white p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100">
        <h2 className="text-lg lg:text-xl font-semibold mb-4 text-slate-800">Stato Tavoli</h2>

        {/* Shift Occupancy Summary */}
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-3 sm:p-4 border border-amber-100">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 mb-2">
              <span className="text-sm font-medium text-amber-800">Pranzo</span>
              <span className="text-[11px] sm:text-xs text-amber-600 whitespace-nowrap">{lunchTableIds.size}/{totalTables} tavoli</span>
            </div>
            <div className="flex flex-wrap items-end gap-x-2 gap-y-0">
              <span className="text-2xl sm:text-3xl font-bold text-amber-700 leading-none">{lunchOccupancy}%</span>
              <span className="text-xs sm:text-sm text-amber-600 mb-0.5 sm:mb-1">occupazione</span>
            </div>
            <div className="mt-2 h-2 bg-amber-200 rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all duration-500" style={{ width: `${lunchOccupancy}%` }} />
            </div>
            <p className="text-[11px] sm:text-xs text-amber-600 mt-2">{lunchReservations.length} prenotazioni · {lunchReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti</p>
          </div>

          <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-3 sm:p-4 border border-indigo-100">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 mb-2">
              <span className="text-sm font-medium text-indigo-800">Cena</span>
              <span className="text-[11px] sm:text-xs text-indigo-600 whitespace-nowrap">{dinnerTableIds.size}/{totalTables} tavoli</span>
            </div>
            <div className="flex flex-wrap items-end gap-x-2 gap-y-0">
              <span className="text-2xl sm:text-3xl font-bold text-indigo-700 leading-none">{dinnerOccupancy}%</span>
              <span className="text-xs sm:text-sm text-indigo-600 mb-0.5 sm:mb-1">occupazione</span>
            </div>
            <div className="mt-2 h-2 bg-indigo-200 rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${dinnerOccupancy}%` }} />
            </div>
            <p className="text-[11px] sm:text-xs text-indigo-600 mt-2">{dinnerReservations.length} prenotazioni · {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti</p>
          </div>
        </div>

        {/* Room by Room Status */}
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {rooms.map(room => {
            const roomTables = tables.filter(t => t.room_id === room.id);
            const roomTableIds = new Set(roomTables.map(t => t.id));
            const roomLunchReserved = lunchReservations.filter(r => roomTableIds.has(r.table_id)).length;
            const roomDinnerReserved = dinnerReservations.filter(r => roomTableIds.has(r.table_id)).length;
            const roomLunchAvailable = roomTables.length - roomLunchReserved;
            const roomDinnerAvailable = roomTables.length - roomDinnerReserved;

            return (
              <div key={room.id} className="border border-slate-100 rounded-lg p-2 hover:border-slate-200 transition-colors bg-slate-50/50">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-medium text-slate-700 text-xs truncate">{room.name}</h3>
                  <span className="text-[10px] text-slate-400">{roomTables.length}</span>
                </div>
                <div className="flex gap-1">
                  <div className="flex-1 bg-amber-50 rounded px-1 py-0.5 border border-amber-100 text-center">
                    <span className={`text-[10px] font-bold ${roomLunchAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {roomLunchAvailable}
                    </span>
                  </div>
                  <div className="flex-1 bg-indigo-50 rounded px-1 py-0.5 border border-indigo-100 text-center">
                    <span className={`text-[10px] font-bold ${roomDinnerAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {roomDinnerAvailable}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2: Affluenza per Sala (con orari) + Affluenza Settimanale */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 lg:gap-8">
        {/* Affluenza per Sala con orari - 75% */}
        <div className="lg:col-span-3 bg-white p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg lg:text-xl font-semibold text-slate-800">Affluenza per Orario</h2>
            <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
              <button
                onClick={() => setAffluenceShiftFilter('ALL')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  affluenceShiftFilter === 'ALL'
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setAffluenceShiftFilter('LUNCH')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  affluenceShiftFilter === 'LUNCH'
                    ? 'bg-amber-100 text-amber-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Pranzo
              </button>
              <button
                onClick={() => setAffluenceShiftFilter('DINNER')}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  affluenceShiftFilter === 'DINNER'
                    ? 'bg-indigo-100 text-indigo-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Cena
              </button>
            </div>
          </div>

          <div className="space-y-4 max-h-[400px] overflow-y-auto">
            {timeSlotAffluence.roomTimeSlots.map(room => (
              <div key={room.roomId} className="border border-slate-100 rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-slate-700">{room.roomName}</h3>
                  <span className="text-xs text-slate-400">Max {room.maxCapacity} coperti</span>
                </div>

                {/* Lunch Time Slots */}
                {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'LUNCH') && (
                  <div className={affluenceShiftFilter === 'ALL' ? 'mb-2' : ''}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-amber-700 w-16">Pranzo</span>
                      <span className="text-[10px] text-slate-400">{room.totalLunchGuests}/{room.maxCapacity} ({room.lunchPercentage}%)</span>
                    </div>
                    <div className={`flex ${affluenceShiftFilter === 'LUNCH' ? 'gap-2' : 'gap-1'}`}>
                      {room.lunchSlots.map(slot => (
                        <div key={slot.time} className="flex-1 text-center">
                          <div className={`text-slate-400 mb-0.5 ${affluenceShiftFilter === 'LUNCH' ? 'text-xs' : 'text-[9px]'}`}>{slot.time}</div>
                          <div className={`relative overflow-hidden rounded bg-slate-100 ${affluenceShiftFilter === 'LUNCH' ? 'h-12' : ''}`}>
                            <div
                              className="absolute inset-y-0 left-0 bg-amber-300 transition-all duration-300"
                              style={{ width: `${Math.min(slot.percentage, 100)}%` }}
                            />
                            <div className={`relative font-bold z-10 flex items-center justify-center ${affluenceShiftFilter === 'LUNCH' ? 'text-base h-12' : 'text-xs py-0.5'} ${slot.guests > 0 ? 'text-amber-800' : 'text-slate-400'}`}>
                              {slot.guests}
                            </div>
                          </div>
                          {affluenceShiftFilter === 'LUNCH' && (
                            <div className="text-[10px] text-slate-400 mt-0.5">{slot.percentage}%</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Dinner Time Slots */}
                {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'DINNER') && (
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-indigo-700 w-16">Cena</span>
                      <span className="text-[10px] text-slate-400">{room.totalDinnerGuests}/{room.maxCapacity} ({room.dinnerPercentage}%)</span>
                    </div>
                    <div className={`flex overflow-x-auto ${affluenceShiftFilter === 'DINNER' ? 'gap-1.5' : 'gap-0.5'}`}>
                      {room.dinnerSlots.map(slot => (
                        <div key={slot.time} className={`flex-1 text-center ${affluenceShiftFilter === 'DINNER' ? 'min-w-[50px]' : 'min-w-[32px]'}`}>
                          <div className={`text-slate-400 mb-0.5 ${affluenceShiftFilter === 'DINNER' ? 'text-[10px]' : 'text-[8px]'}`}>{slot.time.substring(0, 5)}</div>
                          <div className={`relative overflow-hidden rounded bg-slate-100 ${affluenceShiftFilter === 'DINNER' ? 'h-12' : ''}`}>
                            <div
                              className="absolute inset-y-0 left-0 bg-indigo-300 transition-all duration-300"
                              style={{ width: `${Math.min(slot.percentage, 100)}%` }}
                            />
                            <div className={`relative font-bold z-10 flex items-center justify-center ${affluenceShiftFilter === 'DINNER' ? 'text-base h-12' : 'text-xs py-0.5'} ${slot.guests > 0 ? 'text-indigo-800' : 'text-slate-400'}`}>
                              {slot.guests}
                            </div>
                          </div>
                          {affluenceShiftFilter === 'DINNER' && (
                            <div className="text-[10px] text-slate-400 mt-0.5">{slot.percentage}%</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Total Summary */}
          <div className={`mt-4 pt-3 border-t border-slate-100 grid gap-3 ${affluenceShiftFilter === 'ALL' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'LUNCH') && (
              <div className="bg-amber-50 rounded-lg p-2.5 border border-amber-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-amber-800">Totale Pranzo</span>
                  <span className="text-sm font-bold text-amber-700">
                    {lunchReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                  </span>
                </div>
              </div>
            )}
            {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'DINNER') && (
              <div className="bg-indigo-50 rounded-lg p-2.5 border border-indigo-100">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-indigo-800">Totale Cena</span>
                  <span className="text-sm font-bold text-indigo-700">
                    {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Affluenza Settimanale - 25% */}
        <div className="lg:col-span-1 bg-white p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="flex flex-col gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-800">Affluenza Settimanale</h2>
              <p className="text-xs text-slate-500">{weekRange}</p>
            </div>
            <div className="flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
              <button
                onClick={() => setChartShiftFilter('ALL')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'ALL'
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setChartShiftFilter('LUNCH')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'LUNCH'
                    ? 'bg-amber-100 text-amber-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Pranzo
              </button>
              <button
                onClick={() => setChartShiftFilter('DINNER')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'DINNER'
                    ? 'bg-indigo-100 text-indigo-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Cena
              </button>
            </div>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyChartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{fill: '#64748b', fontSize: 9}}
                />
                <YAxis
                  domain={[0, 'auto']}
                  axisLine={false}
                  tickLine={false}
                  tick={{fill: '#64748b', fontSize: 9}}
                  width={25}
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
      </div>

      {/* Row 3: Attività + Spesa del giorno */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 lg:gap-8">
        {/* Attività (Todo List) */}
        <div ref={todoSectionRef} className="bg-white p-6 lg:p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-indigo-50 text-indigo-600 rounded-xl">
                <ListTodo className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl lg:text-2xl font-semibold text-slate-800">Attività</h2>
                <p className="text-base text-slate-500">{pendingCount} da completare</p>
              </div>
            </div>
            <button
              onClick={handleOpenAddTodo}
              className="p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-1 mb-4 p-1 bg-slate-100 rounded-lg">
            {[
              { key: 'mine', label: 'Mie', icon: UserCircle },
              { key: 'all', label: 'Tutte', icon: ListTodo },
              { key: 'pending', label: 'Da fare', icon: Circle },
              { key: 'completed', label: 'Fatte', icon: CheckCircle2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTodoFilter(key as typeof todoFilter)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                  todoFilter === key
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Overdue Alert */}
          {overdueTodos.length > 0 && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-100 rounded-xl flex items-center gap-3">
              <AlertTriangle className="h-5 w-5 text-rose-500 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-rose-700">{overdueTodos.length} attività scadute</p>
                <p className="text-xs text-rose-600">{overdueTodos.map(t => t.title).slice(0, 2).join(', ')}{overdueTodos.length > 2 ? '...' : ''}</p>
              </div>
            </div>
          )}

          {/* Todo List */}
          <div className="flex-1 overflow-y-auto max-h-[300px] space-y-2">
            {todosLoading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-8 w-8 text-indigo-400 mx-auto mb-2 animate-spin" />
                <p className="text-slate-400 text-sm">Caricamento attività...</p>
              </div>
            ) : filteredTodos.length === 0 ? (
              <div className="py-8 text-center">
                <CheckCircle2 className="h-10 w-10 text-slate-300 mx-auto mb-2" />
                <p className="text-slate-400 text-sm">
                  {todoFilter === 'mine' ? 'Nessuna attività assegnata a te' : 'Nessuna attività'}
                </p>
              </div>
            ) : (
              filteredTodos.map(todo => {
                const isOverdue = todo.dueDate && todo.dueDate < todayStr && !todo.completed;
                return (
                  <div
                    key={todo.id}
                    className={`group p-3 rounded-xl border transition-all hover:shadow-sm ${
                      todo.completed
                        ? 'bg-slate-50 border-slate-100'
                        : isOverdue
                        ? 'bg-rose-50 border-rose-100'
                        : 'bg-white border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => handleToggleTodo(todo.id)}
                        className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                          todo.completed
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'border-slate-300 hover:border-indigo-400'
                        }`}
                      >
                        {todo.completed && <Check className="h-3 w-3" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm font-medium ${todo.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                            {todo.title}
                          </p>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => handleOpenEditTodo(todo)}
                              className="p-1 text-slate-400 hover:text-indigo-600 transition-colors"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteTodo(todo.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_COLORS[todo.category]}`}>
                            {CATEGORY_LABELS[todo.category]}
                          </span>
                          <Flag className={`h-3.5 w-3.5 ${PRIORITY_COLORS[todo.priority]}`} />
                          {todo.assignedToUserName && (
                            <span className="text-xs text-slate-500 flex items-center gap-1">
                              <UserCircle className="h-3 w-3" />
                              {todo.assignedToUserName}
                            </span>
                          )}
                          {todo.assignedToTeam && !todo.assignedToUserId && (
                            <span className={`text-xs px-2 py-0.5 rounded-full ${TEAM_COLORS[todo.assignedToTeam]}`}>
                              {TEAM_LABELS[todo.assignedToTeam]}
                            </span>
                          )}
                          {todo.dueDate && (
                            <span className={`text-xs flex items-center gap-1 ${isOverdue ? 'text-rose-600 font-medium' : 'text-slate-400'}`}>
                              <Clock className="h-3 w-3" />
                              {new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Spesa del Giorno (Shopping List) */}
        <div className="bg-white p-6 lg:p-8 rounded-2xl shadow-sm border border-slate-100 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2.5 bg-emerald-50 text-emerald-600 rounded-xl">
                <ShoppingCart className="h-6 w-6" />
              </div>
              <div>
                <h2 className="text-xl lg:text-2xl font-semibold text-slate-800">Spesa del Giorno</h2>
                <p className="text-base text-slate-500">{isToday ? 'Oggi' : selectedDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · {checkedItems}/{totalItems} completati</p>
              </div>
            </div>
            {checkedItems > 0 && (
              <button
                onClick={clearCheckedItems}
                className="text-sm text-slate-500 hover:text-rose-600 transition-colors"
              >
                Rimuovi completati
              </button>
            )}
          </div>

          {/* Add Item Form */}
          <div className="flex gap-2 mb-4">
            <input
              type="text"
              value={newItemName}
              onChange={(e) => setNewItemName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addShoppingItem()}
              placeholder="Aggiungi prodotto..."
              className="flex-1 px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-transparent outline-none"
            />
            <select
              value={newItemCategory}
              onChange={(e) => setNewItemCategory(e.target.value as ShoppingCategory)}
              className="px-2 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none"
            >
              <option value="CUCINA">Cucina</option>
              <option value="BAR">Bar</option>
              <option value="ALTRO">Altro</option>
            </select>
            <button
              onClick={addShoppingItem}
              disabled={!newItemName.trim()}
              className="p-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-5 w-5" />
            </button>
          </div>

          {/* Shopping List by Category */}
          <div className="flex-1 overflow-y-auto max-h-[300px] space-y-4">
            {shoppingLoading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-8 w-8 text-emerald-400 mx-auto mb-2 animate-spin" />
                <p className="text-slate-400 text-sm">Caricamento...</p>
              </div>
            ) : totalItems === 0 ? (
              <div className="py-8 text-center">
                <ShoppingCart className="h-10 w-10 text-slate-300 mx-auto mb-2" />
                <p className="text-slate-400 text-sm">Nessun prodotto nella lista</p>
              </div>
            ) : (
              (['CUCINA', 'BAR', 'ALTRO'] as ShoppingCategory[]).map(category => {
                const items = shoppingByCategory[category];
                if (items.length === 0) return null;
                return (
                  <div key={category}>
                    <div className={`flex items-center gap-2 px-2 py-1 rounded-lg ${SHOPPING_CATEGORY_COLORS[category]} mb-2`}>
                      {SHOPPING_CATEGORY_ICONS[category]}
                      <span className="text-xs font-medium">{SHOPPING_CATEGORY_LABELS[category]}</span>
                      <span className="text-xs opacity-70">({items.length})</span>
                    </div>
                    <div className="space-y-2 pl-2">
                      {items.map(item => (
                        <div key={item.id} className="group">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => toggleShoppingItem(item.id)}
                              className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
                                item.checked
                                  ? 'bg-emerald-500 border-emerald-500 text-white'
                                  : 'border-slate-300 hover:border-emerald-400'
                              }`}
                            >
                              {item.checked && <Check className="h-2.5 w-2.5" />}
                            </button>
                            <span className={`flex-1 text-sm ${item.checked ? 'line-through text-slate-400' : 'text-slate-700'}`}>
                              {item.name}
                            </span>
                            <button
                              onClick={() => deleteShoppingItem(item.id)}
                              className="p-1 text-slate-300 hover:text-rose-500 opacity-0 group-hover:opacity-100 transition-all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="ml-6 text-xs text-slate-400">
                            {item.createdByUserName ? item.createdByUserName.split('@')[0] : 'Anonimo'}
                            {item.createdAt && (
                              <> • {new Date(item.createdAt).toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })} {new Date(item.createdAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Row 4: Staff Presence */}
      <div className="bg-white p-5 lg:p-6 rounded-2xl shadow-sm border border-slate-100">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2.5 bg-violet-50 text-violet-600 rounded-xl">
            <UsersRound className="h-6 w-6" />
          </div>
          <div>
            <h2 className="text-lg lg:text-xl font-semibold text-slate-800">Personale in Servizio</h2>
            <p className="text-sm text-slate-500">{isToday ? 'Oggi' : selectedDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</p>
          </div>
        </div>

        {staffLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-violet-400" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Pranzo */}
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 border border-amber-100">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-amber-200 flex items-center justify-center">
                  <span className="text-amber-700 text-sm font-bold">P</span>
                </div>
                <span className="font-semibold text-amber-800">Pranzo</span>
                <span className="ml-auto text-sm text-amber-600">
                  {staffPresence.lunch.sala.length + staffPresence.lunch.cucina.length} persone
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* Sala */}
                <div className="bg-white/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users className="h-4 w-4 text-emerald-600" />
                    <span className="text-xs font-medium text-emerald-700">Sala</span>
                    <span className="ml-auto text-xs text-slate-500">{staffPresence.lunch.sala.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.lunch.sala.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">Nessuno</p>
                    ) : (
                      staffPresence.lunch.sala.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center text-[10px] font-medium text-emerald-700">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-slate-700 truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Cucina */}
                <div className="bg-white/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <ChefHat className="h-4 w-4 text-orange-600" />
                    <span className="text-xs font-medium text-orange-700">Cucina</span>
                    <span className="ml-auto text-xs text-slate-500">{staffPresence.lunch.cucina.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.lunch.cucina.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">Nessuno</p>
                    ) : (
                      staffPresence.lunch.cucina.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center text-[10px] font-medium text-orange-700">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-slate-700 truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Cena */}
            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-8 h-8 rounded-lg bg-indigo-200 flex items-center justify-center">
                  <span className="text-indigo-700 text-sm font-bold">C</span>
                </div>
                <span className="font-semibold text-indigo-800">Cena</span>
                <span className="ml-auto text-sm text-indigo-600">
                  {staffPresence.dinner.sala.length + staffPresence.dinner.cucina.length} persone
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* Sala */}
                <div className="bg-white/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users className="h-4 w-4 text-emerald-600" />
                    <span className="text-xs font-medium text-emerald-700">Sala</span>
                    <span className="ml-auto text-xs text-slate-500">{staffPresence.dinner.sala.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.dinner.sala.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">Nessuno</p>
                    ) : (
                      staffPresence.dinner.sala.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center text-[10px] font-medium text-emerald-700">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-slate-700 truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Cucina */}
                <div className="bg-white/60 rounded-lg p-2.5">
                  <div className="flex items-center gap-1.5 mb-2">
                    <ChefHat className="h-4 w-4 text-orange-600" />
                    <span className="text-xs font-medium text-orange-700">Cucina</span>
                    <span className="ml-auto text-xs text-slate-500">{staffPresence.dinner.cucina.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.dinner.cucina.length === 0 ? (
                      <p className="text-xs text-slate-400 italic">Nessuno</p>
                    ) : (
                      staffPresence.dinner.cucina.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center text-[10px] font-medium text-orange-700">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-slate-700 truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* My Tasks Modal */}
      {showMyTasksModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between bg-gradient-to-r from-indigo-500 to-purple-600">
              <div className="flex items-center gap-3 text-white">
                <div className="p-2 bg-white/20 rounded-lg">
                  <UserCircle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">Le Mie Attività</h3>
                  <p className="text-sm text-white/80">{myTodos.length} {myTodos.length === 1 ? 'attività' : 'attività'} da completare</p>
                </div>
              </div>
              <button onClick={() => setShowMyTasksModal(false)} className="p-1 hover:bg-white/20 rounded-lg transition-colors">
                <X className="h-5 w-5 text-white" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {myTodos.length === 0 ? (
                <div className="py-12 text-center">
                  <CheckCircle2 className="h-12 w-12 text-emerald-400 mx-auto mb-3" />
                  <p className="text-slate-600 font-medium">Tutto fatto!</p>
                  <p className="text-slate-400 text-sm">Non hai attività assegnate</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {myTodos.map(todo => {
                    const isOverdue = todo.dueDate && todo.dueDate < todayStr;
                    return (
                      <div key={todo.id} className={`p-4 rounded-xl border ${isOverdue ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'} hover:shadow-md transition-shadow`}>
                        <div className="flex items-start gap-3">
                          <button
                            onClick={() => handleToggleTodo(todo.id)}
                            className="mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 border-slate-300 hover:border-indigo-400 flex items-center justify-center transition-colors"
                          >
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className="font-medium text-slate-800">{todo.title}</p>
                              <Flag className={`h-4 w-4 flex-shrink-0 ${PRIORITY_COLORS[todo.priority]}`} />
                            </div>
                            {todo.description && (
                              <p className="text-sm text-slate-500 mt-1">{todo.description}</p>
                            )}
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className={`text-xs px-2 py-1 rounded-full ${CATEGORY_COLORS[todo.category]}`}>
                                {CATEGORY_LABELS[todo.category]}
                              </span>
                              {isAssignedToMe(todo) && (
                                <span className="text-xs px-2 py-1 rounded-full bg-blue-100 text-blue-700 flex items-center gap-1">
                                  <UserCircle className="h-3 w-3" /> Personale
                                </span>
                              )}
                              {isAssignedToMyTeam(todo) && !isAssignedToMe(todo) && (
                                <span className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 ${TEAM_COLORS[todo.assignedToTeam!]}`}>
                                  <UsersRound className="h-3 w-3" /> {TEAM_LABELS[todo.assignedToTeam!]}
                                </span>
                              )}
                              {todo.dueDate && (
                                <span className={`text-xs flex items-center gap-1 ${isOverdue ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
                                  <Clock className="h-3 w-3" />
                                  {isOverdue ? 'Scaduto: ' : ''}
                                  {new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 bg-slate-50">
              <button
                onClick={() => setShowMyTasksModal(false)}
                className="w-full px-4 py-3 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium"
              >
                Chiudi
              </button>
            </div>
          </div>
        </div>
      )}

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
