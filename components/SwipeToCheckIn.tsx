import React, { useRef, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';

/**
 * Swipe-to-check-in — wraps a reservation card; swiping it right past the
 * threshold marks the party as arrived (like archiving an email). Touch-only:
 * mouse users have the state chip and the Reception buttons.
 *
 * Gesture rules:
 * - engages only on a clearly horizontal rightward drag (|dx| > |dy|·1.4),
 *   so vertical list scrolling never fights the gesture (touch-action: pan-y
 *   lets the browser keep vertical panning);
 * - past the threshold the card gains resistance and the underlay saturates —
 *   release = confirm (with a small haptic tick), release early = spring back.
 */
interface SwipeToCheckInProps {
  enabled: boolean;
  onConfirm: () => void;
  children: React.ReactNode;
}

const ENGAGE_PX = 14;        // horizontal intent before the gesture locks
const MAX_PULL_PX = 220;     // hard cap on the visual pull

export const SwipeToCheckIn: React.FC<SwipeToCheckInProps> = ({ enabled, onConfirm, children }) => {
  const [dx, setDx] = useState(0);
  const [springing, setSpringing] = useState(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const engagedRef = useRef(false);
  const widthRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  // Mirror of dx for the touchend handler: on a fast flick the last
  // touchmove's setDx may not have re-rendered yet, and reading the stale
  // state would drop a past-threshold release.
  const dxRef = useRef(0);

  if (!enabled) return <>{children}</>;

  const threshold = () => Math.min(Math.max(widthRef.current * 0.38, 110), 180);

  const reset = (spring: boolean) => {
    startRef.current = null;
    engagedRef.current = false;
    dxRef.current = 0;
    if (spring) {
      setSpringing(true);
      setDx(0);
      window.setTimeout(() => setSpringing(false), 260);
    } else {
      setDx(0);
    }
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startRef.current = { x: t.clientX, y: t.clientY };
    widthRef.current = rootRef.current?.offsetWidth || 320;
    setSpringing(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const start = startRef.current;
    if (!start) return;
    const t = e.touches[0];
    const rawDx = t.clientX - start.x;
    const rawDy = t.clientY - start.y;

    if (!engagedRef.current) {
      // Decide intent once: rightward and clearly horizontal.
      if (rawDx > ENGAGE_PX && Math.abs(rawDx) > Math.abs(rawDy) * 1.4) {
        engagedRef.current = true;
      } else if (Math.abs(rawDy) > ENGAGE_PX) {
        // The user is scrolling — stand down for this touch.
        startRef.current = null;
        return;
      } else {
        return;
      }
    }

    // Resistance past the threshold: the card follows the finger 1:1 up to
    // the threshold, then at 1/3 speed — it feels "armed", not elastic.
    const th = threshold();
    const pulled = rawDx <= th ? rawDx : th + (rawDx - th) / 3;
    const clamped = Math.max(0, Math.min(pulled, MAX_PULL_PX));
    dxRef.current = clamped;
    setDx(clamped);
  };

  const onTouchEnd = () => {
    if (engagedRef.current && dxRef.current >= threshold()) {
      if (navigator.vibrate) navigator.vibrate(30);
      onConfirm();
    }
    reset(true);
  };

  const progress = Math.min(dx / threshold(), 1);
  const armed = progress >= 1;

  return (
    <div
      ref={rootRef}
      className="relative"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={() => reset(true)}
    >
      {/* Underlay — revealed as the card slides right */}
      {dx > 0 && (
        <div
          className={`absolute inset-0 rounded-2xl flex items-center pl-5 gap-2.5 transition-colors ${
            armed ? 'bg-[var(--ds-seated-solid)]' : 'bg-[var(--ds-seated-solid)]/70'
          }`}
          aria-hidden="true"
        >
          <CheckCircle2
            className="h-6 w-6 text-white transition-transform"
            style={{ transform: `scale(${0.8 + progress * 0.4})` }}
          />
          <span className="text-white text-sm font-semibold">
            {armed ? 'Rilascia: Arrivato' : 'Arrivato'}
          </span>
        </div>
      )}
      <div
        style={{
          transform: dx > 0 ? `translateX(${dx}px)` : undefined,
          transition: springing ? 'transform 0.25s cubic-bezier(0.2, 0.8, 0.3, 1)' : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
};
