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
import { setSessionTimeZone } from '../../utils/displayTime';
import type { SceneCopy, SceneInputs } from '../../components/salaVivo/types';
import { liveService } from '../../components/salaVivo/model/service';
import { groupStatusFor } from '../../components/salaVivo/model/tableStatus';
import {
  CAPTION_MAX,
  SIGN_AHEAD_MIN,
  SIGN_LATE_MIN,
  captionFor,
  guestName,
  signFor,
  truncateCaption,
  type SignChoice,
} from '../../components/salaVivo/model/signs';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';

/* I cartellini «Riservato · HH:MM» ed «Evento» sui tavoli dove non siede
 * nessuno, e la seconda riga dell'etichetta. La cena del 4 ottobre 2026 a
 * Roma, letta alle 19:00. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));
const MIN = 60_000;
const COPY: SceneCopy = { reserved: (time: string) => `Riservato · ${time}`, event: 'Evento' };

let seq = 7000;
const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
  id: seq++,
  customer_name: 'rossi',
  reservation_time: ora('20:30'),
  shift: Shift.DINNER,
  guests: 2,
  table_id: 1,
  payment_status: PaymentStatus.PENDING,
  arrival_status: ArrivalStatus.WAITING,
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

const banchetto = (over: Partial<BanquetMenu> = {}): BanquetMenu => ({
  id: 7,
  name: 'Cresima di Giulia',
  description: '',
  price_per_person: 40,
  dish_ids: [],
  event_date: '2026-10-04',
  shift: Shift.DINNER,
  table_ids: [1],
  guests: 12,
  ...over,
});

const stato = (reservations: Reservation[], banquetMenus: BanquetMenu[] = []) =>
  groupStatusFor({
    groupIds: [1],
    tablesById: new Map([[1, tavolo(1)]]),
    reservations,
    banquetMenus,
    service: SERVIZIO,
    nowMs: NOW,
  });

// Il cartellino di un tavolo con queste prenotazioni, come lo sceglie la sala.
const cartello = (reservations: Reservation[], over: { banquets?: BanquetMenu[]; occupied?: boolean } = {}) =>
  signFor({
    status: stato(reservations, over.banquets),
    candidates: reservations,
    occupied: over.occupied ?? false,
    service: SERVIZIO,
    nowMs: NOW,
  });

const riservato = (s: SignChoice | null) => (s?.kind === 'reserved' ? s.time : null);

describe('«Riservato»', () => {
  it('«Riservato · 20:30» con l\'ora del ristorante', () => {
    // 18:30 in UTC sono le 20:30 a Roma: l'ora scritta è quella del locale.
    const r = prenotazione({ reservation_time: '2026-10-04T18:30:00.000Z' });
    const s = cartello([r]);
    expect(s).toEqual({ kind: 'reserved', reservation: r, time: '20:30' });
    expect(captionFor({ sign: s, seated: null, showNames: false, copy: COPY })).toBe('Riservato · 20:30');
  });

  it('da 90 minuti prima a 120 dopo l\'ora prenotata, bordi compresi', () => {
    expect([SIGN_AHEAD_MIN, SIGN_LATE_MIN]).toEqual([90, 120]);
    const a = (ms: number) => riservato(cartello([prenotazione({ reservation_time: new Date(ms).toISOString() })]));
    expect(a(NOW + 90 * MIN)).toBe('20:30');
    expect(a(NOW + 91 * MIN)).toBeNull();
    expect(a(NOW - 120 * MIN)).toBe('17:00');
    expect(a(NOW - 121 * MIN)).toBeNull();
  });

  it('la prenotazione dietro il colore del tavolo vince su una più vicina', () => {
    // Alle 19:00 il tavolo aspetta quelli delle 17:20, in ritardo (l'anello
    // pulsa per loro); quelli delle 20:00 sono più vicini, ma il cartellino
    // parla della stessa prenotazione dell'anello.
    const ritardo = prenotazione({ reservation_time: ora('17:20') });
    const dopo = prenotazione({ reservation_time: ora('20:00') });
    expect(stato([ritardo, dopo]).active).toBe(ritardo);
    expect(riservato(cartello([dopo, ritardo]))).toBe('17:20');
    // Senza una prenotazione dietro il colore, la più vicina.
    const s = signFor({
      status: { ...stato([]), active: null },
      candidates: [ritardo, dopo],
      occupied: false,
      service: SERVIZIO,
      nowMs: NOW,
    });
    expect(riservato(s)).toBe('20:00');
  });

  it('a pari distanza la prima, poi l\'id più basso', () => {
    const libero = { ...stato([]), active: null };
    const prima = prenotazione({ id: 2, reservation_time: ora('18:50') });
    const dopo = prenotazione({ id: 1, reservation_time: ora('19:10') });
    const pari = prenotazione({ id: 3, reservation_time: ora('18:50') });
    const scegli = (candidates: Reservation[]) =>
      signFor({ status: libero, candidates, occupied: false, service: SERVIZIO, nowMs: NOW });
    expect(scegli([dopo, prima])).toEqual({ kind: 'reserved', reservation: prima, time: '18:50' });
    expect(scegli([pari, dopo, prima])).toEqual({ kind: 'reserved', reservation: prima, time: '18:50' });
  });

  it('anche da confermare; mai no-show, annullate, rifiutate, sedute, andate via o di un altro turno', () => {
    expect(riservato(cartello([prenotazione({ reservation_status: ReservationStatus.PENDING })]))).toBe('20:30');
    const mai: Array<Partial<Reservation>> = [
      { reservation_status: ReservationStatus.NO_SHOW },
      { reservation_status: ReservationStatus.CANCELLED },
      { reservation_status: ReservationStatus.DECLINED },
      { arrival_status: ArrivalStatus.ARRIVED },
      { arrival_status: ArrivalStatus.DEPARTING },
      { arrival_status: ArrivalStatus.DEPARTED },
      { shift: Shift.LUNCH },
      { reservation_time: ora('20:30', '2026-10-05') },
      { reservation_time: 'non è una data' },
    ];
    for (const over of mai) expect(cartello([prenotazione(over)]), JSON.stringify(over)).toBeNull();
  });

  it('niente cartellino dove siede qualcuno', () => {
    expect(cartello([prenotazione()], { occupied: true })).toBeNull();
    expect(cartello([], { banquets: [banchetto()], occupied: true })).toBeNull();
  });
});

describe('«Evento»', () => {
  it('sui tavoli di un banchetto del servizio, e vince su «Riservato»', () => {
    const b = banchetto();
    expect(cartello([], { banquets: [b] })).toEqual({ kind: 'event', banquet: b });
    expect(cartello([prenotazione()], { banquets: [b] })).toEqual({ kind: 'event', banquet: b });
    // Un banchetto di un altro giorno non è un evento qui.
    expect(cartello([], { banquets: [banchetto({ event_date: '2026-10-05' })] })).toBeNull();
  });
});

describe('la seconda riga dell\'etichetta', () => {
  const evento: SignChoice = { kind: 'event', banquet: banchetto({ name: 'Cresima di giulia' }) };
  const seduti = prenotazione({ customer_name: 'famiglia ESPOSITO', arrival_status: ArrivalStatus.ARRIVED });

  it('chi siede al tavolo: il nome solo a nomi accesi, in Title Case', () => {
    expect(captionFor({ sign: null, seated: seduti, showNames: true, copy: COPY })).toBe('Famiglia Esposito');
    expect(captionFor({ sign: null, seated: seduti, showNames: false, copy: COPY })).toBeNull();
    expect(captionFor({ sign: null, seated: prenotazione({ customer_name: '   ' }), showNames: true, copy: COPY })).toBeNull();
  });

  it('il banchetto: il suo nome com\'è scritto solo a nomi accesi, se no «Evento»', () => {
    expect(captionFor({ sign: evento, seated: null, showNames: true, copy: COPY })).toBe('Cresima di giulia');
    expect(captionFor({ sign: evento, seated: null, showNames: false, copy: COPY })).toBe('Evento');
    const senzaNome: SignChoice = { kind: 'event', banquet: banchetto({ name: '  ' }) };
    expect(captionFor({ sign: senzaNome, seated: null, showNames: true, copy: COPY })).toBe('Evento');
  });

  it('«Riservato · HH:MM» a nomi accesi o spenti; niente riga senza cartellino', () => {
    const s: SignChoice = { kind: 'reserved', reservation: prenotazione(), time: '20:30' };
    expect(captionFor({ sign: s, seated: null, showNames: true, copy: COPY })).toBe('Riservato · 20:30');
    expect(captionFor({ sign: s, seated: null, showNames: false, copy: COPY })).toBe('Riservato · 20:30');
    expect(captionFor({ sign: null, seated: null, showNames: true, copy: COPY })).toBeNull();
  });

  it('prima che i testi siano pronti nessuna riga vuota', () => {
    const vuoto: SceneCopy = { reserved: () => '', event: '' };
    expect(captionFor({ sign: evento, seated: null, showNames: false, copy: vuoto })).toBeNull();
    const s: SignChoice = { kind: 'reserved', reservation: prenotazione(), time: '20:30' };
    expect(captionFor({ sign: s, seated: null, showNames: false, copy: vuoto })).toBeNull();
    // Un copy rotto non fa cadere niente: resta l'ora.
    expect(captionFor({ sign: s, seated: null, showNames: false, copy: null as unknown as SceneCopy })).toBe('20:30');
  });

  it('al più 24 caratteri veri, «…» compreso', () => {
    expect(CAPTION_MAX).toBe(24);
    // I primi 23, poi «…»; uno spazio prima dei puntini non resta.
    expect(truncateCaption('Bartolomeo Dellavalle Fontana')).toBe('Bartolomeo Dellavalle F…');
    expect(Array.from(truncateCaption('Bartolomeo Dellavalle Fontana'))).toHaveLength(24);
    expect(truncateCaption('Bartolomeo Della Valle Fontana')).toBe('Bartolomeo Della Valle…');
    expect(truncateCaption('Esattamente ventiquattro')).toBe('Esattamente ventiquattro');
    // Le emoji contano uno: non si spezzano a metà.
    expect(truncateCaption('🎂'.repeat(30))).toBe(`${'🎂'.repeat(23)}…`);
    expect(guestName({ customer_name: 'maria   de   rossi' })).toBe('Maria De Rossi');
    expect(guestName({ customer_name: 'bartolomeo della valle fontana' })).toBe('Bartolomeo Della Valle…');
    expect(guestName({ customer_name: null as unknown as string })).toBeNull();
  });
});

describe('nella sala', () => {
  const VERANDA: Room = { id: 1, name: 'Veranda', width: 1200, height: 600 };
  const scena = (over: Partial<SceneInputs> = {}): SceneInputs => ({
    rooms: [VERANDA],
    tables: [tavolo(1), tavolo(2), tavolo(3), tavolo(4)],
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
    copy: COPY,
    ...over,
  });
  const attesi = prenotazione({ table_id: 1, reservation_time: ora('20:30'), customer_name: 'bianchi' });
  const seduti = prenotazione({
    table_id: 2,
    reservation_time: ora('18:30'),
    arrival_status: ArrivalStatus.ARRIVED,
    customer_name: 'famiglia esposito',
    // Più tardi c'è un'altra prenotazione: dove siede qualcuno non si vede.
  });
  const doppio = prenotazione({ table_id: 2, reservation_time: ora('20:00'), customer_name: 'verdi' });

  it('cartellini e seconde righe, a nomi spenti', () => {
    const model = deriveSceneModel(scena({
      reservations: [attesi, seduti, doppio],
      banquetMenus: [banchetto({ table_ids: [3] })],
    }));
    const tavoli = model.rooms[0].tables;
    expect(tavoli.map(t => [t.id, t.sign, t.caption])).toEqual([
      [1, 'reserved', 'Riservato · 20:30'],
      [2, null, null],
      [3, 'event', 'Evento'],
      [4, null, null],
    ]);
    // A nomi spenti nessun nome di persona entra nel modello.
    expect(model.rooms[0].parties.map(p => p.name)).toEqual([null]);
    expect(JSON.stringify(model)).not.toMatch(/esposito|bianchi|verdi|cresima/i);
  });

  it('a nomi accesi: il nome di chi siede e quello del banchetto', () => {
    const model = deriveSceneModel(scena({
      reservations: [attesi, seduti, doppio],
      banquetMenus: [banchetto({ table_ids: [3] })],
      showNames: true,
    }));
    const tavoli = model.rooms[0].tables;
    expect(tavoli.map(t => t.caption)).toEqual(['Riservato · 20:30', 'Famiglia Esposito', 'Cresima di Giulia', null]);
    expect(model.rooms[0].parties.map(p => p.name)).toEqual(['Famiglia Esposito']);
  });
});
