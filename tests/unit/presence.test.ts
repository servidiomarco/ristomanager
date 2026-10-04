import { beforeAll, describe, it, expect } from 'vitest';
import {
  ArrivalStatus,
  PaymentStatus,
  ReservationStatus,
  Shift,
  TableShape,
  TableStatus,
  type Reservation,
  type Room,
  type Table,
} from '../../types';
import { setSessionTimeZone } from '../../utils/displayTime';
import type { MarkerModel, RoomModel, SceneInputs } from '../../components/salaVivo/types';
import { liveService } from '../../components/salaVivo/model/service';
import { groupStatusFor, withinGrace } from '../../components/salaVivo/model/tableStatus';
import {
  LOBBY_MAX_DRAWN,
  LOBBY_WINDOW_MIN,
  derivePresence,
  mainRoomOf,
  peopleOf,
  summaryFor,
  type DrawnTable,
} from '../../components/salaVivo/model/presence';
import { deriveSceneModel, roomsToShow } from '../../components/salaVivo/model/sceneModel';

/* Chi è in sala adesso: la regola unica da cui nascono le figure e ogni
 * numero. La cena del 4 ottobre 2026 a Roma, letta alle 19:00. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));
const MIN = 60_000;

let seq = 5000;
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
  x: id * 100,
  y: 0,
  room_id: 1,
  status: TableStatus.FREE,
  rotation: 0,
  ...over,
});

// Un tavolo disegnato, col suo stato calcolato come fa la sala.
const disegnato = (tableId: number, reservations: Reservation[], nowMs = NOW, roomId = 1): DrawnTable => ({
  tableId,
  roomId,
  groupIds: [tableId],
  status: groupStatusFor({
    groupIds: [tableId],
    tablesById: new Map([[tableId, tavolo(tableId)]]),
    reservations,
    banquetMenus: [],
    service: SERVIZIO,
    nowMs,
  }),
});

const presenza = (drawn: DrawnTable[], reservations: Reservation[], over: Partial<Parameters<typeof derivePresence>[0]> = {}) =>
  derivePresence({
    drawn,
    tableRoomIds: new Map([[1, 1], [2, 1], [9, 2]]),
    mainRoomId: 1,
    reservations,
    service: SERVIZIO,
    nowMs: NOW,
    ...over,
  });

const ids = (list: Array<{ reservation: Reservation }>) => list.map(p => p.reservation.id);

describe('a tavola', () => {
  it('su un tavolo seduto due volte c\'è solo la comitiva più recente', () => {
    // DEPARTED spesso non lo segna nessuno: senza questa regola la prima
    // comitiva sederebbe ancora sotto quella nuova.
    const prima = prenotazione({ reservation_time: ora('18:00'), guests: 2 });
    const dopo = prenotazione({ reservation_time: ora('18:45'), guests: 3 });
    const p = presenza([disegnato(1, [prima, dopo])], [prima, dopo]);
    expect(p.present).toEqual([{ reservation: dopo, roomId: 1, tableId: 1 }]);
    // La più vecchia non è a tavola, non aspetta all'ingresso, non si conta.
    expect(p.lobby).toEqual([]);
    expect(summaryFor(p, 1)).toEqual({ seated: 3, arriving: 0, lobby: 0 });
  });

  it('la grazia: fino a 45 minuti oltre la fine prevista, poi niente figure ma il tavolo resta «uscita»', () => {
    // Seduti alle 16:00 per 120 minuti: fine alle 18:00, presenti fino alle 18:45.
    const r = prenotazione({ reservation_time: ora('16:00'), guests: 5 });
    const end = Date.parse(ora('18:00'));
    for (const [minuti, atteso] of [[44, true], [46, false]] as const) {
      const now = end + minuti * MIN;
      const d = disegnato(1, [r], now);
      expect(d.status.status).toBe('uscita');
      expect(withinGrace(r, now)).toBe(atteso);
      const p = presenza([d], [r], { nowMs: now });
      expect(ids(p.present)).toEqual(atteso ? [r.id] : []);
      expect(p.lobby).toEqual([]);
      expect(summaryFor(p, 1).seated).toBe(atteso ? 5 : 0);
    }
  });

  it('la grazia legge una durata arrivata come stringa', () => {
    const r = prenotazione({ reservation_time: ora('17:00'), duration_minutes: '60' as unknown as number });
    // Fine alle 18:00, presenti fino alle 18:45: alle 19:00 non più.
    expect(withinGrace(r, NOW)).toBe(false);
    expect(withinGrace(r, Date.parse(ora('18:44')))).toBe(true);
  });

  it('un pranzo seduto alle 12:30, a cena, non è più a tavola', () => {
    const pranzo = prenotazione({ reservation_time: ora('12:30'), shift: Shift.LUNCH, guests: 4 });
    const d = disegnato(1, [pranzo]);
    // Il tavolo resta suo (seduto, mai segnato via): «uscita». Ma è passato
    // da un pezzo: 12:30 + 90 + 45 = 14:45.
    expect(d.status.status).toBe('uscita');
    const p = presenza([d], [pranzo]);
    expect(p.present).toEqual([]);
    expect(p.lobby).toEqual([]);
  });

  it('la comitiva di ieri non è nemmeno viva: niente figure, niente colore', () => {
    const ieri = prenotazione({ reservation_time: ora('19:00', '2026-10-03') });
    const d = disegnato(1, [ieri]);
    expect(d.status.active).toBeNull();
    expect(presenza([d], [ieri])).toEqual({ present: [], arriving: [], lobby: [] });
  });

  it('no-show, annullate, rifiutate, andate via: mai a tavola né all\'ingresso', () => {
    const fuori: Array<Partial<Reservation>> = [
      { reservation_status: ReservationStatus.NO_SHOW },
      { reservation_status: ReservationStatus.CANCELLED },
      { reservation_status: ReservationStatus.DECLINED },
      { arrival_status: ArrivalStatus.DEPARTED },
    ];
    for (const over of fuori) {
      const aTavolo = prenotazione(over);
      const senzaTavolo = prenotazione({ ...over, table_id: undefined });
      const p = presenza([disegnato(1, [aTavolo])], [aTavolo, senzaTavolo]);
      expect(p.present).toEqual([]);
      expect(p.lobby).toEqual([]);
    }
  });

  it('in arrivo: le persone dietro gli anelli che pulsano', () => {
    const inArrivo = prenotazione({ table_id: 2, reservation_time: ora('19:15'), arrival_status: ArrivalStatus.WAITING, guests: 2 });
    const attesa = prenotazione({ table_id: 1, reservation_time: ora('19:25'), arrival_status: ArrivalStatus.WAITING, guests: 6 });
    const drawn = [disegnato(1, [attesa]), disegnato(2, [inArrivo])];
    expect(drawn.map(d => d.status.status)).toEqual(['attesa', 'inarrivo']);
    const p = presenza(drawn, [attesa, inArrivo]);
    expect(p.arriving).toEqual([{ reservation: inArrivo, roomId: 1, tableId: 2 }]);
    expect(p.present).toEqual([]);
    expect(summaryFor(p, 1)).toEqual({ seated: 0, arriving: 2, lobby: 0 });
  });
});

describe('all\'ingresso', () => {
  it('arrivato senza tavolo: nella sala principale, fino a un\'ora dall\'ora prenotata', () => {
    expect(LOBBY_WINDOW_MIN).toBe(60);
    const r = prenotazione({ table_id: undefined, reservation_time: ora('18:30'), guests: 3 });
    const a = (hhmm: string) => presenza([], [r], { mainRoomId: 2, nowMs: Date.parse(ora(hhmm)) });
    expect(a('19:29').lobby).toEqual([{ reservation: r, roomId: 2 }]);
    expect(summaryFor(a('19:29'), 2)).toEqual({ seated: 0, arriving: 0, lobby: 3 });
    expect(a('19:30').lobby).toEqual([]);
    // Arrivato in anticipo: c'è già.
    const presto = prenotazione({ table_id: undefined, reservation_time: ora('20:00') });
    expect(ids(presenza([], [presto]).lobby)).toEqual([presto.id]);
  });

  it('chi non è ancora arrivato non aspetta all\'ingresso', () => {
    const r = prenotazione({ table_id: undefined, arrival_status: ArrivalStatus.WAITING });
    expect(presenza([], [r]).lobby).toEqual([]);
  });

  it('chi siede su un tavolo nascosto aspetta all\'ingresso della sua sala', () => {
    // Il tavolo 9 c'è (nella sala 2) ma non si disegna.
    const r = prenotazione({ table_id: 9 });
    expect(presenza([disegnato(1, [])], [r]).lobby).toEqual([{ reservation: r, roomId: 2 }]);
  });

  it('su un tavolo di una sala che non c\'è, nella sala principale; senza sale, da nessuna parte', () => {
    const r = prenotazione({ table_id: 77 });
    expect(presenza([], [r]).lobby).toEqual([{ reservation: r, roomId: 1 }]);
    expect(presenza([], [r], { mainRoomId: null }).lobby).toEqual([]);
  });

  it('chi ha il tavolo disegnato ma non è a tavola non va all\'ingresso', () => {
    // Una seduta più vecchia sullo stesso tavolo, appena arrivata: il tavolo
    // c'è, quindi è andata via senza che nessuno lo segnasse.
    const vecchia = prenotazione({ reservation_time: ora('18:20') });
    const nuova = prenotazione({ reservation_time: ora('18:40') });
    const p = presenza([disegnato(1, [vecchia, nuova])], [vecchia, nuova]);
    expect(ids(p.present)).toEqual([nuova.id]);
    expect(p.lobby).toEqual([]);
  });

  it('in ordine d\'ora prenotata, poi id; una riga ripetuta conta una volta', () => {
    const b = prenotazione({ id: 20, table_id: undefined, reservation_time: ora('18:45') });
    const a = prenotazione({ id: 21, table_id: undefined, reservation_time: ora('18:15') });
    const c = prenotazione({ id: 19, table_id: undefined, reservation_time: ora('18:45') });
    const p = presenza([], [b, a, c, { ...b }, null as unknown as Reservation]);
    expect(ids(p.lobby)).toEqual([21, 19, 20]);
  });
});

describe('i numeri', () => {
  it('summaryFor somma persone, sala per sala', () => {
    const r1 = prenotazione({ table_id: 1, guests: 3 });
    const r2 = prenotazione({ table_id: 2, guests: 0 });
    const r3 = prenotazione({ table_id: 5, guests: 4 });
    const lobby = prenotazione({ table_id: undefined, guests: 2 });
    const p = presenza(
      [disegnato(1, [r1]), disegnato(2, [r2]), disegnato(5, [r3], NOW, 2)],
      [r1, r2, r3, lobby],
    );
    // Una prenotazione senza ospiti è comunque qualcuno.
    expect(summaryFor(p, 1)).toEqual({ seated: 4, arriving: 0, lobby: 2 });
    expect(summaryFor(p, 2)).toEqual({ seated: 4, arriving: 0, lobby: 0 });
    expect(summaryFor(p, 3)).toEqual({ seated: 0, arriving: 0, lobby: 0 });
    expect([peopleOf(r2), peopleOf(null), peopleOf(prenotazione({ guests: '3' as unknown as number }))]).toEqual([1, 0, 3]);
  });

  it('una comitiva su due tavoli disegnati (una riga ripetuta) si conta una volta', () => {
    const r = prenotazione({ table_id: 1, guests: 3 });
    const d1 = disegnato(1, [r]);
    const d2 = { ...d1, tableId: 2, groupIds: [2] };
    const p = presenza([d1, d2], [r]);
    expect(p.present).toEqual([{ reservation: r, roomId: 1, tableId: 1 }]);
    expect(summaryFor(p, 1).seated).toBe(3);
  });
});

describe('la sala principale', () => {
  const marker = (placed: boolean): MarkerModel =>
    ({ kind: 'ENTRANCE', pos: { x: 0, z: 0 }, placed, inward: { x: 0, z: -1 } });
  const sala = (id: number, closed: boolean, placed: boolean) =>
    ({ id, closed, markers: { ENTRANCE: marker(placed) } as RoomModel['markers'] });

  it('la prima aperta con l\'ingresso posato, poi la prima aperta, poi la prima', () => {
    expect(mainRoomOf([sala(1, false, false), sala(2, true, true), sala(3, false, true)])).toBe(3);
    expect(mainRoomOf([sala(1, true, true), sala(2, false, false), sala(3, false, false)])).toBe(2);
    expect(mainRoomOf([sala(1, true, false), sala(2, true, true)])).toBe(1);
    expect(mainRoomOf([])).toBeNull();
    expect(mainRoomOf(undefined as unknown as RoomModel[])).toBeNull();
  });
});

describe('nella sala', () => {
  const SALA: Room = { id: 1, name: 'Veranda', width: 1200, height: 600 };
  const FIUME: Room = { id: 2, name: 'Fiume', width: 800, height: 600 };
  const scena = (over: Partial<SceneInputs> = {}): SceneInputs => ({
    rooms: [SALA, FIUME],
    tables: [tavolo(1), tavolo(2), tavolo(9, { room_id: 2 })],
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

  it('l\'ingresso disegna al più sei persone e conta tutte le altre', () => {
    expect(LOBBY_MAX_DRAWN).toBe(6);
    const arrivati = [
      prenotazione({ table_id: undefined, reservation_time: ora('18:40'), guests: 4 }),
      prenotazione({ table_id: undefined, reservation_time: ora('18:50'), guests: 3, children: 1 }),
      prenotazione({ table_id: undefined, reservation_time: ora('18:55'), guests: 2 }),
    ];
    const model = deriveSceneModel(scena({ reservations: arrivati }));
    // Senza ingressi posati e tutte aperte, la principale è la prima: Veranda.
    expect(model.mainRoomId).toBe(1);
    const [veranda, fiume] = model.rooms;
    expect(veranda.summary).toEqual({ seated: 0, arriving: 0, lobby: 9, covers: 8 });
    expect(fiume.summary.lobby).toBe(0);
    expect(model.summary).toEqual({ seated: 0, arriving: 0, lobby: 9 });
    const inPiedi = veranda.figures.filter(f => f.kind !== 'hostess');
    expect(inPiedi).toHaveLength(6);
    expect(inPiedi.every(f => f.pose === 'standing' && f.tableId === null)).toBe(true);
    // Le comitive in ordine d'ora: le 4 persone delle 18:40, poi le prime 2
    // delle 18:50 (adulto, bambino). Le comitive ci sono tutte.
    expect(inPiedi.map(f => f.key)).toEqual([
      `r${arrivati[0].id}:a0`, `r${arrivati[0].id}:a1`, `r${arrivati[0].id}:a2`, `r${arrivati[0].id}:a3`,
      `r${arrivati[1].id}:a0`, `r${arrivati[1].id}:k0`,
    ]);
    expect(veranda.parties.map(p => [p.id, p.tableId])).toEqual(arrivati.map(r => [r.id, null]));
  });

  it('chi siede su un tavolo nascosto aspetta all\'ingresso della sua sala, non della principale', () => {
    const r = prenotazione({ table_id: 9, guests: 2 });
    const model = deriveSceneModel(scena({ reservations: [r], hiddenTableIds: new Set([9]) }));
    expect(model.rooms.map(room => room.summary.lobby)).toEqual([0, 2]);
    expect(model.rooms[1].parties.map(p => p.id)).toEqual([r.id]);
  });

  it('chi siede su un tavolo unito sotto un capofila nascosto aspetta all\'ingresso della sua sala', () => {
    // L'8 e il 9 di Fiume sono uniti, col capofila 8 nascosto per il turno:
    // come in 2D l'unione sparisce, e il 9 non si disegna. Chi ci siede non
    // ha un tavolo da disegnare, ma la sua sala c'è: Fiume, non la
    // principale (Veranda).
    const r = prenotazione({ table_id: 9, guests: 3 });
    const model = deriveSceneModel(scena({
      tables: [tavolo(1), tavolo(2), tavolo(8, { room_id: 2, x: 400 }), tavolo(9, { room_id: 2 })],
      reservations: [r],
      merges: [{ id: 1, date: '2026-10-04', shift: Shift.DINNER, primary_id: 8, merged_ids: [9] }],
      hiddenTableIds: new Set([8]),
    }));
    const [veranda, fiume] = model.rooms;
    expect(model.mainRoomId).toBe(veranda.id);
    expect(fiume.tables).toEqual([]);
    expect([veranda.summary.lobby, fiume.summary.lobby]).toEqual([0, 3]);
    expect(fiume.parties.map(p => [p.id, p.tableId])).toEqual([[r.id, null]]);
    expect(fiume.figures.filter(f => f.partyId === r.id).map(f => [f.pose, f.tableId]))
      .toEqual([['standing', null], ['standing', null], ['standing', null]]);
  });

  it('ogni persona che la testata conta sta in una sala con la sua linguetta', () => {
    // Fiume chiusa per il turno (la pioggia), con le prenotazioni ancora
    // sopra: chi arriva, chi siede, chi aspetta all'ingresso.
    const chiusa = new Set([2]);
    const inArrivo = prenotazione({ table_id: 9, reservation_time: ora('19:10'), arrival_status: ArrivalStatus.WAITING, guests: 4 });
    const seduti = prenotazione({ table_id: 9, guests: 2 });
    const nascosto = prenotazione({ table_id: 7, guests: 3 });
    const casi = [
      scena({ closedRoomIds: chiusa }),
      scena({ closedRoomIds: chiusa, reservations: [inArrivo] }),
      scena({ closedRoomIds: chiusa, reservations: [seduti] }),
      scena({
        closedRoomIds: chiusa,
        tables: [tavolo(1), tavolo(2), tavolo(7, { room_id: 2, x: 400 }), tavolo(9, { room_id: 2 })],
        hiddenTableIds: new Set([7]),
        reservations: [nascosto],
      }),
    ];
    const linguette = casi.map(s => roomsToShow(deriveSceneModel(s).rooms).map(r => r.name));
    // Chiusa e vuota non ha la linguetta; in arrivo, a tavola o all'ingresso sì.
    expect(linguette).toEqual([['Veranda'], ['Veranda', 'Fiume'], ['Veranda', 'Fiume'], ['Veranda', 'Fiume']]);
    for (const s of casi) {
      const model = deriveSceneModel(s);
      const viste = roomsToShow(model.rooms);
      for (const k of ['seated', 'arriving', 'lobby'] as const) {
        expect(viste.reduce((n, r) => n + r.summary[k], 0), k).toBe(model.summary[k]);
      }
    }
    expect(roomsToShow(undefined)).toEqual([]);
  });

  it('una seduta sotto un\'unione si conta al tavolo unito, una volta', () => {
    const r = prenotazione({ table_id: 2, guests: 6 });
    const model = deriveSceneModel(scena({
      reservations: [r],
      merges: [{ id: 1, date: '2026-10-04', shift: Shift.DINNER, primary_id: 1, merged_ids: [2] }],
    }));
    const [veranda] = model.rooms;
    expect(veranda.tables.map(t => t.name)).toEqual(['1+2']);
    expect(veranda.summary.seated).toBe(6);
    expect(veranda.summary.lobby).toBe(0);
    expect(veranda.figures.filter(f => f.tableId === 1)).toHaveLength(6);
  });
});
