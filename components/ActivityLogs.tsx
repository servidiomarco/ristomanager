import React, { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, RefreshCw, Filter, Search } from 'lucide-react';
import { ActivityLog, ActivityAction, ResourceType, LogFilters } from '../types';
import { logApiService, LogUser } from '../services/logApiService';
import { CookingPotLoader } from './CookingPotLoader';

interface ActivityLogsProps {
  isOpen: boolean;
  onClose: () => void;
}

const ACTION_LABELS: Record<ActivityAction, string> = {
  [ActivityAction.CREATE]: 'Creazione',
  [ActivityAction.UPDATE]: 'Modifica',
  [ActivityAction.DELETE]: 'Eliminazione',
  [ActivityAction.LOGIN]: 'Login',
  [ActivityAction.LOGOUT]: 'Logout'
};

const RESOURCE_LABELS: Record<ResourceType, string> = {
  [ResourceType.RESERVATION]: 'Prenotazione',
  [ResourceType.TABLE]: 'Tavolo',
  [ResourceType.ROOM]: 'Sala',
  [ResourceType.DISH]: 'Piatto',
  [ResourceType.BANQUET_MENU]: 'Menu Banchetto',
  [ResourceType.USER]: 'Utente',
  [ResourceType.AUTH]: 'Autenticazione',
  [ResourceType.STAFF]: 'Personale',
  [ResourceType.STAFF_SHIFT]: 'Turno Personale',
  [ResourceType.STAFF_TIME_OFF]: 'Permesso Personale',
  [ResourceType.CUSTOMER]: 'Cliente',
  [ResourceType.ORDER]: 'Comanda',
  [ResourceType.SETTINGS]: 'Impostazioni'
};

const ACTION_COLORS: Record<ActivityAction, string> = {
  [ActivityAction.CREATE]: 'bg-emerald-50 text-emerald-700 border border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  [ActivityAction.UPDATE]: 'bg-blue-50 text-blue-700 border border-blue-100 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30',
  [ActivityAction.DELETE]: 'bg-rose-50 text-rose-700 border border-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  [ActivityAction.LOGIN]: 'bg-violet-50 text-violet-700 border border-violet-100 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
  [ActivityAction.LOGOUT]: 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)] border border-[var(--color-line)]'
};

export const ActivityLogs: React.FC<ActivityLogsProps> = ({ isOpen, onClose }) => {
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<LogUser[]>([]);

  // Filters
  const [selectedUserId, setSelectedUserId] = useState<number | undefined>();
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | undefined>();
  const [selectedAction, setSelectedAction] = useState<ActivityAction | undefined>();
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Pagination
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

  // Debounce search input to avoid hammering the API on every keystroke
  useEffect(() => {
    const handle = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(handle);
  }, [search]);

  const fetchLogs = async () => {
    setLoading(true);
    setError(null);

    try {
      const filters: LogFilters = {
        user_id: selectedUserId,
        resource_type: selectedResourceType,
        action: selectedAction,
        from_date: fromDate ? new Date(fromDate).toISOString() : undefined,
        to_date: toDate ? new Date(toDate + 'T23:59:59').toISOString() : undefined,
        search: debouncedSearch || undefined,
        limit,
        offset: (page - 1) * limit
      };

      const response = await logApiService.getActivityLogs(filters);
      setLogs(response.logs);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch logs');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      const usersData = await logApiService.getLogUsers();
      setUsers(usersData);
    } catch (err) {
      console.error('Failed to fetch users:', err);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchLogs();
      fetchUsers();
    }
  }, [isOpen, page, selectedUserId, selectedResourceType, selectedAction, fromDate, toDate, debouncedSearch]);

  const resetFilters = () => {
    setSelectedUserId(undefined);
    setSelectedResourceType(undefined);
    setSelectedAction(undefined);
    setFromDate('');
    setToDate('');
    setSearch('');
    setDebouncedSearch('');
    setPage(1);
  };

  const totalPages = Math.ceil(total / limit);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleString('it-IT', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const formatDetails = (details: Record<string, any> | undefined): string => {
    if (!details) return '-';
    const entries = Object.entries(details)
      .filter(([_, v]) => v !== null && v !== undefined)
      .slice(0, 3);
    if (entries.length === 0) return '-';
    return entries.map(([k, v]) => `${k}: ${v}`).join(', ');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-[rgba(15,23,42,0.5)] dark:bg-[rgba(0,0,0,0.7)] flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-[var(--color-surface)] rounded-2xl shadow-2xl border border-[var(--color-line)] w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-[var(--color-line)]">
          <div>
            <h3 className="text-[16px] font-semibold text-[var(--color-fg)]">Log Attività</h3>
            <p className="text-xs text-[var(--color-fg-muted)] mt-0.5">
              {total} {total === 1 ? 'operazione registrata' : 'operazioni registrate'}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={fetchLogs}
              className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
              title="Aggiorna"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="px-5 py-4 border-b border-[var(--color-line)] bg-[var(--color-surface-2)]">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-3.5 h-3.5 text-[var(--color-fg-subtle)]" />
            <span className="text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">Filtri</span>
            {(selectedUserId || selectedResourceType || selectedAction || fromDate || toDate || search) && (
              <button
                onClick={resetFilters}
                className="text-xs text-[var(--color-fg)] hover:underline ml-2"
              >
                Azzera filtri
              </button>
            )}
          </div>
          <div className="relative mb-3">
            <Search className="w-4 h-4 text-[var(--color-fg-subtle)] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca in tutte le prenotazioni (nome, email, dettagli)..."
              className="w-full bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md pl-9 pr-9 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] hover:bg-[var(--color-surface-hover)]"
                title="Cancella ricerca"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            {/* User Filter */}
            <select
              value={selectedUserId || ''}
              onChange={(e) => {
                setSelectedUserId(e.target.value ? parseInt(e.target.value, 10) : undefined);
                setPage(1);
              }}
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="">Tutti gli utenti</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>{user.name || user.email}</option>
              ))}
            </select>

            {/* Resource Type Filter */}
            <select
              value={selectedResourceType || ''}
              onChange={(e) => {
                setSelectedResourceType(e.target.value as ResourceType || undefined);
                setPage(1);
              }}
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="">Tutte le risorse</option>
              {Object.values(ResourceType).map(type => (
                <option key={type} value={type}>{RESOURCE_LABELS[type]}</option>
              ))}
            </select>

            {/* Action Filter */}
            <select
              value={selectedAction || ''}
              onChange={(e) => {
                setSelectedAction(e.target.value as ActivityAction || undefined);
                setPage(1);
              }}
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            >
              <option value="">Tutte le azioni</option>
              {Object.values(ActivityAction).map(action => (
                <option key={action} value={action}>{ACTION_LABELS[action]}</option>
              ))}
            </select>

            {/* From Date Filter */}
            <input
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
              placeholder="Da"
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />

            {/* To Date Filter */}
            <input
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
              placeholder="A"
              className="bg-[var(--color-surface)] border border-[var(--color-line)] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-[var(--color-fg)]"
            />
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {error ? (
            <div className="p-8 text-center text-rose-600">
              {error}
            </div>
          ) : loading && logs.length === 0 ? (
            <div className="p-8 text-center text-[var(--color-fg-muted)]">
              <CookingPotLoader label="Caricamento…" size={40} />
            </div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-[var(--color-fg-muted)]">
              Nessun log trovato
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-[var(--color-surface-3)] sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Data/Ora
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Utente
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Azione
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Risorsa
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Nome
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Dettagli
                  </th>
                  <th className="px-4 py-3 text-left text-[11px] tracking-[0.02em] font-semibold text-[var(--color-fg-subtle)]">
                    Stato
                  </th>
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <tr key={log.id} className="border-b border-[var(--color-line)] hover:bg-[var(--color-surface-hover)]">
                    <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)] whitespace-nowrap">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg)]">
                      {log.user_name || log.user_email || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${ACTION_COLORS[log.action]}`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                        {ACTION_LABELS[log.action]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg-muted)]">
                      {RESOURCE_LABELS[log.resource_type]}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg)] max-w-[150px] truncate" title={log.resource_name || '-'}>
                      {log.resource_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--color-fg-subtle)] max-w-[200px] truncate" title={formatDetails(log.details)}>
                      {formatDetails(log.details)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border ${
                        log.status === 'SUCCESS'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-100 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30'
                          : 'bg-rose-50 text-rose-700 border-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30'
                      }`}>
                        <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />
                        {log.status === 'SUCCESS' ? 'OK' : 'Errore'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[var(--color-line)]">
            <div className="text-xs text-[var(--color-fg-muted)]">
              Pagina {page} di {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-1.5 rounded-md text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-fg)] disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
