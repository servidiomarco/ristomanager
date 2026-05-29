import React, { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus, ReservationStatus, ReservationSource, TableMerge, TableHiddenOverride, COMMON_ALLERGENS, Customer } from '../types';
import { Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, Sunset, MapPin, Filter, Map as MapIcon, List, MessageCircle, Mail, Armchair, Search, BellRing, CheckSquare, Square, UserCheck, UserX, Combine, Scissors, Check, ChevronDown, ChevronLeft, ChevronRight, AlertTriangle, StickyNote, Mic, Loader2, Info, ArrowUpDown, RotateCcw, Printer, Eye, EyeOff, BookUser, BookOpen, MoreHorizontal, Ban } from 'lucide-react';
import { sendWhatsAppConfirmation, getTableMerges, getTableHidden, createTableHidden, deleteTableHidden, getCustomers } from '../services/apiService';
import { CustomerPickerModal } from './CustomerPickerModal';
import { isVoiceSupported, startListening, parseReservationText } from '../services/voiceInputService';
import { saveDraft, loadDraft, clearDraft, DRAFT_KEYS } from '../services/draftService';
import { applyMerges } from '../utils/tableMerge';
import { toTitleCase } from '../utils/text';
import { useSocket } from '../hooks/useSocket';
import { PrintReservationsModal } from './PrintReservationsModal';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { DateNavigator } from './DateNavigator';
import { useAuth } from '../contexts/AuthContext';

// Helpers for local-date formatting (avoid UTC shift from toISOString)
const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const formatLocalDateTime = (date: Date): string => {
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${formatLocalDate(date)}T${h}:${min}`;
};

// Helper to format datetime without timezone conversion
const formatDateTime = (isoString: string): string => {
  // Parse the ISO string directly without timezone conversion
  const match = isoString.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return `${day}/${month}/${year}, ${hour}:${minute}`;
  }
  // Fallback to original behavior
  return new Date(isoString).toLocaleString();
};

// Two-letter initials from a full name (falls back to '?' on empty)
const getInitials = (name?: string | null): string => {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase();
};

// Small circular badge showing who took the reservation:
// voice-agent bookings get a Mic icon, manual bookings get user initials.
const renderOperatorBadge = (res: Reservation): React.ReactNode => {
  if (res.source === ReservationSource.VOICE) {
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-100 border border-indigo-200 text-indigo-600 dark:bg-indigo-500/20 dark:border-indigo-500/30 dark:text-indigo-300 flex-shrink-0"
        title="Presa dall'agente vocale"
        aria-label="Presa dall'agente vocale"
      >
        <Mic className="h-2.5 w-2.5" />
      </span>
    );
  }
  if (res.created_by_user_name) {
    return (
      <span
        className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[var(--color-surface-3)] border border-[var(--color-line)] text-[var(--color-fg-muted)] text-[9px] font-semibold flex-shrink-0"
        title={`Presa da ${toTitleCase(res.created_by_user_name)}`}
        aria-label={`Presa da ${toTitleCase(res.created_by_user_name)}`}
      >
        {getInitials(res.created_by_user_name)}
      </span>
    );
  }
  return null;
};

// Helper to format only time
const formatTime = (isoString: string): string => {
  const match = isoString.match(/T(\d{2}):(\d{2})/);
  if (match) {
    return `${match[1]}:${match[2]}`;
  }
  return '';
};

// Helper to calculate lateness in minutes (returns negative if reservation is in the future)
const getMinutesLate = (reservationTime: string): number => {
  const now = new Date();
  const match = reservationTime.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return 0;
  const [, year, month, day, hour, minute] = match;
  const resDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return Math.floor((now.getTime() - resDate.getTime()) / 60000);
};

interface ReservationListProps {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  onUpdateReservation: (r: Reservation) => void;
  onAddReservation: (r: Omit<Reservation, 'id'>) => void;
  onDeleteReservation: (id: number) => void;
  onMergeTables: (tableIds: number[], date: string, shift: Shift) => Promise<void>;
  onSplitTable: (tableId: number, date: string, shift: Shift) => Promise<void>;
  onUpdateTable: (table: Table) => Promise<void>;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
  canEdit?: boolean;
  autoOpenNew?: boolean;
  onAutoOpenNewHandled?: () => void;
  modalOnly?: boolean;
  onModalClose?: () => void;
  // Pre-fill search term when navigating in from the global header search
  initialSearchTerm?: string;
  onInitialSearchTermHandled?: () => void;
  // Global date/shift from App header (desktop)
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  onDateChange?: (date: Date) => void;
  onShiftFilterChange?: (filter: 'ALL' | 'LUNCH' | 'DINNER') => void;
}

export const ReservationList: React.FC<ReservationListProps> = ({
  reservations,
  banquetMenus,
  tables,
  rooms,
  onUpdateReservation,
  onAddReservation,
  onDeleteReservation,
  onMergeTables,
  onSplitTable,
  onUpdateTable,
  showToast,
  canEdit = true,
  autoOpenNew = false,
  onAutoOpenNewHandled,
  modalOnly = false,
  onModalClose,
  initialSearchTerm,
  onInitialSearchTermHandled,
  globalDate,
  globalShiftFilter: globalShiftFilterProp,
  onDateChange,
  onShiftFilterChange,
}) => {
  const { hasPermission } = useAuth();
  const canViewBanquetPrice = hasPermission('banquet:view_price');
  // Main View State
  const [viewMode, setViewMode] = useState<'LIST' | 'MAP'>('LIST');
  const [selectedDate, setSelectedDateLocal] = useState<string>(() => {
    if (globalDate) return formatLocalDate(globalDate) + 'T' + (new Date().getHours() < 17 ? '13:00' : '20:00');
    return formatLocalDateTime(new Date());
  });
  const setSelectedDate = (val: string) => {
    setSelectedDateLocal(val);
    const [datePart] = val.split('T');
    if (datePart && onDateChange) {
      const [y, m, d] = datePart.split('-').map(Number);
      if (y && m && d) onDateChange(new Date(y, m - 1, d));
    }
  };
  const [selectedShift, setSelectedShiftLocal] = useState<Shift | 'ALL'>(() => {
    if (globalShiftFilterProp === 'LUNCH') return Shift.LUNCH;
    if (globalShiftFilterProp === 'DINNER') return Shift.DINNER;
    return 'ALL';
  });
  const setSelectedShift = (val: Shift | 'ALL') => {
    setSelectedShiftLocal(val);
    if (onShiftFilterChange) {
      if (val === Shift.LUNCH) onShiftFilterChange('LUNCH');
      else if (val === Shift.DINNER) onShiftFilterChange('DINNER');
    }
  };

  // Sync from global header changes
  useEffect(() => {
    if (globalDate) {
      const time = selectedDate.split('T')[1] || '12:00';
      const newDateStr = formatLocalDate(globalDate) + 'T' + time;
      if (newDateStr.split('T')[0] !== selectedDate.split('T')[0]) {
        setSelectedDateLocal(newDateStr);
      }
    }
  }, [globalDate]);
  useEffect(() => {
    if (globalShiftFilterProp === 'LUNCH') setSelectedShiftLocal(Shift.LUNCH);
    else if (globalShiftFilterProp === 'DINNER') setSelectedShiftLocal(Shift.DINNER);
  }, [globalShiftFilterProp]);
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterArrivalStatus, setFilterArrivalStatus] = useState<ArrivalStatus | 'ALL'>('ALL');
  const [filterGuestRange, setFilterGuestRange] = useState<'ALL' | '1-2' | '3-4' | '5-6' | '7+'>('ALL');
  const [filterHasAllergens, setFilterHasAllergens] = useState(false);
  const [filterHasNotes, setFilterHasNotes] = useState(false);
  const [filterNoTable, setFilterNoTable] = useState(false);
  const [sortBy, setSortBy] = useState<'time-asc' | 'time-desc' | 'name-asc' | 'name-desc' | 'guests-asc' | 'guests-desc'>('time-asc');
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [searchTerm, setSearchTerm] = useState(initialSearchTerm ?? '');
  // Apply prefill from global header search, then notify the parent to clear it
  // so it doesn't re-apply on remount.
  useEffect(() => {
    if (initialSearchTerm !== undefined) {
      setSearchTerm(initialSearchTerm);
      onInitialSearchTermHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSearchTerm]);
    const [activeMapRoomId, setActiveMapRoomId] = useState<string | number>('ALL');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  // Tick the header clock once per minute (aligned to start of each minute)
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

  // Auto-advance the selected date when midnight rolls over while the user
  // is still viewing the previous "today". Manual navigation away from today
  // is preserved.
  const prevTodayRef = useRef<string>(formatLocalDate(new Date()));
  useEffect(() => {
    const newToday = formatLocalDate(currentTime);
    if (newToday !== prevTodayRef.current) {
      const selectedOnly = selectedDate.split('T')[0];
      if (selectedOnly === prevTodayRef.current) {
        const time = selectedDate.split('T')[1] || '12:00';
        setSelectedDate(`${newToday}T${time}`);
      }
      prevTodayRef.current = newToday;
    }
  }, [currentTime, selectedDate]);

  useEffect(() => {
    const openRoomsList = rooms.filter(r => !r.is_closed);
    if (openRoomsList.length === 0) return;
    const currentIsClosed = activeMapRoomId !== 'ALL' && rooms.find(r => r.id === activeMapRoomId)?.is_closed;
    if (activeMapRoomId === 'ALL' || currentIsClosed) {
      setActiveMapRoomId(openRoomsList[0].id);
    }
  }, [rooms, activeMapRoomId]);

  // Auto-switch from 'ALL' to a specific shift (no 'Tutte' option in UI)
  useEffect(() => {
    if (selectedShift === 'ALL') {
      const hour = new Date().getHours();
      setSelectedShift(hour >= 11 && hour < 17 ? Shift.LUNCH : Shift.DINNER);
    }
  }, [selectedShift]);

  // Modal/Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSavingReservation, setIsSavingReservation] = useState(false);
  const [selectedAllergens, setSelectedAllergens] = useState<string[]>([]);
  const [selectedQuickNotes, setSelectedQuickNotes] = useState<string[]>([]);
  const [showAllergensSection, setShowAllergensSection] = useState(false);
  const [showNotesSection, setShowNotesSection] = useState(false);
  const [modalRoomFilter, setModalRoomFilter] = useState<string | number>('ALL');
  const [selectedTablesForMerge, setSelectedTablesForMerge] = useState<number[]>([]);
  const [mergeMode, setMergeMode] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{show: boolean, reservationId: number | null, customerName: string}>({show: false, reservationId: null, customerName: ''});
  const [unhideAllConfirm, setUnhideAllConfirm] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [showSortModal, setShowSortModal] = useState(false);
  const [cardMenuOpenId, setCardMenuOpenId] = useState<number | null>(null);
  const cardMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cardMenuOpenId === null) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (cardMenuRef.current && !cardMenuRef.current.contains(e.target as Node)) {
        setCardMenuOpenId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [cardMenuOpenId]);

  // Split-view state
  const [selectedReservationId, setSelectedReservationId] = useState<number | null>(null);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['waiting', 'arrived', 'noshow']));
  const [newReservationFlashId, setNewReservationFlashId] = useState<number | null>(null);
  const [hoveredReservationId, setHoveredReservationId] = useState<number | null>(null);
  const [tooltipReservation, setTooltipReservation] = useState<{ id: number; type: 'allergen' | 'note'; text: string; x: number; y: number } | null>(null);

  // Desktop breakpoint for split-view (>= 1024px)
  const [isDesktop, setIsDesktop] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1024);
  useEffect(() => {
    const onResize = () => setIsDesktop(window.innerWidth >= 1024);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const toggleGroup = (group: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  // Draft restore banner — only shown while creating a new reservation
  const [draftBanner, setDraftBanner] = useState<{ savedAt: number } | null>(null);

  // Map-view: assign a free table to an unassigned reservation
  const [assignTableModal, setAssignTableModal] = useState<Table | null>(null);
  // Map-view: list of reservations without an assigned table for the selected date+shift
  const [showUnassignedModal, setShowUnassignedModal] = useState(false);

  // Map view canvas size tracking for responsive scaling.
  // Use a state-based callback ref so the measurement re-runs whenever the
  // canvas element mounts/unmounts (e.g. when viewMode or isPhone changes).
  const [mapCanvasNode, setMapCanvasNode] = useState<HTMLDivElement | null>(null);
  const [mapCanvasSize, setMapCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!mapCanvasNode) {
      setMapCanvasSize({ width: 0, height: 0 });
      return;
    }
    const rect = mapCanvasNode.getBoundingClientRect();
    setMapCanvasSize({ width: rect.width, height: rect.height });
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setMapCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(mapCanvasNode);
    return () => observer.disconnect();
  }, [mapCanvasNode]);

  // Phone breakpoint detection (< 640px = Tailwind's sm) for list-style Map view on smartphones
  const [isPhone, setIsPhone] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);
  useEffect(() => {
    const onResize = () => setIsPhone(window.innerWidth < 640);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Portal target for the page-level title/actions inside the global sticky header
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setHeaderSlot(document.getElementById('page-header-slot'));
  }, []);

  // Confirmation modal state
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    suggestions?: Array<{ label: string; table: Table }>;
    onConfirm: () => void;
    onCancel: () => void;
    onSelectSuggestion?: (table: Table) => void;
  } | null>(null);

  // Customer picker (rubrica) modal
  const [isCustomerPickerOpen, setIsCustomerPickerOpen] = useState(false);

  // Inline customer autocomplete (name & phone fields in the reservation form)
  const [customerSuggestions, setCustomerSuggestions] = useState<Customer[]>([]);
  const [activeSuggestField, setActiveSuggestField] = useState<'name' | 'phone' | null>(null);
  const [matchedCustomerNoShows, setMatchedCustomerNoShows] = useState<number>(0);
  // Tracks which value we last queried for, so the dropdown closes on selection
  // (we set this to the just-selected name/phone to skip re-querying for it).
  const lastSuggestQueryRef = useRef<string>('');

  // Time slot options
  const LUNCH_TIMES = ['13:00', '13:30', '14:00'];
  const DINNER_TIMES = ['19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

  const getDefaultTime = (shift: Shift) => shift === Shift.LUNCH ? '13:00' : '20:00';

  const [formData, setFormData] = useState<Partial<Reservation>>({
      customer_name: '',
      guests: 2,
      children: 0,
      reservation_time: `${new Date().toISOString().split('T')[0]}T20:00`,
      shift: Shift.DINNER,
      payment_status: PaymentStatus.PENDING,
      table_id: undefined,
      enable_reminder: true,
      reminder_sent: false,
      arrival_status: ArrivalStatus.WAITING
  });

  // Debounced customer lookup for the active autocomplete field
  useEffect(() => {
    if (!activeSuggestField) {
      setCustomerSuggestions([]);
      return;
    }
    const raw = activeSuggestField === 'name'
      ? (formData.customer_name || '')
      : (formData.phone || '');
    const query = raw.trim();
    if (query.length < 2 || query === lastSuggestQueryRef.current) {
      setCustomerSuggestions([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const data = await getCustomers(query);
        if (!cancelled) setCustomerSuggestions(data.slice(0, 6));
      } catch {
        if (!cancelled) setCustomerSuggestions([]);
      }
    }, 200);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [activeSuggestField, formData.customer_name, formData.phone]);

  // Auto-detect exact phone match against fetched suggestions, so the no-show
  // warning surfaces even when the user types/pastes a known number directly.
  useEffect(() => {
    const digits = (s: string | null | undefined) => (s || '').replace(/\D/g, '');
    const typedPhone = digits(formData.phone);
    if (typedPhone.length < 6 || customerSuggestions.length === 0) return;
    const exact = customerSuggestions.find(c => digits(c.phone) === typedPhone);
    if (exact && (exact.no_show_count || 0) > 0) {
      setMatchedCustomerNoShows(exact.no_show_count || 0);
    }
  }, [customerSuggestions, formData.phone]);

  const applyCustomerSuggestion = (c: Customer) => {
    lastSuggestQueryRef.current = activeSuggestField === 'phone' ? (c.phone || '') : c.name;
    setFormData(prev => ({
      ...prev,
      customer_name: c.name,
      phone: c.phone || prev.phone || '',
      email: c.email || prev.email || '',
    }));
    setMatchedCustomerNoShows(c.no_show_count || 0);
    setActiveSuggestField(null);
    setCustomerSuggestions([]);
  };

  // Per-shift table merges. Use the form's date+shift while the modal is open;
  // otherwise scope to the page's selectedDate/selectedShift (fallback if 'ALL').
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  const [isLoadingMerges, setIsLoadingMerges] = useState(false);
  const [hiddenTableIds, setHiddenTableIds] = useState<Set<number>>(new Set());
  const [showHidden, setShowHidden] = useState(false);

  const focalDate = isFormOpen && formData.reservation_time
    ? formData.reservation_time.split('T')[0]
    : selectedDate.split('T')[0];
  const focalShift: Shift = isFormOpen && formData.shift
    ? formData.shift
    : (selectedShift !== 'ALL' ? selectedShift : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER));

  // Refresh merges from the server. Used after local merge/split actions so
  // the originating client updates immediately even when the socket is offline.
  const refreshMerges = async (date: string, shift: Shift) => {
    try {
      const merges = await getTableMerges(date, shift);
      setTableMerges(merges);
    } catch (err) {
      console.error('Error fetching table merges:', err);
    }
  };

  const handleToggleTableHidden = async (table: Table) => {
    const isCurrentlyHidden = hiddenTableIds.has(table.id);
    try {
      if (isCurrentlyHidden) {
        await deleteTableHidden(focalDate, focalShift, table.id);
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          next.delete(table.id);
          return next;
        });
        showToast(`Tavolo ${table.name} riattivato`, 'success');
      } else {
        await createTableHidden(focalDate, focalShift, table.id);
        setHiddenTableIds(prev => {
          const next = new Set(prev);
          next.add(table.id);
          return next;
        });
        showToast(`Tavolo ${table.name} nascosto per questo turno`, 'success');
      }
    } catch (err: any) {
      showToast(err?.message || 'Operazione non riuscita', 'error');
    }
  };

  const handleUnhideAllTables = async () => {
    if (hiddenTableIds.size === 0) return;
    const ids = [...hiddenTableIds];
    try {
      await Promise.all(ids.map(id => deleteTableHidden(focalDate, focalShift, id)));
      setHiddenTableIds(new Set());
      setShowHidden(false);
      showToast(`${ids.length} ${ids.length === 1 ? 'tavolo riattivato' : 'tavoli riattivati'} per questo turno`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Operazione non riuscita', 'error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setIsLoadingMerges(true);
    getTableMerges(focalDate, focalShift)
      .then(merges => { if (!cancelled) setTableMerges(merges); })
      .catch(err => {
        console.error('Error fetching table merges:', err);
        if (!cancelled) setTableMerges([]);
      })
      .finally(() => { if (!cancelled) setIsLoadingMerges(false); });
    return () => { cancelled = true; };
  }, [focalDate, focalShift]);

  useEffect(() => {
    let cancelled = false;
    getTableHidden(focalDate, focalShift)
      .then(rows => { if (!cancelled) setHiddenTableIds(new Set(rows.map(r => r.table_id))); })
      .catch(err => {
        console.error('Error fetching hidden tables:', err);
        if (!cancelled) setHiddenTableIds(new Set());
      });
    return () => { cancelled = true; };
  }, [focalDate, focalShift]);

  const { socket, isConnected } = useSocket();

  useEffect(() => {
    if (!socket) return;
    const matches = (m: TableMerge) => m.date === focalDate && m.shift === focalShift;
    const onCreated = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => {
        const existing = prev.findIndex(p => p.primary_id === m.primary_id);
        if (existing >= 0) {
          const next = [...prev];
          next[existing] = m;
          return next;
        }
        return [...prev, m];
      });
    };
    const onDeleted = (m: TableMerge) => {
      if (!matches(m)) return;
      setTableMerges(prev => prev.filter(p => p.primary_id !== m.primary_id));
    };
    socket.on('tableMerge:created', onCreated);
    socket.on('tableMerge:deleted', onDeleted);
    return () => {
      socket.off('tableMerge:created', onCreated);
      socket.off('tableMerge:deleted', onDeleted);
    };
  }, [socket, focalDate, focalShift]);

  useEffect(() => {
    if (!socket) return;
    const matches = (h: TableHiddenOverride) => h.date === focalDate && h.shift === focalShift;
    const onCreated = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.add(h.table_id);
        return next;
      });
    };
    const onDeleted = (h: TableHiddenOverride) => {
      if (!matches(h)) return;
      setHiddenTableIds(prev => {
        const next = new Set(prev);
        next.delete(h.table_id);
        return next;
      });
    };
    socket.on('tableHidden:created', onCreated);
    socket.on('tableHidden:deleted', onDeleted);
    return () => {
      socket.off('tableHidden:created', onCreated);
      socket.off('tableHidden:deleted', onDeleted);
    };
  }, [socket, focalDate, focalShift]);

  const displayTables = useMemo(
    () => applyMerges(tables, tableMerges),
    [tables, tableMerges]
  );

  // Filter Logic for Main List
  const activeFilterCount =
    (filterStatus !== 'ALL' ? 1 : 0) +
    (filterArrivalStatus !== 'ALL' ? 1 : 0) +
    (filterGuestRange !== 'ALL' ? 1 : 0) +
    (filterHasAllergens ? 1 : 0) +
    (filterHasNotes ? 1 : 0) +
    (filterNoTable ? 1 : 0);

  const matchesGuestRange = (guests: number): boolean => {
    switch (filterGuestRange) {
      case '1-2': return guests >= 1 && guests <= 2;
      case '3-4': return guests >= 3 && guests <= 4;
      case '5-6': return guests >= 5 && guests <= 6;
      case '7+': return guests >= 7;
      default: return true;
    }
  };

  const filteredReservations = reservations
    .filter(r => {
      const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
      const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
      const matchesStatus = filterStatus === 'ALL' ? true : r.payment_status === filterStatus;
      const matchesArrival = filterArrivalStatus === 'ALL'
        ? true
        : (r.arrival_status || ArrivalStatus.WAITING) === filterArrivalStatus;
      const matchesGuests = matchesGuestRange(r.guests || 0);
      const matchesAllergens = !filterHasAllergens || (typeof r.notes === 'string' && /intolleranze:/i.test(r.notes));
      const matchesNotes = !filterHasNotes || (typeof r.notes === 'string' && r.notes.trim().length > 0);
      const matchesNoTable = !filterNoTable || !r.table_id;
      const trimmedSearch = searchTerm.trim().toLowerCase();
      let matchesSearch = true;
      if (trimmedSearch) {
        const nameHit = !!r.customer_name && r.customer_name.toLowerCase().includes(trimmedSearch);
        const table = r.table_id ? displayTables.find(t => t.id === r.table_id) : undefined;
        const tableHit = !!table && table.name.toLowerCase().includes(trimmedSearch);
        matchesSearch = nameHit || tableHit;
      }
      return matchesDate && matchesShift && matchesStatus && matchesArrival && matchesGuests && matchesAllergens && matchesNotes && matchesNoTable && matchesSearch;
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'time-asc': return a.reservation_time.localeCompare(b.reservation_time);
        case 'time-desc': return b.reservation_time.localeCompare(a.reservation_time);
        case 'name-asc': return (a.customer_name || '').localeCompare(b.customer_name || '', 'it', { sensitivity: 'base' });
        case 'name-desc': return (b.customer_name || '').localeCompare(a.customer_name || '', 'it', { sensitivity: 'base' });
        case 'guests-asc': return (a.guests || 0) - (b.guests || 0);
        case 'guests-desc': return (b.guests || 0) - (a.guests || 0);
        default: return 0;
      }
    });

  const resetFilters = () => {
    setFilterStatus('ALL');
    setFilterArrivalStatus('ALL');
    setFilterGuestRange('ALL');
    setFilterHasAllergens(false);
    setFilterHasNotes(false);
    setFilterNoTable(false);
    setSortBy('time-asc');
  };

  // --- Grouped reservation list for split-view ---
  // Groups: waiting (in attesa), arrived (arrivati, no table), seated (seduti, has table), completed (departed)
  type ReservationGroup = { key: string; label: string; color: string; dotClass: string; items: Reservation[] };
  const groupedReservations = useMemo((): ReservationGroup[] => {
    const dateFiltered = reservations.filter(r => {
      const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
      const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
      const trimmedSearch = searchTerm.trim().toLowerCase();
      let matchesSearch = true;
      if (trimmedSearch) {
        const nameHit = !!r.customer_name && r.customer_name.toLowerCase().includes(trimmedSearch);
        const table = r.table_id ? displayTables.find(t => t.id === r.table_id) : undefined;
        const tableHit = !!table && table.name.toLowerCase().includes(trimmedSearch);
        matchesSearch = nameHit || tableHit;
      }
      return matchesDate && matchesShift && matchesSearch;
    });

    const pending: Reservation[] = [];
    const waiting: Reservation[] = [];
    const arrived: Reservation[] = [];
    const freed: Reservation[] = [];
    const noshow: Reservation[] = [];
    const cancelled: Reservation[] = [];

    for (const r of dateFiltered) {
      const resStatus = r.reservation_status || ReservationStatus.CONFIRMED;
      if (resStatus === ReservationStatus.PENDING) {
        pending.push(r);
        continue;
      }
      if (resStatus === ReservationStatus.CANCELLED) {
        cancelled.push(r);
        continue;
      }
      if (resStatus === ReservationStatus.NO_SHOW) {
        noshow.push(r);
        continue;
      }
      const status = r.arrival_status || ArrivalStatus.WAITING;
      if (status === ArrivalStatus.DEPARTED) {
        freed.push(r);
      } else if (status === ArrivalStatus.ARRIVED) {
        arrived.push(r);
      } else {
        waiting.push(r);
      }
    }

    pending.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    waiting.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    arrived.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    freed.sort((a, b) => b.reservation_time.localeCompare(a.reservation_time));
    noshow.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));
    cancelled.sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));

    return [
      { key: 'pending', label: 'Da confermare', color: 'bg-amber-500', dotClass: 'bg-amber-500', items: pending },
      { key: 'waiting', label: 'In attesa', color: 'bg-blue-500', dotClass: 'bg-blue-500', items: waiting },
      { key: 'arrived', label: 'Arrivato', color: 'bg-emerald-500', dotClass: 'bg-emerald-500', items: arrived },
      { key: 'noshow', label: 'No show', color: 'bg-rose-500', dotClass: 'bg-rose-500', items: noshow },
      { key: 'freed', label: 'Libera', color: 'bg-slate-400', dotClass: 'bg-slate-400', items: freed },
      { key: 'cancelled', label: 'Annullate', color: 'bg-rose-500', dotClass: 'bg-rose-500', items: cancelled },
    ].filter(g => g.items.length > 0);
  }, [reservations, selectedDate, selectedShift, searchTerm, displayTables]);

  const totalGroupedCount = groupedReservations.reduce((s, g) => s + g.items.length, 0);

  const selectedReservation = selectedReservationId
    ? reservations.find(r => r.id === selectedReservationId) ?? null
    : null;

  // Flash animation for newly arriving reservations
  useEffect(() => {
    if (newReservationFlashId !== null) {
      const timer = setTimeout(() => setNewReservationFlashId(null), 1500);
      return () => clearTimeout(timer);
    }
  }, [newReservationFlashId]);

  const selectedDateStr = selectedDate.split('T')[0];

  // --- Actions ---

  const handlePaymentAction = (reservation: Reservation) => {
    let newStatus = PaymentStatus.PAID_FULL;
    if (reservation.payment_status === PaymentStatus.PENDING) {
        newStatus = PaymentStatus.PAID_DEPOSIT; 
    } else if (reservation.payment_status === PaymentStatus.PAID_DEPOSIT) {
        newStatus = PaymentStatus.PAID_FULL;
    }

    onUpdateReservation({
        ...reservation,
        payment_status: newStatus
    });
  };

  const handleSendWhatsapp = async (res: Reservation) => {
      if (!res.phone) {
          showToast('Numero di telefono mancante per questa prenotazione.', 'error');
          return;
      }

      try {
          await sendWhatsAppConfirmation(res.id);
          showToast(`Conferma WhatsApp inviata a ${toTitleCase(res.customer_name)}`, 'success');
      } catch (error) {
          console.error('Error sending WhatsApp confirmation:', error);
          showToast('Errore durante l\'invio della conferma WhatsApp', 'error');
      }
  };

  const handleSendEmail = (res: Reservation) => {
      if (!res.email) {
          showToast('Email cliente mancante.', 'error');
          return;
      }
      const subject = `Conferma Prenotazione RistoManager - ${new Date(res.reservation_time).toLocaleDateString()}`;
      const body = `Gentile ${toTitleCase(res.customer_name)},\n\nConfermiamo con piacere la sua prenotazione per:\nData: ${new Date(res.reservation_time).toLocaleDateString()}\nOra: ${new Date(res.reservation_time).toLocaleTimeString()}\nOspiti: ${res.guests}\n\nCordiali saluti,\nRistoManager Team`;
      
      const url = `mailto:${res.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      window.location.href = url;
      showToast('Client di posta aperto', 'success');
  };
  
  const handleSendReminder = (res: Reservation) => {
      if (res.reminder_sent) {
          showToast('Promemoria già inviato per questa prenotazione', 'info');
          return;
      }
      onUpdateReservation({ ...res, reminder_sent: true });
      showToast(`Promemoria inviato a ${toTitleCase(res.customer_name)}`, 'success');
  };

  type ReservationStateKey = 'pending' | 'waiting' | 'arrived' | 'freed' | 'noshow' | 'cancelled';

  const getReservationState = (res: Reservation): ReservationStateKey => {
    const rs = res.reservation_status || ReservationStatus.CONFIRMED;
    if (rs === ReservationStatus.PENDING) return 'pending';
    if (rs === ReservationStatus.CANCELLED) return 'cancelled';
    if (rs === ReservationStatus.NO_SHOW) return 'noshow';
    const a = res.arrival_status || ArrivalStatus.WAITING;
    if (a === ArrivalStatus.DEPARTED) return 'freed';
    if (a === ArrivalStatus.ARRIVED) return 'arrived';
    return 'waiting';
  };

  const RESERVATION_STATE_META: Record<ReservationStateKey, { label: string; dotClass: string; chipClass: string }> = {
    pending:   { label: 'Da confermare', dotClass: 'bg-amber-500', chipClass: 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 dark:hover:bg-amber-500/25' },
    waiting:   { label: 'In attesa', dotClass: 'bg-blue-500', chipClass: 'bg-blue-50 text-blue-700 border-blue-200 hover:bg-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30 dark:hover:bg-blue-500/25' },
    arrived:   { label: 'Arrivato', dotClass: 'bg-emerald-500', chipClass: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30 dark:hover:bg-emerald-500/25' },
    freed:     { label: 'Libera',   dotClass: 'bg-slate-400', chipClass: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30 dark:hover:bg-slate-500/25' },
    noshow:    { label: 'No show',  dotClass: 'bg-rose-500',  chipClass: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25' },
    cancelled: { label: 'Annullata',dotClass: 'bg-rose-500',  chipClass: 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25' },
  };

  const [stateChangeReservation, setStateChangeReservation] = useState<Reservation | null>(null);

  const handleSetReservationState = (res: Reservation, state: ReservationStateKey) => {
    const update: Partial<Reservation> = {};
    switch (state) {
      case 'pending':
        update.arrival_status = ArrivalStatus.WAITING;
        update.reservation_status = ReservationStatus.PENDING;
        break;
      case 'waiting':
        update.arrival_status = ArrivalStatus.WAITING;
        update.reservation_status = ReservationStatus.CONFIRMED;
        break;
      case 'arrived':
        update.arrival_status = ArrivalStatus.ARRIVED;
        update.reservation_status = ReservationStatus.CONFIRMED;
        break;
      case 'freed':
        update.arrival_status = ArrivalStatus.DEPARTED;
        update.reservation_status = ReservationStatus.CONFIRMED;
        break;
      case 'noshow':
        update.arrival_status = ArrivalStatus.WAITING;
        update.reservation_status = ReservationStatus.NO_SHOW;
        break;
      case 'cancelled':
        update.arrival_status = ArrivalStatus.WAITING;
        update.reservation_status = ReservationStatus.CANCELLED;
        break;
    }
    onUpdateReservation({ ...res, ...update });
    showToast(`${toTitleCase(res.customer_name)}: stato → ${RESERVATION_STATE_META[state].label}`, 'success');
  };

  // Voice input handler
  const handleVoiceInput = async () => {
    if (!isVoiceSupported()) {
      showToast('Riconoscimento vocale non supportato dal browser', 'error');
      return;
    }

    setIsListening(true);
    showToast('Parla ora...', 'info');

    try {
      const transcript = await startListening();
      console.log('Voice transcript:', transcript);
      const parsed = parseReservationText(transcript);
      console.log('Parsed reservation:', parsed);

      // Update form with parsed values, keeping existing values if not parsed
      setFormData(prev => {
        const nextGuests = parsed.guests || prev.guests;
        const rawChildren = parsed.children ?? prev.children;
        const nextChildren = rawChildren != null && nextGuests != null
          ? Math.max(0, Math.min(rawChildren, nextGuests))
          : rawChildren;
        return {
          ...prev,
          customer_name: parsed.customer_name || prev.customer_name,
          guests: nextGuests,
          children: nextChildren,
          reservation_time: parsed.reservation_time || prev.reservation_time,
          shift: parsed.shift || prev.shift,
          phone: parsed.phone || prev.phone,
          notes: parsed.notes ? (prev.notes ? `${prev.notes}, ${parsed.notes}` : parsed.notes) : prev.notes,
        };
      });

      // Build summary of what was parsed
      const parsedFields: string[] = [];
      if (parsed.customer_name) parsedFields.push(`Nome: ${parsed.customer_name}`);
      if (parsed.guests) parsedFields.push(`${parsed.guests} persone`);
      if (parsed.children) parsedFields.push(`${parsed.children} bambin${parsed.children === 1 ? 'o' : 'i'}`);
      if (parsed.reservation_time) {
        const dt = new Date(parsed.reservation_time);
        parsedFields.push(`${dt.toLocaleDateString('it-IT')} ${dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`);
      }
      if (parsed.shift) parsedFields.push(parsed.shift === Shift.LUNCH ? 'Pranzo' : 'Cena');

      if (parsedFields.length > 0) {
        showToast(`Compilato: ${parsedFields.join(' · ')}`, 'success');
      } else {
        showToast(`Riconosciuto: "${transcript}"`, 'info');
      }
    } catch (error: any) {
      if (error.message === 'no-speech') {
        showToast('Nessun audio rilevato, riprova', 'error');
      } else if (error.message === 'audio-capture') {
        showToast('Microfono non disponibile', 'error');
      } else if (error.message === 'not-allowed') {
        showToast('Permesso microfono negato', 'error');
      } else {
        showToast('Errore riconoscimento vocale', 'error');
      }
    } finally {
      setIsListening(false);
    }
  };

  const handleEditClick = (res: Reservation) => {
      const formattedReservation = {
        ...res,
        reservation_time: new Date(res.reservation_time).toISOString().substring(0, 16)
      };
      setFormData(formattedReservation);

      // Extract allergens from notes
      const existingAllergens = COMMON_ALLERGENS.filter(allergen =>
        res.notes?.toLowerCase().includes(allergen.toLowerCase())
      );
      setSelectedAllergens(existingAllergens);

      // Extract quick notes
      const existingQuickNotes = QUICK_NOTES.filter(note =>
        res.notes?.toLowerCase().includes(note.toLowerCase())
      );
      setSelectedQuickNotes(existingQuickNotes);

      // Clean notes: remove allergens and quick notes parts to avoid duplication
      let cleanedNotes = res.notes || '';
      // Remove "Intolleranze: ..." part
      cleanedNotes = cleanedNotes.replace(/Intolleranze:\s*[^|]*(\s*\|\s*)?/gi, '');
      // Remove quick notes
      existingQuickNotes.forEach(note => {
        cleanedNotes = cleanedNotes.replace(new RegExp(note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\|?\\s*', 'gi'), '');
      });
      // Clean up remaining separators and whitespace
      cleanedNotes = cleanedNotes.replace(/^\s*\|\s*/, '').replace(/\s*\|\s*$/, '').replace(/\s*\|\s*\|\s*/g, ' | ').trim();

      // Update formData with cleaned notes
      setFormData(prev => ({ ...prev, notes: cleanedNotes || '' }));

      // Show sections if they have content
      setShowAllergensSection(existingAllergens.length > 0);
      setShowNotesSection(existingQuickNotes.length > 0 || cleanedNotes.length > 0);

      const table = tables.find(t => t.id === res.table_id);
      setModalRoomFilter(table ? table.room_id : 'ALL');
      setIsEditing(true);
      setIsFormOpen(true);
  };

  const handleDeleteClick = (id: number, customerName: string) => {
      setDeleteConfirmModal({show: true, reservationId: id, customerName});
  }

  const handleConfirmDelete = () => {
      if (deleteConfirmModal.reservationId !== null) {
          onDeleteReservation(deleteConfirmModal.reservationId);
          showToast('Prenotazione eliminata', 'success');
      }
      setDeleteConfirmModal({show: false, reservationId: null, customerName: ''});
  }

  const handleCancelDelete = () => {
      setDeleteConfirmModal({show: false, reservationId: null, customerName: ''});
  }

  const QUICK_NOTES = ['Seggiolone', 'Cane', 'Compleanno', 'Anniversario', 'Tavolo tranquillo', 'Vista'];

  const handleOpenNew = () => {
      const newShift = selectedShift === 'ALL' ? Shift.DINNER : selectedShift;
      const defaultTime = getDefaultTime(newShift);
      const dateOnly = selectedDate.split('T')[0];
      setFormData({
        customer_name: '',
        guests: 2,
        children: 0,
        reservation_time: `${dateOnly}T${defaultTime}`,
        shift: newShift,
        payment_status: PaymentStatus.PENDING,
        table_id: undefined,
        enable_reminder: true,
        reminder_sent: false,
        arrival_status: ArrivalStatus.WAITING,
        notes: ''
      });
      setSelectedAllergens([]);
      setSelectedQuickNotes([]);
      setShowAllergensSection(false);
      setShowNotesSection(false);
      setModalRoomFilter('ALL');
      setMatchedCustomerNoShows(0);
      setIsEditing(false);
      setIsFormOpen(true);

      const existing = loadDraft<{
        formData: Partial<Reservation>;
        selectedAllergens: string[];
        selectedQuickNotes: string[];
      }>(DRAFT_KEYS.RESERVATION_NEW);
      setDraftBanner(existing ? { savedAt: existing.savedAt } : null);
  };

  // Auto-open new reservation form when triggered from outside (e.g. Dashboard CTA)
  useEffect(() => {
    if (autoOpenNew) {
      handleOpenNew();
      onAutoOpenNewHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoOpenNew]);

  // In modal-only mode, notify parent when the form closes
  const wasFormOpenRef = useRef(false);
  useEffect(() => {
    if (modalOnly && wasFormOpenRef.current && !isFormOpen) {
      onModalClose?.();
    }
    wasFormOpenRef.current = isFormOpen;
  }, [isFormOpen, modalOnly, onModalClose]);

  const handleRestoreDraft = () => {
      const existing = loadDraft<{
        formData: Partial<Reservation>;
        selectedAllergens: string[];
        selectedQuickNotes: string[];
      }>(DRAFT_KEYS.RESERVATION_NEW);
      if (!existing) {
        setDraftBanner(null);
        return;
      }
      setFormData(existing.data.formData);
      setSelectedAllergens(existing.data.selectedAllergens || []);
      setSelectedQuickNotes(existing.data.selectedQuickNotes || []);
      setShowAllergensSection((existing.data.selectedAllergens || []).length > 0);
      setShowNotesSection(
        (existing.data.selectedQuickNotes || []).length > 0 ||
        !!existing.data.formData?.notes
      );
      setDraftBanner(null);
      showToast('Bozza ripristinata', 'success');
  };

  const handleDiscardDraft = () => {
      clearDraft(DRAFT_KEYS.RESERVATION_NEW);
      setDraftBanner(null);
  };

  // Persist a draft of the new-reservation form (debounced).
  // Only while creating (not editing) and only if the user has typed something meaningful.
  useEffect(() => {
    if (!isFormOpen || isEditing) return;

    const hasContent =
      (formData.customer_name && formData.customer_name.trim() !== '') ||
      (formData.phone && formData.phone.trim() !== '') ||
      (formData.email && formData.email.trim() !== '') ||
      (formData.notes && formData.notes.trim() !== '') ||
      selectedAllergens.length > 0 ||
      selectedQuickNotes.length > 0;
    if (!hasContent) return;

    const timer = setTimeout(() => {
      saveDraft(DRAFT_KEYS.RESERVATION_NEW, {
        formData,
        selectedAllergens,
        selectedQuickNotes,
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [isFormOpen, isEditing, formData, selectedAllergens, selectedQuickNotes]);

  // --- Helper Logic ---

  const getBanquetForTable = (table_id: number, checkDate: string, checkShift: Shift): BanquetMenu | null => {
    for (const b of banquetMenus) {
      if (b.event_date !== checkDate) continue;
      if (b.shift !== checkShift) continue;
      const ids = Array.isArray(b.table_ids) ? b.table_ids : [];
      if (ids.includes(table_id)) return b;
    }
    return null;
  };

  const isTableOccupied = (table_id: number, checkDate: string, checkShift: Shift) => {
    const occupiedByReservation = reservations.some(r =>
        r.table_id === table_id &&
        r.reservation_time.split('T')[0] === checkDate &&
        r.shift === checkShift &&
        r.id !== formData.id &&
        r.arrival_status !== ArrivalStatus.DEPARTED
    );
    if (occupiedByReservation) return true;
    return !!getBanquetForTable(table_id, checkDate, checkShift);
  };

  const getReservationForTable = (table_id: number) => {
      return reservations.find(r =>
          r.table_id === table_id &&
          r.reservation_time.split('T')[0] === selectedDate.split('T')[0] &&
          (selectedShift === 'ALL' || r.shift === selectedShift) &&
          r.arrival_status !== ArrivalStatus.DEPARTED &&
          r.reservation_status !== ReservationStatus.CANCELLED
      );
  }

  // Returns either a reservation OR a banquet that occupies this table for the
  // currently selected date+shift in the map view. Used by Map view to render
  // banquet-occupied tables with their own visual state.
  const getOccupierForTable = (table_id: number): { kind: 'reservation'; data: Reservation } | { kind: 'banquet'; data: BanquetMenu } | null => {
      const date = selectedDate.split('T')[0];
      const res = getReservationForTable(table_id);
      if (res) return { kind: 'reservation', data: res };
      if (selectedShift === 'ALL') {
          const banquetLunch = getBanquetForTable(table_id, date, Shift.LUNCH);
          if (banquetLunch) return { kind: 'banquet', data: banquetLunch };
          const banquetDinner = getBanquetForTable(table_id, date, Shift.DINNER);
          if (banquetDinner) return { kind: 'banquet', data: banquetDinner };
          return null;
      }
      const banquet = getBanquetForTable(table_id, date, selectedShift);
      if (banquet) return { kind: 'banquet', data: banquet };
      return null;
  };

  // Returns either a reservation OR a banquet that occupies this table for the
  // form's date+shift. The picker uses the result to mark the table as occupied
  // and to display the occupier's name in the red pill.
  const getOccupierForTableInForm = (table_id: number): { kind: 'reservation'; data: Reservation } | { kind: 'banquet'; data: BanquetMenu } | null => {
      if (!formData.reservation_time || !formData.shift) return null;
      const date = formData.reservation_time.split('T')[0];
      const res = reservations.find(r =>
          r.table_id === table_id &&
          r.reservation_time.split('T')[0] === date &&
          r.shift === formData.shift &&
          r.id !== formData.id &&
          r.arrival_status !== ArrivalStatus.DEPARTED
      );
      if (res) return { kind: 'reservation', data: res };
      const banquet = getBanquetForTable(table_id, date, formData.shift);
      if (banquet) return { kind: 'banquet', data: banquet };
      return null;
  };

  // Backwards-compatible: returns only the reservation (or null) for legacy callers.
  const getReservationForTableInForm = (table_id: number): Reservation | null => {
      const occ = getOccupierForTableInForm(table_id);
      return occ && occ.kind === 'reservation' ? occ.data : null;
  };

  const handleTableSelection = (table: Table) => {
      const guests = formData.guests || 1;

      // Check if table is too small
      if (table.seats < guests) {
          const closedRoomIds = new Set(rooms.filter(r => r.is_closed).map(r => r.id));
          // Find suitable alternatives (use displayTables for current shift context)
          const suitableTables = displayTables
              .filter(t => !closedRoomIds.has(t.room_id))
              .filter(t => t.seats >= guests)
              .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
              .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
              .filter(t => !displayTables.some(other =>
                  other.merged_with && other.merged_with.length > 0 &&
                  other.merged_with.map(id => Number(id)).includes(Number(t.id))
              ))
              .filter(t => !hiddenTableIds.has(t.id))
              .sort((a, b) => a.seats - b.seats);

          if (suitableTables.length > 0) {
              const suggestions = suitableTables.slice(0, 3).map(t => {
                  const room = rooms.find(r => r.id === t.room_id);
                  return {
                      label: `${t.name} - ${t.seats} posti (${room?.name})`,
                      table: t
                  };
              });

              setConfirmModal({
                  isOpen: true,
                  title: '⚠️ Capienza Insufficiente',
                  message: `Il tavolo ${table.name} ha solo ${table.seats} posti ma la prenotazione è per ${guests} ospiti.`,
                  suggestions: suggestions,
                  onConfirm: () => {
                      setFormData({...formData, table_id: table.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                      showToast(`Tavolo ${table.name} assegnato`, 'success');
                  },
                  onCancel: () => {
                      showToast('Selezione annullata. Scegli un tavolo più grande.', 'info');
                      setConfirmModal(null);
                  },
                  onSelectSuggestion: (suggestedTable: Table) => {
                      setFormData({...formData, table_id: suggestedTable.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                      showToast(`Tavolo ${suggestedTable.name} assegnato automaticamente`, 'success');
                  }
              });
          } else {
              // No suitable tables available - warn but allow
              setConfirmModal({
                  isOpen: true,
                  title: '⚠️ Capienza Insufficiente',
                  message: `Il tavolo ${table.name} ha solo ${table.seats} posti ma la prenotazione è per ${guests} ospiti.\n\nNon ci sono tavoli disponibili più grandi.`,
                  onConfirm: () => {
                      setFormData({...formData, table_id: table.id});
                      setSelectedTablesForMerge([]);
                      setConfirmModal(null);
                  },
                  onCancel: () => {
                      showToast('Selezione annullata.', 'info');
                      setConfirmModal(null);
                  }
              });
          }
          return;
      }

      // Assign the table (if capacity is sufficient)
      setFormData({...formData, table_id: table.id});
      setSelectedTablesForMerge([]);
  };

  const handleAutoAssign = () => {
      if (!formData.guests || !formData.reservation_time || !formData.shift) return;

      const closedRoomIds = new Set(rooms.filter(r => r.is_closed).map(r => r.id));

      const availableTables = displayTables
        .filter(t => !closedRoomIds.has(t.room_id))
        .filter(t => t.seats >= (formData.guests || 0))
        .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
        .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
        .filter(t => !displayTables.some(other =>
            other.merged_with && other.merged_with.length > 0 &&
            other.merged_with.map(id => Number(id)).includes(Number(t.id))
        ))
        .filter(t => !hiddenTableIds.has(t.id))
        .sort((a, b) => a.seats - b.seats);

      if (availableTables.length > 0) {
          setFormData({ ...formData, table_id: availableTables[0].id });
          showToast(`Tavolo ${availableTables[0].name} assegnato automaticamente.`, 'success');
      } else {
          showToast("Nessun tavolo ottimale trovato.", 'error');
      }
  };

  const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!formData.customer_name || !formData.reservation_time) return;
      if (isSavingReservation) return;

      // Combine allergens, quick notes, and additional notes
      const allergensText = selectedAllergens.length > 0
          ? `Intolleranze: ${selectedAllergens.join(', ')}`
          : '';
      const quickNotesText = selectedQuickNotes.length > 0
          ? selectedQuickNotes.join(', ')
          : '';
      const additionalNotes = formData.notes || '';
      const combinedNotes = [allergensText, quickNotesText, additionalNotes].filter(Boolean).join(' | ');

      const dataToSave = {
          ...formData,
          notes: combinedNotes || undefined
      };

      try {
          setIsSavingReservation(true);
          if (isEditing) {
              await onUpdateReservation(dataToSave as Reservation);
          } else {
              await onAddReservation(dataToSave as Omit<Reservation, 'id'>);
              clearDraft(DRAFT_KEYS.RESERVATION_NEW);
          }

          setDraftBanner(null);
          setIsFormOpen(false);
      } finally {
          setIsSavingReservation(false);
      }
  };

  const getStatusColor = (status: PaymentStatus) => {
    switch (status) {
      case PaymentStatus.PAID_FULL: return 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30';
      case PaymentStatus.PAID_DEPOSIT: return 'bg-blue-50 text-blue-700 border-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30';
      case PaymentStatus.PENDING: return 'bg-amber-50 text-amber-700 border-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30';
      case PaymentStatus.REFUNDED: return 'bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30';
      default: return 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border-[var(--color-line)]';
    }
  };

  const openRooms = rooms.filter(r => !r.is_closed);
  const displayedRooms = modalRoomFilter === 'ALL' ? openRooms : openRooms.filter(r => r.id === modalRoomFilter);
  const selectedTableObj = displayTables.find(t => t.id === formData.table_id);

  // Calculate Free Tables for the form header
  // Helper to check if a table is merged into another table (and thus should be hidden)
  const isTableMergedIntoAnother = (tableId: number) => {
    return displayTables.some(other =>
      other.merged_with &&
      other.merged_with.length > 0 &&
      other.merged_with.map(id => Number(id)).includes(Number(tableId))
    );
  };

  // Get visible tables (not merged into another table, not hidden for this shift)
  const visibleTables = displayTables.filter(t =>
    (modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter) &&
    !isTableMergedIntoAnother(t.id) &&
    !hiddenTableIds.has(t.id)
  );

  const totalTablesInFilter = visibleTables.length;

  // Count occupied tables only if we have valid form data
  // Include tables occupied by OTHER reservations + the table currently selected in formData
  const occupiedTablesInFilter = (formData.reservation_time && formData.shift)
    ? visibleTables.filter(t => {
        // Check if occupied by another reservation
        const occupiedByOther = isTableOccupied(t.id, formData.reservation_time!.split('T')[0], formData.shift!);
        // Check if this is the table selected in the current form
        const selectedInForm = formData.table_id === t.id;
        return occupiedByOther || selectedInForm;
      }).length
    : 0;

  const freeTablesCount = totalTablesInFilter - occupiedTablesInFilter;

  // Render logic for Map Table
  const renderMapTable = (table: Table) => {
      const occupier = getOccupierForTable(table.id);
      const reservation = occupier?.kind === 'reservation' ? occupier.data : null;
      const banquet = occupier?.kind === 'banquet' ? occupier.data : null;
      const isOccupied = !!occupier;
      const isArrived = !!reservation && reservation.arrival_status === ArrivalStatus.ARRIVED;
      const isHidden = hiddenTableIds.has(table.id);
      const trimmedSearch = searchTerm.trim().toLowerCase();
      const isSearchMatch = !!(trimmedSearch && (
        (reservation && reservation.customer_name.toLowerCase().includes(trimmedSearch)) ||
        (banquet && banquet.name.toLowerCase().includes(trimmedSearch)) ||
        table.name.toLowerCase().includes(trimmedSearch)
      ));

      // Uniform table sizes on the map. The seat count is shown inside the
      // card, so we don't need to scale rectangles by capacity.
      const baseSize = window.innerWidth < 768 ? 50 : 100;

      let widthPx: number;
      let heightPx: number;
      let borderRadius: string;
      if (table.shape === TableShape.CIRCLE) {
          widthPx = baseSize; heightPx = baseSize; borderRadius = '50%';
      } else {
          widthPx = baseSize; heightPx = baseSize; borderRadius = '8px';
      }

      // Anchor the reservation pill below the rotated bounding box so it
      // always sits horizontally below the visible table at any rotation.
      const rotationRad = ((table.rotation || 0) * Math.PI) / 180;
      const rotatedHalfH = (Math.abs(widthPx * Math.sin(rotationRad)) + Math.abs(heightPx * Math.cos(rotationRad))) / 2;
      const pillTopPx = heightPx / 2 + rotatedHalfH + 6;

      const shapeClasses = `flex flex-col items-center justify-center border shadow-[var(--shadow-xs)] transition-all select-none
          ${isArrived
              ? 'bg-orange-50 border-orange-300 text-orange-700 ring-1 ring-orange-200 dark:bg-orange-500/15 dark:border-orange-500/40 dark:text-orange-300 dark:ring-orange-500/30'
              : reservation
                  ? 'bg-rose-50 border-rose-300 text-rose-700 ring-1 ring-rose-200 dark:bg-rose-500/15 dark:border-rose-500/40 dark:text-rose-300 dark:ring-rose-500/30'
                  : banquet
                      ? 'bg-indigo-50 border-indigo-300 text-indigo-700 ring-1 ring-indigo-200 dark:bg-[#4f46e5]/20 dark:border-[#4f46e5]/50 dark:text-[#a5b4fc] dark:ring-[#4f46e5]/40'
                      : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
          }
          ${isHidden ? 'opacity-40 grayscale' : ''}
      `;

      const isHighlighted = selectedReservation?.table_id === table.id && detailDrawerOpen;
      const hoveredRes = hoveredReservationId ? reservations.find(r => r.id === hoveredReservationId) : null;
      const isHoverMatch = hoveredRes?.table_id === table.id;

      const tooltipText = isHidden
          ? 'Tavolo nascosto per questo turno — clicca per riattivarlo'
          : reservation
              ? `Occupato da: ${toTitleCase(reservation.customer_name)}`
              : banquet
                  ? `Banchetto: ${banquet.name}`
                  : 'Libero — clicca per assegnare una prenotazione';

      return (
        <div
            key={table.id}
            className={`absolute ${isOccupied ? 'z-10' : ''} ${(isSearchMatch || isHoverMatch) ? 'z-20' : ''} ${isHighlighted ? 'z-30' : ''}`}
            style={{
                left: table.x,
                top: table.y,
                width: `${widthPx}px`,
                height: `${heightPx}px`,
            }}
            title={tooltipText}
            onClick={() => {
                if (reservation) {
                    handleEditClick(reservation);
                } else if (banquet) {
                    // Banquet-occupied tables are not assignable from this view.
                } else if (canEdit) {
                    setAssignTableModal(table);
                }
            }}
        >
            <div
                className={`${shapeClasses} ${isHighlighted ? 'outline outline-3 outline-blue-400 outline-offset-2 animate-pulse-ring' : ''} ${(isSearchMatch || isHoverMatch) && !isHighlighted ? 'outline outline-2 outline-rose-500 outline-offset-2 animate-search-pulse' : ''}`}
                style={{
                    width: `${widthPx}px`,
                    height: `${heightPx}px`,
                    borderRadius,
                    transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined,
                }}
            >
                {isHidden && (
                    <div className="absolute -top-2 -left-2 bg-slate-500 text-[#ffffff] text-[10px] font-bold px-1.5 py-0.5 rounded-full shadow-sm flex items-center gap-0.5 border border-[#ffffff]">
                        <EyeOff size={8} />
                    </div>
                )}
                <span className="font-bold text-lg sm:text-xl tracking-tight truncate px-1 max-w-full leading-tight">{table.name}</span>
                {reservation ? (
                    <span className="flex items-center gap-1 text-lg sm:text-xl font-bold leading-tight">
                        <Users size={18} /> {reservation.guests}
                        {reservation.children && reservation.children > 0 ? (
                            <span className="text-xs font-normal opacity-75 ml-0.5">({reservation.children}b)</span>
                        ) : null}
                    </span>
                ) : banquet ? (
                    <span className="flex items-center gap-1 text-xs sm:text-sm font-semibold">
                        <BookOpen size={14} />
                    </span>
                ) : (
                    <span className="text-xs sm:text-sm flex items-center gap-1 opacity-80">
                        <Armchair size={12} /> {table.seats}
                    </span>
                )}
            </div>
            {reservation && (
                <div
                    style={{ top: pillTopPx }}
                    className={`absolute left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 text-[#ffffff] text-sm sm:text-base font-medium pl-1 pr-3 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-sm)] max-w-[220px] ${isArrived ? 'bg-orange-600' : 'bg-[#e11d48]'}`}
                    title={reservation.source === ReservationSource.VOICE ? "Presa dall'agente vocale" : (reservation.created_by_user_name ? `Presa da ${toTitleCase(reservation.created_by_user_name)}` : undefined)}
                >
                    {reservation.source === ReservationSource.VOICE ? (
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white dark:bg-white/20 text-[var(--color-fg)] dark:text-white border border-[var(--color-line)] dark:border-white/30 flex-shrink-0">
                            <Mic className="h-3 w-3" />
                        </span>
                    ) : reservation.created_by_user_name ? (
                        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white dark:bg-white/20 text-[var(--color-fg)] dark:text-white text-[10px] font-bold border border-[var(--color-line)] dark:border-white/30 flex-shrink-0">
                            {getInitials(reservation.created_by_user_name)}
                        </span>
                    ) : (
                        <span className="pl-2" />
                    )}
                    <span className="truncate">{toTitleCase(reservation.customer_name)}</span>
                </div>
            )}
            {banquet && (
                <div
                    style={{ top: pillTopPx }}
                    className="absolute left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 text-sm sm:text-base font-medium px-3 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-sm)] max-w-[220px] bg-[#4f46e5] text-[#ffffff]"
                >
                    <BookOpen size={14} className="flex-shrink-0" />
                    <span className="truncate">{banquet.name}</span>
                </div>
            )}
        </div>
      );
  };

  // --- Helpers for reservation rows ---
  const handleRowClick = (res: Reservation) => {
    if (selectedReservationId === res.id) {
      setSelectedReservationId(null);
      setDetailDrawerOpen(false);
    } else {
      setSelectedReservationId(res.id);
      setDetailDrawerOpen(true);
    }
  };

  const closeDetailDrawer = () => {
    setSelectedReservationId(null);
    setDetailDrawerOpen(false);
  };

  const renderReservationRow = (res: Reservation, group: ReservationGroup) => {
    const table = displayTables.find(t => t.id === res.table_id);
    const tableRoom = table ? rooms.find(r => r.id === table.room_id) : null;
    const isSelected = selectedReservationId === res.id;
    const hasAllergens = res.notes && /intolleranze:/i.test(res.notes);
    const allergenText = hasAllergens ? res.notes!.match(/intolleranze:\s*([^|]*)/i)?.[1]?.trim() : null;
    const noteText = res.notes ? res.notes.replace(/intolleranze:.*$/im, '').trim() : '';
    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
    const isFlashing = newReservationFlashId === res.id;
    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;

    return (
      <div
        key={res.id}
        className={`w-full flex border-b border-[var(--color-line)] last:border-b-0 group/row cursor-pointer
          ${isSelected ? 'bg-blue-50 dark:bg-blue-950/30' : group.key === 'noshow' || group.key === 'cancelled' ? 'bg-rose-50/40 hover:bg-rose-50 dark:bg-rose-500/10 dark:hover:bg-rose-500/15' : 'hover:bg-[var(--color-surface-hover)]'}
          ${isFlashing ? 'animate-flash-row' : ''}
          ${group.key === 'freed' || group.key === 'cancelled' ? 'opacity-60' : ''}
        `}
        onMouseEnter={() => setHoveredReservationId(res.id)}
        onMouseLeave={() => setHoveredReservationId(null)}
        onClick={() => handleRowClick(res)}
      >
        {/* Left content */}
        <div className="flex-1 min-w-0 px-3 py-2">
          {/* Row 1: Time + indicator icons */}
          <div className="flex items-center gap-1.5 h-5">
            <span className="text-xs text-[var(--color-fg)] tabular">
              {formatTime(res.reservation_time)}
            </span>
            {allergenText && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'allergen', text: allergenText, x: e.clientX, y: e.clientY }); }}
                className="flex-shrink-0">
                <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
              </button>
            )}
            {noteText && (
              <button type="button" onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'note', text: noteText, x: e.clientX, y: e.clientY }); }}
                className="flex-shrink-0">
                <StickyNote className="h-3.5 w-3.5 text-amber-500" />
              </button>
            )}
            {res.payment_status !== PaymentStatus.PENDING && (
              <span className="flex-shrink-0" title={res.payment_status === PaymentStatus.PAID_FULL ? 'Saldato' : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'Acconto' : 'Rimborsato'}>
                <CreditCard className="h-3.5 w-3.5 text-emerald-600" />
              </span>
            )}
            {menu && (
              <span className="flex-shrink-0" title={menu.name}>
                <BookOpen className="h-3.5 w-3.5 text-indigo-500" />
              </span>
            )}
            {group.key === 'noshow' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0">
                <UserX className="h-2.5 w-2.5" /> No show
              </span>
            )}
            {group.key === 'cancelled' && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0">
                <Ban className="h-2.5 w-2.5" /> Annullata
              </span>
            )}
          </div>

          {/* Row 2: Customer name */}
          <div className="flex items-center gap-1.5 min-w-0">
            {renderOperatorBadge(res)}
            <p className={`text-base font-semibold text-[var(--color-fg)] leading-6 truncate ${group.key === 'cancelled' ? 'line-through' : ''}`}>
              {toTitleCase(res.customer_name)}
            </p>
          </div>

          {/* Row 3: Actions */}
          {canEdit && (
            <div className="flex items-center gap-2.5 mt-1.5">
              {(() => {
                const state = getReservationState(res);
                const meta = RESERVATION_STATE_META[state];
                return (
                  <button type="button" onClick={(e) => { e.stopPropagation(); setStateChangeReservation(res); }}
                    className={`inline-flex items-center gap-1.5 px-2.5 h-6 rounded-lg text-xs font-medium border transition-colors ${meta.chipClass}`}
                    title="Cambia stato">
                    {meta.label}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                );
              })()}
              {(res.reservation_status === ReservationStatus.PENDING) && (
                <button type="button" onClick={(e) => { e.stopPropagation(); handleSetReservationState(res, 'waiting'); }}
                  className="inline-flex items-center gap-1 px-2.5 h-6 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                  title="Conferma prenotazione">
                  <Check className="h-3.5 w-3.5" /> Conferma
                </button>
              )}
              {arrivalStatus === ArrivalStatus.ARRIVED && !res.table_id && (
                <button type="button" onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
                  className="inline-flex items-center gap-1 px-2.5 h-6 rounded-lg text-xs font-medium bg-[var(--color-surface-3)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors">
                  <MapPin className="h-3.5 w-3.5" /> Tavolo
                </button>
              )}
              <button type="button" onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
                className="inline-flex items-center justify-center min-w-[2rem] min-h-[2rem] rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors" aria-label="Modifica">
                <Edit2 className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={(e) => { e.stopPropagation(); handleDeleteClick(res.id, res.customer_name); }}
                className="inline-flex items-center justify-center min-w-[2rem] min-h-[2rem] rounded-md text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-400 dark:hover:bg-rose-900/50 transition-colors" aria-label="Annulla">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Covers count */}
        <div className="flex items-start pt-2 pr-3 flex-shrink-0">
          <div className="flex items-center gap-1 text-[var(--color-fg-muted)]">
            <Users className="h-3.5 w-3.5" />
            <span className="text-base font-medium tabular">{res.guests}</span>
            {res.children && res.children > 0 ? (
                <span className="text-[10px] opacity-75">({res.children}b)</span>
            ) : null}
          </div>
        </div>

        {/* Table strip — full height */}
        <div className={`w-16 flex-shrink-0 flex flex-col items-center justify-center my-2 mr-2 rounded-md ${
          table
            ? group.key === 'freed' ? 'bg-slate-100 dark:bg-slate-500/15'
              : group.key === 'arrived' ? 'bg-emerald-50 dark:bg-emerald-500/15'
              : group.key === 'noshow' || group.key === 'cancelled' ? 'bg-rose-50 dark:bg-rose-500/15'
              : 'bg-[#dbeafe] dark:bg-blue-500/15'
            : 'bg-[var(--color-surface-3)]'
        }`}>
          {table ? (
            <>
              <span className={`text-base font-bold leading-6 ${
                group.key === 'freed' ? 'text-slate-500 dark:text-slate-300'
                  : group.key === 'arrived' ? 'text-emerald-700 dark:text-emerald-300'
                  : group.key === 'noshow' ? 'text-rose-700 dark:text-rose-300'
                  : 'text-[#193cb8] dark:text-blue-300'
              }`}>{table.name}</span>
              {tableRoom && <span className="text-xs text-[#4d4d4d] dark:text-[var(--color-fg-muted)] text-center leading-4">{tableRoom.name}</span>}
            </>
          ) : (
            <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
          )}
        </div>
      </div>
    );
  };

  // --- Detail drawer content ---
  const renderDetailDrawer = (res: Reservation) => {
    const table = displayTables.find(t => t.id === res.table_id);
    const tableRoomName = table ? rooms.find(r => r.id === table.room_id)?.name : null;
    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
    const hasAllergens = res.notes && /intolleranze:/i.test(res.notes);
    const allergenText = hasAllergens ? res.notes!.match(/intolleranze:\s*([^|]*)/i)?.[1]?.trim() : null;
    const noteText = res.notes ? res.notes.replace(/intolleranze:.*$/im, '').trim() : '';

    return (
      <div className="bg-[var(--color-surface)] border-t border-[var(--color-line)] shadow-[0_-4px_12px_rgba(0,0,0,0.08)] rounded-t-xl overflow-hidden animate-in slide-in-from-bottom-4 duration-200">
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
        </div>

        <div className="px-4 pb-4 space-y-3 max-h-[50vh] lg:max-h-none overflow-y-auto">
          {/* Header */}
          <div className="flex items-start justify-between">
            <div>
              <h3 className="text-base font-semibold text-[var(--color-fg)]">{toTitleCase(res.customer_name)}</h3>
              <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {res.guests} {res.guests === 1 ? 'ospite' : 'ospiti'}{res.children && res.children > 0 ? ` (${res.children} bambin${res.children === 1 ? 'o' : 'i'})` : ''}</span>
                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(res.reservation_time)}</span>
                {table && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" /> T.{table.name}{tableRoomName ? ` · ${tableRoomName}` : ''}</span>}
              </div>
            </div>
            <button type="button" onClick={closeDetailDrawer} className="p-1 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors">
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Info badges */}
          <div className="flex flex-wrap gap-1.5">
            {res.payment_status !== PaymentStatus.PENDING && (
              <span className={`inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-medium border ${getStatusColor(res.payment_status)}`}>
                <CreditCard className="h-2.5 w-2.5" />
                {res.payment_status === PaymentStatus.PAID_FULL ? 'Saldato' : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'Acconto' : 'Rimborsato'}
              </span>
            )}
            {menu && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 dark:bg-[#4f46e5]/15 dark:border-[#4f46e5]/30 dark:text-[#a5b4fc] text-[10px] font-medium">
                <BookOpen className="h-2.5 w-2.5" /> {menu.name}
              </span>
            )}
            {allergenText && (
              <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-rose-50 border border-rose-100 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 text-[10px] font-medium">
                <AlertTriangle className="h-2.5 w-2.5" /> {allergenText}
              </span>
            )}
          </div>

          {/* Contact info */}
          {(res.phone || res.email) && (
            <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
              {res.phone && <span className="flex items-center gap-1"><MessageCircle className="h-3 w-3" /> {res.phone}</span>}
              {res.email && <span className="flex items-center gap-1 truncate"><Mail className="h-3 w-3 flex-shrink-0" /> {res.email}</span>}
            </div>
          )}

          {/* Notes */}
          {noteText && (
            <div className="text-xs text-[var(--color-fg-muted)] bg-[var(--color-surface-2)] rounded-md px-3 py-2">
              <StickyNote className="h-3 w-3 inline mr-1" />{noteText}
            </div>
          )}

          {/* Actions */}
          {canEdit && (
            <div className="flex items-center gap-2.5 pt-1 flex-wrap">
              {(() => {
                const state = getReservationState(res);
                const meta = RESERVATION_STATE_META[state];
                return (
                  <button onClick={() => setStateChangeReservation(res)}
                    className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium border transition-colors ${meta.chipClass}`}
                    title="Cambia stato">
                    Stato: {meta.label}
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </button>
                );
              })()}
              {arrivalStatus === ArrivalStatus.ARRIVED && !res.table_id && (
                <button onClick={() => { handleEditClick(res); closeDetailDrawer(); }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-500/15 dark:text-slate-300 dark:hover:bg-slate-500/25 transition-colors">
                  <MapPin className="h-3.5 w-3.5" /> Assegna tavolo
                </button>
              )}
              <button onClick={() => { handleEditClick(res); closeDetailDrawer(); }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors">
                <Edit2 className="h-3.5 w-3.5" /> Modifica
              </button>
              <button onClick={() => { handleDeleteClick(res.id, res.customer_name); closeDetailDrawer(); }}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-400 dark:hover:bg-rose-900/50 transition-colors">
                <Trash2 className="h-3.5 w-3.5" /> Annulla
              </button>
            </div>
          )}
        </div>
      </div>
    );
  };

  // --- Desktop header controls (date/shift moved to App header) ---
  const renderHeaderControls = () => null;

  // --- Grouped list panel (shared between desktop left column and mobile list view) ---
  const renderGroupedList = () => (
    <>
      {/* Search + filter + sort row */}
      <div className="px-3 pt-3 pb-2 flex items-center gap-1.5">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-subtle)] h-3.5 w-3.5" />
          <input type="text" placeholder="Cerca per nome o tavolo..." className="w-full h-9 pl-9 pr-9 rounded-full border border-[var(--color-line-strong)] focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface-2)] dark:bg-white/[0.04] text-sm"
            value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          {searchTerm && (
            <button type="button" onClick={() => setSearchTerm('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] rounded-full transition-colors" aria-label="Cancella ricerca">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Sort — opens modal */}
        <button type="button" onClick={() => setShowSortModal(true)}
          className="h-9 w-9 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
          aria-label="Ordina">
          <ArrowUpDown className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
        </button>

        {/* Filter — opens modal */}
        <button type="button" onClick={() => setShowFiltersPanel(true)}
          className={`relative h-9 w-9 rounded-full border transition-colors flex items-center justify-center flex-shrink-0 ${
            activeFilterCount > 0
              ? 'bg-[var(--color-fg)] border-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
              : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
          }`}>
          <Filter className="h-3.5 w-3.5" />
          {activeFilterCount > 0 && (
            <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] px-0.5 rounded-full bg-rose-500 text-[#ffffff] text-[9px] font-bold">
              {activeFilterCount}
            </span>
          )}
        </button>

        {/* Print — desktop only (next to search/filter/sort) */}
        <button type="button" onClick={() => setIsPrintModalOpen(true)}
          className="hidden lg:flex h-9 w-9 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors items-center justify-center flex-shrink-0"
          aria-label="Stampa">
          <Printer className="h-4 w-4" />
        </button>
      </div>

      {/* Grouped reservation list */}
      {totalGroupedCount === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-center py-16 px-4">
          <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-surface-3)] mb-3">
            {selectedShift === Shift.LUNCH ? <Sun className="h-5 w-5 text-[var(--color-fg-muted)]" /> : <Sunset className="h-5 w-5 text-[var(--color-fg-muted)]" />}
          </div>
          <h3 className="text-sm font-semibold text-[var(--color-fg)]">Nessuna prenotazione per questo servizio</h3>
          <p className="text-xs text-[var(--color-fg-muted)] mt-1">
            Non ci sono prenotazioni per il turno di {selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} in questa data.
          </p>
          {canEdit && (
            <button onClick={handleOpenNew}
              className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-xs font-medium hover:opacity-90 transition-opacity">
              <Plus className="h-3.5 w-3.5" /> Nuova prenotazione
            </button>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {groupedReservations.map(group => (
            <div key={group.key}>
              {/* Group header */}
              <button type="button" onClick={() => toggleGroup(group.key)}
                className="w-full flex items-center gap-2.5 px-3 py-3 bg-[var(--color-surface-3)] border-b border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] transition-colors sticky top-0 z-10">
                <div className={`w-2.5 h-2.5 rounded-full ${group.dotClass}`} />
                <span className="text-sm font-semibold text-[var(--color-fg)]">{group.label}</span>
                <span className="text-xs text-[var(--color-fg-muted)] font-medium">
                  {group.items.length} {group.items.length === 1 ? 'prenotazione' : 'prenotazioni'} · {group.items.reduce((s, r) => s + (r.guests || 0), 0)} coperti
                  {(() => {
                    const totalChildren = group.items.reduce((s, r) => s + (r.children || 0), 0);
                    return totalChildren > 0 ? ` (${totalChildren} bambin${totalChildren === 1 ? 'o' : 'i'})` : '';
                  })()}
                </span>
                <ChevronDown className={`h-4 w-4 text-[var(--color-fg-subtle)] ml-auto transition-transform ${expandedGroups.has(group.key) ? '' : '-rotate-90'}`} />
              </button>
              {/* Group items */}
              {expandedGroups.has(group.key) && (
                <div>
                  {group.items.map(res => renderReservationRow(res, group))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Sort modal — slides up within list column on desktop */}
      {showSortModal && (
        <div className="absolute inset-0 z-50 flex items-end" onClick={() => setShowSortModal(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative w-full bg-[var(--color-surface)] rounded-t-2xl shadow-[var(--shadow-overlay)] pb-6 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
            </div>
            <div className="px-5 pb-2">
              <h3 className="text-base font-semibold text-[var(--color-fg)]">Ordina per</h3>
            </div>
            <div className="px-3">
              {[
                { value: 'time-asc' as const, label: 'Orario (prima → dopo)' },
                { value: 'time-desc' as const, label: 'Orario (dopo → prima)' },
                { value: 'name-asc' as const, label: 'Nome A → Z' },
                { value: 'name-desc' as const, label: 'Nome Z → A' },
                { value: 'guests-asc' as const, label: 'Coperti (meno → più)' },
                { value: 'guests-desc' as const, label: 'Coperti (più → meno)' },
              ].map(opt => (
                <button key={opt.value} type="button"
                  onClick={() => { setSortBy(opt.value); setShowSortModal(false); }}
                  className={`w-full flex items-center justify-between px-4 py-2.5 text-sm rounded-lg transition-colors ${
                    sortBy === opt.value ? 'bg-[var(--color-surface-3)] font-medium text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                  }`}>
                  {opt.label}
                  {sortBy === opt.value && <Check className="h-4 w-4 text-[var(--color-fg)]" />}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Filter modal — slides up within list column on desktop */}
      {showFiltersPanel && (
        <div className="absolute inset-0 z-50 flex items-end" onClick={() => setShowFiltersPanel(false)}>
          <div className="absolute inset-0 bg-black/30" />
          <div className="relative w-full bg-[var(--color-surface)] rounded-t-2xl shadow-[var(--shadow-overlay)] pb-6 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
            <div className="flex justify-center pt-3 pb-2">
              <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
            </div>
            <div className="px-5 pb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold text-[var(--color-fg)]">Filtri</h3>
              {activeFilterCount > 0 && (
                <button type="button" onClick={resetFilters} className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                  <RotateCcw className="h-3.5 w-3.5" /> Reimposta
                </button>
              )}
            </div>
            <div className="px-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-[var(--color-fg)] mb-2 block">Stato pagamento</label>
                <div className="flex flex-wrap gap-2">
                  {[
                    { value: 'ALL', label: 'Tutti' },
                    { value: PaymentStatus.PENDING, label: 'Sospeso' },
                    { value: PaymentStatus.PAID_DEPOSIT, label: 'Acconto' },
                    { value: PaymentStatus.PAID_FULL, label: 'Saldato' },
                  ].map(opt => (
                    <button key={opt.value} type="button" onClick={() => setFilterStatus(opt.value)}
                      className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                        filterStatus === opt.value
                          ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
                      }`}>{opt.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-[var(--color-fg)] mb-2 block">Altro</label>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => setFilterHasAllergens(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasAllergens ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                    Allergeni
                  </button>
                  <button type="button" onClick={() => setFilterHasNotes(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasNotes ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                    Con note
                  </button>
                  <button type="button" onClick={() => setFilterNoTable(v => !v)}
                    className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterNoTable ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                    Senza tavolo
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );

  // --- Map panel (shared between desktop right column and mobile map view) ---
  const renderMapPanel = () => {
    const tablesInRoom = displayTables
      .filter(t => t.room_id === activeMapRoomId)
      .filter(t => !displayTables.some(other =>
        other.merged_with && other.merged_with.length > 0 &&
        other.merged_with.map(id => Number(id)).includes(Number(t.id))
      ))
      .filter(t => showHidden || !hiddenTableIds.has(t.id));

    const occupiedTablesCount = tablesInRoom.filter(t => getOccupierForTable(t.id)).length;
    const totalTablesInRoom = tablesInRoom.length;
    const occupancyPercentage = totalTablesInRoom > 0 ? Math.round((occupiedTablesCount / totalTablesInRoom) * 100) : 0;

    const reservationsForDayShift = reservations.filter(r => {
      const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
      const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
      return matchesDate && matchesShift;
    });
    const totalGuestsForDayShift = reservationsForDayShift.reduce((sum, r) => sum + (Number(r.guests) || 0), 0);
    const reservationCountForDayShift = reservationsForDayShift.length;
    const unassignedCountForDayShift = reservationsForDayShift.filter(r => !r.table_id).length;

    const PADDING = 40;
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
    const baseSize = isMobile ? 45 : 80;
    const baseWidth = isMobile ? 60 : 100;
    const seatMultiplier = isMobile ? 8 : 15;
    let maxRight = 0;
    let maxBottom = 0;
    for (const t of tablesInRoom) {
      let w: number, h: number;
      if (t.shape === TableShape.CIRCLE || t.shape === TableShape.SQUARE) { w = baseSize; h = baseSize; }
      else { w = Math.max(baseWidth, t.seats * seatMultiplier); h = baseSize; }
      maxRight = Math.max(maxRight, t.x + w);
      maxBottom = Math.max(maxBottom, t.y + h);
    }
    const extentWidth = (tablesInRoom.length === 0 ? 800 : maxRight) + PADDING;
    const extentHeight = (tablesInRoom.length === 0 ? 600 : maxBottom) + PADDING;
    const scale = (!isMobile && mapCanvasSize.width > 0 && mapCanvasSize.height > 0)
      ? Math.min(mapCanvasSize.width / extentWidth, mapCanvasSize.height / extentHeight, 1)
      : 1;

    return (
      <div className="flex flex-col h-full">
        {/* Room tabs + stats */}
        <div className="flex items-center gap-3 px-3 py-2 border-b border-[var(--color-line)]">
          <div className="flex gap-2 overflow-x-auto scrollbar-hide flex-1 min-w-0">
            {rooms.filter(r => !r.is_closed).map(room => (
              <button key={room.id} onClick={() => setActiveMapRoomId(room.id)}
                className={`px-4 py-1.5 text-sm font-medium rounded-full transition-colors whitespace-nowrap flex-shrink-0 border ${
                  activeMapRoomId === room.id
                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                }`}>
                {room.name}
              </button>
            ))}
          </div>
          {hiddenTableIds.size > 0 && (
            <>
              <button type="button" onClick={() => setShowHidden(v => !v)}
                className={`flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors border ${
                  showHidden
                    ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                }`}
                title={showHidden ? 'Nascondi tavoli disabilitati' : 'Mostra tavoli nascosti per questo turno'}>
                {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
                <span>{hiddenTableIds.size} {hiddenTableIds.size === 1 ? 'nascosto' : 'nascosti'}</span>
              </button>
              {canEdit && (
                <button type="button" onClick={() => setUnhideAllConfirm(true)}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/15 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/25 transition-colors"
                  title="Riattiva tutti i tavoli nascosti per questo turno">
                  <RotateCcw size={14} />
                  <span>Riattiva tutti</span>
                </button>
              )}
            </>
          )}
          <div className="hidden md:flex items-center gap-3 text-xs flex-shrink-0">
            <div className="flex items-center gap-1.5">
              <Users size={14} className="text-[var(--color-fg-muted)] flex-shrink-0" />
              <span className="font-semibold text-[var(--color-fg)]">{totalGuestsForDayShift}</span>
              <span className="text-[var(--color-fg-muted)]">coperti</span>
            </div>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <div className="flex items-center gap-1.5">
              <span className="font-medium text-[var(--color-fg)]">{reservationCountForDayShift}</span>
              <span className="text-[var(--color-fg-muted)]">{reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}</span>
            </div>
            {unassignedCountForDayShift > 0 && (
              <button type="button" onClick={() => setShowUnassignedModal(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-800 font-medium rounded-full hover:bg-amber-100 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/25 transition-colors"
                title="Tocca per vedere le prenotazioni senza tavolo">
                <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <span className="text-sm font-semibold">{unassignedCountForDayShift}</span>
                <span className="text-xs">senza tavolo</span>
                <ChevronRight size={12} className="text-amber-600 flex-shrink-0" />
              </button>
            )}
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <div className="flex items-center gap-1.5 text-[var(--color-fg-muted)]">
              <span className="font-medium text-[var(--color-fg)]">{occupiedTablesCount}</span>
              <span>/{totalTablesInRoom} tavoli ({occupancyPercentage}%)</span>
            </div>
          </div>
        </div>

        {/* Mobile stats */}
        <div className="md:hidden px-3 py-2 bg-[var(--color-surface-3)] border-b border-[var(--color-line)] grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div className="flex items-center gap-1.5">
            <Users size={14} className="text-[var(--color-fg-muted)] flex-shrink-0" />
            <span className="font-semibold text-[var(--color-fg)]">{totalGuestsForDayShift}</span>
            <span className="text-[var(--color-fg-muted)]">coperti</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-[var(--color-fg)]">{reservationCountForDayShift}</span>
            <span className="text-[var(--color-fg-muted)]">{reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}</span>
          </div>
          {unassignedCountForDayShift > 0 && (
            <button type="button" onClick={() => setShowUnassignedModal(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 border border-amber-200 text-amber-800 font-medium rounded-full hover:bg-amber-100 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/25 transition-colors w-fit">
              <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <span className="text-sm font-semibold">{unassignedCountForDayShift}</span>
              <span className="text-xs">senza tavolo</span>
            </button>
          )}
          <div className="flex items-center gap-1.5 text-[var(--color-fg-muted)] justify-self-end">
            <span className="font-medium text-[var(--color-fg)]">{occupiedTablesCount}</span>
            <span>/{totalTablesInRoom} tavoli ({occupancyPercentage}%)</span>
          </div>
        </div>

        {/* Map canvas */}
        {isPhone ? (
          <div className="flex-1 overflow-y-auto rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] relative m-3">
            {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-[var(--color-surface)]/70 backdrop-blur-[1px] flex items-center justify-center">
                <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] rounded-md shadow-[var(--shadow-xs)] border border-[var(--color-line)]">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
                  <span className="text-sm text-[var(--color-fg-muted)]">Caricamento tavoli…</span>
                </div>
              </div>
            )}
            {tablesInRoom.length === 0 ? (
              <div className="text-center py-10 px-4 text-sm text-[var(--color-fg-muted)]">
                Nessun tavolo in questa sala.
              </div>
            ) : (
              <ul className="divide-y divide-[var(--color-line)]">
                {[...tablesInRoom]
                  .sort((a, b) => {
                    const oa = getOccupierForTable(a.id);
                    const ob = getOccupierForTable(b.id);
                    if (!!oa !== !!ob) return oa ? -1 : 1;
                    const ra = oa?.kind === 'reservation' ? oa.data : null;
                    const rb = ob?.kind === 'reservation' ? ob.data : null;
                    if (ra && rb) return ra.reservation_time.localeCompare(rb.reservation_time);
                    if (ra && !rb) return -1;
                    if (!ra && rb) return 1;
                    return a.name.localeCompare(b.name, 'it', { numeric: true });
                  })
                  .map(table => {
                    const occupier = getOccupierForTable(table.id);
                    const reservation = occupier?.kind === 'reservation' ? occupier.data : null;
                    const banquet = occupier?.kind === 'banquet' ? occupier.data : null;
                    const isOccupied = !!occupier;
                    const isArrived = !!reservation && reservation.arrival_status === ArrivalStatus.ARRIVED;
                    const trimmedSearch = searchTerm.trim().toLowerCase();
                    const isSearchMatch = !!(trimmedSearch && (
                      (reservation && reservation.customer_name.toLowerCase().includes(trimmedSearch)) ||
                      (banquet && banquet.name.toLowerCase().includes(trimmedSearch)) ||
                      table.name.toLowerCase().includes(trimmedSearch)
                    ));
                    const mergedNames = (table.merged_with && table.merged_with.length > 0)
                      ? table.merged_with.map(id => tables.find(t => Number(t.id) === Number(id))?.name).filter((n): n is string => !!n)
                      : [];
                    const displayName = mergedNames.length > 0 ? `${table.name}+${mergedNames.join('+')}` : table.name;
                    const isMerged = mergedNames.length > 0;
                    return (
                      <li key={table.id}>
                        <button
                          onClick={() => {
                            if (reservation) handleEditClick(reservation);
                            else if (banquet) { /* not assignable */ }
                            else if (canEdit) setAssignTableModal(table);
                          }}
                          className={`w-full text-left px-3 py-3 flex items-center gap-3 transition-colors ${
                            isSearchMatch ? 'bg-[var(--color-surface-3)]' : 'hover:bg-[var(--color-surface-hover)]'
                          }`}>
                          <div className={`min-w-[4.5rem] h-16 px-2 rounded-md flex items-center justify-center flex-shrink-0 border font-semibold ${isMerged ? 'text-base' : 'text-xl'} ${
                            isArrived ? 'bg-orange-50 border-orange-300 text-orange-700 dark:bg-orange-500/15 dark:border-orange-500/40 dark:text-orange-300'
                              : reservation ? 'bg-rose-50 border-rose-300 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/40 dark:text-rose-300'
                              : banquet ? 'bg-indigo-50 border-indigo-300 text-indigo-700 dark:bg-[#4f46e5]/20 dark:border-[#4f46e5]/50 dark:text-[#a5b4fc]'
                              : 'bg-[var(--color-surface)] border-emerald-300 text-emerald-700 dark:border-emerald-500/40 dark:text-emerald-300'
                          }`}>
                            <span className="text-center leading-tight break-all">{displayName}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            {reservation ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-[var(--color-fg)] truncate">{toTitleCase(reservation.customer_name)}</span>
                                  {isArrived && <span className="text-[10px] font-medium bg-orange-50 text-orange-700 border border-orange-100 px-1.5 py-0.5 rounded-full flex-shrink-0 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30">Arrivato</span>}
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                                  <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(reservation.reservation_time)}</span>
                                  <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {reservation.guests}{reservation.children && reservation.children > 0 ? ` (${reservation.children}b)` : ''}</span>
                                  <span className="flex items-center gap-1 text-[var(--color-fg-subtle)]"><Armchair className="h-3 w-3" /> {table.seats}</span>
                                </div>
                              </>
                            ) : banquet ? (
                              <>
                                <div className="flex items-center gap-2">
                                  <BookOpen className="h-3.5 w-3.5 text-indigo-600 flex-shrink-0" />
                                  <span className="font-medium text-indigo-700 truncate">{banquet.name}</span>
                                  <span className="text-[10px] font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 px-1.5 py-0.5 rounded-full flex-shrink-0">Banchetto</span>
                                </div>
                                <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                                  {typeof banquet.guests === 'number' && <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {banquet.guests}</span>}
                                  <span className="flex items-center gap-1 text-[var(--color-fg-subtle)]"><Armchair className="h-3 w-3" /> {table.seats}</span>
                                </div>
                              </>
                            ) : (
                              <>
                                <div className="font-medium text-emerald-700 dark:text-emerald-400">Libero</div>
                                <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                                  <span className="flex items-center gap-1"><Armchair className="h-3 w-3" /> {table.seats} posti</span>
                                  {canEdit && <span className="text-[var(--color-fg)] font-medium">Tocca per assegnare</span>}
                                </div>
                              </>
                            )}
                          </div>
                          <ChevronRight className="h-4 w-4 text-[var(--color-fg-subtle)] flex-shrink-0" />
                        </button>
                      </li>
                    );
                  })}
              </ul>
            )}
          </div>
        ) : (
          <div ref={setMapCanvasNode}
            className="flex-1 bg-[var(--color-surface-2)] rounded-lg border border-dashed border-[var(--color-line)] relative overflow-auto md:overflow-hidden m-3"
            style={{ backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)', backgroundSize: window.innerWidth < 768 ? '15px 15px' : '20px 20px' }}>
            {isLoadingMerges && (
              <div className="absolute inset-0 z-30 bg-[var(--color-surface-2)]/70 backdrop-blur-[1px] flex items-center justify-center">
                <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] rounded-md shadow-[var(--shadow-xs)] border border-[var(--color-line)]">
                  <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
                  <span className="text-sm text-[var(--color-fg-muted)]">Caricamento tavoli…</span>
                </div>
              </div>
            )}
            <div style={{ width: extentWidth, height: extentHeight, transform: `scale(${scale})`, transformOrigin: 'top left', position: 'relative' }}>
              {tablesInRoom.map(renderMapTable)}
            </div>

            {/* Legend */}
            <div className="absolute bottom-4 right-4 z-10 select-none">
              <button type="button" onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface)]/95 backdrop-blur rounded-full shadow-[var(--shadow-xs)] border border-[var(--color-line)] text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface)] transition-colors"
                aria-expanded={isLegendOpen}>
                <Info size={14} className="text-[var(--color-fg-muted)]" /> Legenda
              </button>
              {isLegendOpen && (
                <div className="absolute bottom-full right-0 mb-2 w-56 bg-[var(--color-surface)]/95 backdrop-blur p-3 rounded-lg shadow-[var(--shadow-overlay)] border border-[var(--color-line)] text-xs space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150"
                  onClick={(e) => e.stopPropagation()}>
                  <div className="text-sm font-semibold text-[var(--color-fg)] mb-1">Legenda Stato</div>
                  <div className="flex items-center gap-2 text-[var(--color-fg-muted)]"><div className="w-3 h-3 bg-[var(--color-surface)] border border-emerald-300 rounded-sm"></div> Libero</div>
                  <div className="flex items-center gap-2 text-[var(--color-fg-muted)]"><div className="w-3 h-3 bg-rose-50 border border-rose-300 dark:bg-rose-500/15 dark:border-rose-500/40 rounded-sm"></div> Occupato</div>
                  <div className="flex items-center gap-2 text-[var(--color-fg-muted)]"><div className="w-3 h-3 bg-orange-50 border border-orange-300 dark:bg-orange-500/15 dark:border-orange-500/40 rounded-sm"></div> Arrivato</div>
                  <div className="flex items-center gap-2 text-[var(--color-fg-muted)]"><div className="w-3 h-3 bg-indigo-50 border border-indigo-300 dark:bg-[#4f46e5]/20 dark:border-[#4f46e5]/50 rounded-sm"></div> Banchetto</div>
                  <div className="border-t border-[var(--color-line)] mt-1 pt-2">
                    <div className="text-sm font-semibold text-[var(--color-fg)]">Occupazione</div>
                    <div className="text-sm text-[var(--color-fg)]"><span className="font-semibold">{occupiedTablesCount}</span> / {totalTablesInRoom} tavoli (<span className="font-semibold">{occupancyPercentage}%</span>)</div>
                  </div>
                  <div className="border-t border-[var(--color-line)] mt-1 pt-2">
                    <div className="text-sm font-semibold text-[var(--color-fg)]">Coperti</div>
                    <div className="text-sm text-[var(--color-fg)]"><span className="font-semibold">{totalGuestsForDayShift}</span> in <span className="font-semibold">{reservationCountForDayShift}</span> {reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={modalOnly ? 'contents' : 'h-[calc(100vh-56px)] flex flex-col'}>
      {!modalOnly && (
      <React.Fragment>

      {/* ===== DESKTOP: Two-column split view (>= 1024px) ===== */}
      {isDesktop ? (
        <div className="flex flex-col h-full">
          {/* Split view */}
          <div className="flex flex-1 min-h-0">
            {/* Left column — Reservation list (25%) */}
            <div className="w-[25%] min-w-[280px] border-r border-[var(--color-line)] bg-[var(--color-surface)] flex flex-col relative overflow-hidden">
              {renderGroupedList()}
            </div>

            {/* Right column — Floor map (75%) */}
            <div className="flex-1 min-w-0 bg-[var(--color-surface)]">
              {renderMapPanel()}
            </div>
          </div>
        </div>
      ) : (
        /* ===== MOBILE / TABLET: List only (< 1024px) ===== */
        <div className="flex flex-col h-full">
          {/* Row 1: Date - Shift */}
          <div className="px-4 pt-2.5 pb-2 border-b border-[var(--color-line)] bg-[var(--color-surface)]">
            <div className="flex items-start gap-2">
              <DateNavigator
                value={selectedDateStr}
                onChange={(dateOnly) => {
                  const time = selectedDate.split('T')[1] || '12:00';
                  setSelectedDate(`${dateOnly}T${time}`);
                }}
                className="flex-1 min-w-0"
              />

              {/* Shift toggle — icon only; top-aligned so it tracks the date pill,
                  not the chip below. */}
              <div className="flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5 flex-shrink-0 w-[108px] h-10">
                <button onClick={() => setSelectedShift(Shift.LUNCH)}
                  className={`inline-flex items-center justify-center flex-1 h-8 rounded-full transition-colors ${
                    selectedShift === Shift.LUNCH ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
                  }`} aria-label="Pranzo">
                  <Sun className="h-4 w-4" />
                </button>
                <button onClick={() => setSelectedShift(Shift.DINNER)}
                  className={`inline-flex items-center justify-center flex-1 h-8 rounded-full transition-colors ${
                    selectedShift === Shift.DINNER ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)]'
                  }`} aria-label="Cena">
                  <Sunset className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>

          {/* Content: Card-based list */}
          <div className="flex-1 min-h-0 overflow-y-auto">
            {/* Search + filter + sort row */}
            <div className="px-4 pt-3 pb-2 flex items-center gap-1.5">
              <div className="relative flex-1 min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-fg-subtle)] h-3.5 w-3.5" />
                <input type="text" placeholder="Cerca..." className="w-full h-9 pl-9 pr-9 rounded-full border border-[var(--color-line-strong)] focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface-2)] dark:bg-white/[0.04] text-sm"
                  value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
                {searchTerm && (
                  <button type="button" onClick={() => setSearchTerm('')}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)] rounded-full transition-colors" aria-label="Cancella ricerca">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {/* Sort — opens modal */}
              <button type="button" onClick={() => setShowSortModal(true)}
                className="h-9 w-9 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
                aria-label="Ordina">
                <ArrowUpDown className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
              </button>

              {/* Filter — opens modal */}
              <button type="button" onClick={() => setShowFiltersPanel(true)}
                className={`relative h-9 w-9 rounded-full border transition-colors flex items-center justify-center flex-shrink-0 ${
                  activeFilterCount > 0
                    ? 'bg-[var(--color-fg)] border-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                    : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                }`}>
                <Filter className="h-3.5 w-3.5" />
                {activeFilterCount > 0 && (
                  <span className="absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[16px] h-[16px] px-0.5 rounded-full bg-rose-500 text-[#ffffff] text-[9px] font-bold">
                    {activeFilterCount}
                  </span>
                )}
              </button>

              {/* Print */}
              <button type="button" onClick={() => setIsPrintModalOpen(true)}
                className="h-9 w-9 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
                aria-label="Stampa">
                <Printer className="h-3.5 w-3.5" />
              </button>
            </div>

            {totalGroupedCount === 0 ? (
              <div className="flex flex-col items-center justify-center text-center py-16 px-4">
                <div className="inline-flex items-center justify-center w-10 h-10 rounded-full bg-[var(--color-surface-3)] mb-3">
                  {selectedShift === Shift.LUNCH ? <Sun className="h-5 w-5 text-[var(--color-fg-muted)]" /> : <Sunset className="h-5 w-5 text-[var(--color-fg-muted)]" />}
                </div>
                <h3 className="text-sm font-semibold text-[var(--color-fg)]">Nessuna prenotazione per questo servizio</h3>
                <p className="text-xs text-[var(--color-fg-muted)] mt-1">Non ci sono prenotazioni per il turno di {selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'}.</p>
                {canEdit && (
                  <button onClick={handleOpenNew}
                    className="mt-3 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-xs font-medium hover:opacity-90 transition-opacity">
                    <Plus className="h-3.5 w-3.5" /> Nuova prenotazione
                  </button>
                )}
              </div>
            ) : (
              <div className="px-4 pb-4 space-y-2">
                {groupedReservations.map(group => {
                  const groupCovers = group.items.reduce((s, r) => s + (r.guests || 0), 0);
                  return (
                    <div key={group.key}>
                      {/* Group header */}
                      <button type="button" onClick={() => toggleGroup(group.key)}
                        className="w-full flex items-center gap-2.5 px-1 py-3 transition-colors">
                        <div className={`w-2.5 h-2.5 rounded-full ${group.dotClass}`} />
                        <span className="text-sm font-semibold text-[var(--color-fg)]">{group.label}</span>
                        <span className="text-xs text-[var(--color-fg-muted)]">{group.items.length} · {groupCovers} coperti</span>
                        <ChevronDown className={`h-4 w-4 text-[var(--color-fg-subtle)] ml-auto transition-transform ${expandedGroups.has(group.key) ? '' : '-rotate-90'}`} />
                      </button>

                      {/* Cards */}
                      {expandedGroups.has(group.key) && (
                        <div className="space-y-2">
                          {group.items.map(res => {
                            const table = displayTables.find(t => t.id === res.table_id);
                            const tableRoom = table ? rooms.find(r => r.id === table.room_id) : null;
                            const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
                            const hasAllergens = res.notes && /intolleranze:/i.test(res.notes);
                            const allergenText = hasAllergens ? res.notes!.match(/intolleranze:\s*([^|]*)/i)?.[1]?.trim() : null;
                            const noteText = res.notes ? res.notes.replace(/intolleranze:.*$/im, '').trim() : '';
                            const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);

                            const circleColor = group.key === 'freed' ? 'bg-slate-400'
                              : group.key === 'arrived' ? 'bg-emerald-500'
                              : group.key === 'noshow' || group.key === 'cancelled' ? 'bg-rose-500'
                              : 'bg-blue-500';

                            return (
                              <div key={res.id}
                                className={`bg-[var(--color-surface)] rounded-xl border cursor-pointer ${group.key === 'noshow' || group.key === 'cancelled' ? 'border-rose-200 bg-rose-50/40 dark:border-rose-500/30 dark:bg-rose-500/10' : 'border-[var(--color-line)]'} flex overflow-hidden ${group.key === 'freed' || group.key === 'cancelled' ? 'opacity-60' : ''} ${selectedReservationId === res.id ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
                                onMouseEnter={() => setHoveredReservationId(res.id)}
                                onMouseLeave={() => setHoveredReservationId(null)}
                                onClick={() => handleRowClick(res)}>
                                {/* Left content */}
                                <div className="flex-1 min-w-0 p-3">
                                  {/* Row 1: Time + indicator icons */}
                                  <div className="flex items-center gap-1.5 h-5">
                                    <span className="text-xs text-[var(--color-fg)] tabular">
                                      {formatTime(res.reservation_time)}
                                    </span>
                                    {allergenText && (
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'allergen', text: allergenText, x: e.clientX, y: e.clientY }); }}
                                        className="flex-shrink-0">
                                        <AlertTriangle className="h-3.5 w-3.5 text-rose-500" />
                                      </button>
                                    )}
                                    {noteText && (
                                      <button type="button" onClick={(e) => { e.stopPropagation(); setTooltipReservation({ id: res.id, type: 'note', text: noteText, x: e.clientX, y: e.clientY }); }}
                                        className="flex-shrink-0">
                                        <StickyNote className="h-3.5 w-3.5 text-amber-500" />
                                      </button>
                                    )}
                                    {res.payment_status !== PaymentStatus.PENDING && (
                                      <span className="flex-shrink-0" title={res.payment_status === PaymentStatus.PAID_FULL ? 'Saldato' : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'Acconto' : 'Rimborsato'}>
                                        <CreditCard className="h-3.5 w-3.5 text-emerald-600" />
                                      </span>
                                    )}
                                    {menu && (
                                      <span className="flex-shrink-0" title={menu.name}>
                                        <BookOpen className="h-3.5 w-3.5 text-indigo-500" />
                                      </span>
                                    )}
                                    {group.key === 'noshow' && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0">
                                        <UserX className="h-2.5 w-2.5" /> No show
                                      </span>
                                    )}
                                    {group.key === 'cancelled' && (
                                      <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0">
                                        <Ban className="h-2.5 w-2.5" /> Annullata
                                      </span>
                                    )}
                                  </div>

                                  {/* Row 2: Customer name */}
                                  <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                                    {renderOperatorBadge(res)}
                                    <p className={`text-base font-semibold text-[var(--color-fg)] leading-6 truncate ${group.key === 'cancelled' ? 'line-through' : ''}`}>
                                      {toTitleCase(res.customer_name)}
                                    </p>
                                  </div>

                                  {/* Row 3: Actions */}
                                  {canEdit && (
                                    <div className="flex items-center gap-2.5 mt-2">
                                      {(() => {
                                        const state = getReservationState(res);
                                        const meta = RESERVATION_STATE_META[state];
                                        return (
                                          <button onClick={(e) => { e.stopPropagation(); setStateChangeReservation(res); }}
                                            className={`inline-flex items-center gap-1.5 px-2.5 h-6 rounded-lg text-xs font-medium border transition-colors ${meta.chipClass}`}
                                            title="Cambia stato">
                                            {meta.label}
                                            <ChevronDown className="h-3 w-3 opacity-60" />
                                          </button>
                                        );
                                      })()}
                                      {arrivalStatus === ArrivalStatus.ARRIVED && !res.table_id && (
                                        <button onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
                                          className="inline-flex items-center gap-1 px-2.5 h-6 rounded-lg text-xs font-medium bg-[var(--color-surface-3)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors">
                                          <MapPin className="h-3.5 w-3.5" /> Tavolo
                                        </button>
                                      )}
                                      <button onClick={(e) => { e.stopPropagation(); handleEditClick(res); }}
                                        className="inline-flex items-center justify-center min-w-[2rem] min-h-[2rem] rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] transition-colors" aria-label="Modifica">
                                        <Edit2 className="h-3.5 w-3.5" />
                                      </button>
                                      <button onClick={(e) => { e.stopPropagation(); handleDeleteClick(res.id, res.customer_name); }}
                                        className="inline-flex items-center justify-center min-w-[2rem] min-h-[2rem] rounded-md text-rose-400 hover:bg-rose-50 hover:text-rose-600 dark:text-rose-400 dark:hover:bg-rose-900/50 transition-colors" aria-label="Annulla">
                                        <Trash2 className="h-3.5 w-3.5" />
                                      </button>
                                    </div>
                                  )}
                                </div>

                                {/* Covers count */}
                                <div className="flex items-start pt-3 pr-3 flex-shrink-0">
                                  <div className="flex items-center gap-1 text-[var(--color-fg-muted)]">
                                    <Users className="h-3.5 w-3.5" />
                                    <span className="text-base font-medium tabular">{res.guests}</span>
                                  </div>
                                </div>

                                {/* Table strip */}
                                <div className={`w-16 flex-shrink-0 flex flex-col items-center justify-center my-2 mr-2 rounded-md ${
                                  table
                                    ? group.key === 'freed' ? 'bg-slate-100 dark:bg-slate-500/15'
                                      : group.key === 'arrived' ? 'bg-emerald-50 dark:bg-emerald-500/15'
                                      : 'bg-[#dbeafe] dark:bg-blue-500/15'
                                    : 'bg-[var(--color-surface-3)]'
                                }`}>
                                  {table ? (
                                    <>
                                      <span className={`text-base font-bold leading-6 ${
                                        group.key === 'freed' ? 'text-slate-500 dark:text-slate-300'
                                          : group.key === 'arrived' ? 'text-emerald-700 dark:text-emerald-300'
                                          : 'text-[#193cb8] dark:text-blue-300'
                                      }`}>{table.name}</span>
                                      {tableRoom && <span className="text-xs text-[#4d4d4d] dark:text-[var(--color-fg-muted)] text-center leading-4">{tableRoom.name}</span>}
                                    </>
                                  ) : (
                                    <span className="text-xs text-[var(--color-fg-subtle)]">—</span>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Sort modal — slide up (mobile/tablet) */}
          {showSortModal && (
            <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowSortModal(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="relative w-full bg-[var(--color-surface)] rounded-t-2xl shadow-[var(--shadow-overlay)] pb-8 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-2">
                  <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
                </div>
                <div className="px-5 pb-2">
                  <h3 className="text-base font-semibold text-[var(--color-fg)]">Ordina per</h3>
                </div>
                <div className="px-3">
                  {[
                    { value: 'time-asc' as const, label: 'Orario (prima → dopo)' },
                    { value: 'time-desc' as const, label: 'Orario (dopo → prima)' },
                    { value: 'name-asc' as const, label: 'Nome A → Z' },
                    { value: 'name-desc' as const, label: 'Nome Z → A' },
                    { value: 'guests-asc' as const, label: 'Coperti (meno → più)' },
                    { value: 'guests-desc' as const, label: 'Coperti (più → meno)' },
                  ].map(opt => (
                    <button key={opt.value} type="button"
                      onClick={() => { setSortBy(opt.value); setShowSortModal(false); }}
                      className={`w-full flex items-center justify-between px-4 py-3 text-sm rounded-lg transition-colors ${
                        sortBy === opt.value ? 'bg-[var(--color-surface-3)] font-medium text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                      }`}>
                      {opt.label}
                      {sortBy === opt.value && <Check className="h-4 w-4 text-[var(--color-fg)]" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Filter modal — slide up (mobile/tablet) */}
          {showFiltersPanel && (
            <div className="fixed inset-0 z-50 flex items-end" onClick={() => setShowFiltersPanel(false)}>
              <div className="absolute inset-0 bg-black/30" />
              <div className="relative w-full bg-[var(--color-surface)] rounded-t-2xl shadow-[var(--shadow-overlay)] pb-8 animate-in slide-in-from-bottom duration-200" onClick={e => e.stopPropagation()}>
                <div className="flex justify-center pt-3 pb-2">
                  <div className="w-8 h-1 rounded-full bg-[var(--color-fg-subtle)]" />
                </div>
                <div className="px-5 pb-3 flex items-center justify-between">
                  <h3 className="text-base font-semibold text-[var(--color-fg)]">Filtri</h3>
                  {activeFilterCount > 0 && (
                    <button type="button" onClick={resetFilters} className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]">
                      <RotateCcw className="h-3.5 w-3.5" /> Reimposta
                    </button>
                  )}
                </div>
                <div className="px-5 space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-[var(--color-fg)] mb-2 block">Stato pagamento</label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        { value: 'ALL', label: 'Tutti' },
                        { value: PaymentStatus.PENDING, label: 'Sospeso' },
                        { value: PaymentStatus.PAID_DEPOSIT, label: 'Acconto' },
                        { value: PaymentStatus.PAID_FULL, label: 'Saldato' },
                      ].map(opt => (
                        <button key={opt.value} type="button" onClick={() => setFilterStatus(opt.value)}
                          className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${
                            filterStatus === opt.value
                              ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                              : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'
                          }`}>{opt.label}</button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-[var(--color-fg)] mb-2 block">Altro</label>
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => setFilterHasAllergens(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasAllergens ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                        Allergeni
                      </button>
                      <button type="button" onClick={() => setFilterHasNotes(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterHasNotes ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                        Con note
                      </button>
                      <button type="button" onClick={() => setFilterNoTable(v => !v)}
                        className={`px-3.5 py-2 rounded-full text-xs font-medium border transition-colors ${filterNoTable ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)]'}`}>
                        Senza tavolo
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      </React.Fragment>
      )}
      {/* Reservation Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4" onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }}>
            <div className="bg-[var(--color-surface)] rounded-none sm:rounded-2xl shadow-2xl border border-[var(--color-line)] w-full sm:max-w-5xl overflow-hidden flex flex-col h-full sm:max-h-[90vh]" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
                    <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">{isEditing ? 'Modifica Prenotazione' : 'Nuova Prenotazione'}</h3>
                    <button onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }} className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    {matchedCustomerNoShows > 0 && (
                        <div className="mx-4 sm:mx-6 mt-4 p-3 sm:p-4 bg-rose-50 border border-rose-200 dark:bg-rose-500/10 dark:border-rose-500/30 rounded-xl flex items-start gap-3">
                            <UserX className="h-5 w-5 text-rose-600 dark:text-rose-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-rose-900 dark:text-rose-200">
                                    Attenzione: cliente con {matchedCustomerNoShows} no-show
                                </p>
                                <p className="text-xs text-rose-700 dark:text-rose-300 mt-0.5">
                                    Questo cliente non si è presentato {matchedCustomerNoShows === 1 ? 'una volta' : `${matchedCustomerNoShows} volte`} in passato.
                                </p>
                            </div>
                        </div>
                    )}
                    {!isEditing && draftBanner && (
                        <div className="mx-4 sm:mx-6 mt-4 p-3 sm:p-4 bg-amber-50 border border-amber-200 dark:bg-amber-500/10 dark:border-amber-500/30 rounded-xl flex items-start gap-3">
                            <Info className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                            <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-amber-900 dark:text-amber-200">Bozza non salvata trovata</p>
                                <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                                    Salvata {new Date(draftBanner.savedAt).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}
                                </p>
                            </div>
                            <div className="flex gap-2 flex-shrink-0">
                                <button
                                    type="button"
                                    onClick={handleRestoreDraft}
                                    className="px-3 py-1.5 bg-amber-600 text-[#ffffff] text-xs font-semibold rounded-lg hover:bg-amber-700"
                                >
                                    Riprendi
                                </button>
                                <button
                                    type="button"
                                    onClick={handleDiscardDraft}
                                    className="px-3 py-1.5 bg-white text-amber-700 text-xs font-semibold rounded-lg border border-amber-300 hover:bg-amber-100 dark:bg-[var(--color-surface-3)] dark:text-amber-300 dark:border-amber-500/30 dark:hover:bg-[var(--color-surface-hover)]"
                                >
                                    Scarta
                                </button>
                            </div>
                        </div>
                    )}
                    <form id="reservation-form" onSubmit={handleSubmit} className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">
                        {/* Left Column: Details (5 cols) */}
                        <div className="lg:col-span-5 space-y-5 sm:space-y-6">
                            {/* Guests */}
                            <div>
                                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Numero Ospiti</label>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            const newGuests = Math.max(1, (formData.guests || 2) - 1);
                                            setFormData({...formData, guests: newGuests, children: Math.min(formData.children || 0, newGuests)});
                                        }}
                                        className="w-10 h-10 sm:w-12 sm:h-12 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] font-medium text-lg sm:text-xl hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
                                    >
                                        −
                                    </button>
                                    <input
                                        type="number"
                                        min="1"
                                        required
                                        className="flex-1 min-w-0 rounded-md border border-[var(--color-line)] px-3 py-2 text-center text-lg sm:text-xl font-semibold focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.guests || ''}
                                        onChange={e => {
                                            const newGuests = parseInt(e.target.value) || undefined;
                                            setFormData({...formData, guests: newGuests, children: newGuests != null ? Math.min(formData.children || 0, newGuests) : formData.children});
                                        }}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, guests: (formData.guests || 2) + 1})}
                                        className="w-10 h-10 sm:w-12 sm:h-12 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] font-medium text-lg sm:text-xl hover:opacity-90 transition-opacity flex items-center justify-center flex-shrink-0"
                                    >
                                        +
                                    </button>
                                </div>
                            </div>

                            {/* Children */}
                            <div>
                                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Di cui Bambini</label>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, children: Math.max(0, (formData.children || 0) - 1)})}
                                        className="w-10 h-10 sm:w-12 sm:h-12 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] font-medium text-lg sm:text-xl hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
                                    >
                                        −
                                    </button>
                                    <input
                                        type="number"
                                        min="0"
                                        max={formData.guests || 0}
                                        className="flex-1 min-w-0 rounded-md border border-[var(--color-line)] px-3 py-2 text-center text-lg sm:text-xl font-semibold focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.children ?? 0}
                                        onChange={e => {
                                            const raw = parseInt(e.target.value) || 0;
                                            const clamped = Math.max(0, Math.min(raw, formData.guests || 0));
                                            setFormData({...formData, children: clamped});
                                        }}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, children: Math.min(formData.guests || 0, (formData.children || 0) + 1)})}
                                        className="w-10 h-10 sm:w-12 sm:h-12 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] font-medium text-lg sm:text-xl hover:opacity-90 transition-opacity flex items-center justify-center flex-shrink-0"
                                    >
                                        +
                                    </button>
                                </div>
                            </div>

                            {/* Date & Shift */}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Turno</label>
                                    <div className="flex items-center bg-[var(--color-surface)] rounded-full border border-[var(--color-line)] p-1 gap-0.5">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.LUNCH, reservation_time: `${currentDate}T13:00`});
                                            }}
                                            className={`inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${formData.shift === Shift.LUNCH ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                                        >
                                            <Sun className="h-3.5 w-3.5" /> Pranzo
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.DINNER, reservation_time: `${currentDate}T20:00`});
                                            }}
                                            className={`inline-flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${formData.shift === Shift.DINNER ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                                        >
                                            <Sunset className="h-3.5 w-3.5" /> Cena
                                        </button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="overflow-hidden">
                                        <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Data</label>
                                        <input
                                            type="date"
                                            required
                                            className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer transition-colors"
                                            value={formData.reservation_time?.split('T')[0] || ''}
                                            onChange={e => {
                                                const currentTime = formData.reservation_time?.split('T')[1] || '20:00';
                                                setFormData({...formData, reservation_time: `${e.target.value}T${currentTime}`});
                                            }}
                                        />
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Ora</label>
                                        <select
                                            required
                                            className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer transition-colors"
                                            value={formData.reservation_time?.split('T')[1]?.substring(0, 5) || ''}
                                            onChange={e => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, reservation_time: `${currentDate}T${e.target.value}`});
                                            }}
                                        >
                                            {formData.shift === Shift.LUNCH ? (
                                                <>
                                                    <option value="13:00">13:00</option>
                                                    <option value="13:30">13:30</option>
                                                    <option value="14:00">14:00</option>
                                                </>
                                            ) : (
                                                <>
                                                    <option value="19:30">19:30</option>
                                                    <option value="20:00">20:00</option>
                                                    <option value="20:30">20:30</option>
                                                    <option value="21:00">21:00</option>
                                                    <option value="21:30">21:30</option>
                                                    <option value="22:00">22:00</option>
                                                    <option value="22:30">22:30</option>
                                                    <option value="23:00">23:00</option>
                                                    <option value="23:30">23:30</option>
                                                </>
                                            )}
                                        </select>
                                    </div>
                                </div>
                            </div>

                            {/* Customer Name with Voice Input */}
                            <div>
                                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Nome Cliente</label>
                                <div className="flex items-center gap-2">
                                    <div className="flex-1 relative">
                                        <input
                                            required
                                            className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                            value={formData.customer_name}
                                            onChange={e => {
                                                lastSuggestQueryRef.current = '';
                                                setMatchedCustomerNoShows(0);
                                                setFormData({...formData, customer_name: e.target.value});
                                            }}
                                            onFocus={() => setActiveSuggestField('name')}
                                            onBlur={() => setTimeout(() => setActiveSuggestField(prev => prev === 'name' ? null : prev), 150)}
                                            placeholder="Mario Rossi"
                                            autoComplete="off"
                                        />
                                        {activeSuggestField === 'name' && customerSuggestions.length > 0 && (
                                            <ul className="absolute z-30 left-0 right-0 mt-1 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md shadow-[var(--shadow-md)] max-h-60 overflow-y-auto">
                                                {customerSuggestions.map(c => (
                                                    <li key={c.id}>
                                                        <button
                                                            type="button"
                                                            onMouseDown={e => e.preventDefault()}
                                                            onClick={() => applyCustomerSuggestion(c)}
                                                            className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-hover)] transition-colors"
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-medium text-[var(--color-fg)]">{c.name}</span>
                                                                {(c.no_show_count || 0) > 0 && (
                                                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300">
                                                                        <UserX className="h-2.5 w-2.5" />
                                                                        {c.no_show_count} no-show
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--color-fg-muted)]">
                                                                {c.phone && <span>{c.phone}</span>}
                                                                {c.email && <span className="truncate">{c.email}</span>}
                                                            </div>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setIsCustomerPickerOpen(true)}
                                        className="p-2 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors flex items-center justify-center flex-shrink-0"
                                        title="Rubrica clienti"
                                    >
                                        <BookUser className="h-4 w-4" />
                                    </button>
                                    {isVoiceSupported() && (
                                        <button
                                            type="button"
                                            onClick={handleVoiceInput}
                                            disabled={isListening}
                                            className={`p-2 rounded-md transition-colors flex items-center justify-center flex-shrink-0 border ${
                                                isListening
                                                    ? 'bg-rose-50 text-rose-600 border-rose-100 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30 animate-pulse'
                                                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                                            }`}
                                            title="Dettatura vocale"
                                        >
                                            <Mic className="h-4 w-4" />
                                        </button>
                                    )}
                                </div>
                                {isVoiceSupported() && (
                                    <p className="text-xs text-[var(--color-fg-subtle)] mt-1">
                                        Premi il microfono e detta: "Prenotazione per Mario Rossi domani alle 20 per 4 persone"
                                    </p>
                                )}
                            </div>

                            {/* Phone & Email */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Telefono</label>
                                    <div className="relative">
                                        <input
                                            type="tel"
                                            className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                            value={formData.phone || ''}
                                            onChange={e => {
                                                lastSuggestQueryRef.current = '';
                                                setMatchedCustomerNoShows(0);
                                                setFormData({...formData, phone: e.target.value});
                                            }}
                                            onFocus={() => setActiveSuggestField('phone')}
                                            onBlur={() => setTimeout(() => setActiveSuggestField(prev => prev === 'phone' ? null : prev), 150)}
                                            placeholder="+39 333..."
                                            autoComplete="off"
                                        />
                                        {activeSuggestField === 'phone' && customerSuggestions.length > 0 && (
                                            <ul className="absolute z-30 left-0 right-0 mt-1 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md shadow-[var(--shadow-md)] max-h-60 overflow-y-auto">
                                                {customerSuggestions.map(c => (
                                                    <li key={c.id}>
                                                        <button
                                                            type="button"
                                                            onMouseDown={e => e.preventDefault()}
                                                            onClick={() => applyCustomerSuggestion(c)}
                                                            className="w-full text-left px-3 py-2 hover:bg-[var(--color-surface-hover)] transition-colors"
                                                        >
                                                            <div className="flex items-center gap-2">
                                                                <span className="text-sm font-medium text-[var(--color-fg)]">{c.name}</span>
                                                                {(c.no_show_count || 0) > 0 && (
                                                                    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-rose-100 border border-rose-200 text-rose-700 dark:bg-rose-500/15 dark:border-rose-500/30 dark:text-rose-300">
                                                                        <UserX className="h-2.5 w-2.5" />
                                                                        {c.no_show_count} no-show
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <div className="mt-0.5 flex flex-wrap gap-3 text-xs text-[var(--color-fg-muted)]">
                                                                {c.phone && <span>{c.phone}</span>}
                                                                {c.email && <span className="truncate">{c.email}</span>}
                                                            </div>
                                                        </button>
                                                    </li>
                                                ))}
                                            </ul>
                                        )}
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Email</label>
                                    <input
                                        type="email"
                                        className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@email.com"
                                    />
                                </div>
                            </div>

                            {/* Banchetto - shown only if there are banquets on the chosen date */}
                            {(() => {
                                const formDate = formData.reservation_time?.split('T')[0];
                                const banquetsForDate = formDate
                                    ? banquetMenus.filter(m => m.event_date === formDate)
                                    : [];
                                if (banquetsForDate.length === 0) return null;
                                return (
                                    <div>
                                        <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Banchetto</label>
                                        <div className="relative">
                                            <select
                                                className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 pr-10 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer transition-colors appearance-none"
                                                value={formData.banquet_menu_id ?? ''}
                                                onChange={e => setFormData({
                                                    ...formData,
                                                    banquet_menu_id: e.target.value ? Number(e.target.value) : undefined
                                                })}
                                            >
                                                <option value="">Nessuno</option>
                                                {banquetsForDate.map(m => (
                                                    <option key={m.id} value={m.id}>
                                                        {m.name}{canViewBanquetPrice && ` — €${Number(m.price_per_person).toFixed(2)}/persona`}
                                                    </option>
                                                ))}
                                            </select>
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                                        </div>
                                    </div>
                                );
                            })()}

                            {/* Expandable Sections */}
                            <div className="space-y-3">
                                {/* Allergens Button */}
                                <div className="rounded-md border border-[var(--color-line)] overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShowAllergensSection(!showAllergensSection)}
                                        className={`w-full flex items-center justify-between p-3 transition-colors ${
                                            showAllergensSection ? 'bg-[var(--color-surface-3)]' : 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <AlertTriangle className={`h-4 w-4 ${selectedAllergens.length > 0 ? 'text-amber-600' : 'text-[var(--color-fg-muted)]'}`} />
                                            <div className="text-left">
                                                <span className="text-sm font-medium text-[var(--color-fg)]">Intolleranze</span>
                                                {selectedAllergens.length > 0 && (
                                                    <p className="text-xs text-[var(--color-fg-muted)]">{selectedAllergens.length} selezionate</p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-4 h-4 text-[var(--color-fg-subtle)] transition-transform ${showAllergensSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showAllergensSection && (
                                        <div className="p-3 pt-0 space-y-3 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
                                            <div className="grid grid-cols-2 gap-2 pt-3">
                                                {COMMON_ALLERGENS.slice(0, 8).map(allergen => {
                                                    const isSelected = selectedAllergens.includes(allergen);
                                                    return (
                                                        <button
                                                            key={allergen}
                                                            type="button"
                                                            onClick={() => {
                                                                setSelectedAllergens(prev =>
                                                                    isSelected
                                                                        ? prev.filter(a => a !== allergen)
                                                                        : [...prev, allergen]
                                                                );
                                                            }}
                                                            className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors text-left ${
                                                                isSelected
                                                                    ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300'
                                                                    : 'border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                                                            }`}
                                                        >
                                                            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                                                isSelected ? 'bg-amber-600 border-amber-600 dark:bg-amber-500 dark:border-amber-500' : 'border-[var(--color-line)] bg-[var(--color-surface)]'
                                                            }`}>
                                                                {isSelected && <Check className="text-[#ffffff] w-2.5 h-2.5" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{allergen}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            {selectedAllergens.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 pt-2">
                                                    {selectedAllergens.map(allergen => (
                                                        <span key={allergen} className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 rounded-full text-xs font-medium">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
                                                            {allergen}
                                                            <button
                                                                type="button"
                                                                onClick={() => setSelectedAllergens(prev => prev.filter(a => a !== allergen))}
                                                                className="hover:text-amber-900 dark:hover:text-amber-200"
                                                            >
                                                                <X className="w-3 h-3" />
                                                            </button>
                                                        </span>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {/* Notes Button */}
                                <div className="rounded-md border border-[var(--color-line)] overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShowNotesSection(!showNotesSection)}
                                        className={`w-full flex items-center justify-between p-3 transition-colors ${
                                            showNotesSection ? 'bg-[var(--color-surface-3)]' : 'bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <StickyNote className={`h-4 w-4 ${(selectedQuickNotes.length > 0 || formData.notes) ? 'text-[var(--color-fg)]' : 'text-[var(--color-fg-muted)]'}`} />
                                            <div className="text-left">
                                                <span className="text-sm font-medium text-[var(--color-fg)]">Note</span>
                                                {selectedQuickNotes.length > 0 && (
                                                    <p className="text-xs text-[var(--color-fg-muted)]">{selectedQuickNotes.join(', ')}</p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-4 h-4 text-[var(--color-fg-subtle)] transition-transform ${showNotesSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showNotesSection && (
                                        <div className="p-3 pt-0 space-y-4 border-t border-[var(--color-line)] bg-[var(--color-surface)]">
                                            {/* Quick Notes */}
                                            <div className="grid grid-cols-2 gap-2 pt-3">
                                                {QUICK_NOTES.map(note => {
                                                    const isSelected = selectedQuickNotes.includes(note);
                                                    return (
                                                        <button
                                                            key={note}
                                                            type="button"
                                                            onClick={() => {
                                                                setSelectedQuickNotes(prev =>
                                                                    isSelected
                                                                        ? prev.filter(n => n !== note)
                                                                        : [...prev, note]
                                                                );
                                                            }}
                                                            className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors text-left ${
                                                                isSelected
                                                                    ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)] text-[var(--color-fg)]'
                                                                    : 'border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                                                            }`}
                                                        >
                                                            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                                                isSelected ? 'bg-[var(--color-fg)] border-[var(--color-fg)]' : 'border-[var(--color-line)] bg-[var(--color-surface)]'
                                                            }`}>
                                                                {isSelected && <Check className="text-[var(--color-fg-on-brand)] w-2.5 h-2.5" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{note}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {/* Free text notes */}
                                            <div>
                                                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1">Altre note</label>
                                                <textarea
                                                    className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 focus:outline-none focus:border-[var(--color-fg)] h-20 text-sm bg-[var(--color-surface)] resize-none transition-colors"
                                                    placeholder="Richieste speciali..."
                                                    value={formData.notes || ''}
                                                    onChange={e => setFormData({...formData, notes: e.target.value})}
                                                />
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>

                        {/* Right Column: Table Selection (7 cols) */}
                        <div className="lg:col-span-7 flex flex-col h-full border-t lg:border-t-0 lg:border-l border-[var(--color-line)] pt-6 lg:pt-0 lg:pl-8">
                             {/* Section Header */}
                             <div className="flex items-center gap-3 pb-4 mb-4 border-b border-[var(--color-line)]">
                                <MapPin className="h-4 w-4 text-[var(--color-fg-muted)]" />
                                <div className="flex-1">
                                    <h3 className="text-sm font-semibold text-[var(--color-fg)]">Seleziona Tavolo</h3>
                                    <p className="text-sm text-[var(--color-fg-muted)]">
                                        {formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'} - {' '}
                                        <span className="font-medium text-emerald-700 dark:text-emerald-400">{freeTablesCount} tavoli liberi</span> su {totalTablesInFilter}
                                    </p>
                                </div>
                                {selectedTableObj && (
                                    <div className="flex items-center gap-1">
                                        <span className="inline-flex items-center px-3 py-1 text-emerald-700 bg-emerald-50 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30 rounded-l-full text-xs font-medium border border-r-0 border-emerald-100">
                                            T. {selectedTableObj.name}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFormData({...formData, table_id: undefined});
                                                showToast('Tavolo rimosso dalla prenotazione', 'info');
                                            }}
                                            className="px-2 py-1 text-rose-600 bg-rose-50 dark:bg-rose-500/15 dark:text-rose-400 dark:border-rose-500/30 dark:hover:bg-rose-500/25 rounded-r-full text-xs font-medium border border-rose-100 hover:bg-rose-100 transition-colors"
                                            title="Rimuovi tavolo"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                )}
                             </div>

                             {/* Auto-assign & Actions */}
                             <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <button
                                        type="button"
                                        onClick={handleAutoAssign}
                                        className="inline-flex items-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition-opacity"
                                    >
                                        <Wand2 className="h-4 w-4" /> Assegna Automatico
                                    </button>

                                    {/* Merge Mode Toggle */}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            if (mergeMode) {
                                                setMergeMode(false);
                                                setSelectedTablesForMerge([]);
                                            } else {
                                                setMergeMode(true);
                                                if (formData.table_id) {
                                                    setSelectedTablesForMerge([formData.table_id]);
                                                }
                                            }
                                        }}
                                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-colors font-medium text-xs border ${
                                            mergeMode
                                                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                                : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                                        }`}
                                    >
                                        <Combine className="h-3.5 w-3.5" /> {mergeMode ? 'Esci Unione' : 'Unisci Tavoli'}
                                    </button>
                                </div>

                                <div className="flex gap-2 items-center">
                                    {/* Show selected tables count and total capacity */}
                                    {selectedTablesForMerge.length >= 1 && (
                                        <div className="text-xs text-[var(--color-fg-muted)] bg-[var(--color-surface-3)] border border-[var(--color-line)] px-3 py-1.5 rounded-full font-medium">
                                            {selectedTablesForMerge.length} {selectedTablesForMerge.length === 1 ? 'tavolo' : 'tavoli'} = {tables.filter(t => selectedTablesForMerge.includes(t.id)).reduce((sum, t) => sum + t.seats, 0)} posti
                                        </div>
                                    )}

                                    {selectedTablesForMerge.length >= 2 && (
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!formData.reservation_time || !formData.shift) {
                                                    showToast('Imposta data e turno della prenotazione prima di unire i tavoli', 'error');
                                                    return;
                                                }
                                                try {
                                                    const primaryTableId = selectedTablesForMerge[0];
                                                    const mergeDate = formData.reservation_time.split('T')[0];
                                                    await onMergeTables(selectedTablesForMerge, mergeDate, formData.shift);
                                                    await refreshMerges(mergeDate, formData.shift);
                                                    // Auto-select the merged table for the reservation
                                                    setFormData(prev => ({ ...prev, table_id: primaryTableId }));
                                                    showToast(`Tavoli uniti e assegnati alla prenotazione`, 'success');
                                                    setSelectedTablesForMerge([]);
                                                    setMergeMode(false);
                                                } catch (error) {
                                                    showToast('Errore durante l\'unione dei tavoli', 'error');
                                                }
                                            }}
                                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition-opacity"
                                        >
                                            <Combine className="h-4 w-4" /> Conferma Unione
                                        </button>
                                    )}

                                    {selectedTableObj?.merged_with && selectedTableObj.merged_with.length > 0 && (
                                        <button
                                            type="button"
                                            onClick={async () => {
                                                if (!formData.reservation_time || !formData.shift) {
                                                    showToast('Imposta data e turno della prenotazione prima di dividere i tavoli', 'error');
                                                    return;
                                                }
                                                try {
                                                    const splitDate = formData.reservation_time.split('T')[0];
                                                    await onSplitTable(selectedTableObj.id, splitDate, formData.shift);
                                                    await refreshMerges(splitDate, formData.shift);
                                                    showToast('Tavoli divisi con successo', 'success');
                                                    setFormData({...formData, table_id: undefined});
                                                } catch (error) {
                                                    showToast('Errore durante la divisione dei tavoli', 'error');
                                                }
                                            }}
                                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 border border-amber-100 bg-amber-50 text-amber-700 dark:bg-amber-500/15 dark:border-amber-500/30 dark:text-amber-300 dark:hover:bg-amber-500/25 text-sm font-medium hover:bg-amber-100 transition-colors"
                                        >
                                            <Scissors className="h-4 w-4" /> Dividi
                                        </button>
                                    )}
                                </div>
                             </div>

                             {/* Room Tabs */}
                             <div className="mb-4">
                                 <p className="text-sm font-semibold text-[var(--color-fg)] mb-3">Sale</p>
                                 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                                     <button
                                        type="button"
                                        onClick={() => setModalRoomFilter('ALL')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${modalRoomFilter === 'ALL' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                                     >
                                         Tutte le sale
                                     </button>
                                     {openRooms.map(room => (
                                         <button
                                            key={room.id}
                                            type="button"
                                            onClick={() => setModalRoomFilter(room.id)}
                                            className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${modalRoomFilter === room.id ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                                         >
                                             {room.name}
                                         </button>
                                     ))}
                                 </div>
                             </div>

                             <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[var(--color-fg-muted)] mb-3 px-1">
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface)] border border-[var(--color-line)] rounded"></div> Libero</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-fg)] rounded"></div> Selezionato</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-rose-50 border border-rose-200 dark:bg-rose-500/15 dark:border-rose-500/30 rounded"></div> Occupato</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded opacity-50"></div> Capienza Insufficiente</div>
                                 <div className="flex items-center gap-1.5">
                                     <div className="w-3 h-3 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] rounded-full flex items-center justify-center">
                                         <Combine size={6} />
                                     </div>
                                     Tavolo Unito
                                 </div>
                             </div>

                             <div className="flex-1 bg-[var(--color-surface-2)] rounded-lg border border-[var(--color-line)] p-2 sm:p-4 overflow-y-auto max-h-[300px] sm:max-h-[400px] relative">
                                {isLoadingMerges && (
                                    <div className="absolute inset-0 z-20 bg-[var(--color-surface-2)]/70 backdrop-blur-[1px] flex items-center justify-center rounded-lg">
                                        <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] rounded-md shadow-[var(--shadow-xs)] border border-[var(--color-line)]">
                                            <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
                                            <span className="text-sm text-[var(--color-fg-muted)]">Caricamento tavoli…</span>
                                        </div>
                                    </div>
                                )}
                                {displayedRooms.map(room => (
                                    <div key={room.id} className="mb-4 sm:mb-6 last:mb-0">
                                        <h4 className="text-sm font-semibold text-[var(--color-fg)] mb-2 sticky top-0 bg-[var(--color-surface-2)] py-1 z-10">{room.name}</h4>
                                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 sm:gap-3">
                                                                                         {displayTables
                                                .filter(t => t.room_id === room.id)
                                                .filter(t => !displayTables.some(other =>
                                                    other.merged_with && other.merged_with.length > 0 &&
                                                    other.merged_with.map(id => Number(id)).includes(Number(t.id))
                                                ))
                                                .filter(t => !hiddenTableIds.has(t.id))
                                                .map(table => {
                                                const occupier = getOccupierForTableInForm(table.id);
                                                const isOccupied = !!occupier;
                                                const occupierIsBanquet = occupier?.kind === 'banquet';
                                                const occupierLabel = occupier
                                                  ? occupier.kind === 'reservation'
                                                    ? toTitleCase(occupier.data.customer_name)
                                                    : occupier.data.name
                                                  : '';
                                                const isSelected = formData.table_id === table.id;
                                                const isSelectedForMerge = selectedTablesForMerge.includes(table.id);
                                                const fitsGuests = table.seats >= (formData.guests || 1);
                                                const isMerged = table.merged_with && table.merged_with.length > 0;

                                                return (
                                                    <button
                                                        key={table.id}
                                                        type="button"
                                                        disabled={isOccupied || (!fitsGuests && !mergeMode)}
                                                        onClick={(e) => {
                                                            if (mergeMode || e.ctrlKey || e.metaKey) {
                                                                // Multi-select mode for merging
                                                                e.preventDefault();
                                                                setSelectedTablesForMerge(prev =>
                                                                    prev.includes(table.id)
                                                                        ? prev.filter(id => id !== table.id)
                                                                        : [...prev, table.id]
                                                                );
                                                            } else {
                                                                // Normal single select for reservation - with validation
                                                                handleTableSelection(table);
                                                            }
                                                        }}
                                                        className={`
                                                            relative p-2 sm:p-3 rounded-md border text-center transition-colors group
                                                            ${isSelectedForMerge
                                                                ? 'border-indigo-500 bg-indigo-50 ring-2 ring-indigo-500 z-10'
                                                                : isSelected
                                                                    ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)] ring-1 ring-[var(--color-fg)] z-10'
                                                                    : isOccupied
                                                                        ? 'border-rose-200 bg-rose-50 dark:border-rose-500/30 dark:bg-rose-500/15 opacity-90 cursor-not-allowed'
                                                                        : fitsGuests
                                                                            ? 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                                                                            : 'border-[var(--color-line)] bg-[var(--color-surface-3)] opacity-50 cursor-not-allowed'
                                                            }
                                                        `}
                                                    >
                                                        {/* Merged Table Badge */}
                                                        {isMerged && !isOccupied && (
                                                            <div className="absolute -top-1.5 sm:-top-2 -left-1.5 sm:-left-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-[8px] sm:text-[10px] font-bold px-1 sm:px-1.5 py-0.5 rounded-full shadow-[var(--shadow-xs)] flex items-center gap-0.5 z-20">
                                                                <Combine size={6} className="sm:hidden" />
                                                                <Combine size={8} className="hidden sm:block" />
                                                            </div>
                                                        )}

                                                        <div className={`text-xs sm:text-sm font-semibold truncate ${isSelectedForMerge || isSelected ? 'text-[var(--color-fg)]' : isOccupied ? 'text-rose-700 dark:text-rose-400' : 'text-[var(--color-fg)]'}`}>
                                                            {table.name}
                                                        </div>
                                                        <div className={`text-[9px] sm:text-[10px] flex justify-center items-center gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 ${isOccupied ? 'text-rose-700 dark:text-rose-400' : 'text-[var(--color-fg-muted)]'}`}>
                                                            <Users size={8} className="sm:hidden" />
                                                            <Users size={10} className="hidden sm:block" />
                                                            {table.seats}
                                                        </div>
                                                        {isOccupied && occupier && (
                                                            <div
                                                                className={`absolute -bottom-3 left-1/2 -translate-x-1/2 text-[#ffffff] text-[11px] sm:text-xs font-medium px-2.5 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-xs)] max-w-[140px] truncate z-10 ${occupierIsBanquet ? 'bg-[#4f46e5]' : 'bg-[#e11d48]'}`}
                                                                title={occupierIsBanquet ? `Banchetto: ${occupierLabel}` : `Prenotazione: ${occupierLabel}`}
                                                            >
                                                                {occupierLabel}
                                                            </div>
                                                        )}
                                                        {isSelected && !isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-[var(--color-fg)] rounded-full p-0.5 shadow-[var(--shadow-xs)] z-20">
                                                                <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full m-1" />
                                                            </div>
                                                        )}
                                                        {isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-indigo-600 rounded-full p-1 shadow-[var(--shadow-xs)] z-20 flex items-center justify-center">
                                                                <Combine size={10} className="text-white" />
                                                            </div>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                                {displayedRooms.length === 0 && (
                                    <div className="text-center py-10 text-[var(--color-fg-subtle)]">
                                        Nessuna sala trovata.
                                    </div>
                                )}
                             </div>
                             {mergeMode && (
                                 <div className="mt-3 px-1 text-[11px] text-[var(--color-fg)] font-medium bg-[var(--color-surface-3)] border border-[var(--color-line)] px-2 py-1 rounded-md">
                                     Modalità unione attiva: clicca sui tavoli da unire, poi premi "Conferma Unione"
                                 </div>
                             )}
                        </div>
                    </form>
                </div>

                <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row justify-end items-stretch sm:items-center gap-2">
                    <button
                        type="button"
                        onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }}
                        className="w-full sm:w-auto px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
                    >
                        Annulla
                    </button>
                    {mergeMode && selectedTablesForMerge.length > 0 && (
                        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 px-3 py-1.5 rounded-full text-center">
                            Conferma l'unione tavoli prima di salvare
                        </span>
                    )}
                    <button
                        onClick={handleSubmit}
                        disabled={(mergeMode && selectedTablesForMerge.length > 0) || isSavingReservation}
                        className={`w-full sm:w-auto inline-flex items-center justify-center gap-2 px-4 py-2 rounded-full text-sm font-medium ${
                            (mergeMode && selectedTablesForMerge.length > 0) || isSavingReservation
                                ? 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] cursor-not-allowed border border-[var(--color-line)]'
                                : 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed'
                        }`}
                    >
                        {isSavingReservation && <Loader2 className="h-4 w-4 animate-spin" />}
                        {isEditing ? 'Salva' : 'Conferma'}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal?.isOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={confirmModal.onCancel}>
            <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md max-h-[90vh] overflow-hidden" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
                    <h3 className="text-[16px] font-semibold text-[var(--color-fg)] flex items-center gap-2">
                        {confirmModal.title}
                    </h3>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <p className="text-sm text-[var(--color-fg)] leading-relaxed whitespace-pre-line">
                        {confirmModal.message}
                    </p>

                    {confirmModal.suggestions && confirmModal.suggestions.length > 0 && (
                        <div className="bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-lg p-3">
                            <p className="text-sm font-semibold text-[var(--color-fg)] mb-3">
                                Tavoli disponibili con capienza adeguata
                            </p>
                            <div className="space-y-2">
                                {confirmModal.suggestions.map((suggestion, index) => (
                                    <button
                                        key={index}
                                        onClick={() => confirmModal.onSelectSuggestion?.(suggestion.table)}
                                        className="w-full flex items-center justify-between gap-3 p-3 bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md hover:border-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] transition-colors group"
                                    >
                                        <div className="flex items-center gap-2 text-[var(--color-fg)]">
                                            <Armchair size={16} className="text-[var(--color-fg-muted)]" />
                                            <span className="text-sm font-medium">{suggestion.label}</span>
                                        </div>
                                        <div className="text-[var(--color-fg-muted)] opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Check size={16} />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row justify-end gap-2">
                    <button
                        onClick={confirmModal.onCancel}
                        className="w-full sm:w-auto px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
                    >
                        Annulla
                    </button>
                    <button
                        onClick={confirmModal.onConfirm}
                        className="w-full sm:w-auto px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
                    >
                        Procedi Comunque
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <ConfirmDeleteModal
        isOpen={deleteConfirmModal.show}
        message="Stai per eliminare la prenotazione di:"
        itemName={deleteConfirmModal.customerName}
        onCancel={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />

      <ConfirmDeleteModal
        isOpen={unhideAllConfirm}
        title="Riattiva tutti i tavoli"
        message={`Stai per riattivare ${hiddenTableIds.size} ${hiddenTableIds.size === 1 ? 'tavolo nascosto' : 'tavoli nascosti'} per questo turno.`}
        confirmLabel="Riattiva tutti"
        icon={<Eye className="h-5 w-5 text-emerald-600" />}
        iconWrapperClassName="mx-auto w-12 h-12 bg-emerald-50 border border-emerald-100 dark:bg-emerald-500/15 dark:border-emerald-500/30 rounded-full flex items-center justify-center mb-4"
        confirmClassName="rounded-full px-4 py-2 bg-emerald-600 text-[#ffffff] text-sm font-medium hover:bg-emerald-700 transition"
        showIrreversibleWarning={false}
        onCancel={() => setUnhideAllConfirm(false)}
        onConfirm={async () => {
          setUnhideAllConfirm(false);
          await handleUnhideAllTables();
        }}
      />

      <PrintReservationsModal
        isOpen={isPrintModalOpen}
        onClose={() => setIsPrintModalOpen(false)}
        reservations={reservations}
        banquetMenus={banquetMenus}
        rooms={rooms}
        tables={tables}
        initialDate={selectedDate.split('T')[0]}
        initialShift={selectedShift}
      />

      {/* State picker modal */}
      {stateChangeReservation && (() => {
        const res = stateChangeReservation;
        const current = getReservationState(res);
        const options: ReservationStateKey[] = ['pending', 'waiting', 'arrived', 'freed', 'noshow', 'cancelled'];
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] px-4" onClick={() => setStateChangeReservation(null)}>
            <div className="bg-[var(--color-surface)] w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl border border-[var(--color-line)] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between p-4 border-b border-[var(--color-line)]">
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Cambia stato</h3>
                    <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 truncate">
                      {toTitleCase(res.customer_name)} · {formatTime(res.reservation_time)}
                    </p>
                  </div>
                  <button onClick={() => setStateChangeReservation(null)}
                    className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]">
                    <X className="h-5 w-5" />
                  </button>
              </div>
              <div className="p-3 space-y-1.5">
                {options.map(opt => {
                  const meta = RESERVATION_STATE_META[opt];
                  const isCurrent = opt === current;
                  return (
                    <button
                      key={opt}
                      type="button"
                      onClick={() => {
                        if (!isCurrent) handleSetReservationState(res, opt);
                        setStateChangeReservation(null);
                      }}
                      className={`w-full flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border transition-colors ${
                        isCurrent
                          ? `${meta.chipClass} ring-2 ring-offset-1 ring-[var(--color-fg)]/20`
                          : 'border-[var(--color-line)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]'
                      }`}
                    >
                      <span className="flex items-center gap-2.5">
                        <span className={`w-2 h-2 rounded-full ${meta.dotClass}`} />
                        <span className="text-sm font-medium text-[var(--color-fg)]">{meta.label}</span>
                      </span>
                      {isCurrent && <Check className="h-4 w-4 text-[var(--color-fg-muted)]" />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Unassigned-reservations modal: opened from the map header badge */}
      {showUnassignedModal && (() => {
          const dateOnly = selectedDate.split('T')[0];
          const effectiveShift: Shift = selectedShift !== 'ALL'
            ? selectedShift
            : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER);
          const unassigned = reservations
            .filter(r => r.reservation_time.split('T')[0] === dateOnly)
            .filter(r => r.shift === effectiveShift)
            .filter(r => !r.table_id)
            .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));

          return (
            <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setShowUnassignedModal(false)}>
              <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
                  <div>
                    <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Prenotazioni senza tavolo</h3>
                    <p className="text-xs text-[var(--color-fg-muted)] mt-0.5">
                      {effectiveShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} · {new Date(dateOnly).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' })}
                    </p>
                  </div>
                  <button
                    onClick={() => setShowUnassignedModal(false)}
                    className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                  >
                    <X className="h-5 w-5" />
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                  {unassigned.length === 0 ? (
                    <div className="text-center py-10 px-4">
                      <div className="mx-auto w-12 h-12 bg-emerald-100 dark:bg-emerald-500/15 rounded-full flex items-center justify-center mb-3">
                        <Check className="h-6 w-6 text-emerald-600" />
                      </div>
                      <p className="text-sm font-semibold text-[var(--color-fg)]">Tutte le prenotazioni hanno un tavolo</p>
                      <p className="text-xs text-[var(--color-fg-muted)] mt-1">Nessuna prenotazione da assegnare per questo turno.</p>
                    </div>
                  ) : (
                    <ul className="divide-y divide-[var(--color-line)]">
                      {unassigned.map(r => (
                        <li key={r.id}>
                          <button
                            onClick={() => {
                                setShowUnassignedModal(false);
                                handleEditClick(r);
                            }}
                            className="w-full text-left px-3 py-3 hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors flex items-center gap-3"
                          >
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-semibold text-[var(--color-fg)] truncate">{toTitleCase(r.customer_name)}</span>
                                {renderOperatorBadge(r)}
                              </div>
                              <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                                <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(r.reservation_time)}</span>
                                <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {r.guests}</span>
                                {r.phone && <span className="truncate">{r.phone}</span>}
                              </div>
                            </div>
                            <ChevronRight className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="p-4 border-t border-[var(--color-line)]">
                  <button
                    onClick={() => setShowUnassignedModal(false)}
                    className="w-full px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
                  >
                    Chiudi
                  </button>
                </div>
              </div>
            </div>
          );
      })()}

      {/* Assign-to-free-table modal: click on a free table in Map view */}
      {assignTableModal && (() => {
          const table = assignTableModal;
          const dateOnly = selectedDate.split('T')[0];
          const effectiveShift: Shift = selectedShift !== 'ALL'
            ? selectedShift
            : (new Date().getHours() >= 11 && new Date().getHours() < 17 ? Shift.LUNCH : Shift.DINNER);
          const unassigned = reservations
            .filter(r => r.reservation_time.split('T')[0] === dateOnly)
            .filter(r => r.shift === effectiveShift)
            .filter(r => !r.table_id)
            .sort((a, b) => a.reservation_time.localeCompare(b.reservation_time));

          const assign = (r: Reservation) => {
              onUpdateReservation({ ...r, table_id: table.id });
              showToast(`Tavolo ${table.name} assegnato a ${toTitleCase(r.customer_name)}`, 'success');
              setAssignTableModal(null);
          };

          const isHidden = hiddenTableIds.has(table.id);

          return (
            <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4" onClick={() => setAssignTableModal(null)}>
              <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
                  <div className="min-w-0">
                    <h3 className="text-[16px] font-semibold text-[var(--color-fg)] flex items-center gap-2">
                      <span className="truncate">Assegna Tavolo {table.name}</span>
                      {isHidden && (
                        <span className="flex-shrink-0 inline-flex items-center gap-1 text-[10px] font-bold tracking-wide bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] px-1.5 py-0.5 rounded">
                          <EyeOff size={10} /> Nascosto
                        </span>
                      )}
                    </h3>
                    <p className="text-xs text-[var(--color-fg-muted)] mt-0.5 flex items-center gap-1.5">
                      <Armchair className="h-3 w-3" /> {table.seats} posti · {effectiveShift === Shift.LUNCH ? 'Pranzo' : 'Cena'} · {new Date(dateOnly).toLocaleDateString('it-IT', { weekday: 'short', day: '2-digit', month: 'short' })}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {canEdit && (
                      <button
                        onClick={async () => {
                          await handleToggleTableHidden(table);
                          setAssignTableModal(null);
                        }}
                        className={`p-2 rounded-lg transition-colors ${
                          isHidden
                            ? 'text-emerald-600 hover:bg-emerald-50 dark:text-emerald-400 dark:hover:bg-emerald-500/15'
                            : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                        }`}
                        title={isHidden ? 'Riattiva tavolo per questo turno' : 'Nascondi tavolo per questo turno'}
                      >
                        {isHidden ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
                      </button>
                    )}
                    <button
                      onClick={() => setAssignTableModal(null)}
                      className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                    >
                      <X className="h-5 w-5" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                  <button
                    onClick={async () => {
                        const walkIn: Omit<Reservation, 'id'> = {
                            customer_name: 'Walk-in',
                            guests: Math.min(2, table.seats || 2),
                            reservation_time: formatLocalDateTime(new Date()),
                            shift: effectiveShift,
                            table_id: table.id,
                            payment_status: PaymentStatus.PENDING,
                            arrival_status: ArrivalStatus.ARRIVED,
                            enable_reminder: false,
                            reminder_sent: false,
                        };
                        try {
                            await onAddReservation(walkIn);
                            showToast(`Walk-in al tavolo ${table.name} registrato`, 'success');
                        } catch {
                            showToast('Errore nella registrazione del walk-in', 'error');
                        }
                        setAssignTableModal(null);
                    }}
                    className="w-full text-left px-3 py-3 mb-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 dark:bg-emerald-500/15 dark:hover:bg-emerald-500/25 dark:border-emerald-500/30 rounded-lg transition-colors flex items-center gap-3"
                  >
                    <div className="w-9 h-9 bg-emerald-600 rounded-lg flex items-center justify-center flex-shrink-0">
                      <UserCheck className="h-5 w-5 text-[#ffffff]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-emerald-900 dark:text-emerald-200">Walk-in</div>
                      <div className="text-xs text-emerald-700 dark:text-emerald-400 mt-0.5">Occupa subito il tavolo {table.name} con un cliente senza prenotazione</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-emerald-400 dark:text-emerald-500 flex-shrink-0" />
                  </button>

                  <button
                    onClick={() => {
                        setAssignTableModal(null);
                        handleOpenNew();
                        setFormData(prev => ({ ...prev, table_id: table.id }));
                    }}
                    className="w-full text-left px-3 py-3 mb-2 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 dark:bg-[#4f46e5]/15 dark:hover:bg-[#4f46e5]/25 dark:border-[#4f46e5]/30 rounded-lg transition-colors flex items-center gap-3"
                  >
                    <div className="w-9 h-9 bg-[#4f46e5] rounded-lg flex items-center justify-center flex-shrink-0">
                      <Plus className="h-5 w-5 text-[#ffffff]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-indigo-900 dark:text-[#c7d2fe]">Nuova prenotazione</div>
                      <div className="text-xs text-indigo-700 dark:text-[#a5b4fc] mt-0.5">Crea e assegna direttamente al tavolo {table.name}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 text-indigo-400 dark:text-[#818cf8] flex-shrink-0" />
                  </button>

                  {unassigned.length === 0 ? (
                    <div className="text-center py-6 px-4">
                      <p className="text-xs text-[var(--color-fg-muted)]">Nessuna prenotazione senza tavolo per questo turno.</p>
                    </div>
                  ) : (
                    <>
                      <div className="px-1 pt-2 pb-1 text-[11px] font-semibold tracking-wide text-[var(--color-fg-muted)]">
                        Oppure assegna a una prenotazione esistente
                      </div>
                      <ul className="divide-y divide-[var(--color-line)]">
                        {unassigned.map(r => {
                          const insufficient = (r.guests || 0) > table.seats;
                          return (
                            <li key={r.id}>
                              <button
                                onClick={() => assign(r)}
                                className="w-full text-left px-3 py-3 hover:bg-[var(--color-surface-hover)] rounded-lg transition-colors flex items-center gap-3"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <span className="font-semibold text-[var(--color-fg)] truncate">{toTitleCase(r.customer_name)}</span>
                                    {renderOperatorBadge(r)}
                                    {insufficient && (
                                      <span className="text-[10px] font-bold tracking-wide bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 px-1.5 py-0.5 rounded">
                                        Capienza insufficiente
                                      </span>
                                    )}
                                  </div>
                                  <div className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)] mt-0.5">
                                    <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {formatTime(r.reservation_time)}</span>
                                    <span className="flex items-center gap-1"><Users className="h-3 w-3" /> {r.guests}</span>
                                    {r.phone && <span className="truncate">{r.phone}</span>}
                                  </div>
                                </div>
                                <ChevronRight className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </>
                  )}
                </div>

                <div className="p-4 border-t border-[var(--color-line)]">
                  <button
                    onClick={() => setAssignTableModal(null)}
                    className="w-full px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
                  >
                    Annulla
                  </button>
                </div>
              </div>
            </div>
          );
      })()}

      <CustomerPickerModal
        isOpen={isCustomerPickerOpen}
        initialQuery={formData.customer_name || ''}
        onClose={() => setIsCustomerPickerOpen(false)}
        onSelect={(c: Customer) => {
          setFormData(prev => ({
            ...prev,
            customer_name: c.name,
            phone: c.phone || prev.phone || '',
            email: c.email || prev.email || '',
          }));
        }}
      />

      {/* Tooltip for allergens / notes */}
      {tooltipReservation && (
        <div className="fixed inset-0 z-[9999]" onClick={() => setTooltipReservation(null)}>
          <div
            className="absolute bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl shadow-[var(--shadow-lg)] px-4 py-3 max-w-xs min-w-[200px]"
            style={{
              left: Math.min(tooltipReservation.x, window.innerWidth - 280),
              top: tooltipReservation.y + 8,
              ...(tooltipReservation.y + 150 > window.innerHeight ? { top: undefined, bottom: window.innerHeight - tooltipReservation.y + 8 } as any : {}),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1.5 mb-1.5">
                {tooltipReservation.type === 'allergen'
                  ? <AlertTriangle className="h-4 w-4 text-rose-500 flex-shrink-0" />
                  : <StickyNote className="h-4 w-4 text-amber-500 flex-shrink-0" />}
                <span className="text-xs font-semibold text-[var(--color-fg)]">
                  {tooltipReservation.type === 'allergen' ? 'Intolleranze' : 'Note'}
                </span>
              </div>
              <button type="button" onClick={() => setTooltipReservation(null)}
                className="p-0.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors flex-shrink-0">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-[var(--color-fg-muted)] leading-relaxed">{tooltipReservation.text}</p>
          </div>
        </div>
      )}
    </div>
  );
};
