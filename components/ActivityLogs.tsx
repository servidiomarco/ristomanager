import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, ChevronLeft, ChevronRight, RefreshCw, Search, FileText, SlidersHorizontal } from 'lucide-react';
import { ModalShell, SegmentedControl, EmptyState, dsInput, dsSelect, dsIconButton, dsStepArrow } from './ds';
import { ActivityLog, ActivityAction, ResourceType, LogFilters, LogRefs } from '../types';
import { logApiService, LogUser } from '../services/logApiService';
import { LogList, ReservationHistory } from './registro/LogList';
import { Loader } from './Loader';

interface ActivityLogsProps {
  isOpen: boolean;
  onClose: () => void;
}

/* I valori (CREATE, RESERVATION, …) sono dell'enum e finiscono nella query:
   si traduce l'etichetta, mai il valore. */
type TFunc = (key: string, defaultValue: string, options?: Record<string, unknown>) => string;

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
  [ResourceType.SETTINGS]: 'Impostazioni',
  [ResourceType.INVENTORY_LOCATION]: 'Magazzino',
  [ResourceType.INVENTORY_CATEGORY]: 'Categoria magazzino',
  [ResourceType.INVENTORY_PRODUCT]: 'Prodotto magazzino',
  [ResourceType.INVENTORY_MOVEMENT]: 'Movimento magazzino'
};

const actionLabel = (a: ActivityAction, t?: TFunc): string =>
  t ? t(`action.${a}`, ACTION_LABELS[a]) : ACTION_LABELS[a];

const resourceLabel = (r: ResourceType, t?: TFunc): string =>
  t ? t(`res.${r}`, RESOURCE_LABELS[r]) : RESOURCE_LABELS[r];

// Quasi ogni indagine parte da «stasera» o «ieri»: il periodo è un tocco,
// le date a mano restano per il resto.
type Period = 'all' | 'today' | 'yesterday' | 'week' | 'custom';

const startOfDay = (offsetDays: number): Date => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - offsetDays);
  return d;
};

const periodRange = (period: Period, fromDate: string, toDate: string): { from?: string; to?: string } => {
  switch (period) {
    case 'today': return { from: startOfDay(0).toISOString() };
    case 'yesterday': return { from: startOfDay(1).toISOString(), to: new Date(startOfDay(0).getTime() - 1).toISOString() };
    case 'week': return { from: startOfDay(6).toISOString() };
    case 'custom':
      // Mezzanotte LOCALE: new Date('2026-10-11') è mezzanotte UTC, e
      // tagliava fuori le prime due ore del giorno.
      return {
        from: fromDate ? new Date(`${fromDate}T00:00:00`).toISOString() : undefined,
        to: toDate ? new Date(`${toDate}T23:59:59.999`).toISOString() : undefined,
      };
    default: return {};
  }
};

const EMPTY_REFS: LogRefs = { tables: {}, rooms: {}, reservations: {}, merge_reservations: {} };
const PAGE_SIZE = 50;

export const ActivityLogs: React.FC<ActivityLogsProps> = ({ isOpen, onClose }) => {
  const { t } = useTranslation('log', { useSuspense: false });
  const [logs, setLogs] = useState<ActivityLog[]>([]);
  const [refs, setRefs] = useState<LogRefs>(EMPTY_REFS);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<LogUser[]>([]);

  // Filters
  const [selectedUserId, setSelectedUserId] = useState<number | undefined>();
  const [selectedResourceType, setSelectedResourceType] = useState<ResourceType | undefined>();
  const [selectedAction, setSelectedAction] = useState<ActivityAction | undefined>();
  const [period, setPeriod] = useState<Period>('all');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // La prenotazione di cui si sta guardando la storia, aperta da un nome.
  const [focus, setFocus] = useState<{ id: number; name: string } | null>(null);
  // Su telefono i tre menu impilati prendevano mezzo schermo prima della
  // prima riga: stanno dietro «Filtri», da sm in su restano sempre visibili.
  const [showFilters, setShowFilters] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);

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
      const range = periodRange(period, fromDate, toDate);
      const filters: LogFilters = {
        user_id: selectedUserId,
        resource_type: selectedResourceType,
        action: selectedAction,
        from_date: range.from,
        to_date: range.to,
        search: debouncedSearch || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE
      };

      const response = await logApiService.getActivityLogs(filters);
      setLogs(response.logs);
      setRefs(response.refs);
      setTotal(response.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('errLoad', 'Errore nel caricamento dei log'));
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
    if (isOpen) fetchUsers();
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) fetchLogs();
  }, [isOpen, page, selectedUserId, selectedResourceType, selectedAction, period, fromDate, toDate, debouncedSearch]);

  const resetFilters = () => {
    setSelectedUserId(undefined);
    setSelectedResourceType(undefined);
    setSelectedAction(undefined);
    setPeriod('all');
    setFromDate('');
    setToDate('');
    setSearch('');
    setDebouncedSearch('');
    setPage(1);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (!isOpen) return null;

  const hasFilters = !!(selectedUserId || selectedResourceType || selectedAction || period !== 'all' || search);
  const hasSelectFilters = !!(selectedUserId || selectedResourceType || selectedAction);

  if (focus) {
    return (
      <ModalShell
        open={isOpen}
        onClose={onClose}
        title={focus.name}
        subtitle={t('historyTitle', 'Cronologia della prenotazione')}
        size="fluid"
        fixedHeight
        bodyClassName="px-5 pb-5 sm:px-6"
        subheader={
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="-ml-2 inline-flex min-h-[44px] items-center gap-1 rounded-[var(--ds-radius-control)] px-2 text-[14px] font-medium text-[var(--ds-text-primary)] hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
            {t('backToLog', 'Registro')}
          </button>
        }
      >
        <ReservationHistory
          key={focus.id}
          reservationId={focus.id}
          onOpenReservation={(id, name) => setFocus({ id, name })}
        />
      </ModalShell>
    );
  }

  return (
    <ModalShell
      open={isOpen}
      onClose={onClose}
      title={t('title', 'Log attività')}
      subtitle={t('count', '{{count}} operazioni registrate', { count: total })}
      size="fluid"
      fixedHeight
      bodyClassName="px-5 pb-5 sm:px-6"
      subheader={
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ds-text-muted)]" aria-hidden />
              <label htmlFor="log-search" className="sr-only">{t('searchAria', 'Cerca nei log')}</label>
              <input
                id="log-search"
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('searchPlaceholder', 'Cerca un cliente, un utente, un piatto…')}
                className={`${dsInput} bg-[var(--ds-surface)] pl-11 pr-11`}
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[var(--ds-radius-control)] text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  title={t('clearSearch', 'Cancella ricerca')}
                  aria-label={t('clearSearch', 'Cancella ricerca')}
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setShowFilters(v => !v)}
              aria-expanded={showFilters || hasSelectFilters}
              className={`${dsIconButton} relative sm:hidden`}
              title={t('filters', 'Filtri')}
              aria-label={t('filters', 'Filtri')}
            >
              <SlidersHorizontal className="h-4 w-4" aria-hidden />
              {hasSelectFilters && (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-[var(--ds-action-bg)]" aria-hidden />
              )}
            </button>
            {/* L'aggiornamento sta con i filtri, non nella testata: è la
                stessa azione — cambiare cosa mostra la lista. */}
            <button
              type="button"
              onClick={fetchLogs}
              className={dsIconButton}
              title={t('reload', 'Aggiorna')}
              aria-label={t('reload', 'Aggiorna')}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />
            </button>
          </div>

          <SegmentedControl<Period>
            value={period}
            onChange={(p) => { setPeriod(p); setPage(1); }}
            ariaLabel={t('period', 'Periodo')}
            overflow="scroll"
            equalWidth={false}
            options={[
              { value: 'all', label: t('periodAll', 'Tutto') },
              { value: 'today', label: t('today', 'Oggi') },
              { value: 'yesterday', label: t('yesterday', 'Ieri') },
              { value: 'week', label: t('periodWeek', '7 giorni') },
              { value: 'custom', label: t('periodCustom', 'Date') },
            ]}
          />

          <div className={`grid grid-cols-1 gap-3 sm:grid-cols-3 ${showFilters || hasSelectFilters ? '' : 'max-sm:hidden'}`}>
            <select
              value={selectedUserId || ''}
              onChange={(e) => {
                setSelectedUserId(e.target.value ? parseInt(e.target.value, 10) : undefined);
                setPage(1);
              }}
              aria-label={t('filterUser', 'Filtra per utente')}
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">{t('allUsers', 'Tutti gli utenti')}</option>
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
              aria-label={t('filterResource', 'Filtra per risorsa')}
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">{t('allResources', 'Tutte le risorse')}</option>
              {Object.values(ResourceType).map(type => (
                <option key={type} value={type}>{resourceLabel(type, t)}</option>
              ))}
            </select>

            <select
              value={selectedAction || ''}
              onChange={(e) => {
                setSelectedAction(e.target.value as ActivityAction || undefined);
                setPage(1);
              }}
              aria-label={t('filterAction', 'Filtra per azione')}
              className={`${dsSelect} bg-[var(--ds-surface)]`}
            >
              <option value="">{t('allActions', 'Tutte le azioni')}</option>
              {Object.values(ActivityAction).map(action => (
                <option key={action} value={action}>{actionLabel(action, t)}</option>
              ))}
            </select>
          </div>

          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="log-from" className="mb-1 block text-[13px] text-[var(--ds-text-muted)]">{t('from', 'Da')}</label>
                <input
                  id="log-from"
                  type="date"
                  value={fromDate}
                  onChange={(e) => { setFromDate(e.target.value); setPage(1); }}
                  className={`${dsInput} bg-[var(--ds-surface)]`}
                />
              </div>
              <div>
                <label htmlFor="log-to" className="mb-1 block text-[13px] text-[var(--ds-text-muted)]">{t('to', 'A')}</label>
                <input
                  id="log-to"
                  type="date"
                  value={toDate}
                  onChange={(e) => { setToDate(e.target.value); setPage(1); }}
                  className={`${dsInput} bg-[var(--ds-surface)]`}
                />
              </div>
            </div>
          )}

          {hasFilters && (
            <button
              type="button"
              onClick={resetFilters}
              className="rounded-[var(--ds-radius-control)] text-[13px] text-[var(--ds-text-primary)] underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {t('clearFilters', 'Azzera filtri')}
            </button>
          )}
        </div>
      }
      footerStart={totalPages > 1 ? t('page', 'Pagina {{n}} di {{totale}}', { n: page, totale: totalPages }) : undefined}
      footer={totalPages > 1 ? (
        <>
          <button
            type="button"
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className={dsStepArrow}
            aria-label={t('prevPage', 'Pagina precedente')}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className={dsStepArrow}
            aria-label={t('nextPage', 'Pagina successiva')}
          >
            <ChevronRight className="h-4 w-4" aria-hidden />
          </button>
        </>
      ) : undefined}
      footerLayout="row"
    >
      {error ? (
        <div role="alert" className="rounded-[var(--ds-radius)] bg-[var(--ds-critical-tint)] p-8 text-center text-[var(--ds-critical-text)]">
          {error}
        </div>
      ) : loading && logs.length === 0 ? (
        <div className="p-8 text-center">
          <Loader size={40} />
        </div>
      ) : logs.length === 0 ? (
        <EmptyState icon={FileText}>{t('empty', 'Nessun log trovato')}</EmptyState>
      ) : (
        <LogList logs={logs} refs={refs} onOpenReservation={(id, name) => setFocus({ id, name })} />
      )}
    </ModalShell>
  );
};
