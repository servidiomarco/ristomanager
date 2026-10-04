import { beforeAll, describe, it, expect } from 'vitest';
import {
  ArrivalStatus,
  PaymentStatus,
  ReservationStatus,
  Shift,
  TableShape,
  TableStatus,
  type FloorMarker,
  type Reservation,
  type Room,
  type Table,
  type TableMerge,
} from '../../types';
import { setSessionTimeZone } from '../../utils/displayTime';
import type { FigureSlot, PartyState, RoomModel, SceneInputs } from '../../components/salaVivo/types';
import { liveService } from '../../components/salaVivo/model/service';
import { MAX_PARTY_PEOPLE } from '../../components/salaVivo/model/presence';
import { STAND_GAP, STAND_PITCH, approachPoint } from '../../components/salaVivo/model/placement';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';

/* Le fasi delle comitive per il regista (SceneModel.partyStates), e chi è
 * «In uscita» in piedi dietro le sedie: tutto dalla stessa presenza delle
 * figure e dei numeri. La cena del 4 ottobre 2026 a Roma, letta alle 19:00. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));

let seq = 9000;
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

const tavolo = (id: number, over: Partial<Table> = {}): Table => ({
  id,
  name: String(id),
  shape: TableShape.RECTANGLE,
  seats: 4,
  x: id * 150,
  y: 100,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

const VERANDA: Room = { id: 1, name: 'Veranda', width: 1600, height: 700 };
const FIUME: Room = { id: 2, name: 'Fiume', width: 800, height: 600 };

const scena = (over: Partial<SceneInputs> = {}): SceneInputs => ({
  rooms: [VERANDA, FIUME],
  tables: [],
  reservations: [],
  banquetMenus: [],
  merges: [],
  hiddenTableIds: new Set<number>(),
  closedRoomIds: new Set<number>(),
  markers: [{ id: 1, room_id: 1, kind: 'ENTRANCE', x: 800, y: 650 } as FloorMarker],
  service: SERVIZIO,
  nowMs: NOW,
  notePresets: [],
  showNames: false,
  copy: { reserved: (t: string) => `Riservato · ${t}`, event: 'Evento' },
  ...over,
});

const fasi = (states: PartyState[]) => states.map(s => [s.id, s.phase, s.roomId, s.tableId]);
const persone = (figures: FigureSlot[]) => figures.filter(f => f.kind === 'adult' || f.kind === 'kid');

describe('le fasi delle comitive', () => {
  // Una sera con un po' di tutto, creata una volta: gli id restano gli stessi.
  const seduti = prenotazione({ table_id: 1, guests: 3 });
  const inUscita = prenotazione({ table_id: 2, guests: 4, arrival_status: ArrivalStatus.DEPARTING, reservation_time: ora('18:00') });
  // Due comitive sedute sul tavolo 3: la più recente c'è, la più vecchia è
  // stata spodestata (DEPARTED non l'ha segnato nessuno).
  const vecchia = prenotazione({ table_id: 3, guests: 2, reservation_time: ora('17:45') });
  const nuova = prenotazione({ table_id: 3, guests: 5, reservation_time: ora('18:45') });
  // Seduti alle 16:00 per due ore: oltre la grazia di 45 minuti alle 18:45.
  const dimenticati = prenotazione({ table_id: 4, guests: 2, reservation_time: ora('16:00') });
  // Senza tavolo: all'ingresso, se arrivati da meno di un'ora dall'ora prenotata.
  const ingresso = prenotazione({ table_id: undefined, guests: 2, reservation_time: ora('18:40') });
  const ingressoVecchio = prenotazione({ table_id: undefined, guests: 3, reservation_time: ora('17:30') });
  // Il tavolo 8 di Fiume.
  const fiume = prenotazione({ table_id: 8, guests: 2, reservation_time: ora('18:20') });
  // Ancora da arrivare.
  const attesa = prenotazione({ table_id: 5, arrival_status: ArrivalStatus.WAITING, reservation_time: ora('19:15') });
  const daConfermare = prenotazione({
    table_id: 6,
    arrival_status: ArrivalStatus.WAITING,
    reservation_status: ReservationStatus.PENDING,
    reservation_time: ora('19:15'),
  });
  // Andati, annullati, rifiutati, mai arrivati, di un altro giorno: mancano.
  const andati = prenotazione({ table_id: 7, arrival_status: ArrivalStatus.DEPARTED, reservation_time: ora('18:00') });
  const annullata = prenotazione({ table_id: 7, arrival_status: ArrivalStatus.WAITING, reservation_status: ReservationStatus.CANCELLED });
  const rifiutata = prenotazione({ table_id: 7, arrival_status: ArrivalStatus.WAITING, reservation_status: ReservationStatus.DECLINED });
  const noShow = prenotazione({ table_id: 7, arrival_status: ArrivalStatus.WAITING, reservation_status: ReservationStatus.NO_SHOW });
  const ieri = prenotazione({ table_id: 1, reservation_time: ora('19:00', '2026-10-03') });
  const tutte = [
    attesa, seduti, inUscita, vecchia, nuova, dimenticati, ingresso, ingressoVecchio, fiume, daConfermare,
    andati, annullata, rifiutata, noShow, ieri,
  ];
  const model = deriveSceneModel(scena({
    tables: [1, 2, 3, 4, 5, 6, 7].map(id => tavolo(id)).concat(tavolo(8, { room_id: 2, x: 100 })),
    reservations: tutte,
  }));

  it('a tavola, in uscita, all\'ingresso, nascoste, in attesa; le altre mancano', () => {
    expect(fasi(model.partyStates)).toEqual([
      // A tavola, nell'ordine dei tavoli disegnati (Veranda, poi Fiume).
      [seduti.id, 'seated', 1, 1],
      [inUscita.id, 'standing', 1, 2],
      [nuova.id, 'seated', 1, 3],
      [fiume.id, 'seated', 2, 8],
      // All'ingresso della sala principale.
      [ingresso.id, 'lobby', 1, null],
      // Poi per ora prenotata: le sedute senza figure e le attese.
      [dimenticati.id, 'hidden', null, null],
      [ingressoVecchio.id, 'hidden', null, null],
      [vecchia.id, 'hidden', null, null],
      [attesa.id, 'waiting', null, null],
      [daConfermare.id, 'waiting', null, null],
    ]);
    const ids = new Set(model.partyStates.map(s => s.id));
    for (const r of [andati, annullata, rifiutata, noShow, ieri]) expect(ids.has(r.id)).toBe(false);
  });

  it('le persone e il banchetto di ogni comitiva', () => {
    const di = (id: number) => model.partyStates.find(s => s.id === id)!;
    expect(di(seduti.id).people).toBe(3);
    expect(di(nuova.id).people).toBe(5);
    expect(di(ingressoVecchio.id).people).toBe(3);
    expect(model.partyStates.every(s => s.banquet === false)).toBe(true);
    // Le persone come le conta il riassunto: almeno 1, al più 150.
    const zero = prenotazione({ table_id: 1, guests: 0 });
    const enorme = prenotazione({ table_id: 2, guests: 500 });
    const banchetti = [7, '7', '', null, 'x'].map(b => prenotazione({ table_id: 3, arrival_status: ArrivalStatus.WAITING, banquet_menu_id: b as unknown as number }));
    const m = deriveSceneModel(scena({ tables: [tavolo(1), tavolo(2), tavolo(3)], reservations: [zero, enorme, ...banchetti] }));
    const st = (id: number) => m.partyStates.find(s => s.id === id)!;
    expect(st(zero.id).people).toBe(1);
    expect(st(enorme.id).people).toBe(MAX_PARTY_PEOPLE);
    expect(banchetti.map(b => st(b.id).banquet)).toEqual([true, true, false, false, false]);
  });

  it('dicono le stesse cose delle figure e dei numeri', () => {
    for (const room of model.rooms) {
      for (const p of room.parties) {
        const s = model.partyStates.find(x => x.id === p.id)!;
        expect(s, `${p.id}`).toBeDefined();
        expect(s.roomId).toBe(room.id);
        expect(s.tableId).toBe(p.tableId);
        expect(s.phase === 'lobby').toBe(p.tableId === null);
        expect(s.people).toBe(p.adults + p.kids);
      }
      const qui = model.partyStates.filter(s => s.roomId === room.id);
      expect(qui.filter(s => s.phase === 'seated' || s.phase === 'standing').reduce((n, s) => n + s.people, 0)).toBe(room.summary.seated);
      expect(qui.filter(s => s.phase === 'lobby').reduce((n, s) => n + s.people, 0)).toBe(room.summary.lobby);
    }
    // Nascoste e in attesa non hanno figure.
    const senza = new Set(model.partyStates.filter(s => s.roomId === null).map(s => s.id));
    for (const room of model.rooms) for (const f of room.figures) expect(senza.has(f.partyId ?? -1)).toBe(false);
  });

  it('un\'unione è un tavolo solo; un tavolo nascosto manda all\'ingresso della sua sala; la prima riga per id', () => {
    const suSecondario = prenotazione({ table_id: 2, guests: 6 });
    const suNascosto = prenotazione({ table_id: 8, guests: 2 });
    const unione: TableMerge = { id: 1, date: '2026-10-04', shift: Shift.DINNER, primary_id: 1, merged_ids: [2] };
    const m = deriveSceneModel(scena({
      tables: [tavolo(1), tavolo(2), tavolo(8, { room_id: 2, x: 100 })],
      reservations: [suSecondario, suNascosto, { ...suSecondario, guests: 9 }],
      merges: [unione],
      hiddenTableIds: new Set([8]),
    }));
    expect(fasi(m.partyStates)).toEqual([
      [suSecondario.id, 'seated', 1, 1],
      [suNascosto.id, 'lobby', 2, null],
    ]);
    expect(m.partyStates[0].people).toBe(6);
  });

  it('chi aspetta all\'ingresso da più di un\'ora diventa nascosto, e chi è oltre la grazia anche', () => {
    const r = prenotazione({ table_id: undefined, guests: 2, reservation_time: ora('18:30') });
    const fase = (hhmm: string) => deriveSceneModel(scena({ reservations: [r], nowMs: Date.parse(ora(hhmm)) })).partyStates[0].phase;
    expect(fase('19:29')).toBe('lobby');
    expect(fase('19:31')).toBe('hidden');
    const t = prenotazione({ table_id: 1, guests: 2, reservation_time: ora('18:30'), duration_minutes: 90 });
    const faseT = (hhmm: string) => deriveSceneModel(scena({ tables: [tavolo(1)], reservations: [t], nowMs: Date.parse(ora(hhmm)) })).partyStates[0].phase;
    // Fine prevista alle 20:00, più 45 minuti.
    expect(faseT('20:44')).toBe('seated');
    expect(faseT('20:46')).toBe('hidden');
  });
});

describe('«In uscita»: in piedi dietro le sedie', () => {
  const famiglia = (over: Partial<Reservation> = {}) =>
    prenotazione({ table_id: 1, guests: 4, children: 1, notes: 'Cane, Seggiolone', reservation_time: ora('18:30'), ...over });
  const r = famiglia();
  const sala = (arrival: ArrivalStatus, extra: Partial<Reservation> = {}) => deriveSceneModel(scena({
    tables: [tavolo(1, { seats: 4, x: 600, y: 250 })],
    reservations: [{ ...r, arrival_status: arrival, ...extra }],
  })).rooms[0];

  it('ognuno 0,55 m dietro la sua sedia, rivolto al tavolo; il cane in piedi dov\'era; le chiavi e i numeri non cambiano', () => {
    const seduta = sala(ArrivalStatus.ARRIVED);
    const uscita = sala(ArrivalStatus.DEPARTING);
    expect(uscita.figures.map(f => f.key)).toEqual(seduta.figures.map(f => f.key));
    expect(uscita.summary).toEqual(seduta.summary);
    expect(uscita.parties).toEqual(seduta.parties);
    // Le sedie restano accese: sono ancora loro. Cambia solo il colore del
    // tavolo, che diventa «uscita» come in 2D.
    expect(uscita.tables.map(t => [t.chairs, t.extraChairs])).toEqual(seduta.tables.map(t => [t.chairs, t.extraChairs]));
    expect(uscita.tables.map(t => t.status)).toEqual(['uscita']);
    seduta.figures.forEach((f, i) => {
      const g = uscita.figures[i];
      expect([g.tint, g.tableId, g.partyId, g.kind]).toEqual([f.tint, f.tableId, f.partyId, f.kind]);
      if (f.kind === 'hostess') {
        expect(g).toEqual(f);
      } else if (f.kind === 'dog') {
        expect(f.pose).toBe('lying');
        expect(g).toEqual({ ...f, pose: 'standing' });
      } else {
        expect(f.pose).toBe('seated');
        const dietro = approachPoint(f);
        expect([g.pose, g.seatHeight, g.yaw]).toEqual(['standing', 0, f.yaw]);
        expect(g.x).toBeCloseTo(dietro.x, 12);
        expect(g.z).toBeCloseTo(dietro.z, 12);
        expect(Math.hypot(g.x - f.x, g.z - f.z)).toBeCloseTo(STAND_GAP, 12);
        // Rivolto al tavolo: la sedia gli sta davanti.
        expect(Math.sin(g.yaw) * (f.x - g.x) + Math.cos(g.yaw) * (f.z - g.z)).toBeCloseTo(STAND_GAP, 12);
      }
    });
    // Il bambino del seggiolone si alza dietro la testa, da terra.
    const bimbo = uscita.figures.find(f => f.kind === 'kid')!;
    expect(bimbo.seatHeight).toBe(0);
    // Le persone ai tavoli sono ancora quelle che la linguetta conta.
    expect(persone(uscita.figures).filter(f => f.tableId !== null)).toHaveLength(uscita.summary.seated);
    expect(persone(uscita.figures).every(f => f.pose === 'standing')).toBe(true);
  });

  it('a un tavolo troppo pieno chi si alza non finisce addosso a chi era già in piedi', () => {
    // 9 persone su un tavolo da 4: 4 sulle sedie, 2 alle teste, 3 in piedi
    // dietro le teste e le prime sedie, proprio dove si alzerebbe chi siede.
    const pieno = prenotazione({ table_id: 1, guests: 9 });
    const room = (arrival: ArrivalStatus) => deriveSceneModel(scena({
      tables: [tavolo(1, { seats: 4, x: 600, y: 250 })],
      reservations: [{ ...pieno, arrival_status: arrival }],
    })).rooms[0];
    const seduta = room(ArrivalStatus.ARRIVED);
    const uscita = room(ArrivalStatus.DEPARTING);
    const giaInPiedi = persone(seduta.figures).filter(f => f.pose === 'standing');
    expect(giaInPiedi).toHaveLength(3);
    // Chi era in piedi resta dov'era.
    for (const f of giaInPiedi) expect(uscita.figures.find(g => g.key === f.key)).toEqual(f);
    const tutti = persone(uscita.figures);
    expect(tutti).toHaveLength(9);
    for (let a = 0; a < tutti.length; a++) {
      for (let b = a + 1; b < tutti.length; b++) {
        const d = Math.hypot(tutti[a].x - tutti[b].x, tutti[a].z - tutti[b].z);
        expect(d, `${tutti[a].key} ${tutti[b].key}`).toBeGreaterThanOrEqual(0.3);
      }
    }
    // Chi si alza davanti a uno in piedi arretra di un giro (STAND_PITCH).
    const seduti = persone(seduta.figures).filter(f => f.pose === 'seated');
    const arretrati = seduti.filter(f => {
      const g = uscita.figures.find(x => x.key === f.key)!;
      return Math.abs(Math.hypot(g.x - f.x, g.z - f.z) - (STAND_GAP + STAND_PITCH)) < 1e-9;
    });
    expect(arretrati.length).toBe(3);
  });

  it('contro il muro si resta sul pavimento', () => {
    // Il tavolo contro il muro in alto: chi siede sul lato del muro si alza
    // dentro la sala, a 30 cm dal bordo.
    const contro = prenotazione({ table_id: 1, guests: 4 });
    const room: RoomModel = deriveSceneModel(scena({
      tables: [tavolo(1, { seats: 4, x: 600, y: 0 })],
      reservations: [{ ...contro, arrival_status: ArrivalStatus.DEPARTING }],
    })).rooms[0];
    for (const f of persone(room.figures)) {
      expect(f.z, f.key).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(f.pose).toBe('standing');
    }
  });
});
