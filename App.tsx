import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Grid, Menu as MenuIcon, Settings, ChevronRight, ChevronLeft, ChefHat, Calendar, Bell, X, CheckCircle, AlertTriangle, Info, LogOut, Users, FileText, PanelLeftClose, PanelLeft, UsersRound, Sun, Moon, Wifi, WifiOff, MoreHorizontal } from 'lucide-react';
import { ViewState, Room, Table, Dish, Reservation, TableStatus, TableShape, BanquetMenu, PaymentStatus, Notification, Shift, Toast, UserRole } from './types';
import { Dashboard } from './components/Dashboard';
import { FloorPlan } from './components/FloorPlan';
import { MenuManager } from './components/MenuManager';
import { ReservationList } from './components/ReservationList';
import { LoginPage } from './components/LoginPage';
import { UserManagement } from './components/UserManagement';
import { RolePermissions } from './components/RolePermissions';
import { ActivityLogs } from './components/ActivityLogs';
import { StaffManagement } from './components/StaffManagement';
import { useSocket } from './hooks/useSocket';
import { offlineQueue } from './services/offlineQueue';
import { socketClient } from './services/socketClient';
import { useAuth } from './contexts/AuthContext';
import { sortRooms } from './utils/roomOrder';

import {
  getReservations,
  createReservation,
  updateReservation,
  deleteReservation,
  getTables,
  createTable,
  updateTable,
  deleteTable,
  getRooms,
  createRoom,
  deleteRoom,
  getDishes,
  createDish,
  updateDish,
  deleteDish,
  getBanquetMenus,
  createBanquetMenu,
  updateBanquetMenu,
  deleteBanquetMenu,
  createTableMerge,
  deleteTableMerge,
} from './services/apiService';

const App: React.FC = () => {
  const { user, isAuthenticated, isLoading: authLoading, logout, canAccessView, canManageUsers, hasPermission, getAccessibleViews, canViewLogs } = useAuth();

  const [view, setView] = useState<ViewState>(ViewState.DASHBOARD);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [menuInitialTab, setMenuInitialTab] = useState<'DISHES' | 'BANQUETS'>('DISHES');

  // Theme (light/dark) — persisted, respects prefers-color-scheme on first visit
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    if (typeof window === 'undefined') return 'light';
    const stored = localStorage.getItem('ristocrm_theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
    localStorage.setItem('ristocrm_theme', theme);
  }, [theme]);
  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  // Redirect to first accessible view when user changes or doesn't have access to current view
  useEffect(() => {
    if (isAuthenticated && user) {
      const accessibleViews = getAccessibleViews();
      if (accessibleViews.length > 0 && !accessibleViews.includes(view)) {
        setView(accessibleViews[0]);
      }
    }
  }, [isAuthenticated, user]);

  const [rooms, setRooms] = useState<Room[]>([]);
  const [tables, setTables] = useState<Table[]>([]);
  const [dishes, setDishes] = useState<Dish[]>([]);
  const [banquetMenus, setBanquetMenus] = useState<BanquetMenu[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);

  // Notification State
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);

  // Toast/Snackbar State
  const [toasts, setToasts] = useState<Toast[]>([]);

  // User management modal state
  const [showUserManagement, setShowUserManagement] = useState(false);
  const [showRolePermissions, setShowRolePermissions] = useState(false);
  const [showActivityLogs, setShowActivityLogs] = useState(false);

  // Mobile chrome menus
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Socket.IO connection
  const { socket, isConnected } = useSocket();

  // Reconnect socket when user logs in
  useEffect(() => {
    if (isAuthenticated) {
      socketClient.reconnectWithToken();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchData();
    }
  }, [isAuthenticated]);

  const fetchData = async () => {
    try {
      const [roomsData, tablesData, dishesData, banquetMenusData, reservationsData] = await Promise.all([
        getRooms(),
        getTables(),
        getDishes(),
        getBanquetMenus(),
        getReservations(),
      ]);

      // Check for duplicate table IDs and filter them out
      const seenTableIds = new Set();
      const uniqueTables = tablesData.filter(table => {
        if (seenTableIds.has(table.id)) {
          console.warn('Duplicate table ID found during fetchData:', table.id, table);
          return false;
        }
        seenTableIds.add(table.id);
        return true;
      });

      if (uniqueTables.length < tablesData.length) {
        console.error(`Found ${tablesData.length - uniqueTables.length} duplicate table(s) during fetchData`);
      }

      // Debug: Log tables with merged_with info
      console.log('Fetched tables from backend:', uniqueTables.map(t => `${t.name}(${t.id})`));
      uniqueTables.forEach(table => {
        if (table.merged_with && table.merged_with.length > 0) {
          console.log('Loaded merged table:', table.name, 'ID:', table.id, 'merged_with:', table.merged_with, 'type:', typeof table.merged_with[0]);
        }
      });

      setRooms(sortRooms(roomsData));
      setTables(uniqueTables);
      setDishes(dishesData);
      setBanquetMenus(banquetMenusData);
      setReservations(reservationsData);
    } catch (error) {
      console.error("Error fetching data:", error);
      addToast('Error fetching data', 'error');
    }
  };

  const addToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'info',
    options?: { title?: string; details?: string[]; duration?: number }
  ) => {
      const id = Math.random().toString(36).substr(2, 9);
      const duration = options?.duration ?? (options?.details?.length ? 6000 : 3000);
      setToasts(prev => [...prev, { id, message, type, title: options?.title, details: options?.details, duration }]);

      setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
  };

  // Socket.IO Real-time Event Listeners
  useEffect(() => {
    if (!socket) return;

    // Reservation events
    socket.on('reservation:created', (reservation: Reservation) => {
      setReservations(prev => {
        // Avoid duplicates - check if already exists
        if (prev.some(r => r.id === reservation.id)) {
          return prev;
        }
        return [...prev, reservation];
      });
      addToast(`Nuova prenotazione: ${reservation.customer_name}`, 'info');
    });

    socket.on('reservation:updated', (reservation: Reservation) => {
      setReservations(prev =>
        prev.map(r => r.id === reservation.id ? reservation : r)
      );
      addToast(`Prenotazione aggiornata: ${reservation.customer_name}`, 'info');
    });

    socket.on('reservation:deleted', (id: number) => {
      setReservations(prev => prev.filter(r => r.id !== id));
      addToast('Prenotazione eliminata', 'info');
    });

    // Table events
    socket.on('table:created', (table: Table) => {
      console.log('Socket received table:created for table:', table.name, 'ID:', table.id);
      setTables(prev => {
        // Check if table already exists (avoid duplicates from API response)
        if (prev.some(t => t.id === table.id)) {
          console.log('Table already exists, skipping duplicate add');
          return prev;
        }
        return [...prev, table];
      });
    });

    socket.on('table:updated', (table: Table) => {
      console.log('Socket received table:updated for table:', table.name, 'ID:', table.id, 'merged_with:', table.merged_with);
      setTables(prev => {
        // Remove any duplicates first
        const uniqueTables = prev.filter((t, index, self) =>
          self.findIndex(t2 => t2.id === t.id) === index
        );

        // Update the table
        const updated = uniqueTables.map(t => t.id === table.id ? table : t);
        console.log('Tables after socket update:', updated.map(t => `${t.name}(${t.id})`));
        return updated;
      });
    });

    socket.on('table:deleted', (id: number) => {
      setTables(prev => prev.filter(t => t.id !== id));
    });

    // Room events
    socket.on('room:created', (room: Room) => {
      setRooms(prev => {
        if (prev.some(r => r.id === room.id)) {
          return prev;
        }
        return sortRooms([...prev, room]);
      });
    });

    socket.on('room:deleted', (id: number) => {
      setRooms(prev => prev.filter(r => r.id !== id));
    });

    // Dish events
    socket.on('dish:created', (dish: Dish) => {
      setDishes(prev => {
        if (prev.some(d => d.id === dish.id)) {
          return prev;
        }
        return [...prev, dish];
      });
    });

    socket.on('dish:updated', (dish: Dish) => {
      setDishes(prev =>
        prev.map(d => d.id === dish.id ? dish : d)
      );
    });

    socket.on('dish:deleted', (id: number) => {
      setDishes(prev => prev.filter(d => d.id !== id));
    });

    // Banquet Menu events
    socket.on('banquet:created', (menu: BanquetMenu) => {
      setBanquetMenus(prev => [...prev, menu]);
    });

    socket.on('banquet:updated', (menu: BanquetMenu) => {
      setBanquetMenus(prev =>
        prev.map(m => m.id === menu.id ? menu : m)
      );
    });

    socket.on('banquet:deleted', (id: number) => {
      setBanquetMenus(prev => prev.filter(m => m.id !== id));
    });

    // Connection/Disconnection handlers with offline queue
    socket.on('connect', async () => {
      console.log('✅ Socket connected - flushing offline queue');

      // Show reconnection toast
      addToast('Connessione ristabilita', 'success');

      // Flush offline queue if there are pending operations
      if (!offlineQueue.isEmpty()) {
        const queueSize = offlineQueue.size();
        addToast(`Sincronizzazione di ${queueSize} operazioni in sospeso...`, 'info');

        const result = await offlineQueue.flush();

        if (result.success > 0) {
          addToast(`✓ ${result.success} operazioni sincronizzate con successo`, 'success');
        }
        if (result.failed > 0) {
          addToast(`⚠ ${result.failed} operazioni non riuscite`, 'error');
        }

        // Refresh all data after sync
        fetchData();
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('⚠️ Socket disconnected:', reason);
      addToast('Connessione persa - le modifiche verranno sincronizzate al ripristino', 'error');
    });

    // Cleanup all event listeners on unmount
    return () => {
      socket.off('reservation:created');
      socket.off('reservation:updated');
      socket.off('reservation:deleted');
      socket.off('table:created');
      socket.off('table:updated');
      socket.off('table:deleted');
      socket.off('room:created');
      socket.off('room:deleted');
      socket.off('dish:created');
      socket.off('dish:updated');
      socket.off('dish:deleted');
      socket.off('banquet:created');
      socket.off('banquet:updated');
      socket.off('banquet:deleted');
      socket.off('connect');
      socket.off('disconnect');
    };
  }, [socket]);

  // --- Floor Plan Logic ---
  const handleUpdateTable = async (updatedTable: Table) => {
    // Optimistic update - update state immediately for instant UI feedback
    setTables(prev => {
      // Remove duplicates
      const uniqueTables = prev.filter((t, index, self) =>
        self.findIndex(t2 => t2.id === t.id) === index
      );
      return uniqueTables.map(t => t.id === updatedTable.id ? updatedTable : t);
    });

    try {
      // Then sync with backend
      const returnedTable = await updateTable(updatedTable.id as number, updatedTable);
      // Update again with server data in case something changed
      setTables(prev => {
        // Remove duplicates
        const uniqueTables = prev.filter((t, index, self) =>
          self.findIndex(t2 => t2.id === t.id) === index
        );
        return uniqueTables.map(t => t.id === returnedTable.id ? returnedTable : t);
      });
    } catch (error) {
      console.error("Error updating table:", error);
      addToast('Error updating table', 'error');
      // Note: Could revert optimistic update here if needed
    }
  };

  const handleAddTable = async (newTable: Omit<Table, 'id'>) => {
    try {
      const returnedTable = await createTable(newTable);
      setTables(prev => [...prev, returnedTable]);
      addToast('Nuovo tavolo aggiunto alla sala', 'success');
    } catch (error) {
      console.error("Error adding table:", error);
      addToast('Error adding table', 'error');
    }
  };

  const handleDeleteTable = async (tableId: number) => {
    try {
      await deleteTable(tableId);
      setTables(prev => prev.filter(t => t.id !== tableId));
      addToast('Tavolo eliminato', 'success');
    } catch (error) {
      console.error("Error deleting table:", error);
      addToast('Error deleting table', 'error');
    }
  };

  // Merge tables for a specific (date, shift). Persists to table_merges only —
  // raw tables are not modified, so the merge is scoped to that one service.
  const handleMergeTables = async (tableIds: number[], date: string, shift: Shift) => {
    if (tableIds.length < 2) {
      addToast('Seleziona almeno 2 tavoli da unire', 'error');
      return;
    }

    try {
      const selectedTables = tableIds
        .map(id => tables.find(t => t.id === id))
        .filter((t): t is Table => !!t);
      if (selectedTables.length !== tableIds.length) {
        addToast('Tavolo non trovato', 'error');
        return;
      }

      const [primary, ...others] = selectedTables;
      await createTableMerge(date, shift, primary.id, others.map(t => t.id));

      const combinedName = selectedTables.map(t => t.name).join('+');
      const totalSeats = selectedTables.reduce((sum, t) => sum + t.seats, 0);
      addToast(`Tavoli uniti: ${combinedName} (${totalSeats} coperti)`, 'success');
    } catch (error) {
      console.error('Error merging tables:', error);
      addToast("Errore durante l'unione dei tavoli", 'error');
    }
  };

  const handleSplitTable = async (primaryId: number, date: string, shift: Shift) => {
    try {
      await deleteTableMerge(date, shift, primaryId);
      addToast('Tavoli divisi con successo', 'success');
    } catch (error) {
      console.error('Error splitting table:', error);
      addToast('Errore durante la divisione dei tavoli', 'error');
    }
  };

  const handleAddRoom = async (roomName: string) => {
    try {
      const newRoom = await createRoom({ name: roomName, width: 800, height: 600 });
      setRooms(prev => [...prev, newRoom]);
      addToast(`Sala "${roomName}" creata`, 'success');
    } catch (error) {
      console.error("Error adding room:", error);
      addToast('Error adding room', 'error');
    }
  };

  const handleDeleteRoom = async (roomId: number) => {
    try {
      await deleteRoom(roomId);
      setRooms(prev => prev.filter(r => r.id !== roomId));
      addToast('Sala eliminata', 'success');
    } catch (error) {
      console.error("Error deleting room:", error);
      addToast('Error deleting room', 'error');
    }
  };

  // --- Menu Logic ---
  const handleAddDish = async (dish: Omit<Dish, 'id'>) => {
    try {
        await createDish(dish);
        // Socket.IO will handle adding to state via dish:created event
        addToast('Piatto aggiunto al menu', 'success');
    } catch (error) {
        console.error("Error adding dish:", error);
        addToast('Error adding dish', 'error');
    }
  };

  const handleUpdateDish = async (id: number, dish: Partial<Dish>) => {
    try {
        await updateDish(id, dish);
        // Socket.IO will handle updating state via dish:updated event
        addToast('Piatto aggiornato', 'success');
    } catch (error) {
        console.error("Error updating dish:", error);
        addToast('Error updating dish', 'error');
    }
  };

  const handleDeleteDish = async (id: number) => {
    try {
        await deleteDish(id);
        // Socket.IO will handle removing from state via dish:deleted event
        addToast('Piatto rimosso', 'success');
    } catch (error) {
        console.error("Error deleting dish:", error);
        addToast('Error deleting dish', 'error');
    }
  };

  const handleAddBanquet = async (menu: Omit<BanquetMenu, 'id'>) => {
    try {
        await createBanquetMenu(menu);
        // Socket.IO will handle adding to state via banquet:created event
        addToast('Menu banchetto creato', 'success');
    } catch (error) {
        console.error("Error adding banquet menu:", error);
        addToast('Error adding banquet menu', 'error');
    }
    };

  const handleUpdateBanquet = async (id: number, menu: Partial<BanquetMenu>) => {
    try {
        await updateBanquetMenu(id, menu);
        // Socket.IO will handle updating state via banquet:updated event
        addToast('Menu banchetto aggiornato', 'success');
    } catch (error) {
        console.error("Error updating banquet menu:", error);
        addToast('Error updating banquet menu', 'error');
    }
  };

  const handleDeleteBanquet = async (id: number) => {
    try {
        await deleteBanquetMenu(id);
        // Socket.IO will handle removing from state via banquet:deleted event
        addToast('Menu banchetto eliminato', 'success');
    } catch (error) {
        console.error("Error deleting banquet menu:", error);
        addToast('Error deleting banquet menu', 'error');
    }
  };

  // --- Reservation Logic ---
  const buildReservationDetails = (res: Reservation): string[] => {
    // Treat reservation_time as a wall-clock string ("YYYY-MM-DDTHH:MM[:SS]")
    // and parse the components directly, otherwise new Date() may shift it
    // by the local UTC offset (e.g. 21:00 → 23:00 in CEST).
    const [datePart, timePartRaw] = res.reservation_time.split('T');
    const [yStr, mStr, dStr] = (datePart || '').split('-');
    const [hhStr, mmStr] = (timePartRaw || '00:00').split(':');
    const localDate = new Date(
      Number(yStr),
      Number(mStr) - 1,
      Number(dStr),
      Number(hhStr) || 0,
      Number(mmStr) || 0,
    );

    const dateLabel = localDate.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeLabel = `${(hhStr || '00').padStart(2, '0')}:${(mmStr || '00').padStart(2, '0').slice(0, 2)}`;
    const shiftLabel = res.shift === Shift.LUNCH ? 'Pranzo' : 'Cena';
    const tableName = res.table_id ? tables.find(t => t.id === res.table_id)?.name : null;

    const details = [
      `${res.customer_name} · ${res.guests} ${res.guests === 1 ? 'ospite' : 'ospiti'}`,
      `${dateLabel} · ${timeLabel} (${shiftLabel})`,
      tableName ? `Tavolo ${tableName}` : 'Tavolo non assegnato',
    ];
    if (res.phone) details.push(res.phone);
    return details;
  };

  const handleUpdateReservation = async (updatedRes: Reservation) => {
    try {
      const returnedRes = await updateReservation(updatedRes.id as number, updatedRes);
      setReservations(prev => prev.map(r => r.id === returnedRes.id ? returnedRes : r));
      addToast('Prenotazione aggiornata', 'success', {
        title: 'Modifica Prenotazione',
        details: buildReservationDetails(returnedRes),
      });
    } catch (error) {
      console.error("Error updating reservation:", error);
      addToast('Error updating reservation', 'error');
    }
  };

  const handleAddReservation = async (newRes: Omit<Reservation, 'id'>) => {
    try {
      const returnedRes = await createReservation(newRes);
      // Don't add to state here - socket event will handle it to avoid duplicates
      setNotifications(prev => [{
        id: Math.random().toString(),
        title: 'Nuova Prenotazione',
        message: `Creata prenotazione per ${returnedRes.customer_name} il ${new Date(returnedRes.reservation_time).toLocaleString()}`,
        type: 'info',
        timestamp: new Date(),
        read: false
      }, ...prev]);

      addToast('Prenotazione inserita con successo', 'success', {
        title: 'Nuova Prenotazione',
        details: buildReservationDetails(returnedRes),
      });
    } catch (error) {
      console.error("Error adding reservation:", error);
      addToast('Error adding reservation', 'error');
    }
  };

  const handleDeleteReservation = async (id: number) => {
    const targetRes = reservations.find(r => r.id === id);
    try {
      await deleteReservation(id);
      setReservations(prev => prev.filter(r => r.id !== id));
      setNotifications(prev => [{
        id: Math.random().toString(),
        title: 'Prenotazione Cancellata',
        message: 'La prenotazione è stata rimossa con successo.',
        type: 'warning',
        timestamp: new Date(),
        read: false
      }, ...prev]);
      addToast('Prenotazione cancellata', 'info', targetRes
        ? { title: 'Prenotazione Cancellata', details: buildReservationDetails(targetRes) }
        : undefined);
    } catch (error) {
      console.error("Error deleting reservation:", error);
      addToast('Error deleting reservation', 'error');
    }
  }

  // Show loading spinner while checking auth
  if (authLoading) {
    return (
      <div className="min-h-screen bg-[var(--color-surface-2)] flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-2 border-[var(--color-fg)] border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sm text-[var(--color-fg-muted)]">Caricamento...</p>
        </div>
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Get role display name
  const getRoleDisplayName = (role: UserRole): string => {
    const roleNames: Record<UserRole, string> = {
      [UserRole.OWNER]: 'Proprietario',
      [UserRole.MANAGER]: 'Manager',
      [UserRole.WAITER]: 'Cameriere',
      [UserRole.KITCHEN]: 'Cucina'
    };
    return roleNames[role] || role;
  };

  return (
    <div className="flex h-screen bg-[var(--color-surface-2)] font-sans text-[var(--color-fg)]">
      {/* Skip link for keyboard users */}
      <a href="#main" className="skip-link">Salta al contenuto</a>

      {/* User Management Modal */}
      {showUserManagement && canManageUsers() && (
        <UserManagement onClose={() => setShowUserManagement(false)} />
      )}

      {/* Role Permissions Modal */}
      {showRolePermissions && canManageUsers() && (
        <RolePermissions
          isOpen={showRolePermissions}
          onClose={() => setShowRolePermissions(false)}
        />
      )}

      {/* Activity Logs Modal */}
      {showActivityLogs && canViewLogs() && (
        <ActivityLogs
          isOpen={showActivityLogs}
          onClose={() => setShowActivityLogs(false)}
        />
      )}

      {/* Sidebar — blends into page bg */}
      <aside
        className={`hidden lg:flex ${sidebarCollapsed ? 'w-[72px]' : 'w-64'} bg-[var(--color-sidebar-bg)] border-r border-[var(--color-sidebar-line)] flex-col transition-[width] duration-200 z-20 relative`}
        aria-label="Navigazione principale"
      >
        <div className={`h-14 flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between px-5'}`}>
          <div className="flex items-center">
            <div className="bg-[var(--color-sidebar-fg-strong)] p-1.5 rounded-md">
               <ChefHat className="text-[var(--color-sidebar-bg)] h-4 w-4" />
            </div>
            {!sidebarCollapsed && <span className="ml-2.5 font-semibold text-[15px] text-[var(--color-sidebar-fg-strong)] tracking-tight">RistoCRM</span>}
          </div>
          {!sidebarCollapsed && (
            <button
              onClick={() => setSidebarCollapsed(true)}
              className="p-1.5 text-[var(--color-sidebar-fg)] hover:text-[var(--color-sidebar-fg-strong)] hover:bg-[var(--color-sidebar-active-bg)] rounded-md transition-colors"
              title="Comprimi"
              aria-label="Comprimi navigazione"
            >
              <PanelLeftClose size={16} />
            </button>
          )}
        </div>

        {/* Expand button when collapsed */}
        {sidebarCollapsed && (
          <button
            onClick={() => setSidebarCollapsed(false)}
            className="mx-auto mt-3 p-2 text-[var(--color-sidebar-fg)] hover:text-[var(--color-sidebar-fg-strong)] hover:bg-[var(--color-sidebar-active-bg)] rounded-md transition-colors"
            title="Espandi"
            aria-label="Espandi navigazione"
          >
            <PanelLeft size={18} />
          </button>
        )}

        <nav className={`flex-1 py-5 space-y-0.5 ${sidebarCollapsed ? 'px-2' : 'px-3'}`}>
          {!sidebarCollapsed && (
            <div className="px-3 pb-2 text-[10px] uppercase tracking-[0.1em] font-semibold text-[var(--color-sidebar-eyebrow)]">
              Operatività
            </div>
          )}
          {canAccessView(ViewState.DASHBOARD) && (
            <SidebarItem
              icon={<LayoutDashboard size={20} />}
              label="Dashboard"
              active={view === ViewState.DASHBOARD}
              onClick={() => setView(ViewState.DASHBOARD)}
              collapsed={sidebarCollapsed}
            />
          )}
          {canAccessView(ViewState.RESERVATIONS) && (
            <SidebarItem
              icon={<Calendar size={20} />}
              label="Prenotazioni"
              active={view === ViewState.RESERVATIONS}
              onClick={() => setView(ViewState.RESERVATIONS)}
              collapsed={sidebarCollapsed}
            />
          )}
          {canAccessView(ViewState.FLOOR_PLAN) && (
            <SidebarItem
              icon={<Grid size={20} />}
              label="Sale & Tavoli"
              active={view === ViewState.FLOOR_PLAN}
              onClick={() => setView(ViewState.FLOOR_PLAN)}
              collapsed={sidebarCollapsed}
            />
          )}
          {canAccessView(ViewState.MENU) && (
            <SidebarItem
              icon={<MenuIcon size={20} />}
              label="Menu & Banchetti"
              active={view === ViewState.MENU}
              onClick={() => { setMenuInitialTab('DISHES'); setView(ViewState.MENU); }}
              collapsed={sidebarCollapsed}
            />
          )}

          {(canAccessView(ViewState.STAFF) || canAccessView(ViewState.SETTINGS)) && !sidebarCollapsed && (
            <div className="px-3 pt-5 pb-2 text-[10px] uppercase tracking-[0.1em] font-semibold text-[var(--color-sidebar-eyebrow)]">
              Gestione
            </div>
          )}
          {canAccessView(ViewState.STAFF) && (
            <SidebarItem
              icon={<UsersRound size={20} />}
              label="Personale"
              active={view === ViewState.STAFF}
              onClick={() => setView(ViewState.STAFF)}
              collapsed={sidebarCollapsed}
            />
          )}
          {canAccessView(ViewState.SETTINGS) && (
            <SidebarItem
              icon={<Settings size={20} />}
              label="Impostazioni"
              active={view === ViewState.SETTINGS}
              onClick={() => setView(ViewState.SETTINGS)}
              collapsed={sidebarCollapsed}
            />
          )}
        </nav>

        <div className={`p-3 space-y-1 ${sidebarCollapsed ? 'px-2' : ''}`}>
          {/* User Management Button (Owner only) */}
          {canManageUsers() && (
            <button
              onClick={() => setShowUserManagement(true)}
              className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center' : 'gap-3'} px-3 py-2 text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-active-bg)] hover:text-[var(--color-sidebar-fg-strong)] rounded-md transition-colors text-sm`}
              title={sidebarCollapsed ? 'Gestione Utenti' : undefined}
            >
              <Users size={18} />
              {!sidebarCollapsed && <span className="font-medium">Gestione Utenti</span>}
            </button>
          )}

          {/* User Info */}
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2 pt-2">
              <div className="w-9 h-9 rounded-full bg-[var(--color-sidebar-fg-strong)] flex items-center justify-center text-[var(--color-sidebar-bg)] font-medium text-xs">
                {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
              </div>
              <button
                onClick={logout}
                className="p-2 text-[var(--color-sidebar-fg)] hover:text-rose-600 hover:bg-[var(--color-sidebar-active-bg)] rounded-md transition-colors"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-2 py-2 mt-1">
              <div className="w-9 h-9 rounded-full bg-[var(--color-sidebar-fg-strong)] flex items-center justify-center text-[var(--color-sidebar-bg)] font-medium text-xs">
                {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-[var(--color-sidebar-fg-strong)] truncate">{user?.full_name || 'Utente'}</p>
                <p className="text-[11px] text-[var(--color-sidebar-fg)] truncate">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
              </div>
              <button
                onClick={logout}
                className="p-1.5 text-[var(--color-sidebar-fg)] hover:text-rose-600 hover:bg-[var(--color-sidebar-active-bg)] rounded-md transition-colors"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut size={16} />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content - Add bottom padding on mobile for bottom nav */}
      <main id="main" className="flex-1 overflow-y-auto relative pb-20 lg:pb-0 bg-[var(--color-surface-2)]">
        {/* Header */}
        <header className="h-14 bg-[var(--color-surface-2)]/90 backdrop-blur-sm border-b border-[var(--color-line)] sticky top-0 z-10 flex items-center justify-between px-4 lg:px-6">
           <div className="flex items-center gap-2 lg:hidden">
              <div className="bg-[var(--color-fg)] p-1.5 rounded-md">
                <ChefHat className="text-[var(--color-fg-on-brand)] h-4 w-4" />
              </div>
              <span className="font-semibold text-[15px] tracking-tight text-[var(--color-fg)]">RistoCRM</span>
           </div>
           <div className="ml-auto flex items-center gap-1">
              {/* Connection state pill */}
              <div
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                  isConnected
                    ? 'border-[var(--color-line)] text-[var(--color-fg-muted)] bg-[var(--color-surface)]'
                    : 'border-rose-200 text-rose-700 bg-rose-50 animate-pulse'
                }`}
                role="status"
                aria-live={isConnected ? 'polite' : 'assertive'}
                aria-label={isConnected ? 'Connesso' : 'Non connesso'}
              >
                {isConnected ? <Wifi className="h-3 w-3" aria-hidden /> : <WifiOff className="h-3 w-3" aria-hidden />}
                <span className="hidden sm:inline">{isConnected ? 'Live' : 'Offline'}</span>
              </div>

              {/* Theme toggle */}
              <button
                onClick={toggleTheme}
                className="p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] rounded-md transition-colors"
                aria-label={theme === 'dark' ? 'Passa a tema chiaro' : 'Passa a tema scuro'}
                title={theme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}
              >
                {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>

               <div className="relative">
                   <button
                      onClick={() => { setShowNotifications(!showNotifications); setShowUserMenu(false); }}
                      className="p-2 text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] rounded-md relative transition-colors"
                      aria-label="Notifiche"
                      aria-expanded={showNotifications}
                    >
                       <Bell className="h-4 w-4" />
                       {notifications.some(n => !n.read) && (
                           <span className="absolute top-1.5 right-1.5 w-1.5 h-1.5 bg-rose-500 rounded-full"></span>
                       )}
                   </button>

                   {/* Notification Dropdown */}
                   {showNotifications && (
                       <div className="absolute right-0 top-full mt-2 w-80 bg-[var(--color-surface)] rounded-lg shadow-[var(--shadow-lg)] border border-[var(--color-line)] overflow-hidden animate-in fade-in slide-in-from-top-2 z-30">
                           <div className="px-3 py-2.5 border-b border-[var(--color-line)] flex justify-between items-center">
                               <h3 className="font-semibold text-[13px] text-[var(--color-fg)]">Notifiche</h3>
                               <button onClick={() => setShowNotifications(false)} className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]" aria-label="Chiudi"><X className="h-3.5 w-3.5" /></button>
                           </div>
                           <div className="max-h-72 overflow-y-auto">
                               {notifications.length === 0 ? (
                                   <div className="p-6 text-center text-sm text-[var(--color-fg-subtle)]">Nessuna notifica</div>
                               ) : (
                                   notifications.map(notif => (
                                       <div key={notif.id} className="p-3 hover:bg-[var(--color-surface-hover)] border-b border-[var(--color-line)] last:border-0">
                                           <div className="flex justify-between items-start gap-2">
                                                <p className="text-sm font-medium text-[var(--color-fg)]">{notif.title}</p>
                                                <span className="text-[10px] text-[var(--color-fg-subtle)] tabular shrink-0">{notif.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                           </div>
                                           <p className="text-xs text-[var(--color-fg-muted)] mt-0.5">{notif.message}</p>
                                       </div>
                                   ))
                               )}
                           </div>
                       </div>
                   )}
               </div>

               {/* Mobile-only user menu trigger — last in row */}
               <div className="relative lg:hidden">
                   <button
                      onClick={() => { setShowUserMenu(o => !o); setShowNotifications(false); setShowMoreMenu(false); }}
                      className="ml-1 w-8 h-8 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] flex items-center justify-center text-[11px] font-medium hover:opacity-90 transition-opacity"
                      aria-label="Menu utente"
                      aria-expanded={showUserMenu}
                    >
                       {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                   </button>
                   {showUserMenu && (
                       <div className="absolute right-0 top-full mt-2 w-64 bg-[var(--color-surface)] rounded-lg shadow-[var(--shadow-lg)] border border-[var(--color-line)] overflow-hidden z-30 animate-in fade-in slide-in-from-top-2">
                           <div className="px-3 py-3 border-b border-[var(--color-line)] flex items-center gap-3">
                               <div className="w-9 h-9 rounded-full bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] font-medium text-xs">
                                   {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                               </div>
                               <div className="flex-1 min-w-0">
                                   <p className="text-sm font-medium text-[var(--color-fg)] truncate">{user?.full_name || 'Utente'}</p>
                                   <p className="text-[11px] text-[var(--color-fg-muted)] truncate">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
                               </div>
                           </div>
                           <button
                               onClick={() => { setShowUserMenu(false); logout(); }}
                               className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-rose-600 hover:bg-rose-50 transition-colors"
                           >
                               <LogOut className="h-4 w-4" />
                               Esci
                           </button>
                       </div>
                   )}
               </div>
           </div>
        </header>

        {view === ViewState.DASHBOARD && (
          <Dashboard
            reservations={reservations}
            tables={tables}
            dishes={dishes}
            rooms={rooms}
            banquetMenus={banquetMenus}
            onNavigateToBanquets={() => { setMenuInitialTab('BANQUETS'); setView(ViewState.MENU); }}
          />
        )}

        {view === ViewState.RESERVATIONS && (
            <ReservationList
                reservations={reservations}
                banquetMenus={banquetMenus}
                tables={tables}
                rooms={rooms}
                onUpdateReservation={handleUpdateReservation}
                onAddReservation={handleAddReservation}
                onDeleteReservation={handleDeleteReservation}
                onMergeTables={handleMergeTables}
                onSplitTable={handleSplitTable}
                onUpdateTable={handleUpdateTable}
                showToast={addToast}
                canEdit={hasPermission('reservations:full')}
            />
        )}

        {view === ViewState.FLOOR_PLAN && (
          <FloorPlan
            rooms={rooms}
            tables={tables}
            reservations={reservations}
            onUpdateTable={handleUpdateTable}
            onAddTable={handleAddTable}
            onDeleteTable={handleDeleteTable}
            onMergeTables={handleMergeTables}
            onSplitTable={handleSplitTable}
            onAddRoom={handleAddRoom}
            onDeleteRoom={handleDeleteRoom}
            canEdit={hasPermission('floorplan:full')}
          />
        )}

        {view === ViewState.MENU && (
          <MenuManager
            dishes={dishes}
            banquetMenus={banquetMenus}
            onAddDish={handleAddDish}
            onUpdateDish={handleUpdateDish}
            onDeleteDish={handleDeleteDish}
            onAddBanquetMenu={handleAddBanquet}
            onUpdateBanquetMenu={handleUpdateBanquet}
            onDeleteBanquetMenu={handleDeleteBanquet}
            canEdit={hasPermission('menu:full')}
            initialTab={menuInitialTab}
          />
        )}

        {view === ViewState.STAFF && (
          <StaffManagement showToast={addToast} />
        )}

        {view === ViewState.SETTINGS && (
          <div className="p-6 lg:p-10 max-w-4xl mx-auto">
            <div className="mb-8">
              <h2 className="text-[22px] font-semibold tracking-tight text-[var(--color-fg)]">Impostazioni</h2>
              <p className="text-sm text-[var(--color-fg-muted)] mt-0.5">Configurazione account, integrazioni, amministrazione.</p>
            </div>

            {/* Admin Section */}
            {canManageUsers() && (
              <div className="mb-8">
                <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Amministrazione</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    onClick={() => setShowUserManagement(true)}
                    className="flex items-center gap-3 p-4 bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] hover:border-[var(--color-fg)] transition-colors text-left"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center">
                      <Users className="w-5 h-5 text-[var(--color-fg)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Gestione Utenti</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Crea, modifica, elimina utenti</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>

                  <button
                    onClick={() => setShowRolePermissions(true)}
                    className="flex items-center gap-3 p-4 bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] hover:border-[var(--color-fg)] transition-colors text-left"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center">
                      <svg className="w-5 h-5 text-[var(--color-fg)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Permessi Ruoli</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Configura i permessi per ogni ruolo</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>
                </div>
              </div>
            )}

            {/* Monitoring Section */}
            {canViewLogs() && (
              <div className="mb-8">
                <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Monitoraggio</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    onClick={() => setShowActivityLogs(true)}
                    className="flex items-center gap-3 p-4 bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] hover:border-[var(--color-fg)] transition-colors text-left"
                  >
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center">
                      <FileText className="w-5 h-5 text-[var(--color-fg)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Log Attività</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Operazioni degli utenti</p>
                    </div>
                    <ChevronRight className="h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>
                </div>
              </div>
            )}

            {/* Integrations */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Integrazioni</h3>
              <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center">
                      <svg className="w-5 h-5 text-[var(--color-fg)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Stripe Connect</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Gateway di pagamento</p>
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100">
                    <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
                    Attivo (Simulato)
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Navigation - Visible only on mobile */}
        <nav className="fixed bottom-0 left-0 right-0 bg-[var(--color-surface)]/95 backdrop-blur-sm border-t border-[var(--color-line)] lg:hidden z-30" aria-label="Navigazione mobile">
          <div className="flex items-stretch py-1.5 px-1.5 gap-1">
            {canAccessView(ViewState.DASHBOARD) && (
              <BottomNavItem
                icon={<LayoutDashboard size={20} />}
                label="Dashboard"
                active={view === ViewState.DASHBOARD}
                onClick={() => setView(ViewState.DASHBOARD)}
              />
            )}
            {canAccessView(ViewState.RESERVATIONS) && (
              <BottomNavItem
                icon={<Calendar size={20} />}
                label="Prenotazioni"
                active={view === ViewState.RESERVATIONS}
                onClick={() => setView(ViewState.RESERVATIONS)}
              />
            )}
            {canAccessView(ViewState.FLOOR_PLAN) && (
              <BottomNavItem
                icon={<Grid size={20} />}
                label="Sala"
                active={view === ViewState.FLOOR_PLAN}
                onClick={() => setView(ViewState.FLOOR_PLAN)}
              />
            )}
            {canAccessView(ViewState.MENU) && (
              <BottomNavItem
                icon={<MenuIcon size={20} />}
                label="Menu"
                active={view === ViewState.MENU}
                onClick={() => { setMenuInitialTab('DISHES'); setView(ViewState.MENU); }}
              />
            )}
            {(canAccessView(ViewState.STAFF) || canAccessView(ViewState.SETTINGS)) && (
              <BottomNavItem
                icon={<MoreHorizontal size={20} />}
                label="Altro"
                active={showMoreMenu || view === ViewState.STAFF || view === ViewState.SETTINGS}
                onClick={() => setShowMoreMenu(true)}
              />
            )}
          </div>
        </nav>

        {/* "Altro" bottom sheet — mobile */}
        {showMoreMenu && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Altro">
            <div
              className="absolute inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)]"
              onClick={() => setShowMoreMenu(false)}
            />
            <div className="absolute bottom-0 left-0 right-0 bg-[var(--color-surface)] rounded-t-2xl border-t border-[var(--color-line)] shadow-[var(--shadow-overlay)] animate-in slide-in-from-bottom duration-200">
              <div className="flex justify-center pt-2.5 pb-1">
                <div className="w-10 h-1 rounded-full bg-[var(--color-line-strong)]" />
              </div>
              <div className="px-4 pb-2 pt-1 flex items-center justify-between">
                <h3 className="text-[15px] font-semibold text-[var(--color-fg)]">Altro</h3>
                <button onClick={() => setShowMoreMenu(false)} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]" aria-label="Chiudi">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-2 pb-6">
                {canAccessView(ViewState.STAFF) && (
                  <button
                    onClick={() => { setShowMoreMenu(false); setView(ViewState.STAFF); }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${view === ViewState.STAFF ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
                  >
                    <UsersRound className="h-5 w-5 text-[var(--color-fg-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-fg)]">Personale</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>
                )}
                {canAccessView(ViewState.SETTINGS) && (
                  <button
                    onClick={() => { setShowMoreMenu(false); setView(ViewState.SETTINGS); }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${view === ViewState.SETTINGS ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
                  >
                    <Settings className="h-5 w-5 text-[var(--color-fg-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-fg)]">Impostazioni</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Global Toasts */}
        <div
          className="fixed bottom-20 lg:bottom-4 right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-2rem)] sm:max-w-md"
          role="region"
          aria-label="Notifiche"
          aria-live="polite"
        >
            {toasts.map(toast => {
                const hasDetails = toast.details && toast.details.length > 0;
                const accent = toast.type === 'success'
                    ? { iconText: 'text-emerald-600' }
                    : toast.type === 'error'
                    ? { iconText: 'text-rose-600' }
                    : { iconText: 'text-[var(--color-fg)]' };
                return (
                    <div
                        key={toast.id}
                        role={toast.type === 'error' ? 'alert' : undefined}
                        className={`bg-[var(--color-surface)] shadow-[var(--shadow-lg)] border border-[var(--color-line)] rounded-lg animate-in slide-in-from-right duration-300 ${
                            hasDetails ? 'p-3.5 min-w-[300px] sm:min-w-[360px]' : 'flex items-center gap-2.5 px-3.5 py-2.5'
                        }`}
                    >
                        {hasDetails ? (
                            <div className="flex items-start gap-3">
                                <div className={`p-1.5 rounded-md bg-[var(--color-surface-3)] ${accent.iconText} flex-shrink-0`}>
                                    {toast.type === 'success' && <CheckCircle className="h-4 w-4" />}
                                    {toast.type === 'error' && <AlertTriangle className="h-4 w-4" />}
                                    {toast.type === 'info' && <Info className="h-4 w-4" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    {toast.title && (
                                        <p className="text-[13px] font-semibold text-[var(--color-fg)] mb-0.5">{toast.title}</p>
                                    )}
                                    <p className="text-sm font-medium text-[var(--color-fg)] mb-1">{toast.message}</p>
                                    <ul className="space-y-0.5">
                                        {toast.details!.map((d, i) => (
                                            <li key={i} className="text-[13px] text-[var(--color-fg-muted)] leading-snug">{d}</li>
                                        ))}
                                    </ul>
                                </div>
                            </div>
                        ) : (
                            <>
                                {toast.type === 'success' && <CheckCircle className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                {toast.type === 'error' && <AlertTriangle className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                {toast.type === 'info' && <Info className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                <span className="text-[13px] font-medium text-[var(--color-fg)]">{toast.message}</span>
                            </>
                        )}
                    </div>
                );
            })}
        </div>
      </main>
    </div>
  );
};

// Helper Component for Sidebar (dark navy)
const SidebarItem = ({ icon, label, active, onClick, collapsed = false }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void, collapsed?: boolean }) => (
  <button
    onClick={onClick}
    title={collapsed ? label : undefined}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-md transition-colors duration-150 group ${
      active
        ? 'bg-[var(--color-sidebar-active-bg)] text-[var(--color-sidebar-active-fg)]'
        : 'text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-active-bg)] hover:text-[var(--color-sidebar-fg-strong)]'
    }`}
  >
    <span className={active ? 'text-[var(--color-sidebar-active-fg)]' : 'text-[var(--color-sidebar-fg)] group-hover:text-[var(--color-sidebar-fg-strong)]'}>
      {icon}
    </span>
    {!collapsed && <span className="font-medium text-[13px] tracking-tight">{label}</span>}
  </button>
);

// Helper Component for Bottom Navigation (mobile)
const BottomNavItem = ({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 rounded-lg transition-colors duration-150 ${
      active
        ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)]'
        : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
    }`}
  >
    {icon}
    <span className="text-[10px] font-medium whitespace-nowrap">
      {label}
    </span>
  </button>
);

export default App;