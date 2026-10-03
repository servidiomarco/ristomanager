import React from 'react';
import { TableShape } from '../types';
import { GLYPH, getChairSlots, getGlyphLayout, litChairIndices } from '../utils/tableGeometry';

// Misure, piano e sedie stanno in utils/tableGeometry, dove le legge anche la
// Sala dal vivo: qui resta il disegno, e nessun numero del glifo si ricalcola.
// getGlyphDimensions si riesporta perché FloorPlan, ReservationList,
// ReceptionPage e la Piantina di Cassa la prendono da qui.
export { getGlyphDimensions } from '../utils/tableGeometry';

// The six service states a table can display, as a narrative progression:
// libera (silence) → attesa/Prenotato (promise) → inarrivo (gentle urgency,
// the only animated state) → arrivato/Occupato (operational calm) →
// uscita (draining, turnover ahead) → back to libera. noshow is the rose
// off-ramp. Colors come from the --tg-{status}-* token families in index.css.
export type TableDisplayStatus = 'libera' | 'attesa' | 'inarrivo' | 'arrivato' | 'uscita' | 'noshow';

const { CHAIR_W, CHAIR_H, CHAIR_R, BODY_H, BODY_R, NAME_FONT_SIZE, DIMMED_CHAIR_OPACITY } = GLYPH;

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

  // Le sedie accese sono quelle della comitiva (tutte, a tavolo libero): la
  // regola sta in litChairIndices, la stessa che usa la Sala dal vivo.
  const layout = getGlyphLayout(shape, seats);
  const slots = getChairSlots(shape, seats);
  const lit = new Set(litChairIndices(shape, seats, party ?? 0));
  const chairOpacity = (index: number) => (lit.has(index) ? 1 : DIMMED_CHAIR_OPACITY);

  if (layout.kind === 'circle') {
    const { width: size, cx, cy, r } = layout;

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
        {slots.map((s) => (
          <rect
            key={s.index}
            className="tg-chair"
            x={-CHAIR_W / 2} y={-CHAIR_H / 2}
            width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R}
            style={{ fill: ch }} opacity={chairOpacity(s.index)}
            transform={`translate(${s.cx},${s.cy}) rotate(${s.rotDeg})`}
          />
        ))}
        <text className="tg-name" x={cx} y={cy + 5.5} textAnchor="middle"
          style={{ fill: nm, fontSize: NAME_FONT_SIZE, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
      </svg>
    );
  }

  // Rectangle / Square
  const { width: svgW, height: svgH, bodyX, bodyY, bodyW } = layout;

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
      {slots.map((s) => (
        <rect key={`${s.edge === 'top' ? 't' : 'b'}${s.i}`} className="tg-chair" x={s.cx - CHAIR_W / 2} y={s.cy - CHAIR_H / 2}
          width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R} style={{ fill: ch }} opacity={chairOpacity(s.index)} />
      ))}
      <text className="tg-name" x={bodyX + bodyW / 2} y={bodyY + BODY_H / 2 + 5.5} textAnchor="middle"
        style={{ fill: nm, fontSize: NAME_FONT_SIZE, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
    </svg>
  );
});
TableGlyph.displayName = 'TableGlyph';
