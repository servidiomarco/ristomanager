import type { Vec2 } from '../types';

/* Il passo di chi cammina nella Sala dal vivo: un binario (una spezzata con
 * le sue lunghezze d'arco cumulate) su cui si avanza a velocità costante, una
 * rotazione con un tetto, la fase delle gambe che segue i metri fatti.
 *
 * Chi segue un binario sta ESATTAMENTE nel punto del suo arco: niente molle né
 * inseguimenti, quindi nessuno taglia gli angoli dei tavoli che il percorso
 * aggira, e la fila dietro l'hostess (ognuno qualche decimetro d'arco dietro
 * chi lo precede) ripercorre le sue stesse «briciole» al centimetro. Il corpo
 * si gira verso la direzione del tratto al più di YAW_RATE: a uno spigolo del
 * percorso la testa ruota in un attimo, invece di scattare di 90°.
 *
 * Due tempi, e le allocazioni solo nel primo. I binari si costruiscono quando
 * si pianifica (makeTrack, appendTrack: una volta per percorso). Nel frame
 * (pointAt, followStep, turnToward, advancePhase, easeWalk, isAhead) si
 * scrive in un oggetto dato o si restituiscono numeri: a 30 fps con decine di
 * persone in cammino, un oggetto nuovo a chiamata diventerebbe spazzatura da
 * raccogliere a metà accompagnamento. Puro, senza orologio: il tempo arriva
 * da fuori (dt). */

/** La rotazione più veloce di chi cammina: 7 rad/s, mezzo giro in 0,45 s. */
export const YAW_RATE = 7;
/** Quanto in fretta il passo prende o lascia l'ampiezza piena: 6 al secondo,
 *  da fermo a passo pieno in un sesto di secondo. */
export const WALK_EASE_RATE = 6;

const EPS = 1e-9;
const TAU = Math.PI * 2;

/** Un binario: i punti di una spezzata e l'arco di ciascuno. */
export interface Track {
  /** Le coordinate dei punti, in metri: xs[k], zs[k] è il punto k, nell'ordine
   *  dato (anche due punti uguali di fila restano, così l'indice di un punto
   *  passato a makeTrack è il suo indice qui). */
  xs: Float64Array;
  zs: Float64Array;
  /** L'arco di ogni punto: cum[0] = start, poi ogni tratto aggiunge la sua
   *  lunghezza. Gli archi sono assoluti: con start −12 il secondo punto di
   *  un accompagnamento dalla porta (`outside`) sta all'arco 0. */
  cum: Float64Array;
  /** La lunghezza della spezzata. L'ultimo punto sta all'arco
   *  start + length (trackEnd), non all'arco `length`. */
  length: number;
  /** L'arco del primo punto: negativo quando il binario è stato allungato
   *  all'indietro (la coda dietro la porta). */
  start: number;
}

/** Un punto del binario a un dato arco, e la direzione del tratto (come
 *  rotation.y: il davanti verso +Z locale). */
export interface TrackPoint {
  x: number;
  z: number;
  heading: number;
  /** Il tratto trovato: il suggerimento per la chiamata dopo. */
  seg: number;
}

// Un punto con le due coordinate leggibili.
const isPoint = (p: unknown): p is Vec2 =>
  !!p
  && typeof (p as Vec2).x === 'number' && Number.isFinite((p as Vec2).x)
  && typeof (p as Vec2).z === 'number' && Number.isFinite((p as Vec2).z);

/** Il binario per una spezzata. `start` è l'arco del primo punto (0 se non
 *  detto): un accompagnamento dalla porta parte 12 m prima di `outside`, dove
 *  la fila aspetta invisibile, e `outside` resta all'arco 0.
 *
 *  Un punto illeggibile resta sul precedente (un tratto lungo zero) invece di
 *  sparire: chi costruisce il binario può contare sull'indice dei suoi punti
 *  (cum[3] è l'arco del quarto punto). Le lunghezze con Math.sqrt e non con
 *  Math.hypot: la radice è arrotondata uguale in ogni motore JS, hypot no, e
 *  la TV e il tablet devono trovare gli stessi archi. */
export function makeTrack(points: readonly Vec2[], start = 0): Track {
  const list = Array.isArray(points) ? points : [];
  const n = list.length;
  const xs = new Float64Array(n);
  const zs = new Float64Array(n);
  const cum = new Float64Array(n);
  const s0 = typeof start === 'number' && Number.isFinite(start) ? start : 0;
  let px = 0;
  let pz = 0;
  for (const p of list) {
    if (isPoint(p)) {
      px = p.x;
      pz = p.z;
      break;
    }
  }
  let acc = s0;
  for (let k = 0; k < n; k++) {
    const p = list[k];
    const x = isPoint(p) ? p.x : px;
    const z = isPoint(p) ? p.z : pz;
    if (k > 0) {
      const dx = x - xs[k - 1];
      const dz = z - zs[k - 1];
      acc += Math.sqrt(dx * dx + dz * dz);
    }
    xs[k] = x;
    zs[k] = z;
    cum[k] = acc;
    px = x;
    pz = z;
  }
  return { xs, zs, cum, length: acc - s0, start: s0 };
}

/** L'arco dell'ultimo punto: dove finisce il binario. */
export function trackEnd(track: Track): number {
  const n = track?.cum?.length ?? 0;
  return n > 0 ? track.cum[n - 1] : 0;
}

// Il punto del binario più vicino a (x, z), come arco; a pari distanza il
// primo lungo il binario.
function nearestArc(track: Track, x: number, z: number): number {
  const { xs, zs, cum } = track;
  const n = xs.length;
  let best = cum[0];
  let bestD = (x - xs[0]) * (x - xs[0]) + (z - zs[0]) * (z - zs[0]);
  for (let k = 0; k + 1 < n; k++) {
    const len = cum[k + 1] - cum[k];
    if (len <= EPS) continue;
    const dx = (xs[k + 1] - xs[k]) / len;
    const dz = (zs[k + 1] - zs[k]) / len;
    const along = Math.min(len, Math.max(0, (x - xs[k]) * dx + (z - zs[k]) * dz));
    const qx = xs[k] + dx * along - x;
    const qz = zs[k] + dz * along - z;
    const d = qx * qx + qz * qz;
    if (d < bestD - EPS) {
      bestD = d;
      best = cum[k] + along;
    }
  }
  return best;
}

const cutScratch: TrackPoint = { x: 0, z: 0, heading: 0, seg: 0 };

/** Il binario fatto, più un pezzo nuovo da `from` (RETARGET: la fila continua
 *  sulle briciole già posate).
 *
 *  Il binario vecchio si taglia all'arco `at`, dove sta chi guida (l'hostess),
 *  e lì si attaccano i punti nuovi (di solito findPath dalla sua posizione al
 *  tavolo nuovo: il primo punto è lei, e si salta). Tutto quello che sta
 *  prima del taglio resta com'era, archi compresi, bit per bit: chi la segue
 *  a un arco minore non si sposta di un millimetro e continua sulla stessa
 *  strada, poi prende la nuova. Senza `at` si taglia nel punto del binario più
 *  vicino al primo punto nuovo (a pari distanza il primo): meglio passarlo,
 *  perché un percorso che si incrocia ha due punti uguali. Un `at` oltre i
 *  capi si ferma ai capi. */
export function appendTrack(track: Track, points: readonly Vec2[], at?: number): Track {
  const list = Array.isArray(points) ? points.filter(isPoint) : [];
  const n = track?.xs?.length ?? 0;
  if (n === 0) return makeTrack(list, track?.start ?? 0);
  const { xs, zs, cum } = track;
  let s = typeof at === 'number' && Number.isFinite(at)
    ? at
    : list.length > 0 ? nearestArc(track, list[0].x, list[0].z) : cum[n - 1];
  s = Math.min(cum[n - 1], Math.max(cum[0], s));

  // I punti fino al taglio, com'erano; poi il punto del taglio, se cade a
  // metà di un tratto.
  let k = 0;
  while (k + 1 < n && cum[k + 1] <= s) k++;
  const out: Vec2[] = [];
  for (let i = 0; i <= k; i++) out.push({ x: xs[i], z: zs[i] });
  let cx = xs[k];
  let cz = zs[k];
  if (s > cum[k]) {
    pointAt(track, s, cutScratch, k);
    cx = cutScratch.x;
    cz = cutScratch.z;
    out.push({ x: cx, z: cz });
  }
  list.forEach((p, i) => {
    // Il primo punto nuovo è chi guida, già sul taglio: un doppione no. Se
    // sta un filo fuori (si era scansato per dare la precedenza), resta: un
    // tratto corto la riporta sul percorso nuovo.
    if (i === 0 && Math.abs(p.x - cx) < 1e-6 && Math.abs(p.z - cz) < 1e-6) return;
    out.push({ x: p.x, z: p.z });
  });
  return makeTrack(out, cum[0]);
}

/** Il punto ad arco `s` (fuori dai capi: sul prolungamento del primo e
 *  dell'ultimo segmento) e la sua direzione. `hint` è l'indice di segmento
 *  dell'ultima chiamata (si cammina in avanti: niente ricerca binaria per
 *  frame).
 *
 *  Su un vertice vale il tratto che parte da lì (all'ultimo punto, quello che
 *  ci arriva); i tratti lunghi zero si saltano. Nei punti del binario il
 *  risultato è il punto stesso, bit per bit (interpolazione a·(1−t) + b·t):
 *  chi arriva in fondo sta esattamente dove il percorso finisce. Un arco che
 *  non è un numero vale l'inizio. Scrive in `out` e lo restituisce. */
export function pointAt(track: Track, s: number, out: TrackPoint, hint = 0): TrackPoint {
  const xs = track?.xs;
  const n = xs?.length ?? 0;
  if (n === 0) {
    out.x = 0;
    out.z = 0;
    out.heading = 0;
    out.seg = 0;
    return out;
  }
  const { zs, cum } = track;
  if (n === 1) {
    out.x = xs[0];
    out.z = zs[0];
    out.heading = 0;
    out.seg = 0;
    return out;
  }
  const arc = Number.isFinite(s) ? s : s === Infinity ? cum[n - 1] : cum[0];
  const last = n - 2;
  let k = Number.isFinite(hint) ? Math.trunc(hint) : 0;
  if (k < 0) k = 0;
  else if (k > last) k = last;
  while (k > 0 && arc < cum[k]) k--;
  while (k < last && arc >= cum[k + 1]) k++;

  // Il tratto che dà la direzione: quello trovato, o il primo lungo più di
  // zero dopo di lui (prima dell'inizio), o l'ultimo prima (oltre la fine).
  let m = k;
  if (cum[m + 1] - cum[m] <= EPS) {
    let f = m + 1;
    while (f <= last && cum[f + 1] - cum[f] <= EPS) f++;
    if (f <= last) {
      m = f;
    } else {
      let b = m - 1;
      while (b >= 0 && cum[b + 1] - cum[b] <= EPS) b--;
      m = b;
    }
  }
  out.seg = k;
  if (m < 0) {
    // Tutti i punti coincidono: si sta lì, senza una direzione.
    out.x = xs[0];
    out.z = zs[0];
    out.heading = 0;
    return out;
  }
  const len = cum[m + 1] - cum[m];
  const t = (arc - cum[m]) / len;
  out.x = xs[m] * (1 - t) + xs[m + 1] * t;
  out.z = zs[m] * (1 - t) + zs[m + 1] * t;
  out.heading = Math.atan2(xs[m + 1] - xs[m], zs[m + 1] - zs[m]);
  return out;
}

/** Un angolo avvolto in (−π, π]. Senza trigonometria: un angolo già dentro
 *  torna identico, bit per bit. */
export function wrapAngle(a: number): number {
  if (!Number.isFinite(a)) return 0;
  if (a > -Math.PI && a <= Math.PI) return a;
  const r = a - TAU * Math.ceil((a - Math.PI) / TAU);
  // Il rumore dei float può lasciare −π appena fuori: è lo stesso verso di π.
  return r <= -Math.PI ? r + TAU : r > Math.PI ? r - TAU : r;
}

/** Gira `current` verso `target` di al più `maxDelta` (angoli avvolti in
 *  (−π, π]), dalla parte più corta. Quando ci arriva restituisce `target`
 *  com'è, non avvolto: chi finisce di girarsi ha lo yaw della figura statica
 *  esatto, e il passaggio a People non si vede. */
export function turnToward(current: number, target: number, maxDelta: number): number {
  if (!Number.isFinite(target)) return Number.isFinite(current) ? current : 0;
  if (!Number.isFinite(current)) return target;
  const step = maxDelta > 0 ? maxDelta : 0;
  const d = wrapAngle(target - current);
  if (Math.abs(d) <= step) return target;
  return wrapAngle(current + (d > 0 ? step : -step));
}

/** La fase del passo dopo `distance` metri con falcata `stride`, in [0, 1):
 *  le gambe seguono i metri fatti, non il tempo, così chi rallenta (o si
 *  ferma per dare la precedenza) non pattina. */
export function advancePhase(phase: number, distance: number, stride: number): number {
  const p0 = Number.isFinite(phase) ? phase : 0;
  const p = stride > 0 && Number.isFinite(distance) ? p0 + distance / stride : p0;
  const r = p - Math.floor(p);
  return r >= 1 ? 0 : r;
}

/** L'ampiezza del passo verso `target` (0 o 1) a 6/s: le gambe non scattano
 *  quando si parte o ci si ferma. Arriva a `target` esatto. */
export function easeWalk(current: number, target: number, dtS: number): number {
  const c = Number.isFinite(current) ? current : 0;
  const step = WALK_EASE_RATE * (dtS > 0 ? dtS : 0);
  if (Math.abs(target - c) <= step) return target;
  return c + (target > c ? step : -step);
}

/** Chi è entro `dist` metri davanti (cono di ±45° attorno a `yaw`): la regola
 *  di precedenza. Chi sta esattamente nello stesso punto non conta: due
 *  persone sovrapposte si darebbero la precedenza a vicenda per sempre. */
export function isAhead(ax: number, az: number, yaw: number, bx: number, bz: number, dist: number): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const d2 = dx * dx + dz * dz;
  if (!(d2 > 1e-12) || !(d2 <= dist * dist)) return false;
  const dot = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  // cos 45° = √½: dot ≥ |d|·√½ ⇔ dot > 0 e dot² ≥ d²/2, senza radici.
  return dot > 0 && dot * dot >= 0.5 * d2;
}

/** Chi segue un binario: arco, punto, verso e fase del passo. Lo stato del
 *  regista, riscritto sul posto da followStep. */
export interface Follower {
  /** L'arco sul binario. */
  s: number;
  x: number;
  z: number;
  /** rotation.y: dove guarda. */
  yaw: number;
  /** La fase del passo, in [0, 1). */
  phase: number;
  /** Il tratto dell'ultima pointAt: il suggerimento per la prossima. */
  seg: number;
}

const followScratch: TrackPoint = { x: 0, z: 0, heading: 0, seg: 0 };

/** Un passo di chi segue `track`: avanza a velocità costante `speed` (m/s) per
 *  `dtS` secondi, ma non oltre l'arco `until` (la fine del binario, o il suo
 *  posto in fila); si mette ESATTAMENTE nel punto del suo arco; gira verso la
 *  direzione del tratto al più di `yawRate`·dt; la fase avanza di
 *  distanza / falcata. Restituisce i metri fatti in questo passo (0: fermo, e
 *  allora non si gira: chi aspetta in fila guarda dove guardava). Niente
 *  allocazioni: si chiama nel frame. */
export function followStep(
  f: Follower,
  track: Track,
  speed: number,
  dtS: number,
  stride: number,
  until: number = trackEnd(track),
  yawRate: number = YAW_RATE,
): number {
  const dt = dtS > 0 && Number.isFinite(dtS) ? dtS : 0;
  const v = speed > 0 && Number.isFinite(speed) ? speed : 0;
  const limit = Number.isFinite(until) ? until : trackEnd(track);
  const from = Number.isFinite(f.s) ? f.s : limit;
  const to = Math.max(from, Math.min(limit, from + v * dt));
  const moved = to - from;
  f.s = to;
  pointAt(track, to, followScratch, f.seg);
  f.x = followScratch.x;
  f.z = followScratch.z;
  f.seg = followScratch.seg;
  if (moved > 0) {
    f.yaw = turnToward(f.yaw, followScratch.heading, yawRate * dt);
    f.phase = advancePhase(f.phase, moved, stride);
  }
  return moved;
}
