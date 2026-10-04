import { TableShape } from '../types';

/* La geometria del glifo tavolo: misure, sedie, sedie accese. SOLO FRONTEND,
 * e senza React.
 *
 * Perché un modulo a sé: la piantina 2D (TableGlyph) e la Sala dal vivo in 3D
 * devono mettere le sedie negli STESSI punti e accendere le STESSE sedie, e
 * due copie delle formule prima o poi divergono. Qui ci sono i numeri — il
 * box, il piano, le sedie, calcolati una volta sola in getGlyphLayout — e
 * TableGlyph li disegna. Anche tableOverlap, tableLayout e labelPlacement
 * leggono da qui le misure del glifo, così non si tirano dietro un componente.
 *
 * Tutto è in px nel box del glifo (origine in alto a sinistra), lo stesso
 * spazio di table.x / table.y. La forma si confronta in modo esatto, come fa
 * il disegno: un 'circle' minuscolo ereditato dal seed esce rettangolare
 * anche qui.
 */

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

export const GLYPH = {
  PITCH,
  CHAIR_W,
  CHAIR_H,
  CHAIR_R,
  GAP,
  BODY_H,
  BODY_R,
  NAME_FONT_SIZE,
  DIMMED_CHAIR_OPACITY,
} as const;

/** Le misure del glifo, in un posto solo: le leggono getGlyphDimensions,
 *  getChairSlots, litChairIndices e il disegno di TableGlyph.
 *
 * - `circle`: il box è un quadrato di lato `width`; il piano ha centro
 *   (`cx`, `cy`) e raggio `r`, e le sedie stanno a `chairDist` dal centro.
 * - `rect` (rettangolo e quadrato): il piano è il rettangolo `bodyX`, `bodyY`,
 *   `bodyW` × GLYPH.BODY_H; le sedie sono `topChairs` sul lato sopra e
 *   `botChairs` su quello sotto.
 *
 * Le espressioni sono quelle che la piantina ha sempre usato, operazione per
 * operazione: il SVG ne stampa i numeri così come escono.
 */
export type GlyphLayout =
  | { kind: 'circle'; width: number; height: number; cx: number; cy: number; r: number; chairDist: number }
  | { kind: 'rect'; width: number; height: number; bodyX: number; bodyY: number; bodyW: number; topChairs: number; botChairs: number };

export function getGlyphLayout(shape: TableShape, seats: number): GlyphLayout {
  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(74, 34 + seats * 10);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    return { kind: 'circle', width: size, height: size, cx: size / 2, cy: size / 2, r, chairDist };
  }
  // Rettangolo e quadrato: le sedie solo sui due lati lunghi, il lato sopra
  // prende quella in più quando i posti sono dispari.
  const topChairs = Math.ceil(seats / 2);
  const botChairs = Math.floor(seats / 2);
  const maxChairs = Math.max(topChairs, botChairs);
  const bodyW = Math.max(64, maxChairs * PITCH + 16);
  const bodyX = 12;
  const bodyY = CHAIR_H + GAP + 2;
  const svgW = bodyW + 24;
  const svgH = bodyY + BODY_H + GAP + CHAIR_H + 2;
  return { kind: 'rect', width: svgW, height: svgH, bodyX, bodyY, bodyW, topChairs, botChairs };
}

export function getGlyphDimensions(shape: TableShape, seats: number) {
  const { width, height } = getGlyphLayout(shape, seats);
  return { width, height };
}

/** Una sedia del glifo.
 *
 * - `index`: l'ordine in cui la piantina le disegna. Tondo: l'anello, dalla
 *   sedia a ore 12 in senso orario. Rettangolo e quadrato: prima il lato
 *   sopra da sinistra a destra, poi quello sotto, sempre da sinistra.
 * - `edge`, `i`: il lato e la posizione sul lato (sull'anello `i` = `index`).
 * - `cx`, `cy`: il centro della sedia nel box del glifo, prima della rotazione.
 * - `rotDeg`: la rotazione della sedia in gradi, in senso orario come in SVG.
 *   A 0 è orientata come una sedia sopra il tavolo: distesa in orizzontale,
 *   col tavolo sotto. Sul lato sotto del rettangolo vale 180: la piantina non
 *   la ruota (il rettangolo arrotondato è simmetrico), ma in 3D lo schienale
 *   deve stare dalla parte opposta al tavolo.
 * - `nx`, `ny`: il versore dalla sedia verso il tavolo, cioè (−sin θ, cos θ)
 *   con θ = `rotDeg`: è il verso in cui guarda chi ci si siede.
 */
export type ChairSlot = {
  index: number;
  edge: 'top' | 'bottom' | 'ring';
  i: number;
  cx: number;
  cy: number;
  rotDeg: number;
  nx: number;
  ny: number;
};

/** Le sedie del glifo, nell'ordine in cui TableGlyph le disegna.
 *
 * Le espressioni sono quelle del disegno, operazione per operazione: il SVG
 * della piantina ne stampa i numeri così come escono, e un ordine diverso dei
 * calcoli cambierebbe l'ultima cifra dei decimali. Array.from con `length`
 * come prima, perché tratti nello stesso modo anche un numero di posti strano.
 */
export function getChairSlots(shape: TableShape, seats: number): ChairSlot[] {
  const layout = getGlyphLayout(shape, seats);
  if (layout.kind === 'circle') {
    const { cx, cy, chairDist } = layout;
    return Array.from({ length: seats }, (_, i): ChairSlot => {
      // Sedia 0 a ore 12, poi in senso orario.
      const angle = (2 * Math.PI * i) / seats - Math.PI / 2;
      return {
        index: i,
        edge: 'ring',
        i,
        cx: cx + chairDist * Math.cos(angle),
        cy: cy + chairDist * Math.sin(angle),
        rotDeg: (angle * 180) / Math.PI + 90,
        nx: -Math.cos(angle),
        ny: -Math.sin(angle),
      };
    });
  }

  const { topChairs, botChairs, bodyX, bodyY, bodyW } = layout;
  const top = Array.from({ length: topChairs }, (_, i): ChairSlot => {
    const span = (topChairs - 1) * PITCH;
    const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
    return { index: i, edge: 'top', i, cx: sx, cy: bodyY - GAP - CHAIR_H / 2, rotDeg: 0, nx: 0, ny: 1 };
  });
  const bottom = Array.from({ length: botChairs }, (_, i): ChairSlot => {
    const span = (botChairs - 1) * PITCH;
    const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
    return { index: top.length + i, edge: 'bottom', i, cx: sx, cy: bodyY + BODY_H + GAP + CHAIR_H / 2, rotDeg: 180, nx: 0, ny: -1 };
  });
  return [...top, ...bottom];
}

/** Gli `index` delle sedie accese per una comitiva di `party` persone, in
 *  ordine crescente: le stesse che la piantina disegna piene. */
export function litChairIndices(shape: TableShape, seats: number, party: number): number[] {
  // How many chairs render lit. A free table (or one with no party data) keeps
  // every chair at full weight; otherwise only `party` chairs (capped at the
  // table's capacity) stay lit and the remaining seats dim.
  const litCount = party > 0 ? Math.min(party, seats) : seats;
  const layout = getGlyphLayout(shape, seats);
  const slots = getChairSlots(shape, seats);
  if (layout.kind === 'circle') {
    return slots.filter((s) => s.index < litCount).map((s) => s.index);
  }
  // Spread the lit chairs balanced across the two edges (top gets the spare on
  // odd counts), each edge filling left-to-right.
  const litTop = Math.min(layout.topChairs, Math.ceil(litCount / 2));
  const litBot = litCount - litTop;
  return slots.filter((s) => s.i < (s.edge === 'top' ? litTop : litBot)).map((s) => s.index);
}
