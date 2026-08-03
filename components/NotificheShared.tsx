import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, X, Phone, CreditCard, Calendar, MessageCircle, Mail, AlertTriangle, Check, MoreHorizontal } from 'lucide-react';
import { NotificationRow } from '../services/notificationsApiService';
import { SwipeRow } from './ds';

/**
 * Everything the notifications list is made of, shared by the full page and
 * the desktop bell panel. One implementation so the two can't drift apart in
 * row density, tone mapping or what the "…" menu offers.
 */

export const formatRelative = (iso: string): string => {
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
/**
 * Six categories onto four semantic families, so calls and messages share
 * green and payments and email share amber. The icon is what separates them —
 * inventing two more hues would weaken what the existing ones mean everywhere
 * else in the app.
 */
export const categoryStyle = (cat: string | null): { Icon: React.ComponentType<{ className?: string }>; tile: string } => {
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
export type Bucket = 'adesso' | 'oggi' | 'ieri' | 'settimana' | 'prima';

export const BUCKET_ORDER: Bucket[] = ['adesso', 'oggi', 'ieri', 'settimana', 'prima'];
export const BUCKET_LABEL: Record<Bucket, string> = {
  adesso: 'Adesso',
  oggi: 'Oggi',
  ieri: 'Ieri',
  settimana: 'Questa settimana',
  prima: 'Prima',
};

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export const bucketOf = (iso: string, now: Date): Bucket => {
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


/**
 * The two secondary row actions, folded behind a "…" so the row can be one
 * clean tap target. Desktop only — on touch the same two live on the swipe.
 */
const MENU_WIDTH = 208;

export const RowMenu: React.FC<{
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

/* ── NotificationItem ─────────────────────────────────────────────────────
   One row. The card itself is the tap target: it opens whatever the
   notification points at and marks it read on the way. Secondary actions ride
   the swipe on touch and the "…" menu on a pointer. */
export const NotificationItem: React.FC<{
  n: NotificationRow;
  hint?: boolean;
  onOpen: (n: NotificationRow) => void;
  onMarkRead: (n: NotificationRow) => void;
  onDismiss: (n: NotificationRow) => void;
}> = ({ n, hint, onOpen, onMarkRead, onDismiss }) => {
  const isUnread = !n.read_at;
  const { Icon, tile } = categoryStyle(n.category);
  return (
    <SwipeRow
      hint={hint}
      left={isUnread ? {
        label: 'Letta',
        tone: 'confirm',
        icon: <Check className="h-4 w-4" aria-hidden />,
        onAction: () => onMarkRead(n),
      } : undefined}
      right={{
        label: 'Rimuovi',
        tone: 'danger',
        icon: <X className="h-4 w-4" aria-hidden />,
        onAction: () => onDismiss(n),
      }}
    >
      <div className="flex items-start gap-3 bg-[var(--ds-surface)] p-3">
        <button
          type="button"
          onClick={() => onOpen(n)}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-[12px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          {/* A read notification keeps its icon but loses its colour — the row
              stays scannable while no longer competing for attention. */}
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
        {/* A pointer has no swipe, so the two secondary actions live here. On
            touch they'd duplicate the gesture, so the menu is hidden. */}
        <div className="hidden md:block">
          <RowMenu
            onMarkRead={isUnread ? () => onMarkRead(n) : undefined}
            onDismiss={() => onDismiss(n)}
          />
        </div>
      </div>
    </SwipeRow>
  );
};
