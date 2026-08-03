import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CheckCheck, RefreshCw, AlertTriangle, ListFilter } from 'lucide-react';
import { SkeletonNotificationList } from './SkeletonCards';
import { notificationsApiService, NotificationRow } from '../services/notificationsApiService';
import { socketClient } from '../services/socketClient';
import {
  SegmentedControl, SectionHeader, CountBadge, EmptyState, Callout,
  useFirstRunHint, dsIconButton,
} from './ds';
import {
  NotificationItem, BUCKET_ORDER, BUCKET_LABEL, bucketOf, type Bucket,
} from './NotificheShared';

// Read-state and category are one filter, not two: the endpoint takes either
// `unread` or `category`, never both.
type CategoryFilter = 'all' | 'unread' | 'voice' | 'payment' | 'reservation' | 'message' | 'email' | 'system';

interface CountsShape {
  total: number;
  unread: number;
  by_category: {
    reservation: number;
    voice: number;
    payment: number;
    message: number;
    email: number;
    system: number;
    general: number;
  };
}

const emptyCounts: CountsShape = {
  total: 0, unread: 0,
  by_category: { reservation: 0, voice: 0, payment: 0, message: 0, email: 0, system: 0, general: 0 },
};

const NotifichePage: React.FC = () => {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [counts, setCounts] = useState<CountsShape>(emptyCounts);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const swipeHint = useFirstRunHint('ds-swipe-hint-notifiche');

  const refreshCounts = useCallback(async () => {
    try {
      const c = await notificationsApiService.counts();
      setCounts(c);
    } catch { /* silent — badge just stays stale until next refresh */ }
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const params: Parameters<typeof notificationsApiService.list>[0] = {};
      if (filter === 'unread') params.unread = true;
      else if (filter !== 'all') params.category = filter;
      const [{ notifications }] = await Promise.all([
        notificationsApiService.list(params),
        refreshCounts(),
      ]);
      setItems(notifications);
    } catch (err: any) {
      setError(err?.message || 'Errore caricamento notifiche');
    } finally {
      setLoading(false);
    }
  }, [filter, refreshCounts]);

  useEffect(() => { load(); }, [load]);

  // Live badge: append new notifications as they come in via socket. The
  // backend broadcasts a 'notification:new' event to the recipient's user
  // room in future iterations; for now the page just reloads on socket
  // reconnect so it stays fresh without a manual refresh.
  useEffect(() => {
    const reload = () => load();
    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) attached.off('notification:new', reload);
      attached = s;
      if (attached) attached.on('notification:new', reload);
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => { unsub(); attach(null); };
  }, [load]);

  const handleMarkRead = async (n: NotificationRow) => {
    if (n.read_at) return;
    try {
      await notificationsApiService.markRead(n.id);
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
      refreshCounts();
    } catch { /* silent */ }
  };

  const handleDismiss = async (n: NotificationRow) => {
    try {
      await notificationsApiService.dismiss(n.id);
      setItems(prev => prev.filter(x => x.id !== n.id));
      refreshCounts();
    } catch { /* silent */ }
  };

  const handleOpen = (n: NotificationRow) => {
    handleMarkRead(n);
    if (n.url) window.location.href = n.url;
  };

  const handleMarkAllRead = async () => {
    setMarkingAll(true);
    try {
      await notificationsApiService.markAllRead();
      const now = new Date().toISOString();
      setItems(prev => prev.map(x => x.read_at ? x : { ...x, read_at: now }));
      refreshCounts();
    } catch { /* silent */ } finally {
      setMarkingAll(false);
    }
  };

  // The read-state segment and the category panel are one filter, not two:
  // the endpoint takes either `unread` or `category`, never both, and that is
  // exactly how the page behaved before.
  const categoryFilters: { v: CategoryFilter; l: string; n: number }[] = [
    { v: 'all', l: 'Tutte le categorie', n: 0 },
    { v: 'reservation', l: 'Prenotazioni', n: counts.by_category.reservation },
    { v: 'voice', l: 'Chiamate', n: counts.by_category.voice },
    { v: 'message', l: 'Messaggi', n: counts.by_category.message },
    { v: 'email', l: 'Email', n: counts.by_category.email },
    { v: 'payment', l: 'Pagamenti', n: counts.by_category.payment },
    { v: 'system', l: 'Sistema', n: counts.by_category.system },
  ];
  const categoryActive = filter !== 'all' && filter !== 'unread';

  const unreadCount = useMemo(() => items.filter(x => !x.read_at).length, [items]);

  const groups = useMemo(() => {
    const now = new Date();
    const map = new Map<Bucket, NotificationRow[]>();
    for (const n of items) {
      const b = bucketOf(n.sent_at, now);
      const arr = map.get(b);
      if (arr) arr.push(n); else map.set(b, [n]);
    }
    return BUCKET_ORDER
      .map(b => ({ bucket: b, rows: map.get(b) ?? [] }))
      .filter(g => g.rows.length > 0);
  }, [items]);

  const renderRow = (n: NotificationRow, hint: boolean) => (
    <NotificationItem
      key={n.id}
      n={n}
      hint={hint}
      onOpen={handleOpen}
      onMarkRead={handleMarkRead}
      onDismiss={handleDismiss}
    />
  );

  return (
    <div className="px-4 pb-4 pt-4 sm:px-6 lg:px-8">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h1 className="min-w-0 text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] lg:text-[24px]">
            Notifiche
          </h1>
          <div className="flex flex-shrink-0 items-center gap-2">
            {/* Below sm the labelled pill can't share a row with the filters,
                so it joins the header as an icon instead of wrapping onto a
                line of its own. */}
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={markingAll}
                title="Segna tutte come lette"
                aria-label="Segna tutte come lette"
                className={`${dsIconButton} sm:hidden`}
              >
                <CheckCheck className="h-4 w-4" />
              </button>
            )}
            <button
              type="button"
              onClick={load}
              className={dsIconButton}
              title="Aggiorna"
              aria-label="Aggiorna"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* One row that wraps: "Tutte lette" takes ml-auto so it sits right of
            the filters when there's room and drops to its own line when the
            count badges grow. */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Stretches to fill the row, so the filter button lands on the same
              right edge as the icon buttons in the header above it. */}
          <div className="min-w-0 flex-1">
            <SegmentedControl
              value={filter === 'unread' ? 'unread' : 'all'}
              onChange={next => setFilter(next)}
              ariaLabel="Filtra per stato"
              equalWidth={false}
              options={[
                { value: 'all' as CategoryFilter, label: 'Tutte', badge: counts.total, badgeTone: 'neutral' },
                { value: 'unread' as CategoryFilter, label: 'Non lette', badge: counts.unread, badgeTone: 'alert' },
              ]}
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen(v => !v)}
            aria-expanded={filtersOpen}
            aria-label="Filtri"
            title="Filtri"
            className={filtersOpen
              ? 'relative inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] shadow-[var(--ds-shadow-card)] transition-colors'
              : `relative ${dsIconButton}`}
          >
            <ListFilter className="h-4 w-4" />
            {categoryActive && !filtersOpen && (
              <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-[var(--ds-critical-solid)] ring-2 ring-[var(--ds-surface)]" aria-hidden />
            )}
          </button>
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={handleMarkAllRead}
              disabled={markingAll}
              title="Segna tutte come lette"
              className="ml-auto hidden h-9 flex-shrink-0 items-center gap-1.5 rounded-full bg-[var(--ds-surface)] px-4 text-[14px] font-medium text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-50 sm:inline-flex"
            >
              <CheckCheck className="h-4 w-4" aria-hidden />
              Tutte lette
            </button>
          )}
        </div>

        {filtersOpen && (
          <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
            <SegmentedControl
              value={categoryActive ? filter : 'all'}
              onChange={next => setFilter(next)}
              ariaLabel="Filtra per categoria"
              overflow="scroll"
              size="sm"
              options={categoryFilters.map(c => ({
                value: c.v,
                label: c.l,
                badge: c.v === 'all' ? undefined : c.n,
                badgeTone: 'neutral' as const,
              }))}
            />
          </div>
        )}

        {error && <Callout tone="critical" icon={AlertTriangle}>{error}</Callout>}

        {loading ? (
          <SkeletonNotificationList count={6} />
        ) : items.length === 0 ? (
          <EmptyState icon={Bell}>
            {filter === 'unread' ? 'Nessuna notifica da leggere.' : 'Nessuna notifica.'}
          </EmptyState>
        ) : (
          <div className="space-y-1">
            {groups.map(({ bucket, rows }, gi) => (
              <React.Fragment key={bucket}>
                <SectionHeader
                  tone={bucket === 'adesso' ? 'attention' : 'muted'}
                  action={<CountBadge count={rows.length} />}
                >
                  {BUCKET_LABEL[bucket]}
                </SectionHeader>
                <div className="space-y-2 pb-2">
                  {rows.map((n, i) => renderRow(n, swipeHint && gi === 0 && i === 0))}
                </div>
              </React.Fragment>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default NotifichePage;
