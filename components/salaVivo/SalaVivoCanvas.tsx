import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import type * as THREE from 'three';
import type { FigureSlot, RoomModel, SalaVivoCanvasProps, TableModel } from './types';
import { CameraRig } from './scene/CameraRig';
import { DebugStats } from './scene/DebugStats';
import { Fixtures } from './scene/Fixtures';
import { createFrameDemand, type FrameDemand } from './scene/frameDemand';
import { FrameThrottle } from './scene/FrameThrottle';
import { People } from './scene/People';
import { PulseRings } from './scene/PulseRings';
import { RoomShell } from './scene/RoomShell';
import { Signs } from './scene/Signs';
import { TableLabels, type LabelBadge } from './scene/TableLabels';
import { TablesLayer } from './scene/TablesLayer';
import {
  AMBIENT_INTENSITY,
  createBlobShadow,
  disposeBlobShadow,
  SUN_INTENSITY,
  SUN_POSITION,
  useScenePalette,
  type ScenePalette,
} from './scene/theme';

/* La sala in 3D: il solo modulo che porta three nel bundle, caricato a
 * richiesta dalla pagina dopo la sonda WebGL2 (chunk assets/sala3d/).
 *
 * Riceve una RoomModel già calcolata dal modello puro e la disegna: niente
 * layout, niente stati, niente rete qui dentro. Il modello è un oggetto nuovo
 * a ogni ricalcolo (dati, minuto): ogni pezzo della scena confronta la sua
 * firma e rifà il lavoro solo quando cambia quello che mostra.
 *
 * - frameloop "demand": si disegna solo quando qualcosa lo chiede (vedi
 *   FrameThrottle); da ferma la sala è a 0 fps.
 * - `flat`: niente tone mapping, i colori dei token arrivano come sono (la
 *   taratura della luce è in scene/theme.ts).
 * - DPR fra 1 e 1,5: oltre, su un tablet retina, si paga il quadruplo dei
 *   pixel per una differenza che a un metro non si vede. 1 in modalità lenta
 *   e dopo il declassamento automatico.
 * - Mai failIfMajorPerformanceCaveat qui: un dispositivo lento deve
 *   disegnare lo stesso, piano.
 */

const DPR_RANGE: [number, number] = [1, 1.5];
// Costanti di modulo: R3F confronta camera e gl a ogni render del Canvas, e
// un oggetto uguale non riconfigura niente (la camera poi la muove CameraRig).
const CAMERA = { fov: 35, near: 0.1, far: 500, position: [0, 12, 10] as [number, number, number] };
// Senza MSAA in modalità lenta: lì il WebGL è software e l'antialias costa
// quanto il resto del frame.
const GL_DEFAULT = { antialias: true };
const GL_SLOW = { antialias: false };

export default function SalaVivoCanvas({ room, reducedMotion, slowMode, debug, recenterSignal, onContextLost }: SalaVivoCanvasProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [demand] = useState(createFrameDemand);
  // Il declassamento passa dalla prop `dpr`: R3F la riapplica a ogni render
  // del Canvas, e un setDpr(1) da solo tornerebbe a 1,5 al minuto dopo.
  const [dprCapped, setDprCapped] = useState(false);
  const onSlowFrames = useCallback(() => setDprCapped(true), []);

  // aria-hidden: per lo screen reader la sala è l'immagine con i numeri che
  // la pagina mette accanto; qui non c'è niente da leggere né da raggiungere.
  return (
    <div className="absolute inset-0" aria-hidden="true">
      <Canvas frameloop="demand" flat dpr={slowMode || dprCapped ? 1 : DPR_RANGE} camera={CAMERA} gl={slowMode ? GL_SLOW : GL_DEFAULT}>
        <Scene
          room={room}
          reducedMotion={reducedMotion}
          slowMode={slowMode}
          debug={debug}
          recenterSignal={recenterSignal}
          onContextLost={onContextLost}
          demand={demand}
          overlayRef={overlayRef}
          onSlowFrames={onSlowFrames}
        />
      </Canvas>
      {debug && (
        <div
          ref={overlayRef}
          aria-hidden="true"
          className="pointer-events-none absolute left-2 top-2 rounded-[var(--ds-radius-sm)] border border-[var(--ds-border)] bg-[var(--ds-surface)] px-2 py-1 text-[11px] tabular-nums text-[var(--ds-text-secondary)]"
        />
      )}
    </div>
  );
}

interface SceneProps {
  room: RoomModel;
  reducedMotion: boolean;
  slowMode: boolean;
  debug: boolean;
  recenterSignal: number;
  onContextLost: () => void;
  demand: FrameDemand;
  overlayRef: RefObject<HTMLDivElement | null>;
  onSlowFrames: () => void;
}

function Scene({ room, reducedMotion, slowMode, debug, recenterSignal, onContextLost, demand, overlayRef, onSlowFrames }: SceneProps) {
  const { palette, version } = useScenePalette();
  const shadow = useBlobShadowMaterial(palette, version);
  useSceneBackground(palette);
  useContextLoss(onContextLost);
  const seats = useMemo(() => seatsOf(room.tables), [room.tables]);
  const seated = useMemo(() => tablesWithPeople(room.figures), [room.figures]);
  const badge = useMemo(() => lobbyBadgeOf(room.figures, room.summary?.lobby), [room.figures, room.summary?.lobby]);

  return (
    <>
      <ambientLight intensity={AMBIENT_INTENSITY} />
      <directionalLight position={SUN_POSITION} intensity={SUN_INTENSITY} />
      <RoomShell room={room} palette={palette} />
      <Fixtures room={room} palette={palette} shadow={shadow} />
      <TablesLayer tables={room.tables} palette={palette} themeVersion={version} shadow={shadow} />
      <Signs tables={room.tables} palette={palette} themeVersion={version} />
      <People figures={room.figures} seats={seats} palette={palette} themeVersion={version} shadow={shadow} />
      <TableLabels tables={room.tables} seated={seated} badge={badge} palette={palette} themeVersion={version} />
      <PulseRings tables={room.tables} palette={palette} reducedMotion={reducedMotion} demand={demand} />
      <CameraRig room={room} reducedMotion={reducedMotion} recenterSignal={recenterSignal} demand={demand} />
      <FrameThrottle demand={demand} slowMode={slowMode} onSlowFrames={onSlowFrames} />
      {debug && <DebugStats targetRef={overlayRef} slowMode={slowMode} />}
    </>
  );
}

/** I posti della sala, Σ chairs.length: la capienza di partenza delle
 *  persone (People), che non si rifà a ogni minuto. */
function seatsOf(tables: readonly TableModel[] | null | undefined): number {
  if (!Array.isArray(tables)) return 0;
  let n = 0;
  for (const t of tables) n += Array.isArray(t?.chairs) ? t.chairs.length : 0;
  return n;
}

/** I tavoli dove siede o sta qualcuno (anche il cane): lì l'etichetta scende
 *  sul piano, per non coprire le teste di chi siede dall'altra parte. */
function tablesWithPeople(figures: readonly FigureSlot[] | null | undefined): ReadonlySet<number> {
  const ids = new Set<number>();
  if (!Array.isArray(figures)) return ids;
  for (const f of figures) {
    if (f && typeof f.tableId === 'number') ids.add(f.tableId);
  }
  return ids;
}

/** «+N» sopra l'ultimo di chi aspetta all'ingresso, quando la testata ne
 *  conta più di quanti l'ingresso ne disegna (sei). null altrimenti. */
function lobbyBadgeOf(figures: readonly FigureSlot[] | null | undefined, lobby: number | null | undefined): LabelBadge | null {
  if (!Array.isArray(figures) || typeof lobby !== 'number' || !Number.isFinite(lobby)) return null;
  let drawn = 0;
  let last: FigureSlot | null = null;
  for (const f of figures) {
    if (!f || f.tableId !== null || (f.kind !== 'adult' && f.kind !== 'kid')) continue;
    drawn++;
    last = f;
  }
  const extra = Math.floor(lobby) - drawn;
  return last && extra > 0 ? { x: last.x, z: last.z, text: `+${extra}` } : null;
}

/** Lo sfondo della scena è --ds-canvas, lo stesso colore del palco della
 *  pagina: nessun bordo fra il caricamento e il primo frame. Per riferimento
 *  alla tavolozza, così segue il tema da solo. */
function useSceneBackground(palette: ScenePalette): void {
  const scene = useThree((s) => s.scene);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const previous = scene.background;
    scene.background = palette.canvas;
    invalidate();
    return () => {
      scene.background = previous;
    };
  }, [scene, palette, invalidate]);
}

/** Il materiale delle ombre a macchia, uno per tutta la scena: l'opacità
 *  cambia col tema (0,12 chiaro, 0,30 scuro). */
function useBlobShadowMaterial(palette: ScenePalette, version: number): THREE.Material {
  const invalidate = useThree((s) => s.invalidate);
  const [shadow] = useState(createBlobShadow);
  useEffect(() => () => disposeBlobShadow(shadow), [shadow]);
  useLayoutEffect(() => {
    shadow.material.opacity = palette.shadowOpacity;
    invalidate();
  }, [shadow, palette, version, invalidate]);
  return shadow.material;
}

/** Il contesto WebGL perso (driver riavviato, GPU sotto pressione, troppi
 *  contesti su Safari): preventDefault, poi la pagina mostra «Riavvia la
 *  vista» e rimonta il canvas con una chiave nuova. Il listener si toglie
 *  allo smontaggio: R3F forza la perdita del contesto quando libera il
 *  renderer, e quella non è un guasto da segnalare. */
function useContextLoss(onContextLost: () => void): void {
  const gl = useThree((s) => s.gl);
  const callback = useRef(onContextLost);
  useEffect(() => {
    callback.current = onContextLost;
  });
  useEffect(() => {
    const canvas = gl.domElement;
    let active = true;
    const onLost = (event: Event) => {
      event.preventDefault();
      if (active) callback.current();
    };
    canvas.addEventListener('webglcontextlost', onLost);
    return () => {
      active = false;
      canvas.removeEventListener('webglcontextlost', onLost);
    };
  }, [gl]);
}
