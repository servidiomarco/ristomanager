import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A list row with a revealed action on each side.
 *
 * Touch only. On a pointer device the same actions are reachable by opening the
 * row, so binding drag to the mouse would only fight text selection.
 */

export interface SwipeAction {
  label: string;
  icon?: React.ReactNode;
  /** 'confirm' is the reassuring green (mark read / mark handled);
   *  'primary' is the near-black action colour (call back / reply);
   *  'danger' is for removal, and is deliberately the only red one. */
  tone: 'confirm' | 'primary' | 'danger';
  onAction: () => void;
}

const TONE: Record<SwipeAction['tone'], string> = {
  confirm: 'bg-[var(--ds-seated-solid)] text-white',
  primary: 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]',
  danger: 'bg-[var(--ds-critical-solid)] text-[var(--ds-critical-fg)]',
};

/** How far the row opens to park an action, and how far a flick must travel to
 *  fire it outright without parking. */
const REVEAL = 112;
const OPEN_AT = 44;
const FIRE_AT = 150;

/**
 * True once, briefly, the first time this key is ever seen on this device.
 * Drives the nudge that teaches the gesture exists.
 */
export function useFirstRunHint(storageKey: string): boolean {
  const [play, setPlay] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // No point teaching a gesture the device can't perform, and no point
    // animating for someone who asked for less motion.
    if (!window.matchMedia?.('(pointer: coarse)').matches) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let seen = true;
    try { seen = !!window.localStorage.getItem(storageKey); } catch { return; }
    if (seen) return;
    const start = window.setTimeout(() => setPlay(true), 550);
    const end = window.setTimeout(() => {
      setPlay(false);
      try { window.localStorage.setItem(storageKey, '1'); } catch { /* private mode */ }
    }, 2200);
    return () => { window.clearTimeout(start); window.clearTimeout(end); };
  }, [storageKey]);
  return play;
}

export const SwipeRow: React.FC<{
  /** Revealed by swiping right — the forgiving one. */
  left?: SwipeAction;
  /** Revealed by swiping left — the one that takes you somewhere. */
  right?: SwipeAction;
  /** Play the one-time nudge on this row. */
  hint?: boolean;
  className?: string;
  children: React.ReactNode;
}> = ({ left, right, hint, className = '', children }) => {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; base: number } | null>(null);
  // null until the first move decides whether this is a scroll or a swipe.
  const axis = useRef<'x' | 'y' | null>(null);

  const close = useCallback(() => setDx(0), []);

  const fire = useCallback((action: SwipeAction) => {
    setDx(0);
    action.onAction();
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    // The pointer type is the gate, not a media query: '(pointer: coarse)' is
    // false in a desktop browser's device emulation, which made the gesture
    // untestable and silently dead on some hybrid machines.
    if (e.pointerType === 'mouse') return;
    // Capture, or a finger that leaves the row's box stops sending moves and
    // the swipe freezes half-open.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported */ }
    start.current = { x: e.clientX, y: e.clientY, base: dx };
    axis.current = null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const mx = e.clientX - start.current.x;
    const my = e.clientY - start.current.y;
    if (axis.current === null) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      // Vertical wins ties: a list is scrolled far more often than swiped, and
      // stealing the scroll is the one failure people notice immediately.
      axis.current = Math.abs(mx) > Math.abs(my) * 1.3 ? 'x' : 'y';
      if (axis.current === 'x') setDragging(true);
    }
    if (axis.current !== 'x') return;
    let next = start.current.base + mx;
    // Don't let a side open when it has nothing behind it.
    if (next > 0 && !left) next = 0;
    if (next < 0 && !right) next = 0;
    setDx(Math.max(-FIRE_AT - 40, Math.min(FIRE_AT + 40, next)));
  };

  const onPointerUp = () => {
    if (!start.current) return;
    const settled = axis.current === 'x';
    start.current = null;
    axis.current = null;
    setDragging(false);
    if (!settled) return;
    if (dx >= FIRE_AT && left) return fire(left);
    if (dx <= -FIRE_AT && right) return fire(right);
    if (dx >= OPEN_AT && left) return setDx(REVEAL);
    if (dx <= -OPEN_AT && right) return setDx(-REVEAL);
    setDx(0);
  };

  const open = dx !== 0;

  return (
    // The row is the card here — it carries its own elevation off the canvas.
    <div className={`relative overflow-hidden rounded-[16px] shadow-[var(--ds-shadow-card)] ${className}`}>
      {left && (
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          onClick={() => fire(left)}
          className={`absolute inset-y-0 left-0 flex items-center justify-center gap-1.5 px-4 text-[14px] font-semibold ${TONE[left.tone]}`}
          style={{ width: REVEAL }}
        >
          {left.icon}
          {left.label}
        </button>
      )}
      {right && (
        <button
          type="button"
          tabIndex={open ? 0 : -1}
          aria-hidden={!open}
          onClick={() => fire(right)}
          className={`absolute inset-y-0 right-0 flex items-center justify-center gap-1.5 px-4 text-[14px] font-semibold ${TONE[right.tone]}`}
          style={{ width: REVEAL }}
        >
          {right.label}
          {right.icon}
        </button>
      )}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Let the browser own vertical scrolling; we only claim the x axis.
        style={{
          transform: `translateX(${dx}px)`,
          transition: dragging ? 'none' : 'transform 220ms cubic-bezier(0.22, 0.61, 0.36, 1)',
          touchAction: 'pan-y',
        }}
        className={`relative ${hint && !open ? 'ds-swipe-hint' : ''}`}
      >
        {children}
        {/* Tapping the row itself while it's parked closes it rather than
            opening the record — the overlay sits inside the sliding layer, so
            it never covers the revealed action. */}
        {open && (
          <button
            type="button"
            aria-label="Chiudi azioni"
            onClick={close}
            className="absolute inset-0 z-10 bg-transparent"
          />
        )}
      </div>
    </div>
  );
};
