import { TableShape, type BanquetMenu } from '../../../types';
import { litChairIndices } from '../../../utils/tableGeometry';
import type { ChairModel, FigureSlot, MarkerModel, RoomModel, TableModel, Vec2 } from '../types';
import { CHAIR_EDGE_MIN, HIGH_CHAIR_SEAT_HEIGHT, SEAT_HEIGHT, finiteOr } from './geometry';
import { MAX_DOGS, type PartyComposition } from './party';
import { LOBBY_MAX_DRAWN } from './presence';

/* Dove sta ogni persona: sulle sedie che la piantina accende, alle teste di
 * un tavolo pieno, in piedi dietro le sedie, all'ingresso, all'accoglienza.
 * Puro e deterministico: la stessa comitiva sullo stesso tavolo si siede
 * sempre negli stessi posti, e il tavolo ruotato porta gli stessi indici.
 *
 * Tutto si decide in coordinate LOCALI del tavolo (x lungo il lato lungo, z
 * verso il bordo basso del glifo) e poi si porta nel mondo: così l'ordine
 * attorno al tavolo non dipende da come è ruotato in sala. */

/** Una sedia di testa sta oltre il capo del tavolo quanto una sedia del lato
 *  sta oltre il bordo: più vicino, la seduta entrerebbe sotto il piano. */
export const HEAD_GAP = CHAIR_EDGE_MIN;
/** Un anello ridistribuito non mette mai due sedie più vicine di così: la
 *  larghezza di una sedia più un filo d'aria. */
export const RING_PITCH_MIN = 0.48;
/** Chi resta in piedi sta così dietro una sedia (la distanza a cui ci si
 *  avvicina per sedersi)… */
export const STAND_GAP = 0.55;
/** …e un altro mezzo metro più in fuori a ogni giro attorno al tavolo. */
export const STAND_PITCH = 0.5;
/** Il cane: così fuori dalla sedia del padrone… */
export const DOG_OUT = 0.45;
/** …e così di lato, lungo il bordo. */
export const DOG_SIDE = 0.25;
/** L'ingresso: la prima fila così dentro la porta… */
export const LOBBY_IN = 1.2;
/** …la prima colonna così di lato all'asse della porta… */
export const LOBBY_SIDE = 0.9;
/** …e una persona ogni 60 cm: 2 file × 3 colonne = LOBBY_MAX_DRAWN. */
export const LOBBY_PITCH = 0.6;
/** L'hostess sta così oltre il leggio, rivolta a lui. */
export const HOST_SPOT_IN = 0.5;
/** I posti dell'ingresso, le sedie in più alle teste, chi sta in piedi e i
 *  cani restano così dentro il pavimento: oltre si finirebbe nel muro. */
export const FLOOR_MARGIN = 0.3;
/** Quanto il corpo di un ospite va verso --ds-surface: da 0 a questo, per
 *  comitiva. */
export const PARTY_TINT_MAX = 0.2;
/** I bambini, un po' più chiari degli adulti della loro comitiva. */
export const KID_TINT = 0.15;

const TAU = Math.PI * 2;
const LOBBY_COLS = 3;
// Due angoli, o due distanze in metri, più vicini di così sono uguali: il
// rumore dei float (−sin π = −1,2e−16) non deve scegliere un lato o un
// ordine al posto della regola.
const EPS = 1e-9;

export type MemberKind = 'adult' | 'kid';

/** Una persona della comitiva: l'n-esimo adulto o l'n-esimo bambino. */
export interface Member {
  kind: MemberKind;
  n: number;
}

// Un intero non negativo, letto con prudenza.
const countOf = (v: unknown): number => Math.max(0, Math.floor(finiteOr(v, 0)));

// Un angolo in (−π, π]: due rotazioni uguali danno lo stesso numero.
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

// Un valore dentro [min, max]; un pavimento più stretto dei due margini lo
// porta a metà.
const clampInto = (v: number, min: number, max: number): number =>
  (min > max ? (min + max) / 2 : Math.min(max, Math.max(min, v)));

/** Il pavimento per chi ci mette persone e sedie: `inside` dice se un punto
 *  sta a FLOOR_MARGIN dai muri, `clamp` ce lo riporta. Senza un pavimento
 *  leggibile (i test di un tavolo solo) va bene ogni punto. */
interface FloorBox {
  inside: (x: number, z: number) => boolean;
  clamp: (x: number, z: number) => Vec2;
}

function floorBox(floor: RoomModel['floor'] | null | undefined): FloorBox {
  const width = finiteOr(floor?.width, NaN);
  const depth = finiteOr(floor?.depth, NaN);
  if (!(width > 0) || !(depth > 0)) return { inside: () => true, clamp: (x, z) => ({ x, z }) };
  const hiX = width - FLOOR_MARGIN;
  const hiZ = depth - FLOOR_MARGIN;
  return {
    inside: (x, z) => x >= FLOOR_MARGIN - EPS && x <= hiX + EPS && z >= FLOOR_MARGIN - EPS && z <= hiZ + EPS,
    clamp: (x, z) => ({ x: clampInto(x, FLOOR_MARGIN, hiX), z: clampInto(z, FLOOR_MARGIN, hiZ) }),
  };
}

/** Adulti e bambini alternati finché ce ne sono di tutti e due, poi il resto:
 *  2A2K → A K A K, 2A1K → A K A, 0A3K → K K K, 3A1K → A K A A. Ogni bambino
 *  ha un adulto accanto, attorno al tavolo. */
export function interleave(adults: number, kids: number): Member[] {
  const a = countOf(adults);
  const k = countOf(kids);
  const out: Member[] = [];
  for (let i = 0, j = 0; i < a || j < k;) {
    if (i < a) out.push({ kind: 'adult', n: i++ });
    if (j < k) out.push({ kind: 'kid', n: j++ });
  }
  return out;
}

/** La chiave stabile di una figura: r12:a0, r12:k1, r12:d0. */
export function figureKey(partyId: number, kind: 'adult' | 'kid' | 'dog', n: number): string {
  return `r${partyId}:${kind === 'adult' ? 'a' : kind === 'kid' ? 'k' : 'd'}${n}`;
}

/** La tinta di una comitiva, in [0, PARTY_TINT_MAX): un hash moltiplicativo
 *  dell'id (Knuth), così comitive vicine hanno tinte lontane e la stessa
 *  comitiva ha sempre la stessa, su ogni dispositivo e a ogni ricalcolo. */
export function partyTint(partyId: number): number {
  return ((Math.imul(partyId | 0, 2654435761) >>> 0) / 4294967296) * PARTY_TINT_MAX;
}

type TableFrame = Pick<TableModel, 'center' | 'rotY'>;

interface Frame { cx: number; cz: number; c: number; s: number }

// L'angolo θ della rotazione del CSS (oraria con la y in basso) e il centro,
// letti con prudenza.
const frameOf = (table: TableFrame): Frame => {
  const theta = -finiteOr(table?.rotY, 0);
  return {
    cx: finiteOr(table?.center?.x, 0),
    cz: finiteOr(table?.center?.z, 0),
    c: Math.cos(theta),
    s: Math.sin(theta),
  };
};

const localIn = (f: Frame, x: number, z: number): { lx: number; lz: number } => {
  const dx = x - f.cx;
  const dz = z - f.cz;
  return { lx: dx * f.c + dz * f.s, lz: -dx * f.s + dz * f.c };
};

/** Un punto del mondo nelle coordinate del tavolo: x lungo il lato lungo, z
 *  verso il bordo basso del glifo. */
export function toLocal(table: TableFrame, x: number, z: number): { lx: number; lz: number } {
  return localIn(frameOf(table), x, z);
}

/** Un punto del tavolo nel mondo: la stessa rotazione di placeTable
 *  (rotateLocal), attorno al centro del glifo. */
export function toWorld(table: TableFrame, lx: number, lz: number): Vec2 {
  const f = frameOf(table);
  return { x: f.cx + lx * f.c - lz * f.s, z: f.cz + lx * f.s + lz * f.c };
}

/** Gli indici di `points` in senso orario attorno al tavolo (come sulla
 *  piantina, con la y in basso), a partire da `points[0]`; a pari angolo
 *  l'ordine dato. Un rettangolo da 6 con le sedie 0, 1, 3, 4 accese dà
 *  [0, 1, 4, 3]: in alto a sinistra, in alto al centro, in basso al centro,
 *  in basso a sinistra. Attorno al tavolo, non per indice: così una comitiva
 *  si siede vicina, e i bambini fra gli adulti. */
export function ringOrder(table: TableFrame, points: readonly Vec2[]): number[] {
  const list = Array.isArray(points) ? points : [];
  if (list.length === 0) return [];
  const frame = frameOf(table);
  const angles = list.map(p => {
    const { lx, lz } = localIn(frame, finiteOr(p?.x, 0), finiteOr(p?.z, 0));
    return Math.atan2(lz, lx);
  });
  const a0 = angles[0];
  const rel = angles.map(a => {
    let d = (a - a0) % TAU;
    if (d < 0) d += TAU;
    // Un giro intero meno il rumore dei float è ancora il punto di partenza.
    return d > TAU - EPS ? 0 : d;
  });
  return list
    .map((_, i) => i)
    .sort((i, j) => (Math.abs(rel[i] - rel[j]) > EPS ? rel[i] - rel[j] : i - j));
}

// Una sedia in un punto locale del tavolo, rivolta al centro.
const chairAt = (table: TableFrame, lx: number, lz: number, high = false): ChairModel => {
  const p = toWorld(table, lx, lz);
  const { cx, cz } = frameOf(table);
  return { x: p.x, z: p.z, yaw: Math.atan2(cx - p.x, cz - p.z), lit: true, high };
};

// La forma per litChairIndices: il glifo conosce solo tondo e rettangolo
// (il quadrato si dispone come un rettangolo).
const glyphShape = (shape: TableModel['shape']): TableShape =>
  shape === 'circle' ? TableShape.CIRCLE : TableShape.RECTANGLE;

type SeatTable = Pick<TableModel, 'id' | 'shape' | 'center' | 'rotY' | 'length' | 'depth' | 'chairs'>;

export interface SeatPlan {
  /** Le persone della comitiva (nell'ordine di interleave), poi i cani. */
  figures: FigureSlot[];
  /** Solo i tavoli dove siede almeno qualcuno: le loro sedie finali (accese
   *  quelle occupate) e quelle in più. */
  tables: Map<number, { chairs: ChairModel[]; extraChairs: ChairModel[] }>;
}

// Dove finisce una persona: su una sedia (della piantina o ridistribuita),
// su una sedia in più, o in piedi.
type Spot =
  | { t: number; where: 'chair' | 'extra'; i: number }
  | { t: number; where: 'stand'; x: number; z: number; yaw: number };

interface WorkTable {
  table: SeatTable;
  chairs: ChairModel[];
  /** Le teste, nell'ordine destra, sinistra. */
  extra: ChairModel[];
}

/** Siede una comitiva: `tables[0]` è il suo tavolo disegnato, gli altri sono
 *  i tavoli liberi del suo banchetto in questa sala (spillTableIds).
 *
 * 1. Le persone si siedono tavolo per tavolo sulle sedie che la piantina
 *    accende per quante ne restano (litChairIndices), attorno al tavolo, in
 *    ordine alternato. Col seggiolone su un rettangolo il bambino più piccolo
 *    resta fuori dal giro: ha la sua sedia in testa.
 * 2. Chi non entra resta al suo tavolo: su un tondo l'anello si ridistribuisce
 *    per tutti (sedie a 48 cm almeno, sedia 0 a ore 12); su un rettangolo le
 *    teste libere, prima la destra, se non finiscono nel muro.
 * 3. Chi ancora non entra sta in piedi: prima dietro le teste (ai capi del
 *    tavolo, dove non copre nessuno), poi dietro le sedie girando attorno al
 *    tavolo; ogni giro mezzo metro più in fuori, saltando i posti oltre il
 *    muro.
 * 4. Il seggiolone: su un rettangolo la testa dalla parte del primo adulto
 *    (l'altra se quella è nel muro), a HIGH_CHAIR_SEAT_HEIGHT; su un tondo la
 *    sedia del bambino stessa, alzata.
 * 5. I cani sdraiati accanto agli adulti, lungo il bordo, dentro la sala. */
export function seatParty(args: {
  partyId: number;
  composition: PartyComposition;
  tables: readonly TableModel[];
  /** Il pavimento della sala: teste, posti in piedi e cani ci restano dentro,
   *  a FLOOR_MARGIN dai muri. Senza, nessun controllo. */
  floor?: RoomModel['floor'] | null;
}): SeatPlan {
  const { partyId } = args;
  const plan: SeatPlan = { figures: [], tables: new Map() };
  const room = floorBox(args.floor);
  const seenIds = new Set<number>();
  const work: WorkTable[] = [];
  for (const t of Array.isArray(args.tables) ? args.tables : []) {
    if (!t || seenIds.has(t.id)) continue;
    seenIds.add(t.id);
    const chairs = (Array.isArray(t.chairs) ? t.chairs : []).map(c => ({ ...c, lit: false, high: false }));
    work.push({ table: t, chairs, extra: [] });
  }
  if (work.length === 0) return plan;

  const adults = countOf(args.composition?.adults);
  const kids = countOf(args.composition?.kids);
  const dogs = Math.min(MAX_DOGS, countOf(args.composition?.dogs));
  const order = interleave(adults, kids);
  const hc = args.composition?.highChair === true && kids >= 1;
  const youngest = hc ? order.findIndex(m => m.kind === 'kid' && m.n === kids - 1) : -1;
  const u1 = work[0];
  const u1Rect = u1.table.shape !== 'circle';
  // Le teste di un rettangolo che stanno sul pavimento, prima la destra: un
  // tavolo col capo contro il muro non ha la sedia lì.
  const half = finiteOr(u1.table.length, 0) / 2 + HEAD_GAP;
  const headOf = (side: 'right' | 'left', high = false) => chairAt(u1.table, side === 'right' ? half : -half, 0, high);
  const heads = u1Rect
    ? (['right', 'left'] as const).filter(side => {
      const c = headOf(side);
      return room.inside(c.x, c.z);
    })
    : [];
  // Col seggiolone su un rettangolo il più piccolo aspetta la sua testa; se
  // nessuna testa è libera dal muro siede sulle sedie come gli altri, senza
  // seggiolone.
  const hcHead = hc && u1Rect && heads.length > 0;
  // La coda di chi si siede sulle sedie, come indici di `order`.
  const queue = order.map((_, i) => i).filter(i => !(hcHead && i === youngest));
  const spots: Array<Spot | null> = order.map(() => null);
  let next = 0;

  // 1. Le sedie accese, tavolo per tavolo.
  work.forEach((w, t) => {
    const seats = w.chairs.length;
    const take = Math.min(queue.length - next, seats);
    if (take <= 0) return;
    const used = litChairIndices(glyphShape(w.table.shape), seats, take).filter(i => i >= 0 && i < seats);
    for (const k of ringOrder(w.table, used.map(i => w.chairs[i]))) {
      if (next >= queue.length) break;
      spots[queue[next++]] = { t, where: 'chair', i: used[k] };
    }
  });

  // 2. Chi avanza resta al suo tavolo.
  if (!u1Rect) {
    const left = queue.length - next;
    const seats = u1.chairs.length;
    const { cx, cz } = frameOf(u1.table);
    const radius = seats > 0
      ? Math.hypot(u1.chairs[0].x - cx, u1.chairs[0].z - cz)
      : finiteOr(u1.table.length, 0) / 2 + HEAD_GAP;
    const ring = Math.min(seats + left, Math.max(seats, Math.floor((TAU * radius) / RING_PITCH_MIN)));
    if (left > 0 && ring > seats) {
      // Si risiedono in ordine d'indice: quelli già al tavolo (che sul tondo
      // pieno stavano sulle sedie 0, 1, …) e poi i nuovi.
      const members = queue.slice(0, next).filter(i => spots[i]?.t === 0);
      members.push(...queue.slice(next, next + (ring - seats)));
      next += ring - seats;
      u1.chairs = Array.from({ length: ring }, (_, i) => {
        const phi = -Math.PI / 2 + (TAU * i) / ring;
        return { ...chairAt(u1.table, radius * Math.cos(phi), radius * Math.sin(phi)), lit: false };
      });
      members.forEach((m, i) => {
        spots[m] = { t: 0, where: 'chair', i };
      });
    }
  } else {
    let highHead: 'right' | 'left' | null = null;
    if (hcHead) {
      // La testa dalla parte del primo adulto seduto al tavolo: il bambino
      // sta accanto a un grande. Senza adulti al tavolo, o con l'adulto al
      // centro del lato (un tavolo da 2: x locale 0, che ruotata e riportata
      // indietro torna ±1e−17), la sinistra. Se quella è nel muro, l'altra.
      const first = order.findIndex((m, i) => {
        const s = spots[i];
        return m.kind === 'adult' && s !== null && s.t === 0 && s.where === 'chair';
      });
      const s = first >= 0 ? spots[first] : null;
      const chair = s && s.where === 'chair' ? u1.chairs[s.i] : null;
      const side = chair && toLocal(u1.table, chair.x, chair.z).lx > EPS ? 'right' : 'left';
      highHead = heads.includes(side) ? side : heads[0];
    }
    for (const side of heads) {
      let member = -1;
      if (side === highHead) member = youngest;
      else if (next < queue.length) member = queue[next++];
      if (member < 0) continue;
      const i = u1.extra.push(headOf(side, side === highHead)) - 1;
      spots[member] = { t: 0, where: 'extra', i };
    }
  }

  // 3. In piedi accanto al suo tavolo: prima dietro le teste, poi dietro le
  //    sedie in giro attorno al tavolo (dalla sedia d'indice più basso),
  //    ogni giro mezzo metro più in fuori. Le teste prima perché ai capi del
  //    tavolo chi sta in piedi non copre nessuno; dietro una fila di sedute
  //    sembrerebbe una seconda fila di busti.
  if (next < queue.length) {
    const ring = [...u1.extra, ...ringOrder(u1.table, u1.chairs).map(i => u1.chairs[i])];
    // Un tavolo senza sedie né teste non capita (un tondo ha sempre
    // l'anello, un rettangolo ha le teste se non è stretto fra due muri): un
    // posto davanti al lato sopra, per non perdere nessuno.
    if (ring.length === 0) ring.push(chairAt(u1.table, 0, -(finiteOr(u1.table.depth, 0) / 2 + HEAD_GAP)));
    const behind = (k: number) => {
      const seat = ring[k % ring.length];
      const back = STAND_GAP + Math.floor(k / ring.length) * STAND_PITCH;
      return { x: seat.x - Math.sin(seat.yaw) * back, z: seat.z - Math.cos(seat.yaw) * back, yaw: seat.yaw };
    };
    // Un posto oltre il muro si salta. Ogni posto si allontana dritto dalla
    // sua sedia, e il pavimento è un rettangolo: dopo un giro intero di posti
    // fuori, quelli dopo sono ancora più fuori. Chi resta (solo una comitiva
    // enorme, un errore di battitura) sta sul bordo, il più vicino possibile.
    let k = 0;
    let missed = 0;
    while (next < queue.length && missed < ring.length) {
      const p = behind(k++);
      if (!room.inside(p.x, p.z)) {
        missed++;
        continue;
      }
      missed = 0;
      spots[queue[next++]] = { t: 0, where: 'stand', ...p };
    }
    while (next < queue.length) {
      const p = behind(k++);
      spots[queue[next++]] = { t: 0, where: 'stand', ...p, ...room.clamp(p.x, p.z) };
    }
  }

  // 4. Il seggiolone su un tondo: la sedia del bambino, se è al suo tavolo.
  if (hc && !u1Rect && youngest >= 0) {
    const s = spots[youngest];
    if (s && s.t === 0 && s.where === 'chair') u1.chairs[s.i] = { ...u1.chairs[s.i], high: true };
  }

  // Le persone, nell'ordine alternato originale (il più piccolo col
  // seggiolone tiene il suo posto nella lista).
  const tint = partyTint(partyId);
  const touched = new Set<number>();
  order.forEach((m, idx) => {
    const s = spots[idx];
    if (!s) return;
    const w = work[s.t];
    touched.add(s.t);
    const base = {
      key: figureKey(partyId, m.kind, m.n),
      kind: m.kind,
      partyId,
      tableId: w.table.id,
      tint: m.kind === 'kid' ? Math.min(1, tint + KID_TINT) : tint,
    };
    if (s.where === 'stand') {
      plan.figures.push({ ...base, pose: 'standing', x: s.x, z: s.z, yaw: s.yaw, seatHeight: 0 });
      return;
    }
    const chair = s.where === 'chair' ? w.chairs[s.i] : w.extra[s.i];
    if (s.where === 'chair') w.chairs[s.i] = { ...chair, lit: true };
    plan.figures.push({
      ...base,
      pose: 'seated',
      x: chair.x,
      z: chair.z,
      yaw: chair.yaw,
      seatHeight: chair.high ? HIGH_CHAIR_SEAT_HEIGHT : SEAT_HEIGHT,
    });
  });

  // I cani: il cane k accanto all'adulto k (o al primo adulto, o alla prima
  // persona), dalla parte esterna lungo il bordo, sdraiato parallelo al bordo
  // col muso lontano dal padrone. Un secondo cane dello stesso padrone va
  // dall'altra parte.
  const people = plan.figures.slice();
  const grownUps = people.filter(f => f.kind === 'adult');
  const dogsOf = new Map<FigureSlot, number>();
  for (let k = 0; k < dogs; k++) {
    const owner = k < grownUps.length ? grownUps[k] : grownUps[0] ?? people[0];
    if (!owner) break;
    const nth = dogsOf.get(owner) ?? 0;
    dogsOf.set(owner, nth + 1);
    const home = work.find(w => w.table.id === owner.tableId) ?? u1;
    const { cx, cz } = frameOf(home.table);
    const psi = owner.yaw;
    const fx = Math.sin(psi);
    const fz = Math.cos(psi);
    const sideX = Math.cos(psi);
    const sideZ = -Math.sin(psi);
    // Una sedia al centro del lato non ha una parte esterna: vale +1 (lì il
    // prodotto è solo rumore dei float, da cui EPS).
    const outer = (owner.x - cx) * sideX + (owner.z - cz) * sideZ < -EPS ? -1 : 1;
    const side = nth % 2 === 0 ? outer : -outer;
    // Dietro una sedia contro il muro il cane finirebbe nel muro: resta sul
    // pavimento, a ridosso.
    const spot = room.clamp(owner.x - fx * DOG_OUT + sideX * side * DOG_SIDE, owner.z - fz * DOG_OUT + sideZ * side * DOG_SIDE);
    plan.figures.push({
      key: figureKey(partyId, 'dog', k),
      kind: 'dog',
      pose: 'lying',
      x: spot.x,
      z: spot.z,
      yaw: wrapAngle(psi + (side * Math.PI) / 2),
      seatHeight: 0,
      partyId,
      tableId: owner.tableId,
      tint: 0,
    });
  }

  work.forEach((w, t) => {
    if (touched.has(t)) plan.tables.set(w.table.id, { chairs: w.chairs, extraChairs: w.extra });
  });
  return plan;
}

/** I tavoli su cui una comitiva di banchetto trabocca quando il suo non
 *  basta: gli altri tavoli del suo banchetto disegnati in questa sala, liberi
 *  (senza una prenotazione loro), nell'ordine del banchetto. Senza banchetto
 *  nessuno: la comitiva resta al suo tavolo (teste, anello, in piedi). */
export function spillTableIds(args: {
  ownTableId: number;
  /** Il banchetto del servizio con id === Number(r.banquet_menu_id). */
  banquet: BanquetMenu | null;
  /** Tavolo del gruppo → tavolo disegnato, solo in QUESTA sala. */
  drawnTableOf: ReadonlyMap<number, number>;
  /** I tavoli disegnati di questa sala liberi per chi trabocca. */
  available: ReadonlySet<number>;
}): number[] {
  const { ownTableId, banquet, drawnTableOf, available } = args;
  if (!banquet) return [];
  const ids: unknown[] = Array.isArray(banquet.table_ids) ? banquet.table_ids : [];
  const out: number[] = [];
  for (const raw of ids) {
    const id = drawnTableOf.get(Number(raw));
    if (id === undefined || id === ownTableId || out.includes(id) || !available.has(id)) continue;
    out.push(id);
  }
  return out;
}

// Sposta l'intervallo [lo, hi] dentro [min, max] tutto insieme; se non ci
// sta, lo centra (poi ogni posto si stringe da sé).
const shiftInto = (lo: number, hi: number, min: number, max: number): number => {
  if (min > max || hi - lo > max - min) return (min + max) / 2 - (lo + hi) / 2;
  if (lo < min) return min - lo;
  if (hi > max) return max - hi;
  return 0;
};

/** I sei posti dell'ingresso, nell'ordine in cui si riempiono: due file (1,2
 *  e 1,8 m dentro la porta) per tre colonne (0,9, 1,5 e 2,1 m di lato
 *  all'asse), dalla parte della porta lontana dal leggio, così chi aspetta non
 *  copre l'hostess. Contro un muro la griglia si sposta tutta insieme dentro
 *  il pavimento, a 30 cm dal bordo, invece di schiacciare i posti l'uno
 *  sull'altro. */
export function lobbyCells(room: Pick<RoomModel, 'floor' | 'markers'>): Vec2[] {
  const entrance = room?.markers?.ENTRANCE;
  const host = room?.markers?.HOST_STAND;
  const ex = finiteOr(entrance?.pos?.x, 0);
  const ez = finiteOr(entrance?.pos?.z, 0);
  const inX = finiteOr(entrance?.inward?.x, 0);
  const inZ = finiteOr(entrance?.inward?.z, -1);
  // La destra di chi è sulla porta e guarda dentro.
  const rightX = -inZ;
  const rightZ = inX;
  const toHost = (finiteOr(host?.pos?.x, ex) - ex) * rightX + (finiteOr(host?.pos?.z, ez) - ez) * rightZ;
  // Un leggio proprio sull'asse della porta non ha un lato: la destra.
  const side = toHost > EPS ? -1 : 1;
  const rows = Math.ceil(LOBBY_MAX_DRAWN / LOBBY_COLS);

  const raw: Vec2[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < LOBBY_COLS && raw.length < LOBBY_MAX_DRAWN; c++) {
      const into = LOBBY_IN + r * LOBBY_PITCH;
      const aside = side * (LOBBY_SIDE + c * LOBBY_PITCH);
      raw.push({ x: ex + inX * into + rightX * aside, z: ez + inZ * into + rightZ * aside });
    }
  }

  const width = Math.max(0, finiteOr(room?.floor?.width, 0));
  const depth = Math.max(0, finiteOr(room?.floor?.depth, 0));
  const xs = raw.map(p => p.x);
  const zs = raw.map(p => p.z);
  const dx = shiftInto(Math.min(...xs), Math.max(...xs), FLOOR_MARGIN, width - FLOOR_MARGIN);
  const dz = shiftInto(Math.min(...zs), Math.max(...zs), FLOOR_MARGIN, depth - FLOOR_MARGIN);
  return raw.map(p => ({
    x: clampInto(p.x + dx, FLOOR_MARGIN, width - FLOOR_MARGIN),
    z: clampInto(p.z + dz, FLOOR_MARGIN, depth - FLOOR_MARGIN),
  }));
}

/** Chi aspetta all'ingresso, in piedi sui posti di `cells` finché ce ne sono:
 *  le comitive nell'ordine dato (quello di presence), le persone alternate
 *  come a tavola, le stesse chiavi e tinte. Niente cani né seggioloni:
 *  all'ingresso si aspetta in piedi. */
export function lobbyFigures(
  parties: readonly { id: number; composition: PartyComposition }[],
  cells: readonly Vec2[],
  yaw: number,
): FigureSlot[] {
  const out: FigureSlot[] = [];
  const capacity = Math.min(LOBBY_MAX_DRAWN, Array.isArray(cells) ? cells.length : 0);
  for (const p of Array.isArray(parties) ? parties : []) {
    if (!p) continue;
    const tint = partyTint(p.id);
    for (const m of interleave(p.composition?.adults ?? 0, p.composition?.kids ?? 0)) {
      if (out.length >= capacity) return out;
      const cell = cells[out.length];
      out.push({
        key: figureKey(p.id, m.kind, m.n),
        kind: m.kind,
        pose: 'standing',
        x: cell.x,
        z: cell.z,
        yaw,
        seatHeight: 0,
        partyId: p.id,
        tableId: null,
        tint: m.kind === 'kid' ? Math.min(1, tint + KID_TINT) : tint,
      });
    }
  }
  return out;
}

/** Il posto dell'hostess: dietro il leggio per chi entra, cioè mezzo metro
 *  oltre il leggio sulla linea porta → leggio (presa lungo l'asse della sala
 *  più vicino, come si mette un mobile), rivolta alla porta col leggio
 *  davanti. Il verso viene dalla porta e non dal muro più vicino al leggio:
 *  un leggio posato a pari distanza da due muri la girerebbe di spalle alla
 *  porta per due pixel. Se porta e leggio coincidono, o quel posto finisce
 *  nel muro, mezzo metro dal leggio verso la sala (marker.inward), rivolta a
 *  lui. Il piano del leggio si inclina verso di lei (Fixtures.tsx). */
export function hostSpot(
  host: MarkerModel,
  entrance?: MarkerModel | null,
  floor?: RoomModel['floor'] | null,
): { x: number; z: number; yaw: number } {
  const hx = finiteOr(host?.pos?.x, 0);
  const hz = finiteOr(host?.pos?.z, 0);
  const dx = hx - finiteOr(entrance?.pos?.x, hx);
  const dz = hz - finiteOr(entrance?.pos?.z, hz);
  if (Math.abs(dx) > EPS || Math.abs(dz) > EPS) {
    const ax = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
    const az = ax === 0 ? Math.sign(dz) : 0;
    const x = hx + ax * HOST_SPOT_IN;
    const z = hz + az * HOST_SPOT_IN;
    // Mai −0 nell'atan2: darebbe −π invece di π per lo stesso verso.
    if (floorBox(floor).inside(x, z)) return { x, z, yaw: Math.atan2(ax === 0 ? 0 : -ax, az === 0 ? 0 : -az) };
  }
  const inX = finiteOr(host?.inward?.x, 0);
  const inZ = finiteOr(host?.inward?.z, -1);
  return {
    x: hx + inX * HOST_SPOT_IN,
    z: hz + inZ * HOST_SPOT_IN,
    yaw: Math.atan2(-inX, -inZ),
  };
}

/** L'hostess di una sala, all'accoglienza (posata o di ripiego). Senza nome:
 *  il nome arriva con PR3, dal personale in turno. */
export function hostessFigure(
  roomId: number,
  host: MarkerModel,
  entrance?: MarkerModel | null,
  floor?: RoomModel['floor'] | null,
): FigureSlot {
  return {
    key: `host:${roomId}`,
    kind: 'hostess',
    pose: 'standing',
    ...hostSpot(host, entrance, floor),
    seatHeight: 0,
    partyId: null,
    tableId: null,
    tint: 0,
  };
}
