import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { VSYNC_FPS, VSYNC_SLACK_MS, pulseResumeAt, slowFrameLimit, targetFps, type FrameDemand } from './frameDemand';

/* Chi decide quando si disegna. Il Canvas è in frameloop="demand": senza una
 * richiesta non parte nessun frame, e la sala ferma costa zero. Qui si
 * chiedono i frame al ritmo che dice targetFps (frameDemand.ts: 30 fps coi
 * controlli, 12 finché un anello è visibile, 0 da fermi, al più 15 in
 * modalità lenta), e niente mentre la scheda è nascosta.
 *
 * Gli altri cambi (dati, tema, resize) chiedono un frame solo, con
 * invalidate(). Mai invalidate() dentro useFrame per animare: R3F lo prende
 * come «un altro frame subito» e la sala tornerebbe a 60 fps. */

/** Due frame più distanti di così non sono un movimento continuo. */
const RUN_GAP_MS = 250;
/** Il declassamento guarda gli ultimi 3 s di movimento continuo. */
const SLOW_WINDOW_MS = 3000;

interface FrameThrottleProps {
  demand: FrameDemand;
  slowMode: boolean;
  /** Il dispositivo non tiene il ritmo: il canvas passa a DPR 1. Va nello
   *  stato del Canvas (la prop `dpr`): R3F riapplica la prop a ogni render, e
   *  un setDpr da solo durerebbe fino al minuto dopo. */
  onSlowFrames: () => void;
}

export function FrameThrottle({ demand, slowMode, onSlowFrames }: FrameThrottleProps) {
  const invalidate = useThree((s) => s.invalidate);
  const setDpr = useThree((s) => s.setDpr);
  const dpr = useThree((s) => s.viewport.dpr);
  const onSlowRef = useRef(onSlowFrames);

  // Il tempo dei frame, solo nei tratti di movimento continuo a 30 fps (un
  // anello circolare di campioni: niente allocazioni), e il vsync di questo
  // schermo: il più breve intervallo visto fra due requestAnimationFrame di
  // fila. Senza il vsync un pannello a 50 Hz, dove 30 fps diventano un frame
  // ogni 40 ms, sembrerebbe una GPU in affanno.
  const [perf] = useState(() => ({
    times: new Float64Array(256),
    deltas: new Float64Array(256),
    head: 0,
    size: 0,
    runStart: -1,
    last: -1,
    done: false,
    vsyncMs: Infinity,
  }));

  useEffect(() => {
    onSlowRef.current = onSlowFrames;
  });

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let raf = 0;
    let lastKick = -Infinity;
    // L'istante dell'ultimo requestAnimationFrame di una catena, -1 se la
    // catena si è interrotta: l'intervallo fra due callback di fila è il vsync.
    let lastRafTs = -1;

    const stop = () => {
      if (timer !== null) window.clearTimeout(timer);
      if (raf) cancelAnimationFrame(raf);
      timer = null;
      raf = 0;
      lastRafTs = -1;
    };

    const tick = () => {
      timer = null;
      raf = 0;
      if (disposed) return;
      if (document.visibilityState === 'hidden') {
        lastRafTs = -1;
        return;
      }
      const now = performance.now();
      const fps = targetFps(demand, now, slowMode);
      if (fps <= 0) {
        lastRafTs = -1;
        // L'anello è nella parte trasparente del ciclo: nessun frame, ma un
        // risveglio quando torna visibile. Altrimenti fermi, niente in coda:
        // il prossimo wake() riparte da qui.
        const resume = pulseResumeAt(demand, now);
        if (resume !== null) timer = window.setTimeout(tick, Math.max(1, resume - now));
        return;
      }
      const interval = 1000 / fps;
      const vsync = fps >= VSYNC_FPS;
      const wait = lastKick + interval - now;
      if (wait <= (vsync ? VSYNC_SLACK_MS : 1)) {
        lastKick = now;
        invalidate();
      }
      if (vsync) {
        raf = requestAnimationFrame(onRaf);
      } else {
        lastRafTs = -1;
        timer = window.setTimeout(tick, Math.max(1, Math.min(interval, lastKick + interval - now)));
      }
    };

    function onRaf(ts: number) {
      if (lastRafTs >= 0) {
        const dt = ts - lastRafTs;
        if (dt > 2 && dt < RUN_GAP_MS) perf.vsyncMs = Math.min(perf.vsyncMs, dt);
      }
      lastRafTs = ts;
      tick();
    }

    demand.wake = () => {
      if (disposed) return;
      stop();
      tick();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') invalidate();
      demand.wake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    demand.wake();

    return () => {
      disposed = true;
      stop();
      demand.wake = () => {};
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [demand, slowMode, invalidate, perf]);

  // Il declassamento: a 30 fps il ritmo voluto è un frame ogni 33 ms (o
  // quello che il vsync di questo schermo permette), e una media oltre
  // slowFrameLimit per 3 s di movimento continuo vuol dire che la GPU non ce
  // la fa con la risoluzione attuale. A 12 fps l'intervallo è lungo per
  // scelta e non dice niente.
  useFrame(() => {
    const p = perf;
    if (p.done || slowMode || !(dpr > 1)) return;
    const now = performance.now();
    const continuous = targetFps(demand, now, slowMode) >= VSYNC_FPS;
    if (!continuous) {
      p.last = -1;
      return;
    }
    if (p.last < 0 || now - p.last > RUN_GAP_MS) {
      p.runStart = now;
      p.head = 0;
      p.size = 0;
      p.last = now;
      return;
    }
    const cap = p.times.length;
    p.times[p.head] = now;
    p.deltas[p.head] = now - p.last;
    p.head = (p.head + 1) % cap;
    p.size = Math.min(cap, p.size + 1);
    p.last = now;
    if (now - p.runStart < SLOW_WINDOW_MS) return;
    let sum = 0;
    let n = 0;
    for (let i = 0; i < p.size; i++) {
      const k = (p.head - 1 - i + cap) % cap;
      if (now - p.times[k] > SLOW_WINDOW_MS) break;
      sum += p.deltas[k];
      n++;
    }
    if (n > 0 && sum / n > slowFrameLimit(p.vsyncMs)) {
      p.done = true;
      setDpr(1);
      onSlowRef.current();
    }
  });

  return null;
}
