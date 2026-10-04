import { useEffect, useLayoutEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { RoomModel } from '../types';
import { DOOR_GAP, SKIRT_THICKNESS, doorOnWall, type DoorOnWall, type WallEdge } from '../model/geometry';
import type { ScenePalette } from './theme';

/* Il guscio della sala: il pavimento, da (0, 0) a (width, depth) come il
 * modello lo misura, e uno zoccolo basso lungo i bordi. Niente pareti alte:
 * dalla camera a 52° coprirebbero i tavoli vicini al bordo, e la sala si deve
 * leggere tutta come la piantina. Lo zoccolo basta a dire dove finisce. */

// La porta nel muro sta in model/geometry (PR3): è anche il varco da cui gli
// ospiti entrano camminando, e deve essere lo stesso calcolo. Ripresa da qui
// per chi la importava dal guscio (Fixtures).
export { doorOnWall, DOOR_SNAP, DOOR_GAP, SKIRT_THICKNESS, type DoorOnWall, type WallEdge } from '../model/geometry';

/** Lo zoccolo: 10 cm d'altezza (lo spessore, 5 cm, sta in model/geometry con
 *  la porta), tutto dentro il pavimento. */
export const SKIRT_HEIGHT = 0.1;

const finitePositive = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

/** Le misure del pavimento, mai nulle: un modello vuoto o un numero sbagliato
 *  non devono dare una sala di larghezza zero (e una camera che diverge). */
export function floorSize(room: Pick<RoomModel, 'floor'>): { width: number; depth: number } {
  return { width: finitePositive(room.floor?.width, 1), depth: finitePositive(room.floor?.depth, 1) };
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
