

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Dish, RestaurantMenu, BanquetMenu, BanquetCourse, BanquetStatus, Shift, COMMON_ALLERGENS, VAT_RATES, Customer, Table, TableMerge, Reservation, ArrivalStatus, ReservationStatus, Room } from '../types';
import { Plus, Search, Tag, Trash2, Edit2, Utensils, BookOpen, Check, Calendar, List as ListIcon, LayoutGrid, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, ArrowUpDown, Printer, ImageIcon, X, Sun, Sunset, Users, StickyNote, BookUser, Phone, Mail, Upload, Loader2, Wallet, MoreHorizontal, ChefHat, Info, RefreshCw, QrCode, Copy, Languages, Layers, SlidersHorizontal, Share2, MessageCircle } from 'lucide-react';
import { resizeImageToDataUrl } from '../utils/resizeImage';
import { getRomeDatePart } from '../utils/reservationTime';
import { printBanquet } from '../utils/printBanquet';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { BanquetCompositionModal } from './BanquetCompositionModal';
import { BanquetPaymentsModal } from './BanquetPaymentsModal';
import { DishDetailModal } from './DishDetailModal';
import { CustomerPickerModal } from './CustomerPickerModal';
import { getCustomers, getTableMerges, importMenuPassepartout, translateMenu, digitalMenuUrl, getFeatureFlags, updateFeatureFlags, getMenuCategories, saveMenuCategories, saveDishOrder, setDishEnabled, createMenu, renameMenu, deleteMenu, setBanquetStatus, setCategoryMenu, createMenuCategory, renameMenuCategory, deleteMenuCategory, getBanquetShareLink, sendBanquetQuoteEmail, sendBanquetQuoteWhatsApp, getModifierGroups, getDishComponents, type AdminModifierGroup, type MenuImportResult, type MenuTranslateResult, type MenuCategory } from '../services/apiService';
import { socketClient } from '../services/socketClient';
import { MenuVariantsModal } from './MenuVariantsModal';
import { billsApiService } from '../services/billsApiService';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../contexts/AuthContext';
import { saveDraft, loadDraft, clearDraft, DRAFT_KEYS } from '../services/draftService';
import {
  SegmentedControl, SearchField, SectionHeader, StatusPill, Callout, EmptyState,
  ModalShell, FormCard, Field, Stepper, StepNav, useMediaQuery,
  dsInput, dsSelect, dsTextarea, dsButton, dsIconButton, dsStepArrow,
} from './ds';

const BANQUET_DISH_CATEGORIES = ['Antipasti', 'Primi', 'Secondi', 'Contorni', 'Dolci', 'Bevande'] as const;

const ITALIAN_MONTHS = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno', 'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];
const ITALIAN_WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];

const formatLocalDate = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
};

type BanquetTimeStatus = 'PAST' | 'UPCOMING';

const computeBanquetTimeStatus = (menu: BanquetMenu): BanquetTimeStatus => {
    if (!menu.event_date) return 'UPCOMING';
    const today = formatLocalDate(new Date());
    return menu.event_date < today ? 'PAST' : 'UPCOMING';
};

type BanquetPaymentStatus = 'UNPAID' | 'PARTIAL' | 'PAID';

export const computeBanquetDiscountAmount = (menu: BanquetMenu, gross: number): number => {
    if (!menu.discount_type || menu.discount_value == null) return 0;
    const v = Number(menu.discount_value);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (menu.discount_type === 'PERCENT') return Math.min(gross, gross * (v / 100));
    return Math.min(gross, v);
};

export const computeBanquetGrossTotal = (menu: BanquetMenu): number => {
    const guests = Number(menu.guests || 0);
    const children = Number(menu.children || 0);
    const adults = Math.max(0, guests - children);
    const adultPrice = Number(menu.price_per_person || 0);
    const childPrice = menu.children_price != null ? Number(menu.children_price) : adultPrice;
    return (adults * adultPrice) + (children * childPrice);
};

export const computeBanquetTotalDue = (menu: BanquetMenu): number => {
    const gross = computeBanquetGrossTotal(menu);
    const discount = computeBanquetDiscountAmount(menu, gross);
    return Math.max(0, gross - discount);
};

const computeBanquetPaymentStatus = (menu: BanquetMenu): BanquetPaymentStatus => {
    const paid = Number(menu.total_paid || 0);
    const due = computeBanquetTotalDue(menu);
    if (paid <= 0) return 'UNPAID';
    if (due > 0 && paid + 0.005 >= due) return 'PAID';
    return 'PARTIAL';
};

/* ── Date bucketing for the banquet list ──────────────────────────────────
   Four buckets, not the three the mockup shows: an event later than this
   month still has to land somewhere, and dropping it silently would make the
   list quietly lie about how many banquets exist. */
type BanquetGroupKey = 'week' | 'month' | 'later' | 'past';

const BANQUET_GROUP_LABEL: Record<BanquetGroupKey, string> = {
  week:  'Questa settimana',
  month: 'Questo mese',
  later: 'Più avanti',
  past:  'Passati',
};

// Monday-based, matching the Italian week the restaurant plans around.
const endOfCurrentWeek = (from: Date): string => {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const offsetToSunday = (7 - (d.getDay() || 7)); // getDay(): 0 = Sunday
  d.setDate(d.getDate() + offsetToSunday);
  return formatLocalDate(d);
};

const endOfCurrentMonth = (from: Date): string =>
  formatLocalDate(new Date(from.getFullYear(), from.getMonth() + 1, 0));

/* ── Quanto urge il saldo ─────────────────────────────────────────────────
   Un banchetto nasce sempre non pagato, quindi "manca l'incasso" da solo non
   dice niente: dipingerlo di rosso vorrebbe dire una lista rossa dal primo
   giorno, e un rosso sempre acceso smette di essere un segnale. È il
   calendario a decidere — la stessa idea di `getTimedReservationState`, dove
   lo stato si carica avvicinandosi all'ora.

   `pending` finché l'evento è lontano: c'è da incassare, con calma.
   `critical` da fine settimana in giù, passati compresi (una data già scaduta
   è <= weekEnd): sta per succedere, o è successo, e i soldi non ci sono.

   Senza data non è imminente per definizione, quindi resta `pending`. */
const isOutstandingUrgent = (menu: BanquetMenu, weekEnd: string): boolean =>
  !!menu.event_date && menu.event_date <= weekEnd;

const banquetGroupFor = (menu: BanquetMenu, today: string, weekEnd: string, monthEnd: string): BanquetGroupKey => {
  const date = menu.event_date;
  // No date yet: it is still being planned, so it belongs with what is coming
  // rather than disappearing into the past.
  if (!date) return 'week';
  if (date < today) return 'past';
  if (date <= weekEnd) return 'week';
  if (date <= monthEnd) return 'month';
  return 'later';
};

/* ── Form steps ───────────────────────────────────────────────────────────
   The same six sections the form has always had, regrouped into five screens
   (cliente and evento share one). Steps never gate each other: you can jump
   anywhere from the header, and the required-field check still runs once, on
   save, exactly as it did when this was a single scroll. */
const BANQUET_STEPS = [
  { label: 'Evento e cliente', hint: 'nome interno, data, turno e chi lo ha richiesto', icon: BookUser },
  { label: 'Coperti e tariffa', hint: 'un prezzo bambini separa il calcolo', icon: Users },
  { label: 'Composizione menù', hint: 'clicca un piatto per aggiungerlo all\'uscita attiva', icon: Utensils },
  { label: 'Tavoli assegnati', hint: 'i tavoli occupati nello stesso turno sono disabilitati', icon: LayoutGrid },
  { label: 'Note operative', hint: 'compaiono nelle stampe per cucina e sala', icon: StickyNote },
] as const;

// Category filters on Piatti alla carta. There are more of these than a
// SegmentedControl should hold, so they stay individual pills on a wrapping row.
// 32px, the dense-desktop touch target — these sit in a filter row above a
// grid, not in a primary action position, and at 44px they outweighed the
// cards they filter.
const DISH_FILTER_BASE =
  'inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const DISH_FILTER_ON = 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]';
const DISH_FILTER_OFF =
  'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] hover:text-[var(--ds-text-primary)]';

const formatEuro = (n: number): string =>
  new Intl.NumberFormat('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(Math.round(n));

interface MenuManagerProps {
  /* Quale metà mostrare: DISHES è la pagina Menu (piatti nei vari menu),
     BANQUETS la pagina Banchetti (gli eventi). Un componente solo perché
     condividono anagrafiche, wizard e modali. */
  mode: 'DISHES' | 'BANQUETS';
  dishes: Dish[];
  menus: RestaurantMenu[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  reservations: Reservation[];
  onAddDish: (dish: Omit<Dish, 'id'>) => void;
  onUpdateDish: (id: number, dish: Partial<Dish>) => void;
  onDeleteDish: (id: number) => void;
  onAddBanquetMenu: (menu: Omit<BanquetMenu, 'id'>) => void;
  onUpdateBanquetMenu: (id: number, menu: Partial<BanquetMenu>) => void;
  onDeleteBanquetMenu: (id: number) => void;
  canEdit?: boolean;
  autoOpenNewBanquet?: boolean;
  onAutoOpenNewBanquetHandled?: () => void;
  autoOpenNewDish?: boolean;
  onAutoOpenNewDishHandled?: () => void;
}

export const MenuManager: React.FC<MenuManagerProps> = ({
    mode,
    dishes,
    menus,
    banquetMenus,
    tables,
    rooms,
    reservations,
    onAddDish,
    onUpdateDish,
    onDeleteDish,
    onAddBanquetMenu,
    onUpdateBanquetMenu,
    onDeleteBanquetMenu,
    canEdit = true,
    autoOpenNewBanquet,
    onAutoOpenNewBanquetHandled,
    autoOpenNewDish,
    onAutoOpenNewDishHandled
}) => {
  const { hasPermission, hasFeature } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const canManageBanquetPayments = hasPermission('banquet:manage_payments');
  // Import dalla cassa Passepartout: entitlement del solo ristorante col
  // gestionale (oggi Vecchio Frantoio). Gli altri tenant non vedono il bottone.
  const canImportCassa = canEdit && hasFeature('passepartout');
  const [importing, setImporting] = useState(false);
  const [importEsito, setImportEsito] = useState<MenuImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Categorie del menu: accensione e ordine si decidono qui e valgono anche
  // per il palmare comande e il menu digitale. Il rifetch segue l'anagrafica
  // piatti (socket, import cassa), così i conteggi non restano indietro.
  const [menuCats, setMenuCats] = useState<MenuCategory[] | null>(null);
  const [catsOpen, setCatsOpen] = useState(false);
  const [catsBusy, setCatsBusy] = useState(false);
  const [togglingDishId, setTogglingDishId] = useState<number | null>(null);
  // CRUD delle categorie (modale Categorie): crea, rinomina, elimina.
  const [catForm, setCatForm] = useState<{ kind: 'create' } | { kind: 'rename'; name: string } | null>(null);
  const [catFormName, setCatFormName] = useState('');
  const [catFormBusy, setCatFormBusy] = useState(false);
  const [catFormError, setCatFormError] = useState<string | null>(null);
  const [deleteCatConfirm, setDeleteCatConfirm] = useState<string | null>(null);

  const refreshMenuCats = () => { getMenuCategories().then(setMenuCats).catch(() => {}); };

  // Gruppi di varianti: la lista è del padre, condivisa fra la modale
  // «Varianti» e le chip nell'editor piatto. Solo con menu:full — la GET è
  // protetta come tutte le scritture del menu.
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [modifierGroups, setModifierGroups] = useState<AdminModifierGroup[]>([]);
  const refreshModifierGroups = React.useCallback(() => {
    if (canEdit) getModifierGroups().then(setModifierGroups).catch(() => {});
  }, [canEdit]);
  useEffect(() => { refreshModifierGroups(); }, [refreshModifierGroups]);
  // Un'altra postazione tocca le varianti → il server emette
  // catalogue:updated e qui la lista si riallinea da sola.
  useEffect(() => {
    const s = socketClient.getSocket();
    if (!s) return;
    const onCatalogue = () => refreshModifierGroups();
    s.on('catalogue:updated', onCatalogue);
    return () => { s.off('catalogue:updated', onCatalogue); };
  }, [refreshModifierGroups]);

  const submitCatForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = catFormName.trim();
    if (!catForm || !name || catFormBusy) return;
    setCatFormBusy(true);
    setCatFormError(null);
    try {
      if (catForm.kind === 'create') await createMenuCategory(name);
      else await renameMenuCategory(catForm.name, name);
      setCatForm(null);
      setCatFormName('');
      // I piatti arrivano dal socket; l'elenco categorie si aggiorna subito
      // (una categoria vuota non muove l'anagrafica piatti).
      refreshMenuCats();
    } catch (err: any) {
      setCatFormError(err?.data?.error ?? err?.message ?? 'Salvataggio non riuscito');
    } finally {
      setCatFormBusy(false);
    }
  };

  const handleDeleteCategory = async (name: string) => {
    try {
      await deleteMenuCategory(name);
      refreshMenuCats();
    } catch { /* la categoria resta: nessun falso ok */ }
    setDeleteCatConfirm(null);
  };

  // Spunta di menu su una categoria (modale Categorie): chiave `nome|menuId`.
  const [catMenuBusy, setCatMenuBusy] = useState<string | null>(null);
  const handleToggleCategoryMenu = async (catName: string, menuId: number, member: boolean) => {
    setCatMenuBusy(`${catName}|${menuId}`);
    try {
      // Il server applica in blocco e broadcasta 'dish:synced': i piatti si
      // ricaricano via App e le pill si riallineano da sole.
      await setCategoryMenu(catName, menuId, member);
    } catch { /* le pill restano com'erano: nessun falso ok */ }
    finally { setCatMenuBusy(null); }
  };
  const [reorderBusy, setReorderBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    getMenuCategories().then(c => { if (!cancelled) setMenuCats(c); }).catch(() => {});
    return () => { cancelled = true; };
  }, [dishes]);

  const handleToggleDish = async (dish: Dish) => {
    setTogglingDishId(dish.id);
    try {
      // La riga aggiornata torna dal socket (dish:updated → App): qui non
      // c'è stato locale da tenere allineato.
      await setDishEnabled(dish.id, dish.crm_enabled === false);
    } catch { /* la riga resta com'era: nessun falso ok */ }
    finally { setTogglingDishId(null); }
  };

  // Sposta un piatto su/giù dentro la SUA categoria intera (non la lista
  // filtrata dalla ricerca): l'ordine è del menu, non della vista.
  const handleMoveDish = async (dish: Dish, dir: -1 | 1) => {
    const cat = (dish.category ?? '').trim();
    const group = dishes.filter(d => (d.category ?? '').trim() === cat);
    const idx = group.findIndex(d => d.id === dish.id);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= group.length) return;
    const ids = group.map(d => d.id);
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    setReorderBusy(true);
    try { await saveDishOrder(ids); } catch { /* ordine invariato */ }
    finally { setReorderBusy(false); }
  };

  // Le modifiche alle categorie salvano subito (come gli altri interruttori
  // dell'app): l'ordine dell'array È l'ordine del menu.
  const applyMenuCats = async (next: MenuCategory[]) => {
    const prev = menuCats;
    setMenuCats(next);
    setCatsBusy(true);
    try {
      await saveMenuCategories(next.map(c => ({ name: c.name, enabled: c.enabled })));
    } catch {
      setMenuCats(prev);
    } finally {
      setCatsBusy(false);
    }
  };

  const handleImportCassa = async () => {
    if (importing) return;
    setImporting(true);
    setImportEsito(null);
    setImportError(null);
    try {
      // La lista si aggiorna da sola via socket 'dish:synced'.
      setImportEsito(await importMenuPassepartout());
    } catch (err: any) {
      setImportError(err?.data?.message ?? err?.data?.error ?? err?.message ?? 'Import non riuscito');
    } finally {
      setImporting(false);
    }
  };

  // Menu digitale: QR pubblico, interruttore del flag e traduzioni AI.
  const [qrOpen, setQrOpen] = useState(false);
  const [menuAttivo, setMenuAttivo] = useState<boolean | null>(null);
  const [menuFlagBusy, setMenuFlagBusy] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translateEsito, setTranslateEsito] = useState<MenuTranslateResult | null>(null);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const [linkCopiato, setLinkCopiato] = useState(false);
  const menuUrl = digitalMenuUrl();

  useEffect(() => {
    if (!qrOpen) return;
    let cancelled = false;
    getFeatureFlags()
      .then(f => { if (!cancelled) setMenuAttivo(f.digital_menu_enabled === true); })
      .catch(() => { if (!cancelled) setMenuAttivo(null); });
    return () => { cancelled = true; };
  }, [qrOpen]);

  const toggleMenuDigitale = async () => {
    if (menuFlagBusy || menuAttivo == null) return;
    setMenuFlagBusy(true);
    try {
      const updated = await updateFeatureFlags({ digital_menu_enabled: !menuAttivo });
      setMenuAttivo(updated.digital_menu_enabled === true);
    } catch (_) {
      /* lo stato resta quello vero: al prossimo open si ricarica */
    } finally {
      setMenuFlagBusy(false);
    }
  };

  const handleTranslate = async () => {
    if (translating) return;
    setTranslating(true);
    setTranslateEsito(null);
    setTranslateError(null);
    try {
      setTranslateEsito(await translateMenu());
    } catch (err: any) {
      setTranslateError(err?.data?.message ?? err?.data?.error ?? err?.message ?? 'Traduzione non riuscita');
    } finally {
      setTranslating(false);
    }
  };

  const copiaLinkMenu = () => {
    navigator.clipboard?.writeText(menuUrl).then(() => {
      setLinkCopiato(true);
      setTimeout(() => setLinkCopiato(false), 2000);
    }).catch(() => {});
  };

  const activeTab = mode;

  // I due menu di sistema: ALLA_CARTA governa comande e menu digitale,
  // BANQUETS il picker della composizione banchetti.
  const cartaMenu = useMemo(() => menus.find(m => m.system_key === 'ALLA_CARTA') ?? null, [menus]);
  const banquetsMenu = useMemo(() => menus.find(m => m.system_key === 'BANQUETS') ?? null, [menus]);

  // Menu selezionato nella pagina Menu. Se quello selezionato sparisce
  // (eliminato da un altro client) si ricade su Alla carta via fallback.
  const [selectedMenuId, setSelectedMenuId] = useState<number | null>(null);
  const selectedMenu = menus.find(m => m.id === selectedMenuId) ?? cartaMenu;
  useEffect(() => {
    if (selectedMenuId == null && cartaMenu) setSelectedMenuId(cartaMenu.id);
  }, [selectedMenuId, cartaMenu]);
  const inSelectedMenu = (d: Dish): boolean =>
    selectedMenu == null || (d.menu_ids ?? []).includes(selectedMenu.id);
  const menuDishes = useMemo(
    () => (selectedMenu == null ? dishes : dishes.filter(d => (d.menu_ids ?? []).includes(selectedMenu.id)))
      // allergens può arrivare NULL dal DB (piatto creato via API senza il
      // campo): senza questa normalizzazione i conteggi e le pill in lista
      // fanno cadere l'intera pagina su .length.
      .map(d => (d.allergens ? d : { ...d, allergens: [] })),
    [dishes, selectedMenu]
  );

  // Creazione/rinomina dei menu stagionali (i due di sistema non si toccano).
  const [menuForm, setMenuForm] = useState<{ kind: 'create' } | { kind: 'rename'; menu: RestaurantMenu } | null>(null);
  const [menuFormName, setMenuFormName] = useState('');
  const [menuFormBusy, setMenuFormBusy] = useState(false);
  const [menuFormError, setMenuFormError] = useState<string | null>(null);
  const [deleteMenuConfirm, setDeleteMenuConfirm] = useState<RestaurantMenu | null>(null);

  const submitMenuForm = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = menuFormName.trim();
    if (!menuForm || !name || menuFormBusy) return;
    setMenuFormBusy(true);
    setMenuFormError(null);
    try {
      if (menuForm.kind === 'create') {
        const created = await createMenu(name);
        // La lista arriva via socket 'menu:created'; qui si seleziona subito.
        setSelectedMenuId(created.id);
      } else {
        await renameMenu(menuForm.menu.id, name);
      }
      setMenuForm(null);
      setMenuFormName('');
    } catch (err: any) {
      setMenuFormError(err?.data?.error ?? err?.message ?? 'Salvataggio non riuscito');
    } finally {
      setMenuFormBusy(false);
    }
  };

  const handleDeleteMenu = async (menu: RestaurantMenu) => {
    try {
      await deleteMenu(menu.id);
      if (selectedMenuId === menu.id) setSelectedMenuId(cartaMenu?.id ?? null);
    } catch { /* il menu resta: nessun falso ok */ }
    setDeleteMenuConfirm(null);
  };

  // Pagina Banchetti: preventivi e confermati sono due liste. Un evento
  // senza status (dati pre-migrazione ancora in cache) conta da confermato.
  const banquetStatusOf = (b: BanquetMenu): 'QUOTE' | 'CONFIRMED' =>
    b.status === BanquetStatus.QUOTE ? 'QUOTE' : 'CONFIRMED';
  const [banquetStatusFilter, setBanquetStatusFilter] = useState<'CONFIRMED' | 'QUOTE'>('CONFIRMED');
  const statusBanquets = useMemo(
    () => banquetMenus.filter(b => banquetStatusOf(b) === banquetStatusFilter),
    [banquetMenus, banquetStatusFilter]
  );
  const quoteCount = useMemo(() => banquetMenus.filter(b => banquetStatusOf(b) === 'QUOTE').length, [banquetMenus]);
  const [statusBusyId, setStatusBusyId] = useState<number | null>(null);
  const handleSetBanquetStatus = async (menu: BanquetMenu, status: BanquetStatus) => {
    if (statusBusyId === menu.id) return;
    setStatusBusyId(menu.id);
    try {
      // La riga aggiornata torna dal socket (banquet:updated → App).
      await setBanquetStatus(menu.id, status);
    } catch { /* lo stato resta com'era */ }
    finally { setStatusBusyId(null); }
  };

  // Foglio «Condividi preventivo»: link pubblico stabile + invio WhatsApp
  // DAL NUMERO BUSINESS (template Meta, decisione utente 3/09 — mai wa.me
  // dall'operatore) + invio email dal server. Finché il template non è
  // approvato e cablato, il canale WhatsApp si presenta «in attivazione».
  const [shareBanquet, setShareBanquet] = useState<BanquetMenu | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareCustomer, setShareCustomer] = useState<Customer | null>(null);
  const [shareWhatsAppReady, setShareWhatsAppReady] = useState(false);
  const [sharePhone, setSharePhone] = useState('');
  const [sharePhoneBusy, setSharePhoneBusy] = useState(false);
  const [sharePhoneDone, setSharePhoneDone] = useState<string | null>(null);
  const [sharePhoneError, setSharePhoneError] = useState<string | null>(null);
  const [shareEmail, setShareEmail] = useState('');
  const [shareEmailBusy, setShareEmailBusy] = useState(false);
  const [shareEmailDone, setShareEmailDone] = useState<string | null>(null);
  const [shareEmailError, setShareEmailError] = useState<string | null>(null);

  const openShareSheet = (menu: BanquetMenu) => {
    setShareBanquet(menu);
    setShareUrl(null);
    setShareError(null);
    setShareCopied(false);
    setShareCustomer(null);
    setShareWhatsAppReady(false);
    setSharePhone('');
    setSharePhoneDone(null);
    setSharePhoneError(null);
    setShareEmail('');
    setShareEmailDone(null);
    setShareEmailError(null);
    getBanquetShareLink(menu.id)
      .then(r => { setShareUrl(r.url); setShareWhatsAppReady(r.whatsapp_ready === true); })
      .catch(err => setShareError(err?.data?.error ?? err?.message ?? 'Link non disponibile'));
    if (menu.customer_id) {
      getCustomers()
        .then(list => {
          const found = list.find(c => c.id === menu.customer_id) ?? null;
          setShareCustomer(found);
          if (found?.email) setShareEmail(found.email);
          if (found?.phone) setSharePhone(found.phone);
        })
        .catch(() => {});
    }
  };

  const handleSendQuoteWhatsApp = async () => {
    if (!shareBanquet || sharePhoneBusy) return;
    const phone = sharePhone.trim();
    if (!phone) return;
    setSharePhoneBusy(true);
    setSharePhoneError(null);
    setSharePhoneDone(null);
    try {
      const r = await sendBanquetQuoteWhatsApp(shareBanquet.id, phone);
      setSharePhoneDone(r.phone);
    } catch (err: any) {
      setSharePhoneError(err?.data?.message ?? err?.data?.error ?? err?.message ?? 'Invio non riuscito');
    } finally {
      setSharePhoneBusy(false);
    }
  };

  const handleCopyShareLink = () => {
    if (!shareUrl) return;
    navigator.clipboard?.writeText(shareUrl).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    }).catch(() => {});
  };

  const handleSendQuoteEmail = async () => {
    if (!shareBanquet || shareEmailBusy) return;
    const email = shareEmail.trim();
    if (!email) return;
    setShareEmailBusy(true);
    setShareEmailError(null);
    setShareEmailDone(null);
    try {
      const r = await sendBanquetQuoteEmail(shareBanquet.id, email);
      setShareEmailDone(r.email);
    } catch (err: any) {
      setShareEmailError(err?.data?.error ?? err?.message ?? 'Invio non riuscito');
    } finally {
      setShareEmailBusy(false);
    }
  };

  const [banquetView, setBanquetView] = useState<'LIST' | 'CALENDAR'>('LIST');
  type BanquetSortBy = 'date-asc' | 'date-desc' | 'name-asc' | 'name-desc' | 'guests-asc' | 'guests-desc';
  const [banquetSortBy, setBanquetSortBy] = useState<BanquetSortBy>('date-asc');
  const [showBanquetSortModal, setShowBanquetSortModal] = useState(false);
  // Everything ahead is open by default; the past is collapsed because it only
  // gets longer and you almost never come here for it.
  const [expandedBanquetGroups, setExpandedBanquetGroups] = useState<Set<BanquetGroupKey>>(
    new Set<BanquetGroupKey>(['week', 'month', 'later'])
  );
  const toggleBanquetGroup = (key: BanquetGroupKey) => {
    setExpandedBanquetGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const [searchTerm, setSearchTerm] = useState('');
  const [banquetSearchTerm, setBanquetSearchTerm] = useState('');
  const [dishViewMode, setDishViewMode] = useState<'GRID' | 'LIST'>('GRID');
  // The inline detail panel needs real width to sit beside a grid. Below lg the
  // same selection opens DishDetailModal instead, so the dish is never
  // unreachable — only presented differently.
  const dishPanelFits = useMediaQuery('(min-width: 1024px)');
  const detailPanelOpen = dishPanelFits && activeTab === 'DISHES';
  // Which step of the create/edit wizard is showing. Steps never gate each
  // other — validation still runs once, on save.
  const [banquetStep, setBanquetStep] = useState(0);
  // Da quale menu pesca il picker della composizione: il menu Banchetti di
  // default, o uno stagionale (es. Ferragosto) per comporre da quella lista.
  const [pickerMenuId, setPickerMenuId] = useState<number | null>(null);
  const pickerMenus = useMemo(
    () => menus.filter(m => m.system_key === 'BANQUETS' || !m.system_key),
    [menus]
  );
  const pickerDishes = useMemo(() => {
    const target = pickerMenuId ?? banquetsMenu?.id ?? null;
    if (target == null) return dishes;
    return dishes.filter(d => (d.menu_ids ?? []).includes(target));
  }, [dishes, pickerMenuId, banquetsMenu]);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [isDishFormOpen, setIsDishFormOpen] = useState(false);
  const [isBanquetFormOpen, setIsBanquetFormOpen] = useState(false);
  const [isEditingDish, setIsEditingDish] = useState(false);
  const [isEditingBanquet, setIsEditingBanquet] = useState(false);
  const [editingDishId, setEditingDishId] = useState<number | null>(null);
  const [editingBanquetId, setEditingBanquetId] = useState<number | null>(null);
  const [deleteDishConfirm, setDeleteDishConfirm] = useState<Dish | null>(null);
  const [deleteBanquetConfirm, setDeleteBanquetConfirm] = useState<BanquetMenu | null>(null);
  const [viewBanquet, setViewBanquet] = useState<BanquetMenu | null>(null);
  const [paymentsBanquet, setPaymentsBanquet] = useState<BanquetMenu | null>(null);
  const [viewDish, setViewDish] = useState<Dish | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoUploadError, setPhotoUploadError] = useState<string | null>(null);
  const photoFileInputRef = useRef<HTMLInputElement>(null);

  // Aliquota proposta per un piatto nuovo: il dish_default della mappatura
  // IVA (Impostazioni → Fiscalità). 10 finché non arriva — best effort, il
  // form resta usabile anche se la lettura fallisce.
  const [defaultVatRate, setDefaultVatRate] = useState(10);
  useEffect(() => {
    let cancelled = false;
    billsApiService.getFiscalSettings()
      .then(s => { if (!cancelled && Number.isInteger(s.vat_map?.dish_default)) setDefaultVatRate(s.vat_map.dish_default); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // New Dish State
  const [newDish, setNewDish] = useState<Partial<Dish>>({
    name: '',
    description: '',
    price: 0,
    category: 'Antipasti',
    allergens: [],
    photo_url: '',
    vat_rate: 10,
    menu_ids: []
  });
  // Gruppi varianti spuntati nel form e ingredienti del composto: viaggiano
  // nel salvataggio del piatto (semantica menu_ids), non con chiamate a parte.
  // Lo sconto resta stringa mentre si scrive (un campo controllato che
  // riformatta a ogni tasto rende impossibile battere «2,50») e diventa
  // centesimi solo al salvataggio.
  const [dishGroupIds, setDishGroupIds] = useState<number[]>([]);
  const [dishComponents, setDishComponents] = useState<{ id?: number; name: string; sconto: string }[]>([]);

  // New Banquet Menu State
  const [newBanquet, setNewBanquet] = useState<Partial<BanquetMenu>>({
      name: '',
      description: '',
      price_per_person: 0,
      dish_ids: [],
      courses: [],
      event_date: '',
      shift: undefined,
      deposit_amount: undefined,
      guests: undefined,
      children: 0,
      children_price: null,
      customer_id: null,
      notes_courses: '',
      notes_service: '',
      notes_mise_en_place: '',
      table_ids: [],
      discount_type: null,
      discount_value: null
  });

  // Customer picker (rubrica) state for banquet form
  const [isBanquetCustomerPickerOpen, setIsBanquetCustomerPickerOpen] = useState(false);
  const [selectedBanquetCustomer, setSelectedBanquetCustomer] = useState<Customer | null>(null);

  // Banquet form validation errors
  const [banquetFormErrors, setBanquetFormErrors] = useState<string[]>([]);
  const [isSavingBanquet, setIsSavingBanquet] = useState(false);
  // Surfaced when reopening the new-banquet modal and a saved draft exists.
  const [banquetDraftBanner, setBanquetDraftBanner] = useState<{ savedAt: number } | null>(null);
  const [isSavingDish, setIsSavingDish] = useState(false);
  const [tablePickerRoomFilter, setTablePickerRoomFilter] = useState<number | 'ALL'>('ALL');
  // Each step starts at its own top. Without this you leave step 3 scrolled to
  // the bottom and arrive at step 4 already halfway down it. ModalShell owns
  // the scroll container, so we pull a sentinel at the top of the body into
  // view instead of scrolling an element we do not hold.
  const banquetFormScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    banquetFormScrollRef.current?.scrollIntoView({ block: 'start' });
  }, [banquetStep]);
  const [cardMenuOpenId, setCardMenuOpenId] = useState<number | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoOpenNewBanquet) {
      handleOpenNewBanquet();
      onAutoOpenNewBanquetHandled?.();
    }
  }, [autoOpenNewBanquet]);

  useEffect(() => {
    if (autoOpenNewDish) {
      handleOpenNewDish();
      onAutoOpenNewDishHandled?.();
    }
  }, [autoOpenNewDish]);

  useEffect(() => {
    if (cardMenuOpenId === null) return;
    const handler = (e: MouseEvent) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
        setCardMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [cardMenuOpenId]);

  // Load the selected customer when editing a banquet that has customer_id
  useEffect(() => {
    if (!isBanquetFormOpen) return;
    const id = newBanquet.customer_id;
    if (!id) {
      setSelectedBanquetCustomer(null);
      return;
    }
    if (selectedBanquetCustomer?.id === id) return;
    let cancelled = false;
    getCustomers()
      .then(list => {
        if (cancelled) return;
        const found = list.find(c => c.id === id) || null;
        setSelectedBanquetCustomer(found);
      })
      .catch(() => { if (!cancelled) setSelectedBanquetCustomer(null); });
    return () => { cancelled = true; };
  }, [isBanquetFormOpen, newBanquet.customer_id, selectedBanquetCustomer?.id]);

  const handleAddDishSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDish.name || !newDish.price) return;
    if (isSavingDish) return;

    try {
      setIsSavingDish(true);
      const dishType = newDish.dish_type ?? 'SIMPLE';
      const payload: Partial<Dish> = {
        name: newDish.name!,
        description: newDish.description || '',
        price: Number(newDish.price),
        category: newDish.category || 'Antipasti',
        allergens: newDish.allergens || [],
        photo_url: newDish.photo_url?.trim() || undefined,
        vat_rate: newDish.vat_rate ?? defaultVatRate,
        menu_ids: newDish.menu_ids ?? [],
        dish_type: dishType,
        sold_by_weight: newDish.sold_by_weight === true,
        weight_min_grams: newDish.weight_min_grams ?? null,
        weight_max_grams: newDish.weight_max_grams ?? null,
        weight_default_grams: newDish.weight_default_grams ?? null,
        modifier_group_ids: dishGroupIds,
        // Gli ingredienti si mandano solo per i composti: su un piatto
        // tornato Semplice restano com'erano, ignorati (non cancellati).
        ...(dishType === 'COMPOSED'
          ? {
              components: dishComponents.filter(c => c.name.trim()).map(c => {
                const n = Number(c.sconto.trim().replace(',', '.'));
                return {
                  ...(c.id != null ? { id: c.id } : {}),
                  name: c.name.trim(),
                  removal_delta_cents: Number.isFinite(n) && n > 0 ? -Math.round(n * 100) : 0,
                };
              }),
            }
          : {}),
      };
      if (isEditingDish && editingDishId !== null) {
        await onUpdateDish(editingDishId, payload);
      } else {
        await onAddDish(payload as Dish);
      }
      // I legami varianti vivono nel catalogo, non nell'anagrafica piatti:
      // il refetch tiene allineate le chip e i conteggi della modale.
      refreshModifierGroups();

      setIsDishFormOpen(false);
      setIsEditingDish(false);
      setEditingDishId(null);
      setNewDish({ name: '', description: '', price: 0, category: 'Antipasti', allergens: [], photo_url: '', vat_rate: defaultVatRate, menu_ids: [] });
      setDishGroupIds([]);
      setDishComponents([]);
    } finally {
      setIsSavingDish(false);
    }
  };

  // Mirrors handleOpenNewBanquet: a create always starts from a blank form.
  // Closing the modal with Annulla leaves the previous edit's values in place —
  // only a successful save clears them — so without this reset "+ Nuovo piatto"
  // could open prefilled and still in edit mode, and saving would have
  // overwritten that dish instead of adding one.
  const handleOpenNewDish = () => {
    setIsEditingDish(false);
    setEditingDishId(null);
    // Il piatto nuovo nasce nella prima categoria vera del ristorante e nei
    // menu della sua categoria (se impostati in modale Categorie), altrimenti
    // nel menu che si sta guardando (o Alla carta): la spunta si toglie, non
    // si rincorre.
    const firstCat = menuCats?.[0]?.name ?? 'Antipasti';
    const catDefault = menuCats?.find(c => c.name === firstCat)?.menu_ids;
    const defaultMenuId = selectedMenu?.id ?? cartaMenu?.id;
    const defaultMenus = Array.isArray(catDefault) && catDefault.length > 0
      ? catDefault
      : defaultMenuId != null ? [defaultMenuId] : [];
    setNewDish({ name: '', description: '', price: 0, category: firstCat, allergens: [], photo_url: '', vat_rate: defaultVatRate, menu_ids: defaultMenus, dish_type: 'SIMPLE', sold_by_weight: false });
    setDishGroupIds([]);
    setDishComponents([]);
    setPhotoUploadError(null);
    setIsDishFormOpen(true);
  };

  const handleEditDish = (dish: Dish) => {
    setNewDish({
      name: dish.name,
      description: dish.description,
      price: dish.price,
      category: dish.category,
      allergens: dish.allergens,
      photo_url: dish.photo_url || '',
      vat_rate: dish.vat_rate ?? 10,
      menu_ids: dish.menu_ids ?? [],
      dish_type: dish.dish_type ?? 'SIMPLE',
      sold_by_weight: dish.sold_by_weight === true,
      weight_min_grams: dish.weight_min_grams ?? null,
      weight_max_grams: dish.weight_max_grams ?? null,
      weight_default_grams: dish.weight_default_grams ?? null,
    });
    // Le spunte dei gruppi si leggono dai dish_ids della gestione varianti;
    // gli ingredienti si caricano pigri — servono solo aprendo un composto.
    setDishGroupIds(modifierGroups.filter(g => g.dish_ids.includes(dish.id)).map(g => g.id));
    setDishComponents([]);
    if (dish.dish_type === 'COMPOSED') {
      getDishComponents(dish.id)
        .then(list => setDishComponents(list.map(c => ({
          id: c.id,
          name: c.name,
          sconto: c.removal_delta_cents === 0 ? '' : (Math.abs(c.removal_delta_cents) / 100).toFixed(2),
        }))))
        .catch(() => {});
    }
    setEditingDishId(dish.id);
    setIsEditingDish(true);
    setIsDishFormOpen(true);
  };

  const handlePhotoFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoUploadError(null);
    setPhotoUploading(true);
    try {
      const dataUrl = await resizeImageToDataUrl(file, 800, 0.8);
      setNewDish(prev => ({ ...prev, photo_url: dataUrl }));
    } catch (err: any) {
      setPhotoUploadError(err?.message || 'Caricamento fallito');
    } finally {
      setPhotoUploading(false);
      if (photoFileInputRef.current) photoFileInputRef.current.value = '';
    }
  };

  const handleAddBanquetSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (isSavingBanquet) return;

      const missing: string[] = [];
      if (!newBanquet.name || !newBanquet.name.trim()) missing.push('Nome Menu');
      if (!newBanquet.event_date) missing.push('Data Evento');
      if (canViewBanquetPrice && (newBanquet.price_per_person == null || isNaN(Number(newBanquet.price_per_person)) || Number(newBanquet.price_per_person) <= 0)) {
        missing.push('Prezzo Adulti');
      }

      if (missing.length > 0) {
        setBanquetFormErrors(missing);
        return;
      }
      setBanquetFormErrors([]);

      const courses = (newBanquet.courses || []).filter(c => c.name.trim() !== '');
      const flatDishIds = courses.flatMap(c => c.dish_ids);

      const payload = {
          name: newBanquet.name!,
          description: newBanquet.description || '',
          price_per_person: Number(newBanquet.price_per_person),
          dish_ids: flatDishIds,
          courses,
          event_date: newBanquet.event_date!,
          shift: newBanquet.shift,
          deposit_amount: newBanquet.deposit_amount != null && newBanquet.deposit_amount !== ('' as any)
              ? Number(newBanquet.deposit_amount)
              : undefined,
          guests: newBanquet.guests != null && newBanquet.guests !== ('' as any)
              ? Number(newBanquet.guests)
              : undefined,
          children: Number(newBanquet.children ?? 0),
          children_price: newBanquet.children_price != null && newBanquet.children_price !== ('' as any)
              ? Number(newBanquet.children_price)
              : null,
          customer_id: newBanquet.customer_id ?? null,
          notes_courses: newBanquet.notes_courses?.trim() || undefined,
          notes_service: newBanquet.notes_service?.trim() || undefined,
          notes_mise_en_place: newBanquet.notes_mise_en_place?.trim() || undefined,
          table_ids: Array.isArray(newBanquet.table_ids) ? newBanquet.table_ids : [],
          discount_type: newBanquet.discount_type ?? null,
          discount_value: newBanquet.discount_type && newBanquet.discount_value != null && newBanquet.discount_value !== ('' as any)
              ? Math.max(0, Number(newBanquet.discount_value))
              : null,
      };

      try {
        setIsSavingBanquet(true);
        if (isEditingBanquet && editingBanquetId !== null) {
          await onUpdateBanquetMenu(editingBanquetId, payload);
        } else {
          await onAddBanquetMenu(payload as BanquetMenu);
          clearDraft(DRAFT_KEYS.BANQUET_NEW);
          // Il banchetto nuovo nasce preventivo: la lista si sposta lì,
          // o sembrerebbe che il salvataggio non abbia fatto nulla.
          setBanquetStatusFilter('QUOTE');
        }

        setIsBanquetFormOpen(false);
        setIsEditingBanquet(false);
        setEditingBanquetId(null);
        setSelectedBanquetCustomer(null);
        setBanquetDraftBanner(null);
        setNewBanquet({ name: '', description: '', price_per_person: 0, dish_ids: [], courses: [], event_date: '', shift: undefined, deposit_amount: undefined, guests: undefined, children: 0, children_price: null, customer_id: null, notes_courses: '', notes_service: '', notes_mise_en_place: '', table_ids: [], discount_type: null, discount_value: null });
      } catch (err: any) {
        const msg = err?.message || 'Errore durante il salvataggio';
        const isConflict = err?.status === 409 || /tavolo/i.test(msg);
        setBanquetFormErrors([isConflict ? `Conflitto tavoli: ${msg}` : msg]);
      } finally {
        setIsSavingBanquet(false);
      }
  };

  const handleEditBanquet = (menu: BanquetMenu) => {
    // Derive courses: use stored courses if present, otherwise wrap legacy flat list into a single course
    const courses: BanquetCourse[] = menu.courses && menu.courses.length > 0
      ? menu.courses.map(c => ({ name: c.name, dish_ids: [...(c.dish_ids || [])], notes: c.notes || '' }))
      : (menu.dish_ids && menu.dish_ids.length > 0
          ? [{ name: 'Composizione', dish_ids: [...menu.dish_ids] }]
          : []);
    setNewBanquet({
      name: menu.name,
      description: menu.description,
      price_per_person: menu.price_per_person,
      dish_ids: menu.dish_ids,
      courses,
      event_date: menu.event_date || '',
      shift: menu.shift,
      deposit_amount: menu.deposit_amount != null ? Number(menu.deposit_amount) : undefined,
      guests: menu.guests != null ? Number(menu.guests) : undefined,
      children: menu.children != null ? Number(menu.children) : 0,
      children_price: menu.children_price != null ? Number(menu.children_price) : null,
      customer_id: menu.customer_id ?? null,
      notes_courses: menu.notes_courses || '',
      notes_service: menu.notes_service || '',
      notes_mise_en_place: menu.notes_mise_en_place || '',
      table_ids: Array.isArray(menu.table_ids) ? [...menu.table_ids] : [],
      discount_type: menu.discount_type ?? null,
      discount_value: menu.discount_value != null ? Number(menu.discount_value) : null,
    });
    setSelectedBanquetCustomer(null);
    setBanquetFormErrors([]);
    setEditingBanquetId(menu.id);
    setIsEditingBanquet(true);
    setBanquetStep(0);
    setPickerMenuId(null);
    setIsBanquetFormOpen(true);
  };

  const handleOpenNewBanquet = () => {
    setIsEditingBanquet(false);
    setEditingBanquetId(null);
    setSelectedBanquetCustomer(null);
    setBanquetFormErrors([]);
    setNewBanquet({
      name: '', description: '', price_per_person: 0,
      dish_ids: [],
      courses: [{ name: '1ª Uscita', dish_ids: [] }],
      event_date: '', shift: undefined, deposit_amount: undefined,
      guests: undefined,
      children: 0,
      children_price: null,
      customer_id: null,
      notes_courses: '', notes_service: '', notes_mise_en_place: '',
      table_ids: []
    });
    setBanquetStep(0);
    setPickerMenuId(null);
    setIsBanquetFormOpen(true);

    const existing = loadDraft<Partial<BanquetMenu>>(DRAFT_KEYS.BANQUET_NEW);
    setBanquetDraftBanner(existing ? { savedAt: existing.savedAt } : null);
  };

  const closeBanquetForm = () => {
    setIsBanquetFormOpen(false);
    setBanquetFormErrors([]);
    setBanquetDraftBanner(null);
    // Always reopen on the first step. Landing back on "Note operative"
    // because that is where you closed it reads as a broken form.
    setBanquetStep(0);
  };

  const handleRestoreBanquetDraft = () => {
    const existing = loadDraft<Partial<BanquetMenu>>(DRAFT_KEYS.BANQUET_NEW);
    if (!existing) {
      setBanquetDraftBanner(null);
      return;
    }
    setNewBanquet(existing.data);
    setBanquetDraftBanner(null);
  };

  const handleDiscardBanquetDraft = () => {
    clearDraft(DRAFT_KEYS.BANQUET_NEW);
    setBanquetDraftBanner(null);
  };

  // Persist a draft of the new-banquet form (debounced). Only while creating
  // (not editing) and only once the user has typed something meaningful. The
  // customer is recovered from the saved customer_id via the existing lookup
  // effect, so we only store newBanquet.
  useEffect(() => {
    if (!isBanquetFormOpen || isEditingBanquet) return;

    const hasContent =
      (newBanquet.name && newBanquet.name.trim() !== '') ||
      (newBanquet.event_date && newBanquet.event_date.trim() !== '') ||
      (newBanquet.description && newBanquet.description.trim() !== '') ||
      (newBanquet.notes_courses && newBanquet.notes_courses.trim() !== '') ||
      (newBanquet.notes_service && newBanquet.notes_service.trim() !== '') ||
      (newBanquet.notes_mise_en_place && newBanquet.notes_mise_en_place.trim() !== '') ||
      (newBanquet.guests != null && newBanquet.guests !== ('' as any)) ||
      (newBanquet.price_per_person != null && Number(newBanquet.price_per_person) > 0) ||
      newBanquet.customer_id != null ||
      (Array.isArray(newBanquet.courses) && newBanquet.courses.some(c => (c.dish_ids || []).length > 0)) ||
      (Array.isArray(newBanquet.table_ids) && newBanquet.table_ids.length > 0);
    if (!hasContent) return;

    const timer = setTimeout(() => {
      saveDraft(DRAFT_KEYS.BANQUET_NEW, newBanquet);
    }, 400);
    return () => clearTimeout(timer);
  }, [isBanquetFormOpen, isEditingBanquet, newBanquet]);

  const banquetFieldHasError = (field: string) => banquetFormErrors.includes(field);

  /* Which required fields are still empty — the same three handleAddBanquetSubmit
     checks, kept in step with it. The save button is disabled off this list, and
     the footer names what is missing: a dead primary action with nothing to
     explain it is the reason people click it twice and then leave. */
  const banquetMissingRequired = useMemo(() => {
    const missing: string[] = [];
    if (!newBanquet.name || !newBanquet.name.trim()) missing.push('il nome del menù');
    if (!newBanquet.event_date) missing.push('la data dell\'evento');
    if (canViewBanquetPrice && (newBanquet.price_per_person == null || isNaN(Number(newBanquet.price_per_person)) || Number(newBanquet.price_per_person) <= 0)) {
      missing.push('il prezzo adulti');
    }
    return missing;
  }, [newBanquet.name, newBanquet.event_date, newBanquet.price_per_person, canViewBanquetPrice]);

  const addCourse = () => {
    setNewBanquet(prev => {
      const courses = prev.courses ? [...prev.courses] : [];
      const ordinals = ['1ª', '2ª', '3ª', '4ª', '5ª', '6ª', '7ª', '8ª', '9ª', '10ª'];
      const next = ordinals[courses.length] || `${courses.length + 1}ª`;
      courses.push({ name: `${next} Uscita`, dish_ids: [] });
      return { ...prev, courses };
    });
  };

  const removeCourse = (index: number) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).filter((_, i) => i !== index);
      return { ...prev, courses };
    });
  };

  const renameCourse = (index: number, name: string) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => i === index ? { ...c, name } : c);
      return { ...prev, courses };
    });
  };

  const setCourseNotes = (index: number, notes: string) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => i === index ? { ...c, notes } : c);
      return { ...prev, courses };
    });
  };

  const toggleDishInCourse = (courseIndex: number, dishId: number) => {
    setNewBanquet(prev => {
      const courses = (prev.courses || []).map((c, i) => {
        if (i !== courseIndex) return c;
        const has = c.dish_ids.includes(dishId);
        return { ...c, dish_ids: has ? c.dish_ids.filter(id => id !== dishId) : [...c.dish_ids, dishId] };
      });
      return { ...prev, courses };
    });
  };

  const moveCourse = (index: number, direction: -1 | 1) => {
    setNewBanquet(prev => {
      const courses = [...(prev.courses || [])];
      const newIndex = index + direction;
      if (newIndex < 0 || newIndex >= courses.length) return prev;
      [courses[index], courses[newIndex]] = [courses[newIndex], courses[index]];
      return { ...prev, courses };
    });
  };

  const toggleDishMenu = (menuId: number) => {
    setNewDish(prev => {
      const current = prev.menu_ids ?? [];
      return current.includes(menuId)
        ? { ...prev, menu_ids: current.filter(id => id !== menuId) }
        : { ...prev, menu_ids: [...current, menuId] };
    });
  };

  const toggleAllergen = (allergen: string) => {
    setNewDish(prev => {
        const current = prev.allergens || [];
        if (current.includes(allergen)) {
            return { ...prev, allergens: current.filter(a => a !== allergen) };
        } else {
            return { ...prev, allergens: [...current, allergen] };
        }
    });
  };

  const dishCategories = useMemo(() => {
    const present = new Set<string>();
    for (const d of menuDishes) {
      if (d.category && d.category.trim()) present.add(d.category.trim());
    }
    // Con le preferenze caricate comanda l'ordine scelto in "Categorie";
    // le categorie nuove (non ancora ordinate) vanno in coda, alfabetiche.
    if (menuCats) {
      const known = menuCats.map(c => c.name).filter(n => present.has(n));
      const extra = [...present].filter(n => !menuCats.some(c => c.name === n))
        .sort((a, b) => a.localeCompare(b, 'it'));
      return [...known, ...extra];
    }
    // Prima del fetch: l'ordine di portata classico di sempre.
    const order = ['antipasti', 'primi', 'secondi', 'contorni', 'dolci'];
    return Array.from(present).sort((a, b) => {
      const ai = order.indexOf(a.toLowerCase());
      const bi = order.indexOf(b.toLowerCase());
      if (ai !== -1 && bi !== -1) return ai - bi;
      if (ai !== -1) return -1;
      if (bi !== -1) return 1;
      return a.localeCompare(b, 'it');
    });
  }, [menuDishes, menuCats]);

  const disabledCategories = useMemo(
    () => new Set((menuCats ?? []).filter(c => !c.enabled).map(c => c.name)),
    [menuCats]
  );

  // Unioni tavoli attive per la data+turno scelti nel form: un tavolo
  // occupato occupa l'intera unione (stessa regola del controllo server),
  // quindi anche i tavoli uniti al suo gruppo vanno disabilitati in griglia.
  const [banquetMerges, setBanquetMerges] = useState<TableMerge[]>([]);
  useEffect(() => {
    const date = newBanquet.event_date;
    const shift = newBanquet.shift;
    if (!date || !shift) { setBanquetMerges([]); return; }
    let cancelled = false;
    getTableMerges(date, shift)
      .then(merges => { if (!cancelled) setBanquetMerges(merges); })
      .catch(() => { if (!cancelled) setBanquetMerges([]); });
    return () => { cancelled = true; };
  }, [newBanquet.event_date, newBanquet.shift]);

  // Map of tableId -> occupancy info for the currently selected event_date+shift
  // (excluding the banquet being edited). Used by the table picker in the form.
  const tableOccupancyMap = useMemo(() => {
    const map = new Map<number, { source: 'reservation' | 'banquet'; label: string }>();
    const date = newBanquet.event_date;
    const shift = newBanquet.shift;
    if (!date || !shift) return map;

    for (const r of reservations) {
      if (!r.table_id) continue;
      if (r.shift !== shift) continue;
      if ((r.arrival_status || ArrivalStatus.WAITING) === ArrivalStatus.DEPARTED) continue;
      if (r.reservation_status === ReservationStatus.CANCELLED) continue;
      if (r.reservation_status === ReservationStatus.DECLINED) continue;
      if (getRomeDatePart(r.reservation_time) !== date) continue;
      if (!map.has(r.table_id)) {
        map.set(r.table_id, { source: 'reservation', label: r.customer_name });
      }
    }

    for (const b of banquetMenus) {
      if (editingBanquetId !== null && b.id === editingBanquetId) continue;
      if (b.event_date !== date) continue;
      if (b.shift !== shift) continue;
      const ids = Array.isArray(b.table_ids) ? b.table_ids : [];
      for (const tid of ids) {
        if (!map.has(tid)) {
          map.set(tid, { source: 'banquet', label: b.name });
        }
      }
    }

    // Estende l'occupazione all'intero gruppo di unione: il tavolo unito a
    // uno occupato eredita la stessa etichetta di chi occupa il gruppo.
    for (const m of banquetMerges) {
      const group = [m.primary_id, ...m.merged_ids];
      const occ = group.map(id => map.get(id)).find(Boolean);
      if (occ) for (const id of group) { if (!map.has(id)) map.set(id, occ); }
    }

    return map;
  }, [newBanquet.event_date, newBanquet.shift, reservations, banquetMenus, editingBanquetId, banquetMerges]);

  const groupedBanquets = useMemo(() => {
    const today = formatLocalDate(new Date());
    const compare = (a: BanquetMenu, b: BanquetMenu) => {
      switch (banquetSortBy) {
        case 'date-asc':    return (a.event_date || '').localeCompare(b.event_date || '');
        case 'date-desc':   return (b.event_date || '').localeCompare(a.event_date || '');
        case 'name-asc':    return (a.name || '').localeCompare(b.name || '', 'it', { sensitivity: 'base' });
        case 'name-desc':   return (b.name || '').localeCompare(a.name || '', 'it', { sensitivity: 'base' });
        case 'guests-asc':  return (Number(a.guests) || 0) - (Number(b.guests) || 0);
        case 'guests-desc': return (Number(b.guests) || 0) - (Number(a.guests) || 0);
      }
    };
    const now = new Date();
    const weekEnd = endOfCurrentWeek(now);
    const monthEnd = endOfCurrentMonth(now);

    // Name and description only. The client is a customer_id reference and the
    // customers list is not loaded on this screen, so searching by client name
    // would mean a fetch this list does not otherwise need. The event type
    // ("Battesimo", "Comunione") lives in description, which is what you
    // actually reach for.
    const q = banquetSearchTerm.trim().toLowerCase();
    const matches = (b: BanquetMenu) => {
      if (!q) return true;
      return (b.name || '').toLowerCase().includes(q)
        || (b.description || '').toLowerCase().includes(q);
    };

    const buckets: Record<BanquetGroupKey, BanquetMenu[]> = { week: [], month: [], later: [], past: [] };
    for (const b of statusBanquets) {
      if (!matches(b)) continue;
      buckets[banquetGroupFor(b, today, weekEnd, monthEnd)].push(b);
    }
    // The past reads newest-first whatever the sort says: an explicit "prima →
    // dopo" is about planning ahead, and applying it backwards buries the
    // event that just happened at the bottom of a very long list.
    (Object.keys(buckets) as BanquetGroupKey[]).forEach(k => {
      buckets[k].sort(k === 'past' && banquetSortBy === 'date-asc'
        ? (a, b) => (b.event_date || '').localeCompare(a.event_date || '')
        : compare);
    });
    return buckets;
  }, [statusBanquets, banquetSortBy, banquetSearchTerm]);

  // Header figures. All three come from data already loaded — nothing new is
  // fetched to show them.
  const banquetKpis = useMemo(() => {
    const today = formatLocalDate(new Date());
    // Solo i confermati: un preventivo non ha coperti prenotati né incassi
    // da rincorrere — contarlo gonfierebbe i numeri del servizio.
    const upcoming = banquetMenus.filter(b =>
      banquetStatusOf(b) === 'CONFIRMED' && (!b.event_date || b.event_date >= today));
    const covers = upcoming.reduce((s, b) => s + (Number(b.guests) || 0), 0);
    const outstanding = upcoming.reduce((s, b) => {
      const due = computeBanquetTotalDue(b);
      const paid = Number(b.total_paid || 0);
      return s + Math.max(0, due - paid);
    }, 0);
    // La somma è quasi sempre > 0 — ogni banchetto nasce da pagare — quindi da
    // sola non merita il rosso. Si accende se almeno un evento entro fine
    // settimana (o già passato) è ancora scoperto: lì sì che c'è da correre.
    const weekEnd = endOfCurrentWeek(new Date());
    const urgent = upcoming.some(b =>
      Math.max(0, computeBanquetTotalDue(b) - Number(b.total_paid || 0)) > 0
      && isOutstandingUrgent(b, weekEnd)
    );
    return { count: upcoming.length, covers, outstanding, urgent };
  }, [banquetMenus]);

  const BANQUET_SORT_OPTIONS: { value: BanquetSortBy; label: string }[] = [
    { value: 'date-asc',    label: 'Data evento (prima → dopo)' },
    { value: 'date-desc',   label: 'Data evento (dopo → prima)' },
    { value: 'name-asc',    label: 'Nome A → Z' },
    { value: 'name-desc',   label: 'Nome Z → A' },
    { value: 'guests-asc',  label: 'Coperti (meno → più)' },
    { value: 'guests-desc', label: 'Coperti (più → meno)' },
  ];

  // Le righe arrivano già ordinate per (categoria, posizione, nome); qui si
  // riordinano solo i GRUPPI secondo l'ordine scelto in "Categorie" — il
  // sort è stabile, l'ordine dentro la categoria non si tocca.
  const categoryIndex = useMemo(
    () => new Map(dishCategories.map((c, i) => [c, i])),
    [dishCategories]
  );
  const filteredDishes = menuDishes.filter(d => {
    const matchesSearch = d.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      d.category.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = !categoryFilter || d.category === categoryFilter;
    return matchesSearch && matchesCategory;
  }).sort((a, b) =>
    (categoryIndex.get((a.category ?? '').trim()) ?? Number.MAX_SAFE_INTEGER)
    - (categoryIndex.get((b.category ?? '').trim()) ?? Number.MAX_SAFE_INTEGER)
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      {/* Tabs + header figures */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 mb-5">
        {/* The create button sits directly under the selector rather than among
            the KPIs or the search: it acts on whichever section is showing, so
            it belongs to the switch. One element for both tabs also keeps the
            two labels identically sized — as separate buttons in separate rows
            they had drifted to different heights and widths. */}
        <div className="flex flex-col items-start gap-2.5">
          {/* Pagina Menu: un menu per pill — i due di sistema poi gli
              stagionali, col "+" in coda. Un menu stagionale selezionato
              porta con sé rinomina ed elimina; i due di sistema no. */}
          {activeTab === 'DISHES' && (
            <div className="flex flex-wrap items-center gap-2">
              {menus.map(m => {
                const isActive = selectedMenu?.id === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setSelectedMenuId(m.id)}
                    className={`${DISH_FILTER_BASE} h-9 ${isActive ? DISH_FILTER_ON : DISH_FILTER_OFF}`}
                  >
                    {m.name}
                  </button>
                );
              })}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => { setMenuFormName(''); setMenuFormError(null); setMenuForm({ kind: 'create' }); }}
                  title="Nuovo menu (es. Ferragosto, Pasqua)"
                  className={`${DISH_FILTER_BASE} h-9 ${DISH_FILTER_OFF}`}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  Nuovo menu
                </button>
              )}
              {canEdit && selectedMenu && !selectedMenu.system_key && (
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => { setMenuFormName(selectedMenu.name); setMenuFormError(null); setMenuForm({ kind: 'rename', menu: selectedMenu }); }}
                    className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none`}
                    title="Rinomina menu"
                  >
                    <Edit2 className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteMenuConfirm(selectedMenu)}
                    className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                    title="Elimina menu"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </span>
              )}
            </div>
          )}
          {/* Pagina Banchetti: prima i confermati (il lavoro vero), i
              preventivi accanto col loro conteggio. */}
          {activeTab === 'BANQUETS' && (
            <SegmentedControl<'CONFIRMED' | 'QUOTE'>
              value={banquetStatusFilter}
              onChange={setBanquetStatusFilter}
              ariaLabel="Stato banchetti"
              equalWidth={false}
              options={[
                { value: 'CONFIRMED', label: 'Confermati' },
                { value: 'QUOTE', label: quoteCount > 0 ? `Preventivi (${quoteCount})` : 'Preventivi' },
              ]}
            />
          )}
          {/* Phone only, and the breakpoint is not a guess: the global "+" menu
              in the top bar is `hidden md:block`, so below md this is the only
              route into either form. From md up it would be a second button for
              a create the header already offers. */}
          {canEdit && (
            <button
              type="button"
              onClick={activeTab === 'BANQUETS' ? handleOpenNewBanquet : handleOpenNewDish}
              className="inline-flex h-9 items-center justify-center gap-1.5 rounded-full bg-[var(--ds-action-bg)] px-3.5 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] md:hidden"
            >
              <Plus className="h-4 w-4" aria-hidden />
              {activeTab === 'BANQUETS' ? 'Nuovo banchetto' : 'Nuovo piatto'}
            </button>
          )}
        </div>
        {activeTab === 'BANQUETS' && (
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="info" className="h-8 px-3">
              <span className="font-semibold tabular-nums">{banquetKpis.count}</span>
              <span className="font-normal">in arrivo</span>
            </StatusPill>
            <StatusPill tone="neutral" className="h-8 px-3">
              <span className="font-semibold tabular-nums">{banquetKpis.covers}</span>
              <span className="font-normal">coperti prenotati</span>
            </StatusPill>
            {canViewBanquetPrice && banquetKpis.outstanding > 0 && (
              <StatusPill tone={banquetKpis.urgent ? 'critical' : 'pending'} className="h-8 px-3">
                <span className="font-semibold tabular-nums">€ {formatEuro(banquetKpis.outstanding)}</span>
                <span className="font-normal">da incassare</span>
              </StatusPill>
            )}
          </div>
        )}
        {activeTab === 'DISHES' && (
          <div className="flex items-center gap-2 sm:flex-1 sm:justify-end">
            <button
              type="button"
              onClick={() => setQrOpen(true)}
              title="QR e traduzioni del menu per gli ospiti"
              className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              <QrCode className="h-4 w-4" aria-hidden />
              Menu digitale
            </button>
            {canImportCassa && (
              <button
                type="button"
                onClick={handleImportCassa}
                disabled={importing}
                title="Allinea i piatti al catalogo della cassa Passepartout"
                className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RefreshCw className="h-4 w-4" aria-hidden />}
                Importa da cassa
              </button>
            )}
            <SearchField
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Cerca piatto o ingrediente..."
              ariaLabel="Cerca piatto"
              className="min-w-0 flex-1 sm:max-w-sm"
            />
            {/* Icon-only: the two modes are self-evident from the glyphs, and
                the labels were competing with the search beside them. */}
            <div className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-surface-row)] p-1">
              {([
                { value: 'GRID' as const, label: 'Griglia', Icon: LayoutGrid },
                { value: 'LIST' as const, label: 'Elenco', Icon: ListIcon },
              ]).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setDishViewMode(value)}
                  aria-pressed={dishViewMode === value}
                  title={label}
                  aria-label={label}
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    dishViewMode === value
                      ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                      : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)]'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {activeTab === 'DISHES' && (
          <>
            {(importEsito || importError) && (
              <div className="mb-4">
                <Callout tone={importError ? 'critical' : 'positive'}>
                  {importError
                    ?? `Menu allineato alla cassa: ${importEsito!.creati} nuovi, ${importEsito!.aggiornati} aggiornati, ${importEsito!.disattivati} disattivati${importEsito!.eliminati ? `, ${importEsito!.eliminati} rimossi` : ''}${importEsito!.gruppi_varianti ? `, ${importEsito!.gruppi_varianti} gruppi varianti` : ''}.`}
                </Callout>
              </div>
            )}
            <div className="flex flex-col gap-3 md:flex-row md:items-center mb-5">
              {dishCategories.length > 0 && (
                <div className="flex flex-1 flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setCategoryFilter(null)}
                    className={`${DISH_FILTER_BASE} ${categoryFilter === null ? DISH_FILTER_ON : DISH_FILTER_OFF}`}
                  >
                    Tutte <span className="tabular-nums opacity-70">{menuDishes.length}</span>
                  </button>
                  {dishCategories.map(cat => {
                    const count = menuDishes.filter(d => d.category === cat).length;
                    const isActive = categoryFilter === cat;
                    const isOff = disabledCategories.has(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(isActive ? null : cat)}
                        title={isOff ? `${cat} — spenta: non compare su comande e menu digitale` : undefined}
                        className={`${DISH_FILTER_BASE} ${isActive ? DISH_FILTER_ON : DISH_FILTER_OFF} ${isOff && !isActive ? 'opacity-50 line-through' : ''}`}
                      >
                        {cat} <span className="tabular-nums opacity-70">{count}</span>
                      </button>
                    );
                  })}
                </div>
              )}
              {/* Azione, non filtro: sta fuori dalla fila di pill e usa lo
                  stesso vestito di "Importa da cassa", così non si confonde
                  con una categoria in più. */}
              {canEdit && dishCategories.length > 0 && (
                <button
                  type="button"
                  onClick={() => setCatsOpen(true)}
                  title="Ordina e accendi/spegni le categorie"
                  className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 self-start rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] md:self-center"
                >
                  <SlidersHorizontal className="h-4 w-4" aria-hidden />
                  Categorie
                </button>
              )}
              {canEdit && (
                <button
                  type="button"
                  onClick={() => setVariantsOpen(true)}
                  title="Gruppi di varianti: cotture, aggiunte, sovrapprezzi"
                  className="inline-flex h-9 flex-shrink-0 items-center gap-1.5 self-start rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] md:self-center"
                >
                  <Layers className="h-4 w-4" aria-hidden />
                  Varianti
                </button>
              )}
              <span className="text-[13px] text-[var(--ds-text-muted)] md:flex-shrink-0 md:self-center">
                {menuDishes.length} piatti · {menuDishes.filter(d => d.allergens.length > 0).length} con allergeni · {menuDishes.filter(d => !d.photo_url).length} senza foto
              </span>
            </div>

            {filteredDishes.length === 0 ? (
              <EmptyState icon={Utensils}>
                {searchTerm || categoryFilter
                  ? 'Nessun piatto corrisponde ai filtri.'
                  : dishes.length > 0 && selectedMenu
                    ? `Nessun piatto in «${selectedMenu.name}»: spuntalo dalla scheda del piatto.`
                    : 'Non hai ancora aggiunto piatti.'}
              </EmptyState>
            ) : (
              <div className="flex gap-4">
                <div className="min-w-0 flex-1">
                  {dishViewMode === 'GRID' ? (
                    <div className={`grid gap-4 ${detailPanelOpen ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'}`}>
                      {filteredDishes.map(dish => {
                        const isSelected = viewDish?.id === dish.id;
                        return (
                          <button
                            key={dish.id}
                            type="button"
                            onClick={() => setViewDish(isSelected ? null : dish)}
                            className={`flex flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] text-left shadow-[var(--ds-shadow-card)] transition-shadow hover:shadow-[var(--ds-shadow-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                              isSelected ? 'ring-2 ring-[var(--ds-text-primary)]' : ''
                            } ${dish.is_active === false || dish.crm_enabled === false ? 'opacity-60' : ''}`}
                          >
                            <div className="relative">
                              {(dish.is_active === false || dish.crm_enabled === false) && (
                                <span className="absolute bottom-2 left-2 z-10 flex gap-1">
                                  {dish.is_active === false && (
                                    <span className="rounded-full bg-[var(--ds-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--ds-critical-text)]">
                                      spento in cassa
                                    </span>
                                  )}
                                  {dish.crm_enabled === false && (
                                    <span className="rounded-full bg-[var(--ds-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--ds-text-secondary)]">
                                      spento
                                    </span>
                                  )}
                                </span>
                              )}
                              {dish.photo_url ? (
                                <img
                                  src={dish.photo_url}
                                  alt=""
                                  className="h-32 w-full object-cover"
                                  onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                                />
                              ) : (
                                <div className="flex h-32 w-full items-center justify-center bg-[var(--ds-surface-row)]">
                                  <ImageIcon className="h-6 w-6 text-[var(--ds-text-subtle)]" aria-hidden />
                                </div>
                              )}
                              <span className="absolute left-2 top-2 rounded-full bg-[var(--ds-surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--ds-text-secondary)]">
                                {dish.category}
                              </span>
                              {dish.allergens.length > 0 && (
                                <span
                                  className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-[var(--ds-critical-solid)] px-2 py-0.5 text-[11px] font-semibold text-[#ffffff]"
                                  title={`${dish.allergens.length} allergeni: ${dish.allergens.join(', ')}`}
                                >
                                  <Info className="h-3 w-3" aria-hidden />
                                  <span className="tabular-nums">{dish.allergens.length}</span>
                                </span>
                              )}
                            </div>
                            <div className="flex flex-1 flex-col p-3">
                              <h3 className="text-[15px] font-semibold leading-tight text-[var(--ds-text-primary)]">{dish.name}</h3>
                              {dish.description && (
                                <p className="mt-1 line-clamp-2 text-[13px] text-[var(--ds-text-muted)]">{dish.description}</p>
                              )}
                              <div className="mt-auto flex items-center justify-between pt-3">
                                <span className="text-[19px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                                  € {Number(dish.price).toFixed(2)}
                                </span>
                                {canEdit && (
                                  <span className="flex items-center gap-1">
                                    <span
                                      role="switch"
                                      tabIndex={0}
                                      aria-checked={dish.crm_enabled !== false}
                                      aria-label={`${dish.crm_enabled !== false ? 'Spegni' : 'Accendi'} ${dish.name} nel menu`}
                                      onClick={e => { e.stopPropagation(); if (togglingDishId !== dish.id) handleToggleDish(dish); }}
                                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (togglingDishId !== dish.id) handleToggleDish(dish); } }}
                                      className={`relative mr-1 inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                                        dish.crm_enabled !== false ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                                      } ${togglingDishId === dish.id ? 'opacity-50' : ''}`}
                                    >
                                      <span aria-hidden="true"
                                        className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${dish.crm_enabled !== false ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
                                    </span>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      onClick={e => { e.stopPropagation(); handleEditDish(dish); }}
                                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleEditDish(dish); } }}
                                      className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none`}
                                      title="Modifica"
                                    >
                                      <Edit2 className="h-4 w-4" />
                                    </span>
                                    <span
                                      role="button"
                                      tabIndex={0}
                                      onClick={e => { e.stopPropagation(); setDeleteDishConfirm(dish); }}
                                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDeleteDishConfirm(dish); } }}
                                      className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                                      title="Elimina"
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </span>
                                  </span>
                                )}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
                      {filteredDishes.map((dish, i) => {
                        const isSelected = viewDish?.id === dish.id;
                        return (
                          <button
                            key={dish.id}
                            type="button"
                            onClick={() => setViewDish(isSelected ? null : dish)}
                            className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-border-focus)] ${
                              i > 0 ? 'border-t border-[var(--ds-border)]' : ''
                            } ${isSelected ? 'bg-[var(--ds-surface-row)]' : ''}`}
                          >
                            {dish.photo_url ? (
                              <img
                                src={dish.photo_url}
                                alt=""
                                className="h-11 w-11 flex-shrink-0 rounded-[12px] object-cover"
                                onError={e => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                              />
                            ) : (
                              <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[12px] bg-[var(--ds-surface-row)]">
                                <ImageIcon className="h-4 w-4 text-[var(--ds-text-subtle)]" aria-hidden />
                              </div>
                            )}
                            <div className={`min-w-0 flex-1 ${dish.is_active === false || dish.crm_enabled === false ? 'opacity-60' : ''}`}>
                              <div className="flex items-center gap-2">
                                <span className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{dish.name}</span>
                                {dish.is_active === false && <StatusPill tone="critical">spento in cassa</StatusPill>}
                                {dish.crm_enabled === false && <StatusPill tone="neutral">spento</StatusPill>}
                                {dish.dish_type === 'COMPOSED' && <StatusPill tone="neutral">composto</StatusPill>}
                                {(() => {
                                  const n = modifierGroups.filter(g => g.is_active && g.dish_ids.includes(dish.id)).length;
                                  return n > 0 ? <StatusPill tone="neutral">{n === 1 ? '1 variante' : `${n} varianti`}</StatusPill> : null;
                                })()}
                              </div>
                              <div className="truncate text-[13px] text-[var(--ds-text-muted)]">
                                {[dish.category, dish.description].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                            <div className="hidden flex-shrink-0 flex-wrap items-center justify-end gap-1 md:flex md:w-64">
                              {dish.allergens.length > 0 ? dish.allergens.map(a => (
                                <StatusPill key={a} tone="critical">{a}</StatusPill>
                              )) : (
                                <span className="text-[13px] text-[var(--ds-text-subtle)]">nessun allergene</span>
                              )}
                            </div>
                            <span className="flex-shrink-0 text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                              € {Number(dish.price).toFixed(2)}
                            </span>
                            {canEdit && (
                              <span className="flex flex-shrink-0 items-center gap-1">
                                {/* Ordine dentro la categoria: le frecce muovono
                                    nel menu intero, non nella vista filtrata. */}
                                <span className="hidden items-center sm:flex">
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    aria-disabled={reorderBusy}
                                    onClick={e => { e.stopPropagation(); if (!reorderBusy) handleMoveDish(dish, -1); }}
                                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!reorderBusy) handleMoveDish(dish, -1); } }}
                                    className={`${dsIconButton} h-9 w-7 bg-transparent shadow-none ${reorderBusy ? 'opacity-40' : ''}`}
                                    title="Sposta su"
                                  >
                                    <ChevronUp className="h-4 w-4" />
                                  </span>
                                  <span
                                    role="button"
                                    tabIndex={0}
                                    aria-disabled={reorderBusy}
                                    onClick={e => { e.stopPropagation(); if (!reorderBusy) handleMoveDish(dish, 1); }}
                                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (!reorderBusy) handleMoveDish(dish, 1); } }}
                                    className={`${dsIconButton} h-9 w-7 bg-transparent shadow-none ${reorderBusy ? 'opacity-40' : ''}`}
                                    title="Sposta giù"
                                  >
                                    <ChevronDown className="h-4 w-4" />
                                  </span>
                                </span>
                                <span
                                  role="switch"
                                  tabIndex={0}
                                  aria-checked={dish.crm_enabled !== false}
                                  aria-label={`${dish.crm_enabled !== false ? 'Spegni' : 'Accendi'} ${dish.name} nel menu`}
                                  onClick={e => { e.stopPropagation(); if (togglingDishId !== dish.id) handleToggleDish(dish); }}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (togglingDishId !== dish.id) handleToggleDish(dish); } }}
                                  className={`relative mx-1 inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                                    dish.crm_enabled !== false ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                                  } ${togglingDishId === dish.id ? 'opacity-50' : ''}`}
                                >
                                  <span aria-hidden="true"
                                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${dish.crm_enabled !== false ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
                                </span>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={e => { e.stopPropagation(); handleEditDish(dish); }}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); handleEditDish(dish); } }}
                                  className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none`}
                                  title="Modifica"
                                >
                                  <Edit2 className="h-4 w-4" />
                                </span>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={e => { e.stopPropagation(); setDeleteDishConfirm(dish); }}
                                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setDeleteDishConfirm(dish); } }}
                                  className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                                  title="Elimina"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </span>
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Detail panel. Desktop only — below lg the same dish opens in
                    DishDetailModal as a sheet, because a 320px column beside a
                    grid leaves neither readable. */}
                {detailPanelOpen && viewDish && (
                  <aside className="hidden w-80 flex-shrink-0 flex-col self-start overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] lg:flex">
                    <div className="relative">
                      {viewDish.photo_url ? (
                        <img src={viewDish.photo_url} alt="" className="h-40 w-full object-cover" />
                      ) : (
                        <div className="flex h-40 w-full items-center justify-center bg-[var(--ds-surface-row)]">
                          <ImageIcon className="h-7 w-7 text-[var(--ds-text-subtle)]" aria-hidden />
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={() => setViewDish(null)}
                        className={`${dsIconButton} absolute right-2 top-2 h-9 w-9`}
                        aria-label="Chiudi dettaglio"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex flex-1 flex-col gap-4 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <h3 className="text-[20px] font-semibold leading-tight tracking-[-0.015em] text-[var(--ds-text-primary)]">
                          {viewDish.name}
                        </h3>
                        <span className="flex-shrink-0 text-[20px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                          € {Number(viewDish.price).toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <StatusPill tone="neutral"><Tag className="h-3 w-3" />{viewDish.category}</StatusPill>
                      </div>
                      {viewDish.description && (
                        <p className="text-[14px] leading-relaxed text-[var(--ds-text-secondary)]">{viewDish.description}</p>
                      )}
                      <div>
                        <h4 className="mb-2 text-[13px] font-semibold text-[var(--ds-critical-text)]">Allergeni</h4>
                        {viewDish.allergens.length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {viewDish.allergens.map(a => (
                              <StatusPill key={a} tone="critical">{a}</StatusPill>
                            ))}
                          </div>
                        ) : (
                          <p className="text-[13px] text-[var(--ds-text-muted)]">Nessun allergene dichiarato.</p>
                        )}
                      </div>
                      <div>
                        <h4 className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">Usato nei banchetti</h4>
                        {(() => {
                          const used = banquetMenus.filter(m => {
                            if (m.courses && m.courses.length > 0) {
                              return m.courses.some(c => c.dish_ids.includes(viewDish.id));
                            }
                            return m.dish_ids.includes(viewDish.id);
                          });
                          if (used.length === 0) {
                            return (
                              <p className="rounded-[12px] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[13px] text-[var(--ds-text-muted)]">
                                Non ancora inserito in un menu banchetto.
                              </p>
                            );
                          }
                          return (
                            <ul className="space-y-1">
                              {used.slice(0, 6).map(m => (
                                <li key={m.id} className="truncate rounded-[12px] bg-[var(--ds-surface-row)] px-3 py-2 text-[13px] text-[var(--ds-text-primary)]">
                                  {m.name}
                                  {m.event_date && (
                                    <span className="text-[var(--ds-text-muted)]">
                                      {' · '}
                                      {new Date(m.event_date + 'T00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: 'numeric' })}
                                    </span>
                                  )}
                                </li>
                              ))}
                              {used.length > 6 && (
                                <li className="px-3 text-[13px] text-[var(--ds-text-muted)]">e altri {used.length - 6}</li>
                              )}
                            </ul>
                          );
                        })()}
                      </div>
                      {canEdit && (
                        <div className="mt-auto flex items-center gap-2 pt-2">
                          <button
                            type="button"
                            onClick={() => handleEditDish(viewDish)}
                            className={`${dsButton.primary} flex-1`}
                          >
                            <Edit2 className="h-4 w-4" /> Modifica piatto
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeleteDishConfirm(viewDish)}
                            className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                            title="Elimina piatto"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      )}
                    </div>
                  </aside>
                )}
              </div>
            )}
          </>
      )}

      {activeTab === 'BANQUETS' && (
        <div className="space-y-6">
          {banquetMenus.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              {banquetView === 'LIST' && (
                <SearchField
                  value={banquetSearchTerm}
                  onChange={setBanquetSearchTerm}
                  placeholder="Cerca banchetto o tipo evento..."
                  ariaLabel="Cerca banchetto"
                  className="sm:flex-1 sm:min-w-0"
                />
              )}
              <div className="flex items-center gap-2 sm:flex-shrink-0">
                <SegmentedControl<'LIST' | 'CALENDAR'>
                  value={banquetView}
                  onChange={setBanquetView}
                  ariaLabel="Vista banchetti"
                  size="sm"
                  equalWidth={false}
                  options={[
                    { value: 'LIST', label: 'Lista', icon: <ListIcon className="h-4 w-4" /> },
                    { value: 'CALENDAR', label: 'Calendario', icon: <Calendar className="h-4 w-4" /> },
                  ]}
                />
                {banquetView === 'LIST' && (
                  <button
                    type="button"
                    onClick={() => setShowBanquetSortModal(true)}
                    className={`${dsIconButton} ml-auto h-9 w-9`}
                    aria-label="Ordina banchetti"
                    title={BANQUET_SORT_OPTIONS.find(o => o.value === banquetSortBy)?.label}
                  >
                    <ArrowUpDown className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          )}
          {banquetView === 'LIST' && (() => {
            const renderBanquetCard = (menu: BanquetMenu) => {
                const isPast = computeBanquetTimeStatus(menu) === 'PAST';
                const isQuote = banquetStatusOf(menu) === 'QUOTE';
                const paymentStatus = computeBanquetPaymentStatus(menu);
                const due = computeBanquetTotalDue(menu);
                const paid = Number(menu.total_paid || 0);
                const outstanding = Math.max(0, due - paid);
                // Guard the divide: a banquet with no price yet has due = 0, and
                // 0/0 would paint a full bar on something nobody has paid for.
                const paidRatio = due > 0 ? Math.min(1, paid / due) : 0;
                // Rosso solo se l'evento è entro fine settimana (o già passato).
                const urgent = outstanding > 0 && isOutstandingUrgent(menu, endOfCurrentWeek(new Date()));

                const courseCount = menu.courses && menu.courses.length > 0 ? menu.courses.length : null;
                const dishCount = menu.courses && menu.courses.length > 0
                  ? menu.courses.reduce((sum, c) => sum + c.dish_ids.length, 0)
                  : menu.dish_ids.length;

                /* Gli stessi tre numeri, due volte: la striscia da desktop li
                   incolonna e ha ~110px a testa, la lista da mobile ha tutta la
                   riga. Da larghi "3/5" con l'etichetta accanto sta; da stretti
                   la frase intera si legge senza doverla decifrare. Il valore lo
                   si calcola qui una volta, così le due rese non possono
                   divergere. */
                /* Le note sono tre caselle fisse — cucina, sala, mise en place —
                   non una lista, quindi il conteggio non passa mai 3: dice su
                   quante aree c'è qualcosa da leggere, non quanto. Il testo
                   sta nella scheda di dettaglio e nelle stampe. */
                const notesCount = [menu.notes_courses, menu.notes_service, menu.notes_mise_en_place]
                  .filter(n => n?.trim()).length;

                const guestsValue = menu.guests != null && Number(menu.guests) > 0 ? Number(menu.guests) : '—';
                const priceValue = `€ ${Number(menu.price_per_person) || 0}`;
                // Senza portate definite resta il solo conteggio dei piatti:
                // "5 in 0 portate" sarebbe falso.
                const dishesLong = courseCount != null
                  ? `${dishCount} in ${courseCount} ${courseCount === 1 ? 'portata' : 'portate'}`
                  : `${dishCount}`;

                const eventDate = menu.event_date ? new Date(menu.event_date + 'T00:00') : null;
                const isLunch = menu.shift === Shift.LUNCH;
                const tileTone = !menu.shift
                  ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]'
                  : isLunch
                    ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                    : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]';

                return (
                  <div
                    key={menu.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setViewBanquet(menu)}
                    onKeyDown={e => {
                      if (e.target !== e.currentTarget) return;
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewBanquet(menu); }
                    }}
                    // Raised only while its own menu is open. Grid siblings paint
                    // in DOM order, so without this the dropdown slides under the
                    // next card instead of over it.
                    className={`flex cursor-pointer flex-col rounded-[20px] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)] transition-shadow hover:shadow-[var(--ds-shadow-raised)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${isPast ? 'opacity-75' : ''} ${cardMenuOpenId === menu.id ? 'relative z-40' : ''}`}
                  >
                      <div className="flex items-start gap-4">
                          {/* Date tile — the thing you scan a banquet list for.
                              Il turno sta in cima: è il primo filtro con cui si
                              legge la lista (pranzo o cena), e sopra la data fa
                              da intestazione invece che da coda.
                              `min-h` invece di `h`: l'altezza la decide il
                              contenuto più il padding, così le tessere restano
                              allineate fra loro ma non strozzate. */}
                          <div className={`flex min-h-[92px] w-[62px] flex-shrink-0 flex-col items-center justify-center rounded-[16px] px-2 py-3 ${tileTone}`}>
                              {menu.shift && (
                                isLunch ? <Sun className="mb-1 h-3.5 w-3.5" aria-label="Pranzo" />
                                        : <Sunset className="mb-1 h-3.5 w-3.5" aria-label="Cena" />
                              )}
                              {eventDate ? (
                                <>
                                  <span className="text-[11px] font-semibold leading-none">
                                    {ITALIAN_WEEKDAYS[(eventDate.getDay() + 6) % 7]}
                                  </span>
                                  <span className="text-[24px] font-bold leading-tight tabular-nums">{eventDate.getDate()}</span>
                                  <span className="text-[11px] leading-none">
                                    {ITALIAN_MONTHS[eventDate.getMonth()].slice(0, 3).toLowerCase()}
                                  </span>
                                </>
                              ) : (
                                <span className="text-center text-[11px] font-medium leading-tight">Senza data</span>
                              )}
                          </div>

                          <div className="min-w-0 flex-1">
                              <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0">
                                      <h3 className="truncate text-[19px] font-semibold leading-tight tracking-[-0.01em] text-[var(--ds-text-primary)]">
                                        {menu.name}
                                      </h3>
                                      {menu.description && (
                                        <p className="mt-1 hidden line-clamp-1 text-[13px] text-[var(--ds-text-muted)] sm:block">{menu.description}</p>
                                      )}
                                      {/* Da mobile la descrizione se ne va nel blocco
                                          grigio, quindi qui la pill resta attaccata al
                                          titolo; da sm segue la descrizione. Una
                                          posizione sola che funziona in entrambi. */}
                                      {(isQuote || notesCount > 0) && (
                                        <span className="mt-2 flex flex-wrap items-center gap-1.5">
                                          {/* pending = "in attesa di una decisione": è
                                              esattamente cosa è un preventivo. */}
                                          {isQuote && (
                                            <StatusPill tone="pending" className="h-7 px-2.5">preventivo</StatusPill>
                                          )}
                                          {notesCount > 0 && (
                                            <StatusPill tone="neutral" className="h-7 px-2.5">
                                              <StickyNote className="h-3.5 w-3.5" aria-hidden />
                                              {notesCount} {notesCount === 1 ? 'nota' : 'note'}
                                            </StatusPill>
                                          )}
                                        </span>
                                      )}
                                  </div>
                                  <div className="flex flex-shrink-0 items-center gap-1">
                                      {/* Indicatore, non comando: dice che il
                                          banchetto ha tavoli assegnati. Sta nella
                                          fila delle azioni per stare in cerchio
                                          come le altre, ma resta uno <span> —
                                          niente hover, niente focus, non finisce
                                          nella tabulazione. */}
                                      {(menu.table_ids?.length ?? 0) > 0 && (
                                      // Stessa base delle due accanto, `dsIconButton`
                                      // incluso: scritto a mano restava di 36px mentre
                                      // le altre si risolvevano diverse — fra `h-11`
                                      // della base e `h-9` qui vince l'ordine del CSS
                                      // generato, non quello dell'attributo. Gli hover
                                      // sono rimessi al valore di riposo perché questo
                                      // non è un comando.
                                      <span
                                          className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] shadow-none hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-muted)]`}
                                          title="Tavoli assegnati"
                                          aria-label="Tavoli assegnati"
                                          role="img"
                                      >
                                          <BookOpen className="h-4 w-4" />
                                      </span>
                                      )}
                                      {canManageBanquetPayments && (
                                      // Il cerchio è neutro come quello dei tre
                                      // puntini — la tinta di stato era così
                                      // pallida da non leggersi come cerchio. Lo
                                      // stato resta sul glifo, e comunque la riga
                                      // dell'importo e la barra lo dicono più forte.
                                      <button
                                          onClick={e => { e.stopPropagation(); setPaymentsBanquet(menu); }}
                                          className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none ${
                                            paymentStatus === 'PAID'
                                              ? 'text-[var(--ds-seated-text)] hover:text-[var(--ds-seated-text)]'
                                              : urgent
                                                ? 'text-[var(--ds-critical-text)] hover:text-[var(--ds-critical-text)]'
                                                : 'text-[var(--ds-pending-text)] hover:text-[var(--ds-pending-text)]'
                                          }`}
                                          title="Pagamenti"
                                      >
                                          <Wallet className="h-4 w-4" />
                                      </button>
                                      )}
                                      {canEdit && (
                                      // Ref wraps the trigger as well as the menu.
                                      // With it on the menu alone, mousedown on the
                                      // trigger counted as "outside", closed the
                                      // menu, and the click then reopened it — so
                                      // the dots never appeared to close.
                                      <div className="relative" ref={cardMenuOpenId === menu.id ? cardMenuRef : undefined}>
                                          <button
                                              type="button"
                                              onClick={e => { e.stopPropagation(); setCardMenuOpenId(cardMenuOpenId === menu.id ? null : menu.id); }}
                                              className={`${dsIconButton} h-9 w-9 bg-[var(--ds-surface-row)] shadow-none`}
                                              aria-label="Altre azioni"
                                          >
                                              <MoreHorizontal className="h-4 w-4" />
                                          </button>
                                          {cardMenuOpenId === menu.id && (
                                              <div
 className="absolute right-0 top-full z-30 mt-1 w-48 overflow-hidden rounded-[16px] bg-[var(--ds-surface)] py-1 shadow-[var(--ds-shadow-raised)] duration-100"
                                              >
                                                  <button
                                                      type="button"
                                                      onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); printBanquet(menu, dishes, { showPrice: canViewBanquetPrice }); }}
                                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                                  >
                                                      <Printer className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                                                      Stampa / PDF
                                                  </button>
                                                  <button
                                                      type="button"
                                                      onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); printBanquet(menu, dishes, { kitchenMode: true }); }}
                                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                                  >
                                                      <ChefHat className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                                                      Stampa per cucina
                                                  </button>
                                                  <button
                                                      type="button"
                                                      onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); handleEditBanquet(menu); }}
                                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                                  >
                                                      <Edit2 className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                                                      Modifica
                                                  </button>
                                                  <button
                                                      type="button"
                                                      onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); openShareSheet(menu); }}
                                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                                  >
                                                      <Share2 className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                                                      Condividi preventivo
                                                  </button>
                                                  {isQuote ? (
                                                      <button
                                                          type="button"
                                                          onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); handleSetBanquetStatus(menu, BanquetStatus.CONFIRMED); }}
                                                          className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-seated-text)] transition-colors hover:bg-[var(--ds-seated-tint)]"
                                                      >
                                                          <Check className="h-3.5 w-3.5" />
                                                          Conferma banchetto
                                                      </button>
                                                  ) : (
                                                      <button
                                                          type="button"
                                                          onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); handleSetBanquetStatus(menu, BanquetStatus.QUOTE); }}
                                                          className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]"
                                                      >
                                                          <StickyNote className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" />
                                                          Riporta a preventivo
                                                      </button>
                                                  )}
                                                  <button
                                                      type="button"
                                                      onClick={e => { e.stopPropagation(); setCardMenuOpenId(null); setDeleteBanquetConfirm(menu); }}
                                                      className="flex w-full items-center gap-2 px-4 py-2.5 text-[13px] font-medium text-[var(--ds-critical-text)] transition-colors hover:bg-[var(--ds-critical-tint)]"
                                                  >
                                                      <Trash2 className="h-3.5 w-3.5" />
                                                      Elimina
                                                  </button>
                                              </div>
                                          )}
                                      </div>
                                      )}
                                  </div>
                              </div>

                              {/* Three figures, one strip — the shape repeats on every
                                  card so the eye lands on the same spot each time. */}
                              <div className="mt-4 hidden items-stretch rounded-[16px] bg-[var(--ds-surface-row)] sm:flex">
                                  <div className="flex-1 px-3 py-3 text-center">
                                      <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                                        {guestsValue}
                                      </div>
                                      <div className="text-[11px] text-[var(--ds-text-muted)]">coperti</div>
                                  </div>
                                  {canViewBanquetPrice && (
                                    <div className="flex-1 border-l border-[var(--ds-border)] px-3 py-3 text-center">
                                        <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                                          {priceValue}
                                        </div>
                                        <div className="text-[11px] text-[var(--ds-text-muted)]">a persona</div>
                                    </div>
                                  )}
                                  <div className="flex-1 border-l border-[var(--ds-border)] px-3 py-3 text-center">
                                      <div className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">
                                        {courseCount != null ? `${courseCount}/${dishCount}` : dishCount}
                                      </div>
                                      <div className="text-[11px] text-[var(--ds-text-muted)]">
                                        {courseCount != null ? 'portate/piatti' : 'piatti'}
                                      </div>
                                  </div>
                              </div>
                          </div>
                      </div>

                      {/* Solo mobile. I numeri escono dalla colonna della tessera:
                          rientrati di 78px (tessera piu' gap) i tre incolonnati
                          mandavano "a persona" a capo. Fuori dalla riga prendono
                          tutta la scheda — etichetta a sinistra, valore a destra,
                          allineati su un bordo solo.

                          La descrizione apre il blocco invece di stare sotto al
                          titolo: li' si troncava a "Menu per...". Il filetto lo
                          mette ogni riga e lo toglie la prima, cosi' quando la
                          descrizione manca il bordo non resta appeso sopra
                          "Coperti". Il padding sta sul contenitore, cosi' i
                          filetti restano rientrati. */}
                      <div className="mt-3 rounded-[16px] bg-[var(--ds-surface-row)] px-4 sm:hidden">
                          {menu.description && (
                            <p className="line-clamp-2 border-t border-[var(--ds-border)] py-3 text-[13px] text-[var(--ds-text-muted)] first:border-t-0">
                              {menu.description}
                            </p>
                          )}
                          <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] py-3 first:border-t-0">
                              <span className="text-[13px] text-[var(--ds-text-muted)]">Coperti</span>
                              <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{guestsValue}</span>
                          </div>
                          {canViewBanquetPrice && (
                            <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] py-3 first:border-t-0">
                                <span className="text-[13px] text-[var(--ds-text-muted)]">A persona</span>
                                <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{priceValue}</span>
                            </div>
                          )}
                          <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] py-3 first:border-t-0">
                              <span className="text-[13px] text-[var(--ds-text-muted)]">Piatti</span>
                              <span className="text-[15px] font-semibold tabular-nums text-[var(--ds-text-primary)]">{dishesLong}</span>
                          </div>
                      </div>

                      {/* Payment line + how far along the money is. */}
                      {canViewBanquetPrice && due > 0 && (
                        <div className="mt-4">
                            {/* Quanto manca a sinistra, quanto è già entrato in
                                fondo alla riga, sopra i due capi della barra che
                                dicono la stessa cosa. L'acconto si mostra anche a
                                zero: "acconto € 0" è un'informazione, la sua
                                assenza si legge come un dato che manca. A saldo
                                fatto sparisce — non c'è più un resto da separare. */}
                            <div className="flex items-baseline justify-between gap-3 text-[13px]">
                                {outstanding > 0 ? (
                                  <>
                                    <span className="min-w-0">
                                      <span className={`font-semibold tabular-nums ${urgent ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-pending-text)]'}`}>€ {formatEuro(outstanding)}</span>
                                      <span className="text-[var(--ds-text-muted)]"> da incassare</span>
                                    </span>
                                    <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-muted)]">acconto € {formatEuro(paid)}</span>
                                  </>
                                ) : (
                                  <span className="min-w-0">
                                    <span className="font-semibold tabular-nums text-[var(--ds-seated-text)]">€ {formatEuro(due)}</span>
                                    <span className="text-[var(--ds-text-muted)]"> saldato</span>
                                  </span>
                                )}
                            </div>
                            <div className="mt-2.5 h-1 w-full overflow-hidden rounded-full bg-[var(--ds-surface-row)]">
                                <div
                                  className={`h-full rounded-full ${outstanding <= 0 ? 'bg-[var(--ds-seated-solid)]' : urgent ? 'bg-[var(--ds-critical-solid)]' : 'bg-[var(--ds-pending-solid)]'}`}
                                  style={{ width: `${Math.round(paidRatio * 100)}%` }}
                                />
                            </div>
                        </div>
                      )}
                  </div>
                );
            };
            const GROUP_TONE: Record<BanquetGroupKey, 'attention' | 'pending' | 'info' | 'muted'> = {
              week: 'attention', month: 'pending', later: 'info', past: 'muted',
            };
            const visibleGroups = (['week', 'month', 'later', 'past'] as BanquetGroupKey[])
              .map(key => ({ key, items: groupedBanquets[key] }))
              .filter(g => g.items.length > 0);

            return (
              <div className="space-y-5">
                {statusBanquets.length === 0 && (
                  <EmptyState icon={BookOpen}>
                    {banquetStatusFilter === 'QUOTE'
                      ? 'Nessun preventivo in corso.'
                      : banquetMenus.length > 0
                        ? 'Nessun banchetto confermato: i preventivi sono nella scheda accanto.'
                        : 'Non hai ancora creato banchetti.'}
                  </EmptyState>
                )}
                {statusBanquets.length > 0 && visibleGroups.length === 0 && (
                  <EmptyState icon={Search}>
                    Nessun banchetto per «{banquetSearchTerm}».
                  </EmptyState>
                )}
                {visibleGroups.map(group => {
                  const totalGuests = group.items.reduce((s, b) => s + (Number(b.guests) || 0), 0);
                  const totalOutstanding = group.items.reduce((s, b) => {
                    return s + Math.max(0, computeBanquetTotalDue(b) - Number(b.total_paid || 0));
                  }, 0);
                  const isOpen = expandedBanquetGroups.has(group.key);
                  return (
                    <div key={group.key}>
                      <SectionHeader
                        tone={GROUP_TONE[group.key]}
                        onToggle={() => toggleBanquetGroup(group.key)}
                        expanded={isOpen}
                        meta={
                          <>
                            {group.items.length} {group.items.length === 1 ? 'banchetto' : 'banchetti'}
                            {totalGuests > 0 && ` · ${totalGuests} coperti`}
                            {canViewBanquetPrice && totalOutstanding > 0 && ` · € ${formatEuro(totalOutstanding)} da incassare`}
                          </>
                        }
                      >
                        {BANQUET_GROUP_LABEL[group.key]}
                      </SectionHeader>
                      {isOpen && (
                        <div className="mt-3 grid grid-cols-1 gap-4 xl:grid-cols-2">
                          {group.items.map(renderBanquetCard)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {banquetView === 'CALENDAR' && (
            <BanquetCalendar
              banquetMenus={statusBanquets}
              onSelectBanquet={handleEditBanquet}
              onViewBanquet={setViewBanquet}
              canEdit={canEdit}
            />
          )}
        </div>
      )}

      {/* Add Dish Modal */}
      {isDishFormOpen && (
        <ModalShell
          open={isDishFormOpen}
          onClose={() => setIsDishFormOpen(false)}
          title={isEditingDish ? 'Modifica piatto' : 'Aggiungi nuovo piatto'}
          size="md"
          bodyClassName="p-5 sm:p-6"
          footer={
            <>
              <button
                type="button"
                onClick={() => setIsDishFormOpen(false)}
                className={dsButton.secondary}
              >
                Annulla
              </button>
              <button
                type="submit"
                form="dish-form"
                disabled={isSavingDish}
                className={dsButton.primary}
              >
                {isSavingDish && <Loader2 className="h-4 w-4 animate-spin" />}
                Salva piatto
              </button>
            </>
          }
        >
          {/* Three cards on the canvas, not one flat run of fields: the shell's
              body is deliberately unpadded so cards inside it read as raised. */}
          <form id="dish-form" onSubmit={handleAddDishSubmit} className="space-y-4">
            <FormCard title="Dettagli">
              <div className="space-y-4">
                <Field label="Nome" required>
                  <input
                    required
                    className={dsInput}
                    value={newDish.name}
                    onChange={e => setNewDish({ ...newDish, name: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Prezzo (€)" required>
                    <input
                      type="number"
                      step="0.5"
                      required
                      className={dsInput}
                      value={newDish.price}
                      onChange={e => setNewDish({ ...newDish, price: parseFloat(e.target.value) })}
                    />
                  </Field>
                  <Field label="Categoria">
                    <select
                      className={dsSelect}
                      value={newDish.category}
                      onChange={e => {
                        const category = e.target.value;
                        // In creazione la categoria porta i suoi menu di
                        // default (quelli spuntati in modale Categorie); in
                        // modifica le spunte del piatto non si toccano.
                        const catDefault = !isEditingDish
                          ? menuCats?.find(c => c.name === category)?.menu_ids
                          : null;
                        setNewDish(prev => ({
                          ...prev,
                          category,
                          ...(Array.isArray(catDefault) && catDefault.length > 0 ? { menu_ids: catDefault } : {}),
                        }));
                      }}
                    >
                      {/* Le categorie vere del ristorante (incluse quelle
                          appena create, ancora vuote); i sei classici solo
                          finché l'elenco non è arrivato. Il valore corrente
                          resta sempre in lista o la select lo azzererebbe. */}
                      {(() => {
                        const base = menuCats && menuCats.length > 0
                          ? menuCats.map(c => c.name)
                          : [...BANQUET_DISH_CATEGORIES];
                        const options = newDish.category && !base.includes(newDish.category)
                          ? [newDish.category, ...base]
                          : base;
                        return options.map(name => <option key={name}>{name}</option>);
                      })()}
                    </select>
                  </Field>
                  {/* Il 10% è la somministrazione in loco: quasi ogni piatto
                      resta lì. Serve solo per i casi diversi (asporto 22,
                      pane 4…) e alimenta scontrino e fattura per aliquota. */}
                  <Field label="Aliquota IVA">
                    <select
                      className={dsSelect}
                      value={newDish.vat_rate ?? defaultVatRate}
                      onChange={e => setNewDish({ ...newDish, vat_rate: Number(e.target.value) })}
                    >
                      {VAT_RATES.map(r => (
                        <option key={r} value={r}>{r}%</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <Field label="Descrizione">
                  <textarea
                    rows={4}
                    className={`${dsTextarea} resize-none`}
                    value={newDish.description}
                    onChange={e => setNewDish({ ...newDish, description: e.target.value })}
                  />
                </Field>
              </div>
            </FormCard>

            {/* Le spunte dei menu: stesso vestito degli allergeni. Un piatto
                può stare in più menu; fuori da tutti non si batte da nessuna
                parte, e il footer lo dice invece di impedirlo — è legittimo
                per un piatto in preparazione. */}
            <FormCard
              title="Nei menu"
              aside={
                (newDish.menu_ids?.length ?? 0) === 0
                  ? <span className="text-[13px] text-[var(--ds-pending-text)]">in nessun menu</span>
                  : <span className="text-[13px] text-[var(--ds-text-muted)]">{newDish.menu_ids!.length} selezionati</span>
              }
            >
              <div className="flex flex-wrap gap-2">
                {menus.map(m => {
                  const isSelected = newDish.menu_ids?.includes(m.id) ?? false;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleDishMenu(m.id)}
                      aria-pressed={isSelected}
                      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                        isSelected
                          ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                      }`}
                    >
                      {isSelected && <Check size={13} />}
                      {m.name}
                    </button>
                  );
                })}
              </div>
            </FormCard>

            {/* I gruppi di varianti agganciati al piatto: cotture, aggiunte,
                sovrapprezzi. Anche quelli della cassa si agganciano
                liberamente — il legame fatto qui sopravvive agli import. */}
            <FormCard
              title="Varianti"
              aside={
                dishGroupIds.length === 0
                  ? <span className="text-[13px] text-[var(--ds-text-muted)]">nessun gruppo</span>
                  : <span className="text-[13px] text-[var(--ds-text-muted)]">{dishGroupIds.length} {dishGroupIds.length === 1 ? 'gruppo' : 'gruppi'}</span>
              }
            >
              {modifierGroups.length === 0 ? (
                <p className="text-[13px] text-[var(--ds-text-muted)]">
                  Nessun gruppo di varianti: crealo da «Varianti» in testa alla pagina.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {modifierGroups
                    .filter(g => g.is_active || dishGroupIds.includes(g.id))
                    .map(g => {
                      const isSelected = dishGroupIds.includes(g.id);
                      const pp = !!g.external_ref?.startsWith('pp:varianti:');
                      return (
                        <button
                          key={g.id}
                          type="button"
                          onClick={() => setDishGroupIds(prev =>
                            prev.includes(g.id) ? prev.filter(x => x !== g.id) : [...prev, g.id])}
                          aria-pressed={isSelected}
                          title={pp ? 'Gruppo della cassa: le opzioni si aggiornano a ogni import' : undefined}
                          className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                            isSelected
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                          }`}
                        >
                          {isSelected && <Check size={13} />}
                          {g.name}
                          {pp && <span className="text-[11px] opacity-70">cassa</span>}
                        </button>
                      );
                    })}
                </div>
              )}
            </FormCard>

            {/* Semplice = com'è sempre stato. Composto = fatto di ingredienti
                pre-inclusi che il cameriere può togliere («Senza cipolla»),
                gratis o a sconto. */}
            <FormCard
              title="Composizione"
              aside={newDish.dish_type === 'COMPOSED'
                ? <span className="text-[13px] text-[var(--ds-text-muted)]">{dishComponents.length} {dishComponents.length === 1 ? 'ingrediente' : 'ingredienti'}</span>
                : undefined}
            >
              <div className="space-y-3">
                <div className="flex items-center rounded-full bg-[var(--ds-surface-row)] p-1">
                  {([['SIMPLE', 'Semplice'], ['COMPOSED', 'Composto']] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setNewDish({ ...newDish, dish_type: value })}
                      aria-pressed={(newDish.dish_type ?? 'SIMPLE') === value}
                      className={`inline-flex h-9 flex-1 items-center justify-center rounded-full text-[13px] font-medium transition-colors ${
                        (newDish.dish_type ?? 'SIMPLE') === value
                          ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                          : 'text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* Al peso: un solo articolo «Bistecca» col prezzo AL KG al
                    posto delle grammature finte; i grammi si chiedono alla
                    battuta e la cucina li corregge dopo la pesata. */}
                <button
                  type="button"
                  onClick={() => setNewDish({ ...newDish, sold_by_weight: !newDish.sold_by_weight })}
                  aria-pressed={newDish.sold_by_weight === true}
                  className="flex min-h-[44px] w-full items-center gap-3 rounded-[12px] bg-[var(--ds-surface-row)] px-3 py-2 text-left transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <span
                    aria-hidden
                    className={`relative inline-flex h-6 w-10 flex-shrink-0 items-center rounded-full transition-colors ${
                      newDish.sold_by_weight ? 'bg-[var(--ds-action-bg)]' : 'bg-[var(--ds-border-strong)]'
                    }`}
                  >
                    <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${newDish.sold_by_weight ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14px] font-medium text-[var(--ds-text-primary)]">Vendita al peso</span>
                    <span className="block text-[12px] text-[var(--ds-text-muted)]">
                      il prezzo qui sopra vale al kg; alla battuta si chiedono i grammi, la cucina li corregge dopo la pesata
                    </span>
                  </span>
                </button>
                {/* Il range del piatto e da dove parte lo stepper: un filetto
                    non parte da 500 g come una bistecca. Vuoto = default
                    della UI (300–1000, parte da 500). Solo guida di battuta:
                    la bilancia dice sempre l'ultima parola. */}
                {newDish.sold_by_weight === true && (
                  <div className="grid grid-cols-3 gap-2">
                    {([
                      ['weight_min_grams', 'da (g)', '300'],
                      ['weight_max_grams', 'a (g)', '1000'],
                      ['weight_default_grams', 'parte da (g)', '500'],
                    ] as const).map(([field, label, ph]) => (
                      <label key={field} className="block">
                        <span className="mb-1 block text-[12px] font-medium text-[var(--ds-text-muted)]">{label}</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={50000}
                          step={10}
                          placeholder={ph}
                          className={dsInput}
                          value={newDish[field] ?? ''}
                          onChange={e => {
                            const n = Math.round(Number(e.target.value));
                            setNewDish({ ...newDish, [field]: e.target.value === '' || !Number.isFinite(n) || n <= 0 ? null : n });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                )}
                {newDish.dish_type === 'COMPOSED' && (
                  <div className="space-y-2">
                    {dishComponents.map((c, i) => (
                      <div key={c.id ?? `new-${i}`} className="flex items-center gap-2">
                        {/* dsInput porta w-full: i due campi vanno dimensionati
                            dal contenitore, non con classi di larghezza sul
                            campo — la cascata le farebbe perdere e lo sconto
                            si mangerebbe la riga schiacciando il nome. */}
                        <div className="min-w-0 flex-1">
                          <input
                            className={dsInput}
                            maxLength={100}
                            placeholder="Ingrediente…"
                            value={c.name}
                            onChange={e => setDishComponents(prev => prev.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                          />
                        </div>
                        <div className="w-28 flex-none">
                          <input
                            className={`${dsInput} text-right tabular-nums`}
                            inputMode="decimal"
                            placeholder="sconto €"
                            title="Sconto se tolto (vuoto = togliere è gratis)"
                            value={c.sconto}
                            onChange={e => setDishComponents(prev => prev.map((x, j) => j === i ? { ...x, sconto: e.target.value } : x))}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => setDishComponents(prev => prev.filter((_, j) => j !== i))}
                          className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                          title="Togli ingrediente"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => setDishComponents(prev => [...prev, { name: '', sconto: '' }])}
                      className={`${dsButton.quiet} h-9 px-4 text-[13px]`}
                    >
                      <Plus className="h-3.5 w-3.5" /> Ingrediente
                    </button>
                  </div>
                )}
              </div>
            </FormCard>

            <FormCard title="Foto" aside={<span className="text-[13px] text-[var(--ds-text-muted)]">opzionale</span>}>
              <div className="flex items-start gap-4">
                {newDish.photo_url ? (
                  <img
                    src={newDish.photo_url}
                    alt="Anteprima"
                    className="h-20 w-20 flex-shrink-0 rounded-[16px] object-cover"
                    onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                  />
                ) : (
                  <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center rounded-[16px] bg-[var(--ds-surface-row)]">
                    <ImageIcon className="h-6 w-6 text-[var(--ds-text-subtle)]" aria-hidden />
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <input
                    type="url"
                    placeholder="https://... oppure carica un file"
                    className={dsInput}
                    value={newDish.photo_url?.startsWith('data:') ? '' : (newDish.photo_url || '')}
                    onChange={e => setNewDish({ ...newDish, photo_url: e.target.value })}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      ref={photoFileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      className="hidden"
                      onChange={handlePhotoFileChange}
                    />
                    <button
                      type="button"
                      onClick={() => photoFileInputRef.current?.click()}
                      disabled={photoUploading}
                      className={`${dsButton.quiet} h-9 px-4 text-[13px] disabled:cursor-wait`}
                    >
                      {photoUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {photoUploading ? 'Elaborazione…' : 'Carica foto'}
                    </button>
                    {newDish.photo_url && (
                      <button
                        type="button"
                        onClick={() => setNewDish({ ...newDish, photo_url: '' })}
                        className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-[13px] text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
                      >
                        <X className="h-3.5 w-3.5" />
                        Rimuovi
                      </button>
                    )}
                  </div>
                  <p className="text-[13px] leading-snug text-[var(--ds-text-muted)]">
                    JPG, PNG o WebP — ridimensionata automaticamente a max 800×800px, ottimizzata per il web.
                  </p>
                  {photoUploadError && (
                    <p className="text-[13px] text-[var(--ds-critical-text)]">{photoUploadError}</p>
                  )}
                </div>
              </div>
            </FormCard>

            <FormCard
              title="Allergeni"
              aside={
                (newDish.allergens?.length ?? 0) > 0
                  ? <span className="text-[13px] text-[var(--ds-text-muted)]">{newDish.allergens?.length} selezionati</span>
                  : undefined
              }
            >
              <div className="flex flex-wrap gap-2">
                {COMMON_ALLERGENS.map(allergen => {
                  const isSelected = newDish.allergens?.includes(allergen);
                  return (
                    <button
                      key={allergen}
                      type="button"
                      onClick={() => toggleAllergen(allergen)}
                      aria-pressed={isSelected}
                      className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                        isSelected
                          ? 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
                          : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                      }`}
                    >
                      {isSelected && <Check size={13} />}
                      {allergen}
                    </button>
                  );
                })}
              </div>
            </FormCard>
          </form>
        </ModalShell>
      )}

      {/* Add Banquet Modal */}
      {isBanquetFormOpen && (
        <ModalShell
          open={isBanquetFormOpen}
          onClose={closeBanquetForm}
          title={isEditingBanquet ? 'Modifica menu banchetto' : 'Crea menu banchetto'}
          // The step counter said what the stepper below already shows, and
          // selected. This line is the one thing the header could not say.
          subtitle="Aggiungi almeno un piatto per completare il menù."
          size="lg"
          fixedHeight
          // No top padding: the pinned stepper above already supplies it.
          bodyClassName="px-5 pb-5 sm:px-6 sm:pb-6"
          // One row at every width: back, the save, forward. Stacked, the two
          // arrows became two lonely rows around the button.
          footerLayout="row"
          /* Step navigation is two bare arrows, parked at the two ends of the
             footer: back on the far left, forward past the save. Labelled
             Indietro/Avanti buttons read as the way through the form, and the
             steps never gated each other — the stepper above is the real
             navigation, these just walk it one at a time. */
          footerStart={
            <button
              type="button"
              onClick={() => setBanquetStep(s => Math.max(0, s - 1))}
              disabled={banquetStep === 0}
              aria-label="Passo precedente"
              title="Passo precedente"
              className={dsStepArrow}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          }
          footer={
            <>
              {/* No Annulla: the X in the header closes the modal, and one exit
                  is enough. On every step, not just the last — there is nothing
                  to advance through before saving becomes allowed. */}
              <button
                onClick={handleAddBanquetSubmit}
                type="button"
                disabled={isSavingBanquet || banquetMissingRequired.length > 0}
                className={`min-w-0 flex-1 sm:flex-none ${dsButton.primary}`}
              >
                {isSavingBanquet && <Loader2 className="h-4 w-4 animate-spin" />}
                {isEditingBanquet ? 'Salva modifiche' : 'Crea menu'}
              </button>
              <button
                type="button"
                onClick={() => setBanquetStep(s => Math.min(BANQUET_STEPS.length - 1, s + 1))}
                disabled={banquetStep === BANQUET_STEPS.length - 1}
                aria-label="Passo successivo"
                title="Passo successivo"
                className={dsStepArrow}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </>
          }
          subheader={
            <StepNav
              steps={BANQUET_STEPS}
              current={banquetStep}
              onSelect={setBanquetStep}
              ariaLabel="Passi del menu banchetto"
            />
          }
        >
          {/* Scroll anchor: each step starts at its own top. The shell owns the
              scroll container, so we bring this sentinel into view rather than
              reaching for a ref it does not expose. */}
          <div ref={banquetFormScrollRef} aria-hidden />


          {!isEditingBanquet && banquetDraftBanner && (
            <Callout
              tone="pending"
              icon={Info}
              title="Bozza non salvata trovata"
              className="mb-4"
              action={
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleRestoreBanquetDraft}
                    // Era bianco su gold: 3.25:1, sotto AA (§3.3), con l'esadecimale
                    // scritto a mano invece del token. Stesso primary del gemello in
                    // ReservationList.
                    className="inline-flex h-9 items-center rounded-full bg-[var(--ds-action-bg)] px-4 text-[13px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    Riprendi
                  </button>
                  <button
                    type="button"
                    onClick={handleDiscardBanquetDraft}
                    className="inline-flex h-9 items-center rounded-full bg-[var(--ds-surface)] px-4 text-[13px] font-semibold text-[var(--ds-pending-text)] transition-opacity hover:opacity-90"
                  >
                    Scarta
                  </button>
                </div>
              }
            >
              Salvata {new Date(banquetDraftBanner.savedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
            </Callout>
          )}

          <form onSubmit={handleAddBanquetSubmit} className="space-y-4">

              {/* SECTION: Cliente */}
              <section className={banquetStep === 0 ? 'block' : 'hidden'}>
                <FormCard title="Cliente">
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Chi ha richiesto il banchetto. Selezionalo dalla rubrica per collegare la prenotazione.</p>
                {selectedBanquetCustomer ? (
                  <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--ds-border)] bg-[var(--ds-canvas)] p-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-[var(--ds-text-primary)] text-sm truncate">{selectedBanquetCustomer.name}</div>
                      <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--ds-text-muted)]">
                        {selectedBanquetCustomer.phone && (
                          <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" /> {selectedBanquetCustomer.phone}</span>
                        )}
                        {selectedBanquetCustomer.email && (
                          <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" /> {selectedBanquetCustomer.email}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsBanquetCustomerPickerOpen(true)}
                        className="px-2.5 py-1.5 text-xs font-medium text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] rounded-md"
                      >
                        Cambia
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedBanquetCustomer(null);
                          setNewBanquet(prev => ({ ...prev, customer_id: null }));
                        }}
                        className="p-1.5 text-[var(--ds-text-muted)] hover:text-[var(--ds-critical-text)] hover:bg-[var(--ds-critical-tint)] rounded-md"
                        title="Rimuovi cliente"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setIsBanquetCustomerPickerOpen(true)}
                    className="inline-flex items-center gap-2 px-3 py-2 rounded-md border border-[var(--ds-border)] bg-[var(--ds-canvas)] text-[var(--ds-text-primary)] text-sm font-medium hover:bg-[var(--ds-surface-row)]"
                  >
                    <BookUser className="h-4 w-4" />
                    Seleziona dalla rubrica
                  </button>
                )}
                </FormCard>
              </section>

              {/* SECTION: Evento */}
              <section className={banquetStep === 0 ? 'block' : 'hidden'}>
                <FormCard title="Evento">
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Identifica il banchetto: nome interno, data e turno.</p>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    <div className="md:col-span-2">
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Nome Menu <span className="text-[var(--ds-critical-text)]">*</span></label>
                      <input
                          required
                          placeholder="es. Menu Matrimonio Gold"
                          className={`w-full bg-[var(--ds-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                            banquetFieldHasError('Nome Menu')
                              ? 'border-[var(--ds-critical-solid)] focus:border-[var(--ds-critical-solid)]'
                              : 'border-[var(--ds-border)] focus:border-[var(--ds-text-primary)]'
                          }`}
                          value={newBanquet.name}
                          onChange={e => {
                            setNewBanquet({...newBanquet, name: e.target.value});
                            if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Nome Menu'));
                          }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Data Evento <span className="text-[var(--ds-critical-text)]">*</span></label>
                      <input
                          type="date"
                          required
                          className={`w-full bg-[var(--ds-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                            banquetFieldHasError('Data Evento')
                              ? 'border-[var(--ds-critical-solid)] focus:border-[var(--ds-critical-solid)]'
                              : 'border-[var(--ds-border)] focus:border-[var(--ds-text-primary)]'
                          }`}
                          value={newBanquet.event_date || ''}
                          onChange={e => {
                            setNewBanquet({...newBanquet, event_date: e.target.value});
                            if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Data Evento'));
                          }}
                      />
                    </div>
                    <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Turno</label>
                      {/* Cast covers the not-yet-chosen case: an empty value
                          matches no segment, so neither lights up until you pick
                          one — the form has never defaulted the shift. */}
                      <SegmentedControl<Shift>
                        value={(newBanquet.shift ?? '') as Shift}
                        onChange={next => setNewBanquet({ ...newBanquet, shift: next })}
                        ariaLabel="Turno"
                        options={[
                          { value: Shift.LUNCH, label: 'Pranzo', icon: <Sun className="h-4 w-4" /> },
                          { value: Shift.DINNER, label: 'Cena', icon: <Sunset className="h-4 w-4" /> },
                        ]}
                      />
                    </div>
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Descrizione Commerciale <span className="font-normal text-[var(--ds-text-muted)]">— opzionale</span></label>
                    <textarea
                      placeholder="Breve descrizione visibile in stampa (es. Cresima, Matrimonio civile…)"
                      className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] h-20"
                      value={newBanquet.description}
                      onChange={e => setNewBanquet({...newBanquet, description: e.target.value})}
                    />
                  </div>
                </div>
                </FormCard>
              </section>

              {/* SECTION: Coperti & Tariffa */}
              <section className={banquetStep === 1 ? 'block' : 'hidden'}>
                <FormCard title="Coperti e tariffa">
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Numero di partecipanti e prezzi. Se imposti un prezzo bambini, il calcolo distingue adulti e bambini.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Ospiti totali">
                      {/* Children stay clamped to the headcount, same rule the
                          number inputs enforced — lowering guests below the
                          children count would otherwise price a phantom adult. */}
                      <Stepper
                          value={newBanquet.guests ?? undefined}
                          onChange={next => {
                              const clampedChildren = next != null ? Math.min(newBanquet.children ?? 0, next) : (newBanquet.children ?? 0);
                              setNewBanquet({ ...newBanquet, guests: next, children: clampedChildren });
                          }}
                          min={0}
                          max={999}
                          ariaLabel="Ospiti totali"
                      />
                  </Field>
                  <Field label="Di cui bambini">
                      <Stepper
                          value={newBanquet.children ?? 0}
                          onChange={next => {
                              const clamped = Math.max(0, Math.min(next ?? 0, newBanquet.guests ?? 0));
                              setNewBanquet({ ...newBanquet, children: clamped });
                          }}
                          min={0}
                          max={newBanquet.guests ?? 0}
                          ariaLabel="Di cui bambini"
                      />
                  </Field>
                  {canViewBanquetPrice && (
                  <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Prezzo Adulti (€) <span className="text-[var(--ds-critical-text)]">*</span></label>
                      <input
                          type="number"
                          required
                          min="0"
                          step="0.01"
                          className={`w-full bg-[var(--ds-surface)] border rounded-md px-3 py-2 text-sm focus:outline-none ${
                            banquetFieldHasError('Prezzo Adulti')
                              ? 'border-[var(--ds-critical-solid)] focus:border-[var(--ds-critical-solid)]'
                              : 'border-[var(--ds-border)] focus:border-[var(--ds-text-primary)]'
                          }`}
                          value={newBanquet.price_per_person}
                          onChange={e => {
                            setNewBanquet({...newBanquet, price_per_person: parseFloat(e.target.value)});
                            if (banquetFormErrors.length > 0) setBanquetFormErrors(prev => prev.filter(f => f !== 'Prezzo Adulti'));
                          }}
                      />
                  </div>
                  )}
                  {canViewBanquetPrice && (
                  <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Prezzo Bambini (€) <span className="font-normal text-[var(--ds-text-muted)]">— opzionale</span></label>
                      <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Se vuoto: stesso adulti"
                          className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)]"
                          value={newBanquet.children_price ?? ''}
                          onChange={e => setNewBanquet({...newBanquet, children_price: e.target.value === '' ? null : parseFloat(e.target.value)})}
                      />
                  </div>
                  )}
                  {canViewBanquetPrice && (
                  <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Acconto (€) <span className="font-normal text-[var(--ds-text-muted)]">— opzionale</span></label>
                      <input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)]"
                          value={newBanquet.deposit_amount ?? ''}
                          onChange={e => setNewBanquet({...newBanquet, deposit_amount: e.target.value === '' ? undefined : parseFloat(e.target.value)})}
                      />
                  </div>
                  )}
                  {canViewBanquetPrice && (
                  <div>
                      <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Sconto <span className="font-normal text-[var(--ds-text-muted)]">— opzionale</span></label>
                      <div className="flex gap-2">
                          <div className="inline-flex rounded-md border border-[var(--ds-border)] overflow-hidden flex-shrink-0">
                              <button
                                  type="button"
                                  onClick={() => setNewBanquet({...newBanquet, discount_type: newBanquet.discount_type === 'PERCENT' ? null : 'PERCENT', discount_value: newBanquet.discount_type === 'PERCENT' ? null : (newBanquet.discount_value ?? null)})}
                                  className={`px-3 py-2 text-sm font-medium ${newBanquet.discount_type === 'PERCENT' ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'}`}
                                  aria-pressed={newBanquet.discount_type === 'PERCENT'}
                              >%</button>
                              <button
                                  type="button"
                                  onClick={() => setNewBanquet({...newBanquet, discount_type: newBanquet.discount_type === 'AMOUNT' ? null : 'AMOUNT', discount_value: newBanquet.discount_type === 'AMOUNT' ? null : (newBanquet.discount_value ?? null)})}
                                  className={`px-3 py-2 text-sm font-medium border-l border-[var(--ds-border)] ${newBanquet.discount_type === 'AMOUNT' ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'}`}
                                  aria-pressed={newBanquet.discount_type === 'AMOUNT'}
                              >€</button>
                          </div>
                          <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder={newBanquet.discount_type === 'PERCENT' ? 'es. 10' : '0.00'}
                              disabled={!newBanquet.discount_type}
                              className="flex-1 min-w-0 bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] disabled:opacity-50 disabled:cursor-not-allowed"
                              value={newBanquet.discount_value ?? ''}
                              onChange={e => setNewBanquet({...newBanquet, discount_value: e.target.value === '' ? null : parseFloat(e.target.value)})}
                          />
                      </div>
                  </div>
                  )}
                </div>

                {/* What the numbers above add up to, shown where they are
                    entered rather than only on the card afterwards. */}
                {canViewBanquetPrice && (() => {
                  const gross = computeBanquetGrossTotal(newBanquet as BanquetMenu);
                  const discount = computeBanquetDiscountAmount(newBanquet as BanquetMenu, gross);
                  const total = Math.max(0, gross - discount);
                  const guests = Number(newBanquet.guests) || 0;
                  const adultPrice = Number(newBanquet.price_per_person) || 0;
                  return (
                    <div className="mt-5 flex flex-wrap items-center justify-between gap-2 rounded-[16px] bg-[var(--ds-seated-tint)] px-4 py-3">
                      <div>
                        <div className="text-[13px] font-semibold text-[var(--ds-seated-text)]">Totale banchetto</div>
                        <div className="text-[13px] text-[var(--ds-seated-text)] opacity-80 tabular-nums">
                          {guests} × € {adultPrice.toFixed(2)}
                          {discount > 0 && ` − € ${discount.toFixed(2)} di sconto`}
                        </div>
                      </div>
                      <div className="text-[28px] font-bold tabular-nums leading-none text-[var(--ds-seated-text)]">
                        € {total.toFixed(2)}
                      </div>
                    </div>
                  );
                })()}
                </FormCard>
              </section>

              {/* SECTION: Note operative */}
              <section className={banquetStep === 4 ? 'block' : 'hidden'}>
                <FormCard title="Note operative">
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Istruzioni separate per cucina, sala e mise en place. Compariranno nelle stampe operative.</p>
                <div className="space-y-4">
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Note Portate <span className="font-normal normal-case tracking-normal">— cucina</span></label>
                    <textarea
                      placeholder="es. Senza glutine al tavolo 3, allergia ai crostacei per il tavolo sposi…"
                      className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] h-28"
                      value={newBanquet.notes_courses || ''}
                      onChange={e => setNewBanquet({...newBanquet, notes_courses: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Note Servizio <span className="font-normal normal-case tracking-normal">— sala</span></label>
                    <textarea
                      placeholder="es. Tempi: aperitivo 19:30, taglio torta 22:30. Vino bianco freddo per gli antipasti…"
                      className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] h-28"
                      value={newBanquet.notes_service || ''}
                      onChange={e => setNewBanquet({...newBanquet, notes_service: e.target.value})}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[13px] font-medium text-[var(--ds-text-secondary)]">Note Mise en Place</label>
                    <textarea
                      placeholder="es. Tovagliato avorio, segnaposti personalizzati, fiori bianchi al centro…"
                      className="w-full bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] h-28"
                      value={newBanquet.notes_mise_en_place || ''}
                      onChange={e => setNewBanquet({...newBanquet, notes_mise_en_place: e.target.value})}
                    />
                  </div>
                </div>
                </FormCard>
              </section>

              <section className={banquetStep === 2 ? 'block' : 'hidden'}>
                <FormCard
                  title="Composizione del menù"
                  aside={
                    <button
                      type="button"
                      onClick={addCourse}
                      className={`${dsButton.quiet} h-9 flex-shrink-0 px-4 text-[13px]`}
                    >
                      <Plus className="h-3.5 w-3.5" /> Aggiungi uscita
                    </button>
                  }
                >
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Crea le uscite del menu (es. Antipasti, Primi, Secondi) e assegna i piatti a ciascuna.</p>

                  {/* Da dove pescano le uscite: il menu Banchetti, o uno
                      stagionale. Le chip compaiono solo se c'è una scelta. */}
                  {pickerMenus.length > 1 && (
                    <div className="mb-4 flex flex-wrap gap-2">
                      {pickerMenus.map(m => {
                        const isActive = (pickerMenuId ?? banquetsMenu?.id) === m.id;
                        return (
                          <button
                            key={m.id}
                            type="button"
                            onClick={() => setPickerMenuId(m.id)}
                            className={`${DISH_FILTER_BASE} ${isActive ? DISH_FILTER_ON : DISH_FILTER_OFF}`}
                          >
                            {m.name}
                          </button>
                        );
                      })}
                    </div>
                  )}

                <div className="space-y-3">
                  {(newBanquet.courses || []).map((course, courseIndex) => {
                    const totalCourses = (newBanquet.courses || []).length;
                    return (
                      <div key={courseIndex} className="bg-[var(--ds-canvas)] rounded-lg border border-[var(--ds-border)] overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-[var(--ds-surface)] border-b border-[var(--ds-border)]">
                          <div className="flex flex-col">
                            <button
                              type="button"
                              onClick={() => moveCourse(courseIndex, -1)}
                              disabled={courseIndex === 0}
                              className="text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Sposta su"
                            >
                              <ChevronLeft className="h-3.5 w-3.5 rotate-90" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveCourse(courseIndex, 1)}
                              disabled={courseIndex === totalCourses - 1}
                              className="text-[var(--ds-text-muted)] hover:text-[var(--ds-text-primary)] disabled:opacity-30 disabled:cursor-not-allowed"
                              title="Sposta giù"
                            >
                              <ChevronRight className="h-3.5 w-3.5 rotate-90" />
                            </button>
                          </div>
                          <input
                            type="text"
                            value={course.name}
                            onChange={e => renameCourse(courseIndex, e.target.value)}
                            placeholder={`Nome uscita (es. ${courseIndex + 1}ª Uscita)`}
                            className="flex-1 bg-transparent border-0 focus:ring-0 outline-none text-sm font-semibold text-[var(--ds-text-primary)] px-1 py-0.5"
                          />
                          <span className="text-xs text-[var(--ds-text-muted)] whitespace-nowrap">
                            {course.dish_ids.length} {course.dish_ids.length === 1 ? 'piatto' : 'piatti'}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeCourse(courseIndex)}
                            className="p-1.5 rounded-md text-[var(--ds-text-muted)] hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]"
                            title="Elimina uscita"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </div>

                        <div className="p-3 max-h-60 overflow-y-auto space-y-3">
                          {BANQUET_DISH_CATEGORIES.map(category => {
                            const categoryDishes = pickerDishes.filter(d => d.category === category);
                            if (categoryDishes.length === 0) return null;
                            return (
                              <div key={category}>
                                <div className="text-[11px] font-semibold tracking-[0.02em] text-[var(--ds-text-subtle)] mb-1.5">
                                  {category}
                                </div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  {categoryDishes.map(dish => {
                                    const checked = course.dish_ids.includes(dish.id);
                                    return (
                                      <div
                                        key={dish.id}
                                        onClick={() => toggleDishInCourse(courseIndex, dish.id)}
                                        className={`p-2 rounded-md border cursor-pointer transition flex items-start gap-2 ${
                                          checked
                                            ? 'bg-[var(--ds-surface-row)] border-[var(--ds-text-primary)]'
                                            : 'bg-[var(--ds-surface)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'
                                        }`}
                                      >
                                        <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                          checked ? 'bg-[var(--ds-action-bg)] border-[var(--ds-text-primary)]' : 'border-[var(--ds-border-strong)]'
                                        }`}>
                                          {checked && <div className="w-1.5 h-1.5 bg-[var(--ds-action-fg)] rounded-full" />}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-sm font-medium text-[var(--ds-text-primary)] truncate">{dish.name}</div>
                                          <div className="text-xs text-[var(--ds-text-muted)]">€{dish.price}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })}
                          {(() => {
                            const orphan = pickerDishes.filter(d => !BANQUET_DISH_CATEGORIES.includes(d.category as any));
                            if (orphan.length === 0) return null;
                            return (
                              <div>
                                <div className="text-[11px] font-semibold tracking-[0.02em] text-[var(--ds-text-subtle)] mb-1.5">Altro</div>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                                  {orphan.map(dish => {
                                    const checked = course.dish_ids.includes(dish.id);
                                    return (
                                      <div
                                        key={dish.id}
                                        onClick={() => toggleDishInCourse(courseIndex, dish.id)}
                                        className={`p-2 rounded-md border cursor-pointer transition flex items-start gap-2 ${
                                          checked ? 'bg-[var(--ds-surface-row)] border-[var(--ds-text-primary)]' : 'bg-[var(--ds-surface)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'
                                        }`}
                                      >
                                        <div className={`w-4 h-4 mt-0.5 rounded border flex items-center justify-center flex-shrink-0 ${
                                          checked ? 'bg-[var(--ds-action-bg)] border-[var(--ds-text-primary)]' : 'border-[var(--ds-border-strong)]'
                                        }`}>
                                          {checked && <div className="w-1.5 h-1.5 bg-[var(--ds-action-fg)] rounded-full" />}
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-sm font-medium text-[var(--ds-text-primary)] truncate">{dish.name}</div>
                                          <div className="text-xs text-[var(--ds-text-muted)]">{dish.category} · €{dish.price}</div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            );
                          })()}
                          {pickerDishes.length === 0 && (
                            <div className="text-xs text-[var(--ds-text-subtle)] text-center py-4">
                              Nessun piatto in questo menu: spuntalo dalla scheda del piatto, in Menu.
                            </div>
                          )}
                        </div>

                        <div className="px-3 pb-3 pt-2 border-t border-[var(--ds-border)] bg-[var(--ds-surface)]">
                          <label className="block text-[11px] tracking-[0.02em] font-semibold text-[var(--ds-text-subtle)] mb-1.5">
                            Note uscita (opzionale)
                          </label>
                          <textarea
                            value={course.notes || ''}
                            onChange={e => setCourseNotes(courseIndex, e.target.value)}
                            placeholder="Es. servire con pane caldo, abbinare a vino bianco fresco…"
                            rows={2}
                            className="w-full bg-[var(--ds-canvas)] border border-[var(--ds-border)] rounded-md p-2 text-sm focus:outline-none focus:border-[var(--ds-text-primary)] resize-y"
                          />
                        </div>
                      </div>
                    );
                  })}
                  {(newBanquet.courses || []).length === 0 && (
                    <div className="text-center py-6 bg-[var(--ds-canvas)] rounded-lg border border-dashed border-[var(--ds-border)]">
                      <p className="text-sm text-[var(--ds-text-muted)] mb-2">Nessuna uscita</p>
                      <button
                        type="button"
                        onClick={addCourse}
                        className="text-sm font-medium text-[var(--ds-text-primary)] hover:underline"
                      >
                        + Aggiungi la prima uscita
                      </button>
                    </div>
                  )}
                </div>
                </FormCard>
              </section>

              <section className={banquetStep === 3 ? 'block' : 'hidden'}>
                <FormCard title="Tavoli assegnati" aside={<span className="text-[13px] text-[var(--ds-text-muted)]">opzionale</span>}>
                  <p className="mb-4 text-[13px] text-[var(--ds-text-muted)]">Riserva i tavoli del banchetto. I tavoli occupati nello stesso turno sono disabilitati.</p>
                {!newBanquet.event_date || !newBanquet.shift ? (
                  <p className="text-xs text-[var(--ds-text-muted)] italic">Seleziona Data Evento e Turno per assegnare i tavoli.</p>
                ) : tables.length === 0 ? (
                  <p className="text-xs text-[var(--ds-text-muted)] italic">Nessun tavolo configurato.</p>
                ) : (
                  <div className="space-y-3">

                    {/* Room tabs */}
                    {(() => {
                      const openRooms = rooms.filter(r => !r.is_closed);
                      if (openRooms.length === 0) return null;
                      return (
                        <div>
                          <p className="text-[11px] tracking-[0.02em] font-semibold text-[var(--ds-text-subtle)] mb-2">Sale</p>
                          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                            <button
                              type="button"
                              onClick={() => setTablePickerRoomFilter('ALL')}
                              className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${tablePickerRoomFilter === 'ALL' ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'}`}
                            >
                              Tutte le sale
                            </button>
                            {openRooms.map(room => (
                              <button
                                key={room.id}
                                type="button"
                                onClick={() => setTablePickerRoomFilter(room.id)}
                                className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${tablePickerRoomFilter === room.id ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] border-[var(--ds-text-primary)]' : 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)] border-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'}`}
                              >
                                {room.name}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {/* Tables grouped by room — same UX as Reservations table picker */}
                    <div className="bg-[var(--ds-canvas)] rounded-lg border border-[var(--ds-border)] p-2 sm:p-4 max-h-[400px] overflow-y-auto">
                      {(() => {
                        const openRooms = rooms.filter(r => !r.is_closed);
                        const displayedRooms = tablePickerRoomFilter === 'ALL'
                          ? openRooms
                          : openRooms.filter(r => r.id === tablePickerRoomFilter);
                        if (displayedRooms.length === 0) {
                          return <div className="text-center py-10 text-[var(--ds-text-subtle)] text-sm">Nessuna sala disponibile.</div>;
                        }
                        return displayedRooms.map(room => {
                          const roomTables = [...tables]
                            .filter(t => t.room_id === room.id)
                            .sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
                          if (roomTables.length === 0) return null;
                          return (
                            <div key={room.id} className="mb-4 sm:mb-6 last:mb-0">
                              <h4 className="text-[11px] tracking-[0.02em] font-semibold text-[var(--ds-text-subtle)] mb-2 sticky top-0 bg-[var(--ds-canvas)] py-1 z-10">{room.name}</h4>
                              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 sm:gap-3">
                                {roomTables.map(t => {
                                  const isSelected = (newBanquet.table_ids || []).includes(t.id);
                                  const occ = tableOccupancyMap.get(t.id);
                                  const isOccupied = !!occ && !isSelected;
                                  return (
                                    <button
                                      key={t.id}
                                      type="button"
                                      disabled={isOccupied}
                                      onClick={() => {
                                        setNewBanquet(prev => {
                                          const current = Array.isArray(prev.table_ids) ? prev.table_ids : [];
                                          const next = current.includes(t.id)
                                            ? current.filter(id => id !== t.id)
                                            : [...current, t.id];
                                          return { ...prev, table_ids: next };
                                        });
                                      }}
                                      className={`relative p-2 sm:p-3 rounded-md border text-center transition-colors ${
                                        isSelected
                                          ? 'border-[var(--ds-text-primary)] bg-[var(--ds-surface-row)] ring-1 ring-[var(--ds-text-primary)] z-10'
                                          : isOccupied
                                            ? 'border-[var(--ds-critical-tint)] bg-[var(--ds-critical-tint)] opacity-90 cursor-not-allowed'
                                            : 'border-[var(--ds-border)] bg-[var(--ds-surface)] hover:border-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)]'
                                      }`}
                                    >
                                      <div className={`text-xs sm:text-sm font-semibold truncate ${isOccupied ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-primary)]'}`}>
                                        {t.name}
                                      </div>
                                      <div className={`text-[9px] sm:text-[10px] flex justify-center items-center gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 ${isOccupied ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}`}>
                                        <Users size={8} className="sm:hidden" />
                                        <Users size={10} className="hidden sm:block" />
                                        {t.seats}
                                      </div>
                                      {isOccupied && occ && (
                                        <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-[var(--ds-critical-solid)] text-[#ffffff] text-[10px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-xs)] max-w-[140px] truncate z-10" title={occ.label}>
                                          {occ.label}
                                        </div>
                                      )}
                                      {isSelected && (
                                        <div className="absolute -top-2 -right-2 bg-[var(--ds-action-bg)] rounded-full p-0.5 shadow-[var(--shadow-xs)] z-20">
                                          <div className="w-1.5 h-1.5 bg-[var(--ds-action-fg)] rounded-full m-1" />
                                        </div>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          );
                        });
                      })()}
                    </div>

                    {/* Legend */}
                    <div className="flex flex-wrap gap-4 text-[10px] text-[var(--ds-text-muted)] px-1">
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--ds-surface)] border border-[var(--ds-border)] rounded"></div> Libero</div>
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--ds-surface-row)] border border-[var(--ds-text-primary)] rounded"></div> Selezionato</div>
                      <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--ds-critical-tint)] border  rounded"></div> Occupato</div>
                    </div>

                    {(newBanquet.table_ids || []).length > 0 && (
                      <p className="text-xs text-[var(--ds-text-muted)] px-1">
                        Selezionati: <span className="font-semibold text-[var(--ds-text-primary)]">{(newBanquet.table_ids || []).length}</span> tavolo/i ·{' '}
                        <span className="font-semibold text-[var(--ds-text-primary)]">
                          {(newBanquet.table_ids || []).reduce((sum, tid) => {
                            const t = tables.find(tt => tt.id === tid);
                            return sum + (t ? t.seats : 0);
                          }, 0)}
                        </span>{' '}
                        posti totali
                      </p>
                    )}
                  </div>
                )}
                </FormCard>
              </section>

          </form>

          {banquetFormErrors.length > 0 && (
            <Callout tone="critical" icon={Info} title="Compila i campi obbligatori:" className="mt-4">
              <ul className="list-inside list-disc space-y-0.5">
                {banquetFormErrors.map(field => (
                  <li key={field}>{field}</li>
                ))}
              </ul>
            </Callout>
          )}
        </ModalShell>
      )}

      {/* Menu digitale: QR da mettere al tavolo, interruttore di visibilità
          e traduzioni AI. La pagina pubblica è servita dal backend, come la
          pagina prenotazioni. */}
      <ModalShell
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        title="Menu digitale"
        subtitle="L'ospite inquadra il QR e sfoglia il menu in quattro lingue."
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--ds-surface-row)] px-4 py-3">
            <span className="text-[14px] font-medium text-[var(--ds-text-primary)]">
              {menuAttivo == null ? 'Stato…' : menuAttivo ? 'Menu visibile agli ospiti' : 'Menu non visibile'}
            </span>
            <button
              type="button"
              onClick={toggleMenuDigitale}
              disabled={menuFlagBusy || menuAttivo == null}
              className={`inline-flex h-9 items-center rounded-full px-4 text-[13px] font-semibold transition-colors disabled:opacity-40 ${
                menuAttivo
                  ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                  : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
              }`}
            >
              {menuFlagBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : menuAttivo ? 'Spegni' : 'Pubblica'}
            </button>
          </div>

          <div className="flex flex-col items-center gap-3">
            {/* Piatto bianco fisso: un QR su fondo scuro non si inquadra. */}
            <div className="rounded-[16px] bg-[#ffffff] p-3 shadow-[var(--ds-shadow-card)]">
              <QRCodeSVG value={menuUrl} size={168} level="M" />
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={copiaLinkMenu}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
              >
                {linkCopiato ? <><Check className="h-4 w-4" /> Copiato</> : <><Copy className="h-4 w-4" /> Copia link</>}
              </button>
              <a
                href={menuUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]"
              >
                Apri la pagina
              </a>
            </div>
          </div>

          {canEdit && (
            <div className="space-y-2 border-t border-[var(--ds-border)] pt-4">
              <button
                type="button"
                onClick={handleTranslate}
                disabled={translating}
                className="inline-flex h-9 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[13px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)] disabled:opacity-40"
              >
                {translating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
                Traduci le voci nuove
              </button>
              <p className="text-[13px] text-[var(--ds-text-muted)]">
                Inglese, francese e tedesco. Traduce solo le voci senza traduzione: si può rilanciare dopo ogni import.
              </p>
              {translateEsito && (
                <p className="text-[13px] text-[var(--ds-seated-text)]">
                  {translateEsito.tradotte === 0 ? 'Tutto già tradotto.' : `${translateEsito.tradotte} voci tradotte.`}
                </p>
              )}
              {translateError && <p className="text-[13px] text-[var(--ds-critical-text)]">{translateError}</p>}
            </div>
          )}
        </div>
      </ModalShell>

      <ConfirmDeleteModal
        isOpen={!!deleteDishConfirm}
        title="Elimina Piatto"
        message="Stai per eliminare il piatto:"
        itemName={deleteDishConfirm?.name}
        onCancel={() => setDeleteDishConfirm(null)}
        onConfirm={() => {
          if (deleteDishConfirm) onDeleteDish(deleteDishConfirm.id);
          setDeleteDishConfirm(null);
        }}
      />

      <ConfirmDeleteModal
        isOpen={!!deleteBanquetConfirm}
        title="Elimina Menu Banchetto"
        message="Stai per eliminare il menu banchetto:"
        itemName={deleteBanquetConfirm?.name}
        onCancel={() => setDeleteBanquetConfirm(null)}
        onConfirm={() => {
          if (deleteBanquetConfirm) onDeleteBanquetMenu(deleteBanquetConfirm.id);
          setDeleteBanquetConfirm(null);
        }}
      />

      {/* Nuovo menu / rinomina menu stagionale. */}
      {menuForm && (
        <ModalShell
          open={!!menuForm}
          onClose={() => setMenuForm(null)}
          title={menuForm.kind === 'create' ? 'Nuovo menu' : 'Rinomina menu'}
          size="sm"
          bodyClassName="p-5"
          footer={
            <>
              <button type="button" onClick={() => setMenuForm(null)} className={dsButton.secondary}>
                Annulla
              </button>
              <button
                type="submit"
                form="menu-form"
                disabled={menuFormBusy || !menuFormName.trim()}
                className={dsButton.primary}
              >
                {menuFormBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {menuForm.kind === 'create' ? 'Crea menu' : 'Salva'}
              </button>
            </>
          }
        >
          <form id="menu-form" onSubmit={submitMenuForm}>
            <Field label="Nome" required>
              <input
                autoFocus
                required
                maxLength={80}
                placeholder="es. Ferragosto, Pasqua…"
                className={dsInput}
                value={menuFormName}
                onChange={e => setMenuFormName(e.target.value)}
              />
            </Field>
            {menuFormError && <p className="mt-2 text-[13px] text-[var(--ds-critical-text)]">{menuFormError}</p>}
          </form>
        </ModalShell>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteMenuConfirm}
        title="Elimina Menu"
        message="I piatti restano in anagrafica e negli altri menu. Stai per eliminare:"
        itemName={deleteMenuConfirm?.name}
        onCancel={() => setDeleteMenuConfirm(null)}
        onConfirm={() => { if (deleteMenuConfirm) handleDeleteMenu(deleteMenuConfirm); }}
      />

      {/* Condividi preventivo: link pubblico, WhatsApp, email. */}
      {shareBanquet && (
        <ModalShell
          open={!!shareBanquet}
          onClose={() => setShareBanquet(null)}
          title="Condividi preventivo"
          subtitle={shareBanquet.name}
          size="sm"
          bodyClassName="p-5"
        >
          <div className="space-y-4">
            {shareError && <Callout tone="critical">{shareError}</Callout>}

            <div>
              <p className="mb-1.5 text-[13px] font-medium text-[var(--ds-text-secondary)]">Link del preventivo</p>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={shareUrl ?? 'Genero il link…'}
                  onFocus={e => e.currentTarget.select()}
                  className={`${dsInput} min-w-0 flex-1 text-[13px]`}
                />
                <button
                  type="button"
                  disabled={!shareUrl}
                  onClick={handleCopyShareLink}
                  className={`${dsIconButton} h-11 w-11 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none disabled:opacity-40`}
                  title="Copia link"
                >
                  {shareCopied ? <Check className="h-4 w-4 text-[var(--ds-seated-text)]" /> : <Copy className="h-4 w-4" />}
                </button>
              </div>
              <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                La pagina mostra sempre la versione aggiornata: le modifiche al preventivo non richiedono un nuovo invio.
              </p>
            </div>

            <div className="border-t border-[var(--ds-border)] pt-4">
              <p className="mb-1.5 text-[13px] font-medium text-[var(--ds-text-secondary)]">Invia su WhatsApp</p>
              {shareWhatsAppReady ? (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="tel"
                      placeholder="telefono del cliente"
                      className={`${dsInput} min-w-0 flex-1`}
                      value={sharePhone}
                      onChange={e => { setSharePhone(e.target.value); setSharePhoneDone(null); setSharePhoneError(null); }}
                    />
                    <button
                      type="button"
                      disabled={sharePhoneBusy || !sharePhone.trim()}
                      onClick={handleSendQuoteWhatsApp}
                      className={`${dsButton.primary} flex-shrink-0 disabled:opacity-40`}
                    >
                      {sharePhoneBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MessageCircle className="h-4 w-4" />}
                      Invia
                    </button>
                  </div>
                  <p className="mt-1.5 text-[12px] text-[var(--ds-text-muted)]">
                    Parte dal numero WhatsApp del ristorante.
                  </p>
                  {sharePhoneDone && (
                    <p className="mt-1.5 text-[13px] text-[var(--ds-seated-text)]">Preventivo inviato a {sharePhoneDone}.</p>
                  )}
                  {sharePhoneError && (
                    <p className="mt-1.5 text-[13px] text-[var(--ds-critical-text)]">{sharePhoneError}</p>
                  )}
                </>
              ) : (
                <p className="rounded-[12px] bg-[var(--ds-surface-row)] px-3 py-2.5 text-[13px] text-[var(--ds-text-muted)]">
                  L'invio dal numero WhatsApp del ristorante è in attivazione (serve l'approvazione del modello da parte di Meta). Intanto copia il link o usa l'email.
                </p>
              )}
            </div>

            <div className="border-t border-[var(--ds-border)] pt-4">
              <p className="mb-1.5 text-[13px] font-medium text-[var(--ds-text-secondary)]">Invia via email</p>
              <div className="flex items-center gap-2">
                <input
                  type="email"
                  placeholder="email del cliente"
                  className={`${dsInput} min-w-0 flex-1`}
                  value={shareEmail}
                  onChange={e => { setShareEmail(e.target.value); setShareEmailDone(null); setShareEmailError(null); }}
                />
                <button
                  type="button"
                  disabled={shareEmailBusy || !shareEmail.trim()}
                  onClick={handleSendQuoteEmail}
                  className={`${dsButton.primary} flex-shrink-0 disabled:opacity-40`}
                >
                  {shareEmailBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
                  Invia
                </button>
              </div>
              {shareEmailDone && (
                <p className="mt-1.5 text-[13px] text-[var(--ds-seated-text)]">Preventivo inviato a {shareEmailDone}.</p>
              )}
              {shareEmailError && (
                <p className="mt-1.5 text-[13px] text-[var(--ds-critical-text)]">{shareEmailError}</p>
              )}
            </div>
          </div>
        </ModalShell>
      )}

      {viewBanquet && (
        <BanquetCompositionModal
          banquet={viewBanquet}
          dishes={dishes}
          onClose={() => setViewBanquet(null)}
        />
      )}

      {paymentsBanquet && (
        <BanquetPaymentsModal
          banquet={paymentsBanquet}
          onClose={() => setPaymentsBanquet(null)}
        />
      )}

      {/* Categorie: accensione e ordine. Ogni azione salva subito — l'ordine
          della lista È l'ordine del menu, su comande e menu digitale. */}
      {catsOpen && menuCats && (
        <ModalShell
          open={catsOpen}
          onClose={() => setCatsOpen(false)}
          title="Categorie"
          subtitle="L'ordine e le categorie spente valgono anche su comande e menu digitale"
          size="sm"
          bodyClassName="p-2"
        >
          <div className="divide-y divide-[var(--ds-border)]">
            {menuCats.map((cat, i) => (
              <div key={cat.name} className={`flex items-center gap-2 px-3 py-2.5 ${cat.enabled ? '' : 'opacity-60'}`}>
                <div className="flex flex-shrink-0 items-center">
                  <button
                    type="button"
                    disabled={catsBusy || i === 0}
                    onClick={() => {
                      const next = [...menuCats];
                      [next[i - 1], next[i]] = [next[i], next[i - 1]];
                      applyMenuCats(next);
                    }}
                    className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
                    title="Sposta su"
                  >
                    <ChevronUp className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    disabled={catsBusy || i === menuCats.length - 1}
                    onClick={() => {
                      const next = [...menuCats];
                      [next[i], next[i + 1]] = [next[i + 1], next[i]];
                      applyMenuCats(next);
                    }}
                    className={`${dsIconButton} h-9 w-8 bg-transparent shadow-none disabled:opacity-30`}
                    title="Sposta giù"
                  >
                    <ChevronDown className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[14px] font-medium text-[var(--ds-text-primary)]">{cat.name}</div>
                  <div className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">{cat.dishes} {cat.dishes === 1 ? 'piatto' : 'piatti'}</div>
                  {/* In quali menu sta la categoria. Lo stato lo dicono i
                      piatti veri, non il default salvato: piena = tutti i
                      piatti nel menu, parziale = «3/12». Il click applica in
                      blocco; i singoli piatti restano regolabili dopo. */}
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {menus.map(m => {
                      const inCat = dishes.filter(d => (d.category ?? '') === cat.name);
                      const inMenu = inCat.filter(d => (d.menu_ids ?? []).includes(m.id)).length;
                      const full = inCat.length > 0 && inMenu === inCat.length;
                      const partial = inMenu > 0 && !full;
                      const busyKey = `${cat.name}|${m.id}`;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          disabled={catMenuBusy === busyKey || inCat.length === 0}
                          onClick={() => handleToggleCategoryMenu(cat.name, m.id, !full)}
                          aria-pressed={full}
                          title={full
                            ? `Tutti i piatti di ${cat.name} sono in ${m.name} — togli tutti`
                            : `Metti tutti i piatti di ${cat.name} in ${m.name}`}
                          className={`inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                            full
                              ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                              : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:text-[var(--ds-text-primary)]'
                          } ${catMenuBusy === busyKey ? 'opacity-50' : ''}`}
                        >
                          {full && <Check size={12} />}
                          {m.name}
                          {partial && <span className="tabular-nums opacity-70">{inMenu}/{inCat.length}</span>}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <button
                  type="button" role="switch" aria-checked={cat.enabled}
                  aria-label={`${cat.enabled ? 'Spegni' : 'Accendi'} ${cat.name}`}
                  disabled={catsBusy}
                  onClick={() => {
                    const next = menuCats.map((c, j) => j === i ? { ...c, enabled: !c.enabled } : c);
                    applyMenuCats(next);
                  }}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] disabled:opacity-50 ${
                    cat.enabled ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-surface-row)] border border-[var(--ds-border)]'
                  }`}
                >
                  <span aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition-transform ${cat.enabled ? 'translate-x-5' : 'translate-x-0.5'} translate-y-0.5`} />
                </button>
                <button
                  type="button"
                  onClick={() => { setCatFormName(cat.name); setCatFormError(null); setCatForm({ kind: 'rename', name: cat.name }); }}
                  className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none`}
                  title="Rinomina categoria"
                >
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  disabled={cat.dishes > 0}
                  onClick={() => setDeleteCatConfirm(cat.name)}
                  className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface-row)] shadow-none disabled:opacity-30 hover:bg-[var(--ds-critical-tint)] hover:text-[var(--ds-critical-text)]`}
                  title={cat.dishes > 0 ? 'Ha ancora piatti: spostali prima di eliminarla' : 'Elimina categoria'}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <div className="px-3 py-3">
            <button
              type="button"
              onClick={() => { setCatFormName(''); setCatFormError(null); setCatForm({ kind: 'create' }); }}
              className={`${dsButton.quiet} h-9 px-4 text-[13px]`}
            >
              <Plus className="h-3.5 w-3.5" /> Nuova categoria
            </button>
          </div>
        </ModalShell>
      )}

      <MenuVariantsModal
        open={variantsOpen}
        onClose={() => setVariantsOpen(false)}
        groups={modifierGroups}
        onChanged={refreshModifierGroups}
      />

      {/* Nuova categoria / rinomina. La rinomina sposta tutti i piatti sul
          nuovo nome; per i piatti della cassa vale solo fino al prossimo
          import, e la modale lo dice invece di lasciarlo scoprire. */}
      {catForm && (
        <ModalShell
          open={!!catForm}
          onClose={() => setCatForm(null)}
          title={catForm.kind === 'create' ? 'Nuova categoria' : 'Rinomina categoria'}
          size="sm"
          bodyClassName="p-5"
          footer={
            <>
              <button type="button" onClick={() => setCatForm(null)} className={dsButton.secondary}>
                Annulla
              </button>
              <button
                type="submit"
                form="cat-form"
                disabled={catFormBusy || !catFormName.trim() || (catForm.kind === 'rename' && catFormName.trim() === catForm.name)}
                className={dsButton.primary}
              >
                {catFormBusy && <Loader2 className="h-4 w-4 animate-spin" />}
                {catForm.kind === 'create' ? 'Crea categoria' : 'Salva'}
              </button>
            </>
          }
        >
          <form id="cat-form" onSubmit={submitCatForm} className="space-y-3">
            <Field label="Nome" required>
              <input
                autoFocus
                required
                maxLength={60}
                placeholder="es. Fritture, Pizze…"
                className={dsInput}
                value={catFormName}
                onChange={e => setCatFormName(e.target.value)}
              />
            </Field>
            {catForm.kind === 'rename' && dishes.some(d => d.category === catForm.name && d.external_ref?.startsWith('pp:')) && (
              <Callout tone="pending">
                Qui ci sono piatti sincronizzati dalla cassa: al prossimo «Importa da cassa» torneranno alla categoria della cassa. Per un nome definitivo rinominala anche in Passepartout.
              </Callout>
            )}
            {catFormError && <p className="text-[13px] text-[var(--ds-critical-text)]">{catFormError}</p>}
          </form>
        </ModalShell>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteCatConfirm}
        title="Elimina Categoria"
        message="La categoria è vuota: nessun piatto viene toccato. Stai per eliminare:"
        itemName={deleteCatConfirm ?? undefined}
        onCancel={() => setDeleteCatConfirm(null)}
        onConfirm={() => { if (deleteCatConfirm) handleDeleteCategory(deleteCatConfirm); }}
      />

      {/* Only when the inline panel cannot show — otherwise the same dish would
          open twice, in a panel and a modal on top of it. */}
      {viewDish && !detailPanelOpen && (
        <DishDetailModal
          dish={viewDish}
          onClose={() => setViewDish(null)}
        />
      )}

      <CustomerPickerModal
        isOpen={isBanquetCustomerPickerOpen}
        initialQuery={selectedBanquetCustomer?.name || newBanquet.name || ''}
        onClose={() => setIsBanquetCustomerPickerOpen(false)}
        onSelect={(c: Customer) => {
          setSelectedBanquetCustomer(c);
          setNewBanquet(prev => ({ ...prev, customer_id: c.id }));
        }}
      />

      {showBanquetSortModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" onClick={() => setShowBanquetSortModal(false)}>
          <div className="absolute inset-0 bg-black/30" />
 <div className="relative w-full sm:max-w-sm bg-[var(--ds-surface)] rounded-t-2xl sm:rounded-2xl shadow-[var(--ds-shadow-raised)] pb-6 duration-200"onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2 sm:hidden">
              <div className="w-8 h-1 rounded-full bg-[var(--ds-text-subtle)]" />
            </div>
            <div className="px-5 pb-2 pt-2 sm:pt-5">
              <h3 className="text-base font-semibold text-[var(--ds-text-primary)]">Ordina per</h3>
            </div>
            <div className="px-3">
              {BANQUET_SORT_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setBanquetSortBy(opt.value); setShowBanquetSortModal(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm rounded-lg transition-colors ${
                    banquetSortBy === opt.value ? 'bg-[var(--ds-surface-row)] font-medium text-[var(--ds-text-primary)]' : 'text-[var(--ds-text-muted)] hover:bg-[var(--ds-surface-row)]'
                  }`}
                >
                  {opt.label}
                  {banquetSortBy === opt.value && <Check className="h-4 w-4 text-[var(--ds-text-primary)]" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

interface BanquetCalendarProps {
  banquetMenus: BanquetMenu[];
  onSelectBanquet: (menu: BanquetMenu) => void;
  onViewBanquet: (menu: BanquetMenu) => void;
  canEdit: boolean;
}

const BanquetCalendar: React.FC<BanquetCalendarProps> = ({ banquetMenus, onSelectBanquet, onViewBanquet, canEdit }) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  const canManageBanquetPayments = hasPermission('banquet:manage_payments');
  const [cursor, setCursor] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const monthIndex = cursor.getMonth();
  const year = cursor.getFullYear();

  // Group banquets by date
  const banquetsByDate = useMemo(() => {
    const map = new Map<string, BanquetMenu[]>();
    for (const m of banquetMenus) {
      if (!m.event_date) continue;
      const arr = map.get(m.event_date) || [];
      arr.push(m);
      map.set(m.event_date, arr);
    }
    return map;
  }, [banquetMenus]);

  // Build the 6×7 grid for the month, week starting on Monday
  const cells = useMemo(() => {
    const firstOfMonth = new Date(year, monthIndex, 1);
    const dayOfWeek = (firstOfMonth.getDay() + 6) % 7; // Mon=0..Sun=6
    const start = new Date(year, monthIndex, 1 - dayOfWeek);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [year, monthIndex]);

  const todayKey = formatLocalDate(new Date());
  const selectedBanquets = selectedDate ? (banquetsByDate.get(selectedDate) || []) : [];

  // Totals for the month on screen, so the header answers "how busy is August"
  // without counting chips.
  const monthTotals = useMemo(() => {
    let count = 0;
    let covers = 0;
    for (const [date, list] of banquetsByDate) {
      const d = new Date(date + 'T00:00');
      if (d.getMonth() !== monthIndex || d.getFullYear() !== year) continue;
      count += list.length;
      covers += list.reduce((s, b) => s + (Number(b.guests) || 0), 0);
    }
    return { count, covers };
  }, [banquetsByDate, monthIndex, year]);

  return (
    <div className="flex flex-col lg:flex-row gap-4">
      <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] sm:p-5 lg:w-3/4">
      <div className="mb-4 flex items-center gap-3">
        <button
          onClick={() => setCursor(new Date(year, monthIndex - 1, 1))}
          className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`}
          aria-label="Mese precedente"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h3 className="flex-1 text-center text-[19px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
          {ITALIAN_MONTHS[monthIndex]} {year}
        </h3>
        {monthTotals.count > 0 && (
          <StatusPill tone="info" className="hidden h-8 px-3 sm:inline-flex">
            <span className="font-semibold tabular-nums">{monthTotals.count}</span>
            <span className="font-normal">{monthTotals.count === 1 ? 'banchetto' : 'banchetti'} · {monthTotals.covers} coperti</span>
          </StatusPill>
        )}
        <button
          onClick={() => setCursor(new Date(year, monthIndex + 1, 1))}
          className={`${dsIconButton} bg-[var(--ds-surface-row)] shadow-none`}
          aria-label="Mese successivo"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>

      <div className="mb-2 grid grid-cols-7 text-center text-[13px] font-semibold text-[var(--ds-text-muted)]">
        {ITALIAN_WEEKDAYS.map(d => <div key={d} className="py-1">{d}</div>)}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          const key = formatLocalDate(d);
          const inMonth = d.getMonth() === monthIndex;
          const events = banquetsByDate.get(key) || [];
          const covers = events.reduce((s, b) => s + (Number(b.guests) || 0), 0);
          const isToday = key === todayKey;
          const isSelected = key === selectedDate;
          return (
            <button
              key={i}
              onClick={() => setSelectedDate(events.length ? key : null)}
              className={`flex aspect-square flex-col overflow-hidden rounded-[12px] p-1.5 text-left transition-colors sm:aspect-auto sm:min-h-[96px] ${
                isSelected
                  ? 'bg-[var(--ds-surface-row)] ring-2 ring-inset ring-[var(--ds-text-primary)]'
                  : isToday
                  ? 'ring-2 ring-inset ring-[var(--ds-seated-solid)] hover:bg-[var(--ds-surface-row)]'
                  : 'ring-1 ring-inset ring-[var(--ds-border)] hover:bg-[var(--ds-surface-row)]'
              } ${inMonth ? '' : 'opacity-40'}`}
            >
              <div className="flex w-full items-center justify-between gap-1">
                <span className={`text-[13px] tabular-nums ${isToday ? 'font-bold text-[var(--ds-seated-text)]' : 'font-semibold text-[var(--ds-text-primary)]'}`}>
                  {d.getDate()}
                </span>
                {covers > 0 && (
                  <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-[var(--ds-text-muted)]">
                    <Users className="h-3 w-3" aria-hidden />{covers}
                  </span>
                )}
              </div>
              {events.length > 0 && (
                <div className="mt-1 flex w-full flex-col gap-0.5 overflow-hidden">
                  {events.slice(0, 2).map(ev => (
                    <span
                      key={ev.id}
                      className={`block truncate rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium ${
                        ev.shift === Shift.DINNER
                          ? 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
                          : 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                      }`}
                      title={ev.name}
                    >
                      {ev.name}
                    </span>
                  ))}
                  {events.length > 2 && (
                    <span className="px-1 text-[11px] font-medium text-[var(--ds-text-muted)]">
                      +{events.length - 2}
                    </span>
                  )}
                </div>
              )}
            </button>
          );
        })}
      </div>
      </div>

      <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)] lg:w-1/4">
        {selectedDate ? (
          <>
          <h4 className="text-[19px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            {new Date(selectedDate + 'T00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}
          </h4>
          <p className="mb-3 text-[13px] text-[var(--ds-text-muted)]">
            {selectedBanquets.length} {selectedBanquets.length === 1 ? 'banchetto' : 'banchetti'}
            {' · '}
            {selectedBanquets.reduce((s, b) => s + (Number(b.guests) || 0), 0)} coperti
          </p>
          <div className="space-y-2">
            {selectedBanquets.map(menu => {
              const hasNotes = !!(menu.notes_courses?.trim() || menu.notes_service?.trim() || menu.notes_mise_en_place?.trim());
              const outstanding = Math.max(0, computeBanquetTotalDue(menu) - Number(menu.total_paid || 0));
              const urgent = outstanding > 0 && isOutstandingUrgent(menu, endOfCurrentWeek(new Date()));
              const isLunch = menu.shift === Shift.LUNCH;
              return (
                <div
                  key={menu.id}
                  role="button"
                  tabIndex={0}
                  // Same rule as the list cards: a row opens the details. Edit
                  // moved to its own button so clicking a banquet never drops
                  // you straight into a form you did not ask for.
                  onClick={() => onViewBanquet(menu)}
                  onKeyDown={e => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onViewBanquet(menu); }
                  }}
                  className="cursor-pointer rounded-[16px] bg-[var(--ds-surface-row)] p-3 transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                >
                  <div className="flex items-start gap-2.5">
                    <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full ${
                      !menu.shift
                        ? 'bg-[var(--ds-surface)] text-[var(--ds-text-muted)]'
                        : isLunch
                          ? 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]'
                          : 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]'
                    }`}>
                      {isLunch ? <Sun className="h-4 w-4" /> : <Sunset className="h-4 w-4" />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[15px] font-semibold text-[var(--ds-text-primary)]">{menu.name}</p>
                      <p className="truncate text-[13px] text-[var(--ds-text-muted)]">
                        {[
                          menu.description,
                          menu.shift ? (isLunch ? 'Pranzo' : 'Cena') : null,
                          menu.guests != null && Number(menu.guests) > 0 ? `${menu.guests} coperti` : null,
                        ].filter(Boolean).join(' · ')}
                      </p>
                      {canViewBanquetPrice && (
                        <p className="mt-1 text-[13px]">
                          {outstanding > 0 ? (
                            <>
                              <span className={`font-semibold tabular-nums ${urgent ? 'text-[var(--ds-critical-text)]' : 'text-[var(--ds-pending-text)]'}`}>€ {formatEuro(outstanding)}</span>
                              <span className="text-[var(--ds-text-muted)]"> da incassare</span>
                            </>
                          ) : (
                            <span className="font-semibold text-[var(--ds-seated-text)]">Saldato</span>
                          )}
                        </p>
                      )}
                      {hasNotes && (
                        <span className="mt-1 inline-flex items-center gap-1 text-[13px] text-[var(--ds-pending-text)]">
                          <StickyNote className="h-3.5 w-3.5" />
                          Con note
                        </span>
                      )}
                    </div>
                    {canEdit && (
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); onSelectBanquet(menu); }}
                        className={`${dsIconButton} h-9 w-9 flex-shrink-0 bg-[var(--ds-surface)] shadow-none`}
                        title="Modifica banchetto"
                      >
                        <Edit2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          </>
        ) : (
          <div className="flex flex-col items-center justify-center py-10 text-center">
            <Calendar className="mb-2 h-8 w-8 text-[var(--ds-text-subtle)]" />
            <p className="text-[14px] text-[var(--ds-text-muted)]">Seleziona un giorno con eventi per vedere i dettagli.</p>
          </div>
        )}
      </div>
    </div>
  );
};