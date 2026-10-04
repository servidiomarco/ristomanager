import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { TABLE_TOP_HEIGHT } from '../model/geometry';
import type { TableModel } from '../types';
import { InstancedPart } from './instancedPart';
import type { ScenePalette } from './theme';

/* I cartellini sul piano: «Riservato» su un tavolo libero prenotato fra poco,
 * «Evento» su un tavolo di banchetto (TableModel.sign, deciso dal modello, e
 * solo dove non siede nessuno).
 *
 * Un cartellino a tenda al centro del piano, girato col tavolo, nei colori
 * del glifo «in attesa»: le falde in --tg-attesa-name e la costa in
 * --tg-attesa-bg. Le falde scure perché il piano sotto è chiaro (libero,
 * attesa e in arrivo hanno tutti un fondo di quel chiaro, e con lo scuro un
 * fondo scuro, dove le falde diventano chiare): nel colore del fondo restava
 * da vedere solo la costa, una lineetta. Niente testo sul cartellino: a 30 cm
 * non si leggerebbe da nessuna parte, e un canvas per tavolo costerebbe una
 * draw call a testa. Le parole («Riservato · 20:30», «Evento») sono la
 * seconda riga dell'etichetta del tavolo, che si legge dalla porta; qui c'è
 * il segno che il tavolo è tenuto.
 *
 * A istanze come i tavoli (cartone e costa: due draw call per tutta la
 * sala), riscritte solo quando cambia l'insieme dei tavoli col cartellino
 * (id, tipo, centro, rotazione) o il tema. */

/** Il cartellino «Riservato»: 30 cm lungo il lato lungo del tavolo, alto 16,
 *  12 di base. Più grande del vero, apposta: dall'inquadratura della sala
 *  intera uno da 18 cm era largo 9 px e si leggeva come un segno meno.
 *  Quello di un banchetto è 1,3 volte più grande. */
const CARD_LENGTH = 0.3;
const CARD_HEIGHT = 0.16;
const CARD_BASE = 0.12;
const EVENT_SCALE = 1.3;
/** La costa: una listella sul colmo, un filo più lunga del cartellino. */
const RIDGE_HEIGHT = 0.03;
const RIDGE_DEPTH = 0.04;
const RIDGE_OVERHANG = 0.008;
/** Un millimetro sopra il piano: il fondo del cartellino non tocca la sua faccia. */
const CARD_LIFT = 0.001;
const MIN_CAPACITY = 4;

const EMPTY: readonly TableModel[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion();

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');

/** Un tavolo col cartellino e un centro leggibile. */
function signed(t: TableModel | null | undefined): t is TableModel {
  return !!t && (t.sign === 'reserved' || t.sign === 'event') && finite(t.center?.x) && finite(t.center?.z);
}

/** Il cartellino a tenda: un prisma triangolare col colmo lungo X locale e la
 *  base sul piano (y = 0), facce piatte. Il fondo non c'è: dall'alto non si
 *  vede mai. */
function buildCard(): THREE.BufferGeometry {
  const L = CARD_LENGTH / 2;
  const D = CARD_BASE / 2;
  const H = CARD_HEIGHT;
  // Davanti in basso (B), dietro in basso (A), colmo (C); a sinistra (−L) e a destra (+L).
  const A0 = [-L, 0, -D];
  const B0 = [-L, 0, D];
  const C0 = [-L, H, 0];
  const A1 = [L, 0, -D];
  const B1 = [L, 0, D];
  const C1 = [L, H, 0];
  // Triangoli in senso antiorario visti da fuori.
  const triangles = [
    [B0, B1, C1], [B0, C1, C0], // la falda davanti (+Z)
    [A1, A0, C0], [A1, C0, C1], // la falda dietro (−Z)
    [A0, B0, C0], // il fianco a sinistra
    [B1, A1, C1], // il fianco a destra
  ];
  const positions = new Float32Array(triangles.length * 9);
  let i = 0;
  for (const tri of triangles) for (const v of tri) for (const c of v) positions[i++] = c;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  // Senza indice ogni triangolo ha le sue normali: facce piatte.
  g.computeVertexNormals();
  return g;
}

function buildRidge(): THREE.BufferGeometry {
  // Centrata un filo sotto il colmo: lo abbraccia, senza facce complanari con le falde.
  return new THREE.BoxGeometry(CARD_LENGTH + RIDGE_OVERHANG, RIDGE_HEIGHT, RIDGE_DEPTH).translate(0, CARD_HEIGHT - RIDGE_HEIGHT / 4, 0);
}

function signsKey(tables: readonly TableModel[]): string {
  let key = '';
  for (const t of tables) {
    if (!signed(t)) continue;
    key += `${t.id}|${t.sign}|${mm(t.center.x)}|${mm(t.center.z)}|${mm(t.rotY)}\n`;
  }
  return key;
}

interface SignParts {
  card: InstancedPart;
  ridge: InstancedPart;
  /** La firma delle matrici scritte; null = niente ancora. */
  writtenKey: string | null;
  dispose: () => void;
}

function createSignParts(group: THREE.Group, tables: readonly TableModel[]): SignParts {
  const cardGeometry = buildCard();
  const ridgeGeometry = buildRidge();
  // Bianco: il colore è quello dell'istanza, il token del cartellino.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // Ogni tavolo della sala potrebbe averne uno.
  const capacity = Math.max(MIN_CAPACITY, tables.length);
  const card = new InstancedPart(group, cardGeometry, material, capacity, true);
  const ridge = new InstancedPart(group, ridgeGeometry, material, capacity, true);
  return {
    card,
    ridge,
    writtenKey: null,
    dispose: () => {
      card.dispose();
      ridge.dispose();
      cardGeometry.dispose();
      ridgeGeometry.dispose();
      material.dispose();
    },
  };
}

function writeSigns(parts: SignParts, tables: readonly TableModel[], palette: ScenePalette, matrices: boolean): void {
  if (matrices) {
    let n = 0;
    for (const t of tables) if (signed(t)) n++;
    parts.card.reserve(n);
    parts.ridge.reserve(n);
  }
  let i = 0;
  for (const t of tables) {
    if (!signed(t)) continue;
    if (matrices) {
      const s = t.sign === 'event' ? EVENT_SCALE : 1;
      _q.setFromAxisAngle(UP, finite(t.rotY) ? t.rotY : 0);
      const y = TABLE_TOP_HEIGHT + CARD_LIFT;
      parts.card.set(i, t.center.x, y, t.center.z, _q, s, s, s, palette.signCard);
      parts.ridge.set(i, t.center.x, y, t.center.z, _q, s, s, s, palette.signRidge);
    } else {
      parts.card.setColor(i, palette.signCard);
      parts.ridge.setColor(i, palette.signRidge);
    }
    i++;
  }
  if (matrices) {
    parts.card.commit(i);
    parts.ridge.commit(i);
  } else {
    parts.card.commitColors();
    parts.ridge.commitColors();
  }
}

interface SignsProps {
  tables: readonly TableModel[] | null | undefined;
  palette: ScenePalette;
  /** Cresce a ogni cambio di tema: i colori per istanza sono copie e vanno riscritti. */
  themeVersion: number;
}

export function Signs({ tables: tablesProp, palette, themeVersion }: SignsProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const tables = Array.isArray(tablesProp) ? tablesProp : EMPTY;
  const key = useMemo(() => signsKey(tables), [tables]);
  const tablesRef = useRef(tables);
  const partsRef = useRef<SignParts | null>(null);

  useLayoutEffect(() => {
    tablesRef.current = tables;
  });

  // Nascono e muoiono con l'effetto (StrictMode), come i pezzi dei tavoli.
  useLayoutEffect(() => {
    const parts = createSignParts(group, tablesRef.current);
    partsRef.current = parts;
    return () => {
      parts.dispose();
      partsRef.current = null;
    };
  }, [group]);

  useLayoutEffect(() => {
    const parts = partsRef.current;
    if (!parts) return;
    writeSigns(parts, tablesRef.current, palette, parts.writtenKey !== key);
    parts.writtenKey = key;
    invalidate();
  }, [key, themeVersion, palette, invalidate]);

  return <primitive object={group} />;
}
