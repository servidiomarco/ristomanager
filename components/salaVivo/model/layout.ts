import { TableShape, type FloorMarker, type FloorMarkerKind, type Room, type Table, type TableMerge } from '../../../types';
import { buildMergeGroups } from '../../comande/tablesView';
import { getGlyphDimensions } from '../../../utils/tableGeometry';
import { applyMerges } from '../../../utils/tableMerge';
import type { RoomAudit, Vec2 } from '../types';
import { finiteOr, seatCount } from './geometry';

/* Che cosa si disegna in una sala, e dove: tavoli, unioni, segnaposto, i
 * controlli sulla disposizione. Tutto in px della tela della sala, lo stesso
 * spazio di tables.x/y; i metri li fa sceneModel.
 *
 * Dal #801 la piantina disegna sempre le posizioni salvate, e la 3D fa lo
 * stesso: le due viste vanno d'accordo per costruzione. Una sala mai disposta
 * (tavoli impilati dove sono nati) resta impilata anche qui, con un avviso
 * per chi la può sistemare: una griglia solo in 3D romperebbe l'accordo. */

/* Le unioni si disegnano come in 2D: un tavolo solo, al posto del capofila,
 * col nome unito e i posti sommati (decisione di Tina, 4 ottobre). I tavoli
 * uniti in sala sono spinti l'uno contro l'altro, ma l'editor non li lascia
 * posare a contatto: anche accostati quanto si può, ognuno al suo posto
 * restavano a 1,3 m (affiancati) o 3,2 m (uno sopra l'altro), e una tavolata
 * da dieci si vedeva seduta di qua e di là da un corridoio che non c'è. */

/** Il margine oltre l'ultimo tavolo o segnaposto, come la piantina. */
export const EXTENT_PAD_PX = 60;

const DEFAULT_ROOM_W = 800;
const DEFAULT_ROOM_H = 600;
// Chip ed etichetta di un segnaposto sporgono a destra e sotto il centro:
// gli stessi numeri con cui la piantina allarga la sala.
const MARKER_RIGHT_PX = 40;
const MARKER_BOTTOM_PX = 60;
// Entro 1 m da un bordo un segnaposto è «sul muro», e guarda dentro dritto.
const EDGE_SNAP_PX = 50;
// I ripieghi: ingresso a metà del bordo verso la camera, pass nell'angolo in
// alto a destra, accoglienza un passo dentro e a destra di chi entra.
const ENTRANCE_INSET_PX = 20;
const PASS_INSET_PX = 60;
const HOST_IN_PX = 60;
const HOST_SIDE_PX = 40;
// Due sagome che si toccano soltanto non si sovrappongono: il rumore dei
// float di una rotazione (cos 90° ≈ 6e-17) non deve far nascere un avviso.
const TOUCH_EPS = 0.01;

/** L'ordine dei segnaposto: anche quello di `audit.missingMarkers`. */
export const MARKER_KINDS: readonly FloorMarkerKind[] = ['ENTRANCE', 'PASS', 'HOST_STAND'];

export interface LayoutUnit {
  /** Il tavolo fisico, o il capofila di applyMerges (nome unito, posti
   *  sommati) per un'unione disegnata alla maniera della 2D. Coi campi
   *  numerici già letti con prudenza. */
  table: Table;
  /** [capofila, ...uniti] per un'unione, se no [table.id]. */
  groupIds: number[];
}

export interface MarkerPx {
  /** Il centro, in px della sala. */
  x: number;
  y: number;
  placed: boolean;
  /** Il versore verso l'interno, già negli assi del mondo ({x, z}). */
  inward: Vec2;
}

export interface RoomLayout {
  units: LayoutUnit[];
  /** Il pavimento: W × H px. */
  extentPx: { width: number; height: number };
  markersPx: Record<FloorMarkerKind, MarkerPx>;
  audit: RoomAudit;
}

// Una riga di tables con i numeri letti con prudenza: un x mancante o una
// stringa non devono mandare un tavolo in NaN.
const normalizeTable = (t: Table): Table => ({
  ...t,
  x: finiteOr(t.x, 0),
  y: finiteOr(t.y, 0),
  seats: seatCount(t.seats),
  rotation: finiteOr(t.rotation, 0),
});

// Le unioni lette con prudenza: buildMergeGroups e applyMerges spargono
// merged_ids, e un valore che non è un array farebbe cadere la pagina.
const normalizeMerges = (merges: readonly TableMerge[]): TableMerge[] => {
  const out: TableMerge[] = [];
  for (const m of Array.isArray(merges) ? merges : []) {
    const primary = Number(m?.primary_id);
    if (!Number.isInteger(primary) || !Array.isArray(m.merged_ids)) continue;
    const merged = m.merged_ids.map(Number).filter(id => Number.isInteger(id) && id !== primary);
    if (merged.length === 0) continue;
    out.push({ ...m, primary_id: primary, merged_ids: merged });
  }
  return out;
};

/* ── Sovrapposizioni su sagome orientate ──────────────────────────────────
   La piantina avvisa con box allineati agli assi più un margine e la fascia
   delle etichette: per lei è giusto, perché le etichette ci sono. Qui no:
   due vicini ruotati a 45° hanno box che si toccano e sagome lontane, e un
   avviso su una sala che va bene insegna a ignorare gli avvisi. Quindi il
   rettangolo del glifo ruotato col tavolo, il tondo come un disco. */

type Shape2D =
  | { kind: 'disc'; cx: number; cy: number; r: number }
  | { kind: 'rect'; cx: number; cy: number; hw: number; hh: number; c: number; s: number };

const shapeOf = (t: Table): Shape2D => {
  const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;
  if (t.shape === TableShape.CIRCLE) return { kind: 'disc', cx, cy, r: w / 2 };
  const th = ((t.rotation ?? 0) * Math.PI) / 180;
  return { kind: 'rect', cx, cy, hw: w / 2, hh: h / 2, c: Math.cos(th), s: Math.sin(th) };
};

type Rect2D = Extract<Shape2D, { kind: 'rect' }>;
type Disc2D = Extract<Shape2D, { kind: 'disc' }>;

// Gli assi del rettangolo nella tela: x locale = (c, s), y locale = (−s, c),
// la rotazione oraria del CSS con la y in basso.
const axesOf = (r: Rect2D): Array<[number, number]> => [[r.c, r.s], [-r.s, r.c]];

// Il raggio di proiezione di un rettangolo su un asse.
const projectedRadius = (r: Rect2D, ax: number, ay: number): number =>
  r.hw * Math.abs(r.c * ax + r.s * ay) + r.hh * Math.abs(-r.s * ax + r.c * ay);

const rectsOverlap = (a: Rect2D, b: Rect2D): boolean => {
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const [ax, ay] of [...axesOf(a), ...axesOf(b)]) {
    const distance = Math.abs(dx * ax + dy * ay);
    if (distance >= projectedRadius(a, ax, ay) + projectedRadius(b, ax, ay) - TOUCH_EPS) return false;
  }
  return true;
};

const rectDiscOverlap = (r: Rect2D, d: Disc2D): boolean => {
  // Il centro del disco nel sistema del rettangolo, poi il punto del
  // rettangolo più vicino.
  const dx = d.cx - r.cx;
  const dy = d.cy - r.cy;
  const lx = dx * r.c + dy * r.s;
  const ly = -dx * r.s + dy * r.c;
  const qx = Math.max(-r.hw, Math.min(r.hw, lx));
  const qy = Math.max(-r.hh, Math.min(r.hh, ly));
  return Math.hypot(lx - qx, ly - qy) < d.r - TOUCH_EPS;
};

const shapesOverlap = (a: Shape2D, b: Shape2D): boolean => {
  if (a.kind === 'disc' && b.kind === 'disc') return Math.hypot(b.cx - a.cx, b.cy - a.cy) < a.r + b.r - TOUCH_EPS;
  if (a.kind === 'rect' && b.kind === 'rect') return rectsOverlap(a, b);
  return a.kind === 'rect' ? rectDiscOverlap(a, b as Disc2D) : rectDiscOverlap(b as Rect2D, a);
};

/** Le coppie di tavoli disegnati che si sovrappongono, per nome, nell'ordine
 *  dei tavoli. Un'unione è un tavolo solo, col suo ingombro intero: come
 *  l'avviso della piantina, che confronta i tavoli dopo applyMerges. */
export function overlappingPairs(units: readonly LayoutUnit[]): Array<[string, string]> {
  const shapes = units.map(u => shapeOf(u.table));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      if (shapesOverlap(shapes[i], shapes[j])) pairs.push([units[i].table.name, units[j].table.name]);
    }
  }
  return pairs;
}

/** Una sala mai disposta: almeno 3 tavoli e la posizione più comune ne tiene
 *  almeno la metà. I tavoli nuovi nascono tutti nello stesso punto, quindi
 *  è il segno che nessuno li ha mai spostati. */
export function isLayoutUnset(tables: readonly Pick<Table, 'x' | 'y'>[]): boolean {
  if (tables.length < 3) return false;
  const counts = new Map<string, number>();
  let best = 0;
  for (const t of tables) {
    const key = `${t.x},${t.y}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    best = Math.max(best, n);
  }
  return best * 2 >= tables.length;
}

/** Il versore verso l'interno della sala per un segnaposto in (x, y): verso il
 *  centro del pavimento, o dritto dentro se sta entro 1 m da un bordo (una
 *  porta sul muro guarda la sala, non il suo centro). A pari distanza vince
 *  il bordo basso, quello dell'ingresso di ripiego.
 *
 *  In basso e a destra il bordo si misura da dove finirebbe il pavimento se
 *  il segnaposto fosse la cosa più esterna della sala: la sala si allarga
 *  fino a chip ed etichetta più il margine (120 px sotto, 100 a destra), e
 *  misurato dal bordo vero un ingresso posato in fondo non sarebbe mai «sul
 *  muro». In alto e a sinistra il pavimento comincia sempre a 0. */
export function inwardAt(x: number, y: number, width: number, height: number): Vec2 {
  const edges: Array<[number, Vec2]> = [
    [height - y - MARKER_BOTTOM_PX - EXTENT_PAD_PX, { x: 0, z: -1 }],
    [y, { x: 0, z: 1 }],
    [x, { x: 1, z: 0 }],
    [width - x - MARKER_RIGHT_PX - EXTENT_PAD_PX, { x: -1, z: 0 }],
  ];
  let nearest = edges[0];
  for (const e of edges) if (e[0] < nearest[0]) nearest = e;
  if (nearest[0] <= EDGE_SNAP_PX) return { ...nearest[1] };
  const dx = width / 2 - x;
  const dz = height / 2 - y;
  const len = Math.hypot(dx, dz);
  return len > 1e-9 ? { x: dx / len, z: dz / len } : { x: 0, z: -1 };
}

const clampTo = (v: number, hi: number): number => Math.max(0, Math.min(hi, v));

/** La sala da disegnare: unità, pavimento, segnaposto e controlli. */
export function buildRoomLayout(args: {
  room: Room;
  tables: readonly Table[];
  merges: readonly TableMerge[];
  hiddenTableIds: ReadonlySet<number>;
  markers: readonly FloorMarker[];
}): RoomLayout {
  const { room, hiddenTableIds } = args;
  // Un id ripetuto (un evento arrivato due volte) è un tavolo solo: vale il
  // primo, come nella piantina.
  const seen = new Set<number>();
  const tables = (Array.isArray(args.tables) ? args.tables : [])
    .filter(t => !!t && !seen.has(t.id) && !!seen.add(t.id))
    .map(normalizeTable);
  const byId = new Map(tables.map(t => [t.id, t]));
  const merges = normalizeMerges(args.merges);
  const mergeByPrimary = new Map(merges.map(m => [m.primary_id, m]));

  // Il gruppo di ogni tavolo unito. Le unioni arrivano già del servizio
  // (data e turno), quindi il turno della chiave di buildMergeGroups non
  // serve più: si tiene l'id.
  const groupOf = new Map<number, number[]>();
  for (const [key, group] of buildMergeGroups(merges)) {
    groupOf.set(Number(key.slice(key.indexOf(':') + 1)), group);
  }

  const shownHere = (t: Table | undefined): t is Table =>
    !!t && t.room_id === room.id && !hiddenTableIds.has(t.id);

  // Come si disegna un'unione in questa sala, deciso una volta per capofila:
  // - 'alone': il capofila non c'è più fra i tavoli. In 2D nessun tavolo
  //   porta più l'unione, e i secondari tornano tavoli qualunque;
  // - 'none': il capofila è nascosto o in un'altra sala. In 2D l'unione
  //   sparisce col suo capofila (i secondari sono nascosti perché uniti),
  //   qui lo stesso;
  // - 'asOne': il capofila solo, come la 2D, col nome unito e i posti
  //   sommati; i secondari non si disegnano.
  type MergeMode = 'alone' | 'none' | 'asOne';
  const modeOf = (group: number[]): MergeMode => {
    const primaryId = group[0];
    if (!byId.has(primaryId)) return 'alone';
    return shownHere(byId.get(primaryId)) ? 'asOne' : 'none';
  };

  // Le unità, nell'ordine dei tavoli: lo stesso ordine a ogni ricalcolo.
  const units: LayoutUnit[] = [];
  for (const t of tables) {
    if (!shownHere(t)) continue;
    const group = groupOf.get(t.id);
    const mode = group ? modeOf(group) : 'alone';
    if (!group || mode === 'alone') {
      units.push({ table: t, groupIds: [t.id] });
    } else if (mode === 'asOne' && t.id === group[0]) {
      const merge = mergeByPrimary.get(t.id);
      const members = group.map(id => byId.get(id)).filter((m): m is Table => !!m);
      const primary = merge ? applyMerges(members, [merge]).find(m => m.id === t.id) : undefined;
      units.push({
        // Senza le misure in cm: sono del capofila da solo, e sul tavolo coi
        // posti sommati darebbero il piano di un tavolo sotto le sedie di
        // due, con quelle in più oltre i capi. Così il corpo si fa dai posti.
        table: primary ? { ...primary, seats: seatCount(primary.seats), width_cm: null, length_cm: null } : t,
        groupIds: group,
      });
    }
  }

  // Il pavimento: la sala salvata, allargata fino all'ultimo tavolo o
  // segnaposto più il margine. Box non ruotati, come la piantina.
  const roomW = finiteOr(room.width, 0) > 0 ? finiteOr(room.width, 0) : DEFAULT_ROOM_W;
  const roomH = finiteOr(room.height, 0) > 0 ? finiteOr(room.height, 0) : DEFAULT_ROOM_H;
  const placed = new Map<FloorMarkerKind, { x: number; y: number }>();
  for (const m of Array.isArray(args.markers) ? args.markers : []) {
    if (!m || m.room_id !== room.id || !MARKER_KINDS.includes(m.kind) || placed.has(m.kind)) continue;
    if (!Number.isFinite(m.x) || !Number.isFinite(m.y)) continue;
    placed.set(m.kind, { x: m.x, y: m.y });
  }
  let maxRight = 0;
  let maxBottom = 0;
  for (const u of units) {
    const { width: w, height: h } = getGlyphDimensions(u.table.shape, u.table.seats);
    maxRight = Math.max(maxRight, u.table.x + w);
    maxBottom = Math.max(maxBottom, u.table.y + h);
  }
  for (const p of placed.values()) {
    maxRight = Math.max(maxRight, p.x + MARKER_RIGHT_PX);
    maxBottom = Math.max(maxBottom, p.y + MARKER_BOTTOM_PX);
  }
  const width = Math.max(roomW, maxRight + EXTENT_PAD_PX);
  const height = Math.max(roomH, maxBottom + EXTENT_PAD_PX);

  // I segnaposto: quelli posati, se no il ripiego, che serve comunque alla
  // scena (gli ospiti entrano da una porta, l'hostess sta a un leggio).
  const missingMarkers: FloorMarkerKind[] = [];
  const markerAt = (x: number, y: number, isPlaced: boolean): MarkerPx =>
    ({ x, y, placed: isPlaced, inward: inwardAt(x, y, width, height) });

  const entrancePlaced = placed.get('ENTRANCE');
  if (!entrancePlaced) missingMarkers.push('ENTRANCE');
  const entrance = entrancePlaced
    ? markerAt(entrancePlaced.x, entrancePlaced.y, true)
    : markerAt(width / 2, height - ENTRANCE_INSET_PX, false);

  const passPlaced = placed.get('PASS');
  if (!passPlaced) missingMarkers.push('PASS');
  const pass = passPlaced
    ? markerAt(passPlaced.x, passPlaced.y, true)
    : markerAt(width - PASS_INSET_PX, PASS_INSET_PX, false);

  // L'accoglienza di ripiego: un passo dentro dall'ingresso e un po' alla
  // destra di chi entra guardando la sala, (−inward.z, inward.x): per la porta
  // sul bordo basso è +x, la destra anche di chi guarda la camera.
  const hostPlaced = placed.get('HOST_STAND');
  if (!hostPlaced) missingMarkers.push('HOST_STAND');
  const { inward } = entrance;
  const host = hostPlaced
    ? markerAt(hostPlaced.x, hostPlaced.y, true)
    : markerAt(
      clampTo(entrance.x + HOST_IN_PX * inward.x - HOST_SIDE_PX * inward.z, width),
      clampTo(entrance.y + HOST_IN_PX * inward.z + HOST_SIDE_PX * inward.x, height),
      false,
    );

  const visible = tables.filter(shownHere);
  return {
    units,
    extentPx: { width, height },
    markersPx: { ENTRANCE: entrance, PASS: pass, HOST_STAND: host },
    audit: {
      overlaps: overlappingPairs(units),
      unset: isLayoutUnset(visible),
      missingMarkers,
    },
  };
}
