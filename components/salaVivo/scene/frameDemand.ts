import type { FrameNeed } from '../types';

/* Il ritmo dei frame della Sala dal vivo, come conti puri: quanti frame
 * chiedere adesso, quando risvegliarsi, quando un dispositivo non tiene il
 * passo. FrameThrottle li applica; qui niente three né React, così i test li
 * provano in node.
 *
 * Il Canvas è in frameloop="demand": senza una richiesta non parte nessun
 * frame, e la sala ferma costa zero (una TV accesa tutto il servizio non
 * scalda, un tablet in Risparmio energetico non si scarica). Da PR3 chiede
 * frame anche il regista: 30 al secondo mentre un ospite o l'hostess si
 * muovono, 20 coi soli camerieri della sala sullo schermo, e quando tutti
 * sono fermi il prossimo risveglio (un cameriere che riparte dal pass). */

/** Lo stato che camera, anelli e throttle condividono: un oggetto mutabile,
 *  fuori da React, perché cambia a ogni gesto e non deve far renderizzare
 *  niente. Chi lo cambia chiama `wake()`. */
export interface FrameDemand {
  /** Fra il `start` e l'`end` dei controlli. */
  interacting: boolean;
  /** performance.now() dell'ultimo `end`. */
  lastEndAt: number;
  /** L'ultimo update dei controlli ha spostato la camera: lo smorzamento
   *  sta ancora lavorando. */
  settling: boolean;
  /** Fine dell'animazione di «Centra», in performance.now(). */
  animatingUntil: number;
  /** C'è un anello che pulsa e il movimento è permesso. */
  pulsing: boolean;
  /** Il ciclo dell'anello in ms, e la sua parte visibile dall'inizio del
   *  ciclo: oltre, l'anello è a opacità 0 fino al giro dopo e non c'è niente
   *  da disegnare. Il ciclo è una funzione di performance.now(), lo stesso
   *  orologio degli anelli, quindi throttle e anelli sanno dove sono senza
   *  parlarsi. 0 = nessun ciclo noto: sempre visibile. */
  pulsePeriodMs: number;
  pulseLiveMs: number;
  /** Quanti frame chiede il regista (director.frameNeed()): lo riscrivono
   *  Walkers dopo ogni passo e il canvas dopo ogni update del regista. */
  motion: FrameNeed;
  /** Con `motion` 'none': in performance.now(), quando qualcuno della sala
   *  ripartirà (director.wakeInMs()). Infinity = nessuno. */
  motionWakeAt: number;
  /** Rivaluta il ritmo subito (lo imposta FrameThrottle quando si monta). */
  wake: () => void;
}

export function createFrameDemand(): FrameDemand {
  return {
    interacting: false,
    lastEndAt: -Infinity,
    settling: false,
    animatingUntil: 0,
    pulsing: false,
    pulsePeriodMs: 0,
    pulseLiveMs: 0,
    motion: 'none',
    motionWakeAt: Infinity,
    wake: () => {},
  };
}

export const FPS_ACTIVE = 30;
/** I soli camerieri che girano: un passo d'ambiente, che a 20 fps si legge
 *  ancora fluido e costa due terzi. */
export const FPS_AMBIENT = 20;
export const FPS_PULSE = 12;
const FPS_SLOW_CAP = 15;
/** Dopo l'`end` dei controlli: lo smorzamento al 12 % ha ancora strada da fare. */
const AFTER_END_MS = 600;
/** Oltre questo, anche se lo smorzamento non ha finito, si smette: il
 *  residuo è sotto il millimetro per frame. */
const SETTLE_CAP_MS = 3000;
/** Sopra questo ritmo si aspetta il vsync (requestAnimationFrame), sotto
 *  basta un timer: 12 risvegli al secondo invece di 60. */
export const VSYNC_FPS = 24;
/** Tolleranza sul vsync: a 60 Hz e a 120 Hz 30 fps cadono su un vsync sì e
 *  uno no, o uno su quattro, senza saltarne per un millisecondo di ritardo. */
export const VSYNC_SLACK_MS = 4;
/** Il declassamento della risoluzione: mai sotto i 40 ms di media. */
const SLOW_FRAME_MS = 40;

// La fase dell'anello in ms dall'inizio del ciclo.
const pulsePhaseMs = (d: FrameDemand, now: number): number =>
  ((now % d.pulsePeriodMs) + d.pulsePeriodMs) % d.pulsePeriodMs;

// L'anello si vede: nella dissolvenza, più un frame dopo, che lo disegna a
// opacità 0 (e nascosto) invece di lasciarlo fermo all'ultimo filo.
const pulseVisible = (d: FrameDemand, now: number): boolean =>
  !(d.pulsePeriodMs > 0) || pulsePhaseMs(d, now) < d.pulseLiveMs + 1000 / FPS_PULSE;

/** I frame che chiede il regista: 30 se si muove un ospite o l'hostess, 20
 *  coi soli camerieri, 0 da fermi. Un valore che questo client non conosce
 *  vale 0. */
export function motionFps(motion: FrameNeed | null | undefined): number {
  return motion === 'active' ? FPS_ACTIVE : motion === 'ambient' ? FPS_AMBIENT : 0;
}

/** Quanti frame al secondo chiedere adesso: il più alto fra
 *
 * - 30 mentre qualcuno muove la camera (da `start` a `end` + 600 ms, e oltre
 *   finché lo smorzamento la sta ancora spostando) o mentre «Centra» anima
 *   il ritorno;
 * - quelli del regista (motionFps): 30 mentre un ospite o l'hostess si
 *   muovono, 20 coi soli camerieri;
 * - 12 finché un anello «in arrivo» pulsa e il movimento è permesso, ma
 *   solo nella parte visibile del ciclo: nel 30 % in cui l'anello è
 *   trasparente un frame ridisegnerebbe la stessa sala;
 * - 0 altrimenti;
 * - mai più di 15 in modalità lenta (WebGL senza accelerazione). */
export function targetFps(demand: FrameDemand, now: number, slowMode: boolean): number {
  let fps = 0;
  if (
    demand.interacting ||
    now < demand.lastEndAt + AFTER_END_MS ||
    now < demand.animatingUntil ||
    (demand.settling && now < demand.lastEndAt + SETTLE_CAP_MS)
  ) {
    fps = FPS_ACTIVE;
  } else if (demand.pulsing && pulseVisible(demand, now)) {
    fps = FPS_PULSE;
  }
  fps = Math.max(fps, motionFps(demand.motion));
  return slowMode ? Math.min(fps, FPS_SLOW_CAP) : fps;
}

/** Quando ripartire se adesso non serve nessun frame solo perché l'anello è
 *  nella parte trasparente del ciclo: l'inizio del ciclo dopo. null = niente
 *  da aspettare (si riparte al prossimo wake()). */
export function pulseResumeAt(demand: FrameDemand, now: number): number | null {
  if (!demand.pulsing || !(demand.pulsePeriodMs > 0) || pulseVisible(demand, now)) return null;
  return now - pulsePhaseMs(demand, now) + demand.pulsePeriodMs;
}

/** Il prossimo risveglio quando adesso non serve nessun frame: il primo fra
 *  il ritorno dell'anello e la ripartenza di un cameriere (motionWakeAt, se
 *  è un istante futuro). null = niente da aspettare: si riparte al prossimo
 *  wake(). */
export function nextWakeAt(demand: FrameDemand, now: number): number | null {
  const pulse = pulseResumeAt(demand, now);
  const motion = demand.motionWakeAt;
  const motionAt = Number.isFinite(motion) && motion > now ? motion : null;
  if (pulse === null) return motionAt;
  if (motionAt === null) return pulse;
  return Math.min(pulse, motionAt);
}

/** Il risveglio non arriva mai prima di un frame d'ambiente da adesso: un
 *  cameriere che riparte 40 ms dopo non si vede, e un regista che dicesse
 *  «fra 0 ms» senza poi muovere nessuno non fa girare il canvas a vuoto. */
export const MIN_MOTION_WAKE_MS = 1000 / FPS_AMBIENT;

/** motionWakeAt da director.wakeInMs(): `now` più l'attesa (almeno
 *  MIN_MOTION_WAKE_MS), Infinity senza un'attesa leggibile. */
export function motionWakeAtFrom(wakeInMs: number | null | undefined, now: number): number {
  if (typeof wakeInMs !== 'number' || !Number.isFinite(wakeInMs)) return Infinity;
  return now + Math.max(MIN_MOTION_WAKE_MS, wakeInMs);
}

/** L'intervallo fra due frame che il throttle produce davvero a `fps` su
 *  uno schermo che va a un vsync ogni `vsyncMs`: disegna al primo vsync in
 *  cui l'attesa scende sotto VSYNC_SLACK_MS. A 60 e 120 Hz 30 fps sono 33 ms;
 *  a 50 e 75 Hz 40 ms, a 48 Hz 41,7: lì è il vsync, non la GPU. */
export function expectedFrameMs(fps: number, vsyncMs: number): number {
  const interval = 1000 / fps;
  if (!(vsyncMs > 0) || !Number.isFinite(vsyncMs)) return interval;
  return Math.max(1, Math.ceil((interval - VSYNC_SLACK_MS) / vsyncMs)) * vsyncMs;
}

/** La media dei frame (a 30 fps, in movimento continuo) oltre la quale la
 *  GPU non ce la fa con la risoluzione attuale e si passa a DPR 1: il ritmo
 *  che questo schermo può dare più mezzo vsync, cioè in media un frame su
 *  due arriva un vsync dopo il previsto. Mai sotto i 40 ms, il limite di
 *  prima, che resta quello di 60 Hz e oltre. Da solo, quel limite fisso
 *  scattava con la GPU ferma su un pannello a 48, 50 o 75 Hz (una TV 4K):
 *  lì 30 fps sono un frame ogni 40 ms o più per via del vsync, e il
 *  collaudo sull'hardware sarebbe finito a DPR 1. Senza un vsync misurato
 *  vale il limite fisso. */
export function slowFrameLimit(vsyncMs: number): number {
  const known = vsyncMs > 0 && Number.isFinite(vsyncMs);
  const expected = expectedFrameMs(FPS_ACTIVE, vsyncMs);
  return Math.max(SLOW_FRAME_MS, known ? expected + vsyncMs / 2 : expected);
}

/** La modalità leggera (niente camerieri) scatta quando per 10 s di
 *  movimento continuo il frame medio sta oltre i 50 ms… */
const LIGHT_FRAME_MS = 50;
/** …o oltre una volta e mezza il ritmo voluto, se è più lungo. «Oltre 50 ms
 *  per 10 s» è il caso degli accompagnamenti a 30 fps (33 ms voluti); coi
 *  soli camerieri a 20 fps 50 ms sono il ritmo stesso, e un timer a 20 fps su
 *  un pannello a 60 Hz cade fra 50 e 67 ms: lì il limite è 75. */
const LIGHT_FRAME_FACTOR = 1.5;

/** Il frame medio oltre il quale, in un tratto continuo a `fps`, il
 *  dispositivo non tiene il passo e i camerieri si spengono. */
export function lightFrameLimit(fps: number, vsyncMs: number): number {
  if (!(fps > 0)) return Infinity;
  return Math.max(LIGHT_FRAME_MS, LIGHT_FRAME_FACTOR * expectedFrameMs(fps, vsyncMs));
}
