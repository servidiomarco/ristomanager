import { useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import type { RoomModel } from '../types';
import type { FrameDemand } from './frameDemand';
import { floorSize } from './RoomShell';

/* La camera: guarda la sala dal bordo basso della piantina (+Z) verso −Z, 52°
 * sopra l'orizzonte, così destra, sinistra, sopra e sotto sono quelli della
 * 2D e chi passa dall'una all'altra non si deve rigirare la sala in testa.
 *
 * Inquadratura: ricerca binaria sulla distanza (24 passi) finché gli angoli
 * del contenuto (tavoli e segnaposto, non il pavimento intero) stanno tutti
 * entro 0,88 dell'NDC, sia sul pavimento sia a 1,8 m (le teste di PR2c, il
 * telaio della porta). Poi un passo che centra il contenuto in verticale (la
 * prospettiva ingrandisce il bordo vicino) e una seconda ricerca.
 *
 * MapControls (da three/addons, non da drei): un dito sposta, due ruotano e
 * avvicinano; smorzamento 0,12 (niente inerzia col movimento ridotto: la
 * camera si ferma dove la lascia il dito); angolo polare 25–65°, azimut ±35°
 * attorno all'inquadratura, distanza da 0,35 a 1,6 volte l'inquadratura,
 * bersaglio tenuto sul pavimento. Oltre non serve: chi si perde preme
 * «Centra». */

const DEG = Math.PI / 180;
const ELEVATION = 52 * DEG;
const FIT_NDC = 0.88;
const FIT_ITERATIONS = 24;
const FIT_HEAD_HEIGHT = 1.8;
const DAMPING = 0.12;
const POLAR_MIN = 25 * DEG;
const POLAR_MAX = 65 * DEG;
const AZIMUTH_SPAN = 35 * DEG;
const DISTANCE_MIN = 0.35;
const DISTANCE_MAX = 1.6;
const RECENTER_MS = 400;
const NEAR = 0.1;
const FAR_MIN = 500;
/** Un contenuto puntiforme (un solo segnaposto) non dà un'inquadratura:
 *  almeno 2 m per lato. */
const MIN_CONTENT = 2;

/** Dal bersaglio verso la camera: +Z e in alto, a 52°. */
const VIEW_DIR = new THREE.Vector3(0, Math.sin(ELEVATION), Math.cos(ELEVATION));

interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface Fit {
  target: THREE.Vector3;
  position: THREE.Vector3;
  distance: number;
}

interface RecenterAnimation {
  start: number;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromOffset: THREE.Spherical;
  toOffset: THREE.Spherical;
  toPosition: THREE.Vector3;
}

interface RigState {
  fit: Fit | null;
  roomId: number | null;
  /** Qualcuno ha toccato la camera dall'ultima inquadratura: un resize del
   *  palco o un contenuto che cambia non gliela strappano di mano. */
  userMoved: boolean;
  floorW: number;
  floorD: number;
  anim: RecenterAnimation | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');

/** Il contenuto da inquadrare, letto con prudenza: senza un rettangolo
 *  valido si inquadra il pavimento. */
function contentBounds(room: RoomModel, floor: { width: number; depth: number }): Bounds {
  const b = room.bounds;
  if (b && finite(b.minX) && finite(b.minZ) && finite(b.maxX) && finite(b.maxZ) && b.maxX >= b.minX && b.maxZ >= b.minZ) {
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const hx = Math.max(MIN_CONTENT, b.maxX - b.minX) / 2;
    const hz = Math.max(MIN_CONTENT, b.maxZ - b.minZ) / 2;
    return { minX: cx - hx, minZ: cz - hz, maxX: cx + hx, maxZ: cz + hz };
  }
  return { minX: 0, minZ: 0, maxX: floor.width, maxZ: floor.depth };
}

const _corners = Array.from({ length: 8 }, () => new THREE.Vector3());
const _v = new THREE.Vector3();
const _t = new THREE.Vector3();
const _sph = new THREE.Spherical();

function placeProbe(cam: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number): void {
  cam.position.copy(target).addScaledVector(VIEW_DIR, distance);
  cam.lookAt(target);
  cam.updateMatrixWorld(true);
}

function fits(cam: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number): boolean {
  placeProbe(cam, target, distance);
  for (const p of _corners) {
    _v.copy(p).applyMatrix4(cam.matrixWorldInverse);
    // Dietro la camera o dentro il piano near: non è inquadrato, comunque.
    if (_v.z > -cam.near) return false;
    _v.applyMatrix4(cam.projectionMatrix);
    if (Math.abs(_v.x) > FIT_NDC || Math.abs(_v.y) > FIT_NDC) return false;
  }
  return true;
}

function searchDistance(cam: THREE.PerspectiveCamera, target: THREE.Vector3): number {
  let hi = 10;
  while (!fits(cam, target, hi) && hi < 1e5) hi *= 2;
  let lo = 0;
  for (let i = 0; i < FIT_ITERATIONS; i++) {
    const mid = (lo + hi) / 2;
    if (fits(cam, target, mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

function computeFit(bounds: Bounds, floor: { width: number; depth: number }, aspect: number, fov: number, cam: THREE.PerspectiveCamera): Fit {
  cam.fov = fov;
  cam.aspect = aspect;
  cam.near = NEAR;
  cam.far = 1e6;
  cam.updateProjectionMatrix();
  let i = 0;
  for (const y of [0, FIT_HEAD_HEIGHT]) {
    for (const x of [bounds.minX, bounds.maxX]) {
      for (const z of [bounds.minZ, bounds.maxZ]) _corners[i++].set(x, y, z);
    }
  }
  const target = new THREE.Vector3((bounds.minX + bounds.maxX) / 2, 0, (bounds.minZ + bounds.maxZ) / 2);
  let distance = searchDistance(cam, target);

  // In verticale il contenuto non esce centrato: il bordo vicino è più
  // grande, e gli angoli a 1,8 m allungano quello lontano. Si sposta il
  // bersaglio lungo Z di quanto serve (un metro sul pavimento vale sin 52°
  // sullo schermo) e si cerca di nuovo la distanza; la stima è al primo
  // ordine, quindi al più tre giri.
  for (let pass = 0; pass < 3; pass++) {
    placeProbe(cam, target, distance);
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of _corners) {
      _v.copy(p).project(cam);
      lo = Math.min(lo, _v.y);
      hi = Math.max(hi, _v.y);
    }
    const mid = (lo + hi) / 2;
    if (!finite(mid) || Math.abs(mid) <= 0.01) break;
    const halfHeight = distance * Math.tan((fov * DEG) / 2);
    target.z = clamp(target.z - (mid * halfHeight) / Math.sin(ELEVATION), Math.max(0, bounds.minZ), Math.min(floor.depth, bounds.maxZ));
    distance = searchDistance(cam, target);
  }
  target.x = clamp(target.x, 0, floor.width);
  target.z = clamp(target.z, 0, floor.depth);
  return { target, position: target.clone().addScaledVector(VIEW_DIR, distance), distance };
}

/** Ferma l'inerzia dello smorzamento. three non ha un metodo pubblico per
 *  farlo: i campi interni di OrbitControls ci sono da anni, e se un giorno
 *  sparissero l'inerzia residua si esaurirebbe da sé in un secondo. Senza,
 *  dopo «Centra» o un cambio di sala l'ultimo trascinamento ripartirebbe al
 *  primo frame, spostando la camera appena messa a posto. */
type Inertia = { _sphericalDelta?: THREE.Spherical; _panOffset?: THREE.Vector3; _scale?: number };
function stopInertia(controls: MapControls): void {
  const c = controls as unknown as Inertia;
  c._sphericalDelta?.set(0, 0, 0);
  c._panOffset?.set(0, 0, 0);
  if (typeof c._scale === 'number') c._scale = 1;
}

function snapTo(controls: MapControls, camera: THREE.PerspectiveCamera, target: THREE.Vector3, position: THREE.Vector3): void {
  stopInertia(controls);
  controls.target.copy(target);
  camera.position.copy(position);
  camera.lookAt(target);
  controls.update();
}

function applyLimits(controls: MapControls | null, camera: THREE.PerspectiveCamera, fit: Fit, floor: { width: number; depth: number }): void {
  if (controls) {
    controls.minDistance = fit.distance * DISTANCE_MIN;
    controls.maxDistance = fit.distance * DISTANCE_MAX;
  }
  // far segue la sala: 500 m bastano a tutte quelle vere, ma una sala
  // enorme non deve perdere il fondo quando si allontana la camera.
  camera.near = NEAR;
  camera.far = Math.max(FAR_MIN, 2 * fit.distance * DISTANCE_MAX + 2 * Math.hypot(floor.width, floor.depth));
  camera.updateProjectionMatrix();
}

const easeInOutCubic = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

interface CameraRigProps {
  room: RoomModel;
  reducedMotion: boolean;
  recenterSignal: number;
  demand: FrameDemand;
  /** Qualcuno ha cominciato a trascinare, pizzicare o girare la rotella:
   *  la pagina mette in pausa «Segui il servizio», così la camera non
   *  cambia sala sotto le dita di chi la sta muovendo. */
  onUserCamera?: () => void;
}

export function CameraRig({ room, reducedMotion, recenterSignal, demand, onUserCamera }: CameraRigProps) {
  const defaultCamera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const size = useThree((s) => s.size);
  const invalidate = useThree((s) => s.invalidate);
  const camera = (defaultCamera as THREE.PerspectiveCamera).isPerspectiveCamera ? (defaultCamera as THREE.PerspectiveCamera) : null;

  // Una camera di prova per la ricerca: mai renderizzata, niente da liberare.
  const probe = useMemo(() => new THREE.PerspectiveCamera(), []);
  const controlsRef = useRef<MapControls | null>(null);
  const rig = useRef<RigState>({ fit: null, roomId: null, userMoved: false, floorW: 1, floorD: 1, anim: null });
  const roomRef = useRef(room);
  const reducedMotionRef = useRef(reducedMotion);
  const onUserCameraRef = useRef(onUserCamera);
  const lastSignal = useRef(recenterSignal);

  useLayoutEffect(() => {
    roomRef.current = room;
    reducedMotionRef.current = reducedMotion;
    onUserCameraRef.current = onUserCamera;
  });

  // I controlli nascono e muoiono con l'effetto: si attaccano al canvas nel
  // costruttore, e sotto StrictMode un'istanza creata nel render resterebbe
  // staccata dopo il primo smontaggio finto.
  useLayoutEffect(() => {
    if (!camera) return;
    const controls = new MapControls(camera, gl.domElement);
    controls.enableDamping = !reducedMotionRef.current;
    controls.dampingFactor = DAMPING;
    controls.minPolarAngle = POLAR_MIN;
    controls.maxPolarAngle = POLAR_MAX;
    // L'inquadratura guarda da +Z: azimut 0, e ±35° attorno.
    controls.minAzimuthAngle = -AZIMUTH_SPAN;
    controls.maxAzimuthAngle = AZIMUTH_SPAN;
    controls.cursorStyle = 'grab';

    const onStart = () => {
      const s = rig.current;
      s.userMoved = true;
      s.anim = null;
      demand.animatingUntil = 0;
      demand.interacting = true;
      demand.wake();
      // Per ultimo: la pagina può cambiare stato, e la camera è già a posto.
      onUserCameraRef.current?.();
    };
    const onEnd = () => {
      demand.interacting = false;
      demand.lastEndAt = performance.now();
      demand.wake();
    };
    // Il bersaglio resta sul pavimento: chi trascina oltre il bordo si ferma
    // lì, e la camera trasla con lui così l'inquadratura non ruota.
    const onChange = () => {
      const s = rig.current;
      const t = controls.target;
      const x = clamp(t.x, 0, s.floorW);
      const z = clamp(t.z, 0, s.floorD);
      if (x === t.x && z === t.z && t.y === 0) return;
      camera.position.x += x - t.x;
      camera.position.y -= t.y;
      camera.position.z += z - t.z;
      t.set(x, 0, z);
      (controls as unknown as Inertia)._panOffset?.set(0, 0, 0);
    };
    controls.addEventListener('start', onStart);
    controls.addEventListener('end', onEnd);
    controls.addEventListener('change', onChange);
    controlsRef.current = controls;

    const fit = rig.current.fit;
    if (fit) {
      applyLimits(controls, camera, fit, { width: rig.current.floorW, depth: rig.current.floorD });
      snapTo(controls, camera, fit.target, fit.position);
      invalidate();
    }

    return () => {
      controls.removeEventListener('start', onStart);
      controls.removeEventListener('end', onEnd);
      controls.removeEventListener('change', onChange);
      controls.dispose();
      controlsRef.current = null;
      demand.interacting = false;
      demand.animatingUntil = 0;
      rig.current.anim = null;
    };
  }, [camera, gl, demand, invalidate]);

  // Col movimento ridotto niente inerzia: dopo un trascinamento o un pizzico
  // la camera non scivola oltre, come «Centra» che lì arriva di colpo.
  useLayoutEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.enableDamping = !reducedMotion;
    if (reducedMotion) stopInertia(controls);
  }, [reducedMotion, camera, gl]);

  // L'inquadratura si ricalcola quando cambiano sala, contenuto, pavimento o
  // palco; il modello è un oggetto nuovo a ogni minuto, la firma no.
  const b = room.bounds;
  const fitKey = `${room.id}|${mm(b?.minX)}|${mm(b?.minZ)}|${mm(b?.maxX)}|${mm(b?.maxZ)}|${mm(room.floor?.width)}|${mm(room.floor?.depth)}`;

  useLayoutEffect(() => {
    if (!camera || !(size.width > 0) || !(size.height > 0)) return;
    const current = roomRef.current;
    const floor = floorSize(current);
    const fit = computeFit(contentBounds(current, floor), floor, size.width / size.height, camera.fov, probe);
    const s = rig.current;
    const roomChanged = s.roomId !== current.id;
    s.roomId = current.id;
    s.fit = fit;
    s.floorW = floor.width;
    s.floorD = floor.depth;
    const controls = controlsRef.current;
    applyLimits(controls, camera, fit, floor);
    // Un'altra sala, il primo montaggio, o nessuno ha toccato la camera:
    // dritti sull'inquadratura nuova. Altrimenti cambiano solo i limiti.
    if (roomChanged || !s.userMoved) {
      s.userMoved = false;
      s.anim = null;
      demand.animatingUntil = 0;
      if (controls) snapTo(controls, camera, fit.target, fit.position);
      else {
        camera.position.copy(fit.position);
        camera.lookAt(fit.target);
      }
    }
    invalidate();
  }, [fitKey, size.width, size.height, camera, probe, demand, invalidate]);

  // «Centra»: torna all'inquadratura in 400 ms, subito col movimento ridotto.
  // Il primo valore del segnale non conta: è quello con cui la pagina parte.
  useLayoutEffect(() => {
    if (recenterSignal === lastSignal.current) return;
    lastSignal.current = recenterSignal;
    const controls = controlsRef.current;
    const s = rig.current;
    const fit = s.fit;
    if (!controls || !camera || !fit) return;
    s.userMoved = false;
    if (reducedMotionRef.current) {
      s.anim = null;
      snapTo(controls, camera, fit.target, fit.position);
      invalidate();
      return;
    }
    stopInertia(controls);
    const start = performance.now();
    s.anim = {
      start,
      fromTarget: controls.target.clone(),
      toTarget: fit.target.clone(),
      fromOffset: new THREE.Spherical().setFromVector3(_v.copy(camera.position).sub(controls.target)),
      toOffset: new THREE.Spherical().setFromVector3(_v.copy(fit.position).sub(fit.target)),
      toPosition: fit.position.clone(),
    };
    demand.animatingUntil = start + RECENTER_MS;
    demand.wake();
    invalidate();
  }, [recenterSignal, camera, demand, invalidate]);

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls || !camera) return;
    const s = rig.current;
    const a = s.anim;
    if (a) {
      const now = performance.now();
      const p = clamp((now - a.start) / RECENTER_MS, 0, 1);
      if (p >= 1) {
        s.anim = null;
        snapTo(controls, camera, a.toTarget, a.toPosition);
        return;
      }
      // I frame si chiedono finché l'animazione non arriva DAVVERO in fondo:
      // fermarsi all'istante previsto potrebbe lasciare l'ultimo frame al 96 %
      // e la camera a un passo dall'inquadratura.
      demand.animatingUntil = Math.max(demand.animatingUntil, now + 100);
      const e = easeInOutCubic(p);
      _t.lerpVectors(a.fromTarget, a.toTarget, e);
      _sph.set(
        a.fromOffset.radius + (a.toOffset.radius - a.fromOffset.radius) * e,
        a.fromOffset.phi + (a.toOffset.phi - a.fromOffset.phi) * e,
        a.fromOffset.theta + (a.toOffset.theta - a.fromOffset.theta) * e,
      );
      controls.target.copy(_t);
      camera.position.setFromSpherical(_sph).add(_t);
      camera.lookAt(_t);
      return;
    }
    // Ogni frame fa un passo dello smorzamento; finché la camera si muove,
    // FrameThrottle continua a chiedere frame (vedi `settling`).
    demand.settling = controls.update();
  });

  return null;
}
