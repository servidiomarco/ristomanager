import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CheckCheck, X, RefreshCw, Phone, CreditCard, Calendar, MessageCircle, Mail, AlertTriangle, ExternalLink } from 'lucide-react';
import { CookingPotLoader } from './CookingPotLoader';
import { SkeletonNotificationList } from './SkeletonCards';
import { notificationsApiService, NotificationRow } from '../services/notificationsApiService';
import { socketClient } from '../services/socketClient';

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

const categoryIcon = (cat: string | null) => {
  switch (cat) {
    case 'voice': return { Icon: Phone, cls: 'bg-indigo-50 text-indigo-700 ring-1 ring-indigo-200' };
    case 'payment': return { Icon: CreditCard, cls: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' };
    case 'reservation': return { Icon: Calendar, cls: 'bg-sky-50 text-sky-700 ring-1 ring-sky-200' };
    case 'message': return { Icon: MessageCircle, cls: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200' };
    case 'email': return { Icon: Mail, cls: 'bg-violet-50 text-violet-700 ring-1 ring-violet-200' };
    case 'system': return { Icon: AlertTriangle, cls: 'bg-rose-50 text-rose-700 ring-1 ring-rose-200' };
    default: return { Icon: Bell, cls: 'bg-slate-100 text-slate-700 ring-1 ring-slate-200' };
  }
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

const NotifichePage: React.FC = () => {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [counts, setCounts] = useState<CountsShape>(emptyCounts);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CategoryFilter>('all');
  const [markingAll, setMarkingAll] = useState(false);

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

  const filters: { v: CategoryFilter; l: string }[] = [
    { v: 'all', l: 'Tutte' },
    { v: 'unread', l: 'Non lette' },
    { v: 'reservation', l: 'Prenotazioni' },
    { v: 'voice', l: 'Chiamate' },
    { v: 'message', l: 'Messaggi' },
    { v: 'email', l: 'Email' },
    { v: 'payment', l: 'Pagamenti' },
    { v: 'system', l: 'Sistema' },
  ];

  const unreadCount = useMemo(() => items.filter(x => !x.read_at).length, [items]);

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <div className="space-y-4 max-w-3xl mx-auto">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-xl md:text-2xl font-semibold text-[var(--color-fg)]">Notifiche</h1>
            <p className="text-[13px] text-[var(--color-fg-muted)] mt-0.5">
              Storico degli avvisi ricevuti — persiste anche a browser chiuso.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={load}
              className="p-2 rounded-lg text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-hover)]"
              title="Aggiorna"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={handleMarkAllRead}
                disabled={markingAll}
                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-full border border-[var(--color-line)] text-[var(--color-fg)] text-xs font-medium hover:bg-[var(--color-surface-hover)] disabled:opacity-50"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                Segna tutte come lette
              </button>
            )}
          </div>
        </div>

        {/* Filter chips with per-category count badges. Numbers come from the
            /notifications/counts endpoint so they reflect the full dataset,
            not just the currently rendered list. Chips with count = 0 hide
            the badge so the row doesn't look padded with zeros. */}
        <div className="flex items-center gap-1.5 overflow-x-auto -mx-1 px-1 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {filters.map(({ v, l }) => {
            const active = filter === v;
            const badge =
              v === 'all' ? counts.total
              : v === 'unread' ? counts.unread
              : v === 'reservation' ? counts.by_category.reservation
              : v === 'voice' ? counts.by_category.voice
              : v === 'message' ? counts.by_category.message
              : v === 'email' ? counts.by_category.email
              : v === 'payment' ? counts.by_category.payment
              : v === 'system' ? counts.by_category.system
              : 0;
            return (
              <button
                key={v}
                type="button"
                onClick={() => setFilter(v)}
                className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium border transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
                    : 'bg-[var(--color-bg)] text-[var(--color-fg-muted)] border-[var(--color-line)] hover:text-[var(--color-fg)] hover:border-[var(--color-line-strong)]'
                }`}
              >
                {l}
                {badge > 0 && (
                  <span
                    className={`inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-semibold tabular ${
                      active
                        ? 'bg-white/25 text-white'
                        : v === 'unread'
                          ? 'bg-rose-500 text-white'
                          : 'bg-[var(--color-surface-3)] text-[var(--color-fg-muted)]'
                    }`}
                  >
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-rose-50 text-rose-700 text-sm">{error}</div>
        )}

        {loading ? (
          <SkeletonNotificationList count={6} />
        ) : items.length === 0 ? (
          <div className="bg-[var(--color-surface)] rounded-xl border border-[var(--color-line)] p-10 text-center">
            <Bell className="h-8 w-8 text-[var(--color-fg-subtle)] mx-auto mb-2" />
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              {filter === 'unread' ? 'Nessuna notifica da leggere.' : 'Nessuna notifica.'}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {items.map(n => {
              const isUnread = !n.read_at;
              const { Icon, cls } = categoryIcon(n.category);
              return (
                <li
                  key={n.id}
                  className={`rounded-xl border p-3 md:p-4 transition-colors ${
                    isUnread
                      ? 'bg-indigo-50/40 border-indigo-200 dark:bg-indigo-500/10 dark:border-indigo-500/30'
                      : 'bg-[var(--color-surface)] border-[var(--color-line)]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <div className={`shrink-0 flex items-center justify-center h-8 w-8 rounded-full ${cls}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2 mb-0.5">
                        <h3 className={`text-[14px] leading-snug ${isUnread ? 'font-semibold' : 'font-medium'} text-[var(--color-fg)]`}>
                          {n.title}
                        </h3>
                        <span className="text-[11px] text-[var(--color-fg-subtle)] tabular whitespace-nowrap">
                          {formatRelative(n.sent_at)}
                        </span>
                      </div>
                      {n.body && (
                        <p className="text-[13px] text-[var(--color-fg-muted)] leading-relaxed whitespace-pre-wrap">
                          {n.body}
                        </p>
                      )}
                      <div className="mt-2 flex items-center gap-2 flex-wrap">
                        {n.url && (
                          <button
                            type="button"
                            onClick={() => handleOpen(n)}
                            className="inline-flex items-center gap-1 text-[12px] font-medium text-indigo-600 hover:text-indigo-700"
                          >
                            Apri <ExternalLink className="h-3 w-3" />
                          </button>
                        )}
                        {isUnread && (
                          <button
                            type="button"
                            onClick={() => handleMarkRead(n)}
                            className="text-[12px] text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
                          >
                            Segna come letta
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleDismiss(n)}
                          className="text-[12px] text-[var(--color-fg-subtle)] hover:text-rose-600 inline-flex items-center gap-1"
                          title="Rimuovi dal centro notifiche"
                        >
                          <X className="h-3 w-3" /> Rimuovi
                        </button>
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export default NotifichePage;
