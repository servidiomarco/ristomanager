import type { FigureSlot, MarkerModel, RoomModel, TableModel, Vec2 } from '../types';
import { DOOR_GAP, doorOnWall, finiteOr } from './geometry';
import { FLOOR_MARGIN, hostSpot } from './placement';

/* Dove si cammina in una sala, e per dove.
 *
 * Il pavimento diventa una griglia di celle da 20 cm. Una cella è bloccata
 * quando il suo centro sta dove il centro di una persona (un disco di 22 cm)
 * non può stare: lungo i muri (tranne il varco della porta), dentro un
 * tavolo, una sedia, il banco del pass o il leggio, addosso a chi aspetta in
 * piedi (all'ingresso, accanto al tavolo) o a un cane. Chi cammina va da cella
 * libera a cella libera con A* (8 vicini, niente tagli d'angolo fra due
 * ostacoli in diagonale), poi «tende il filo»: da ogni punto si va dritti fino
 * all'ultima cella del percorso che si vede senza attraversare celle
 * bloccate. Così un ospite gira attorno ai tavoli come farebbe una persona, e
 * dove la sala è libera va dritto, senza la scaletta della griglia.
 *
 * Quando: la griglia si fa quando cambia la geometria della sala (navKey), mai
 * a ogni frame; un percorso si cerca quando qualcuno parte. A* lavora su
 * buffer tipizzati legati alla griglia, allocati alla prima ricerca e poi
 * riusati (con un numero di generazione invece di ripulirli): qualche
 * millisecondo a percorso, e niente spazzatura. Puro e deterministico: a pari
 * merito vince sempre lo stesso, quindi stessa sala, stessi percorsi su ogni
 * schermo. */

/** Il lato di una cella, in metri. */
export const CELL = 0.2;
/** Il raggio di chi cammina: tavoli, sedie e banco del pass si gonfiano di
 *  tanto, così il CENTRO di una persona in una cella libera lascia il corpo
 *  fuori dai mobili. */
export const AGENT_R = 0.22;
/** Una sedia, come disco. */
export const CHAIR_R = 0.25;
/** Chi sta fermo in piedi (all'ingresso, o accanto al tavolo: in più, «In
 *  uscita») e un cane, sdraiato o in piedi, come dischi: gonfiati come i
 *  mobili, così chi cammina gira attorno a chi aspetta all'ingresso invece di
 *  attraversarlo, e il cameriere non serve in piedi sul cane. Chi siede no:
 *  la sua sedia blocca già. */
export const PERSON_R = 0.2;
export const DOG_R = 0.2;
/** Il leggio dell'accoglienza (0,5 × 0,4 m, scene/Fixtures.tsx), come disco
 *  gonfiato di AGENT_R come gli altri mobili. Non gonfiato, chi gli passava
 *  accanto (l'hostess stessa, partendo e tornando) ci entrava per una decina
 *  di centimetri. Il posto dell'hostess sta a 0,5 m dal centro
 *  (placement.hostSpot), dentro il disco gonfiato: le celle entro HOST_POCKET
 *  da lei restano libere, così parte e arriva lì. */
export const LECTERN_R = 0.3;
export const HOST_POCKET = 0.15;
/** Il banco del pass (scene/Fixtures.tsx: 1,6 × 0,5 m), il lato lungo di
 *  traverso rispetto a `inward`. */
export const PASS_LEN = 1.6;
export const PASS_DEPTH = 0.5;
/** Le celle che A* espande prima di arrendersi: oltre, il percorso è la retta
 *  (ci si compenetra con un mobile per un attimo, meglio che bloccare il
 *  frame cercando una strada che non c'è). */
export const NODE_CAP = 40_000;
/** Dalla porta verso la sala: dove chi entra mette piede sulla griglia. */
export const DOOR_INSIDE = 0.9;
/** Dalla porta verso fuori: dove chi entra compare e chi esce svanisce, fuori
 *  dalla griglia (anche oltre il pavimento). */
export const DOOR_OUTSIDE = 0.8;
/** Dove l'hostess accoglie: accanto a `inside`, dalla parte del leggio (i
 *  posti dell'ingresso stanno dall'altra). */
export const GREET_SIDE = 0.6;
/** Dal segnaposto del pass verso la sala: dove stanno i camerieri. */
export const PASS_FRONT = 0.65;
/** Fra due camerieri fermi al pass, in file da 3. */
export const PASS_SLOT_PITCH = 0.6;

// Il lato più lungo della griglia, in celle (120 m): un pavimento sbagliato
// non deve allocare milioni di celle. Oltre, si cammina in retta.
const MAX_SIDE = 600;
const EPS = 1e-9;
const SQRT2 = Math.SQRT2;
const MARKERS = ['ENTRANCE', 'PASS', 'HOST_STAND'] as const;

/** La griglia di una sala. */
export interface NavGrid {
  roomId: number;
  /** navKey(room) da cui è nata: se cambia, la griglia si rifà. */
  key: string;
  /** La cella (i, j) ha il centro in ((i + 0.5)·CELL, (j + 0.5)·CELL) e
   *  l'indice j·cols + i. */
  cols: number;
  rows: number;
  /** cols·rows, 1 = bloccata. */
  blocked: Uint8Array;
}

// Al mm posizioni e misure, al decimillesimo angoli e versori: il rumore dei
// float di un ricalcolo del modello non rifà la griglia.
const mm = (v: unknown): number => Math.round(finiteOr(v, 0) * 1000);
const fine = (v: unknown): number => Math.round(finiteOr(v, 0) * 10000);

/** Una figura statica che ingombra il pavimento: chi sta in piedi (non
 *  l'hostess, che cammina: la disegna il regista) e i cani. */
const isObstacle = (f: FigureSlot | null | undefined): f is FigureSlot =>
  !!f && (f.kind === 'dog' || ((f.kind === 'adult' || f.kind === 'kid') && f.pose === 'standing'));

/** La firma della geometria che conta per camminare: pavimento, tavoli
 *  (forma, centro, rotazione, misure), sedie e sedie in più (x/z al mm), i
 *  tre segnaposto (pos e inward), chi sta in piedi e i cani (x/z al mm).
 *  Cambia → si rifà la griglia. Non ci sono colori, sedie accese, nomi né chi
 *  siede: un tavolo che si riempie non rifà niente, uno spostato in Sale &
 *  Tavoli sì, e così una comitiva che arriva all'ingresso. */
export function navKey(room: RoomModel): string {
  const out: Array<string | number> = [mm(room?.floor?.width), mm(room?.floor?.depth)];
  for (const t of Array.isArray(room?.tables) ? room.tables : []) {
    if (!t) continue;
    out.push('|', t.shape === 'circle' ? 'c' : 'r', mm(t.center?.x), mm(t.center?.z), fine(t.rotY), mm(t.length), mm(t.depth));
    for (const c of Array.isArray(t.chairs) ? t.chairs : []) if (c) out.push(mm(c.x), mm(c.z));
    out.push(';');
    for (const c of Array.isArray(t.extraChairs) ? t.extraChairs : []) if (c) out.push(mm(c.x), mm(c.z));
  }
  for (const kind of MARKERS) {
    const m = room?.markers?.[kind];
    out.push('|', kind, mm(m?.pos?.x), mm(m?.pos?.z), fine(m?.inward?.x), fine(m?.inward?.z));
  }
  out.push('|');
  for (const f of Array.isArray(room?.figures) ? room.figures : []) {
    if (isObstacle(f)) out.push(f.kind === 'dog' ? 'd' : 'p', mm(f.x), mm(f.z));
  }
  return out.join(',');
}

// Le misure del pavimento come le legge RoomShell (floorSize): un numero
// sbagliato vale 1 m. La porta del varco si calcola sullo stesso pavimento
// su cui la scena la disegna.
const floorOf = (room: Pick<RoomModel, 'floor'> | null | undefined): { width: number; depth: number } => {
  const w = room?.floor?.width;
  const d = room?.floor?.depth;
  return {
    width: typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1,
    depth: typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1,
  };
};

// Quante celle per un lato. Il −EPS: 24 / 0,2 deve dare 120 e non 121 per il
// rumore della divisione.
const cellsFor = (meters: number): number => Math.min(MAX_SIDE, Math.max(3, Math.ceil(meters / CELL - EPS)));

// Un versore letto con prudenza; un vettore nullo o illeggibile vale
// `fallback` (come Fixtures, che gira un arredo senza verso verso −Z).
const unitOr = (v: Vec2 | null | undefined, fx: number, fz: number): Vec2 => {
  const x = finiteOr(v?.x, NaN);
  const z = finiteOr(v?.z, NaN);
  const len = Math.sqrt(x * x + z * z);
  return Number.isFinite(len) && len > EPS ? { x: x / len, z: z / len } : { x: fx, z: fz };
};

const markerPos = (m: MarkerModel | null | undefined): Vec2 | null => {
  const x = m?.pos?.x;
  const z = m?.pos?.z;
  return typeof x === 'number' && typeof z === 'number' && Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
};

interface Raster {
  cols: number;
  rows: number;
  blocked: Uint8Array;
}

// Blocca le celle il cui centro sta dentro il disco, visitando solo quelle
// del suo riquadro.
function blockDisc(r: Raster, cx: number, cz: number, radius: number): void {
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || !(radius > 0)) return;
  const i0 = Math.max(0, Math.floor((cx - radius) / CELL));
  const i1 = Math.min(r.cols - 1, Math.floor((cx + radius) / CELL));
  const j0 = Math.max(0, Math.floor((cz - radius) / CELL));
  const j1 = Math.min(r.rows - 1, Math.floor((cz + radius) / CELL));
  const r2 = radius * radius;
  for (let j = j0; j <= j1; j++) {
    const dz = (j + 0.5) * CELL - cz;
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * CELL - cx;
      if (dx * dx + dz * dz < r2) r.blocked[j * r.cols + i] = 1;
    }
  }
}

// Blocca le celle del disco tranne quelle entro `keepR` da (kx, kz): il
// leggio senza la tasca dove sta l'hostess. Una cella della tasca chiusa da
// un altro ostacolo resta chiusa.
function blockDiscExcept(r: Raster, cx: number, cz: number, radius: number, kx: number, kz: number, keepR: number): void {
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || !(radius > 0)) return;
  const i0 = Math.max(0, Math.floor((cx - radius) / CELL));
  const i1 = Math.min(r.cols - 1, Math.floor((cx + radius) / CELL));
  const j0 = Math.max(0, Math.floor((cz - radius) / CELL));
  const j1 = Math.min(r.rows - 1, Math.floor((cz + radius) / CELL));
  const r2 = radius * radius;
  const k2 = keepR * keepR;
  const keep = Number.isFinite(kx) && Number.isFinite(kz);
  for (let j = j0; j <= j1; j++) {
    const dz = (j + 0.5) * CELL - cz;
    const ez = (j + 0.5) * CELL - kz;
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * CELL - cx;
      if (dx * dx + dz * dz >= r2) continue;
      const ex = (i + 0.5) * CELL - kx;
      if (keep && ex * ex + ez * ez < k2) continue;
      r.blocked[j * r.cols + i] = 1;
    }
  }
}

// Blocca le celle il cui centro sta dentro un rettangolo orientato (mezze
// misure hx lungo u, hz lungo v = u ruotato di 90°) gonfiato di `pad`: la
// somma di Minkowski, con gli spigoli tondi. Agli angoli di un tavolo si
// passa come passa un corpo tondo, non a 31 cm (la diagonale del quadrato
// gonfiato).
function blockBox(r: Raster, cx: number, cz: number, ux: number, uz: number, hx: number, hz: number, pad: number): void {
  if (!Number.isFinite(cx) || !Number.isFinite(cz) || !Number.isFinite(ux) || !Number.isFinite(uz)) return;
  const vx = -uz;
  const vz = ux;
  const ex = Math.abs(ux) * hx + Math.abs(vx) * hz + pad;
  const ez = Math.abs(uz) * hx + Math.abs(vz) * hz + pad;
  const i0 = Math.max(0, Math.floor((cx - ex) / CELL));
  const i1 = Math.min(r.cols - 1, Math.floor((cx + ex) / CELL));
  const j0 = Math.max(0, Math.floor((cz - ez) / CELL));
  const j1 = Math.min(r.rows - 1, Math.floor((cz + ez) / CELL));
  const pad2 = pad * pad;
  for (let j = j0; j <= j1; j++) {
    const dz = (j + 0.5) * CELL - cz;
    for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * CELL - cx;
      const qx = Math.max(0, Math.abs(dx * ux + dz * uz) - hx);
      const qz = Math.max(0, Math.abs(dx * vx + dz * vz) - hz);
      if ((qx === 0 && qz === 0) || qx * qx + qz * qz < pad2) r.blocked[j * r.cols + i] = 1;
    }
  }
}

/** La griglia di una sala, dalla sua geometria.
 *
 *  - Il bordo: un anello di una cella lungo i quattro muri, tranne il varco
 *    della porta quando la porta sta sul muro (doorOnWall): le celle di quel
 *    muro con il centro entro DOOR_GAP/2 dalla porta. Le due celle d'angolo
 *    restano chiuse anche lì: sono pure dell'altro muro, e chi esce non deve
 *    strisciare lungo lo zoccolo di fianco.
 *  - Un tavolo rettangolare: il piano (length × depth, ruotato come
 *    placement.toWorld) gonfiato di AGENT_R. Un tondo: un disco di raggio
 *    length/2 + AGENT_R. Ogni sedia e ogni sedia in più, accesa o no (la
 *    sedia c'è comunque): un disco CHAIR_R + AGENT_R.
 *  - Il banco del pass: PASS_LEN × PASS_DEPTH centrato sul segnaposto, il
 *    lato corto lungo `inward`, gonfiato di AGENT_R. Il leggio: un disco
 *    LECTERN_R gonfiato di AGENT_R, meno la tasca (HOST_POCKET) dove sta
 *    l'hostess.
 *  - Chi sta in piedi e i cani (figure statiche): un disco PERSON_R o DOG_R
 *    + AGENT_R. Chi aspetta all'ingresso sta proprio accanto alla porta,
 *    sulla strada di chi entra ed esce: senza, la fila dell'hostess gli
 *    passerebbe in mezzo.
 *  I segnaposto di ripiego contano come quelli posati: la scena li disegna. */
export function buildNavGrid(room: RoomModel): NavGrid {
  const floor = floorOf(room);
  const cols = cellsFor(floor.width);
  const rows = cellsFor(floor.depth);
  const blocked = new Uint8Array(cols * rows);
  const r: Raster = { cols, rows, blocked };

  for (let i = 0; i < cols; i++) {
    blocked[i] = 1;
    blocked[(rows - 1) * cols + i] = 1;
  }
  for (let j = 0; j < rows; j++) {
    blocked[j * cols] = 1;
    blocked[j * cols + cols - 1] = 1;
  }
  const door = doorOnWall(room?.markers?.ENTRANCE, floor);
  if (door) {
    const half = DOOR_GAP / 2 + EPS;
    if (door.edge === 'far' || door.edge === 'near') {
      const j = door.edge === 'far' ? 0 : rows - 1;
      for (let i = 1; i < cols - 1; i++) {
        if (Math.abs((i + 0.5) * CELL - door.along) <= half) blocked[j * cols + i] = 0;
      }
    } else {
      const i = door.edge === 'left' ? 0 : cols - 1;
      for (let j = 1; j < rows - 1; j++) {
        if (Math.abs((j + 0.5) * CELL - door.along) <= half) blocked[j * cols + i] = 0;
      }
    }
  }

  for (const t of Array.isArray(room?.tables) ? room.tables : []) {
    if (!t) continue;
    const cx = finiteOr(t.center?.x, NaN);
    const cz = finiteOr(t.center?.z, NaN);
    const length = Math.max(0, finiteOr(t.length, 0));
    const depth = Math.max(0, finiteOr(t.depth, 0));
    if (t.shape === 'circle') {
      blockDisc(r, cx, cz, length / 2 + AGENT_R);
    } else {
      // Gli assi del tavolo come placement.toWorld: θ = −rotY, X locale lungo
      // (cos θ, sin θ).
      const theta = -finiteOr(t.rotY, 0);
      blockBox(r, cx, cz, Math.cos(theta), Math.sin(theta), length / 2, depth / 2, AGENT_R);
    }
    for (const c of Array.isArray(t.chairs) ? t.chairs : []) {
      if (c) blockDisc(r, finiteOr(c.x, NaN), finiteOr(c.z, NaN), CHAIR_R + AGENT_R);
    }
    for (const c of Array.isArray(t.extraChairs) ? t.extraChairs : []) {
      if (c) blockDisc(r, finiteOr(c.x, NaN), finiteOr(c.z, NaN), CHAIR_R + AGENT_R);
    }
  }

  const pass = room?.markers?.PASS;
  const passAt = markerPos(pass);
  if (passAt) {
    // +Z locale del banco = inward (Fixtures): il lato lungo sull'asse X
    // locale, (in.z, −in.x).
    const n = unitOr(pass?.inward, 0, -1);
    blockBox(r, passAt.x, passAt.z, n.z, -n.x, PASS_LEN / 2, PASS_DEPTH / 2, AGENT_R);
  }
  const host = room?.markers?.HOST_STAND;
  const hostAt = markerPos(host);
  if (host && hostAt) {
    const spot = hostSpot(host, room?.markers?.ENTRANCE ?? null, room?.floor);
    blockDiscExcept(r, hostAt.x, hostAt.z, LECTERN_R + AGENT_R, spot.x, spot.z, HOST_POCKET);
  }

  for (const f of Array.isArray(room?.figures) ? room.figures : []) {
    if (isObstacle(f)) blockDisc(r, finiteOr(f.x, NaN), finiteOr(f.z, NaN), (f.kind === 'dog' ? DOG_R : PERSON_R) + AGENT_R);
  }

  return { roomId: finiteOr(room?.id, 0), key: navKey(room), cols, rows, blocked };
}

/** L'indice della cella che contiene (x, z); −1 fuori dalla griglia. */
export function cellAt(grid: NavGrid, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1;
  const i = Math.floor(x / CELL);
  const j = Math.floor(z / CELL);
  if (i < 0 || j < 0 || i >= grid.cols || j >= grid.rows) return -1;
  return j * grid.cols + i;
}

/** Il punto sta in una cella libera (fuori dalla griglia: no). */
export function isFree(grid: NavGrid, x: number, z: number): boolean {
  const c = cellAt(grid, x, z);
  return c >= 0 && grid.blocked[c] === 0;
}

// La cella libera col centro più vicino a (x, z) entro `radius` metri, in
// linea d'aria; a pari distanza l'indice più basso. −1 se non ce n'è.
function nearestFreeCell(grid: NavGrid, x: number, z: number, radius: number): number {
  const { cols, rows, blocked } = grid;
  const i0 = Math.max(0, Math.floor((x - radius) / CELL));
  const i1 = Math.min(cols - 1, Math.floor((x + radius) / CELL));
  const j0 = Math.max(0, Math.floor((z - radius) / CELL));
  const j1 = Math.min(rows - 1, Math.floor((z + radius) / CELL));
  let best = -1;
  let bestD = radius * radius + EPS;
  for (let j = j0; j <= j1; j++) {
    const dz = (j + 0.5) * CELL - z;
    for (let i = i0; i <= i1; i++) {
      const idx = j * cols + i;
      if (blocked[idx] !== 0) continue;
      const dx = (i + 0.5) * CELL - x;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = idx;
      }
    }
  }
  return best;
}

const centreOf = (grid: NavGrid, idx: number): Vec2 => ({
  x: ((idx % grid.cols) + 0.5) * CELL,
  z: (Math.floor(idx / grid.cols) + 0.5) * CELL,
});

/** La cella libera più vicina: entro 1,0 m, poi entro 2,0 m; null se niente.
 *  Il centro della cella, in metri. Un punto già in una cella libera dà il
 *  centro della sua cella. */
export function nearestFree(grid: NavGrid, p: Vec2): Vec2 | null {
  const x = finiteOr(p?.x, NaN);
  const z = finiteOr(p?.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let idx = nearestFreeCell(grid, x, z, 1.0);
  if (idx < 0) idx = nearestFreeCell(grid, x, z, 2.0);
  return idx < 0 ? null : centreOf(grid, idx);
}

// La linea di vista su numeri, per non allocare punti nei cicli: il
// percorso delle celle attraversate (Amanatides–Woo), e dove il segmento
// passa esattamente per un vertice della griglia anche le due celle accanto
// (supercover). È proprio quel caso a vietare il taglio d'angolo fra due
// ostacoli in diagonale.
function losXY(grid: NavGrid, ax: number, az: number, bx: number, bz: number): boolean {
  const { cols, rows, blocked } = grid;
  const x0 = ax / CELL;
  const y0 = az / CELL;
  const x1 = bx / CELL;
  const y1 = bz / CELL;
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return false;
  let i = Math.floor(x0);
  let j = Math.floor(y0);
  const iEnd = Math.floor(x1);
  const jEnd = Math.floor(y1);
  const free = (ci: number, cj: number): boolean =>
    ci >= 0 && cj >= 0 && ci < cols && cj < rows && blocked[cj * cols + ci] === 0;
  if (!free(i, j)) return false;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const si = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const sj = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const tdx = si !== 0 ? Math.abs(1 / dx) : Infinity;
  const tdy = sj !== 0 ? Math.abs(1 / dy) : Infinity;
  let tx = si > 0 ? (i + 1 - x0) * tdx : si < 0 ? (x0 - i) * tdx : Infinity;
  let ty = sj > 0 ? (j + 1 - y0) * tdy : sj < 0 ? (y0 - j) * tdy : Infinity;
  let guard = Math.abs(iEnd - i) + Math.abs(jEnd - j) + 2;
  while ((i !== iEnd || j !== jEnd) && guard-- > 0) {
    const d = tx - ty;
    if (Math.abs(d) < EPS && i !== iEnd && j !== jEnd) {
      if (!free(i + si, j) || !free(i, j + sj)) return false;
      i += si;
      j += sj;
      tx += tdx;
      ty += tdy;
    } else if ((d < 0 && i !== iEnd) || j === jEnd) {
      i += si;
      tx += tdx;
    } else {
      j += sj;
      ty += tdy;
    }
    if (!free(i, j)) return false;
  }
  return true;
}

/** Linea di vista supercover: ogni cella toccata dal segmento è libera. Un
 *  estremo fuori dalla griglia, o in una cella bloccata: no. */
export function lineOfSight(grid: NavGrid, a: Vec2, b: Vec2): boolean {
  return losXY(grid, finiteOr(a?.x, NaN), finiteOr(a?.z, NaN), finiteOr(b?.x, NaN), finiteOr(b?.z, NaN));
}

/* ── A* ───────────────────────────────────────────────────────────────── */

interface Scratch {
  /** Il costo dal via, in celle (Float32 come nel piano: 4 byte a cella). */
  g: Float32Array;
  f: Float32Array;
  h: Float32Array;
  parent: Int32Array;
  /** La coda: un heap binario di indici di cella, con la posizione di ognuno
   *  per abbassarne il costo sul posto (una cella sta in coda una volta). */
  heap: Int32Array;
  pos: Int32Array;
  /** La generazione in cui la cella è stata vista / chiusa: una ricerca
   *  nuova non ripulisce niente, alza il numero. */
  seen: Uint32Array;
  closed: Uint32Array;
  gen: number;
}

// I buffer di ogni griglia, allocati alla prima ricerca e poi riusati. Una
// WeakMap e non un campo della griglia: la griglia resta un dato semplice,
// e quando il regista la butta (geometria cambiata) i buffer se ne vanno con
// lei.
const SCRATCH = new WeakMap<NavGrid, Scratch>();

function scratchFor(grid: NavGrid): Scratch {
  const n = grid.cols * grid.rows;
  let s = SCRATCH.get(grid);
  if (!s || s.g.length !== n) {
    s = {
      g: new Float32Array(n),
      f: new Float32Array(n),
      h: new Float32Array(n),
      parent: new Int32Array(n),
      heap: new Int32Array(n),
      pos: new Int32Array(n),
      seen: new Uint32Array(n),
      closed: new Uint32Array(n),
      gen: 0,
    };
    SCRATCH.set(grid, s);
  }
  return s;
}

// a viene prima di b nella coda: f più basso, poi h più basso (più vicina
// alla meta: meno celle espanse), poi l'indice più basso. Sempre lo stesso
// ordine, quindi sempre lo stesso percorso.
const before = (f: Float32Array, h: Float32Array, a: number, b: number): boolean =>
  f[a] !== f[b] ? f[a] < f[b] : h[a] !== h[b] ? h[a] < h[b] : a < b;

function siftUp(s: Scratch, k: number): void {
  const { heap, pos, f, h } = s;
  const node = heap[k];
  while (k > 0) {
    const p = (k - 1) >> 1;
    const pn = heap[p];
    if (!before(f, h, node, pn)) break;
    heap[k] = pn;
    pos[pn] = k;
    k = p;
  }
  heap[k] = node;
  pos[node] = k;
}

function siftDown(s: Scratch, k: number, size: number): void {
  const { heap, pos, f, h } = s;
  const node = heap[k];
  for (;;) {
    let c = 2 * k + 1;
    if (c >= size) break;
    if (c + 1 < size && before(f, h, heap[c + 1], heap[c])) c++;
    if (!before(f, h, heap[c], node)) break;
    heap[k] = heap[c];
    pos[heap[k]] = k;
    k = c;
  }
  heap[k] = node;
  pos[node] = k;
}

// I vicini: prima i quattro dritti, poi le diagonali, in un ordine fisso.
const NB_DI = Int8Array.from([1, -1, 0, 0, 1, -1, 1, -1]);
const NB_DJ = Int8Array.from([0, 0, 1, -1, 1, 1, -1, -1]);

// Il percorso di celle da `start` a `goal` (entrambe libere), o null: nessuna
// strada, o oltre NODE_CAP espansioni. Costi 1 e √2 in celle, euristica
// octile (consistente: una cella chiusa non si riapre), una diagonale solo con
// i due vicini dritti liberi.
function astar(grid: NavGrid, start: number, goal: number): number[] | null {
  const s = scratchFor(grid);
  s.gen = (s.gen + 1) >>> 0;
  if (s.gen === 0) {
    s.seen.fill(0);
    s.closed.fill(0);
    s.gen = 1;
  }
  const gen = s.gen;
  const { cols, rows, blocked } = grid;
  const { g, f, h, parent, heap, seen, closed, pos } = s;
  const gi = goal % cols;
  const gj = (goal - gi) / cols;
  const heuristic = (i: number, j: number): number => {
    const dx = Math.abs(i - gi);
    const dy = Math.abs(j - gj);
    return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
  };

  let size = 0;
  const si0 = start % cols;
  seen[start] = gen;
  g[start] = 0;
  h[start] = heuristic(si0, (start - si0) / cols);
  f[start] = h[start];
  parent[start] = -1;
  heap[0] = start;
  pos[start] = 0;
  size = 1;

  let expanded = 0;
  while (size > 0) {
    const cur = heap[0];
    size--;
    if (size > 0) {
      heap[0] = heap[size];
      pos[heap[0]] = 0;
      siftDown(s, 0, size);
    }
    if (cur === goal) {
      const cells: number[] = [];
      for (let c = goal; c !== -1; c = parent[c]) cells.push(c);
      return cells.reverse();
    }
    closed[cur] = gen;
    if (++expanded > NODE_CAP) return null;
    const ci = cur % cols;
    const cj = (cur - ci) / cols;
    const gCur = g[cur];
    for (let k = 0; k < 8; k++) {
      const ni = ci + NB_DI[k];
      const nj = cj + NB_DJ[k];
      if (ni < 0 || nj < 0 || ni >= cols || nj >= rows) continue;
      const nb = nj * cols + ni;
      if (blocked[nb] !== 0 || closed[nb] === gen) continue;
      const diagonal = k >= 4;
      // Niente tagli d'angolo: in diagonale solo se le due celle dritte
      // accanto sono libere, o il corpo sfiorerebbe lo spigolo.
      if (diagonal && (blocked[cj * cols + ni] !== 0 || blocked[nj * cols + ci] !== 0)) continue;
      // Arrotondato a 32 bit come il buffer: un costo uguale deve risultare
      // uguale, non «migliore» di un ulp, o la cella rientrerebbe in coda.
      const tentative = Math.fround(gCur + (diagonal ? SQRT2 : 1));
      if (seen[nb] !== gen) {
        seen[nb] = gen;
        g[nb] = tentative;
        h[nb] = heuristic(ni, nj);
        f[nb] = tentative + h[nb];
        parent[nb] = cur;
        heap[size] = nb;
        pos[nb] = size;
        size++;
        siftUp(s, size - 1);
      } else if (tentative < g[nb]) {
        g[nb] = tentative;
        f[nb] = tentative + h[nb];
        parent[nb] = cur;
        siftUp(s, pos[nb]);
      }
    }
  }
  return null;
}

// Toglie i doppioni e i punti allineati in mezzo (un punto in mezzo a un
// tratto dritto non è una svolta), tenendo il primo e l'ultimo punto ESATTI.
function simplify(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  const lastIdx = points.length - 1;
  points.forEach((p, idx) => {
    const prev = out[out.length - 1];
    if (prev && idx !== lastIdx && Math.abs(p.x - prev.x) < 1e-9 && Math.abs(p.z - prev.z) < 1e-9) return;
    if (prev && idx === lastIdx && out.length > 1 && Math.abs(p.x - prev.x) < 1e-9 && Math.abs(p.z - prev.z) < 1e-9) {
      // L'ultimo punto prende il posto del suo gemello: il percorso finisce
      // esattamente in `to`.
      out[out.length - 1] = p;
      return;
    }
    while (out.length >= 2) {
      const a = out[out.length - 2];
      const b = out[out.length - 1];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const bpx = p.x - b.x;
      const bpz = p.z - b.z;
      const cross = abx * bpz - abz * bpx;
      const dot = abx * bpx + abz * bpz;
      const scale = Math.sqrt((abx * abx + abz * abz) * (bpx * bpx + bpz * bpz));
      if (dot > 0 && Math.abs(cross) <= 1e-9 * scale) out.pop();
      else break;
    }
    out.push(p);
  });
  return out;
}

/** Il percorso da `from` a `to`: inizia ESATTAMENTE in from e finisce
 *  ESATTAMENTE in to (le celle bloccate si risolvono con nearestFree; il primo
 *  e l'ultimo tratto possono uscire dalla griglia). A* 8-connesso, costi 1 e
 *  √2, euristica octile, niente tagli d'angolo, heap binario su array
 *  tipizzati, NODE_CAP; poi string pulling. Senza soluzione (o oltre il
 *  tetto, o una delle due celle irrisolvibile): [from, to] (compenetrazione
 *  accettata).
 *
 *  Il filo teso: da un punto fermo si va al punto PIÙ LONTANO del percorso
 *  che si vede (lineOfSight), e da lì si ricomincia. Si parte da `from`
 *  stesso se la sua cella è libera, se no dal centro della cella libera più
 *  vicina (e il primo tratto è from → quel centro); lo stesso, all'altro
 *  capo, per `to`. Punti nuovi, mai quelli passati. */
export function findPath(grid: NavGrid, from: Vec2, to: Vec2): Vec2[] {
  const a: Vec2 = { x: finiteOr(from?.x, 0), z: finiteOr(from?.z, 0) };
  const b: Vec2 = { x: finiteOr(to?.x, 0), z: finiteOr(to?.z, 0) };
  if (!grid || !(grid.blocked instanceof Uint8Array) || grid.blocked.length !== grid.cols * grid.rows) return [a, b];

  let start = cellAt(grid, a.x, a.z);
  const startFree = start >= 0 && grid.blocked[start] === 0;
  if (!startFree) {
    const p = nearestFree(grid, a);
    start = p ? cellAt(grid, p.x, p.z) : -1;
  }
  let goal = cellAt(grid, b.x, b.z);
  const goalFree = goal >= 0 && grid.blocked[goal] === 0;
  if (!goalFree) {
    const p = nearestFree(grid, b);
    goal = p ? cellAt(grid, p.x, p.z) : -1;
  }
  if (start < 0 || goal < 0 || start === goal) return [a, b];
  const cells = astar(grid, start, goal);
  if (!cells) return [a, b];

  // I punti del filo: i capi esatti dove sono su celle libere, se no i
  // centri delle celle risolte; in mezzo i centri delle celle.
  const n = cells.length;
  const wx = new Float64Array(n);
  const wz = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const c = cells[k];
    wx[k] = ((c % grid.cols) + 0.5) * CELL;
    wz[k] = (Math.floor(c / grid.cols) + 0.5) * CELL;
  }
  if (startFree) {
    wx[0] = a.x;
    wz[0] = a.z;
  }
  if (goalFree) {
    wx[n - 1] = b.x;
    wz[n - 1] = b.z;
  }

  const points: Vec2[] = [a];
  if (!startFree) points.push({ x: wx[0], z: wz[0] });
  let anchor = 0;
  while (anchor < n - 1) {
    // Il punto più lontano che si vede da qui. Due celle di fila del
    // percorso si vedono sempre (A* non taglia gli angoli), quindi almeno
    // anchor + 1.
    let next = anchor + 1;
    for (let m = n - 1; m > anchor + 1; m--) {
      if (losXY(grid, wx[anchor], wz[anchor], wx[m], wz[m])) {
        next = m;
        break;
      }
    }
    if (next < n - 1 || !goalFree) points.push({ x: wx[next], z: wz[next] });
    anchor = next;
  }
  points.push(b);
  return simplify(points);
}

/* ── I punti fissi di una sala ────────────────────────────────────────── */

/** Un punto del pavimento e dove guarda (rotation.y, davanti verso +Z). */
export interface Spot {
  x: number;
  z: number;
  yaw: number;
}

/** I punti da cui passa chi entra, esce o lavora in una sala. */
export interface RoomAnchors {
  roomId: number;
  /** La porta: sul muro (doorOnWall), o al segnaposto girata verso la sala;
   *  yaw: +Z locale verso la sala. */
  door: Spot;
  /** door + n·DOOR_INSIDE, o la cella libera più vicina: dove chi entra mette
   *  piede sulla griglia, e da dove chi esce lascia la sala. */
  inside: Vec2;
  /** door − n·DOOR_OUTSIDE: fuori dalla griglia (anche oltre il pavimento),
   *  dove chi entra compare e chi esce svanisce. */
  outside: Vec2;
  /** Dove l'hostess accoglie: accanto a `inside` dalla parte del leggio,
   *  rivolta alla porta. */
  greet: Spot;
  /** Davanti al banco del pass, rivolto al banco: dove si fermano i
   *  camerieri. */
  passFront: Spot;
}

// Il punto, o la cella libera più vicina se è bloccato (o fuori dalla
// griglia); se non c'è niente di libero, il punto com'è.
const freeOr = (grid: NavGrid | null, p: Vec2): Vec2 =>
  (grid && !isFree(grid, p.x, p.z) ? nearestFree(grid, p) : null) ?? p;

// Lo yaw di chi sta in `from` e guarda `to`; da fermi nello stesso punto,
// `fallback`.
const yawToward = (from: Vec2, to: Vec2, fallback: number): number => {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  return dx * dx + dz * dz > EPS * EPS ? Math.atan2(dx, dz) : fallback;
};

// La normale verso la sala di ogni muro, esatta: niente sin π = 1e−16 nei
// punti della porta.
const WALL_NORMAL = {
  near: { x: 0, z: -1 },
  far: { x: 0, z: 1 },
  left: { x: 1, z: 0 },
  right: { x: -1, z: 0 },
} as const;

/** I punti fissi di una sala: la porta e i suoi due lati, dove l'hostess
 *  accoglie, dove si fermano i camerieri. Con la griglia i punti che devono
 *  stare sul pavimento camminabile (inside, greet, passFront) scivolano
 *  sulla cella libera più vicina; senza, restano dove la geometria li mette.
 *
 *  Da che parte accoglie l'hostess: quella del leggio, guardando dentro dalla
 *  porta. Un leggio proprio sull'asse della porta non ha una parte: lì
 *  lobbyCells mette i posti dell'ingresso a destra, quindi l'hostess a
 *  sinistra, così non si pestano. */
export function roomAnchors(room: RoomModel, grid: NavGrid | null): RoomAnchors {
  const floor = floorOf(room);
  const entrance = room?.markers?.ENTRANCE;
  const wall = doorOnWall(entrance, floor);
  let n: Vec2;
  let doorAt: Vec2;
  if (wall) {
    n = WALL_NORMAL[wall.edge];
    doorAt = { x: wall.x, z: wall.z };
  } else {
    // Senza ingresso leggibile, il ripiego di layout: a metà del bordo verso
    // la camera, girato verso la sala.
    n = unitOr(entrance?.inward, 0, -1);
    doorAt = markerPos(entrance) ?? { x: floor.width / 2, z: floor.depth };
  }
  const door: Spot = { ...doorAt, yaw: Math.atan2(n.x, n.z) };
  const right = { x: -n.z, z: n.x };
  const inside = freeOr(grid, { x: door.x + n.x * DOOR_INSIDE, z: door.z + n.z * DOOR_INSIDE });
  const outside = { x: door.x - n.x * DOOR_OUTSIDE, z: door.z - n.z * DOOR_OUTSIDE };

  const host = markerPos(room?.markers?.HOST_STAND);
  const toHost = host ? (host.x - door.x) * right.x + (host.z - door.z) * right.z : 0;
  const hostSide = toHost > EPS ? 1 : -1;
  const greetAt = freeOr(grid, {
    x: inside.x + right.x * hostSide * GREET_SIDE,
    z: inside.z + right.z * hostSide * GREET_SIDE,
  });
  const greet: Spot = { ...greetAt, yaw: yawToward(greetAt, door, door.yaw + Math.PI) };

  const pass = room?.markers?.PASS;
  const passIn = unitOr(pass?.inward, 0, -1);
  const passAt = markerPos(pass) ?? { x: floor.width / 2, z: floor.depth / 2 };
  const frontAt = freeOr(grid, { x: passAt.x + passIn.x * PASS_FRONT, z: passAt.z + passIn.z * PASS_FRONT });
  const passFront: Spot = { ...frontAt, yaw: Math.atan2(-passIn.x, -passIn.z) };

  return { roomId: finiteOr(room?.id, 0), door, inside, outside, greet, passFront };
}

/** Il posto del cameriere i-esimo al pass: file da 3 lungo il banco, 0,6 m
 *  l'una dall'altra, ogni fila 0,6 m più dentro; dentro il pavimento a 0,3 m
 *  dai muri; rivolto al banco.
 *
 *  In una fila il primo sta davanti al banco (passFront), il secondo a
 *  sinistra e il terzo a destra di chi guarda il banco: un cameriere solo sta
 *  al centro, non di lato. */
export function passSlot(room: RoomModel, anchors: RoomAnchors, i: number): Spot {
  const k = Math.max(0, Math.floor(finiteOr(i, 0)));
  const row = Math.floor(k / 3);
  const col = k % 3;
  const n = unitOr(room?.markers?.PASS?.inward, 0, -1);
  // La destra di chi guarda il banco (cioè guarda verso −n).
  const rx = n.z;
  const rz = -n.x;
  const aside = col === 0 ? 0 : col === 1 ? -PASS_SLOT_PITCH : PASS_SLOT_PITCH;
  const into = row * PASS_SLOT_PITCH;
  const front = anchors?.passFront ?? { x: 0, z: 0, yaw: 0 };
  const floor = floorOf(room);
  const clampInto = (v: number, size: number): number =>
    (size < 2 * FLOOR_MARGIN ? size / 2 : Math.min(size - FLOOR_MARGIN, Math.max(FLOOR_MARGIN, v)));
  return {
    x: clampInto(finiteOr(front.x, 0) + rx * aside + n.x * into, floor.width),
    z: clampInto(finiteOr(front.z, 0) + rz * aside + n.z * into, floor.depth),
    yaw: Math.atan2(-n.x, -n.z),
  };
}

/** I posti dei camerieri al pass, liberi: gli stessi punti di passSlot, nel
 *  suo ordine, ma solo quelli su una cella libera e ad almeno
 *  PASS_SLOT_PITCH dai posti già presi. Un tavolo accanto al pass toglie un
 *  posto della prima fila, e il cameriere va al prossimo: con passSlot il
 *  terzo aspettava dentro una sedia, e dentro chi ci sedeva. Se i punti
 *  liberi non bastano (un pass chiuso fra i tavoli), la cella libera più
 *  vicina, poi il punto com'è. Si calcola quando cambia la griglia: lo stesso
 *  `count` più grande dà gli stessi primi posti. */
export function passSlots(room: RoomModel, anchors: RoomAnchors, grid: NavGrid | null, count: number): Spot[] {
  const n = Math.max(0, Math.min(64, Math.floor(finiteOr(count, 0))));
  const out: Spot[] = [];
  const min2 = (PASS_SLOT_PITCH - 1e-6) * (PASS_SLOT_PITCH - 1e-6);
  const apart = (x: number, z: number): boolean =>
    out.every(q => (q.x - x) * (q.x - x) + (q.z - z) * (q.z - z) >= min2);
  // Le file da 3 di passSlot, fino a una profondità che basta e avanza: più
  // in là i posti finiscono contro il muro di fondo (clampInto), uguali fra
  // loro, e `apart` li scarta.
  const tries = 3 * n + 12;
  for (let i = 0; i < tries && out.length < n; i++) {
    const s = passSlot(room, anchors, i);
    if ((!grid || isFree(grid, s.x, s.z)) && apart(s.x, s.z)) out.push(s);
  }
  for (let i = 0; out.length < n; i++) {
    const s = passSlot(room, anchors, i);
    const f = grid ? nearestFree(grid, s) : null;
    out.push(f && apart(f.x, f.z) ? { x: f.x, z: f.z, yaw: s.yaw } : s);
  }
  return out;
}

/** Il punto accanto a un tavolo più vicino a `toward`, rivolto al centro del
 *  tavolo. Rettangolo: i due capi a (±(length/2 + gapRect), 0) locali. Tondo:
 *  i varchi fra sedie consecutive (a metà angolo; senza sedie, 8 direzioni) a
 *  raggio length/2 + gapCircle. Si prende il candidato libero più vicino a
 *  `toward`; nessuno libero → nearestFree del più vicino; poi il più vicino
 *  comunque.
 *
 *  È dove l'hostess presenta il tavolo (il capo verso l'ingresso, il varco
 *  verso la porta) e dove il cameriere serve (dal lato del pass): ai capi e
 *  fra le sedie non si sta alle spalle di nessuno. Una testa occupata da una
 *  sedia in più (chi non entrava sui lati) è bloccata, e vale l'altro capo. */
export function tableSidePoint(table: TableModel, toward: Vec2, grid: NavGrid | null, gapRect: number, gapCircle: number): Spot {
  const cx = finiteOr(table?.center?.x, 0);
  const cz = finiteOr(table?.center?.z, 0);
  const tx = finiteOr(toward?.x, cx);
  const tz = finiteOr(toward?.z, cz);
  const length = Math.max(0, finiteOr(table?.length, 0));
  const candidates: Vec2[] = [];
  if (table?.shape === 'circle') {
    const radius = length / 2 + finiteOr(gapCircle, 0);
    const angles: number[] = [];
    for (const list of [table.chairs, table.extraChairs]) {
      for (const c of Array.isArray(list) ? list : []) {
        const x = finiteOr(c?.x, NaN);
        const z = finiteOr(c?.z, NaN);
        if (Number.isFinite(x) && Number.isFinite(z)) angles.push(Math.atan2(z - cz, x - cx));
      }
    }
    if (angles.length === 0) {
      for (let k = 0; k < 8; k++) angles.push((k * Math.PI) / 4);
      for (const phi of angles) candidates.push({ x: cx + radius * Math.cos(phi), z: cz + radius * Math.sin(phi) });
    } else {
      angles.sort((p, q) => p - q);
      angles.forEach((phi, k) => {
        const next = k + 1 < angles.length ? angles[k + 1] : angles[0] + Math.PI * 2;
        const mid = (phi + next) / 2;
        candidates.push({ x: cx + radius * Math.cos(mid), z: cz + radius * Math.sin(mid) });
      });
    }
  } else {
    // Le teste lungo l'asse X locale, ruotato come placement.toWorld.
    const half = length / 2 + finiteOr(gapRect, 0);
    const theta = -finiteOr(table?.rotY, 0);
    const ux = Math.cos(theta);
    const uz = Math.sin(theta);
    candidates.push({ x: cx + ux * half, z: cz + uz * half }, { x: cx - ux * half, z: cz - uz * half });
  }

  const dist2 = (p: Vec2) => (p.x - tx) * (p.x - tx) + (p.z - tz) * (p.z - tz);
  let best = -1;
  let nearest = -1;
  candidates.forEach((p, k) => {
    const d = dist2(p);
    if (nearest < 0 || d < dist2(candidates[nearest]) - EPS) nearest = k;
    if (grid && !isFree(grid, p.x, p.z)) return;
    if (best < 0 || d < dist2(candidates[best]) - EPS) best = k;
  });
  const center = { x: cx, z: cz };
  let p: Vec2;
  if (best >= 0) p = candidates[best];
  else if (nearest >= 0) p = (grid ? nearestFree(grid, candidates[nearest]) : null) ?? candidates[nearest];
  else p = center;
  return { x: p.x, z: p.z, yaw: yawToward(p, center, 0) };
}
