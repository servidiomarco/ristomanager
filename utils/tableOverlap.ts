import { Table } from '../types';
import { getGlyphDimensions } from '../components/TableGlyph';

// Floor-editor grid. Tables snap to this on drag, and the overlap clearance is
// half a cell — enough to keep adjacent tables from visually touching.
export const FLOOR_GRID = 20;
export const FLOOR_CLEARANCE = FLOOR_GRID / 2; // ~half a grid cell

// A reserved/occupied table renders a caption (covers + time) and a name pill
// BELOW the glyph. That band isn't part of the glyph bounds, so without
// reserving room for it a neighbour can sit underneath and get covered by the
// pill once the upper table is booked. Since any table can become the reserved
// one on a given day, we reserve this band below EVERY table. ~78px matches the
// caption + pill stack measured from the glyph's (rotation-aware) bottom edge.
export const FLOOR_LABEL_BAND = 78;

export interface Box { x: number; y: number; w: number; h: number; }

export function snapToGrid(v: number, grid = FLOOR_GRID): number {
  return Math.round(v / grid) * grid;
}

/**
 * Axis-aligned footprint for a table placed with its (unrotated) glyph box's
 * top-left at (x, y). The footprint is the rendered bounds (body + chair
 * overhang, from getGlyphDimensions) expanded to account for the table's
 * rotation, then inflated by `clearance` on every side. Rotation is about the
 * glyph box centre — matching how the glyph is rendered in FloorPlan.
 */
export function getTableFootprint(
  table: Pick<Table, 'shape' | 'seats' | 'rotation'>,
  x: number,
  y: number,
  clearance = FLOOR_CLEARANCE,
  labelBand = FLOOR_LABEL_BAND,
): Box {
  const { width: w, height: h } = getGlyphDimensions(table.shape, table.seats);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rad = ((table.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  // Bounding box of the rotated rectangle.
  const rw = w * cos + h * sin;
  const rh = w * sin + h * cos;
  // Clearance on all sides; plus the reserved label band below (the caption +
  // name pill render under the glyph, not rotated with it). Top/left/right keep
  // the normal clearance.
  const extraBottom = Math.max(0, labelBand - clearance);
  return {
    x: cx - rw / 2 - clearance,
    y: cy - rh / 2 - clearance,
    w: rw + clearance * 2,
    h: rh + clearance * 2 + extraBottom,
  };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * Returns the subset of `others` whose footprint overlaps `table` placed at
 * (x, y). `others` are tested at their own saved x/y. The table itself (by id)
 * is always skipped.
 */
export function collidesWithOthers(
  table: Table,
  x: number,
  y: number,
  others: Table[],
  clearance = FLOOR_CLEARANCE,
): Table[] {
  const a = getTableFootprint(table, x, y, clearance);
  const hits: Table[] = [];
  for (const o of others) {
    if (o.id === table.id) continue;
    const b = getTableFootprint(o, o.x, o.y, clearance);
    if (boxesOverlap(a, b)) hits.push(o);
  }
  return hits;
}

/**
 * All distinct colliding pairs within a set of tables (at their saved x/y).
 * Used at load time to flag layouts that were spaced before chairs existed.
 */
export function findOverlappingPairs(
  tables: Table[],
  clearance = FLOOR_CLEARANCE,
): Array<[Table, Table]> {
  const boxes = tables.map(t => ({ t, box: getTableFootprint(t, t.x, t.y, clearance) }));
  const pairs: Array<[Table, Table]> = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      if (boxesOverlap(boxes[i].box, boxes[j].box)) {
        pairs.push([boxes[i].t, boxes[j].t]);
      }
    }
  }
  return pairs;
}
