import React, { useMemo } from 'react';
import type { Room, Table } from '../../types';
import { TableGlyph, getGlyphDimensions, type TableDisplayStatus } from '../TableGlyph';
import { RoomShapeLayer } from './RoomShapeLayer';
import { useFitScale } from './useFitScale';
import { useZoomPan } from './useZoomPan';
import { PX_PER_CM, roomHasPlan, realDimsFor, planGlyphBox, legacyCenterToCm, type Box } from './roomGeometry';

// La pianta condivisa: un solo renderer per Cassa, Reception e (a tendere)
// l'editor Sala, al posto delle quattro implementazioni che ricalcolavano
// ognuna la propria scala. Modello: wrapper con un unico transform
// translate+scale (quello di FloorPlan, il migliore dei quattro) e tre
// layer — fabric SVG (pavimento, muri, elementi), tavoli HTML (bottoni veri:
// aria, focus, disabled gratis), overlay in coordinate stanza via children.
//
// Con room.plan i tavoli si disegnano in scala reale (1px = 1cm) centrati su
// x_cm/y_cm; senza plan tutto è pixel-identico alle superfici storiche.

export interface RoomCanvasTableCtx {
  scale: number;
  box: Box;
  hasPlan: boolean;
}

interface RoomCanvasProps {
  room: Room | null;
  tables: Table[]; // già filtrati per sala e post-unioni/nascosti
  // Override delle posizioni (es. layout auto): top-left del glifo in px canvas.
  positions?: Map<number, { x: number; y: number }>;
  statusFor: (t: Table) => TableDisplayStatus;
  partyFor?: (t: Table) => number | undefined;
  selectedIds?: ReadonlySet<number>;
  onSelectTable?: (t: Table) => void;
  disabled?: boolean | ((t: Table) => boolean);
  // Contenuto extra per tavolo (importo in Cassa, badge in Reception),
  // renderizzato sotto il glifo dentro il bottone.
  renderTableExtras?: (t: Table, ctx: RoomCanvasTableCtx) => React.ReactNode;
  // Decorazione del wrapper attorno al glifo (halo ring, opacità, raggio):
  // il glifo resta com'è, il contesto attorno racconta lo stato della scelta.
  glyphDecorFor?: (t: Table, ctx: RoomCanvasTableCtx) => { className?: string; style?: React.CSSProperties } | null;
  // Overlay ancorati al box del glifo (badge «+N», caption): posizionati
  // absolute dentro il wrapper del glifo. Tutto dentro il transform scala con
  // la stanza — chi vuole testo a taglia schermo si counter-scala con ctx.scale.
  overlayFor?: (t: Table, ctx: RoomCanvasTableCtx) => React.ReactNode;
  buttonClassFor?: (t: Table) => string;
  titleFor?: (t: Table) => string;
  // Overlay in coordinate stanza (hull banchetti, card prenotazione).
  children?: React.ReactNode;
  maxScale?: number;
  margin?: number;
  emptyLabel?: string;
  // Pinch-zoom e pan: per le sale grandi sui palmari, dove il fit rende un
  // tavolo da 60 cm illeggibile. Un dito resta per i tap sui tavoli.
  zoomable?: boolean;
}

// Tocco minimo in pixel SCHERMO: sotto scala il bottone si allarga oltre il
// glifo per restare premibile (il glifo resta della sua taglia vera).
const MIN_TAP_PX = 44;

export const RoomCanvas: React.FC<RoomCanvasProps> = ({
  room,
  tables,
  positions,
  statusFor,
  partyFor,
  selectedIds,
  onSelectTable,
  disabled,
  renderTableExtras,
  glyphDecorFor,
  overlayFor,
  buttonClassFor,
  titleFor,
  children,
  maxScale = 1,
  margin = 16,
  emptyLabel,
  zoomable,
}) => {
  const hasPlan = roomHasPlan(room);
  const plan = room?.plan ?? null;

  // Box di ogni tavolo in coordinate canvas (px = cm nelle sale con pianta).
  const boxes = useMemo(() => {
    const map = new Map<number, Box>();
    for (const t of tables) {
      const override = positions?.get(t.id);
      if (hasPlan) {
        // Piazzato sulla pianta → centro reale; non ancora piazzato → si
        // ricava il centro dai legacy x/y così il tavolo non salta quando la
        // sala riceve la sua prima pianta.
        const placed = planGlyphBox(t);
        if (placed && !override) {
          map.set(t.id, placed);
          continue;
        }
        const real = realDimsFor(t);
        const { width, height } = getGlyphDimensions(t.shape, t.seats, real);
        if (override) {
          map.set(t.id, { x: override.x, y: override.y, w: width, h: height });
        } else {
          const center = legacyCenterToCm(t);
          map.set(t.id, { x: center.x_cm * PX_PER_CM - width / 2, y: center.y_cm * PX_PER_CM - height / 2, w: width, h: height });
        }
      } else {
        const { width, height } = getGlyphDimensions(t.shape, t.seats);
        const pos = override ?? { x: t.x, y: t.y };
        map.set(t.id, { x: pos.x, y: pos.y, w: width, h: height });
      }
    }
    return map;
  }, [tables, positions, hasPlan]);

  // Estensione del canvas: con la pianta comanda la stanza vera; senza, il
  // bounding box dei tavoli con il minimo storico della sala (le posizioni
  // possono uscire dal rettangolo nominale, vedi Veranda in Reception).
  const extent = useMemo(() => {
    if (plan) {
      return { width: plan.width_cm * PX_PER_CM, height: plan.height_cm * PX_PER_CM };
    }
    const PAD = 48;
    let maxRight = room?.width ?? 800;
    let maxBottom = room?.height ?? 600;
    for (const box of boxes.values()) {
      maxRight = Math.max(maxRight, box.x + box.w + PAD);
      maxBottom = Math.max(maxBottom, box.y + box.h + PAD);
    }
    return { width: maxRight, height: maxBottom };
  }, [plan, room, boxes]);

  const { containerRef, scale: fitScale, offset: fitOffset } = useFitScale(extent, { margin, maxScale });
  const zp = useZoomPan({
    enabled: !!zoomable,
    fitScale,
    fitOffset,
    extent,
    containerRef,
    resetKey: room?.id,
  });
  const scale = fitScale * zp.zoom;
  const offset = { x: fitOffset.x + zp.pan.x, y: fitOffset.y + zp.pan.y };

  if (!room) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[14px] text-[var(--ds-text-muted)]">
        {emptyLabel ?? 'Scegli una sala per vederne la piantina.'}
      </div>
    );
  }

  const isDisabled = (t: Table) => (typeof disabled === 'function' ? disabled(t) : !!disabled);

  return (
    <div ref={containerRef} className="relative h-full min-h-0 w-full overflow-hidden" {...zp.handlers}>
      <div
        className={hasPlan ? 'absolute left-0 top-0' : 'absolute left-0 top-0 rounded-[20px] bg-[var(--ds-surface-row)]'}
        style={{
          width: extent.width,
          height: extent.height,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transformOrigin: 'top left',
        }}
      >
        {plan && <RoomShapeLayer plan={plan} />}
        {tables.map(t => {
          const box = boxes.get(t.id)!;
          const real = hasPlan ? realDimsFor(t) : null;
          // Espansione dell'area di tocco in px canvas perché il TOCCO a
          // schermo non scenda mai sotto i 44px, glifo escluso dal ritocco.
          const ex = Math.max(0, (MIN_TAP_PX / scale - box.w) / 2);
          const ey = Math.max(0, (MIN_TAP_PX / scale - box.h) / 2);
          const ctx: RoomCanvasTableCtx = { scale, box, hasPlan };
          const decor = glyphDecorFor?.(t, ctx);
          return (
            <button
              key={t.id}
              type="button"
              onClick={onSelectTable ? () => onSelectTable(t) : undefined}
              disabled={isDisabled(t)}
              aria-label={`Tavolo ${t.name}`}
              title={titleFor?.(t)}
              className={`absolute flex flex-col items-center rounded-[16px] transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${buttonClassFor?.(t) ?? ''}`}
              style={{ left: box.x - ex, top: box.y - ey, width: box.w + ex * 2, paddingTop: ey, paddingBottom: ey }}
            >
              <div className={`relative ${decor?.className ?? ''}`} style={decor?.style}>
                <div style={t.rotation ? { transform: `rotate(${t.rotation}deg)` } : undefined}>
                  <TableGlyph
                    name={t.name}
                    seats={t.seats}
                    shape={t.shape}
                    status={statusFor(t)}
                    party={partyFor?.(t)}
                    isSelected={selectedIds?.has(t.id)}
                    widthCm={real?.w_cm}
                    lengthCm={real?.l_cm}
                  />
                </div>
                {overlayFor?.(t, ctx)}
              </div>
              {renderTableExtras?.(t, ctx)}
            </button>
          );
        })}
        {children}
      </div>
    </div>
  );
};
