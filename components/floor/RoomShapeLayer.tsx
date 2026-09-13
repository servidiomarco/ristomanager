import React from 'react';
import type { RoomPlan, RoomPlanElement } from '../../types';
import { PX_PER_CM } from './roomGeometry';

// Il «fabric» della sala: pavimento, muri perimetrali ed elementi fissi.
// Un solo SVG grande quanto la stanza, memoizzato, senza pointer events nei
// modi di sola lettura — i tavoli (HTML) gli passano sopra. Gli elementi sono
// arredo, non stati né categorie: superfici neutre del design system
// (--ds-surface-row / --ds-border-strong), mai famiglie --tg-* o --ds-cat-*.

const WALL_CM = 12;

const cm = (v: number) => v * PX_PER_CM;

function ElementShape({ el }: { el: RoomPlanElement }) {
  const x = cm(el.x_cm);
  const y = cm(el.y_cm);
  const w = cm(el.w_cm);
  const h = cm(el.h_cm);
  const rotate = el.rotation ? `rotate(${el.rotation} ${x + w / 2} ${y + h / 2})` : undefined;
  const label = el.label && el.kind !== 'label' ? (
    <text
      x={x + w / 2}
      y={y + h / 2 + 4}
      textAnchor="middle"
      style={{ fill: 'var(--ds-text-muted)', fontSize: 12, fontFamily: 'var(--font-sans)' }}
    >
      {el.label}
    </text>
  ) : null;

  switch (el.kind) {
    case 'wall':
      // Muro divisorio: pieno, come il perimetro.
      return <g transform={rotate}><rect x={x} y={y} width={w} height={h} rx={2} style={{ fill: 'var(--ds-border-strong)' }} /></g>;
    case 'column': {
      // Colonna: piena, tonda se il box è quadrato.
      const round = Math.abs(w - h) < 1;
      return (
        <g transform={rotate}>
          {round
            ? <circle cx={x + w / 2} cy={y + h / 2} r={w / 2} style={{ fill: 'var(--ds-border-strong)' }} />
            : <rect x={x} y={y} width={w} height={h} style={{ fill: 'var(--ds-border-strong)' }} />}
        </g>
      );
    }
    case 'door': {
      // Porta: varco nel muro + battente con arco a quarto di cerchio.
      // Cardine sul primo angolo del box, apertura verso l'interno del box.
      const r = Math.min(w, h) === h ? w : h;
      return (
        <g transform={rotate}>
          <rect x={x} y={y} width={w} height={h} style={{ fill: 'var(--ds-surface-base)' }} />
          <path
            d={`M ${x} ${y} L ${x} ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y}`}
            fill="none"
            style={{ stroke: 'var(--ds-border-strong)' }}
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
          <line x1={x} y1={y} x2={x} y2={y + r} style={{ stroke: 'var(--ds-border-strong)' }} strokeWidth={3} />
        </g>
      );
    }
    case 'window':
      // Finestra: segno sottile sul muro, tratteggio leggero.
      return (
        <g transform={rotate}>
          <rect x={x} y={y} width={w} height={h} style={{ fill: 'var(--ds-surface-base)' }} />
          <line x1={x} y1={y + h / 2} x2={x + w} y2={y + h / 2} style={{ stroke: 'var(--ds-border-strong)' }} strokeWidth={2} />
        </g>
      );
    case 'stairs': {
      // Scala: gradini come linee parallele dentro il box.
      const steps = Math.max(3, Math.floor(w / 25));
      return (
        <g transform={rotate}>
          <rect x={x} y={y} width={w} height={h} rx={4} style={{ fill: 'var(--ds-surface-row)', stroke: 'var(--ds-border-strong)' }} strokeWidth={1.5} />
          {Array.from({ length: steps - 1 }, (_, i) => {
            const sx = x + ((i + 1) * w) / steps;
            return <line key={i} x1={sx} y1={y} x2={sx} y2={y + h} style={{ stroke: 'var(--ds-border-strong)' }} strokeWidth={1} opacity={0.6} />;
          })}
          {label}
        </g>
      );
    }
    case 'plant': {
      // Pianta: decorativa, cerchio morbido.
      const r = Math.min(w, h) / 2;
      return (
        <g transform={rotate}>
          <circle cx={x + w / 2} cy={y + h / 2} r={r} style={{ fill: 'var(--ds-surface-row)', stroke: 'var(--ds-border-strong)' }} strokeWidth={1.5} strokeDasharray="3 3" />
          <circle cx={x + w / 2} cy={y + h / 2} r={r * 0.45} style={{ fill: 'var(--ds-border-strong)' }} opacity={0.5} />
        </g>
      );
    }
    case 'label':
      return (
        <text
          x={x + w / 2}
          y={y + h / 2 + 4}
          textAnchor="middle"
          transform={rotate}
          style={{ fill: 'var(--ds-text-muted)', fontSize: 13, fontFamily: 'var(--font-sans)', fontWeight: 500 }}
        >
          {el.label ?? ''}
        </text>
      );
    case 'bar':
    case 'cashier':
    default:
      // Bancone, cassa e affini: superficie con bordo forte e nome dentro.
      return (
        <g transform={rotate}>
          <rect x={x} y={y} width={w} height={h} rx={8} style={{ fill: 'var(--ds-surface-row)', stroke: 'var(--ds-border-strong)' }} strokeWidth={1.5} />
          {label}
        </g>
      );
  }
}

interface RoomShapeLayerProps {
  plan: RoomPlan;
  interactive?: boolean;
}

export const RoomShapeLayer: React.FC<RoomShapeLayerProps> = React.memo(({ plan, interactive }) => {
  const w = cm(plan.width_cm);
  const h = cm(plan.height_cm);

  const floorPath = plan.perimeter && plan.perimeter.length >= 3
    ? `M ${plan.perimeter.map(p => `${cm(p.x_cm)} ${cm(p.y_cm)}`).join(' L ')} Z`
    : null;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="absolute left-0 top-0"
      style={interactive ? undefined : { pointerEvents: 'none' }}
      aria-hidden
    >
      {/* Pavimento + muri perimetrali: il muro è lo stroke del pavimento,
          centrato sul bordo — a 12cm di spessore mezza lastra sborda fuori
          dalla stanza, come in una planimetria vera. */}
      {floorPath ? (
        <path d={floorPath} style={{ fill: 'var(--ds-surface-row)', stroke: 'var(--ds-border-strong)' }} strokeWidth={WALL_CM * PX_PER_CM} strokeLinejoin="miter" />
      ) : (
        <rect x={0} y={0} width={w} height={h} style={{ fill: 'var(--ds-surface-row)', stroke: 'var(--ds-border-strong)' }} strokeWidth={WALL_CM * PX_PER_CM} />
      )}
      {plan.elements.map(el => <ElementShape key={el.id} el={el} />)}
    </svg>
  );
});
RoomShapeLayer.displayName = 'RoomShapeLayer';
