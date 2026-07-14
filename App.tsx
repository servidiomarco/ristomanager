import React, { useState, useEffect, useRef } from 'react';
import { LayoutDashboard, Grid, Settings, ChevronRight, ChevronLeft, ChevronDown, ChefHat, Calendar, CalendarDays, Bell, X, CheckCircle, AlertTriangle, Info, LogOut, Users, UserCheck, FileText, PanelLeftClose, PanelLeft, UsersRound, Sun, Moon, Sunset, Wifi, WifiOff, MoreHorizontal, Search, UtensilsCrossed, Plus, BookUser, Boxes, Clock, ShoppingCart, ListChecks, ShieldCheck, Phone, ConciergeBell, Zap, PartyPopper, DoorClosed, StickyNote, CreditCard } from 'lucide-react';
import { ViewState, Room, Table, Dish, Reservation, TableStatus, TableShape, BanquetMenu, PaymentStatus, Notification, Shift, Toast, UserRole } from './types';
import { Dashboard } from './components/Dashboard';
import { FloorPlan } from './components/FloorPlan';
import { MenuManager } from './components/MenuManager';
import { ReservationList } from './components/ReservationList';
import { LoginPage } from './components/LoginPage';
import { CookingPotLoader } from './components/CookingPotLoader';
import { UserManagement } from './components/UserManagement';
import { RolePermissions } from './components/RolePermissions';
import { ActivityLogs } from './components/ActivityLogs';
import { StaffManagement } from './components/StaffManagement';
import { CustomerList } from './components/CustomerList';
import { Inventory } from './components/Inventory';
import { ShoppingListPage } from './components/ShoppingListPage';
import { HaccpPage } from './components/HaccpPage';
import ConversazioniPage from './components/ConversazioniPage';
import ReceptionPage from './components/ReceptionPage';
import { AttivitaPage } from './components/AttivitaPage';
import { PushNotificationsCard } from './components/PushNotificationsCard';
import { OpeningHoursManager } from './components/OpeningHoursManager';
import { FeatureTogglesManager } from './components/FeatureTogglesManager';
import { ScheduledClosuresManager } from './components/ScheduledClosuresManager';
import { ReservationNotesManager } from './components/ReservationNotesManager';
import { ReservationAllergensManager } from './components/ReservationAllergensManager';
import { AutoDepositManager } from './components/AutoDepositManager';
import { RevolutIntegrationCard } from './components/RevolutIntegrationCard';
import { VoiceAgentWidget } from './components/VoiceAgentWidget';
import { DateNavigator } from './components/DateNavigator';
import { useSocket } from './hooks/useSocket';
import { useTokenExpiryWarning } from './hooks/useTokenExpiryWarning';
import { offlineQueue } from './services/offlineQueue';
import { socketClient } from './services/socketClient';
import { voiceCallsApiService } from './services/voiceCallsApiService';
import { useAuth } from './contexts/AuthContext';
import { sortRooms } from './utils/roomOrder';
import { toTitleCase } from './utils/text';

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
  setRoomClosed,
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

// ---------------------------------------------------------------------------
// Navigation taxonomy — single source of truth for the desktop sidebar AND the
// mobile "Altro" sheet. Both surfaces map over NAV_ITEMS; only their filters and
// presentation differ. Item labels, icons and routes must not be edited here
// without an intentional change — this drives every nav surface.
// ---------------------------------------------------------------------------
type NavGroupId = 'servizio' | 'operazioni' | 'gestione' | 'sistema';

// Eyebrow headings, in render order. Proper case by design — never all caps.
const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'servizio', label: 'Servizio' },
  { id: 'operazioni', label: 'Operazioni' },
  { id: 'gestione', label: 'Gestione' },
  { id: 'sistema', label: 'Sistema' },
];

type NavItem = {
  kind: 'link' | 'theme';
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  group: NavGroupId | null;        // null = ungrouped, pinned to the top (Dashboard)
  isTab: boolean;                  // true = already in the mobile bottom tab bar → hidden from "Altro"
  view?: ViewState;                // present for 'link' items
  requiresUserManagement?: boolean;// gate via canManageUsers() instead of canAccessView()
  sidebarCollapse?: boolean;       // desktop side effect on select: true→collapse, false→expand, undefined→leave as-is
  menuInitialTab?: 'DISHES' | 'BANQUETS';
};

const NAV_ITEMS: NavItem[] = [
  // Ungrouped (top)
  { kind: 'link', label: 'Dashboard', Icon: LayoutDashboard, group: null, isTab: true, view: ViewState.DASHBOARD, sidebarCollapse: false },

  // Servizio
  { kind: 'link', label: 'Prenotazioni', Icon: Calendar, group: 'servizio', isTab: true, view: ViewState.RESERVATIONS, sidebarCollapse: true },
  { kind: 'link', label: 'Reception', Icon: ConciergeBell, group: 'servizio', isTab: false, view: ViewState.RECEPTION, sidebarCollapse: true },
  { kind: 'link', label: 'Sale & Tavoli', Icon: Grid, group: 'servizio', isTab: false, view: ViewState.FLOOR_PLAN, sidebarCollapse: false },
  { kind: 'link', label: 'Menu & Banchetti', Icon: UtensilsCrossed, group: 'servizio', isTab: false, view: ViewState.MENU, sidebarCollapse: false, menuInitialTab: 'BANQUETS' },
  { kind: 'link', label: 'Conversazioni', Icon: Phone, group: 'servizio', isTab: true, view: ViewState.CONVERSAZIONI, sidebarCollapse: false },

  // Operazioni
  { kind: 'link', label: 'Attività', Icon: ListChecks, group: 'operazioni', isTab: false, view: ViewState.ATTIVITA, sidebarCollapse: false },
  { kind: 'link', label: 'Inventario', Icon: Boxes, group: 'operazioni', isTab: false, view: ViewState.INVENTARIO },
  { kind: 'link', label: 'Lista della Spesa', Icon: ShoppingCart, group: 'operazioni', isTab: false, view: ViewState.LISTA_DELLA_SPESA, sidebarCollapse: false },
  { kind: 'link', label: 'HACCP', Icon: ShieldCheck, group: 'operazioni', isTab: false, view: ViewState.HACCP, sidebarCollapse: false },

  // Gestione
  { kind: 'link', label: 'Clienti', Icon: BookUser, group: 'gestione', isTab: false, view: ViewState.CLIENTI, sidebarCollapse: false },
  { kind: 'link', label: 'Personale', Icon: UsersRound, group: 'gestione', isTab: false, view: ViewState.STAFF, sidebarCollapse: false },
  { kind: 'link', label: 'Utenti', Icon: Users, group: 'gestione', isTab: false, view: ViewState.USERS, sidebarCollapse: false, requiresUserManagement: true },

  // Sistema
  { kind: 'link', label: 'Impostazioni', Icon: Settings, group: 'sistema', isTab: false, view: ViewState.SETTINGS, sidebarCollapse: false },
  { kind: 'theme', label: 'Modalità scura', Icon: Moon, group: 'sistema', isTab: false },
];

const App: React.FC = () => {
  const { user, isAuthenticated, isLoading: authLoading, logout, canAccessView, canManageUsers, hasPermission, getAccessibleViews, canViewLogs, updatePreferences } = useAuth();

  const [view, setView] = useState<ViewState>(ViewState.DASHBOARD);
  // Tracks whether we've already applied the user's preferred landing for this
  // session. Reset on logout so the next login re-applies it.
  const appliedPreferredLandingRef = useRef(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [menuInitialTab, setMenuInitialTab] = useState<'DISHES' | 'BANQUETS'>('BANQUETS');
  const [autoOpenNewReservation, setAutoOpenNewReservation] = useState(false);
  const [newReservationKind, setNewReservationKind] = useState<'standard' | 'walkin'>('standard');
  // Prefill applied when opening the new-reservation modal (currently used
  // when converting a voice call into a booking).
  const [newReservationPrefill, setNewReservationPrefill] = useState<{ customer_name?: string; phone?: string } | undefined>(undefined);
  // If set, the next reservation that gets created is linked to this voice
  // call. Cleared once the link finishes (or the modal is dismissed).
  const linkVoiceCallOnCreateRef = useRef<number | null>(null);
  const [autoOpenNewBanquet, setAutoOpenNewBanquet] = useState(false);
  const [autoOpenNewDish, setAutoOpenNewDish] = useState(false);
  const [autoOpenNewCustomer, setAutoOpenNewCustomer] = useState(false);
  const [autoEditCustomerByPhone, setAutoEditCustomerByPhone] = useState<string | null>(null);
  const [autoOpenNewStaff, setAutoOpenNewStaff] = useState(false);
  const [autoOpenNewUser, setAutoOpenNewUser] = useState(false);
  const [autoOpenNewProduct, setAutoOpenNewProduct] = useState(false);
  const [autoOpenNewShoppingItem, setAutoOpenNewShoppingItem] = useState(false);
  const [autoOpenWalkIn, setAutoOpenWalkIn] = useState(false);
  const [autoOpenNewAttivita, setAutoOpenNewAttivita] = useState(false);
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const [showCreateMenu, setShowCreateMenu] = useState(false);
  const createMenuRef = useRef<HTMLDivElement>(null);

  // Close the global create menu on outside click (pointer down outside the +/panel)
  useEffect(() => {
    if (!showCreateMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (createMenuRef.current && !createMenuRef.current.contains(e.target as Node)) {
        setShowCreateMenu(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showCreateMenu]);
  const [activeMenuTab, setActiveMenuTab] = useState<'DISHES' | 'BANQUETS'>('BANQUETS');
  const [reservationsSearchPrefill, setReservationsSearchPrefill] = useState<string | undefined>(undefined);
  // Set when a notification deep-links to a specific booking (?reservationId=…);
  // handed to ReservationList so it opens that booking's detail drawer.
  const [pendingReservationId, setPendingReservationId] = useState<number | null>(null);

  // Count of voice calls in the last 7 days without a linked reservation —
  // drives the follow-up badge on the Conversazioni sidebar icon.
  const [voiceCallsPendingCount, setVoiceCallsPendingCount] = useState(0);
  const canSeeVoiceCalls = canAccessView(ViewState.CONVERSAZIONI);
  useEffect(() => {
    if (!isAuthenticated || !canSeeVoiceCalls) return;
    let cancelled = false;
    const refresh = () => {
      voiceCallsApiService.pendingCount()
        .then(({ count }) => { if (!cancelled) setVoiceCallsPendingCount(count); })
        .catch(() => { /* silent — badge just stays at previous value */ });
    };
    refresh();
    // Refresh when the app regains focus (e.g., staff comes back after a call)
    // and every time the user navigates to the Conversazioni page (see effect below).
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [isAuthenticated, canSeeVoiceCalls]);
  // Re-fetch when leaving the Conversazioni page so the badge reflects any
  // reservations linked from calls the user just handled.
  useEffect(() => {
    if (!isAuthenticated || !canSeeVoiceCalls) return;
    if (view === ViewState.CONVERSAZIONI) return;
    voiceCallsApiService.pendingCount()
      .then(({ count }) => setVoiceCallsPendingCount(count))
      .catch(() => {});
  }, [view, isAuthenticated, canSeeVoiceCalls]);

  // Global date/shift state — drives the header control group on desktop
  const [globalDate, setGlobalDate] = useState<Date>(new Date());
  const [globalShiftFilter, setGlobalShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>(() =>
    new Date().getHours() < 17 ? 'LUNCH' : 'DINNER'
  );
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  useEffect(() => {
    const now = new Date();
    const msUntilNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    let interval: ReturnType<typeof setInterval>;
    const timeout = setTimeout(() => {
      setCurrentTime(new Date());
      interval = setInterval(() => setCurrentTime(new Date()), 60_000);
    }, msUntilNextMinute);
    return () => { clearTimeout(timeout); if (interval) clearInterval(interval); };
  }, []);

  const formatLocalDateGlobal = (d: Date) => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const globalDateStr = formatLocalDateGlobal(globalDate);

  // Auto-switch from 'ALL' when navigating away from Dashboard
  useEffect(() => {
    if (view !== ViewState.DASHBOARD && globalShiftFilter === 'ALL') {
      setGlobalShiftFilter(new Date().getHours() < 17 ? 'LUNCH' : 'DINNER');
    }
  }, [view]);

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

  // Redirect to first accessible view when user changes or doesn't have access to current view.
  // Also honors a ?view= query param so a notification click that opens a fresh tab lands on
  // the right view (e.g. /?view=RESERVATIONS from a "new reservation" notification).
  // On the first authenticated render, also applies the user's preferred landing view
  // (settable from Impostazioni → Profilo) — but ?view= deep-links always win.
  useEffect(() => {
    if (!isAuthenticated || !user) {
      appliedPreferredLandingRef.current = false;
      return;
    }
    const accessibleViews = getAccessibleViews();

    const params = new URLSearchParams(window.location.search);
    const requestedView = params.get('view');
    // A notification may deep-link to a specific booking; capture it so the
    // Prenotazioni view opens that booking's detail once mounted.
    const requestedReservationId = params.get('reservationId');
    if (requestedReservationId) {
      const parsed = Number(requestedReservationId);
      if (Number.isFinite(parsed)) setPendingReservationId(parsed);
    }
    if (requestedView && (Object.values(ViewState) as string[]).includes(requestedView)) {
      const target = requestedView as ViewState;
      if (accessibleViews.includes(target)) {
        setView(target);
        appliedPreferredLandingRef.current = true;
      }
      // Strip the params either way so reloads don't keep re-navigating.
      params.delete('view');
      params.delete('reservationId');
      const search = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (search ? `?${search}` : '') + window.location.hash);
      if (accessibleViews.includes(target)) return;
    }

    // Apply preferred landing view once per session (after login or initial load).
    if (!appliedPreferredLandingRef.current && user.preferred_landing_view) {
      const preferred = user.preferred_landing_view as ViewState;
      if (
        (Object.values(ViewState) as string[]).includes(preferred) &&
        accessibleViews.includes(preferred)
      ) {
        setView(preferred);
        appliedPreferredLandingRef.current = true;
        return;
      }
    }
    appliedPreferredLandingRef.current = true;

    if (accessibleViews.length > 0 && !accessibleViews.includes(view)) {
      setView(accessibleViews[0]);
    }
  }, [isAuthenticated, user]);

  // When a notification is clicked while the app is already open, the service
  // worker postMessages us a URL instead of forcing a reload. Pick out ?view=
  // from it and switch in-app if the user has access.
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || data.type !== 'NOTIFICATION_CLICK' || !data.url) return;
      try {
        const url = new URL(data.url, window.location.origin);
        const requestedView = url.searchParams.get('view');
        if (!requestedView) return;
        if (!(Object.values(ViewState) as string[]).includes(requestedView)) return;
        const target = requestedView as ViewState;
        if (getAccessibleViews().includes(target)) {
          const requestedReservationId = url.searchParams.get('reservationId');
          if (requestedReservationId) {
            const parsed = Number(requestedReservationId);
            if (Number.isFinite(parsed)) setPendingReservationId(parsed);
          }
          setView(target);
        }
      } catch {
        // Ignore malformed URLs
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [isAuthenticated, user, getAccessibleViews]);

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

  // Re-fetch when the PWA / tab returns to the foreground. iOS Safari throttles
  // and often kills background websockets, so the socket "connect" handler is
  // not always enough — visibilitychange and pageshow cover the short
  // backgrounding case where the socket never noticed the gap.
  useEffect(() => {
    if (!isAuthenticated) return;
    const onResume = () => {
      if (document.visibilityState === 'visible') {
        fetchData();
      }
    };
    document.addEventListener('visibilitychange', onResume);
    // pageshow fires when a page is restored from the bfcache (common on iOS
    // when swiping back to a previously suspended PWA).
    window.addEventListener('pageshow', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
    };
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
    options?: { title?: string; details?: string[]; duration?: number; action?: { label: string; onClick: () => void } }
  ) => {
      const id = Math.random().toString(36).substr(2, 9);
      const duration = options?.duration ?? (options?.details?.length ? 6000 : 3000);
      setToasts(prev => [...prev, {
          id,
          message,
          type,
          title: options?.title,
          details: options?.details,
          duration,
          action: options?.action,
      }]);

      setTimeout(() => {
          setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
  };

  useTokenExpiryWarning({ isAuthenticated, showToast: addToast });

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
      addToast(`Nuova prenotazione: ${toTitleCase(reservation.customer_name)}`, 'info');
    });

    socket.on('reservation:updated', (reservation: Reservation) => {
      setReservations(prev =>
        prev.map(r => r.id === reservation.id ? reservation : r)
      );
      addToast(`Prenotazione aggiornata: ${toTitleCase(reservation.customer_name)}`, 'info');
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

    socket.on('room:updated', (room: Room) => {
      setRooms(prev => prev.map(r => r.id === room.id ? room : r));
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
      console.log('✅ Socket connected - refreshing data');

      // Show reconnection toast
      addToast('Connessione ristabilita', 'success');

      // Always re-fetch on (re)connect. iOS suspends websockets when the PWA
      // is backgrounded; on resume the socket reconnects and we may have
      // missed broadcasts while disconnected, so pull the current state.
      fetchData();

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

        // Refresh again after the flush so the UI reflects the server state
        // produced by replaying the queue.
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
      socket.off('room:updated');
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

  const handleToggleRoomClosed = async (roomId: number, isClosed: boolean) => {
    try {
      const updated = await setRoomClosed(roomId, isClosed);
      setRooms(prev => prev.map(r => r.id === roomId ? updated : r));
      addToast(isClosed ? `Sala "${updated.name}" chiusa` : `Sala "${updated.name}" riaperta`, 'success');
    } catch (error: any) {
      console.error("Error toggling room closed:", error);
      addToast(error?.message || 'Errore aggiornamento sala', 'error');
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
    } catch (error: any) {
        console.error("Error adding banquet menu:", error);
        addToast(error?.message || 'Errore creazione menu banchetto', 'error');
        throw error;
    }
    };

  const handleUpdateBanquet = async (id: number, menu: Partial<BanquetMenu>) => {
    try {
        await updateBanquetMenu(id, menu);
        // Socket.IO will handle updating state via banquet:updated event
        addToast('Menu banchetto aggiornato', 'success');
    } catch (error: any) {
        console.error("Error updating banquet menu:", error);
        addToast(error?.message || 'Errore aggiornamento menu banchetto', 'error');
        throw error;
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
    } catch (error: any) {
      console.error("Error updating reservation:", error);
      addToast(error?.message || 'Errore aggiornamento prenotazione', 'error');
      throw error;
    }
  };

  const handleAddReservation = async (newRes: Omit<Reservation, 'id'>) => {
    try {
      const returnedRes = await createReservation(newRes);
      // If this reservation was created from a voice call, link it and drop
      // the call out of the pending queue. Best-effort — a link failure
      // should not block the user's booking flow.
      const linkCallId = linkVoiceCallOnCreateRef.current;
      if (linkCallId != null) {
        linkVoiceCallOnCreateRef.current = null;
        voiceCallsApiService.linkReservation(linkCallId, returnedRes.id)
          .then(() => voiceCallsApiService.pendingCount()
            .then(({ count }) => setVoiceCallsPendingCount(count))
            .catch(() => {}))
          .catch((err) => console.warn('linkReservation failed:', err));
      }
      // Optimistically include the new row so checks that scan `reservations`
      // (e.g. the duplicate preflight) see it immediately instead of waiting
      // for the socket round-trip. The socket handler dedupes by id.
      setReservations(prev => prev.some(r => r.id === returnedRes.id) ? prev : [...prev, returnedRes]);
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
    } catch (error: any) {
      console.error("Error adding reservation:", error);
      addToast(error?.message || 'Errore creazione prenotazione', 'error');
      throw error;
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
        <CookingPotLoader label="Caricamento..." />
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
      [UserRole.GENERAL_MANAGER]: 'General Manager',
      [UserRole.MANAGER]: 'Manager',
      [UserRole.RECEPTION]: 'Reception',
      [UserRole.WAITER]: 'Cameriere',
      [UserRole.KITCHEN]: 'Cucina'
    };
    return roleNames[role] || role;
  };

  // Capability gate for a nav item — drives which items show across every surface
  // so all permission tiers stay consistent. The theme toggle is always available.
  const canSeeNavItem = (item: NavItem): boolean => {
    if (item.kind === 'theme') return true;
    if (item.requiresUserManagement) return canManageUsers();
    return item.view !== undefined && canAccessView(item.view);
  };

  // Desktop sidebar: select a link, applying its incidental sidebar side effects.
  const selectNavItem = (item: NavItem) => {
    if (item.view === undefined) return;
    if (item.sidebarCollapse === true) setSidebarCollapsed(true);
    else if (item.sidebarCollapse === false) setSidebarCollapsed(false);
    if (item.menuInitialTab) setMenuInitialTab(item.menuInitialTab);
    setView(item.view);
  };

  // Items surfaced in the mobile "Altro" sheet (every visible non-tab link).
  // Drives the bottom-tab "Altro" button's visibility and active state.
  const altroNavItems = NAV_ITEMS.filter(item => item.kind === 'link' && !item.isTab && canSeeNavItem(item));

  // Global "+" create menu — identical on every page (not contextual to the view).
  // Each item reuses an existing create flow; items the user can't create are hidden.
  // Two clusters (service actions, then records) rendered with an unlabeled divider.
  // Closing the menu, then running the action, keeps the panel from lingering over the modal.
  const runCreateAction = (run: () => void) => { setShowCreateMenu(false); run(); };
  const createMenuClusters: { label: string; Icon: React.ComponentType<{ size?: number; className?: string }>; show: boolean; run: () => void }[][] = [
    [
      { label: 'Prenotazione', Icon: Calendar, show: hasPermission('reservations:full'), run: () => { setNewReservationKind('standard'); setAutoOpenNewReservation(true); } },
      { label: 'Walk-in', Icon: Zap, show: canAccessView(ViewState.RECEPTION), run: () => { setView(ViewState.RECEPTION); setAutoOpenWalkIn(true); } },
      { label: 'Banchetto', Icon: PartyPopper, show: hasPermission('menu:full'), run: () => { setMenuInitialTab('BANQUETS'); setView(ViewState.MENU); setAutoOpenNewBanquet(true); } },
      { label: 'Piatto', Icon: UtensilsCrossed, show: hasPermission('menu:full'), run: () => { setMenuInitialTab('DISHES'); setView(ViewState.MENU); setAutoOpenNewDish(true); } },
    ],
    [
      { label: 'Spesa', Icon: ShoppingCart, show: canAccessView(ViewState.LISTA_DELLA_SPESA), run: () => { setView(ViewState.LISTA_DELLA_SPESA); setAutoOpenNewShoppingItem(true); } },
      { label: 'Attività', Icon: ListChecks, show: canAccessView(ViewState.ATTIVITA), run: () => { setView(ViewState.ATTIVITA); setAutoOpenNewAttivita(true); } },
    ],
    [
      { label: 'Cliente', Icon: BookUser, show: hasPermission('customers:full'), run: () => { setView(ViewState.CLIENTI); setAutoOpenNewCustomer(true); } },
      { label: 'Dipendente', Icon: UsersRound, show: hasPermission('staff:full'), run: () => { setView(ViewState.STAFF); setAutoOpenNewStaff(true); } },
      { label: 'Utente', Icon: Users, show: canManageUsers(), run: () => { setView(ViewState.USERS); setAutoOpenNewUser(true); } },
      { label: 'Prodotto', Icon: Boxes, show: hasPermission('inventory:full'), run: () => { setView(ViewState.INVENTARIO); setAutoOpenNewProduct(true); } },
    ],
  ];
  const visibleCreateClusters = createMenuClusters
    .map(cluster => cluster.filter(item => item.show))
    .filter(cluster => cluster.length > 0);

  return (
    <div className="flex h-screen bg-[var(--color-surface-2)] font-sans text-[var(--color-fg)]">
      {/* Skip link for keyboard users */}
      <a href="#main" className="skip-link">Salta al contenuto</a>

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
          {NAV_ITEMS.filter(item => item.group === null && canSeeNavItem(item)).map(item => (
            <SidebarItem
              key={item.label}
              icon={<item.Icon size={20} />}
              label={item.label}
              active={item.view !== undefined && view === item.view}
              onClick={() => selectNavItem(item)}
              collapsed={sidebarCollapsed}
            />
          ))}
          {NAV_GROUPS.map(group => {
            const items = NAV_ITEMS.filter(item => item.group === group.id && canSeeNavItem(item));
            if (items.length === 0) return null;
            return (
              <React.Fragment key={group.id}>
                {!sidebarCollapsed && (
                  <div className="px-3 pt-5 pb-2 text-[10px] tracking-[0.04em] font-semibold text-[var(--color-sidebar-eyebrow)]">
                    {group.label}
                  </div>
                )}
                {items.map(item => (
                  item.kind === 'theme' ? (
                    sidebarCollapsed ? (
                      <button
                        key={item.label}
                        type="button"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Tema chiaro' : 'Tema scuro'}
                        aria-label={theme === 'dark' ? 'Passa a tema chiaro' : 'Passa a tema scuro'}
                        className="group w-full flex items-center justify-center px-3 py-2 rounded-md text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-active-bg)] hover:text-[var(--color-sidebar-fg-strong)] transition-colors"
                      >
                        {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                      </button>
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        onClick={toggleTheme}
                        aria-label={theme === 'dark' ? 'Passa a tema chiaro' : 'Passa a tema scuro'}
                        aria-pressed={theme === 'dark'}
                        className="group w-full flex items-center justify-between gap-3 px-3 py-2 rounded-md text-[var(--color-sidebar-fg)] hover:bg-[var(--color-sidebar-active-bg)] hover:text-[var(--color-sidebar-fg-strong)] transition-colors text-sm"
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-[var(--color-sidebar-fg)] group-hover:text-[var(--color-sidebar-fg-strong)]">
                            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                          </span>
                          <span className="font-medium">{item.label}</span>
                        </span>
                        <span
                          aria-hidden
                          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${theme === 'dark' ? 'bg-[var(--color-sidebar-fg-strong)]' : 'bg-[var(--color-sidebar-line)]'}`}
                        >
                          <span
                            className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-sidebar-bg)] shadow transition-transform ${theme === 'dark' ? 'translate-x-4' : 'translate-x-0.5'}`}
                          />
                        </span>
                      </button>
                    )
                  ) : (
                    <SidebarItem
                      key={item.label}
                      icon={<item.Icon size={20} />}
                      label={item.label}
                      active={item.view !== undefined && view === item.view}
                      onClick={() => selectNavItem(item)}
                      collapsed={sidebarCollapsed}
                      badge={item.view === ViewState.CONVERSAZIONI ? voiceCallsPendingCount : undefined}
                    />
                  )
                ))}
              </React.Fragment>
            );
          })}
        </nav>

        <div className={`p-3 space-y-1 ${sidebarCollapsed ? 'px-2' : ''}`}>
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
        {/* Header — taller on desktop to house the date/time/shift controls */}
        <header className="h-14 md:h-[72px] bg-[var(--color-surface-2)]/90 backdrop-blur-sm border-b border-[var(--color-line)] sticky top-0 z-10 flex items-center justify-between px-4 lg:px-6">
           <div className="flex items-center gap-2 lg:hidden">
              <div className="bg-[var(--color-fg)] p-1.5 rounded-md">
                <ChefHat className="text-[var(--color-fg-on-brand)] h-4 w-4" />
              </div>
              <span className="font-semibold text-[15px] tracking-tight text-[var(--color-fg)]">RistoCRM</span>
           </div>

           {/* Desktop date/time/shift control group — takes ~half the header width */}
           <div className={`hidden md:flex items-center gap-2.5 w-1/2 min-w-0 ${[ViewState.SETTINGS, ViewState.USERS, ViewState.CLIENTI, ViewState.STAFF].includes(view) ? '!hidden' : ''}`}>
             <DateNavigator
               value={globalDateStr}
               onChange={(dateOnly) => {
                 const [y, m, d] = dateOnly.split('-').map(Number);
                 if (y && m && d) setGlobalDate(new Date(y, m - 1, d));
               }}
               widthClass="w-[200px]"
               backToToday="inline"
             />

             {/* Live time chip */}
             <div className="flex items-center gap-1.5 bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] px-3 py-2 flex-shrink-0">
               <Clock className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
               <span className="tabular font-medium text-sm text-[var(--color-fg)] whitespace-nowrap">
                 {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
               </span>
             </div>

             {/* Shift filter — "Tutti" only on Dashboard */}
             <div className="flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5 flex-shrink-0">
               {([
                 { key: 'ALL', label: 'Tutti', icon: null as React.ReactNode },
                 { key: 'LUNCH', label: 'Pranzo', icon: <Sun className="h-3.5 w-3.5" /> },
                 { key: 'DINNER', label: 'Cena', icon: <Sunset className="h-3.5 w-3.5" /> },
               ] as const).filter(opt => opt.key !== 'ALL' || view === ViewState.DASHBOARD).map(opt => (
                 <button
                   key={opt.key}
                   onClick={() => setGlobalShiftFilter(opt.key)}
                   className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
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

           <div className="ml-auto flex items-center gap-2">
              {/* Global "+" create menu — replaces the old Nuova prenotazione + per-view secondary CTAs.
                  Identical on every page; desktop/tablet only (mobile uses the bottom "+" sheet). */}
              {visibleCreateClusters.length > 0 && (
                <div className="relative hidden md:block" ref={createMenuRef}>
                  <button
                    type="button"
                    onClick={() => { setShowCreateMenu(v => !v); setShowNotifications(false); }}
                    aria-haspopup="menu"
                    aria-expanded={showCreateMenu}
                    aria-label="Crea nuovo"
                    className="inline-flex items-center justify-center h-11 w-11 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 transition-all shadow-[var(--shadow-sm)]"
                  >
                    <Plus className="h-5 w-5 transition-transform duration-200" style={{ transform: showCreateMenu ? 'rotate(45deg)' : 'none' }} />
                  </button>

                  {showCreateMenu && (
                    <div
                      role="menu"
                      aria-label="Crea nuovo"
                      className="absolute right-0 top-full mt-2 w-60 p-1.5 rounded-[18px] border border-[var(--color-line)] bg-[var(--color-surface)] shadow-[var(--shadow-lg)] z-30 animate-in fade-in slide-in-from-top-2"
                    >
                      {visibleCreateClusters.map((cluster, ci) => (
                        <React.Fragment key={ci}>
                          {ci > 0 && <div className="my-1.5 border-t border-[var(--color-line)]" />}
                          {cluster.map(item => (
                            <button
                              key={item.label}
                              type="button"
                              role="menuitem"
                              onClick={() => runCreateAction(item.run)}
                              className="w-full flex items-center gap-3 px-3 h-11 rounded-xl text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors text-left"
                            >
                              <item.Icon className="h-[18px] w-[18px] text-[var(--color-fg-muted)]" />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Connection state — full pill on md+, status dot only on mobile */}
              <div
                className={`hidden md:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${
                  isConnected
                    ? 'border-[var(--color-line)] text-[var(--color-fg-muted)] bg-[var(--color-surface)]'
                    : 'border-rose-200 text-rose-700 bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:bg-rose-500/15 animate-pulse'
                }`}
                role="status"
                aria-live={isConnected ? 'polite' : 'assertive'}
                aria-label={isConnected ? 'Connesso' : 'Non connesso'}
              >
                {isConnected ? (
                  <>
                    <span className="relative flex h-2 w-2" aria-hidden>
                      <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping"></span>
                      <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500"></span>
                    </span>
                    <Wifi className="h-3 w-3 text-emerald-600" aria-hidden />
                  </>
                ) : (
                  <WifiOff className="h-3 w-3" aria-hidden />
                )}
                <span>{isConnected ? 'Live' : 'Offline'}</span>
              </div>
              {/* Mobile-only status dot */}
              <span
                className="md:hidden relative flex h-2.5 w-2.5 mx-1"
                role="status"
                aria-live={isConnected ? 'polite' : 'assertive'}
                aria-label={isConnected ? 'Connesso' : 'Non connesso'}
                title={isConnected ? 'Connesso' : 'Non connesso'}
              >
                {isConnected && (
                  <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping" aria-hidden></span>
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-rose-500'}`}
                  aria-hidden
                ></span>
              </span>



               <div className="relative">
                   <button
                      onClick={() => { setShowNotifications(!showNotifications); setShowUserMenu(false); }}
                      className="h-9 w-9 inline-flex items-center justify-center rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] relative transition-colors"
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
            onNavigateToReservations={() => { setSidebarCollapsed(true); setView(ViewState.RESERVATIONS); }}
            onNavigateToInventario={() => { setSidebarCollapsed(false); setView(ViewState.INVENTARIO); }}
            onNavigateToShoppingList={() => setView(ViewState.LISTA_DELLA_SPESA)}
            onNavigateToAttivita={() => setView(ViewState.ATTIVITA)}
            globalDate={globalDate}
            globalShiftFilter={globalShiftFilter}
            onDateChange={setGlobalDate}
            onShiftFilterChange={setGlobalShiftFilter}
          />
        )}

        {/* Global "Nuova prenotazione" modal — opens on whichever page the user is on
            (skip on RESERVATIONS view, which handles its own inline modal) */}
        {autoOpenNewReservation && view !== ViewState.RESERVATIONS && (
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
            modalOnly
            autoOpenNew
            autoOpenNewKind={newReservationKind}
            newReservationPrefill={newReservationPrefill}
            onAutoOpenNewHandled={() => { /* keep flag until modal closes */ }}
            onModalClose={() => {
              setAutoOpenNewReservation(false);
              setNewReservationKind('standard');
              setNewReservationPrefill(undefined);
              linkVoiceCallOnCreateRef.current = null;
            }}
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
                autoOpenNew={autoOpenNewReservation}
                autoOpenNewKind={newReservationKind}
                newReservationPrefill={newReservationPrefill}
                onAutoOpenNewHandled={() => { setAutoOpenNewReservation(false); setNewReservationKind('standard'); setNewReservationPrefill(undefined); }}
                initialSearchTerm={reservationsSearchPrefill}
                onInitialSearchTermHandled={() => setReservationsSearchPrefill(undefined)}
                openReservationId={pendingReservationId}
                onOpenReservationHandled={() => setPendingReservationId(null)}
                globalDate={globalDate}
                globalShiftFilter={globalShiftFilter}
                onDateChange={setGlobalDate}
                onShiftFilterChange={setGlobalShiftFilter}
            />
        )}

        {view === ViewState.USERS && canManageUsers() && (
          <UserManagement autoOpenNew={autoOpenNewUser} onAutoOpenNewHandled={() => setAutoOpenNewUser(false)} />
        )}

        {view === ViewState.FLOOR_PLAN && (
          <FloorPlan
            rooms={rooms}
            tables={tables}
            reservations={reservations}
            banquetMenus={banquetMenus}
            onUpdateTable={handleUpdateTable}
            onAddTable={handleAddTable}
            onDeleteTable={handleDeleteTable}
            onMergeTables={handleMergeTables}
            onSplitTable={handleSplitTable}
            onAddRoom={handleAddRoom}
            onDeleteRoom={handleDeleteRoom}
            onToggleRoomClosed={handleToggleRoomClosed}
            canEdit={hasPermission('floorplan:full')}
            globalDate={globalDate}
            globalShiftFilter={globalShiftFilter}
          />
        )}

        {view === ViewState.MENU && (
          <MenuManager
            dishes={dishes}
            banquetMenus={banquetMenus}
            tables={tables}
            rooms={rooms}
            reservations={reservations}
            onAddDish={handleAddDish}
            onUpdateDish={handleUpdateDish}
            onDeleteDish={handleDeleteDish}
            onAddBanquetMenu={handleAddBanquet}
            onUpdateBanquetMenu={handleUpdateBanquet}
            onDeleteBanquetMenu={handleDeleteBanquet}
            canEdit={hasPermission('menu:full')}
            initialTab={menuInitialTab}
            autoOpenNewBanquet={autoOpenNewBanquet}
            onAutoOpenNewBanquetHandled={() => setAutoOpenNewBanquet(false)}
            autoOpenNewDish={autoOpenNewDish}
            onAutoOpenNewDishHandled={() => setAutoOpenNewDish(false)}
            onActiveTabChange={setActiveMenuTab}
          />
        )}

        {view === ViewState.STAFF && (
          <StaffManagement showToast={addToast} autoOpenNew={autoOpenNewStaff} onAutoOpenNewHandled={() => setAutoOpenNewStaff(false)} />
        )}

        {view === ViewState.CLIENTI && (
          <CustomerList
            reservations={reservations}
            banquetMenus={banquetMenus}
            tables={tables}
            rooms={rooms}
            showToast={addToast}
            autoOpenNew={autoOpenNewCustomer}
            onAutoOpenNewHandled={() => setAutoOpenNewCustomer(false)}
            autoEditByPhone={autoEditCustomerByPhone}
            onAutoEditHandled={() => setAutoEditCustomerByPhone(null)}
          />
        )}

        {view === ViewState.INVENTARIO && (
          <Inventory showToast={addToast} autoOpenNewProduct={autoOpenNewProduct} onAutoOpenNewProductHandled={() => setAutoOpenNewProduct(false)} />
        )}

        {view === ViewState.LISTA_DELLA_SPESA && (
          <ShoppingListPage
            reservations={reservations}
            banquetMenus={banquetMenus}
            autoOpenNewShoppingItem={autoOpenNewShoppingItem}
            onAutoOpenNewShoppingItemHandled={() => setAutoOpenNewShoppingItem(false)}
          />
        )}

        {view === ViewState.HACCP && (
          <HaccpPage />
        )}

        {view === ViewState.CONVERSAZIONI && (
          <ConversazioniPage
            onFollowUpChanged={() => {
              voiceCallsApiService.pendingCount()
                .then(({ count }) => setVoiceCallsPendingCount(count))
                .catch(() => {});
            }}
            onCreateReservationFromCall={({ callId, customer_name, phone }) => {
              linkVoiceCallOnCreateRef.current = callId;
              setNewReservationPrefill({ customer_name, phone });
              setNewReservationKind('standard');
              setAutoOpenNewReservation(true);
            }}
            onOpenCustomerProfile={({ phone }) => {
              setAutoEditCustomerByPhone(phone);
              setView(ViewState.CLIENTI);
            }}
          />
        )}

        {view === ViewState.RECEPTION && (
          <ReceptionPage
            globalDate={globalDate}
            globalShiftFilter={globalShiftFilter}
            autoOpenWalkIn={autoOpenWalkIn}
            onAutoOpenWalkInHandled={() => setAutoOpenWalkIn(false)}
          />
        )}

        {view === ViewState.ATTIVITA && (
          <AttivitaPage
            banquetMenus={banquetMenus}
            dishes={dishes}
            autoOpenNew={autoOpenNewAttivita}
            onAutoOpenNewHandled={() => setAutoOpenNewAttivita(false)}
          />
        )}

        {view === ViewState.SETTINGS && (
          <div className="p-6 lg:p-10 max-w-4xl mx-auto">
            <div className="mb-2" />

            {/* Profile / Personal preferences */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Profilo</h3>
              <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
                <label htmlFor="preferred-landing" className="block text-[14px] font-medium text-[var(--color-fg)] mb-1">
                  Pagina di partenza
                </label>
                <p className="text-[13px] text-[var(--color-fg-muted)] mb-3">
                  La sezione che si apre dopo il login.
                </p>
                <select
                  id="preferred-landing"
                  value={user?.preferred_landing_view ?? ''}
                  onChange={async (e) => {
                    const v = e.target.value || null;
                    try {
                      await updatePreferences({ preferred_landing_view: v });
                      addToast(v ? 'Pagina di partenza aggiornata' : 'Pagina di partenza ripristinata', 'success');
                    } catch (err: any) {
                      addToast(err?.message || 'Errore aggiornamento preferenze', 'error');
                    }
                  }}
                  className="w-full sm:max-w-sm rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-[14px] text-[var(--color-fg)] focus:outline-none focus:ring-2 focus:ring-[var(--color-fg)]"
                >
                  <option value="">Predefinita (prima sezione disponibile)</option>
                  {getAccessibleViews().map(v => {
                    const labels: Record<ViewState, string> = {
                      [ViewState.DASHBOARD]: 'Dashboard',
                      [ViewState.RESERVATIONS]: 'Prenotazioni',
                      [ViewState.RECEPTION]: 'Reception',
                      [ViewState.FLOOR_PLAN]: 'Sale & Tavoli',
                      [ViewState.MENU]: 'Menu & Banchetti',
                      [ViewState.STAFF]: 'Personale',
                      [ViewState.CLIENTI]: 'Clienti',
                      [ViewState.INVENTARIO]: 'Inventario',
                      [ViewState.LISTA_DELLA_SPESA]: 'Lista della spesa',
                      [ViewState.HACCP]: 'HACCP',
                      [ViewState.CONVERSAZIONI]: 'Conversazioni',
                      [ViewState.ATTIVITA]: 'Attività',
                      [ViewState.USERS]: 'Utenti',
                      [ViewState.SETTINGS]: 'Impostazioni',
                    };
                    return (
                      <option key={v} value={v}>{labels[v]}</option>
                    );
                  })}
                </select>
              </div>
            </div>

            {/* Opening hours & closures — collapsible to keep the page compact */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Orari di apertura</h3>
              <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                      <Clock className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Orari settimanali e chiusure</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Gestisci servizi (pranzo/cena), giorni di chiusura e date speciali.</p>
                    </div>
                  </div>
                  <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
                  <OpeningHoursManager showToast={addToast} />
                </div>
              </details>
            </div>

            {/* Chiusure programmate — per-shift closures of rooms and tables (future occurrences aggregated) */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Chiusure programmate</h3>
              <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                      <DoorClosed className="w-5 h-5" />
                    </div>
                    <div className="min-w-0">
                      <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Sale chiuse e tavoli nascosti</h4>
                      <p className="text-[13px] text-[var(--color-fg-muted)]">Programma o rimuovi chiusure per turno di sale e tavoli.</p>
                    </div>
                  </div>
                  <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                </summary>
                <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
                  <ScheduledClosuresManager showToast={addToast} />
                </div>
              </details>
            </div>

            {/* Canali di prenotazione — toggles for the public form and the voice agent */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Canali di prenotazione</h3>
              <div className="bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] p-4">
                <FeatureTogglesManager showToast={addToast} />
              </div>
            </div>

            {/* Opzioni prenotazioni — customizable chip lists (note rapide + intolleranze) surfaced in the reservation modal */}
            <div className="mb-8">
              <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Opzioni prenotazioni</h3>
              <div className="space-y-3">
                <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                  <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-[var(--color-fg)] flex-shrink-0">
                        <StickyNote className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Note rapide prenotazione</h4>
                        <p className="text-[13px] text-[var(--color-fg-muted)]">Chip suggeriti nel modal di prenotazione. Ogni nota può avere un'icona che appare nella card. Trascina per riordinare.</p>
                      </div>
                    </div>
                    <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
                    <ReservationNotesManager showToast={addToast} />
                  </div>
                </details>

                <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                  <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-amber-600 dark:text-amber-400 flex-shrink-0">
                        <AlertTriangle className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Intolleranze</h4>
                        <p className="text-[13px] text-[var(--color-fg-muted)]">Chip suggeriti nella sezione Intolleranze del modal prenotazione. Trascina per riordinare.</p>
                      </div>
                    </div>
                    <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
                    <ReservationAllergensManager showToast={addToast} />
                  </div>
                </details>

                <details className="group bg-[var(--color-surface)] rounded-lg border border-[var(--color-line)] overflow-hidden">
                  <summary className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden hover:bg-[var(--color-surface-2)] transition-colors">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-md bg-[var(--color-surface-3)] flex items-center justify-center text-emerald-600 dark:text-emerald-400 flex-shrink-0">
                        <CreditCard className="w-5 h-5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="font-medium text-[14px] text-[var(--color-fg)]">Caparra automatica</h4>
                        <p className="text-[13px] text-[var(--color-fg-muted)]">Per le prenotazioni web sopra una certa soglia di coperti invia un link Revolut per la caparra (€10/persona) via SMS.</p>
                      </div>
                    </div>
                    <ChevronDown className="w-5 h-5 text-[var(--color-fg-muted)] flex-shrink-0 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="px-4 pb-4 pt-1 border-t border-[var(--color-line)]">
                    <AutoDepositManager showToast={addToast} />
                  </div>
                </details>
              </div>
            </div>

            {/* Admin Section */}
            {canManageUsers() && (
              <div className="mb-8">
                <h3 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-3">Amministrazione</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <button
                    onClick={() => setView(ViewState.USERS)}
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
                <h3 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-3">Monitoraggio</h3>
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

            <PushNotificationsCard />

            {/* Integrations */}
            <div className="mb-8">
              <h3 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)] mb-3">Integrazioni</h3>
              <div className="space-y-3">
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
                    <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></div>
                      Attivo (Simulato)
                    </div>
                  </div>
                </div>
                <RevolutIntegrationCard showToast={addToast} />
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
            {/* Center "+" — circular, raised above the nav — opens context-aware action sheet */}
            <div className="flex-1 flex justify-center items-end">
              <button
                type="button"
                onClick={() => setShowCreateSheet(v => !v)}
                aria-label="Crea nuovo"
                className="h-14 w-14 -translate-y-3 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] shadow-[var(--shadow-overlay)] flex items-center justify-center hover:opacity-90 active:scale-95 transition-all ring-4 ring-[var(--color-surface)]"
              >
                <Plus className="h-6 w-6 transition-transform duration-200" style={{ transform: showCreateSheet ? 'rotate(45deg)' : 'rotate(0deg)' }} />
              </button>
            </div>
            {canAccessView(ViewState.CONVERSAZIONI) && (
              <BottomNavItem
                icon={<Phone size={20} />}
                label="Conversazioni"
                active={view === ViewState.CONVERSAZIONI}
                badge={voiceCallsPendingCount}
                onClick={() => setView(ViewState.CONVERSAZIONI)}
              />
            )}
            {altroNavItems.length > 0 && (
              <BottomNavItem
                icon={<MoreHorizontal size={20} />}
                label="Altro"
                active={showMoreMenu || altroNavItems.some(item => view === item.view)}
                onClick={() => setShowMoreMenu(true)}
              />
            )}
          </div>
        </nav>

        {/* "Create" action sheet — slides up from behind the bottom nav */}
        {showCreateSheet && (
          <>
            <div
              className="fixed inset-0 z-[29] lg:hidden bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)]"
              style={{ animation: 'fadeIn 280ms ease-out both' }}
              onClick={() => setShowCreateSheet(false)}
            />
            <div
              className="fixed left-0 right-0 z-[29] lg:hidden bg-[var(--color-surface)] rounded-t-[20px] border-t border-[var(--color-line)] shadow-[var(--shadow-overlay)]"
              style={{ bottom: 0, animation: 'slideUpBehindNav 280ms ease-out both' }}
            >
              <div className="px-6 pt-5 pb-20 grid grid-cols-2 gap-4 justify-items-center" style={{ paddingBottom: 'calc(5rem + env(safe-area-inset-bottom, 0px))' }}>
                {[
                  { key: 'reservation', icon: <Calendar className="h-7 w-7" />, label: 'Prenotazione', action: () => { setNewReservationKind('standard'); setAutoOpenNewReservation(true); setShowCreateSheet(false); } },
                  { key: 'walkin', icon: <UserCheck className="h-7 w-7" />, label: 'Walk-in', action: () => { setNewReservationKind('walkin'); setAutoOpenNewReservation(true); setShowCreateSheet(false); } },
                  { key: 'shopping', icon: <ShoppingCart className="h-7 w-7" />, label: 'Spesa', action: () => { setView(ViewState.LISTA_DELLA_SPESA); setAutoOpenNewShoppingItem(true); setShowCreateSheet(false); } },
                  { key: 'customer', icon: <BookUser className="h-7 w-7" />, label: 'Cliente', action: () => { setView(ViewState.CLIENTI); setAutoOpenNewCustomer(true); setShowCreateSheet(false); } },
                ].map((tile, i) => (
                  <button
                    key={tile.key}
                    type="button"
                    onClick={tile.action}
                    className="flex flex-col items-center gap-2 focus:outline-none active:scale-95 transition-transform"
                    style={{ animation: `tileIn 150ms ease-out ${i * 40}ms both` }}
                  >
                    <div className="w-20 h-20 rounded-2xl bg-[var(--color-surface-2)] flex items-center justify-center text-[var(--color-fg)]">
                      {tile.icon}
                    </div>
                    <span className="text-[12px] font-semibold text-[var(--color-fg)]">{tile.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}

        {/* "Altro" bottom sheet — mobile */}
        {showMoreMenu && (
          <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Altro">
            <div
              className="absolute inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)]"
              onClick={() => setShowMoreMenu(false)}
            />
            <div className="absolute bottom-0 left-0 right-0 max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] flex flex-col bg-[var(--color-surface)] rounded-t-2xl border-t border-[var(--color-line)] shadow-[var(--shadow-overlay)] animate-in slide-in-from-bottom duration-200">
              <div className="flex-shrink-0 bg-[var(--color-surface)] rounded-t-2xl">
                <div className="flex justify-center pt-2.5 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[var(--color-line-strong)]" />
                </div>
                <div className="px-4 pb-2 pt-1 flex items-center justify-between">
                  <h3 className="text-[15px] font-semibold text-[var(--color-fg)]">Altro</h3>
                  <button onClick={() => setShowMoreMenu(false)} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]" aria-label="Chiudi">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              {/* User identity card */}
              <div className="mx-4 mb-2 px-3 py-3 rounded-lg bg-[var(--color-surface-2)] border border-[var(--color-line)] flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] flex items-center justify-center text-[12px] font-medium shrink-0">
                  {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--color-fg)] truncate">{user?.full_name || 'Utente'}</p>
                  <p className="text-[11px] text-[var(--color-fg-muted)] truncate">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
                </div>
              </div>
              <div className="px-2 pb-2">
                {NAV_GROUPS.filter(group => group.id !== 'sistema').map(group => {
                  const items = NAV_ITEMS.filter(item => item.group === group.id && !item.isTab && item.kind === 'link' && canSeeNavItem(item));
                  if (items.length === 0) return null;
                  return (
                    <React.Fragment key={group.id}>
                      <div className="px-3 pt-3 pb-1 text-[11px] tracking-[0.04em] font-semibold text-[var(--color-fg-subtle)]">
                        {group.label}
                      </div>
                      {items.map(item => {
                        const badge = item.view === ViewState.CONVERSAZIONI ? voiceCallsPendingCount : 0;
                        return (
                        <button
                          key={item.label}
                          onClick={() => { setShowMoreMenu(false); if (item.view !== undefined) setView(item.view); }}
                          className={`w-full flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${item.view !== undefined && view === item.view ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
                        >
                          <item.Icon className="h-5 w-5 text-[var(--color-fg-muted)]" />
                          <span className="text-sm font-medium text-[var(--color-fg)]">{item.label}</span>
                          {badge > 0 && (
                            <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-rose-500 text-white text-[11px] font-semibold flex items-center justify-center">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                          <ChevronRight className={`${badge > 0 ? '' : 'ml-auto'} h-4 w-4 text-[var(--color-fg-subtle)]`} />
                        </button>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
              <div className="px-2 pb-6 pt-1 border-t border-[var(--color-line)]">
                {NAV_ITEMS.filter(item => item.group === 'sistema' && item.kind === 'link' && canSeeNavItem(item)).map(item => (
                  <button
                    key={item.label}
                    onClick={() => { setShowMoreMenu(false); if (item.view !== undefined) setView(item.view); }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-md transition-colors ${item.view !== undefined && view === item.view ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'}`}
                  >
                    <item.Icon className="h-5 w-5 text-[var(--color-fg-muted)]" />
                    <span className="text-sm font-medium text-[var(--color-fg)]">{item.label}</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-[var(--color-fg-subtle)]" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={toggleTheme}
                  aria-pressed={theme === 'dark'}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-md hover:bg-[var(--color-surface-hover)] transition-colors"
                >
                  {theme === 'dark' ? <Sun className="h-5 w-5 text-[var(--color-fg-muted)]" /> : <Moon className="h-5 w-5 text-[var(--color-fg-muted)]" />}
                  <span className="text-sm font-medium text-[var(--color-fg)]">Modalità scura</span>
                  <span
                    aria-hidden
                    className={`ml-auto relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${theme === 'dark' ? 'bg-[var(--color-fg)]' : 'bg-[var(--color-line-strong)]'}`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--color-surface)] shadow transition-transform ${theme === 'dark' ? 'translate-x-4' : 'translate-x-0.5'}`}
                    />
                  </span>
                </button>
                <button
                  onClick={() => { setShowMoreMenu(false); logout(); }}
                  className="w-full flex items-center gap-3 px-3 py-3 rounded-md text-rose-600 hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/15 transition-colors"
                >
                  <LogOut className="h-5 w-5" />
                  <span className="text-sm font-medium">Esci</span>
                </button>
              </div>
              </div>
            </div>
          </div>
        )}

        {/* ElevenLabs voice-agent widget — temporarily hidden, will be
            re-enabled in the future. Component and import preserved. */}
        {false && user?.role === UserRole.OWNER && <VoiceAgentWidget />}

        {/* Global Toasts */}
        <div
          className="fixed bottom-20 lg:bottom-4 left-4 right-auto lg:left-auto lg:right-4 z-50 flex flex-col gap-2 max-w-[calc(100vw-6rem)] sm:max-w-md"
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
                                    {toast.action && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                toast.action!.onClick();
                                                setToasts(prev => prev.filter(t => t.id !== toast.id));
                                            }}
                                            className={`mt-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-[var(--color-surface-3)] ${accent.iconText} hover:opacity-80`}
                                        >
                                            {toast.action.label}
                                        </button>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <>
                                {toast.type === 'success' && <CheckCircle className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                {toast.type === 'error' && <AlertTriangle className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                {toast.type === 'info' && <Info className={`h-4 w-4 ${accent.iconText} shrink-0`} />}
                                <span className="text-[13px] font-medium text-[var(--color-fg)] flex-1">{toast.message}</span>
                                {toast.action && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            toast.action!.onClick();
                                            setToasts(prev => prev.filter(t => t.id !== toast.id));
                                        }}
                                        className={`px-3 py-1 text-xs font-semibold rounded-md bg-[var(--color-surface-3)] ${accent.iconText} hover:opacity-80 flex-shrink-0`}
                                    >
                                        {toast.action.label}
                                    </button>
                                )}
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
const SidebarItem = ({ icon, label, active, onClick, collapsed = false, badge }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void, collapsed?: boolean, badge?: number }) => (
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
    <span className={`relative ${active ? 'text-[var(--color-sidebar-active-fg)]' : 'text-[var(--color-sidebar-fg)] group-hover:text-[var(--color-sidebar-fg-strong)]'}`}>
      {icon}
      {collapsed && badge != null && badge > 0 && (
        <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 inline-flex items-center justify-center rounded-full bg-rose-500 text-white text-[10px] font-semibold leading-none ring-2 ring-[var(--color-sidebar-bg)]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
    {!collapsed && (
      <>
        <span className="font-medium text-[13px] tracking-tight">{label}</span>
        {badge != null && badge > 0 && (
          <span className="ml-auto min-w-[18px] h-[18px] px-1.5 inline-flex items-center justify-center rounded-full bg-rose-500 text-white text-[10px] font-semibold leading-none">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </>
    )}
  </button>
);

// Helper Component for Bottom Navigation (mobile)
const BottomNavItem = ({ icon, label, active, onClick, badge }: { icon: React.ReactNode, label: string, active: boolean, onClick: () => void, badge?: number }) => (
  <button
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`flex flex-1 flex-col items-center justify-center gap-0.5 px-1 py-2 rounded-lg transition-colors duration-150 ${
      active
        ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)]'
        : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
    }`}
  >
    <span className="relative">
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-semibold flex items-center justify-center">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
    <span className="text-[10px] font-medium whitespace-nowrap">
      {label}
    </span>
  </button>
);

export default App;