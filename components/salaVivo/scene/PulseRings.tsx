import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { TABLE_TOP_HEIGHT } from '../model/geometry';
import type { TableModel } from '../types';
import type { FrameDemand } from './frameDemand';
import type { ScenePalette } from './theme';

/* L'anello «in arrivo»: il solo stato che si muove, sulla piantina come qui.
 *
 * Stesso disegno della 2D (.tg-pulse in index.css): un anello attorno al
 * piano in --tg-inarrivo-accent, ciclo di 2,2 s, opacità 0,85 → 0 e scala
 * 1 → 1,08 nel primo 70 % con ease-out, poi fermo e invisibile fino al giro
 * dopo. Col movimento ridotto resta fermo e pieno, come la 2D quando il CSS
 * spegne l'animazione (l'anello torna al suo stile: opacità 1, scala 1), e
 * non chiede nemmeno un frame.
 *
 * Nel 30 % del ciclo in cui l'anello è trasparente il gruppo è nascosto, e
 * FrameThrottle non chiede frame (conosce il ciclo da `demand`): un
 * «in arrivo» dura quasi tutto il servizio, e su una TV o un tablet sempre
 * accesi quei frame uguali sono solo calore.
 *
 * Pochi anelli alla volta (i tavoli il cui arrivo è imminente): un mesh a
 * testa con un materiale condiviso, così l'opacità è un uniform solo. */

const PERIOD_MS = 2200;
const FADE_SHARE = 0.7;
const OPACITY_FROM = 0.85;
const SCALE_TO = 1.08;
/** Il glifo mette l'anello 5 px fuori dal piano con un tratto di 2,5 px: in
 *  metri il tratto va da 7 a 13 cm dal bordo, un filo più spesso perché da
 *  lontano non sparisca. */
const RING_OFFSET = 0.07;
const RING_WIDTH = 0.06;
/** Appena sopra l'altezza del piano: fuori dalla sua sagoma, non lo copre. */
const RING_Y = TABLE_TOP_HEIGHT + 0.005;
const RING_RENDER_ORDER = 1;

/** ease-out del CSS = cubic-bezier(0, 0, 0.58, 1): x(t) si inverte con
 *  qualche passo di Newton, poi y(t). */
function cssEaseOut(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const x1 = 0;
  const x2 = 0.58;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const dbx = (t: number) => 3 * (1 - t) * (1 - t) * x1 + 6 * (1 - t) * t * (x2 - x1) + 3 * t * t * (1 - x2);
  let t = u;
  for (let i = 0; i < 6; i++) {
    const d = dbx(t);
    if (Math.abs(d) < 1e-6) break;
    t = Math.min(1, Math.max(0, t - (bx(t) - u) / d));
  }
  // y1 = 0, y2 = 1
  return 3 * (1 - t) * t * t + t * t * t;
}

/** Un anello rettangolare: la sagoma del piano allargata di `offset`, con gli
 *  spigoli arrotondati di quanto si allarga (la vera curva parallela di un
 *  rettangolo), larga `width`. Nel piano XZ, centrata nell'origine. */
function rectRingGeometry(halfL: number, halfD: number, offset: number, width: number): THREE.BufferGeometry {
  const SEG = 8;
  const inner = offset;
  const outer = offset + width;
  const corners: Array<[number, number, number]> = [
    [halfL, halfD, 0],
    [-halfL, halfD, Math.PI / 2],
    [-halfL, -halfD, Math.PI],
    [halfL, -halfD, (3 * Math.PI) / 2],
  ];
  const positions: number[] = [];
  for (const [cx, cz, start] of corners) {
    for (let i = 0; i <= SEG; i++) {
      const a = start + (i / SEG) * (Math.PI / 2);
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      positions.push(cx + dx * inner, 0, cz + dz * inner);
      positions.push(cx + dx * outer, 0, cz + dz * outer);
    }
  }
  const count = positions.length / 6;
  const index: number[] = [];
  for (let i = 0; i < count; i++) {
    const a = i * 2;
    const b = ((i + 1) % count) * 2;
    index.push(a, a + 1, b, b, a + 1, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function ringGeometry(t: TableModel): THREE.BufferGeometry {
  if (t.shape === 'circle') {
    const r = t.length / 2;
    return new THREE.RingGeometry(r + RING_OFFSET, r + RING_OFFSET + RING_WIDTH, 64).rotateX(-Math.PI / 2);
  }
  return rectRingGeometry(t.length / 2, t.depth / 2, RING_OFFSET, RING_WIDTH);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');
const EMPTY: readonly TableModel[] = [];

function pulsing(tables: readonly TableModel[]): TableModel[] {
  return tables.filter(
    (t) => !!t && t.pulse === true && finite(t.center?.x) && finite(t.center?.z) && finite(t.length) && t.length > 0 && finite(t.depth) && t.depth > 0,
  );
}

function ringsKey(tables: readonly TableModel[]): string {
  return pulsing(tables)
    .map((t) => `${t.id}|${t.shape}|${mm(t.center.x)}|${mm(t.center.z)}|${mm(t.rotY)}|${mm(t.length)}|${mm(t.depth)}`)
    .join('\n');
}

interface PulseRingsProps {
  tables: readonly TableModel[] | null | undefined;
  palette: ScenePalette;
  reducedMotion: boolean;
  demand: FrameDemand;
}

export function PulseRings({ tables: tablesProp, palette, reducedMotion, demand }: PulseRingsProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const tables = Array.isArray(tablesProp) ? tablesProp : EMPTY;
  const key = useMemo(() => ringsKey(tables), [tables]);
  const tablesRef = useRef(tables);
  const ringsRef = useRef<{ meshes: THREE.Mesh[]; material: THREE.MeshBasicMaterial } | null>(null);

  useLayoutEffect(() => {
    tablesRef.current = tables;
  });

  // Gli anelli si rifanno tutti quando cambia l'insieme (un tavolo entra o
  // esce da «in arrivo», si sposta): sono pochi, e così l'effetto possiede
  // per intero quello che crea, anche sotto StrictMode.
  useLayoutEffect(() => {
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    // Per riferimento: il cambio di tema arriva dal .set() della tavolozza.
    material.color = palette.ringAccent;
    const meshes: THREE.Mesh[] = [];
    for (const t of pulsing(tablesRef.current)) {
      const mesh = new THREE.Mesh(ringGeometry(t), material);
      mesh.position.set(t.center.x, RING_Y, t.center.z);
      mesh.rotation.y = finite(t.rotY) ? t.rotY : 0;
      mesh.renderOrder = RING_RENDER_ORDER;
      group.add(mesh);
      meshes.push(mesh);
    }
    ringsRef.current = { meshes, material };
    return () => {
      for (const mesh of meshes) {
        group.remove(mesh);
        mesh.geometry.dispose();
      }
      material.dispose();
      ringsRef.current = null;
    };
  }, [key, palette, group]);

  // Chi chiede i frame: a 12 al secondo nella parte visibile del ciclo
  // finché c'è un anello e il movimento è permesso (FrameThrottle), a zero
  // col movimento ridotto.
  useLayoutEffect(() => {
    const rings = ringsRef.current;
    const animate = !reducedMotion && !!rings && rings.meshes.length > 0;
    if (rings && !animate) {
      rings.material.opacity = 1;
      for (const mesh of rings.meshes) mesh.scale.setScalar(1);
    }
    // Fermo (o senza anelli) il gruppo si vede sempre; animato lo decide il
    // frame, secondo la fase.
    if (!animate) group.visible = true;
    demand.pulsing = animate;
    demand.pulsePeriodMs = PERIOD_MS;
    demand.pulseLiveMs = FADE_SHARE * PERIOD_MS;
    demand.wake();
    invalidate();
  }, [key, reducedMotion, palette, demand, invalidate, group]);

  useEffect(
    () => () => {
      demand.pulsing = false;
    },
    [demand],
  );

  useFrame(() => {
    const rings = ringsRef.current;
    if (reducedMotion || !rings || rings.meshes.length === 0) return;
    const phase = (performance.now() % PERIOD_MS) / PERIOD_MS;
    // Oltre la dissolvenza l'anello è trasparente: nascosto, non si
    // disegna nemmeno nei frame chiesti da altro (la camera che si muove).
    const live = phase < FADE_SHARE;
    group.visible = live;
    if (!live) return;
    const e = cssEaseOut(phase / FADE_SHARE);
    rings.material.opacity = OPACITY_FROM * (1 - e);
    const scale = 1 + (SCALE_TO - 1) * e;
    for (const mesh of rings.meshes) mesh.scale.setScalar(scale);
  });

  return <primitive object={group} />;
}
