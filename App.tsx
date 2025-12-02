import React, { useState, useEffect } from 'react';
import { LayoutDashboard, Grid, Menu as MenuIcon, Settings, ChevronRight, ChefHat, Calendar, Bell, X, CheckCircle, AlertTriangle, Info } from 'lucide-react';
import { ViewState, Room, Table, Dish, Reservation, TableStatus, TableShape, BanquetMenu, PaymentStatus, Notification, Shift, Toast } from './types';
import { Dashboard } from './components/Dashboard';
import { FloorPlan } from './components/FloorPlan';
import { MenuManager } from './components/MenuManager';
import { ReservationList } from './components/ReservationList';
import { useSocket } from './hooks/useSocket';
import { offlineQueue } from './services/offlineQueue';

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
  deleteDish,
  getBanquetMenus,
  createBanquetMenu,
  updateBanquetMenu,
  deleteBanquetMenu,
} from './services/apiService';

const App: React.FC = () => {
  const [view, setView] = useState<ViewState>(ViewState.DASHBOARD);
  
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

  // Socket.IO connection
  const { socket, isConnected } = useSocket();

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const [roomsData, tablesData, dishesData, banquetMenusData, reservationsData] = await Promise.all([
        getRooms(),
        getTables(),
        getDishes(),
        getBanquetMenus(),
        getReservations(),
      ]);
      setRooms(roomsData);
      setTables(tablesData);
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
      setReservations(prev => [...prev, reservation]);
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
      setTables(prev => [...prev, table]);
    });

    socket.on('table:updated', (table: Table) => {
      setTables(prev =>
        prev.map(t => t.id === table.id ? table : t)
      );
    });

    socket.on('table:deleted', (id: number) => {
      setTables(prev => prev.filter(t => t.id !== id));
    });

    // Room events
    socket.on('room:created', (room: Room) => {
      setRooms(prev => [...prev, room]);
    });

    socket.on('room:deleted', (id: number) => {
      setRooms(prev => prev.filter(r => r.id !== id));
    });

    // Dish events
    socket.on('dish:created', (dish: Dish) => {
      setDishes(prev => [...prev, dish]);
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
    try {
      const returnedTable = await updateTable(updatedTable.id as number, updatedTable);
      setTables(prev => prev.map(t => t.id === returnedTable.id ? returnedTable : t));
    } catch (error) {
      console.error("Error updating table:", error);
      addToast('Error updating table', 'error');
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

  const handleMergeTables = (tableIds: number[]) => {
    console.log('Merging tables:', tableIds);
    addToast('La funzionalità di unione non è ancora implementata.', 'info');
  };

  const handleSplitTable = (tableId: number) => {
    console.log('Splitting table:', tableId);
    addToast('La funzionalità di divisione non è ancora implementata.', 'info');
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
        const returnedDish = await createDish(dish);
        setDishes(prev => [...prev, returnedDish]);
        addToast('Piatto aggiunto al menu', 'success');
    } catch (error) {
        console.error("Error adding dish:", error);
        addToast('Error adding dish', 'error');
    }
  };
  const handleDeleteDish = async (id: number) => {
    try {
        await deleteDish(id);
        setDishes(prev => prev.filter(d => d.id !== id));
        addToast('Piatto rimosso', 'success');
    } catch (error) {
        console.error("Error deleting dish:", error);
        addToast('Error deleting dish', 'error');
    }
  };

  const handleAddBanquet = async (menu: Omit<BanquetMenu, 'id'>) => {
    try {
        const returnedMenu = await createBanquetMenu(menu);
        setBanquetMenus(prev => [...prev, returnedMenu]);
        addToast('Menu banchetto creato', 'success');
    } catch (error) {
        console.error("Error adding banquet menu:", error);
        addToast('Error adding banquet menu', 'error');
    }
    };
    
  const handleDeleteBanquet = async (id: number) => {
    try {
        await deleteBanquetMenu(id);
        setBanquetMenus(prev => prev.filter(m => m.id !== id));
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
      setReservations(prev => [...prev, returnedRes]);
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

  return (
    <div className="flex h-screen bg-slate-50 font-sans text-slate-900">
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
          <SidebarItem 
            icon={<LayoutDashboard size={20} />} 
            label="Dashboard" 
            active={view === ViewState.DASHBOARD} 
            onClick={() => setView(ViewState.DASHBOARD)} 
          />
          <SidebarItem 
            icon={<Calendar size={20} />} 
            label="Prenotazioni" 
            active={view === ViewState.RESERVATIONS} 
            onClick={() => setView(ViewState.RESERVATIONS)} 
          />
          <SidebarItem 
            icon={<Grid size={20} />} 
            label="Sala & Tavoli" 
            active={view === ViewState.FLOOR_PLAN} 
            onClick={() => setView(ViewState.FLOOR_PLAN)} 
          />
          <SidebarItem 
            icon={<MenuIcon size={20} />} 
            label="Menu & Banchetti" 
            active={view === ViewState.MENU} 
            onClick={() => setView(ViewState.MENU)} 
          />
          <SidebarItem 
            icon={<Settings size={20} />} 
            label="Impostazioni" 
            active={view === ViewState.SETTINGS} 
            onClick={() => setView(ViewState.SETTINGS)} 
          />
        </nav>

        <div className="p-4 border-t border-slate-100">
          <div className="hidden lg:flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
             <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 font-bold text-xs">
               AD
             </div>
             <div className="flex-1">
               <p className="text-sm font-medium text-slate-700">Admin User</p>
               <p className="text-xs text-slate-400">Manager</p>
             </div>
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
                showToast={addToast}
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
          />
        )}

        {view === ViewState.MENU && (
          <MenuManager 
            dishes={dishes}
            banquetMenus={banquetMenus}
            onAddDish={handleAddDish}
            onDeleteDish={handleDeleteDish}
            onAddBanquetMenu={handleAddBanquet}
            onDeleteBanquetMenu={handleDeleteBanquet}
          />
        )}

        {view === ViewState.SETTINGS && (
           <div className="p-10 text-center text-slate-400">
               <Settings className="h-16 w-16 mx-auto mb-4 opacity-20" />
               <h2 className="text-xl font-semibold">Impostazioni</h2>
               <p className="mb-4">Integrazione Gateway di Pagamento & Email</p>
               <div className="inline-flex items-center gap-2 px-4 py-2 bg-slate-100 rounded-lg text-sm">
                   <div className="w-2 h-2 bg-emerald-500 rounded-full"></div> Stripe Connect (Simulato) Attivo
               </div>
           </div>
        )}

        {/* Bottom Navigation - Visible only on mobile */}
        <nav className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 lg:hidden z-30">
          <div className="flex items-center justify-around py-2">
            <BottomNavItem
              icon={<LayoutDashboard size={24} />}
              label="Dashboard"
              active={view === ViewState.DASHBOARD}
              onClick={() => setView(ViewState.DASHBOARD)}
            />
            <BottomNavItem
              icon={<Calendar size={24} />}
              label="Prenotazioni"
              active={view === ViewState.RESERVATIONS}
              onClick={() => setView(ViewState.RESERVATIONS)}
            />
            <BottomNavItem
              icon={<Grid size={24} />}
              label="Sala"
              active={view === ViewState.FLOOR_PLAN}
              onClick={() => setView(ViewState.FLOOR_PLAN)}
            />
            <BottomNavItem
              icon={<MenuIcon size={24} />}
              label="Menu"
              active={view === ViewState.MENU}
              onClick={() => setView(ViewState.MENU)}
            />
            <BottomNavItem
              icon={<Settings size={24} />}
              label="Altro"
              active={view === ViewState.SETTINGS}
              onClick={() => setView(ViewState.SETTINGS)}
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