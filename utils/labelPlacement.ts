// Collision-aware placement of reservation cards and banquet labels on the
// floor-plan canvas. All coordinates are in the UNSCALED canvas space (the same
// space as table.x / table.y and getGlyphDimensions) — the caller renders the
// result inside the scaled transform wrapper, so this module is scale-agnostic.

import { TableShape } from '../types';
import { getGlyphDimensions } from '../components/TableGlyph';

export interface Box { x: number; y: number; w: number; h: number; }

export interface FloorTable {
  id: number;
  shape: TableShape;
  seats: number;
  rotation?: number | null;
  x: number;
  y: number;
}

export interface BanquetGroup {
  id: number;
  tableIds: number[]; // limited to tables present in the current room
}

export interface CardPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
  attached: boolean;            // directly below/above its anchor → no connector
  anchor: { x: number; y: number }; // table/hull edge point the card belongs to
}

export interface BanquetHull {
  banquetId: number;
  box: Box;
}

export interface FloorLabelsResult {
  hulls: BanquetHull[];
  reservationCards: Map<number, CardPlacement>;        // by tableId
  banquetLabels: Array<CardPlacement & { banquetId: number }>; // ONE per banquet
}

// --- Tunables --------------------------------------------------------------
export const CHIP_H = 26;             // capacity chip strip height below the table
export const CARD_H = 92;             // reservation card height (capacity + name + covers)
export const BANQUET_LABEL_H = 48;    // banquet event label height (1 line, bigger font)
const RES_CARD_MIN_W = 160;           // legible minimum card width
const RES_CARD_MAX_W = 260;
const GAP = 10;                       // gap between an anchor and its attached card
const NUDGE_STEP = 14;                // search increment when nudging
const MAX_NUDGE_RING = 28;            // how far the ring search goes
const PAD = 3;                        // extra clearance so things never touch
const CLUSTER_GAP = 48;              // max edge gap to merge banquet tables into one hull
const HULL_PAD = 12;                  // padding around a banquet cluster hull
const BANQUET_LABEL_MIN_W = 240;     // wide enough so event names don't truncate to "C..."
const BANQUET_LABEL_MAX_W = 380;

export function boxesOverlap(a: Box, b: Box, pad = 0): boolean {
  return (
    a.x < b.x + b.w + pad &&
    a.x + a.w + pad > b.x &&
    a.y < b.y + b.h + pad &&
    a.y + a.h + pad > b.y
  );
}

function rotatedGlyphBox(t: FloorTable): Box {
  const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
  const cx = t.x + w / 2;
  const cy = t.y + h / 2;
  const rad = ((t.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const rw = w * cos + h * sin;
  const rh = w * sin + h * cos;
  return { x: cx - rw / 2, y: cy - rh / 2, w: rw, h: rh };
}

// Physical footprint a card must avoid: the rotated glyph box plus the capacity
// chip strip that sits centred just below it.
export function tablePhysicalBox(t: FloorTable): Box {
  const g = rotatedGlyphBox(t);
  return { x: g.x, y: g.y, w: g.w, h: g.h + 6 + CHIP_H };
}

interface CardSpec {
  key: string;
  anchor: Box;          // box the card attaches below/above
  centerX: number;      // preferred horizontal centre (table/cluster centre)
  w: number;
  h: number;
  selected: boolean;
}

function placeOne(
  spec: CardSpec,
  obstacles: Box[],
  placed: Box[],
): CardPlacement {
  const left = spec.centerX - spec.w / 2;
  const collides = (box: Box) => {
    for (const o of obstacles) if (boxesOverlap(box, o, PAD)) return true;
    for (const p of placed) if (boxesOverlap(box, p, PAD)) return true;
    return false;
  };

  // 1) directly below (attached)
  let box: Box = { x: left, y: spec.anchor.y + spec.anchor.h + GAP, w: spec.w, h: spec.h };
  if (!collides(box)) {
    return { ...box, attached: true, anchor: { x: spec.centerX, y: spec.anchor.y + spec.anchor.h } };
  }

  // 2) directly above (attached)
  box = { x: left, y: spec.anchor.y - GAP - spec.h, w: spec.w, h: spec.h };
  if (!collides(box)) {
    return { ...box, attached: true, anchor: { x: spec.centerX, y: spec.anchor.y } };
  }

  // 3) nudge: expanding ring, prefer below band then above band, fan out sideways
  for (let r = 1; r <= MAX_NUDGE_RING; r++) {
    const vy = r * NUDGE_STEP;
    const bands = [
      spec.anchor.y + spec.anchor.h + GAP + vy, // below
      spec.anchor.y - GAP - spec.h - vy,        // above
    ];
    for (const by of bands) {
      for (let hx = 0; hx <= r; hx++) {
        const dxs = hx === 0 ? [0] : [hx * NUDGE_STEP, -hx * NUDGE_STEP];
        for (const dx of dxs) {
          box = { x: left + dx, y: by, w: spec.w, h: spec.h };
          if (!collides(box)) {
            const below = by > spec.anchor.y;
            return {
              ...box,
              attached: false,
              anchor: { x: spec.centerX, y: below ? spec.anchor.y + spec.anchor.h : spec.anchor.y },
            };
          }
        }
      }
    }
  }

  // Last resort (extremely dense): park it below, accept it may touch.
  return {
    x: left,
    y: spec.anchor.y + spec.anchor.h + GAP,
    w: spec.w,
    h: spec.h,
    attached: false,
    anchor: { x: spec.centerX, y: spec.anchor.y + spec.anchor.h },
  };
}

// Group a banquet's tables into proximity clusters (union-find by edge gap).
function clusterTables(tables: FloorTable[]): FloorTable[][] {
  const boxes = tables.map(rotatedGlyphBox);
  const parent = tables.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const gapX = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const gapY = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      if (gapX <= CLUSTER_GAP && gapY <= CLUSTER_GAP) union(i, j);
    }
  }
  const groups = new Map<number, FloorTable[]>();
  tables.forEach((t, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(t);
  });
  return [...groups.values()];
}

function hullBox(tables: FloorTable[]): Box {
  const boxes = tables.map(rotatedGlyphBox);
  // include the capacity chip strip below each table inside the hull
  const minX = Math.min(...boxes.map(b => b.x));
  const minY = Math.min(...boxes.map(b => b.y));
  const maxX = Math.max(...boxes.map(b => b.x + b.w));
  const maxY = Math.max(...boxes.map(b => b.y + b.h + 6 + CHIP_H));
  return {
    x: minX - HULL_PAD,
    y: minY - HULL_PAD,
    w: maxX - minX + HULL_PAD * 2,
    h: maxY - minY + HULL_PAD * 2,
  };
}

export function buildFloorLabels(opts: {
  tables: FloorTable[];               // every table in the room (resolved positions)
  reservationTableIds: number[];      // tables that should render a reservation card
  banquets: BanquetGroup[];           // banquets present (tableIds within this room)
  selectedTableId?: number | null;
  cardHeight?: number;
}): FloorLabelsResult {
  const cardH = opts.cardHeight ?? CARD_H;
  const byId = new Map(opts.tables.map(t => [t.id, t]));

  const obstacles: Box[] = opts.tables.map(tablePhysicalBox);

  // --- banquet hulls + labels ----------------------------------------------
  // One tinted hull per proximity cluster (so spread banquets read as one
  // event visually), but exactly ONE label per banquet — anchored to the
  // PRIMARY cluster (most tables, ties broken by area). Repeating the same
  // truncated pill over every cluster only added noise; the violet tint and
  // single legible label are enough to identify the event.
  const hulls: BanquetHull[] = [];
  const banquetLabelSpecs: CardSpec[] = [];
  const specKeyToBanquet = new Map<string, number>();
  for (const b of opts.banquets) {
    const memberTables = b.tableIds.map(id => byId.get(id)).filter((t): t is FloorTable => !!t);
    if (memberTables.length === 0) continue;
    const clusters = clusterTables(memberTables);
    const clusterBoxes = clusters.map(hullBox);
    for (const box of clusterBoxes) {
      obstacles.push(box);
      hulls.push({ banquetId: b.id, box });
    }
    // Pick the primary cluster: most tables, then largest area.
    let primaryIdx = 0;
    for (let i = 1; i < clusters.length; i++) {
      const a = clusters[primaryIdx];
      const c = clusters[i];
      const areaA = clusterBoxes[primaryIdx].w * clusterBoxes[primaryIdx].h;
      const areaC = clusterBoxes[i].w * clusterBoxes[i].h;
      if (c.length > a.length || (c.length === a.length && areaC > areaA)) {
        primaryIdx = i;
      }
    }
    const anchor = clusterBoxes[primaryIdx];
    const key = `b${b.id}`;
    specKeyToBanquet.set(key, b.id);
    const w = Math.min(BANQUET_LABEL_MAX_W, Math.max(BANQUET_LABEL_MIN_W, anchor.w));
    banquetLabelSpecs.push({
      key,
      anchor,
      centerX: anchor.x + anchor.w / 2,
      w,
      h: BANQUET_LABEL_H,
      selected: false,
    });
  }

  // --- reservation card specs ---------------------------------------------
  const resSpecs: CardSpec[] = [];
  for (const tid of opts.reservationTableIds) {
    const t = byId.get(tid);
    if (!t) continue;
    const { width: gw } = getGlyphDimensions(t.shape, t.seats);
    const phys = tablePhysicalBox(t);
    resSpecs.push({
      key: `t${tid}`,
      anchor: phys,
      centerX: t.x + gw / 2,
      w: Math.min(RES_CARD_MAX_W, Math.max(RES_CARD_MIN_W, gw)),
      h: cardH,
      selected: opts.selectedTableId === tid,
    });
  }

  // Place selected first, then banquet labels, then the rest top-to-bottom so
  // results are deterministic and the selected card claims its slot.
  const ordered = [...resSpecs, ...banquetLabelSpecs].sort((a, b) => {
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return a.anchor.y - b.anchor.y || a.anchor.x - b.anchor.x;
  });

  const placed: Box[] = [];
  const reservationCards = new Map<number, CardPlacement>();
  const banquetLabels: Array<CardPlacement & { banquetId: number }> = [];

  for (const spec of ordered) {
    const p = placeOne(spec, obstacles, placed);
    placed.push({ x: p.x, y: p.y, w: p.w, h: p.h });
    if (spec.key.startsWith('t')) {
      reservationCards.set(Number(spec.key.slice(1)), p);
    } else {
      banquetLabels.push({ ...p, banquetId: specKeyToBanquet.get(spec.key)! });
    }
  }

  return { hulls, reservationCards, banquetLabels };
}
