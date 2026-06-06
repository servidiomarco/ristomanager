import { Table } from '../types';
import { getGlyphDimensions } from '../components/TableGlyph';

export interface AutoLayout {
  positions: Map<number, { x: number; y: number }>;
  width: number;
  height: number;
}

// Lay tables out into tidy flowing rows, sorted by table number. Pure +
// deterministic. Computed fresh at render time from the tables actually shown
// (after merges / hidden overrides), so every date stays neat regardless of how
// tables are merged that day. targetAspect (canvas width/height) shapes the
// block so it fills the available canvas.
export function computeAutoLayout(tables: Table[], targetAspect = 1.6): AutoLayout {
  const positions = new Map<number, { x: number; y: number }>();
  if (tables.length === 0) return { positions, width: 800, height: 600 };

  const ORIGIN_X = 32;
  const ORIGIN_Y = 32;
  const GUTTER_X = 56;     // horizontal space between cells
  const ROW_EXTRA = 150;   // capacity + name + covers·time stacked below the glyph
                           // inside the wrapped reservation card
  const ROW_GAP = 40;      // breathing room between rows
  const MIN_CELL_W = 230;  // floor so the wrapped card never reaches its neighbour
                           // (cell pitch ≥ card width + GUTTER_X)

  const sorted = [...tables].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );

  const cells = sorted.map(t => {
    const d = getGlyphDimensions(t.shape, t.seats);
    // Cell wide enough for the wrapped card (≈ glyph width + card padding),
    // floored at MIN_CELL_W so adjacent cards keep clear horizontally.
    return { id: t.id, gw: d.width, gh: d.height, w: Math.max(MIN_CELL_W, d.width + 56) };
  });

  // Wrap width that targets the canvas aspect (width/height): wider canvas →
  // wider rows that fill it.
  const totalW = cells.reduce((s, c) => s + c.w + GUTTER_X, 0);
  const avgCellH = cells.reduce((s, c) => s + c.gh + ROW_EXTRA + ROW_GAP, 0) / cells.length;
  const rows = Math.max(1, Math.round(Math.sqrt(totalW / (Math.max(0.4, targetAspect) * avgCellH))));
  const wrapWidth = totalW / rows;

  let x = ORIGIN_X;
  let y = ORIGIN_Y;
  let rowH = 0;
  let curRowWidth = 0;
  let maxRight = 0;
  let maxBottom = 0;

  for (const c of cells) {
    if (curRowWidth > 0 && curRowWidth + c.w > wrapWidth) {
      x = ORIGIN_X;
      y += rowH + ROW_EXTRA + ROW_GAP;
      rowH = 0;
      curRowWidth = 0;
    }
    // Center the glyph within its (possibly wider) cell.
    const gx = Math.round(x + (c.w - c.gw) / 2);
    positions.set(c.id, { x: gx, y });
    maxRight = Math.max(maxRight, gx + c.gw);
    maxBottom = Math.max(maxBottom, y + c.gh);
    x += c.w + GUTTER_X;
    curRowWidth += c.w + GUTTER_X;
    rowH = Math.max(rowH, c.gh);
  }

  return {
    positions,
    width: maxRight + ORIGIN_X,
    height: maxBottom + ROW_EXTRA + ORIGIN_Y,
  };
}
