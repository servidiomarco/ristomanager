import { SEAT_HEIGHT } from '../model/geometry';
import type { ActorKind } from '../types';

/* Le pose delle figure come conti puri: dove stanno ginocchia, gomiti e
 * polsi di chi sta in piedi, siede, cammina, accoglie o porta il vassoio, e
 * come stanno le zampe del cane. figures.ts ne fa le matrici delle parti;
 * qui niente three né React, così i test le provano in node.
 *
 * Le due pose ferme sono quelle di PR2c (STANDING e SEATED) e tutto il resto
 * ci gira attorno. Con seat 0 e walk 0 escono ESATTAMENTE le articolazioni in
 * piedi, con seat 1 e walk 0 quelle sedute, numero per numero (niente conti
 * sulle estremità, solo copie): è il patto con People. Un attore del regista
 * torna figura statica quando la sua posa è quella dello slot, e il cambio di
 * mano non si deve vedere nemmeno di un pixel.
 *
 * In mezzo, sedersi e alzarsi sono una media delle due pose, articolazione
 * per articolazione, e del bacino: le caviglie stanno a 7 cm da terra sia in
 * piedi sia sedute, e con la media restano lì per tutto il movimento (con le
 * cosce che ruotano attorno all'anca, a metà strada i piedi finirebbero sotto
 * il pavimento).
 *
 * Il sistema di una figura: +Y in alto, +Z avanti (dove guarda), +X la sua
 * sinistra. Misure in metri, articolazioni a scala 1 rispetto al bacino. */

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

/** La scala dei bambini, uniforme e attorno al bacino. */
export const KID_SCALE = 0.62;
/** Seduto: l'asse delle cosce sta un loro raggio sopra la seduta, 2 cm verso
 *  il tavolo dal centro della sedia, così il busto appoggia allo schienale e
 *  gli avambracci arrivano al bordo del piano. */
export const SEAT_HIP_LIFT = 0.07;
export const SEAT_HIP_FORWARD = 0.02;
/** In piedi: il bacino a 0,92 m, la cima della testa a 1,74 (l'inquadratura
 *  della camera tiene già gli angoli a 1,8 m). */
export const STAND_HIP = 0.92;

/** Il passo (spec §6.4): la coscia oscilla di ±28° attorno all'anca, le
 *  braccia in controfase a 0,8 di quell'ampiezza. */
export const LEG_SWING = 28 * DEG;
export const ARM_SWING_RATIO = 0.8;
/** Il dondolio del bacino, |sin 2πφ| · 2,5 cm. In giù: è più basso quando le
 *  gambe sono aperte, come nel passo vero. Con le gambe dritte a ±28° e il
 *  bacino fermo i piedi salirebbero di 10 cm; scendendo, il passo sta più
 *  vicino al pavimento. */
export const BOB = 0.025;
/** Il ginocchio della gamba che torna avanti (il piede in aria) si piega,
 *  fino a 40° a metà strada, sotto il bacino, e torna dritto agli estremi:
 *  il piede passa sopra il pavimento invece di strisciarci, e la gamba
 *  d'appoggio resta dritta. Piegato quando la gamba è dietro, lo stinco
 *  andava in orizzontale all'indietro: un calcio, più corsa che passo. */
export const KNEE_BEND = 40 * DEG;
/** Il braccio dell'hostess che accoglie e presenta il tavolo: il destro,
 *  alzato in avanti di 75° alla spalla e con l'avambraccio altri 20° su, il
 *  gesto di «prego, da questa parte». */
export const ARM_RAISE = 75 * DEG;
export const FOREARM_RAISE = 20 * DEG;

/** Il vassoio del cameriere: gli avambracci in avanti, i polsi a 1,03 m, il
 *  vassoio appoggiato sopra a 1,05 m (0,13 sopra il bacino) e 38 cm avanti,
 *  così il bordo dietro resta davanti al busto. Il lato sinistro: il destro è
 *  lo specchio in x. */
const TRAY_ELBOW = [0.22, 0.21, 0.06] as const;
const TRAY_WRIST = [0.15, 0.11, 0.31] as const;
export const TRAY_Y = 0.13;
export const TRAY_Z = 0.38;

/** Il cane sdraiato ha il centro del corpo a 0,11 m; in piedi sta 23 cm più
 *  su, col dorso a 0,45. */
export const DOG_STAND_LIFT = 0.23;
/** Le zampe del cane in piedi: dal perno, dentro il corpo a 0,30 m da terra,
 *  fino alla punta sul pavimento. Una capsula sola per zampa. */
export const DOG_LEG_TOP = 0.3;
export const DOG_LEG_LENGTH = 0.3;
export const DOG_LEG_RADIUS = 0.03;
/** I perni delle zampe, [x, z] rispetto al centro del corpo: anteriore
 *  sinistra, anteriore destra, posteriore sinistra, posteriore destra. */
export const DOG_LEG_PIVOTS: ReadonlyArray<readonly [number, number]> = [
  [0.06, 0.17],
  [-0.06, 0.17],
  [0.07, -0.17],
  [-0.07, -0.17],
];
/** Il trotto: le zampe a coppie diagonali (anteriore sinistra con posteriore
 *  destra) oscillano di ±25°, il corpo dondola di 1,2 cm. */
export const DOG_SWING = 25 * DEG;
export const DOG_BOB = 0.012;

/** Un'articolazione del lato sinistro: x, y, z dal bacino, a scala 1. */
export type Joint = readonly [number, number, number];

/** Le articolazioni del lato sinistro (+X); il destro è lo specchio in x. */
export interface StillPose {
  hip: Joint;
  knee: Joint;
  ankle: Joint;
  shoulder: Joint;
  elbow: Joint;
  wrist: Joint;
}

/** Seduti su una sedia da 0,45 m: cosce orizzontali sulla seduta, stinchi
 *  dritti fino al pavimento, busto dritto, testa in cima a 1,34 m. Gli
 *  avambracci a 0,79-0,80 m, sul bordo del piano (0,75), raccolti davanti al
 *  petto con le mani che si toccano: con gli avambracci dritti in avanti, chi
 *  siede di schiena alla camera (a 52° d'altezza) sembrava con le mani
 *  alzate, perché un braccio che va avanti sul tavolo sullo schermo sale.
 *  Raccolti, di schiena li coprono testa e busto e restano i gomiti; di
 *  fronte sono braccia sul tavolo. I gomiti a 19 cm dall'asse, 24 col
 *  braccio: due vicini sulle sedie a 52 cm l'una restano a 4 cm (a 22 si
 *  toccavano). */
export const SEATED: StillPose = {
  hip: [0.09, 0, 0],
  knee: [0.09, 0, 0.4],
  ankle: [0.09, -0.45, 0.4],
  shoulder: [0.21, 0.48, 0],
  elbow: [0.19, 0.27, 0.15],
  wrist: [0.02, 0.28, 0.33],
};

/** In piedi: gambe dritte, braccia lungo i fianchi. */
export const STANDING: StillPose = {
  hip: [0.09, 0, 0],
  knee: [0.09, -0.4, 0],
  ankle: [0.09, -0.85, 0],
  shoulder: [0.21, 0.48, 0],
  elbow: [0.23, 0.22, 0.02],
  wrist: [0.23, -0.05, 0.05],
};

/** Dove sta ogni articolazione nei Float64Array di PoseJoints.sides: x, y, z
 *  di fila. */
export const J_HIP = 0;
export const J_KNEE = 3;
export const J_ANKLE = 6;
export const J_SHOULDER = 9;
export const J_ELBOW = 12;
export const J_WRIST = 15;
const SIDE_FLOATS = 18;
const ORDER: ReadonlyArray<keyof StillPose> = ['hip', 'knee', 'ankle', 'shoulder', 'elbow', 'wrist'];

/** Quello che serve per mettere in posa una figura: i campi omonimi di
 *  ActorView (un ActorView si passa così com'è). */
export interface PoseInput {
  kind: ActorKind;
  /** 0 in piedi, 1 seduto (il cane: sdraiato). */
  seat: number;
  /** La seduta verso cui si scende; 0 o meno vale SEAT_HEIGHT. */
  seatHeight: number;
  /** 0 fermo, 1 passo pieno. */
  walk: number;
  /** La fase del passo, in giri: conta solo la parte frazionaria. */
  phase: number;
  /** Il braccio alzato dell'hostess, da 0 a 1. */
  arm: number;
  tray: boolean;
}

/** Una posa calcolata. Le persone: il bacino e le articolazioni dei due lati;
 *  il cane: quanto scende il corpo e l'angolo di ogni zampa. Si crea una
 *  volta (createPoseJoints) e si riscrive sul posto: niente allocazioni. */
export interface PoseJoints {
  /** L'altezza del bacino dal pavimento, in metri, scala e dondolio compresi. */
  hipY: number;
  /** Quanto il bacino sta avanti rispetto al punto della figura, lungo il suo
   *  sguardo, in metri e scala compresa: 2 cm verso il tavolo da seduti. */
  hipForward: number;
  /** [0] il lato sinistro (+X), [1] il destro: x, y, z di ogni articolazione
   *  (J_HIP … J_WRIST) rispetto al bacino, a scala 1, la x del destro già
   *  specchiata e il passo già applicato. */
  sides: [Float64Array, Float64Array];
  /** Il vassoio sulle mani: il centro rispetto al bacino, a scala 1, sulla
   *  linea di mezzo (x 0). */
  tray: boolean;
  trayY: number;
  trayZ: number;
  /** Il cane del tutto sdraiato: si disegna con la geometria del cane
   *  sdraiato, quella delle figure statiche. */
  dogLying: boolean;
  /** Di quanto scende il cane in piedi, in metri: 0 fermo in piedi, fino a
   *  DOG_STAND_LIFT mentre si sdraia, più il dondolio del trotto. */
  dogDrop: number;
  /** L'inclinazione di ogni zampa in radianti, + in avanti, nell'ordine di
   *  DOG_LEG_PIVOTS. */
  dogLegs: Float64Array;
}

export function createPoseJoints(): PoseJoints {
  return {
    hipY: STAND_HIP,
    hipForward: 0,
    sides: [new Float64Array(SIDE_FLOATS), new Float64Array(SIDE_FLOATS)],
    tray: false,
    trayY: TRAY_Y,
    trayZ: TRAY_Z,
    dogLying: false,
    dogDrop: 0,
    dogLegs: new Float64Array(4),
  };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** In [0, 1]; un valore illeggibile vale 0 (fermo, in piedi). */
const unit = (v: unknown): number => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);
/** La fase del passo in radianti, sulla sola parte frazionaria: la fase
 *  3,25 e la 0,25 sono lo stesso punto del passo, bit per bit. */
const stepAngle = (phase: unknown): number => (finite(phase) ? TAU * (phase - Math.floor(phase)) : 0);

/** La media fra a e b, ESATTA alle estremità: t 0 dà a, t 1 dà b, bit per
 *  bit (a + (b − a)·1 può non tornare b). */
export function mix(a: number, b: number, t: number): number {
  if (t <= 0) return a;
  if (t >= 1) return b;
  return a + (b - a) * t;
}

/** Ruota in avanti (verso +Z) attorno all'asse X il punto `j` di `side`
 *  attorno al perno `p`, di `angle` radianti: una gamba che pende (−Y) va
 *  verso +Z con un angolo positivo. */
function pitchAbout(side: Float64Array, j: number, p: number, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const y = side[j + 1] - side[p + 1];
  const z = side[j + 2] - side[p + 2];
  side[j + 1] = side[p + 1] + y * c + z * s;
  side[j + 2] = side[p + 2] - y * s + z * c;
}

/** Mette in posa una persona o il cane: scrive in `out` e lo restituisce. */
export function poseJoints(input: PoseInput, out: PoseJoints): PoseJoints {
  if (input?.kind === 'dog') return dogPose(input, out);
  return personPose(input, out);
}

function personPose(input: PoseInput, out: PoseJoints): PoseJoints {
  const s = input?.kind === 'kid' ? KID_SCALE : 1;
  const seat = unit(input?.seat);
  const walk = unit(input?.walk);
  const arm = unit(input?.arm);
  const h = input?.seatHeight;
  const seatH = finite(h) && h > 0 ? h : SEAT_HEIGHT;

  out.hipY = mix(STAND_HIP * s, seatH + SEAT_HIP_LIFT * s, seat);
  out.hipForward = mix(0, SEAT_HIP_FORWARD * s, seat);
  out.tray = false;
  out.trayY = TRAY_Y;
  out.trayZ = TRAY_Z;
  out.dogLying = false;
  out.dogDrop = 0;

  for (let side = 0; side < 2; side++) {
    const a = out.sides[side];
    for (let k = 0; k < ORDER.length; k++) {
      const from = STANDING[ORDER[k]];
      const to = SEATED[ORDER[k]];
      const x = mix(from[0], to[0], seat);
      // Il destro è lo specchio: −x ha gli stessi bit di x · −1, quello che
      // faceva PR2c.
      a[k * 3] = side === 0 ? x : -x;
      a[k * 3 + 1] = mix(from[1], to[1], seat);
      a[k * 3 + 2] = mix(from[2], to[2], seat);
    }
  }

  const tray = input?.tray === true;
  if (walk > 0) {
    const angle = stepAngle(input.phase);
    const sn = Math.sin(angle);
    const cs = Math.cos(angle);
    out.hipY -= Math.abs(sn) * BOB * walk * s;
    for (let side = 0; side < 2; side++) {
      const a = out.sides[side];
      // Il sinistro avanti quando sin 2πφ > 0, il destro in controfase; la
      // derivata (cos) dice quale gamba sta tornando avanti.
      const forward = side === 0 ? sn : -sn;
      const coming = side === 0 ? cs : -cs;
      const swing = LEG_SWING * walk * forward;
      pitchAbout(a, J_KNEE, J_HIP, swing);
      pitchAbout(a, J_ANKLE, J_HIP, swing);
      // Il ginocchio si piega solo sulla gamba in aria, che torna avanti.
      if (coming > 0) pitchAbout(a, J_ANKLE, J_KNEE, -KNEE_BEND * walk * coming);
      // Le braccia vanno con la gamba dell'altro lato; col vassoio no.
      if (!tray) {
        const armSwing = -ARM_SWING_RATIO * swing;
        pitchAbout(a, J_ELBOW, J_SHOULDER, armSwing);
        pitchAbout(a, J_WRIST, J_SHOULDER, armSwing);
      }
    }
  }

  if (tray) {
    out.tray = true;
    for (let side = 0; side < 2; side++) {
      const a = out.sides[side];
      const m = side === 0 ? 1 : -1;
      a[J_ELBOW] = TRAY_ELBOW[0] * m;
      a[J_ELBOW + 1] = TRAY_ELBOW[1];
      a[J_ELBOW + 2] = TRAY_ELBOW[2];
      a[J_WRIST] = TRAY_WRIST[0] * m;
      a[J_WRIST + 1] = TRAY_WRIST[1];
      a[J_WRIST + 2] = TRAY_WRIST[2];
    }
  } else if (arm > 0) {
    // Il braccio destro, verso la strada della fila o verso il tavolo: sempre
    // davanti a sé, dove il regista l'ha girata.
    const a = out.sides[1];
    pitchAbout(a, J_ELBOW, J_SHOULDER, ARM_RAISE * arm);
    pitchAbout(a, J_WRIST, J_SHOULDER, ARM_RAISE * arm);
    pitchAbout(a, J_WRIST, J_ELBOW, FOREARM_RAISE * arm);
  }
  return out;
}

function dogPose(input: PoseInput, out: PoseJoints): PoseJoints {
  const t = unit(input?.seat);
  const walk = unit(input?.walk);
  out.hipY = 0;
  out.hipForward = 0;
  out.tray = false;
  out.dogLying = t >= 1;

  const sn = walk > 0 ? Math.sin(stepAngle(input.phase)) : 0;
  // Sdraiandosi il corpo scende verso il pavimento e le zampe si piegano in
  // avanti quanto basta per restare con la punta a terra (cos θ = altezza del
  // perno / lunghezza). Da t 1 vale la geometria del cane sdraiato.
  const pivot = DOG_LEG_TOP - DOG_STAND_LIFT * t;
  const fold = t > 0 ? Math.acos(Math.min(1, Math.max(-1, pivot / DOG_LEG_LENGTH))) : 0;
  out.dogDrop = DOG_STAND_LIFT * t + (walk > 0 ? Math.abs(sn) * DOG_BOB * walk : 0);
  const swing = DOG_SWING * walk * sn;
  out.dogLegs[0] = fold + swing;
  out.dogLegs[1] = fold - swing;
  out.dogLegs[2] = fold - swing;
  out.dogLegs[3] = fold + swing;
  return out;
}
