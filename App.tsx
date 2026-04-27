import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Grid, Menu as MenuIcon, Settings, ChevronRight, ChefHat, Calendar, Bell, X, CheckCircle, AlertTriangle, Info, LogOut, Users, FileText } from 'lucide-react';
import { ViewState, Room, Table, Dish, Reservation, TableStatus, TableShape, BanquetMenu, PaymentStatus, Notification, Shift, Toast, UserRole } from './types';
import { Dashboard } from './components/Dashboard';
import { FloorPlan } from './components/FloorPlan';
import { MenuManager } from './components/MenuManager';
import { ReservationList } from './components/ReservationList';
import { LoginPage } from './components/LoginPage';
import { UserManagement } from './components/UserManagement';
import { RolePermissions } from './components/RolePermissions';
import { ActivityLogs } from './components/ActivityLogs';
import { useSocket } from './hooks/useSocket';
import { offlineQueue } from './services/offlineQueue';
import { socketClient } from './services/socketClient';
import { useAuth } from './contexts/AuthContext';

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
} from './services/apiService';

const App: React.FC = () => {
  const { user, isAuthenticated, isLoading: authLoading, logout, canAccessView, canManageUsers, hasPermission, getAccessibleViews, canViewLogs } = useAuth();

  const [view, setView] = useState<ViewState>(ViewState.DASHBOARD);

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

      setRooms(roomsData);
      setTables(uniqueTables);
      setDishes(dishesData);
      setBanquetMenus(banquetMenusData);
      setReservations(reservationsData);
    } catch (error) {
      console.error("Error fetching data:", error);
      addToast('Error fetching data', 'error');
    }
  };

  const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
      const id = Math.random().toString(36).substr(2, 9);
      setToasts(prev => [...prev, { id, message, type }]);
      
      // Auto remove after 3 seconds
      setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
      }, 3000);
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
        return [...prev, room];
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

  const handleMergeTables = async (tableIds: number[]) => {
    if (tableIds.length < 2) {
      addToast('Seleziona almeno 2 tavoli da unire', 'error');
      return;
    }

    try {
      console.log('handleMergeTables called with tableIds:', tableIds);

      // Get tables in the same order as tableIds
      const selectedTables = tableIds.map(id => tables.find(t => t.id === id)).filter(Boolean) as Table[];

      console.log('Merging tables:', selectedTables.map(t => `${t.name} (ID: ${t.id})`));

      // Use the first table ID as the primary table
      const primaryTableId = tableIds[0];
      const primaryTable = selectedTables[0];
      const otherTableIds = tableIds.slice(1);

      // Calculate total seats
      const totalSeats = selectedTables.reduce((sum, t) => sum + t.seats, 0);

      // Create combined name - use the order from selectedTables
      const combinedName = selectedTables.map(t => t.name).join('+');

      console.log('Primary table:', primaryTable.name, 'ID:', primaryTable.id);
      console.log('Other table IDs to merge:', otherTableIds);

      // Update the primary table with merged data
      const updatedPrimaryTable = {
        ...primaryTable,
        name: combinedName,
        seats: totalSeats,
        merged_with: otherTableIds
      };

      console.log('Updated primary table:', updatedPrimaryTable);

      // Optimistic update - with deduplication
      setTables(prev => {
        // Remove duplicates
        const uniqueTables = prev.filter((t, index, self) =>
          self.findIndex(t2 => t2.id === t.id) === index
        );
        return uniqueTables.map(t => t.id === primaryTable.id ? updatedPrimaryTable : t);
      });

      // Sync with backend
      const result = await updateTable(primaryTable.id, updatedPrimaryTable);
      console.log('Backend response:', result);

      // Update with backend response to ensure we have the exact data
      setTables(prev => {
        // Remove duplicates
        const uniqueTables = prev.filter((t, index, self) =>
          self.findIndex(t2 => t2.id === t.id) === index
        );
        return uniqueTables.map(t => t.id === result.id ? result : t);
      });

      addToast(`Tavoli uniti: ${combinedName} (${totalSeats} coperti)`, 'success');
    } catch (error) {
      console.error('Error merging tables:', error);
      addToast('Errore durante l\'unione dei tavoli', 'error');
    }
  };

  const handleSplitTable = async (tableId: number) => {
    try {
      const table = tables.find(t => t.id === tableId);
      if (!table || !table.merged_with || table.merged_with.length === 0) {
        addToast('Questo tavolo non è unito', 'error');
        return;
      }

      // Get all the original tables that were merged
      const allMergedIds = [table.id, ...table.merged_with];
      const allMergedTables = tables.filter(t => allMergedIds.includes(t.id));

      // Calculate seats per table (divide equally)
      const seatsPerTable = Math.floor(table.seats / allMergedIds.length);

      // Split the name back (e.g., "T1+T2+T3" -> ["T1", "T2", "T3"])
      const originalNames = table.name.split('+');

      // Update the primary table to remove merge
      const updatedPrimaryTable = {
        ...table,
        name: originalNames[0] || table.name.split('+')[0],
        seats: seatsPerTable,
        merged_with: []
      };

      // Optimistic update
      setTables(prev => prev.map(t => t.id === table.id ? updatedPrimaryTable : t));

      // Sync with backend
      await updateTable(table.id, updatedPrimaryTable);

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
  const handleUpdateReservation = async (updatedRes: Reservation) => {
    try {
      const returnedRes = await updateReservation(updatedRes.id as number, updatedRes);
      setReservations(prev => prev.map(r => r.id === returnedRes.id ? returnedRes : r));
      addToast('Prenotazione aggiornata', 'success');
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
      addToast('Prenotazione inserita con successo', 'success');
    } catch (error) {
      console.error("Error adding reservation:", error);
      addToast('Error adding reservation', 'error');
    }
  };

  const handleDeleteReservation = async (id: number) => {
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
      addToast('Prenotazione cancellata', 'info');
    } catch (error) {
      console.error("Error deleting reservation:", error);
      addToast('Error deleting reservation', 'error');
    }
  }

  // Show loading spinner while checking auth
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-slate-500">Caricamento...</p>
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
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
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

      {/* Connection Status Indicator */}
      <div className={`fixed top-4 right-4 z-50 px-3 py-1 rounded-full text-xs font-medium transition-all duration-300 ${
        isConnected
          ? 'bg-emerald-100 text-emerald-700'
          : 'bg-red-100 text-red-700 animate-pulse'
      }`}>
        {isConnected ? '🟢 Live' : '🔴 Offline'}
      </div>

      {/* Sidebar - Hidden on mobile, visible on lg+ */}
      <aside className="hidden lg:flex w-64 bg-white border-r border-slate-200 flex-col transition-all duration-300 z-20 relative">
        <div className="h-16 flex items-center justify-center lg:justify-start lg:px-6 border-b border-slate-100">
          <div className="bg-indigo-600 p-2 rounded-lg">
             <ChefHat className="text-white h-6 w-6" />
          </div>
          <span className="ml-3 font-bold text-xl hidden lg:block text-slate-800">RistoAI</span>
        </div>

        <nav className="flex-1 py-6 space-y-2 px-3">
          {canAccessView(ViewState.DASHBOARD) && (
            <SidebarItem
              icon={<LayoutDashboard size={20} />}
              label="Dashboard"
              active={view === ViewState.DASHBOARD}
              onClick={() => setView(ViewState.DASHBOARD)}
            />
          )}
          {canAccessView(ViewState.RESERVATIONS) && (
            <SidebarItem
              icon={<Calendar size={20} />}
              label="Prenotazioni"
              active={view === ViewState.RESERVATIONS}
              onClick={() => setView(ViewState.RESERVATIONS)}
            />
          )}
          {canAccessView(ViewState.FLOOR_PLAN) && (
            <SidebarItem
              icon={<Grid size={20} />}
              label="Sala & Tavoli"
              active={view === ViewState.FLOOR_PLAN}
              onClick={() => setView(ViewState.FLOOR_PLAN)}
            />
          )}
          {canAccessView(ViewState.MENU) && (
            <SidebarItem
              icon={<MenuIcon size={20} />}
              label="Menu & Banchetti"
              active={view === ViewState.MENU}
              onClick={() => setView(ViewState.MENU)}
            />
          )}
          {canAccessView(ViewState.SETTINGS) && (
            <SidebarItem
              icon={<Settings size={20} />}
              label="Impostazioni"
              active={view === ViewState.SETTINGS}
              onClick={() => setView(ViewState.SETTINGS)}
            />
          )}
        </nav>

        <div className="p-4 border-t border-slate-100 space-y-2">
          {/* User Management Button (Owner only) */}
          {canManageUsers() && (
            <button
              onClick={() => setShowUserManagement(true)}
              className="w-full flex items-center gap-3 px-3 py-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900 rounded-xl transition-all"
            >
              <Users size={20} />
              <span className="text-sm font-medium">Gestione Utenti</span>
            </button>
          )}

          {/* User Info */}
          <div className="hidden lg:flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
            <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs">
              {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-700 truncate">{user?.full_name || 'Utente'}</p>
              <p className="text-xs text-slate-400">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
            </div>
            <button
              onClick={logout}
              className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
              title="Esci"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content - Add bottom padding on mobile for bottom nav */}
      <main className="flex-1 overflow-y-auto relative pb-20 lg:pb-0">
        {/* Header with Notification Center */}
        <header className="h-16 bg-white/80 backdrop-blur-sm border-b border-slate-200 sticky top-0 z-10 flex items-center justify-between px-6">
           <span className="font-bold text-lg lg:hidden">RistoManager AI</span>
           <div className="ml-auto flex items-center gap-4">
               <div className="relative">
                   <button 
                      onClick={() => setShowNotifications(!showNotifications)}
                      className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg relative"
                    >
                       <Bell className="h-5 w-5" />
                       {notifications.some(n => !n.read) && (
                           <span className="absolute top-1.5 right-2 w-2 h-2 bg-rose-500 rounded-full border border-white"></span>
                       )}
                   </button>

                   {/* Notification Dropdown */}
                   {showNotifications && (
                       <div className="absolute right-0 top-full mt-2 w-80 bg-white rounded-xl shadow-xl border border-slate-100 overflow-hidden animate-in fade-in slide-in-from-top-2">
                           <div className="p-3 border-b border-slate-100 flex justify-between items-center">
                               <h3 className="font-semibold text-sm text-slate-700">Notifiche</h3>
                               <button onClick={() => setShowNotifications(false)}><X className="h-4 w-4 text-slate-400" /></button>
                           </div>
                           <div className="max-h-64 overflow-y-auto">
                               {notifications.length === 0 ? (
                                   <div className="p-4 text-center text-sm text-slate-400">Nessuna notifica</div>
                               ) : (
                                   notifications.map(notif => (
                                       <div key={notif.id} className="p-3 hover:bg-slate-50 border-b border-slate-50 last:border-0">
                                           <div className="flex justify-between items-start">
                                                <p className="text-sm font-medium text-slate-800">{notif.title}</p>
                                                <span className="text-[10px] text-slate-400">{notif.timestamp.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                                           </div>
                                           <p className="text-xs text-slate-500 mt-1">{notif.message}</p>
                                       </div>
                                   ))
                               )}
                           </div>
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
          />
        )}

        {view === ViewState.SETTINGS && (
          <div className="p-6 lg:p-10 max-w-4xl mx-auto">
            <h2 className="text-2xl font-bold text-slate-800 mb-6">Impostazioni</h2>

            {/* Admin Section - Only for users who can manage */}
            {canManageUsers() && (
              <div className="mb-8">
                <h3 className="text-lg font-semibold text-slate-700 mb-4">Amministrazione</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* User Management */}
                  <button
                    onClick={() => setShowUserManagement(true)}
                    className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-blue-300 hover:shadow-md transition-all text-left"
                  >
                    <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
                      <Users className="w-6 h-6 text-blue-600" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-800">Gestione Utenti</h4>
                      <p className="text-sm text-slate-500">Crea, modifica ed elimina utenti</p>
                    </div>
                  </button>

                  {/* Role Permissions */}
                  <button
                    onClick={() => setShowRolePermissions(true)}
                    className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-purple-300 hover:shadow-md transition-all text-left"
                  >
                    <div className="w-12 h-12 bg-purple-100 rounded-lg flex items-center justify-center">
                      <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-800">Permessi Ruoli</h4>
                      <p className="text-sm text-slate-500">Configura i permessi per ogni ruolo</p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Monitoring Section - Only for users who can view logs */}
            {canViewLogs() && (
              <div className="mb-8">
                <h3 className="text-lg font-semibold text-slate-700 mb-4">Monitoraggio</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Activity Logs */}
                  <button
                    onClick={() => setShowActivityLogs(true)}
                    className="flex items-center gap-4 p-4 bg-white rounded-xl border border-slate-200 hover:border-amber-300 hover:shadow-md transition-all text-left"
                  >
                    <div className="w-12 h-12 bg-amber-100 rounded-lg flex items-center justify-center">
                      <FileText className="w-6 h-6 text-amber-600" />
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-800">Log Attività</h4>
                      <p className="text-sm text-slate-500">Visualizza le operazioni degli utenti</p>
                    </div>
                  </button>
                </div>
              </div>
            )}

            {/* Integrations Section */}
            <div className="mb-8">
              <h3 className="text-lg font-semibold text-slate-700 mb-4">Integrazioni</h3>
              <div className="bg-white rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 bg-emerald-100 rounded-lg flex items-center justify-center">
                      <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
                      </svg>
                    </div>
                    <div>
                      <h4 className="font-semibold text-slate-800">Stripe Connect</h4>
                      <p className="text-sm text-slate-500">Gateway di pagamento</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 px-3 py-1 bg-emerald-100 rounded-full text-sm text-emerald-700">
                    <div className="w-2 h-2 bg-emerald-500 rounded-full"></div>
                    Attivo (Simulato)
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Bottom Navigation - Visible only on mobile */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 lg:hidden z-30">
          <div className="flex items-center justify-around py-2">
            {canAccessView(ViewState.DASHBOARD) && (
              <BottomNavItem
                icon={<LayoutDashboard size={24} />}
                label="Dashboard"
                active={view === ViewState.DASHBOARD}
                onClick={() => setView(ViewState.DASHBOARD)}
              />
            )}
            {canAccessView(ViewState.RESERVATIONS) && (
              <BottomNavItem
                icon={<Calendar size={24} />}
                label="Prenotazioni"
                active={view === ViewState.RESERVATIONS}
                onClick={() => setView(ViewState.RESERVATIONS)}
              />
            )}
            {canAccessView(ViewState.FLOOR_PLAN) && (
              <BottomNavItem
                icon={<Grid size={24} />}
                label="Sala"
                active={view === ViewState.FLOOR_PLAN}
                onClick={() => setView(ViewState.FLOOR_PLAN)}
              />
            )}
            {canAccessView(ViewState.MENU) && (
              <BottomNavItem
                icon={<MenuIcon size={24} />}
                label="Menu"
                active={view === ViewState.MENU}
                onClick={() => setView(ViewState.MENU)}
              />
            )}
            {canAccessView(ViewState.SETTINGS) && (
              <BottomNavItem
                icon={<Settings size={24} />}
                label="Altro"
                active={view === ViewState.SETTINGS}
                onClick={() => setView(ViewState.SETTINGS)}
              />
            )}
            {/* Mobile logout button */}
            <BottomNavItem
              icon={<LogOut size={24} />}
              label="Esci"
              active={false}
              onClick={logout}
            />
          </div>
        </nav>

        {/* Global Toasts */}
        <div className="fixed bottom-20 lg:bottom-4 right-4 z-50 flex flex-col gap-2">
            {toasts.map(toast => (
                <div 
                    key={toast.id}
                    className={`
                        flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border animate-in slide-in-from-right duration-300
                        ${toast.type === 'success' ? 'bg-white border-emerald-200 text-emerald-700' : 
                          toast.type === 'error' ? 'bg-white border-rose-200 text-rose-700' : 
                          'bg-white border-indigo-200 text-indigo-700'}
                    `}
                >
                    {toast.type === 'success' && <CheckCircle className="h-5 w-5" />}
                    {toast.type === 'error' && <AlertTriangle className="h-5 w-5" />}
                    {toast.type === 'info' && <Info className="h-5 w-5" />}
                    <span className="text-sm font-medium text-slate-800">{toast.message}</span>
                </div>
            ))}
        </div>
      </main>
    </div>
  );
};

// Helper Component for Sidebar
const SidebarItem = ({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-3 py-3 rounded-xl transition-all duration-200 group ${
      active
        ? 'bg-indigo-50 text-indigo-600'
        : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
    }`}
  >
    <span className={`${active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600'}`}>
      {icon}
    </span>
    <span className="font-medium text-sm">{label}</span>
    {active && <ChevronRight className="ml-auto h-4 w-4" />}
  </button>
);

// Helper Component for Bottom Navigation
const BottomNavItem = ({ icon, label, active, onClick }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void }) => (
  <button
    onClick={onClick}
    className={`flex flex-col items-center justify-center px-3 py-2 min-w-[60px] transition-colors duration-200 ${
      active
        ? 'text-indigo-600'
        : 'text-slate-400'
    }`}
  >
    {icon}
    <span className={`text-[10px] mt-1 font-medium ${active ? 'text-indigo-600' : 'text-slate-500'}`}>
      {label}
    </span>
  </button>
);

export default App;