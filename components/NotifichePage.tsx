import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, CheckCheck, X, RefreshCw, Phone, CreditCard, Calendar, MessageCircle, Mail, AlertTriangle, ListFilter, Check, MoreHorizontal } from 'lucide-react';
import { SkeletonNotificationList } from './SkeletonCards';
import { notificationsApiService, NotificationRow } from '../services/notificationsApiService';
import { socketClient } from '../services/socketClient';
import {
  SegmentedControl, SectionHeader, CountBadge, EmptyState, Callout,
  SwipeRow, useFirstRunHint, dsIconButton,
} from './ds';

const formatRelative = (iso: string): string => {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'ora';
  if (min < 60) return `${min} min fa`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h fa`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} g fa`;
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' });
};

// Category → visual bucket. Anything not mapped falls back to "general".
type CategoryFilter = 'all' | 'unread' | 'voice' | 'payment' | 'reservation' | 'message' | 'email' | 'system';

/**
 * Six categories onto four semantic families, so calls and messages share
 * green and payments and email share amber. The icon is what separates them —
 * inventing two more hues would weaken what the existing ones mean everywhere
 * else in the app.
 */
const categoryStyle = (cat: string | null): { Icon: React.ComponentType<{ className?: string }>; tile: string } => {
  switch (cat) {
    case 'voice': return {
      Icon: Phone,
      tile: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
    };
    case 'message': return {
      Icon: MessageCircle,
      tile: 'bg-[var(--ds-seated-tint)] text-[var(--ds-seated-text)]',
    };
    case 'reservation': return {
      Icon: Calendar,
      tile: 'bg-[var(--ds-arriving-tint)] text-[var(--ds-arriving-text)]',
    };
    case 'payment': return {
      Icon: CreditCard,
      tile: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
    };
    case 'email': return {
      Icon: Mail,
      tile: 'bg-[var(--ds-pending-tint)] text-[var(--ds-pending-text)]',
    };
    case 'system': return {
      Icon: AlertTriangle,
      tile: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]',
    };
    default: return {
      Icon: Bell,
      tile: 'bg-[var(--ds-surface-row)] text-[var(--ds-text-secondary)]',
    };
  }
};

/* ── Time buckets ─────────────────────────────────────────────────────────
   Purely presentational: the list arrives newest-first and this only inserts
   headings. "Adesso" is the last half hour — during service that's the window
   where an alert is still worth acting on. */
type Bucket = 'adesso' | 'oggi' | 'ieri' | 'settimana' | 'prima';

const BUCKET_ORDER: Bucket[] = ['adesso', 'oggi', 'ieri', 'settimana', 'prima'];
const BUCKET_LABEL: Record<Bucket, string> = {
  adesso: 'Adesso',
  oggi: 'Oggi',
  ieri: 'Ieri',
  settimana: 'Questa settimana',
  prima: 'Prima',
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const bucketOf = (iso: string, now: Date): Bucket => {
  const d = new Date(iso);
  const diffMin = (now.getTime() - d.getTime()) / 60000;
  if (diffMin < 30) return 'adesso';
  if (sameDay(d, now)) return 'oggi';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'ieri';
  if (now.getTime() - d.getTime() < 7 * 24 * 3600 * 1000) return 'settimana';
  return 'prima';
};

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

/**
 * The two secondary row actions, folded behind a "…" so the row can be one
 * clean tap target. Desktop only — on touch the same two live on the swipe.
 */
const MENU_WIDTH = 208;

const RowMenu: React.FC<{
  onMarkRead?: () => void;
  onDismiss: () => void;
}> = ({ onMarkRead, onDismiss }) => {
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const open = at !== null;

  // Portaled to <body> because the row is a SwipeRow, and that has to keep
  // overflow-hidden to hide its swipe panels — an absolutely positioned menu
  // inside it gets clipped at the row's edge.
  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const height = onMarkRead ? 96 : 52;
    const below = r.bottom + 6;
    setAt({
      // Flip above the trigger when there isn't room beneath it.
      top: below + height > window.innerHeight ? r.top - height - 6 : below,
      left: Math.max(8, r.right - MENU_WIDTH),
    });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !triggerRef.current?.contains(t)) setAt(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    // Fixed positioning doesn't follow a scrolling list, so close rather than
    // let the menu drift away from its row.
    const onScroll = () => setAt(null);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  const item =
    'flex w-full items-center gap-2 px-3 py-2 text-left text-[14px] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)]';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setAt(null) : place())}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Altre azioni"
        className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {at && createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ top: at.top, left: at.left, width: MENU_WIDTH }}
          className="fixed z-[60] overflow-hidden rounded-[16px] bg-[var(--ds-surface)] py-1 shadow-[var(--ds-shadow-raised)]"
        >
          {onMarkRead && (
            <button type="button" role="menuitem" className={item} onClick={() => { setAt(null); onMarkRead(); }}>
              <Check className="h-4 w-4 text-[var(--ds-text-muted)]" aria-hidden />
              Segna come letta
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={`${item} text-[var(--ds-critical-text)]`}
            onClick={() => { setAt(null); onDismiss(); }}
          >
            <X className="h-4 w-4" aria-hidden />
            Rimuovi
          </button>
        </div>,
        document.body
      )}
    </>
  );
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

  const renderRow = (n: NotificationRow, hint: boolean) => {
    const isUnread = !n.read_at;
    const { Icon, tile } = categoryStyle(n.category);
    return (
      <SwipeRow
        key={n.id}
        hint={hint}
        left={isUnread ? {
          label: 'Letta',
          tone: 'confirm',
          icon: <Check className="h-4 w-4" aria-hidden />,
          onAction: () => handleMarkRead(n),
        } : undefined}
        right={{
          label: 'Rimuovi',
          tone: 'danger',
          icon: <X className="h-4 w-4" aria-hidden />,
          onAction: () => handleDismiss(n),
        }}
      >
        <div className="flex items-start gap-3 bg-[var(--ds-surface)] p-3">
          {/* The row itself is the tap target — it opens the record the
              notification points at and marks it read on the way. */}
          <button
            type="button"
            onClick={() => handleOpen(n)}
            className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] rounded-[12px]"
          >
            {/* A read notification keeps its icon but loses its colour — the
                row stays scannable while no longer competing for attention. */}
            <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-[12px] ${
              isUnread ? tile : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
            }`}>
              <Icon className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className={`truncate text-[15px] ${
                isUnread
                  ? 'font-semibold text-[var(--ds-text-primary)]'
                  : 'font-medium text-[var(--ds-text-secondary)]'
              }`}>
                {n.title}
              </h3>
              {n.body && (
                <p className="truncate text-[14px] text-[var(--ds-text-muted)]">{n.body}</p>
              )}
              <span className="mt-0.5 block text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                {formatRelative(n.sent_at)}
              </span>
            </div>
          </button>
          {/* Desktop has no swipe, so the two secondary actions live here.
              On touch they'd duplicate the gesture, so the menu is hidden. */}
          <div className="hidden md:block">
            <RowMenu
              onMarkRead={isUnread ? () => handleMarkRead(n) : undefined}
              onDismiss={() => handleDismiss(n)}
            />
          </div>
        </div>
      </SwipeRow>
    );
  };

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
