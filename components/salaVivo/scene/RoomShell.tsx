import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { MarkerModel, RoomModel } from '../types';
import type { ScenePalette } from './theme';

/* Il guscio della sala: il pavimento, da (0, 0) a (width, depth) come il
 * modello lo misura, e uno zoccolo basso lungo i bordi. Niente pareti alte:
 * dalla camera a 52° coprirebbero i tavoli vicini al bordo, e la sala si deve
 * leggere tutta come la piantina. Lo zoccolo basta a dire dove finisce. */

/** Lo zoccolo: 10 cm d'altezza, 5 di spessore, tutto dentro il pavimento. */
export const SKIRT_HEIGHT = 0.1;
export const SKIRT_THICKNESS = 0.05;
/** Un ingresso entro un metro dal bordo VERO del pavimento è una porta in
 *  quel muro. Il metro è quello con cui il modello aggancia `inward`, ma il
 *  modello misura i bordi basso e destro togliendo il pavimento che la sala
 *  aggiunge oltre un segnaposto (chip, etichetta e margine: 2,4 m sotto, 2 m
 *  a destra), e qui no, di proposito: un ingresso posato in fondo alla
 *  piantina guarda dritto dentro ma resta al suo posto. Spostato nel muro
 *  finirebbe 2,4 m più in là, fuori dall'inquadratura, che prende il
 *  contenuto attorno ai segnaposto e non il pavimento intero (provato:
 *  la porta spariva sotto il bordo del palco). */
export const DOOR_SNAP = 1;
/** Il varco nello zoccolo, poco più largo del telaio (1,16 m). */
export const DOOR_GAP = 1.2;

export type WallEdge = 'far' | 'near' | 'left' | 'right';

export interface DoorOnWall {
  /** Il centro della porta, sulla mezzeria dello zoccolo. */
  x: number;
  z: number;
  /** rotation.y del telaio: +Z locale verso la sala. */
  yaw: number;
  edge: WallEdge;
  /** La coordinata lungo il bordo (x per far/near, z per left/right). */
  along: number;
}

const finitePositive = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

/** Le misure del pavimento, mai nulle: un modello vuoto o un numero sbagliato
 *  non devono dare una sala di larghezza zero (e una camera che diverge). */
export function floorSize(room: Pick<RoomModel, 'floor'>): { width: number; depth: number } {
  return { width: finitePositive(room.floor?.width, 1), depth: finitePositive(room.floor?.depth, 1) };
}

/** L'ingresso, se sta sul muro: il bordo più vicino entro DOOR_SNAP. Lì la
 *  porta si disegna NEL muro (sul filo dello zoccolo, che lì si apre), così
 *  si legge come una porta e non come un telaio in mezzo alla stanza. Più
 *  lontano dai bordi (un ingresso disegnato al centro, o posato in fondo
 *  alla piantina: vedi DOOR_SNAP) resta dov'è, girato verso la sala. */
export function doorOnWall(marker: MarkerModel | null | undefined, floor: { width: number; depth: number }): DoorOnWall | null {
  const x = marker?.pos?.x;
  const z = marker?.pos?.z;
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return null;
  const { width: W, depth: D } = floor;
  const candidates: Array<{ edge: WallEdge; dist: number }> = [
    { edge: 'near', dist: D - z },
    { edge: 'far', dist: z },
    { edge: 'left', dist: x },
    { edge: 'right', dist: W - x },
  ];
  let best = candidates[0];
  for (const c of candidates) if (c.dist < best.dist) best = c;
  if (!(best.dist <= DOOR_SNAP)) return null;

  const half = DOOR_GAP / 2;
  const alongX = Math.min(Math.max(x, half), Math.max(half, W - half));
  const alongZ = Math.min(Math.max(z, half), Math.max(half, D - half));
  const mid = SKIRT_THICKNESS / 2;
  switch (best.edge) {
    case 'near':
      return { x: alongX, z: D - mid, yaw: Math.PI, edge: 'near', along: alongX };
    case 'far':
      return { x: alongX, z: mid, yaw: 0, edge: 'far', along: alongX };
    case 'left':
      return { x: mid, z: alongZ, yaw: Math.PI / 2, edge: 'left', along: alongZ };
    default:
      return { x: W - mid, z: alongZ, yaw: -Math.PI / 2, edge: 'right', along: alongZ };
  }
}

interface SkirtPiece {
  x: number;
  z: number;
  sx: number;
  sz: number;
}

/** I pezzi dello zoccolo: un bordo intero, o due tronconi ai lati della porta. */
function skirtPieces(W: number, D: number, door: DoorOnWall | null): SkirtPiece[] {
  const t = SKIRT_THICKNESS;
  const pieces: SkirtPiece[] = [];
  const run = (edge: WallEdge, length: number, place: (from: number, to: number) => SkirtPiece) => {
    if (door && door.edge === edge) {
      const a = door.along - DOOR_GAP / 2;
      const b = door.along + DOOR_GAP / 2;
      if (a > 0.01) pieces.push(place(0, a));
      if (b < length - 0.01) pieces.push(place(b, length));
    } else {
      pieces.push(place(0, length));
    }
  };
  run('far', W, (a, b) => ({ x: (a + b) / 2, z: t / 2, sx: b - a, sz: t }));
  run('near', W, (a, b) => ({ x: (a + b) / 2, z: D - t / 2, sx: b - a, sz: t }));
  run('left', D, (a, b) => ({ x: t / 2, z: (a + b) / 2, sx: t, sz: b - a }));
  run('right', D, (a, b) => ({ x: W - t / 2, z: (a + b) / 2, sx: t, sz: b - a }));
  return pieces;
}

export function RoomShell({ room, palette }: { room: RoomModel; palette: ScenePalette }) {
  const invalidate = useThree((s) => s.invalidate);

  const res = useMemo(() => {
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const box = new THREE.BoxGeometry(1, 1, 1);
    // Il pavimento non scrive la profondità ed è il primo a disegnarsi
    // (renderOrder −1): ombre a macchia e zerbino, a pochi mm sopra, non
    // possono fare z-fighting con lui a nessuna distanza della camera.
    const floor = new THREE.MeshLambertMaterial({ depthWrite: false });
    const skirt = new THREE.MeshLambertMaterial();
    skirt.color = palette.borderStrong;
    return { plane, box, floor, skirt };
  }, [palette]);

  useEffect(
    () => () => {
      res.plane.dispose();
      res.box.dispose();
      res.floor.dispose();
      res.skirt.dispose();
    },
    [res],
  );

  // Per riferimento, non copiato: al cambio di tema il pavimento segue da sé.
  useLayoutEffect(() => {
    res.floor.color = room.outdoor ? palette.outdoorFloor : palette.surface;
    invalidate();
  }, [res, room.outdoor, palette, invalidate]);

  const { width: W, depth: D } = floorSize(room);
  const entrance = room.markers?.ENTRANCE;
  const door = doorOnWall(entrance, { width: W, depth: D });
  const pieces = useMemo(
    () => skirtPieces(W, D, door),
    // Le dipendenze sono i numeri: il modello è un oggetto nuovo a ogni minuto.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [W, D, door?.edge, door?.along],
  );

  return (
    <group>
      <mesh geometry={res.plane} material={res.floor} position={[W / 2, 0, D / 2]} scale={[W, 1, D]} renderOrder={-1} />
      {pieces.map((p, i) => (
        <mesh
          key={i}
          geometry={res.box}
          material={res.skirt}
          position={[p.x, SKIRT_HEIGHT / 2, p.z]}
          scale={[p.sx, SKIRT_HEIGHT, p.sz]}
        />
      ))}
    </group>
  );
}
