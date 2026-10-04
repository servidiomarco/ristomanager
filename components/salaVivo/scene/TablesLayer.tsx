import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHAIR_BACK_HEIGHT, SEAT_HEIGHT, TABLE_TOP_HEIGHT } from '../model/geometry';
import type { TableModel } from '../types';
import { statusColors, type ScenePalette } from './theme';

/* Tavoli e sedie: un InstancedMesh per tipo di pezzo, colorato per istanza.
 *
 * Perché a istanze: una sala vera ha 40-60 tavoli e 200-300 sedie; un mesh a
 * testa sarebbero centinaia di draw call, su un televisore o un tablet vecchio
 * il collo di bottiglia. Così sono otto, qualunque sia la sala.
 *
 * Le trappole degli InstancedMesh, tutte evitate qui:
 * - frustumCulled = false su ognuno: la boundingSphere si calcola una volta,
 *   alla prima occasione, e non segue né le matrici né `count`. Con la sfera
 *   vecchia un tavolo spostato sparirebbe ai bordi dell'inquadratura.
 * - instanceColor creato PRIMA del primo render: un materiale compilato senza
 *   ignora setColorAt, e i tavoli resterebbero bianchi.
 * - capienza dalla sala (pezzi × 1,25); se non basta, il mesh si rifà al
 *   doppio: `count` non può superare la capienza con cui è nato.
 * - si riscrive solo quando cambia quello che si vede (posizioni, stati, sedie
 *   accese) o il tema: il modello è un oggetto nuovo a ogni minuto, la firma
 *   no. Temporanei riusati, niente allocazioni nel ciclo.
 */

/** Il piano: una lastra sottile nel colore del bordo (--tg-*-stroke) e sopra,
 *  1 cm più su, la faccia nel colore del piano (--tg-*-bg). Il centimetro è
 *  voluto: due facce complanari fanno z-fighting da lontano, a 1 cm no fino
 *  a oltre 100 m di distanza con il near a 0,1 m. */
const TOP_GAP = 0.01;
const SLAB_T = 0.035;
const SLAB_TOP = TABLE_TOP_HEIGHT - TOP_GAP;
const SLAB_BOTTOM = SLAB_TOP - SLAB_T;
const LEG_W = 0.05;
const LEG_INSET = 0.07;
const PEDESTAL_BASE_H = 0.025;
/** La sedia: seduta 42 × 40 cm. Il passo delle sedie del glifo è 52 cm, così
 *  due vicine non si toccano. Davanti verso +Z locale, schienale verso −Z. */
const CHAIR_W = 0.42;
const CHAIR_D = 0.4;
const CHAIR_SEAT_T = 0.05;
const CHAIR_BACK_T = 0.04;
const CHAIR_LEG = 0.035;
const SHADOW_Y = 0.003;
const TABLE_SHADOW_PAD = 0.45;
const CHAIR_SHADOW_W = 0.62;
const CHAIR_SHADOW_D = 0.6;
const MIN_CAPACITY = 8;
const CAPACITY_SLACK = 1.25;

const EMPTY: readonly TableModel[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _v = new THREE.Vector3();
const _qTable = new THREE.Quaternion();
const _qChair = new THREE.Quaternion();

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Un tavolo che si può disegnare: centro e misure leggibili. */
function drawable(t: TableModel | null | undefined): t is TableModel {
  return !!t && finite(t.center?.x) && finite(t.center?.z) && finite(t.length) && t.length > 0 && finite(t.depth) && t.depth > 0;
}

/** Una parte dei tavoli (piani, gambe, sedie…): un InstancedMesh con la sua
 *  capienza, rifatto al doppio quando non basta. */
class InstancedPart {
  mesh: THREE.InstancedMesh;
  private capacity: number;
  private readonly group: THREE.Group;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.Material;
  private readonly colored: boolean;

  constructor(group: THREE.Group, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number, colored: boolean) {
    this.group = group;
    this.geometry = geometry;
    this.material = material;
    this.colored = colored;
    this.capacity = Math.max(MIN_CAPACITY, Math.ceil(capacity * CAPACITY_SLACK));
    this.mesh = this.create(this.capacity);
    group.add(this.mesh);
  }

  private create(capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, capacity);
    mesh.frustumCulled = false;
    if (this.colored) mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    mesh.count = 0;
    mesh.visible = false;
    return mesh;
  }

  /** Posto per `count` istanze, rifacendo il mesh al doppio se serve. */
  reserve(count: number): void {
    if (count <= this.capacity) return;
    this.group.remove(this.mesh);
    this.mesh.dispose();
    this.capacity = Math.max(Math.ceil(count * CAPACITY_SLACK), this.capacity * 2);
    this.mesh = this.create(this.capacity);
    this.group.add(this.mesh);
  }

  set(i: number, x: number, y: number, z: number, q: THREE.Quaternion, sx: number, sy: number, sz: number, color?: THREE.Color): void {
    _p.set(x, y, z);
    _s.set(sx, sy, sz);
    _m.compose(_p, q, _s);
    this.mesh.setMatrixAt(i, _m);
    if (color && this.colored) this.mesh.setColorAt(i, color);
  }

  commit(count: number): void {
    this.mesh.count = count;
    this.mesh.visible = count > 0;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.group.remove(this.mesh);
    this.mesh.dispose();
  }
}

interface TableParts {
  rectTop: InstancedPart;
  rectSlab: InstancedPart;
  legs: InstancedPart;
  circleTop: InstancedPart;
  circleSlab: InstancedPart;
  pedestal: InstancedPart;
  chair: InstancedPart;
  shadow: InstancedPart;
  dispose: () => void;
}

/** Più pezzi fusi in una geometria sola: una sedia è un'istanza, non sei. */
function merged(parts: THREE.BufferGeometry[], fallback: () => THREE.BufferGeometry): THREE.BufferGeometry {
  const out = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return out ?? fallback();
}

function buildChair(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    parts.push(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
  };
  add(CHAIR_W, CHAIR_SEAT_T, CHAIR_D, 0, SEAT_HEIGHT - CHAIR_SEAT_T / 2, 0);
  const backH = CHAIR_BACK_HEIGHT - SEAT_HEIGHT;
  add(CHAIR_W, backH, CHAIR_BACK_T, 0, SEAT_HEIGHT + backH / 2, -CHAIR_D / 2 + CHAIR_BACK_T / 2);
  const legH = SEAT_HEIGHT - CHAIR_SEAT_T;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(CHAIR_LEG, legH, CHAIR_LEG, sx * (CHAIR_W / 2 - CHAIR_LEG), legH / 2, sz * (CHAIR_D / 2 - CHAIR_LEG));
    }
  }
  return merged(parts, () => new THREE.BoxGeometry(CHAIR_W, SEAT_HEIGHT, CHAIR_D).translate(0, SEAT_HEIGHT / 2, 0));
}

/** Il piede del tavolo tondo: colonna e base, già alla misura finale. */
function buildPedestal(): THREE.BufferGeometry {
  const columnH = SLAB_BOTTOM - PEDESTAL_BASE_H;
  const column = new THREE.CylinderGeometry(0.05, 0.05, columnH, 12).translate(0, PEDESTAL_BASE_H + columnH / 2, 0);
  const base = new THREE.CylinderGeometry(0.22, 0.25, PEDESTAL_BASE_H, 24).translate(0, PEDESTAL_BASE_H / 2, 0);
  return merged([column, base], () => new THREE.CylinderGeometry(0.05, 0.05, SLAB_BOTTOM, 12).translate(0, SLAB_BOTTOM / 2, 0));
}

function countParts(tables: readonly TableModel[]): { rect: number; circle: number; chairs: number } {
  let rect = 0;
  let circle = 0;
  let chairs = 0;
  for (const t of tables) {
    if (!drawable(t)) continue;
    if (t.shape === 'circle') circle++;
    else rect++;
    chairs += Array.isArray(t.chairs) ? t.chairs.length : 0;
  }
  return { rect, circle, chairs };
}

function createTableParts(group: THREE.Group, tables: readonly TableModel[], shadowMaterial: THREE.Material): TableParts {
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const disc = new THREE.CircleGeometry(0.5, 48).rotateX(-Math.PI / 2);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 48);
  const pedestal = buildPedestal();
  const chair = buildChair();
  // Bianco: il colore è quello dell'istanza (instanceColor moltiplica il
  // colore del materiale), cioè il token dello stato.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const n = countParts(tables);
  const parts = {
    rectTop: new InstancedPart(group, plane, material, n.rect, true),
    rectSlab: new InstancedPart(group, box, material, n.rect, true),
    legs: new InstancedPart(group, box, material, n.rect * 4, true),
    circleTop: new InstancedPart(group, disc, material, n.circle, true),
    circleSlab: new InstancedPart(group, cylinder, material, n.circle, true),
    pedestal: new InstancedPart(group, pedestal, material, n.circle, true),
    chair: new InstancedPart(group, chair, material, n.chairs, true),
    shadow: new InstancedPart(group, plane, shadowMaterial, n.rect + n.circle + n.chairs, false),
  };
  return {
    ...parts,
    dispose: () => {
      for (const p of Object.values(parts)) p.dispose();
      for (const g of [plane, box, disc, cylinder, pedestal, chair]) g.dispose();
      material.dispose();
    },
  };
}

/** Riscrive tutte le istanze dai tavoli del modello. */
function writeParts(parts: TableParts, tables: readonly TableModel[], palette: ScenePalette): void {
  const n = countParts(tables);
  parts.rectTop.reserve(n.rect);
  parts.rectSlab.reserve(n.rect);
  parts.legs.reserve(n.rect * 4);
  parts.circleTop.reserve(n.circle);
  parts.circleSlab.reserve(n.circle);
  parts.pedestal.reserve(n.circle);
  parts.chair.reserve(n.chairs);
  parts.shadow.reserve(n.rect + n.circle + n.chairs);

  let rect = 0;
  let leg = 0;
  let circle = 0;
  let chair = 0;
  let shadow = 0;
  const slabY = SLAB_TOP - SLAB_T / 2;

  for (const t of tables) {
    if (!drawable(t)) continue;
    const colors = statusColors(palette, t.status);
    const cx = t.center.x;
    const cz = t.center.z;
    _qTable.setFromAxisAngle(UP, finite(t.rotY) ? t.rotY : 0);

    if (t.shape === 'circle') {
      const d = t.length;
      parts.circleTop.set(circle, cx, TABLE_TOP_HEIGHT, cz, _qTable, d, 1, d, colors.bg);
      parts.circleSlab.set(circle, cx, slabY, cz, _qTable, d, SLAB_T, d, colors.stroke);
      parts.pedestal.set(circle, cx, 0, cz, _qTable, 1, 1, 1, colors.stroke);
      circle++;
      parts.shadow.set(shadow++, cx, SHADOW_Y, cz, _qTable, d + TABLE_SHADOW_PAD, 1, d + TABLE_SHADOW_PAD);
    } else {
      const L = t.length;
      const D = t.depth;
      parts.rectTop.set(rect, cx, TABLE_TOP_HEIGHT, cz, _qTable, L, 1, D, colors.bg);
      parts.rectSlab.set(rect, cx, slabY, cz, _qTable, L, SLAB_T, D, colors.stroke);
      rect++;
      // Quattro gambe rientrate dagli spigoli, ruotate col tavolo.
      const lx = Math.max(0, L / 2 - LEG_INSET);
      const lz = Math.max(0, D / 2 - LEG_INSET);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          _v.set(sx * lx, 0, sz * lz).applyQuaternion(_qTable);
          parts.legs.set(leg++, cx + _v.x, SLAB_BOTTOM / 2, cz + _v.z, _qTable, LEG_W, SLAB_BOTTOM, LEG_W, colors.stroke);
        }
      }
      parts.shadow.set(shadow++, cx, SHADOW_Y, cz, _qTable, L + TABLE_SHADOW_PAD, 1, D + TABLE_SHADOW_PAD);
    }

    const chairs = Array.isArray(t.chairs) ? t.chairs : [];
    for (const c of chairs) {
      if (!finite(c?.x) || !finite(c?.z)) continue;
      _qChair.setFromAxisAngle(UP, finite(c.yaw) ? c.yaw : 0);
      parts.chair.set(chair++, c.x, 0, c.z, _qChair, 1, 1, 1, c.lit ? colors.chair : colors.chairDim);
      parts.shadow.set(shadow++, c.x, SHADOW_Y, c.z, _qChair, CHAIR_SHADOW_W, 1, CHAIR_SHADOW_D);
    }
  }

  parts.rectTop.commit(rect);
  parts.rectSlab.commit(rect);
  parts.legs.commit(leg);
  parts.circleTop.commit(circle);
  parts.circleSlab.commit(circle);
  parts.pedestal.commit(circle);
  parts.chair.commit(chair);
  parts.shadow.commit(shadow);
}

const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');

/** La firma di quello che si vede: cambia solo quando cambia il disegno. */
export function tablesKey(tables: readonly TableModel[]): string {
  let key = '';
  for (const t of tables) {
    if (!t) continue;
    key += `${t.id}|${t.shape}|${t.status}|${mm(t.center?.x)}|${mm(t.center?.z)}|${mm(t.rotY)}|${mm(t.length)}|${mm(t.depth)}`;
    const chairs = Array.isArray(t.chairs) ? t.chairs : [];
    for (const c of chairs) key += `;${mm(c?.x)},${mm(c?.z)},${mm(c?.yaw)},${c?.lit ? 1 : 0}`;
    key += '\n';
  }
  return key;
}

interface TablesLayerProps {
  tables: readonly TableModel[] | null | undefined;
  palette: ScenePalette;
  /** Cresce a ogni cambio di tema: i colori per istanza sono copie e vanno riscritti. */
  themeVersion: number;
  shadow: THREE.Material;
}

export function TablesLayer({ tables: tablesProp, palette, themeVersion, shadow }: TablesLayerProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const tables = Array.isArray(tablesProp) ? tablesProp : EMPTY;
  const key = useMemo(() => tablesKey(tables), [tables]);
  const tablesRef = useRef(tables);
  const partsRef = useRef<TableParts | null>(null);

  // L'ultimo elenco, per gli effetti qui sotto: dichiarato per primo, gira
  // per primo a ogni commit.
  useLayoutEffect(() => {
    tablesRef.current = tables;
  });

  // Le parti nascono e muoiono con l'effetto, non nel render: sotto
  // StrictMode (montaggio, smontaggio, rimontaggio) il secondo giro ne crea
  // di nuove invece di riusare mesh già tolti dal gruppo.
  useLayoutEffect(() => {
    const parts = createTableParts(group, tablesRef.current, shadow);
    partsRef.current = parts;
    return () => {
      parts.dispose();
      partsRef.current = null;
    };
  }, [group, shadow]);

  useLayoutEffect(() => {
    const parts = partsRef.current;
    if (!parts) return;
    writeParts(parts, tablesRef.current, palette);
    invalidate();
  }, [key, themeVersion, palette, shadow, invalidate]);

  return <primitive object={group} />;
}
