import { describe, it, expect } from 'vitest';
import { HIGH_CHAIR_SEAT_HEIGHT, SEAT_HEIGHT } from '../../components/salaVivo/model/geometry';
import {
  ARM_SWING_RATIO,
  BOB,
  DOG_LEG_LENGTH,
  DOG_LEG_TOP,
  DOG_STAND_LIFT,
  DOG_SWING,
  J_ANKLE,
  J_ELBOW,
  J_HIP,
  J_KNEE,
  J_SHOULDER,
  J_WRIST,
  KID_SCALE,
  KNEE_BEND,
  LEG_SWING,
  SEATED,
  SEAT_HIP_FORWARD,
  SEAT_HIP_LIFT,
  STANDING,
  STAND_HIP,
  TRAY_Y,
  createPoseJoints,
  mix,
  poseJoints,
  type PoseInput,
  type PoseJoints,
  type StillPose,
} from '../../components/salaVivo/scene/walkPose';

/* Le pose delle figure: in piedi, sedute, in cammino, l'hostess che accoglie,
 * il cameriere col vassoio, il cane. La prova che conta di più è la prima:
 * un attore del regista torna figura statica (People) solo quando la sua
 * posa è quella dello slot, e il passaggio non si deve vedere. Per questo le
 * estremità si confrontano con toBe, bit per bit, non con toBeCloseTo. */

const JOINTS: Array<[keyof StillPose, number]> = [
  ['hip', J_HIP],
  ['knee', J_KNEE],
  ['ankle', J_ANKLE],
  ['shoulder', J_SHOULDER],
  ['elbow', J_ELBOW],
  ['wrist', J_WRIST],
];

const fermo = (over: Partial<PoseInput> = {}): PoseInput => ({
  kind: 'adult',
  seat: 0,
  seatHeight: 0,
  walk: 0,
  phase: 0,
  arm: 0,
  tray: false,
  ...over,
});

const posa = (input: PoseInput): PoseJoints => poseJoints(input, createPoseJoints());

/** Un'articolazione di un lato: [x, y, z]. */
const at = (j: PoseJoints, side: number, k: number): [number, number, number] => {
  const a = j.sides[side];
  return [a[k], a[k + 1], a[k + 2]];
};

const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** L'angolo in avanti di un segmento rispetto alla verticale in giù. */
const pitch = (from: readonly number[], to: readonly number[]): number => Math.atan2(to[2] - from[2], -(to[1] - from[1]));

describe('le pose ferme sono quelle di PR2c, bit per bit', () => {
  it('in piedi: le articolazioni di STANDING, il destro specchiato, il bacino a 0,92', () => {
    for (const kind of ['adult', 'kid', 'hostess', 'waiter'] as const) {
      const j = posa(fermo({ kind }));
      const s = kind === 'kid' ? KID_SCALE : 1;
      expect(j.hipY).toBe(STAND_HIP * s);
      expect(j.hipForward).toBe(0);
      expect(j.tray).toBe(false);
      for (const [name, k] of JOINTS) {
        expect(at(j, 0, k)).toEqual([...STANDING[name]]);
        expect(at(j, 1, k)).toEqual([-STANDING[name][0], STANDING[name][1], STANDING[name][2]]);
      }
    }
  });

  it('seduti: le articolazioni di SEATED, il bacino sulla seduta e 2 cm verso il tavolo', () => {
    for (const kind of ['adult', 'kid'] as const) {
      for (const seatHeight of [SEAT_HEIGHT, HIGH_CHAIR_SEAT_HEIGHT]) {
        const j = posa(fermo({ kind, seat: 1, seatHeight }));
        const s = kind === 'kid' ? KID_SCALE : 1;
        expect(j.hipY).toBe(seatHeight + SEAT_HIP_LIFT * s);
        expect(j.hipForward).toBe(SEAT_HIP_FORWARD * s);
        for (const [name, k] of JOINTS) {
          expect(at(j, 0, k)).toEqual([...SEATED[name]]);
          expect(at(j, 1, k)).toEqual([-SEATED[name][0], SEATED[name][1], SEATED[name][2]]);
        }
      }
    }
  });

  it('una seduta illeggibile o a 0 vale SEAT_HEIGHT, come in People', () => {
    for (const seatHeight of [0, -1, NaN, undefined as unknown as number]) {
      expect(posa(fermo({ seat: 1, seatHeight })).hipY).toBe(SEAT_HEIGHT + SEAT_HIP_LIFT);
    }
  });

  it('mix è esatto alle estremità', () => {
    expect(mix(0.92, 0.52, 0)).toBe(0.92);
    expect(mix(0.92, 0.52, 1)).toBe(0.52);
    expect(mix(0.1, 0.7, 1)).toBe(0.7);
    expect(mix(2, 4, 0.5)).toBe(3);
  });
});

describe('sedersi e alzarsi', () => {
  it('a metà strada la media delle due pose, coi piedi sempre a 7 cm da terra', () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const j = posa(fermo({ seat: t, seatHeight: SEAT_HEIGHT }));
      expect(j.hipY).toBeCloseTo(STAND_HIP + (SEAT_HEIGHT + SEAT_HIP_LIFT - STAND_HIP) * t, 9);
      const ankle = at(j, 0, J_ANKLE);
      expect(j.hipY + ankle[1]).toBeCloseTo(0.07, 9);
      const knee = at(j, 0, J_KNEE);
      expect(knee[2]).toBeCloseTo(SEATED.knee[2] * t, 9);
    }
  });

  it('seat fuori da [0, 1] si ferma alle estremità', () => {
    expect(posa(fermo({ seat: 3 })).hipY).toBe(SEAT_HEIGHT + SEAT_HIP_LIFT);
    expect(posa(fermo({ seat: -2 })).hipY).toBe(STAND_HIP);
  });
});

describe('il passo', () => {
  it('a un quarto di passo la gamba sinistra avanti di 28° e la destra indietro, tutte e due dritte', () => {
    const j = posa(fermo({ walk: 1, phase: 0.25 }));
    const hipL = at(j, 0, J_HIP);
    const kneeL = at(j, 0, J_KNEE);
    const hipR = at(j, 1, J_HIP);
    const kneeR = at(j, 1, J_KNEE);
    expect(pitch(hipL, kneeL)).toBeCloseTo(LEG_SWING, 9);
    expect(pitch(hipR, kneeR)).toBeCloseTo(-LEG_SWING, 9);
    // Agli estremi del passo le gambe sono dritte.
    expect(pitch(kneeL, at(j, 0, J_ANKLE))).toBeCloseTo(LEG_SWING, 9);
    expect(pitch(kneeR, at(j, 1, J_ANKLE))).toBeCloseTo(-LEG_SWING, 9);
    // Il bacino scende di 2,5 cm a gambe aperte.
    expect(j.hipY).toBeCloseTo(STAND_HIP - BOB, 9);
  });

  it('la gamba che torna avanti piega il ginocchio, quella d\'appoggio no', () => {
    // A fase 0 il sinistro passa sotto il bacino tornando avanti, il destro
    // sotto il bacino in appoggio.
    const j = posa(fermo({ walk: 1, phase: 0 }));
    expect(pitch(at(j, 0, J_HIP), at(j, 0, J_KNEE))).toBeCloseTo(0, 9);
    expect(pitch(at(j, 0, J_KNEE), at(j, 0, J_ANKLE))).toBeCloseTo(-KNEE_BEND, 9);
    expect(pitch(at(j, 1, J_KNEE), at(j, 1, J_ANKLE))).toBeCloseTo(0, 9);
    // Il piede in aria sta sopra quello d'appoggio.
    expect(at(j, 0, J_ANKLE)[1]).toBeGreaterThan(at(j, 1, J_ANKLE)[1] + 0.05);
    // Mezzo passo dopo, le parti si scambiano.
    const k = posa(fermo({ walk: 1, phase: 0.5 }));
    expect(pitch(at(k, 1, J_KNEE), at(k, 1, J_ANKLE))).toBeCloseTo(-KNEE_BEND, 9);
    expect(pitch(at(k, 0, J_KNEE), at(k, 0, J_ANKLE))).toBeCloseTo(0, 9);
  });

  it('le braccia vanno in controfase, a 0,8 dell\'ampiezza delle gambe', () => {
    const j = posa(fermo({ walk: 1, phase: 0.25 }));
    const swingL = pitch(at(j, 0, J_SHOULDER), at(j, 0, J_ELBOW)) - pitch(STANDING.shoulder, STANDING.elbow);
    const swingR = pitch(at(j, 1, J_SHOULDER), at(j, 1, J_ELBOW)) - pitch(STANDING.shoulder, STANDING.elbow);
    expect(swingL).toBeCloseTo(-ARM_SWING_RATIO * LEG_SWING, 9);
    expect(swingR).toBeCloseTo(ARM_SWING_RATIO * LEG_SWING, 9);
  });

  it('a mezzo passo le cosce sono di nuovo verticali, e l\'ampiezza segue walk', () => {
    const mid = posa(fermo({ walk: 1, phase: 0.5 }));
    expect(at(mid, 0, J_KNEE)[2]).toBeCloseTo(0, 9);
    expect(mid.hipY).toBeCloseTo(STAND_HIP, 9);
    const half = posa(fermo({ walk: 0.5, phase: 0.25 }));
    expect(pitch(at(half, 0, J_HIP), at(half, 0, J_KNEE))).toBeCloseTo(LEG_SWING / 2, 9);
    // La fase conta solo per la parte frazionaria.
    expect(posa(fermo({ walk: 1, phase: 3.25 })).sides[0]).toEqual(posa(fermo({ walk: 1, phase: 0.25 })).sides[0]);
  });

  it('ruotare non allunga né accorcia gli arti', () => {
    for (let phase = 0; phase < 1; phase += 0.05) {
      const j = posa(fermo({ walk: 1, phase }));
      for (let side = 0; side < 2; side++) {
        expect(dist(at(j, side, J_HIP), at(j, side, J_KNEE))).toBeCloseTo(0.4, 9);
        expect(dist(at(j, side, J_KNEE), at(j, side, J_ANKLE))).toBeCloseTo(0.45, 9);
        expect(dist(at(j, side, J_SHOULDER), at(j, side, J_ELBOW))).toBeCloseTo(dist(STANDING.shoulder, STANDING.elbow), 9);
        expect(dist(at(j, side, J_ELBOW), at(j, side, J_WRIST))).toBeCloseTo(dist(STANDING.elbow, STANDING.wrist), 9);
      }
    }
  });

  it('il bambino dondola a scala', () => {
    const j = posa(fermo({ kind: 'kid', walk: 1, phase: 0.25 }));
    expect(j.hipY).toBeCloseTo((STAND_HIP - BOB) * KID_SCALE, 9);
  });
});

describe('l\'hostess e il cameriere', () => {
  it('il braccio dell\'hostess: il destro alzato in avanti, il sinistro fermo', () => {
    const j = posa(fermo({ kind: 'hostess', arm: 1 }));
    const wrist = at(j, 1, J_WRIST);
    const elbow = at(j, 1, J_ELBOW);
    expect(wrist[2]).toBeGreaterThan(0.45);
    expect(wrist[1]).toBeGreaterThan(STANDING.shoulder[1] - 0.1);
    expect(elbow[2]).toBeGreaterThan(0.2);
    expect(at(j, 0, J_WRIST)).toEqual([...STANDING.wrist]);
    // A metà, a metà strada.
    const half = posa(fermo({ kind: 'hostess', arm: 0.5 }));
    expect(at(half, 1, J_WRIST)[2]).toBeGreaterThan(STANDING.wrist[2]);
    expect(at(half, 1, J_WRIST)[2]).toBeLessThan(wrist[2]);
  });

  it('il vassoio: gli avambracci in avanti a ≈ 1,05 m, fermi anche camminando', () => {
    const fermoVassoio = posa(fermo({ kind: 'waiter', tray: true }));
    expect(fermoVassoio.tray).toBe(true);
    expect(fermoVassoio.hipY + fermoVassoio.trayY).toBeCloseTo(1.05, 6);
    expect(TRAY_Y).toBeCloseTo(0.13, 9);
    for (let side = 0; side < 2; side++) {
      const wrist = at(fermoVassoio, side, J_WRIST);
      expect(fermoVassoio.hipY + wrist[1]).toBeGreaterThan(1.0);
      expect(fermoVassoio.hipY + wrist[1]).toBeLessThan(1.06);
      expect(wrist[2]).toBeGreaterThan(0.25);
    }
    const camminando = posa(fermo({ kind: 'waiter', tray: true, walk: 1, phase: 0.25 }));
    expect(at(camminando, 0, J_WRIST)).toEqual(at(fermoVassoio, 0, J_WRIST));
    expect(at(camminando, 1, J_ELBOW)).toEqual(at(fermoVassoio, 1, J_ELBOW));
    // Le gambe camminano lo stesso.
    expect(at(camminando, 0, J_KNEE)[2]).toBeGreaterThan(0.1);
  });
});

describe('il cane', () => {
  it('fermo in piedi: zampe dritte, corpo alla sua altezza; sdraiato: la geometria intera', () => {
    const inPiedi = posa(fermo({ kind: 'dog' }));
    expect(inPiedi.dogLying).toBe(false);
    expect(inPiedi.dogDrop).toBe(0);
    expect(Array.from(inPiedi.dogLegs)).toEqual([0, 0, 0, 0]);
    expect(posa(fermo({ kind: 'dog', seat: 1 })).dogLying).toBe(true);
  });

  it('sdraiandosi scende, e le zampe si piegano con la punta a terra', () => {
    for (const t of [0.2, 0.5, 0.9]) {
      const j = posa(fermo({ kind: 'dog', seat: t }));
      expect(j.dogLying).toBe(false);
      expect(j.dogDrop).toBeCloseTo(DOG_STAND_LIFT * t, 9);
      const pivot = DOG_LEG_TOP - j.dogDrop;
      for (let l = 0; l < 4; l++) {
        expect(j.dogLegs[l]).toBeGreaterThan(0);
        expect(pivot - DOG_LEG_LENGTH * Math.cos(j.dogLegs[l])).toBeCloseTo(0, 9);
      }
    }
  });

  it('trotta a coppie diagonali: anteriore sinistra con posteriore destra', () => {
    const j = posa(fermo({ kind: 'dog', walk: 1, phase: 0.25 }));
    expect(j.dogLegs[0]).toBeCloseTo(DOG_SWING, 9);
    expect(j.dogLegs[3]).toBeCloseTo(DOG_SWING, 9);
    expect(j.dogLegs[1]).toBeCloseTo(-DOG_SWING, 9);
    expect(j.dogLegs[2]).toBeCloseTo(-DOG_SWING, 9);
  });
});

describe('ingressi illeggibili', () => {
  it('niente NaN, e la stessa posa per lo stesso ingresso', () => {
    const rotto = { kind: 'adult', seat: NaN, seatHeight: Infinity, walk: undefined, phase: NaN, arm: null, tray: 'sì' } as unknown as PoseInput;
    const j = posa(rotto);
    expect(j.hipY).toBe(STAND_HIP);
    for (let side = 0; side < 2; side++) for (const v of j.sides[side]) expect(Number.isFinite(v)).toBe(true);
    const a = posa(fermo({ walk: 0.7, phase: 0.31, seat: 0.2, arm: 0.4 }));
    const b = posa(fermo({ walk: 0.7, phase: 0.31, seat: 0.2, arm: 0.4 }));
    expect(a.sides[0]).toEqual(b.sides[0]);
    expect(a.sides[1]).toEqual(b.sides[1]);
    expect(a.hipY).toBe(b.hipY);
  });
});
