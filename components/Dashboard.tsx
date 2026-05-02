import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Reservation, Table, Dish, Room, Shift, ArrivalStatus, TodoItem, TodoPriority, TodoCategory, UserRole, User, StaffMember, StaffShift, StaffTimeOff, StaffCategory, StaffType, BanquetMenu } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { todoApiService } from '../services/todoApiService';
import { shoppingApiService, ShoppingItem, ShoppingCategory } from '../services/shoppingApiService';
import { staffApiService } from '../services/staffApiService';
import { authApiService } from '../services/authApiService';
import { socketClient } from '../services/socketClient';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
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
  onNewReservation?: () => void;
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

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms, banquetMenus, onNavigateToBanquets, onNewReservation }) => {
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
  const [deleteTodoConfirm, setDeleteTodoConfirm] = useState<TodoItem | null>(null);
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
    <div className="p-4 sm:p-6 lg:p-8 space-y-5 sm:space-y-6 lg:space-y-8 bg-[var(--color-surface-2)]">
      {/* Header with Calendar Navigation */}
      {(() => {
        const hour = currentTime.getHours();
        const greeting =
          hour >= 5 && hour < 12 ? 'Buongiorno'
          : hour >= 12 && hour < 18 ? 'Buon pomeriggio'
          : hour >= 18 && hour < 23 ? 'Buonasera'
          : 'Buonanotte';
        const firstName = user?.full_name?.trim().split(' ')[0] || 'Utente';
        // Service window: lunch 11:00-15:30, dinner 18:00-23:30
        const minutes = hour * 60 + currentTime.getMinutes();
        const inLunch = minutes >= 11 * 60 && minutes < 15 * 60 + 30;
        const inDinner = minutes >= 18 * 60 && minutes < 23 * 60 + 30;
        const serviceLabel = inLunch
          ? { text: 'Servizio pranzo · In corso', dot: 'bg-emerald-500', color: 'text-emerald-700' }
          : inDinner
          ? { text: 'Servizio cena · In corso', dot: 'bg-emerald-500', color: 'text-emerald-700' }
          : { text: 'Fuori servizio', dot: 'bg-[var(--color-fg-subtle)]', color: 'text-[var(--color-fg-muted)]' };
        return (
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-2">
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

            {/* Date navigator + time chip + new reservation button */}
            <div className="flex flex-wrap items-center gap-2 self-stretch md:self-auto w-full md:w-auto">
              {/* Date pill with fixed-position arrows */}
              <div className="flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5 flex-1 md:flex-none min-w-0">
                {!isToday && (
                  <button
                    onClick={goToToday}
                    className="px-3 py-1.5 text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] rounded-full transition-colors"
                  >
                    Oggi
                  </button>
                )}

                <button
                  onClick={goToPreviousDay}
                  className="p-1.5 rounded-full text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors flex-shrink-0"
                  aria-label="Giorno precedente"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>

                <div className="relative flex-1 md:w-[200px] md:flex-none flex justify-center min-w-0">
                  <div className="flex items-center justify-center px-3 py-1.5 rounded-full pointer-events-none">
                    <span className="tabular font-medium text-sm text-[var(--color-fg)] whitespace-nowrap capitalize">
                      {formatDate(selectedDate)}
                    </span>
                  </div>
                  <input
                    ref={dateInputRef}
                    type="date"
                    value={selectedDateStr}
                    onChange={handleDateInputChange}
                    onClick={(e) => {
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
                  className="p-1.5 rounded-full text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors flex-shrink-0"
                  aria-label="Giorno successivo"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>

              {/* Separate time chip — always shows live current time */}
              <div className="flex items-center gap-1.5 bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] px-3 py-2">
                <Clock className="h-3.5 w-3.5 text-[var(--color-fg-muted)] flex-shrink-0" />
                <span className="tabular font-medium text-sm text-[var(--color-fg)] whitespace-nowrap">
                  {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* Nuova prenotazione — primary CTA (desktop only; mobile uses floating FAB) */}
              {onNewReservation && (
                <button
                  type="button"
                  onClick={onNewReservation}
                  className="hidden md:inline-flex items-center justify-center gap-1.5 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] px-4 py-2 text-sm font-medium hover:opacity-90 transition-opacity shadow-[var(--shadow-sm)]"
                >
                  <Plus className="h-4 w-4" />
                  Nuova prenotazione
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* My Tasks Alert Banner */}
      {myTodos.length > 0 && (
        <div className="bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] p-4 rounded-xl shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-white/10 rounded-md">
                <UserCircle className="h-5 w-5" />
              </div>
              <div>
                <h3 className="font-semibold text-sm">Hai <span className="tabular">{myTodos.length}</span> {myTodos.length === 1 ? 'attività assegnata' : 'attività assegnate'}</h3>
                <p className="text-xs text-white/70">
                  {myTodos.filter(isAssignedToMe).length > 0 && (
                    <span><span className="tabular">{myTodos.filter(isAssignedToMe).length}</span> personali</span>
                  )}
                  {myTodos.filter(isAssignedToMe).length > 0 && myTodos.filter(isAssignedToMyTeam).length > 0 && ' · '}
                  {myTodos.filter(isAssignedToMyTeam).length > 0 && (
                    <span><span className="tabular">{myTodos.filter(isAssignedToMyTeam).length}</span> del team {user?.role && TEAM_LABELS[user.role]}</span>
                  )}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowMyTasksModal(true)}
              className="rounded-full px-4 py-2 bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
            >
              Visualizza
            </button>
          </div>
        </div>
      )}

      {/* KPI Cards — per shift (Pranzo / Cena), tinted meal-blocks */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 sm:gap-4 lg:gap-5">
        {/* Ospiti attesi */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-5 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Ospiti attesi</h3>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0"><Users className="h-4 w-4" /></span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                  <Sun className="h-3.5 w-3.5" />
                </span>
                Pranzo
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{lunchExpectedGuests}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Moon className="h-3.5 w-3.5" />
                </span>
                Cena
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{dinnerExpectedGuests}</span>
            </div>
          </div>
        </div>

        {/* Ospiti arrivati */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-5 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Ospiti arrivati</h3>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0"><Users className="h-4 w-4" /></span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                  <Sun className="h-3.5 w-3.5" />
                </span>
                Pranzo
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{lunchArrivedGuests}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Moon className="h-3.5 w-3.5" />
                </span>
                Cena
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{dinnerArrivedGuests}</span>
            </div>
          </div>
        </div>

        {/* Tavoli attesi */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-5 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Tavoli attesi</h3>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0"><Armchair className="h-4 w-4" /></span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                  <Sun className="h-3.5 w-3.5" />
                </span>
                Pranzo
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{lunchTableIds.size}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Moon className="h-3.5 w-3.5" />
                </span>
                Cena
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{dinnerTableIds.size}</span>
            </div>
          </div>
        </div>

        {/* Tavoli arrivati */}
        <div className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-5 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Tavoli arrivati</h3>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0"><Armchair className="h-4 w-4" /></span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                  <Sun className="h-3.5 w-3.5" />
                </span>
                Pranzo
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{lunchArrivedTableIds.size}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Moon className="h-3.5 w-3.5" />
                </span>
                Cena
              </span>
              <span className="tabular text-[28px] leading-none font-semibold text-[var(--color-fg)]">{dinnerArrivedTableIds.size}</span>
            </div>
          </div>
        </div>

        {/* Prenotazioni & Banchetti */}
        <button
          type="button"
          onClick={onNavigateToBanquets}
          className="bg-[var(--color-surface)] rounded-2xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] p-5 flex flex-col gap-4 text-left hover:bg-[var(--color-surface-hover)] transition-colors group"
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)] tracking-tight">Prenotazioni & banchetti</h3>
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] flex-shrink-0 group-hover:text-[var(--color-fg)] group-hover:translate-x-0.5 transition-all"><ChevronRight className="h-4 w-4" /></span>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between rounded-xl bg-amber-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
                  <Sun className="h-3.5 w-3.5" />
                </span>
                Pranzo
              </span>
              <span className="tabular text-[24px] leading-none font-semibold text-[var(--color-fg)]">{lunchReservations.length}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-indigo-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-100 text-indigo-600">
                  <Moon className="h-3.5 w-3.5" />
                </span>
                Cena
              </span>
              <span className="tabular text-[24px] leading-none font-semibold text-[var(--color-fg)]">{dinnerReservations.length}</span>
            </div>
            <div className="flex items-center justify-between rounded-xl bg-rose-50 px-3 py-2.5">
              <span className="inline-flex items-center gap-2 text-[14px] font-medium text-[var(--color-fg)]">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-rose-100 text-rose-600">
                  <Calendar className="h-3.5 w-3.5" />
                </span>
                Banchetti
              </span>
              <span className="tabular text-[24px] leading-none font-semibold text-rose-600">{banquetsToday}</span>
            </div>
          </div>
        </button>
      </div>

      {/* Row 1: Stato Tavoli (full width) */}
      <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
        <h2 className="text-base lg:text-lg font-semibold mb-4 text-[var(--color-fg)]">Stato Tavoli</h2>

        {/* Shift Occupancy Summary */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          <div className="bg-[var(--color-surface-3)] rounded-lg p-3 sm:p-4 border border-[var(--color-line)]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Pranzo</span>
              <span className="tabular text-[11px] sm:text-xs text-[var(--color-fg-muted)] whitespace-nowrap">{lunchTableIds.size}/{totalTables} tavoli</span>
            </div>
            <div className="flex flex-wrap items-end gap-x-2 gap-y-0">
              <span className="tabular text-2xl sm:text-3xl font-semibold text-[var(--color-fg)] leading-none">{lunchOccupancy}%</span>
              <span className="text-xs sm:text-sm text-[var(--color-fg-muted)] mb-0.5 sm:mb-1">occupazione</span>
            </div>
            <div className="mt-2 h-1.5 bg-[var(--color-surface-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-amber-500 rounded-full transition-all duration-500" style={{ width: `${lunchOccupancy}%` }} />
            </div>
            <p className="tabular text-[11px] sm:text-xs text-[var(--color-fg-muted)] mt-2">{lunchReservations.length} prenotazioni · {lunchReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti</p>
          </div>

          <div className="bg-[var(--color-surface-3)] rounded-lg p-3 sm:p-4 border border-[var(--color-line)]">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-0.5 sm:gap-2 mb-2">
              <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Cena</span>
              <span className="tabular text-[11px] sm:text-xs text-[var(--color-fg-muted)] whitespace-nowrap">{dinnerTableIds.size}/{totalTables} tavoli</span>
            </div>
            <div className="flex flex-wrap items-end gap-x-2 gap-y-0">
              <span className="tabular text-2xl sm:text-3xl font-semibold text-[var(--color-fg)] leading-none">{dinnerOccupancy}%</span>
              <span className="text-xs sm:text-sm text-[var(--color-fg-muted)] mb-0.5 sm:mb-1">occupazione</span>
            </div>
            <div className="mt-2 h-1.5 bg-[var(--color-surface-hover)] rounded-full overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full transition-all duration-500" style={{ width: `${dinnerOccupancy}%` }} />
            </div>
            <p className="tabular text-[11px] sm:text-xs text-[var(--color-fg-muted)] mt-2">{dinnerReservations.length} prenotazioni · {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti</p>
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
              <div key={room.id} className="border border-[var(--color-line)] rounded-md p-2 hover:bg-[var(--color-surface-hover)] transition-colors bg-[var(--color-surface)]">
                <div className="flex items-center justify-between mb-1">
                  <h3 className="font-medium text-[var(--color-fg)] text-xs truncate">{room.name}</h3>
                  <span className="tabular text-[10px] text-[var(--color-fg-subtle)]">{roomTables.length}</span>
                </div>
                <div className="flex gap-1">
                  <div className="flex-1 bg-[var(--color-surface-3)] rounded px-1 py-0.5 border border-[var(--color-line)] text-center">
                    <span className={`tabular text-[10px] font-semibold ${roomLunchAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {roomLunchAvailable}
                    </span>
                  </div>
                  <div className="flex-1 bg-[var(--color-surface-3)] rounded px-1 py-0.5 border border-[var(--color-line)] text-center">
                    <span className={`tabular text-[10px] font-semibold ${roomDinnerAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
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
        <div className="lg:col-span-3 bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Affluenza per Orario</h2>
            <div className="flex rounded-md border border-[var(--color-line)] p-0.5 bg-[var(--color-surface-3)]">
              <button
                onClick={() => setAffluenceShiftFilter('ALL')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  affluenceShiftFilter === 'ALL'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setAffluenceShiftFilter('LUNCH')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  affluenceShiftFilter === 'LUNCH'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Pranzo
              </button>
              <button
                onClick={() => setAffluenceShiftFilter('DINNER')}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                  affluenceShiftFilter === 'DINNER'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Cena
              </button>
            </div>
          </div>

          <div className="space-y-4 max-h-[400px] overflow-y-auto">
            {timeSlotAffluence.roomTimeSlots.map(room => (
              <div key={room.roomId} className="border border-[var(--color-line)] rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-medium text-sm text-[var(--color-fg)]">{room.roomName}</h3>
                  <span className="tabular text-xs text-[var(--color-fg-subtle)]">Max {room.maxCapacity} coperti</span>
                </div>

                {/* Lunch Time Slots */}
                {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'LUNCH') && (
                  <div className={affluenceShiftFilter === 'ALL' ? 'mb-2' : ''}>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] w-16">Pranzo</span>
                      <span className="tabular text-[10px] text-[var(--color-fg-subtle)]">{room.totalLunchGuests}/{room.maxCapacity} ({room.lunchPercentage}%)</span>
                    </div>
                    <div className={`flex ${affluenceShiftFilter === 'LUNCH' ? 'gap-2' : 'gap-1'}`}>
                      {room.lunchSlots.map(slot => (
                        <div key={slot.time} className="flex-1 text-center">
                          <div className={`tabular text-[var(--color-fg-subtle)] mb-0.5 ${affluenceShiftFilter === 'LUNCH' ? 'text-xs' : 'text-[9px]'}`}>{slot.time}</div>
                          <div className={`relative overflow-hidden rounded bg-[var(--color-surface-3)] ${affluenceShiftFilter === 'LUNCH' ? 'h-12' : ''}`}>
                            <div
                              className="absolute inset-y-0 left-0 bg-amber-200 transition-all duration-300"
                              style={{ width: `${Math.min(slot.percentage, 100)}%` }}
                            />
                            <div className={`tabular relative font-semibold z-10 flex items-center justify-center ${affluenceShiftFilter === 'LUNCH' ? 'text-base h-12' : 'text-xs py-0.5'} ${slot.guests > 0 ? 'text-amber-800' : 'text-[var(--color-fg-subtle)]'}`}>
                              {slot.guests}
                            </div>
                          </div>
                          {affluenceShiftFilter === 'LUNCH' && (
                            <div className="tabular text-[10px] text-[var(--color-fg-subtle)] mt-0.5">{slot.percentage}%</div>
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
                      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] w-16">Cena</span>
                      <span className="tabular text-[10px] text-[var(--color-fg-subtle)]">{room.totalDinnerGuests}/{room.maxCapacity} ({room.dinnerPercentage}%)</span>
                    </div>
                    <div className={`flex overflow-x-auto ${affluenceShiftFilter === 'DINNER' ? 'gap-1.5' : 'gap-0.5'}`}>
                      {room.dinnerSlots.map(slot => (
                        <div key={slot.time} className={`flex-1 text-center ${affluenceShiftFilter === 'DINNER' ? 'min-w-[50px]' : 'min-w-[32px]'}`}>
                          <div className={`tabular text-[var(--color-fg-subtle)] mb-0.5 ${affluenceShiftFilter === 'DINNER' ? 'text-[10px]' : 'text-[8px]'}`}>{slot.time.substring(0, 5)}</div>
                          <div className={`relative overflow-hidden rounded bg-[var(--color-surface-3)] ${affluenceShiftFilter === 'DINNER' ? 'h-12' : ''}`}>
                            <div
                              className="absolute inset-y-0 left-0 bg-indigo-200 transition-all duration-300"
                              style={{ width: `${Math.min(slot.percentage, 100)}%` }}
                            />
                            <div className={`tabular relative font-semibold z-10 flex items-center justify-center ${affluenceShiftFilter === 'DINNER' ? 'text-base h-12' : 'text-xs py-0.5'} ${slot.guests > 0 ? 'text-indigo-800' : 'text-[var(--color-fg-subtle)]'}`}>
                              {slot.guests}
                            </div>
                          </div>
                          {affluenceShiftFilter === 'DINNER' && (
                            <div className="tabular text-[10px] text-[var(--color-fg-subtle)] mt-0.5">{slot.percentage}%</div>
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
          <div className={`mt-4 pt-3 border-t border-[var(--color-line)] grid gap-3 ${affluenceShiftFilter === 'ALL' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'LUNCH') && (
              <div className="bg-[var(--color-surface-3)] rounded-md p-2.5 border border-[var(--color-line)]">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Totale Pranzo</span>
                  <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                    {lunchReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                  </span>
                </div>
              </div>
            )}
            {(affluenceShiftFilter === 'ALL' || affluenceShiftFilter === 'DINNER') && (
              <div className="bg-[var(--color-surface-3)] rounded-md p-2.5 border border-[var(--color-line)]">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Totale Cena</span>
                  <span className="tabular text-sm font-semibold text-[var(--color-fg)]">
                    {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)}/{timeSlotAffluence.totalCapacity}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Affluenza Settimanale - 25% */}
        <div className="lg:col-span-1 bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
          <div className="flex flex-col gap-3 mb-4">
            <div>
              <h2 className="text-base font-semibold text-[var(--color-fg)]">Affluenza Settimanale</h2>
              <p className="tabular text-xs text-[var(--color-fg-muted)]">{weekRange}</p>
            </div>
            <div className="flex rounded-md border border-[var(--color-line)] p-0.5 bg-[var(--color-surface-3)]">
              <button
                onClick={() => setChartShiftFilter('ALL')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                  chartShiftFilter === 'ALL'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setChartShiftFilter('LUNCH')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                  chartShiftFilter === 'LUNCH'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Pranzo
              </button>
              <button
                onClick={() => setChartShiftFilter('DINNER')}
                className={`flex-1 px-2 py-1 text-[10px] font-medium rounded transition-colors ${
                  chartShiftFilter === 'DINNER'
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                Cena
              </button>
            </div>
          </div>
          <div className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyChartData} margin={{ top: 5, right: 5, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="var(--color-chart-grid)" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  stroke="var(--color-chart-axis)"
                  tick={{fill: 'var(--color-chart-axis)', fontSize: 9}}
                />
                <YAxis
                  domain={[0, 'auto']}
                  axisLine={false}
                  tickLine={false}
                  stroke="var(--color-chart-axis)"
                  tick={{fill: 'var(--color-chart-axis)', fontSize: 9}}
                  width={25}
                />
                <Tooltip
                  cursor={{fill: 'var(--color-surface-hover)'}}
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
                  fill={chartShiftFilter === 'LUNCH' ? 'var(--color-chart-2)' : chartShiftFilter === 'DINNER' ? 'var(--color-chart-1)' : 'var(--color-chart-1)'}
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
        <div ref={todoSectionRef} className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] rounded-md">
                <ListTodo className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Attività</h2>
                <p className="tabular text-xs text-[var(--color-fg-muted)]">{pendingCount} da completare</p>
              </div>
            </div>
            <button
              onClick={handleOpenAddTodo}
              className="rounded-full p-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 transition"
              aria-label="Aggiungi attività"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-1 mb-4 p-0.5 bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-md">
            {[
              { key: 'mine', label: 'Mie', icon: UserCircle },
              { key: 'all', label: 'Tutte', icon: ListTodo },
              { key: 'pending', label: 'Da fare', icon: Circle },
              { key: 'completed', label: 'Fatte', icon: CheckCircle2 },
            ].map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTodoFilter(key as typeof todoFilter)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                  todoFilter === key
                    ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                    : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* Overdue Alert */}
          {overdueTodos.length > 0 && (
            <div className="mb-4 p-3 bg-rose-50 border border-rose-100 rounded-md flex items-center gap-3">
              <AlertTriangle className="h-4 w-4 text-rose-600 flex-shrink-0" />
              <div>
                <p className="tabular text-sm font-medium text-rose-700">{overdueTodos.length} attività scadute</p>
                <p className="text-xs text-rose-600">{overdueTodos.map(t => t.title).slice(0, 2).join(', ')}{overdueTodos.length > 2 ? '...' : ''}</p>
              </div>
            </div>
          )}

          {/* Todo List */}
          <div className="flex-1 overflow-y-auto max-h-[300px] space-y-2">
            {todosLoading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-6 w-6 text-[var(--color-fg-subtle)] mx-auto mb-2 animate-spin" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Caricamento attività...</p>
              </div>
            ) : filteredTodos.length === 0 ? (
              <div className="py-8 text-center">
                <CheckCircle2 className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
                <p className="text-[var(--color-fg-subtle)] text-sm">
                  {todoFilter === 'mine' ? 'Nessuna attività assegnata a te' : 'Nessuna attività'}
                </p>
              </div>
            ) : (
              filteredTodos.map(todo => {
                const isOverdue = todo.dueDate && todo.dueDate < todayStr && !todo.completed;
                return (
                  <div
                    key={todo.id}
                    className={`group p-3 rounded-md border transition-colors ${
                      todo.completed
                        ? 'bg-[var(--color-surface-3)] border-[var(--color-line)]'
                        : isOverdue
                        ? 'bg-rose-50 border-rose-100'
                        : 'bg-[var(--color-surface)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        onClick={() => handleToggleTodo(todo.id)}
                        className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                          todo.completed
                            ? 'bg-emerald-500 border-emerald-500 text-white'
                            : 'border-[var(--color-line-strong)] hover:border-[var(--color-fg)]'
                        }`}
                      >
                        {todo.completed && <Check className="h-2.5 w-2.5" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-start justify-between gap-2">
                          <p className={`text-sm font-medium ${todo.completed ? 'line-through text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}>
                            {todo.title}
                          </p>
                          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                              onClick={() => handleOpenEditTodo(todo)}
                              className="p-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                            >
                              <Edit2 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteTodoConfirm(todo)}
                              className="p-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-rose-600 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${CATEGORY_COLORS[todo.category]}`}>
                            {CATEGORY_LABELS[todo.category]}
                          </span>
                          <Flag className={`h-3.5 w-3.5 ${PRIORITY_COLORS[todo.priority]}`} />
                          {todo.assignedToUserName && (
                            <span className="text-[11px] text-[var(--color-fg-muted)] flex items-center gap-1">
                              <UserCircle className="h-3 w-3" />
                              {todo.assignedToUserName}
                            </span>
                          )}
                          {todo.assignedToTeam && !todo.assignedToUserId && (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${TEAM_COLORS[todo.assignedToTeam]}`}>
                              {TEAM_LABELS[todo.assignedToTeam]}
                            </span>
                          )}
                          {todo.dueDate && (
                            <span className={`tabular text-[11px] flex items-center gap-1 ${isOverdue ? 'text-rose-600 font-medium' : 'text-[var(--color-fg-subtle)]'}`}>
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
        <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)] flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] rounded-md">
                <ShoppingCart className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Spesa del Giorno</h2>
                <p className="tabular text-xs text-[var(--color-fg-muted)]">{isToday ? 'Oggi' : selectedDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} · {checkedItems}/{totalItems} completati</p>
              </div>
            </div>
            {checkedItems > 0 && (
              <button
                onClick={clearCheckedItems}
                className="text-xs text-[var(--color-fg-muted)] hover:text-rose-600 transition-colors"
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
              className="flex-1 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />
            <select
              value={newItemCategory}
              onChange={(e) => setNewItemCategory(e.target.value as ShoppingCategory)}
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-2 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="CUCINA">Cucina</option>
              <option value="BAR">Bar</option>
              <option value="ALTRO">Altro</option>
            </select>
            <button
              onClick={addShoppingItem}
              disabled={!newItemName.trim()}
              className="rounded-full p-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
              aria-label="Aggiungi prodotto"
            >
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {/* Shopping List by Category */}
          <div className="flex-1 overflow-y-auto max-h-[300px] space-y-4">
            {shoppingLoading ? (
              <div className="py-8 text-center">
                <Loader2 className="h-6 w-6 text-[var(--color-fg-subtle)] mx-auto mb-2 animate-spin" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Caricamento...</p>
              </div>
            ) : totalItems === 0 ? (
              <div className="py-8 text-center">
                <ShoppingCart className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
                <p className="text-[var(--color-fg-subtle)] text-sm">Nessun prodotto nella lista</p>
              </div>
            ) : (
              (['CUCINA', 'BAR', 'ALTRO'] as ShoppingCategory[]).map(category => {
                const items = shoppingByCategory[category];
                if (items.length === 0) return null;
                return (
                  <div key={category}>
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-[var(--color-fg-muted)]">{SHOPPING_CATEGORY_ICONS[category]}</span>
                      <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">{SHOPPING_CATEGORY_LABELS[category]}</span>
                      <span className="tabular text-[11px] text-[var(--color-fg-subtle)]">({items.length})</span>
                    </div>
                    <div className="space-y-2 pl-1">
                      {items.map(item => (
                        <div key={item.id} className="group">
                          <div className="flex items-center gap-2">
                            <button
                              onClick={() => toggleShoppingItem(item.id)}
                              className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
                                item.checked
                                  ? 'bg-emerald-500 border-emerald-500 text-white'
                                  : 'border-[var(--color-line-strong)] hover:border-[var(--color-fg)]'
                              }`}
                            >
                              {item.checked && <Check className="h-2.5 w-2.5" />}
                            </button>
                            <span className={`flex-1 text-sm ${item.checked ? 'line-through text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}>
                              {item.name}
                            </span>
                            <button
                              onClick={() => deleteShoppingItem(item.id)}
                              className="p-1 rounded text-[var(--color-fg-subtle)] hover:bg-[var(--color-surface-hover)] hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="tabular ml-6 text-[11px] text-[var(--color-fg-subtle)]">
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
      <div className="bg-[var(--color-surface)] p-5 lg:p-6 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] rounded-md">
            <UsersRound className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-base lg:text-lg font-semibold text-[var(--color-fg)]">Personale in Servizio</h2>
            <p className="tabular text-xs text-[var(--color-fg-muted)]">{isToday ? 'Oggi' : selectedDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}</p>
          </div>
        </div>

        {staffLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-[var(--color-fg-subtle)]" />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Pranzo */}
            <div className="bg-[var(--color-surface-3)] rounded-lg p-4 border border-[var(--color-line)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
                  <Sun className="h-4 w-4 text-amber-700" />
                </div>
                <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Pranzo</span>
                <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">
                  {staffPresence.lunch.sala.length + staffPresence.lunch.cucina.length} persone
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* Sala */}
                <div className="bg-[var(--color-surface)] rounded-md p-2.5 border border-[var(--color-line)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                    <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Sala</span>
                    <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">{staffPresence.lunch.sala.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.lunch.sala.length === 0 ? (
                      <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                    ) : (
                      staffPresence.lunch.sala.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-[var(--color-surface-3)] flex items-center justify-center text-[10px] font-medium text-[var(--color-fg)]">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-[var(--color-fg)] truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Cucina */}
                <div className="bg-[var(--color-surface)] rounded-md p-2.5 border border-[var(--color-line)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <ChefHat className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                    <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Cucina</span>
                    <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">{staffPresence.lunch.cucina.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.lunch.cucina.length === 0 ? (
                      <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                    ) : (
                      staffPresence.lunch.cucina.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-[var(--color-surface-3)] flex items-center justify-center text-[10px] font-medium text-[var(--color-fg)]">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-[var(--color-fg)] truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Cena */}
            <div className="bg-[var(--color-surface-3)] rounded-lg p-4 border border-[var(--color-line)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-7 h-7 rounded-md bg-indigo-100 flex items-center justify-center">
                  <Moon className="h-4 w-4 text-indigo-700" />
                </div>
                <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Cena</span>
                <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">
                  {staffPresence.dinner.sala.length + staffPresence.dinner.cucina.length} persone
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* Sala */}
                <div className="bg-[var(--color-surface)] rounded-md p-2.5 border border-[var(--color-line)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Users className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                    <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Sala</span>
                    <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">{staffPresence.dinner.sala.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.dinner.sala.length === 0 ? (
                      <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                    ) : (
                      staffPresence.dinner.sala.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-[var(--color-surface-3)] flex items-center justify-center text-[10px] font-medium text-[var(--color-fg)]">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-[var(--color-fg)] truncate">{s.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {/* Cucina */}
                <div className="bg-[var(--color-surface)] rounded-md p-2.5 border border-[var(--color-line)]">
                  <div className="flex items-center gap-1.5 mb-2">
                    <ChefHat className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                    <span className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Cucina</span>
                    <span className="tabular ml-auto text-xs text-[var(--color-fg-muted)]">{staffPresence.dinner.cucina.length}</span>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-1">
                    {staffPresence.dinner.cucina.length === 0 ? (
                      <p className="text-xs text-[var(--color-fg-subtle)] italic">Nessuno</p>
                    ) : (
                      staffPresence.dinner.cucina.map(s => (
                        <div key={s.id} className="flex items-center gap-1.5">
                          <div className="w-5 h-5 rounded-full bg-[var(--color-surface-3)] flex items-center justify-center text-[10px] font-medium text-[var(--color-fg)]">
                            {s.name[0]}{s.surname[0]}
                          </div>
                          <span className="text-xs text-[var(--color-fg)] truncate">{s.name}</span>
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
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-sm)] border border-[var(--color-line)] w-full max-w-lg max-h-[80vh] overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col">
            <div className="p-4 border-b border-[var(--color-line)] flex items-center justify-between bg-[var(--color-fg)]">
              <div className="flex items-center gap-3 text-[var(--color-fg-on-brand)]">
                <div className="p-2 bg-white/10 rounded-md">
                  <UserCircle className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold">Le Mie Attività</h3>
                  <p className="tabular text-xs text-white/70">{myTodos.length} {myTodos.length === 1 ? 'attività' : 'attività'} da completare</p>
                </div>
              </div>
              <button onClick={() => setShowMyTasksModal(false)} className="p-1.5 rounded-md hover:bg-white/10 transition-colors">
                <X className="h-4 w-4 text-white" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {myTodos.length === 0 ? (
                <div className="py-12 text-center">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto mb-3" />
                  <p className="text-[var(--color-fg)] font-medium">Tutto fatto!</p>
                  <p className="text-[var(--color-fg-subtle)] text-sm">Non hai attività assegnate</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {myTodos.map(todo => {
                    const isOverdue = todo.dueDate && todo.dueDate < todayStr;
                    return (
                      <div key={todo.id} className={`p-3 rounded-md border ${isOverdue ? 'border-rose-100 bg-rose-50' : 'border-[var(--color-line)] bg-[var(--color-surface)]'} transition-colors`}>
                        <div className="flex items-start gap-3">
                          <button
                            onClick={() => handleToggleTodo(todo.id)}
                            className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border border-[var(--color-line-strong)] hover:border-[var(--color-fg)] flex items-center justify-center transition-colors"
                          >
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-start justify-between gap-2">
                              <p className="font-medium text-sm text-[var(--color-fg)]">{todo.title}</p>
                              <Flag className={`h-4 w-4 flex-shrink-0 ${PRIORITY_COLORS[todo.priority]}`} />
                            </div>
                            {todo.description && (
                              <p className="text-sm text-[var(--color-fg-muted)] mt-1">{todo.description}</p>
                            )}
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${CATEGORY_COLORS[todo.category]}`}>
                                {CATEGORY_LABELS[todo.category]}
                              </span>
                              {isAssignedToMe(todo) && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 text-blue-700 border border-blue-100">
                                  <UserCircle className="h-3 w-3" /> Personale
                                </span>
                              )}
                              {isAssignedToMyTeam(todo) && !isAssignedToMe(todo) && (
                                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${TEAM_COLORS[todo.assignedToTeam!]}`}>
                                  <UsersRound className="h-3 w-3" /> {TEAM_LABELS[todo.assignedToTeam!]}
                                </span>
                              )}
                              {todo.dueDate && (
                                <span className={`tabular text-[11px] flex items-center gap-1 ${isOverdue ? 'text-rose-600 font-medium' : 'text-[var(--color-fg-muted)]'}`}>
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
            <div className="p-4 border-t border-[var(--color-line)] bg-[var(--color-surface-2)]">
              <button
                onClick={() => setShowMyTasksModal(false)}
                className="w-full rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition"
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
          <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-sm)] border border-[var(--color-line)] w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-4 border-b border-[var(--color-line)] flex items-center justify-between">
              <h3 className="text-base font-semibold text-[var(--color-fg)]">{editingTodo ? 'Modifica Attività' : 'Nuova Attività'}</h3>
              <button onClick={() => { setShowTodoModal(false); resetTodoForm(); }} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]"><X className="h-4 w-4" /></button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Titolo</label>
                <input type="text" value={todoForm.title} onChange={e => setTodoForm({ ...todoForm, title: e.target.value })} placeholder="Es: Chiamare fornitore vini" className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]" autoFocus />
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Descrizione (opzionale)</label>
                <textarea value={todoForm.description} onChange={e => setTodoForm({ ...todoForm, description: e.target.value })} placeholder="Aggiungi dettagli..." className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20 resize-none" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Priorità</label>
                  <select value={todoForm.priority} onChange={e => setTodoForm({ ...todoForm, priority: e.target.value as TodoPriority })} className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]">
                    <option value={TodoPriority.LOW}>Bassa</option>
                    <option value={TodoPriority.MEDIUM}>Media</option>
                    <option value={TodoPriority.HIGH}>Alta</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Categoria</label>
                  <select value={todoForm.category} onChange={e => setTodoForm({ ...todoForm, category: e.target.value as TodoCategory })} className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]">
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (<option key={key} value={key}>{label}</option>))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Scadenza (opzionale)</label>
                <input type="date" value={todoForm.dueDate} onChange={e => setTodoForm({ ...todoForm, dueDate: e.target.value })} className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]" />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Assegna a Persona</label>
                  <select
                    value={todoForm.assignedToUserId || ''}
                    onChange={e => setTodoForm({ ...todoForm, assignedToUserId: e.target.value ? Number(e.target.value) : undefined, assignedToTeam: undefined })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    <option value="">Nessuno</option>
                    {staffUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name} ({TEAM_LABELS[u.role]})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5">Assegna a Team</label>
                  <select
                    value={todoForm.assignedToTeam || ''}
                    onChange={e => setTodoForm({ ...todoForm, assignedToTeam: e.target.value ? e.target.value as UserRole : undefined, assignedToUserId: undefined })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    <option value="">Nessun team</option>
                    {Object.entries(TEAM_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row sm:justify-end gap-2">
              <button onClick={() => { setShowTodoModal(false); resetTodoForm(); }} className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]">Annulla</button>
              <button onClick={handleSaveTodo} disabled={!todoForm.title.trim()} className="w-full sm:w-auto rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed">
                {editingTodo ? 'Salva' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Today's Tasks Summary */}
      {todaysTodos.length > 0 && (
        <div className="bg-[var(--color-surface)] p-4 rounded-xl border border-[var(--color-line)] shadow-[var(--shadow-sm)]">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-4 w-4 text-[var(--color-fg-muted)]" />
            <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Attività di oggi</h3>
            <span className="tabular inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] text-[var(--color-fg)] border border-[var(--color-line)]">{todaysTodos.length}</span>
          </div>
          <div className="space-y-2">
            {todaysTodos.slice(0, 3).map(todo => (
              <div key={todo.id} className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
                <div className={`w-1.5 h-1.5 rounded-full ${PRIORITY_COLORS[todo.priority].replace('text-', 'bg-')}`} />
                {todo.title}
              </div>
            ))}
            {todaysTodos.length > 3 && <p className="tabular text-xs text-[var(--color-fg-muted)]">+{todaysTodos.length - 3} altre attività</p>}
          </div>
        </div>
      )}

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

      <ConfirmDeleteModal
        isOpen={!!deleteTodoConfirm}
        title="Elimina Attività"
        message="Stai per eliminare l'attività:"
        itemName={deleteTodoConfirm?.title}
        onCancel={() => setDeleteTodoConfirm(null)}
        onConfirm={() => {
          if (deleteTodoConfirm) handleDeleteTodo(deleteTodoConfirm.id);
          setDeleteTodoConfirm(null);
        }}
      />
    </div>
  );
};
