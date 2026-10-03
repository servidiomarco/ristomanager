import { describe, it, expect } from 'vitest';
import { TableShape, TableStatus, type Table } from '../../types';
import { getChairSlots, getGlyphDimensions, litChairIndices } from '../../utils/tableGeometry';
import {
  CHAIR_EDGE_MIN,
  M_PER_PX,
  placeTable,
  pxToWorld,
  rotateLocal,
  tableBody,
} from '../../components/salaVivo/model/geometry';

/* La geometria della Sala dal vivo: la piantina in metri.
 *
 * La promessa da tenere è una: chi guarda la 2D e poi la 3D riconosce lo
 * stesso tavolo sedia per sedia. Quindi le sedie stanno nei centri degli slot
 * del glifo scalati di M, ruotati come li ruota il CSS; solo un corpo più
 * profondo del disegno (misure in cm) le spinge fuori. */

const SHAPES = [TableShape.RECTANGLE, TableShape.SQUARE, TableShape.CIRCLE];
const POSTI = Array.from({ length: 24 }, (_, k) => k + 1);
const ROTAZIONI = [0, 30, 90, 135, 225, 315];

const tavolo = (over: Partial<Table> = {}): Table => ({
  id: 1,
  name: '1',
  shape: TableShape.RECTANGLE,
  seats: 4,
  x: 100,
  y: 200,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

// Lo slot del glifo come lo mette la piantina: centro del box più la
// rotazione del CSS (oraria con la y in basso), in px, poi in metri. È un
// conto indipendente da rotateLocal.
const slotNellaPiantina = (t: Table, cx: number, cy: number) => {
  const { width: w, height: h } = getGlyphDimensions(t.shape, t.seats);
  const th = ((t.rotation ?? 0) * Math.PI) / 180;
  const dx = cx - w / 2;
  const dy = cy - h / 2;
  const xPx = t.x + w / 2 + dx * Math.cos(th) - dy * Math.sin(th);
  const yPx = t.y + h / 2 + dx * Math.sin(th) + dy * Math.cos(th);
  return { x: xPx * M_PER_PX, z: yPx * M_PER_PX };
};

// La sedia nel sistema del tavolo (prima della rotazione), dal mondo.
const locale = (t: Table, c: { x: number; z: number }) => {
  const p = placeTable(t, t.seats, []);
  return rotateLocal(c.x - p.center.x, c.z - p.center.z, -(t.rotation ?? 0));
};

describe('dalla piantina al mondo', () => {
  it('un px vale 2 cm: X = x·M, Z = y·M', () => {
    expect(M_PER_PX).toBe(0.02);
    const p = pxToWorld(100, 250);
    expect(p.x).toBeCloseTo(2, 12);
    expect(p.z).toBeCloseTo(5, 12);
  });

  it('il centro del tavolo è il centro del box del glifo, anche centro di rotazione', () => {
    // Rettangolo da 4: box 92 × 100 px.
    const p = placeTable(tavolo(), 4, []);
    expect(p.center.x).toBeCloseTo((100 + 46) * 0.02, 12);
    expect(p.center.z).toBeCloseTo((200 + 50) * 0.02, 12);
    // Ruotato, il centro non si muove.
    const r = placeTable(tavolo({ rotation: 70 }), 4, []);
    expect(r.center).toEqual(p.center);
  });

  it('una rotazione di 90° porta il +x locale sul +Z del mondo', () => {
    const a = rotateLocal(1, 0, 90);
    expect(a.x).toBeCloseTo(0, 12);
    expect(a.z).toBeCloseTo(1, 12);
    // E il +z locale (in basso nella piantina) va a sinistra, −X: orario.
    const b = rotateLocal(0, 1, 90);
    expect(b.x).toBeCloseTo(-1, 12);
    expect(b.z).toBeCloseTo(0, 12);
  });

  it('rotY = −rotation·π/180 è la rotazione di rotateLocal per three.js', () => {
    // three.js ruota attorno a Y con R(φ) = [[cos φ, sin φ], [−sin φ, cos φ]]
    // sul piano (x, z): con φ = rotY deve dare lo stesso punto di rotateLocal.
    for (const rotation of ROTAZIONI) {
      const { rotY } = placeTable(tavolo({ rotation }), 4, []);
      expect(rotY).toBeCloseTo(-(rotation * Math.PI) / 180, 12);
      const [lx, lz] = [0.7, -0.3];
      const three = { x: lx * Math.cos(rotY) + lz * Math.sin(rotY), z: -lx * Math.sin(rotY) + lz * Math.cos(rotY) };
      const nostra = rotateLocal(lx, lz, rotation);
      expect(three.x).toBeCloseTo(nostra.x, 12);
      expect(three.z).toBeCloseTo(nostra.z, 12);
    }
    // Dritto è 0, non −0: rotation.y lo prenderebbe uguale, un confronto no.
    expect(Object.is(placeTable(tavolo({ rotation: 0 }), 4, []).rotY, 0)).toBe(true);
    expect(Object.is(placeTable(tavolo({ rotation: undefined }), 4, []).rotY, 0)).toBe(true);
  });
});

describe('le sedie stanno sugli slot del glifo', () => {
  it('dritte: centri degli slot × M, per ogni forma e da 1 a 24 posti', () => {
    for (const shape of SHAPES) {
      for (const seats of POSTI) {
        const t = tavolo({ shape, seats });
        const slots = getChairSlots(shape, seats);
        const { chairs } = placeTable(t, seats, []);
        expect(chairs).toHaveLength(slots.length);
        slots.forEach((s, i) => {
          expect(chairs[i].x).toBeCloseTo((t.x + s.cx) * M_PER_PX, 9);
          expect(chairs[i].z).toBeCloseTo((t.y + s.cy) * M_PER_PX, 9);
        });
      }
    }
  });

  it('ruotate: dove le mette il CSS della piantina', () => {
    for (const shape of SHAPES) {
      for (const seats of [1, 2, 5, 8, 13]) {
        for (const rotation of ROTAZIONI) {
          const t = tavolo({ shape, seats, rotation });
          const { chairs } = placeTable(t, seats, []);
          getChairSlots(shape, seats).forEach((s, i) => {
            const atteso = slotNellaPiantina(t, s.cx, s.cy);
            expect(chairs[i].x).toBeCloseTo(atteso.x, 9);
            expect(chairs[i].z).toBeCloseTo(atteso.z, 9);
          });
        }
      }
    }
  });

  it('col corpo di default nessuna sedia si sposta: c\'è già spazio', () => {
    for (const shape of SHAPES) {
      for (const seats of POSTI) {
        const t = tavolo({ shape, seats });
        const body = tableBody(t, seats);
        for (const c of placeTable(t, seats, []).chairs) {
          const l = locale(t, c);
          const daBordo = body.shape === 'circle'
            ? Math.hypot(l.x, l.z) - body.length / 2
            : Math.abs(l.z) - body.depth / 2;
          expect(daBordo).toBeGreaterThanOrEqual(CHAIR_EDGE_MIN - 1e-9);
        }
      }
    }
  });

  it('un rettangolo dritto: le sedie sopra guardano +Z (yaw 0), quelle sotto −Z (yaw π)', () => {
    const t = tavolo({ seats: 6 });
    const slots = getChairSlots(t.shape, 6);
    placeTable(t, 6, []).chairs.forEach((c, i) => {
      expect(Math.abs(c.yaw)).toBeCloseTo(slots[i].edge === 'top' ? 0 : Math.PI, 12);
    });
  });

  it('chi siede guarda il tavolo, anche ruotato e tondo', () => {
    for (const shape of SHAPES) {
      for (const rotation of ROTAZIONI) {
        const t = tavolo({ shape, seats: 7, rotation });
        const p = placeTable(t, 7, []);
        for (const c of p.chairs) {
          const verso = { x: Math.sin(c.yaw), z: Math.cos(c.yaw) };
          const alTavolo = { x: p.center.x - c.x, z: p.center.z - c.z };
          const len = Math.hypot(alTavolo.x, alTavolo.z);
          const dot = (verso.x * alTavolo.x + verso.z * alTavolo.z) / len;
          if (shape === TableShape.CIRCLE) {
            // Il tondo: dritto verso il centro.
            expect(dot).toBeCloseTo(1, 9);
          } else {
            // Il rettangolo: perpendicolare al lato lungo, verso il tavolo.
            expect(dot).toBeGreaterThan(0);
            const asse = rotateLocal(0, 1, rotation);
            expect(Math.abs(verso.x * asse.x + verso.z * asse.z)).toBeCloseTo(1, 9);
          }
        }
      }
    }
  });

  it('accese: le stesse sedie di litChairIndices', () => {
    for (const shape of SHAPES) {
      for (const seats of [3, 6, 9]) {
        for (const party of [0, 1, 2, 5, 12]) {
          const lit = litChairIndices(shape, seats, party);
          const { chairs } = placeTable(tavolo({ shape, seats }), seats, lit);
          expect(chairs.flatMap((c, i) => (c.lit ? [i] : []))).toEqual(lit);
        }
      }
    }
  });

  it('i posti con cui si disegna vincono su quelli della riga (un\'unione alla 2D)', () => {
    const t = tavolo({ seats: 4 });
    const p = placeTable(t, 8, []);
    expect(p.chairs).toHaveLength(8);
    const { width: w } = getGlyphDimensions(t.shape, 8);
    expect(p.center.x).toBeCloseTo((t.x + w / 2) * M_PER_PX, 12);
  });
});

describe('il corpo del tavolo', () => {
  it('senza misure: dai posti, con le proporzioni di un tavolo vero', () => {
    const rect = (seats: number) => tableBody(tavolo({ shape: TableShape.RECTANGLE }), seats);
    expect(rect(4).length).toBeCloseTo(1.12, 9);
    expect(rect(4).depth).toBeCloseTo(0.8, 9);
    expect(rect(2).length).toBeCloseTo(0.7, 9);
    expect(rect(1).length).toBeCloseTo(0.7, 9);
    expect(rect(8).length).toBeCloseTo(2.16, 9);

    const square = (seats: number) => tableBody(tavolo({ shape: TableShape.SQUARE }), seats);
    expect(square(4)).toEqual({ shape: 'rect', length: 1.1, depth: 1.1 });
    expect(square(3)).toEqual({ shape: 'rect', length: 1.1, depth: 1.1 });
    expect(square(2)).toEqual({ shape: 'rect', length: 0.8, depth: 0.8 });
    // Da 5 posti le sedie di un lato non ci stanno più su 1,10 m: il lato
    // lungo cresce coi posti, come quello del rettangolo.
    expect(square(5).length).toBeCloseTo(1.64, 9);
    expect(square(6).length).toBeCloseTo(1.64, 9);
    expect(square(6).depth).toBeCloseTo(1.1, 9);
    expect(square(8).length).toBeCloseTo(2.16, 9);
    expect(square(8).depth).toBeCloseTo(1.1, 9);

    const circle = (seats: number) => tableBody(tavolo({ shape: TableShape.CIRCLE }), seats);
    expect(circle(2)).toEqual({ shape: 'circle', length: 0.8, depth: 0.8 });
    expect(circle(4).length).toBeCloseTo(0.94, 9);
    expect(circle(10).length).toBeCloseTo(1.9, 9);
  });

  it('senza misure nessuna sedia sporge oltre i capi del piano, da 1 a 24 posti', () => {
    // Mezza sedia del glifo (10 px) oltre il centro dell'ultima del lato.
    const mezzaSedia = 10 * M_PER_PX;
    for (const shape of [TableShape.RECTANGLE, TableShape.SQUARE]) {
      for (const seats of POSTI) {
        const t = tavolo({ shape, seats });
        const p = placeTable(t, seats, []);
        for (const c of p.chairs) {
          expect(Math.abs(locale(t, c).x) + mezzaSedia, `${shape} da ${seats}`).toBeLessThanOrEqual(p.length / 2 + 1e-9);
        }
      }
    }
  });

  it('dalle misure in cm: larghezza = profondità, lunghezza = lato lungo', () => {
    const b = tableBody(tavolo({ width_cm: 90, length_cm: 180 }), 6);
    expect(b.depth).toBeCloseTo(0.9, 9);
    expect(b.length).toBeCloseTo(1.8, 9);
    // Scritte al contrario sono lo stesso tavolo: il lato lungo è il maggiore.
    expect(tableBody(tavolo({ width_cm: 180, length_cm: 90 }), 6)).toEqual(b);
    // Un quadrato con una misura sola la usa per tutti e due i lati.
    const q = tableBody(tavolo({ shape: TableShape.SQUARE, width_cm: 90 }), 4);
    expect(q.length).toBeCloseTo(0.9, 9);
    expect(q.depth).toBeCloseTo(0.9, 9);
    // Il tondo prende la lunghezza come diametro, se no la larghezza.
    expect(tableBody(tavolo({ shape: TableShape.CIRCLE, width_cm: 100 }), 4).length).toBeCloseTo(1, 9);
    expect(tableBody(tavolo({ shape: TableShape.CIRCLE, width_cm: 100, length_cm: 120 }), 4).length).toBeCloseTo(1.2, 9);
  });

  it('un corpo più grande del glifo si stringe dentro il box meno la fascia delle sedie', () => {
    // Rettangolo da 4: box largo 92 px = 1,84 m, quindi al massimo 1,74 m;
    // profondità al massimo 1,20 m.
    const b = tableBody(tavolo({ width_cm: 300, length_cm: 500 }), 4);
    expect(b.length).toBeCloseTo(1.74, 9);
    expect(b.depth).toBeCloseTo(1.2, 9);
    // Tondo da 4: box di 108 px = 2,16 m, quindi al massimo 1,36 m.
    expect(tableBody(tavolo({ shape: TableShape.CIRCLE, length_cm: 300 }), 4).length).toBeCloseTo(1.36, 9);
  });

  it('un corpo profondo spinge fuori le sedie fino a 0,30 m dal bordo', () => {
    // 150 cm di profondità → 1,20 m: il bordo a 0,60 dal centro, e le sedie
    // del glifo (a 0,85) passano a 0,90.
    for (const rotation of [0, 40, 90]) {
      const t = tavolo({ width_cm: 150, seats: 4, rotation });
      const body = tableBody(t, 4);
      expect(body.depth).toBeCloseTo(1.2, 9);
      const slots = getChairSlots(t.shape, 4);
      const { width: w } = getGlyphDimensions(t.shape, 4);
      placeTable(t, 4, []).chairs.forEach((c, i) => {
        const l = locale(t, c);
        expect(Math.abs(l.z)).toBeCloseTo(0.6 + CHAIR_EDGE_MIN, 9);
        // Lungo il lato la sedia resta dove la mette il glifo.
        expect(l.x).toBeCloseTo((slots[i].cx - w / 2) * M_PER_PX, 9);
      });
    }
    // Il tondo al massimo (1,36 m): l'anello passa da 0,93 a 0,68 + 0,30.
    const tondo = tavolo({ shape: TableShape.CIRCLE, seats: 4, length_cm: 300 });
    for (const c of placeTable(tondo, 4, []).chairs) {
      const l = locale(tondo, c);
      expect(Math.hypot(l.x, l.z)).toBeCloseTo(0.68 + CHAIR_EDGE_MIN, 9);
    }
  });

  it('misure assurde non danno mai un corpo nullo o negativo', () => {
    const base = tableBody(tavolo(), 4);
    // Zero, negativi e testo sono «non scritto»: vale il corpo dai posti.
    for (const v of [0, -50, Number.NaN, 'abc' as unknown as number, null]) {
      expect(tableBody(tavolo({ width_cm: v, length_cm: v }), 4)).toEqual(base);
    }
    // Un centimetro è una misura: piccola, ma mai sotto i 40 cm.
    const mini = tableBody(tavolo({ width_cm: 1, length_cm: 1 }), 4);
    expect(mini.length).toBeCloseTo(0.4, 9);
    expect(mini.depth).toBeCloseTo(0.4, 9);
    expect(tableBody(tavolo({ shape: TableShape.CIRCLE, length_cm: 1 }), 4).length).toBeCloseTo(0.4, 9);
    // La stringa di un numero vale quel numero (una colonna numeric di pg).
    expect(tableBody(tavolo({ width_cm: '90' as unknown as number, length_cm: 180 }), 6).depth).toBeCloseTo(0.9, 9);
  });

  it('una riga monca non manda il tavolo in NaN', () => {
    const p = placeTable(tavolo({ x: undefined as unknown as number, y: 'x' as unknown as number, rotation: Number.NaN }), 4, []);
    expect(Number.isFinite(p.center.x)).toBe(true);
    expect(Number.isFinite(p.center.z)).toBe(true);
    expect(p.rotY).toBe(0);
    for (const c of p.chairs) {
      expect(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.yaw)).toBe(true);
    }
    expect(placeTable(tavolo(), Number.NaN, []).chairs).toHaveLength(0);
  });
});
