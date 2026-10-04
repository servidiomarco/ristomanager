import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { FigureSlot } from '../types';
import { composeDog, composePerson, createFigureGeometries, createPersonMatrices, figureScale } from './figures';
import { CAPACITY_SLACK, InstancedPart } from './instancedPart';
import { guestBodyColor, headColor, type ScenePalette } from './theme';

/* Le persone della sala: gli ospiti ai tavoli e all'ingresso, i cani,
 * l'hostess al leggio. Statiche in questa PR: niente useFrame, si riscrive
 * solo quando cambia quello che si vede, e da ferma la sala resta a 0 fps.
 *
 * Un InstancedMesh per tipo di parte per tutta la sala (busto, testa, coscia,
 * stinco, braccio, avambraccio, chignon, cane, più le ombre a macchia di chi
 * sta in piedi): nove draw call per cento ospiti come per due, invece di dieci
 * a persona. Un materiale bianco solo; il colore è dell'istanza, quello del
 * ruolo (theme.ts), mai uno stato.
 *
 * La capienza parte dalla sala: i posti × 1,25 (le teste e chi resta in
 * piedi), più i 6 posti dell'ingresso e l'hostess; i cani almeno 4. Se un
 * servizio ne chiede di più, il pezzo si rifà al doppio (InstancedPart).
 *
 * Il modello è un oggetto nuovo a ogni minuto: si confronta una firma di
 * quello che si vede (tipo, posa, posizione al mm, verso, seduta, tinta), e a
 * firma uguale non si tocca niente. Al cambio di tema si riscrivono solo i
 * colori, con le matrici ferme. */

/** I posti dell'ingresso disegnati (LOBBY_MAX_DRAWN del modello) e
 *  l'hostess: ci sono in ogni sala, anche vuota. */
const LOBBY_CELLS = 6;
const HOSTESSES = 1;
const MIN_DOGS = 4;
const MIN_BUNS = 2;
/** Le ombre a macchia stanno 3 mm sopra il pavimento, come quelle dei
 *  tavoli. Ce l'ha chi sta in piedi (0,5 m, a scala per i bambini) e il cane
 *  (0,45 × 0,9 lungo il corpo); chi è seduto ha già quella della sedia. */
const SHADOW_Y = 0.003;
const STAND_SHADOW = 0.5;
const DOG_SHADOW_W = 0.45;
const DOG_SHADOW_L = 0.9;

const EMPTY: readonly FigureSlot[] = [];
const UP = new THREE.Vector3(0, 1, 0);
const _matrices = createPersonMatrices();
const _dog = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _body = new THREE.Color();
const _head = new THREE.Color();

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const mm = (v: unknown): string => (finite(v) ? String(Math.round(v * 1000)) : 'x');

/** Una figura che si può disegnare: almeno un punto leggibile sul pavimento. */
function drawable(f: FigureSlot | null | undefined): f is FigureSlot {
  return !!f && finite(f.x) && finite(f.z);
}

const isDog = (f: FigureSlot): boolean => f.kind === 'dog';
/** In piedi sul pavimento: tutto quello che non è seduto, tranne il cane
 *  (che ha la sua ombra). Una persona «sdraiata» si disegna in piedi. */
const isStanding = (f: FigureSlot): boolean => !isDog(f) && f.pose !== 'seated';

interface Counts {
  people: number;
  hostesses: number;
  dogs: number;
  shadows: number;
}

function countFigures(figures: readonly FigureSlot[]): Counts {
  const n: Counts = { people: 0, hostesses: 0, dogs: 0, shadows: 0 };
  for (const f of figures) {
    if (!drawable(f)) continue;
    if (isDog(f)) {
      n.dogs++;
      n.shadows++;
      continue;
    }
    n.people++;
    if (f.kind === 'hostess') n.hostesses++;
    if (isStanding(f)) n.shadows++;
  }
  return n;
}

/** La firma di quello che si vede: cambia solo quando cambia il disegno. */
export function figuresKey(figures: readonly FigureSlot[]): string {
  let key = '';
  for (const f of figures) {
    if (!f) continue;
    key += `${f.kind}|${f.pose}|${mm(f.x)}|${mm(f.z)}|${mm(f.yaw)}|${mm(f.seatHeight)}|${mm(f.tint)}\n`;
  }
  return key;
}

interface PeopleParts {
  torso: InstancedPart;
  head: InstancedPart;
  thigh: InstancedPart;
  shin: InstancedPart;
  upperArm: InstancedPart;
  forearm: InstancedPart;
  bun: InstancedPart;
  dog: InstancedPart;
  shadow: InstancedPart;
  /** La firma delle matrici scritte; null = niente ancora (parti appena nate). */
  writtenKey: string | null;
  dispose: () => void;
}

function createPeopleParts(group: THREE.Group, seats: number, figures: readonly FigureSlot[], shadowMaterial: THREE.Material): PeopleParts {
  const geo = createFigureGeometries();
  // Bianco: il colore è quello dell'istanza (instanceColor moltiplica il
  // colore del materiale), cioè il token del ruolo.
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);

  const n = countFigures(figures);
  const s = finite(seats) && seats > 0 ? seats : 0;
  const people = Math.max(n.people, Math.ceil(s * CAPACITY_SLACK) + LOBBY_CELLS + HOSTESSES);
  const dogs = Math.max(MIN_DOGS, n.dogs);
  // In piedi: l'ingresso, l'hostess, chi non trova posto (al più il quarto
  // dei posti, come il margine), più i cani.
  const shadows = Math.max(n.shadows, LOBBY_CELLS + HOSTESSES + Math.ceil(s * (CAPACITY_SLACK - 1)) + dogs);

  const parts = {
    torso: new InstancedPart(group, geo.torso, material, people, true),
    head: new InstancedPart(group, geo.head, material, people, true),
    thigh: new InstancedPart(group, geo.thigh, material, people * 2, true),
    shin: new InstancedPart(group, geo.shin, material, people * 2, true),
    upperArm: new InstancedPart(group, geo.upperArm, material, people * 2, true),
    forearm: new InstancedPart(group, geo.forearm, material, people * 2, true),
    bun: new InstancedPart(group, geo.bun, material, Math.max(MIN_BUNS, n.hostesses), true),
    dog: new InstancedPart(group, geo.dog, material, dogs, true),
    shadow: new InstancedPart(group, plane, shadowMaterial, shadows, false),
  };
  return {
    ...parts,
    writtenKey: null,
    dispose: () => {
      for (const p of Object.values(parts)) p.dispose();
      geo.dispose();
      plane.dispose();
      material.dispose();
    },
  };
}

/** Il colore del corpo e della testa di una persona, in _body e _head.
 *  L'hostess ha il corpo d'argilla e la testa neutra degli ospiti: schiarita,
 *  l'argilla diventa un rosa carne, e le pedine non hanno colori di pelle. Il
 *  ruolo lo dicono il corpo e lo chignon. */
function personColors(f: FigureSlot, palette: ScenePalette): void {
  if (f.kind === 'hostess') {
    _body.copy(palette.hostess);
    headColor(palette, guestBodyColor(palette, 0, _head), _head);
    return;
  }
  guestBodyColor(palette, f.tint, _body);
  headColor(palette, _body, _head);
}

/** Scrive le figure nelle parti. Con `matrices` false riscrive solo i colori
 *  (il tema è cambiato, le figure no): stesso giro, stessi indici. */
function writeFigures(parts: PeopleParts, figures: readonly FigureSlot[], palette: ScenePalette, matrices: boolean): void {
  if (matrices) {
    const n = countFigures(figures);
    parts.torso.reserve(n.people);
    parts.head.reserve(n.people);
    parts.thigh.reserve(n.people * 2);
    parts.shin.reserve(n.people * 2);
    parts.upperArm.reserve(n.people * 2);
    parts.forearm.reserve(n.people * 2);
    parts.bun.reserve(n.hostesses);
    parts.dog.reserve(n.dogs);
    parts.shadow.reserve(n.shadows);
  }

  let person = 0;
  let bun = 0;
  let dog = 0;
  let shadow = 0;
  for (const f of figures) {
    if (!drawable(f)) continue;
    if (isDog(f)) {
      if (matrices) {
        composeDog(f, _dog);
        parts.dog.setMatrix(dog, _dog);
        _q.setFromAxisAngle(UP, finite(f.yaw) ? f.yaw : 0);
        parts.shadow.set(shadow++, f.x, SHADOW_Y, f.z, _q, DOG_SHADOW_W, 1, DOG_SHADOW_L);
      }
      parts.dog.setColor(dog, palette.dog);
      dog++;
      continue;
    }

    personColors(f, palette);
    const left = person * 2;
    const right = left + 1;
    const hostess = f.kind === 'hostess';
    if (matrices) {
      composePerson(f, _matrices);
      parts.torso.setMatrix(person, _matrices.torso);
      parts.head.setMatrix(person, _matrices.head);
      parts.thigh.setMatrix(left, _matrices.thigh[0]);
      parts.thigh.setMatrix(right, _matrices.thigh[1]);
      parts.shin.setMatrix(left, _matrices.shin[0]);
      parts.shin.setMatrix(right, _matrices.shin[1]);
      parts.upperArm.setMatrix(left, _matrices.upperArm[0]);
      parts.upperArm.setMatrix(right, _matrices.upperArm[1]);
      parts.forearm.setMatrix(left, _matrices.forearm[0]);
      parts.forearm.setMatrix(right, _matrices.forearm[1]);
      if (hostess) parts.bun.setMatrix(bun, _matrices.bun);
      if (isStanding(f)) {
        const size = STAND_SHADOW * figureScale(f.kind);
        _q.setFromAxisAngle(UP, finite(f.yaw) ? f.yaw : 0);
        parts.shadow.set(shadow++, f.x, SHADOW_Y, f.z, _q, size, 1, size);
      }
    }
    // Una pedina monocroma: busto e arti nel colore del corpo, la testa più
    // chiara, lo chignon come il corpo.
    parts.torso.setColor(person, _body);
    parts.head.setColor(person, _head);
    parts.thigh.setColor(left, _body);
    parts.thigh.setColor(right, _body);
    parts.shin.setColor(left, _body);
    parts.shin.setColor(right, _body);
    parts.upperArm.setColor(left, _body);
    parts.upperArm.setColor(right, _body);
    parts.forearm.setColor(left, _body);
    parts.forearm.setColor(right, _body);
    if (hostess) parts.bun.setColor(bun++, _body);
    person++;
  }

  if (matrices) {
    parts.torso.commit(person);
    parts.head.commit(person);
    parts.thigh.commit(person * 2);
    parts.shin.commit(person * 2);
    parts.upperArm.commit(person * 2);
    parts.forearm.commit(person * 2);
    parts.bun.commit(bun);
    parts.dog.commit(dog);
    parts.shadow.commit(shadow);
  } else {
    for (const p of [parts.torso, parts.head, parts.thigh, parts.shin, parts.upperArm, parts.forearm, parts.bun, parts.dog]) p.commitColors();
  }
}

interface PeopleProps {
  figures: readonly FigureSlot[] | null | undefined;
  /** I posti della sala (Σ chairs.length dei tavoli): la capienza di partenza. */
  seats: number;
  palette: ScenePalette;
  /** Cresce a ogni cambio di tema: i colori per istanza sono copie e vanno riscritti. */
  themeVersion: number;
  shadow: THREE.Material;
}

export function People({ figures: figuresProp, seats, palette, themeVersion, shadow }: PeopleProps) {
  const invalidate = useThree((s) => s.invalidate);
  const [group] = useState(() => new THREE.Group());
  const figures = Array.isArray(figuresProp) ? figuresProp : EMPTY;
  const key = useMemo(() => figuresKey(figures), [figures]);
  const figuresRef = useRef(figures);
  const seatsRef = useRef(seats);
  const partsRef = useRef<PeopleParts | null>(null);

  // L'ultimo elenco, per gli effetti qui sotto: dichiarato per primo, gira
  // per primo a ogni commit.
  useLayoutEffect(() => {
    figuresRef.current = figures;
    seatsRef.current = seats;
  });

  // Geometrie, materiale e mesh nascono e muoiono con l'effetto, non nel
  // render: sotto StrictMode (montaggio, smontaggio, rimontaggio) il secondo
  // giro ne crea di nuovi invece di riusare mesh già tolti dal gruppo.
  useLayoutEffect(() => {
    const parts = createPeopleParts(group, seatsRef.current, figuresRef.current, shadow);
    partsRef.current = parts;
    return () => {
      parts.dispose();
      partsRef.current = null;
    };
  }, [group, shadow]);

  useLayoutEffect(() => {
    const parts = partsRef.current;
    if (!parts) return;
    // Parti nuove o figure cambiate: tutto. Stessa firma (è cambiato il
    // tema): solo i colori.
    writeFigures(parts, figuresRef.current, palette, parts.writtenKey !== key);
    parts.writtenKey = key;
    invalidate();
  }, [key, themeVersion, palette, shadow, invalidate]);

  return <primitive object={group} />;
}
