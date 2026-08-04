import React from 'react';
import { TableShape } from '../types';

// The six service states a table can display, as a narrative progression:
// libera (silence) → attesa/Prenotato (promise) → inarrivo (gentle urgency,
// the only animated state) → arrivato/Occupato (operational calm) →
// uscita (draining, turnover ahead) → back to libera. noshow is the rose
// off-ramp. Colors come from the --tg-{status}-* token families in index.css.
export type TableDisplayStatus = 'libera' | 'attesa' | 'inarrivo' | 'arrivato' | 'uscita' | 'noshow';

const PITCH = 26;
const CHAIR_W = 20;
const CHAIR_H = 11;
const CHAIR_R = 5;
const GAP = 4;
const BODY_H = 66;
const BODY_R = 15;
const NAME_FONT_SIZE = 22;

// Opacity applied to the empty chairs of an occupied table (capacity − party).
// Lit chairs render at full weight; tune this single value to taste.
const DIMMED_CHAIR_OPACITY = 0.25;

export function getGlyphDimensions(shape: TableShape, seats: number) {
  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(74, 34 + seats * 10);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    return { width: size, height: size };
  }
  const topChairs = Math.ceil(seats / 2);
  const maxChairs = Math.max(topChairs, Math.floor(seats / 2));
  const bodyW = Math.max(64, maxChairs * PITCH + 16);
  const svgW = bodyW + 24;
  const bodyY = CHAIR_H + GAP + 2;
  const svgH = bodyY + BODY_H + GAP + CHAIR_H + 2;
  return { width: svgW, height: svgH };
}

interface TableGlyphProps {
  name: string;
  seats: number;
  shape: TableShape;
  status: TableDisplayStatus;
  isSelected?: boolean;
  // Size of the seated/assigned party. On an occupied table, this many chairs
  // light up at full weight and the rest dim — purely visual occupancy feedback.
  party?: number;
  // When true, the glyph scales down to fit its container width (capped at its
  // natural size) — used inside the fixed-cell table pickers.
  fit?: boolean;
  // Override the chair colour (keeps body/name from `status`). Used by the
  // wrapped reservation card: white body + status-coloured chairs.
  chairColor?: string;
}

// Memoized: all props are scalars, and dozens of glyphs re-render on every
// hover/keystroke — and now on every useNow() minute tick — so unchanged
// tables should bail out instead of rebuilding their SVG tree.
export const TableGlyph: React.FC<TableGlyphProps> = React.memo(({ name, seats, shape, status, isSelected, party, fit, chairColor }) => {
  const bg = `var(--tg-${status}-bg)`;
  const st = `var(--tg-${status}-stroke)`;
  const ch = chairColor ?? `var(--tg-${status}-chair)`;
  const nm = `var(--tg-${status}-name)`;

  // How many chairs render lit. A free table (or one with no party data) keeps
  // every chair at full weight; otherwise only `party` chairs (capped at the
  // table's capacity) stay lit and the remaining seats dim.
  const litCount = party && party > 0 ? Math.min(party, seats) : seats;
  const chairOpacity = (index: number) => (index < litCount ? 1 : DIMMED_CHAIR_OPACITY);

  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(74, 34 + seats * 10);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    const cx = size / 2;
    const cy = size / 2;

    return (
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block"
        style={fit ? { width: '100%', height: 'auto', maxWidth: size, margin: '0 auto' } : undefined}>
        {isSelected && (
          <circle cx={cx} cy={cy} r={r + 3} fill="none" style={{ stroke: 'var(--ds-text-primary)' }} strokeWidth={2} />
        )}
        {status === 'inarrivo' && (
          <circle className="tg-pulse" cx={cx} cy={cy} r={r + 5}
            fill="none" style={{ stroke: 'var(--tg-inarrivo-accent)' }} strokeWidth={2.5} />
        )}
        <circle className="dark:hidden" cx={cx} cy={cy + 2} r={r} fill="#000" opacity={0.08} />
        <circle className="tg-body" cx={cx} cy={cy} r={r} style={{ fill: bg, stroke: st }} strokeWidth={1} />
        {Array.from({ length: seats }, (_, i) => {
          const angle = (2 * Math.PI * i) / seats - Math.PI / 2;
          const chairCx = cx + chairDist * Math.cos(angle);
          const chairCy = cy + chairDist * Math.sin(angle);
          const rotDeg = (angle * 180) / Math.PI + 90;
          return (
            <rect
              key={i}
              className="tg-chair"
              x={-CHAIR_W / 2} y={-CHAIR_H / 2}
              width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R}
              style={{ fill: ch }} opacity={chairOpacity(i)}
              transform={`translate(${chairCx},${chairCy}) rotate(${rotDeg})`}
            />
          );
        })}
        <text className="tg-name" x={cx} y={cy + 5.5} textAnchor="middle"
          style={{ fill: nm, fontSize: NAME_FONT_SIZE, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
      </svg>
    );
  }

  // Rectangle / Square
  const topChairs = Math.ceil(seats / 2);
  const botChairs = Math.floor(seats / 2);
  const maxChairs = Math.max(topChairs, botChairs);
  const bodyW = Math.max(64, maxChairs * PITCH + 16);
  const bodyX = 12;
  const bodyY = CHAIR_H + GAP + 2;
  const svgW = bodyW + 24;
  const svgH = bodyY + BODY_H + GAP + CHAIR_H + 2;

  // Spread the lit chairs balanced across the two edges (top gets the spare on
  // odd counts), each edge filling left-to-right.
  const litTop = Math.min(topChairs, Math.ceil(litCount / 2));
  const litBot = litCount - litTop;

  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="block"
      style={fit ? { width: '100%', height: 'auto', maxWidth: svgW, margin: '0 auto' } : undefined}>
      {isSelected && (
        <rect x={bodyX - 3} y={bodyY - 3} width={bodyW + 6} height={BODY_H + 6} rx={BODY_R + 3}
          fill="none" style={{ stroke: 'var(--ds-text-primary)' }} strokeWidth={2} />
      )}
      {status === 'inarrivo' && (
        <rect className="tg-pulse" x={bodyX - 5} y={bodyY - 5} width={bodyW + 10} height={BODY_H + 10} rx={BODY_R + 5}
          fill="none" style={{ stroke: 'var(--tg-inarrivo-accent)' }} strokeWidth={2.5} />
      )}
      <rect className="dark:hidden" x={bodyX} y={bodyY + 2.5} width={bodyW} height={BODY_H} rx={BODY_R} fill="#000" opacity={0.08} />
      <rect className="tg-body" x={bodyX} y={bodyY} width={bodyW} height={BODY_H} rx={BODY_R}
        style={{ fill: bg, stroke: st }} strokeWidth={1} />
      {Array.from({ length: topChairs }, (_, i) => {
        const span = (topChairs - 1) * PITCH;
        const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
        return (
          <rect key={`t${i}`} className="tg-chair" x={sx - CHAIR_W / 2} y={bodyY - GAP - CHAIR_H}
            width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R} style={{ fill: ch }} opacity={i < litTop ? 1 : DIMMED_CHAIR_OPACITY} />
        );
      })}
      {Array.from({ length: botChairs }, (_, i) => {
        const span = (botChairs - 1) * PITCH;
        const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
        return (
          <rect key={`b${i}`} className="tg-chair" x={sx - CHAIR_W / 2} y={bodyY + BODY_H + GAP}
            width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R} style={{ fill: ch }} opacity={i < litBot ? 1 : DIMMED_CHAIR_OPACITY} />
        );
      })}
      <text className="tg-name" x={bodyX + bodyW / 2} y={bodyY + BODY_H / 2 + 5.5} textAnchor="middle"
        style={{ fill: nm, fontSize: NAME_FONT_SIZE, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
    </svg>
  );
});
TableGlyph.displayName = 'TableGlyph';
