import React, { useState, useMemo } from 'react';
import { Reservation, Table, Dish, Room, Shift, ArrivalStatus } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Sparkles, Loader2, TrendingUp, Users, Utensils, ChevronLeft, ChevronRight, Calendar } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAuth } from '../contexts/AuthContext';

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
  rooms: Room[];
}

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes, rooms }) => {
  const { user } = useAuth();
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [chartShiftFilter, setChartShiftFilter] = useState<'ALL' | 'LUNCH' | 'DINNER'>('ALL');

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
  const selectedDayGuests = selectedDayReservations.reduce((acc, r) => acc + r.guests, 0);
  const arrivedGuests = selectedDayReservations
    .filter(r => r.arrival_status === ArrivalStatus.ARRIVED)
    .reduce((acc, r) => acc + r.guests, 0);

  // Reservations by shift for selected day
  const lunchReservations = selectedDayReservations.filter(r => r.shift === Shift.LUNCH);
  const dinnerReservations = selectedDayReservations.filter(r => r.shift === Shift.DINNER);

  const lunchTableIds = new Set(lunchReservations.map(r => r.table_id).filter(Boolean));
  const dinnerTableIds = new Set(dinnerReservations.map(r => r.table_id).filter(Boolean));

  const lunchOccupancy = totalTables > 0 ? Math.round((lunchTableIds.size / totalTables) * 100) : 0;
  const dinnerOccupancy = totalTables > 0 ? Math.round((dinnerTableIds.size / totalTables) * 100) : 0;

  // Calculate weekly chart data from real reservations (based on selected date's week)
  const weeklyChartData = useMemo(() => {
    // Get start of selected date's week (Monday)
    const dayOfWeek = selectedDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() + mondayOffset);
    monday.setHours(0, 0, 0, 0);

    const days = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
    const data = [];

    for (let i = 0; i < 7; i++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      const dateStr = date.toISOString().split('T')[0];

      let dayReservations = Array.isArray(reservations)
        ? reservations.filter(r => r.reservation_time.startsWith(dateStr))
        : [];

      // Filter by shift if not ALL
      if (chartShiftFilter !== 'ALL') {
        dayReservations = dayReservations.filter(r => r.shift === chartShiftFilter);
      }

      const dayGuests = dayReservations.reduce((acc, r) => acc + r.guests, 0);

      data.push({
        name: days[i],
        date: date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }),
        guests: dayGuests
      });
    }

    return data;
  }, [reservations, chartShiftFilter, selectedDate]);

  // Get week range for display (based on selected date's week)
  const weekRange = useMemo(() => {
    const dayOfWeek = selectedDate.getDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() + mondayOffset);
    const sunday = new Date(monday);
    sunday.setDate(monday.getDate() + 6);

    return `${monday.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} - ${sunday.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}`;
  }, [selectedDate]);

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header with Calendar Navigation */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500">Benvenuto su RistoCRM, {user?.full_name}</p>
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
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Ospiti Attesi</p>
            <p className="text-xl font-bold text-slate-800">{selectedDayGuests}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Ospiti Arrivati</p>
            <p className="text-xl font-bold text-slate-800">{arrivedGuests}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-rose-50 text-rose-600 rounded-lg">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Occupazione</p>
            <p className="text-xl font-bold text-slate-800">{occupancyRate}%</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-amber-50 text-amber-600 rounded-lg">
            <Utensils className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Coperti Totali</p>
            <p className="text-xl font-bold text-slate-800">{totalCapacity}</p>
          </div>
        </div>
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-100 flex items-center gap-3">
          <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
            <Calendar className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-slate-500">Prenotazioni</p>
            <p className="text-xl font-bold text-slate-800">{selectedDayReservations.length}</p>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {rooms.map(room => {
              const roomTables = tables.filter(t => t.room_id === room.id);
              const roomTableIds = new Set(roomTables.map(t => t.id));

              // Calculate room-specific availability per shift for selected day
              const roomLunchReserved = lunchReservations.filter(r => roomTableIds.has(r.table_id)).length;
              const roomDinnerReserved = dinnerReservations.filter(r => roomTableIds.has(r.table_id)).length;
              const roomLunchAvailable = roomTables.length - roomLunchReserved;
              const roomDinnerAvailable = roomTables.length - roomDinnerReserved;

              return (
                <div key={room.id} className="border border-slate-100 rounded-lg p-3 hover:border-slate-200 transition-colors bg-slate-50/50">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-medium text-slate-700 text-sm">{room.name}</h3>
                    <span className="text-xs text-slate-400">{roomTables.length} tavoli</span>
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1 bg-amber-50 rounded-md px-2 py-1.5 border border-amber-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-amber-700">Pranzo</span>
                        <span className={`text-xs font-bold ${roomLunchAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {roomLunchAvailable}/{roomTables.length}
                        </span>
                      </div>
                    </div>
                    <div className="flex-1 bg-indigo-50 rounded-md px-2 py-1.5 border border-indigo-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-indigo-700">Cena</span>
                        <span className={`text-xs font-bold ${roomDinnerAvailable > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {roomDinnerAvailable}/{roomTables.length}
                        </span>
                      </div>
                    </div>
                  </div>
                  {roomTables.length === 0 && (
                    <span className="text-xs text-slate-400">Nessun tavolo</span>
                  )}
                </div>
              );
            })}
            {rooms.length === 0 && (
              <div className="col-span-full text-center text-slate-400 py-8">
                Nessuna sala configurata
              </div>
            )}
          </div>

          {/* Legend */}
          <div className="flex flex-wrap justify-center gap-4 mt-4 pt-4 border-t border-slate-100">
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-600">Disponibilità tavoli per turno del giorno selezionato</span>
            </div>
          </div>
        </div>

        {/* Weekly Chart - Now smaller (1 column) */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-slate-800">Affluenza Settimanale</h2>
            <p className="text-sm text-slate-500 mt-1">{weekRange}</p>
            <div className="flex rounded-lg border border-slate-200 p-1 bg-slate-50 mt-4">
              <button
                onClick={() => setChartShiftFilter('ALL')}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'ALL'
                    ? 'bg-white text-slate-800 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Tutti
              </button>
              <button
                onClick={() => setChartShiftFilter('LUNCH')}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'LUNCH'
                    ? 'bg-amber-100 text-amber-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Pranzo
              </button>
              <button
                onClick={() => setChartShiftFilter('DINNER')}
                className={`flex-1 px-3 py-2 text-sm font-medium rounded-md transition-colors ${
                  chartShiftFilter === 'DINNER'
                    ? 'bg-indigo-100 text-indigo-700 shadow-sm'
                    : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Cena
              </button>
            </div>
          </div>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={weeklyChartData}>
                <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke="#e2e8f0" />
                <XAxis
                  dataKey="name"
                  axisLine={false}
                  tickLine={false}
                  tick={{fill: '#64748b', fontSize: 11}}
                />
                <YAxis
                  domain={[0, 600]}
                  axisLine={false}
                  tickLine={false}
                  tick={{fill: '#64748b', fontSize: 11}}
                  width={35}
                />
                <Tooltip
                  cursor={{fill: '#f1f5f9'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                  formatter={(value: number) => [`${value} ospiti`, 'Ospiti']}
                  labelFormatter={(label, payload) => {
                    if (payload && payload[0]) {
                      return `${label} (${payload[0].payload.date})`;
                    }
                    return label;
                  }}
                />
                <Bar
                  dataKey="guests"
                  fill={chartShiftFilter === 'LUNCH' ? '#f59e0b' : chartShiftFilter === 'DINNER' ? '#6366f1' : '#6366f1'}
                  radius={[4, 4, 0, 0]}
                />
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
