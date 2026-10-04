import { beforeAll, describe, it, expect } from 'vitest';
import {
  ArrivalStatus,
  PaymentStatus,
  ReservationStatus,
  Shift,
  TableShape,
  TableStatus,
  type BanquetMenu,
  type FloorMarker,
  type Reservation,
  type Room,
  type Table,
  type TableMerge,
} from '../../types';
import { deriveTableDisplayStatus } from '../../components/reservationState';
import { buildMergeGroups } from '../../components/comande/tablesView';
import { litChairIndices } from '../../utils/tableGeometry';
import { serviceDayOf, setSessionTimeZone } from '../../utils/displayTime';
import type { SceneInputs, TableDisplayStatus, TableModel } from '../../components/salaVivo/types';
import { inService, isLiveParty, liveService } from '../../components/salaVivo/model/service';
import {
  SEATED_GRACE_MIN,
  activeReservationFor,
  groupIdsOf,
  groupStatusFor,
  litByTable,
} from '../../components/salaVivo/model/tableStatus';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';

/* Lo stato dei tavoli della Sala dal vivo: lo stesso colore della piantina,
 * per la prenotazione che conta nel servizio in corso.
 *
 * Il servizio è la cena del 4 ottobre 2026 a Roma (UTC+2), letta alle 19:00:
 * le ore scritte qui sono ore di Roma. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));
const MIN = 60_000;

let seq = 1000;
const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
  id: seq++,
  customer_name: 'Rossi',
  reservation_time: ora('19:00'),
  shift: Shift.DINNER,
  guests: 4,
  table_id: 1,
  payment_status: PaymentStatus.PENDING,
  arrival_status: ArrivalStatus.WAITING,
  reservation_status: ReservationStatus.CONFIRMED,
  ...over,
});

// Rettangoli da 4 a 100 px l'uno dall'altro.
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

const banchetto = (over: Partial<BanquetMenu> = {}): BanquetMenu => ({
  id: 7,
  name: 'Cresima',
  description: '',
  price_per_person: 40,
  dish_ids: [],
  event_date: '2026-10-04',
  shift: Shift.DINNER,
  table_ids: [1],
  guests: 3,
  ...over,
});

const unione = (primary_id: number, merged_ids: number[]): TableMerge =>
  ({ id: primary_id, date: '2026-10-04', shift: Shift.DINNER, primary_id, merged_ids });

const SALA: Room = { id: 1, name: 'Veranda', width: 1200, height: 600 };

const stato = (reservations: Reservation[], over: Partial<Parameters<typeof groupStatusFor>[0]> = {}) =>
  groupStatusFor({
    groupIds: [1],
    tablesById: new Map([[1, tavolo(1)]]),
    reservations,
    banquetMenus: [],
    service: SERVIZIO,
    nowMs: NOW,
    ...over,
  });

const scena = (over: Partial<SceneInputs> = {}): SceneInputs => ({
  rooms: [SALA],
  tables: [],
  reservations: [],
  banquetMenus: [],
  merges: [],
  hiddenTableIds: new Set<number>(),
  closedRoomIds: new Set<number>(),
  markers: [],
  service: SERVIZIO,
  nowMs: NOW,
  ...over,
});

const accese = (t: TableModel) => t.chairs.flatMap((c, i) => (c.lit ? [i] : []));

describe('il servizio mostrato', () => {
  it('è quello in corso nel fuso del ristorante', () => {
    expect(SERVIZIO).toEqual({ date: '2026-10-04', shift: Shift.DINNER, key: '2026-10-04:DINNER' });
    expect(liveService(new Date(ora('16:59'))).shift).toBe(Shift.LUNCH);
    expect(liveService(new Date(ora('17:00'))).shift).toBe(Shift.DINNER);
  });

  it('una comitiva viva: del servizio, non annullata, non no-show, non andata via', () => {
    expect(isLiveParty(prenotazione(), SERVIZIO, NOW)).toBe(true);
    expect(isLiveParty(prenotazione({ reservation_status: ReservationStatus.NO_SHOW }), SERVIZIO, NOW)).toBe(false);
    expect(isLiveParty(prenotazione({ reservation_status: ReservationStatus.CANCELLED }), SERVIZIO, NOW)).toBe(false);
    expect(isLiveParty(prenotazione({ arrival_status: ArrivalStatus.DEPARTED }), SERVIZIO, NOW)).toBe(false);
    expect(isLiveParty(prenotazione({ reservation_time: ora('19:00', '2026-10-03') }), SERVIZIO, NOW)).toBe(false);
    expect(isLiveParty(prenotazione({ reservation_time: 'non è una data' }), SERVIZIO, NOW)).toBe(false);
  });
});

describe('il colore del tavolo', () => {
  it('è quello di deriveTableDisplayStatus, per la prenotazione che conta', () => {
    const casi: Array<[string, Partial<Reservation>, TableDisplayStatus]> = [
      ['confermata fra 25 minuti', { reservation_time: ora('19:25') }, 'attesa'],
      ['confermata fra 15 minuti', { reservation_time: ora('19:15') }, 'inarrivo'],
      ['in ritardo di 90 minuti', { reservation_time: ora('17:30') }, 'inarrivo'],
      ['seduta', { reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED }, 'arrivato'],
      ['seduta oltre la durata', { reservation_time: ora('16:30'), arrival_status: ArrivalStatus.ARRIVED }, 'uscita'],
      ['in uscita a mano', { reservation_time: ora('18:45'), arrival_status: ArrivalStatus.DEPARTING }, 'uscita'],
      ['da confermare', { reservation_time: ora('19:20'), reservation_status: ReservationStatus.PENDING }, 'attesa'],
      ['no-show', { reservation_time: ora('19:10'), reservation_status: ReservationStatus.NO_SHOW }, 'noshow'],
    ];
    for (const [caso, over, atteso] of casi) {
      const r = prenotazione(over);
      const gs = stato([r]);
      expect(gs.active, caso).toBe(r);
      expect(gs.status, caso).toBe(deriveTableDisplayStatus(r, { now: NOW }));
      expect(gs.status, caso).toBe(atteso);
      expect(gs.pulse, caso).toBe(atteso === 'inarrivo');
    }
    expect(stato([]).status).toBe('libera');
  });

  it('la prossima prenotazione: da 30 minuti prima a 120 dopo, come la 2D', () => {
    expect(stato([prenotazione({ reservation_time: ora('19:30') })]).status).toBe('attesa');
    expect(stato([prenotazione({ reservation_time: ora('19:31') })]).active).toBeNull();
    expect(stato([prenotazione({ reservation_time: ora('17:00') })]).status).toBe('inarrivo');
    expect(stato([prenotazione({ reservation_time: ora('16:59') })]).active).toBeNull();
  });

  it('la prossima è del turno in corso, e non annullata, rifiutata o andata via', () => {
    const fuori: Array<Partial<Reservation>> = [
      { shift: Shift.LUNCH },
      { reservation_status: ReservationStatus.CANCELLED },
      { reservation_status: ReservationStatus.DECLINED },
      { arrival_status: ArrivalStatus.DEPARTED },
      { table_id: 2 },
      { table_id: undefined },
    ];
    for (const over of fuori) {
      expect(stato([prenotazione({ reservation_time: ora('19:10'), ...over })]).status).toBe('libera');
    }
  });

  it('una comitiva seduta occupa il tavolo qualunque turno porti scritto', () => {
    // Un pranzo che sconfina: oltre la durata (90 minuti) è in uscita.
    const pranzo = prenotazione({ reservation_time: ora('15:30'), shift: Shift.LUNCH, arrival_status: ArrivalStatus.ARRIVED });
    const gs = stato([pranzo]);
    expect(gs.status).toBe('uscita');
    // Ma oltre la fine prevista più la grazia non conta più fra i presenti.
    expect(gs.present).toBe(false);
  });

  it('con due comitive sedute vince la più recente; a parità d\'ora, l\'id più alto', () => {
    const prima = prenotazione({ id: 1, reservation_time: ora('18:00'), arrival_status: ArrivalStatus.ARRIVED });
    const dopo = prenotazione({ id: 0, reservation_time: ora('18:45'), arrival_status: ArrivalStatus.ARRIVED });
    expect(stato([dopo, prima]).active).toBe(dopo);
    expect(stato([prima, dopo]).active).toBe(dopo);
    const a = prenotazione({ id: 2000, reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED });
    const b = prenotazione({ id: 2001, reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED });
    expect(stato([b, a]).active).toBe(b);
    expect(stato([a, b]).active).toBe(b);
  });

  it('chi è seduto vince su chi deve arrivare', () => {
    const seduto = prenotazione({ reservation_time: ora('18:00'), arrival_status: ArrivalStatus.ARRIVED });
    const atteso = prenotazione({ reservation_time: ora('19:10') });
    expect(stato([atteso, seduto]).active).toBe(seduto);
  });

  it('un no-show cede il passo a chi deve ancora arrivare; fra due prossime la più vicina', () => {
    const noShow = prenotazione({ reservation_time: ora('18:50'), reservation_status: ReservationStatus.NO_SHOW });
    const attesa = prenotazione({ reservation_time: ora('19:20') });
    expect(stato([noShow, attesa]).active).toBe(attesa);
    expect(stato([noShow]).status).toBe('noshow');
    const prima = prenotazione({ reservation_time: ora('19:10') });
    expect(stato([attesa, prima]).active).toBe(prima);
    expect(stato([prima, attesa]).active).toBe(prima);
  });

  it('fra una mai arrivata e una che sta per arrivare il tavolo aspetta la seconda, come la 2D', () => {
    // Alle 19:00: 6 persone delle 17:30 (90 minuti di ritardo, ancora nella
    // finestra) e 2 delle 19:15. Si accendono le sedie dei 2.
    const ritardo = prenotazione({ reservation_time: ora('17:30'), guests: 6 });
    const dovuta = prenotazione({ reservation_time: ora('19:15'), guests: 2 });
    for (const lista of [[ritardo, dovuta], [dovuta, ritardo]]) {
      const gs = stato(lista);
      expect(gs.active).toBe(dovuta);
      expect(gs.party).toBe(2);
      expect(gs.status).toBe('inarrivo');
    }
    // A pari distanza, in anticipo o in ritardo, l'id più basso.
    const a = prenotazione({ id: 3001, reservation_time: ora('18:50') });
    const b = prenotazione({ id: 3000, reservation_time: ora('19:10') });
    expect(stato([a, b]).active).toBe(b);
    expect(stato([b, a]).active).toBe(b);
  });

  it('un tavolo bloccato da chi sta assegnando è attesa, anche con la scadenza in ISO', () => {
    const bloccato = (temp_lock_expires_at: unknown) =>
      stato([], { tablesById: new Map([[1, tavolo(1, { temp_lock_expires_at: temp_lock_expires_at as number })]]) }).status;
    expect(bloccato(NOW + MIN)).toBe('attesa');
    expect(bloccato(String(NOW + MIN))).toBe('attesa');
    expect(bloccato(new Date(NOW + MIN).toISOString())).toBe('attesa');
    expect(bloccato(NOW - 1)).toBe('libera');
    expect(bloccato('scaduto?')).toBe('libera');
  });
});

describe('le persone e le sedie accese', () => {
  it('come in 2D: gli ospiti della prenotazione, 0 per un no-show, se no quelli del banchetto', () => {
    expect(stato([prenotazione({ reservation_time: ora('19:10'), guests: 3 })]).party).toBe(3);
    expect(stato([prenotazione({ reservation_time: ora('19:10'), reservation_status: ReservationStatus.NO_SHOW })]).party)
      .toBe(0);
    expect(stato([], { banquetMenus: [banchetto({ guests: 9 })] }).party).toBe(9);
    expect(stato([]).party).toBe(0);
  });

  it('senza prenotazione ogni tavolo accende le sue: tutte, o gli ospiti del banchetto', () => {
    const units = [tavolo(1), tavolo(2), tavolo(3, { seats: 2 })];
    expect(litByTable(units, 0, null)).toEqual(new Map([[1, [0, 1, 2, 3]], [2, [0, 1, 2, 3]], [3, [0, 1]]]));
    const banchettoDa3 = litByTable(units, 3, null);
    expect(banchettoDa3.get(1)).toEqual(litChairIndices(TableShape.RECTANGLE, 4, 3));
    expect(banchettoDa3.get(3)).toEqual([0, 1]);
  });

  it('una comitiva si siede prima al suo tavolo, poi agli altri dell\'unione', () => {
    const units = [tavolo(1), tavolo(2), tavolo(3, { seats: 2 })];
    const sette = litByTable(units, 7, 2);
    expect(sette.get(2)).toEqual([0, 1, 2, 3]);
    expect(sette.get(1)).toEqual(litChairIndices(TableShape.RECTANGLE, 4, 3));
    // Il tavolo dove non resta nessuno è vuoto, in un gruppo occupato.
    expect(sette.get(3)).toEqual([]);
    // Il tavolo della prenotazione non è fra quelli disegnati: l'ordine
    // dell'unione.
    const cinque = litByTable(units, 5, 99);
    expect([cinque.get(1), cinque.get(2), cinque.get(3)]).toEqual([[0, 1, 2, 3], [0], []]);
    // Un no-show (0 persone) le lascia tutte accese, come in 2D.
    expect(litByTable(units, 0, 2)).toEqual(litByTable(units, 0, null));
  });

  it('un tavolo da solo accende esattamente le sedie della piantina', () => {
    for (const shape of [TableShape.RECTANGLE, TableShape.SQUARE, TableShape.CIRCLE]) {
      for (let party = 0; party <= 7; party++) {
        const t = tavolo(1, { shape, seats: 5 });
        expect(litByTable([t], party, 1).get(1)).toEqual(litChairIndices(shape, 5, party));
        expect(litByTable([t], party, null).get(1)).toEqual(litChairIndices(shape, 5, party));
      }
    }
  });
});

describe('le unioni sono un tavolo solo', () => {
  it('il gruppo di un tavolo è quello della sua unione nel turno', () => {
    const gruppi = buildMergeGroups([unione(1, [2])]);
    expect(groupIdsOf(2, gruppi, Shift.DINNER)).toEqual([1, 2]);
    expect(groupIdsOf(2, gruppi, Shift.LUNCH)).toEqual([2]);
    expect(groupIdsOf(5, gruppi, Shift.DINNER)).toEqual([5]);
  });

  it('una comitiva su un secondario colora tutto il gruppo', () => {
    const r = prenotazione({ table_id: 2, reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED, guests: 6 });
    expect(activeReservationFor([1, 2], [r], SERVIZIO, NOW)).toBe(r);
    expect(activeReservationFor([1], [r], SERVIZIO, NOW)).toBeNull();

    // Un tavolo solo, «1+2» da 8, come in 2D: la comitiva del secondario lo
    // colora e ne accende sei sedie.
    const model = deriveSceneModel(scena({ tables: [tavolo(1), tavolo(2)], merges: [unione(1, [2])], reservations: [r] }));
    const tavoli = model.rooms[0].tables;
    expect(tavoli.map(t => [t.id, t.name, t.status])).toEqual([[1, '1+2', 'arrivato']]);
    expect(accese(tavoli[0])).toEqual(litChairIndices(TableShape.RECTANGLE, 8, 6));
  });

  it('un\'unione disegnata come in 2D è un tavolo con le sedie della 2D', () => {
    const r = prenotazione({ table_id: 2, reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED, guests: 6 });
    // Anche col secondario lontano: un tavolo solo, «1+2» da 8.
    const model = deriveSceneModel(scena({
      tables: [tavolo(1), tavolo(2, { x: 600 })],
      merges: [unione(1, [2])],
      reservations: [r],
    }));
    const [unito] = model.rooms[0].tables;
    expect(model.rooms[0].tables).toHaveLength(1);
    expect([unito.id, unito.name, unito.status]).toEqual([1, '1+2', 'arrivato']);
    expect(unito.chairs).toHaveLength(8);
    expect(accese(unito)).toEqual(litChairIndices(TableShape.RECTANGLE, 8, 6));
  });
});

describe('il giorno di servizio, non il calendario', () => {
  it('un walk-in delle 00:30 col turno LUNCH è della cena di ieri', () => {
    // Accoglienza dà LUNCH a ogni walk-in prima delle 16, anche alle 00:30.
    const notte = Date.parse(ora('00:40', '2026-10-05'));
    const servizio = liveService(new Date(notte));
    expect(servizio).toEqual({ date: '2026-10-04', shift: Shift.DINNER, key: '2026-10-04:DINNER' });

    const walkIn = prenotazione({
      reservation_time: ora('00:30', '2026-10-05'),
      shift: Shift.LUNCH,
      arrival_status: ArrivalStatus.ARRIVED,
      guests: 2,
    });
    expect(serviceDayOf(walkIn.reservation_time)).toBe('2026-10-04');
    expect(inService(walkIn, servizio, notte)).toBe(true);
    const gs = stato([walkIn], { service: servizio, nowMs: notte });
    expect(gs.status).toBe('arrivato');
    expect(gs.present).toBe(true);

    // Il pranzo di domani non è di questo servizio, anche se il calendario
    // è già al 5.
    const domani = prenotazione({ reservation_time: ora('12:30', '2026-10-05'), shift: Shift.LUNCH });
    expect(inService(domani, servizio, notte)).toBe(false);
  });
});

describe('i banchetti', () => {
  it('i tavoli di un banchetto del servizio sono attesa, anche con qualcuno seduto', () => {
    expect(stato([], { banquetMenus: [banchetto()] }).status).toBe('attesa');
    const seduto = prenotazione({ reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED });
    expect(stato([seduto], { banquetMenus: [banchetto()] }).status).toBe('attesa');
    // Un banchetto su un altro tavolo del gruppo vale per tutto il gruppo.
    expect(stato([], { groupIds: [1, 2], banquetMenus: [banchetto({ table_ids: [2] })] }).status).toBe('attesa');
  });

  it('un banchetto di un altro turno o giorno, o senza tavoli leggibili, non conta', () => {
    expect(stato([], { banquetMenus: [banchetto({ shift: Shift.LUNCH })] }).status).toBe('libera');
    expect(stato([], { banquetMenus: [banchetto({ event_date: '2026-10-05' })] }).status).toBe('libera');
    expect(stato([], { banquetMenus: [banchetto({ table_ids: '1' as unknown as number[] })] }).status).toBe('libera');
    expect(stato([], { banquetMenus: [banchetto({ table_ids: undefined })] }).status).toBe('libera');
  });

  it('nella sala: le sedie accese sono gli ospiti del banchetto, su ogni suo tavolo', () => {
    const model = deriveSceneModel(scena({
      tables: [tavolo(1), tavolo(2, { x: 500 })],
      banquetMenus: [banchetto({ table_ids: [1, 2], guests: 3 })],
    }));
    for (const t of model.rooms[0].tables) {
      expect(t.status).toBe('attesa');
      expect(accese(t)).toEqual(litChairIndices(TableShape.RECTANGLE, 4, 3));
    }
  });
});

describe('il modello della sala', () => {
  const seduti = prenotazione({ table_id: 1, reservation_time: ora('18:30'), arrival_status: ArrivalStatus.ARRIVED, guests: 3 });
  const inArrivo = prenotazione({ table_id: 2, reservation_time: ora('19:15'), guests: 2 });
  // Seduti alle 16:00: fine prevista alle 18:00, più 45 minuti → fuori alle 18:45.
  const dimenticati = prenotazione({ table_id: 3, reservation_time: ora('16:00'), arrival_status: ArrivalStatus.ARRIVED, guests: 5 });
  const senzaOspiti = prenotazione({ table_id: 4, reservation_time: ora('19:15'), guests: 0 });
  const fuori = prenotazione({
    table_id: 5,
    reservation_time: ora('18:00'),
    arrival_status: ArrivalStatus.ARRIVED,
    guests: 4,
    duration_minutes: 90,
  });
  const FIUME = { id: 2, name: 'Fiume', width: 800, height: 600, location: 'OUTDOOR' } as Room;
  const inputs = scena({
    // Fiume prima di Veranda: l'ordine lo decide sortRooms.
    rooms: [FIUME, SALA],
    tables: [tavolo(1), tavolo(2), tavolo(3), tavolo(4), tavolo(5, { room_id: 2 })],
    reservations: [seduti, inArrivo, dimenticati, senzaOspiti, fuori],
    markers: [{ id: 1, room_id: 1, kind: 'ENTRANCE', x: 100, y: 550 } as FloorMarker],
    closedRoomIds: new Set([2]),
  });
  const model = deriveSceneModel(inputs);
  const [veranda, fiume] = model.rooms;

  it('le sale nell\'ordine di sortRooms, chiuse comprese', () => {
    expect(model.rooms.map(r => r.name)).toEqual(['Veranda', 'Fiume']);
    expect([veranda.closed, fiume.closed]).toEqual([false, true]);
    expect(deriveSceneModel(scena({ rooms: [{ ...SALA, is_closed: true }] })).rooms[0].closed).toBe(true);
  });

  it('all\'aperto dalla location della sala, letta con prudenza', () => {
    expect([veranda.outdoor, fiume.outdoor]).toEqual([false, true]);
  });

  it('il riassunto conta persone: a tavola entro la grazia, in arrivo dietro gli anelli', () => {
    expect(SEATED_GRACE_MIN).toBe(45);
    expect(veranda.tables.map(t => t.status)).toEqual(['arrivato', 'inarrivo', 'uscita', 'inarrivo']);
    // 3 a tavola (i 5 delle 16:00 sono oltre la grazia); in arrivo 2 + 1 (una
    // prenotazione senza ospiti è comunque qualcuno). I coperti sono i posti.
    expect(veranda.summary).toEqual({ seated: 3, arriving: 3, covers: 16 });
    expect(fiume.summary).toEqual({ seated: 4, arriving: 0, covers: 4 });
    expect(model.summary).toEqual({ seated: 7, arriving: 3 });
  });

  it('pavimento, segnaposto e inquadratura in metri', () => {
    // 1200 × 600 px, ma l'ingresso a y = 550 allarga il fondo fino alla sua
    // etichetta più il margine: 670 px.
    expect(veranda.floor.width).toBeCloseTo(24, 9);
    expect(veranda.floor.depth).toBeCloseTo(13.4, 9);
    expect(veranda.markers.ENTRANCE.pos.x).toBeCloseTo(2, 12);
    expect(veranda.markers.ENTRANCE.pos.z).toBeCloseTo(11, 12);
    expect(veranda.markers.ENTRANCE.placed).toBe(true);
    expect(veranda.markers.ENTRANCE.inward).toEqual({ x: 0, z: -1 });
    expect(veranda.markers.PASS.placed).toBe(false);
    expect(veranda.audit.missingMarkers).toEqual(['PASS', 'HOST_STAND']);
    // Dal segnaposto più a sinistra (l'ingresso, 2 − 0,6) al pass di ripiego
    // (1140 px → 22,8 + 0,6); dal bordo dei tavoli a 0 all'ingresso (11 + 0,6).
    expect(veranda.bounds.minX).toBeCloseTo(1.4, 9);
    expect(veranda.bounds.minZ).toBeCloseTo(0, 9);
    expect(veranda.bounds.maxX).toBeCloseTo(23.4, 9);
    expect(veranda.bounds.maxZ).toBeCloseTo(11.6, 9);
    for (const t of veranda.tables) {
      expect(t.center.x).toBeGreaterThan(veranda.bounds.minX);
      expect(t.center.x).toBeLessThan(veranda.bounds.maxX);
    }
  });

  it('ogni tavolo porta il suo id, nome, sala e corpo', () => {
    const t = veranda.tables[0];
    expect([t.id, t.name, t.roomId, t.shape]).toEqual([1, '1', 1, 'rect']);
    expect(t.length).toBeCloseTo(1.12, 9);
    expect(t.depth).toBeCloseTo(0.8, 9);
    expect(t.chairs).toHaveLength(4);
  });

  it('è puro: con gli stessi ingressi la stessa sala', () => {
    expect(deriveSceneModel(inputs)).toEqual(model);
    expect(model.service).toBe(SERVIZIO);
  });

  it('una sala vuota ha pavimento e segnaposto, nessun tavolo', () => {
    const vuota = deriveSceneModel(scena()).rooms[0];
    expect(vuota.tables).toEqual([]);
    expect(vuota.summary).toEqual({ seated: 0, arriving: 0, covers: 0 });
    expect(vuota.audit).toEqual({ overlaps: [], unset: false, missingMarkers: ['ENTRANCE', 'PASS', 'HOST_STAND'] });
    expect(vuota.bounds.maxX).toBeGreaterThan(vuota.bounds.minX);
  });

  it('i tavoli nascosti per il servizio non si disegnano e non contano', () => {
    const nascosti = deriveSceneModel({ ...inputs, hiddenTableIds: new Set([1]) });
    expect(nascosti.rooms[0].tables.map(t => t.id)).toEqual([2, 3, 4]);
    expect(nascosti.rooms[0].summary).toEqual({ seated: 0, arriving: 3, covers: 12 });
  });

  it('dati monchi non fanno cadere il modello', () => {
    const rotto = deriveSceneModel(scena({
      tables: [tavolo(1), null as unknown as Table],
      reservations: [null as unknown as Reservation, prenotazione({ table_id: 'x' as unknown as number })],
      banquetMenus: [null as unknown as BanquetMenu],
      merges: undefined as unknown as TableMerge[],
      markers: undefined as unknown as FloorMarker[],
    }));
    expect(rotto.rooms[0].tables.map(t => t.status)).toEqual(['libera']);
  });
});
