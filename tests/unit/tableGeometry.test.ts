import { describe, it, expect } from 'vitest';
import { TableShape } from '../../types';
import { GLYPH, getGlyphDimensions, getGlyphLayout, getChairSlots, litChairIndices, type ChairSlot } from '../../utils/tableGeometry';

/* Il riferimento d'oro: le formule inline di components/TableGlyph.tsx PRIMA
 * che la geometria passasse in utils/tableGeometry (le «Fondamenta» della
 * Sala dal vivo), copiate qui com'erano. La piantina 2D disegnava esattamente
 * questi numeri (il passaggio è stato verificato byte per byte sul SVG), e la
 * Sala dal vivo mette le sedie 3D sugli stessi punti. Se qualcuno tocca la
 * geometria del glifo, questo file se ne accorge: va aggiornato a mano, di
 * proposito, insieme alla piantina.
 *
 * I confronti sono esatti (toBe), non approssimati: il SVG stampa i numeri
 * così come escono, e un ordine diverso delle operazioni cambierebbe l'ultima
 * cifra dei decimali sulla piantina. */
const PITCH = 26;
const CHAIR_W = 20;
const CHAIR_H = 11;
const GAP = 4;
const BODY_H = 66;

function goldenDimensions(shape: TableShape, seats: number) {
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

// Il piano come lo disegnava la piantina: centro e raggio del tondo, il
// rettangolo del piano e le sedie per lato di rettangolo e quadrato.
function goldenBody(shape: TableShape, seats: number) {
  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(74, 34 + seats * 10);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    const cx = size / 2;
    const cy = size / 2;
    return { kind: 'circle', width: size, height: size, cx, cy, r, chairDist };
  }
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

// Una sedia come la disegnava la piantina, nell'ordine dei <rect>: centro,
// rotazione (il tondo la ruota, rettangolo e quadrato no), lato e accesa/spenta.
type GoldenChair = { edge: 'top' | 'bottom' | 'ring'; cx: number; cy: number; rotDeg: number | null; lit: boolean };

function goldenChairs(shape: TableShape, seats: number, party?: number): GoldenChair[] {
  const litCount = party && party > 0 ? Math.min(party, seats) : seats;

  if (shape === TableShape.CIRCLE) {
    const diameter = Math.max(74, 34 + seats * 10);
    const r = diameter / 2;
    const chairDist = r + GAP + CHAIR_H / 2;
    const totalR = chairDist + CHAIR_H / 2 + 2;
    const size = Math.ceil(totalR * 2);
    const cx = size / 2;
    const cy = size / 2;
    return Array.from({ length: seats }, (_, i) => {
      const angle = (2 * Math.PI * i) / seats - Math.PI / 2;
      const chairCx = cx + chairDist * Math.cos(angle);
      const chairCy = cy + chairDist * Math.sin(angle);
      const rotDeg = (angle * 180) / Math.PI + 90;
      return { edge: 'ring' as const, cx: chairCx, cy: chairCy, rotDeg, lit: i < litCount };
    });
  }

  const topChairs = Math.ceil(seats / 2);
  const botChairs = Math.floor(seats / 2);
  const maxChairs = Math.max(topChairs, botChairs);
  const bodyW = Math.max(64, maxChairs * PITCH + 16);
  const bodyX = 12;
  const bodyY = CHAIR_H + GAP + 2;
  const litTop = Math.min(topChairs, Math.ceil(litCount / 2));
  const litBot = litCount - litTop;
  // Il <rect> si posava dall'angolo in alto a sinistra: il centro è mezza
  // sedia più in là e più in giù.
  const top = Array.from({ length: topChairs }, (_, i) => {
    const span = (topChairs - 1) * PITCH;
    const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
    const x = sx - CHAIR_W / 2;
    const y = bodyY - GAP - CHAIR_H;
    return { edge: 'top' as const, cx: x + CHAIR_W / 2, cy: y + CHAIR_H / 2, rotDeg: null, lit: i < litTop };
  });
  const bottom = Array.from({ length: botChairs }, (_, i) => {
    const span = (botChairs - 1) * PITCH;
    const sx = bodyX + bodyW / 2 - span / 2 + i * PITCH;
    const x = sx - CHAIR_W / 2;
    const y = bodyY + BODY_H + GAP;
    return { edge: 'bottom' as const, cx: x + CHAIR_W / 2, cy: y + CHAIR_H / 2, rotDeg: null, lit: i < litBot };
  });
  return [...top, ...bottom];
}

const SHAPES = [TableShape.RECTANGLE, TableShape.SQUARE, TableShape.CIRCLE];
const POSTI = Array.from({ length: 24 }, (_, k) => k + 1);

// Il centro del piano: per il tondo il centro del box; per rettangolo e
// quadrato il piano sta al centro del box anche lui (12 px di margine per
// lato in orizzontale, 17 in verticale), e il test lo verifica.
const centroDelBox = (shape: TableShape, seats: number) => {
  const { width, height } = getGlyphDimensions(shape, seats);
  return { x: width / 2, y: height / 2 };
};

describe('geometria del glifo — le costanti', () => {
  it('sono quelle che la piantina ha sempre usato', () => {
    expect(GLYPH).toEqual({
      PITCH: 26,
      CHAIR_W: 20,
      CHAIR_H: 11,
      CHAIR_R: 5,
      GAP: 4,
      BODY_H: 66,
      BODY_R: 15,
      NAME_FONT_SIZE: 22,
      DIMMED_CHAIR_OPACITY: 0.25,
    });
  });
});

describe('geometria del glifo — le misure', () => {
  it('getGlyphDimensions dà le misure di prima, per 1–24 posti e le tre forme', () => {
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        expect(getGlyphDimensions(shape, n), `${shape} da ${n}`).toEqual(goldenDimensions(shape, n));
      }
    }
  });

  it('getGlyphLayout dà il piano che la piantina disegna, e le stesse misure', () => {
    // TableGlyph disegna piano, alone e nome da qui: questo è il riferimento
    // anche per quei numeri, non solo per le sedie.
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        const layout = getGlyphLayout(shape, n);
        expect(layout, `${shape} da ${n}`).toEqual(goldenBody(shape, n));
        expect({ width: layout.width, height: layout.height }).toEqual(getGlyphDimensions(shape, n));
      }
    }
  });

  it('un rettangolo ha il piano al centro del box', () => {
    for (const shape of [TableShape.RECTANGLE, TableShape.SQUARE]) {
      for (const n of POSTI) {
        const { width, height } = getGlyphDimensions(shape, n);
        const bodyW = Math.max(64, Math.max(Math.ceil(n / 2), Math.floor(n / 2)) * PITCH + 16);
        expect(12 + bodyW / 2).toBe(width / 2);
        expect(17 + BODY_H / 2).toBe(height / 2);
      }
    }
  });
});

describe('geometria del glifo — le sedie', () => {
  it('stanno dove le disegnava la piantina, nello stesso ordine', () => {
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        const slots = getChairSlots(shape, n);
        const oro = goldenChairs(shape, n);
        expect(slots.length, `${shape} da ${n}`).toBe(oro.length);
        slots.forEach((s, k) => {
          const g = oro[k];
          expect(s.index, `${shape} da ${n}, sedia ${k}`).toBe(k);
          expect(s.edge).toBe(g.edge);
          expect(s.cx, `${shape} da ${n}, sedia ${k}: cx`).toBe(g.cx);
          expect(s.cy, `${shape} da ${n}, sedia ${k}: cy`).toBe(g.cy);
        });
      }
    }
  });

  it('il tondo le ruota come la piantina; il rettangolo 0 sopra e 180 sotto', () => {
    // La piantina non ruota le sedie di rettangolo e quadrato: il rettangolo
    // arrotondato è simmetrico e mezzo giro non lo cambia. Il 180 di sotto
    // serve alla 3D, dove lo schienale va dalla parte opposta al tavolo.
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        const oro = goldenChairs(shape, n);
        getChairSlots(shape, n).forEach((s, k) => {
          const atteso = oro[k].rotDeg ?? (s.edge === 'top' ? 0 : 180);
          expect(s.rotDeg, `${shape} da ${n}, sedia ${k}`).toBe(atteso);
        });
      }
    }
  });

  it('i lati: sopra ⌈n/2⌉ e sotto ⌊n/2⌋, da sinistra a destra; l\'anello ne ha n', () => {
    for (const n of POSTI) {
      for (const shape of [TableShape.RECTANGLE, TableShape.SQUARE]) {
        const slots = getChairSlots(shape, n);
        const sopra = slots.filter((s) => s.edge === 'top');
        const sotto = slots.filter((s) => s.edge === 'bottom');
        expect(sopra.length).toBe(Math.ceil(n / 2));
        expect(sotto.length).toBe(Math.floor(n / 2));
        expect(slots.length).toBe(n);
        // prima tutto il lato sopra, poi quello sotto
        expect(slots.map((s) => s.edge)).toEqual([...sopra.map(() => 'top'), ...sotto.map(() => 'bottom')]);
        for (const lato of [sopra, sotto]) {
          lato.forEach((s, i) => {
            expect(s.i).toBe(i);
            if (i > 0) expect(s.cx - lato[i - 1].cx).toBe(PITCH);
          });
        }
        // le sedie stanno a 7,5 e 92,5: mezza sedia fuori dal bordo, più lo stacco
        for (const s of sopra) expect(s.cy).toBe(7.5);
        for (const s of sotto) expect(s.cy).toBe(92.5);
      }
      const anello = getChairSlots(TableShape.CIRCLE, n);
      expect(anello.length).toBe(n);
      anello.forEach((s, k) => {
        expect(s.edge).toBe('ring');
        expect(s.i).toBe(k);
      });
      // la sedia 0 sta a ore 12, sopra il centro
      const c = centroDelBox(TableShape.CIRCLE, n);
      expect(anello[0].cx).toBeCloseTo(c.x, 12);
      expect(anello[0].cy).toBeLessThan(c.y);
      // e si gira in senso orario: la sedia 1 è a destra del centro (con
      // due posti sta a ore 6, sotto)
      if (n > 2) expect(anello[1].cx).toBeGreaterThan(c.x);
      if (n === 2) expect(anello[1].cy).toBeGreaterThan(c.y);
    }
  });

  it('i versori sono unitari, guardano il tavolo e concordano con rotDeg', () => {
    const verso = (s: ChairSlot) => ({ x: -Math.sin((s.rotDeg * Math.PI) / 180), y: Math.cos((s.rotDeg * Math.PI) / 180) });
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        const c = centroDelBox(shape, n);
        for (const s of getChairSlots(shape, n)) {
          expect(Math.hypot(s.nx, s.ny)).toBeCloseTo(1, 12);
          // verso il centro del tavolo: prodotto scalare positivo
          expect(s.nx * (c.x - s.cx) + s.ny * (c.y - s.cy)).toBeGreaterThan(0);
          // la stessa direzione che dice la rotazione
          const v = verso(s);
          expect(s.nx).toBeCloseTo(v.x, 12);
          expect(s.ny).toBeCloseTo(v.y, 12);
          // e dal centro della sedia, mezza sedia più lo stacco lungo il
          // versore, si arriva esattamente al bordo del piano
          const bordoX = s.cx + s.nx * (GAP + CHAIR_H / 2);
          const bordoY = s.cy + s.ny * (GAP + CHAIR_H / 2);
          if (shape === TableShape.CIRCLE) {
            const r = Math.max(74, 34 + n * 10) / 2;
            expect(s.nx).toBeCloseTo((c.x - s.cx) / Math.hypot(c.x - s.cx, c.y - s.cy), 12);
            expect(s.ny).toBeCloseTo((c.y - s.cy) / Math.hypot(c.x - s.cx, c.y - s.cy), 12);
            expect(Math.hypot(bordoX - c.x, bordoY - c.y)).toBeCloseTo(r, 9);
          } else {
            expect(s.nx).toBe(0);
            expect(s.ny).toBe(s.edge === 'top' ? 1 : -1);
            expect(bordoY).toBe(s.edge === 'top' ? 17 : 17 + BODY_H);
          }
        }
      }
    }
  });

  it('un \'circle\' minuscolo ereditato dal seed resta rettangolare, come sulla piantina', () => {
    const legacy = 'circle' as unknown as TableShape;
    for (const n of POSTI) {
      expect(getChairSlots(legacy, n)).toEqual(getChairSlots(TableShape.RECTANGLE, n));
      expect(getGlyphDimensions(legacy, n)).toEqual(getGlyphDimensions(TableShape.RECTANGLE, n));
      expect(getGlyphLayout(legacy, n)).toEqual(getGlyphLayout(TableShape.RECTANGLE, n));
      expect(litChairIndices(legacy, n, 1)).toEqual(litChairIndices(TableShape.RECTANGLE, n, 1));
    }
  });
});

describe('geometria del glifo — le sedie accese', () => {
  it('sono quelle che la piantina disegna piene, per comitive da 0 a n+2', () => {
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        for (let party = 0; party <= n + 2; party++) {
          const attese = goldenChairs(shape, n, party)
            .map((g, k) => (g.lit ? k : -1))
            .filter((k) => k >= 0);
          expect(litChairIndices(shape, n, party), `${shape} da ${n}, comitiva di ${party}`).toEqual(attese);
        }
      }
    }
  });

  it('anche per i valori storti che la piantina riceve: senza comitiva, negativa, decimale', () => {
    for (const shape of SHAPES) {
      for (const n of POSTI) {
        const tutte = goldenChairs(shape, n, undefined).map((_, k) => k);
        expect(litChairIndices(shape, n, 0)).toEqual(tutte);
        expect(litChairIndices(shape, n, -1)).toEqual(tutte);
        expect(litChairIndices(shape, n, Number.NaN)).toEqual(tutte);
        const mezza = goldenChairs(shape, n, 2.5).map((g, k) => (g.lit ? k : -1)).filter((k) => k >= 0);
        expect(litChairIndices(shape, n, 2.5), `${shape} da ${n}, comitiva di 2,5`).toEqual(mezza);
      }
    }
  });

  it('sul rettangolo si dividono fra i due lati, il lato sopra prende la dispari', () => {
    // 6 posti, 4 persone: due sopra e due sotto, da sinistra
    expect(litChairIndices(TableShape.RECTANGLE, 6, 4)).toEqual([0, 1, 3, 4]);
    // 6 posti, 3 persone: due sopra, una sotto
    expect(litChairIndices(TableShape.RECTANGLE, 6, 3)).toEqual([0, 1, 3]);
    // 5 posti (3 sopra, 2 sotto), comitiva piena
    expect(litChairIndices(TableShape.RECTANGLE, 5, 5)).toEqual([0, 1, 2, 3, 4]);
    // sul tondo, le prime in senso orario da ore 12
    expect(litChairIndices(TableShape.CIRCLE, 6, 4)).toEqual([0, 1, 2, 3]);
  });
});
