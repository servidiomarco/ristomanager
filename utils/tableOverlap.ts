import { Table } from '../types';
import { getGlyphDimensions } from '../components/TableGlyph';
import type { TableDimensionsCm } from './tableDimensions';

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
 *
 * `real` (misure in cm, 1px = 1cm) arriva solo nelle sale con pianta: lì il
 * chiamante passa anche clearance/labelBand a 0, perché i tavoli veri possono
 * toccarsi e 78cm di corridoio riservato renderebbero impossibili i layout.
 */
export function getTableFootprint(
  table: Pick<Table, 'shape' | 'seats' | 'rotation'>,
  x: number,
  y: number,
  clearance = FLOOR_CLEARANCE,
  labelBand = FLOOR_LABEL_BAND,
  real?: TableDimensionsCm | null,
): Box {
  const { width: w, height: h } = getGlyphDimensions(table.shape, table.seats, real);
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
 * True se il footprint del tavolo tocca uno degli ostacoli (bancone, muri,
 * colonne della pianta reale). Gli ostacoli sono AABB già ruotati; il
 * footprint qui è quello nudo (niente clearance né banda): sulla pianta un
 * tavolo può accostarsi al muro, non entrarci dentro.
 */
export function footprintHitsObstacles(
  table: Pick<Table, 'shape' | 'seats' | 'rotation'>,
  x: number,
  y: number,
  obstacles: Box[],
  real?: TableDimensionsCm | null,
): boolean {
  if (obstacles.length === 0) return false;
  const a = getTableFootprint(table, x, y, 0, 0, real);
  return obstacles.some(o => boxesOverlap(a, o));
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
  opts?: { labelBand?: number; realFor?: (t: Table) => TableDimensionsCm | null; posFor?: (t: Table) => { x: number; y: number } },
): Table[] {
  const labelBand = opts?.labelBand ?? FLOOR_LABEL_BAND;
  const a = getTableFootprint(table, x, y, clearance, labelBand, opts?.realFor?.(table));
  const hits: Table[] = [];
  for (const o of others) {
    if (o.id === table.id) continue;
    // Nelle sale con pianta le posizioni vive sono x_cm/y_cm, non i legacy
    // x/y: il chiamante le risolve con posFor.
    const p = opts?.posFor?.(o) ?? { x: o.x, y: o.y };
    const b = getTableFootprint(o, p.x, p.y, clearance, labelBand, opts?.realFor?.(o));
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
  opts?: { labelBand?: number; realFor?: (t: Table) => TableDimensionsCm | null; posFor?: (t: Table) => { x: number; y: number } },
): Array<[Table, Table]> {
  const labelBand = opts?.labelBand ?? FLOOR_LABEL_BAND;
  const boxes = tables.map(t => {
    const p = opts?.posFor?.(t) ?? { x: t.x, y: t.y };
    return { t, box: getTableFootprint(t, p.x, p.y, clearance, labelBand, opts?.realFor?.(t)) };
  });
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
