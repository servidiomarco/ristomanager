import { beforeAll, describe, it, expect } from 'vitest';
import {
  ArrivalStatus,
  PaymentStatus,
  ReservationStatus,
  Shift,
  TableShape,
  TableStatus,
  type BanquetMenu,
  type Reservation,
  type Room,
  type Table,
} from '../../types';
import { litChairIndices } from '../../utils/tableGeometry';
import { setSessionTimeZone } from '../../utils/displayTime';
import type { ChairModel, FigureSlot, MarkerModel, RoomModel, SceneInputs, TableModel } from '../../components/salaVivo/types';
import { HIGH_CHAIR_SEAT_HEIGHT, SEAT_HEIGHT, placeTable } from '../../components/salaVivo/model/geometry';
import { liveService } from '../../components/salaVivo/model/service';
import type { PartyComposition } from '../../components/salaVivo/model/party';
import { MAX_PARTY_PEOPLE } from '../../components/salaVivo/model/presence';
import {
  DOG_OUT,
  DOG_SIDE,
  FLOOR_MARGIN,
  HEAD_GAP,
  KID_TINT,
  PARTY_TINT_MAX,
  STAND_GAP,
  STAND_PITCH,
  figureKey,
  hostSpot,
  hostessFigure,
  interleave,
  lobbyCells,
  lobbyFigures,
  partyTint,
  ringOrder,
  seatParty,
  spillTableIds,
  toLocal,
  toWorld,
} from '../../components/salaVivo/model/placement';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';

/* Dove sta ogni persona: sulle sedie che la piantina accende, alle teste,
 * sull'anello ridistribuito, in piedi, all'ingresso, all'accoglienza. Le
 * posizioni si controllano in coordinate locali del tavolo (x lungo il lato
 * lungo, z verso il bordo basso del glifo), così valgono a ogni rotazione.
 *
 * Le misure dei tavoli (geometry.ts): un rettangolo da 4 è lungo 1,12 m, le
 * sedie a (±0,26, ∓0,85); da 6 è lungo 1,64 m, le sedie a −0,52, 0, +0,52;
 * un tondo da 4 ha le sedie a 0,93 m dal centro. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const tavolo = (over: Partial<Table> = {}, id = 1): Table => ({
  id,
  name: String(id),
  shape: TableShape.RECTANGLE,
  seats: 4,
  x: 100,
  y: 100,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

// Un tavolo disegnato, libero: tutte le sedie accese, come in 2D.
const modello = (over: Partial<Table> = {}, id = 1): TableModel => {
  const t = tavolo(over, id);
  const p = placeTable(t, t.seats, litChairIndices(t.shape, t.seats, 0));
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

const comitiva = (adults: number, kids: number, over: Partial<PartyComposition> = {}): PartyComposition =>
  ({ adults, kids, dogs: 0, highChair: false, ...over });

const siedi = (tables: TableModel[], composition: PartyComposition, partyId = 12) =>
  seatParty({ partyId, composition, tables });

const vicino = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const su = (c: ChairModel, f: FigureSlot) => vicino(c.x, f.x) && vicino(c.z, f.z);
// L'indice della sedia (della piantina o ridistribuita) su cui siede f.
const sediaDi = (t: { chairs: ChairModel[] }, f: FigureSlot) => t.chairs.findIndex(c => su(c, f));
const accese = (chairs: ChairModel[]) => chairs.flatMap((c, i) => (c.lit ? [i] : []));
const persone = (figures: FigureSlot[]) => figures.filter(f => f.kind === 'adult' || f.kind === 'kid');
// La posizione di una figura nel sistema del tavolo, arrotondata al mm.
const locale = (t: TableModel, p: { x: number; z: number }) => {
  const { lx, lz } = toLocal(t, p.x, p.z);
  return [Math.round(lx * 1000) / 1000 + 0, Math.round(lz * 1000) / 1000 + 0];
};
const angolo = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

describe('le sedie che la piantina accende', () => {
  it('6 posti e 4 ospiti: le sedie 0 e 1 sopra, 0 e 1 sotto, e solo quelle accese', () => {
    const t = modello({ seats: 6 });
    const plan = siedi([t], comitiva(4, 0));
    const seduti = plan.tables.get(1)!;
    expect(plan.figures.map(f => sediaDi(seduti, f))).toEqual([0, 1, 4, 3]);
    expect(accese(seduti.chairs)).toEqual([0, 1, 3, 4]);
    expect(accese(seduti.chairs)).toEqual(litChairIndices(TableShape.RECTANGLE, 6, 4));
    expect(seduti.extraChairs).toEqual([]);
    for (const f of plan.figures) {
      const c = seduti.chairs[sediaDi(seduti, f)];
      expect([f.pose, f.seatHeight, f.yaw, f.tableId]).toEqual(['seated', SEAT_HEIGHT, c.yaw, 1]);
    }
    // Le sedie restano quelle della piantina, nello stesso posto.
    expect(seduti.chairs.map(c => [c.x, c.z])).toEqual(t.chairs.map(c => [c.x, c.z]));
    expect(seduti.chairs.every(c => !c.high)).toBe(true);
  });

  it('attorno al tavolo, in senso orario: [0, 1, 3, 4] diventa 0, 1, 4, 3', () => {
    const t = modello({ seats: 6 });
    const scelte = [0, 1, 3, 4].map(i => t.chairs[i]);
    expect(ringOrder(t, scelte)).toEqual([0, 1, 3, 2]);
    // Si parte dal primo punto dato.
    expect(ringOrder(t, [t.chairs[4], t.chairs[0], t.chairs[1]]).map(i => [4, 0, 1][i])).toEqual([4, 0, 1]);
    expect(ringOrder(t, [])).toEqual([]);
  });

  it('adulti e bambini alternati attorno al tavolo', () => {
    expect(interleave(2, 2).map(m => `${m.kind[0]}${m.n}`)).toEqual(['a0', 'k0', 'a1', 'k1']);
    expect(interleave(2, 1).map(m => `${m.kind[0]}${m.n}`)).toEqual(['a0', 'k0', 'a1']);
    expect(interleave(0, 3).map(m => `${m.kind[0]}${m.n}`)).toEqual(['k0', 'k1', 'k2']);
    expect(interleave(3, 1).map(m => `${m.kind[0]}${m.n}`)).toEqual(['a0', 'k0', 'a1', 'a2']);
    expect(interleave(Number.NaN, -2)).toEqual([]);

    // 2 adulti e 2 bambini su 6 posti: a0 sopra 0, k0 sopra 1, a1 sotto 1,
    // k1 sotto 0. Ogni bambino ha un adulto accanto.
    const sei = modello({ seats: 6 });
    const famiglia = siedi([sei], comitiva(2, 2));
    const t6 = famiglia.tables.get(1)!;
    expect(famiglia.figures.map(f => [f.key, sediaDi(t6, f)])).toEqual([
      ['r12:a0', 0], ['r12:k0', 1], ['r12:a1', 4], ['r12:k1', 3],
    ]);

    // 2 adulti e 1 bambino su 4: A K A.
    const quattro = modello();
    const tre = siedi([quattro], comitiva(2, 1));
    expect(tre.figures.map(f => [f.kind, sediaDi(tre.tables.get(1)!, f)])).toEqual([['adult', 0], ['kid', 1], ['adult', 2]]);

    // Senza adulti, tutti bambini.
    expect(siedi([quattro], comitiva(0, 3)).figures.map(f => f.kind)).toEqual(['kid', 'kid', 'kid']);
  });

  it('gli indici delle sedie non dipendono dalla rotazione del tavolo', () => {
    for (const rotation of [0, 90, 180, 270, 37, -45]) {
      const t = modello({ seats: 6, rotation });
      const plan = siedi([t], comitiva(2, 2));
      expect(plan.figures.map(f => sediaDi(plan.tables.get(1)!, f)), `rotazione ${rotation}`).toEqual([0, 1, 4, 3]);
    }
  });

  it('toWorld e toLocal sono l\'una l\'inversa dell\'altra, con la rotazione di placeTable', () => {
    const dritto = modello({ seats: 6 });
    const storto = modello({ seats: 6, rotation: 37 });
    storto.chairs.forEach((c, i) => {
      // Ruotato o no, ogni sedia sta nello stesso punto del tavolo.
      expect(locale(storto, c)).toEqual(locale(dritto, dritto.chairs[i]));
      const { lx, lz } = toLocal(storto, c.x, c.z);
      const p = toWorld(storto, lx, lz);
      expect(p.x).toBeCloseTo(c.x, 12);
      expect(p.z).toBeCloseTo(c.z, 12);
    });
  });
});

describe('chi non entra nelle sedie', () => {
  it('rettangolo pieno: le teste libere, a ±(lunghezza/2 + 0,30), prima la destra', () => {
    const t = modello();
    expect(t.length).toBeCloseTo(1.12, 9);
    const plan = siedi([t], comitiva(6, 0));
    const seduti = plan.tables.get(1)!;
    expect(accese(seduti.chairs)).toEqual([0, 1, 2, 3]);
    expect(seduti.extraChairs.map(c => locale(t, c))).toEqual([[0.86, 0], [-0.86, 0]]);
    expect(HEAD_GAP).toBe(0.3);
    expect(seduti.extraChairs.map(c => [c.lit, c.high])).toEqual([[true, false], [true, false]]);
    // Rivolte al tavolo.
    expect(seduti.extraChairs.map(c => angolo(c.yaw))).toEqual([-Math.PI / 2, Math.PI / 2]);
    const [a4, a5] = plan.figures.slice(4);
    expect([a4.key, a4.pose, locale(t, a4)]).toEqual(['r12:a4', 'seated', [0.86, 0]]);
    expect([a5.key, a5.pose, locale(t, a5)]).toEqual(['r12:a5', 'seated', [-0.86, 0]]);
  });

  it('rettangolo con le teste prese: in piedi 0,55 m dietro le teste, poi dietro le sedie, giro dopo giro', () => {
    const t = modello();
    const sette = siedi([t], comitiva(7, 0));
    const inPiedi = sette.figures.filter(f => f.pose === 'standing');
    expect(inPiedi).toHaveLength(1);
    // Dietro la testa destra, rivolto come lei: al capo del tavolo non copre
    // nessuno, dietro una fila di sedute sembrerebbe una seconda fila.
    expect(STAND_GAP).toBe(0.55);
    const testa = sette.tables.get(1)!.extraChairs[0];
    expect(locale(t, inPiedi[0])).toEqual([1.41, 0]);
    expect([inPiedi[0].yaw, inPiedi[0].seatHeight, inPiedi[0].tableId]).toEqual([testa.yaw, 0, 1]);

    // 13 su 4 posti: 4 sedute, 2 alle teste, 7 in piedi: dietro le due teste,
    // poi attorno alle sedie (sopra, sotto); il settimo al secondo giro.
    const tredici = siedi([t], comitiva(13, 0)).figures;
    expect(tredici.filter(f => f.pose === 'seated')).toHaveLength(6);
    const giro = tredici.filter(f => f.pose === 'standing').map(f => locale(t, f));
    expect(giro).toEqual([
      [1.41, 0], [-1.41, 0], [-0.26, -1.4], [0.26, -1.4], [0.26, 1.4], [-0.26, 1.4],
      [1.41 + STAND_PITCH, 0],
    ]);
  });

  it('contro i muri nessuno ci finisce dentro: teste, posti in piedi e cani restano sul pavimento', () => {
    // Un tavolo da 4 nell'angolo in alto a sinistra (il glifo è 1,84 × 2 m):
    // il capo sinistro e il lato sopra contro i muri.
    const t = modello({ x: 0, y: 0 });
    const floor = { width: 10, depth: 8 };
    const dentro = (p: { x: number; z: number }) =>
      p.x >= FLOOR_MARGIN - 1e-9 && p.x <= floor.width - FLOOR_MARGIN + 1e-9
      && p.z >= FLOOR_MARGIN - 1e-9 && p.z <= floor.depth - FLOOR_MARGIN + 1e-9;
    const plan = seatParty({ partyId: 12, composition: comitiva(9, 0, { dogs: 1 }), tables: [t], floor });
    const seduti = plan.tables.get(1)!;
    // La testa sinistra sarebbe nel muro: c'è solo la destra.
    expect(seduti.extraChairs.map(c => locale(t, c))).toEqual([[0.86, 0]]);
    // 4 sedute, 1 alla testa, 4 in piedi: dietro la testa, dietro le due
    // sedie sotto (quelle sopra darebbero nel muro), di nuovo dietro la testa.
    const inPiedi = plan.figures.filter(f => f.pose === 'standing');
    expect(inPiedi.map(f => locale(t, f))).toEqual([[1.41, 0], [0.26, 1.4], [-0.26, 1.4], [1.91, 0]]);
    expect(inPiedi.every(dentro)).toBe(true);
    // Il cane del primo adulto, seduto in alto a sinistra contro il muro, resta
    // sul pavimento.
    const cani = plan.figures.filter(f => f.kind === 'dog');
    expect(cani).toHaveLength(1);
    expect(cani.every(dentro)).toBe(true);
    // Senza pavimento nessun controllo: tutte e due le teste.
    expect(siedi([t], comitiva(9, 0)).tables.get(1)!.extraChairs).toHaveLength(2);
  });

  it('una comitiva enorme che non sta attorno al tavolo resta dentro la sala, sul bordo', () => {
    // 100 su un tavolo da 4 in una sala di 6 × 5 m: i giri finiscono contro i
    // muri, e chi resta sta sul bordo invece che oltre.
    const t = modello({ x: 100, y: 75 });
    const floor = { width: 6, depth: 5 };
    const plan = seatParty({ partyId: 12, composition: comitiva(100, 0), tables: [t], floor });
    expect(plan.figures).toHaveLength(100);
    for (const f of plan.figures.filter(f => f.pose === 'standing')) {
      expect(f.x).toBeGreaterThanOrEqual(FLOOR_MARGIN - 1e-9);
      expect(f.x).toBeLessThanOrEqual(floor.width - FLOOR_MARGIN + 1e-9);
      expect(f.z).toBeGreaterThanOrEqual(FLOOR_MARGIN - 1e-9);
      expect(f.z).toBeLessThanOrEqual(floor.depth - FLOOR_MARGIN + 1e-9);
    }
  });

  it('tondo pieno: l\'anello si ridistribuisce per tutti, sedia 0 a ore 12, tutte accese', () => {
    const t = modello({ shape: TableShape.CIRCLE });
    const raggio = Math.hypot(t.chairs[0].x - t.center.x, t.chairs[0].z - t.center.z);
    expect(raggio).toBeCloseTo(0.93, 9);
    const plan = siedi([t], comitiva(4, 2));
    const seduti = plan.tables.get(1)!;
    expect(seduti.chairs).toHaveLength(6);
    expect(accese(seduti.chairs)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(seduti.extraChairs).toEqual([]);
    seduti.chairs.forEach((c, i) => {
      const phi = -Math.PI / 2 + (2 * Math.PI * i) / 6;
      expect(locale(t, c)).toEqual(locale(t, toWorld(t, raggio * Math.cos(phi), raggio * Math.sin(phi))));
      // Rivolta al centro.
      expect(angolo(c.yaw)).toBeCloseTo(Math.atan2(t.center.x - c.x, t.center.z - c.z), 12);
    });
    expect(locale(t, seduti.chairs[0])).toEqual([0, -0.93]);
    // Ognuno sulla sua sedia, in ordine: le persone alternate dell'anello.
    expect(plan.figures.map(f => sediaDi(seduti, f))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(plan.figures.every(f => f.pose === 'seated')).toBe(true);
  });

  it('tondo oltre le sedie che ci stanno (una ogni 48 cm): gli altri in piedi', () => {
    const t = modello({ shape: TableShape.CIRCLE });
    // 2π · 0,93 / 0,48 = 12,2: dodici sedie.
    const plan = siedi([t], comitiva(13, 0));
    expect(plan.tables.get(1)!.chairs).toHaveLength(12);
    const inPiedi = plan.figures.filter(f => f.pose === 'standing');
    expect(inPiedi.map(f => f.key)).toEqual(['r12:a12']);
    expect(locale(t, inPiedi[0])).toEqual([0, -1.48]);
  });

  it('un tavolo senza posti si siede alle teste, o su un anello suo', () => {
    const rett = siedi([modello({ seats: 0 })], comitiva(2, 0));
    expect(rett.tables.get(1)!.extraChairs).toHaveLength(2);
    expect(rett.figures.every(f => f.pose === 'seated')).toBe(true);
    const tondo = siedi([modello({ seats: 0, shape: TableShape.CIRCLE })], comitiva(3, 0));
    expect(tondo.tables.get(1)!.chairs).toHaveLength(3);
    expect(tondo.figures.every(f => f.pose === 'seated')).toBe(true);
  });
});

describe('il seggiolone', () => {
  it('rettangolo: il più piccolo alla testa dalla parte del primo adulto, sul seggiolone', () => {
    const t = modello();
    const plan = siedi([t], comitiva(2, 1, { highChair: true }));
    const seduti = plan.tables.get(1)!;
    // a0 in alto a sinistra: la testa sinistra.
    expect(plan.figures.map(f => f.key)).toEqual(['r12:a0', 'r12:k0', 'r12:a1']);
    const [a0, k0, a1] = plan.figures;
    expect([sediaDi(seduti, a0), sediaDi(seduti, a1)]).toEqual([0, 2]);
    expect(seduti.extraChairs.map(c => [locale(t, c), c.lit, c.high])).toEqual([[[-0.86, 0], true, true]]);
    expect([locale(t, k0), k0.seatHeight]).toEqual([[-0.86, 0], HIGH_CHAIR_SEAT_HEIGHT]);
    // Sotto il piano (0,75): le cosce del bambino passano sotto il tavolo.
    expect(HIGH_CHAIR_SEAT_HEIGHT).toBe(0.58);
    // La 2D accende 3 sedie (0, 1, 2); la sedia lasciata dal bambino è vuota
    // e resta spenta.
    expect(litChairIndices(TableShape.RECTANGLE, 4, 3)).toEqual([0, 1, 2]);
    expect(accese(seduti.chairs)).toEqual([0, 2]);
  });

  it('rettangolo pieno: il seggiolone tiene la sua testa, chi avanza prende l\'altra', () => {
    const t = modello();
    const plan = siedi([t], comitiva(5, 1, { highChair: true }));
    const seduti = plan.tables.get(1)!;
    expect(seduti.extraChairs.map(c => [locale(t, c), c.high])).toEqual([[[0.86, 0], false], [[-0.86, 0], true]]);
    expect(plan.figures.find(f => f.key === 'r12:k0')!.seatHeight).toBe(HIGH_CHAIR_SEAT_HEIGHT);
    expect(plan.figures.find(f => f.key === 'r12:a4')!.seatHeight).toBe(SEAT_HEIGHT);
  });

  it('col capo del primo adulto contro il muro, l\'altra testa; senza teste, niente seggiolone', () => {
    const t = modello({ x: 0, y: 200 });
    const plan = seatParty({ partyId: 12, composition: comitiva(2, 1, { highChair: true }), tables: [t], floor: { width: 10, depth: 10 } });
    // a0 siede in alto a sinistra, ma il capo sinistro è a 6 cm dal muro.
    expect(plan.tables.get(1)!.extraChairs.map(c => [locale(t, c), c.high])).toEqual([[[0.86, 0], true]]);
    expect(plan.figures.find(f => f.key === 'r12:k0')!.seatHeight).toBe(HIGH_CHAIR_SEAT_HEIGHT);
    // Un pavimento largo quanto il tavolo: nessuna testa, e il bambino siede
    // su una sedia come gli altri.
    const stretta = seatParty({ partyId: 12, composition: comitiva(2, 1, { highChair: true }), tables: [t], floor: { width: 1.84, depth: 10 } });
    expect(stretta.tables.get(1)!.extraChairs).toEqual([]);
    expect(stretta.tables.get(1)!.chairs.some(c => c.high)).toBe(false);
    expect(stretta.figures.map(f => [f.key, f.pose, f.seatHeight])).toEqual([
      ['r12:a0', 'seated', SEAT_HEIGHT], ['r12:k0', 'seated', SEAT_HEIGHT], ['r12:a1', 'seated', SEAT_HEIGHT],
    ]);
  });

  it('senza adulti al tavolo, la testa sinistra', () => {
    const t = modello();
    const plan = siedi([t], comitiva(0, 2, { highChair: true }));
    expect(plan.figures.map(f => [f.key, locale(t, f), f.seatHeight])).toEqual([
      ['r12:k0', [-0.26, -0.85], SEAT_HEIGHT],
      ['r12:k1', [-0.86, 0], HIGH_CHAIR_SEAT_HEIGHT],
    ]);
  });

  it('tondo: la sedia del bambino stessa diventa alta', () => {
    const t = modello({ shape: TableShape.CIRCLE });
    const plan = siedi([t], comitiva(2, 1, { highChair: true }));
    const seduti = plan.tables.get(1)!;
    expect(seduti.chairs.map(c => c.high)).toEqual([false, true, false, false]);
    expect(seduti.extraChairs).toEqual([]);
    expect(plan.figures.map(f => f.seatHeight)).toEqual([SEAT_HEIGHT, HIGH_CHAIR_SEAT_HEIGHT, SEAT_HEIGHT]);
  });

  it('tondo: se il più piccolo resta in piedi, niente seggiolone', () => {
    const t = modello({ shape: TableShape.CIRCLE });
    // 7 adulti e 7 bambini: 12 sedute, a6 e k6 in piedi.
    const plan = siedi([t], comitiva(7, 7, { highChair: true }));
    expect(plan.tables.get(1)!.chairs.some(c => c.high)).toBe(false);
    const k6 = plan.figures.find(f => f.key === 'r12:k6')!;
    expect([k6.pose, k6.seatHeight]).toEqual(['standing', 0]);
  });

  it('senza bambini il seggiolone non si disegna', () => {
    const plan = siedi([modello()], comitiva(1, 0, { highChair: true }));
    expect(plan.tables.get(1)!.extraChairs).toEqual([]);
    expect(plan.figures.map(f => f.seatHeight)).toEqual([SEAT_HEIGHT]);
  });
});

describe('il cane', () => {
  it('sdraiato fuori dalla sedia del primo adulto, dalla parte esterna, lungo il bordo', () => {
    // La famiglia Esposito: 2 adulti, 2 bambini e «Cane», su 6 posti.
    const t = modello({ seats: 6 });
    const plan = siedi([t], comitiva(2, 2, { dogs: 1 }));
    expect(plan.figures).toHaveLength(5);
    const cane = plan.figures[4];
    expect([cane.key, cane.kind, cane.pose, cane.seatHeight, cane.tint, cane.partyId, cane.tableId])
      .toEqual(['r12:d0', 'dog', 'lying', 0, 0, 12, 1]);
    // a0 siede a (−0,52, −0,85): il cane 0,45 più fuori e 0,25 verso il capo
    // sinistro, sdraiato lungo il lato col muso verso quel capo.
    expect([DOG_OUT, DOG_SIDE]).toEqual([0.45, 0.25]);
    expect(locale(t, cane)).toEqual([-0.77, -1.3]);
    expect(angolo(cane.yaw)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('due cani con due adulti: uno accanto a ciascuno', () => {
    const t = modello({ seats: 6 });
    const [, , , , d0, d1] = siedi([t], comitiva(2, 2, { dogs: 2 })).figures;
    expect(locale(t, d0)).toEqual([-0.77, -1.3]);
    // a1 siede sotto, al centro del lato: lì la parte esterna è +1, la sua
    // sinistra.
    expect(locale(t, d1)).toEqual([-0.25, 1.3]);
    expect(angolo(d1.yaw)).toBeCloseTo(-Math.PI / 2, 12);
  });

  it('due cani e un adulto: uno per parte', () => {
    const t = modello();
    const cani = siedi([t], comitiva(1, 1, { dogs: 2 })).figures.filter(f => f.kind === 'dog');
    expect(cani.map(c => locale(t, c))).toEqual([[-0.51, -1.3], [-0.01, -1.3]]);
    expect(cani.map(c => angolo(c.yaw))).toEqual([-Math.PI / 2, Math.PI / 2]);
  });

  it('a ogni rotazione, nello stesso punto del tavolo', () => {
    for (const rotation of [90, 200, -37]) {
      const t = modello({ seats: 6, rotation });
      const cane = siedi([t], comitiva(2, 2, { dogs: 1 })).figures[4];
      expect(locale(t, cane), `rotazione ${rotation}`).toEqual([-0.77, -1.3]);
      expect(angolo(cane.yaw - t.rotY)).toBeCloseTo(-Math.PI / 2, 9);
    }
  });

  it('senza adulti, accanto al primo bambino; al più due', () => {
    const t = modello();
    const plan = siedi([t], comitiva(0, 2, { dogs: 5 }));
    const cani = plan.figures.filter(f => f.kind === 'dog');
    expect(cani.map(c => c.key)).toEqual(['r12:d0', 'r12:d1']);
    expect(cani.map(c => locale(t, c))).toEqual([[-0.51, -1.3], [-0.01, -1.3]]);
  });
});

describe('le tinte e le chiavi', () => {
  it('una tinta per comitiva fra 0 e 0,2, sempre la stessa; i bambini +0,15', () => {
    expect([PARTY_TINT_MAX, KID_TINT]).toEqual([0.2, 0.15]);
    const tinte = new Set<number>();
    for (let id = 0; id < 2000; id++) {
      const j = partyTint(id);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThan(PARTY_TINT_MAX);
      expect(partyTint(id)).toBe(j);
      tinte.add(Math.round(j * 1000));
    }
    // Comitive vicine, tinte sparse: quasi ogni millesimo è usato.
    expect(tinte.size).toBeGreaterThan(190);
    const plan = siedi([modello()], comitiva(2, 2), 4242);
    const j = partyTint(4242);
    expect(plan.figures.map(f => f.tint)).toEqual([j, j + KID_TINT, j, j + KID_TINT]);
  });

  it('chiavi stabili: la stessa comitiva dà le stesse figure', () => {
    expect([figureKey(12, 'adult', 0), figureKey(12, 'kid', 1), figureKey(12, 'dog', 0)]).toEqual(['r12:a0', 'r12:k1', 'r12:d0']);
    const t = modello({ seats: 6, rotation: 30 });
    const a = siedi([t], comitiva(3, 2, { dogs: 1, highChair: true }));
    const b = siedi([t], comitiva(3, 2, { dogs: 1, highChair: true }));
    expect(b).toEqual(a);
    expect(new Set(a.figures.map(f => f.key)).size).toBe(a.figures.length);
  });

  it('il tavolo passato non cambia: le sedie nuove sono copie', () => {
    const t = modello();
    const prima = JSON.stringify(t);
    siedi([t], comitiva(5, 1, { highChair: true }));
    expect(JSON.stringify(t)).toBe(prima);
  });
});

describe('il banchetto che trabocca', () => {
  it('spillTableIds: i tavoli liberi del banchetto in questa sala, nell\'ordine del banchetto', () => {
    const banchetto = { id: 7, table_ids: ['3', 2, 99, 1, 5, 2] } as unknown as BanquetMenu;
    // Il 5 è unito sotto il 3: è lo stesso tavolo disegnato.
    const drawnTableOf = new Map([[1, 1], [2, 2], [3, 3], [5, 3]]);
    expect(spillTableIds({ ownTableId: 1, banquet: banchetto, drawnTableOf, available: new Set([2, 3]) })).toEqual([3, 2]);
    expect(spillTableIds({ ownTableId: 1, banquet: banchetto, drawnTableOf, available: new Set([3]) })).toEqual([3]);
    expect(spillTableIds({ ownTableId: 1, banquet: null, drawnTableOf, available: new Set([2, 3]) })).toEqual([]);
    const rotto = { id: 7, table_ids: '3' } as unknown as BanquetMenu;
    expect(spillTableIds({ ownTableId: 1, banquet: rotto, drawnTableOf, available: new Set([3]) })).toEqual([]);
  });

  it('seatParty: prima il suo tavolo, poi gli altri in ordine; chi avanza alle teste del suo', () => {
    const own = modello({}, 1);
    const altro = modello({ x: 400 }, 3);
    const plan = siedi([own, altro], comitiva(10, 0));
    expect(plan.figures.map(f => f.tableId)).toEqual([1, 1, 1, 1, 3, 3, 3, 3, 1, 1]);
    expect(accese(plan.tables.get(3)!.chairs)).toEqual([0, 1, 2, 3]);
    expect(plan.tables.get(1)!.extraChairs).toHaveLength(2);
    // Un tavolo dove non arriva nessuno non si tocca.
    const poco = siedi([own, altro], comitiva(3, 0));
    expect([...poco.tables.keys()]).toEqual([1]);
  });
});

describe('nella sala', () => {
  const ora = (hhmm: string) => new Date(`2026-10-04T${hhmm}:00+02:00`).toISOString();
  const NOW = Date.parse(ora('19:00'));
  const SERVIZIO = liveService(new Date(NOW));
  let seq = 8000;
  const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
    id: seq++,
    customer_name: 'Rossi',
    reservation_time: ora('18:30'),
    shift: Shift.DINNER,
    guests: 2,
    table_id: 1,
    payment_status: PaymentStatus.PENDING,
    arrival_status: ArrivalStatus.ARRIVED,
    reservation_status: ReservationStatus.CONFIRMED,
    ...over,
  });
  const VERANDA: Room = { id: 1, name: 'Veranda', width: 1200, height: 600 };
  const FIUME: Room = { id: 2, name: 'Fiume', width: 800, height: 600 };
  const scena = (over: Partial<SceneInputs> = {}): SceneInputs => ({
    rooms: [VERANDA, FIUME],
    tables: [],
    reservations: [],
    banquetMenus: [],
    merges: [],
    hiddenTableIds: new Set<number>(),
    closedRoomIds: new Set<number>(),
    markers: [],
    service: SERVIZIO,
    nowMs: NOW,
    notePresets: [],
    showNames: false,
    copy: { reserved: (t: string) => `Riservato · ${t}`, event: 'Evento' },
    ...over,
  });

  it('un\'unione siede la comitiva sui posti sommati, al tavolo unito', () => {
    const r = prenotazione({ table_id: 2, guests: 6 });
    const model = deriveSceneModel(scena({
      tables: [tavolo({ x: 100 }, 1), tavolo({ x: 600 }, 2)],
      reservations: [r],
      merges: [{ id: 1, date: '2026-10-04', shift: Shift.DINNER, primary_id: 1, merged_ids: [2] }],
    }));
    const [unito] = model.rooms[0].tables;
    expect([unito.id, unito.name, unito.chairs.length]).toEqual([1, '1+2', 8]);
    expect(accese(unito.chairs)).toEqual(litChairIndices(TableShape.RECTANGLE, 8, 6));
    const figure = persone(model.rooms[0].figures);
    expect(figure).toHaveLength(6);
    expect(figure.every(f => f.tableId === 1 && unito.chairs.some(c => c.lit && su(c, f)))).toBe(true);
  });

  it('un banchetto: chi non entra va sui tavoli liberi del banchetto, mai su uno prenotato né in un\'altra sala', () => {
    const banchetto: BanquetMenu = {
      id: 7,
      name: 'Cresima di Giulia',
      description: '',
      price_per_person: 40,
      dish_ids: [],
      event_date: '2026-10-04',
      shift: Shift.DINNER,
      table_ids: [3, 2, 4, 1],
      guests: 10,
    };
    const festa = prenotazione({ table_id: 1, guests: 10, banquet_menu_id: 7 });
    const prenotato = prenotazione({ table_id: 2, arrival_status: ArrivalStatus.WAITING, reservation_time: ora('19:20') });
    const model = deriveSceneModel(scena({
      tables: [tavolo({ x: 100 }, 1), tavolo({ x: 300 }, 2), tavolo({ x: 500 }, 3), tavolo({ x: 100, room_id: 2 }, 4)],
      reservations: [festa, prenotato],
      banquetMenus: [banchetto],
    }));
    const [veranda, fiume] = model.rooms;
    const [t1, t2, t3] = veranda.tables;
    // 4 al suo tavolo, 4 sul 3 (il 2 ha una prenotazione sua, il 4 è in
    // Fiume), gli ultimi 2 alle teste del suo.
    expect(persone(veranda.figures).map(f => f.tableId)).toEqual([1, 1, 1, 1, 3, 3, 3, 3, 1, 1]);
    expect(veranda.summary.seated).toBe(10);
    expect([accese(t1.chairs), t1.extraChairs.length]).toEqual([[0, 1, 2, 3], 2]);
    expect([accese(t3.chairs), t3.extraChairs.length]).toEqual([[0, 1, 2, 3], 0]);
    // Il 2 resta com'è in 2D: le sedie della sua prenotazione, e il
    // cartellino del banchetto. Dove siede qualcuno, nessun cartellino.
    expect(accese(t2.chairs)).toEqual(litChairIndices(TableShape.RECTANGLE, 4, 2));
    expect(veranda.tables.map(t => t.sign)).toEqual([null, 'event', null]);
    expect(fiume.figures.filter(f => f.kind !== 'hostess')).toEqual([]);
    expect(fiume.tables[0].sign).toBe('event');
    // Una comitiva, al suo tavolo.
    expect(veranda.parties.map(p => [p.id, p.tableId])).toEqual([[festa.id, 1]]);
  });

  it('un tavolo del banchetto prenotato per più tardi è suo per tutto il turno: chi trabocca non salta all\'orologio', () => {
    const banchetto: BanquetMenu = {
      id: 7,
      name: 'Festa',
      description: '',
      price_per_person: 40,
      dish_ids: [],
      event_date: '2026-10-04',
      shift: Shift.DINNER,
      table_ids: [1, 3, 5, 4],
      guests: 8,
    };
    const festa = prenotazione({ table_id: 1, guests: 8, banquet_menu_id: 7, reservation_time: ora('19:00') });
    // Il 3 è prenotato per le 20:30: la piantina lo colora solo dalle 20:00,
    // ma è suo da prima.
    const dopo = prenotazione({ table_id: 3, arrival_status: ArrivalStatus.WAITING, reservation_time: ora('20:30') });
    // Il 5 aveva una prenotazione della cena segnata no-show: resta suo.
    const mancata = prenotazione({
      table_id: 5,
      arrival_status: ArrivalStatus.WAITING,
      reservation_status: ReservationStatus.NO_SHOW,
      reservation_time: ora('18:00'),
    });
    // Il 4 ha avuto solo un pranzo, andato via: per la cena è libero.
    const pranzo = prenotazione({
      table_id: 4,
      shift: Shift.LUNCH,
      arrival_status: ArrivalStatus.DEPARTED,
      reservation_time: ora('13:00'),
    });
    const sala = (hhmm: string) => deriveSceneModel(scena({
      tables: [tavolo({ x: 100 }, 1), tavolo({ x: 300 }, 3), tavolo({ x: 500 }, 5), tavolo({ x: 700 }, 4)],
      reservations: [festa, dopo, mancata, pranzo],
      banquetMenus: [banchetto],
      nowMs: Date.parse(ora(hhmm)),
    })).rooms[0];
    const prima = sala('19:59');
    const poi = sala('20:00');
    // 4 al suo tavolo e 4 sul 4, l'unico del banchetto senza prenotazioni sue.
    expect(persone(prima.figures).map(f => f.tableId)).toEqual([1, 1, 1, 1, 4, 4, 4, 4]);
    // Un minuto dopo la stessa sala: le stesse figure, le stesse sedie.
    expect(poi.figures).toEqual(prima.figures);
    const sedute = (r: RoomModel) => r.tables.filter(t => t.id === 1 || t.id === 4).map(t => [t.id, t.chairs, t.extraChairs]);
    expect(sedute(poi)).toEqual(sedute(prima));
    // Dove non siede nessuno, «Evento», a ogni minuto.
    expect(prima.tables.map(t => t.sign)).toEqual([null, 'event', 'event', null]);
    expect(poi.tables.map(t => t.sign)).toEqual([null, 'event', 'event', null]);
  });

  it('una comitiva enorme (un errore di battitura) si ferma a 150 persone, contate e disegnate, tutte nella sala', () => {
    expect(MAX_PARTY_PEOPLE).toBe(150);
    const r = prenotazione({ table_id: 1, guests: 500 });
    const [sala] = deriveSceneModel(scena({ tables: [tavolo({ x: 500, y: 250 }, 1)], reservations: [r] })).rooms;
    const figure = persone(sala.figures).filter(f => f.tableId === 1);
    expect(figure).toHaveLength(MAX_PARTY_PEOPLE);
    expect(sala.summary.seated).toBe(MAX_PARTY_PEOPLE);
    const { width, depth } = sala.floor;
    for (const f of figure.filter(f => f.pose === 'standing')) {
      expect(f.x, f.key).toBeGreaterThanOrEqual(FLOOR_MARGIN - 1e-9);
      expect(f.x, f.key).toBeLessThanOrEqual(width - FLOOR_MARGIN + 1e-9);
      expect(f.z, f.key).toBeGreaterThanOrEqual(FLOOR_MARGIN - 1e-9);
      expect(f.z, f.key).toBeLessThanOrEqual(depth - FLOOR_MARGIN + 1e-9);
    }
  });
});

describe('l\'ingresso e l\'accoglienza', () => {
  const marker = (kind: MarkerModel['kind'], x: number, z: number, inward = { x: 0, z: -1 }): MarkerModel =>
    ({ kind, pos: { x, z }, placed: true, inward });
  const sala = (entrance: MarkerModel, host: MarkerModel, width = 24, depth = 13.4): Pick<RoomModel, 'floor' | 'markers'> => ({
    floor: { width, depth },
    markers: { ENTRANCE: entrance, PASS: marker('PASS', 22, 1), HOST_STAND: host },
  });
  const punti = (cells: Array<{ x: number; z: number }>) =>
    cells.map(c => [Math.round(c.x * 1000) / 1000, Math.round(c.z * 1000) / 1000]);

  it('due file per tre colonne, dalla parte della porta lontana dal leggio', () => {
    const porta = marker('ENTRANCE', 12, 13);
    // Il leggio a destra di chi entra (la porta guarda verso −z: la destra è +x).
    expect(punti(lobbyCells(sala(porta, marker('HOST_STAND', 12.8, 11.8))))).toEqual([
      [11.1, 11.8], [10.5, 11.8], [9.9, 11.8],
      [11.1, 11.2], [10.5, 11.2], [9.9, 11.2],
    ]);
    // Il leggio a sinistra: i posti a destra.
    expect(punti(lobbyCells(sala(porta, marker('HOST_STAND', 11.2, 11.8))))).toEqual([
      [12.9, 11.8], [13.5, 11.8], [14.1, 11.8],
      [12.9, 11.2], [13.5, 11.2], [14.1, 11.2],
    ]);
  });

  it('una porta sul muro di sinistra: le file verso la sala, le colonne lungo il muro', () => {
    const porta = marker('ENTRANCE', 0.5, 6, { x: 1, z: 0 });
    // Entrando verso +x, la destra è +z: il leggio lì, i posti verso −z.
    expect(punti(lobbyCells(sala(porta, marker('HOST_STAND', 1.7, 6.8))))).toEqual([
      [1.7, 5.1], [1.7, 4.5], [1.7, 3.9],
      [2.3, 5.1], [2.3, 4.5], [2.3, 3.9],
    ]);
  });

  it('contro un muro la griglia scivola dentro tutta insieme, a 30 cm dal bordo', () => {
    const porta = marker('ENTRANCE', 1, 13);
    const celle = punti(lobbyCells(sala(porta, marker('HOST_STAND', 1.8, 11.8))));
    // A 0,9, 1,5 e 2,1 m a sinistra della porta finirebbero a 0,1, −0,5 e
    // −1,1: scivolano di 1,4 m, e restano a 60 cm l'una dall'altra.
    expect(celle).toEqual([
      [1.5, 11.8], [0.9, 11.8], [0.3, 11.8],
      [1.5, 11.2], [0.9, 11.2], [0.3, 11.2],
    ]);
    // Un pavimento più stretto dei due margini: tutti a metà.
    const stretta = lobbyCells(sala(porta, marker('HOST_STAND', 1.8, 11.8), 0.5));
    expect(stretta.every(c => vicino(c.x, 0.25))).toBe(true);
  });

  it('chi aspetta: al più sei, in piedi, rivolti alla sala, le comitive in ordine', () => {
    const celle = lobbyCells(sala(marker('ENTRANCE', 12, 13), marker('HOST_STAND', 12.8, 11.8)));
    const figure = lobbyFigures(
      [
        { id: 31, composition: comitiva(4, 0) },
        { id: 32, composition: comitiva(2, 1, { dogs: 1, highChair: true }) },
        { id: 33, composition: comitiva(2, 0) },
      ],
      celle,
      Math.atan2(0, -1),
    );
    expect(figure.map(f => f.key)).toEqual(['r31:a0', 'r31:a1', 'r31:a2', 'r31:a3', 'r32:a0', 'r32:k0']);
    figure.forEach((f, i) => {
      expect([f.x, f.z]).toEqual([celle[i].x, celle[i].z]);
      expect([f.pose, f.seatHeight, f.tableId, f.yaw]).toEqual(['standing', 0, null, Math.PI]);
    });
    // Niente cani all'ingresso; il bambino un po' più chiaro.
    expect(figure.some(f => f.kind === 'dog')).toBe(false);
    expect(figure[5].tint).toBe(partyTint(32) + KID_TINT);
    expect(lobbyFigures([], celle, 0)).toEqual([]);
  });

  it('l\'hostess senza una porta da cui guardare: mezzo metro dentro dal leggio, rivolta al leggio', () => {
    const leggio = marker('HOST_STAND', 2.8, 9.8, { x: 1, z: 0 });
    const posto = hostSpot(leggio);
    expect([posto.x, posto.z]).toEqual([3.3, 9.8]);
    // Guarda verso −x, cioè il leggio.
    expect(Math.sin(posto.yaw)).toBeCloseTo(-1, 12);
    expect(Math.cos(posto.yaw)).toBeCloseTo(0, 12);
    expect(hostessFigure(3, leggio)).toEqual({
      key: 'host:3',
      kind: 'hostess',
      pose: 'standing',
      x: 3.3,
      z: 9.8,
      yaw: posto.yaw,
      seatHeight: 0,
      partyId: null,
      tableId: null,
      tint: 0,
    });
  });

  it('l\'hostess sta dietro il leggio per chi entra: mezzo metro oltre il leggio, rivolta alla porta', () => {
    // La Veranda della harness: la porta in basso, il leggio alla sua destra e
    // un filo più su, a pari distanza dal muro destro e da quello in basso. Il
    // muro più vicino la metteva fra porta e leggio, di spalle alla porta.
    const floor = { width: 12.96, depth: 10 };
    const porta = marker('ENTRANCE', 8.4, 7.6);
    const leggio = marker('HOST_STAND', 10.6, 7.2, { x: -1, z: 0 });
    const posto = hostSpot(leggio, porta, floor);
    expect(posto.x).toBeCloseTo(11.1, 12);
    expect(posto.z).toBeCloseTo(7.2, 12);
    // Guarda verso −x: il leggio davanti, la porta oltre.
    expect(Math.sin(posto.yaw)).toBeCloseTo(-1, 12);
    expect(Math.cos(posto.yaw)).toBeCloseTo(0, 12);
    expect(hostessFigure(3, leggio, porta, floor)).toMatchObject({ key: 'host:3', x: posto.x, z: posto.z, yaw: posto.yaw });
    // Il leggio più dentro la sala della porta: lei ancora più dentro, rivolta
    // verso la porta (+z).
    const sopra = hostSpot(marker('HOST_STAND', 8.4, 6), porta, floor);
    expect([sopra.x, sopra.z]).toEqual([8.4, 5.5]);
    expect(Math.cos(sopra.yaw)).toBeCloseTo(1, 12);
    // Oltre il leggio c'è il muro: mezzo metro verso la sala, rivolta al leggio.
    const contro = hostSpot(marker('HOST_STAND', 12.8, 7.2, { x: -1, z: 0 }), porta, floor);
    expect(contro.x).toBeCloseTo(12.3, 12);
    expect(Math.sin(contro.yaw)).toBeCloseTo(1, 12);
    // Porta e leggio nello stesso punto: verso la sala.
    const insieme = hostSpot(marker('HOST_STAND', 8.4, 7.6), porta, floor);
    expect([insieme.x, insieme.z]).toEqual([8.4, 7.1]);
  });
});
