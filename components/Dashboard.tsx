import React, { useState, useEffect } from 'react';
import { Reservation, Table, Dish, TodoItem, TodoPriority, TodoCategory } from '../types';
import { generateRestaurantReport } from '../services/geminiService';
import { getTodos, createTodo, updateTodo, deleteTodo, toggleTodoComplete, saveTodos } from '../services/todoService';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Sparkles, Loader2, TrendingUp, Users, Utensils, Plus, Check, Trash2, Calendar, Clock, Flag, Tag, X, ChevronDown, AlertTriangle, CheckCircle2, Circle, ListTodo } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface DashboardProps {
  reservations: Reservation[];
  tables: Table[];
  dishes: Dish[];
}

const COLORS = ['#6366f1', '#10b981', '#f59e0b', '#ef4444'];

const CATEGORY_LABELS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'Generale',
  [TodoCategory.RESERVATION]: 'Prenotazione',
  [TodoCategory.INVENTORY]: 'Inventario',
  [TodoCategory.STAFF]: 'Staff',
  [TodoCategory.MAINTENANCE]: 'Manutenzione',
  [TodoCategory.EVENT]: 'Evento',
};

const CATEGORY_COLORS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'bg-slate-100 text-slate-600',
  [TodoCategory.RESERVATION]: 'bg-indigo-100 text-indigo-600',
  [TodoCategory.INVENTORY]: 'bg-amber-100 text-amber-600',
  [TodoCategory.STAFF]: 'bg-emerald-100 text-emerald-600',
  [TodoCategory.MAINTENANCE]: 'bg-orange-100 text-orange-600',
  [TodoCategory.EVENT]: 'bg-purple-100 text-purple-600',
};

const PRIORITY_COLORS: Record<TodoPriority, string> = {
  [TodoPriority.LOW]: 'text-slate-400',
  [TodoPriority.MEDIUM]: 'text-amber-500',
  [TodoPriority.HIGH]: 'text-rose-500',
};

export const Dashboard: React.FC<DashboardProps> = ({ reservations, tables, dishes }) => {
  const [report, setReport] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Todo State
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [todoFilter, setTodoFilter] = useState<'all' | 'pending' | 'completed' | 'overdue'>('pending');
  const [showAddTodo, setShowAddTodo] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string>(new Date().toISOString().split('T')[0]);
  const [newTodo, setNewTodo] = useState({
    title: '',
    description: '',
    priority: TodoPriority.MEDIUM,
    category: TodoCategory.GENERAL,
    dueDate: '',
  });

  useEffect(() => {
    setTodos(getTodos());
  }, []);

  const handleGenerateReport = async () => {
    setLoading(true);
    const result = await generateRestaurantReport(reservations, tables, dishes);
    setReport(result);
    setLoading(false);
  };

  const handleAddTodo = () => {
    if (!newTodo.title.trim()) return;

    const todo = createTodo({
      title: newTodo.title,
      description: newTodo.description || undefined,
      priority: newTodo.priority,
      category: newTodo.category,
      dueDate: newTodo.dueDate || undefined,
    });

    setTodos([todo, ...todos]);
    setNewTodo({
      title: '',
      description: '',
      priority: TodoPriority.MEDIUM,
      category: TodoCategory.GENERAL,
      dueDate: '',
    });
    setShowAddTodo(false);
  };

  const handleToggleTodo = (id: string) => {
    const updated = toggleTodoComplete(id);
    if (updated) {
      setTodos(todos.map(t => t.id === id ? updated : t));
    }
  };

  const handleDeleteTodo = (id: string) => {
    deleteTodo(id);
    setTodos(todos.filter(t => t.id !== id));
  };

  const today = new Date().toISOString().split('T')[0];

  const filteredTodos = todos.filter(todo => {
    if (todoFilter === 'pending') return !todo.completed;
    if (todoFilter === 'completed') return todo.completed;
    if (todoFilter === 'overdue') return !todo.completed && todo.dueDate && todo.dueDate < today;
    return true;
  });

  const todaysTodos = todos.filter(t => t.dueDate === today && !t.completed);
  const overdueTodos = todos.filter(t => !t.completed && t.dueDate && t.dueDate < today);
  const pendingCount = todos.filter(t => !t.completed).length;

  // Calculate mock stats
  const occupiedTables = Array.isArray(tables) ? tables.filter(t => t.status === 'OCCUPIED').length : 0;
  const totalTables = Array.isArray(tables) ? tables.length : 0;
  const totalCapacity = Array.isArray(tables) ? tables.reduce((acc, t) => acc + (Number(t.seats) || 0), 0) : 0;

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

      {/* Todo List Section */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-4 sm:p-6 border-b border-slate-100">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg">
                <ListTodo className="h-5 w-5" />
              </div>
              <div>
                <h2 className="text-lg font-semibold text-slate-800">Attività</h2>
                <p className="text-sm text-slate-500">{pendingCount} da completare</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddTodo(true)}
                className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-xl hover:bg-indigo-700 transition-colors text-sm font-medium"
              >
                <Plus className="h-4 w-4" /> Nuova
              </button>
            </div>
          </div>

          {/* Filter Tabs */}
          <div className="flex gap-2 mt-4 overflow-x-auto pb-1">
            {[
              { key: 'pending', label: 'Da fare', icon: Circle },
              { key: 'completed', label: 'Completate', icon: CheckCircle2 },
              { key: 'overdue', label: 'Scadute', icon: AlertTriangle, count: overdueTodos.length },
              { key: 'all', label: 'Tutte', icon: ListTodo },
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setTodoFilter(tab.key as typeof todoFilter)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                  todoFilter === tab.key
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                }`}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {tab.count !== undefined && tab.count > 0 && (
                  <span className="bg-rose-500 text-white text-xs px-1.5 py-0.5 rounded-full">{tab.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Todo Items */}
        <div className="divide-y divide-slate-100 max-h-[400px] overflow-y-auto">
          {filteredTodos.length === 0 ? (
            <div className="p-8 text-center">
              <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mx-auto mb-3">
                <CheckCircle2 className="h-6 w-6 text-slate-400" />
              </div>
              <p className="text-slate-500 text-sm">
                {todoFilter === 'pending' ? 'Nessuna attività da completare' :
                 todoFilter === 'completed' ? 'Nessuna attività completata' :
                 todoFilter === 'overdue' ? 'Nessuna attività scaduta' :
                 'Nessuna attività'}
              </p>
            </div>
          ) : (
            filteredTodos.map(todo => {
              const isOverdue = !todo.completed && todo.dueDate && todo.dueDate < today;
              return (
                <div
                  key={todo.id}
                  className={`p-4 hover:bg-slate-50 transition-colors ${todo.completed ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-start gap-3">
                    <button
                      onClick={() => handleToggleTodo(todo.id)}
                      className={`mt-0.5 flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                        todo.completed
                          ? 'bg-emerald-500 border-emerald-500 text-white'
                          : 'border-slate-300 hover:border-indigo-400'
                      }`}
                    >
                      {todo.completed && <Check className="h-3 w-3" />}
                    </button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className={`font-medium ${todo.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>
                          {todo.title}
                        </p>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Flag className={`h-4 w-4 ${PRIORITY_COLORS[todo.priority]}`} />
                          <button
                            onClick={() => handleDeleteTodo(todo.id)}
                            className="p-1 text-slate-400 hover:text-rose-500 hover:bg-rose-50 rounded transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      {todo.description && (
                        <p className="text-sm text-slate-500 mt-1">{todo.description}</p>
                      )}
                      <div className="flex flex-wrap items-center gap-2 mt-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_COLORS[todo.category]}`}>
                          {CATEGORY_LABELS[todo.category]}
                        </span>
                        {todo.dueDate && (
                          <span className={`flex items-center gap-1 text-xs ${isOverdue ? 'text-rose-600 font-medium' : 'text-slate-500'}`}>
                            <Calendar className="h-3 w-3" />
                            {new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                            {isOverdue && ' (scaduta)'}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Add Todo Modal */}
      {showAddTodo && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="p-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">Nuova Attività</h3>
              <button onClick={() => setShowAddTodo(false)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="h-5 w-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Titolo</label>
                <input
                  type="text"
                  value={newTodo.title}
                  onChange={e => setNewTodo({ ...newTodo, title: e.target.value })}
                  placeholder="Es: Chiamare fornitore vini"
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Descrizione (opzionale)</label>
                <textarea
                  value={newTodo.description}
                  onChange={e => setNewTodo({ ...newTodo, description: e.target.value })}
                  placeholder="Aggiungi dettagli..."
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none h-20 resize-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Priorità</label>
                  <select
                    value={newTodo.priority}
                    onChange={e => setNewTodo({ ...newTodo, priority: e.target.value as TodoPriority })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value={TodoPriority.LOW}>Bassa</option>
                    <option value={TodoPriority.MEDIUM}>Media</option>
                    <option value={TodoPriority.HIGH}>Alta</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Categoria</label>
                  <select
                    value={newTodo.category}
                    onChange={e => setNewTodo({ ...newTodo, category: e.target.value as TodoCategory })}
                    className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1 uppercase">Scadenza (opzionale)</label>
                <input
                  type="date"
                  value={newTodo.dueDate}
                  onChange={e => setNewTodo({ ...newTodo, dueDate: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none"
                />
              </div>
            </div>
            <div className="p-4 border-t border-slate-100 flex justify-end gap-3">
              <button
                onClick={() => setShowAddTodo(false)}
                className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-colors font-medium"
              >
                Annulla
              </button>
              <button
                onClick={handleAddTodo}
                disabled={!newTodo.title.trim()}
                className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors font-medium disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Aggiungi
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Today's Tasks Summary */}
      {todaysTodos.length > 0 && (
        <div className="bg-gradient-to-r from-amber-50 to-orange-50 p-4 rounded-2xl border border-amber-100">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="h-5 w-5 text-amber-600" />
            <h3 className="font-semibold text-amber-900">Attività di oggi</h3>
            <span className="bg-amber-200 text-amber-800 text-xs px-2 py-0.5 rounded-full font-medium">{todaysTodos.length}</span>
          </div>
          <div className="space-y-2">
            {todaysTodos.slice(0, 3).map(todo => (
              <div key={todo.id} className="flex items-center gap-2 text-sm text-amber-800">
                <div className={`w-2 h-2 rounded-full ${PRIORITY_COLORS[todo.priority].replace('text-', 'bg-')}`} />
                {todo.title}
              </div>
            ))}
            {todaysTodos.length > 3 && (
              <p className="text-xs text-amber-600">+{todaysTodos.length - 3} altre attività</p>
            )}
          </div>
        </div>
      )}

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