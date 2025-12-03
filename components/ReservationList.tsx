import React, { useState, useEffect } from 'react';
import { Reservation, PaymentStatus, BanquetMenu, Table, TableStatus, Shift, Room, TableShape, ArrivalStatus } from '../types';
import { Calendar, CreditCard, Clock, AlertCircle, Plus, Users, X, Trash2, Edit2, Wand2, Sun, Moon, MapPin, Filter, Map as MapIcon, List, MessageCircle, Mail, Armchair, Search, BellRing, CheckSquare, Square, UserCheck, Combine, Scissors } from 'lucide-react';

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

  const handleSendWhatsapp = (res: Reservation) => {
      if (!res.phone) {
          // Try fallback or alert
          window.open('https://wa.me/');
          showToast('Numero di telefono mancante, apro WhatsApp Web.', 'info');
          return;
      }
      
      const msg = `Gentile ${res.customer_name}, confermiamo la prenotazione presso RistoManager per il ${new Date(res.reservation_time).toLocaleString()} per ${res.guests} persone. A presto!`;
      const url = `https://wa.me/${res.phone}?text=${encodeURIComponent(msg)}`;
      window.open(url, '_blank');
      showToast('WhatsApp aperto per l\'invio', 'success');
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

  const handleAutoAssign = () => {
      if (!formData.guests || !formData.reservation_time || !formData.shift) return;
      
      const availableTables = tables
        .filter(t => t.seats >= (formData.guests || 0))
        .filter(t => !isTableOccupied(t.id as number, formData.reservation_time!.split('T')[0], formData.shift!))
        .filter(t => modalRoomFilter === 'ALL' || t.room_id === modalRoomFilter)
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

      let shapeStyles = {};
      if (table.shape === TableShape.CIRCLE) shapeStyles = { borderRadius: '50%', width: '80px', height: '80px' };
      else if (table.shape === TableShape.SQUARE) shapeStyles = { borderRadius: '8px', width: '80px', height: '80px' };
      else { 
          const width = Math.max(100, table.seats * 15);
          shapeStyles = { borderRadius: '8px', width: `${width}px`, height: '80px' };
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
          const tablesInRoom = tables.filter(t => t.room_id === activeMapRoomId);
          const occupiedTablesCount = tablesInRoom.filter(t => getReservationForTable(t.id)).length;
          const totalTablesInRoom = tablesInRoom.length;
          const occupancyPercentage = totalTablesInRoom > 0 ? Math.round((occupiedTablesCount / totalTablesInRoom) * 100) : 0;

          return (
              <div className="bg-white p-4 rounded-2xl border border-slate-200 shadow-sm flex flex-col h-[600px] animate-in fade-in duration-300">
                  {/* Room Selector for Map */}
                  <div className="flex gap-2 mb-4 border-b border-slate-100 pb-2">
                      {rooms.map(room => (
                          <button
                              key={room.id}
                              onClick={() => setActiveMapRoomId(room.id)}
                              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${ 
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
                    className="flex-1 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200 relative overflow-hidden"
                    style={{ 
                        backgroundImage: 'radial-gradient(#cbd5e1 1px, transparent 1px)',
                        backgroundSize: '20px 20px'
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
                <div className="p-5 border-b border-slate-100 flex justify-between items-center bg-slate-50">
                    <h2 className="text-xl font-bold text-slate-800">{isEditing ? 'Modifica Prenotazione' : 'Nuova Prenotazione'}</h2>
                    <button onClick={() => setIsFormOpen(false)} className="text-slate-400 hover:text-slate-600">
                        <X className="h-6 w-6" />
                    </button>
                </div>
                
                <div className="flex-1 overflow-y-auto">
                    <form id="reservation-form" onSubmit={handleSubmit} className="p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
                        {/* Left Column: Details (4 cols) */}
                        <div className="lg:col-span-5 space-y-4">
                            <h3 className="font-semibold text-slate-900 mb-2 flex items-center gap-2 border-b pb-2">
                                <Users className="h-4 w-4 text-indigo-500" /> Dettagli Cliente & Orario
                            </h3>
                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Nome Cliente</label>
                                <input 
                                    required
                                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                    value={formData.customer_name}
                                    onChange={e => setFormData({...formData, customer_name: e.target.value})}
                                    placeholder="Mario Rossi"
                                />
                            </div>
                             
                            <div className="grid grid-cols-2 gap-4">
                                 <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Telefono</label>
                                    <input 
                                        className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                        value={formData.phone || ''}
                                        onChange={e => setFormData({...formData, phone: e.target.value})}
                                        placeholder="333..."
                                    />
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Email</label>
                                    <input 
                                        type="email"
                                        className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                        value={formData.email || ''}
                                        onChange={e => setFormData({...formData, email: e.target.value})}
                                        placeholder="cliente@mail.com"
                                    />
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Data e Ora</label>
                                    <div className="relative">
                                        <input 
                                            type="datetime-local"
                                            required
                                            className="w-full rounded-lg border border-slate-300 p-2.5 pl-10 focus:ring-2 focus:ring-indigo-500 outline-none bg-white cursor-pointer"
                                            value={formData.reservation_time}
                                            onChange={e => setFormData({...formData, reservation_time: e.target.value})} 
                                        />
                                        <Calendar className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 pointer-events-none" />
                                    </div>
                                </div>
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Turno</label>
                                    <div className="bg-slate-100 p-1 rounded-lg flex items-center gap-1 border border-slate-300">
                                        <button 
                                            type="button"
                                            onClick={() => setFormData({...formData, shift: Shift.LUNCH})}
                                            className={`flex w-full items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${formData.shift === Shift.LUNCH ? 'bg-white text-amber-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Sun className="h-4 w-4" /> Pranzo
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFormData({...formData, shift: Shift.DINNER})}
                                            className={`flex w-full items-center justify-center gap-2 px-3 py-1.5 rounded-md text-sm font-medium transition-all ${formData.shift === Shift.DINNER ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                                        >
                                            <Moon className="h-4 w-4" /> Cena
                                        </button>
                                    </div>
                                </div>
                            </div>
                            
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Ospiti</label>
                                    <input 
                                        type="number"
                                        min="1"
                                        required
                                        className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white"
                                        value={formData.guests || ''}
                                        onChange={e => setFormData({...formData, guests: parseInt(e.target.value) || undefined})}
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Menu Banchetto</label>
                                <select 
                                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none bg-white text-sm"
                                    value={formData.banquet_menu_id || ''}
                                    onChange={e => setFormData({...formData, banquet_menu_id: e.target.value ? parseInt(e.target.value) : undefined})}
                                >
                                    <option value="">Alla Carta</option>
                                    {banquetMenus.map(m => (
                                        <option key={m.id} value={m.id}>{m.name} (€{m.price_per_person} pp)</option>
                                    ))}
                                </select>
                            </div>
                            
                            <div className="flex items-center gap-2 p-3 bg-indigo-50 rounded-lg border border-indigo-100 cursor-pointer" onClick={() => setFormData({...formData, enable_reminder: !formData.enable_reminder})}>
                                <div className={`w-5 h-5 rounded border flex items-center justify-center ${formData.enable_reminder ? 'bg-indigo-600 border-indigo-600' : 'bg-white border-slate-300'}`}>
                                    {formData.enable_reminder && <CheckSquare className="text-white w-3 h-3" />}
                                </div>
                                <label className="text-sm text-slate-700 font-medium cursor-pointer select-none">Invia promemoria automatico 24h prima</label>
                            </div>

                             <div>
                                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Note</label>
                                <textarea 
                                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none h-20 text-sm bg-white"
                                    placeholder="Intolleranze, seggiolone..."
                                    value={formData.notes || ''}
                                    onChange={e => setFormData({...formData, notes: e.target.value})}
                                />
                            </div>
                        </div>

                        {/* Right Column: Table Selection (7 cols) */}
                        <div className="lg:col-span-7 flex flex-col h-full border-l border-slate-100 pl-0 lg:pl-8 pt-6 lg:pt-0">
                             <div className="flex flex-col sm:flex-row justify-between items-start sm:items-end mb-4 gap-2">
                                <div>
                                    <h3 className="font-semibold text-slate-900 flex items-center gap-2">
                                        <MapPin className="h-4 w-4 text-indigo-500" /> 
                                        Seleziona Tavolo
                                        {selectedTableObj && (
                                            <span className="ml-2 text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded text-sm border border-indigo-100">
                                                                                                 {selectedTableObj.name} - {rooms.find(r => r.id === selectedTableObj.room_id)?.name}
                                            </span>
                                        )}
                                    </h3>
                                    <p className="text-xs text-slate-500 mt-1 flex items-center gap-2">
                                        Disponibilità per <b>{formData.reservation_time?.split('T')[0]}</b> ({formData.shift === Shift.LUNCH ? 'Pranzo' : 'Cena'}): 
                                        <span className="font-bold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">
                                            {freeTablesCount} liberi su {totalTablesInFilter}
                                        </span>
                                    </p>
                                </div>
                                <button 
                                    type="button"
                                    onClick={handleAutoAssign}
                                    className="text-xs flex items-center gap-1 bg-indigo-50 text-indigo-700 px-3 py-1.5 rounded-lg hover:bg-indigo-100 transition-colors font-medium border border-indigo-100"
                                >
                                    <Wand2 className="h-3 w-3" /> Auto-assegna
                                </button>
                             </div>

                             {/* Room Tabs for Modal */}
                             <div className="flex gap-2 overflow-x-auto pb-2 mb-2 scrollbar-hide">
                                 <button
                                    type="button"
                                    onClick={() => setModalRoomFilter('ALL')}
                                    className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${modalRoomFilter === 'ALL' ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                 >
                                     Tutte le Sale
                                 </button>
                                 {rooms.map(room => (
                                     <button
                                        key={room.id}
                                        type="button"
                                        onClick={() => setModalRoomFilter(room.id)}
                                        className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap transition-colors ${modalRoomFilter === room.id ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}
                                     >
                                         {room.name}
                                     </button>
                                 ))}
                             </div>

                             <div className="flex-1 bg-slate-50 rounded-xl border border-slate-200 p-4 overflow-y-auto max-h-[400px] relative">
                                {displayedRooms.map(room => (
                                    <div key={room.id} className="mb-6 last:mb-0">
                                        <h4 className="text-xs font-bold text-slate-400 uppercase mb-2 sticky top-0 bg-slate-50 py-1 z-10">{room.name}</h4>
                                        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3">
                                                                                         {tables.filter(t => t.room_id === room.id).map(table => {
                                                const occupiedReservation = getReservationForTableInForm(table.id);
                                                const isOccupied = !!occupiedReservation;
                                                const isSelected = formData.table_id === table.id;
                                                const fitsGuests = table.seats >= (formData.guests || 1);

                                                return (
                                                    <button
                                                        key={table.id}
                                                        type="button"
                                                        disabled={isOccupied}
                                                        onClick={() => setFormData({...formData, table_id: table.id})}
                                                        className={`
                                                            relative p-3 rounded-xl border-2 text-center transition-all group
                                                            ${isSelected 
                                                                ? 'border-indigo-600 bg-indigo-50 ring-2 ring-indigo-200 z-10' 
                                                                : isOccupied 
                                                                    ? 'border-red-500 bg-red-100 opacity-90 cursor-not-allowed' 
                                                                    : fitsGuests 
                                                                        ? 'border-white bg-white shadow-sm hover:border-indigo-300 hover:shadow-md hover:-translate-y-0.5' 
                                                                        : 'border-slate-200 bg-slate-100 opacity-50'
                                                            }
                                                        `}
                                                    >
                                                        <div className={`text-sm font-bold ${isSelected ? 'text-indigo-700' : isOccupied ? 'text-red-900' : 'text-slate-700'}`}>
                                                            {table.name}
                                                        </div>
                                                        <div className={`text-[10px] flex justify-center items-center gap-1 mt-1 ${isOccupied ? 'text-red-800' : 'text-slate-500'}`}>
                                                            <Users size={10} /> {table.seats}
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
                                                        {isSelected && (
                                                            <div className="absolute -top-2 -right-2 bg-indigo-600 text-white rounded-full p-0.5 shadow-sm">
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
                             <div className="mt-3 flex flex-wrap gap-4 text-[10px] text-slate-500 px-1">
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-white border border-slate-200 shadow-sm rounded"></div> Libero</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-indigo-50 border-2 border-indigo-600 rounded"></div> Selezionato</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-slate-200 border border-slate-200 rounded"></div> Occupato</div>
                                 <div className="flex items-center gap-1.5"><div className="w-3 h-3 bg-slate-100 border border-slate-200 rounded opacity-50"></div> Capienza Insufficiente</div>
                             </div>
                        </div>
                    </form>
                </div>

                <div className="p-5 border-t border-slate-100 bg-slate-50 flex justify-end gap-3">
                    <button 
                        type="button"
                        onClick={() => setIsFormOpen(false)}
                        className="px-5 py-2.5 rounded-xl border border-slate-300 text-slate-700 font-medium hover:bg-white transition-colors"
                    >
                        Annulla
                    </button>
                    <button 
                        onClick={handleSubmit}
                        className="px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 shadow-lg shadow-indigo-200 transition-all"
                    >
                        {isEditing ? 'Salva Modifiche' : 'Conferma Prenotazione'}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};
