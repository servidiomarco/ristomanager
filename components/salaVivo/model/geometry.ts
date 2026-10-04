import { TableShape, type Table } from '../../../types';
import { GLYPH, getChairSlots, getGlyphDimensions } from '../../../utils/tableGeometry';
import type { ChairModel, MarkerModel, TableShape3D, Vec2 } from '../types';

/* Dalla piantina al mondo 3D: px della tela della sala → metri.
 *
 * La regola è una sola, e tutto il resto ne discende: X = x·M, Z = y·M, con
 * M = 2 cm per px. La 2D ha la y verso il basso, la 3D la Z verso la camera:
 * guardata dal bordo basso della mappa, la sala ha la stessa destra e la
 * stessa sinistra. Le sedie stanno ESATTAMENTE nei punti del glifo 2D
 * (getChairSlots), scalati: chi guarda la piantina e poi la sala riconosce
 * il tavolo sedia per sedia, e PR2c ci fa sedere gli ospiti per indice.
 *
 * Solo il corpo del tavolo è diverso dal glifo: il piano del glifo è un
 * disegno (1,32 m di profondità per qualunque rettangolo), in 3D serve un
 * tavolo credibile. Lo si prende dalle misure in cm quando ci sono, se no
 * dai posti, e lo si tiene dentro il box del glifo lasciando la fascia delle
 * sedie: un corpo che sconfina finirebbe sotto le sedie dei vicini.
 *
 * Questo file lo importa anche la scena per le altezze: niente React, niente
 * three, niente rete. */

/** Metri per px della tela della sala. */
export const M_PER_PX = 0.02;
/** L'altezza del piano del tavolo. */
export const TABLE_TOP_HEIGHT = 0.75;
/** L'altezza della seduta. */
export const SEAT_HEIGHT = 0.45;
/** L'altezza della seduta di un seggiolone: il bambino (a scala 0,62) ha i
 *  polsi a 0,80 m come gli adulti accanto, e le cosce passano sotto il piano
 *  (il fondo della lastra è a 0,705). Alla pari del piano (0,75) sedeva sul
 *  tavolo, con le ginocchia sul bordo. */
export const HIGH_CHAIR_SEAT_HEIGHT = 0.58;
/** L'altezza della cima dello schienale. */
export const CHAIR_BACK_HEIGHT = 0.9;
/** Il centro di una sedia sta almeno a questa distanza dal bordo del piano:
 *  più vicino, la seduta entrerebbe sotto il tavolo. */
export const CHAIR_EDGE_MIN = 0.3;

// Un corpo non scende mai sotto i 40 cm: una misura sbagliata (1 cm, un
// negativo) non deve dare un tavolo invisibile o rovesciato.
const BODY_MIN = 0.4;
// La fascia che il corpo lascia alle sedie dentro il box del glifo, per lato.
const CHAIR_BAND = 0.4;
// Le misure di un tavolo vero, quando non ci sono quelle in cm: 80 cm di
// profondità, 52 cm per coperto lungo il lato, 30 cm oltre l'ultima sedia.
const RECT_DEPTH = 0.8;
const RECT_DEPTH_MAX = 1.2;
const RECT_LENGTH_MIN = 0.7;
const SEAT_PITCH = 0.52;
const RECT_END = 0.6;
const SQUARE_MIN = 0.8;
const SQUARE_MAX = 1.1;
// Mezza sedia lungo il lato, in metri: quanto la sedia in fondo sporge oltre
// il suo centro.
const CHAIR_HALF_WIDTH = (GLYPH.CHAIR_W / 2) * M_PER_PX;
const CIRCLE_MIN = 0.8;
const CIRCLE_PER_SEAT = 0.16;
const CIRCLE_BASE = 0.3;
// Il rumore dei float (0,85 contro 0,8500000000000001) non deve spostare una
// sedia che è già al suo posto.
const EPS = 1e-9;

/** Un numero letto con prudenza: i campi arrivano da un server che può essere
 *  più vecchio o più nuovo di questo client, e un NaN qui diventa un tavolo
 *  in un punto impossibile. Accetta anche la stringa di un numero. */
export function finiteOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** I posti come intero non negativo: è il numero di sedie da disegnare. */
export function seatCount(v: unknown): number {
  const n = finiteOr(v, 0);
  return n > 0 ? Math.floor(n) : 0;
}

/** La forma del piano. Confronto esatto, come il glifo: il quadrato è un
 *  rettangolo, e un 'circle' minuscolo del seed esce rettangolare. */
export function shape3D(shape: unknown): TableShape3D {
  return shape === TableShape.CIRCLE ? 'circle' : 'rect';
}

/** Un punto della tela della sala (px) sul pavimento (m). */
export function pxToWorld(xPx: number, yPx: number): Vec2 {
  return { x: xPx * M_PER_PX, z: yPx * M_PER_PX };
}

/** Ruota un vettore locale del tavolo come lo ruota il CSS della piantina:
 *  rotate(θ) è orario su uno schermo con la y in basso, e con Z = y·M la
 *  stessa matrice vale sul pavimento. È anche quello che fa rotation.y = −θ
 *  sul gruppo del tavolo in three.js: rotateLocal(1, 0, 90) = (0, 1). */
export function rotateLocal(lx: number, lz: number, rotationDeg: number): Vec2 {
  const t = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(t);
  const s = Math.sin(t);
  return { x: lx * c - lz * s, z: lx * s + lz * c };
}

export interface TableBody {
  shape: TableShape3D;
  /** Il lato lungo (tondo: il diametro), in metri. */
  length: number;
  /** La profondità (tondo: il diametro), in metri. */
  depth: number;
}

// Una misura in cm valida (> 0) in metri, altrimenti null.
const cmToM = (v: unknown): number | null => {
  const n = finiteOr(v, NaN);
  return n > 0 ? n / 100 : null;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Il corpo del tavolo in 3D.
 *
 * Con le misure di Sale & Tavoli («Larghezza × Lunghezza» in cm): la
 * larghezza è la profondità, la lunghezza il lato lungo. Se ci sono tutte e
 * due vince la maggiore come lato lungo, perché il glifo mette sempre il lato
 * lungo in orizzontale e chi le scrive guardando la piantina può chiamare
 * «larghezza» proprio quello. Un quadrato con una misura sola la usa per i
 * due lati. Senza misure: dai posti, con le proporzioni di un tavolo vero; un
 * quadrato resta quadrato finché le sedie di un lato ci stanno.
 *
 * Poi dentro il box del glifo meno la fascia delle sedie: un corpo più grande
 * del disegno finirebbe sotto le sedie, sue o del vicino. */
export function tableBody(table: Pick<Table, 'shape' | 'width_cm' | 'length_cm'>, seats: number): TableBody {
  const n = seatCount(seats);
  const shape = shape3D(table.shape);
  const boxM = getGlyphDimensions(table.shape, n).width * M_PER_PX;
  const widthM = cmToM(table.width_cm);
  const lengthM = cmToM(table.length_cm);

  if (shape === 'circle') {
    const d = lengthM ?? widthM ?? Math.max(CIRCLE_MIN, CIRCLE_PER_SEAT * n + CIRCLE_BASE);
    const dc = Math.max(BODY_MIN, Math.min(d, boxM - 2 * CHAIR_BAND));
    return { shape, length: dc, depth: dc };
  }

  // Le sedie stanno sui due lati lunghi, il lato sopra prende quella in più:
  // ⌈n/2⌉ sedie a 52 cm l'una, e 30 cm oltre le ultime.
  const perSide = Math.ceil(n / 2);
  const fromSeats = Math.max(RECT_LENGTH_MIN, (perSide - 1) * SEAT_PITCH + RECT_END);
  let length: number;
  let depth: number;
  if (widthM !== null && lengthM !== null) {
    length = Math.max(widthM, lengthM);
    depth = Math.min(widthM, lengthM);
  } else if (table.shape === TableShape.SQUARE) {
    const side = widthM ?? lengthM ?? clamp(fromSeats, SQUARE_MIN, SQUARE_MAX);
    depth = side;
    // Il glifo mette le sedie del quadrato solo sopra e sotto, come al
    // rettangolo: da 3 per lato (5 posti) su 1,10 m quelle in fondo
    // sporgerebbero oltre i capi. Lì, senza misure scritte, il lato lungo
    // cresce coi posti come quello di un rettangolo. Una misura scritta vale
    // com'è: è il tavolo vero.
    const chairsReach = ((perSide - 1) * SEAT_PITCH) / 2 + CHAIR_HALF_WIDTH;
    length = widthM === null && lengthM === null && chairsReach > side / 2 ? fromSeats : side;
  } else {
    length = lengthM ?? fromSeats;
    depth = widthM ?? RECT_DEPTH;
  }
  return {
    shape,
    length: Math.max(BODY_MIN, Math.min(length, boxM - 0.1)),
    depth: Math.max(BODY_MIN, Math.min(depth, RECT_DEPTH_MAX)),
  };
}

export interface PlacedTable {
  shape: TableShape3D;
  /** Il centro del glifo, in metri: anche il centro di rotazione. */
  center: Vec2;
  /** rotation.y del gruppo del tavolo. */
  rotY: number;
  length: number;
  depth: number;
  /** Nel mondo, nell'ordine di getChairSlots. */
  chairs: ChairModel[];
}

/** Un tavolo posato nel mondo: centro, rotazione, corpo e sedie.
 *
 * `seats` è il numero di posti con cui si disegna (per un'unione alla
 * maniera della 2D, la somma); `lit` gli indici delle sedie piene, che decide
 * lo stato del tavolo (litByTable). Le sedie partono dai centri del glifo,
 * centrati sul box e scalati; un corpo più profondo del disegno (misure in
 * cm) le spinge fuori lungo la normale finché il centro non è a
 * CHAIR_EDGE_MIN dal bordo. Il verso resta quello del glifo: verso il tavolo. */
export function placeTable(table: Table, seats: number, lit: readonly number[]): PlacedTable {
  const n = seatCount(seats);
  const { width: w, height: h } = getGlyphDimensions(table.shape, n);
  const x = finiteOr(table.x, 0);
  const y = finiteOr(table.y, 0);
  const rotation = finiteOr(table.rotation, 0);
  const center = pxToWorld(x + w / 2, y + h / 2);
  const body = tableBody(table, n);
  const litSet = new Set(lit);

  const chairs = getChairSlots(table.shape, n).map((s): ChairModel => {
    let lx = (s.cx - w / 2) * M_PER_PX;
    let lz = (s.cy - h / 2) * M_PER_PX;
    if (body.shape === 'circle') {
      const need = body.length / 2 + CHAIR_EDGE_MIN;
      const r = Math.hypot(lx, lz);
      if (r < need - EPS) {
        if (r > EPS) {
          lx *= need / r;
          lz *= need / r;
        } else {
          lx = -s.nx * need;
          lz = -s.ny * need;
        }
      }
    } else {
      // Sedie sui lati lunghi: la normale è (0, ±1), la distanza dal centro
      // verso fuori si legge lungo −n.
      const need = body.depth / 2 + CHAIR_EDGE_MIN;
      const out = -(lx * s.nx + lz * s.ny);
      if (out < need - EPS) {
        lx -= s.nx * (need - out);
        lz -= s.ny * (need - out);
      }
    }
    const offset = rotateLocal(lx, lz, rotation);
    const facing = rotateLocal(s.nx, s.ny, rotation);
    return {
      x: center.x + offset.x,
      z: center.z + offset.z,
      // Una sedia modellata col davanti verso +Z locale: rotation.y = ψ porta
      // +Z su (sin ψ, cos ψ), e lo vogliamo sul verso del tavolo.
      yaw: Math.atan2(facing.x, facing.z),
      lit: litSet.has(s.index),
      // Il seggiolone lo decide la comitiva seduta (placement.ts), non il
      // tavolo: una sedia della piantina nasce sempre normale.
      high: false,
    };
  });

  return {
    shape: body.shape,
    center,
    // Mai −0: rotation.y lo prenderebbe uguale, ma un confronto esatto no.
    rotY: rotation ? -(rotation * Math.PI) / 180 : 0,
    length: body.length,
    depth: body.depth,
    chairs,
  };
}

/* ── La porta nel muro ─────────────────────────────────────────────────────
 * Stava in scene/RoomShell.tsx, che la disegna; da PR3 sta qui, uguale,
 * perché la porta che la scena disegna e il varco da cui gli ospiti entrano
 * ed escono camminando (model/navGrid.ts) devono essere un calcolo solo: due
 * copie prima o poi si separano, e la gente uscirebbe attraverso lo zoccolo.
 * RoomShell la importa da qui e la riesporta, così Fixtures non cambia. */

/** Lo spessore dello zoccolo, 5 cm, tutto dentro il pavimento: la porta sul
 *  muro sta sulla sua mezzeria. */
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
