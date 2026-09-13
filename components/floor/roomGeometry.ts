// Geometria condivisa della pianta di sala. Tutto ciò che dentro room.plan è
// in centimetri diventa pixel del canvas attraverso PX_PER_CM — una costante
// di render, mai persistita. Con 1px = 1cm i numeri storici restano sensati:
// la griglia da 20px è uno snap da 20cm, la sala default 800×600 è un 8×6 m.

import { Room, Table } from '../../types';
import { getEffectiveDimensionsCm, TableDimensionsCm } from '../../utils/tableDimensions';
import { getGlyphDimensions } from '../TableGlyph';

export const PX_PER_CM = 1;

// Snap sulla pianta reale: 10 cm — abbastanza fine da seguire un muro,
// abbastanza grosso da tenere i tavoli allineati a occhio.
export const PLAN_GRID_CM = 10;

export interface Box { x: number; y: number; w: number; h: number; }

// La presenza del plan È il flag «questa sala è disegnata com'è davvero»:
// misure reali, coordinate x_cm/y_cm, layout manuale di default.
export function roomHasPlan(room: Pick<Room, 'plan'> | null | undefined): boolean {
  return !!room?.plan;
}

// Misure reali del tavolo (dal metro o stimate dai posti): è l'unico punto
// da cui il canvas le legge, così default e misure vere restano un solo path.
export function realDimsFor(table: Pick<Table, 'shape' | 'seats' | 'width_cm' | 'length_cm'>): TableDimensionsCm {
  return getEffectiveDimensionsCm(table);
}

/**
 * Box del glifo (in px canvas = cm) per un tavolo piazzato sulla pianta:
 * x_cm/y_cm sono il CENTRO del tavolo, il glifo però si disegna dal suo
 * top-left. null se il tavolo non è ancora stato piazzato (x_cm/y_cm NULL) —
 * il chiamante decide dove parcheggiarlo.
 */
export function planGlyphBox(table: Table): Box | null {
  if (table.x_cm == null || table.y_cm == null) return null;
  const real = realDimsFor(table);
  const { width, height } = getGlyphDimensions(table.shape, table.seats, real);
  return {
    x: table.x_cm * PX_PER_CM - width / 2,
    y: table.y_cm * PX_PER_CM - height / 2,
    w: width,
    h: height,
  };
}

/**
 * Conversione una-tantum px→cm quando una sala esistente riceve la sua prima
 * pianta: il centro del box legacy (x/y = top-left del glifo a taglia da
 * posti) diventa x_cm/y_cm, così i tavoli non si spostano visivamente.
 */
export function legacyCenterToCm(table: Table): { x_cm: number; y_cm: number } {
  const { width, height } = getGlyphDimensions(table.shape, table.seats);
  return {
    x_cm: Math.round((table.x + width / 2) / PX_PER_CM),
    y_cm: Math.round((table.y + height / 2) / PX_PER_CM),
  };
}

export function snapToPlanGrid(cm: number, grid = PLAN_GRID_CM): number {
  return Math.round(cm / grid) * grid;
}
