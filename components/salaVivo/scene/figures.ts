import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FigureKind, FigureSlot } from '../types';
import {
  DOG_LEG_LENGTH,
  DOG_LEG_PIVOTS,
  DOG_LEG_RADIUS,
  DOG_LEG_TOP,
  DOG_STAND_LIFT,
  J_ANKLE,
  J_ELBOW,
  J_HIP,
  J_KNEE,
  J_SHOULDER,
  J_WRIST,
  KID_SCALE,
  createPoseJoints,
  poseJoints,
  type PoseInput,
  type PoseJoints,
} from './walkPose';

/* Le figure della sala, costruite in codice: niente modelli da scaricare, e
 * pedine che da lontano si leggono come persone sedute, in piedi o in
 * cammino.
 *
 * Una geometria condivisa per tipo di parte (People e Walkers ne fanno un
 * InstancedMesh a testa): busto a tornio, testa a icosaedro, coscia, stinco,
 * braccio e avambraccio a capsula, lo chignon dell'hostess, il grembiule e il
 * vassoio del cameriere, e il cane: sdraiato in un pezzo solo, in piedi in un
 * corpo e quattro zampe. Le parti sono rigide e già della loro misura: una
 * figura le mette in posa solo con posizione e rotazione, mai con una scala
 * non uniforme, che schiaccerebbe le calotte delle capsule. Per questo gamba
 * e braccio sono spezzati al ginocchio e al gomito (una capsula sola non si
 * piega), e le lunghezze dei segmenti sono le stesse seduti e in piedi
 * (entro 5 mm), così una geometria va bene per tutte e due le pose.
 *
 * I bambini sono le stesse parti a 0,62, scalate attorno al bacino: seduti
 * restano sulla seduta con i piedi a penzoloni, invece di affondare nella
 * sedia come farebbero scalati dal pavimento.
 *
 * Dove stanno le articolazioni lo dice walkPose.ts (conti puri: in piedi,
 * seduti, il passo, il braccio dell'hostess, il vassoio); qui si fanno le
 * matrici. composePersonJoints e composeDogStanding non allocano: temporanei
 * di modulo, matrici d'uscita riusate da chi chiama. composePerson e
 * composeDog mettono in posa una figura statica (People) passando dagli
 * stessi conti con seat 0 o 1 e walk 0: le stesse matrici di prima, bit per
 * bit, e le stesse di un attore del regista fermo sul suo posto.
 *
 * Il sistema di una figura: +Y in alto, +Z avanti (dove guarda), +X la sua
 * sinistra; rotation.y = yaw, come le sedie. Misure in metri. */

export { KID_SCALE };

/** La base del busto, la testa e lo chignon (dietro la testa, un po' sopra),
 *  rispetto al bacino a scala 1: uguali in ogni posa. */
type Joint = readonly [number, number, number];
const TORSO_BASE: Joint = [0, -0.06, 0];
const HEAD_CENTRE: Joint = [0, 0.69, 0];
const BUN_CENTRE: Joint = [0, 0.76, -0.1];
/** Il centro della testa sopra il bacino, a scala 1: le etichette dei nomi
 *  stanno sopra questo punto. */
export const HEAD_CENTRE_Y = HEAD_CENTRE[1];

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

/** Il grembiule del cameriere, nel sistema del busto (origine alla sua
 *  base): da 22 cm sopra la base a metà coscia, davanti alla faccia piatta
 *  del busto (a 0,166 dall'asse all'altezza del petto). */
const APRON_W = 0.28;
const APRON_H = 0.52;
const APRON_D = 0.015;
const APRON_Y = -0.04;
const APRON_Z = 0.176;
/** Il vassoio: un disco sottile da 36 cm. */
const TRAY_R = 0.18;
const TRAY_H = 0.015;

export interface FigureGeometries {
  torso: THREE.BufferGeometry;
  head: THREE.BufferGeometry;
  bun: THREE.BufferGeometry;
  thigh: THREE.BufferGeometry;
  shin: THREE.BufferGeometry;
  upperArm: THREE.BufferGeometry;
  forearm: THREE.BufferGeometry;
  /** Il cane sdraiato, in un pezzo. */
  dog: THREE.BufferGeometry;
  /** Il cane in piedi: il corpo (con testa, orecchie e coda) e una zampa. */
  dogBody: THREE.BufferGeometry;
  dogLeg: THREE.BufferGeometry;
  apron: THREE.BufferGeometry;
  tray: THREE.BufferGeometry;
  dispose(): void;
}

const DEG = Math.PI / 180;

/** Una capsula distesa lungo +Z (CapsuleGeometry nasce lungo Y). */
function capsuleAlongZ(radius: number, length: number, capSegments: number, radialSegments: number): THREE.BufferGeometry {
  return new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments).rotateX(Math.PI / 2);
}

/* I pezzi del cane, `lift` metri più in alto di quello sdraiato: lo stesso
 * corpo, la stessa testa, le stesse orecchie e la stessa coda per il cane
 * sdraiato (lift 0) e per quello in piedi (DOG_STAND_LIFT). Così il cane che
 * si sdraia scende fino a essere, pezzo per pezzo, quello sdraiato. */
const dogTrunk = (lift: number) => capsuleAlongZ(0.11, 0.34, 2, 6).translate(0, 0.11 + lift, 0);
// La testa alta sulle zampe, e il muso lungo e stretto.
const dogHead = (lift: number) => new THREE.IcosahedronGeometry(0.09, 1).translate(0, 0.2 + lift, 0.27);
const dogMuzzle = (lift: number) => capsuleAlongZ(0.035, 0.11, 2, 6).translate(0, 0.16 + lift, 0.4);
// Le orecchie che pendono ai lati della testa: attaccate in alto, la punta in
// giù e un po' in fuori.
const dogEar = (side: number, lift: number) =>
  new THREE.CapsuleGeometry(0.025, 0.05, 1, 5).rotateZ(side * 30 * DEG).translate(side * 0.085, 0.19 + lift, 0.25);
// La coda, dal fondo della schiena all'indietro, la punta un po' alzata e
// girata di 20° verso +X.
const dogTail = (lift: number) =>
  capsuleAlongZ(0.02, 0.18, 1, 5).rotateX(25 * DEG).rotateY(-20 * DEG).translate(0.05, 0.09 + lift, -0.36);

/** I pezzi in una geometria sola. mergeGeometries vuole tutti i pezzi
 *  indicizzati o nessuno: le capsule lo sono, gli icosaedri no. */
function merge(parts: THREE.BufferGeometry[], fallback: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = parts.map((g) => {
    if (!g.index) return g;
    const n = g.toNonIndexed();
    g.dispose();
    return n;
  });
  const out = mergeGeometries(flat, false);
  for (const g of flat) g.dispose();
  return out ?? fallback();
}

/** Il cane sdraiato, a sfinge: UNA geometria, origine sul pavimento sotto il
 *  corpo, muso verso +Z; lungo circa 0,9 m e alto 0,3. Si legge come un cane
 *  per il muso lungo e le orecchie che pendono ai lati della testa: con un
 *  muso corto visto di punta e le orecchie dritte in cima sembrava un
 *  orsetto. */
function buildDog(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Il corpo, appoggiato al pavimento.
  parts.push(dogTrunk(0));
  parts.push(dogHead(0));
  parts.push(dogMuzzle(0));
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? 1 : -1;
    parts.push(dogEar(side, 0));
    // Le zampe davanti distese, e le cosce posteriori.
    parts.push(capsuleAlongZ(0.03, 0.14, 1, 5).translate(side * 0.06, 0.03, 0.22));
    parts.push(new THREE.IcosahedronGeometry(0.07, 0).translate(side * 0.09, 0.07, -0.1));
  }
  parts.push(dogTail(0));
  return merge(parts, () => dogTrunk(0));
}

/** Il cane in piedi senza le zampe: corpo, testa, muso, orecchie e coda del
 *  cane sdraiato, DOG_STAND_LIFT più su (il dorso a 0,45 m). Le zampe sono
 *  istanze a parte, una capsula l'una, perché trottano. */
function buildDogStanding(): THREE.BufferGeometry {
  const lift = DOG_STAND_LIFT;
  return merge([dogTrunk(lift), dogHead(lift), dogMuzzle(lift), dogEar(1, lift), dogEar(-1, lift), dogTail(lift)], () => dogTrunk(lift));
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
  const dogBody = buildDogStanding();
  // Una zampa: capsula centrata lungo Y, lunga DOG_LEG_LENGTH calotte comprese.
  const dogLeg = new THREE.CapsuleGeometry(DOG_LEG_RADIUS, DOG_LEG_LENGTH - 2 * DOG_LEG_RADIUS, 1, 5);
  // Il grembiule si mette con la matrice del busto: è già al suo posto
  // rispetto alla base del busto.
  const apron = new THREE.BoxGeometry(APRON_W, APRON_H, APRON_D).translate(0, APRON_Y, APRON_Z);
  const tray = new THREE.CylinderGeometry(TRAY_R, TRAY_R, TRAY_H, 16);
  const all = [torso, head, bun, thigh, shin, upperArm, forearm, dog, dogBody, dogLeg, apron, tray];
  return {
    torso,
    head,
    bun,
    thigh,
    shin,
    upperArm,
    forearm,
    dog,
    dogBody,
    dogLeg,
    apron,
    tray,
    dispose: () => {
      for (const g of all) g.dispose();
    },
  };
}

/** Le matrici di una persona: create una volta da chi disegna, riscritte da
 *  composePersonJoints per ogni figura. Gli arti: [0] il sinistro (+X), [1]
 *  il destro. Il grembiule usa la matrice del busto; `tray` vale solo con il
 *  vassoio. */
export interface PersonMatrices {
  torso: THREE.Matrix4;
  head: THREE.Matrix4;
  bun: THREE.Matrix4;
  thigh: [THREE.Matrix4, THREE.Matrix4];
  shin: [THREE.Matrix4, THREE.Matrix4];
  upperArm: [THREE.Matrix4, THREE.Matrix4];
  forearm: [THREE.Matrix4, THREE.Matrix4];
  tray: THREE.Matrix4;
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
    tray: new THREE.Matrix4(),
  };
}

/** Le matrici del cane in piedi: il corpo e le quattro zampe, nell'ordine di
 *  DOG_LEG_PIVOTS. */
export interface DogMatrices {
  body: THREE.Matrix4;
  legs: [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4, THREE.Matrix4];
}

export function createDogMatrices(): DogMatrices {
  return {
    body: new THREE.Matrix4(),
    legs: [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
  };
}

/** 0,62 per un bambino, 1 per tutti gli altri. */
export function figureScale(kind: FigureKind | 'waiter' | null | undefined): number {
  return kind === 'kid' ? KID_SCALE : 1;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const _qYaw = new THREE.Quaternion();
const _qLimb = new THREE.Quaternion();
const _qWorld = new THREE.Quaternion();
const _hip = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _one = new THREE.Vector3(1, 1, 1);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();
const _joints = createPoseJoints();
const _still: PoseInput = { kind: 'adult', seat: 0, seatHeight: 0, walk: 0, phase: 0, arm: 0, tray: false };

/** Un'articolazione nel mondo: × scala, ruotata dello yaw, più il bacino. */
function place(out: THREE.Vector3, j: Joint, side: number, s: number): THREE.Vector3 {
  return out.set(j[0] * side * s, j[1] * s, j[2] * s).applyQuaternion(_qYaw).add(_hip);
}

/** Un arto fra due articolazioni di un lato (`from` e `to` sono indici
 *  J_* in `a`): la capsula (nata lungo +Y, centrata) al punto medio, girata
 *  da +Y verso il segmento. La rotazione si cerca nel sistema della figura e
 *  poi si gira dello yaw: così l'arto ruota col corpo anche attorno al
 *  proprio asse. */
function limb(out: THREE.Matrix4, a: Float64Array, from: number, to: number, s: number): void {
  _a.set(a[from], a[from + 1], a[from + 2]);
  _b.set(a[to], a[to + 1], a[to + 2]);
  _dir.subVectors(_b, _a);
  const len = _dir.length();
  if (len > 1e-6) _dir.divideScalar(len);
  else _dir.copy(UP);
  // La capsula è simmetrica: il verso non conta, e una gamba dritta non
  // passa dal caso antiparallelo di setFromUnitVectors (asse a caso).
  if (_dir.y < 0) _dir.negate();
  _qLimb.setFromUnitVectors(UP, _dir);
  _qWorld.multiplyQuaternions(_qYaw, _qLimb);
  _p.addVectors(_a, _b).multiplyScalar(0.5 * s);
  _p.applyQuaternion(_qYaw).add(_hip);
  out.compose(_p, _qWorld, _scale);
}

/** Mette in posa una persona (adulto, bambino, hostess, cameriere) da una
 *  posa già calcolata (poseJoints): scrive in `out` le matrici di tutte le
 *  parti, chignon compreso (lo disegna solo l'hostess) e vassoio (solo con
 *  `joints.tray`). (x, z) è il punto della figura: in piedi il pavimento sotto
 *  il bacino, seduta il centro della sedia. */
export function composePersonJoints(x: number, z: number, yaw: number, s: number, joints: PoseJoints, out: PersonMatrices): void {
  _qYaw.setFromAxisAngle(UP, yaw);
  _scale.set(s, s, s);
  _hip.set(0, 0, joints.hipForward).applyQuaternion(_qYaw);
  _hip.set(x + _hip.x, joints.hipY, z + _hip.z);

  // Busto dritto, testa e chignon: girati solo dello yaw.
  out.torso.compose(place(_p, TORSO_BASE, 1, s), _qYaw, _scale);
  out.head.compose(place(_p, HEAD_CENTRE, 1, s), _qYaw, _scale);
  out.bun.compose(place(_p, BUN_CENTRE, 1, s), _qYaw, _scale);

  for (let i = 0; i < 2; i++) {
    const a = joints.sides[i];
    limb(out.thigh[i], a, J_HIP, J_KNEE, s);
    limb(out.shin[i], a, J_KNEE, J_ANKLE, s);
    limb(out.upperArm[i], a, J_SHOULDER, J_ELBOW, s);
    limb(out.forearm[i], a, J_ELBOW, J_WRIST, s);
  }
  if (joints.tray) {
    _p.set(0, joints.trayY * s, joints.trayZ * s).applyQuaternion(_qYaw).add(_hip);
    out.tray.compose(_p, _qYaw, _scale);
  }
}

/** Una figura statica come input della posa: seduta (seat 1) o in piedi, ferma. */
function stillInput(slot: FigureSlot): PoseInput {
  const kind = slot?.kind;
  _still.kind = kind === 'kid' || kind === 'hostess' || kind === 'dog' ? kind : 'adult';
  _still.seat = slot?.pose === 'seated' ? 1 : 0;
  _still.seatHeight = num(slot?.seatHeight, 0);
  return _still;
}

/** Mette in posa una persona statica (adulto, bambino, hostess): seduta, il
 *  bacino sulla seduta (slot.seatHeight, 0,45 o 0,58 il seggiolone); in
 *  piedi, e per una persona «sdraiata» che non esiste, il bacino a 0,92 ×
 *  scala sopra il punto dello slot. */
export function composePerson(slot: FigureSlot, out: PersonMatrices): void {
  poseJoints(stillInput(slot), _joints);
  composePersonJoints(num(slot?.x, 0), num(slot?.z, 0), num(slot?.yaw, 0), figureScale(slot?.kind), _joints, out);
}

/** Il cane sdraiato: la sua geometria è già in posa, basta metterla sul
 *  pavimento nel punto, girata dello yaw. */
export function composeDogLying(x: number, z: number, yaw: number, out: THREE.Matrix4): void {
  _qYaw.setFromAxisAngle(UP, yaw);
  _p.set(x, 0, z);
  out.compose(_p, _qYaw, _one);
}

/** Il cane statico sdraiato (People). */
export function composeDog(slot: FigureSlot, out: THREE.Matrix4): void {
  composeDogLying(num(slot?.x, 0), num(slot?.z, 0), num(slot?.yaw, 0), out);
}

/** Il cane in piedi da una posa già calcolata: il corpo sceso di
 *  joints.dogDrop, ogni zampa appesa al suo perno e inclinata in avanti del
 *  suo angolo. (x, z) è il centro del corpo a terra, come per quello
 *  sdraiato. */
export function composeDogStanding(x: number, z: number, yaw: number, joints: PoseJoints, out: DogMatrices): void {
  _qYaw.setFromAxisAngle(UP, yaw);
  _hip.set(x, -joints.dogDrop, z);
  out.body.compose(_hip, _qYaw, _one);
  const top = DOG_LEG_TOP - joints.dogDrop;
  const half = DOG_LEG_LENGTH / 2;
  for (let i = 0; i < 4; i++) {
    const angle = joints.dogLegs[i];
    const pivot = DOG_LEG_PIVOTS[i];
    // Il centro della capsula: mezza zampa sotto il perno, ruotata in avanti.
    _p.set(pivot[0], top - half * Math.cos(angle), pivot[1] + half * Math.sin(angle));
    _p.applyQuaternion(_qYaw);
    _p.x += x;
    _p.z += z;
    // In avanti di `angle` è una rotazione di −angle attorno a X.
    _qLimb.setFromAxisAngle(X_AXIS, -angle);
    _qWorld.multiplyQuaternions(_qYaw, _qLimb);
    out.legs[i].compose(_p, _qWorld, _one);
  }
}

/** Il cane statico in piedi (una comitiva «In uscita»), fermo. */
export function composeDogStill(slot: FigureSlot, out: DogMatrices): void {
  _still.kind = 'dog';
  _still.seat = 0;
  _still.seatHeight = 0;
  poseJoints(_still, _joints);
  composeDogStanding(num(slot?.x, 0), num(slot?.z, 0), num(slot?.yaw, 0), _joints, out);
}
