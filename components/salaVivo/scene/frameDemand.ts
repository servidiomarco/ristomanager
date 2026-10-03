/* Il ritmo dei frame della Sala dal vivo, come conti puri: quanti frame
 * chiedere adesso, quando risvegliarsi, quando un dispositivo non tiene il
 * passo. FrameThrottle li applica; qui niente three né React, così i test li
 * provano in node.
 *
 * Il Canvas è in frameloop="demand": senza una richiesta non parte nessun
 * frame, e la sala ferma costa zero (una TV accesa tutto il servizio non
 * scalda, un tablet in Risparmio energetico non si scarica). */

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
    wake: () => {},
  };
}

export const FPS_ACTIVE = 30;
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

/** Quanti frame al secondo chiedere adesso.
 *
 * - 30 mentre qualcuno muove la camera (da `start` a `end` + 600 ms, e oltre
 *   finché lo smorzamento la sta ancora spostando) o mentre «Centra» anima
 *   il ritorno;
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
  return slowMode ? Math.min(fps, FPS_SLOW_CAP) : fps;
}

/** Quando ripartire se adesso non serve nessun frame solo perché l'anello è
 *  nella parte trasparente del ciclo: l'inizio del ciclo dopo. null = niente
 *  da aspettare (si riparte al prossimo wake()). */
export function pulseResumeAt(demand: FrameDemand, now: number): number | null {
  if (!demand.pulsing || !(demand.pulsePeriodMs > 0) || pulseVisible(demand, now)) return null;
  return now - pulsePhaseMs(demand, now) + demand.pulsePeriodMs;
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
