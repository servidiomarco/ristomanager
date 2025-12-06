import React, { useState, useEffect } from 'react';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus } from '../types';
import { Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, MapPin, Filter, Map as MapIcon, List, MessageCircle, Mail, Armchair, Search, BellRing, CheckSquare, Square, UserCheck, Combine, Scissors, Check } from 'lucide-react';
import { sendWhatsAppConfirmation } from '../services/apiService';

interface ReservationListProps {
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  tables: Table[];
  rooms: Room[];
  onUpdateReservation: (r: Reservation) => void;
  onAddReservation: (r: Omit<Reservation, 'id'>) => void;
  onDeleteReservation: (id: number) => void;
  onMergeTables: (tableIds: number[]) => Promise<void>;
  onSplitTable: (tableId: number) => Promise<void>;
  onUpdateTable: (table: Table) => Promise<void>;
  showToast: (msg: string, type: 'success' | 'error' | 'info') => void;
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
  showToast
}) => {
  // Main View State
  const [viewMode, setViewMode] = useState<'LIST' | 'MAP'>('LIST');
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().substring(0, 16));
  const [selectedShift, setSelectedShift] = useState<Shift | 'ALL'>('ALL');
  const [filterStatus, setFilterStatus] = useState<string>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
    const [activeMapRoomId, setActiveMapRoomId] = useState<string | number>('ALL');

  useEffect(() => {
    if (rooms.length > 0 && activeMapRoomId === 'ALL') {
      setActiveMapRoomId(rooms[0].id);
    }
  }, [rooms, activeMapRoomId]);

  // Modal/Form State
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [modalRoomFilter, setModalRoomFilter] = useState<string | number>('ALL');
  const [selectedTablesForMerge, setSelectedTablesForMerge] = useState<number[]>([]);

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

  const [formData, setFormData] = useState<Partial<Reservation>>({
      customer_name: '',
      guests: 2,
      reservation_time: new Date().toISOString().substring(0, 16),
      shift: Shift.DINNER,
      payment_status: PaymentStatus.PENDING,
      table_id: undefined,
      enable_reminder: true,
      reminder_sent: false,
      arrival_status: ArrivalStatus.WAITING
  });

  useEffect(() => {
    if (formData.reservation_time) {
      const hour = new Date(formData.reservation_time).getHours();
      if (hour >= 11 && hour < 17) {
        setFormData(d => ({...d, shift: Shift.LUNCH}));
      } else {
        setFormData(d => ({...d, shift: Shift.DINNER}));
      }
    }
  }, [formData.reservation_time]);

  // Filter Logic for Main List
  const filteredReservations = reservations.filter(r => {
    const matchesDate = r.reservation_time.split('T')[0] === selectedDate.split('T')[0];
    const matchesShift = selectedShift === 'ALL' ? true : r.shift === selectedShift;
    const matchesStatus = filterStatus === 'ALL' ? true : r.payment_status === filterStatus;
    const matchesSearch = r.customer_name ? r.customer_name.toLowerCase().includes(searchTerm.toLowerCase()) : true;
    return matchesDate && matchesStatus && matchesShift && matchesSearch;
  });

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

  const handleEditClick = (res: Reservation) => {
      const formattedReservation = {
        ...res,
        reservation_time: new Date(res.reservation_time).toISOString().substring(0, 16)
      };
      setFormData(formattedReservation);
      const table = tables.find(t => t.id === res.table_id);
      setModalRoomFilter(table ? table.room_id : 'ALL');
      setIsEditing(true);
      setIsFormOpen(true);
  };

  const handleDeleteClick = (id: number) => {
      if(window.confirm("Sei sicuro di voler cancellare questa prenotazione?")) {
          onDeleteReservation(id);
      }
  }

  const handleOpenNew = () => {
      setFormData({
        customer_name: '',
        guests: 2,
        reservation_time: selectedDate,
        shift: selectedShift === 'ALL' ? Shift.DINNER : selectedShift,
        payment_status: PaymentStatus.PENDING,
        table_id: undefined,
        enable_reminder: true,
        reminder_sent: false,
        arrival_status: ArrivalStatus.WAITING
      });
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
          // Find suitable alternatives
          const suitableTables = tables
              .filter(t => t.seats >= guests)
              .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
              .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
              // Hide merged tables
              .filter(t => {
                  const isMergedIntoAnother = tables.some(other => {
                      if (other.merged_with && other.merged_with.length > 0) {
                          return other.merged_with.map(id => Number(id)).includes(Number(t.id));
                      }
                      return false;
                  });
                  return !isMergedIntoAnother;
              })
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

      const availableTables = tables
        .filter(t => t.seats >= (formData.guests || 0))
        .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
        .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
        // Hide merged tables
        .filter(t => {
            const isMergedIntoAnother = tables.some(other => {
                if (other.merged_with && other.merged_with.length > 0) {
                    return other.merged_with.map(id => Number(id)).includes(Number(t.id));
                }
                return false;
            });
            return !isMergedIntoAnother;
        })
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

      if (isEditing) {
          onUpdateReservation(formData as Reservation);
      } else {
          onAddReservation(formData as Omit<Reservation, 'id'>);
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
  const selectedTableObj = tables.find(t => t.id === formData.table_id);

  // Calculate Free Tables for the form header
  const totalTablesInFilter = tables.filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter).length;
  const occupiedTablesInFilter = tables.filter(t => (modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter) && isTableOccupied(t.id, formData.reservation_time!.split('T')[0], formData.shift!)).length;
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
            <button 
                onClick={handleOpenNew}
                className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all"
            >
                <Plus className="h-5 w-5" /> Nuova
            </button>

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
                <button
                    onClick={() => setSelectedShift('ALL')}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${selectedShift === 'ALL' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                    Tutte
                </button>
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
            <div className="flex items-center gap-4">
                <div className="flex items-center gap-2 px-3 relative group">
                    <Calendar className="text-indigo-500 h-5 w-5 absolute left-3 pointer-events-none" />
                    <input
                    type="datetime-local"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="outline-none text-slate-700 font-medium bg-transparent pl-8 cursor-pointer py-2"
                    />
                </div>
                {/* Status filter hidden for now */}
                {/* <select
                    className="outline-none text-slate-600 text-sm bg-transparent pr-2 py-2"
                    value={filterStatus}
                    onChange={(e) => setFilterStatus(e.target.value)}
                >
                    <option value="ALL">Tutti gli stati</option>
                    <option value={PaymentStatus.PENDING}>In Attesa</option>
                    <option value={PaymentStatus.PAID_DEPOSIT}>Acconto Versato</option>
                    <option value={PaymentStatus.PAID_FULL}>Saldato</option>
                </select> */}
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
                    const table = tables.find(t => t.id === res.table_id);
                    const menu = banquetMenus.find(m => m.id === res.banquet_menu_id);
                    const arrivalStatus = res.arrival_status || ArrivalStatus.WAITING;
                    const borderColor = arrivalStatus === ArrivalStatus.ARRIVED ? 'border-l-orange-500' : 'border-l-emerald-500';

                    return (
                        <div key={res.id} className={`bg-white p-5 rounded-xl border border-slate-200 border-l-4 ${borderColor} shadow-sm hover:shadow-md transition-shadow flex flex-col lg:flex-row lg:items-center justify-between gap-4`}>
                            <div className="flex-1">
                                <div className="flex items-center gap-3 mb-1">
                                    <h3 className="font-bold text-lg text-slate-800">{res.customer_name}</h3>
                                    <span className={`text-xs font-bold px-2 py-0.5 rounded border ${getStatusColor(res.payment_status)}`}>
                                        {res.payment_status === PaymentStatus.PAID_FULL ? 'SALDATO' : res.payment_status === PaymentStatus.PAID_DEPOSIT ? 'ACCONTO' : 'DA PAGARE'}
                                    </span>
                                    
                                </div>
                                <div className="flex flex-wrap gap-4 text-sm text-slate-500">
                                    <div className="flex items-center gap-1">
                                        <Clock className="h-4 w-4" /> {new Date(res.reservation_time).toLocaleString()}
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Users className="h-4 w-4" /> {res.guests} Ospiti
                                    </div>
                                    {table ? (
                                        <div className="flex items-center gap-1 text-indigo-600 font-medium">
                                            <div className="w-2 h-2 bg-indigo-500 rounded-full" /> Tavolo {table.name} ({rooms.find(r => r.id === table.room_id)?.name}) - {res.customer_name}
                                        </div>
                                    ) : (
                                        <div className="flex items-center gap-1 text-rose-500 font-medium">
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

                                <div className="flex items-center gap-2">
                                    {/* Confirmation Actions */}
                                    <button 
                                        onClick={() => handleSendWhatsapp(res)}
                                        className="p-2 bg-green-50 text-green-600 hover:bg-green-100 rounded-lg transition-colors"
                                        title="Invia conferma WhatsApp"
                                    >
                                        <MessageCircle className="h-5 w-5" />
                                    </button>
                                    <button 
                                        onClick={() => handleSendEmail(res)}
                                        className="p-2 bg-blue-50 text-blue-600 hover:bg-blue-100 rounded-lg transition-colors"
                                        title="Invia conferma Email"
                                    >
                                        <Mail className="h-5 w-5" />
                                    </button>

                                    {res.enable_reminder && (
                                        <button 
                                            onClick={() => handleSendReminder(res)}
                                                                                         className={`p-2 rounded-lg transition-colors ${res.reminder_sent ? 'bg-amber-100 text-amber-600' : 'bg-slate-50 text-slate-400 hover:bg-amber-50 hover:text-amber-600'}`}
                                                                                        title={res.reminder_sent ? "Promemoria già inviato" : "Invia Promemoria"}                                        >
                                            <BellRing className="h-5 w-5" />
                                        </button>
                                    )}

                                    <div className="w-px h-6 bg-slate-200 mx-1"></div>

                                    {/* Payment button - Hidden for now */}
                                    {/* {res.payment_status !== PaymentStatus.PAID_FULL && (
                                        <button
                                            onClick={() => handlePaymentAction(res)}
                                            className="p-2 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 rounded-lg transition-colors"
                                            title="Registra Pagamento"
                                        >
                                            <CreditCard className="h-5 w-5" />
                                        </button>
                                    )} */}

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
                                        onClick={() => handleDeleteClick(res.id)}
                                        className="p-2 bg-rose-50 text-rose-600 hover:bg-rose-100 rounded-lg transition-colors"
                                        title="Elimina"
                                    >
                                        <Trash2 className="h-5 w-5" />
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                })
            )}
          </div>
      )}

      {/* --- MAP VIEW --- */}
      {viewMode === 'MAP' && (() => {
          const tablesInRoom = tables
              .filter(t => t.room_id === activeMapRoomId)
              // Hide tables that are merged into another table
              .filter(t => {
                  const isMergedIntoAnother = tables.some(other => {
                      if (other.merged_with && other.merged_with.length > 0) {
                          const mergedIds = other.merged_with.map(id => Number(id));
                          const tableId = Number(t.id);
                          return mergedIds.includes(tableId);
                      }
                      return false;
                  });
                  return !isMergedIntoAnother;
              });
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
                    <button onClick={() => setIsFormOpen(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="h-5 w-5 sm:h-6 sm:w-6" />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <form id="reservation-form" onSubmit={handleSubmit} className="p-3 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-8">
                        {/* Left Column: Details (4 cols) */}
                        <div className="lg:col-span-5 space-y-3 sm:space-y-4">
                            <h3 className="font-semibold text-sm sm:text-base text-slate-900 mb-2 flex items-center gap-2 border-b pb-2">
                                <Users className="h-4 w-4 text-indigo-500" /> Dettagli Cliente & Orario
                            </h3>
                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Nome Cliente</label>
                                <input
                                    required
                                    className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                    value={formData.customer_name}
                                    onChange={e => setFormData({...formData, customer_name: e.target.value})}
                                    placeholder="Mario Rossi"
                                />
                            </div>

                            <div className="grid grid-cols-2 gap-3 sm:gap-4">
                                 <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Telefono</label>
                                    <input
                                        className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                        value={formData.phone || ''}
                                        onChange={e => setFormData({...formData, phone: e.target.value})}
                                        placeholder="333..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Email</label>
                                    <input
                                        type="email"
                                        className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@mail.com"
                                    />
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-3 sm:gap-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Data e Ora</label>
                                    <div className="relative">
                                        <input
                                            type="datetime-local"
                                            required
                                            className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 pl-8 sm:pl-10 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white cursor-pointer"
                                            value={formData.reservation_time}
                                            onChange={e => setFormData({...formData, reservation_time: e.target.value})}
                                        />
                                        <Calendar className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 h-3 w-3 sm:h-4 sm:w-4 text-slate-400 pointer-events-none" />
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Turno</label>
                                    <div className="bg-slate-100 p-1 rounded-lg flex items-center gap-1 border border-slate-300">
                                        <button
                                            type="button"
                                            onClick={() => setFormData({...formData, shift: Shift.LUNCH})}
                                            className={`flex w-full items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all ${formData.shift === Shift.LUNCH ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Sun className="h-3 w-3 sm:h-4 sm:w-4" /> <span className="hidden xs:inline">Pranzo</span><span className="xs:hidden">P</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFormData({...formData, shift: Shift.DINNER})}
                                            className={`flex w-full items-center justify-center gap-1 px-2 sm:px-3 py-1.5 rounded-md text-xs sm:text-sm font-medium transition-all ${formData.shift === Shift.DINNER ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Moon className="h-3 w-3 sm:h-4 sm:w-4" /> <span className="hidden xs:inline">Cena</span><span className="xs:hidden">C</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Ospiti</label>
                                <input
                                    type="number"
                                    min="1"
                                    required
                                    className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                    value={formData.guests || ''}
                                    onChange={e => setFormData({...formData, guests: parseInt(e.target.value) || undefined})}
                                />
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Menu Banchetto</label>
                                <select
                                    className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 text-base focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                    value={formData.banquet_menu_id || ''}
                                    onChange={e => setFormData({...formData, banquet_menu_id: e.target.value ? parseInt(e.target.value) : undefined})}
                                >
                                    <option value="">Alla Carta</option>
                                    {banquetMenus.map(m => (
                                        <option key={m.id} value={m.id}>{m.name} (€{m.price_per_person} pp)</option>
                                    ))}
                                </select>
                            </div>

                            <div className="flex items-center gap-2 p-2 sm:p-3 bg-indigo-50 rounded-lg border border-indigo-100 cursor-pointer" onClick={() => setFormData({...formData, enable_reminder: !formData.enable_reminder})}>
                                <div className={`w-4 h-4 sm:w-5 sm:h-5 rounded border flex items-center justify-center flex-shrink-0 ${formData.enable_reminder ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'}`}>
                                    {formData.enable_reminder && <CheckSquare className="text-white w-2.5 h-2.5 sm:w-3 sm:h-3" />}
                                </div>
                                <label className="text-xs sm:text-sm text-slate-700 font-medium cursor-pointer select-none">Invia promemoria automatico 24h prima</label>
                            </div>

                             <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Note</label>
                                <textarea
                                    className="w-full rounded-lg border border-slate-300 p-2 sm:p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none h-16 sm:h-20 text-base bg-white"
                                    placeholder="Intolleranze, seggiolone..."
                                    value={formData.notes || ''}
                                    onChange={e => setFormData({...formData, notes: e.target.value})}
                                />
                            </div>
                        </div>

                        {/* Right Column: Table Selection (7 cols) */}
                        <div className="lg:col-span-7 flex flex-col h-full border-t lg:border-t-0 lg:border-l border-slate-100 pt-4 lg:pt-0 lg:pl-8">
                             <div className="flex flex-col gap-2 mb-3 sm:mb-4">
                                <div className="flex justify-between items-start gap-2">
                                    <div className="flex-1 min-w-0">
                                        <h3 className="font-semibold text-sm sm:text-base text-slate-900 flex items-center gap-2">
                                            <MapPin className="h-3 w-3 sm:h-4 sm:w-4 text-indigo-500 flex-shrink-0" />
                                            <span className="truncate">Seleziona Tavolo</span>
                                        </h3>
                                        {selectedTableObj && (
                                            <span className="inline-block mt-1 text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded text-xs border border-indigo-100 truncate max-w-full">
                                                {selectedTableObj.name} - {rooms.find(r => r.id === selectedTableObj.room_id)?.name}
                                            </span>
                                        )}
                                    </div>
                                    <div className="flex gap-1 sm:gap-2 flex-shrink-0">
                                        <button
                                            type="button"
                                            onClick={handleAutoAssign}
                                            className="text-[10px] sm:text-xs flex items-center gap-1 bg-indigo-50 text-indigo-700 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg hover:bg-indigo-100 transition-colors font-medium border border-indigo-100"
                                        >
                                            <Wand2 className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> <span className="hidden sm:inline">Auto</span>
                                        </button>

                                        {selectedTablesForMerge.length >= 2 && (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    try {
                                                        await onMergeTables(selectedTablesForMerge);
                                                        showToast(`${selectedTablesForMerge.length} tavoli uniti con successo`, 'success');
                                                        setSelectedTablesForMerge([]);
                                                    } catch (error) {
                                                        showToast('Errore durante l\'unione dei tavoli', 'error');
                                                    }
                                                }}
                                                className="text-[10px] sm:text-xs flex items-center gap-1 bg-purple-50 text-purple-700 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg hover:bg-purple-100 transition-colors font-medium border border-purple-100"
                                            >
                                                <Combine className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> ({selectedTablesForMerge.length})
                                            </button>
                                        )}

                                        {selectedTableObj?.merged_with && selectedTableObj.merged_with.length > 0 && (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    try {
                                                        await onSplitTable(selectedTableObj.id);
                                                        showToast('Tavoli divisi con successo', 'success');
                                                        setFormData({...formData, table_id: undefined});
                                                    } catch (error) {
                                                        showToast('Errore durante la divisione dei tavoli', 'error');
                                                    }
                                                }}
                                                className="text-[10px] sm:text-xs flex items-center gap-1 bg-amber-50 text-amber-700 px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg hover:bg-amber-100 transition-colors font-medium border border-amber-100"
                                            >
                                                <Scissors className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                            </button>
                                        )}
                                    </div>
                                </div>
                                <p className="text-[10px] sm:text-xs text-slate-500 flex flex-wrap items-center gap-1">
                                    <span className="whitespace-nowrap">Disp. {formData.reservation_time?.split('T')[0]}</span>
                                    <span className="whitespace-nowrap">({formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'}):</span>
                                    <span className="font-bold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full whitespace-nowrap">
                                        {freeTablesCount}/{totalTablesInFilter}
                                    </span>
                                </p>
                            </div>

                             {/* Room Tabs for Modal */}
                             <div className="flex gap-1.5 sm:gap-2 overflow-x-auto pb-2 mb-2 sm:mb-3 scrollbar-hide">
                                 <button
                                    type="button"
                                    onClick={() => setModalRoomFilter('ALL')}
                                    className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex-shrink-0 ${modalRoomFilter === 'ALL' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                 >
                                     Tutte
                                 </button>
                                 {rooms.map(room => (
                                     <button
                                        key={room.id}
                                        type="button"
                                        onClick={() => setModalRoomFilter(room.id)}
                                        className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium rounded-lg whitespace-nowrap transition-colors flex-shrink-0 ${modalRoomFilter === room.id ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                     >
                                         {room.name}
                                     </button>
                                 ))}
                             </div>

                             <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 p-2 sm:p-4 overflow-y-auto max-h-[300px] sm:max-h-[400px] relative">
                                {displayedRooms.map(room => (
                                    <div key={room.id} className="mb-4 sm:mb-6 last:mb-0">
                                        <h4 className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase mb-2 sticky top-0 bg-slate-50 py-1 z-10">{room.name}</h4>
                                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2 sm:gap-3">
                                                                                         {tables
                                                .filter(t => t.room_id === room.id)
                                                // Hide tables that are merged into another table
                                                .filter(t => {
                                                    const isMergedIntoAnother = tables.some(other => {
                                                        if (other.merged_with && other.merged_with.length > 0) {
                                                            const mergedIds = other.merged_with.map(id => Number(id));
                                                            const tableId = Number(t.id);
                                                            return mergedIds.includes(tableId);
                                                        }
                                                        return false;
                                                    });
                                                    return !isMergedIntoAnother;
                                                })
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
                                                            if (e.ctrlKey || e.metaKey) {
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
                                                                    <span className="text-[10px] font-bold text-red-700 bg-white/80 px-2 py-0.5 rounded shadow-sm border border-red-200 -mt-16">OCCUPATO</span>
                                                                </div>
                                                                <div className="absolute -bottom-2.5 w-full flex justify-center">
                                                                    <div className="bg-red-600 text-white text-[9px] px-1.5 py-0.5 rounded-full whitespace-nowrap shadow-sm max-w-[100%] truncate border border-white -ml-6">
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
                                 <div className="text-[10px] text-slate-400 italic">
                                     💡 Tieni premuto Ctrl (o Cmd su Mac) mentre clicchi per selezionare più tavoli da unire
                                 </div>
                             </div>
                        </div>
                    </form>
                </div>

                <div className="p-3 sm:p-5 border-t border-slate-100 bg-slate-50 flex justify-end gap-2 sm:gap-3">
                    <button
                        type="button"
                        onClick={() => setIsFormOpen(false)}
                        className="px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg sm:rounded-xl border border-slate-300 text-slate-700 text-sm sm:text-base font-medium hover:bg-white transition-colors"
                    >
                        Annulla
                    </button>
                    <button
                        onClick={handleSubmit}
                        className="px-3 sm:px-5 py-2 sm:py-2.5 bg-indigo-600 text-white rounded-lg sm:rounded-xl text-sm sm:text-base font-medium hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all"
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
    </div>
  );
};
