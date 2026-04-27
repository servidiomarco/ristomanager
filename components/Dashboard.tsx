import React, { useState, useMemo } from 'react';
import { Reservation, Table, Dish, Room, TableStatus, Shift } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, TrendingUp, Users, Utensils, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
  rooms: Room[];
}

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms }) => {
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());

  const handleGenerateReport = async () => {
    setLoading(true);
    const result = await generateRestaurantReport(reservations, tables, dishes);
    setReport(result);
    setLoading(false);
  };

  // Format date for display
  const formatDate = (date: Date) => {
    return date.toLocaleDateString('it-IT', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  };

  // Navigate to previous/next day
  const goToPreviousDay = () => {
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() - 1);
      return newDate;
    });
  };

  const goToNextDay = () => {
    setSelectedDate(prev => {
      const newDate = new Date(prev);
      newDate.setDate(newDate.getDate() + 1);
      return newDate;
    });
  };

  const goToToday = () => {
    setSelectedDate(new Date());
  };

  // Get selected date string for filtering
  const selectedDateStr = selectedDate.toISOString().split('T')[0];
  const isToday = selectedDateStr === new Date().toISOString().split('T')[0];

  // Filter reservations for selected date
  const selectedDayReservations = useMemo(() => {
    return Array.isArray(reservations)
      ? reservations.filter(r => r.reservation_time.startsWith(selectedDateStr))
      : [];
  }, [reservations, selectedDateStr]);

  // Calculate stats for selected day
  const totalTables = Array.isArray(tables) ? tables.length : 0;
  const totalCapacity = Array.isArray(tables) ? tables.reduce((acc, t) => acc + (Number(t.seats) || 0), 0) : 0;

  // Current occupancy (real-time status)
  const occupiedTables = Array.isArray(tables) ? tables.filter(t => t.status === 'OCCUPIED').length : 0;
  const occupancyRate = totalTables > 0 ? Math.round((occupiedTables / totalTables) * 100) : 0;

  // Selected day stats
  const selectedDayOccupiedTableIds = new Set(selectedDayReservations.map(r => r.table_id).filter(Boolean));
  const selectedDayOccupiedTables = selectedDayOccupiedTableIds.size;
  const selectedDayOccupancyRate = totalTables > 0 ? Math.round((selectedDayOccupiedTables / totalTables) * 100) : 0;
  const selectedDayGuests = selectedDayReservations.reduce((acc, r) => acc + r.guests, 0);

  // Reservations by shift for selected day
  const lunchReservations = selectedDayReservations.filter(r => r.shift === Shift.LUNCH);
  const dinnerReservations = selectedDayReservations.filter(r => r.shift === Shift.DINNER);

  const lunchTableIds = new Set(lunchReservations.map(r => r.table_id).filter(Boolean));
  const dinnerTableIds = new Set(dinnerReservations.map(r => r.table_id).filter(Boolean));

  const lunchOccupancy = totalTables > 0 ? Math.round((lunchTableIds.size / totalTables) * 100) : 0;
  const dinnerOccupancy = totalTables > 0 ? Math.round((dinnerTableIds.size / totalTables) * 100) : 0;

  const chartData = [
    { name: 'Lun', guests: 24 },
    { name: 'Mar', guests: 18 },
    { name: 'Mer', guests: 32 },
    { name: 'Gio', guests: 45 },
    { name: 'Ven', guests: 85 },
    { name: 'Sab', guests: 98 },
    { name: 'Dom', guests: 65 },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header with Calendar Navigation */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500">Benvenuto su RistoManager AI</p>
        </div>

        {/* Date Navigation */}
        <div className="flex items-center gap-2 bg-white rounded-xl border border-slate-200 p-1">
          <button
            onClick={goToPreviousDay}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ChevronLeft className="h-5 w-5 text-slate-600" />
          </button>

          <div className="flex items-center gap-2 px-3 py-1.5">
            <Calendar className="h-4 w-4 text-indigo-600" />
            <span className="font-medium text-slate-700 capitalize min-w-[200px] text-center">
              {formatDate(selectedDate)}
            </span>
          </div>

          <button
            onClick={goToNextDay}
            className="p-2 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <ChevronRight className="h-5 w-5 text-slate-600" />
          </button>

          {!isToday && (
            <button
              onClick={goToToday}
              className="px-3 py-1.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
            >
              Oggi
            </button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Occupazione Attuale</p>
            <p className="text-2xl font-bold text-slate-800">{occupancyRate}%</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
            <Users className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Ospiti Attesi</p>
            <p className="text-2xl font-bold text-slate-800">{selectedDayGuests}</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-lg">
            <Utensils className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Coperti Totali</p>
            <p className="text-2xl font-bold text-slate-800">{totalCapacity}</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Prenotazioni</p>
            <p className="text-2xl font-bold text-slate-800">{selectedDayReservations.length}</p>
          </div>
        </div>
      </div>

      {/* Charts Section - Swapped: Table Status is now larger */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table Status by Room - Now expanded (2 columns) */}
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">Stato Tavoli</h2>

          {/* Shift Occupancy Summary */}
          <div className="grid grid-cols-2 gap-4 mb-6">
            <div className="bg-gradient-to-br from-amber-50 to-orange-50 rounded-xl p-4 border border-amber-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-amber-800">Pranzo</span>
                <span className="text-xs text-amber-600">{lunchTableIds.size}/{totalTables} tavoli</span>
              </div>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold text-amber-700">{lunchOccupancy}%</span>
                <span className="text-sm text-amber-600 mb-1">occupazione</span>
              </div>
              <div className="mt-2 h-2 bg-amber-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-amber-500 rounded-full transition-all duration-500"
                  style={{ width: `${lunchOccupancy}%` }}
                />
              </div>
              <p className="text-xs text-amber-600 mt-2">
                {lunchReservations.length} prenotazioni · {lunchReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti
              </p>
            </div>

            <div className="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-indigo-800">Cena</span>
                <span className="text-xs text-indigo-600">{dinnerTableIds.size}/{totalTables} tavoli</span>
              </div>
              <div className="flex items-end gap-2">
                <span className="text-3xl font-bold text-indigo-700">{dinnerOccupancy}%</span>
                <span className="text-sm text-indigo-600 mb-1">occupazione</span>
              </div>
              <div className="mt-2 h-2 bg-indigo-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                  style={{ width: `${dinnerOccupancy}%` }}
                />
              </div>
              <p className="text-xs text-indigo-600 mt-2">
                {dinnerReservations.length} prenotazioni · {dinnerReservations.reduce((acc, r) => acc + r.guests, 0)} ospiti
              </p>
            </div>
          </div>

          {/* Room by Room Status */}
          <div className="space-y-3 max-h-64 overflow-y-auto">
            {rooms.map(room => {
              const roomTables = tables.filter(t => t.room_id === room.id);
              const freeCount = roomTables.filter(t => t.status === TableStatus.FREE).length;
              const occupiedCount = roomTables.filter(t => t.status === TableStatus.OCCUPIED).length;
              const reservedCount = roomTables.filter(t => t.status === TableStatus.RESERVED).length;
              const dirtyCount = roomTables.filter(t => t.status === TableStatus.DIRTY).length;

              // Calculate room-specific shift occupancy for selected day
              const roomLunchTables = lunchReservations.filter(r => roomTables.some(t => t.id === r.table_id)).length;
              const roomDinnerTables = dinnerReservations.filter(r => roomTables.some(t => t.id === r.table_id)).length;

              return (
                <div key={room.id} className="border border-slate-100 rounded-xl p-4 hover:border-slate-200 transition-colors">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="font-medium text-slate-700">{room.name}</h3>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                        P: {roomLunchTables}
                      </span>
                      <span className="text-xs text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full">
                        C: {roomDinnerTables}
                      </span>
                      <span className="text-xs text-slate-400">{roomTables.length} tavoli</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {freeCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                        <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                        {freeCount} Liberi
                      </span>
                    )}
                    {occupiedCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-100 text-rose-700">
                        <span className="w-2 h-2 rounded-full bg-rose-500"></span>
                        {occupiedCount} Occupati
                      </span>
                    )}
                    {reservedCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                        <span className="w-2 h-2 rounded-full bg-amber-500"></span>
                        {reservedCount} Prenotati
                      </span>
                    )}
                    {dirtyCount > 0 && (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                        <span className="w-2 h-2 rounded-full bg-slate-500"></span>
                        {dirtyCount} Da pulire
                      </span>
                    )}
                    {roomTables.length === 0 && (
                      <span className="text-xs text-slate-400">Nessun tavolo</span>
                    )}
                  </div>
                </div>
              );
            })}
            {rooms.length === 0 && (
              <div className="text-center text-slate-400 py-8">
                Nessuna sala configurata
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-4 mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-500"></span>
              <span className="text-xs text-slate-600">Libero</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-rose-500"></span>
              <span className="text-xs text-slate-600">Occupato</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500"></span>
              <span className="text-xs text-slate-600">Prenotato</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-slate-500"></span>
              <span className="text-xs text-slate-600">Da pulire</span>
            </div>
          </div>
        </div>

        {/* Weekly Chart - Now smaller (1 column) */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">Affluenza Settimanale</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
                <XAxis type="number" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} width={35} />
                <Tooltip
                  cursor={{fill: '#f1f5f9'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                />
                <Bar dataKey="guests" fill="#6366f1" radius={[0, 4, 4, 0]} barSize={20} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* AI Report Section */}
      {report && (
        <div className="bg-gradient-to-br from-indigo-50 to-purple-50 p-6 rounded-2xl border border-indigo-100 animate-fade-in">
          <div className="flex items-center gap-2 mb-4">
            <Sparkles className="h-5 w-5 text-indigo-600" />
            <h2 className="text-lg font-bold text-indigo-900">Analisi AI Gemini</h2>
          </div>
          <div className="prose prose-indigo max-w-none text-slate-700">
            <ReactMarkdown>{report}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
};
