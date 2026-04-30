import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus, TableMerge, COMMON_ALLERGENS } from '../types';
import { Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, MapPin, Filter, Map as MapIcon, List, MessageCircle, Mail, Armchair, Search, BellRing, CheckSquare, Square, UserCheck, Combine, Scissors, Check, ChevronDown, ChevronLeft, ChevronRight, AlertTriangle, StickyNote, Mic, Loader2 } from 'lucide-react';
import { sendWhatsAppConfirmation, getTableMerges } from '../services/apiService';
import { isVoiceSupported, startListening, parseReservationText } from '../services/voiceInputService';
import { applyMerges } from '../utils/tableMerge';
import { useSocket } from '../hooks/useSocket';

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
  canEdit = true
}) => {
  // Main View State
  const [viewMode, setViewMode] = useState<'LIST' | 'MAP'>('LIST');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 16));
  const [selectedShift, setSelectedShift] = useState<Shift | 'ALL'>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
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

  useEffect(() => {
    if (rooms.length > 0 && activeMapRoomId === 'ALL') {
      setActiveMapRoomId(rooms[0].id);
    }
  }, [rooms, activeMapRoomId]);

  // Auto-switch from 'ALL' to a specific shift when in LIST view
  useEffect(() => {
    if (viewMode === 'LIST' && selectedShift === 'ALL') {
      const hour = new Date().getHours();
      setSelectedShift(hour >= 11 && hour < 17 ? Shift.LUNCH : Shift.DINNER);
    }
  }, [viewMode, selectedShift]);

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
  const filteredReservations = reservations.filter(r => {
    const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
    const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
    const matchesStatus = filterStatus === 'ALL' ? true : r.payment_status === filterStatus;
    const matchesSearch = r.customer_name ? r.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) : true;
    return matchesDate && matchesStatus && matchesShift && matchesSearch;
  });

  // Date Navigation Helpers
  const selectedDateObj = new Date(selectedDate);
  const todayStr = new Date().toISOString().split('T')[0];
  const selectedDateStr = selectedDate.split('T')[0];
  const isToday = selectedDateStr === todayStr;

  const goToPreviousDay = () => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() - 1);
    // Keep the same time
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(current.toISOString().split('T')[0] + 'T' + time);
  };

  const goToNextDay = () => {
    const current = new Date(selectedDate);
    current.setDate(current.getDate() + 1);
    // Keep the same time
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(current.toISOString().split('T')[0] + 'T' + time);
  };

  const goToToday = () => {
    const time = selectedDate.split('T')[1] || '12:00';
    setSelectedDate(new Date().toISOString().split('T')[0] + 'T' + time);
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
          showToast(`Conferma WhatsApp inviata a ${res.customer_name}`, 'success');
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
      const body = `Gentile ${res.customer_name},\n\nConfermiamo con piacere la sua prenotazione per:\nData: ${new Date(res.reservation_time).toLocaleDateString()}\nOra: ${new Date(res.reservation_time).toLocaleTimeString()}\nOspiti: ${res.guests}\n\nCordiali saluti,\nRistoManager Team`;
      
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
      showToast(`Promemoria inviato a ${res.customer_name}`, 'success');
  };

  const handleToggleArrivalStatus = (res: Reservation) => {
      const currentStatus = res.arrival_status || ArrivalStatus.WAITING;
      const newStatus = currentStatus === ArrivalStatus.WAITING ? ArrivalStatus.ARRIVED : ArrivalStatus.WAITING;
      onUpdateReservation({ ...res, arrival_status: newStatus });
      showToast(
          newStatus === ArrivalStatus.ARRIVED
              ? `${res.customer_name} è arrivato`
              : `${res.customer_name} è in attesa`,
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

  // --- Helper Logic ---

  const isTableOccupied = (table_id: number, checkDate: string, checkShift: Shift) => {
    return reservations.some(r => 
        r.table_id === table_id && 
        r.reservation_time.split('T')[0] === checkDate && 
        r.shift === checkShift && 
        r.id !== formData.id 
    );
  };

  const getReservationForTable = (table_id: number) => {
      return reservations.find(r => 
          r.table_id === table_id && 
          r.reservation_time.split('T')[0] === selectedDate.split('T')[0] && 
          r.shift === selectedShift
      );
  }

  const getReservationForTableInForm = (table_id: number) => {
      if (!formData.reservation_time || !formData.shift) return null;
      return reservations.find(r => 
          r.table_id === table_id && 
          r.reservation_time.split('T')[0] === formData.reservation_time!.split('T')[0] && 
          r.shift === formData.shift &&
          r.id !== formData.id 
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
      case PaymentStatus.PAID_FULL: return 'bg-emerald-100 text-emerald-700 border-emerald-200';
      case PaymentStatus.PAID_DEPOSIT: return 'bg-blue-100 text-blue-700 border-blue-200';
      case PaymentStatus.PENDING: return 'bg-amber-100 text-amber-700 border-amber-200';
      case PaymentStatus.REFUNDED: return 'bg-red-100 text-red-700 border-red-200';
      default: return 'bg-gray-100';
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
            className={`absolute flex flex-col items-center justify-center border-2 shadow-sm transition-all select-none
                ${isOccupied 
                    ? 'bg-red-100 border-red-500 text-red-900 shadow-red-200 z-10 ring-2 ring-red-200' 
                    : 'bg-white border-emerald-300 text-emerald-700 hover:shadow-md hover:-translate-y-1'
                }
            `}
            style={{ 
                left: table.x,
                top: table.y,
                ...shapeStyles
            }}
            title={isOccupied ? `Occupato da: ${reservation.customer_name}` : 'Libero'}
            onClick={() => isOccupied && handleEditClick(reservation)}
        >
            <span className="font-bold text-sm truncate px-1 max-w-full">{table.name}</span>
            <span className="text-[10px] flex items-center gap-1 opacity-80">
                <Armchair size={10} /> {table.seats}
            </span>
            {isOccupied && (
                <div className="absolute -bottom-3 bg-red-600 text-white text-[9px] px-2 py-0.5 rounded-full whitespace-nowrap shadow-sm max-w-[120px] truncate border border-white">
                    {reservation.customer_name}
                </div>
            )}
        </div>
      );
  };

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Gestione Prenotazioni</h1>
          <p className="text-slate-500">Gestisci turni, tavoli e pagamenti.</p>
        </div>
        
        <div className="flex flex-wrap items-center gap-3">
            {canEdit && (
            <button
                onClick={handleOpenNew}
                className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all"
            >
                <Plus className="h-5 w-5" /> Nuova
            </button>
            )}

            <div className="flex bg-slate-100 p-1 rounded-xl">
                <button 
                   onClick={() => setViewMode('LIST')} 
                   className={`p-2 rounded-lg transition-all ${viewMode === 'LIST' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}
                   title="Vista Elenco"
                >
                    <List className="h-5 w-5" />
                </button>
                <button 
                   onClick={() => setViewMode('MAP')} 
                   className={`p-2 rounded-lg transition-all ${viewMode === 'MAP' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}
                   title="Vista Mappa Sala"
                >
                    <MapIcon className="h-5 w-5" />
                </button>
            </div>

            {/* Main Shift Toggle */}
            <div className="bg-slate-100 p-1 rounded-xl flex items-center gap-1">
                {viewMode === 'MAP' && (
                    <button
                        onClick={() => setSelectedShift('ALL')}
                        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${selectedShift === 'ALL' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                    >
                        Tutte
                    </button>
                )}
                <button
                    onClick={() => setSelectedShift(Shift.LUNCH)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${selectedShift === Shift.LUNCH ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    <Sun className="h-4 w-4" /> Pranzo
                </button>
                <button
                    onClick={() => setSelectedShift(Shift.DINNER)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${selectedShift === Shift.DINNER ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    <Moon className="h-4 w-4" /> Cena
                </button>
            </div>
        </div>
      </div>

      {/* Search & Filters Bar */}
      <div className="flex flex-wrap items-center gap-4 bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
            <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-slate-400 h-5 w-5" />
                <input 
                    type="text" 
                    placeholder="Cerca prenotazione..." 
                    className="w-full pl-10 pr-4 py-2 rounded-xl border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:outline-none bg-slate-50"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                />
            </div>
            <div className="h-8 w-px bg-slate-200 hidden sm:block"></div>

            {/* Clock + Date Navigation */}
            <div className="flex flex-wrap items-center gap-2 md:gap-3">
                <div className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 px-4 py-2.5">
                    <Clock className="h-5 w-5 text-indigo-600" />
                    <span className="font-mono text-lg font-semibold text-slate-700 tabular-nums">
                        {currentTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                </div>

                <div className="flex items-center gap-1 bg-white rounded-xl border border-slate-200 p-1.5">
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
                        <div className="flex items-center gap-2 px-4 py-2 hover:bg-slate-50 rounded-lg transition-colors pointer-events-none">
                            <Calendar className="h-5 w-5 text-indigo-600" />
                            <span className="font-semibold text-base lg:text-lg text-slate-700 capitalize min-w-[220px] lg:min-w-[260px] text-center">
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
                        className="p-2.5 hover:bg-slate-100 rounded-lg transition-colors"
                        aria-label="Giorno successivo"
                    >
                        <ChevronRight className="h-5 w-5 text-slate-600" />
                    </button>
                </div>
            </div>
      </div>

      {/* --- LIST VIEW --- */}
      {viewMode === 'LIST' && (
          <div className="grid gap-4 animate-in fade-in duration-300">
            {filteredReservations.length === 0 ? (
                <div className="text-center py-20 bg-white rounded-2xl border border-dashed border-slate-300">
                    <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-slate-100 mb-4">
                    {selectedShift === Shift.LUNCH ? <Sun className="h-8 w-8 text-amber-400" /> : selectedShift === Shift.DINNER ? <Moon className="h-8 w-8 text-indigo-400" /> : <Calendar className="h-8 w-8 text-slate-400" />}
                    </div>
                    <h3 className="text-lg font-medium text-slate-900">Nessuna prenotazione</h3>
                    <p className="text-slate-500">
                        Non ci sono prenotazioni{selectedShift === 'ALL' ? '' : ` per il turno di <b>${selectedShift === Shift.LUNCH ? 'Pranzo' : 'Cena'}</b>`} in questa data.
                    </p>
                    <button
                        onClick={handleOpenNew}
                        className="mt-4 px-4 py-2 bg-white border border-slate-200 shadow-sm rounded-lg text-indigo-600 font-medium hover:bg-slate-50 transition-colors"
                    >
                        Aggiungine una ora
                    </button>
                </div>
            ) : (
                filteredReservations.map(res => {
                    const table = displayTables.find(t => t.id === res.table_id);
                    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
                    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
                    const borderColor = arrivalStatus === ArrivalStatus.ARRIVED ? 'border-l-orange-500' : 'border-l-emerald-500';

                    return (
                        <div key={res.id} className={`bg-white p-5 rounded-xl border border-slate-200 border-l-4 ${borderColor} shadow-sm hover:shadow-md transition-shadow flex flex-col lg:flex-row lg:items-center justify-between gap-4`}>
                            <div className="flex-1">
                                <div className="flex items-center gap-3 mb-2">
                                    <h3 className="font-bold text-lg text-slate-800">{res.customer_name}</h3>
                                    {/* Payment status - only show if paid */}
                                    {res.payment_status !== PaymentStatus.PENDING && (
                                        <span className={`text-xs font-bold px-2 py-0.5 rounded border ${getStatusColor(res.payment_status)}`}>
                                            {res.payment_status === PaymentStatus.PAID_FULL ? 'SALDATO' : 'ACCONTO'}
                                        </span>
                                    )}
                                </div>
                                <div className="flex flex-wrap items-center gap-4 text-sm text-slate-500">
                                    {/* Time with lateness indicator */}
                                    {(() => {
                                        const minutesLate = getMinutesLate(res.reservation_time);
                                        const isToday = res.reservation_time.split('T')[0] === new Date().toISOString().split('T')[0];
                                        const clockColor = isToday && minutesLate >= 30 ? 'text-red-500'
                                            : isToday && minutesLate >= 15 ? 'text-orange-500'
                                            : 'text-slate-400';
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
                                    {/* Table & Room - Better highlighted */}
                                    {isLoadingMerges && res.table_id ? (
                                        <div className="flex items-center gap-2 bg-slate-100 text-slate-400 px-3 py-1 rounded-lg animate-pulse">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            <span className="text-xs">Caricamento tavolo…</span>
                                        </div>
                                    ) : table ? (
                                        <div className="flex items-center gap-2 bg-indigo-50 text-indigo-700 px-3 py-1 rounded-lg font-semibold">
                                            <span className="text-indigo-900 font-bold">T. {table.name}</span>
                                            <span className="text-indigo-500">•</span>
                                            <span>{rooms.find(r => r.id === table.room_id)?.name}</span>
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1 text-rose-500 font-medium bg-rose-50 px-3 py-1 rounded-lg">
                                            <AlertCircle className="h-3 w-3" /> Nessun Tavolo
                                        </div>
                                    )}
                                </div>
                                {menu && (
                                    <div className="mt-2 text-sm bg-slate-50 inline-block px-3 py-1 rounded border border-slate-200 text-slate-700">
                                        🍽️ Menu Banchetto: <b>{menu.name}</b> (€{menu.price_per_person}/pax)
                                    </div>
                                )}
                                {res.notes && <p className="text-xs text-slate-400 mt-2 italic">{res.notes}</p>}
                            </div>

                            <div className="flex flex-col sm:flex-row sm:items-center gap-4 border-t lg:border-t-0 lg:border-l border-slate-100 pt-4 lg:pt-0 lg:pl-6">
                                {/* Totale Stimato - Hidden for now */}
                                {/* <div className="text-right mr-4">
                                    <p className="text-xs text-slate-400">Totale Stimato</p>
                                    <p className="text-xl font-bold text-slate-800">
                                        €{menu ? (menu.price_per_person * res.guests).toFixed(2) : '0.00'}
                                    </p>
                                </div> */}

                                {/* Actions - Only shown in edit mode */}
                                {canEdit && (
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => handleToggleArrivalStatus(res)}
                                        className={`p-2 rounded-lg transition-colors ${
                                            arrivalStatus === ArrivalStatus.ARRIVED
                                                ? 'bg-orange-50 text-orange-600 hover:bg-orange-100'
                                                : 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100'
                                        }`}
                                        title={arrivalStatus === ArrivalStatus.ARRIVED ? 'Arrivato' : 'In attesa'}
                                    >
                                        <UserCheck className="h-5 w-5" />
                                    </button>

                                    <button
                                        onClick={() => handleEditClick(res)}
                                        className="p-2 bg-slate-50 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                                        title="Modifica"
                                    >
                                        <Edit2 className="h-5 w-5" />
                                    </button>
                                    <button
                                        onClick={() => handleDeleteClick(res.id, res.customer_name)}
                                        className="p-2 bg-rose-50 text-rose-600 hover:bg-rose-100 rounded-lg transition-colors"
                                        title="Elimina"
                                    >
                                        <Trash2 className="h-5 w-5" />
                                    </button>
                                </div>
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

          return (
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col h-[500px] sm:h-[600px] animate-in fade-in duration-300">
                  {/* Room Selector for Map */}
                  <div className="flex gap-2 mb-4 border-b border-slate-100 pb-2 overflow-x-auto scrollbar-hide">
                      {rooms.map(room => (
                          <button
                              key={room.id}
                              onClick={() => setActiveMapRoomId(room.id)}
                              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ${
                                  activeMapRoomId === room.id
                                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                              }`}
                          >
                              {room.name}
                          </button>
                      ))}
                  </div>

                  {/* Map Canvas */}
                  <div
                    className="flex-1 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 relative overflow-auto"
                    style={{
                        backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
                        backgroundSize: window.innerWidth < 768 ? '15px 15px' : '20px 20px'
                    }}
                  >
                       {isLoadingMerges && (
                           <div className="absolute inset-0 z-30 bg-slate-50/70 backdrop-blur-[1px] flex items-center justify-center">
                               <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-sm border border-slate-200">
                                   <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                                   <span className="text-sm text-slate-600">Caricamento tavoli…</span>
                               </div>
                           </div>
                       )}
                       {tablesInRoom.map(renderMapTable)}
    
                       {/* Legend Overlay */}
                       <div className="absolute bottom-4 right-4 bg-white/90 backdrop-blur p-3 rounded-xl shadow-sm border border-slate-200 text-xs space-y-2">
                           <div className="font-semibold text-slate-700 mb-1">Legenda</div>
                           <div className="flex items-center gap-2 text-emerald-700">
                               <div className="w-3 h-3 bg-white border border-emerald-400 rounded-sm"></div> Libero
                           </div>
                           <div className="flex items-center gap-2 text-red-700">
                               <div className="w-3 h-3 bg-red-100 border border-red-500 rounded-sm"></div> Occupato
                           </div>
                           <div className="border-t border-slate-200 mt-2 pt-2">
                                <div className="font-semibold text-slate-700">Occupazione:</div>
                                <div className="text-sm">
                                    <span className="font-bold">{occupiedTablesCount}</span> / {totalTablesInRoom} tavoli (<span className="font-bold">{occupancyPercentage}%</span>)
                                </div>
                           </div>
                       </div>
                  </div>
              </div>
          );
      })()}

      {/* Reservation Modal */}
      {isFormOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-0 sm:p-4">
            <div className="bg-white rounded-none sm:rounded-2xl shadow-2xl w-full sm:max-w-5xl overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col h-full sm:max-h-[90vh]">
                <div className="p-3 sm:p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <h2 className="text-lg sm:text-xl font-bold text-slate-800">{isEditing ? 'Modifica Prenotazione' : 'Nuova Prenotazione'}</h2>
                    <button onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }} className="text-slate-400 hover:text-slate-600">
                        <X className="h-5 w-5 sm:h-6 sm:w-6" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <form id="reservation-form" onSubmit={handleSubmit} className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 sm:gap-8">
                        {/* Left Column: Details (5 cols) */}
                        <div className="lg:col-span-5 space-y-5 sm:space-y-6">
                            <div className="flex items-center gap-3 pb-3 border-b-2 border-slate-100">
                                <div className="w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
                                    <Users className="h-5 w-5 text-indigo-600" />
                                </div>
                                <div>
                                    <h3 className="font-bold text-base sm:text-lg text-slate-900">Dettagli Prenotazione</h3>
                                    <p className="text-xs text-slate-500">Compila i dati del cliente</p>
                                </div>
                            </div>
                            {/* Customer Name with Voice Input */}
                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Nome Cliente</label>
                                <div className="flex gap-2">
                                    <input
                                        required
                                        className="flex-1 rounded-xl border-2 border-slate-200 p-3 sm:p-4 text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white transition-all"
                                        value={formData.customer_name}
                                        onChange={e => setFormData({...formData, customer_name: e.target.value})}
                                        placeholder="Mario Rossi"
                                    />
                                    {isVoiceSupported() && (
                                        <button
                                            type="button"
                                            onClick={handleVoiceInput}
                                            disabled={isListening}
                                            className={`p-3 sm:p-4 rounded-xl transition-all flex items-center justify-center ${
                                                isListening
                                                    ? 'bg-red-100 text-red-600 animate-pulse'
                                                    : 'bg-indigo-100 text-indigo-600 hover:bg-indigo-200'
                                            }`}
                                            title="Dettatura vocale - Es: 'Prenotazione per Mario Rossi domani sera alle 20 per 4 persone'"
                                        >
                                            <Mic className="h-5 w-5" />
                                        </button>
                                    )}
                                </div>
                                {isVoiceSupported() && (
                                    <p className="text-xs text-slate-400 mt-1">
                                        Premi il microfono e detta: "Prenotazione per Mario Rossi domani alle 20 per 4 persone"
                                    </p>
                                )}
                            </div>

                            {/* Phone & Email */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Telefono</label>
                                    <input
                                        type="tel"
                                        className="w-full rounded-xl border-2 border-slate-200 p-3 sm:p-4 text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white transition-all"
                                        value={formData.phone || ''}
                                        onChange={e => setFormData({...formData, phone: e.target.value})}
                                        placeholder="+39 333..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Email</label>
                                    <input
                                        type="email"
                                        className="w-full rounded-xl border-2 border-slate-200 p-3 sm:p-4 text-base focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white transition-all"
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@email.com"
                                    />
                                </div>
                            </div>

                            {/* Date & Shift */}
                            <div className="space-y-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Turno</label>
                                    <div className="bg-slate-100 p-1.5 rounded-xl flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.LUNCH, reservation_time: `${currentDate}T13:00`});
                                            }}
                                            className={`flex w-full items-center justify-center gap-2 px-4 py-3.5 rounded-lg text-sm font-semibold transition-all ${formData.shift === Shift.LUNCH ? 'bg-white text-amber-600 shadow-md' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Sun className="h-5 w-5" /> Pranzo
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                const currentDate = formData.reservation_time?.split('T')[0] || new Date().toISOString().split('T')[0];
                                                setFormData({...formData, shift: Shift.DINNER, reservation_time: `${currentDate}T20:00`});
                                            }}
                                            className={`flex w-full items-center justify-center gap-2 px-4 py-3.5 rounded-lg text-sm font-semibold transition-all ${formData.shift === Shift.DINNER ? 'bg-white text-indigo-600 shadow-md' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Moon className="h-5 w-5" /> Cena
                                        </button>
                                    </div>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <div className="overflow-hidden">
                                        <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Data</label>
                                        <div className="relative">
                                            <input
                                                type="date"
                                                required
                                                className="w-full rounded-xl border-2 border-slate-200 p-3 pl-11 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white cursor-pointer transition-all"
                                                value={formData.reservation_time?.split('T')[0] || ''}
                                                onChange={e => {
                                                    const currentTime = formData.reservation_time?.split('T')[1] || '20:00';
                                                    setFormData({...formData, reservation_time: `${e.target.value}T${currentTime}`});
                                                }}
                                            />
                                            <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400 pointer-events-none" />
                                        </div>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Ora</label>
                                        <div className="relative">
                                            <select
                                                required
                                                className="w-full rounded-xl border-2 border-slate-200 p-3 pl-11 text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white cursor-pointer transition-all appearance-none"
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
                                            <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400 pointer-events-none" />
                                            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-5 w-5 text-slate-400 pointer-events-none" />
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {/* Guests */}
                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-2 uppercase tracking-wide">Numero Ospiti</label>
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, guests: Math.max(1, (formData.guests || 2) - 1)})}
                                        className="w-14 h-14 sm:w-16 sm:h-14 rounded-xl bg-slate-200 text-slate-700 font-bold text-2xl hover:bg-slate-300 transition-all flex items-center justify-center flex-shrink-0"
                                    >
                                        −
                                    </button>
                                    <input
                                        type="number"
                                        min="1"
                                        required
                                        className="flex-1 min-w-0 rounded-xl border-2 border-slate-200 p-3 text-center text-2xl font-bold focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none bg-white transition-all"
                                        value={formData.guests || ''}
                                        onChange={e => setFormData({...formData, guests: parseInt(e.target.value) || undefined})}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setFormData({...formData, guests: (formData.guests || 2) + 1})}
                                        className="w-14 h-14 sm:w-16 sm:h-14 rounded-xl bg-indigo-500 text-white font-bold text-2xl hover:bg-indigo-600 transition-all flex items-center justify-center flex-shrink-0"
                                    >
                                        +
                                    </button>
                                </div>
                            </div>

                            {/* Expandable Sections */}
                            <div className="space-y-3">
                                {/* Allergens Button */}
                                <div className="rounded-xl border-2 border-slate-200 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShowAllergensSection(!showAllergensSection)}
                                        className={`w-full flex items-center justify-between p-4 transition-all ${
                                            showAllergensSection ? 'bg-red-50' : 'bg-white hover:bg-slate-50'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                                                selectedAllergens.length > 0 ? 'bg-red-100' : 'bg-slate-100'
                                            }`}>
                                                <AlertTriangle className={`w-5 h-5 ${selectedAllergens.length > 0 ? 'text-red-600' : 'text-slate-500'}`} />
                                            </div>
                                            <div className="text-left">
                                                <span className="font-semibold text-slate-800">Intolleranze</span>
                                                {selectedAllergens.length > 0 && (
                                                    <p className="text-xs text-red-600 font-medium">{selectedAllergens.length} selezionate</p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${showAllergensSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showAllergensSection && (
                                        <div className="p-4 pt-0 space-y-3 border-t border-slate-100 bg-white">
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
                                                            className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all text-left ${
                                                                isSelected
                                                                    ? 'border-red-400 bg-red-50 text-red-700'
                                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                                                            }`}
                                                        >
                                                            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                                                                isSelected ? 'bg-red-500 border-red-500' : 'border-slate-300 bg-white'
                                                            }`}>
                                                                {isSelected && <Check className="text-white w-3 h-3" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{allergen}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                            {selectedAllergens.length > 0 && (
                                                <div className="flex flex-wrap gap-1.5 pt-2">
                                                    {selectedAllergens.map(allergen => (
                                                        <span key={allergen} className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-100 text-red-700 rounded-full text-xs font-medium">
                                                            {allergen}
                                                            <button
                                                                type="button"
                                                                onClick={() => setSelectedAllergens(prev => prev.filter(a => a !== allergen))}
                                                                className="hover:text-red-900"
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
                                <div className="rounded-xl border-2 border-slate-200 overflow-hidden">
                                    <button
                                        type="button"
                                        onClick={() => setShowNotesSection(!showNotesSection)}
                                        className={`w-full flex items-center justify-between p-4 transition-all ${
                                            showNotesSection ? 'bg-amber-50' : 'bg-white hover:bg-slate-50'
                                        }`}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                                                (selectedQuickNotes.length > 0 || formData.notes) ? 'bg-amber-100' : 'bg-slate-100'
                                            }`}>
                                                <StickyNote className={`w-5 h-5 ${(selectedQuickNotes.length > 0 || formData.notes) ? 'text-amber-600' : 'text-slate-500'}`} />
                                            </div>
                                            <div className="text-left">
                                                <span className="font-semibold text-slate-800">Note</span>
                                                {selectedQuickNotes.length > 0 && (
                                                    <p className="text-xs text-amber-600 font-medium">{selectedQuickNotes.join(', ')}</p>
                                                )}
                                            </div>
                                        </div>
                                        <ChevronDown className={`w-5 h-5 text-slate-400 transition-transform ${showNotesSection ? 'rotate-180' : ''}`} />
                                    </button>

                                    {showNotesSection && (
                                        <div className="p-4 pt-0 space-y-4 border-t border-slate-100 bg-white">
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
                                                            className={`flex items-center gap-2 p-3 rounded-xl border-2 transition-all text-left ${
                                                                isSelected
                                                                    ? 'border-amber-400 bg-amber-50 text-amber-700'
                                                                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
                                                            }`}
                                                        >
                                                            <div className={`w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                                                                isSelected ? 'bg-amber-500 border-amber-500' : 'border-slate-300 bg-white'
                                                            }`}>
                                                                {isSelected && <Check className="text-white w-3 h-3" />}
                                                            </div>
                                                            <span className="text-sm font-medium truncate">{note}</span>
                                                        </button>
                                                    );
                                                })}
                                            </div>

                                            {/* Free text notes */}
                                            <div>
                                                <label className="block text-xs font-medium text-slate-500 mb-2 uppercase">Altre note</label>
                                                <textarea
                                                    className="w-full rounded-xl border-2 border-slate-200 p-3 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none h-20 text-base bg-white resize-none transition-all"
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
                        <div className="lg:col-span-7 flex flex-col h-full border-t lg:border-t-0 lg:border-l border-slate-100 pt-6 lg:pt-0 lg:pl-8">
                             {/* Section Header */}
                             <div className="flex items-center gap-3 pb-4 mb-4 border-b-2 border-slate-100">
                                <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                                    <MapPin className="h-5 w-5 text-emerald-600" />
                                </div>
                                <div className="flex-1">
                                    <h3 className="font-bold text-base sm:text-lg text-slate-900">Seleziona Tavolo</h3>
                                    <p className="text-xs text-slate-500">
                                        {formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'} - {' '}
                                        <span className="font-semibold text-emerald-600">{freeTablesCount} tavoli liberi</span> su {totalTablesInFilter}
                                    </p>
                                </div>
                                {selectedTableObj && (
                                    <div className="flex items-center gap-1">
                                        <span className="px-3 py-1.5 text-emerald-700 bg-emerald-50 rounded-l-xl text-sm font-semibold border-2 border-r-0 border-emerald-200">
                                            T. {selectedTableObj.name}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setFormData({...formData, table_id: undefined});
                                                showToast('Tavolo rimosso dalla prenotazione', 'info');
                                            }}
                                            className="px-2 py-1.5 text-rose-600 bg-rose-50 rounded-r-xl text-sm font-semibold border-2 border-rose-200 hover:bg-rose-100 transition-colors"
                                            title="Rimuovi tavolo"
                                        >
                                            <X className="h-4 w-4" />
                                        </button>
                                    </div>
                                )}
                             </div>

                             {/* Auto-assign & Actions */}
                             <div className="flex items-center justify-between gap-3 mb-4">
                                <div className="flex items-center gap-2">
                                    <button
                                        type="button"
                                        onClick={handleAutoAssign}
                                        className="flex items-center gap-2 bg-indigo-100 text-indigo-700 px-4 py-2.5 rounded-xl hover:bg-indigo-200 transition-colors font-semibold text-sm"
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
                                        className={`flex items-center gap-2 px-4 py-2.5 rounded-xl transition-colors font-semibold text-sm ${
                                            mergeMode
                                                ? 'bg-purple-600 text-white shadow-lg shadow-purple-200'
                                                : 'bg-purple-100 text-purple-700 hover:bg-purple-200'
                                        }`}
                                    >
                                        <Combine className="h-4 w-4" /> {mergeMode ? 'Esci Unione' : 'Unisci Tavoli'}
                                    </button>
                                </div>

                                <div className="flex gap-2 items-center">
                                    {/* Show selected tables count and total capacity */}
                                    {selectedTablesForMerge.length >= 1 && (
                                        <div className="text-sm text-purple-700 bg-purple-50 px-3 py-2 rounded-xl font-medium">
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
                                            className="flex items-center gap-1.5 bg-purple-600 text-white px-3 py-2 rounded-xl hover:bg-purple-700 transition-colors font-medium text-sm shadow-lg"
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
                                            className="flex items-center gap-1.5 bg-amber-100 text-amber-700 px-3 py-2 rounded-xl hover:bg-amber-200 transition-colors font-medium text-sm"
                                        >
                                            <Scissors className="h-4 w-4" /> Dividi
                                        </button>
                                    )}
                                </div>
                             </div>

                             {/* Room Tabs */}
                             <div className="mb-4">
                                 <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-3">Sale</p>
                                 <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
                                     <button
                                        type="button"
                                        onClick={() => setModalRoomFilter('ALL')}
                                        className={`px-4 py-2.5 text-sm font-semibold rounded-xl whitespace-nowrap transition-all flex-shrink-0 ${modalRoomFilter === 'ALL' ? 'bg-slate-800 text-white shadow-lg' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                     >
                                         Tutte le sale
                                     </button>
                                     {rooms.map(room => (
                                         <button
                                            key={room.id}
                                            type="button"
                                            onClick={() => setModalRoomFilter(room.id)}
                                            className={`px-4 py-2.5 text-sm font-semibold rounded-xl whitespace-nowrap transition-all flex-shrink-0 ${modalRoomFilter === room.id ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                         >
                                             {room.name}
                                         </button>
                                     ))}
                                 </div>
                             </div>

                             <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 p-2 sm:p-4 overflow-y-auto max-h-[300px] sm:max-h-[400px] relative">
                                {isLoadingMerges && (
                                    <div className="absolute inset-0 z-20 bg-slate-50/70 backdrop-blur-[1px] flex items-center justify-center rounded-xl">
                                        <div className="flex items-center gap-2 px-4 py-2 bg-white rounded-lg shadow-sm border border-slate-200">
                                            <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                                            <span className="text-sm text-slate-600">Caricamento tavoli…</span>
                                        </div>
                                    </div>
                                )}
                                {displayedRooms.map(room => (
                                    <div key={room.id} className="mb-4 sm:mb-6 last:mb-0">
                                        <h4 className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase mb-2 sticky top-0 bg-slate-50 py-1 z-10">{room.name}</h4>
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
                                                            relative p-2 sm:p-3 rounded-lg sm:rounded-xl border-2 text-center transition-all group
                                                            ${isSelectedForMerge
                                                                ? 'border-purple-600 bg-purple-50 ring-2 ring-purple-200 z-10'
                                                                : isSelected
                                                                    ? 'border-indigo-600 bg-indigo-50 ring-2 ring-indigo-200 z-10'
                                                                    : isOccupied
                                                                        ? 'border-red-500 bg-red-100 opacity-90 cursor-not-allowed'
                                                                        : fitsGuests
                                                                            ? 'border-white bg-white shadow-sm hover:border-indigo-300 hover:shadow-md hover:-translate-y-0.5'
                                                                            : 'border-slate-200 bg-slate-100 opacity-50'
                                                            }
                                                        `}
                                                    >
                                                        {/* Merged Table Badge */}
                                                        {isMerged && !isOccupied && (
                                                            <div className="absolute -top-1.5 sm:-top-2 -left-1.5 sm:-left-2 bg-indigo-600 text-white text-[8px] sm:text-[10px] font-bold px-1 sm:px-1.5 py-0.5 rounded-full shadow-sm flex items-center gap-0.5 border border-white z-20">
                                                                <Combine size={6} className="sm:hidden" />
                                                                <Combine size={8} className="hidden sm:block" />
                                                            </div>
                                                        )}

                                                        <div className={`text-xs sm:text-sm font-bold truncate ${isSelectedForMerge ? 'text-purple-700' : isSelected ? 'text-indigo-700' : isOccupied ? 'text-red-900' : 'text-slate-700'}`}>
                                                            {table.name}
                                                        </div>
                                                        <div className={`text-[9px] sm:text-[10px] flex justify-center items-center gap-0.5 sm:gap-1 mt-0.5 sm:mt-1 ${isOccupied ? 'text-red-800' : 'text-slate-500'}`}>
                                                            <Users size={8} className="sm:hidden" />
                                                            <Users size={10} className="hidden sm:block" />
                                                            {table.seats}
                                                        </div>
                                                        {isOccupied && occupiedReservation && (
                                                            <>
                                                                <div className="absolute inset-0 flex items-center justify-center bg-red-100/50 rounded-xl">
                                                                    <span className="text-[11px] sm:text-xs font-bold text-red-700 bg-white/90 px-2.5 py-1 rounded-lg shadow-sm border border-red-200 -mt-14 sm:-mt-16">OCCUPATO</span>
                                                                </div>
                                                                <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex justify-center">
                                                                    <div className="bg-red-600 text-white text-[11px] sm:text-xs font-medium px-2.5 py-1 rounded-full whitespace-nowrap shadow-md max-w-[120px] truncate border-2 border-white">
                                                                        {occupiedReservation.customer_name}
                                                                    </div>
                                                                </div>
                                                            </>
                                                        )}
                                                        {isSelected && !isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-indigo-600 text-white rounded-full p-0.5 shadow-sm z-20">
                                                                <div className="w-1.5 h-1.5 bg-white rounded-full m-1" />
                                                            </div>
                                                        )}
                                                        {isSelectedForMerge && (
                                                            <div className="absolute -top-2 -right-2 bg-purple-600 text-white rounded-full p-0.5 shadow-sm z-20">
                                                                <div className="w-1.5 h-1.5 bg-white rounded-full m-1" />
                                                            </div>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))}
                                {displayedRooms.length === 0 && (
                                    <div className="text-center py-10 text-slate-400">
                                        Nessuna sala trovata.
                                    </div>
                                )}
                             </div>
                             <div className="mt-3 flex flex-col gap-2 px-1">
                                 <div className="flex flex-wrap gap-4 text-[10px] text-slate-500">
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-white border border-slate-200 shadow-sm rounded"></div> Libero</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-indigo-50 border-2 border-indigo-600 rounded"></div> Selezionato</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-purple-50 border-2 border-purple-600 rounded"></div> Multi-selezione</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-slate-200 border border-slate-200 rounded"></div> Occupato</div>
                                     <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-slate-100 border border-slate-200 rounded opacity-50"></div> Capienza Insufficiente</div>
                                     <div className="flex items-center gap-1.5">
                                         <div className="w-3 h-3 bg-indigo-600 text-white rounded-full flex items-center justify-center">
                                             <Combine size={6} className="text-white" />
                                         </div>
                                         Tavolo Unito
                                     </div>
                                 </div>
                                 {mergeMode ? (
                                     <div className="text-[10px] text-purple-600 font-medium bg-purple-50 px-2 py-1 rounded-lg">
                                         🔗 Modalità unione attiva: clicca sui tavoli da unire, poi premi "Conferma Unione"
                                     </div>
                                 ) : (
                                     <div className="text-[10px] text-slate-400 italic">
                                         💡 Usa il pulsante "Unisci Tavoli" per combinare più tavoli per grandi gruppi
                                     </div>
                                 )}
                             </div>
                        </div>
                    </form>
                </div>

                <div className="p-3 sm:p-5 border-t border-slate-100 bg-slate-50 flex justify-end gap-2 sm:gap-3">
                    <button
                        type="button"
                        onClick={() => { setIsFormOpen(false); setMergeMode(false); setSelectedTablesForMerge([]); }}
                        className="px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl border border-slate-300 text-slate-700 text-sm sm:text-base font-medium hover:bg-white transition-colors"
                    >
                        Annulla
                    </button>
                    {mergeMode && selectedTablesForMerge.length > 0 && (
                        <span className="text-xs text-amber-600 bg-amber-50 px-3 py-2 rounded-lg">
                            ⚠️ Conferma l'unione tavoli prima di salvare
                        </span>
                    )}
                    <button
                        onClick={handleSubmit}
                        disabled={mergeMode && selectedTablesForMerge.length > 0}
                        className={`px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl text-sm sm:text-base font-medium transition-all ${
                            mergeMode && selectedTablesForMerge.length > 0
                                ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                                : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-lg shadow-indigo-200'
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
                <div className="p-6 border-b border-slate-100">
                    <h3 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                        <span className="text-2xl">{confirmModal.title}</span>
                    </h3>
                </div>

                <div className="p-6 space-y-4">
                    <p className="text-slate-700 leading-relaxed whitespace-pre-line">
                        {confirmModal.message}
                    </p>

                    {confirmModal.suggestions && confirmModal.suggestions.length > 0 && (
                        <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-4">
                            <p className="text-sm font-semibold text-indigo-900 mb-3">
                                Tavoli disponibili con capienza adeguata:
                            </p>
                            <div className="space-y-2">
                                {confirmModal.suggestions.map((suggestion, index) => (
                                    <button
                                        key={index}
                                        onClick={() => confirmModal.onSelectSuggestion?.(suggestion.table)}
                                        className="w-full flex items-center justify-between gap-3 p-3 bg-white border-2 border-indigo-300 rounded-lg hover:border-indigo-500 hover:bg-indigo-50 transition-all group"
                                    >
                                        <div className="flex items-center gap-2 text-indigo-700">
                                            <Armchair size={16} className="text-indigo-500" />
                                            <span className="text-sm font-medium">{suggestion.label}</span>
                                        </div>
                                        <div className="text-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <Check size={18} />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-6 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                    <button
                        onClick={confirmModal.onCancel}
                        className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-medium hover:bg-white transition-colors"
                    >
                        Annulla
                    </button>
                    <button
                        onClick={confirmModal.onConfirm}
                        className="px-5 py-2.5 bg-amber-600 text-white rounded-xl font-medium hover:bg-amber-700 shadow-lg shadow-amber-200 transition-all"
                    >
                        Procedi Comunque
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmModal.show && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-6 text-center">
              <div className="mx-auto w-16 h-16 bg-rose-100 rounded-full flex items-center justify-center mb-4">
                <Trash2 className="h-8 w-8 text-rose-600" />
              </div>
              <h3 className="text-xl font-bold text-slate-800 mb-2">Conferma Eliminazione</h3>
              <p className="text-slate-600 mb-1">
                Stai per eliminare la prenotazione di:
              </p>
              <p className="text-lg font-semibold text-slate-800 mb-4">
                {deleteConfirmModal.customerName}
              </p>
              <p className="text-sm text-slate-500">
                Questa azione non può essere annullata.
              </p>
            </div>
            <div className="flex border-t border-slate-100">
              <button
                onClick={handleCancelDelete}
                className="flex-1 px-6 py-4 text-slate-700 font-medium hover:bg-slate-50 transition-colors border-r border-slate-100"
              >
                Annulla
              </button>
              <button
                onClick={handleConfirmDelete}
                className="flex-1 px-6 py-4 text-rose-600 font-medium hover:bg-rose-50 transition-colors"
              >
                Elimina
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
