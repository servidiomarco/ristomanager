import { describe, it, expect } from 'vitest';
import { Shift, TableShape, TableStatus, type FloorMarker, type Room, type Table, type TableMerge } from '../../types';
import { boxesOverlap, getTableFootprint } from '../../utils/tableOverlap';
import {
  EXTENT_PAD_PX,
  buildRoomLayout,
  inwardAt,
  isLayoutUnset,
} from '../../components/salaVivo/model/layout';
import { placeTable, tableBody } from '../../components/salaVivo/model/geometry';

/* La disposizione di una sala della Sala dal vivo: che cosa si disegna e dove,
 * e i controlli che diventano avvisi. Tutto in px della tela della sala. */

const SALA: Room = { id: 1, name: 'Veranda', width: 800, height: 600 };

// Rettangolo da 4 posti: box del glifo 92 × 100 px. Tondo da 4: 108 × 108.
const tavolo = (id: number, x: number, y: number, over: Partial<Table> = {}): Table => ({
  id,
  name: String(id),
  shape: TableShape.RECTANGLE,
  seats: 4,
  x,
  y,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

const unione = (primary_id: number, merged_ids: number[]): TableMerge =>
  ({ id: primary_id, date: '2026-10-04', shift: Shift.DINNER, primary_id, merged_ids });

const segnaposto = (kind: FloorMarker['kind'], x: number, y: number, room_id = 1): FloorMarker =>
  ({ id: x * 1000 + y, room_id, kind, x, y });

const layout = (over: {
  room?: Room;
  tables?: Table[];
  merges?: TableMerge[];
  hidden?: number[];
  markers?: FloorMarker[];
} = {}) => buildRoomLayout({
  room: over.room ?? SALA,
  tables: over.tables ?? [],
  merges: over.merges ?? [],
  hiddenTableIds: new Set(over.hidden ?? []),
  markers: over.markers ?? [],
});

describe('sovrapposizioni sulle sagome orientate', () => {
  it('vicini ruotati coi box allineati che si toccano e le sagome no: niente avviso', () => {
    // Due rettangoli a 45°, centri a 132 px: i box ruotati (136 px di lato)
    // si sovrappongono, i rettangoli no (servirebbero meno di 130 px).
    const a = tavolo(1, 0, 0, { rotation: 45 });
    const b = tavolo(2, 132, 0, { rotation: 45 });
    expect(boxesOverlap(getTableFootprint(a, a.x, a.y, 0, 0), getTableFootprint(b, b.x, b.y, 0, 0))).toBe(true);
    expect(layout({ tables: [a, b] }).audit.overlaps).toEqual([]);
  });

  it('due tavoli che si sovrappongono davvero: la coppia, per nome', () => {
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 50, 0), tavolo(3, 400, 300)] });
    expect(l.audit.overlaps).toEqual([['1', '2']]);
  });

  it('ruotati che si sovrappongono si vedono anche se dritti non si toccherebbero', () => {
    // Dritti a 94 px non si toccano (92 di larghezza); ruotato di 90° il
    // primo è largo 100 attorno al suo centro (46) e arriva a 96: dentro il
    // secondo.
    const dritti = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 94, 0)] });
    expect(dritti.audit.overlaps).toEqual([]);
    const ruotati = layout({ tables: [tavolo(1, 0, 0, { rotation: 90 }), tavolo(2, 94, 0)] });
    expect(ruotati.audit.overlaps).toEqual([['1', '2']]);
  });

  it('i tondi sono dischi: box che si toccano negli angoli, dischi lontani', () => {
    const a = tavolo(1, 0, 0, { shape: TableShape.CIRCLE });
    const b = tavolo(2, 90, 90, { shape: TableShape.CIRCLE });
    expect(boxesOverlap(getTableFootprint(a, 0, 0, 0, 0), getTableFootprint(b, 90, 90, 0, 0))).toBe(true);
    expect(layout({ tables: [a, b] }).audit.overlaps).toEqual([]);
    // Più vicini, si toccano davvero.
    expect(layout({ tables: [a, tavolo(2, 60, 60, { shape: TableShape.CIRCLE })] }).audit.overlaps).toEqual([['1', '2']]);
  });

  it('un tondo contro un rettangolo: conta il punto del rettangolo più vicino', () => {
    const rett = tavolo(1, 0, 0);
    // Il disco (r 54) davanti all'angolo in basso a destra, a 56,6 px: no.
    const lontano = tavolo(2, 78, 86, { shape: TableShape.CIRCLE });
    expect(layout({ tables: [rett, lontano] }).audit.overlaps).toEqual([]);
    // Il disco sul lato destro, a 42 px dal bordo: sì.
    const vicino = tavolo(2, 80, 0, { shape: TableShape.CIRCLE });
    expect(layout({ tables: [rett, vicino] }).audit.overlaps).toEqual([['1', '2']]);
  });

  it('tavoli che si toccano soltanto non si sovrappongono', () => {
    expect(layout({ tables: [tavolo(1, 0, 0), tavolo(2, 92, 0)] }).audit.overlaps).toEqual([]);
    // Ruotati di 90° sono alti 92 attorno al centro: il primo finisce a 96,
    // il secondo (y = 92) comincia a 96. Il rumore di cos 90° non conta.
    expect(layout({ tables: [tavolo(1, 0, 0, { rotation: 90 }), tavolo(2, 0, 92, { rotation: 90 })] }).audit.overlaps)
      .toEqual([]);
    // Un px più in su sì.
    expect(layout({ tables: [tavolo(1, 0, 0, { rotation: 90 }), tavolo(2, 0, 91, { rotation: 90 })] }).audit.overlaps)
      .toEqual([['1', '2']]);
  });

  it('un\'unione conta come il tavolo unito che si disegna, come nella piantina', () => {
    // «1+2» da 8 è largo 144 px dal posto del capofila: arriva sul 3. Il 2,
    // che non si disegna, non conta da solo.
    const tables = [tavolo(1, 0, 0), tavolo(2, 50, 0), tavolo(3, 80, 0)];
    const l = layout({ tables, merges: [unione(1, [2])] });
    expect(l.audit.overlaps).toEqual([['1+2', '3']]);
  });

  it('nessun margine né fascia delle etichette: tavoli a 10 px non sono un avviso', () => {
    // La piantina (findOverlappingPairs) li segnalerebbe: per lei c'è la
    // fascia delle etichette sotto ogni tavolo.
    expect(layout({ tables: [tavolo(1, 0, 0), tavolo(2, 0, 110)] }).audit.overlaps).toEqual([]);
  });
});

describe('sala mai disposta', () => {
  it('almeno 3 tavoli e la posizione più comune ne tiene almeno la metà', () => {
    expect(isLayoutUnset([{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 50, y: 50 }, { x: 300, y: 300 }])).toBe(true);
    // Esattamente la metà conta.
    expect(isLayoutUnset([{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 200, y: 50 }, { x: 300, y: 300 }])).toBe(true);
    // Meno della metà no.
    expect(isLayoutUnset([{ x: 50, y: 50 }, { x: 50, y: 50 }, { x: 200, y: 50 }, { x: 300, y: 300 }, { x: 400, y: 0 }]))
      .toBe(false);
  });

  it('con meno di 3 tavoli non è mai «da disporre»', () => {
    expect(isLayoutUnset([{ x: 50, y: 50 }, { x: 50, y: 50 }])).toBe(false);
    expect(isLayoutUnset([])).toBe(false);
  });

  it('nella sala: contano i tavoli visibili di questa sala', () => {
    const impilati = [tavolo(1, 50, 50), tavolo(2, 50, 50), tavolo(3, 50, 50), tavolo(4, 300, 300)];
    expect(layout({ tables: impilati }).audit.unset).toBe(true);
    // Due dei tre impilati nascosti per il servizio: non più.
    expect(layout({ tables: [...impilati, tavolo(5, 500, 300)], hidden: [1, 2] }).audit.unset).toBe(false);
    // Quelli di un'altra sala non contano.
    const altrove = impilati.map(t => (t.id <= 2 ? { ...t, room_id: 2 } : t));
    expect(layout({ tables: [...altrove, tavolo(5, 500, 300)] }).audit.unset).toBe(false);
  });
});

describe('il pavimento', () => {
  it('almeno la sala salvata', () => {
    expect(layout({ tables: [tavolo(1, 100, 100)] }).extentPx).toEqual({ width: 800, height: 600 });
  });

  it('un tavolo oltre la sala la allarga fino al suo box più il margine', () => {
    // Box 92 × 100: destra a 992, fondo a 800.
    expect(layout({ tables: [tavolo(1, 900, 700)] }).extentPx)
      .toEqual({ width: 992 + EXTENT_PAD_PX, height: 800 + EXTENT_PAD_PX });
  });

  it('anche i segnaposto posati la allargano, con chip ed etichetta', () => {
    const l = layout({ markers: [segnaposto('ENTRANCE', 1000, 650)] });
    expect(l.extentPx).toEqual({ width: 1000 + 40 + EXTENT_PAD_PX, height: 650 + 60 + EXTENT_PAD_PX });
    // Quelli di un'altra sala no.
    expect(layout({ markers: [segnaposto('ENTRANCE', 1000, 650, 2)] }).extentPx).toEqual({ width: 800, height: 600 });
  });

  it('una sala senza misure vale 800 × 600, una più grande resta com\'è', () => {
    expect(layout({ room: { ...SALA, width: 0, height: -5 } }).extentPx).toEqual({ width: 800, height: 600 });
    expect(layout({ room: { ...SALA, width: 1200, height: 900 } }).extentPx).toEqual({ width: 1200, height: 900 });
  });
});

describe('i segnaposto', () => {
  it('senza segnaposto: ingresso in basso al centro, pass in alto a destra, accoglienza dentro e a destra', () => {
    const l = layout();
    const { ENTRANCE, PASS, HOST_STAND } = l.markersPx;
    expect(ENTRANCE).toMatchObject({ x: 400, y: 580, placed: false });
    expect(PASS).toMatchObject({ x: 740, y: 60, placed: false });
    // 60 px dentro (verso −y) e 40 alla destra di chi entra (+x).
    expect(HOST_STAND).toMatchObject({ x: 440, y: 520, placed: false });
    expect(l.audit.missingMarkers).toEqual(['ENTRANCE', 'PASS', 'HOST_STAND']);
  });

  it('i ripieghi stanno sul muro e guardano dentro dritti', () => {
    const { ENTRANCE, PASS, HOST_STAND } = layout().markersPx;
    expect(ENTRANCE.inward).toEqual({ x: 0, z: -1 });
    // Il pass nell'angolo in alto a destra: il muro più vicino è quello di
    // destra (contando chip ed etichetta), e guarda a sinistra.
    expect(PASS.inward).toEqual({ x: -1, z: 0 });
    // Il leggio, un passo dentro dall'ingresso, guarda come la porta.
    expect(HOST_STAND.inward).toEqual({ x: 0, z: -1 });
  });

  it('un segnaposto posato in fondo alla sala è sul muro, anche lontano dal centro', () => {
    // L'ingresso in basso a sinistra allarga il pavimento fino alla sua
    // etichetta più il margine: è sul muro di fondo e guarda su, non in
    // diagonale verso il centro.
    for (const x of [100, 300]) {
      const l = layout({ tables: [tavolo(1, 0, 0)], markers: [segnaposto('ENTRANCE', x, 700)] });
      expect(l.extentPx.height).toBe(700 + 60 + EXTENT_PAD_PX);
      expect(l.markersPx.ENTRANCE.inward).toEqual({ x: 0, z: -1 });
    }
    // In mezzo alla sala guarda il centro.
    const centro = layout({ markers: [segnaposto('HOST_STAND', 200, 200)] }).markersPx.HOST_STAND.inward;
    expect(centro.x).toBeCloseTo(200 / Math.hypot(200, 100), 12);
    expect(centro.z).toBeCloseTo(100 / Math.hypot(200, 100), 12);
  });

  it('i segnaposto posati restano dove sono; l\'accoglienza di ripiego segue l\'ingresso', () => {
    // Ingresso sul muro di sinistra: guarda +x, e la destra di chi entra è +y.
    const l = layout({ markers: [segnaposto('ENTRANCE', 10, 300), segnaposto('PASS', 400, 30)] });
    expect(l.markersPx.ENTRANCE).toEqual({ x: 10, y: 300, placed: true, inward: { x: 1, z: 0 } });
    expect(l.markersPx.PASS).toEqual({ x: 400, y: 30, placed: true, inward: { x: 0, z: 1 } });
    expect(l.markersPx.HOST_STAND).toMatchObject({ x: 70, y: 340, placed: false });
    expect(l.audit.missingMarkers).toEqual(['HOST_STAND']);
  });

  it('inward: versore verso il centro, agganciato al bordo entro 50 px', () => {
    expect(inwardAt(400, 560, 800, 600)).toEqual({ x: 0, z: -1 });
    expect(inwardAt(790, 300, 800, 600)).toEqual({ x: -1, z: 0 });
    expect(inwardAt(400, 50, 800, 600)).toEqual({ x: 0, z: 1 });
    expect(inwardAt(30, 300, 800, 600)).toEqual({ x: 1, z: 0 });
    // In basso e a destra il bordo conta da dopo chip, etichetta e margine:
    // a 170 px dal fondo si è ancora sul muro, a 171 no.
    expect(inwardAt(200, 430, 800, 600)).toEqual({ x: 0, z: -1 });
    expect(inwardAt(200, 429, 800, 600).z).toBeCloseTo(-129 / Math.hypot(200, 129), 12);
    const dentro = inwardAt(100, 100, 800, 600);
    expect(dentro.x).toBeCloseTo(300 / Math.hypot(300, 200), 12);
    expect(dentro.z).toBeCloseTo(200 / Math.hypot(300, 200), 12);
    // Proprio al centro non c'è un verso: vale quello dell'ingresso di ripiego.
    expect(inwardAt(400, 300, 800, 600)).toEqual({ x: 0, z: -1 });
  });

  it('un segnaposto in un angolo: l\'accoglienza di ripiego resta sul pavimento', () => {
    const l = layout({ markers: [segnaposto('ENTRANCE', 0, 0)] });
    const h = l.markersPx.HOST_STAND;
    expect(h.x).toBeGreaterThanOrEqual(0);
    expect(h.y).toBeGreaterThanOrEqual(0);
    expect(h.x).toBeLessThanOrEqual(l.extentPx.width);
    expect(h.y).toBeLessThanOrEqual(l.extentPx.height);
  });
});

describe('le unioni: sempre un tavolo solo, come in 2D', () => {
  // Decisione di Tina (4 ottobre): accostati o no, i tavoli uniti si
  // disegnano come li disegna la piantina — il capofila al suo posto, col
  // nome unito e i posti sommati — e i secondari non si disegnano.
  const unità = (l: ReturnType<typeof layout>) => l.units.map(u => [u.table.id, u.table.name, u.table.seats]);

  it('due da 4 affiancati quanto l\'editor permette: un tavolo solo da 8, al posto del capofila', () => {
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 120, 0)], merges: [unione(1, [2])] });
    expect(unità(l)).toEqual([[1, '1+2', 8]]);
    expect(l.units[0].groupIds).toEqual([1, 2]);
    expect([l.units[0].table.x, l.units[0].table.y]).toEqual([0, 0]);
  });

  it('vicini o lontani, di lato o uno sopra l\'altro: sempre lo stesso tavolo unito', () => {
    for (const [x, y] of [[120, 0], [140, 0], [0, 200], [0, 220], [600, 400]]) {
      const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, x, y), tavolo(3, 700, 0)], merges: [unione(1, [2])] });
      expect(unità(l), JSON.stringify([x, y])).toEqual([[1, '1+2', 8], [3, '3', 4]]);
    }
  });

  it('come in 2D il corpo si fa dai posti sommati, non dalle misure del capofila', () => {
    // Il capofila misura 80 × 120 cm: sul tavolo da 8 le sedie in fondo
    // (a 0,78 m dal centro) finirebbero oltre i capi di un piano lungo 1,2 m.
    const capofila = tavolo(1, 0, 0, { width_cm: 80, length_cm: 120 });
    const l = layout({ tables: [capofila, tavolo(2, 300, 0)], merges: [unione(1, [2])] });
    const [unito] = l.units;
    expect([unito.table.seats, unito.table.width_cm, unito.table.length_cm]).toEqual([8, null, null]);
    const corpo = tableBody(unito.table, unito.table.seats);
    expect(corpo).toEqual(tableBody(tavolo(9, 0, 0), 8));
    const p = placeTable(unito.table, unito.table.seats, []);
    const metà = p.length / 2;
    for (const c of p.chairs) {
      // Mezza sedia (20 px = 0,4 m) oltre il centro: dentro il piano.
      expect(Math.abs(c.x - p.center.x) + 0.2).toBeLessThanOrEqual(metà + 1e-9);
    }
    // Il tavolo vero, da solo, tiene le sue misure.
    const solo = layout({ tables: [capofila] });
    expect([solo.units[0].table.width_cm, solo.units[0].table.length_cm]).toEqual([80, 120]);
  });

  it('una fila di tre: un tavolo solo coi posti di tutti', () => {
    const l = layout({
      tables: [tavolo(1, 0, 0), tavolo(2, 100, 0), tavolo(3, 200, 0)],
      merges: [unione(1, [2, 3])],
    });
    expect(l.units.map(u => [u.table.id, u.table.seats, u.groupIds])).toEqual([[1, 12, [1, 2, 3]]]);
  });

  it('capofila nascosto: l\'unione sparisce, come in 2D', () => {
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 100, 0), tavolo(3, 400, 0)], merges: [unione(1, [2])], hidden: [1] });
    expect(l.units.map(u => u.table.id)).toEqual([3]);
  });

  it('un secondario nascosto: il capofila resta il tavolo unito, coi posti di tutti come in 2D', () => {
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 100, 0)], merges: [unione(1, [2])], hidden: [2] });
    expect(unità(l)).toEqual([[1, '1+2', 8]]);
    expect(l.units[0].groupIds).toEqual([1, 2]);
  });

  it('membri in due sale: nella sala del capofila come in 2D, nell\'altra niente', () => {
    const tables = [tavolo(1, 0, 0), tavolo(2, 100, 0, { room_id: 2 })];
    const qui = layout({ tables, merges: [unione(1, [2])] });
    expect(unità(qui)).toEqual([[1, '1+2', 8]]);
    const altra = layout({ room: { ...SALA, id: 2, name: 'Fiume' }, tables, merges: [unione(1, [2])] });
    expect(altra.units).toEqual([]);
  });

  it('un capofila che non esiste più: i secondari tornano tavoli qualunque, come in 2D', () => {
    const l = layout({ tables: [tavolo(2, 0, 0), tavolo(3, 100, 0)], merges: [unione(1, [2, 3])] });
    expect(l.units.map(u => [u.table.id, u.groupIds])).toEqual([[2, [2]], [3, [3]]]);
  });

  it('i tavoli nell\'ordine in cui arrivano, a ogni ricalcolo', () => {
    const tables = [tavolo(9, 400, 0), tavolo(2, 117, 0), tavolo(1, 0, 0)];
    const l = layout({ tables, merges: [unione(1, [2])] });
    expect(l.units.map(u => u.table.id)).toEqual([9, 1]);
    expect(layout({ tables, merges: [unione(1, [2])] })).toEqual(l);
  });

  it('unioni rotte non fanno cadere niente', () => {
    const rotte = [
      { id: 1, date: '2026-10-04', shift: Shift.DINNER, primary_id: 1, merged_ids: null },
      { id: 2, date: '2026-10-04', shift: Shift.DINNER, primary_id: 'x', merged_ids: [2] },
      null,
    ] as unknown as TableMerge[];
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(2, 300, 0)], merges: rotte });
    expect(l.units.map(u => [u.table.id, u.groupIds])).toEqual([[1, [1]], [2, [2]]]);
  });
});

describe('le altre sale e i nascosti', () => {
  it('si disegnano solo i tavoli visibili di questa sala', () => {
    const l = layout({
      tables: [tavolo(1, 0, 0), tavolo(2, 200, 0, { room_id: 2 }), tavolo(3, 400, 0)],
      hidden: [3],
    });
    expect(l.units.map(u => u.table.id)).toEqual([1]);
  });

  it('un tavolo ripetuto si disegna una volta, il primo, come in 2D', () => {
    const l = layout({ tables: [tavolo(1, 0, 0), tavolo(1, 300, 0), null as unknown as Table] });
    expect(l.units.map(u => [u.table.id, u.table.x])).toEqual([[1, 0]]);
  });

  it('numeri monchi della riga si leggono con prudenza', () => {
    const l = layout({ tables: [tavolo(1, '40' as unknown as number, Number.NaN, { seats: '6' as unknown as number })] });
    expect([l.units[0].table.x, l.units[0].table.y, l.units[0].table.seats]).toEqual([40, 0, 6]);
  });
});
