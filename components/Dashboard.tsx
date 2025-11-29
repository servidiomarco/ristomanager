import React, { useState } from 'react';
import { Reservation, Table, Dish } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Sparkles, Loader2, TrendingUp, Users, DollarSign, Utensils } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444'];

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes }) => {
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleGenerateReport = async () => {
    setLoading(true);
    const result = await generateRestaurantReport(reservations, tables, dishes);
    setReport(result);
    setLoading(false);
  };

  // Calculate mock stats
  const occupiedTables = Array.isArray(tables) ? tables.filter(t => t.status === 'OCCUPIED').length : 0;
  const totalTables = Array.isArray(tables) ? tables.length : 0;
  const totalCapacity = Array.isArray(tables) ? tables.reduce((acc, t) => acc + (Number(t.seats) || 0), 0) : 0;
  
  const today = new Date().toISOString().split('T')[0];
  const todaysReservations = Array.isArray(reservations) ? reservations.filter(r => r.reservation_time.startsWith(today)) : [];
  const occupiedTableIds = new Set(todaysReservations.map(r => r.table_id));
  const dailyOccupiedTables = occupiedTableIds.size;
  const dailyOccupancyRate = totalTables > 0 ? Math.round((dailyOccupiedTables / totalTables) * 100) : 0;

  const occupancyRate = totalTables > 0 ? Math.round((occupiedTables / totalTables) * 100) : 0;

  const chartData = [
    { name: 'Lun', guests: 24 },
    { name: 'Mar', guests: 18 },
    { name: 'Mer', guests: 32 },
    { name: 'Gio', guests: 45 },
    { name: 'Ven', guests: 85 },
    { name: 'Sab', guests: 98 },
    { name: 'Dom', guests: 65 },
  ];

  const pieData = [
    { name: 'Liberi', value: tables.filter(t => t.status === 'FREE').length },
    { name: 'Occupati', value: tables.filter(t => t.status === 'OCCUPIED').length },
    { name: 'Prenotati', value: tables.filter(t => t.status === 'RESERVED').length },
  ];

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-800">Dashboard</h1>
          <p className="text-slate-500">Benvenuto su RistoManager AI</p>
        </div>
        {/* <button
          onClick={handleGenerateReport}
          disabled={loading}
          className="flex items-center gap-2 bg-gradient-to-r from-indigo-600 to-purple-600 text-white px-6 py-2.5 rounded-xl hover:opacity-90 transition-all shadow-lg shadow-indigo-200 disabled:opacity-50"
        >
          {loading ? <Loader2 className="animate-spin h-5 w-5" /> : <Sparkles className="h-5 w-5" />}
          {loading ? 'Analisi in corso...' : 'Genera Report AI'}
        </button> */}
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-indigo-50 text-indigo-600 rounded-lg">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Tasso Occupazione Attuale</p>
            <p className="text-2xl font-bold text-slate-800">{occupancyRate || 0}%</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-lg">
            <Users className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Ospiti Attesi (Oggi)</p>
            <p className="text-2xl font-bold text-slate-800">{todaysReservations.reduce((acc, r) => acc + r.guests, 0) || 0}</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-amber-50 text-amber-600 rounded-lg">
            <Utensils className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Coperti Totali</p>
            <p className="text-2xl font-bold text-slate-800">{totalCapacity || 0}</p>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex items-center gap-4">
          <div className="p-3 bg-blue-50 text-blue-600 rounded-lg">
            <TrendingUp className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm text-slate-500">Occupazione del Giorno</p>
            <p className="text-2xl font-bold text-slate-800">{dailyOccupancyRate || 0}%</p>
          </div>
        </div>
      </div>

      {/* Charts and AI Report */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Chart */}
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">Affluenza Settimanale</h2>
          <div className="h-80 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{fill: '#64748b'}} dy={10} />
                <YAxis axisLine={false} tickLine={false} tick={{fill: '#64748b'}} />
                <Tooltip 
                  cursor={{fill: '#f1f5f9'}}
                  contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }} 
                />
                <Bar dataKey="guests" fill="#6366f1" radius={[4, 4, 0, 0]} barSize={40} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Pie Chart */}
        <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <h2 className="text-lg font-semibold mb-4 text-slate-800">Stato Tavoli</h2>
          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-4 mt-4">
             {pieData.map((entry, index) => (
               <div key={entry.name} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{backgroundColor: COLORS[index % COLORS.length]}}></div>
                  <span className="text-sm text-slate-600">{entry.name}</span>
               </div>
             ))}
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