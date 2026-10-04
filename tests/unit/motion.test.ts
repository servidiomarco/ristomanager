import { describe, it, expect } from 'vitest';
import type { Vec2 } from '../../components/salaVivo/types';
import {
  WALK_EASE_RATE,
  YAW_RATE,
  advancePhase,
  appendTrack,
  easeWalk,
  followStep,
  isAhead,
  makeTrack,
  pointAt,
  trackEnd,
  turnToward,
  wrapAngle,
  type Follower,
  type Track,
  type TrackPoint,
} from '../../components/salaVivo/model/motion';

/* Il passo di chi cammina: velocità costante sul binario, una rotazione col
 * tetto di 7 rad/s, le gambe che seguono i metri, la fila dietro l'hostess a
 * distanze d'arco esatte. */

const DT = 1 / 30;
const punto = (): TrackPoint => ({ x: 0, z: 0, heading: 0, seg: 0 });
const chi = (s = 0, yaw = 0): Follower => ({ s, x: 0, z: 0, yaw, phase: 0, seg: 0 });

// La distanza di un punto dalla spezzata (per dire «sta sul binario»).
const fuoriDalBinario = (t: Track, x: number, z: number): number => {
  let best = Infinity;
  for (let k = 0; k + 1 < t.xs.length; k++) {
    const ax = t.xs[k];
    const az = t.zs[k];
    const bx = t.xs[k + 1];
    const bz = t.zs[k + 1];
    const len2 = (bx - ax) ** 2 + (bz - az) ** 2;
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + (bx - ax) * u - x, az + (bz - az) * u - z));
  }
  return best;
};

// La lunghezza della spezzata fra due archi, misurata a parte: si spezza il
// binario nei suoi vertici e si sommano i pezzi, senza passare da cum.
const arcoMisurato = (points: Vec2[], a: Vec2, b: Vec2): number => {
  // L'arco di un punto che sta sulla spezzata: la somma dei tratti prima del
  // suo, più il pezzo nel suo.
  const arcOf = (p: Vec2): number => {
    let acc = 0;
    let best = Infinity;
    let at = 0;
    for (let k = 0; k + 1 < points.length; k++) {
      const s = points[k];
      const e = points[k + 1];
      const len = Math.hypot(e.x - s.x, e.z - s.z);
      const u = len > 0 ? Math.min(1, Math.max(0, ((p.x - s.x) * (e.x - s.x) + (p.z - s.z) * (e.z - s.z)) / (len * len))) : 0;
      const d = Math.hypot(s.x + (e.x - s.x) * u - p.x, s.z + (e.z - s.z) * u - p.z);
      if (d < best - 1e-12) {
        best = d;
        at = acc + u * len;
      }
      acc += len;
    }
    return at;
  };
  return arcOf(b) - arcOf(a);
};

// Una spezzata con angoli: a destra, giù, in diagonale, a sinistra.
const ZIGZAG: Vec2[] = [
  { x: 1, z: 1 },
  { x: 4, z: 1 },
  { x: 4, z: 3.5 },
  { x: 6, z: 5.5 },
  { x: 2.5, z: 5.5 },
];

describe('il binario', () => {
  it('gli archi cumulati, assoluti: con start −12 il secondo punto sta all\'arco 0', () => {
    const t = makeTrack([{ x: 2, z: 13.8 + 12 }, { x: 2, z: 13.8 }, { x: 2, z: 12.1 }, { x: 2.6, z: 12.1 }], -12);
    expect(t.start).toBe(-12);
    expect(Array.from(t.cum)).toEqual([-12, 0, 13.8 - 12.1, 13.8 - 12.1 + 0.6]);
    expect(t.length).toBeCloseTo(12 + 1.7 + 0.6, 12);
    expect(trackEnd(t)).toBeCloseTo(1.7 + 0.6, 12);
    // Senza start, da 0.
    const z = makeTrack(ZIGZAG);
    expect(z.cum[0]).toBe(0);
    expect(trackEnd(z)).toBe(z.length);
  });

  it('un punto illeggibile resta sul precedente: gli indici dei punti non cambiano', () => {
    const t = makeTrack([{ x: 0, z: 0 }, { x: Number.NaN, z: 1 }, null as unknown as Vec2, { x: 3, z: 4 }]);
    expect(t.xs.length).toBe(4);
    expect(Array.from(t.cum)).toEqual([0, 0, 0, 5]);
    expect(makeTrack(null as unknown as Vec2[]).xs.length).toBe(0);
    expect(makeTrack([{ x: 1, z: 1 }], Number.NaN).start).toBe(0);
  });

  it('pointAt: nei vertici il vertice stesso, bit per bit; a metà, sulla spezzata', () => {
    const t = makeTrack(ZIGZAG);
    const p = punto();
    ZIGZAG.forEach((v, k) => {
      pointAt(t, t.cum[k], p);
      expect([p.x, p.z]).toEqual([v.x, v.z]);
    });
    pointAt(t, 1.5, p);
    expect([p.x, p.z]).toEqual([2.5, 1]);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 12);
    // Sul vertice vale il tratto che parte da lì; in fondo quello che arriva.
    pointAt(t, t.cum[1], p);
    expect(p.heading).toBeCloseTo(0, 12);
    pointAt(t, trackEnd(t), p);
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('pointAt oltre i capi prolunga il primo e l\'ultimo tratto', () => {
    const t = makeTrack(ZIGZAG);
    const p = punto();
    pointAt(t, -2, p);
    expect(p.x).toBeCloseTo(-1, 12);
    expect(p.z).toBeCloseTo(1, 12);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 12);
    pointAt(t, trackEnd(t) + 1.5, p);
    expect(p.x).toBeCloseTo(1, 12);
    expect(p.z).toBeCloseTo(5.5, 12);
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 12);
    // Un tratto lungo zero in coda non toglie la direzione.
    const doppio = makeTrack([...ZIGZAG, ZIGZAG[ZIGZAG.length - 1]]);
    pointAt(doppio, trackEnd(doppio) + 1, p);
    expect(p.x).toBeCloseTo(1.5, 12);
    expect(p.heading).toBeCloseTo(-Math.PI / 2, 12);
    // Un binario di un punto solo: lì, senza direzione.
    pointAt(makeTrack([{ x: 3, z: 2 }]), 5, p);
    expect([p.x, p.z, p.heading]).toEqual([3, 2, 0]);
  });

  it('pointAt col suggerimento sbagliato trova lo stesso punto (avanti e indietro)', () => {
    const t = makeTrack(ZIGZAG);
    const a = punto();
    const b = punto();
    for (let s = -1; s < trackEnd(t) + 1; s += 0.37) {
      pointAt(t, s, a, 0);
      pointAt(t, s, b, 3);
      expect([b.x, b.z, b.heading, b.seg]).toEqual([a.x, a.z, a.heading, a.seg]);
    }
  });
});

describe('chi segue il binario', () => {
  it('velocità costante lungo una spezzata con angoli: passi d\'arco uguali, sempre sul binario', () => {
    const t = makeTrack(ZIGZAG);
    const w = chi(0, Math.PI / 2);
    const v = 1.1;
    let prev = w.s;
    let steps = 0;
    while (w.s < trackEnd(t) && steps < 10_000) {
      const fatto = followStep(w, t, v, DT, 0.7);
      steps++;
      expect(fuoriDalBinario(t, w.x, w.z)).toBeLessThan(1e-9);
      if (w.s < trackEnd(t)) {
        // Ogni passo pieno fa esattamente v·dt d'arco…
        expect(fatto).toBeCloseTo(v * DT, 12);
        expect(w.s - prev).toBeCloseTo(v * DT, 12);
      } else {
        // …l'ultimo si ferma in fondo, senza superarlo.
        expect(fatto).toBeLessThanOrEqual(v * DT + 1e-12);
      }
      prev = w.s;
    }
    expect(w.s).toBe(trackEnd(t));
    expect([w.x, w.z]).toEqual([2.5, 5.5]);
    expect(steps).toBe(Math.ceil(t.length / (v * DT)));
    // Fermo in fondo: niente passi, niente giri.
    const yaw = w.yaw;
    expect(followStep(w, t, v, DT, 0.7)).toBe(0);
    expect(w.yaw).toBe(yaw);
  });

  it('un\'inversione a U: il corpo gira al più di 7 rad/s, poi segue il binario', () => {
    expect(YAW_RATE).toBe(7);
    // Su per 3 m, mezzo metro di lato, giù per 3 m.
    const t = makeTrack([{ x: 0, z: 0 }, { x: 0, z: 3 }, { x: 0.5, z: 3 }, { x: 0.5, z: 0 }]);
    const w = chi(0, 0);
    let maxRate = 0;
    let prevYaw = w.yaw;
    while (w.s < trackEnd(t)) {
      followStep(w, t, 1.3, DT, 0.7);
      maxRate = Math.max(maxRate, Math.abs(wrapAngle(w.yaw - prevYaw)) / DT);
      prevYaw = w.yaw;
    }
    expect(maxRate).toBeLessThanOrEqual(YAW_RATE + 1e-9);
    // Il giro è servito davvero tutto: mezzo giro a 7 rad/s.
    expect(maxRate).toBeGreaterThan(YAW_RATE - 1e-9);
    // In fondo guarda giù (−z): yaw π.
    expect(Math.abs(wrapAngle(w.yaw - Math.PI))).toBeLessThan(1e-9);
  });

  it('la fase avanza di distanza / falcata', () => {
    expect(advancePhase(0.2, 0.35, 0.7)).toBeCloseTo(0.7, 12);
    expect(advancePhase(0.9, 0.14, 0.7)).toBeCloseTo(0.1, 12);
    expect(advancePhase(0, 0.45, 0.45)).toBe(0);
    expect(advancePhase(0.3, 1, 0)).toBeCloseTo(0.3, 12);
    expect(advancePhase(Number.NaN, 0.07, 0.7)).toBeCloseTo(0.1, 12);
    // Lungo un binario: tanti passi quanti metri / falcata, adulto o bambino.
    for (const stride of [0.7, 0.45]) {
      const t = makeTrack([{ x: 0, z: 0 }, { x: 0, z: 2.1 }]);
      const w = chi();
      let giri = 0;
      let prev = 0;
      while (w.s < trackEnd(t)) {
        followStep(w, t, 1.1, DT, stride);
        if (w.phase < prev) giri++;
        prev = w.phase;
      }
      const attesi = 2.1 / stride;
      expect(giri + w.phase).toBeCloseTo(attesi, 9);
    }
  });

  it('la fila: ognuno a un arco esatto dietro chi lo precede, sulle stesse briciole', () => {
    const t = makeTrack(ZIGZAG);
    const gaps = [0.8, 0.7, 0.8, 0.7];
    const p = punto();
    for (let sL = 3.2; sL < trackEnd(t); sL += 0.9) {
      let s = sL;
      pointAt(t, s, p);
      let ahead = { x: p.x, z: p.z };
      for (const gap of gaps) {
        s -= gap;
        pointAt(t, s, p);
        const here = { x: p.x, z: p.z };
        expect(fuoriDalBinario(t, here.x, here.z)).toBeLessThan(1e-9);
        // La distanza lungo il binario, misurata senza cum, è il passo della fila.
        expect(arcoMisurato(ZIGZAG, here, ahead)).toBeCloseTo(gap, 9);
        ahead = here;
      }
    }
  });
});

describe('appendTrack: la fila continua sulle briciole già posate', () => {
  it('il pezzo già fatto resta com\'era, archi compresi; il nuovo parte dal taglio', () => {
    const t = makeTrack([{ x: 2, z: 25.8 }, { x: 2, z: 13.8 }, { x: 2, z: 12.1 }, { x: 2.6, z: 12.1 }, { x: 6, z: 9 }, { x: 9, z: 9 }], -12);
    const at = 4.1; // l'hostess, a metà del tratto verso (6, 9)
    const p = punto();
    pointAt(t, at, p);
    const lei = { x: p.x, z: p.z };
    const nuovo = [lei, { x: 4, z: 6 }, { x: 2, z: 6 }];
    const u = appendTrack(t, nuovo, at);
    // I primi quattro punti e i loro archi, identici.
    expect(Array.from(u.xs.slice(0, 4))).toEqual(Array.from(t.xs.slice(0, 4)));
    expect(Array.from(u.zs.slice(0, 4))).toEqual(Array.from(t.zs.slice(0, 4)));
    expect(Array.from(u.cum.slice(0, 4))).toEqual(Array.from(t.cum.slice(0, 4)));
    expect(u.start).toBe(-12);
    // Il taglio sta all'arco dell'hostess, e da lì si va verso il tavolo nuovo
    // (il primo punto nuovo, che è lei, non si ripete).
    expect(u.xs.length).toBe(4 + 1 + 2);
    expect(u.cum[4]).toBeCloseTo(at, 12);
    expect(u.xs[4]).toBeCloseTo(lei.x, 12);
    expect([u.xs[6], u.zs[6]]).toEqual([2, 6]);
    // Chi la segue a un arco minore non si sposta.
    const q = punto();
    for (const s of [-3, -0.8, 0, 1.2, 2.3, 3.5, 4.0]) {
      pointAt(t, s, p);
      pointAt(u, s, q);
      expect(q.x).toBeCloseTo(p.x, 12);
      expect(q.z).toBeCloseTo(p.z, 12);
    }
    // E il binario finisce dove finisce il percorso nuovo.
    pointAt(u, trackEnd(u), q);
    expect([q.x, q.z]).toEqual([2, 6]);
  });

  it('senza arco si taglia nel punto più vicino al primo punto nuovo; oltre i capi, ai capi', () => {
    const t = makeTrack(ZIGZAG);
    const u = appendTrack(t, [{ x: 4, z: 2 }, { x: 8, z: 2 }]);
    expect(u.cum[2]).toBeCloseTo(4, 12); // 3 m a destra, poi 1 giù
    expect([u.xs[u.xs.length - 1], u.zs[u.zs.length - 1]]).toEqual([8, 2]);
    const fine = appendTrack(t, [{ x: 9, z: 9 }], 1e9);
    expect(Array.from(fine.cum.slice(0, ZIGZAG.length))).toEqual(Array.from(t.cum));
    expect(fine.xs.length).toBe(ZIGZAG.length + 1);
    const vuoto = appendTrack(makeTrack([]), [{ x: 1, z: 1 }, { x: 2, z: 1 }]);
    expect(trackEnd(vuoto)).toBe(1);
  });
});

describe('girarsi, partire, dare la precedenza', () => {
  it('wrapAngle in (−π, π]; un angolo già dentro torna identico', () => {
    expect(wrapAngle(Math.PI)).toBe(Math.PI);
    expect(wrapAngle(-Math.PI)).toBe(Math.PI);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
    expect(wrapAngle(1.5 * Math.PI)).toBeCloseTo(-0.5 * Math.PI, 12);
    expect(wrapAngle(-7)).toBeCloseTo(-7 + 2 * Math.PI, 12);
    expect(wrapAngle(0.3)).toBe(0.3);
    for (let a = -20; a < 20; a += 0.123) {
      const w = wrapAngle(a);
      expect(w).toBeGreaterThan(-Math.PI);
      expect(w).toBeLessThanOrEqual(Math.PI);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
    }
  });

  it('turnToward: dalla parte più corta, al più maxDelta, e il bersaglio esatto quando ci arriva', () => {
    expect(turnToward(0, 1, 0.25)).toBe(0.25);
    expect(turnToward(0, -1, 0.25)).toBe(-0.25);
    // Da 170° a −170° si passa per 180°, non per 0.
    const da = (170 * Math.PI) / 180;
    const a = (-170 * Math.PI) / 180;
    expect(turnToward(da, a, 0.1)).toBeCloseTo(da + 0.1, 12);
    // Raggiunto: proprio il valore dato (lo yaw della figura statica).
    const yawStatico = -2.0943951023931957;
    expect(turnToward(yawStatico + 0.05, yawStatico, 7 * DT)).toBe(yawStatico);
    expect(turnToward(0.2, 0.2, 0)).toBe(0.2);
    expect(turnToward(0.2, 1, 0)).toBe(0.2);
    expect(turnToward(Number.NaN, 1, 0.1)).toBe(1);
  });

  it('easeWalk: verso 0 o 1 a 6 al secondo, fino al valore esatto', () => {
    expect(WALK_EASE_RATE).toBe(6);
    let w = 0;
    let frames = 0;
    while (w < 1) {
      w = easeWalk(w, 1, DT);
      frames++;
    }
    expect(w).toBe(1);
    expect(frames).toBe(5); // 1/6 s a 30 fps
    expect(easeWalk(1, 0, 0.1)).toBeCloseTo(0.4, 12);
    expect(easeWalk(0.3, 0.3, 0)).toBe(0.3);
  });

  it('isAhead: entro la distanza, in un cono di ±45° davanti', () => {
    // Guarda verso +z (yaw 0).
    expect(isAhead(0, 0, 0, 0, 0.4, 0.45)).toBe(true);
    expect(isAhead(0, 0, 0, 0, 0.5, 0.45)).toBe(false);
    expect(isAhead(0, 0, 0, 0.2, 0.3, 0.45)).toBe(true); // 34°
    expect(isAhead(0, 0, 0, 0.3, 0.2, 0.45)).toBe(false); // 56°
    expect(isAhead(0, 0, 0, 0, -0.3, 0.45)).toBe(false); // dietro
    expect(isAhead(0, 0, Math.PI / 2, 0.3, 0, 0.45)).toBe(true); // verso +x
    expect(isAhead(1, 1, 0, 1, 1, 0.45)).toBe(false); // nello stesso punto
  });
});
