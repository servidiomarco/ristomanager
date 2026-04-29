import React, { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, RefreshCw, Filter } from 'lucide-react';
import { ActivityLog, ActivityAction, ResourceType, LogFilters } from '../types';
import { logApiService, LogUser } from '../services/logApiService';

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
  [ResourceType.STAFF_TIME_OFF]: 'Permesso Personale'
};

const ACTION_COLORS: Record<ActivityAction, string> = {
  [ActivityAction.CREATE]: 'bg-emerald-100 text-emerald-700',
  [ActivityAction.UPDATE]: 'bg-blue-100 text-blue-700',
  [ActivityAction.DELETE]: 'bg-rose-100 text-rose-700',
  [ActivityAction.LOGIN]: 'bg-violet-100 text-violet-700',
  [ActivityAction.LOGOUT]: 'bg-slate-100 text-slate-600'
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

  // Pagination
  const [page, setPage] = useState(1);
  const [limit] = useState(20);

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
  }, [isOpen, page, selectedUserId, selectedResourceType, selectedAction, fromDate, toDate]);

  const resetFilters = () => {
    setSelectedUserId(undefined);
    setSelectedResourceType(undefined);
    setSelectedAction(undefined);
    setFromDate('');
    setToDate('');
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-slate-100">
          <div>
            <h2 className="text-xl font-bold text-slate-800">Log Attività</h2>
            <p className="text-sm text-slate-500 mt-1">
              {total} {total === 1 ? 'operazione registrata' : 'operazioni registrate'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchLogs}
              className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
              title="Aggiorna"
            >
              <RefreshCw className={`w-5 h-5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              onClick={onClose}
              className="p-2 text-slate-500 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="p-4 border-b border-slate-100 bg-slate-50">
          <div className="flex items-center gap-2 mb-3">
            <Filter className="w-4 h-4 text-slate-400" />
            <span className="text-sm font-medium text-slate-600">Filtri</span>
            {(selectedUserId || selectedResourceType || selectedAction || fromDate || toDate) && (
              <button
                onClick={resetFilters}
                className="text-xs text-indigo-600 hover:text-indigo-700 ml-2"
              >
                Azzera filtri
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
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
            <div className="p-8 text-center text-slate-500">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto mb-2" />
              Caricamento...
            </div>
          ) : logs.length === 0 ? (
            <div className="p-8 text-center text-slate-500">
              Nessun log trovato
            </div>
          ) : (
            <table className="w-full">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Data/Ora
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Utente
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Azione
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Risorsa
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Nome
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Dettagli
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Stato
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map(log => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-800">
                      {log.user_name || log.user_email || '-'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${ACTION_COLORS[log.action]}`}>
                        {ACTION_LABELS[log.action]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {RESOURCE_LABELS[log.resource_type]}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-800 max-w-[150px] truncate" title={log.resource_name || '-'}>
                      {log.resource_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500 max-w-[200px] truncate" title={formatDetails(log.details)}>
                      {formatDetails(log.details)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                        log.status === 'SUCCESS'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-rose-100 text-rose-700'
                      }`}>
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
          <div className="flex items-center justify-between p-4 border-t border-slate-100">
            <div className="text-sm text-slate-500">
              Pagina {page} di {totalPages}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
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
