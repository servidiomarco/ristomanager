import React, { useMemo, useState, useEffect } from 'react';
import { useTodos } from '../contexts/TodosContext';
import { useAuth } from '../contexts/AuthContext';
import {
  TodoItem, TodoPriority, TodoCategory, UserRole, BanquetMenu, Dish,
} from '../types';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { BanquetCompositionModal } from './BanquetCompositionModal';
import {
  Plus, Check, Trash2, Clock, Flag, AlertTriangle, Loader2, ListTodo, ListChecks,
  ListFilter, RotateCcw, UserCircle, UsersRound, Edit2, Utensils, Sparkles, Package,
  Wrench, CalendarDays, PartyPopper, Users, Tag, ChevronDown, Bell, Link2,
} from 'lucide-react';
import { SkeletonTaskList } from './SkeletonCards';
import {
  StatusPill, CountBadge, SearchField, SectionHeader, StatStrip, Avatar, Callout,
  EmptyState, ModalShell, FormCard, Field, SegmentedControl, dsInput, dsTextarea,
  dsButton, dsIconButton,
} from './ds';
import type { Stat } from './ds';

interface AttivitaPageProps {
  banquetMenus: BanquetMenu[];
  dishes: Dish[];
  /** When true, open the new-activity modal (e.g. triggered from the global "+" create menu). */
  autoOpenNew?: boolean;
  onAutoOpenNewHandled?: () => void;
}

const CATEGORY_LABELS: Record<TodoCategory, string> = {
  [TodoCategory.GENERAL]: 'Generale',
  [TodoCategory.RESERVATION]: 'Prenotazione',
  [TodoCategory.INVENTORY]: 'Inventario',
  [TodoCategory.STAFF]: 'Staff',
  [TodoCategory.MAINTENANCE]: 'Manutenzione',
  [TodoCategory.EVENT]: 'Evento',
};

/* Categories are told apart by icon, not by hue. The design system's colour
   families are states (§3.2) — seated, arriving, pending, critical — and there
   are four of them for six categories, so painting "Inventario" gold and
   "Manutenzione" red would both run out of colours and make a maintenance task
   read as a failure on a page where red already means scaduta. Six icons
   separate cleanly at 12px and leave colour to say one thing: urgency. */
const CATEGORY_ICONS: Record<TodoCategory, React.ComponentType<{ className?: string }>> = {
  [TodoCategory.GENERAL]: Tag,
  [TodoCategory.RESERVATION]: CalendarDays,
  [TodoCategory.INVENTORY]: Package,
  [TodoCategory.STAFF]: Users,
  [TodoCategory.MAINTENANCE]: Wrench,
  [TodoCategory.EVENT]: PartyPopper,
};

const PRIORITY_LABELS: Record<TodoPriority, string> = {
  [TodoPriority.HIGH]: 'Alta',
  [TodoPriority.MEDIUM]: 'Media',
  [TodoPriority.LOW]: 'Bassa',
};

const PRIORITY_DOTS: Record<TodoPriority, string> = {
  [TodoPriority.HIGH]: 'bg-[var(--ds-critical-solid)]',
  [TodoPriority.MEDIUM]: 'bg-[var(--ds-pending-solid)]',
  [TodoPriority.LOW]: 'bg-[var(--ds-text-muted)]',
};

const TEAM_LABELS: Record<UserRole, string> = {
  [UserRole.PLATFORM_ADMIN]: 'Admin piattaforma',
  [UserRole.OWNER]: 'Proprietario',
  [UserRole.GENERAL_MANAGER]: 'General Manager',
  [UserRole.MANAGER]: 'Manager',
  [UserRole.RECEPTION]: 'Reception',
  [UserRole.WAITER]: 'Camerieri',
  [UserRole.KITCHEN]: 'Cucina',
};

// Mirrors auth/permissions.ts role hierarchy.
const ROLE_RANK: Record<UserRole, number> = {
  [UserRole.PLATFORM_ADMIN]: 5,
  [UserRole.OWNER]: 4,
  [UserRole.GENERAL_MANAGER]: 3,
  [UserRole.MANAGER]: 2,
  [UserRole.RECEPTION]: 1,
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

/* A due date is a plain YYYY-MM-DD, not an instant. Parsing it at local noon
   keeps it on the day it says: `new Date('2026-08-01')` is UTC midnight, which
   in Rome is fine but flips a day west of Greenwich. */
const parseDueDate = (iso: string): Date => new Date(`${iso}T12:00:00`);

const formatDueShort = (iso: string, todayStr: string): string => {
  if (iso === todayStr) return 'oggi';
  return parseDueDate(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
};

const formatDueLong = (iso: string): string =>
  parseDueDate(iso).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' });

const daysLate = (iso: string, todayStr: string): number =>
  Math.round((parseDueDate(todayStr).getTime() - parseDueDate(iso).getTime()) / 86400000);

const formatCompleted = (iso: string, todayStr: string): string => {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  if (formatLocalDate(d) === todayStr) return `fatta alle ${time}`;
  return `fatta il ${d.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} alle ${time}`;
};

/* Four tabs, not two: "Oggi" and "Scadute" used to be figures you read in the
   strip and then had to go find. They are the two questions the page is opened
   to answer, so they are filters. "Da fare" still holds all of them — it is
   everything not yet done, overdue and due-today included. */
type StatusTab = 'TODO' | 'TODAY' | 'OVERDUE' | 'DONE';
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
  linkedBanquetIds: number[];
}

const PRIORITY_RANK: Record<TodoPriority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
const sortByPriorityThenDate = (a: TodoItem, b: TodoItem) => {
  if (PRIORITY_RANK[a.priority] !== PRIORITY_RANK[b.priority]) {
    return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  }
  return (a.dueDate || '').localeCompare(b.dueDate || '');
};

const emptyForm: TodoForm = {
  title: '',
  description: '',
  priority: TodoPriority.MEDIUM,
  category: TodoCategory.GENERAL,
  dueDate: '',
  assignedToUserId: undefined,
  assignedToTeam: undefined,
  linkedBanquetIds: [],
};

/* ── Chip ─────────────────────────────────────────────────────────────────
   A single value out of a set, laid out as a wrapping row rather than a
   segmented track. Six categories and six teams do not fit on one line, and a
   <select> hides the options that matter — the whole point of the filter panel
   is seeing what is on offer without opening anything else. 44px tall, because
   on a phone this is the primary control. */
const Chip: React.FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`inline-flex h-11 max-w-full items-center gap-1.5 rounded-full px-3.5 text-[14px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
      active
        ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
        : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-border)]'
    }`}
  >
    {children}
  </button>
);

/* The row's own actions. Full 44px under a thumb, compact where there is a
   cursor and they only appear on hover anyway. */
const rowAction =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] md:h-9 md:w-9';

/* ── AssigneePill ─────────────────────────────────────────────────────────
   Who owns it. A person wins over a team when both are set, which is what the
   server stores anyway — assigning to one clears the other. */
const AssigneePill: React.FC<{ todo: TodoItem }> = ({ todo }) => {
  if (todo.assignedToUserName) {
    return (
      <StatusPill title={`Assegnata a ${todo.assignedToUserName}`}>
        <UserCircle className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">{todo.assignedToUserName}</span>
      </StatusPill>
    );
  }
  if (todo.assignedToTeam && !todo.assignedToUserId) {
    return (
      <StatusPill title={`Assegnata al team ${TEAM_LABELS[todo.assignedToTeam]}`}>
        <UsersRound className="h-3 w-3 flex-shrink-0" aria-hidden />
        <span className="truncate">{TEAM_LABELS[todo.assignedToTeam]}</span>
      </StatusPill>
    );
  }
  return null;
};

/* ── TodoRow ──────────────────────────────────────────────────────────────
   A white card on the canvas. Red never touches the card itself, only the date
   pill and the band above the group: a wall of pink rows says everything is
   equally wrong and stops meaning anything. */
const TodoRow: React.FC<{
  todo: TodoItem;
  todayStr: string;
  banquetMenus: BanquetMenu[];
  selectMode: boolean;
  isSelected: boolean;
  onToggleComplete: () => void;
  onToggleSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenBanquet: (banquet: BanquetMenu) => void;
}> = ({
  todo, todayStr, banquetMenus, selectMode, isSelected,
  onToggleComplete, onToggleSelect, onEdit, onDelete, onOpenBanquet,
}) => {
  const isOverdue = !!(todo.dueDate && todo.dueDate < todayStr && !todo.completed);
  const CategoryIcon = CATEGORY_ICONS[todo.category];
  const linkedBanquets = (todo.linkedBanquetIds ?? [])
    .map(id => banquetMenus.find(b => b.id === id))
    .filter((b): b is BanquetMenu => !!b);
  // In selection mode the leading circle picks rather than completes, so the
  // two never fire from the same tap.
  const ticked = selectMode ? isSelected : todo.completed;

  return (
    <div
      onClick={selectMode ? onToggleSelect : undefined}
      className={`group relative rounded-[18px] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)] transition-shadow ${
        selectMode ? 'cursor-pointer' : ''
      } ${isSelected ? 'ring-2 ring-[var(--ds-border-focus)]' : ''}`}
    >
      <div className="flex items-start gap-1">
        <button
          type="button"
          onClick={e => { e.stopPropagation(); (selectMode ? onToggleSelect : onToggleComplete)(); }}
          aria-label={
            selectMode
              ? isSelected ? 'Deseleziona' : 'Seleziona'
              : todo.completed ? 'Segna come da fare' : 'Segna come fatta'
          }
          aria-pressed={selectMode ? isSelected : undefined}
          className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <span
            className={`inline-flex h-5 w-5 items-center justify-center rounded-full transition-colors ${
              ticked
                ? selectMode
                  ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                  : 'bg-[var(--ds-seated-solid)] text-white'
                : 'ring-[1.5px] ring-inset ring-[var(--ds-border-strong)] group-hover:ring-[var(--ds-text-muted)]'
            }`}
          >
            {ticked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
          </span>
        </button>

        <div className="min-w-0 flex-1 pb-1 pt-2.5">
          <div className="flex items-start gap-2">
            <p
              className={`min-w-0 flex-1 text-[15px] font-semibold leading-snug tracking-[-0.01em] ${
                todo.completed
                  ? 'text-[var(--ds-text-muted)] line-through'
                  : 'text-[var(--ds-text-primary)]'
              }`}
            >
              {todo.title}
            </p>
            {/* Nothing to edit or delete mid-selection, and a completed row
                carries no actions either — a strikethrough line with three
                controls invites tidying work that is already finished. */}
            {!selectMode && !todo.completed && (
              <div className="flex flex-shrink-0 items-center transition-opacity md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                <button type="button" onClick={onEdit} aria-label="Modifica" className={rowAction}>
                  <Edit2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  aria-label="Elimina"
                  className={`${rowAction} hover:text-[var(--ds-critical-text)]`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>

          {todo.description && (
            <p className="mt-0.5 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
              {todo.description}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <AssigneePill todo={todo} />
            {todo.completed && todo.completedAt ? (
              <StatusPill tone="positive">
                <Check className="h-3 w-3 flex-shrink-0" aria-hidden />
                {formatCompleted(todo.completedAt, todayStr)}
              </StatusPill>
            ) : todo.dueDate ? (
              <StatusPill tone={isOverdue ? 'critical' : 'neutral'}>
                <Clock className="h-3 w-3 flex-shrink-0" aria-hidden />
                {formatDueShort(todo.dueDate, todayStr)}
              </StatusPill>
            ) : null}
            <StatusPill>
              <CategoryIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
              <span className="truncate">{CATEGORY_LABELS[todo.category]}</span>
            </StatusPill>
            {!todo.completed && todo.priority !== TodoPriority.LOW && (
              <StatusPill tone={todo.priority === TodoPriority.HIGH ? 'critical' : 'pending'}>
                <Flag className="h-3 w-3 flex-shrink-0" aria-hidden />
                {PRIORITY_LABELS[todo.priority]}
              </StatusPill>
            )}
            {/* The reservation link was in the data all along and rendered
                nowhere; the banquet chip still opens the composition. */}
            {todo.linkedReservationId && (
              <StatusPill tone="info" title="Prenotazione collegata">
                <CalendarDays className="h-3 w-3 flex-shrink-0" aria-hidden />
                Prenotazione
              </StatusPill>
            )}
            {linkedBanquets.map(banquet => (
              <button
                key={banquet.id}
                type="button"
                onClick={e => { e.stopPropagation(); onOpenBanquet(banquet); }}
                title="Visualizza composizione"
                className="inline-flex h-6 max-w-full flex-shrink-0 items-center gap-1 rounded-full bg-[var(--ds-arriving-tint)] px-2 text-[12px] font-medium text-[var(--ds-arriving-text)] transition-[filter] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                <Utensils className="h-3 w-3 flex-shrink-0" aria-hidden />
                <span className="truncate">{banquet.name}</span>
              </button>
            ))}
            {todo.banquetReminderHours != null && (
              <StatusPill tone="pending">
                <Bell className="h-3 w-3 flex-shrink-0" aria-hidden />
                {todo.banquetReminderHours}h prima
              </StatusPill>
            )}
            {todo.autoKind && (
              <StatusPill title={`Creata automaticamente (${todo.autoKind})`}>
                <Sparkles className="h-3 w-3 flex-shrink-0" aria-hidden />
                auto
              </StatusPill>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export const AttivitaPage: React.FC<AttivitaPageProps> = ({ banquetMenus, dishes, autoOpenNew, onAutoOpenNewHandled }) => {
  const { user } = useAuth();
  const { todos, loading, assignableUsers, addTodo, updateTodo, toggleTodo, deleteTodo } = useTodos();

  const [statusTab, setStatusTab] = useState<StatusTab>('TODO');
  const [scope, setScope] = useState<ScopeFilter>('MINE');
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL');
  const [search, setSearch] = useState('');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [showModal, setShowModal] = useState(false);
  const [editingTodo, setEditingTodo] = useState<TodoItem | null>(null);
  const [form, setForm] = useState<TodoForm>(emptyForm);
  const [banquetPickerOpen, setBanquetPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<TodoItem | null>(null);
  const [banquetModal, setBanquetModal] = useState<BanquetMenu | null>(null);

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
      if (statusTab === 'DONE') {
        if (!t.completed) return false;
      } else {
        if (t.completed) return false;
        if (statusTab === 'TODAY' && t.dueDate !== todayStr) return false;
        if (statusTab === 'OVERDUE' && !(t.dueDate && t.dueDate < todayStr)) return false;
      }
      if (scope === 'MINE' && !(isAssignedToMe(t) || isAssignedToMyTeam(t))) return false;
      if (priorityFilter !== 'ALL' && t.priority !== priorityFilter) return false;
      if (categoryFilter !== 'ALL' && t.category !== categoryFilter) return false;
      if (query && !`${t.title} ${t.description ?? ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [todos, statusTab, scope, priorityFilter, categoryFilter, search, user, todayStr]);

  // Group by date bucket: Scadute / Oggi / Domani / Settimana / Future / Senza scadenza.
  const grouped = useMemo(() => {
    // Oggi and Scadute are one day's worth of tasks by definition, and the tab
    // already says which. A lone band over every card would just repeat it.
    if (statusTab === 'TODAY' || statusTab === 'OVERDUE') {
      return [{ key: 'flat', label: '', items: [...filtered].sort(sortByPriorityThenDate) }];
    }

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

    buckets.forEach(b => b.items.sort(sortByPriorityThenDate));
    return buckets.filter(b => b.items.length > 0);
  }, [filtered, todayStr, statusTab]);

  const counts = useMemo(() => {
    const overdue = todos.filter(t => !t.completed && t.dueDate && t.dueDate < todayStr).length;
    const today = todos.filter(t => !t.completed && t.dueDate === todayStr).length;
    const pending = todos.filter(t => !t.completed).length;
    const done = todos.filter(t => t.completed).length;
    return { overdue, today, pending, done };
  }, [todos, todayStr]);

  // The strip and the tabs show the same four numbers, so they are the same
  // control: pressing a figure selects the tab that filters to it. Otherwise
  // one of them is decoration and the eye has to work out which.
  const selectTab = (tab: StatusTab) => { setStatusTab(tab); exitSelectMode(); };

  const stats: Stat[] = [
    { value: counts.pending, label: 'Da fare', onClick: () => selectTab('TODO'), title: 'Mostra tutte le attività da fare' },
    {
      value: counts.overdue,
      label: 'Scadute',
      // A zero here is good news, and a green or red zero both claim something
      // that has not happened. Colour arrives with the first late task.
      tone: counts.overdue > 0 ? 'critical' : 'neutral',
      tint: counts.overdue > 0,
      onClick: () => selectTab('OVERDUE'),
      title: 'Mostra solo le attività scadute',
    },
    {
      value: counts.today,
      label: 'Oggi',
      tone: counts.today > 0 ? 'pending' : 'neutral',
      onClick: () => selectTab('TODAY'),
      title: 'Mostra solo le attività in scadenza oggi',
    },
    {
      value: counts.done,
      label: 'Fatte',
      tone: counts.done > 0 ? 'positive' : 'neutral',
      onClick: () => selectTab('DONE'),
      title: 'Mostra le attività completate',
    },
  ];

  // Scope is deliberately not counted: switching to Tutte widens the list, and
  // a badge that says "1 filtro" while you are seeing more reads backwards.
  const activeFilterCount = (priorityFilter !== 'ALL' ? 1 : 0) + (categoryFilter !== 'ALL' ? 1 : 0);
  const resetFilters = () => { setPriorityFilter('ALL'); setCategoryFilter('ALL'); };

  const toggleGroup = (key: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resetForm = () => {
    setForm(emptyForm);
    setEditingTodo(null);
    setBanquetPickerOpen(false);
  };

  const openAdd = () => {
    resetForm();
    setForm(prev => ({ ...prev, dueDate: todayStr }));
    setShowModal(true);
  };
  // Open the new-activity modal when triggered from the global "+" create menu, then clear the flag.
  useEffect(() => {
    if (autoOpenNew) {
      openAdd();
      onAutoOpenNewHandled?.();
    }
  }, [autoOpenNew]);
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
      linkedBanquetIds: t.linkedBanquetIds ?? [],
    });
    setBanquetPickerOpen((t.linkedBanquetIds?.length ?? 0) > 0);
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
      if (editingTodo) {
        // Always sent on update: the route treats an empty array as "clear",
        // so this is also how a link gets removed. Omitting it would leave the
        // stored links untouched and make unlinking impossible.
        await updateTodo(editingTodo.id, { ...payload, linkedBanquetIds: form.linkedBanquetIds });
      } else {
        await addTodo({
          ...payload,
          linkedBanquetIds: form.linkedBanquetIds.length ? form.linkedBanquetIds : undefined,
        });
      }
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
  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); };
  /* On the Fatte tab the bulk action is the reverse one. Selecting rows there
     and offering "Completa" would be a button that provably does nothing, and
     un-completing is already what the row's own circle does. */
  const bulkApply = async () => {
    const ids = Array.from(selected);
    const wantCompleted = statusTab !== 'DONE';
    exitSelectMode();
    await Promise.all(ids.map(id => {
      const todo = todos.find(t => t.id === id);
      if (todo && todo.completed !== wantCompleted) return toggleTodo(id);
      return Promise.resolve();
    }));
  };

  const toggleBanquetLink = (id: number) => {
    setForm(prev => ({
      ...prev,
      linkedBanquetIds: prev.linkedBanquetIds.includes(id)
        ? prev.linkedBanquetIds.filter(b => b !== id)
        : [...prev.linkedBanquetIds, id],
    }));
  };

  const sortedBanquets = useMemo(
    () => [...banquetMenus].sort((a, b) => (b.event_date || '').localeCompare(a.event_date || '')),
    [banquetMenus]
  );

  const oldestOverdueDays = grouped.find(b => b.key === 'overdue')?.items
    .reduce((max, t) => Math.max(max, t.dueDate ? daysLate(t.dueDate, todayStr) : 0), 0) ?? 0;

  const newButton = (
    <button type="button" onClick={openAdd} className={dsButton.primary}>
      <Plus className="h-4 w-4" aria-hidden />
      <span className="sm:hidden">Nuova</span>
      <span className="hidden sm:inline">Nuova attività</span>
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-col gap-3 px-4 pb-3 pt-4 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-4 lg:px-8">
        <div className="flex items-center justify-between gap-3">
          {/* No counts line under the title: the strip beside it and the tabs
              below already carry every one of those numbers. */}
          <h1 className="min-w-0 text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
            Attività
          </h1>
          {/* Desktop creates from the header "+" — a second button for the same
              thing on the same screen is just one more object to read. */}
          <div className="flex-shrink-0 lg:hidden">{newButton}</div>
        </div>
        <StatStrip stats={stats} layout="stacked" className="w-full lg:w-[440px] lg:flex-none" />
      </div>

      {/* relative: the filter panel slides up inside this region, the way the
          one on Prenotazioni does — it covers the list it applies to and leaves
          the app header and the sidebar alone. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Pinned while the cards scroll under it. The bottom padding is
            load-bearing: the scrolling region below is opaque and paints later,
            so without it the toolbar's shadow gets sliced off by a hard line. */}
        <div className="flex flex-shrink-0 flex-col gap-2.5 px-4 pb-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            {/* The track scrolls rather than squeezing: four labels with counts
                cannot share a phone's width, and equal-width segments would
                clip "Da fare" to fit "Fatte". At lg it hugs its content and
                Mie/Tutte takes the far end of the line. */}
            <div className="min-w-0 flex-1 lg:w-fit lg:flex-none">
              <SegmentedControl<StatusTab>
                value={statusTab}
                // Switching tab drops selection mode with it: a selection made
                // of rows the list no longer shows is a trap.
                onChange={selectTab}
                ariaLabel="Stato attività"
                equalWidth={false}
                overflow="scroll"
                options={[
                  { value: 'TODO', label: 'Da fare', badge: counts.pending, badgeTone: 'neutral' },
                  { value: 'TODAY', label: 'Oggi', badge: counts.today, badgeTone: 'neutral' },
                  { value: 'OVERDUE', label: 'Scadute', badge: counts.overdue, badgeTone: 'neutral' },
                  { value: 'DONE', label: 'Fatte', badge: counts.done, badgeTone: 'neutral' },
                ]}
              />
            </div>
            {/* Below lg this lives in the filter panel instead: it is a filter
                like the other two, and it will not share the line there. */}
            <div className="ml-auto hidden flex-shrink-0 lg:block lg:w-[168px]">
              <SegmentedControl<ScopeFilter>
                value={scope}
                onChange={setScope}
                ariaLabel="Ambito attività"
                options={[
                  { value: 'MINE', label: 'Mie' },
                  { value: 'ALL', label: 'Tutte' },
                ]}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Cerca attività…"
              ariaLabel="Cerca attività"
              className="min-w-0 flex-1"
            />
            <button
              type="button"
              onClick={() => setFiltersOpen(true)}
              aria-label="Filtri"
              title="Filtri"
              className={activeFilterCount > 0
                ? 'relative inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]'
                : `relative ${dsIconButton}`}
            >
              <ListFilter className="h-4 w-4" />
              {activeFilterCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5">
                  <CountBadge
                    count={activeFilterCount}
                    tone="alert"
                    className="h-5 min-w-[20px] text-[11px] ring-2 ring-[var(--ds-canvas)]"
                  />
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => (selectMode ? exitSelectMode() : setSelectMode(true))}
              aria-pressed={selectMode}
              aria-label={selectMode ? 'Annulla selezione' : 'Seleziona attività'}
              title={selectMode ? 'Annulla selezione' : 'Seleziona attività'}
              className={`inline-flex h-11 flex-shrink-0 items-center justify-center gap-2 rounded-full px-3 text-[15px] font-medium shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] sm:px-4 ${
                selectMode
                  ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                  : 'bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]'
              }`}
            >
              <ListTodo className="h-4 w-4" aria-hidden />
              {/* Label drops below sm, where it would squeeze the search field
                  down to a few characters. */}
              <span className="hidden sm:inline">{selectMode ? 'Annulla' : 'Seleziona'}</span>
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 sm:px-6 lg:px-8">
          {selectMode && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-full bg-[var(--ds-action-bg)] py-1.5 pl-4 pr-1.5">
              <span className="min-w-0 truncate text-[14px] font-medium text-[var(--ds-action-fg)] tabular-nums">
                {selected.size === 0
                  ? statusTab === 'DONE'
                    ? 'Scegli le attività da riaprire'
                    : 'Scegli le attività da completare'
                  : `${selected.size} selezionate`}
              </span>
              <button
                type="button"
                onClick={bulkApply}
                disabled={selected.size === 0}
                className={`inline-flex h-9 flex-shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[14px] font-semibold transition-[filter] hover:brightness-95 disabled:opacity-40 ${
                  statusTab === 'DONE'
                    ? 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)]'
                    : 'bg-[var(--ds-seated-solid)] text-white'
                }`}
              >
                {statusTab === 'DONE' ? (
                  <>
                    <ListChecks className="h-4 w-4" aria-hidden />
                    Riporta da fare
                  </>
                ) : (
                  <>
                    <Check className="h-4 w-4" aria-hidden />
                    Completa
                  </>
                )}
              </button>
            </div>
          )}

          {loading ? (
            <SkeletonTaskList count={6} />
          ) : filtered.length === 0 ? (
            <EmptyState icon={ListChecks} action={statusTab === 'DONE' ? undefined : newButton}>
              {activeFilterCount > 0 || search.trim()
                ? 'Nessuna attività con questi filtri'
                : statusTab === 'DONE'
                ? 'Nessuna attività completata'
                : statusTab === 'OVERDUE'
                ? 'Nessuna attività scaduta'
                : statusTab === 'TODAY'
                ? 'Nessuna attività in scadenza oggi'
                : scope === 'MINE'
                ? 'Nessuna attività assegnata a te'
                : 'Nessuna attività'}
            </EmptyState>
          ) : (
            grouped.map(bucket => {
              const expanded = bucket.key === 'flat' || !collapsedGroups.has(bucket.key);
              const meta = bucket.items.length === 1 ? '1 attività' : `${bucket.items.length} attività`;
              return (
                <div key={bucket.key} className="mb-3 last:mb-0">
                  {/* Scadute keeps the red band the other groups do not get.
                      It collapses like them, but through a chevron in the
                      Callout's action slot rather than by turning the notice
                      into a grey SectionHeader and losing the one place red
                      earns its keep. */}
                  {bucket.key === 'flat' ? null : bucket.key === 'overdue' ? (
                    <Callout
                      tone="critical"
                      icon={AlertTriangle}
                      className={expanded ? 'mb-2.5' : ''}
                      action={
                        <button
                          type="button"
                          onClick={() => toggleGroup(bucket.key)}
                          aria-expanded={expanded}
                          aria-label={expanded ? 'Comprimi le scadute' : 'Espandi le scadute'}
                          className={`inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--ds-critical-text)] transition-transform hover:brightness-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                            expanded ? '' : '-rotate-90'
                          }`}
                        >
                          <ChevronDown className="h-4 w-4" />
                        </button>
                      }
                    >
                      <span className="font-semibold">Scadute</span>
                      <span className="opacity-85"> · {meta}</span>
                      {oldestOverdueDays > 0 && (
                        <span className="opacity-85">
                          {' '}— la più vecchia è di {oldestOverdueDays === 1 ? '1 giorno' : `${oldestOverdueDays} giorni`}
                        </span>
                      )}
                    </Callout>
                  ) : (
                    <SectionHeader
                      tone={bucket.key === 'today' ? 'pending' : 'muted'}
                      onToggle={() => toggleGroup(bucket.key)}
                      expanded={expanded}
                      meta={meta}
                    >
                      {bucket.label}
                    </SectionHeader>
                  )}
                  {expanded && (
                    <div className="space-y-2">
                      {bucket.items.map(todo => (
                        <TodoRow
                          key={todo.id}
                          todo={todo}
                          todayStr={todayStr}
                          banquetMenus={banquetMenus}
                          selectMode={selectMode}
                          isSelected={selected.has(todo.id)}
                          onToggleComplete={() => toggleTodo(todo.id)}
                          onToggleSelect={() => toggleSelect(todo.id)}
                          onEdit={() => openEdit(todo)}
                          onDelete={() => setDeleteConfirm(todo)}
                          onOpenBanquet={setBanquetModal}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        {/* ── Filtri ───────────────────────────────────────────────────────
            Slides up over the list, same as Prenotazioni: changes apply as you
            make them and the backdrop dismisses. No apply button — there is
            nothing to commit. */}
        {filtersOpen && (
          <div className="absolute inset-0 z-50 flex items-end" onClick={() => setFiltersOpen(false)}>
            <div
              className="absolute inset-0 bg-[var(--ds-backdrop)]"
              style={{ animation: 'fadeIn 200ms ease-out both' }}
            />
            {/* Keyframes vere, dichiarate in index.css. Altrove il codice usava
                le classi di tailwindcss-animate (`animate-in`,
                `slide-in-from-bottom`): quel plugin non e' mai stato
                installato, quindi non animavano nulla — sono state rimosse. */}
            <div
              onClick={e => e.stopPropagation()}
              style={{ animation: 'slideUpSheet 260ms cubic-bezier(0.32, 0.72, 0, 1) both' }}
              className="relative max-h-full w-full overflow-y-auto rounded-t-[24px] bg-[var(--ds-surface)] pb-6 shadow-[var(--ds-shadow-raised)]"
            >
              <div className="flex justify-center pb-2 pt-3" aria-hidden>
                <span className="h-1 w-9 rounded-full bg-[var(--ds-border-strong)]" />
              </div>
              <div className="flex items-center justify-between gap-3 px-5 pb-3 sm:px-6">
                <h3 className="text-[17px] font-semibold text-[var(--ds-text-primary)]">Filtri</h3>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text-primary)]"
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    Reimposta
                  </button>
                )}
              </div>
              <div className="space-y-4 px-5 sm:px-6">
                {/* Only below lg — above it Mie/Tutte is in the toolbar and
                    repeating it here would give one setting two homes on the
                    same screen. */}
                <div className="lg:hidden">
                  <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-primary)]">Ambito</span>
                  <div className="flex flex-wrap gap-2">
                    <Chip active={scope === 'MINE'} onClick={() => setScope('MINE')}>Mie</Chip>
                    <Chip active={scope === 'ALL'} onClick={() => setScope('ALL')}>Tutte</Chip>
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-primary)]">Priorità</span>
                  <div className="flex flex-wrap gap-2">
                    <Chip active={priorityFilter === 'ALL'} onClick={() => setPriorityFilter('ALL')}>
                      Tutte
                    </Chip>
                    {[TodoPriority.HIGH, TodoPriority.MEDIUM, TodoPriority.LOW].map(p => (
                      <Chip key={p} active={priorityFilter === p} onClick={() => setPriorityFilter(p)}>
                        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PRIORITY_DOTS[p]}`} aria-hidden />
                        {PRIORITY_LABELS[p]}
                      </Chip>
                    ))}
                  </div>
                </div>
                <div>
                  <span className="mb-2 block text-[13px] font-semibold text-[var(--ds-text-primary)]">Categoria</span>
                  <div className="flex flex-wrap gap-2">
                    <Chip active={categoryFilter === 'ALL'} onClick={() => setCategoryFilter('ALL')}>
                      Tutte
                    </Chip>
                    {(Object.keys(CATEGORY_LABELS) as TodoCategory[]).map(c => {
                      const Icon = CATEGORY_ICONS[c];
                      return (
                        <Chip key={c} active={categoryFilter === c} onClick={() => setCategoryFilter(c)}>
                          <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                          {CATEGORY_LABELS[c]}
                        </Chip>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Nuova / Modifica attività ──────────────────────────────────────
          Groups in cards over two columns, the same shape as the reservation
          form, so the whole thing fits one screen instead of six stacked
          <select>s you scroll through. */}
      <ModalShell
        open={showModal}
        onClose={() => { setShowModal(false); resetForm(); }}
        title={editingTodo ? 'Modifica attività' : 'Nuova attività'}
        subtitle={`${form.title.trim() || 'Titolo da inserire'} · ${PRIORITY_LABELS[form.priority].toLowerCase()} · ${CATEGORY_LABELS[form.category].toLowerCase()}`}
        size="lg"
        footerStart={
          !form.title.trim() ? (
            <span className="text-[var(--ds-critical-text)]">Il titolo è obbligatorio.</span>
          ) : undefined
        }
        footer={
          <>
            <button
              type="button"
              onClick={() => { setShowModal(false); resetForm(); }}
              className={dsButton.secondary}
            >
              Annulla
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={!form.title.trim() || isSaving}
              className={dsButton.primary}
            >
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {editingTodo ? 'Salva' : 'Aggiungi'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-1 gap-4 p-4 sm:p-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <FormCard title="Attività">
              <div className="space-y-4">
                <Field label="Titolo" htmlFor="attivita-titolo" required>
                  <input
                    id="attivita-titolo"
                    type="text"
                    value={form.title}
                    onChange={e => setForm({ ...form, title: e.target.value })}
                    placeholder="Es: Chiamare fornitore vini"
                    className={dsInput}
                    autoFocus
                  />
                </Field>
                <Field label="Descrizione" htmlFor="attivita-descrizione" aside="opzionale">
                  <textarea
                    id="attivita-descrizione"
                    value={form.description}
                    onChange={e => setForm({ ...form, description: e.target.value })}
                    placeholder="Aggiungi dettagli…"
                    rows={4}
                    className={`${dsTextarea} resize-none`}
                  />
                </Field>
              </div>
            </FormCard>

            <FormCard title="Priorità e categoria" aside="la bassa non mostra etichetta">
              <div className="space-y-4">
                <SegmentedControl<TodoPriority>
                  value={form.priority}
                  onChange={priority => setForm({ ...form, priority })}
                  ariaLabel="Priorità"
                  options={[TodoPriority.HIGH, TodoPriority.MEDIUM, TodoPriority.LOW].map(p => ({
                    value: p,
                    label: PRIORITY_LABELS[p],
                    icon: <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${PRIORITY_DOTS[p]}`} aria-hidden />,
                  }))}
                />
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(CATEGORY_LABELS) as TodoCategory[]).map(c => {
                    const Icon = CATEGORY_ICONS[c];
                    return (
                      <Chip
                        key={c}
                        active={form.category === c}
                        onClick={() => setForm({ ...form, category: c })}
                      >
                        <Icon className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                        {CATEGORY_LABELS[c]}
                      </Chip>
                    );
                  })}
                </div>
              </div>
            </FormCard>
          </div>

          <div className="flex min-w-0 flex-col gap-4">
            <FormCard title="Scadenza">
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Chip
                    active={form.dueDate === todayStr}
                    onClick={() => setForm({ ...form, dueDate: todayStr })}
                  >
                    Oggi
                  </Chip>
                  <Chip
                    active={form.dueDate === formatLocalDate(addDays(new Date(), 1))}
                    onClick={() => setForm({ ...form, dueDate: formatLocalDate(addDays(new Date(), 1)) })}
                  >
                    Domani
                  </Chip>
                  <Chip
                    active={form.dueDate === formatLocalDate(addDays(new Date(), 7))}
                    onClick={() => setForm({ ...form, dueDate: formatLocalDate(addDays(new Date(), 7)) })}
                  >
                    Fra una settimana
                  </Chip>
                  <Chip active={form.dueDate === ''} onClick={() => setForm({ ...form, dueDate: '' })}>
                    Senza scadenza
                  </Chip>
                </div>
                <input
                  type="date"
                  value={form.dueDate}
                  onChange={e => setForm({ ...form, dueDate: e.target.value })}
                  aria-label="Data di scadenza"
                  className={dsInput}
                />
              </div>
            </FormCard>

            <FormCard title="Assegnazione">
              <div className="space-y-4">
                <Field label="Persona">
                  <div className="flex flex-wrap gap-2">
                    <Chip
                      active={form.assignedToUserId === undefined}
                      onClick={() => setForm({ ...form, assignedToUserId: undefined })}
                    >
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-text-muted)]" aria-hidden />
                      Nessuno
                    </Chip>
                    {assignableUsers.map(u => (
                      <Chip
                        key={u.id}
                        active={form.assignedToUserId === u.id}
                        onClick={() => setForm({ ...form, assignedToUserId: u.id, assignedToTeam: undefined })}
                      >
                        <Avatar name={u.full_name} size="sm" className="-ml-1.5" />
                        <span className="min-w-0 truncate">{u.full_name}</span>
                      </Chip>
                    ))}
                  </div>
                </Field>
                <Field label="Team">
                  <div className="flex flex-wrap gap-2">
                    <Chip
                      active={form.assignedToTeam === undefined}
                      onClick={() => setForm({ ...form, assignedToTeam: undefined })}
                    >
                      <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[var(--ds-text-muted)]" aria-hidden />
                      Nessun team
                    </Chip>
                    {(Object.entries(TEAM_LABELS) as [UserRole, string][])
                      .filter(([key]) => canAssignToRole(user?.role, key))
                      .map(([key, label]) => (
                        <Chip
                          key={key}
                          active={form.assignedToTeam === key}
                          onClick={() => setForm({ ...form, assignedToTeam: key, assignedToUserId: undefined })}
                        >
                          <UsersRound className="h-3.5 w-3.5 flex-shrink-0" aria-hidden />
                          {label}
                        </Chip>
                      ))}
                  </div>
                </Field>
              </div>
            </FormCard>

            {/* Collapsed by default: most activities hang off nothing, and a
                list of every banquet on record is not what you want to scroll
                past on the way to the save button. */}
            <FormCard>
              <button
                type="button"
                onClick={() => setBanquetPickerOpen(v => !v)}
                aria-expanded={banquetPickerOpen}
                className="flex w-full items-center gap-3 text-left focus-visible:outline-none focus-visible:underline"
              >
                <Link2 className="h-4 w-4 flex-shrink-0 text-[var(--ds-text-muted)]" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-[var(--ds-text-primary)]">
                    Collega a un banchetto
                  </span>
                  <span className="block text-[13px] text-[var(--ds-text-muted)]">
                    {form.linkedBanquetIds.length === 0
                      ? 'nessun collegamento'
                      : form.linkedBanquetIds.length === 1
                      ? '1 banchetto collegato'
                      : `${form.linkedBanquetIds.length} banchetti collegati`}
                  </span>
                </span>
                <span
                  className={`inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-transform ${
                    banquetPickerOpen ? '' : '-rotate-90'
                  }`}
                  aria-hidden
                >
                  <ChevronDown className="h-4 w-4" />
                </span>
              </button>
              {banquetPickerOpen && (
                <div className="mt-4 max-h-64 space-y-1.5 overflow-y-auto">
                  {sortedBanquets.length === 0 ? (
                    <p className="text-[14px] text-[var(--ds-text-muted)]">Nessun banchetto in archivio.</p>
                  ) : (
                    sortedBanquets.map(b => {
                      const linked = form.linkedBanquetIds.includes(b.id);
                      return (
                        <button
                          key={b.id}
                          type="button"
                          onClick={() => toggleBanquetLink(b.id)}
                          aria-pressed={linked}
                          className={`flex w-full items-center gap-3 rounded-[16px] p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                            linked
                              ? 'bg-[var(--ds-arriving-tint)]'
                              : 'bg-[var(--ds-surface-row)] hover:bg-[var(--ds-border)]'
                          }`}
                        >
                          <span
                            className={`inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full ${
                              linked
                                ? 'bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)]'
                                : 'ring-[1.5px] ring-inset ring-[var(--ds-border-strong)]'
                            }`}
                          >
                            {linked && <Check className="h-3 w-3" strokeWidth={3} aria-hidden />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-[15px] font-medium ${
                                linked ? 'text-[var(--ds-arriving-text)]' : 'text-[var(--ds-text-primary)]'
                              }`}
                            >
                              {b.name}
                            </span>
                            <span
                              className={`block text-[13px] ${
                                linked ? 'text-[var(--ds-arriving-text)] opacity-80' : 'text-[var(--ds-text-muted)]'
                              }`}
                            >
                              {b.event_date ? formatDueLong(b.event_date) : 'senza data'}
                            </span>
                          </span>
                          {b.guests != null && (
                            <span
                              className={`flex-shrink-0 text-[13px] tabular-nums ${
                                linked ? 'text-[var(--ds-arriving-text)] opacity-80' : 'text-[var(--ds-text-muted)]'
                              }`}
                            >
                              {b.guests} coperti
                            </span>
                          )}
                        </button>
                      );
                    })
                  )}
                </div>
              )}
            </FormCard>
          </div>
        </div>
      </ModalShell>

      <ConfirmDeleteModal
        isOpen={!!deleteConfirm}
        title="Elimina attività"
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
