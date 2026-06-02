import React from 'react';
import { TableShape } from '../types';

export type TableDisplayStatus = 'libera' | 'attesa' | 'arrivato';

const PITCH = 16;
const CHAIR_W = 12;
const CHAIR_H = 7;
const CHAIR_R = 3;
const GAP = 2;
const BODY_H = 40;
const BODY_R = 9;

export function getGlyphDimensions(shape: TableShape, seats: number) {
  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(44, 20 + seats * 6);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    return { width: size, height: size };
  }
  const topChairs = Math.ceil(seats / 2);
  const maxChairs = Math.max(topChairs, Math.floor(seats / 2));
  const bodyW = Math.max(38, maxChairs * PITCH + 10);
  const svgW = bodyW + 16;
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
  // When true, the glyph scales down to fit its container width (capped at its
  // natural size) — used inside the fixed-cell table pickers.
  fit?: boolean;
}

export const TableGlyph: React.FC<TableGlyphProps> = ({ name, seats, shape, status, isSelected, fit }) => {
  const bg = `var(--tg-${status}-bg)`;
  const st = `var(--tg-${status}-stroke)`;
  const ch = `var(--tg-${status}-chair)`;
  const nm = `var(--tg-${status}-name)`;

  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(44, 20 + seats * 6);
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
          <circle cx={cx} cy={cy} r={r + 3} fill="none" style={{ stroke: 'var(--color-fg)' }} strokeWidth={2} />
        )}
        <circle className="dark:hidden" cx={cx} cy={cy + 2} r={r} fill="#000" opacity={0.08} />
        <circle cx={cx} cy={cy} r={r} style={{ fill: bg, stroke: st }} strokeWidth={1} />
        {Array.from({ length: seats }, (_, i) => {
          const angle = (2 * Math.PI * i) / seats - Math.PI / 2;
          const chairCx = cx + chairDist * Math.cos(angle);
          const chairCy = cy + chairDist * Math.sin(angle);
          const rotDeg = (angle * 180) / Math.PI + 90;
          return (
            <rect
              key={i}
              x={-CHAIR_W / 2} y={-CHAIR_H / 2}
              width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R}
              style={{ fill: ch }}
              transform={`translate(${chairCx},${chairCy}) rotate(${rotDeg})`}
            />
          );
        })}
        <text x={cx} y={cy + 4.5} textAnchor="middle"
          style={{ fill: nm, fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
      </svg>
    );
  }

  // Rectangle / Square
  const topChairs = Math.ceil(seats / 2);
  const botChairs = Math.floor(seats / 2);
  const maxChairs = Math.max(topChairs, botChairs);
  const bodyW = Math.max(38, maxChairs * PITCH + 10);
  const bodyX = 8;
  const bodyY = CHAIR_H + GAP + 2;
  const svgW = bodyW + 16;
  const svgH = bodyY + BODY_H + GAP + CHAIR_H + 2;

  return (
    <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="block"
      style={fit ? { width: '100%', height: 'auto', maxWidth: svgW, margin: '0 auto' } : undefined}>
      {isSelected && (
        <rect x={bodyX - 3} y={bodyY - 3} width={bodyW + 6} height={BODY_H + 6} rx={BODY_R + 3}
          fill="none" style={{ stroke: 'var(--color-fg)' }} strokeWidth={2} />
      )}
      <rect className="dark:hidden" x={bodyX} y={bodyY + 2.5} width={bodyW} height={BODY_H} rx={BODY_R} fill="#000" opacity={0.08} />
      <rect x={bodyX} y={bodyY} width={bodyW} height={BODY_H} rx={BODY_R}
        style={{ fill: bg, stroke: st }} strokeWidth={1} />
      {Array.from({ length: topChairs }, (_, i) => {
        const span = (topChairs - 1) * PITCH;
        const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
        return (
          <rect key={`t${i}`} x={sx - CHAIR_W / 2} y={bodyY - GAP - CHAIR_H}
            width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R} style={{ fill: ch }} />
        );
      })}
      {Array.from({ length: botChairs }, (_, i) => {
        const span = (botChairs - 1) * PITCH;
        const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
        return (
          <rect key={`b${i}`} x={sx - CHAIR_W / 2} y={bodyY + BODY_H + GAP}
            width={CHAIR_W} height={CHAIR_H} rx={CHAIR_R} style={{ fill: ch }} />
        );
      })}
      <text x={bodyX + bodyW / 2} y={bodyY + BODY_H / 2 + 4.5} textAnchor="middle"
        style={{ fill: nm, fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>{name}</text>
    </svg>
  );
};
