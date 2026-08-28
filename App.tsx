import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { LayoutDashboard, Grid, Settings, ChevronRight, ChevronDown, ChefHat, PanelLeft, Calendar, CalendarDays, Bell, X, CheckCircle, AlertTriangle, Info, LogOut, Users, UserCheck, FileText, UsersRound, Sun, Moon, Sunset, MoreHorizontal, Search, UtensilsCrossed, Plus, BookUser, Boxes, Clock, ShoppingCart, ListChecks, ShieldCheck, Phone, ConciergeBell, Zap, PartyPopper, DoorClosed, StickyNote, CreditCard, MessageCircle, Mail, Kanban, ClipboardList, CookingPot, BellRing, MessagesSquare, Gauge, Building2, Milestone, Ban, Sparkles, Landmark, Percent } from 'lucide-react';
import { ViewState, Room, Table, Dish, Reservation, TableStatus, TableShape, BanquetMenu, PaymentStatus, Notification, Shift, Toast, UserRole, ReservationSource, ReservationStatus } from './types';
import { Dashboard } from './components/Dashboard';
import { FloorPlan } from './components/FloorPlan';
import { MenuManager } from './components/MenuManager';
import { ReservationList, type NewReservationPrefill } from './components/ReservationList';
import { LoginPage } from './components/LoginPage';
import { ProfiloSheet } from './components/ProfiloSheet';
import { OnboardingWizard } from './components/OnboardingWizard';
import { BookingChannelsManager } from './components/BookingChannelsManager';
import { PlatformPanel, ImpersonationBanner } from './components/PlatformPanel';
import { Loader } from './components/Loader';
import { UserManagement } from './components/UserManagement';
import { RolePermissions } from './components/RolePermissions';
import { ActivityLogs } from './components/ActivityLogs';
import { StaffManagement } from './components/StaffManagement';
import { CustomerList } from './components/CustomerList';
import { Inventory } from './components/Inventory';
import { OrderPad } from './components/OrderPad';
import { KitchenDisplay } from './components/KitchenDisplay';
import { ExpediterDisplay } from './components/ExpediterDisplay';
import { ShoppingListPage } from './components/ShoppingListPage';
import { HaccpPage } from './components/HaccpPage';
import ConversazioniPage from './components/ConversazioniPage';
import InboxPage from './components/InboxPage';
import StaffChatPage from './components/StaffChatPage';
import { SegmentedControl, StatusPill, useMediaQuery, dsSelect } from './components/ds';
import { NotificationsPanel } from './components/NotificationsPanel';
import EmailPage from './components/EmailPage';
import NotifichePage from './components/NotifichePage';
import PagamentiPage from './components/PagamentiPage';
import { DevelopmentPage } from './components/DevelopmentPage';
import { RoadmapPage } from './components/RoadmapPage';
import { MonitoringPage } from './components/MonitoringPage';
import ReceptionPage from './components/ReceptionPage';
import { AttivitaPage } from './components/AttivitaPage';
import { PushNotificationsCard } from './components/PushNotificationsCard';
import { OpeningHoursManager } from './components/OpeningHoursManager';
import { FeatureTogglesManager } from './components/FeatureTogglesManager';
import { ScheduledClosuresManager } from './components/ScheduledClosuresManager';
import { RemindersManager } from './components/RemindersManager';
import { ReservationNotesManager } from './components/ReservationNotesManager';
import { ReservationAllergensManager } from './components/ReservationAllergensManager';
import { AutoDepositManager } from './components/AutoDepositManager';
import { PaymentLinkExpiryManager } from './components/PaymentLinkExpiryManager';
import { BlacklistPolicyManager } from './components/BlacklistPolicyManager';
import { PayAtTableSettingsManager } from './components/PayAtTableSettingsManager';
import { FiscalSettingsManager } from './components/FiscalSettingsManager';
import { SalaCucinaSettingsManager } from './components/SalaCucinaSettingsManager';
import { AiMessagesSettingsManager } from './components/AiMessagesSettingsManager';
import { MediaLibraryManager } from './components/MediaLibraryManager';
import { RevolutIntegrationCard } from './components/RevolutIntegrationCard';
import { SumUpIntegrationCard } from './components/SumUpIntegrationCard';
import { SmtpIntegrationCard } from './components/SmtpIntegrationCard';
import { ImapIntegrationCard } from './components/ImapIntegrationCard';
import { CardErrorBoundary } from './components/CardErrorBoundary';
import { LegalSettingsCard } from './components/LegalSettingsCard';
import { TableAssignmentAiPromptCard } from './components/TableAssignmentAiPromptCard';
import { VoiceAgentWidget } from './components/VoiceAgentWidget';
import { PLATFORM_NAME } from './platform';
import { DateNavigator } from './components/DateNavigator';
import { CommandPalette } from './components/CommandPalette';
import { AppVersionBanner } from './components/AppVersionBanner';
import { BookingChannelsBar } from './components/BookingChannelsBar';
import { useSocket } from './hooks/useSocket';
import { useTokenExpiryWarning } from './hooks/useTokenExpiryWarning';
import { useAppBadge } from './hooks/useAppBadge';
import { useScrollFade } from './hooks/useScrollFade';
import { offlineQueue } from './services/offlineQueue';
import { socketClient } from './services/socketClient';
import { voiceCallsApiService, voiceCallsCache } from './services/voiceCallsApiService';
import { messagesApiService, inboxCache } from './services/messagesApiService';
import { staffChatApiService } from './services/staffChatApiService';
import { paymentsApiService } from './services/paymentsApiService';
import { emailApiService, emailCache } from './services/emailApiService';
import { notificationsApiService } from './services/notificationsApiService';
import { useAuth } from './contexts/AuthContext';
import { sortRooms } from './utils/roomOrder';
import { toTitleCase } from './utils/text';
import { getRomeDatePart, getRomeTimePart } from './utils/reservationTime';

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
  getFeatureFlags,
} from './services/apiService';

// ---------------------------------------------------------------------------
// Navigation taxonomy — single source of truth for the desktop sidebar AND the
// mobile "Altro" sheet. Both surfaces map over NAV_ITEMS; only their filters and
// presentation differ. Item labels, icons and routes must not be edited here
// without an intentional change — this drives every nav surface.
// ---------------------------------------------------------------------------
type NavGroupId = 'servizio' | 'comunicazioni' | 'operazioni' | 'gestione' | 'sistema';

// Eyebrow headings, in render order. Proper case by design — never all caps.
const NAV_GROUPS: { id: NavGroupId; label: string }[] = [
  { id: 'servizio', label: 'Servizio' },
  { id: 'comunicazioni', label: 'Comunicazioni' },
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
  { kind: 'link', label: 'Sale & Tavoli', Icon: Grid, group: 'servizio', isTab: false, view: ViewState.FLOOR_PLAN, sidebarCollapse: true },
  { kind: 'link', label: 'Menu & Banchetti', Icon: UtensilsCrossed, group: 'servizio', isTab: false, view: ViewState.MENU, sidebarCollapse: false, menuInitialTab: 'BANQUETS' },
  { kind: 'link', label: 'Comande', Icon: ClipboardList, group: 'servizio', isTab: false, view: ViewState.COMANDE, sidebarCollapse: true },
  { kind: 'link', label: 'Cucina', Icon: CookingPot, group: 'servizio', isTab: false, view: ViewState.CUCINA, sidebarCollapse: true },
  { kind: 'link', label: 'Passe', Icon: BellRing, group: 'servizio', isTab: false, view: ViewState.PASSE, sidebarCollapse: true },

  // Comunicazioni — all four are isTab, so the whole group drops out of the
  // mobile "Altro" sheet. The three channels live behind the Comunicazioni
  // bottom tab; Notifiche is the top-bar bell on every breakpoint. The sidebar
  // ignores isTab, so desktop still lists them individually.
  { kind: 'link', label: 'Chiamate', Icon: Phone, group: 'comunicazioni', isTab: true, view: ViewState.CONVERSAZIONI, sidebarCollapse: false },
  { kind: 'link', label: 'Messaggi', Icon: MessageCircle, group: 'comunicazioni', isTab: true, view: ViewState.MESSAGGI, sidebarCollapse: false },
  { kind: 'link', label: 'Chat staff', Icon: MessagesSquare, group: 'comunicazioni', isTab: true, view: ViewState.CHAT_STAFF, sidebarCollapse: false },
  { kind: 'link', label: 'Email', Icon: Mail, group: 'comunicazioni', isTab: true, view: ViewState.EMAIL, sidebarCollapse: false },
  { kind: 'link', label: 'Notifiche', Icon: Bell, group: 'comunicazioni', isTab: true, view: ViewState.NOTIFICHE, sidebarCollapse: false },

  // Operazioni
  { kind: 'link', label: 'Attività', Icon: ListChecks, group: 'operazioni', isTab: false, view: ViewState.ATTIVITA, sidebarCollapse: false },
  { kind: 'link', label: 'Inventario', Icon: Boxes, group: 'operazioni', isTab: false, view: ViewState.INVENTARIO },
  { kind: 'link', label: 'Lista della Spesa', Icon: ShoppingCart, group: 'operazioni', isTab: false, view: ViewState.LISTA_DELLA_SPESA, sidebarCollapse: false },
  { kind: 'link', label: 'HACCP', Icon: ShieldCheck, group: 'operazioni', isTab: false, view: ViewState.HACCP, sidebarCollapse: false },
  { kind: 'link', label: 'Pagamenti', Icon: CreditCard, group: 'operazioni', isTab: false, view: ViewState.PAGAMENTI, sidebarCollapse: false },

  // Gestione
  { kind: 'link', label: 'Clienti', Icon: BookUser, group: 'gestione', isTab: false, view: ViewState.CLIENTI, sidebarCollapse: false },
  { kind: 'link', label: 'Personale', Icon: UsersRound, group: 'gestione', isTab: false, view: ViewState.STAFF, sidebarCollapse: false },
  { kind: 'link', label: 'Utenti', Icon: Users, group: 'gestione', isTab: false, view: ViewState.USERS, sidebarCollapse: false, requiresUserManagement: true },

  // Sistema
  // Visibile solo al ruolo PLATFORM_ADMIN (gate per ruolo in canAccessView)
  { kind: 'link', label: 'Piattaforma', Icon: Building2, group: 'sistema', isTab: false, view: ViewState.PLATFORM, sidebarCollapse: false },
  { kind: 'link', label: 'Impostazioni', Icon: Settings, group: 'sistema', isTab: false, view: ViewState.SETTINGS, sidebarCollapse: false },
  // Visibili solo all'account admin (gate email-based in canAccessView)
  { kind: 'link', label: 'Consumi AI', Icon: Gauge, group: 'sistema', isTab: false, view: ViewState.MONITORING, sidebarCollapse: false },
  { kind: 'link', label: 'Development', Icon: Kanban, group: 'sistema', isTab: false, view: ViewState.DEVELOPMENT, sidebarCollapse: false },
  { kind: 'link', label: 'Roadmap', Icon: Milestone, group: 'sistema', isTab: false, view: ViewState.ROADMAP, sidebarCollapse: false },
  { kind: 'theme', label: 'Modalità scura', Icon: Moon, group: 'sistema', isTab: false },
];

// The Comunicazioni channels, in the order the mobile switcher shows them.
// Presentation only — each one is still its own ViewState, so deep links from
// the command palette, notifications and the sidebar are untouched.
const COMMS_VIEWS: ViewState[] = [ViewState.CONVERSAZIONI, ViewState.MESSAGGI, ViewState.CHAT_STAFF, ViewState.EMAIL];

// Stato aperto/chiuso della sidebar desktop. Scritto solo dalla linguetta.
const SIDEBAR_COLLAPSED_KEY = 'ristocrm_sidebar_collapsed';

// Viste del modulo Sala & Cucina: oltre al permesso serve il modulo attivo
// (flag table_orders_enabled) — spento, le voci spariscono dalla sidebar.
const SALA_VIEWS: ViewState[] = [ViewState.COMANDE, ViewState.CUCINA, ViewState.PASSE];

/* ── Blocchi della pagina Impostazioni ────────────────────────────────────
   Impostazioni è tornata una voce piatta della sidebar e una pagina unica:
   il sottomenu costringeva a sapere in anticipo in quale delle dodici voci
   stava una regolazione. Ora la pagina impila pochi blocchi tematici — le
   card sono raggruppate per natura — e questa lista alimenta solo la riga
   di chip-àncora in testa, che salta al blocco senza stato né routing.
   `guard` nasconde il blocco a chi non ha i permessi delle sue card. */
const SETTINGS_GROUPS: {
  id: string;
  label: string;
  Icon: React.ComponentType<{ size?: number; className?: string }>;
  guard?: 'admin' | 'pay_at_table';
}[] = [
  { id: 'imp-profilo', label: 'Profilo', Icon: UserCheck },
  { id: 'imp-ristorante', label: 'Ristorante', Icon: Clock },
  { id: 'imp-prenotazioni', label: 'Prenotazioni', Icon: Calendar },
  { id: 'imp-pagamenti', label: 'Pagamenti', Icon: CreditCard },
  { id: 'imp-fiscalita', label: 'Fiscalità', Icon: Landmark, guard: 'pay_at_table' },
  { id: 'imp-comunicazioni', label: 'Comunicazioni', Icon: MessagesSquare },
  { id: 'imp-ai', label: 'AI', Icon: Sparkles },
  { id: 'imp-amministrazione', label: 'Amministrazione', Icon: Users, guard: 'admin' },
];

/* ── Impostazioni ─────────────────────────────────────────────────────────
   Tre forme, ripetute quindici volte in quella pagina: un'etichetta di
   sezione, una card che si apre, una card che porta altrove. Erano scritte a
   mano ogni volta, con la stessa manciata di classi legacy ricopiate — e ogni
   copia era un posto in cui la pagina poteva divergere da sola.

   Le etichette restano in tondo: erano in maiuscolo con 0.08em di spaziatura,
   che a 11px cancella la forma della parola senza renderla più leggibile
   (§5.2). Peso e colore portano la gerarchia. */
const SettingsSection: React.FC<{ id?: string; label: string; children: React.ReactNode }> = ({ id, label, children }) => (
  // scroll-mt: quando i chip-àncora saltano qui, l'intestazione non finisce
  // incollata al bordo superiore della zona che scorre.
  <section id={id} className="mb-6 scroll-mt-4">
    <h3 className="mb-2 px-1 text-[13px] font-semibold text-[var(--ds-text-muted)]">{label}</h3>
    {children}
  </section>
);

/** L'icona quadrata a sinistra di ogni riga di impostazioni. */
const SettingsIcon: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  tone?: 'neutral' | 'pending' | 'positive';
}> = ({ icon: Icon, tone = 'neutral' }) => (
  <span
    className={`inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] ${
      tone === 'pending' ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
      : tone === 'positive' ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
    }`}
  >
    <Icon className="h-5 w-5" />
  </span>
);

/** Una card che si apre in posto. Resta un <details>: l'apertura non è stato
 *  applicativo e non deve passare per React. */
const SettingsDisclosure: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  iconTone?: 'neutral' | 'pending' | 'positive';
  title: string;
  description: string;
  children: React.ReactNode;
}> = ({ icon, iconTone, title, description, children }) => (
  <details className="group overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
    {/* min-h 44px e nessun marcatore nativo: la riga intera è il bersaglio. */}
    <summary className="flex min-h-[64px] cursor-pointer select-none list-none items-center justify-between gap-3 p-3 transition-colors hover:bg-[var(--ds-surface-row)] [&::-webkit-details-marker]:hidden">
      <span className="flex min-w-0 items-center gap-3">
        <SettingsIcon icon={icon} tone={iconTone} />
        <span className="min-w-0">
          <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">{title}</span>
          <span className="block text-[13px] leading-snug text-[var(--ds-text-muted)]">{description}</span>
        </span>
      </span>
      <span
        className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-transform group-open:rotate-180"
        aria-hidden
      >
        <ChevronDown className="h-4 w-4" />
      </span>
    </summary>
    <div className="border-t border-[var(--ds-border)] px-3 pb-4 pt-3 sm:px-4">{children}</div>
  </details>
);

/** Una card che porta da un'altra parte: stessa anatomia, chevron a destra. */
const SettingsNavCard: React.FC<{
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}> = ({ icon, title, description, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="flex min-h-[64px] items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
  >
    <SettingsIcon icon={icon} />
    <span className="min-w-0 flex-1">
      <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">{title}</span>
      <span className="block text-[13px] leading-snug text-[var(--ds-text-muted)]">{description}</span>
    </span>
    <ChevronRight className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
  </button>
);

const App: React.FC = () => {
  const { user, isAuthenticated, isLoading: authLoading, logout, canAccessView, canManageUsers, hasPermission, hasFeature, getAccessibleViews, canViewLogs, updatePreferences } = useAuth();

  const [view, setView] = useState<ViewState>(ViewState.DASHBOARD);
  // Una schermata che si prende tutto lo schermo sul telefono: la barra di
  // navigazione in basso sparisce, e con lei il suo spazio di rispetto. Per ora
  // la chiede solo la comanda aperta su un tavolo.
  const [immersive, setImmersive] = useState(false);
  // Which Comunicazioni channel the mobile tab reopens on. Declared up here
  // with its effect: everything below the auth guards runs conditionally, so a
  // hook placed there changes the hook count once the user logs in.
  const [lastCommsView, setLastCommsView] = useState<ViewState>(ViewState.CONVERSAZIONI);
  useEffect(() => {
    if (COMMS_VIEWS.includes(view)) setLastCommsView(view);
  }, [view]);
  // Tracks whether we've already applied the user's preferred landing for this
  // session. Reset on logout so the next login re-applies it.
  const appliedPreferredLandingRef = useRef(false);
  // Sidebar aperta/chiusa. Le viste continuano a comandarla: le task-oriented
  // (Prenotazioni, Reception, Sale & Tavoli, Comande, Cucina, Passe) la
  // chiudono per guadagnare larghezza, le altre la riaprono — vedi
  // NAV_ITEMS.sidebarCollapse. La linguetta è l'override manuale nel mezzo, e
  // quello che sceglie viene persistito: al riavvio si riparte da lì, finché
  // la prima navigazione non applica di nuovo il default della vista.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
  });
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? '1' : '0');
      return next;
    });
  };
  // Modulo Sala & Cucina: governa la visibilità di Comande/Cucina/Passe in
  // sidebar. Si aggiorna in tempo reale via socket quando qualcuno tocca
  // l'interruttore in Impostazioni.
  const [tableOrdersEnabled, setTableOrdersEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isAuthenticated) { setTableOrdersEnabled(null); return; }
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setTableOrdersEnabled(f.table_orders_enabled === true); })
      .catch(() => { /* flag non leggibile: le voci restano nascoste */ });

    const onFlags = (flags: any) => {
      if (flags && typeof flags.table_orders_enabled === 'boolean') {
        setTableOrdersEnabled(flags.table_orders_enabled);
      }
    };
    let attachedSocket: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attachedSocket === s) return;
      if (attachedSocket) attachedSocket.off('features:updated', onFlags);
      attachedSocket = s;
      if (attachedSocket) attachedSocket.on('features:updated', onFlags);
    };
    attach(socketClient.getSocket());
    const unsubSocket = socketClient.onSocketChange((s) => attach(s));
    return () => {
      cancelled = true;
      unsubSocket();
      if (attachedSocket) attachedSocket.off('features:updated', onFlags);
    };
  }, [isAuthenticated]);

  // Se il modulo viene spento mentre sei su una sua vista, si torna alla
  // Dashboard: restare su una pagina che la sidebar non offre più disorienta.
  useEffect(() => {
    // Solo a flag noto: al boot è null e un deep-link su Cucina/Passe non
    // deve rimbalzare in Dashboard prima che la risposta arrivi.
    if (tableOrdersEnabled === false && SALA_VIEWS.includes(view)) setView(ViewState.DASHBOARD);
  }, [tableOrdersEnabled, view]);
  const [menuInitialTab, setMenuInitialTab] = useState<'DISHES' | 'BANQUETS'>('BANQUETS');
  const [autoOpenNewReservation, setAutoOpenNewReservation] = useState(false);
  const [newReservationKind, setNewReservationKind] = useState<'standard' | 'walkin'>('standard');
  // Prefill applied when opening the new-reservation modal (currently used
  // when converting a voice call into a booking).
  const [newReservationPrefill, setNewReservationPrefill] = useState<NewReservationPrefill | undefined>(undefined);
  // If set, the next reservation that gets created is linked to this voice
  // call. Cleared once the link finishes (or the modal is dismissed).
  const linkVoiceCallOnCreateRef = useRef<number | null>(null);
  // Phone_digits of the inbox conversation a new reservation should link back
  // to (set when creating from the chat). Cleared once the link finishes.
  const linkInboxConversationOnCreateRef = useRef<string | null>(null);
  // Bumped after an inbox conversation gets linked so InboxPage refetches and
  // shows the "Apri prenotazione" affordance without a manual reload.
  const [inboxRefreshTick, setInboxRefreshTick] = useState(0);
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
  // Scroll-aware edge fade on the sidebar nav (fades an edge only when there's
  // more to scroll that way).
  const navFadeRef = useScrollFade<HTMLElement>();

  // Global Cmd/Ctrl+K → open the command palette. Fires even while typing
  // in a form field so the operator can switch to global search mid-flow;
  // preventDefault stops the browser from grabbing it (Firefox → address bar).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isPaletteHotkey = (e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K');
      if (!isPaletteHotkey) return;
      // Sulla vista Piattaforma la ricerca globale pescherebbe nei dati del
      // tenant dell'admin: meglio nessuna palette che quella del ristorante
      // sbagliato.
      if (view === ViewState.PLATFORM) return;
      e.preventDefault();
      setPaletteOpen(true);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [view]);

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

  // Global command palette (Cmd/Ctrl+K). Lets the operator find a
  // reservation without knowing its date — the daily list stays intact.
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Count of voice calls in the last 7 days without a linked reservation —
  // drives the follow-up badge on the Conversazioni sidebar icon.
  const [voiceCallsPendingCount, setVoiceCallsPendingCount] = useState(0);
  // Bumped when a background mutation touches voice_calls rows (e.g. the
  // quick-create flow links a call to the new reservation) so ConversazioniPage
  // refetches list + open detail without a manual page reload.
  const [voiceCallsRefreshTick, setVoiceCallsRefreshTick] = useState(0);
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

  // Unread count for the "Messaggi" nav badge. Fetched on mount and refreshed
  // on every inbound socket event so the sidebar reflects new chats live. When
  // the user leaves the inbox we also refresh, in case they read some threads.
  const [messagesUnreadCount, setMessagesUnreadCount] = useState(0);
  const canSeeMessages = canAccessView(ViewState.MESSAGGI);
  // Pre-scalda la cache dell'inbox al login: il primo ingresso in Messaggi
  // trova la lista già pronta invece dello spinner (mezzo secondo di rete
  // verso Railway). Al logout la cache si svuota: non deve sopravvivere a un
  // cambio utente sullo stesso browser.
  useEffect(() => {
    if (!isAuthenticated) { inboxCache.clear(); return; }
    if (!canSeeMessages) return;
    messagesApiService.prefetchConversations();
  }, [isAuthenticated, canSeeMessages]);

  // Stesso pre-riscaldamento per Chiamate: la lista di partenza è pronta al
  // primo ingresso e la cache muore col logout.
  useEffect(() => {
    if (!isAuthenticated) { voiceCallsCache.clear(); return; }
    if (!canSeeVoiceCalls) return;
    voiceCallsApiService.prefetchList();
  }, [isAuthenticated, canSeeVoiceCalls]);

  useEffect(() => {
    if (!isAuthenticated || !canSeeMessages) return;
    let cancelled = false;
    const refresh = () => {
      messagesApiService.unreadCount()
        .then(({ count }) => { if (!cancelled) setMessagesUnreadCount(count); })
        .catch(() => {});
    };
    refresh();
    const onEvent = () => refresh();

    // Re-attach on socket reconnect: if this effect runs before Socket.IO
    // finishes connecting, `getSocket()` returns null and a plain socket.on
    // would silently no-op. Subscribing via onSocketChange also handles the
    // reconnect case (mobile background wake, network flap).
    let attachedSocket: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attachedSocket === s) return;
      if (attachedSocket) {
        attachedSocket.off('message:inbound', onEvent);
        attachedSocket.off('message:read', onEvent);
      }
      attachedSocket = s;
      if (attachedSocket) {
        attachedSocket.on('message:inbound', onEvent);
        attachedSocket.on('message:read', onEvent);
      }
    };
    attach(socketClient.getSocket());
    const unsubSocket = socketClient.onSocketChange((s) => attach(s));

    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      unsubSocket();
      attach(null);
    };
  }, [isAuthenticated, canSeeMessages]);
  useEffect(() => {
    if (!isAuthenticated || !canSeeMessages) return;
    if (view === ViewState.MESSAGGI) return;
    messagesApiService.unreadCount()
      .then(({ count }) => setMessagesUnreadCount(count))
      .catch(() => {});
  }, [view, isAuthenticated, canSeeMessages]);

  // Non letti della chat staff — stesso schema del badge Messaggi: fetch al
  // mount, refresh su ogni evento socket del modulo e al focus. La lettura
  // fatta su QUESTO device non emette l'evento verso se stessa (esclusione
  // X-Socket-ID), quindi si riconta anche quando si lascia la vista.
  const [staffChatUnreadCount, setStaffChatUnreadCount] = useState(0);
  const canSeeStaffChat = canAccessView(ViewState.CHAT_STAFF);
  useEffect(() => {
    if (!isAuthenticated || !canSeeStaffChat) return;
    let cancelled = false;
    const refresh = () => {
      staffChatApiService.unreadCount()
        .then(({ count }) => { if (!cancelled) setStaffChatUnreadCount(count); })
        .catch(() => {});
    };
    refresh();
    const onEvent = () => refresh();

    let attachedSocket: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attachedSocket === s) return;
      if (attachedSocket) {
        attachedSocket.off('staffchat:message', onEvent);
        attachedSocket.off('staffchat:read', onEvent);
      }
      attachedSocket = s;
      if (attachedSocket) {
        attachedSocket.on('staffchat:message', onEvent);
        attachedSocket.on('staffchat:read', onEvent);
      }
    };
    attach(socketClient.getSocket());
    const unsubSocket = socketClient.onSocketChange((s) => attach(s));

    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      unsubSocket();
      attach(null);
    };
  }, [isAuthenticated, canSeeStaffChat]);
  useEffect(() => {
    if (!isAuthenticated || !canSeeStaffChat) return;
    staffChatApiService.unreadCount()
      .then(({ count }) => setStaffChatUnreadCount(count))
      .catch(() => {});
  }, [view, isAuthenticated, canSeeStaffChat]);

  // Deep-link dalla push (?staffchat=<threadKey>): il thread da aprire appena
  // la vista monta.
  const [pendingStaffChatThread, setPendingStaffChatThread] = useState<string | null>(null);

  // Email and Notifiche unread badges — poll on view change + on focus, no
  // socket wiring for now (both endpoints are cheap).
  const [emailUnreadCount, setEmailUnreadCount] = useState(0);
  const canSeeEmail = canAccessView(ViewState.EMAIL);
  // Stesso pre-riscaldamento di Messaggi e Chiamate: la lista thread è pronta
  // al primo ingresso e la cache muore col logout.
  useEffect(() => {
    if (!isAuthenticated) { emailCache.clear(); return; }
    if (!canSeeEmail) return;
    emailApiService.prefetchThreads();
  }, [isAuthenticated, canSeeEmail]);
  useEffect(() => {
    if (!isAuthenticated || !canSeeEmail) return;
    let cancelled = false;
    const refresh = () => {
      emailApiService.unreadCount()
        .then(({ count }) => { if (!cancelled) setEmailUnreadCount(count); })
        .catch(() => {});
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [isAuthenticated, canSeeEmail, view]);

  const [notificationsUnreadCount, setNotificationsUnreadCount] = useState(0);
  // The bell is a dropdown on pointer-sized screens and a link to the full
  // page below lg — the same line the sidebar and bottom nav already use.
  const [notificationsPanelOpen, setNotificationsPanelOpen] = useState(false);
  const bellRef = useRef<HTMLButtonElement | null>(null);
  const bellOpensPanel = useMediaQuery('(min-width: 1024px)');
  // Never leave the panel hanging over a screen that shouldn't have one.
  useEffect(() => { if (!bellOpensPanel) setNotificationsPanelOpen(false); }, [bellOpensPanel]);
  const canSeeNotifications = canAccessView(ViewState.NOTIFICHE);
  useEffect(() => {
    if (!isAuthenticated || !canSeeNotifications) return;
    let cancelled = false;
    const refresh = () => {
      notificationsApiService.unreadCount()
        .then(({ count }) => { if (!cancelled) setNotificationsUnreadCount(count); })
        .catch(() => {});
    };
    refresh();
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => { cancelled = true; window.removeEventListener('focus', onFocus); };
  }, [isAuthenticated, canSeeNotifications, view]);

  // Pagamenti badge — paid-but-not-yet-seen payments. Live via the payment
  // socket events (webhook completions land without any user action) plus
  // 'payments:seen' so opening the page on one device clears every sidebar.
  const [paymentsUnseenCount, setPaymentsUnseenCount] = useState(0);
  const canSeePayments = canAccessView(ViewState.PAGAMENTI);
  useEffect(() => {
    if (!isAuthenticated || !canSeePayments) return;
    let cancelled = false;
    const refresh = () => {
      paymentsApiService.unseenCount()
        .then(({ count }) => { if (!cancelled) setPaymentsUnseenCount(count); })
        .catch(() => {});
    };
    refresh();
    const onEvent = () => refresh();
    let attachedSocket: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attachedSocket === s) return;
      if (attachedSocket) {
        attachedSocket.off('paymentRequest:updated', onEvent);
        attachedSocket.off('paymentRequest:created', onEvent);
        attachedSocket.off('payments:seen', onEvent);
      }
      attachedSocket = s;
      if (attachedSocket) {
        attachedSocket.on('paymentRequest:updated', onEvent);
        attachedSocket.on('paymentRequest:created', onEvent);
        attachedSocket.on('payments:seen', onEvent);
      }
    };
    attach(socketClient.getSocket());
    const unsubSocket = socketClient.onSocketChange((s) => attach(s));
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      unsubSocket();
      attach(null);
    };
  }, [isAuthenticated, canSeePayments, view]);

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
        // Mirror the sidebar side-effect that clicking the nav item would
        // trigger — so landing on Reception/Prenotazioni opens with a
        // collapsed sidebar (max real estate for task-focused views).
        const navItem = NAV_ITEMS.find(n => n.view === preferred);
        if (navItem?.sidebarCollapse === true) setSidebarCollapsed(true);
        else if (navItem?.sidebarCollapse === false) setSidebarCollapsed(false);
        appliedPreferredLandingRef.current = true;
        return;
      }
    }

    // Il platform admin parte dal pannello: la sua giornata sta sopra i
    // tenant, non nel servizio di uno di essi. Un preferred_landing_view
    // esplicito o un deep-link ?view= vincono comunque (gestiti sopra).
    if (!appliedPreferredLandingRef.current && user.role === UserRole.PLATFORM_ADMIN && accessibleViews.includes(ViewState.PLATFORM)) {
      setView(ViewState.PLATFORM);
      appliedPreferredLandingRef.current = true;
      return;
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
        // Push della chat staff: apre la vista sul thread indicato.
        const staffChatThread = url.searchParams.get('staffchat');
        if (staffChatThread) {
          if (getAccessibleViews().includes(ViewState.CHAT_STAFF)) {
            setPendingStaffChatThread(staffChatThread);
            setView(ViewState.CHAT_STAFF);
          }
          return;
        }
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
  // Flips to false the first time fetchData() completes. Consumers (list
  // pages) render skeleton placeholders while this is true and their data
  // array is empty. Stays false thereafter so refetches (visibilitychange,
  // pageshow, socket reconnect) never flash the skeleton over real data.
  const [isInitialDataLoading, setIsInitialDataLoading] = useState(true);

  // Notification State — persisted to localStorage so they survive PWA
  // reloads and mobile app suspend/resume (iOS drops websocket in background
  // and would otherwise lose the bell history).
  const NOTIFICATIONS_STORAGE_KEY = 'ristomanager_notifications_v1';
  const NOTIFICATIONS_MAX = 50;
  const [notifications, setNotifications] = useState<Notification[]>(() => {
    try {
      const raw = localStorage.getItem(NOTIFICATIONS_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((n: any) => ({
        ...n,
        timestamp: new Date(n.timestamp),
      })).filter((n: Notification) => !isNaN(n.timestamp.getTime()));
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      const serializable = notifications.slice(0, NOTIFICATIONS_MAX).map(n => ({
        ...n,
        timestamp: n.timestamp.toISOString(),
      }));
      localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(serializable));
    } catch { /* quota or private mode — ignore */ }
  }, [notifications]);

  // Latest reservations snapshot for socket handlers (avoids stale closures).
  const reservationsRef = useRef<Reservation[]>([]);
  useEffect(() => { reservationsRef.current = reservations; }, [reservations]);

  // Channel label for the bell notification title. For MANUAL (in-app)
  // reservations we prefer the creator's actual name so the shared Reception
  // account doesn't just read "Utente" over and over.
  const channelLabelForReservation = (res: Reservation): string => {
    switch (res.source) {
      case ReservationSource.WHATSAPP: return 'WhatsApp';
      case ReservationSource.VOICE: return 'Agente vocale';
      case ReservationSource.GOOGLE: return 'Web';
      case ReservationSource.MANUAL:
      default:
        return toTitleCase((res.created_by_user_name || '').trim()) || 'Utente';
    }
  };

  type ReservationNotifKind = 'created' | 'confirmed' | 'declined' | 'cancelled' | 'noshow' | 'deleted';

  // Push a reservation notification into the bell dropdown. Deduplicates
  // repeats for the same reservation+kind within a 5s window so that local
  // optimistic actions + their socket rebroadcast don't produce two entries.
  const addReservationNotification = (res: Reservation, kind: ReservationNotifKind) => {
    const name = toTitleCase(res.customer_name);
    const when = (() => {
      try {
        const dt = new Date(res.reservation_time);
        return dt.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      } catch { return res.reservation_time; }
    })();
    const source = channelLabelForReservation(res);
    let title = '';
    let message = '';
    let type: Notification['type'] = 'info';
    switch (kind) {
      case 'created':
        title = `Nuova prenotazione · ${source}`;
        message = `${name} · ${res.guests} ospiti · ${when}`;
        type = 'info';
        break;
      case 'confirmed':
        title = 'Prenotazione confermata';
        message = `${name} · ${res.guests} ospiti · ${when}`;
        type = 'success';
        break;
      case 'declined':
        title = 'Prenotazione rifiutata';
        message = `${name} · ${when}`;
        type = 'warning';
        break;
      case 'cancelled':
        title = 'Prenotazione annullata';
        message = `${name} · ${when}`;
        type = 'warning';
        break;
      case 'noshow':
        title = 'Prenotazione no show';
        message = `${name} · ${when}`;
        type = 'warning';
        break;
      case 'deleted':
        title = 'Prenotazione eliminata';
        message = `${name} · ${when}`;
        type = 'warning';
        break;
    }
    setNotifications(prev => {
      const now = Date.now();
      const isDup = prev.some(n =>
        n.reservationId === res.id
        && n.title === title
        && (now - n.timestamp.getTime()) < 5000
      );
      if (isDup) return prev;
      return [{
        id: Math.random().toString(),
        title, message, type,
        reservationId: res.id,
        timestamp: new Date(),
        read: false,
      }, ...prev].slice(0, NOTIFICATIONS_MAX);
    });
  };

  // Rebuild bell entries for reservations created in the last window from the
  // server payload. Needed for mobile/PWA sessions that were closed (or with
  // a suspended socket) when the reservation was actually created — without
  // this the bell would be empty on those devices even though the reservation
  // is visible in the list.
  const BELL_HYDRATE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
  const hydrateBellFromRecentReservations = (list: Reservation[]) => {
    const cutoff = Date.now() - BELL_HYDRATE_WINDOW_MS;
    const recent = list.filter(r => {
      if (!r.created_at) return false;
      const t = new Date(r.created_at).getTime();
      return !isNaN(t) && t >= cutoff;
    });
    if (recent.length === 0) return;
    setNotifications(prev => {
      const existingReservationIds = new Set(
        prev.map(n => n.reservationId).filter((v): v is number => v != null)
      );
      const additions: Notification[] = [];
      for (const r of recent) {
        if (existingReservationIds.has(r.id)) continue;
        const when = (() => {
          try {
            const dt = new Date(r.reservation_time);
            return dt.toLocaleString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
          } catch { return ''; }
        })();
        const name = toTitleCase(r.customer_name);
        const channel = channelLabelForReservation(r);
        additions.push({
          id: `hydrate-${r.id}-${r.created_at}`,
          title: `Nuova prenotazione · ${channel}`,
          message: `${name} · ${when}`,
          type: 'info',
          reservationId: r.id,
          timestamp: new Date(r.created_at as string),
          read: false,
        });
      }
      if (additions.length === 0) return prev;
      const merged = [...additions, ...prev];
      merged.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
      return merged.slice(0, NOTIFICATIONS_MAX);
    });
  };

  // Classify a reservation update as a notification-worthy status transition.
  // Returns null for edits that shouldn't spam the bell (notes/guests/table).
  const classifyReservationUpdate = (prev: Reservation, next: Reservation): ReservationNotifKind | null => {
    const prevStatus = prev.reservation_status;
    const nextStatus = next.reservation_status;
    if (prevStatus !== nextStatus) {
      if (nextStatus === ReservationStatus.CANCELLED) return 'cancelled';
      if (nextStatus === ReservationStatus.DECLINED) return 'declined';
      if (nextStatus === ReservationStatus.NO_SHOW) return 'noshow';
      if (nextStatus === ReservationStatus.CONFIRMED && prevStatus === ReservationStatus.PENDING) return 'confirmed';
    }
    return null;
  };

  // Toast/Snackbar State
  const [toasts, setToasts] = useState<Toast[]>([]);

  // User management modal state
  const [showRolePermissions, setShowRolePermissions] = useState(false);
  const [showActivityLogs, setShowActivityLogs] = useState(false);

  // Mobile chrome menus
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  // Profilo self-service (nome, telefono, password, email) — aperto
  // dall'area utente della sidebar e dal menu "Altro" su mobile.
  const [showProfilo, setShowProfilo] = useState(false);

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

  // Caricamento in due tempi (26/08): il boot scarica solo la finestra
  // recente (RESERVATIONS_WINDOW_DAYS indietro + tutto il futuro) e l'app
  // diventa interattiva subito; lo storico arriva in background e si fonde
  // nello stato, così schede clienti, ricerca globale e storico telefonate
  // — che leggono tutto — restano completi. Il tempo di avvio smette di
  // crescere con lo storico. archiveRef sopravvive alle riconnessioni: la
  // fetchData di un reconnect ricarica la finestra e rimonta l'archivio già
  // in memoria senza riscaricarlo.
  const RESERVATIONS_WINDOW_DAYS = 45;
  const reservationsArchiveRef = useRef<Reservation[]>([]);
  const archiveLoadedRef = useRef(false);

  const mergeReservationsById = (primary: Reservation[], secondary: Reservation[]): Reservation[] => {
    const ids = new Set(primary.map(r => r.id));
    return [...primary, ...secondary.filter(r => !ids.has(r.id))];
  };

  const loadReservationsArchive = async (windowFrom: string) => {
    try {
      const archive = await getReservations({ to: windowFrom });
      reservationsArchiveRef.current = archive;
      archiveLoadedRef.current = true;
      // prev vince sul duplicato di confine: contiene già gli aggiornamenti
      // socket arrivati mentre l'archivio era in volo.
      setReservations(prev => mergeReservationsById(prev, archive));
    } catch (error) {
      // Non bloccante: l'app funziona sulla finestra; si ritenta al prossimo
      // fetchData (reconnect) finché l'archivio non entra.
      console.warn('Archivio prenotazioni non caricato, si ritenta al prossimo sync:', error);
    }
  };

  const fetchData = async () => {
    // L'admin piattaforma non opera il CRM del tenant: per scelta (D2) non ha
    // righe nella matrice permessi, quindi questi cinque endpoint gli
    // risponderebbero 403 — il toast "insufficient permissions" a ogni login.
    // Atterra sulla vista Piattaforma; i dati di un ristorante li vede solo
    // impersonando, con un token da OWNER di quel tenant.
    if (user?.role === UserRole.PLATFORM_ADMIN) {
      setIsInitialDataLoading(false);
      return;
    }
    const windowFrom = getRomeDatePart(new Date(Date.now() - RESERVATIONS_WINDOW_DAYS * 86400000));
    try {
      const [roomsData, tablesData, dishesData, banquetMenusData, reservationsData] = await Promise.all([
        getRooms(),
        getTables(),
        getDishes(),
        getBanquetMenus(),
        getReservations({ from: windowFrom }),
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
      setReservations(mergeReservationsById(reservationsData, reservationsArchiveRef.current));
      hydrateBellFromRecentReservations(reservationsData);
    } catch (error) {
      console.error("Error fetching data:", error);
      addToast('Error fetching data', 'error');
    } finally {
      setIsInitialDataLoading(false);
    }
    // Secondo tempo, fuori dal percorso critico: parte dopo che l'app è
    // interattiva. `to` = windowFrom incluso: un giorno di sovrapposizione
    // col primo tempo, il dedup per id lo assorbe.
    if (!archiveLoadedRef.current) void loadReservationsArchive(windowFrom);
  };

  // Dedup guard: same message+type+title emitted within this window are
  // collapsed to a single toast. Fires all the time we do "handler +
  // socket:event" (both trigger the same feedback) or when React StrictMode
  // double-invokes an effect in dev. 2500ms covers the typical socket
  // roundtrip while staying short enough to not swallow legitimate repeat
  // actions ("Salva" clicked twice on purpose).
  const TOAST_DEDUP_WINDOW_MS = 2500;
  const lastToastAtRef = useRef<Map<string, number>>(new Map());

  const addToast = (
    message: string,
    type: 'success' | 'error' | 'info' = 'info',
    options?: { title?: string; details?: string[]; duration?: number; action?: { label: string; onClick: () => void } }
  ) => {
      const dedupKey = `${type}|${options?.title ?? ''}|${message}`;
      const now = Date.now();
      const lastAt = lastToastAtRef.current.get(dedupKey);
      if (lastAt !== undefined && now - lastAt < TOAST_DEDUP_WINDOW_MS) {
          // Suppressed duplicate. Refresh the timestamp so back-to-back
          // triggers keep the suppression alive instead of leaking through
          // right after the window expires.
          lastToastAtRef.current.set(dedupKey, now);
          return;
      }
      lastToastAtRef.current.set(dedupKey, now);
      // Periodic cleanup so the map doesn't grow unbounded during long
      // sessions. Anything older than the window is safe to drop.
      for (const [k, ts] of lastToastAtRef.current) {
          if (now - ts > TOAST_DEDUP_WINDOW_MS * 4) lastToastAtRef.current.delete(k);
      }

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

  // Socket connectivity — refs used to filter spurious connect/disconnect
  // toasts. Real drops (Wi-Fi off, server restart) last well over 2.5s and
  // still surface a toast; brief flaps (iOS backgrounding, transport
  // upgrade, single missed heartbeat) do not.
  const disconnectToastTimerRef = useRef<number | null>(null);
  const disconnectToastShownRef = useRef(false);

  // PWA icon badge — somma le "cose da attenzionare" in un unico numero
  // che appare sopra l'icona dell'app installata. Segnali scelti:
  //   • prenotazioni PENDING ("Da confermare" nella Dashboard)
  //   • chiamate voice da ricontattare (già tracciate)
  //   • messaggi non letti in Inbox (SMS/WhatsApp/email in ingresso)
  // Silenzioso su Safari macOS / Firefox (API non supportata) o quando
  // la pagina non è aperta come PWA installata.
  const pendingReservationsCount = useMemo(
    () => reservations.filter(r => r.reservation_status === ReservationStatus.PENDING).length,
    [reservations]
  );
  useAppBadge(pendingReservationsCount + voiceCallsPendingCount + messagesUnreadCount);

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
      addReservationNotification(reservation, 'created');
    });

    socket.on('reservation:updated', (reservation: Reservation) => {
      const previous = reservationsRef.current.find(r => r.id === reservation.id);
      setReservations(prev =>
        prev.map(r => r.id === reservation.id ? reservation : r)
      );
      addToast(`Prenotazione aggiornata: ${toTitleCase(reservation.customer_name)}`, 'info');
      if (previous) {
        const kind = classifyReservationUpdate(previous, reservation);
        if (kind) addReservationNotification(reservation, kind);
      }
    });

    socket.on('reservation:deleted', (id: number) => {
      const deleted = reservationsRef.current.find(r => r.id === id);
      setReservations(prev => prev.filter(r => r.id !== id));
      addToast('Prenotazione eliminata', 'info');
      if (deleted) addReservationNotification(deleted, 'deleted');
    });

    // Silent patch — a denormalized field (e.g. customer_name/phone from a
    // customer rename or merge) changed on these reservations. Update the
    // cards in place with no toast/notification: the user made that edit
    // elsewhere and one booking edit can touch many reservations.
    socket.on('reservation:synced', (reservation: Reservation) => {
      setReservations(prev =>
        prev.map(r => r.id === reservation.id ? reservation : r)
      );
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

    // Sync di massa dalla cassa (import Passepartout): un evento solo al
    // posto di centinaia di dish:updated — si ricarica l'anagrafica intera.
    socket.on('dish:synced', () => {
      getDishes().then(setDishes).catch(() => {});
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

    // Connection/Disconnection handlers with offline queue.
    // Toast policy:
    //  - First connect after page load: silent (nothing was "restored").
    //  - Disconnect: schedule the "persa" toast after 2.5s. If the socket
    //    reconnects before then, cancel it — the user never sees a flap.
    //  - Real reconnect (we actually showed "persa"): show "ristabilita".
    // Data policy (unchanged): always fetchData + flush offline queue on
    // every connect — that's the correctness path, not the UI concern.
    socket.on('connect', async () => {
      console.log('✅ Socket connected - refreshing data');

      // Cancel a pending "persa" toast if the drop was < 2.5s (glitch).
      if (disconnectToastTimerRef.current !== null) {
        clearTimeout(disconnectToastTimerRef.current);
        disconnectToastTimerRef.current = null;
      }

      // Only surface "ristabilita" if we actually alerted the user that
      // the connection was down. Otherwise stay quiet (first connect,
      // brief reconnect that never reached the toast timer).
      if (disconnectToastShownRef.current) {
        addToast('Connessione ristabilita', 'success');
        disconnectToastShownRef.current = false;
      }

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
        if (result.dropped > 0) {
          addToast(`${result.dropped} operazioni troppo vecchie non sono state rigiocate`, 'info');
        }

        // Refresh again after the flush so the UI reflects the server state
        // produced by replaying the queue.
        fetchData();
      }
    });

    socket.on('disconnect', (reason) => {
      console.log('⚠️ Socket disconnected:', reason);
      // Debounce: only pop the "persa" toast if the disconnect lasts >2.5s.
      // Guards against transient flaps (iOS background, network handoff,
      // single missed pong, Socket.IO transport upgrade churn).
      if (disconnectToastTimerRef.current !== null) {
        clearTimeout(disconnectToastTimerRef.current);
      }
      disconnectToastTimerRef.current = window.setTimeout(() => {
        addToast('Connessione persa - le modifiche verranno sincronizzate al ripristino', 'error');
        disconnectToastShownRef.current = true;
        disconnectToastTimerRef.current = null;
      }, 2500);
    });

    // Cleanup all event listeners on unmount
    return () => {
      socket.off('reservation:created');
      socket.off('reservation:updated');
      socket.off('reservation:deleted');
      socket.off('reservation:synced');
      socket.off('table:created');
      socket.off('table:updated');
      socket.off('table:deleted');
      socket.off('room:created');
      socket.off('room:updated');
      socket.off('room:deleted');
      socket.off('dish:created');
      socket.off('dish:updated');
      socket.off('dish:deleted');
      socket.off('dish:synced');
      socket.off('banquet:created');
      socket.off('banquet:updated');
      socket.off('banquet:deleted');
      socket.off('connect');
      socket.off('disconnect');
      // Clear the pending "persa" timer so an unmount mid-flap doesn't
      // fire the toast after the component has already gone away.
      if (disconnectToastTimerRef.current !== null) {
        clearTimeout(disconnectToastTimerRef.current);
        disconnectToastTimerRef.current = null;
      }
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
    // Post write-path fix + migration the DB returns reservation_time as a
    // proper UTC ISO ("2026-07-21T18:00:00.000Z" = 20:00 in Europe/Rome).
    // Splitting on 'T' would grab the UTC hour and show 18:00 for a 20:00
    // booking — the classic 2h CEST shift. Convert via the helpers instead.
    const romeDate = getRomeDatePart(res.reservation_time);
    const timeLabel = getRomeTimePart(res.reservation_time) || '00:00';
    const [yStr, mStr, dStr] = (romeDate || '').split('-');
    const dateLabelSource = new Date(
      Number(yStr),
      Number(mStr) - 1,
      Number(dStr),
    );
    const dateLabel = dateLabelSource.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    const shiftLabel = res.shift === Shift.LUNCH ? 'Pranzo' : 'Cena';
    const tableName = res.table_id ? tables.find(t => t.id === res.table_id)?.name : null;

    const details = [
      `${toTitleCase(res.customer_name)} · ${res.guests} ${res.guests === 1 ? 'ospite' : 'ospiti'}`,
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

  // Silent local patch — used when a server call already produced a
  // definitive row (e.g. /reservations/:id/confirm-email echoes the promoted
  // CONFIRMED row back). Guarantees the originating client's card reflects
  // the change even if the socket:updated broadcast is dropped, without
  // firing a second PUT the way handleUpdateReservation would.
  const handlePatchReservationLocal = useCallback((patched: Reservation) => {
    setReservations(prev => prev.map(r => r.id === patched.id ? patched : r));
  }, []);

  const handleAddReservation = async (newRes: Omit<Reservation, 'id'>): Promise<Reservation> => {
    try {
      const returnedRes = await createReservation(newRes);
      // If this reservation was created from a voice call, link it and drop
      // the call out of the pending queue. Best-effort — a link failure
      // should not block the user's booking flow.
      const linkCallId = linkVoiceCallOnCreateRef.current;
      if (linkCallId != null) {
        linkVoiceCallOnCreateRef.current = null;
        voiceCallsApiService.linkReservation(linkCallId, returnedRes.id)
          .then(() => {
            // Signal ConversazioniPage: the call is now linked, badges must
            // flip from "Da ricontattare" to the reservation state.
            setVoiceCallsRefreshTick(t => t + 1);
            return voiceCallsApiService.pendingCount()
              .then(({ count }) => setVoiceCallsPendingCount(count))
              .catch(() => {});
          })
          .catch((err) => console.warn('linkReservation failed:', err));
      }
      // If created from an inbox conversation, link it back so staff can
      // reopen/modify the booking from the chat. Best-effort.
      const linkInboxPhone = linkInboxConversationOnCreateRef.current;
      if (linkInboxPhone) {
        linkInboxConversationOnCreateRef.current = null;
        messagesApiService.linkReservation(linkInboxPhone, returnedRes.id)
          .then(() => setInboxRefreshTick(t => t + 1))
          .catch((err) => console.warn('inbox linkReservation failed:', err));
      }
      // Optimistically include the new row so checks that scan `reservations`
      // (e.g. the duplicate preflight) see it immediately instead of waiting
      // for the socket round-trip. The socket handler dedupes by id.
      setReservations(prev => prev.some(r => r.id === returnedRes.id) ? prev : [...prev, returnedRes]);
      // The bell notification is added by the reservation:created socket
      // handler (see Socket.IO effect) — that path covers all channels
      // uniformly and dedupes against the local optimistic path.

      addToast('Prenotazione inserita con successo', 'success', {
        title: 'Nuova Prenotazione',
        details: buildReservationDetails(returnedRes),
      });
      return returnedRes;
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
      // The bell notification is added by the reservation:deleted socket
      // handler (see Socket.IO effect).
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
      <div className="min-h-screen bg-[var(--ds-canvas)] flex items-center justify-center">
        <Loader label="Caricamento..." />
      </div>
    );
  }

  // Show login page if not authenticated
  if (!isAuthenticated) {
    return <LoginPage />;
  }

  // Primo accesso di un tenant appena provisionato (Fase D1): l'OWNER passa
  // dal wizard prima di entrare. Solo lui — gli altri ruoli lavorano
  // normalmente anche se il wizard non è stato completato.
  if (user?.role === UserRole.OWNER && user.tenant?.needs_onboarding) {
    // Anche qui il banner: un platform admin che impersona l'OWNER di un
    // tenant appena nato vede il wizard, e deve poter tornare al pannello.
    return (
      <>
        <ImpersonationBanner />
        <OnboardingWizard />
      </>
    );
  }

  // Get role display name
  const getRoleDisplayName = (role: UserRole): string => {
    const roleNames: Record<UserRole, string> = {
      // Ruolo di piattaforma: nella UI di un tenant compare solo se un
      // platform admin sta impersonando — l'etichetta serve a non mostrare
      // la costante grezza.
      [UserRole.PLATFORM_ADMIN]: 'Admin piattaforma',
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
    if (item.view !== undefined && SALA_VIEWS.includes(item.view) && tableOrdersEnabled !== true) return false;
    return item.view !== undefined && canAccessView(item.view);
  };

  // Desktop sidebar: select a link, applying its incidental sidebar side effects.
  const selectNavItem = (item: NavItem) => {
    if (item.view === undefined) return;
    if (item.sidebarCollapse === true) setSidebarCollapsed(true);
    else if (item.sidebarCollapse === false) setSidebarCollapsed(false);
    if (item.menuInitialTab) setMenuInitialTab(item.menuInitialTab);
    // Dashboard is a "now" view — the live-service hero, KPIs and Stato Tavoli
    // all describe today by design. If the user navigated in from a
    // reservation/notification that pinned globalDate to a future or past day,
    // snap back to today when they cross into the Dashboard. Skip when
    // they're already on Dashboard (they may have just picked a date via the
    // header navigator and are re-clicking).
    if (item.view === ViewState.DASHBOARD && view !== ViewState.DASHBOARD) {
      const today = new Date();
      if (globalDate.toDateString() !== today.toDateString()) setGlobalDate(today);
    }
    setView(item.view);
  };

  // Items surfaced in the mobile "Altro" sheet (every visible non-tab link).
  // Drives the bottom-tab "Altro" button's visibility and active state.
  const altroNavItems = NAV_ITEMS.filter(item => item.kind === 'link' && !item.isTab && canSeeNavItem(item));

  // Blocchi di Impostazioni visibili a questo utente: il blocco
  // Amministrazione compare solo a chi può usarne almeno una card, la
  // Fiscalità solo col conto al tavolo nel piano (l'emissione parte da lì).
  const visibleSettingsGroups = SETTINGS_GROUPS.filter(g =>
    g.guard === 'admin' ? (canManageUsers() || canViewLogs())
    : g.guard === 'pay_at_table' ? hasFeature('pay_at_table')
    : true
  );

  // ── Comunicazioni, mobile ────────────────────────────────────────────────
  // One bottom tab stands in for three views. The channels the user can't
  // reach drop out, so a single-channel user gets a plain tab with no switcher.
  const commsChannels = [
    { view: ViewState.CONVERSAZIONI, label: 'Chiamate', badge: voiceCallsPendingCount },
    { view: ViewState.MESSAGGI, label: 'Messaggi', badge: messagesUnreadCount },
    { view: ViewState.CHAT_STAFF, label: 'Chat staff', badge: staffChatUnreadCount },
    { view: ViewState.EMAIL, label: 'Email', badge: emailUnreadCount },
  ].filter(c => canAccessView(c.view));
  const commsBadgeTotal = commsChannels.reduce((n, c) => n + (c.badge || 0), 0);
  const isCommsView = COMMS_VIEWS.includes(view);
  // Returning to the tab lands you back on the channel you left, the way the
  // sheet used to remember nothing and always cost two taps.
  const commsTargetView = commsChannels.some(c => c.view === lastCommsView)
    ? lastCommsView
    : commsChannels[0]?.view;

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
      // Prodotto sta con la spesa e le attività, non con le anagrafiche: è
      // roba di magazzino, la si crea nella stessa mezz'ora in cui si segna
      // cosa manca. In fondo all'elenco era l'unica voce di quel gruppo.
      { label: 'Prodotto', Icon: Boxes, show: hasPermission('inventory:full'), run: () => { setView(ViewState.INVENTARIO); setAutoOpenNewProduct(true); } },
    ],
    [
      { label: 'Cliente', Icon: BookUser, show: hasPermission('customers:full'), run: () => { setView(ViewState.CLIENTI); setAutoOpenNewCustomer(true); } },
      { label: 'Dipendente', Icon: UsersRound, show: hasPermission('staff:full'), run: () => { setView(ViewState.STAFF); setAutoOpenNewStaff(true); } },
      { label: 'Utente', Icon: Users, show: canManageUsers(), run: () => { setView(ViewState.USERS); setAutoOpenNewUser(true); } },
    ],
  ];
  const visibleCreateClusters = createMenuClusters
    .map(cluster => cluster.filter(item => item.show))
    .filter(cluster => cluster.length > 0);

  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--ds-canvas)] font-sans text-[var(--ds-text-primary)]">
      {/* Version banner — shows when the running bundle is older than the
          server. Fixed at the top, above every view. */}
      <AppVersionBanner />
      {/* Impersonation (Fase D2) — fisso sopra ogni vista finché il token
          porta il claim impersonated_by; il bottone ripristina la sessione
          del platform admin e ricarica. */}
      <ImpersonationBanner />
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

      {/* Sidebar — blends into page bg.
          mr-0, non mr-3: quei 12px erano la distanza di sicurezza della
          vecchia linguetta, che sporgeva nel corridoio e con margine zero
          finiva per toccare la card del contenuto. Ora nel corridoio non vive
          più niente, e sommati al m-4 dell'header di main facevano 28px di
          stacco fra le due card contro i 16px dei margini esterni: il
          contenuto risultava spinto a destra. Con mr-0 il corridoio torna a
          16px ed è uguale a tutti gli altri lati. */}
      <aside
        className={`hidden lg:flex ${sidebarCollapsed ? 'w-[76px]' : 'w-[250px]'} m-4 mr-0 rounded-[28px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] flex-col transition-[width] duration-200 z-20 relative`}
        aria-label="Navigazione principale"
      >
        {/* Intestazione — logo e comando apri/chiudi sulla stessa riga, come
            fanno gli editor a pannelli: il toggle sta dove sta il marchio,
            non su una linguetta da cercare sul bordo. Aperta è in coda alla
            riga (ml-auto); chiusa i 76px non reggono due elementi affiancati,
            così scende sotto il logo e la testata diventa due righe. L'icona
            non cambia fra i due stati — è sempre il pannello, non una freccia:
            resta lo stesso bersaglio nello stesso punto, e lo stato lo dicono
            aria-expanded e il title. */}
        <div className={`flex ${sidebarCollapsed ? 'flex-col items-center gap-1 pt-4 pb-2' : 'h-16 items-center px-4'}`}>
          <div className="flex items-center min-w-0">
            {/* Wordmark Sympotia a sidebar aperta; chiusa non ci sta, resta il
                quadrato. Due img nero/bianco: il tema le scambia via CSS. */}
            {sidebarCollapsed ? (
              <div className="bg-[var(--ds-action-bg)] h-10 w-10 rounded-[14px] inline-flex items-center justify-center flex-shrink-0">
                <ChefHat className="text-[var(--ds-action-fg)] h-5 w-5" />
              </div>
            ) : (
              <>
                <img src="/logo-sympotia-black.svg" alt={PLATFORM_NAME} className="h-7 w-auto dark:hidden" />
                <img src="/logo-sympotia-white.svg" alt={PLATFORM_NAME} className="hidden h-7 w-auto dark:block" />
              </>
            )}
          </div>
          <button
            type="button"
            onClick={toggleSidebar}
            aria-expanded={!sidebarCollapsed}
            aria-controls="sidebar-nav"
            title={sidebarCollapsed ? 'Apri menu' : 'Chiudi menu'}
            aria-label={sidebarCollapsed ? 'Apri menu' : 'Chiudi menu'}
            className={`inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${sidebarCollapsed ? '' : 'ml-auto'}`}
          >
            <PanelLeft size={18} />
          </button>
        </div>

        <nav id="sidebar-nav" ref={navFadeRef} className="flex-1 min-h-0 overflow-y-auto scroll-fade-y scrollbar-hover py-2 space-y-0.5 px-3">
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
            // Notifiche is presented as the top-bar bell on desktop, so it is
            // hidden from this list only. The NAV_ITEMS entry stays intact so
            // the mobile bottom tab, the "Altro" sheet and the command palette
            // keep working unchanged.
            const items = NAV_ITEMS.filter(item =>
              item.group === group.id
              && canSeeNavItem(item)
              && item.view !== ViewState.NOTIFICHE
            );
            if (items.length === 0) return null;
            return (
              <React.Fragment key={group.id}>
                {sidebarCollapsed ? (
                  // Chiusa, l'eyebrow non entra: al suo posto un filetto, così
                  // i gruppi restano leggibili come blocchi invece di
                  // sciogliersi in una colonna unica di icone.
                  <div aria-hidden className="mx-auto my-2 h-px w-6 bg-[var(--ds-border)]" />
                ) : (
                  <div className="px-3 pt-4 pb-1 text-[13px] font-medium text-[var(--ds-text-muted)]">
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
                        className="group w-full flex items-center justify-center px-3 h-10 rounded-[12px] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] transition-colors"
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
                        className="group w-full flex items-center justify-between gap-3 px-3 h-10 rounded-[12px] text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] transition-colors"
                      >
                        <span className="flex items-center gap-3">
                          <span className="text-[var(--ds-text-secondary)]">
                            {theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}
                          </span>
                          {/* nowrap: è l'unica riga della nav che porta anche
                              un toggle da 44px, quindi con la sidebar a 250px
                              il flex la stringeva e "Modalità scura" andava a
                              capo. */}
                          <span className="font-medium text-[15px] tracking-[-0.01em] whitespace-nowrap">{item.label}</span>
                        </span>
                        <span
                          aria-hidden
                          className={`relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full transition-colors ${theme === 'dark' ? 'bg-[var(--ds-action-bg)]' : 'bg-[var(--ds-border-strong)]'}`}
                        >
                          <span
                            className={`inline-block h-[22px] w-[22px] transform rounded-full bg-[var(--ds-surface)] shadow transition-transform ${theme === 'dark' ? 'translate-x-[20px]' : 'translate-x-0.5'}`}
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
                      badge={
                        item.view === ViewState.CONVERSAZIONI ? voiceCallsPendingCount
                        : item.view === ViewState.MESSAGGI ? messagesUnreadCount
                        : item.view === ViewState.CHAT_STAFF ? staffChatUnreadCount
                        : item.view === ViewState.EMAIL ? emailUnreadCount
                        : item.view === ViewState.NOTIFICHE ? notificationsUnreadCount
                        : item.view === ViewState.PAGAMENTI ? paymentsUnseenCount
                        : undefined
                      }
                    />
                  )
                ))}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="p-3">
          {/* User Info — level-2 row inside the level-1 sidebar card */}
          {sidebarCollapsed ? (
            <div className="flex flex-col items-center gap-2 py-2 rounded-[16px] bg-[var(--ds-surface-row)]">
              {/* L'avatar apre il profilo self-service — è l'unico appiglio
                  quando la sidebar è chiusa. */}
              <button
                onClick={() => setShowProfilo(true)}
                className="w-10 h-10 rounded-full bg-[var(--ds-action-bg)] flex items-center justify-center text-[var(--ds-action-fg)] font-medium text-[13px] transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                title="Il tuo account"
                aria-label="Il tuo account"
              >
                {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
              </button>
              <button
                onClick={logout}
                className="p-2 text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-solid)] rounded-[12px] transition-colors"
                title="Esci"
                aria-label="Esci"
              >
                <LogOut size={16} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-3 rounded-[16px] bg-[var(--ds-surface-row)]">
              {/* Avatar + nome sono un bottone: aprono il profilo. Esci resta
                  un controllo separato — logout e profilo non si somigliano. */}
              <button
                onClick={() => setShowProfilo(true)}
                className="flex flex-1 min-w-0 items-center gap-3 text-left rounded-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                title="Il tuo account"
                aria-label="Il tuo account"
              >
                <div className="w-10 h-10 shrink-0 rounded-full bg-[var(--ds-action-bg)] flex items-center justify-center text-[var(--ds-action-fg)] font-medium text-[13px]">
                  {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold text-[var(--ds-text-primary)] tracking-[-0.01em] truncate">{user?.full_name || 'Utente'}</p>
                  <p className="text-[13px] text-[var(--ds-text-muted)] truncate">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
                </div>
              </button>
              <button
                onClick={logout}
                className="p-1.5 text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-solid)] rounded-[10px] transition-colors"
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
      {/* main is a flex column: a fixed header + one internal scroll region.
          This replaces the old "main scrolls, header is sticky" model, which
          on mobile let the whole view drift up under the header (100vh + the
          bottom-nav padding overflowed the visible viewport). Now nothing
          scrolls at the main level, so headers and toolbars stay put. */}
      <main id="main" className="flex-1 min-w-0 flex flex-col min-h-0 relative bg-[var(--ds-canvas)]">
        {/* Header — floating rounded card on the canvas (no blur: the design
            system is opaque, see docs/risto-design-system.md §2.2). */}
        {/* z-10 → md:z-30: the "+" menu lives inside this stacking context, so
            the header must outrank in-page toolbars (Sale & Tavoli rows are
            z-20) or the dropdown paints behind them. Mobile stays z-10 — the
            bottom-sheet backdrop (z-[29]) has to dim the header there. */}
        <header className="flex-shrink-0 h-16 md:h-[72px] m-4 rounded-[28px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] z-10 md:z-30 flex items-center justify-between px-3 md:px-4">
           <div className="flex items-center gap-2.5 lg:hidden">
              <img src="/logo-sympotia-black.svg" alt={PLATFORM_NAME} className="h-6 w-auto dark:hidden" />
              <img src="/logo-sympotia-white.svg" alt={PLATFORM_NAME} className="hidden h-6 w-auto dark:block" />
           </div>

           {/* Desktop date/time/shift control group. Uses flex-1 (not a fixed
               w-1/2) so it takes exactly the free space between the mobile logo
               and the right actions — with the sidebar open at lg the content
               area shrinks and a fixed half would overflow into the "+" button. */}
           <div className={`hidden md:flex items-center gap-2.5 flex-1 min-w-0 ${[ViewState.SETTINGS, ViewState.USERS, ViewState.CLIENTI, ViewState.STAFF, ViewState.PLATFORM].includes(view) ? '!hidden' : ''}`}>
             <DateNavigator
               value={globalDateStr}
               onChange={(dateOnly) => {
                 const [y, m, d] = dateOnly.split('-').map(Number);
                 if (y && m && d) setGlobalDate(new Date(y, m - 1, d));
               }}
               widthClass="w-[200px]"
               backToToday="inline"
             />

             {/* The standalone clock chip is gone — the time now lives inside
                 the connection pill on the right ("Live 20:43"). */}

             {/* Shift filter — "Tutti" only on Dashboard. Segmented control:
                 track at surface-row, active segment raised on surface. */}
             <div className="flex items-center bg-[var(--ds-surface-row)] rounded-full p-1 gap-0.5 flex-shrink-0">
               {([
                 { key: 'LUNCH', label: 'Pranzo', icon: <Sun className="h-3.5 w-3.5" /> },
                 { key: 'DINNER', label: 'Cena', icon: <Sunset className="h-3.5 w-3.5" /> },
                 { key: 'ALL', label: 'Tutti', icon: null as React.ReactNode },
               ] as const).filter(opt => opt.key !== 'ALL' || view === ViewState.DASHBOARD).map(opt => (
                 <button
                   key={opt.key}
                   onClick={() => setGlobalShiftFilter(opt.key)}
                   className={`inline-flex items-center gap-1.5 px-4 h-9 rounded-full text-[15px] font-medium transition-colors ${
                     globalShiftFilter === opt.key
                       ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                       : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                   }`}
                   aria-pressed={globalShiftFilter === opt.key}
                 >
                   {opt.icon}
                   {opt.label}
                 </button>
               ))}
             </div>

             {/* Channel status icons — visibile solo quando un turno specifico
                 è selezionato (la combinazione di "Tutti" con blocco per-turno
                 non ha una singola risposta). Legge lo stato effettivo per
                 (globalDate, globalShift) e permette toggle inline con
                 settings:full. */}
             {(globalShiftFilter === 'LUNCH' || globalShiftFilter === 'DINNER') && (
               <div className="hidden xl:flex items-center flex-shrink-0">
                 <BookingChannelsBar
                   date={globalDateStr}
                   shift={globalShiftFilter}
                   showToast={addToast}
                 />
               </div>
             )}
           </div>

           {/* Right cluster — order is deliberate: Live · Search · Bell · Plus */}
           <div className={`ml-auto flex items-center gap-2 flex-shrink-0 pl-2 ${view === ViewState.PLATFORM ? '!hidden' : ''}`}>

              {/* Connection state + current time, merged into one pill.
                  Connected uses the `seated` family; offline uses `critical`.
                  The dot pulses, but under prefers-reduced-motion it becomes a
                  steady colour — the signal is never removed, only the motion. */}
              <div
                className={`hidden md:inline-flex items-center gap-2 pl-2.5 pr-3 h-10 rounded-full text-[15px] font-medium ${
                  isConnected
                    ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                    : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
                }`}
                role="status"
                aria-live={isConnected ? 'polite' : 'assertive'}
                aria-label={isConnected ? 'Connesso' : 'Non connesso'}
              >
                <span className="relative flex h-2 w-2" aria-hidden>
                  {isConnected && (
                    <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden"></span>
                  )}
                  <span className={`relative inline-flex h-2 w-2 rounded-full ${isConnected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}></span>
                </span>
                <span className="whitespace-nowrap tabular-nums">
                  {isConnected
                    ? `Live ${currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
                    : 'Offline'}
                </span>
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
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--ds-seated-solid)] opacity-60 animate-ping motion-reduce:hidden" aria-hidden></span>
                )}
                <span
                  className={`relative inline-flex h-2.5 w-2.5 rounded-full ${isConnected ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-critical-solid)]'}`}
                  aria-hidden
                ></span>
              </span>

              {/* Global search — opens the command palette. Same button surface
                  as the bell so it stays reachable on mobile, where ⌘K does not apply. */}
              <button
                 onClick={() => setPaletteOpen(true)}
                 className="h-11 w-11 inline-flex items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors"
                 aria-label="Cerca (⌘K)"
                 title="Cerca prenotazioni o clienti (⌘K)"
              >
                 <Search className="h-[18px] w-[18px]" />
              </button>

              {/* Notifications — moved out of the sidebar into the top bar.
                  On a pointer-sized screen the bell opens a dropdown; below lg
                  it navigates to the full page, which is the mobile design.
                  The NAV_ITEMS entry is untouched so the tabs still work. */}
              {canAccessView(ViewState.NOTIFICHE) && (
                <button
                  ref={bellRef}
                  onClick={() => {
                    if (bellOpensPanel) setNotificationsPanelOpen(v => !v);
                    else setView(ViewState.NOTIFICHE);
                  }}
                  aria-haspopup={bellOpensPanel ? 'dialog' : undefined}
                  aria-expanded={bellOpensPanel ? notificationsPanelOpen : undefined}
                  className={`relative h-11 w-11 inline-flex items-center justify-center rounded-full transition-colors ${
                    notificationsPanelOpen
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                  }`}
                  aria-label={notificationsUnreadCount > 0 ? `Notifiche, ${notificationsUnreadCount} non lette` : 'Notifiche'}
                  title="Notifiche"
                >
                  <Bell className="h-[18px] w-[18px]" />
                  {notificationsUnreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[11px] font-semibold leading-none tabular-nums ring-2 ring-[var(--ds-surface)]">
                      {notificationsUnreadCount > 99 ? '99+' : notificationsUnreadCount}
                    </span>
                  )}
                </button>
              )}
              {notificationsPanelOpen && bellOpensPanel && (
                <NotificationsPanel
                  anchorRef={bellRef}
                  onClose={() => setNotificationsPanelOpen(false)}
                  onSeeAll={() => setView(ViewState.NOTIFICHE)}
                  onCountsChanged={() => {
                    notificationsApiService.unreadCount()
                      .then(({ count }) => setNotificationsUnreadCount(count))
                      .catch(() => {});
                  }}
                />
              )}

              {/* Global "+" create menu — replaces the old Nuova prenotazione + per-view secondary CTAs.
                  Identical on every page; desktop/tablet only (mobile uses the bottom "+" sheet). */}
              {visibleCreateClusters.length > 0 && (
                <div className="relative hidden md:block" ref={createMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowCreateMenu(v => !v)}
                    aria-haspopup="menu"
                    aria-expanded={showCreateMenu}
                    aria-label="Crea nuovo"
                    className="inline-flex items-center justify-center h-11 w-11 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)] transition-colors"
                  >
                    <Plus className="h-5 w-5 transition-transform duration-200" style={{ transform: showCreateMenu ? 'rotate(45deg)' : 'none' }} />
                  </button>

                  {showCreateMenu && (
                    <div
                      role="menu"
                      aria-label="Crea nuovo"
 className="absolute right-0 top-full mt-2 w-60 p-1.5 rounded-[18px] border border-[var(--ds-border)] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] z-30"
                    >
                      {visibleCreateClusters.map((cluster, ci) => (
                        <React.Fragment key={ci}>
                          {ci > 0 && <div className="my-1.5 border-t border-[var(--ds-border)]" />}
                          {cluster.map(item => (
                            <button
                              key={item.label}
                              type="button"
                              role="menuitem"
                              onClick={() => runCreateAction(item.run)}
                              className="w-full flex items-center gap-3 px-3 h-11 rounded-xl text-sm font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] transition-colors text-left"
                            >
                              <item.Icon className="h-[18px] w-[18px] text-[var(--ds-text-muted)]" />
                              <span>{item.label}</span>
                            </button>
                          ))}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              )}

           </div>
        </header>

        {/* View container — the single scroll region below the fixed header,
            keyed on the active view so every navigation re-mounts with a soft
            rise-in (see .animate-view-in). pb-20 on mobile clears the fixed
            bottom nav; full-height views (h-full) size to the padding-excluded
            area so they sit neatly between header and nav. */}
        {/* Mobile channel switcher. Comunicazioni is a single bottom tab, so
            without this, moving between Conversazioni, Messaggi and Email would
            mean going back out to the bar. Desktop keeps three sidebar entries
            and never renders it.

            A sibling of the scroll region, not a child: Messaggi and Email are
            full-height split views, so a bar inside the scroller would push
            them past the fold. Out here the scroller's flex-1 accounts for it.
            It sits on a white card because the segmented track is a level-2
            surface — on the canvas it would be invisible. */}
        {isCommsView && commsChannels.length > 1 && (
          // pb-4 is not decoration: the card's shadow falls below it, and the
          // scroll region underneath now paints an opaque sticky toolbar. With
          // no gap the shadow gets sliced by a hard horizontal edge.
          <div className="flex-shrink-0 px-4 pb-4 pt-4 lg:hidden">
            <div className="rounded-full bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)]">
              <SegmentedControl
                value={view}
                onChange={next => setView(next)}
                ariaLabel="Tipo di comunicazione"
                equalWidth={false}
                options={commsChannels.map(c => ({ value: c.view, label: c.label, badge: c.badge }))}
              />
            </div>
          </div>
        )}

        {/* .pb-mobile-nav clears the floating bottom bar (height + 16px offset
            + safe-area inset) and collapses to 0 at lg, where the bar is gone.
            In immersive mode the bar isn't there, so neither is the clearance —
            leaving it would park the comanda's Invia above a strip of nothing. */}
        <div
          key={view}
          className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden animate-view-in ${
            immersive ? '' : 'pb-mobile-nav'
          }`}
        >

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
            onUpdateReservation={handleUpdateReservation}
            onOpenReservationInList={(id) => {
              setPendingReservationId(id);
              setSidebarCollapsed(true);
              setView(ViewState.RESERVATIONS);
            }}
            isInitialLoading={isInitialDataLoading}
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
            onPatchReservationLocal={handlePatchReservationLocal}
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
              linkInboxConversationOnCreateRef.current = null;
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
                onPatchReservationLocal={handlePatchReservationLocal}
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
                isInitialLoading={isInitialDataLoading}
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
            reservations={reservations}
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
            refreshTick={voiceCallsRefreshTick}
          />
        )}

        {view === ViewState.MESSAGGI && (
          <InboxPage
            refreshTick={inboxRefreshTick}
            reservations={reservations}
            onCreateReservationFromContact={({ phone_digits, ...prefill }) => {
              // Remember which conversation to link the new booking back to,
              // so it becomes reopenable from the chat after creation.
              linkInboxConversationOnCreateRef.current = phone_digits ?? null;
              setNewReservationPrefill(prefill);
              setNewReservationKind('standard');
              setAutoOpenNewReservation(true);
              setView(ViewState.RESERVATIONS);
            }}
            onOpenReservation={(reservationId) => {
              setPendingReservationId(reservationId);
              setView(ViewState.RESERVATIONS);
            }}
          />
        )}
        {view === ViewState.CHAT_STAFF && user && (
          <StaffChatPage
            currentUserId={user.id}
            initialThreadKey={pendingStaffChatThread}
            onInitialThreadConsumed={() => setPendingStaffChatThread(null)}
          />
        )}

        {view === ViewState.EMAIL && (
          <EmailPage />
        )}

        {view === ViewState.NOTIFICHE && (
          <NotifichePage />
        )}

        {view === ViewState.COMANDE && (
          <CardErrorBoundary label="Comande">
            <OrderPad dishes={dishes} tables={tables} reservations={reservations} globalDate={globalDate} globalShiftFilter={globalShiftFilter} onImmersive={setImmersive} />
          </CardErrorBoundary>
        )}

        {view === ViewState.CUCINA && (
          <CardErrorBoundary label="Cucina">
            <KitchenDisplay globalDate={globalDate} globalShiftFilter={globalShiftFilter} />
          </CardErrorBoundary>
        )}

        {view === ViewState.PASSE && (
          <CardErrorBoundary label="Passe">
            <ExpediterDisplay />
          </CardErrorBoundary>
        )}

        {view === ViewState.PAGAMENTI && (
          <PagamentiPage globalDate={globalDate} globalShiftFilter={globalShiftFilter} />
        )}

        {view === ViewState.DEVELOPMENT && (
          <DevelopmentPage />
        )}

        {view === ViewState.ROADMAP && (
          <RoadmapPage />
        )}

        {view === ViewState.MONITORING && (
          <MonitoringPage />
        )}

        {view === ViewState.PLATFORM && canAccessView(ViewState.PLATFORM) && (
          <PlatformPanel showToast={addToast} />
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
          <CardErrorBoundary label="Impostazioni">
          {/* Scorrimento della pagina, non del contenitore: è quello che tiene
              il contenuto sopra la barra di navigazione flottante del telefono
              invece di lasciarlo passare dietro e ricomparire sotto. La colonna
              centrata sta DENTRO la zona che scorre, altrimenti la barra di
              scorrimento finirebbe in mezzo alla pagina invece che al bordo. */}
          <div className="flex h-full min-h-0 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">

            {/* Indice della pagina: chip-àncora che saltano al blocco. Nessuno
                stato — la pagina è unica e i blocchi sono sempre tutti
                montati, i chip fanno solo scorrere. */}
            <div className="-mx-4 mb-4 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
              {visibleSettingsGroups.map(g => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => document.getElementById(g.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                  className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-3.5 text-[13px] font-medium text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <g.Icon size={14} className="flex-shrink-0" />
                  {g.label}
                </button>
              ))}
            </div>

            {/* Preferenze personali: valgono per chi è collegato (e per questo
                dispositivo, nel caso delle push), non per il ristorante. */}
            <SettingsSection id="imp-profilo" label="Profilo">
              <div className="space-y-3">
              <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
                <label htmlFor="preferred-landing" className="mb-1 block text-[15px] font-semibold text-[var(--ds-text-primary)]">
                  Pagina di partenza
                </label>
                <p className="mb-3 text-[13px] text-[var(--ds-text-muted)]">
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
                  className={`${dsSelect} sm:max-w-sm`}
                >
                  <option value="">Predefinita (prima sezione disponibile)</option>
                  {getAccessibleViews().map(v => {
                    const labels: Record<ViewState, string> = {
                      [ViewState.DASHBOARD]: 'Dashboard',
                      [ViewState.RESERVATIONS]: 'Prenotazioni',
                      [ViewState.RECEPTION]: 'Reception',
                      [ViewState.CHAT_STAFF]: 'Chat staff',
                      [ViewState.FLOOR_PLAN]: 'Sale & Tavoli',
                      [ViewState.MENU]: 'Menu & Banchetti',
                      [ViewState.COMANDE]: 'Comande',
                      [ViewState.CUCINA]: 'Cucina',
                      [ViewState.PASSE]: 'Passe',
                      [ViewState.STAFF]: 'Personale',
                      [ViewState.CLIENTI]: 'Clienti',
                      [ViewState.INVENTARIO]: 'Inventario',
                      [ViewState.LISTA_DELLA_SPESA]: 'Lista della spesa',
                      [ViewState.HACCP]: 'HACCP',
                      [ViewState.CONVERSAZIONI]: 'Chiamate',
                      [ViewState.MESSAGGI]: 'Messaggi',
                      [ViewState.EMAIL]: 'Email',
                      [ViewState.NOTIFICHE]: 'Notifiche',
                      [ViewState.PAGAMENTI]: 'Pagamenti',
                      [ViewState.ATTIVITA]: 'Attività',
                      [ViewState.USERS]: 'Utenti',
                      [ViewState.SETTINGS]: 'Impostazioni',
                      [ViewState.MONITORING]: 'Consumi AI',
                      [ViewState.DEVELOPMENT]: 'Development',
                      [ViewState.ROADMAP]: 'Roadmap',
                      [ViewState.PLATFORM]: 'Piattaforma',
                    };
                    return (
                      <option key={v} value={v}>{labels[v]}</option>
                    );
                  })}
                </select>
              </div>
                <PushNotificationsCard />
              </div>
            </SettingsSection>

            {/* Il ristorante in quanto luogo: quando è aperto, cosa è chiuso,
                le routine di servizio, sala e cucina, l'identità legale. */}
            <SettingsSection id="imp-ristorante" label="Ristorante">
              <div className="space-y-3">
                <SettingsDisclosure
                  icon={Clock}
                  title="Orari settimanali e chiusure"
                  description="Gestisci servizi (pranzo/cena), giorni di chiusura e date speciali."
                >
                  <OpeningHoursManager showToast={addToast} />
                </SettingsDisclosure>
                <SettingsDisclosure
                  icon={DoorClosed}
                  title="Sale chiuse e tavoli nascosti"
                  description="Programma o rimuovi chiusure per turno di sale e tavoli."
                >
                  <ScheduledClosuresManager showToast={addToast} />
                </SettingsDisclosure>
                {/* Promemoria automatici (una tantum, giornalieri, settimanali,
                    mensili), incluso il "Promemoria pane". */}
                <RemindersManager showToast={addToast} />
                <CardErrorBoundary label="Sala & Cucina">
                  <SalaCucinaSettingsManager showToast={addToast} />
                </CardErrorBoundary>
                {/* Identità del tenant + documenti legali generati. */}
                <LegalSettingsCard showToast={addToast} />
              </div>
            </SettingsSection>

            {/* Tutto ciò che governa come nascono e si comportano le
                prenotazioni: canali di ingresso, risposte all'ospite, opzioni
                del modal, caparra, blacklist, logica tavoli. */}
            <SettingsSection id="imp-prenotazioni" label="Prenotazioni">
              <div className="space-y-3">
                {/* Solo il canale web: la scheda di Sofia sta nella sezione AI. */}
                <FeatureTogglesManager showToast={addToast} only="web" />
                <SettingsDisclosure
                  icon={MessagesSquare}
                  title="Canali di risposta"
                  description="Con quale strumento rispondere all'ospite per ogni fonte di prenotazione: ordine di priorità e fallback tra email, WhatsApp e SMS."
                >
                  <BookingChannelsManager showToast={addToast} />
                </SettingsDisclosure>
                <SettingsDisclosure
                  icon={StickyNote}
                  title="Note rapide prenotazione"
                  description="Chip suggeriti nel modal di prenotazione. Ogni nota può avere un'icona che appare nella card. Trascina per riordinare."
                >
                  <ReservationNotesManager showToast={addToast} />
                </SettingsDisclosure>

                <SettingsDisclosure
                  icon={AlertTriangle}
                  iconTone="pending"
                  title="Intolleranze"
                  description="Chip suggeriti nella sezione Intolleranze del modal prenotazione. Trascina per riordinare."
                >
                  <ReservationAllergensManager showToast={addToast} />
                </SettingsDisclosure>

                {/* Solo col modulo prenotazioni web nel piano: la caparra
                    automatica esiste soltanto per le web booking. */}
                {hasFeature('web_booking') && (
                  <SettingsDisclosure
                    icon={CreditCard}
                    iconTone="positive"
                    title="Caparra automatica"
                    description="Per le prenotazioni web sopra una certa soglia di coperti invia un link Revolut per la caparra (€10/persona) via SMS."
                  >
                    <AutoDepositManager showToast={addToast} />
                  </SettingsDisclosure>
                )}

                {/* Card #27: comportamento della blacklist deciso dal tenant,
                    fonte per fonte — niente più scelta hardcoded. */}
                <SettingsDisclosure
                  icon={Ban}
                  iconTone="pending"
                  title="Blacklist"
                  description="Per ogni fonte decidi se un numero in blacklist viene bloccato o entra con l'avviso allo staff."
                >
                  <BlacklistPolicyManager showToast={addToast} />
                </SettingsDisclosure>
              </div>
            </SettingsSection>

            {/* Gateway e regole dei pagamenti. */}
            <SettingsSection id="imp-pagamenti" label="Pagamenti">
              <div className="space-y-3">
                <div className="rounded-[20px] bg-[var(--ds-surface)] p-3 shadow-[var(--ds-shadow-card)]">
                  <div className="flex min-h-[40px] items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <SettingsIcon icon={CreditCard} />
                      <div className="min-w-0">
                        <h4 className="text-[15px] font-semibold text-[var(--ds-text-primary)]">Stripe Connect</h4>
                        <p className="text-[13px] text-[var(--ds-text-muted)]">Gateway di pagamento</p>
                      </div>
                    </div>
                    <StatusPill tone="positive" className="flex-shrink-0">
                      <span className="h-1.5 w-1.5 rounded-full bg-[var(--ds-seated-solid)]" aria-hidden />
                      Attivo (simulato)
                    </StatusPill>
                  </div>
                </div>
                <CardErrorBoundary label="Revolut">
                  <RevolutIntegrationCard showToast={addToast} />
                </CardErrorBoundary>
                <CardErrorBoundary label="SumUp">
                  <SumUpIntegrationCard showToast={addToast} />
                </CardErrorBoundary>
                {/* Add-on commerciale: senza pay_at_table nel piano la card
                    non compare (e il server maschera comunque il flag). */}
                {hasFeature('pay_at_table') && (
                  <CardErrorBoundary label="Conto al tavolo">
                    <PayAtTableSettingsManager showToast={addToast} />
                  </CardErrorBoundary>
                )}
                {/* Card #28: i link inviati e non pagati scadono da soli dopo
                    N ore, col messaggio delle prenotazioni non confermate. */}
                <SettingsDisclosure
                  icon={CreditCard}
                  iconTone="pending"
                  title="Scadenza link di pagamento"
                  description="Annulla da solo i link non pagati dopo una soglia di ore e avvisa il cliente che la prenotazione non è confermata."
                >
                  <PaymentLinkExpiryManager showToast={addToast} />
                </SettingsDisclosure>
              </div>
            </SettingsSection>

            {/* Tutta la fiscalità in un posto solo: dati dell'esercente,
                scontrino elettronico e aliquote. Esiste solo col conto al
                tavolo nel piano, perché l'emissione parte dalla sua
                chiusura (stesso gate del chip in SETTINGS_GROUPS). */}
            {hasFeature('pay_at_table') && (
              <SettingsSection id="imp-fiscalita" label="Fiscalità">
                <div className="space-y-3">
                  <CardErrorBoundary label="Fiscalità">
                    <FiscalSettingsManager showToast={addToast} />
                  </CardErrorBoundary>
                  {/* L'aliquota vive sul piatto: qui solo la strada per
                      arrivarci, non un doppione della regolazione. */}
                  {canAccessView(ViewState.MENU) && (
                    <SettingsNavCard
                      icon={Percent}
                      title="Aliquote IVA"
                      description="L'aliquota si imposta piatto per piatto nel menù (default 10%). Coperto e servizio al 10%."
                      onClick={() => { setMenuInitialTab('DISHES'); setView(ViewState.MENU); }}
                    />
                  )}
                </div>
              </SettingsSection>
            )}

            {/* I canali con cui il ristorante scrive e riceve: email in
                uscita e in entrata, allegati. Le risposte AI ai messaggi
                stanno nella sezione AI. */}
            <SettingsSection id="imp-comunicazioni" label="Comunicazioni">
              <div className="space-y-3">
                <CardErrorBoundary label="Server Email (SMTP)">
                  <SmtpIntegrationCard showToast={addToast} />
                </CardErrorBoundary>
                <CardErrorBoundary label="Ricezione Email (IMAP)">
                  <ImapIntegrationCard showToast={addToast} />
                </CardErrorBoundary>
                <CardErrorBoundary label="Media">
                  <MediaLibraryManager showToast={addToast} />
                </CardErrorBoundary>
              </div>
            </SettingsSection>

            {/* Tutto ciò che è guidato dall'AI in un posto solo: Sofia al
                telefono (con le sue regolazioni), le risposte AI ai messaggi
                WhatsApp e il prompt della logica tavoli. */}
            <SettingsSection id="imp-ai" label="AI">
              <div className="space-y-3">
                <FeatureTogglesManager showToast={addToast} only="voice" />
                <CardErrorBoundary label="Messaggi con AI">
                  <AiMessagesSettingsManager showToast={addToast} />
                </CardErrorBoundary>
                {/* Istruzioni testuali per una futura assegnazione tavoli
                    guidata da AI; oggi il testo è solo salvato. */}
                <CardErrorBoundary label="Prompt logica tavoli per AI">
                  <TableAssignmentAiPromptCard showToast={addToast} />
                </CardErrorBoundary>
              </div>
            </SettingsSection>

            {/* Utenti, ruoli e log: visibile solo a chi può usarne
                almeno una card. */}
            {(canManageUsers() || canViewLogs()) && (
              <SettingsSection id="imp-amministrazione" label="Amministrazione">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  {canManageUsers() && (
                    <>
                      <SettingsNavCard
                        icon={Users}
                        title="Gestione utenti"
                        description="Crea, modifica, elimina utenti"
                        onClick={() => setView(ViewState.USERS)}
                      />
                      <SettingsNavCard
                        icon={ShieldCheck}
                        title="Permessi ruoli"
                        description="Configura i permessi per ogni ruolo"
                        onClick={() => setShowRolePermissions(true)}
                      />
                    </>
                  )}
                  {canViewLogs() && (
                    <SettingsNavCard
                      icon={FileText}
                      title="Log attività"
                      description="Operazioni degli utenti"
                      onClick={() => setShowActivityLogs(true)}
                    />
                  )}
                </div>
              </SettingsSection>
            )}
          </div>
          </div>
          </div>
          </CardErrorBoundary>
        )}

        </div>{/* /view container */}

        {/* Bottom Navigation - Visible only on mobile */}
        {/* Floating bottom bar — a card on the canvas, matching the desktop
            chrome. Offset by the safe-area inset so it clears the iOS home
            indicator instead of sitting under it. */}
        {/* Sparisce quando una schermata chiede tutto lo schermo: dentro una
            comanda il pollice lavora sul piatto e sull'Invia, e la barra di
            navigazione sotto sarebbe solo un bersaglio per uscire per sbaglio
            dal tavolo aperto. Si torna indietro con la freccia in testata. */}
        <nav
          className={`fixed left-4 right-4 rounded-[28px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] lg:hidden z-30 ${
            immersive ? 'hidden' : ''
          }`}
          style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
          aria-label="Navigazione mobile"
        >
          <div className="flex items-stretch py-2 px-2 gap-1">
            {view !== ViewState.PLATFORM && canAccessView(ViewState.DASHBOARD) && (
              <BottomNavItem
                icon={<LayoutDashboard size={20} />}
                label="Dashboard"
                active={view === ViewState.DASHBOARD}
                onClick={() => {
                  // Mirror the desktop sidebar behaviour: snap globalDate to
                  // today when arriving on Dashboard from another view so the
                  // live-service hero, KPIs and Stato Tavoli describe now.
                  if (view !== ViewState.DASHBOARD) {
                    const today = new Date();
                    if (globalDate.toDateString() !== today.toDateString()) setGlobalDate(today);
                  }
                  setView(ViewState.DASHBOARD);
                }}
              />
            )}
            {view !== ViewState.PLATFORM && canAccessView(ViewState.RESERVATIONS) && (
              <BottomNavItem
                icon={<Calendar size={20} />}
                label="Prenotazioni"
                active={view === ViewState.RESERVATIONS}
                onClick={() => setView(ViewState.RESERVATIONS)}
              />
            )}
            {/* Center "+" — circular, raised above the nav — opens context-aware action sheet.
                Nascosto sulla vista Piattaforma: le azioni rapide creano dati
                del tenant dell'admin, non dei clienti del SaaS. */}
            {view !== ViewState.PLATFORM && <div className="flex-1 flex justify-center items-end">
              <button
                type="button"
                onClick={() => setShowCreateSheet(v => !v)}
                aria-label="Crea nuovo"
                className="h-14 w-14 -translate-y-4 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-raised)] flex items-center justify-center active:scale-95 transition-all ring-4 ring-[var(--ds-canvas)]"
              >
                <Plus className="h-6 w-6 transition-transform duration-200" style={{ transform: showCreateSheet ? 'rotate(45deg)' : 'rotate(0deg)' }} />
              </button>
            </div>}
            {/* Comunicazioni replaces the old Notifiche tab, which duplicated
                the top-bar bell. The badge rolls up all three channels. */}
            {view !== ViewState.PLATFORM && commsTargetView !== undefined && (
              <BottomNavItem
                icon={<MessagesSquare size={20} />}
                label="Comunicazioni"
                active={isCommsView}
                badge={commsBadgeTotal}
                onClick={() => setView(commsTargetView)}
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
              className="fixed inset-0 z-[29] lg:hidden bg-[var(--ds-backdrop)]"
              style={{ animation: 'fadeIn 280ms ease-out both' }}
              onClick={() => setShowCreateSheet(false)}
            />
            {/* Floating card that sits ABOVE the bottom bar rather than behind
                it — anchored to the same --ds-bottom-nav-clear the scroll
                region uses, so it always clears the bar and the raised "+". */}
            <div
              className="fixed left-4 right-4 z-[29] lg:hidden bg-[var(--ds-surface)] rounded-[28px] shadow-[var(--ds-shadow-raised)]"
              style={{ bottom: 'var(--ds-bottom-nav-clear)', animation: 'slideUpBehindNav 280ms ease-out both' }}
            >
              <div className="p-5 grid grid-cols-2 gap-4 justify-items-center">
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
                    <div className="w-20 h-20 rounded-[20px] bg-[var(--ds-surface-row)] flex items-center justify-center text-[var(--ds-text-primary)]">
                      {tile.icon}
                    </div>
                    <span className="text-[13px] font-semibold text-[var(--ds-text-primary)]">{tile.label}</span>
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
              className="absolute inset-0 bg-[var(--ds-backdrop)]"
              onClick={() => setShowMoreMenu(false)}
            />
 <div className="absolute bottom-0 left-0 right-0 max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] flex flex-col bg-[var(--ds-surface)] rounded-t-[28px] shadow-[var(--ds-shadow-raised)] duration-200">
              <div className="flex-shrink-0 bg-[var(--ds-surface)] rounded-t-[28px]">
                <div className="flex justify-center pt-3 pb-1">
                  <div className="w-10 h-1 rounded-full bg-[var(--ds-border-strong)]" />
                </div>
                <div className="px-4 pb-2 pt-1 flex items-center justify-between">
                  <h3 className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">Altro</h3>
                  <button onClick={() => setShowMoreMenu(false)} className="h-9 w-9 inline-flex items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)] transition-colors" aria-label="Chiudi">
                    <X className="h-[18px] w-[18px]" />
                  </button>
                </div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain">
              {/* User identity card — tocco: apre il profilo self-service */}
              <button
                onClick={() => { setShowMoreMenu(false); setShowProfilo(true); }}
                className="mx-4 mb-2 p-3 rounded-[16px] bg-[var(--ds-surface-row)] flex items-center gap-3 w-[calc(100%-2rem)] text-left"
              >
                <div className="w-10 h-10 rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] flex items-center justify-center text-[13px] font-medium shrink-0">
                  {user?.full_name?.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase() || 'U'}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[15px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)] truncate">{user?.full_name || 'Utente'}</p>
                  <p className="text-[13px] text-[var(--ds-text-muted)] truncate">{user?.role ? getRoleDisplayName(user.role) : ''}</p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-[var(--ds-text-subtle)]" />
              </button>
              <div className="px-2 pb-2">
                {NAV_GROUPS.filter(group => group.id !== 'sistema').map(group => {
                  const items = NAV_ITEMS.filter(item => item.group === group.id && !item.isTab && item.kind === 'link' && canSeeNavItem(item));
                  if (items.length === 0) return null;
                  return (
                    <React.Fragment key={group.id}>
                      <div className="px-3 pt-4 pb-1 text-[13px] font-medium text-[var(--ds-text-muted)]">
                        {group.label}
                      </div>
                      {items.map(item => {
                        const badge =
                          item.view === ViewState.CONVERSAZIONI ? voiceCallsPendingCount
                          : item.view === ViewState.MESSAGGI ? messagesUnreadCount
                          : item.view === ViewState.CHAT_STAFF ? staffChatUnreadCount
                          : item.view === ViewState.EMAIL ? emailUnreadCount
                          : item.view === ViewState.NOTIFICHE ? notificationsUnreadCount
                          : item.view === ViewState.PAGAMENTI ? paymentsUnseenCount
                          : 0;
                        return (
                        <button
                          key={item.label}
                          onClick={() => { setShowMoreMenu(false); if (item.view !== undefined) setView(item.view); }}
                          className={`w-full flex items-center gap-3 px-3 h-12 rounded-[14px] transition-colors ${item.view !== undefined && view === item.view ? 'bg-[var(--ds-surface-row)]' : ''}`}
                        >
                          <item.Icon className="h-5 w-5 text-[var(--ds-text-secondary)]" />
                          <span className="text-[15px] font-medium tracking-[-0.01em] text-[var(--ds-text-primary)]">{item.label}</span>
                          {badge > 0 && (
                            <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[11px] font-semibold tabular-nums flex items-center justify-center">
                              {badge > 99 ? '99+' : badge}
                            </span>
                          )}
                          <ChevronRight className={`${badge > 0 ? '' : 'ml-auto'} h-4 w-4 text-[var(--ds-text-subtle)]`} />
                        </button>
                        );
                      })}
                    </React.Fragment>
                  );
                })}
              </div>
              <div className="px-2 pb-6 pt-2 mt-2 border-t border-[var(--ds-border)]">
                {NAV_ITEMS.filter(item => item.group === 'sistema' && item.kind === 'link' && canSeeNavItem(item)).map(item => (
                  <button
                    key={item.label}
                    onClick={() => { setShowMoreMenu(false); if (item.view !== undefined) setView(item.view); }}
                    className={`w-full flex items-center gap-3 px-3 h-12 rounded-[14px] transition-colors ${item.view !== undefined && view === item.view ? 'bg-[var(--ds-surface-row)]' : ''}`}
                  >
                    <item.Icon className="h-5 w-5 text-[var(--ds-text-secondary)]" />
                    <span className="text-[15px] font-medium tracking-[-0.01em] text-[var(--ds-text-primary)]">{item.label}</span>
                    <ChevronRight className="ml-auto h-4 w-4 text-[var(--ds-text-subtle)]" />
                  </button>
                ))}
                <button
                  type="button"
                  onClick={toggleTheme}
                  aria-pressed={theme === 'dark'}
                  className="w-full flex items-center gap-3 px-3 h-12 rounded-[14px] transition-colors"
                >
                  {theme === 'dark' ? <Sun className="h-5 w-5 text-[var(--ds-text-secondary)]" /> : <Moon className="h-5 w-5 text-[var(--ds-text-secondary)]" />}
                  <span className="text-[15px] font-medium tracking-[-0.01em] text-[var(--ds-text-primary)]">Modalità scura</span>
                  <span
                    aria-hidden
                    className={`ml-auto relative inline-flex h-[26px] w-11 shrink-0 items-center rounded-full transition-colors ${theme === 'dark' ? 'bg-[var(--ds-action-bg)]' : 'bg-[var(--ds-border-strong)]'}`}
                  >
                    <span
                      className={`inline-block h-[22px] w-[22px] transform rounded-full bg-[var(--ds-surface)] shadow transition-transform ${theme === 'dark' ? 'translate-x-[20px]' : 'translate-x-0.5'}`}
                    />
                  </span>
                </button>
                <button
                  onClick={() => { setShowMoreMenu(false); logout(); }}
                  className="w-full flex items-center gap-3 px-3 h-12 rounded-[14px] text-[var(--ds-critical-text)] transition-colors"
                >
                  <LogOut className="h-5 w-5" />
                  <span className="text-[15px] font-medium tracking-[-0.01em]">Esci</span>
                </button>
              </div>
              </div>
            </div>
          </div>
        )}

        {/* Profilo self-service — nome, telefono, password, email */}
        <ProfiloSheet
          open={showProfilo}
          onClose={() => setShowProfilo(false)}
          roleLabel={user?.role ? getRoleDisplayName(user.role) : ''}
        />

        {/* ElevenLabs voice-agent widget — temporarily hidden, will be
            re-enabled in the future. Component and import preserved. */}
        {false && user?.role === UserRole.OWNER && <VoiceAgentWidget />}

        {/* Global command palette — Cmd/Ctrl+K anywhere in the app. On
            selecting a reservation we jump to the Prenotazioni view for that
            date and open its detail drawer; on selecting a customer we
            open the Clienti view with their edit modal (matched by phone). */}
        <CommandPalette
          isOpen={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          reservations={reservations}
          onSelectReservation={(res) => {
            const dateOnly = getRomeDatePart(res.reservation_time);
            const [y, m, d] = dateOnly.split('-').map(Number);
            if (y && m && d) setGlobalDate(new Date(y, m - 1, d));
            setPendingReservationId(res.id);
            setView(ViewState.RESERVATIONS);
            setPaletteOpen(false);
          }}
          onSelectCustomer={(customer) => {
            if (customer.phone) {
              setAutoEditCustomerByPhone(customer.phone);
            }
            setView(ViewState.CLIENTI);
            setPaletteOpen(false);
          }}
        />

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
                    ? { iconText: 'text-[var(--ds-seated-text)]' }
                    : toast.type === 'error'
                    ? { iconText: 'text-[var(--ds-critical-text)]' }
                    : { iconText: 'text-[var(--ds-text-primary)]' };
                return (
                    <div
                        key={toast.id}
                        role={toast.type === 'error' ? 'alert' : undefined}
 className={`bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)] border border-[var(--ds-border)] rounded-lg duration-300 ${
                            hasDetails ? 'p-3.5 min-w-[300px] sm:min-w-[360px]' : 'flex items-center gap-2.5 px-3.5 py-2.5'
                        }`}
                    >
                        {hasDetails ? (
                            <div className="flex items-start gap-3">
                                <div className={`p-1.5 rounded-md bg-[var(--ds-surface-row)] ${accent.iconText} flex-shrink-0`}>
                                    {toast.type === 'success' && <CheckCircle className="h-4 w-4" />}
                                    {toast.type === 'error' && <AlertTriangle className="h-4 w-4" />}
                                    {toast.type === 'info' && <Info className="h-4 w-4" />}
                                </div>
                                <div className="flex-1 min-w-0">
                                    {toast.title && (
                                        <p className="text-[13px] font-semibold text-[var(--ds-text-primary)] mb-0.5">{toast.title}</p>
                                    )}
                                    <p className="text-sm font-medium text-[var(--ds-text-primary)] mb-1">{toast.message}</p>
                                    <ul className="space-y-0.5">
                                        {toast.details!.map((d, i) => (
                                            <li key={i} className="text-[13px] text-[var(--ds-text-muted)] leading-snug">{d}</li>
                                        ))}
                                    </ul>
                                    {toast.action && (
                                        <button
                                            type="button"
                                            onClick={() => {
                                                toast.action!.onClick();
                                                setToasts(prev => prev.filter(t => t.id !== toast.id));
                                            }}
                                            className={`mt-2 px-3 py-1.5 text-xs font-semibold rounded-md bg-[var(--ds-surface-row)] ${accent.iconText} hover:opacity-80`}
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
                                <span className="text-[13px] font-medium text-[var(--ds-text-primary)] flex-1">{toast.message}</span>
                                {toast.action && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            toast.action!.onClick();
                                            setToasts(prev => prev.filter(t => t.id !== toast.id));
                                        }}
                                        className={`px-3 py-1 text-xs font-semibold rounded-md bg-[var(--ds-surface-row)] ${accent.iconText} hover:opacity-80 flex-shrink-0`}
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
    className={`w-full flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 h-10 rounded-[12px] transition-colors duration-150 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-surface)] ${
      active
        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
        : 'text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]'
    }`}
  >
    <span className={`relative ${active ? 'text-[var(--ds-action-fg)]' : 'text-[var(--ds-text-secondary)]'}`}>
      {icon}
      {collapsed && badge != null && badge > 0 && (
        <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 inline-flex items-center justify-center rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[10px] font-semibold leading-none tabular-nums ring-2 ring-[var(--ds-surface)]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
    {!collapsed && (
      <>
        <span className="font-medium text-[15px] tracking-[-0.01em]">{label}</span>
        {badge != null && badge > 0 && (
          <span className="ml-auto min-w-[20px] h-5 px-1.5 inline-flex items-center justify-center rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[11px] font-semibold leading-none tabular-nums">
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
    aria-label={label}
    className={`pressable flex flex-1 flex-col items-center justify-center gap-1 px-1 py-1.5 max-[420px]:py-[13px] rounded-[14px] transition-colors ${
      active
        ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)]'
        : 'text-[var(--ds-text-muted)]'
    }`}
  >
    {/* Icon-only mode trades labels for a bit more icon: 20 → 24px. */}
    <span className="relative max-[420px]:[&>svg]:size-6">
      {icon}
      {badge !== undefined && badge > 0 && (
        <span className="absolute -top-1.5 -right-2 min-w-[16px] h-4 px-1 rounded-full bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)] text-[9px] font-semibold tabular-nums flex items-center justify-center ring-2 ring-[var(--ds-surface)]">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </span>
    {/* On narrow phones (iPhone SE, ~Pixel/Xiaomi widths) four labels plus
        the raised "+" don't fit and the last one clips past the card edge —
        below 420px the bar goes icon-only (aria-label keeps the name). */}
    <span className={`text-[11px] whitespace-nowrap max-[420px]:hidden ${active ? 'font-semibold' : 'font-medium'}`}>
      {label}
    </span>
  </button>
);

export default App;