import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SEAT_HEIGHT } from '../model/geometry';
import type { FigureKind, FigureSlot } from '../types';

/* Le figure della sala, costruite in codice: niente modelli da scaricare, e
 * pedine che da lontano si leggono come persone sedute o in piedi.
 *
 * Una geometria condivisa per tipo di parte (People ne fa un InstancedMesh a
 * testa): busto a tornio, testa a icosaedro, coscia, stinco, braccio e
 * avambraccio a capsula, lo chignon dell'hostess, e il cane sdraiato in un
 * pezzo solo. Le parti sono rigide e già della loro misura: una figura le
 * mette in posa solo con posizione e rotazione, mai con una scala non
 * uniforme, che schiaccerebbe le calotte delle capsule. Per questo gamba e
 * braccio sono spezzati al ginocchio e al gomito (una capsula sola non si
 * piega), e le lunghezze dei segmenti sono le stesse seduti e in piedi
 * (entro 5 mm), così una geometria va bene per tutte e due le pose.
 *
 * I bambini sono le stesse parti a 0,62, scalate attorno al bacino: seduti
 * restano sulla seduta con i piedi a penzoloni, invece di affondare nella
 * sedia come farebbero scalati dal pavimento.
 *
 * composePerson e composeDog sono funzioni pure dello slot e non allocano:
 * temporanei di modulo, matrici d'uscita riusate da chi chiama. PR3 aggiunge
 * a composePerson la fase del passo.
 *
 * Il sistema di una figura: +Y in alto, +Z avanti (dove guarda), +X la sua
 * sinistra; rotation.y = slot.yaw, come le sedie. Misure in metri. */

/** La scala dei bambini, uniforme e attorno al bacino. */
export const KID_SCALE = 0.62;

/** Seduto: l'asse delle cosce sta un loro raggio sopra la seduta, 2 cm verso
 *  il tavolo dal centro della sedia, così il busto appoggia allo schienale e
 *  gli avambracci arrivano al bordo del piano. */
const SEAT_HIP_LIFT = 0.07;
const SEAT_HIP_FORWARD = 0.02;
/** In piedi: il bacino a 0,92 m, la cima della testa a 1,74 (l'inquadratura
 *  della camera tiene già gli angoli a 1,8 m). */
const STAND_HIP = 0.92;
const DEG = Math.PI / 180;

type Joint = readonly [number, number, number];

/** Le articolazioni del lato sinistro (+X), rispetto al bacino e a scala 1;
 *  il destro è lo specchio in x. */
interface Pose {
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
const SEATED: Pose = {
  hip: [0.09, 0, 0],
  knee: [0.09, 0, 0.4],
  ankle: [0.09, -0.45, 0.4],
  shoulder: [0.21, 0.48, 0],
  elbow: [0.19, 0.27, 0.15],
  wrist: [0.02, 0.28, 0.33],
};

/** In piedi: gambe dritte, braccia lungo i fianchi. */
const STANDING: Pose = {
  hip: [0.09, 0, 0],
  knee: [0.09, -0.4, 0],
  ankle: [0.09, -0.85, 0],
  shoulder: [0.21, 0.48, 0],
  elbow: [0.23, 0.22, 0.02],
  wrist: [0.23, -0.05, 0.05],
};

/** La base del busto, la testa e lo chignon (dietro la testa, un po' sopra):
 *  uguali nelle due pose. */
const TORSO_BASE: Joint = [0, -0.06, 0];
const HEAD_CENTRE: Joint = [0, 0.69, 0];
const BUN_CENTRE: Joint = [0, 0.76, -0.1];

/** Il profilo del busto (raggio, altezza) dalla base: fianchi, vita, spalle
 *  e collo. Al tornio con 8 spicchi. */
const TORSO_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0.13, 0.01],
  [0.16, 0.1],
  [0.18, 0.3],
  [0.17, 0.45],
  [0.12, 0.53],
  [0.05, 0.57],
  [0.05, 0.61],
  [0, 0.63],
];

export interface FigureGeometries {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  bun: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  dog: THREE.BufferGeometry;
  dispose(): void;
}

/** Una capsula distesa lungo +Z (CapsuleGeometry nasce lungo Y). */
function capsuleAlongZ(radius: number, length: number, capSegments: number, radialSegments: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments).rotateX(Math.PI / 2);
}

/** Il cane sdraiato, a sfinge: UNA geometria, origine sul pavimento sotto il
 *  corpo, muso verso +Z; lungo circa 0,9 m e alto 0,3. Un pezzo solo perché
 *  da fermo non si muove niente (PR3 lo può dividere per farlo camminare).
 *  Si legge come un cane per il muso lungo e le orecchie che pendono ai lati
 *  della testa: con un muso corto visto di punta e le orecchie dritte in
 *  cima sembrava un orsetto. */
function buildDog(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Il corpo, appoggiato al pavimento.
  parts.push(capsuleAlongZ(0.11, 0.34, 2, 6).translate(0, 0.11, 0));
  // La testa alta sulle zampe, e il muso lungo e stretto.
  parts.push(new THREE.IcosahedronGeometry(0.09, 1).translate(0, 0.2, 0.27));
  parts.push(capsuleAlongZ(0.035, 0.11, 2, 6).translate(0, 0.16, 0.4));
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    // Le orecchie che pendono ai lati della testa: attaccate in alto, la
    // punta in giù e un po' in fuori.
    parts.push(new THREE.CapsuleGeometry(0.025, 0.05, 1, 5).rotateZ(side * 30 * DEG).translate(side * 0.085, 0.19, 0.25));
    // Le zampe davanti distese, e le cosce posteriori.
    parts.push(capsuleAlongZ(0.03, 0.14, 1, 5).translate(side * 0.06, 0.03, 0.22));
    parts.push(new THREE.IcosahedronGeometry(0.07, 0).translate(side * 0.09, 0.07, -0.1));
  }
  // La coda, dal fondo della schiena all'indietro, la punta un po' alzata e
  // girata di 20° verso +X.
  parts.push(capsuleAlongZ(0.02, 0.18, 1, 5).rotateX(25 * DEG).rotateY(-20 * DEG).translate(0.05, 0.09, -0.36));

  // mergeGeometries vuole tutti i pezzi indicizzati o nessuno: le capsule lo
  // sono, gli icosaedri no.
  const flat = parts.map((g) => {
    if (!g.index) return g;
    const n = g.toNonIndexed();
    g.dispose();
    return n;
  });
  const out = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  return out ?? capsuleAlongZ(0.11, 0.34, 2, 6).translate(0, 0.11, 0);
}

export function createFigureGeometries(): FigureGeometries {
  const torso = new THREE.LatheGeometry(
    TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)),
    8,
  );
  // Un lato piatto davanti e dietro, non uno spigolo: il tornio mette il
  // primo vertice su +Z.
  torso.rotateY(Math.PI / 8);
  const head = new THREE.IcosahedronGeometry(0.13, 1);
  const bun = new THREE.IcosahedronGeometry(0.06, 1);
  const thigh = new THREE.CapsuleGeometry(0.07, 0.4, 2, 6);
  const shin = new THREE.CapsuleGeometry(0.06, 0.45, 2, 6);
  const upperArm = new THREE.CapsuleGeometry(0.05, 0.26, 2, 6);
  const forearm = new THREE.CapsuleGeometry(0.045, 0.27, 2, 6);
  const dog = buildDog();
  const all = [torso, head, bun, thigh, shin, upperArm, forearm, dog];
  return {
    torso,
    head,
    bun,
    thigh,
    shin,
    upperArm,
    forearm,
    dog,
    dispose: () => {
      for (const g of all) g.dispose();
    },
  };
}

/** Le matrici di una persona: create una volta da chi disegna, riscritte da
 *  composePerson per ogni figura. Gli arti: [0] il sinistro (+X), [1] il
 *  destro. */
export interface PersonMatrices {
  torso: THREE.Matrix4;
  head: THREE.Matrix4;
  bun: THREE.Matrix4;
  thigh: [THREE.Matrix4, THREE.Matrix4];
  shin: [THREE.Matrix4, THREE.Matrix4];
  upperArm: [THREE.Matrix4, THREE.Matrix4];
  forearm: [THREE.Matrix4, THREE.Matrix4];
}

export function createPersonMatrices(): PersonMatrices {
  const pair = (): [THREE.Matrix4, THREE.Matrix4] => [new THREE.Matrix4(), new THREE.Matrix4()];
  return {
    torso: new THREE.Matrix4(),
    head: new THREE.Matrix4(),
    bun: new THREE.Matrix4(),
    thigh: pair(),
    shin: pair(),
    upperArm: pair(),
    forearm: pair(),
  };
}

/** 0,62 per un bambino, 1 per tutti gli altri. */
export function figureScale(kind: FigureKind | null | undefined): number {
  return kind === 'kid' ? KID_SCALE : 1;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const UP = new THREE.Vector3(0, 1, 0);
const _qYaw = new THREE.Quaternion();
const _qLimb = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _hip = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Un'articolazione nel mondo: × scala, ruotata dello yaw, più il bacino. */
function place(out: THREE.Vector3, j: Joint, side: number, s: number): THREE.Vector3 {
  return out.set(j[0] * side * s, j[1] * s, j[2] * s).applyQuaternion(_qYaw).add(_hip);
}

/** Un arto fra due articolazioni: la capsula (nata lungo +Y, centrata) al
 *  punto medio, girata da +Y verso il segmento. La rotazione si cerca nel
 *  sistema della figura e poi si gira dello yaw: così l'arto ruota col corpo
 *  anche attorno al proprio asse. */
function limb(out: THREE.Matrix4, from: Joint, to: Joint, side: number, s: number): void {
  _a.set(from[0] * side, from[1], from[2]);
  _b.set(to[0] * side, to[1], to[2]);
  _dir.subVectors(_b, _a);
  const len = _dir.length();
  if (len > 1e-6) _dir.divideScalar(len);
  else _dir.copy(UP);
  // La capsula è simmetrica: il verso non conta, e una gamba dritta non
  // passa dal caso antiparallelo di setFromUnitVectors (asse a caso).
  if (_dir.y < 0) _dir.negate();
  _qLimb.setFromUnitVectors(UP, _dir);
  _qWorld.multiplyQuaternions(_qYaw, _qLimb);
  _p.addVectors(_a, _b).multiplyScalar(0.5 * s).applyQuaternion(_qYaw).add(_hip);
  out.compose(_p, _qWorld, _scale);
}

/** Mette in posa una persona (adulto, bambino, hostess): scrive in `out` le
 *  matrici di tutte le parti, chignon compreso (lo disegna solo l'hostess).
 *  Seduta: il bacino sulla seduta (slot.seatHeight, 0,45 o 0,75 il
 *  seggiolone); in piedi, e per una persona «sdraiata» che non esiste, il
 *  bacino a 0,92 × scala sopra il punto dello slot. */
export function composePerson(slot: FigureSlot, out: PersonMatrices): void {
  const s = figureScale(slot?.kind);
  const x = num(slot?.x, 0);
  const z = num(slot?.z, 0);
  _qYaw.setFromAxisAngle(UP, num(slot?.yaw, 0));
  _scale.set(s, s, s);
  const seated = slot?.pose === 'seated';
  if (seated) {
    const h = num(slot.seatHeight, 0);
    const seat = h > 0 ? h : SEAT_HEIGHT;
    _hip.set(0, 0, SEAT_HIP_FORWARD * s).applyQuaternion(_qYaw);
    _hip.set(x + _hip.x, seat + SEAT_HIP_LIFT * s, z + _hip.z);
  } else {
    _hip.set(x, STAND_HIP * s, z);
  }
  const pose = seated ? SEATED : STANDING;

  // Busto dritto, testa e chignon: girati solo dello yaw.
  out.torso.compose(place(_p, TORSO_BASE, 1, s), _qYaw, _scale);
  out.head.compose(place(_p, HEAD_CENTRE, 1, s), _qYaw, _scale);
  out.bun.compose(place(_p, BUN_CENTRE, 1, s), _qYaw, _scale);

  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    limb(out.thigh[i], pose.hip, pose.knee, side, s);
    limb(out.shin[i], pose.knee, pose.ankle, side, s);
    limb(out.upperArm[i], pose.shoulder, pose.elbow, side, s);
    limb(out.forearm[i], pose.elbow, pose.wrist, side, s);
  }
}

/** Il cane, sempre sdraiato: la sua geometria è già in posa, basta metterla
 *  sul pavimento al punto dello slot, girata dello yaw. */
export function composeDog(slot: FigureSlot, out: THREE.Matrix4): void {
  _qYaw.setFromAxisAngle(UP, num(slot?.yaw, 0));
  _p.set(num(slot?.x, 0), 0, num(slot?.z, 0));
  _scale.set(1, 1, 1);
  out.compose(_p, _qYaw, _scale);
}
