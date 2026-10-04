import { describe, it, expect } from 'vitest';
import { TableShape, TableStatus, type Table } from '../../types';
import { getGlyphDimensions, litChairIndices } from '../../utils/tableGeometry';
import type { FigureSlot, MarkerModel, RoomModel, TableModel, Vec2 } from '../../components/salaVivo/types';
import { DOOR_GAP, M_PER_PX, placeTable } from '../../components/salaVivo/model/geometry';
import { FLOOR_MARGIN, lobbyCells, toLocal } from '../../components/salaVivo/model/placement';
import {
  AGENT_R,
  CELL,
  CHAIR_R,
  DOG_R,
  DOOR_INSIDE,
  DOOR_OUTSIDE,
  GREET_SIDE,
  HOST_POCKET,
  LECTERN_R,
  NODE_CAP,
  PASS_FRONT,
  PASS_SLOT_PITCH,
  PERSON_R,
  buildNavGrid,
  cellAt,
  findPath,
  isFree,
  lineOfSight,
  navKey,
  nearestFree,
  passSlot,
  passSlots,
  roomAnchors,
  tableSidePoint,
  type NavGrid,
} from '../../components/salaVivo/model/navGrid';

/* Dove si cammina: la griglia di una sala, i percorsi attorno ai tavoli, i
 * punti fissi (porta, accoglienza, pass) e i capi dei tavoli. Le misure sono
 * in metri, come il modello; le celle sono di 20 cm. */

const marker = (kind: MarkerModel['kind'], x: number, z: number, inward: Vec2 = { x: 0, z: -1 }, placed = true): MarkerModel =>
  ({ kind, pos: { x, z }, placed, inward });

const tavolo = (id: number, over: Partial<Table> = {}): Table => ({
  id,
  name: String(id),
  shape: TableShape.RECTANGLE,
  seats: 4,
  x: 0,
  y: 0,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

// Un tavolo disegnato col centro in (cx, cz) metri, con le sue sedie, come
// lo fa la sala (placeTable).
const modello = (id: number, cx: number, cz: number, over: Partial<Table> = {}): TableModel => {
  const t = tavolo(id, over);
  const { width, height } = getGlyphDimensions(t.shape, t.seats);
  const posato = { ...t, x: cx / M_PER_PX - width / 2, y: cz / M_PER_PX - height / 2 };
  const p = placeTable(posato, posato.seats, litChairIndices(t.shape, t.seats, 0));
  return {
    id,
    name: t.name,
    roomId: 1,
    shape: p.shape,
    center: p.center,
    rotY: p.rotY,
    length: p.length,
    depth: p.depth,
    status: 'libera',
    chairs: p.chairs,
    extraChairs: [],
    pulse: false,
    sign: null,
    caption: null,
  };
};

// Una sala da 12 × 8 m: l'ingresso a metà del muro in basso (sul muro), il
// pass in alto a destra rivolto a sinistra, il leggio a destra della porta.
const sala = (over: Partial<RoomModel> = {}): RoomModel => ({
  id: 1,
  name: 'Veranda',
  closed: false,
  outdoor: false,
  floor: { width: 12, depth: 8 },
  bounds: { minX: 0, minZ: 0, maxX: 12, maxZ: 8 },
  tables: [],
  markers: {
    ENTRANCE: marker('ENTRANCE', 6, 7.6),
    PASS: marker('PASS', 11, 1.2, { x: -1, z: 0 }),
    HOST_STAND: marker('HOST_STAND', 7.2, 6.6),
  },
  audit: { overlaps: [], unset: false, missingMarkers: [] },
  summary: { seated: 0, arriving: 0, lobby: 0, covers: 0 },
  parties: [],
  figures: [],
  ...over,
});

const centro = (grid: NavGrid, i: number, j: number): Vec2 => ({ x: (i + 0.5) * CELL, z: (j + 0.5) * CELL });

// Una griglia aperta fatta a mano: solo l'anello del bordo bloccato.
const griglia = (cols: number, rows: number, blocked: Array<[number, number]> = []): NavGrid => {
  const g: NavGrid = { roomId: 0, key: '', cols, rows, blocked: new Uint8Array(cols * rows) };
  for (let i = 0; i < cols; i++) {
    g.blocked[i] = 1;
    g.blocked[(rows - 1) * cols + i] = 1;
  }
  for (let j = 0; j < rows; j++) {
    g.blocked[j * cols] = 1;
    g.blocked[j * cols + cols - 1] = 1;
  }
  for (const [i, j] of blocked) g.blocked[j * cols + i] = 1;
  return g;
};

const lunghezza = (path: Vec2[]) => path.slice(1).reduce((acc, p, k) => acc + Math.hypot(p.x - path[k].x, p.z - path[k].z), 0);

// Il centro di una persona dentro il tavolo gonfiato di AGENT_R (piano con
// gli spigoli tondi) o dentro una sedia gonfiata.
const dentroTavolo = (t: TableModel, p: Vec2): boolean => {
  const { lx, lz } = toLocal(t, p.x, p.z);
  const qx = Math.max(0, Math.abs(lx) - t.length / 2);
  const qz = Math.max(0, Math.abs(lz) - t.depth / 2);
  return qx * qx + qz * qz < AGENT_R * AGENT_R;
};
const dentroSedia = (t: TableModel, p: Vec2): boolean =>
  [...t.chairs, ...t.extraChairs].some(c => Math.hypot(c.x - p.x, c.z - p.z) < CHAIR_R + AGENT_R);

const segmentiLiberi = (grid: NavGrid, path: Vec2[], from = 0, to = path.length - 1) => {
  for (let k = from; k < to; k++) expect(lineOfSight(grid, path[k], path[k + 1]), `tratto ${k}`).toBe(true);
};

describe('la griglia', () => {
  it('celle da 20 cm sul pavimento, il bordo chiuso e aperto solo nel varco della porta', () => {
    const grid = buildNavGrid(sala());
    expect([grid.cols, grid.rows, grid.roomId]).toEqual([60, 40, 1]);
    expect(grid.key).toBe(navKey(sala()));
    // La porta sul muro in basso, a x = 6: aperte le celle del bordo il cui
    // centro sta entro DOOR_GAP/2 = 0,6 m, cioè da 5,5 a 6,5.
    expect(DOOR_GAP).toBe(1.2);
    const aperte: string[] = [];
    for (let i = 0; i < grid.cols; i++) {
      for (let j = 0; j < grid.rows; j++) {
        const bordo = i === 0 || j === 0 || i === grid.cols - 1 || j === grid.rows - 1;
        if (bordo && grid.blocked[j * grid.cols + i] === 0) aperte.push(`${i},${j}`);
      }
    }
    expect(aperte).toEqual(['27,39', '28,39', '29,39', '30,39', '31,39', '32,39']);
    // Un ingresso lontano dai muri non apre niente: si entra da dov'è.
    const inMezzo = buildNavGrid(sala({ markers: { ...sala().markers, ENTRANCE: marker('ENTRANCE', 6, 5) } }));
    let bordiAperti = 0;
    for (let i = 0; i < inMezzo.cols; i++) {
      for (let j = 0; j < inMezzo.rows; j++) {
        const bordo = i === 0 || j === 0 || i === inMezzo.cols - 1 || j === inMezzo.rows - 1;
        if (bordo && inMezzo.blocked[j * inMezzo.cols + i] === 0) bordiAperti++;
      }
    }
    expect(bordiAperti).toBe(0);
    // Una porta nell'angolo: gli angoli restano chiusi, sono anche dell'altro muro.
    const angolo = buildNavGrid(sala({ markers: { ...sala().markers, ENTRANCE: marker('ENTRANCE', 0.2, 7.9) } }));
    expect(angolo.blocked[39 * 60 + 0]).toBe(1);
    expect(angolo.blocked[39 * 60 + 1]).toBe(0);
  });

  it('bloccati tavoli (gonfiati di 22 cm), sedie, banco del pass e leggio (gonfiato, meno il posto dell\'hostess)', () => {
    const t = modello(1, 4, 3.5, { seats: 6 });
    const tondo = modello(2, 8, 4, { shape: TableShape.CIRCLE, seats: 4 });
    const grid = buildNavGrid(sala({ tables: [t, tondo] }));
    // Il centro del tavolo, un punto appena oltre il bordo del piano, una sedia.
    expect(isFree(grid, 4, 3.5)).toBe(false);
    expect(isFree(grid, 4 + t.length / 2 + 0.1, 3.5)).toBe(false);
    expect(isFree(grid, t.chairs[0].x, t.chairs[0].z)).toBe(false);
    // Lontano dal tavolo e dalle sedie: libero.
    expect(isFree(grid, 4 + t.length / 2 + 0.6, 3.5)).toBe(true);
    expect(isFree(grid, 8, 4)).toBe(false);
    expect(isFree(grid, 8 + tondo.length / 2 + 0.1, 4)).toBe(false);
    // Il pass a (11, 1,2) rivolto a −x: il banco è lungo 1,6 m lungo z.
    expect(isFree(grid, 11, 1.9)).toBe(false);
    expect(isFree(grid, 11 - 0.25 - 0.1, 1.2)).toBe(false);
    expect(isFree(grid, 11 - PASS_FRONT, 1.2)).toBe(true);
    // Il leggio: 30 cm gonfiati di 22, come gli altri mobili (chi gli passava
    // accanto ci entrava di 10 cm). L'hostess sta a 50 cm, dalla parte
    // opposta alla porta (placement.hostSpot: qui a +x), e il suo posto resta
    // libero: una tasca di HOST_POCKET attorno a lei.
    expect(LECTERN_R).toBe(0.3);
    expect(isFree(grid, 7.2, 6.6)).toBe(false);
    expect(isFree(grid, 7.3, 6.1)).toBe(false);
    expect(isFree(grid, 7.7, 6.6)).toBe(true);
    expect(isFree(grid, 7.3, 5.9)).toBe(true);
    // Da lì si esce verso la sala, e ci si torna.
    const via = findPath(grid, { x: 7.7, z: 6.6 }, { x: 9, z: 5 });
    expect(via[0]).toEqual({ x: 7.7, z: 6.6 });
    for (let k = 1; k < via.length; k++) expect(Math.hypot(via[k].x - 7.2, via[k].z - 6.6), `punto ${k}`).toBeGreaterThanOrEqual(LECTERN_R + AGENT_R - CELL);
    // Ogni cella bloccata ha il centro dentro un ostacolo, o sta sul bordo.
    for (let j = 1; j < grid.rows - 1; j++) {
      for (let i = 1; i < grid.cols - 1; i++) {
        if (grid.blocked[j * grid.cols + i] === 0) continue;
        const c = centro(grid, i, j);
        const ostacolo = [t, tondo].some(tb => (tb.shape === 'circle'
          ? Math.hypot(c.x - tb.center.x, c.z - tb.center.z) < tb.length / 2 + AGENT_R
          : dentroTavolo(tb, c)) || dentroSedia(tb, c));
        const lPass = { x: c.x - 11, z: c.z - 1.2 };
        const qx = Math.max(0, Math.abs(lPass.z) - 0.8);
        const qz = Math.max(0, Math.abs(lPass.x) - 0.25);
        const pass = qx * qx + qz * qz < AGENT_R * AGENT_R;
        const leggio = Math.hypot(c.x - 7.2, c.z - 6.6) < LECTERN_R + AGENT_R;
        expect(ostacolo || pass || leggio, `${i},${j}`).toBe(true);
        // Nella tasca dell'hostess il leggio non chiude niente.
        if (Math.hypot(c.x - 7.7, c.z - 6.6) < HOST_POCKET) expect(ostacolo || pass, `tasca ${i},${j}`).toBe(true);
      }
    }
  });

  it('cellAt e isFree: fuori dalla griglia, −1 e no', () => {
    const grid = buildNavGrid(sala());
    expect(cellAt(grid, 0.1, 0.1)).toBe(0);
    expect(cellAt(grid, 0.3, 0.1)).toBe(1);
    expect(cellAt(grid, 0.1, 0.3)).toBe(60);
    expect(cellAt(grid, -0.1, 1)).toBe(-1);
    expect(cellAt(grid, 1, 8.1)).toBe(-1);
    expect(cellAt(grid, Number.NaN, 1)).toBe(-1);
    expect(isFree(grid, 13, 1)).toBe(false);
    expect(isFree(grid, 1, 1)).toBe(true);
    expect(isFree(grid, 0.1, 1)).toBe(false);
  });

  it('chi sta fermo in piedi e i cani sono ostacoli; chi siede e l\'hostess no', () => {
    const fig = (key: string, kind: FigureSlot['kind'], pose: FigureSlot['pose'], x: number, z: number, tableId: number | null = null): FigureSlot =>
      ({ key, kind, pose, x, z, yaw: 0, seatHeight: pose === 'seated' ? 0.45 : 0, partyId: kind === 'hostess' ? null : 7, tableId, tint: 0 });
    const base = sala();
    // Chi aspetta all'ingresso: le sei caselle accanto alla porta.
    const celle = lobbyCells(base);
    const ingresso = celle.map((c, k) => fig(`r7:a${k}`, 'adult', 'standing', c.x, c.z));
    const conIngresso = sala({ figures: ingresso });
    const grid = buildNavGrid(conIngresso);
    expect(PERSON_R).toBe(0.2);
    for (const c of celle) expect(isFree(grid, c.x, c.z)).toBe(false);
    // Il disco è PERSON_R + AGENT_R: appena fuori, verso la porta, libero.
    const c0 = celle[0];
    expect(isFree(grid, c0.x, c0.z + (PERSON_R + AGENT_R) + 0.25)).toBe(true);
    // La chiave cambia con chi aspetta, e un percorso dalla porta non ci passa in mezzo.
    expect(navKey(conIngresso)).not.toBe(navKey(base));
    const a = roomAnchors(conIngresso, grid);
    const meta = { x: c0.x + (c0.x > a.inside.x ? 2.5 : -2.5), z: 1.5 };
    const path = findPath(grid, a.inside, meta);
    for (let k = 0; k < path.length - 1; k++) {
      for (let t = 0; t <= 20; t++) {
        const p = { x: path[k].x + ((path[k + 1].x - path[k].x) * t) / 20, z: path[k].z + ((path[k + 1].z - path[k].z) * t) / 20 };
        for (const c of celle) expect(Math.hypot(p.x - c.x, p.z - c.z), `tratto ${k}`).toBeGreaterThan(PERSON_R + AGENT_R - CELL);
      }
    }
    // Un cane (sdraiato o in piedi) blocca; chi siede e l'hostess no (la sedia
    // blocca già, l'hostess cammina).
    expect(DOG_R).toBe(0.2);
    const altri = buildNavGrid(sala({
      figures: [
        fig('r7:d0', 'dog', 'lying', 3, 3, 1),
        fig('r8:a0', 'adult', 'seated', 5, 3, 1),
        fig('host:1', 'hostess', 'standing', 9, 3),
      ],
    }));
    expect(isFree(altri, 3, 3)).toBe(false);
    expect(isFree(altri, 5, 3)).toBe(true);
    expect(isFree(altri, 9, 3)).toBe(true);
  });

  it('navKey cambia con la geometria, non con colori, sedie accese o chi siede', () => {
    const t = modello(1, 4, 3.5);
    const base = sala({ tables: [t] });
    const k = navKey(base);
    expect(navKey(sala({ tables: [{ ...t, status: 'arrivato', pulse: true, chairs: t.chairs.map(c => ({ ...c, lit: false })) }] }))).toBe(k);
    expect(navKey({ ...base, figures: [{ key: 'r1:a0', kind: 'adult', pose: 'seated', x: 1, z: 1, yaw: 0, seatHeight: 0.45, partyId: 1, tableId: 1, tint: 0 }] })).toBe(k);
    // Il rumore dei float non conta…
    expect(navKey(sala({ tables: [{ ...t, center: { x: t.center.x + 1e-7, z: t.center.z } }] }))).toBe(k);
    // …un tavolo spostato, ruotato, una sedia in più, un segnaposto spostato sì.
    expect(navKey(sala({ tables: [{ ...t, center: { x: t.center.x + 0.1, z: t.center.z } }] }))).not.toBe(k);
    expect(navKey(sala({ tables: [{ ...t, rotY: -Math.PI / 2 }] }))).not.toBe(k);
    expect(navKey(sala({ tables: [{ ...t, extraChairs: [{ x: 5, z: 3.5, yaw: 0, lit: true, high: false }] }] }))).not.toBe(k);
    expect(navKey({ ...base, markers: { ...base.markers, PASS: marker('PASS', 10, 1.2, { x: -1, z: 0 }) } })).not.toBe(k);
    expect(navKey({ ...base, floor: { width: 12.2, depth: 8 } })).not.toBe(k);
  });

  it('dati monchi non la fanno cadere', () => {
    const rotta = sala({
      floor: { width: Number.NaN, depth: -3 },
      tables: [null as unknown as TableModel, { ...modello(1, 4, 3.5), center: { x: Number.NaN, z: 1 }, chairs: undefined as unknown as [] }],
      markers: {} as RoomModel['markers'],
    });
    const grid = buildNavGrid(rotta);
    expect([grid.cols, grid.rows]).toEqual([5, 5]);
    expect(findPath(grid, { x: 0.3, z: 0.3 }, { x: 0.7, z: 0.7 })).toEqual([{ x: 0.3, z: 0.3 }, { x: 0.7, z: 0.7 }]);
    expect(() => roomAnchors(rotta, grid)).not.toThrow();
  });
});

describe('i percorsi', () => {
  it('aggirano un tavolo: nessun punto dentro il tavolo o una sedia, ogni tratto a vista', () => {
    const t = modello(1, 6, 4, { seats: 6 });
    const grid = buildNavGrid(sala({ tables: [t] }));
    const from = { x: 2, z: 4 };
    const to = { x: 10, z: 4 };
    expect(lineOfSight(grid, from, to)).toBe(false);
    const path = findPath(grid, from, to);
    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    expect(path.length).toBeGreaterThan(2);
    for (const p of path) {
      expect(dentroTavolo(t, p), `${p.x},${p.z}`).toBe(false);
      expect(dentroSedia(t, p), `${p.x},${p.z}`).toBe(false);
    }
    segmentiLiberi(grid, path);
    // Un giro corto, non il giro della sala: al più un paio di metri in più.
    expect(lunghezza(path)).toBeGreaterThan(8);
    expect(lunghezza(path)).toBeLessThan(10);
  });

  it('niente tagli d\'angolo fra due celle bloccate in diagonale', () => {
    const grid = griglia(20, 20, [[9, 9], [10, 10]]);
    const a = centro(grid, 9, 10);
    const b = centro(grid, 10, 9);
    // Il segmento passa per il vertice comune: la vista è chiusa.
    expect(lineOfSight(grid, a, b)).toBe(false);
    const path = findPath(grid, a, b);
    expect(path.length).toBeGreaterThan(2);
    segmentiLiberi(grid, path);
    expect(lunghezza(path)).toBeGreaterThan(2 * CELL);
    // Un muro in diagonale (solo celle che si toccano agli spigoli) non si
    // attraversa: si gira attorno alla sua punta.
    const muro = griglia(20, 20, Array.from({ length: 14 }, (_, k) => [k + 3, k + 3] as [number, number]));
    const sotto = centro(muro, 5, 12);
    const sopra = centro(muro, 12, 5);
    const giro = findPath(muro, sotto, sopra);
    segmentiLiberi(muro, giro);
    expect(giro.some(p => p.x < 3 * CELL && p.z < 3 * CELL) || giro.some(p => p.x > 17 * CELL && p.z > 17 * CELL)).toBe(true);
  });

  it('il filo teso toglie i nodi allineati: in una sala libera, da un angolo all\'altro, due punti', () => {
    const grid = buildNavGrid(sala());
    expect(findPath(grid, { x: 0.5, z: 0.5 }, { x: 11.5, z: 7.3 })).toEqual([{ x: 0.5, z: 0.5 }, { x: 11.5, z: 7.3 }]);
    // Lungo un corridoio dritto, anche con capi che non sono centri di cella.
    expect(findPath(grid, { x: 1.03, z: 3.31 }, { x: 9.87, z: 3.31 })).toHaveLength(2);
    // Attorno a un tavolo, nessun punto allineato coi suoi vicini.
    const path = findPath(buildNavGrid(sala({ tables: [modello(1, 6, 4, { seats: 6 })] })), { x: 2, z: 4 }, { x: 10, z: 4 });
    for (let k = 1; k + 1 < path.length; k++) {
      const [a, b, c] = [path[k - 1], path[k], path[k + 1]];
      const cross = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      expect(Math.abs(cross)).toBeGreaterThan(1e-6);
    }
  });

  it('un punto bloccato si risolve sulla cella libera più vicina, entro 1 m, e il percorso finisce comunque lì', () => {
    const t = modello(1, 6, 4, { seats: 6 });
    const grid = buildNavGrid(sala({ tables: [t] }));
    // Il punto d'approccio della sedia è libero; la sedia no.
    const sedia = { x: t.chairs[0].x, z: t.chairs[0].z };
    expect(isFree(grid, sedia.x, sedia.z)).toBe(false);
    const vicina = nearestFree(grid, sedia)!;
    expect(isFree(grid, vicina.x, vicina.z)).toBe(true);
    expect(Math.hypot(vicina.x - sedia.x, vicina.z - sedia.z)).toBeLessThanOrEqual(1.0);
    // Nessuna cella libera più vicina di quella.
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.cols; i++) {
        if (grid.blocked[j * grid.cols + i]) continue;
        const c = centro(grid, i, j);
        expect(Math.hypot(c.x - sedia.x, c.z - sedia.z)).toBeGreaterThanOrEqual(Math.hypot(vicina.x - sedia.x, vicina.z - sedia.z) - 1e-12);
      }
    }
    const path = findPath(grid, { x: 2, z: 1 }, sedia);
    expect(path[path.length - 1]).toEqual(sedia);
    expect(path[path.length - 2]).toEqual(vicina);
    segmentiLiberi(grid, path, 0, path.length - 2);
    // Anche la partenza: da dentro il tavolo si esce dalla cella libera più vicina.
    const daDentro = findPath(grid, { x: 6, z: 4 }, { x: 1, z: 7 });
    expect(daDentro[0]).toEqual({ x: 6, z: 4 });
    expect(isFree(grid, daDentro[1].x, daDentro[1].z)).toBe(true);
    // Un punto in un posto tutto bloccato per 2 m: niente.
    const piena = griglia(30, 30, Array.from({ length: 28 * 28 }, (_, k) => [1 + (k % 28), 1 + Math.floor(k / 28)] as [number, number]));
    expect(nearestFree(piena, centro(piena, 15, 15))).toBeNull();
    // Il passo, da fuori dalla porta: entra dal varco.
    const fuori = { x: 6, z: 8.6 };
    const entrata = findPath(grid, fuori, { x: 3, z: 6 });
    expect(entrata[0]).toEqual(fuori);
    expect(isFree(grid, entrata[1].x, entrata[1].z)).toBe(true);
    expect(entrata[1].z).toBeGreaterThan(7.4);
  });

  it('senza strada (o oltre il tetto) la retta: [from, to], e presto', () => {
    // La meta chiusa in un anello di celle bloccate.
    const anello: Array<[number, number]> = [];
    for (let i = 8; i <= 12; i++) for (let j = 8; j <= 12; j++) if (i === 8 || i === 12 || j === 8 || j === 12) anello.push([i, j]);
    const grid = griglia(150, 200, anello);
    const from = centro(grid, 2, 2);
    const to = centro(grid, 10, 10);
    const t0 = performance.now();
    expect(findPath(grid, from, to)).toEqual([from, to]);
    expect(performance.now() - t0).toBeLessThan(200);
    // Una sala enorme (90 000 celle) senza strada: A* si ferma a NODE_CAP.
    expect(NODE_CAP).toBe(40_000);
    const enorme = griglia(300, 300, anello.map(([i, j]) => [i + 140, j + 140] as [number, number]));
    const t1 = performance.now();
    expect(findPath(enorme, centro(enorme, 2, 2), centro(enorme, 150, 150))).toHaveLength(2);
    expect(performance.now() - t1).toBeLessThan(200);
    // Partenza e arrivo nella stessa cella: la retta.
    expect(findPath(grid, { x: 1.01, z: 1.01 }, { x: 1.09, z: 1.05 })).toEqual([{ x: 1.01, z: 1.01 }, { x: 1.09, z: 1.05 }]);
  });

  it('stessi ingressi, stesso percorso (anche su una griglia rifatta)', () => {
    const tavoli = [modello(1, 4, 3, { seats: 6 }), modello(2, 8, 3.5, { shape: TableShape.CIRCLE, seats: 6 }), modello(3, 6, 5.6, { rotation: 30 })];
    const a = findPath(buildNavGrid(sala({ tables: tavoli })), { x: 1, z: 7 }, { x: 10.5, z: 1 });
    const b = findPath(buildNavGrid(sala({ tables: tavoli })), { x: 1, z: 7 }, { x: 10.5, z: 1 });
    expect(b).toEqual(a);
    // E la stessa griglia, interrogata di nuovo dopo altri percorsi.
    const grid = buildNavGrid(sala({ tables: tavoli }));
    const prima = findPath(grid, { x: 1, z: 7 }, { x: 10.5, z: 1 });
    findPath(grid, { x: 11, z: 7 }, { x: 1, z: 1 });
    findPath(grid, { x: 6, z: 0.5 }, { x: 6, z: 7.5 });
    expect(findPath(grid, { x: 1, z: 7 }, { x: 10.5, z: 1 })).toEqual(prima);
    expect(prima).toEqual(a);
  });

  it('30 000 celle: da un angolo all\'altro attorno ai tavoli in meno di 20 ms', () => {
    // 40 × 30 m (200 × 150 celle): sei file di tavoli da 6 accostati a 2 m,
    // che fanno muro, col varco una volta a destra e una a sinistra. Il
    // percorso deve serpeggiare per tutta la sala (quasi 250 m): il caso
    // peggiore per A*, che deve riempire ogni corridoio.
    const tavoli: TableModel[] = [];
    let id = 1;
    for (let r = 0; r < 6; r++) {
      const z = 3 + r * 4.5;
      const varcoADestra = r % 2 === 0;
      for (let c = 0; c < 20; c++) {
        if (varcoADestra ? c >= 18 : c < 2) continue;
        tavoli.push(modello(id++, 1 + c * 2, z, { seats: 6 }));
      }
    }
    const room = sala({
      floor: { width: 40, depth: 30 },
      tables: tavoli,
      markers: {
        ENTRANCE: marker('ENTRANCE', 20, 29.6),
        PASS: marker('PASS', 39, 1.2, { x: -1, z: 0 }),
        HOST_STAND: marker('HOST_STAND', 21.2, 28.6),
      },
    });
    const t0 = performance.now();
    const grid = buildNavGrid(room);
    // Anche la griglia si fa in fretta: si rifà a ogni tavolo spostato.
    expect(performance.now() - t0).toBeLessThan(50);
    expect(grid.cols * grid.rows).toBe(30_000);
    const from = { x: 0.5, z: 0.5 };
    const to = { x: 39.5, z: 29.5 };
    findPath(grid, from, to); // riscaldamento: i buffer della griglia
    const tempi: number[] = [];
    let path: Vec2[] = [];
    for (let k = 0; k < 7; k++) {
      const t = performance.now();
      path = findPath(grid, from, to);
      tempi.push(performance.now() - t);
    }
    tempi.sort((p, q) => p - q);
    // La mediana di 7: una pausa del garbage collector non fa fallire il test.
    expect(tempi[3]).toBeLessThan(20);
    expect(path[0]).toEqual(from);
    expect(path[path.length - 1]).toEqual(to);
    segmentiLiberi(grid, path);
    // Ha davvero serpeggiato: sei inversioni, più di 200 m.
    expect(lunghezza(path)).toBeGreaterThan(200);
  });
});

describe('i punti fissi della sala', () => {
  it('la porta sul muro: inside libero e sul pavimento, outside oltre il muro', () => {
    const room = sala();
    const grid = buildNavGrid(room);
    const a = roomAnchors(room, grid);
    expect(a.roomId).toBe(1);
    // La porta sulla mezzeria dello zoccolo in basso, rivolta alla sala (−z).
    expect(a.door).toEqual({ x: 6, z: 8 - 0.025, yaw: Math.PI });
    expect(a.inside.x).toBe(6);
    expect(a.inside.z).toBeCloseTo(8 - 0.025 - DOOR_INSIDE, 12);
    expect(isFree(grid, a.inside.x, a.inside.z)).toBe(true);
    expect(a.outside.z).toBeCloseTo(8 - 0.025 + DOOR_OUTSIDE, 12);
    expect(a.outside.z).toBeGreaterThan(room.floor.depth);
    // Fra outside e inside si passa dal varco.
    expect(isFree(grid, 6, 7.9)).toBe(true);
  });

  it('l\'hostess accoglie dalla parte del leggio, rivolta alla porta; i posti dell\'ingresso stanno dall\'altra', () => {
    const lato = (room: RoomModel) => {
      const a = roomAnchors(room, buildNavGrid(room));
      return Math.sign(a.greet.x - a.inside.x);
    };
    // Il leggio a destra di chi entra (porta in basso: la destra è +x).
    const destra = sala();
    const a = roomAnchors(destra, buildNavGrid(destra));
    expect(a.greet.x).toBeCloseTo(a.inside.x + GREET_SIDE, 1);
    expect(isFree(buildNavGrid(destra), a.greet.x, a.greet.z)).toBe(true);
    // Rivolta alla porta.
    const dir = { x: Math.sin(a.greet.yaw), z: Math.cos(a.greet.yaw) };
    const versoPorta = { x: a.door.x - a.greet.x, z: a.door.z - a.greet.z };
    const len = Math.hypot(versoPorta.x, versoPorta.z);
    expect(dir.x * versoPorta.x / len + dir.z * versoPorta.z / len).toBeCloseTo(1, 9);
    // Il leggio a sinistra: l'hostess a sinistra.
    const sinistra = sala({ markers: { ...sala().markers, HOST_STAND: marker('HOST_STAND', 4.8, 6.6) } });
    expect(lato(sinistra)).toBe(-1);
    // Sull'asse della porta: lobbyCells mette i posti a destra, lei a sinistra.
    const asse = sala({ markers: { ...sala().markers, HOST_STAND: marker('HOST_STAND', 6, 5.5) } });
    expect(lato(asse)).toBe(-1);
    for (const room of [destra, sinistra, asse]) {
      const celle = lobbyCells(room);
      expect(Math.sign(celle[0].x - 6)).toBe(-lato(room));
    }
  });

  it('una porta sul muro di sinistra e una lontana dai muri', () => {
    const room = sala({ markers: { ...sala().markers, ENTRANCE: marker('ENTRANCE', 0.4, 4, { x: 1, z: 0 }), HOST_STAND: marker('HOST_STAND', 1.4, 5) } });
    const a = roomAnchors(room, buildNavGrid(room));
    expect(a.door.x).toBeCloseTo(0.025, 12);
    expect(a.door.yaw).toBeCloseTo(Math.PI / 2, 12);
    expect(a.inside.x).toBeCloseTo(0.025 + DOOR_INSIDE, 12);
    expect(a.outside.x).toBeLessThan(0);
    // Entrando verso +x la destra è +z: il leggio è lì.
    expect(a.greet.z).toBeGreaterThan(a.inside.z);
    // Lontana dai muri: al segnaposto, girata come `inward`.
    const libera = sala({ markers: { ...sala().markers, ENTRANCE: marker('ENTRANCE', 6, 5, { x: 0, z: -1 }) } });
    const b = roomAnchors(libera, null);
    expect(b.door).toEqual({ x: 6, z: 5, yaw: Math.PI });
    expect(b.inside.z).toBeCloseTo(5 - DOOR_INSIDE, 12);
    expect(b.outside.z).toBeCloseTo(5 + DOOR_OUTSIDE, 12);
  });

  it('senza griglia i punti restano dove la geometria li mette; con la griglia scivolano sul libero', () => {
    // Un tavolo proprio davanti alla porta.
    const room = sala({ tables: [modello(1, 6, 7, { seats: 4 })] });
    const grid = buildNavGrid(room);
    const nudo = roomAnchors(room, null);
    expect(isFree(grid, nudo.inside.x, nudo.inside.z)).toBe(false);
    const a = roomAnchors(room, grid);
    expect(isFree(grid, a.inside.x, a.inside.z)).toBe(true);
    expect(Math.hypot(a.inside.x - nudo.inside.x, a.inside.z - nudo.inside.z)).toBeLessThanOrEqual(2);
    expect(isFree(grid, a.greet.x, a.greet.z)).toBe(true);
  });

  it('il pass: davanti al banco rivolto al banco; i camerieri in file da 3 dentro il pavimento', () => {
    const room = sala();
    const grid = buildNavGrid(room);
    const a = roomAnchors(room, grid);
    expect(a.passFront.x).toBeCloseTo(11 - PASS_FRONT, 1);
    expect(a.passFront.z).toBeCloseTo(1.2, 1);
    expect(isFree(grid, a.passFront.x, a.passFront.z)).toBe(true);
    // Rivolto al banco: verso +x.
    expect(Math.sin(a.passFront.yaw)).toBeCloseTo(1, 12);
    const slots = [0, 1, 2, 3, 4, 5].map(i => passSlot(room, a, i));
    expect([slots[0].x, slots[0].z]).toEqual([a.passFront.x, a.passFront.z]);
    // La fila: lungo il banco, a 60 cm; la seconda fila 60 cm più dentro.
    expect(slots[1].x).toBeCloseTo(a.passFront.x, 12);
    expect(Math.abs(slots[1].z - slots[0].z)).toBeCloseTo(PASS_SLOT_PITCH, 12);
    expect(slots[2].z - slots[0].z).toBeCloseTo(-(slots[1].z - slots[0].z), 12);
    expect(slots[3].x).toBeCloseTo(a.passFront.x - PASS_SLOT_PITCH, 12);
    expect(slots[3].z).toBeCloseTo(slots[0].z, 12);
    for (const s of slots) expect(s.yaw).toBe(a.passFront.yaw);
    // Vicino al muro in alto: chi finirebbe nel muro resta a 30 cm.
    const alto = sala({ markers: { ...sala().markers, PASS: marker('PASS', 11, 0.6, { x: -1, z: 0 }) } });
    const b = roomAnchors(alto, null);
    for (let i = 0; i < 9; i++) {
      const s = passSlot(alto, b, i);
      expect(s.z).toBeGreaterThanOrEqual(FLOOR_MARGIN);
      expect(s.x).toBeLessThanOrEqual(12 - FLOOR_MARGIN);
    }
    // Con il pass libero, i posti liberi sono gli stessi.
    expect(passSlots(room, a, grid, 6)).toEqual(slots);
  });

  it('i posti al pass stanno sul libero: un tavolo da 4 accanto al banco non ci mette un cameriere sulla sedia', () => {
    // Il tavolo appena sotto il pass, con le sedie dove cadrebbero il secondo
    // e il terzo posto della prima fila.
    const t = modello(1, 10.2, 2.1);
    const room = sala({ tables: [t] });
    const grid = buildNavGrid(room);
    const a = roomAnchors(room, grid);
    const raw = [0, 1, 2].map(i => passSlot(room, a, i));
    expect(raw.some(s => !isFree(grid, s.x, s.z))).toBe(true);
    const slots = passSlots(room, a, grid, 9);
    expect(slots.length).toBe(9);
    for (const [k, s] of slots.entries()) {
      expect(isFree(grid, s.x, s.z), `posto ${k}`).toBe(true);
      for (const c of t.chairs) expect(Math.hypot(s.x - c.x, s.z - c.z), `posto ${k}`).toBeGreaterThan(CHAIR_R + AGENT_R - 1e-9);
      for (const o of slots.slice(0, k)) expect(Math.hypot(s.x - o.x, s.z - o.z)).toBeGreaterThanOrEqual(PASS_SLOT_PITCH - 1e-6);
      expect(s.yaw).toBe(a.passFront.yaw);
    }
    // Lo stesso numero più grande dà gli stessi primi posti.
    expect(passSlots(room, a, grid, 12).slice(0, 9)).toEqual(slots);
  });
});

describe('il capo del tavolo', () => {
  it('rettangolo: il capo più vicino a `toward`, a L/2 + gap, rivolto al centro', () => {
    const t = modello(1, 6, 4, { seats: 6 });
    const grid = buildNavGrid(sala({ tables: [t] }));
    const sx = tableSidePoint(t, { x: 1, z: 6 }, grid, 0.45, 0.5);
    expect(sx.x).toBeCloseTo(6 - t.length / 2 - 0.45, 12);
    expect(sx.z).toBeCloseTo(4, 12);
    expect(Math.sin(sx.yaw)).toBeCloseTo(1, 12);
    const dx = tableSidePoint(t, { x: 11, z: 1 }, grid, 0.45, 0.5);
    expect(dx.x).toBeCloseTo(6 + t.length / 2 + 0.45, 12);
    expect(Math.sin(dx.yaw)).toBeCloseTo(-1, 12);
    // Ruotato di 90°: i capi stanno sopra e sotto.
    const r = modello(2, 6, 4, { seats: 6, rotation: 90 });
    const sotto = tableSidePoint(r, { x: 6, z: 8 }, null, 0.45, 0.5);
    expect(sotto.x).toBeCloseTo(6, 9);
    expect(sotto.z).toBeCloseTo(4 + r.length / 2 + 0.45, 9);
  });

  it('una testa occupata da una sedia in più: l\'altro capo', () => {
    const base = modello(1, 6, 4, { seats: 4 });
    const testa = { x: 6 + base.length / 2 + 0.3, z: 4, yaw: -Math.PI / 2, lit: true, high: false };
    const t = { ...base, extraChairs: [testa] };
    const grid = buildNavGrid(sala({ tables: [t] }));
    const p = tableSidePoint(t, { x: 11, z: 4 }, grid, 0.45, 0.5);
    expect(p.x).toBeCloseTo(6 - t.length / 2 - 0.45, 12);
    // Senza griglia non si sa che è occupata: il capo più vicino.
    expect(tableSidePoint(t, { x: 11, z: 4 }, null, 0.45, 0.5).x).toBeCloseTo(6 + t.length / 2 + 0.45, 12);
    // Tutte e due le teste occupate: la cella libera più vicina al capo più vicino.
    const due = { ...t, extraChairs: [testa, { ...testa, x: 6 - base.length / 2 - 0.3, yaw: Math.PI / 2 }] };
    const g2 = buildNavGrid(sala({ tables: [due] }));
    const q = tableSidePoint(due, { x: 11, z: 4 }, g2, 0.45, 0.5);
    expect(isFree(g2, q.x, q.z)).toBe(true);
    expect(q.x).toBeGreaterThan(6);
  });

  it('tondo: il varco fra due sedie più vicino a `toward`, a raggio Dc/2 + gap', () => {
    const t = modello(1, 6, 4, { shape: TableShape.CIRCLE, seats: 4 });
    const grid = buildNavGrid(sala({ tables: [t] }));
    const angoli = t.chairs.map(c => Math.atan2(c.z - 4, c.x - 6));
    // Verso il basso a destra: il varco fra le due sedie di quel quarto.
    const p = tableSidePoint(t, { x: 11, z: 8 }, grid, 0.45, 0.5);
    expect(Math.hypot(p.x - 6, p.z - 4)).toBeCloseTo(t.length / 2 + 0.5, 9);
    const phi = Math.atan2(p.z - 4, p.x - 6);
    // Non sopra una sedia: a metà fra le due più vicine.
    const distanze = angoli.map(a => Math.abs(Math.atan2(Math.sin(a - phi), Math.cos(a - phi)))).sort((x, y) => x - y);
    expect(distanze[0]).toBeCloseTo(distanze[1], 9);
    expect(p.x).toBeGreaterThan(6);
    expect(p.z).toBeGreaterThan(4);
    // Rivolto al centro.
    expect(Math.sin(p.yaw) * (6 - p.x) + Math.cos(p.yaw) * (4 - p.z)).toBeCloseTo(Math.hypot(6 - p.x, 4 - p.z), 9);
    // Senza sedie: otto direzioni.
    const nudo = { ...t, chairs: [] };
    const q = tableSidePoint(nudo, { x: 6, z: 0 }, null, 0.45, 0.5);
    expect(q.x).toBeCloseTo(6, 9);
    expect(q.z).toBeCloseTo(4 - (t.length / 2 + 0.5), 9);
  });
});
