import React, { useMemo, useState } from 'react';
import { useTodos } from '../contexts/TodosContext';
import { useAuth } from '../contexts/AuthContext';
import {
  TodoItem, TodoPriority, TodoCategory, UserRole, BanquetMenu, Dish,
} from '../types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { BanquetCompositionModal } from './BanquetCompositionModal';
import {
  Plus, Check, Trash2, Clock, Flag, X, AlertTriangle, CheckCircle2, Loader2,
  ListTodo, UserCircle, UsersRound, Edit2, Search, Utensils,
} from 'lucide-react';

interface AttivitaPageProps {
  banquetMenus: BanquetMenu[];
  dishes: Dish[];
}

const CATEGORY_LABELS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'Generale',
  [TodoCategory.RESERVATION]: 'Prenotazione',
  [TodoCategory.INVENTORY]: 'Inventario',
  [TodoCategory.STAFF]: 'Staff',
  [TodoCategory.MAINTENANCE]: 'Manutenzione',
  [TodoCategory.EVENT]: 'Evento',
};

const CATEGORY_DOT_COLORS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'bg-slate-400',
  [TodoCategory.RESERVATION]: 'bg-indigo-500',
  [TodoCategory.INVENTORY]: 'bg-amber-500',
  [TodoCategory.STAFF]: 'bg-emerald-500',
  [TodoCategory.MAINTENANCE]: 'bg-orange-500',
  [TodoCategory.EVENT]: 'bg-purple-500',
};

const TEAM_LABELS: Record<UserRole, string> = {
  [UserRole.OWNER]: 'Proprietario',
  [UserRole.GENERAL_MANAGER]: 'General Manager',
  [UserRole.MANAGER]: 'Manager',
  [UserRole.WAITER]: 'Camerieri',
  [UserRole.KITCHEN]: 'Cucina',
};

// Mirrors auth/permissions.ts role hierarchy.
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.OWNER]: 4,
  [UserRole.GENERAL_MANAGER]: 3,
  [UserRole.MANAGER]: 2,
  [UserRole.WAITER]: 1,
  [UserRole.KITCHEN]: 1,
};
const canAssignToRole = (actorRole: UserRole | undefined, targetRole: UserRole): boolean => {
  if (!actorRole) return false;
  const a = ROLE_RANK[actorRole];
  const t = ROLE_RANK[targetRole];
  return a !== undefined && t !== undefined && a >= t;
};

const formatLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const addDays = (date: Date, days: number): Date => {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
};

type StatusTab = 'TODO' | 'DONE';
type ScopeFilter = 'MINE' | 'ALL';
type PriorityFilter = 'ALL' | TodoPriority;
type CategoryFilter = 'ALL' | TodoCategory;

interface TodoForm {
  title: string;
  description: string;
  priority: TodoPriority;
  category: TodoCategory;
  dueDate: string;
  assignedToUserId: number | undefined;
  assignedToTeam: UserRole | undefined;
}

const emptyForm: TodoForm = {
  title: '',
  description: '',
  priority: TodoPriority.MEDIUM,
  category: TodoCategory.GENERAL,
  dueDate: '',
  assignedToUserId: undefined,
  assignedToTeam: undefined,
};

export const AttivitaPage: React.FC<AttivitaPageProps> = ({ banquetMenus, dishes }) => {
  const { user } = useAuth();
  const { todos, loading, assignableUsers, addTodo, updateTodo, toggleTodo, deleteTodo } = useTodos();

  const [statusTab, setStatusTab] = useState<StatusTab>('TODO');
  const [scope, setScope] = useState<ScopeFilter>('MINE');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL');
  const [search, setSearch] = useState('');

  const [showModal, setShowModal] = useState(false);
  const [editingTodo, setEditingTodo] = useState<TodoItem | null>(null);
  const [form, setForm] = useState<TodoForm>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<TodoItem | null>(null);
  const [banquetModal, setBanquetModal] = useState<BanquetMenu | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const todayStr = formatLocalDate(new Date());

  const isAssignedToMe = (t: TodoItem) => {
    if (t.assignedToUserId && user?.id && Number(t.assignedToUserId) === Number(user.id)) return true;
    if (t.assignedToUserName && user?.full_name && t.assignedToUserName.toLowerCase() === user.full_name.toLowerCase()) return true;
    return false;
  };
  const isAssignedToMyTeam = (t: TodoItem) => t.assignedToTeam === user?.role;

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return todos.filter(t => {
      if (statusTab === 'TODO' && t.completed) return false;
      if (statusTab === 'DONE' && !t.completed) return false;
      if (scope === 'MINE' && !(isAssignedToMe(t) || isAssignedToMyTeam(t))) return false;
      if (priorityFilter !== 'ALL' && t.priority !== priorityFilter) return false;
      if (categoryFilter !== 'ALL' && t.category !== categoryFilter) return false;
      if (query && !`${t.title} ${t.description ?? ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [todos, statusTab, scope, priorityFilter, categoryFilter, search, user]);

  // Group by date bucket: Scadute / Oggi / Domani / Settimana / Future / Senza scadenza.
  const grouped = useMemo(() => {
    const tomorrowStr = formatLocalDate(addDays(new Date(), 1));
    const endOfWeekStr = formatLocalDate(addDays(new Date(), 7));

    const buckets: { key: string; label: string; items: TodoItem[] }[] = [
      { key: 'overdue', label: 'Scadute', items: [] },
      { key: 'today', label: 'Oggi', items: [] },
      { key: 'tomorrow', label: 'Domani', items: [] },
      { key: 'week', label: 'Questa settimana', items: [] },
      { key: 'future', label: 'Future', items: [] },
      { key: 'none', label: 'Senza scadenza', items: [] },
    ];

    for (const t of filtered) {
      if (!t.dueDate) {
        buckets[5].items.push(t);
        continue;
      }
      if (!t.completed && t.dueDate < todayStr) buckets[0].items.push(t);
      else if (t.dueDate === todayStr) buckets[1].items.push(t);
      else if (t.dueDate === tomorrowStr) buckets[2].items.push(t);
      else if (t.dueDate <= endOfWeekStr) buckets[3].items.push(t);
      else buckets[4].items.push(t);
    }

    const sortByPriorityThenDate = (a: TodoItem, b: TodoItem) => {
      const pRank: Record<TodoPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
      if (pRank[a.priority] !== pRank[b.priority]) return pRank[a.priority] - pRank[b.priority];
      return (a.dueDate || '').localeCompare(b.dueDate || '');
    };
    buckets.forEach(b => b.items.sort(sortByPriorityThenDate));
    return buckets.filter(b => b.items.length > 0);
  }, [filtered, todayStr]);

  const counts = useMemo(() => {
    const overdue = todos.filter(t => !t.completed && t.dueDate && t.dueDate < todayStr).length;
    const today = todos.filter(t => !t.completed && t.dueDate === todayStr).length;
    const pending = todos.filter(t => !t.completed).length;
    const done = todos.filter(t => t.completed).length;
    return { overdue, today, pending, done };
  }, [todos, todayStr]);

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTodo(null);
  };

  const openAdd = () => {
    resetForm();
    setForm(prev => ({ ...prev, dueDate: todayStr }));
    setShowModal(true);
  };
  const openEdit = (t: TodoItem) => {
    setEditingTodo(t);
    setForm({
      title: t.title,
      description: t.description || '',
      priority: t.priority,
      category: t.category,
      dueDate: t.dueDate || '',
      assignedToUserId: t.assignedToUserId,
      assignedToTeam: t.assignedToTeam,
    });
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!form.title.trim() || isSaving) return;
    const assignedUser = assignableUsers.find(u => u.id === form.assignedToUserId);
    const payload = {
      title: form.title,
      description: form.description || undefined,
      priority: form.priority,
      category: form.category,
      dueDate: form.dueDate || undefined,
      assignedToUserId: form.assignedToUserId,
      assignedToUserName: assignedUser?.full_name,
      assignedToTeam: form.assignedToTeam,
    };
    try {
      setIsSaving(true);
      if (editingTodo) await updateTodo(editingTodo.id, payload);
      else await addTodo(payload);
      resetForm();
      setShowModal(false);
    } finally {
      setIsSaving(false);
    }
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());
  const bulkComplete = async () => {
    const ids = Array.from(selected);
    clearSelection();
    await Promise.all(ids.map(id => {
      const todo = todos.find(t => t.id === id);
      if (todo && !todo.completed) return toggleTodo(id);
      return Promise.resolve();
    }));
  };

  return (
    <div className="p-4 sm:p-6 lg:p-8 bg-[var(--color-surface-2)] min-h-full">
      <div className="max-w-5xl mx-auto space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <h1 className="text-[22px] sm:text-[28px] font-semibold text-[var(--color-fg)] tracking-tight">
              Attività
            </h1>
            <p className="text-sm text-[var(--color-fg-muted)] mt-1 tabular">
              {counts.pending} da fare · {counts.done} completate
              {counts.overdue > 0 && (
                <span className="text-rose-600 dark:text-rose-400 font-medium"> · {counts.overdue} scadute</span>
              )}
            </p>
          </div>
          <button
            onClick={openAdd}
            className="self-start sm:self-auto inline-flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Nuova attività
          </button>
        </div>

        {counts.overdue > 0 && statusTab === 'TODO' && (
          <div className="flex items-center gap-3 rounded-xl border border-rose-100 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/15 px-4 py-3">
            <AlertTriangle className="h-5 w-5 text-rose-600 dark:text-rose-400 flex-shrink-0" />
            <p className="text-sm text-rose-700 dark:text-rose-300">
              <span className="font-semibold tabular">{counts.overdue}</span> attività scadute richiedono attenzione.
            </p>
          </div>
        )}

        {/* Filters */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl p-3 sm:p-4 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--color-fg-subtle)]" />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Cerca attività..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-lg focus:outline-none focus:border-[var(--color-fg)]"
              />
            </div>
            <div className="inline-flex rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-0.5 text-sm self-start">
              {(['TODO', 'DONE'] as const).map(tab => (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setStatusTab(tab)}
                  className={`px-3 py-1.5 rounded-md font-medium transition-colors ${
                    statusTab === tab
                      ? 'bg-[var(--color-surface)] text-[var(--color-fg)] shadow-[var(--shadow-sm)]'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {tab === 'TODO' ? `Da fare (${counts.pending})` : `Fatte (${counts.done})`}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] p-0.5 text-xs">
              {(['MINE', 'ALL'] as const).map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={`px-3 py-1 rounded-full font-medium transition-colors ${
                    scope === s
                      ? 'bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]'
                      : 'text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]'
                  }`}
                >
                  {s === 'MINE' ? 'Mie' : 'Tutte'}
                </button>
              ))}
            </div>
            <span className="text-[var(--color-fg-subtle)]">·</span>
            <select
              value={priorityFilter}
              onChange={e => setPriorityFilter(e.target.value as PriorityFilter)}
              className="text-xs bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full px-3 py-1 focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="ALL">Tutte le priorità</option>
              <option value={TodoPriority.HIGH}>Priorità alta</option>
              <option value={TodoPriority.MEDIUM}>Priorità media</option>
              <option value={TodoPriority.LOW}>Priorità bassa</option>
            </select>
            <select
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value as CategoryFilter)}
              className="text-xs bg-[var(--color-surface-2)] border border-[var(--color-line)] rounded-full px-3 py-1 focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="ALL">Tutte le categorie</option>
              {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Bulk bar */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg bg-[var(--color-fg)] text-[var(--color-fg-on-brand)]">
            <span className="text-sm font-medium tabular">{selected.size} selezionate</span>
            <div className="flex items-center gap-2">
              <button onClick={clearSelection} className="text-xs px-2 py-1 rounded hover:bg-[var(--color-surface)]/10">
                Annulla
              </button>
              <button onClick={bulkComplete} className="text-xs px-2 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-white inline-flex items-center gap-1.5">
                <Check className="h-3.5 w-3.5" />
                Completa tutte
              </button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-xl">
          {loading ? (
            <div className="py-12 text-center">
              <Loader2 className="h-6 w-6 text-[var(--color-fg-subtle)] mx-auto mb-2 animate-spin" />
              <p className="text-[var(--color-fg-subtle)] text-sm">Caricamento attività...</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <CheckCircle2 className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
              <p className="text-[var(--color-fg-subtle)] text-sm">
                {scope === 'MINE' ? 'Nessuna attività assegnata a te' : 'Nessuna attività'}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-[var(--color-line)]">
              {grouped.map(bucket => (
                <div key={bucket.key} className="p-3 sm:p-4">
                  <h3 className={`text-[11px] uppercase tracking-[0.06em] font-semibold mb-2.5 ${
                    bucket.key === 'overdue' ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--color-fg-subtle)]'
                  }`}>
                    {bucket.label} <span className="tabular opacity-70">({bucket.items.length})</span>
                  </h3>
                  <div className="space-y-2">
                    {bucket.items.map(todo => {
                      const isOverdue = !!(todo.dueDate && todo.dueDate < todayStr && !todo.completed);
                      const isSelected = selected.has(todo.id);
                      return (
                        <div
                          key={todo.id}
                          className={`group p-3 rounded-lg border transition-colors ${
                            todo.completed
                              ? 'bg-[var(--color-surface-3)] border-[var(--color-line)]'
                              : isOverdue
                              ? 'bg-rose-50 dark:bg-rose-500/15 border-rose-100 dark:border-rose-500/30'
                              : isSelected
                              ? 'bg-[var(--color-surface-hover)] border-[var(--color-line)]'
                              : 'bg-[var(--color-surface)] border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]'
                          }`}
                          onClick={() => { if (selected.size > 0) toggleSelect(todo.id); }}
                        >
                          <div className="flex items-start gap-3">
                            <button
                              onClick={e => { e.stopPropagation(); toggleTodo(todo.id); }}
                              className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
                                todo.completed
                                  ? 'bg-emerald-500 border-emerald-500 text-[#ffffff]'
                                  : 'border-[var(--color-line-strong)] hover:border-[var(--color-fg)]'
                              }`}
                            >
                              {todo.completed && <Check className="h-2.5 w-2.5" />}
                            </button>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-start justify-between gap-2">
                                <p className={`text-sm font-medium ${todo.completed ? 'line-through text-[var(--color-fg-subtle)]' : 'text-[var(--color-fg)]'}`}>
                                  {todo.title}
                                </p>
                                <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity flex-shrink-0">
                                  <button
                                    onClick={e => { e.stopPropagation(); toggleSelect(todo.id); }}
                                    className="p-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                                    title="Seleziona"
                                  >
                                    <ListTodo className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={e => { e.stopPropagation(); openEdit(todo); }}
                                    className="p-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] transition-colors"
                                  >
                                    <Edit2 className="h-3.5 w-3.5" />
                                  </button>
                                  <button
                                    onClick={e => { e.stopPropagation(); setDeleteConfirm(todo); }}
                                    className="p-1 rounded text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-rose-600 transition-colors"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </div>
                              </div>

                              {todo.description && (
                                <p className="text-xs text-[var(--color-fg-muted)] mt-1">{todo.description}</p>
                              )}

                              <div className="flex items-center gap-2 mt-1.5 text-[var(--color-fg-muted)]">
                                {todo.assignedToUserName && (
                                  <span className="inline-flex items-center gap-1 text-xs">
                                    <UserCircle className="h-3 w-3 flex-shrink-0" />
                                    {todo.assignedToUserName}
                                  </span>
                                )}
                                {todo.assignedToTeam && !todo.assignedToUserId && (
                                  <span className="inline-flex items-center gap-1 text-xs">
                                    <UsersRound className="h-3 w-3 flex-shrink-0" />
                                    {TEAM_LABELS[todo.assignedToTeam]}
                                  </span>
                                )}
                                {todo.dueDate && (
                                  <span className={`inline-flex items-center gap-1 text-xs ${isOverdue ? 'text-rose-600 dark:text-rose-400 font-medium' : ''}`}>
                                    <Clock className="h-3 w-3 flex-shrink-0" />
                                    {new Date(todo.dueDate).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })}
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--color-surface-3)] border border-[var(--color-line)] text-[var(--color-fg-muted)]">
                                  <span className={`w-1.5 h-1.5 rounded-full ${CATEGORY_DOT_COLORS[todo.category]}`} />
                                  {CATEGORY_LABELS[todo.category]}
                                </span>
                                {todo.priority !== TodoPriority.LOW && (
                                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                                    todo.priority === TodoPriority.HIGH
                                      ? 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-100 dark:border-rose-500/30'
                                      : 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-500/30'
                                  }`}>
                                    <Flag className="h-3 w-3" />
                                    {todo.priority === TodoPriority.HIGH ? 'Alta' : 'Media'}
                                  </span>
                                )}
                                {todo.banquetReminderHours != null && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-orange-50 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300 border border-orange-100 dark:border-orange-500/30">
                                    {todo.banquetReminderHours}h prima
                                  </span>
                                )}
                              </div>

                              {Array.isArray(todo.linkedBanquetIds) && todo.linkedBanquetIds.length > 0 && (
                                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                  {todo.linkedBanquetIds.map(bid => {
                                    const banquet = banquetMenus.find(b => b.id === bid);
                                    if (!banquet) return null;
                                    return (
                                      <button
                                        key={bid}
                                        type="button"
                                        onClick={e => { e.stopPropagation(); setBanquetModal(banquet); }}
                                        className="inline-flex items-center gap-1 text-[11px] font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:text-indigo-800 px-2 py-0.5 rounded-full border border-indigo-100 transition-colors"
                                        title="Visualizza composizione"
                                      >
                                        <Utensils className="h-2.5 w-2.5" />
                                        <span className="truncate max-w-[140px]">{banquet.name}</span>
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Add/Edit Modal */}
      {showModal && (
        <div
          className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4"
          onClick={() => { setShowModal(false); resetForm(); }}
        >
          <div
            className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden animate-in fade-in zoom-in duration-200"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)] flex-shrink-0">
              <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">
                {editingTodo ? 'Modifica Attività' : 'Nuova Attività'}
              </h3>
              <button
                onClick={() => { setShowModal(false); resetForm(); }}
                className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 space-y-4 overflow-y-auto flex-1">
              <div>
                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Titolo</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder="Es: Chiamare fornitore vini"
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Descrizione (opzionale)</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm({ ...form, description: e.target.value })}
                  placeholder="Aggiungi dettagli..."
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)] h-20 resize-none"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Priorità</label>
                  <select
                    value={form.priority}
                    onChange={e => setForm({ ...form, priority: e.target.value as TodoPriority })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    <option value={TodoPriority.LOW}>Bassa</option>
                    <option value={TodoPriority.MEDIUM}>Media</option>
                    <option value={TodoPriority.HIGH}>Alta</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Categoria</label>
                  <select
                    value={form.category}
                    onChange={e => setForm({ ...form, category: e.target.value as TodoCategory })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Scadenza (opzionale)</label>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={e => setForm({ ...form, dueDate: e.target.value })}
                  className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Assegna a persona</label>
                  <select
                    value={form.assignedToUserId || ''}
                    onChange={e => setForm({
                      ...form,
                      assignedToUserId: e.target.value ? Number(e.target.value) : undefined,
                      assignedToTeam: undefined,
                    })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    <option value="">Nessuno</option>
                    {assignableUsers.map(u => (
                      <option key={u.id} value={u.id}>{u.full_name} ({TEAM_LABELS[u.role]})</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-[var(--color-fg-muted)] mb-1.5">Assegna a team</label>
                  <select
                    value={form.assignedToTeam || ''}
                    onChange={e => setForm({
                      ...form,
                      assignedToTeam: e.target.value ? (e.target.value as UserRole) : undefined,
                      assignedToUserId: undefined,
                    })}
                    className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md p-2.5 text-sm focus:outline-none focus:border-[var(--color-fg)]"
                  >
                    <option value="">Nessun team</option>
                    {(Object.entries(TEAM_LABELS) as [UserRole, string][])
                      .filter(([key]) => canAssignToRole(user?.role, key))
                      .map(([key, label]) => (
                        <option key={key} value={key}>{label}</option>
                      ))}
                  </select>
                </div>
              </div>
            </div>
            <div className="p-4 border-t border-[var(--color-line)] flex flex-col sm:flex-row gap-2 sm:justify-end flex-shrink-0">
              <button
                onClick={() => { setShowModal(false); resetForm(); }}
                className="w-full sm:w-auto px-4 py-2 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-sm font-medium hover:bg-[var(--color-surface-hover)]"
              >
                Annulla
              </button>
              <button
                onClick={handleSave}
                disabled={!form.title.trim() || isSaving}
                className="w-full sm:w-auto px-4 py-2 rounded-full bg-[var(--color-fg)] text-[var(--color-fg-on-brand)] text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed inline-flex items-center justify-center gap-2"
              >
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingTodo ? 'Salva' : 'Aggiungi'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDeleteModal
        isOpen={!!deleteConfirm}
        title="Elimina Attività"
        message="Stai per eliminare l'attività:"
        itemName={deleteConfirm?.title}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={() => {
          if (deleteConfirm) deleteTodo(deleteConfirm.id);
          setDeleteConfirm(null);
        }}
      />

      {banquetModal && (
        <BanquetCompositionModal
          banquet={banquetModal}
          dishes={dishes}
          onClose={() => setBanquetModal(null)}
        />
      )}
    </div>
  );
};
