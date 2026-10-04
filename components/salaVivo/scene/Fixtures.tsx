import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { MarkerModel, RoomModel, Vec2 } from '../types';
import { doorOnWall, floorSize } from './RoomShell';
import type { ScenePalette } from './theme';

/* Gli arredi dei segnaposto: il telaio della porta all'ingresso, il banco del
 * pass, il leggio dell'accoglienza. Ognuno è orientato da `marker.inward`
 * (+Z locale verso la sala), così la scena non deve conoscere la geometria
 * della stanza per girarli.
 *
 * Si disegnano anche nella posizione di ripiego: PR2c e PR3 fanno entrare gli
 * ospiti dalla porta e mettono l'hostess al leggio, quindi ci devono essere
 * sempre. Ma velati, così chi guarda capisce che non è la posizione vera e
 * che va sistemata in Sale & Tavoli (la pagina lo dice anche a parole). */

/** L'opacità di un arredo in posizione di ripiego. */
const GHOST_OPACITY = 0.45;
/** Le ombre a macchia stanno 3 mm sopra il pavimento (che non scrive la
 *  profondità: niente z-fighting, vedi RoomShell). */
const SHADOW_Y = 0.003;

type Triple = [number, number, number];

interface FixtureLook {
  body: THREE.Material;
  edge: THREE.Material;
}

/** Il verso del segnaposto come rotation.y: +Z locale su `inward`. Un
 *  versore illeggibile lascia l'arredo rivolto verso la camera. */
function yawOf(inward: Vec2 | null | undefined): number {
  const x = inward?.x;
  const z = inward?.z;
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return Math.PI;
  if (x === 0 && z === 0) return Math.PI;
  return Math.atan2(x, z);
}

function usable(marker: MarkerModel | null | undefined): marker is MarkerModel {
  const x = marker?.pos?.x;
  const z = marker?.pos?.z;
  return typeof x === 'number' && typeof z === 'number' && Number.isFinite(x) && Number.isFinite(z);
}

interface PartProps {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  position: Triple;
  scale: Triple;
  rotation?: Triple;
}

function Part({ geometry, material, position, scale, rotation }: PartProps) {
  return <mesh geometry={geometry} material={material} position={position} scale={scale} rotation={rotation} />;
}

export function Fixtures({ room, palette, shadow }: { room: RoomModel; palette: ScenePalette; shadow: THREE.Material }) {
  const res = useMemo(() => {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const body = new THREE.MeshLambertMaterial();
    const edge = new THREE.MeshLambertMaterial();
    // Velati: trasparenti e senza scrittura di profondità, o un telaio
    // velato nasconderebbe a metà i tavoli che ha dietro.
    const bodyGhost = new THREE.MeshLambertMaterial({ transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    const edgeGhost = new THREE.MeshLambertMaterial({ transparent: true, opacity: GHOST_OPACITY, depthWrite: false });
    // Per riferimento: il cambio di tema arriva dal .set() della tavolozza.
    body.color = palette.surfaceRow;
    bodyGhost.color = palette.surfaceRow;
    edge.color = palette.borderStrong;
    edgeGhost.color = palette.borderStrong;
    return {
      box,
      plane,
      placed: { body, edge } as FixtureLook,
      ghost: { body: bodyGhost, edge: edgeGhost } as FixtureLook,
      all: [body, edge, bodyGhost, edgeGhost],
    };
  }, [palette]);

  useEffect(
    () => () => {
      res.box.dispose();
      res.plane.dispose();
      for (const m of res.all) m.dispose();
    },
    [res],
  );

  const floor = floorSize(room);
  const entrance = room.markers?.ENTRANCE;
  const pass = room.markers?.PASS;
  const host = room.markers?.HOST_STAND;
  const lookOf = (m: MarkerModel): FixtureLook => (m.placed === false ? res.ghost : res.placed);

  return (
    <group>
      {usable(entrance) && (
        <DoorFrame
          marker={entrance}
          floor={floor}
          look={lookOf(entrance)}
          box={res.box}
        />
      )}
      {usable(pass) && (
        <group position={[pass.pos.x, 0, pass.pos.z]} rotation={[0, yawOf(pass.inward), 0]}>
          {/* Il banco del pass: 1,6 × 0,5 m, alto 1 m, il lato lungo lungo il
              muro. È anche l'ingombro che il passo dei camerieri (PR3) evita. */}
          <Part geometry={res.box} material={lookOf(pass).body} position={[0, 0.48, 0]} scale={[1.6, 0.96, 0.5]} />
          <Part geometry={res.box} material={lookOf(pass).edge} position={[0, 0.98, 0]} scale={[1.68, 0.04, 0.58]} />
          {pass.placed !== false && (
            <Part geometry={res.plane} material={shadow} position={[0, SHADOW_Y, 0]} scale={[2.1, 1, 1]} />
          )}
        </group>
      )}
      {usable(host) && (
        <group position={[host.pos.x, 0, host.pos.z]} rotation={[0, yawOf(host.inward), 0]}>
          {/* Il leggio: 0,5 × 0,4 m, alto 1,1 m col piano inclinato verso
              l'hostess, che PR2c mette mezzo metro verso la sala. */}
          <Part geometry={res.box} material={lookOf(host).body} position={[0, 0.5, 0]} scale={[0.5, 1, 0.4]} />
          <Part
            geometry={res.box}
            material={lookOf(host).edge}
            position={[0, 1.05, 0]}
            rotation={[0.2, 0, 0]}
            scale={[0.56, 0.04, 0.46]}
          />
          {host.placed !== false && (
            <Part geometry={res.plane} material={shadow} position={[0, SHADOW_Y, 0]} scale={[0.9, 1, 0.8]} />
          )}
        </group>
      )}
    </group>
  );
}

/** Il telaio della porta: due stipiti e un architrave, luce di 1 m e 2,1 m
 *  d'altezza, con lo zerbino verso la sala. Sul muro quando l'ingresso sta
 *  entro un metro da un bordo (lo zoccolo lì si apre), altrimenti al
 *  segnaposto. Sottile apposta: dalla camera sta davanti alla sala. */
function DoorFrame({
  marker,
  floor,
  look,
  box,
}: {
  marker: MarkerModel;
  floor: { width: number; depth: number };
  look: FixtureLook;
  box: THREE.BufferGeometry;
}) {
  const wall = doorOnWall(marker, floor);
  const x = wall ? wall.x : marker.pos.x;
  const z = wall ? wall.z : marker.pos.z;
  const yaw = wall ? wall.yaw : yawOf(marker.inward);
  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      <Part geometry={box} material={look.edge} position={[-0.54, 1.05, 0]} scale={[0.08, 2.1, 0.14]} />
      <Part geometry={box} material={look.edge} position={[0.54, 1.05, 0]} scale={[0.08, 2.1, 0.14]} />
      <Part geometry={box} material={look.edge} position={[0, 2.15, 0]} scale={[1.16, 0.1, 0.14]} />
      {/* Lo zerbino: 1 cm di spessore, sopra il pavimento senza toccarne il piano. */}
      <Part geometry={box} material={look.body} position={[0, 0.005, 0.47]} scale={[1, 0.01, 0.7]} />
    </group>
  );
}
