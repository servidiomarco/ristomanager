import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHAIR_BACK_HEIGHT, HIGH_CHAIR_SEAT_HEIGHT, SEAT_HEIGHT, TABLE_TOP_HEIGHT } from '../model/geometry';
import type { ChairModel, TableModel } from '../types';
import { InstancedPart, slackCapacity } from './instancedPart';
import { statusColors, type StatusColors, type ScenePalette } from './theme';

/* Tavoli e sedie: un InstancedMesh per tipo di pezzo, colorato per istanza.
 *
 * Perché a istanze: una sala vera ha 40-60 tavoli e 200-300 sedie; un mesh a
 * testa sarebbero centinaia di draw call, su un televisore o un tablet vecchio
 * il collo di bottiglia. Così sono nove (il seggiolone compreso), qualunque
 * sia la sala.
 *
 * Le trappole degli InstancedMesh (frustumCulled, instanceColor prima del
 * primo render, capienza rifatta al doppio) le evita InstancedPart, lo stesso
 * delle persone e dei cartellini. Qui: capienza dalla sala (pezzi × 1,25), e
 * si riscrive solo quando cambia quello che si vede (posizioni, stati, sedie
 * accese, sedie in più, seggioloni) o il tema: il modello è un oggetto nuovo
 * a ogni minuto, la firma no. Temporanei riusati, niente allocazioni nel ciclo.
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
/** Il seggiolone: seduta 32 × 30 cm col piano a HIGH_CHAIR_SEAT_HEIGHT
 *  (0,58: le cosce del bambino passano sotto il piano del tavolo), schienale
 *  fino a 0,90 m, all'altezza delle sue spalle, quattro gambe aperte verso il
 *  basso per la stabilità e un poggiapiedi davanti, dove arrivano i piedi
 *  (0,31 m da terra, 26 cm davanti al centro). Davanti verso +Z locale come
 *  la sedia: lo yaw della sedia vale anche qui. */
const HIGH_SEAT_W = 0.32;
const HIGH_SEAT_D = 0.3;
const HIGH_SEAT_T = 0.04;
const HIGH_BACK_TOP = 0.9;
const HIGH_BACK_T = 0.035;
const HIGH_LEG = 0.03;
const HIGH_FOOTREST_Y = 0.295;
const HIGH_FOOTREST_Z = 0.22;

const EMPTY: readonly TableModel[] = [];
const NO_CHAIRS: readonly ChairModel[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _qTable = new THREE.Quaternion();
const _qChair = new THREE.Quaternion();

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Un tavolo che si può disegnare: centro e misure leggibili. */
function drawable(t: TableModel | null | undefined): t is TableModel {
  return !!t && finite(t.center?.x) && finite(t.center?.z) && finite(t.length) && t.length > 0 && finite(t.depth) && t.depth > 0;
}

/** Le sedie della piantina e quelle in più (teste, seggiolone): lette con
 *  prudenza, un campo assente è una lista vuota. */
const chairsOf = (t: TableModel): readonly ChairModel[] => (Array.isArray(t.chairs) ? t.chairs : NO_CHAIRS);
const extraChairsOf = (t: TableModel): readonly ChairModel[] => (Array.isArray(t.extraChairs) ? t.extraChairs : NO_CHAIRS);
const placeable = (c: ChairModel | null | undefined): c is ChairModel => !!c && finite(c.x) && finite(c.z);

interface TableParts {
  rectTop: InstancedPart;
  rectSlab: InstancedPart;
  legs: InstancedPart;
  circleTop: InstancedPart;
  circleSlab: InstancedPart;
  pedestal: InstancedPart;
  chair: InstancedPart;
  highChair: InstancedPart;
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

/** Un listello a sezione quadrata da un punto all'altro (le gambe aperte). */
function beam(from: THREE.Vector3, to: THREE.Vector3, w: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(to, from);
  const length = dir.length();
  const q = new THREE.Quaternion().setFromUnitVectors(UP, length > 0 ? dir.divideScalar(length) : UP);
  const m = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  return new THREE.BoxGeometry(w, length, w).applyMatrix4(m);
}

function buildHighChair(): THREE.BufferGeometry {
  const top = HIGH_CHAIR_SEAT_HEIGHT;
  const parts: THREE.BufferGeometry[] = [];
  parts.push(new THREE.BoxGeometry(HIGH_SEAT_W, HIGH_SEAT_T, HIGH_SEAT_D).translate(0, top - HIGH_SEAT_T / 2, 0));
  const backH = HIGH_BACK_TOP - top;
  parts.push(new THREE.BoxGeometry(HIGH_SEAT_W, backH, HIGH_BACK_T).translate(0, top + backH / 2, -HIGH_SEAT_D / 2 + HIGH_BACK_T / 2));
  // Le gambe partono sotto gli angoli della seduta e si aprono di 6 cm per
  // lato fino al pavimento: un seggiolone dritto sembrerebbe uno sgabello.
  const legTop = top - HIGH_SEAT_T;
  const tx = HIGH_SEAT_W / 2 - HIGH_LEG;
  const tz = HIGH_SEAT_D / 2 - HIGH_LEG;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      parts.push(beam(new THREE.Vector3(sx * tx, legTop, sz * tz), new THREE.Vector3(sx * (tx + 0.06), 0, sz * (tz + 0.06)), HIGH_LEG));
    }
  }
  // Il poggiapiedi, davanti fra le gambe e un po' oltre: i piedi del bambino
  // seduto arrivano a 26 cm dal centro, e ci appoggiano sopra.
  parts.push(new THREE.BoxGeometry(HIGH_SEAT_W, 0.025, 0.12).translate(0, HIGH_FOOTREST_Y, HIGH_FOOTREST_Z));
  return merged(parts, () => new THREE.BoxGeometry(HIGH_SEAT_W, top, HIGH_SEAT_D).translate(0, top / 2, 0));
}

/** Il piede del tavolo tondo: colonna e base, già alla misura finale. */
function buildPedestal(): THREE.BufferGeometry {
  const columnH = SLAB_BOTTOM - PEDESTAL_BASE_H;
  const column = new THREE.CylinderGeometry(0.05, 0.05, columnH, 12).translate(0, PEDESTAL_BASE_H + columnH / 2, 0);
  const base = new THREE.CylinderGeometry(0.22, 0.25, PEDESTAL_BASE_H, 24).translate(0, PEDESTAL_BASE_H / 2, 0);
  return merged([column, base], () => new THREE.CylinderGeometry(0.05, 0.05, SLAB_BOTTOM, 12).translate(0, SLAB_BOTTOM / 2, 0));
}

interface PartCounts {
  rect: number;
  circle: number;
  /** Sedie normali, della piantina e in più. */
  chairs: number;
  /** Seggioloni, della piantina (un tondo) o in più (la testa di un rettangolo). */
  highChairs: number;
}

function countChairs(list: readonly ChairModel[], n: PartCounts): void {
  for (const c of list) {
    if (!placeable(c)) continue;
    if (c.high === true) n.highChairs++;
    else n.chairs++;
  }
}

function countParts(tables: readonly TableModel[]): PartCounts {
  const n: PartCounts = { rect: 0, circle: 0, chairs: 0, highChairs: 0 };
  for (const t of tables) {
    if (!drawable(t)) continue;
    if (t.shape === 'circle') n.circle++;
    else n.rect++;
    countChairs(chairsOf(t), n);
    countChairs(extraChairsOf(t), n);
  }
  return n;
}

function createTableParts(group: THREE.Group, tables: readonly TableModel[], shadowMaterial: THREE.Material): TableParts {
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const box = new THREE.BoxGeometry(1, 1, 1);
  const disc = new THREE.CircleGeometry(0.5, 48).rotateX(-Math.PI / 2);
  const cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 48);
  const pedestal = buildPedestal();
  const chair = buildChair();
  const highChair = buildHighChair();
  // Bianco: il colore è quello dell'istanza (instanceColor moltiplica il
  // colore del materiale), cioè il token dello stato.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });

  const n = countParts(tables);
  const parts = {
    rectTop: new InstancedPart(group, plane, material, slackCapacity(n.rect), true),
    rectSlab: new InstancedPart(group, box, material, slackCapacity(n.rect), true),
    legs: new InstancedPart(group, box, material, slackCapacity(n.rect * 4), true),
    circleTop: new InstancedPart(group, disc, material, slackCapacity(n.circle), true),
    circleSlab: new InstancedPart(group, cylinder, material, slackCapacity(n.circle), true),
    pedestal: new InstancedPart(group, pedestal, material, slackCapacity(n.circle), true),
    chair: new InstancedPart(group, chair, material, slackCapacity(n.chairs), true),
    // Di solito nessuno, al più qualcuno per servizio.
    highChair: new InstancedPart(group, highChair, material, slackCapacity(n.highChairs), true),
    shadow: new InstancedPart(group, plane, shadowMaterial, slackCapacity(n.rect + n.circle + n.chairs + n.highChairs), false),
  };
  return {
    ...parts,
    dispose: () => {
      for (const p of Object.values(parts)) p.dispose();
      for (const g of [plane, box, disc, cylinder, pedestal, chair, highChair]) g.dispose();
      material.dispose();
    },
  };
}

/** Dove scrivere la prossima sedia, seggiolone e ombra: un oggetto solo,
 *  azzerato a ogni giro, così il ciclo sulle sedie non crea chiusure. */
const _cursor = { chair: 0, highChair: 0, shadow: 0 };

/** Sedie e seggioloni di una lista: piene se occupate (o, a un tavolo dove
 *  non siede nessuno, se la piantina le accende), spente altrimenti. */
function writeChairs(parts: TableParts, list: readonly ChairModel[], colors: StatusColors): void {
  for (const c of list) {
    if (!placeable(c)) continue;
    _qChair.setFromAxisAngle(UP, finite(c.yaw) ? c.yaw : 0);
    const color = c.lit ? colors.chair : colors.chairDim;
    if (c.high === true) parts.highChair.set(_cursor.highChair++, c.x, 0, c.z, _qChair, 1, 1, 1, color);
    else parts.chair.set(_cursor.chair++, c.x, 0, c.z, _qChair, 1, 1, 1, color);
    parts.shadow.set(_cursor.shadow++, c.x, SHADOW_Y, c.z, _qChair, CHAIR_SHADOW_W, 1, CHAIR_SHADOW_D);
  }
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
  parts.highChair.reserve(n.highChairs);
  parts.shadow.reserve(n.rect + n.circle + n.chairs + n.highChairs);

  let rect = 0;
  let leg = 0;
  let circle = 0;
  _cursor.chair = 0;
  _cursor.highChair = 0;
  _cursor.shadow = 0;
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
      parts.shadow.set(_cursor.shadow++, cx, SHADOW_Y, cz, _qTable, d + TABLE_SHADOW_PAD, 1, d + TABLE_SHADOW_PAD);
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
      parts.shadow.set(_cursor.shadow++, cx, SHADOW_Y, cz, _qTable, L + TABLE_SHADOW_PAD, 1, D + TABLE_SHADOW_PAD);
    }

    // Le sedie della piantina, poi quelle in più: alle teste di un
    // rettangolo per chi non entra nei posti, e il seggiolone. Quelle in
    // più sono sempre occupate, quindi del colore pieno dello stato.
    writeChairs(parts, chairsOf(t), colors);
    writeChairs(parts, extraChairsOf(t), colors);
  }

  parts.rectTop.commit(rect);
  parts.rectSlab.commit(rect);
  parts.legs.commit(leg);
  parts.circleTop.commit(circle);
  parts.circleSlab.commit(circle);
  parts.pedestal.commit(circle);
  parts.chair.commit(_cursor.chair);
  parts.highChair.commit(_cursor.highChair);
  parts.shadow.commit(_cursor.shadow);
}

const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');

/** La firma di quello che si vede: cambia solo quando cambia il disegno. */
export function tablesKey(tables: readonly TableModel[]): string {
  let key = '';
  for (const t of tables) {
    if (!t) continue;
    key += `${t.id}|${t.shape}|${t.status}|${mm(t.center?.x)}|${mm(t.center?.z)}|${mm(t.rotY)}|${mm(t.length)}|${mm(t.depth)}`;
    for (const c of chairsOf(t)) key += `;${mm(c?.x)},${mm(c?.z)},${mm(c?.yaw)},${c?.lit ? 1 : 0}${c?.high === true ? 'h' : ''}`;
    key += '+';
    for (const c of extraChairsOf(t)) key += `;${mm(c?.x)},${mm(c?.z)},${mm(c?.yaw)},${c?.lit ? 1 : 0}${c?.high === true ? 'h' : ''}`;
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
