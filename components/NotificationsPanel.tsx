import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Bell, CheckCheck, X } from 'lucide-react';
import { notificationsApiService, NotificationRow } from '../services/notificationsApiService';
import { SkeletonNotificationList } from './SkeletonCards';
import { SegmentedControl, EmptyState } from './ds';
import { NotificationItem } from './NotificheShared';

/**
 * The bell's dropdown, on pointer-sized screens only.
 *
 * Deliberately lighter than the full page: read-state, the list, clear-all.
 * Category filters and the time sections stay on the page, which is what
 * "Vedi tutte" is for — a 420px panel is for glancing and clearing, not triage.
 *
 * Rows are the same component the page uses, so density, tone mapping and the
 * "…" menu can't drift between the two surfaces.
 */

const PANEL_WIDTH = 420;
const GUTTER = 16;

export const NotificationsPanel: React.FC<{
  /** The bell, so the panel can anchor under it and ignore its own clicks. */
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Opens the full Notifiche page. */
  onSeeAll: () => void;
  /** Lets App refresh the bell badge after a read or a dismiss. */
  onCountsChanged: () => void;
}> = ({ anchorRef, onClose, onSeeAll, onCountsChanged }) => {
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [counts, setCounts] = useState({ total: 0, unread: 0 });
  const [loading, setLoading] = useState(true);
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Anchored with fixed positioning off the bell's rect, clamped so it can't
  // hang off the right edge on a narrow window.
  useEffect(() => {
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      setAt({
        top: r.bottom + 8,
        left: Math.max(GUTTER, Math.min(r.right - PANEL_WIDTH, window.innerWidth - PANEL_WIDTH - GUTTER)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRef]);

  const load = useCallback(async () => {
    try {
      const [{ notifications }, c] = await Promise.all([
        notificationsApiService.list(onlyUnread ? { unread: true } : {}),
        notificationsApiService.counts(),
      ]);
      setItems(notifications);
      setCounts({ total: c.total, unread: c.unread });
    } catch { /* the bell badge already carries the signal */ }
    finally { setLoading(false); }
  }, [onlyUnread]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !anchorRef.current?.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const markRead = async (n: NotificationRow) => {
    if (n.read_at) return;
    try {
      await notificationsApiService.markRead(n.id);
      setItems(prev => prev.map(x => x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x));
      setCounts(c => ({ ...c, unread: Math.max(0, c.unread - 1) }));
      onCountsChanged();
    } catch { /* silent */ }
  };

  const dismiss = async (n: NotificationRow) => {
    try {
      await notificationsApiService.dismiss(n.id);
      setItems(prev => prev.filter(x => x.id !== n.id));
      onCountsChanged();
    } catch { /* silent */ }
  };

  const open = (n: NotificationRow) => {
    markRead(n);
    if (n.url) window.location.href = n.url;
    else onClose();
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await notificationsApiService.markAllRead();
      const now = new Date().toISOString();
      setItems(prev => prev.map(x => x.read_at ? x : { ...x, read_at: now }));
      setCounts(c => ({ ...c, unread: 0 }));
      onCountsChanged();
    } catch { /* silent */ } finally {
      setMarkingAll(false);
    }
  };

  if (!at) return null;

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Notifiche"
      style={{ top: at.top, left: at.left, width: PANEL_WIDTH, maxHeight: 'min(70vh, 620px)' }}
      className="fixed z-[60] flex flex-col overflow-hidden rounded-[24px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-raised)]"
    >
      <div className="flex-shrink-0 space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-[var(--ds-text-primary)]">
            Notifiche
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Chiudi"
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-[var(--ds-text-muted)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <SegmentedControl
          value={onlyUnread ? 'unread' : 'all'}
          onChange={next => { setLoading(true); setOnlyUnread(next === 'unread'); }}
          ariaLabel="Filtra per stato"
          equalWidth={false}
          size="sm"
          options={[
            { value: 'all', label: 'Tutte', badge: counts.total, badgeTone: 'neutral' },
            { value: 'unread', label: 'Non lette', badge: counts.unread, badgeTone: 'alert' },
          ]}
        />
      </div>

      {/* The list is the only thing that scrolls, so the header and the two
          footer actions stay put however long the history is. */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--ds-canvas)] px-3 py-3">
        {loading ? (
          <SkeletonNotificationList count={4} />
        ) : items.length === 0 ? (
          <EmptyState icon={Bell}>
            {onlyUnread ? 'Nessuna notifica da leggere.' : 'Nessuna notifica.'}
          </EmptyState>
        ) : (
          <div className="space-y-2">
            {items.map(n => (
              <NotificationItem
                key={n.id}
                n={n}
                onOpen={open}
                onMarkRead={markRead}
                onDismiss={dismiss}
              />
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center justify-between gap-3 p-3">
        <button
          type="button"
          onClick={markAllRead}
          disabled={markingAll || counts.unread === 0}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-surface-row)] disabled:opacity-40"
        >
          <CheckCheck className="h-4 w-4" aria-hidden />
          Tutte lette
        </button>
        <button
          type="button"
          onClick={() => { onClose(); onSeeAll(); }}
          className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium text-[var(--ds-text-secondary)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)]"
        >
          Vedi tutte
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>,
    document.body
  );
};
