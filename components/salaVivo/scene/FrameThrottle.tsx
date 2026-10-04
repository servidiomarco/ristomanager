import { useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import {
  FPS_AMBIENT,
  VSYNC_FPS,
  VSYNC_SLACK_MS,
  lightFrameLimit,
  nextWakeAt,
  slowFrameLimit,
  targetFps,
  type FrameDemand,
} from './frameDemand';

/* Chi decide quando si disegna. Il Canvas è in frameloop="demand": senza una
 * richiesta non parte nessun frame, e la sala ferma costa zero. Qui si
 * chiedono i frame al ritmo che dice targetFps (frameDemand.ts: 30 fps coi
 * controlli o con un ospite che cammina, 20 coi soli camerieri, 12 finché un
 * anello è visibile, 0 da fermi, al più 15 in modalità lenta), e niente
 * mentre la scheda è nascosta.
 *
 * Da fermi si dorme fino al prossimo risveglio che si conosce (nextWakeAt):
 * il ritorno dell'anello, o il cameriere che riparte dal pass. Raggiunto
 * quell'istante si chiede UN frame: lì Walkers fa il passo del regista, il
 * cameriere parte, e la nuova richiesta (20 fps) arriva da Walkers stesso.
 *
 * Gli altri cambi (dati, tema, resize) chiedono un frame solo, con
 * invalidate(). Mai invalidate() dentro useFrame per animare: R3F lo prende
 * come «un altro frame subito» e la sala tornerebbe a 60 fps. */

/** Due frame più distanti di così non sono un movimento continuo. */
const RUN_GAP_MS = 250;
/** Il declassamento guarda gli ultimi 3 s di movimento continuo. */
const SLOW_WINDOW_MS = 3000;
/** La modalità leggera guarda gli ultimi 10 s di movimento continuo… */
const LIGHT_WINDOW_MS = 10_000;
/** …e un dispositivo in affanno fa frame lunghi: fino a un secondo fra due
 *  frame il tratto è ancora continuo (oltre, il canvas si era fermato). */
const LIGHT_RUN_GAP_MS = 1000;

interface FrameThrottleProps {
  demand: FrameDemand;
  slowMode: boolean;
  /** Il dispositivo non tiene il ritmo: il canvas passa a DPR 1. Va nello
   *  stato del Canvas (la prop `dpr`): R3F riapplica la prop a ogni render, e
   *  un setDpr da solo durerebbe fino al minuto dopo. */
  onSlowFrames: () => void;
  /** Per 10 s di movimento continuo i frame non hanno tenuto il ritmo
   *  (lightFrameLimit): il canvas spegne i camerieri. Una volta sola per
   *  montaggio. */
  onLightMode?: () => void;
}

export function FrameThrottle({ demand, slowMode, onSlowFrames, onLightMode }: FrameThrottleProps) {
  const invalidate = useThree((s) => s.invalidate);
  const setDpr = useThree((s) => s.setDpr);
  const dpr = useThree((s) => s.viewport.dpr);
  const onSlowRef = useRef(onSlowFrames);
  const onLightRef = useRef(onLightMode);

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
  // Lo stesso per la modalità leggera: tratti continui a 20 o 30 fps, 10 s.
  // A ritmo cambiato il tratto riparte, perché il limite dipende dal ritmo:
  // 7 s di camerieri a 20 fps (58 ms) seguiti da un accompagnamento a 30
  // farebbero una media oltre i 50 ms senza nessun affanno.
  const [light] = useState(() => ({
    times: new Float64Array(512),
    deltas: new Float64Array(512),
    head: 0,
    size: 0,
    runStart: -1,
    last: -1,
    fps: 0,
    done: false,
  }));

  useEffect(() => {
    onSlowRef.current = onSlowFrames;
    onLightRef.current = onLightMode;
  });

  useEffect(() => {
    let disposed = false;
    let timer: number | null = null;
    let raf = 0;
    let lastKick = -Infinity;
    // L'istante dell'ultimo requestAnimationFrame di una catena, -1 se la
    // catena si è interrotta: l'intervallo fra due callback di fila è il vsync.
    let lastRafTs = -1;
    // Il risveglio del regista già servito: se il frame che ha chiesto non
    // l'ha ancora spostato, non se ne chiede un altro (né un giro di timer).
    let firedWakeAt = NaN;

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
        // È l'ora in cui un cameriere riparte: UN frame, in cui Walkers fa
        // il passo del regista e pubblica il nuovo bisogno (e se cambia
        // risveglia questo throttle da sé).
        const due = demand.motionWakeAt;
        if (due <= now && due !== firedWakeAt) {
          firedWakeAt = due;
          lastKick = now;
          invalidate();
        }
        // Nessun frame, ma un risveglio quando l'anello torna visibile o un
        // cameriere riparte. Altrimenti fermi, niente in coda: il prossimo
        // wake() riparte da qui.
        const at = nextWakeAt(demand, now);
        if (at !== null) timer = window.setTimeout(tick, Math.max(1, at - now));
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

  useFrame(() => {
    const now = performance.now();
    const fps = targetFps(demand, now, slowMode);

    // Il declassamento: a 30 fps il ritmo voluto è un frame ogni 33 ms (o
    // quello che il vsync di questo schermo permette), e una media oltre
    // slowFrameLimit per 3 s di movimento continuo vuol dire che la GPU non
    // ce la fa con la risoluzione attuale. A 12 fps l'intervallo è lungo per
    // scelta e non dice niente.
    const p = perf;
    if (!p.done && !slowMode && dpr > 1) {
      if (fps < VSYNC_FPS) {
        p.last = -1;
      } else if (p.last < 0 || now - p.last > RUN_GAP_MS) {
        p.runStart = now;
        p.head = 0;
        p.size = 0;
        p.last = now;
      } else {
        const cap = p.times.length;
        p.times[p.head] = now;
        p.deltas[p.head] = now - p.last;
        p.head = (p.head + 1) % cap;
        p.size = Math.min(cap, p.size + 1);
        p.last = now;
        if (now - p.runStart >= SLOW_WINDOW_MS) {
          const avg = windowAverage(p.times, p.deltas, p.head, p.size, now, SLOW_WINDOW_MS);
          if (avg > slowFrameLimit(p.vsyncMs)) {
            p.done = true;
            setDpr(1);
            onSlowRef.current();
          }
        }
      }
    }

    // La modalità leggera: in movimento continuo a 20 fps o più (camerieri,
    // accompagnamenti, camera), se il frame medio degli ultimi 10 s supera
    // lightFrameLimit il dispositivo non tiene il passo, e i camerieri si
    // spengono. Il declassamento a DPR 1 arriva prima (3 s) e spesso basta.
    const l = light;
    if (l.done || !onLightRef.current) return;
    if (fps < FPS_AMBIENT) {
      l.last = -1;
      return;
    }
    if (l.last < 0 || fps !== l.fps || now - l.last > LIGHT_RUN_GAP_MS) {
      l.runStart = now;
      l.head = 0;
      l.size = 0;
      l.last = now;
      l.fps = fps;
      return;
    }
    const cap = l.times.length;
    l.times[l.head] = now;
    l.deltas[l.head] = now - l.last;
    l.head = (l.head + 1) % cap;
    l.size = Math.min(cap, l.size + 1);
    l.last = now;
    if (now - l.runStart < LIGHT_WINDOW_MS) return;
    const avg = windowAverage(l.times, l.deltas, l.head, l.size, now, LIGHT_WINDOW_MS);
    if (avg > lightFrameLimit(fps, perf.vsyncMs)) {
      l.done = true;
      onLightRef.current?.();
    }
  });

  return null;
}

/** La media degli intervalli dei campioni degli ultimi `windowMs`, dal più
 *  recente all'indietro, in un anello circolare. 0 senza campioni. */
function windowAverage(times: Float64Array, deltas: Float64Array, head: number, size: number, now: number, windowMs: number): number {
  const cap = times.length;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < size; i++) {
    const k = (head - 1 - i + cap) % cap;
    if (now - times[k] > windowMs) break;
    sum += deltas[k];
    n++;
  }
  return n > 0 ? sum / n : 0;
}
