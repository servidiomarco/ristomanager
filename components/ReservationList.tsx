import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus, TableMerge, COMMON_ALLERGENS } from '../types';
import { Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, MapPin, Filter, Map as MapIcon, List, MessageCircle, Mail, Armchair, Search, BellRing, CheckSquare, Square, UserCheck, Combine, Scissors, Check, ChevronDown, ChevronLeft, ChevronRight, AlertTriangle, StickyNote, Mic, Loader2, Info, ArrowUpDown, RotateCcw, Printer, LogOut } from 'lucide-react';
import { sendWhatsAppConfirmation, getTableMerges } from '../services/apiService';
import { isVoiceSupported, startListening, parseReservationText } from '../services/voiceInputService';
import { applyMerges } from '../utils/tableMerge';
import { toTitleCase } from '../utils/text';
import { useSocket } from '../hooks/useSocket';
import { PrintReservationsModal } from './PrintReservationsModal';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';

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
  onModalClose
}) => {
  // Main View State
  const [viewMode, setViewMode] = useState<'LIST' | 'MAP'>('LIST');
  const [selectedDate, setSelectedDate] = useState<string>(formatLocalDateTime(new Date()));
  const [selectedShift, setSelectedShift] = useState<Shift | 'ALL'>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [filterArrivalStatus, setFilterArrivalStatus] = useState<ArrivalStatus | 'ALL'>('ALL');
  const [filterGuestRange, setFilterGuestRange] = useState<'ALL' | '1-2' | '3-4' | '5-6' | '7+'>('ALL');
  const [filterHasAllergens, setFilterHasAllergens] = useState(false);
  const [filterHasNotes, setFilterHasNotes] = useState(false);
  const [filterNoTable, setFilterNoTable] = useState(false);
  const [sortBy, setSortBy] = useState<'time-asc' | 'time-desc' | 'name-asc' | 'name-desc' | 'guests-asc' | 'guests-desc'>('time-asc');
  const [showFiltersPanel, setShowFiltersPanel] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
    const [activeMapRoomId, setActiveMapRoomId] = useState<string | number>('ALL');
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const dateInputRef = useRef<HTMLInputElement>(null);

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
    if (rooms.length > 0 && activeMapRoomId === 'ALL') {
      setActiveMapRoomId(rooms[0].id);
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
  const [selectedAllergens, setSelectedAllergens] = useState<string[]>([]);
  const [selectedQuickNotes, setSelectedQuickNotes] = useState<string[]>([]);
  const [showAllergensSection, setShowAllergensSection] = useState(false);
  const [showNotesSection, setShowNotesSection] = useState(false);
  const [modalRoomFilter, setModalRoomFilter] = useState<string | number>('ALL');
  const [selectedTablesForMerge, setSelectedTablesForMerge] = useState<number[]>([]);
  const [mergeMode, setMergeMode] = useState(false);
  const [deleteConfirmModal, setDeleteConfirmModal] = useState<{show: boolean, reservationId: number | null, customerName: string}>({show: false, reservationId: null, customerName: ''});
  const [isListening, setIsListening] = useState(false);
  const [isLegendOpen, setIsLegendOpen] = useState(false);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);

  // Map view canvas size tracking for responsive scaling
  const mapCanvasRef = useRef<HTMLDivElement>(null);
  const [mapCanvasSize, setMapCanvasSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = mapCanvasRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setMapCanvasSize({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [viewMode]);

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

  // Time slot options
  const LUNCH_TIMES = ['13:00', '13:30', '14:00'];
  const DINNER_TIMES = ['19:30', '20:00', '20:30', '21:00', '21:30', '22:00', '22:30', '23:00', '23:30'];

  const getDefaultTime = (shift: Shift) => shift === Shift.LUNCH ? '13:00' : '20:00';

  const [formData, setFormData] = useState<Partial<Reservation>>({
      customer_name: '',
      guests: 2,
      reservation_time: `${new Date().toISOString().split('T')[0]}T20:00`,
      shift: Shift.DINNER,
      payment_status: PaymentStatus.PENDING,
      table_id: undefined,
      enable_reminder: true,
      reminder_sent: false,
      arrival_status: ArrivalStatus.WAITING
  });

  // Per-shift table merges. Use the form's date+shift while the modal is open;
  // otherwise scope to the page's selectedDate/selectedShift (fallback if 'ALL').
  const [tableMerges, setTableMerges] = useState<TableMerge[]>([]);
  const [isLoadingMerges, setIsLoadingMerges] = useState(false);

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

  const { socket } = useSocket();

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
      const matchesSearch = r.customer_name ? r.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) : true;
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

  // Date Navigation Helpers
  const selectedDateObj = new Date(selectedDate);
  const todayStr = formatLocalDate(new Date());
  const selectedDateStr = selectedDate.split('T')[0];
  const isToday = selectedDateStr === todayStr;

  const goToPreviousDay = () => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() - 1);
    // Keep the same time
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(formatLocalDate(current) + 'T' + time);
  };

  const goToNextDay = () => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + 1);
    // Keep the same time
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(formatLocalDate(current) + 'T' + time);
  };

  const goToToday = () => {
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(formatLocalDate(new Date()) + 'T' + time);
  };

  const handleDateInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (!value) return;
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(`${value}T${time}`);
  };

  const formatSelectedDate = (date: Date) => {
    return date.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

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

  const handleToggleArrivalStatus = (res: Reservation) => {
      const currentStatus = res.arrival_status || ArrivalStatus.WAITING;
      // DEPARTED → WAITING (reopen), ARRIVED → WAITING, WAITING → ARRIVED
      const newStatus = currentStatus === ArrivalStatus.ARRIVED ? ArrivalStatus.WAITING : ArrivalStatus.ARRIVED;
      const finalStatus = currentStatus === ArrivalStatus.DEPARTED ? ArrivalStatus.WAITING : newStatus;
      onUpdateReservation({ ...res, arrival_status: finalStatus });
      showToast(
          finalStatus === ArrivalStatus.ARRIVED
              ? `${toTitleCase(res.customer_name)} è arrivato`
              : `${toTitleCase(res.customer_name)} è in attesa`,
          'success'
      );
  };

  const handleFreeTable = (res: Reservation) => {
      onUpdateReservation({ ...res, arrival_status: ArrivalStatus.DEPARTED });
      const tableName = tables.find(t => t.id === res.table_id)?.name;
      showToast(
          tableName
              ? `Tavolo ${tableName} liberato (${toTitleCase(res.customer_name)})`
              : `Prenotazione di ${toTitleCase(res.customer_name)} chiusa`,
          'success'
      );
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
      setFormData(prev => ({
        ...prev,
        customer_name: parsed.customer_name || prev.customer_name,
        guests: parsed.guests || prev.guests,
        reservation_time: parsed.reservation_time || prev.reservation_time,
        shift: parsed.shift || prev.shift,
        phone: parsed.phone || prev.phone,
        notes: parsed.notes ? (prev.notes ? `${prev.notes}, ${parsed.notes}` : parsed.notes) : prev.notes,
      }));

      // Build summary of what was parsed
      const parsedFields: string[] = [];
      if (parsed.customer_name) parsedFields.push(`Nome: ${parsed.customer_name}`);
      if (parsed.guests) parsedFields.push(`${parsed.guests} persone`);
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
      setIsEditing(false);
      setIsFormOpen(true);
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

  // --- Helper Logic ---

  const isTableOccupied = (table_id: number, checkDate: string, checkShift: Shift) => {
    return reservations.some(r =>
        r.table_id === table_id &&
        r.reservation_time.split('T')[0] === checkDate &&
        r.shift === checkShift &&
        r.id !== formData.id &&
        r.arrival_status !== ArrivalStatus.DEPARTED
    );
  };

  const getReservationForTable = (table_id: number) => {
      return reservations.find(r =>
          r.table_id === table_id &&
          r.reservation_time.split('T')[0] === selectedDate.split('T')[0] &&
          r.shift === selectedShift &&
          r.arrival_status !== ArrivalStatus.DEPARTED
      );
  }

  const getReservationForTableInForm = (table_id: number) => {
      if (!formData.reservation_time || !formData.shift) return null;
      return reservations.find(r =>
          r.table_id === table_id &&
          r.reservation_time.split('T')[0] === formData.reservation_time!.split('T')[0] &&
          r.shift === formData.shift &&
          r.id !== formData.id &&
          r.arrival_status !== ArrivalStatus.DEPARTED
      );
  }

  const handleTableSelection = (table: Table) => {
      const guests = formData.guests || 1;

      // Check if table is too small
      if (table.seats < guests) {
          // Find suitable alternatives (use displayTables for current shift context)
          const suitableTables = displayTables
              .filter(t => t.seats >= guests)
              .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
              .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
              .filter(t => !displayTables.some(other =>
                  other.merged_with && other.merged_with.length > 0 &&
                  other.merged_with.map(id => Number(id)).includes(Number(t.id))
              ))
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

      const availableTables = displayTables
        .filter(t => t.seats >= (formData.guests || 0))
        .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
        .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
        .filter(t => !displayTables.some(other =>
            other.merged_with && other.merged_with.length > 0 &&
            other.merged_with.map(id => Number(id)).includes(Number(t.id))
        ))
        .sort((a, b) => a.seats - b.seats);

      if (availableTables.length > 0) {
          setFormData({ ...formData, table_id: availableTables[0].id });
          showToast(`Tavolo ${availableTables[0].name} assegnato automaticamente.`, 'success');
      } else {
          showToast("Nessun tavolo ottimale trovato.", 'error');
      }
  };

  const handleSubmit = (e: React.FormEvent) => {
      e.preventDefault();
      if (!formData.customer_name || !formData.reservation_time) return;

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

      if (isEditing) {
          onUpdateReservation(dataToSave as Reservation);
      } else {
          onAddReservation(dataToSave as Omit<Reservation, 'id'>);
      }

      setIsFormOpen(false);
  };

  const getStatusColor = (status: PaymentStatus) => {
    switch (status) {
      case PaymentStatus.PAID_FULL: return 'bg-emerald-50 text-emerald-700 border-emerald-100';
      case PaymentStatus.PAID_DEPOSIT: return 'bg-blue-50 text-blue-700 border-blue-100';
      case PaymentStatus.PENDING: return 'bg-amber-50 text-amber-700 border-amber-100';
      case PaymentStatus.REFUNDED: return 'bg-rose-50 text-rose-700 border-rose-100';
      default: return 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border-[var(--color-line)]';
    }
  };

  const displayedRooms = modalRoomFilter === 'ALL' ? rooms : rooms.filter(r => r.id === modalRoomFilter);
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

  // Get visible tables (not merged into another table)
  const visibleTables = displayTables.filter(t =>
    (modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter) &&
    !isTableMergedIntoAnother(t.id)
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
      const reservation = getReservationForTable(table.id);
      const isOccupied = !!reservation;
      const isArrived = isOccupied && reservation.arrival_status === ArrivalStatus.ARRIVED;
      const trimmedSearch = searchTerm.trim().toLowerCase();
      const isSearchMatch = !!(trimmedSearch && reservation && reservation.customer_name.toLowerCase().includes(trimmedSearch));

      // Responsive table sizes - smaller on mobile and tablets
      const baseSize = window.innerWidth < 768 ? 45 : 80; // 45px on mobile/tablet, 80px on desktop
      const baseWidth = window.innerWidth < 768 ? 60 : 100; // For rectangles

      let shapeStyles = {};
      if (table.shape === TableShape.CIRCLE) {
          shapeStyles = { borderRadius: '50%', width: `${baseSize}px`, height: `${baseSize}px` };
      } else if (table.shape === TableShape.SQUARE) {
          shapeStyles = { borderRadius: '8px', width: `${baseSize}px`, height: `${baseSize}px` };
      } else {
          const width = Math.max(baseWidth, table.seats * (window.innerWidth < 768 ? 8 : 15));
          shapeStyles = { borderRadius: '8px', width: `${width}px`, height: `${baseSize}px` };
      }

      return (
        <div
            key={table.id}
            className={`absolute flex flex-col items-center justify-center border shadow-[var(--shadow-xs)] transition-all select-none
                ${isArrived
                    ? 'bg-orange-50 border-orange-300 text-orange-700 z-10 ring-1 ring-orange-200'
                    : isOccupied
                        ? 'bg-rose-50 border-rose-300 text-rose-700 z-10 ring-1 ring-rose-200'
                        : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                }
                ${isSearchMatch ? 'animate-glow-pulse z-20' : ''}
            `}
            style={{
                left: table.x,
                top: table.y,
                ...shapeStyles,
                transform: table.rotation ? `rotate(${table.rotation}deg)` : undefined
            }}
            title={isOccupied ? `Occupato da: ${toTitleCase(reservation.customer_name)}` : 'Libero'}
            onClick={() => isOccupied && handleEditClick(reservation)}
        >
            <span className="font-bold text-base sm:text-lg truncate px-1 max-w-full">{table.name}</span>
            {isOccupied ? (
                <span className="flex items-center gap-1 text-base sm:text-lg font-bold">
                    <Users size={16} /> {reservation.guests}
                </span>
            ) : (
                <span className="text-[10px] flex items-center gap-1 opacity-80">
                    <Armchair size={10} /> {table.seats}
                </span>
            )}
            {isOccupied && (
                <div className={`absolute -bottom-6 sm:-bottom-7 left-1/2 -translate-x-1/2 text-white text-xs sm:text-sm font-medium px-3 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-xs)] max-w-[180px] truncate ${isArrived ? 'bg-orange-600' : 'bg-rose-600'}`}>
                    {toTitleCase(reservation.customer_name)}
                </div>
            )}
        </div>
      );
  };

  return (
    <div className={modalOnly ? 'contents' : `${viewMode === 'MAP' ? 'p-4 sm:p-6' : 'max-w-7xl mx-auto p-4 sm:p-6 lg:p-8'} space-y-6`}>
      {!modalOnly && (
      <React.Fragment>
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-[20px] sm:text-[22px] font-semibold tracking-tight text-[var(--color-fg)]">Gestione Prenotazioni</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">Gestisci turni, tavoli e pagamenti.</p>
        </div>

        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
            {canEdit && (
            <button
                onClick={handleOpenNew}
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition-opacity"
            >
                <Plus className="h-4 w-4" /> Nuova
            </button>
            )}

            <div className="inline-flex items-center p-0.5 bg-[var(--color-surface-3)] rounded-full">
                <button
                   onClick={() => setViewMode('LIST')}
                   className={`px-3 py-1 rounded-full text-xs font-medium transition inline-flex items-center gap-1.5 ${viewMode === 'LIST' ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                   title="Vista Elenco"
                >
                    <List className="h-4 w-4" />
                </button>
                <button
                   onClick={() => setViewMode('MAP')}
                   className={`px-3 py-1 rounded-full text-xs font-medium transition inline-flex items-center gap-1.5 ${viewMode === 'MAP' ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                   title="Vista Mappa Sala"
                >
                    <MapIcon className="h-4 w-4" />
                </button>
            </div>
        </div>
      </div>

      {/* Search & Filters Bar */}
      <div className="flex flex-wrap items-stretch gap-3 bg-[var(--color-surface)] p-3 sm:p-4 rounded-lg shadow-[var(--shadow-xs)] border border-[var(--color-line)]">
            <div className="relative flex-1 min-w-[200px] h-11">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-[var(--color-fg-subtle)] h-4 w-4" />
                <input
                    type="text"
                    placeholder="Cerca prenotazione..."
                    className="w-full h-full pl-10 pr-4 rounded-full border border-[var(--color-line)] focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] text-sm"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
            </div>

            <div className="flex items-center justify-between sm:justify-start gap-1 bg-[var(--color-surface)] rounded-md border border-[var(--color-line)] px-1 h-11 w-full sm:w-auto">
                {!isToday && (
                    <button
                        onClick={goToToday}
                        className="px-3 h-9 text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] rounded-md transition-colors"
                    >
                        Oggi
                    </button>
                )}

                <button
                    onClick={goToPreviousDay}
                    className="h-9 w-9 flex items-center justify-center hover:bg-[var(--color-surface-hover)] rounded-md transition-colors"
                    aria-label="Giorno precedente"
                >
                    <ChevronLeft className="h-4 w-4 text-[var(--color-fg-muted)]" />
                </button>

                <div className="relative h-9 flex items-center">
                    <div className="flex items-center gap-2 px-3 sm:px-4 h-9 hover:bg-[var(--color-surface-hover)] rounded-md transition-colors pointer-events-none">
                        <Calendar className="h-4 w-4 text-[var(--color-fg-muted)] flex-shrink-0" />
                        <span className="font-medium text-sm sm:text-base text-[var(--color-fg)] capitalize sm:min-w-[220px] lg:min-w-[260px] text-center whitespace-nowrap">
                            {formatSelectedDate(selectedDateObj)}
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
                    className="h-9 w-9 flex items-center justify-center hover:bg-[var(--color-surface-hover)] rounded-md transition-colors"
                    aria-label="Giorno successivo"
                >
                    <ChevronRight className="h-4 w-4 text-[var(--color-fg-muted)]" />
                </button>
            </div>

            {/* Clock + Shift Toggle - share a row, justified on mobile */}
            <div className="flex items-stretch justify-between sm:justify-start gap-3 w-full sm:w-auto">
                <div className="flex items-center gap-2 bg-[var(--color-surface)] rounded-md border border-[var(--color-line)] px-4 h-11">
                    <Clock className="h-4 w-4 text-[var(--color-fg-muted)]" />
                    <span className="font-mono text-base font-medium text-[var(--color-fg)] tabular-nums">
                        {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>

                <div className="bg-[var(--color-surface-3)] rounded-full flex items-center p-0.5 h-11">
                    <button
                        onClick={() => setSelectedShift(Shift.LUNCH)}
                        className={`flex items-center justify-center gap-1.5 px-3 h-9 rounded-full text-sm font-medium transition ${selectedShift === Shift.LUNCH ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                    >
                        <Sun className="h-4 w-4" /> Pranzo
                    </button>
                    <button
                        onClick={() => setSelectedShift(Shift.DINNER)}
                        className={`flex items-center justify-center gap-1.5 px-3 h-9 rounded-full text-sm font-medium transition ${selectedShift === Shift.DINNER ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                    >
                        <Moon className="h-4 w-4" /> Cena
                    </button>
                </div>
            </div>

            {viewMode === 'LIST' && (
                <div className="flex items-stretch gap-2 w-full sm:w-auto">
                    <div className="relative h-11">
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
                            className="appearance-none h-11 pl-10 pr-9 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-sm font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] focus:outline-none focus:border-[var(--color-fg)] cursor-pointer"
                            aria-label="Ordina prenotazioni"
                        >
                            <option value="time-asc">Orario ↑</option>
                            <option value="time-desc">Orario ↓</option>
                            <option value="name-asc">Nome A–Z</option>
                            <option value="name-desc">Nome Z–A</option>
                            <option value="guests-asc">Coperti ↑</option>
                            <option value="guests-desc">Coperti ↓</option>
                        </select>
                        <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                    </div>
                    <button
                        type="button"
                        onClick={() => setShowFiltersPanel(o => !o)}
                        className={`relative h-11 px-4 rounded-full border text-sm font-medium transition-colors flex items-center gap-2 ${
                            showFiltersPanel || activeFilterCount > 0
                                ? 'bg-[var(--color-fg)] border-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                                : 'bg-[var(--color-surface)] border-[var(--color-line)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                        }`}
                        aria-expanded={showFiltersPanel}
                    >
                        <Filter className="h-4 w-4" />
                        Filtri
                        {activeFilterCount > 0 && (
                            <span className="ml-1 inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-[var(--color-surface)] text-[var(--color-fg)] text-[11px] font-semibold">
                                {activeFilterCount}
                            </span>
                        )}
                    </button>
                    <button
                        type="button"
                        onClick={() => setIsPrintModalOpen(true)}
                        className="ml-auto sm:ml-0 h-11 px-3 sm:px-4 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)] text-sm font-medium transition-colors flex items-center justify-center gap-2"
                        title="Stampa lista prenotazioni"
                        aria-label="Stampa lista prenotazioni"
                    >
                        <Printer className="h-4 w-4" />
                        <span className="hidden sm:inline">Stampa</span>
                    </button>
                </div>
            )}
      </div>

      {/* Filters Panel */}
      {viewMode === 'LIST' && showFiltersPanel && (
          <div className="bg-[var(--color-surface)] p-4 rounded-lg border border-[var(--color-line)] space-y-4 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="flex items-center justify-between">
                  <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] flex items-center gap-2">
                      <Filter className="h-3.5 w-3.5" />
                      Filtri
                  </h3>
                  {activeFilterCount > 0 && (
                      <button
                          type="button"
                          onClick={resetFilters}
                          className="flex items-center gap-1.5 text-xs font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] transition-colors"
                      >
                          <RotateCcw className="h-3.5 w-3.5" />
                          Reimposta
                      </button>
                  )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  <div>
                      <label className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5 block">Stato pagamento</label>
                      <div className="flex flex-wrap gap-1.5">
                          {[
                              { value: 'ALL', label: 'Tutti' },
                              { value: PaymentStatus.PENDING, label: 'Sospeso' },
                              { value: PaymentStatus.PAID_DEPOSIT, label: 'Acconto' },
                              { value: PaymentStatus.PAID_FULL, label: 'Saldato' },
                              { value: PaymentStatus.REFUNDED, label: 'Rimborsato' },
                          ].map(opt => (
                              <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setFilterStatus(opt.value)}
                                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                      filterStatus === opt.value
                                          ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                  }`}
                              >
                                  {opt.label}
                              </button>
                          ))}
                      </div>
                  </div>

                  <div>
                      <label className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5 block">Stato arrivo</label>
                      <div className="flex flex-wrap gap-1.5">
                          {[
                              { value: 'ALL', label: 'Tutti' },
                              { value: ArrivalStatus.WAITING, label: 'In attesa' },
                              { value: ArrivalStatus.ARRIVED, label: 'Arrivato' },
                              { value: ArrivalStatus.DEPARTED, label: 'Liberato' },
                          ].map(opt => (
                              <button
                                  key={opt.value}
                                  type="button"
                                  onClick={() => setFilterArrivalStatus(opt.value as ArrivalStatus | 'ALL')}
                                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                      filterArrivalStatus === opt.value
                                          ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                  }`}
                              >
                                  {opt.label}
                              </button>
                          ))}
                      </div>
                  </div>

                  <div>
                      <label className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5 block">Coperti</label>
                      <div className="flex flex-wrap gap-1.5">
                          {(['ALL', '1-2', '3-4', '5-6', '7+'] as const).map(range => (
                              <button
                                  key={range}
                                  type="button"
                                  onClick={() => setFilterGuestRange(range)}
                                  className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                                      filterGuestRange === range
                                          ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                          : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                  }`}
                              >
                                  {range === 'ALL' ? 'Tutti' : range}
                              </button>
                          ))}
                      </div>
                  </div>

                  <div className="md:col-span-2 lg:col-span-3">
                      <label className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1.5 block">Altri filtri</label>
                      <div className="flex flex-wrap gap-2">
                          <label className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
                              <input
                                  type="checkbox"
                                  checked={filterHasAllergens}
                                  onChange={(e) => setFilterHasAllergens(e.target.checked)}
                                  className="h-4 w-4 rounded border-[var(--color-line)] text-[var(--color-fg)] focus:ring-0"
                              />
                              <span className="text-xs font-medium text-[var(--color-fg)] flex items-center gap-1">
                                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                                  Solo con allergeni
                              </span>
                          </label>
                          <label className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
                              <input
                                  type="checkbox"
                                  checked={filterHasNotes}
                                  onChange={(e) => setFilterHasNotes(e.target.checked)}
                                  className="h-4 w-4 rounded border-[var(--color-line)] text-[var(--color-fg)] focus:ring-0"
                              />
                              <span className="text-xs font-medium text-[var(--color-fg)] flex items-center gap-1">
                                  <StickyNote className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                                  Solo con note
                              </span>
                          </label>
                          <label className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-line)] cursor-pointer hover:bg-[var(--color-surface-hover)] transition-colors">
                              <input
                                  type="checkbox"
                                  checked={filterNoTable}
                                  onChange={(e) => setFilterNoTable(e.target.checked)}
                                  className="h-4 w-4 rounded border-[var(--color-line)] text-[var(--color-fg)] focus:ring-0"
                              />
                              <span className="text-xs font-medium text-[var(--color-fg)] flex items-center gap-1">
                                  <Armchair className="h-3.5 w-3.5 text-rose-600" />
                                  Senza tavolo
                              </span>
                          </label>
                      </div>
                  </div>
              </div>
          </div>
      )}

      {/* --- LIST VIEW --- */}
      {viewMode === 'LIST' && (
          <div className="grid gap-4 animate-in fade-in duration-300">
            {filteredReservations.length === 0 ? (
                <div className="text-center py-20 bg-[var(--color-surface)] rounded-lg border border-dashed border-[var(--color-line)]">
                    <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-[var(--color-surface-3)] mb-4">
                    {selectedShift === Shift.LUNCH ? <Sun className="h-6 w-6 text-[var(--color-fg-muted)]" /> : selectedShift === Shift.DINNER ? <Moon className="h-6 w-6 text-[var(--color-fg-muted)]" /> : <Calendar className="h-6 w-6 text-[var(--color-fg-muted)]" />}
                    </div>
                    <h3 className="text-base font-semibold text-[var(--color-fg)]">Nessuna prenotazione</h3>
                    <p className="text-sm text-[var(--color-fg-muted)] mt-1">
                        Non ci sono prenotazioni{selectedShift === 'ALL' ? '' : ` per il turno di <b>${selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'}</b>`} in questa data.
                    </p>
                    <button
                        onClick={handleOpenNew}
                        className="mt-4 inline-flex items-center gap-2 rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition-opacity"
                    >
                        Aggiungine una ora
                    </button>
                </div>
            ) : (
                filteredReservations.map(res => {
                    const table = displayTables.find(t => t.id === res.table_id);
                    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
                    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
                    const isDeparted = arrivalStatus === ArrivalStatus.DEPARTED;
                    const borderColor = isDeparted
                        ? 'border-l-slate-400'
                        : arrivalStatus === ArrivalStatus.ARRIVED ? 'border-l-orange-500' : 'border-l-emerald-500';
                    const cardOpacity = isDeparted ? 'opacity-70' : '';

                    const tableBadgeColor = isDeparted
                        ? 'bg-[var(--color-surface-3)] border-[var(--color-line)] text-[var(--color-fg-muted)]'
                        : arrivalStatus === ArrivalStatus.ARRIVED
                            ? 'bg-orange-50 border-orange-100 text-orange-700'
                            : 'bg-emerald-50 border-emerald-100 text-emerald-700';
                    const tableRoomName = table ? rooms.find(r => r.id === table.room_id)?.name : null;

                    return (
                        <div key={res.id} className={`bg-[var(--color-surface)] p-4 sm:p-5 rounded-lg border border-[var(--color-line)] border-l-2 ${borderColor} ${cardOpacity} shadow-[var(--shadow-xs)] hover:bg-[var(--color-surface-hover)] transition-colors flex items-start justify-between gap-3 sm:gap-4`}>
                            <div className="flex-1 min-w-0">
                                <div className="flex flex-wrap items-center gap-2 sm:gap-3 mb-2">
                                    <h3 className="font-semibold text-base sm:text-lg text-[var(--color-fg)]">{toTitleCase(res.customer_name)}</h3>
                                    {isDeparted && (
                                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] border border-[var(--color-line)] text-[var(--color-fg-muted)]">
                                            <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-fg-muted)]" />
                                            LIBERATO
                                        </span>
                                    )}
                                    {/* Payment status - only show if paid */}
                                    {res.payment_status !== PaymentStatus.PENDING && (
                                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${getStatusColor(res.payment_status)}`}>
                                            <CreditCard className="h-3 w-3" />
                                            {res.payment_status === PaymentStatus.PAID_FULL ? 'SALDATO' : 'ACCONTO'}
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-sm text-[var(--color-fg-muted)]">
                                    {/* Time with lateness indicator */}
                                    {(() => {
                                        const minutesLate = getMinutesLate(res.reservation_time);
                                        const isToday = res.reservation_time.split('T')[0] === new Date().toISOString().split('T')[0];
                                        const clockColor = isToday && minutesLate >= 30 ? 'text-rose-600'
                                            : isToday && minutesLate >= 15 ? 'text-amber-600'
                                            : 'text-[var(--color-fg-muted)]';
                                        return (
                                            <div className={`flex items-center gap-1 ${clockColor}`}>
                                                <Clock className="h-4 w-4" />
                                                <span className="font-medium">{formatTime(res.reservation_time)}</span>
                                                {isToday && minutesLate >= 15 && (
                                                    <span className="text-xs ml-1">({minutesLate} min)</span>
                                                )}
                                            </div>
                                        );
                                    })()}
                                    <div className="flex items-center gap-1">
                                        <Users className="h-4 w-4" /> {res.guests} Ospiti
                                    </div>
                                </div>
                                {menu && (
                                    <div className="mt-2 text-sm bg-[var(--color-surface-3)] inline-block px-3 py-1 rounded-md border border-[var(--color-line)] text-[var(--color-fg)]">
                                        Menu Banchetto: <b>{menu.name}</b> (€{menu.price_per_person}/pax)
                                    </div>
                                )}
                                {res.notes && <p className="text-xs text-[var(--color-fg-subtle)] mt-2 italic">{res.notes}</p>}

                                {/* Actions - Only shown in edit mode */}
                                {canEdit && (
                                    <div className="flex items-center gap-1 mt-3">
                                        <button
                                            onClick={() => handleToggleArrivalStatus(res)}
                                            className={`p-1.5 rounded-md transition-colors ${
                                                isDeparted
                                                    ? 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                                                    : arrivalStatus === ArrivalStatus.ARRIVED
                                                        ? 'text-orange-600 hover:bg-orange-50'
                                                        : 'text-emerald-600 hover:bg-emerald-50'
                                            }`}
                                            title={isDeparted ? 'Riapri prenotazione' : arrivalStatus === ArrivalStatus.ARRIVED ? 'Arrivato' : 'In attesa'}
                                        >
                                            <UserCheck className="h-4 w-4" />
                                        </button>

                                        {arrivalStatus === ArrivalStatus.ARRIVED && res.table_id && (
                                            <button
                                                onClick={() => handleFreeTable(res)}
                                                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                                                title="Libera tavolo (fine pasto)"
                                            >
                                                <LogOut className="h-4 w-4" />
                                            </button>
                                        )}

                                        <button
                                            onClick={() => handleEditClick(res)}
                                            className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                                            title="Modifica"
                                        >
                                            <Edit2 className="h-4 w-4" />
                                        </button>
                                        <button
                                            onClick={() => handleDeleteClick(res.id, res.customer_name)}
                                            className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-rose-50 hover:text-rose-600 transition-colors"
                                            title="Elimina"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* Right: table+room badge, color matches arrival status */}
                            <div className="flex-shrink-0 self-stretch">
                                {isLoadingMerges && res.table_id ? (
                                    <div className="h-full flex flex-col items-center justify-center min-w-[88px] sm:min-w-[100px] px-3 py-4 sm:py-5 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-3)]">
                                        <Loader2 className="h-5 w-5 animate-spin text-[var(--color-fg-muted)]" />
                                    </div>
                                ) : table ? (
                                    <div className={`h-full flex flex-col items-center justify-center gap-1 min-w-[88px] sm:min-w-[100px] px-3 py-4 sm:py-5 rounded-lg border ${tableBadgeColor}`}>
                                        <span className="text-lg sm:text-xl font-semibold leading-none">T. {table.name}</span>
                                        {tableRoomName && (
                                            <span className="text-xs font-medium truncate max-w-full opacity-80">{tableRoomName}</span>
                                        )}
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => handleEditClick(res)}
                                        className="h-full flex flex-col items-center justify-center gap-1.5 min-w-[88px] sm:min-w-[100px] px-3 py-4 sm:py-5 rounded-lg border border-rose-100 bg-rose-50 text-rose-600 hover:bg-rose-100 transition-colors cursor-pointer"
                                        title="Assegna un tavolo"
                                    >
                                        <AlertCircle className="h-5 w-5" />
                                        <span className="text-[10px] font-semibold text-center leading-tight">Assegna Tavolo</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    );
                })
            )}
          </div>
      )}

      {/* --- MAP VIEW --- */}
      {viewMode === 'MAP' && (() => {
          const tablesInRoom = displayTables
              .filter(t => t.room_id === activeMapRoomId)
              .filter(t => !displayTables.some(other =>
                  other.merged_with && other.merged_with.length > 0 &&
                  other.merged_with.map(id => Number(id)).includes(Number(t.id))
              ));
          const occupiedTablesCount = tablesInRoom.filter(t => getReservationForTable(t.id)).length;
          const totalTablesInRoom = tablesInRoom.length;
          const occupancyPercentage = totalTablesInRoom > 0 ? Math.round((occupiedTablesCount / totalTablesInRoom) * 100) : 0;

          // Total guests (coperti) for the selected day + shift
          const reservationsForDayShift = reservations.filter(r => {
              const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
              const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
              return matchesDate && matchesShift;
          });
          const totalGuestsForDayShift = reservationsForDayShift.reduce((sum, r) => sum + (Number(r.guests) || 0), 0);
          const reservationCountForDayShift = reservationsForDayShift.length;

          // Compute the natural bounding box of the room and a scale factor
          // so the room fits the available canvas width/height on tablet+desktop.
          // On mobile (<768px) we keep scale=1 and rely on overflow scrolling.
          const PADDING = 40;
          const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
          const baseSize = isMobile ? 45 : 80;
          const baseWidth = isMobile ? 60 : 100;
          const seatMultiplier = isMobile ? 8 : 15;
          let maxRight = 0;
          let maxBottom = 0;
          for (const t of tablesInRoom) {
              let w: number, h: number;
              if (t.shape === TableShape.CIRCLE || t.shape === TableShape.SQUARE) {
                  w = baseSize; h = baseSize;
              } else {
                  w = Math.max(baseWidth, t.seats * seatMultiplier);
                  h = baseSize;
              }
              maxRight = Math.max(maxRight, t.x + w);
              maxBottom = Math.max(maxBottom, t.y + h);
          }
          const extentWidth = (tablesInRoom.length === 0 ? 800 : maxRight) + PADDING;
          const extentHeight = (tablesInRoom.length === 0 ? 600 : maxBottom) + PADDING;
          const scale = (!isMobile && mapCanvasSize.width > 0 && mapCanvasSize.height > 0)
              ? Math.min(mapCanvasSize.width / extentWidth, mapCanvasSize.height / extentHeight, 1)
              : 1;

          return (
              <div className="bg-[var(--color-surface)] p-4 rounded-lg border border-[var(--color-line)] shadow-[var(--shadow-xs)] flex flex-col h-[500px] sm:h-[600px] lg:h-[calc(100vh-220px)] animate-in fade-in duration-300">
                  {/* Room Selector for Map */}
                  <div className="flex gap-2 mb-4 border-b border-[var(--color-line)] pb-2 overflow-x-auto scrollbar-hide">
                      {rooms.map(room => (
                          <button
                              key={room.id}
                              onClick={() => setActiveMapRoomId(room.id)}
                              className={`px-4 py-1.5 text-sm font-medium rounded-full transition-colors whitespace-nowrap flex-shrink-0 border ${
                                  activeMapRoomId === room.id
                                  ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                  : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                              }`}
                          >
                              {room.name}
                          </button>
                      ))}
                  </div>

                  {/* Map Canvas */}
                  <div
                    ref={mapCanvasRef}
                    className="flex-1 bg-[var(--color-surface-2)] rounded-lg border border-dashed border-[var(--color-line)] relative overflow-auto md:overflow-hidden"
                    style={{
                        backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
                        backgroundSize: window.innerWidth < 768 ? '15px 15px' : '20px 20px'
                    }}
                  >
                       {isLoadingMerges && (
                           <div className="absolute inset-0 z-30 bg-[var(--color-surface-2)]/70 backdrop-blur-[1px] flex items-center justify-center">
                               <div className="flex items-center gap-2 px-4 py-2 bg-[var(--color-surface)] rounded-md shadow-[var(--shadow-xs)] border border-[var(--color-line)]">
                                   <Loader2 className="h-4 w-4 animate-spin text-[var(--color-fg-muted)]" />
                                   <span className="text-sm text-[var(--color-fg-muted)]">Caricamento tavoli…</span>
                               </div>
                           </div>
                       )}

                       {/* Coperti badge */}
                       <div className="absolute top-4 right-4 z-10 bg-[var(--color-surface)]/95 backdrop-blur px-3 py-2 rounded-full shadow-[var(--shadow-xs)] border border-[var(--color-line)] flex items-center gap-2 text-xs">
                           <Users size={14} className="text-[var(--color-fg-muted)]" />
                           <span className="font-semibold text-[var(--color-fg)]">{totalGuestsForDayShift}</span>
                           <span className="text-[var(--color-fg-muted)]">coperti</span>
                           <span className="text-[var(--color-fg-subtle)]">·</span>
                           <span className="font-medium text-[var(--color-fg)]">{reservationCountForDayShift}</span>
                           <span className="text-[var(--color-fg-muted)]">{reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}</span>
                       </div>
                       <div
                           style={{
                               width: extentWidth,
                               height: extentHeight,
                               transform: `scale(${scale})`,
                               transformOrigin: 'top left',
                               position: 'relative'
                           }}
                       >
                           {tablesInRoom.map(renderMapTable)}
                       </div>

                       {/* Legend - collapsible */}
                       <div className="absolute bottom-4 right-4 z-10 select-none">
                           <button
                               type="button"
                               onClick={(e) => { e.stopPropagation(); setIsLegendOpen(o => !o); }}
                               className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface)]/95 backdrop-blur rounded-full shadow-[var(--shadow-xs)] border border-[var(--color-line)] text-xs font-medium text-[var(--color-fg)] hover:bg-[var(--color-surface)] transition-colors"
                               aria-expanded={isLegendOpen}
                           >
                               <Info size={14} className="text-[var(--color-fg-muted)]" />
                               Legenda
                           </button>
                           {isLegendOpen && (
                               <div
                                   className="absolute bottom-full right-0 mb-2 w-56 bg-[var(--color-surface)]/95 backdrop-blur p-3 rounded-lg shadow-[var(--shadow-overlay)] border border-[var(--color-line)] text-xs space-y-2 animate-in fade-in slide-in-from-bottom-2 duration-150"
                                   onClick={(e) => e.stopPropagation()}
                               >
                                   <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-1">Legenda Stato</div>
                                   <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                                       <div className="w-3 h-3 bg-[var(--color-surface)] border border-emerald-300 rounded-sm"></div> Libero
                                   </div>
                                   <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                                       <div className="w-3 h-3 bg-rose-50 border border-rose-300 rounded-sm"></div> Occupato
                                   </div>
                                   <div className="flex items-center gap-2 text-[var(--color-fg-muted)]">
                                       <div className="w-3 h-3 bg-orange-50 border border-orange-300 rounded-sm"></div> Arrivato
                                   </div>
                                   <div className="border-t border-[var(--color-line)] mt-1 pt-2">
                                       <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Occupazione</div>
                                       <div className="text-sm text-[var(--color-fg)]">
                                           <span className="font-semibold">{occupiedTablesCount}</span> / {totalTablesInRoom} tavoli (<span className="font-semibold">{occupancyPercentage}%</span>)
                                       </div>
                                   </div>
                                   <div className="border-t border-[var(--color-line)] mt-1 pt-2">
                                       <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Coperti</div>
                                       <div className="text-sm text-[var(--color-fg)]">
                                           <span className="font-semibold">{totalGuestsForDayShift}</span> in <span className="font-semibold">{reservationCountForDayShift}</span> {reservationCountForDayShift === 1 ? 'prenotazione' : 'prenotazioni'}
                                       </div>
                                   </div>
                               </div>
                           )}
                       </div>
                  </div>
              </div>
          );
      })()}

      </React.Fragment>
      )}
      {/* Reservation Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-0 sm:p-4">
            <div className="bg-[var(--color-surface)] rounded-none sm:rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full sm:max-w-5xl overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col h-full sm:max-h-[90vh]">
                <div className="px-5 py-3.5 border-b border-[var(--color-line)] flex justify-between items-center">
                    <h2 className="text-base sm:text-lg font-semibold tracking-tight text-[var(--color-fg)]">{isEditing ? 'Modifica Prenotazione' : 'Nuova Prenotazione'}</h2>
                    <button onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }} className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]">
                        <X className="h-5 w-5" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <form id="reservation-form" onSubmit={handleSubmit} className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">
                        {/* Left Column: Details (5 cols) */}
                        <div className="lg:col-span-5 space-y-5 sm:space-y-6">
                            <div className="flex items-center gap-3 pb-3 border-b border-[var(--color-line)]">
                                <Users className="h-4 w-4 text-[var(--color-fg-muted)]" />
                                <div>
                                    <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Dettagli Prenotazione</h3>
                                    <p className="text-sm text-[var(--color-fg-muted)]">Compila i dati del cliente</p>
                                </div>
                            </div>

                            {/* Customer Name with Voice Input */}
                            <div>
                                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Nome Cliente</label>
                                <div className="flex gap-2">
                                    <input
                                        required
                                        className="flex-1 rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.customer_name}
                                        onChange={e => setFormData({...formData, customer_name: e.target.value})}
                                        placeholder="Mario Rossi"
                                    />
                                    {isVoiceSupported() && (
                                        <button
                                            type="button"
                                            onClick={handleVoiceInput}
                                            disabled={isListening}
                                            className={`p-2 rounded-md transition-colors flex items-center justify-center border ${
                                                isListening
                                                    ? 'bg-rose-50 text-rose-600 border-rose-100 animate-pulse'
                                                    : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)]'
                                            }`}
                                            title="Dettatura vocale - Es: 'Prenotazione per Mario Rossi domani sera alle 20 per 4 persone'"
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
                                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Telefono</label>
                                    <input
                                        type="tel"
                                        className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.phone || ''}
                                        onChange={e => setFormData({...formData, phone: e.target.value})}
                                        placeholder="+39 333..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Email</label>
                                    <input
                                        type="email"
                                        className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@email.com"
                                    />
                                </div>
                            </div>

                            {/* Date & Shift */}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Turno</label>
                                    <div className="bg-[var(--color-surface-3)] p-0.5 rounded-full flex items-center">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.LUNCH, reservation_time: `${currentDate}T13:00`});
                                            }}
                                            className={`flex w-full items-center justify-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition ${formData.shift === Shift.LUNCH ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                                        >
                                            <Sun className="h-4 w-4" /> Pranzo
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.DINNER, reservation_time: `${currentDate}T20:00`});
                                            }}
                                            className={`flex w-full items-center justify-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition ${formData.shift === Shift.DINNER ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-xs)]' : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'}`}
                                        >
                                            <Moon className="h-4 w-4" /> Cena
                                        </button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="overflow-hidden">
                                        <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Data</label>
                                        <div className="relative">
                                            <input
                                                type="date"
                                                required
                                                className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 pl-10 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer transition-colors"
                                                value={formData.reservation_time?.split('T')[0] || ''}
                                                onChange={e => {
                                                    const currentTime = formData.reservation_time?.split('T')[1] || '20:00';
                                                    setFormData({...formData, reservation_time: `${e.target.value}T${currentTime}`});
                                                }}
                                            />
                                            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Ora</label>
                                        <div className="relative">
                                            <select
                                                required
                                                className="w-full rounded-md border border-[var(--color-line)] px-3 py-2 pl-10 text-sm focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] cursor-pointer transition-colors appearance-none"
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
                                            <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)] pointer-events-none" />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Guests */}
                            <div>
                                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Numero Ospiti</label>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, guests: Math.max(1, (formData.guests || 2) - 1)})}
                                        className="w-12 h-12 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] font-medium text-xl hover:bg-[var(--color-surface-hover)] transition-colors flex items-center justify-center flex-shrink-0"
                                    >
                                        −
                                    </button>
                                    <input
                                        type="number"
                                        min="1"
                                        required
                                        className="flex-1 min-w-0 rounded-md border border-[var(--color-line)] px-3 py-2 text-center text-xl font-semibold focus:outline-none focus:border-[var(--color-fg)] bg-[var(--color-surface)] transition-colors"
                                        value={formData.guests || ''}
                                        onChange={e => setFormData({...formData, guests: parseInt(e.target.value) || undefined})}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, guests: (formData.guests || 2) + 1})}
                                        className="w-12 h-12 rounded-md bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] font-medium text-xl hover:opacity-90 transition-opacity flex items-center justify-center flex-shrink-0"
                                    >
                                        +
                                    </button>
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
                                        <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Banchetto</label>
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
                                                        {m.name} — €{Number(m.price_per_person).toFixed(2)}/persona
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
                                                                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                                                                    : 'border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]'
                                                            }`}
                                                        >
                                                            <div className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${
                                                                isSelected ? 'bg-amber-600 border-amber-600' : 'border-[var(--color-line)] bg-[var(--color-surface)]'
                                                            }`}>
                                                                {isSelected && <Check className="text-white w-2.5 h-2.5" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{allergen}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            {selectedAllergens.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 pt-2">
                                                    {selectedAllergens.map(allergen => (
                                                        <span key={allergen} className="inline-flex items-center gap-1 px-2.5 py-1 bg-amber-50 text-amber-700 border border-amber-100 rounded-full text-xs font-medium">
                                                            <span className="h-1.5 w-1.5 rounded-full bg-amber-600" />
                                                            {allergen}
                                                            <button
                                                                type="button"
                                                                onClick={() => setSelectedAllergens(prev => prev.filter(a => a !== allergen))}
                                                                className="hover:text-amber-900"
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
                                                <label className="block text-[12px] uppercase tracking-[0.06em] font-medium text-[var(--color-fg-subtle)] mb-1">Altre note</label>
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
                                    <h3 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)]">Seleziona Tavolo</h3>
                                    <p className="text-sm text-[var(--color-fg-muted)]">
                                        {formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'} - {' '}
                                        <span className="font-medium text-emerald-700">{freeTablesCount} tavoli liberi</span> su {totalTablesInFilter}
                                    </p>
                                </div>
                                {selectedTableObj && (
                                    <div className="flex items-center gap-1">
                                        <span className="inline-flex items-center px-3 py-1 text-emerald-700 bg-emerald-50 rounded-l-full text-xs font-medium border border-r-0 border-emerald-100">
                                            T. {selectedTableObj.name}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFormData({...formData, table_id: undefined});
                                                showToast('Tavolo rimosso dalla prenotazione', 'info');
                                            }}
                                            className="px-2 py-1 text-rose-600 bg-rose-50 rounded-r-full text-xs font-medium border border-rose-100 hover:bg-rose-100 transition-colors"
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
                                        className="inline-flex items-center gap-2 rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition-colors"
                                    >
                                        <Wand2 className="h-4 w-4" /> Assegna Automatico
                                    </button>

                                    {/* Merge Mode Toggle */}
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMergeMode(!mergeMode);
                                            if (mergeMode) {
                                                setSelectedTablesForMerge([]);
                                            }
                                        }}
                                        className={`inline-flex items-center gap-2 px-4 py-2 rounded-full transition-colors font-medium text-sm border ${
                                            mergeMode
                                                ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]'
                                                : 'bg-[var(--color-surface)] text-[var(--color-fg)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                                        }`}
                                    >
                                        <Combine className="h-4 w-4" /> {mergeMode ? 'Esci Unione' : 'Unisci Tavoli'}
                                    </button>
                                </div>

                                <div className="flex gap-2 items-center">
                                    {/* Show selected tables count and total capacity */}
                                    {selectedTablesForMerge.length >= 1 && (
                                        <div className="text-xs text-[var(--color-fg-muted)] bg-[var(--color-surface-3)] border border-[var(--color-line)] px-3 py-1.5 rounded-full font-medium">
                                            {selectedTablesForMerge.length} tavoli = {tables.filter(t => selectedTablesForMerge.includes(t.id)).reduce((sum, t) => sum + t.seats, 0)} posti
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
                                            className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 border border-amber-100 bg-amber-50 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors"
                                        >
                                            <Scissors className="h-4 w-4" /> Dividi
                                        </button>
                                    )}
                                </div>
                             </div>

                             {/* Room Tabs */}
                             <div className="mb-4">
                                 <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">Sale</p>
                                 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                                     <button
                                        type="button"
                                        onClick={() => setModalRoomFilter('ALL')}
                                        className={`px-4 py-1.5 text-sm font-medium rounded-full whitespace-nowrap transition-colors flex-shrink-0 border ${modalRoomFilter === 'ALL' ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] border-[var(--color-fg)]' : 'bg-[var(--color-surface)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'}`}
                                     >
                                         Tutte le sale
                                     </button>
                                     {rooms.map(room => (
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
                                        <h4 className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-2 sticky top-0 bg-[var(--color-surface-2)] py-1 z-10">{room.name}</h4>
                                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 sm:gap-3">
                                                                                         {displayTables
                                                .filter(t => t.room_id === room.id)
                                                .filter(t => !displayTables.some(other =>
                                                    other.merged_with && other.merged_with.length > 0 &&
                                                    other.merged_with.map(id => Number(id)).includes(Number(t.id))
                                                ))
                                                .map(table => {
                                                const occupiedReservation = getReservationForTableInForm(table.id);
                                                const isOccupied = !!occupiedReservation;
                                                const isSelected = formData.table_id === table.id;
                                                const isSelectedForMerge = selectedTablesForMerge.includes(table.id);
                                                const fitsGuests = table.seats >= (formData.guests || 1);
                                                const isMerged = table.merged_with && table.merged_with.length > 0;

                                                return (
                                                    <button
                                                        key={table.id}
                                                        type="button"
                                                        disabled={isOccupied}
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
                                                                ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)] ring-1 ring-[var(--color-fg)] z-10'
                                                                : isSelected
                                                                    ? 'border-[var(--color-fg)] bg-[var(--color-surface-3)] ring-1 ring-[var(--color-fg)] z-10'
                                                                    : isOccupied
                                                                        ? 'border-rose-200 bg-rose-50 opacity-90 cursor-not-allowed'
                                                                        : fitsGuests
                                                                            ? 'border-[var(--color-line)] bg-[var(--color-surface)] hover:border-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]'
                                                                            : 'border-[var(--color-line)] bg-[var(--color-surface-3)] opacity-50'
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

                                                        <div className={`text-xs sm:text-sm font-semibold truncate ${isSelectedForMerge || isSelected ? 'text-[var(--color-fg)]' : isOccupied ? 'text-rose-700' : 'text-[var(--color-fg)]'}`}>
                                                            {table.name}
                                                        </div>
                                                        <div className={`text-[9px] sm:text-[10px] flex justify-center items-center gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 ${isOccupied ? 'text-rose-700' : 'text-[var(--color-fg-muted)]'}`}>
                                                            <Users size={8} className="sm:hidden" />
                                                            <Users size={10} className="hidden sm:block" />
                                                            {table.seats}
                                                        </div>
                                                        {isOccupied && occupiedReservation && (
                                                            <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 bg-rose-600 text-white text-[11px] sm:text-xs font-medium px-2.5 py-0.5 rounded-full whitespace-nowrap shadow-[var(--shadow-xs)] max-w-[140px] truncate z-10">
                                                                {toTitleCase(occupiedReservation.customer_name)}
                                                            </div>
                                                        )}
                                                        {isSelected && !isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-[var(--color-fg)] rounded-full p-0.5 shadow-[var(--shadow-xs)] z-20">
                                                                <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full m-1" />
                                                            </div>
                                                        )}
                                                        {isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-[var(--color-fg)] rounded-full p-0.5 shadow-[var(--shadow-xs)] z-20">
                                                                <div className="w-1.5 h-1.5 bg-[var(--color-fg-on-brand)] rounded-full m-1" />
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
                             <div className="mt-3 flex flex-col gap-2 px-1">
                                 <div className="flex flex-wrap gap-4 text-[10px] text-[var(--color-fg-muted)]">
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface)] border border-[var(--color-line)] rounded"></div> Libero</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-fg)] rounded"></div> Selezionato</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-fg)] rounded"></div> Multi-selezione</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-rose-50 border border-rose-200 rounded"></div> Occupato</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded opacity-50"></div> Capienza Insufficiente</div>
                                     <div className="flex items-center gap-1.5">
                                         <div className="w-3 h-3 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] rounded-full flex items-center justify-center">
                                             <Combine size={6} />
                                         </div>
                                         Tavolo Unito
                                     </div>
                                 </div>
                                 {mergeMode ? (
                                     <div className="text-[11px] text-[var(--color-fg)] font-medium bg-[var(--color-surface-3)] border border-[var(--color-line)] px-2 py-1 rounded-md">
                                         Modalità unione attiva: clicca sui tavoli da unire, poi premi "Conferma Unione"
                                     </div>
                                 ) : (
                                     <div className="text-[11px] text-[var(--color-fg-subtle)] italic">
                                         Usa il pulsante "Unisci Tavoli" per combinare più tavoli per grandi gruppi
                                     </div>
                                 )}
                             </div>
                        </div>
                    </form>
                </div>

                <div className="px-5 py-3 border-t border-[var(--color-line)] flex flex-col sm:flex-row justify-end items-stretch sm:items-center gap-2">
                    <button
                        type="button"
                        onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }}
                        className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition-colors"
                    >
                        Annulla
                    </button>
                    {mergeMode && selectedTablesForMerge.length > 0 && (
                        <span className="text-xs text-amber-700 bg-amber-50 border border-amber-100 px-3 py-1.5 rounded-full text-center">
                            Conferma l'unione tavoli prima di salvare
                        </span>
                    )}
                    <button
                        onClick={handleSubmit}
                        disabled={mergeMode && selectedTablesForMerge.length > 0}
                        className={`w-full sm:w-auto rounded-full px-4 py-2 text-sm font-medium transition-opacity ${
                            mergeMode && selectedTablesForMerge.length > 0
                                ? 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] cursor-not-allowed border border-[var(--color-line)]'
                                : 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] hover:opacity-90'
                        }`}
                    >
                        {isEditing ? 'Salva' : 'Conferma'}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {confirmModal?.isOpen && (
        <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-[60] p-4">
            <div className="bg-[var(--color-surface)] rounded-xl shadow-[var(--shadow-overlay)] border border-[var(--color-line)] w-full max-w-md max-h-[90vh] overflow-hidden animate-in fade-in zoom-in duration-200">
                <div className="px-5 py-3.5 border-b border-[var(--color-line)]">
                    <h3 className="text-base font-semibold tracking-tight text-[var(--color-fg)] flex items-center gap-2">
                        {confirmModal.title}
                    </h3>
                </div>

                <div className="px-5 py-4 space-y-4">
                    <p className="text-sm text-[var(--color-fg)] leading-relaxed whitespace-pre-line">
                        {confirmModal.message}
                    </p>

                    {confirmModal.suggestions && confirmModal.suggestions.length > 0 && (
                        <div className="bg-[var(--color-surface-3)] border border-[var(--color-line)] rounded-lg p-3">
                            <p className="text-[11px] uppercase tracking-[0.08em] font-semibold text-[var(--color-fg-subtle)] mb-3">
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

                <div className="px-5 py-3 border-t border-[var(--color-line)] flex flex-col sm:flex-row justify-end gap-2">
                    <button
                        onClick={confirmModal.onCancel}
                        className="w-full sm:w-auto rounded-full px-4 py-2 border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)] transition-colors"
                    >
                        Annulla
                    </button>
                    <button
                        onClick={confirmModal.onConfirm}
                        className="w-full sm:w-auto rounded-full px-4 py-2 bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 transition-opacity"
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
    </div>
  );
};
