import React, { useState, useEffect } from 'react';
import { X, ChevronLeft, ChevronRight, RefreshCw, Filter, Search } from 'lucide-react';
import { ModalShell, dsInput, dsSelect, dsIconButton, dsStepArrow } from './ds';
import { ActivityLog, ActivityAction, ResourceType, LogFilters } from '../types';
import { logApiService, LogUser } from '../services/logApiService';
import { Loader } from './Loader';

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
  [ActivityAction.CREATE]: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
  [ActivityAction.UPDATE]: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]',
  [ActivityAction.DELETE]: 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]',
  [ActivityAction.LOGIN]: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]',
  [ActivityAction.LOGOUT]: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
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

  const hasFilters = !!(selectedUserId || selectedResourceType || selectedAction || fromDate || toDate || search);
  const th = 'px-4 py-3 text-left text-[13px] font-semibold text-[var(--ds-text-secondary)]';

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title="Log Attività"
      subtitle={`${total} ${total === 1 ? 'operazione registrata' : 'operazioni registrate'}`}
      size="fluid"
      fixedHeight
      bodyClassName="px-5 pb-5 sm:px-6"
      subheader={
        <div>
          <div className="mb-3 flex items-center gap-2">
            <Filter className="h-3.5 w-3.5 text-[var(--ds-text-muted)]" aria-hidden />
            <span className="text-[13px] font-semibold text-[var(--ds-text-secondary)]">Filtri</span>
            {hasFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="ml-2 rounded-full text-[13px] text-[var(--ds-text-primary)] underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
              >
                Azzera filtri
              </button>
            )}
            {/* L'aggiornamento sta con i filtri, non nella testata: è la
                stessa azione — cambiare cosa mostra la tabella. */}
            <button
              type="button"
              onClick={fetchLogs}
              className={`${dsIconButton} ml-auto`}
              title="Aggiorna"
              aria-label="Aggiorna"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]" aria-hidden />
            <label htmlFor="log-search" className="sr-only">Cerca nei log</label>
            <input
              id="log-search"
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Cerca in tutte le prenotazioni (nome, email, dettagli)..."
              className={`${dsInput} bg-[var(--ds-surface)] pl-11 pr-11`}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                title="Cancella ricerca"
                aria-label="Cancella ricerca"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            )}
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-5">
            <select
              value={selectedUserId || ''}
              onChange={(e) => {
                setSelectedUserId(e.target.value ? parseInt(e.target.value, 10) : undefined);
                setPage(1);
              }}
              aria-label="Filtra per utente"
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">Tutti gli utenti</option>
              {users.map(user => (
                <option key={user.id} value={user.id}>{user.name || user.email}</option>
              ))}
            </select>

            <select
              value={selectedResourceType || ''}
              onChange={(e) => {
                setSelectedResourceType(e.target.value as ResourceType || undefined);
                setPage(1);
              }}
              aria-label="Filtra per risorsa"
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">Tutte le risorse</option>
              {Object.values(ResourceType).map(type => (
                <option key={type} value={type}>{RESOURCE_LABELS[type]}</option>
              ))}
            </select>

            <select
              value={selectedAction || ''}
              onChange={(e) => {
                setSelectedAction(e.target.value as ActivityAction || undefined);
                setPage(1);
              }}
              aria-label="Filtra per azione"
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">Tutte le azioni</option>
              {Object.values(ActivityAction).map(action => (
                <option key={action} value={action}>{ACTION_LABELS[action]}</option>
              ))}
            </select>

            <label htmlFor="log-from" className="sr-only">Da</label>
            <input
              id="log-from"
              type="date"
              value={fromDate}
              onChange={(e) => {
                setFromDate(e.target.value);
                setPage(1);
              }}
              placeholder="Da"
              className={`${dsInput} bg-[var(--ds-surface)]`}
            />

            <label htmlFor="log-to" className="sr-only">A</label>
            <input
              id="log-to"
              type="date"
              value={toDate}
              onChange={(e) => {
                setToDate(e.target.value);
                setPage(1);
              }}
              placeholder="A"
              className={`${dsInput} bg-[var(--ds-surface)]`}
            />
          </div>
        </div>
      }
      footerStart={totalPages > 1 ? `Pagina ${page} di ${totalPages}` : undefined}
      footer={totalPages > 1 ? (
        <>
          <button
            type="button"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className={dsStepArrow}
            aria-label="Pagina precedente"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className={dsStepArrow}
            aria-label="Pagina successiva"
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </>
      ) : undefined}
      footerLayout="row"
    >
      {error ? (
        <div role="alert" className="rounded-[16px] bg-[var(--ds-critical-tint)] p-8 text-center text-[var(--ds-critical-text)]">
          {error}
        </div>
      ) : loading && logs.length === 0 ? (
        <div className="p-8 text-center">
          <Loader label="Caricamento…" size={40} />
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-[20px] bg-[var(--ds-surface)] px-6 py-12 text-center text-[14px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)]">
          Nessun log trovato
        </div>
      ) : (
        <div className="overflow-x-auto rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)]">
          <table className="w-full">
            <thead className="sticky top-0 bg-[var(--ds-surface-row)]">
              <tr>
                <th className={th}>Data/Ora</th>
                <th className={th}>Utente</th>
                <th className={th}>Azione</th>
                <th className={th}>Risorsa</th>
                <th className={th}>Nome</th>
                <th className={th}>Dettagli</th>
                <th className={th}>Stato</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className="border-t border-[var(--ds-border)] transition-colors hover:bg-[var(--ds-surface-row)]">
                  <td className="whitespace-nowrap px-4 py-3 text-[14px] tabular-nums text-[var(--ds-text-muted)]">
                    {formatDate(log.created_at)}
                  </td>
                  <td className="px-4 py-3 text-[14px] text-[var(--ds-text-primary)]">
                    {log.user_name || log.user_email || '-'}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${ACTION_COLORS[log.action]}`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                      {ACTION_LABELS[log.action]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[14px] text-[var(--ds-text-muted)]">
                    {RESOURCE_LABELS[log.resource_type]}
                  </td>
                  <td className="max-w-[150px] truncate px-4 py-3 text-[14px] text-[var(--ds-text-primary)]" title={log.resource_name || '-'}>
                    {log.resource_name || '-'}
                  </td>
                  <td className="max-w-[200px] truncate px-4 py-3 text-[14px] text-[var(--ds-text-muted)]" title={formatDetails(log.details)}>
                    {formatDetails(log.details)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      log.status === 'SUCCESS'
                        ? 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]'
                        : 'bg-[var(--ds-critical-tint)] text-[var(--ds-critical-text)]'
                    }`}>
                      <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60" />
                      {log.status === 'SUCCESS' ? 'OK' : 'Errore'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </ModalShell>
  );
};
