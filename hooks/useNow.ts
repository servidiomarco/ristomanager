import { useEffect, useState } from 'react';

/**
 * Ticking "now" (epoch ms) that re-renders the consumer on a fixed interval.
 * Drives the time-derived reservation states (In arrivo / In uscita) so the
 * floor map and lists update by themselves as the service progresses.
 *
 * Also refreshes on tab re-focus: a tablet waking up after 20 minutes in a
 * pocket must not show a stale map until the next tick.
 */
export function useNow(intervalMs: number = 60_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = () => setNow(Date.now());
    const id = setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return now;
}
