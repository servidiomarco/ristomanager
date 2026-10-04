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
} from '../../types';
import { setSessionTimeZone } from '../../utils/displayTime';
import type {
  ActorView,
  DirectorEvent,
  DirectorTuning,
  FigureSlot,
  SceneInputs,
  SceneModel,
} from '../../components/salaVivo/types';
import { liveService } from '../../components/salaVivo/model/service';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';
import { DOOR_OUTSIDE, buildNavGrid, roomAnchors } from '../../components/salaVivo/model/navGrid';
import { mulberry32 } from '../../components/salaVivo/model/rng';
import {
  DIRECTOR_DEFAULTS,
  DIRECTOR_SEED,
  DIRECTOR_TUNING,
  SceneDirector,
  withArrivalTargets,
} from '../../components/salaVivo/model/director';

/* Il regista della Sala dal vivo: dal confronto di due modelli al passaggio
 * messo in scena, e ritorno alle figure statiche esatte.
 *
 * La cena del 4 ottobre 2026 a Roma, letta alle 19:00. Due sale: la Veranda
 * (20 × 12 m, la porta nel muro di sinistra, l'accoglienza accanto, il pass
 * in alto a destra, due file di tavoli da 4) e il Fiume (16 × 10 m, la porta
 * a sinistra, un tavolo). Un orologio finto, il seme della pagina, passi da
 * 33 ms; a ogni passo si controlla che nessuno sia disegnato due volte e che
 * nessuno manchi. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));
const PASSO = 33;

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

const VERANDA: Room = { id: 1, name: 'Veranda', width: 1000, height: 600 };
const FIUME: Room = { id: 2, name: 'Fiume', width: 800, height: 500 };

const TAVOLI: Table[] = [
  tavolo(1, 250, 120),
  tavolo(2, 430, 120),
  tavolo(3, 610, 120),
  tavolo(5, 790, 120),
  tavolo(6, 250, 360),
  tavolo(7, 430, 360),
  tavolo(8, 610, 360),
  tavolo(9, 790, 360),
  tavolo(4, 300, 200, { room_id: 2 }),
];

const SEGNAPOSTO: FloorMarker[] = [
  { id: 1, room_id: 1, kind: 'ENTRANCE', x: 0, y: 300 } as FloorMarker,
  { id: 2, room_id: 1, kind: 'HOST_STAND', x: 60, y: 380 } as FloorMarker,
  { id: 3, room_id: 1, kind: 'PASS', x: 980, y: 60 } as FloorMarker,
  { id: 4, room_id: 2, kind: 'ENTRANCE', x: 0, y: 250 } as FloorMarker,
];

let seq = 500;
const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
  id: seq++,
  customer_name: 'Esposito',
  reservation_time: ora('18:45'),
  shift: Shift.DINNER,
  guests: 4,
  table_id: 1,
  payment_status: PaymentStatus.PENDING,
  arrival_status: ArrivalStatus.WAITING,
  reservation_status: ReservationStatus.CONFIRMED,
  ...over,
});

// La stessa prenotazione con qualche campo cambiato: quello che fa Reception.
const con = (r: Reservation, over: Partial<Reservation>): Reservation => ({ ...r, ...over });
const arrivata = (r: Reservation, over: Partial<Reservation> = {}) => con(r, { arrival_status: ArrivalStatus.ARRIVED, ...over });

const scena = (reservations: Reservation[], over: Partial<SceneInputs> = {}): SceneModel =>
  deriveSceneModel({
    rooms: [VERANDA, FIUME],
    tables: TAVOLI,
    reservations,
    banquetMenus: [],
    merges: [],
    hiddenTableIds: new Set<number>(),
    closedRoomIds: new Set<number>(),
    markers: SEGNAPOSTO,
    service: SERVIZIO,
    nowMs: NOW,
    notePresets: [],
    showNames: false,
    copy: { reserved: (t: string) => `Riservato · ${t}`, event: 'Evento' },
    ...over,
  });

interface Regia {
  d: SceneDirector;
  clock: { t: number };
  events: DirectorEvent[];
  model: SceneModel | null;
  /** I cambi di tavolo a piedi all'ultimo controllo (comitiva → `sala:tavolo`
   *  nuovo) e quanti eventi c'erano allora: ogni anello che si accende o si
   *  spegne deve avere il suo evento. */
  cambi: Map<number, string>;
  visti: number;
  /** L'update appena fatto azzera (il primo, un cambio di servizio): non
   *  racconta niente, e i tavoli «in arrivo» li ridisegna la pagina dopo
   *  l'update, perché sa di aver dato un servizio nuovo (SalaVivoPage). */
  azzera: boolean;
}

const regista = (tuning?: Partial<DirectorTuning>): Regia => {
  const clock = { t: 10_000 };
  const d = new SceneDirector({ now: () => clock.t, seed: DIRECTOR_SEED, tuning });
  const r: Regia = { d, clock, events: [], model: null, cambi: new Map(), visti: 0, azzera: false };
  d.onEvent(e => r.events.push(e));
  return r;
};

// Un update come lo fa la pagina, col tempo dell'orologio che avanza.
const aggiorna = (r: Regia, model: SceneModel, reason: Parameters<SceneDirector['update']>[1] = null, dopoMs = 3000) => {
  r.clock.t += dopoMs;
  r.azzera = reason === 'initial' || r.model === null || r.model.service.key !== model.service.key;
  r.model = model;
  r.d.update(model, reason);
  controlla(r);
  r.azzera = false;
};

const tipi = (events: DirectorEvent[]) => events.map(e => e.kind);
const persona = (id: string, name: string, role: string | null = null) => ({ id, name, role });
const stanza = (model: SceneModel, id: number) => model.rooms.find(rm => rm.id === id)!;
const figure = (model: SceneModel, roomId: number, partyId: number): FigureSlot[] =>
  stanza(model, roomId).figures.filter(f => f.partyId === partyId);
const chiavi = (views: readonly ActorView[]) => views.map(v => v.key);
const ancore = (model: SceneModel, roomId: number) => {
  const rm = stanza(model, roomId);
  return roomAnchors(rm, buildNavGrid(rm));
};

/* Gli strati, a ogni passo: chi il regista disegna in una sala e che sta fra
 * le figure di quella sala è anche in movingKeys (People lo salta), nessuno è
 * disegnato in due sale, e una chiave che il regista tiene senza disegnarla
 * è di una comitiva in pieno passaggio (in coda per l'accompagnamento, o in
 * attesa del suo turno). L'hostess sempre al regista. */
function controlla(r: Regia): void {
  const model = r.model;
  if (!model) return;
  // Condizioni semplici, e expect solo se qualcosa non torna: decine di
  // attori per migliaia di passi.
  const drawn = new Set<string>();
  for (const room of model.rooms) {
    const moving = r.d.movingKeys(room.id);
    if (!moving.has(`host:${room.id}`)) expect([...moving]).toContain(`host:${room.id}`);
    const figKeys = new Set(room.figures.map(f => f.key));
    const views = r.d.actorsIn(room.id);
    if (views[0]?.key !== `host:${room.id}`) expect(views[0]?.key).toBe(`host:${room.id}`);
    for (const v of views) {
      if (drawn.has(v.key)) expect.fail(`${v.key} disegnato due volte`);
      drawn.add(v.key);
      if (figKeys.has(v.key) && !moving.has(v.key)) expect.fail(`${v.key} disegnato anche da People`);
      const finite = [v.x, v.z, v.yaw, v.seat, v.walk, v.fade, v.phase].every(Number.isFinite);
      if (!finite || v.fade < 0 || v.fade > 1 || v.seat < 0 || v.seat > 1) expect.fail(`${v.key} fuori scala: ${JSON.stringify(v)}`);
    }
  }
  let scripted: Set<number> | null = null;
  for (const room of model.rooms) {
    for (const key of r.d.movingKeys(room.id)) {
      if (drawn.has(key) || key.startsWith('host:')) continue;
      if (scripted === null) {
        scripted = new Set<number>();
        for (const rm of model.rooms) for (const id of r.d.inspect(rm.id)!.scripts.keys()) scripted.add(id);
      }
      const pid = Number(/^r(-?\d+):/.exec(key)?.[1]);
      expect(scripted.has(pid), `${key} nascosto senza un passaggio`).toBe(true);
    }
  }
  controllaAnelli(r);
}

/* Gli anelli «in arrivo»: gli accompagnamenti più i tavoli nuovi dei cambi a
 * piedi, e nessuno a regista fermo. La pagina ridisegna i tavoli solo a un
 * evento, quindi ogni anello di un cambio si accende con il suo 'moved' e si
 * spegne con un 'moved-end', uno solo, nello stesso update o passo; un
 * 'moved-end' senza un cambio aperto è un evento falso. Si rigiocano gli
 * eventi arrivati dall'ultimo controllo: un 'moved' apre un cambio solo se
 * poi qualcosa lo chiude o il regista lo tiene (le comitive grandi, gli
 * scatti e i cambi di tavolo di un accompagnamento non accendono niente). */
function controllaAnelli(r: Regia): void {
  const model = r.model!;
  const fermoOra = !r.d.isAnimating();
  const cambi = new Map<number, string>();
  for (const room of model.rooms) {
    const moves = r.d.inspect(room.id)!.moves;
    for (const [pid, t] of moves) cambi.set(pid, `${room.id}:${t}`);
    const want = new Set([...r.d.escortTargets(room.id), ...moves.values()]);
    const got = r.d.arrivalTargets(room.id);
    if (got.size !== want.size || [...want].some(t => !got.has(t))) {
      expect.fail(`sala ${room.id}: anelli ${[...got]} invece di ${[...want]}`);
    }
    if (fermoOra && got.size > 0) expect.fail(`sala ${room.id}: anello acceso a regista fermo (${[...got]})`);
  }
  const aperti = new Map(r.cambi);
  const appena = new Map<number, string>();
  for (const e of r.events.slice(r.visti)) {
    if (e.kind === 'moved') {
      appena.set(e.party.id, `${e.roomId}:${e.to.id}`);
    } else if (e.kind === 'moved-end') {
      const dove = `${e.roomId}:${e.tableId}`;
      if (aperti.get(e.partyId) === dove) aperti.delete(e.partyId);
      else if (appena.get(e.partyId) === dove) appena.delete(e.partyId);
      else expect.fail(`'moved-end' di ${e.partyId} verso ${dove} senza un cambio aperto`);
    }
  }
  // Un azzeramento dimentica i cambi senza raccontarli.
  for (const [pid, dove] of aperti) {
    if (!r.azzera && cambi.get(pid) !== dove) expect.fail(`il cambio di ${pid} verso ${dove} finisce senza 'moved-end'`);
  }
  for (const [pid, dove] of cambi) {
    if (aperti.get(pid) !== dove && appena.get(pid) !== dove) expect.fail(`il cambio di ${pid} verso ${dove} comincia senza 'moved'`);
  }
  r.cambi = cambi;
  r.visti = r.events.length;
}

/* Chi torna a People ci torna ESATTAMENTE sulla sua figura statica: si
 * tengono le viste (gli oggetti del regista restano com'erano quando
 * l'attore esce di scena) e, quando una chiave lascia movingKeys, l'ultima
 * vista deve coincidere con la figura. */
function osserva(r: Regia) {
  const views = new Map<string, ActorView>();
  const before = new Map<number, Set<string>>();
  const released: string[] = [];
  const firstSeen = new Map<string, { x: number; z: number; fade: number; roomId: number }>();
  // check false: dopo un update o un configure, dove uno scatto rende le
  // chiavi a People senza camminare (di proposito): si rifà solo la base.
  const sample = (check = true) => {
    const model = r.model!;
    for (const room of model.rooms) {
      for (const v of r.d.actorsIn(room.id)) {
        views.set(v.key, v);
        if (v.fade > 0 && !firstSeen.has(v.key)) firstSeen.set(v.key, { x: v.x, z: v.z, fade: v.fade, roomId: room.id });
      }
    }
    for (const room of model.rooms) {
      const now = new Set(r.d.movingKeys(room.id));
      for (const k of before.get(room.id) ?? []) {
        if (now.has(k)) continue;
        const fig = room.figures.find(f => f.key === k);
        const v = views.get(k);
        if (!fig || !v || !check) continue;
        released.push(k);
        const got = { x: v.x, z: v.z, yaw: v.yaw, seatHeight: v.seatHeight, pose: v.pose, seat: v.seat, walk: v.walk, fade: v.fade };
        const want = {
          x: fig.x, z: fig.z, yaw: fig.yaw, seatHeight: fig.seatHeight, pose: fig.pose,
          seat: fig.pose === 'seated' || fig.pose === 'lying' ? 1 : 0, walk: 0, fade: 1,
        };
        if (JSON.stringify(got) !== JSON.stringify(want)) expect(got, `${k} torna a People esatto`).toEqual(want);
      }
      before.set(room.id, now);
    }
  };
  sample();
  return { sample, released, firstSeen, views };
}

const avanza = (r: Regia, ms: number, onStep?: () => void) => {
  for (let t = 0; t < ms; t += PASSO) {
    r.d.step(PASSO);
    controlla(r);
    onStep?.();
  }
};

// Fino a quando il regista non ha più niente in corso; restituisce i ms.
const finoAFermo = (r: Regia, onStep?: () => void, maxMs = 120_000): number => {
  let t = 0;
  while (r.d.isAnimating()) {
    if (t > maxMs) throw new Error('il regista non si ferma');
    r.d.step(PASSO);
    t += PASSO;
    controlla(r);
    onStep?.();
  }
  return t;
};

// Fino a uno stato dell'hostess (o oltre il tetto).
const finoA = (r: Regia, roomId: number, state: string, onStep?: () => void, maxMs = 60_000): number => {
  let t = 0;
  while (r.d.inspect(roomId)!.hostess.state !== state) {
    if (t > maxMs) throw new Error(`l'hostess non arriva a ${state}`);
    r.d.step(PASSO);
    t += PASSO;
    controlla(r);
    onStep?.();
  }
  return t;
};

const fermo = (r: Regia) => {
  for (const room of r.model!.rooms) {
    expect(chiavi(r.d.actorsIn(room.id)).filter(k => !k.startsWith('waiter:'))).toEqual([`host:${room.id}`]);
    expect([...r.d.movingKeys(room.id)]).toEqual([`host:${room.id}`]);
    expect(r.d.inspect(room.id)!.hostess.state).toBe('AT_STAND');
    expect(r.d.escortTargets(room.id).size).toBe(0);
    // Nessun anello rimasto acceso, nemmeno quello di un cambio di tavolo.
    expect(r.d.arrivalTargets(room.id).size).toBe(0);
    expect(r.d.inspect(room.id)!.moves.size).toBe(0);
  }
  expect(r.d.isAnimating()).toBe(false);
};

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);

describe('le costanti', () => {
  it('i numeri del regista e le condizioni di partenza', () => {
    expect(DIRECTOR_TUNING.guestSpeed).toBe(1.1);
    expect(DIRECTOR_TUNING.bulkK).toBe(4);
    expect(DIRECTOR_TUNING.escortMaxParty).toBe(12);
    expect(DIRECTOR_TUNING.walkingWaitersMax).toBe(8);
    // Un ciclo del passo (due passi) con le gambe a ±28°: 1,6 m senza
    // scivolare; 1,4 lascia un niente di scivolata e un passo più vivace.
    expect(DIRECTOR_TUNING.strideAdult).toBe(1.4);
    expect(DIRECTOR_TUNING.strideKid).toBe(0.9);
    expect(DIRECTOR_DEFAULTS).toEqual({
      reducedMotion: false,
      slowMode: false,
      lightMode: false,
      pinned: false,
      activeRoomId: null,
      staff: undefined,
    });
    expect(DIRECTOR_SEED).toBe(0x53414c41);
  });

  it('withArrivalTargets: la stessa sala senza bersagli, «in arrivo» con l\'anello sui bersagli', () => {
    const model = scena([]);
    const room = stanza(model, 1);
    expect(withArrivalTargets(room, new Set())).toBe(room);
    expect(withArrivalTargets(room, new Set([99]))).toBe(room);
    const out = withArrivalTargets(room, new Set([2]));
    expect(out).not.toBe(room);
    expect(out.tables.find(t => t.id === 2)).toMatchObject({ status: 'inarrivo', pulse: true });
    expect(out.tables.find(t => t.id === 1)).toBe(room.tables.find(t => t.id === 1));
  });
});

describe('il primo update', () => {
  it('scatta: chi è seduto è già seduto, nessun evento, nessuno in scena oltre l\'hostess', () => {
    const r = regista();
    const seduti = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 2, notes: 'Cane' });
    const ingresso = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: undefined, guests: 2, reservation_time: ora('18:40') });
    aggiorna(r, scena([seduti, ingresso]), 'initial');
    expect(r.events).toEqual([]);
    fermo(r);
    expect(r.d.frameNeed()).toBe('none');
    // L'hostess sta sulla sua figura statica.
    const host = stanza(r.model!, 1).figures.find(f => f.key === 'host:1')!;
    const v = r.d.actorsIn(1)[0];
    expect([v.x, v.z, v.yaw, v.kind]).toEqual([host.x, host.z, host.yaw, 'hostess']);
    avanza(r, 1000);
    expect(r.events).toEqual([]);
  });
});

describe('l\'accompagnamento dalla porta', () => {
  it('in attesa → arrivata: l\'hostess va alla porta, accoglie, accompagna, presenta; tutti seduti esatti', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1, guests: 4, children: 2, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([arrivata(fam)]);
    aggiorna(r, model);
    expect(tipi(r.events)).toEqual(['escort-start']);
    expect(r.events[0]).toMatchObject({ kind: 'escort-start', roomId: 1, from: 'entrance', table: { id: 1, name: '1' } });
    expect(r.events[0]).toMatchObject({ party: { id: fam.id, name: null, adults: 2, kids: 2, dogs: 1 } });
    // In coda: nessuno si vede ancora, né al tavolo né alla porta.
    expect([...r.d.escortTargets(1)]).toEqual([1]);
    expect(chiavi(r.d.actorsIn(1))).toEqual(['host:1']);
    expect(r.d.movingKeys(1).size).toBe(6);
    expect(r.d.isAnimating()).toBe(true);
    expect(r.d.frameNeed()).toBe('active');

    const o = osserva(r);
    r.d.step(PASSO);
    controlla(r);
    o.sample();
    // Il percorso dell'hostess parte dal suo posto all'accoglienza.
    const ins = r.d.inspect(1)!;
    const host = stanza(model, 1).figures.find(f => f.key === 'host:1')!;
    expect(ins.hostess.state).toBe('TO_ENTRANCE');
    expect(ins.hostess.partyId).toBe(fam.id);
    expect(ins.current).toBe(fam.id);
    expect(ins.hostess.path![0]).toEqual({ x: host.x, z: host.z });
    const a = ancore(model, 1);
    // Accoglie SULLA strada della fila, 60 cm oltre `inside`: la fila non
    // devia verso di lei per poi tornare indietro (il tornante sulla soglia).
    const greet = ins.hostess.greet!;
    expect(ins.hostess.path![ins.hostess.path!.length - 1]).toEqual(greet);
    expect(dist(greet, a.inside)).toBeLessThanOrEqual(0.6 + 1e-9);
    expect(dist(greet, a.inside)).toBeGreaterThan(0.3);

    let tags = 0;
    let tagAfterPresent = 0;
    let fading = 0;
    let t = 0;
    let presentAt = -1;
    let lastTag: { x: number; z: number; alpha: number } | null = null;
    let raised = 0;
    let checkedHome = false;
    const states: string[] = [];
    finoAFermo(r, () => {
      t += PASSO;
      o.sample();
      const st = r.d.inspect(1)!.hostess.state;
      if (states[states.length - 1] !== st) states.push(st);
      if (st === 'PRESENT' && presentAt < 0) presentAt = t;
      const views = r.d.actorsIn(1);
      const host = views[0];
      // Il braccio dell'accoglienza indica la strada, non la testa di chi
      // arriva: la mano (mezzo metro davanti) lontana da tutti.
      if (st === 'GREET' && host.arm > 0.3) {
        raised++;
        const hand = { x: host.x + Math.sin(host.yaw) * 0.5, z: host.z + Math.cos(host.yaw) * 0.5 };
        for (const v of views) if (v.partyId === fam.id && v.fade > 0.5) expect(dist(hand, v), `${v.key} sotto il braccio`).toBeGreaterThan(0.45);
      }
      // Tornando al leggio, chi ha presentato è già ai posti: seduto, o al
      // suo punto d'approccio.
      if (st === 'RETURN' && !checkedHome) {
        checkedHome = true;
        for (const v of views) {
          if (v.partyId !== fam.id) continue;
          const fig = figure(model, 1, fam.id).find(f => f.key === v.key)!;
          expect(v.seat > 0 || dist(v, fig) <= 0.56, `${v.key} ancora per strada`).toBe(true);
        }
      }
      const tag = r.d.tagIn(1);
      if (tag) {
        tags++;
        expect(tag.partyId).toBe(fam.id);
        expect(tag.y).toBeCloseTo(2.05);
        if (st === 'PRESENT') {
          // A PRESENT svanisce in 400 ms, ferma dov'era (il nome
          // dell'hostess torna intanto, nella scena).
          expect(t - presentAt).toBeLessThanOrEqual(400 + PASSO);
          if (fading > 0 && lastTag) {
            expect([tag.x, tag.z]).toEqual([lastTag.x, lastTag.z]);
            expect(tag.alpha).toBeLessThan(lastTag.alpha);
          }
          fading++;
        }
        if (st === 'RETURN' || st === 'AT_STAND') tagAfterPresent++;
        lastTag = { x: tag.x, z: tag.z, alpha: tag.alpha };
      }
      // L'anello resta finché l'ultimo non si siede.
      if (r.events.length === 1) expect([...r.d.escortTargets(1)]).toEqual([1]);
    });
    expect(states).toEqual(['TO_ENTRANCE', 'GREET', 'ESCORT', 'PRESENT', 'RETURN', 'AT_STAND']);
    expect(tags).toBeGreaterThan(0);
    expect(fading).toBeGreaterThan(3);
    expect(tagAfterPresent).toBe(0);
    expect(raised).toBeGreaterThan(3);
    expect(checkedHome).toBe(true);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    expect(r.events[1]).toMatchObject({ kind: 'escort-end', roomId: 1, partyId: fam.id, tableId: 1, seated: true });
    // Tutti sono comparsi sulla soglia, e tutti sono tornati a People esatti.
    for (const f of figure(model, 1, fam.id)) {
      const first = o.firstSeen.get(f.key)!;
      expect(first, f.key).toBeTruthy();
      // Il cane entra accanto al padrone, 45 cm di lato.
      const side = f.kind === 'dog' ? DIRECTOR_TUNING.dogBeside : 0;
      expect(dist(first, a.door), `${f.key} compare alla porta`).toBeLessThanOrEqual(Math.hypot(DOOR_OUTSIDE, side) + 0.06);
    }
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('il cane cammina accanto al padrone e alla fine si sdraia', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 2, guests: 2, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    let beside = 0;
    finoA(r, 1, 'ESCORT');
    finoA(r, 1, 'PRESENT', () => {
      const views = r.d.actorsIn(1);
      const owner = views.find(v => v.key === `r${fam.id}:a0`);
      const dog = views.find(v => v.key === `r${fam.id}:d0`);
      if (owner && dog && owner.fade === 1 && dog.fade === 1 && dist(owner, dog) < 0.7) beside++;
      if (dog) expect(dog.kind).toBe('dog');
    });
    expect(beside).toBeGreaterThan(20);
    finoAFermo(r);
    fermo(r);
  });
});

describe('dall\'ingresso', () => {
  it('ingresso → tavolo nella stessa sala: l\'hostess va da loro e la fila parte da lì', () => {
    const r = regista();
    const fam = prenotazione({ table_id: undefined, guests: 3, reservation_time: ora('18:40'), arrival_status: ArrivalStatus.ARRIVED });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const lobby = figure(m0, 1, fam.id);
    expect(lobby.length).toBe(3);
    expect(lobby.every(f => f.pose === 'standing' && f.tableId === null)).toBe(true);
    const model = scena([con(fam, { table_id: 6 })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'escort-start', roomId: 1, from: 'lobby', table: { id: 6 } }]);
    // In coda li disegna il regista, dove aspettavano.
    const o = osserva(r);
    for (const f of lobby) {
      const v = r.d.actorsIn(1).find(x => x.key === f.key)!;
      expect([v.x, v.z, v.fade]).toEqual([f.x, f.z, 1]);
    }
    r.d.step(PASSO);
    expect(r.d.inspect(1)!.hostess.state).toBe('TO_LOBBY');
    finoAFermo(r, o.sample);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('ingresso → tavolo in un\'altra sala: svaniscono all\'ingresso e rientrano dalla porta di quella', () => {
    const r = regista();
    const fam = prenotazione({ table_id: undefined, guests: 2, reservation_time: ora('18:40'), arrival_status: ArrivalStatus.ARRIVED });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const lobby = figure(m0, 1, fam.id);
    const model = scena([con(fam, { table_id: 4 })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'escort-start', roomId: 2, from: 'lobby', table: { id: 4 } }]);
    const o = osserva(r);
    // Prima svaniscono all'ingresso della Veranda, dove erano.
    avanza(r, 200, o.sample);
    for (const f of lobby) {
      const v = r.d.actorsIn(1).find(x => x.key === f.key)!;
      expect(v.fade).toBeLessThan(1);
      expect([v.x, v.z]).toEqual([f.x, f.z]);
    }
    // La chiave è già delle figure del Fiume; nella Veranda il regista la
    // tiene lo stesso finché svanisce lì: un People con la lista vecchia
    // non la ridisegna ferma all'ingresso.
    expect(r.d.movingKeys(1).has(lobby[0].key)).toBe(true);
    expect(r.d.movingKeys(2).has(lobby[0].key)).toBe(true);
    // Poi compaiono alla porta del Fiume.
    const door2 = ancore(model, 2).door;
    const inFiume = new Map<string, { x: number; z: number }>();
    finoAFermo(r, () => {
      o.sample();
      for (const v of r.d.actorsIn(2)) {
        if (v.partyId === fam.id && v.fade > 0 && !inFiume.has(v.key)) inFiume.set(v.key, { x: v.x, z: v.z });
      }
    });
    expect([...inFiume.keys()].sort()).toEqual(figure(model, 2, fam.id).map(f => f.key).sort());
    for (const [key, at] of inFiume) expect(dist(at, door2), key).toBeLessThanOrEqual(DOOR_OUTSIDE + 0.06);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    expect(r.events[1]).toMatchObject({ roomId: 2, tableId: 4, seated: true });
    expect(o.released.sort()).toEqual(figure(model, 2, fam.id).map(f => f.key).sort());
    fermo(r);
  });
});

describe('cambi di posto', () => {
  const seduti = (table: number, over: Partial<Reservation> = {}) =>
    prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: table, reservation_time: ora('18:30'), ...over });

  it('RESEAT: si alzano, camminano al tavolo nuovo e si siedono; l\'hostess resta al leggio', () => {
    const r = regista();
    const fam = seduti(1, { guests: 3, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { table_id: 7 })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'moved', roomId: 1, from: { id: 1, name: '1' }, to: { id: 7, name: '7' } }]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('RESEAT');
    const o = osserva(r);
    // Al primo passo sono ancora seduti al tavolo 1, e cominciano ad alzarsi.
    const v0 = r.d.actorsIn(1).find(v => v.key === `r${fam.id}:a0`)!;
    expect(v0.seat).toBe(1);
    finoAFermo(r, () => {
      o.sample();
      expect(r.d.inspect(1)!.hostess.state).toBe('AT_STAND');
    });
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    // La fine del cambio: il tavolo nuovo smette di essere «in arrivo».
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    fermo(r);
  });

  it('un cambio di sala: svaniscono al tavolo vecchio ed entrano dalla porta della sala nuova', () => {
    const r = regista();
    const fam = seduti(2, { guests: 2 });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const model = scena([con(fam, { table_id: 4 })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'moved', roomId: 2, from: { id: 2 }, to: { id: 4 } }]);
    const o = osserva(r);
    const door2 = ancore(model, 2).door;
    let seenIn2 = 0;
    finoAFermo(r, () => {
      o.sample();
      for (const v of r.d.actorsIn(2)) {
        if (v.partyId !== fam.id || v.fade === 0 || seenIn2 > 0) continue;
        seenIn2++;
        expect(dist(v, door2)).toBeLessThanOrEqual(DOOR_OUTSIDE + 0.06);
      }
    });
    expect(seenIn2).toBe(1);
    expect(o.released.sort()).toEqual(figure(model, 2, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('STAND e SIT: «In uscita» si alzano dietro le sedie, e si risiedono', () => {
    const r = regista();
    const fam = seduti(3, { guests: 2, notes: 'Cane' });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const uscita = scena([con(fam, { arrival_status: ArrivalStatus.DEPARTING })]);
    aggiorna(r, uscita);
    expect(r.events).toEqual([]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('STAND');
    const o = osserva(r);
    const t = finoAFermo(r, o.sample);
    // Alzarsi e il passo indietro, non un giro della sala.
    expect(t).toBeLessThan(2500);
    expect(o.released.sort()).toEqual(figure(uscita, 1, fam.id).map(f => f.key).sort());
    for (const f of figure(uscita, 1, fam.id)) expect(f.pose).toBe('standing');
    fermo(r);

    const back = scena([fam]);
    aggiorna(r, back);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('SIT');
    const o2 = osserva(r);
    finoAFermo(r, o2.sample);
    expect(o2.released.sort()).toEqual(figure(back, 1, fam.id).map(f => f.key).sort());
    expect(r.events).toEqual([]);
    fermo(r);
  });

  it('LEAVE: «Tavolo liberato» → si alzano, vanno alla porta e svaniscono uscendo', () => {
    const r = regista();
    const fam = seduti(5, { guests: 3, notes: 'Cane' });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const model = scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'leaving', roomId: 1, party: { id: fam.id }, table: { id: 5, name: '5' } }]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('LEAVE');
    const door = ancore(model, 1).door;
    const last = new Map<string, { x: number; z: number; fade: number }>();
    finoAFermo(r, () => {
      for (const v of r.d.actorsIn(1)) if (v.partyId === fam.id) last.set(v.key, { x: v.x, z: v.z, fade: v.fade });
    });
    expect(last.size).toBe(4);
    for (const [key, v] of last) {
      // L'ultima volta che si vedono stanno uscendo dalla porta, quasi
      // svaniti; il cane accanto al padrone.
      const side = key.includes(':d') ? DIRECTOR_TUNING.dogBeside : 0;
      expect(dist(v, door), key).toBeLessThanOrEqual(Math.hypot(DOOR_OUTSIDE + 0.1, side));
      expect(v.fade, key).toBeLessThan(0.2);
    }
    fermo(r);
  });

  it('FADE: un «Arrivato» annullato svanisce sul posto', () => {
    const r = regista();
    const fam = seduti(6, { guests: 2 });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    const where = figure(m0, 1, fam.id);
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.WAITING })]));
    expect(r.events).toEqual([]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('FADE');
    avanza(r, 200);
    for (const f of where) {
      const v = r.d.actorsIn(1).find(x => x.key === f.key)!;
      expect([v.x, v.z, v.seat]).toEqual([f.x, f.z, 1]);
      expect(v.fade).toBeGreaterThan(0);
      expect(v.fade).toBeLessThan(1);
    }
    expect(finoAFermo(r)).toBeLessThan(DIRECTOR_TUNING.fadeMs);
    fermo(r);
  });
});

describe('il tavolo nuovo di un cambio di tavolo resta «in arrivo»', () => {
  /* Reception sposta una tavolata già seduta: in sala la famiglia si alza dal
   * tavolo vecchio e cammina al nuovo, e il nuovo pulsa «in arrivo» finché
   * l'ultimo non si siede, come quello di un accompagnamento; poi prende il
   * colore del modello. Prima diventava «arrivato» subito, mentre la famiglia
   * si alzava ancora dall'altro. Che ogni anello si accenda e si spenga con
   * il suo evento, una volta, lo controlla controllaAnelli a ogni passo. */
  const seduti = (table: number, over: Partial<Reservation> = {}) =>
    prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: table, reservation_time: ora('18:30'), ...over });
  // Quanti della comitiva il regista tiene ancora (in cammino, mentre
  // svaniscono, dietro la porta): zero quando l'ultimo è tornato a People.
  const inScena = (r: Regia, roomId: number, keys: readonly string[]) => keys.filter(k => r.d.movingKeys(roomId).has(k)).length;

  it('stessa sala: pulsa dal cambio finché l\'ultimo (il cane compreso) non si siede, poi torna «arrivato»; il vecchio mai', () => {
    const r = regista();
    const fam = seduti(1, { guests: 3, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { table_id: 7 })]);
    aggiorna(r, model);
    // Nello stesso update del 'moved', prima di ogni passo: la pagina
    // ridisegna i tavoli a quell'evento.
    expect(tipi(r.events)).toEqual(['moved']);
    expect([...r.d.arrivalTargets(1)]).toEqual([7]);
    expect(r.d.inspect(1)!.moves).toEqual(new Map([[fam.id, 7]]));
    // Non è un accompagnamento: «Segui il servizio» non ci aspetta sopra.
    expect(r.d.escortTargets(1).size).toBe(0);
    // Il modello lo dà già «arrivato»; la sala disegnata lo tiene «in
    // arrivo» con l'anello, il resto com'è.
    const room = stanza(model, 1);
    expect(room.tables.find(t => t.id === 7)!.status).toBe('arrivato');
    const shown = withArrivalTargets(room, r.d.arrivalTargets(1));
    expect(shown.tables.find(t => t.id === 7)).toMatchObject({ status: 'inarrivo', pulse: true });
    expect(shown.tables.find(t => t.id === 1)).toBe(room.tables.find(t => t.id === 1));
    const keys = figure(model, 1, fam.id).map(f => f.key);
    expect(keys.length).toBe(4);
    let acceso = 0;
    let unoSolo = 0;
    finoAFermo(r, () => {
      const n = inScena(r, 1, keys);
      const on = r.d.arrivalTargets(1).has(7);
      // Acceso finché ne resta anche uno, spento nel passo in cui l'ultimo
      // torna a People: lì People lo disegna seduto, e il tavolo «arrivato».
      if (on !== n > 0) expect.fail(`anello ${on ? 'acceso' : 'spento'} con ${n} ancora in scena`);
      if (on) acceso++;
      if (n === 1) unoSolo++;
      expect(r.d.arrivalTargets(1).has(1)).toBe(false);
      expect(r.d.inspect(1)!.hostess.state).toBe('AT_STAND');
    });
    expect(acceso).toBeGreaterThan(50);
    // Anche con uno solo ancora da sedere, l'anello c'era: l'ultimo, non il
    // primo.
    expect(unoSolo).toBeGreaterThan(0);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    expect(r.events[1]).toMatchObject({ kind: 'moved-end', roomId: 1, partyId: fam.id, tableId: 7, seated: true });
    // Finito, la sala disegnata è quella del modello, lo stesso oggetto.
    expect(withArrivalTargets(room, r.d.arrivalTargets(1))).toBe(room);
    fermo(r);
  });

  it('in un\'altra sala pulsa nella sua: mentre svaniscono qui, entrano dalla porta di là e si siedono', () => {
    const r = regista();
    const fam = seduti(2, { guests: 2, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { table_id: 4 })]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'moved', roomId: 2, from: { id: 2 }, to: { id: 4 } }]);
    expect([...r.d.arrivalTargets(2)]).toEqual([4]);
    expect(r.d.arrivalTargets(1).size).toBe(0);
    const keys = figure(model, 2, fam.id).map(f => f.key);
    let svaniscono = 0;
    let entrano = 0;
    finoAFermo(r, () => {
      const n = inScena(r, 2, keys);
      const on = r.d.arrivalTargets(2).has(4);
      if (on !== n > 0) expect.fail(`anello ${on ? 'acceso' : 'spento'} con ${n} ancora in scena`);
      expect(r.d.arrivalTargets(1).size).toBe(0);
      if (on && r.d.actorsIn(1).some(v => v.partyId === fam.id)) svaniscono++;
      if (on && r.d.actorsIn(2).some(v => v.partyId === fam.id)) entrano++;
    });
    expect(svaniscono).toBeGreaterThan(0);
    expect(entrano).toBeGreaterThan(0);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    expect(r.events[1]).toMatchObject({ kind: 'moved-end', roomId: 2, partyId: fam.id, tableId: 4, seated: true });
    fermo(r);
  });

  it('annullato a metà strada («Arrivato» tolto): l\'anello si spegne subito, non arrivato, e svaniscono dove sono', () => {
    const r = regista();
    const fam = seduti(1, { guests: 3 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    avanza(r, 2500);
    expect([...r.d.arrivalTargets(1)]).toEqual([7]);
    aggiorna(r, scena([con(fam, { table_id: 7, arrival_status: ArrivalStatus.WAITING })]), null, 500);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    expect(r.events[1]).toMatchObject({ kind: 'moved-end', roomId: 1, partyId: fam.id, tableId: 7, seated: false });
    expect(r.d.arrivalTargets(1).size).toBe(0);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('FADE');
    finoAFermo(r);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    fermo(r);
  });

  it('rimandata al tavolo di prima a metà strada: il nuovo si spegne, pulsa il vecchio finché non si risiedono', () => {
    const r = regista();
    const fam = seduti(1, { guests: 2 });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    avanza(r, 2000);
    aggiorna(r, scena([fam]), null, 500);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end', 'moved']);
    expect(r.events[1]).toMatchObject({ tableId: 7, seated: false });
    expect(r.events[2]).toMatchObject({ kind: 'moved', from: { id: 7 }, to: { id: 1 } });
    expect([...r.d.arrivalTargets(1)]).toEqual([1]);
    const o = osserva(r);
    finoAFermo(r, () => {
      o.sample();
      expect(r.d.arrivalTargets(1).has(7)).toBe(false);
    });
    expect(o.released.sort()).toEqual(figure(m0, 1, fam.id).map(f => f.key).sort());
    expect(tipi(r.events)).toEqual(['moved', 'moved-end', 'moved', 'moved-end']);
    expect(r.events[3]).toMatchObject({ tableId: 1, seated: true });
    fermo(r);
  });

  it('spostata ancora a metà strada: l\'anello passa al terzo tavolo, il secondo si spegne subito', () => {
    const r = regista();
    const fam = seduti(1, { guests: 3, notes: 'Cane' });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    avanza(r, 2500);
    const model = scena([con(fam, { table_id: 9 })]);
    aggiorna(r, model, null, 500);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end', 'moved']);
    expect(r.events[1]).toMatchObject({ tableId: 7, seated: false });
    expect([...r.d.arrivalTargets(1)]).toEqual([9]);
    const o = osserva(r);
    finoAFermo(r, () => {
      o.sample();
      expect(r.d.arrivalTargets(1).has(7)).toBe(false);
    });
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    expect(tipi(r.events)).toEqual(['moved', 'moved-end', 'moved', 'moved-end']);
    expect(r.events[3]).toMatchObject({ tableId: 9, seated: true });
    fermo(r);
  });

  it('«In uscita» mentre ci cammina: ci sta ancora arrivando, l\'anello resta finché non sono ai posti in piedi', () => {
    const r = regista();
    const fam = seduti(1, { guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    avanza(r, 1500);
    const model = scena([con(fam, { table_id: 7, arrival_status: ArrivalStatus.DEPARTING })]);
    aggiorna(r, model, null, 500);
    expect(tipi(r.events)).toEqual(['moved']);
    expect([...r.d.arrivalTargets(1)]).toEqual([7]);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    for (const f of figure(model, 1, fam.id)) expect(f.pose).toBe('standing');
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    expect(r.events[1]).toMatchObject({ tableId: 7, seated: true });
    fermo(r);
  });

  it('scattato (epoca nuova, scheda nascosta, movimento ridotto, cambi in blocco): l\'anello non si accende mai', () => {
    for (const reason of ['refetch', 'hidden', 'reduced-motion'] as const) {
      const r = regista();
      if (reason === 'reduced-motion') r.d.configure({ reducedMotion: true });
      const fam = seduti(1, { guests: 2 });
      aggiorna(r, scena([fam]), 'initial');
      aggiorna(r, scena([con(fam, { table_id: 7 })]), reason);
      // Col movimento ridotto il cambio si racconta lo stesso; gli altri
      // scatti lo contano fra i tavoli aggiornati. Nessun 'moved-end':
      // nessun anello da spegnere.
      expect(tipi(r.events), reason).toEqual(reason === 'reduced-motion' ? ['moved'] : ['bulk']);
      fermo(r);
    }
    // Più di 4 passaggi in un update: tutti già conclusi.
    const r = regista();
    const quattro = [1, 2, 3, 5].map(t => seduti(t, { guests: 2 }));
    const via = seduti(6, { guests: 2 });
    aggiorna(r, scena([...quattro, via]), 'initial');
    const altrove = [7, 8, 9, 4];
    aggiorna(r, scena([...quattro.map((x, i) => con(x, { table_id: altrove[i] })), con(via, { arrival_status: ArrivalStatus.DEPARTED })]));
    expect(tipi(r.events)).toEqual(['bulk']);
    fermo(r);
  });

  it('a metà strada: uno scatto, fastForward o il movimento ridotto spengono l\'anello col loro \'moved-end\'', () => {
    const prova = (fine: (r: Regia, fam: Reservation) => void) => {
      const r = regista();
      const fam = seduti(1, { guests: 3, notes: 'Cane' });
      aggiorna(r, scena([fam]), 'initial');
      aggiorna(r, scena([con(fam, { table_id: 7 })]));
      avanza(r, 2000);
      expect([...r.d.arrivalTargets(1)]).toEqual([7]);
      fine(r, fam);
      fermo(r);
      return r.events.slice(1);
    };
    // A scheda nascosta un altro tavolo: il cambio a metà non arriva, il
    // nuovo è già concluso.
    expect(prova((r, fam) => aggiorna(r, scena([con(fam, { table_id: 9 })]), 'hidden', 500)))
      .toMatchObject([{ kind: 'moved-end', tableId: 7, seated: false }, { kind: 'bulk', count: 2 }]);
    // Un'epoca nuova che la trova «In uscita» proprio lì: ci è arrivata.
    expect(prova((r, fam) => aggiorna(r, scena([con(fam, { table_id: 7, arrival_status: ArrivalStatus.DEPARTING })]), 'refetch', 500)))
      .toMatchObject([{ kind: 'moved-end', tableId: 7, seated: true }, { kind: 'bulk', count: 1 }]);
    // La scheda di nuovo visibile, o la vista 3D che sparisce: fastForward.
    expect(prova(r => {
      r.d.fastForward();
      controlla(r);
    })).toMatchObject([{ kind: 'moved-end', roomId: 1, tableId: 7, seated: true }]);
    // Il movimento ridotto acceso a metà: tutto in fondo, nessun anello.
    expect(prova(r => {
      r.d.configure({ reducedMotion: true });
      controlla(r);
    })).toMatchObject([{ kind: 'moved-end', roomId: 1, tableId: 7, seated: true }]);
  });

  it('oltre 12 persone o di un banchetto: compaiono già sedute al tavolo nuovo, e nessun anello', () => {
    const r = regista();
    const grande = seduti(6, { guests: 14 });
    const evento = seduti(8, { guests: 3, banquet_menu_id: 7 });
    aggiorna(r, scena([grande, evento]), 'initial');
    aggiorna(r, scena([con(grande, { table_id: 7 }), con(evento, { table_id: 9 })]));
    expect(tipi(r.events)).toEqual(['moved', 'moved']);
    expect(r.d.inspect(1)!.scripts.get(grande.id)).toBe('LARGE');
    expect(r.d.inspect(1)!.scripts.get(evento.id)).toBe('LARGE');
    expect(r.d.arrivalTargets(1).size).toBe(0);
    finoAFermo(r, () => expect(r.d.arrivalTargets(1).size).toBe(0));
    expect(tipi(r.events)).toEqual(['moved', 'moved']);
    fermo(r);
    // A metà di un cambio a piedi la comitiva cresce oltre 12 e cambia ancora
    // tavolo: quello a metà si spegne, il nuovo non si accende.
    const r2 = regista();
    const fam = seduti(1, { guests: 3 });
    aggiorna(r2, scena([fam]), 'initial');
    aggiorna(r2, scena([con(fam, { table_id: 7 })]));
    avanza(r2, 1500);
    aggiorna(r2, scena([con(fam, { table_id: 9, guests: 14 })]), null, 500);
    expect(tipi(r2.events)).toEqual(['moved', 'moved-end', 'moved']);
    expect(r2.events[1]).toMatchObject({ tableId: 7, seated: false });
    expect(r2.d.inspect(1)!.scripts.get(fam.id)).toBe('LARGE');
    expect(r2.d.arrivalTargets(1).size).toBe(0);
    finoAFermo(r2, () => expect(r2.d.arrivalTargets(1).size).toBe(0));
    expect(tipi(r2.events)).toEqual(['moved', 'moved-end', 'moved']);
    fermo(r2);
  });

  // Fino a fermo: il tavolo nuovo acceso finché ne resta in scena anche uno,
  // spento nel passo in cui l'ultimo torna a People. Restituisce i passi con
  // l'anello acceso.
  const anelloFinoAllUltimo = (r: Regia, roomId: number, tableId: number, keys: readonly string[], onStep?: () => void) => {
    let acceso = 0;
    finoAFermo(r, () => {
      onStep?.();
      const n = inScena(r, roomId, keys);
      const on = r.d.arrivalTargets(roomId).has(tableId);
      if (on !== n > 0) expect.fail(`anello ${on ? 'acceso' : 'spento'} con ${n} ancora in scena`);
      if (on) acceso++;
    });
    return acceso;
  };

  it('spodestata, e rimessa da Reception a un altro tavolo mentre esce: ci torna a piedi, e il tavolo nuovo pulsa finché non si siede', () => {
    /* Una coppia più recente arriva al 7 dove la famiglia è seduta: la
     * famiglia esce (è spodestata, Reception l'ha ancora al 7). Reception se
     * ne accorge e la sposta al 9 mentre cammina verso la porta: in sala si
     * gira e va al 9 a piedi. È un cambio di tavolo come gli altri: prima ci
     * camminava senza anello, verso un tavolo già «arrivato», e la striscia
     * diceva solo l'uscita. */
    const r = regista();
    const fam = seduti(7, { guests: 2, notes: 'Cane' });
    const coppia = prenotazione({ table_id: 7, guests: 2, reservation_time: ora('18:50') });
    aggiorna(r, scena([fam, coppia]), 'initial');
    aggiorna(r, scena([fam, arrivata(coppia)]));
    expect(tipi(r.events)).toEqual(['leaving', 'escort-start']);
    avanza(r, 1300);
    expect(r.d.actorsIn(1).some(v => v.partyId === fam.id)).toBe(true);
    const model = scena([con(fam, { table_id: 9 }), arrivata(coppia)]);
    aggiorna(r, model, null, 500);
    expect(r.events.slice(2)).toMatchObject([{ kind: 'moved', roomId: 1, party: { id: fam.id }, from: { id: 7 }, to: { id: 9 } }]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('RESEAT');
    expect(r.d.inspect(1)!.moves).toEqual(new Map([[fam.id, 9]]));
    // Il 7 resta «in arrivo» per la coppia (l'accompagnamento), il 9 per la
    // famiglia; «Segui il servizio» guarda solo il 7.
    expect([...r.d.arrivalTargets(1)].sort()).toEqual([7, 9]);
    expect([...r.d.escortTargets(1)]).toEqual([7]);
    const keys = figure(model, 1, fam.id).map(f => f.key);
    const o = osserva(r);
    expect(anelloFinoAllUltimo(r, 1, 9, keys, o.sample)).toBeGreaterThan(50);
    // Tornati a People esatti, al 9.
    expect(o.released.filter(k => keys.includes(k)).sort()).toEqual([...keys].sort());
    expect(r.events.filter(e => e.kind === 'moved-end')).toMatchObject([{ roomId: 1, partyId: fam.id, tableId: 9, seated: true }]);
    expect(r.events.filter(e => e.kind === 'escort-end')).toMatchObject([{ partyId: coppia.id, tableId: 7, seated: true }]);
    fermo(r);
  });

  it('«Tavolo liberato» tolto a metà uscita, ma su un altro tavolo: ci tornano a piedi ed è un cambio di tavolo; allo stesso tavolo no', () => {
    const r = regista();
    const fam = seduti(1, { guests: 3 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]));
    avanza(r, 1200);
    const model = scena([con(fam, { table_id: 9 })]);
    aggiorna(r, model, null, 500);
    expect(tipi(r.events)).toEqual(['leaving', 'moved']);
    expect(r.events[1]).toMatchObject({ from: { id: 1 }, to: { id: 9 } });
    expect([...r.d.arrivalTargets(1)]).toEqual([9]);
    expect(anelloFinoAllUltimo(r, 1, 9, figure(model, 1, fam.id).map(f => f.key))).toBeGreaterThan(50);
    expect(tipi(r.events)).toEqual(['leaving', 'moved', 'moved-end']);
    expect(r.events[2]).toMatchObject({ tableId: 9, seated: true });
    fermo(r);
    // Rimessa al tavolo che lasciava: torna al suo posto, senza evento né
    // anello (il caso di sempre, vedi più giù).
    const r2 = regista();
    const fam2 = seduti(1, { guests: 3 });
    aggiorna(r2, scena([fam2]), 'initial');
    aggiorna(r2, scena([con(fam2, { arrival_status: ArrivalStatus.DEPARTED })]));
    avanza(r2, 1200);
    aggiorna(r2, scena([fam2]), null, 500);
    expect(r2.d.inspect(1)!.scripts.get(fam2.id)).toBe('RESEAT');
    expect(r2.d.arrivalTargets(1).size).toBe(0);
    finoAFermo(r2, () => expect(r2.d.arrivalTargets(1).size).toBe(0));
    expect(tipi(r2.events)).toEqual(['leaving']);
    fermo(r2);
  });

  it('«Arrivato» tolto e rimesso su un altro tavolo mentre svaniscono: ci vanno a piedi dal tavolo dov\'erano', () => {
    const r = regista();
    const fam = seduti(2, { guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.WAITING })]));
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('FADE');
    avanza(r, 100);
    const model = scena([con(fam, { table_id: 8 })]);
    aggiorna(r, model, null, 100);
    expect(tipi(r.events)).toEqual(['moved']);
    expect(r.events[0]).toMatchObject({ roomId: 1, from: { id: 2 }, to: { id: 8 } });
    expect(anelloFinoAllUltimo(r, 1, 8, figure(model, 1, fam.id).map(f => f.key))).toBeGreaterThan(20);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    fermo(r);
    // Già svaniti del tutto: compaiono con l'hostess, come un arrivo. Il
    // tavolo lasciato non vale più (nessuno torna indietro da lì).
    const r2 = regista();
    const fam2 = seduti(2, { guests: 2 });
    aggiorna(r2, scena([fam2]), 'initial');
    aggiorna(r2, scena([con(fam2, { arrival_status: ArrivalStatus.WAITING })]));
    finoAFermo(r2);
    aggiorna(r2, scena([con(fam2, { table_id: 8 })]));
    expect(tipi(r2.events)).toEqual(['escort-start']);
    finoAFermo(r2);
    expect(tipi(r2.events)).toEqual(['escort-start', 'escort-end']);
    fermo(r2);
  });

  it('il tavolo lasciato vale solo per il passaggio dopo: chi torna dall\'ingresso non fa un cambio di tavolo', () => {
    /* Un'uscita annullata allo stesso tavolo, poi il tavolo nascosto per il
     * servizio (all'ingresso), poi «Arrivato» tolto e rimesso col 9 mentre
     * svaniscono all'ingresso: vengono dall'ingresso, non dal 6 che avevano
     * lasciato tre passaggi prima. Nessun 'moved', nessun anello: il caso di
     * sempre. */
    const r = regista();
    const fam = seduti(6, { guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]));
    avanza(r, 1000);
    aggiorna(r, scena([fam]), null, 500);
    finoAFermo(r);
    const nascosto = { hiddenTableIds: new Set([6]) };
    aggiorna(r, scena([fam], nascosto));
    finoAFermo(r);
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.WAITING })], nascosto));
    avanza(r, 100);
    aggiorna(r, scena([con(fam, { table_id: 9 })], nascosto), null, 100);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('RESEAT');
    expect(r.d.arrivalTargets(1).size).toBe(0);
    finoAFermo(r);
    expect(tipi(r.events)).toEqual(['leaving', 'lobby']);
    fermo(r);
  });

  it('la sala di partenza sparisce a metà dissolvenza: il cambio finisce nello stesso update, arrivato, e nessun anello resta', () => {
    /* La famiglia passa dal 4 (Fiume) al 7 (Veranda) e svanisce nel Fiume;
     * il Fiume esce dalla piantina prima che entri dalla porta della Veranda.
     * Nessuno è più in scena, e People la disegna già al 7: il cambio finisce
     * nell'update stesso, che a scheda nascosta non ha fotogrammi dopo. */
    const r = regista();
    const fam = seduti(4, { guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    expect([...r.d.arrivalTargets(1)]).toEqual([7]);
    avanza(r, 100);
    expect(r.d.actorsIn(2).filter(v => v.partyId === fam.id).length).toBe(2);
    const soloVeranda = { rooms: [VERANDA], tables: TAVOLI.filter(t => t.room_id === 1), markers: SEGNAPOSTO.filter(m => m.room_id === 1) };
    aggiorna(r, scena([con(fam, { table_id: 7 })], soloVeranda), null, 500);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end']);
    expect(r.events[1]).toMatchObject({ kind: 'moved-end', roomId: 1, partyId: fam.id, tableId: 7, seated: true });
    expect(r.d.arrivalTargets(1).size).toBe(0);
    fermo(r);
  });

  it('la sala del tavolo nuovo sparisce a metà: il cambio finisce non arrivato, poi l\'ingresso; e nessun anello resta', () => {
    const r = regista();
    const fam = seduti(2, { guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 4 })]));
    expect([...r.d.arrivalTargets(2)]).toEqual([4]);
    avanza(r, 300);
    const soloVeranda = { rooms: [VERANDA], tables: TAVOLI.filter(t => t.room_id === 1), markers: SEGNAPOSTO.filter(m => m.room_id === 1) };
    // Il suo tavolo non si disegna più: aspetta all'ingresso della Veranda.
    aggiorna(r, scena([con(fam, { table_id: 4 })], soloVeranda), null, 500);
    expect(tipi(r.events)).toEqual(['moved', 'moved-end', 'lobby']);
    expect(r.events[1]).toMatchObject({ roomId: 2, tableId: 4, seated: false });
    expect(r.d.arrivalTargets(1).size).toBe(0);
    expect(r.d.arrivalTargets(2).size).toBe(0);
    finoAFermo(r);
    fermo(r);
    // Un modello che toglie la sala ma la lascia seduta là (la pagina non
    // lo dà: deriveSceneModel la manda all'ingresso, come sopra). Il regista
    // non ci conta: la sala che se ne va si porta via il suo anello, con
    // l'evento, e chi ci stava entrando dalla porta.
    const r2 = regista();
    const fam2 = seduti(2, { guests: 2 });
    aggiorna(r2, scena([fam2]), 'initial');
    const verso4 = scena([con(fam2, { table_id: 4 })]);
    aggiorna(r2, verso4);
    avanza(r2, 1500);
    expect(r2.d.inspect(2)!.scripts.get(fam2.id)).toBe('RESEAT');
    aggiorna(r2, { ...verso4, rooms: verso4.rooms.filter(rm => rm.id !== 2) }, null, 500);
    expect(tipi(r2.events)).toEqual(['moved', 'moved-end']);
    expect(r2.events[1]).toMatchObject({ roomId: 2, tableId: 4, seated: false });
    expect(r2.d.arrivalTargets(1).size).toBe(0);
    finoAFermo(r2);
    fermo(r2);
  });

  it('un cambio di servizio a metà strada azzera senza eventi: nessun anello resta, e la cena riparte pulita', () => {
    /* Alle 17:00 una famiglia del pranzo sta ancora andando al tavolo nuovo.
     * Il regista azzera senza raccontare niente (nessun 'moved-end': non è
     * finito, è un altro servizio); i tavoli «in arrivo» li ridisegna la
     * pagina dopo l'update (SalaVivoPage). */
    const r = regista();
    const pranzo = { service: liveService(new Date(Date.parse(ora('16:59')))), nowMs: Date.parse(ora('16:59')) };
    const tardi = seduti(1, { guests: 3, shift: Shift.LUNCH, reservation_time: ora('15:45') });
    aggiorna(r, scena([tardi], pranzo), 'initial');
    aggiorna(r, scena([con(tardi, { table_id: 7 })], pranzo));
    avanza(r, 1500);
    expect([...r.d.arrivalTargets(1)]).toEqual([7]);
    const cena = { service: liveService(new Date(Date.parse(ora('17:00')))), nowMs: Date.parse(ora('17:00')) };
    const fam = prenotazione({ table_id: 3, guests: 2, reservation_time: ora('19:30'), arrival_status: ArrivalStatus.ARRIVED });
    aggiorna(r, scena([con(tardi, { table_id: 7 }), fam], cena), null, 500);
    expect(tipi(r.events)).toEqual(['moved']);
    expect(r.d.arrivalTargets(1).size).toBe(0);
    expect(r.d.inspect(1)!.moves.size).toBe(0);
    fermo(r);
    // Un cambio di tavolo della cena si accende e si spegne col suo evento.
    const model = scena([con(tardi, { table_id: 7 }), con(fam, { table_id: 5 })], cena);
    aggiorna(r, model);
    expect(tipi(r.events)).toEqual(['moved', 'moved']);
    expect([...r.d.arrivalTargets(1)]).toEqual([5]);
    finoAFermo(r);
    expect(tipi(r.events)).toEqual(['moved', 'moved', 'moved-end']);
    expect(r.events[2]).toMatchObject({ partyId: fam.id, tableId: 5, seated: true });
    fermo(r);
  });
});

describe('mentre l\'hostess accompagna', () => {
  it('annullare «Arrivato» fa svanire i membri dove sono, e l\'hostess torna', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 3, guests: 3 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    finoA(r, 1, 'ESCORT');
    avanza(r, 1500);
    const at = new Map(r.d.actorsIn(1).filter(v => v.partyId === fam.id).map(v => [v.key, { x: v.x, z: v.z }]));
    expect(at.size).toBeGreaterThan(0);
    aggiorna(r, scena([fam]), null, 1000);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    expect(r.events[1]).toMatchObject({ kind: 'escort-end', partyId: fam.id, tableId: 3, seated: false });
    expect(r.d.escortTargets(1).size).toBe(0);
    expect(r.d.inspect(1)!.hostess.state).toBe('RETURN');
    avanza(r, 200);
    for (const v of r.d.actorsIn(1).filter(x => x.partyId === fam.id)) {
      const p = at.get(v.key)!;
      // Svaniscono, non camminano.
      expect(dist(v, p)).toBeLessThan(0.05);
      expect(v.fade).toBeLessThan(1);
    }
    finoAFermo(r);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    fermo(r);
  });

  it('RETARGET: un altro tavolo della stessa sala, il percorso riparte da dove è lei', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1, guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    finoA(r, 1, 'ESCORT');
    avanza(r, 1000);
    const h = r.d.inspect(1)!.hostess;
    const model = scena([arrivata(fam, { table_id: 9 })]);
    aggiorna(r, model, null, 1000);
    expect(tipi(r.events)).toEqual(['escort-start', 'moved']);
    expect(r.events[1]).toMatchObject({ kind: 'moved', roomId: 1, from: { id: 1 }, to: { id: 9 } });
    const after = r.d.inspect(1)!.hostess;
    expect(after.state).toBe('ESCORT');
    expect(after.path![0].x).toBeCloseTo(h.x, 9);
    expect(after.path![0].z).toBeCloseTo(h.z, 9);
    expect([...r.d.escortTargets(1)]).toEqual([9]);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    expect(tipi(r.events)).toEqual(['escort-start', 'moved', 'escort-end']);
    expect(r.events[2]).toMatchObject({ tableId: 9, seated: true });
    fermo(r);
  });

  it('una comitiva più recente sullo stesso tavolo: prima esce la vecchia, poi l\'hostess accompagna la nuova', () => {
    const r = regista();
    const vecchia = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 2, reservation_time: ora('17:45'), guests: 2 });
    const nuova = prenotazione({ table_id: 2, reservation_time: ora('18:50'), guests: 2 });
    const m0 = scena([vecchia, nuova]);
    aggiorna(r, m0, 'initial');
    const model = scena([vecchia, arrivata(nuova)]);
    expect(model.partyStates.find(s => s.id === vecchia.id)?.phase).toBe('hidden');
    aggiorna(r, model);
    // Prima chi esce, poi chi entra: tutti e due raccontati subito.
    expect(tipi(r.events)).toEqual(['leaving', 'escort-start']);
    // Il tavolo resta «in arrivo» mentre la vecchia esce, e l'hostess aspetta
    // al leggio: le due comitive non si incrociano nell'ingresso.
    expect([...r.d.escortTargets(1)]).toEqual([2]);
    let leaving = 0;
    let crossed = 0;
    let escorted = 0;
    finoAFermo(r, () => {
      const ins = r.d.inspect(1)!;
      if (ins.scripts.get(vecchia.id) === 'LEAVE') {
        leaving++;
        if (ins.hostess.state !== 'AT_STAND' || r.d.actorsIn(1).some(v => v.partyId === nuova.id)) crossed++;
      } else if (ins.hostess.state === 'ESCORT') {
        escorted++;
      }
    });
    expect(leaving).toBeGreaterThan(10);
    expect(crossed).toBe(0);
    expect(escorted).toBeGreaterThan(10);
    expect(tipi(r.events)).toEqual(['leaving', 'escort-start', 'escort-end']);
    fermo(r);
  });

  it('chi esce mentre l\'hostess accompagna aspetta in piedi che la fila arrivi al tavolo', () => {
    const r = regista();
    const fuori = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 6, reservation_time: ora('18:00'), guests: 2 });
    const fam = prenotazione({ table_id: 3, guests: 2 });
    aggiorna(r, scena([fuori, fam]), 'initial');
    const posti = figure(scena([fuori, fam]), 1, fuori.id);
    aggiorna(r, scena([fuori, arrivata(fam)]));
    finoA(r, 1, 'ESCORT');
    aggiorna(r, scena([con(fuori, { arrival_status: ArrivalStatus.DEPARTED }), arrivata(fam)]), null, 500);
    expect(tipi(r.events)).toEqual(['escort-start', 'leaving']);
    let waited = 0;
    finoAFermo(r, () => {
      const state = r.d.inspect(1)!.hostess.state;
      const fila = state === 'TO_ENTRANCE' || state === 'GREET' || state === 'ESCORT';
      if (!fila) return;
      for (const v of r.d.actorsIn(1)) {
        if (v.partyId !== fuori.id) continue;
        waited++;
        // Al più il passo indietro dalla sedia (0,55 m): nessuno va verso la porta.
        const near = Math.min(...posti.map(f => dist(v, f)));
        if (near > 0.6) expect.fail(`${v.key} esce mentre l'hostess accompagna (${near.toFixed(2)} m)`);
      }
    });
    expect(waited).toBeGreaterThan(10);
    expect(tipi(r.events)).toEqual(['escort-start', 'leaving', 'escort-end']);
    fermo(r);
  });

  it('nascosta → seduta (l\'arrivo della nuova annullato): la vecchia ricompare al suo posto, senza accompagnamento', () => {
    const r = regista();
    const vecchia = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 8, reservation_time: ora('17:45'), guests: 2 });
    const nuova = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 8, reservation_time: ora('18:50'), guests: 3 });
    aggiorna(r, scena([vecchia, nuova]), 'initial');
    const model = scena([vecchia, con(nuova, { arrival_status: ArrivalStatus.WAITING })]);
    expect(model.partyStates.find(s => s.id === vecchia.id)?.phase).toBe('seated');
    aggiorna(r, model);
    expect(r.events).toEqual([]);
    expect(r.d.inspect(1)!.scripts.get(vecchia.id)).toBe('FADE_IN');
    expect(r.d.inspect(1)!.scripts.get(nuova.id)).toBe('FADE');
    const o = osserva(r);
    // Il primo passo vale il suo tempo, non di più: niente sbalzi d'opacità.
    r.d.step(PASSO);
    controlla(r);
    o.sample();
    const quota = PASSO / DIRECTOR_TUNING.fadeMs;
    for (const v of r.d.actorsIn(1)) {
      if (v.partyId === vecchia.id) expect(v.fade).toBeCloseTo(quota, 12);
      if (v.partyId === nuova.id) expect(v.fade).toBeCloseTo(1 - quota, 12);
    }
    finoAFermo(r, () => {
      o.sample();
      expect(r.d.inspect(1)!.hostess.state).toBe('AT_STAND');
    });
    expect(o.released.sort()).toEqual(figure(model, 1, vecchia.id).map(f => f.key).sort());
    fermo(r);
  });
});

describe('scatti e cambi in blocco', () => {
  it('un\'epoca nuova (refetch) scatta con un solo «bulk»; un arrivo singolo dopo si anima', () => {
    const r = regista();
    const a = prenotazione({ table_id: 1 });
    const b = prenotazione({ table_id: 2 });
    const c = prenotazione({ table_id: 3 });
    aggiorna(r, scena([a, b, c]), 'initial');
    aggiorna(r, scena([arrivata(a), arrivata(b), c]), 'refetch');
    expect(r.events).toMatchObject([{ kind: 'bulk', count: 2 }]);
    fermo(r);
    aggiorna(r, scena([arrivata(a), arrivata(b), arrivata(c)]));
    expect(tipi(r.events)).toEqual(['bulk', 'escort-start']);
    expect(r.d.isAnimating()).toBe(true);
    finoAFermo(r);
    expect(tipi(r.events)).toEqual(['bulk', 'escort-start', 'escort-end']);
  });

  it('a scheda nascosta (o senza vista 3D) si scatta, con un «bulk» se qualcosa è cambiato', () => {
    const r = regista();
    const a = prenotazione({ table_id: 1 });
    aggiorna(r, scena([a]), 'initial');
    aggiorna(r, scena([a]), 'hidden');
    expect(r.events).toEqual([]);
    aggiorna(r, scena([arrivata(a)]), 'hidden');
    expect(r.events).toMatchObject([{ kind: 'bulk', count: 1 }]);
    fermo(r);
  });

  it('più di 4 passaggi in un update scattano; 3 + 2 entro 2 s scattano i 2, i 3 continuano', () => {
    const r = regista();
    const tutte = [1, 2, 3, 5, 6].map(t => prenotazione({ table_id: t }));
    aggiorna(r, scena(tutte), 'initial');
    aggiorna(r, scena(tutte.map(x => arrivata(x))));
    expect(r.events).toMatchObject([{ kind: 'bulk', count: 5 }]);
    fermo(r);

    const r2 = regista();
    aggiorna(r2, scena(tutte), 'initial');
    const tre = tutte.map((x, i) => (i < 3 ? arrivata(x) : x));
    aggiorna(r2, scena(tre));
    expect(tipi(r2.events)).toEqual(['escort-start', 'escort-start', 'escort-start']);
    avanza(r2, 300);
    aggiorna(r2, scena(tutte.map(x => arrivata(x))), null, 1500);
    expect(tipi(r2.events).slice(3)).toEqual(['bulk']);
    expect(r2.events[3]).toMatchObject({ count: 2 });
    // Gli accompagnamenti già partiti non si fermano.
    expect(r2.d.inspect(1)!.queue.length + (r2.d.inspect(1)!.current !== null ? 1 : 0)).toBe(3);
    finoAFermo(r2);
    expect(tipi(r2.events).filter(k => k === 'escort-end').length).toBe(3);

    // Fuori dalla finestra di 2 s, due passaggi si animano.
    const r3 = regista();
    aggiorna(r3, scena(tutte), 'initial');
    aggiorna(r3, scena(tre));
    aggiorna(r3, scena(tutte.map(x => arrivata(x))), null, 2500);
    expect(tipi(r3.events)).toEqual(['escort-start', 'escort-start', 'escort-start', 'escort-start', 'escort-start']);
  });

  it('la coda: oltre 3 l\'hostess va al doppio, oltre 6 i più vecchi si siedono subito', () => {
    // La coda è quella da cui l'hostess prende, l'accompagnamento in corso
    // compreso (spec: «coda > 3»): con quattro comitive alla porta va già al
    // doppio, con tre no.
    const prova = (n: number) => {
      const r = regista();
      const tutte = [1, 2, 3, 5, 6, 7, 8, 9].map(t => prenotazione({ table_id: t, guests: 2 }));
      aggiorna(r, scena(tutte), 'initial');
      let current = tutte;
      // Un arrivo ogni 2,1 s di orologio: nessun cambio in blocco, e
      // l'hostess (senza frame) non ha ancora preso nessuno.
      for (let i = 0; i < n; i++) {
        current = current.map((x, k) => (k === i ? arrivata(x) : x));
        aggiorna(r, scena(current), null, 2100);
      }
      expect(r.d.inspect(1)!.queue.length).toBe(n);
      r.d.step(PASSO);
      controlla(r);
      return { r, tutte, current };
    };
    const tre = prova(3);
    expect(tre.r.d.inspect(1)!.queue.length).toBe(2);
    expect(tre.r.d.inspect(1)!.hostess.speedFactor).toBe(1);

    const quattro = prova(4);
    const { r, tutte } = quattro;
    let current = quattro.current;
    const ins = r.d.inspect(1)!;
    expect(ins.queue.length).toBe(3);
    expect(ins.hostess.speedFactor).toBe(2);
    for (let i = 4; i < 8; i++) {
      current = current.map((x, k) => (k === i ? arrivata(x) : x));
      aggiorna(r, scena(current), null, 2100);
    }
    // In corso 1 e in coda 7 dopo l'ottavo arrivo: oltre 6 fra tutti, i due
    // più vecchi della coda si siedono subito (quello in corso no).
    const snapped = r.events.filter(e => e.kind === 'snapped');
    expect(snapped).toMatchObject([
      { kind: 'snapped', roomId: 1, reason: 'queue', parties: [{ party: { id: tutte[1].id }, table: { id: 2 } }] },
      { kind: 'snapped', roomId: 1, reason: 'queue', parties: [{ party: { id: tutte[2].id }, table: { id: 3 } }] },
    ]);
    const iSnap = r.events.findIndex(e => e.kind === 'snapped');
    expect(r.events[iSnap + 1]).toMatchObject({ kind: 'escort-end', partyId: tutte[1].id, seated: true });
    expect(r.d.inspect(1)!.current).toBe(tutte[0].id);
    expect(r.d.inspect(1)!.queue).toEqual(tutte.slice(3).map(x => x.id));
    finoAFermo(r, undefined, 400_000);
    expect(r.events.filter(e => e.kind === 'escort-end').length).toBe(8);
    fermo(r);
  });

  it('oltre 12 persone, o un banchetto: compaiono già sedute, una ogni 80 ms, senza hostess', () => {
    const r = regista();
    const grande = prenotazione({ table_id: 6, guests: 14 });
    const evento = prenotazione({ table_id: 8, guests: 3, banquet_menu_id: 7 });
    aggiorna(r, scena([grande, evento]), 'initial');
    const model = scena([arrivata(grande), arrivata(evento)]);
    aggiorna(r, model);
    expect(tipi(r.events)).toEqual(['snapped', 'snapped']);
    expect(r.events[0]).toMatchObject({ reason: 'large', roomId: 1, parties: [{ party: { id: grande.id }, table: { id: 6 } }] });
    expect(r.events[1]).toMatchObject({ reason: 'large', parties: [{ party: { id: evento.id }, table: { id: 8 } }] });
    expect(r.d.inspect(1)!.scripts.get(grande.id)).toBe('LARGE');
    const o = osserva(r);
    const firstAt = new Map<string, number>();
    let t = 0;
    finoAFermo(r, () => {
      t += PASSO;
      o.sample();
      expect(r.d.inspect(1)!.hostess.state).toBe('AT_STAND');
      for (const v of r.d.actorsIn(1)) if (v.partyId === grande.id && !firstAt.has(v.key)) firstAt.set(v.key, t);
    });
    const times = [...firstAt.values()].sort((x, y) => x - y);
    expect(times.length).toBe(14);
    expect(times[13] - times[0]).toBeGreaterThanOrEqual(13 * 80 - PASSO);
    expect(o.released.length).toBe(figure(model, 1, grande.id).length + figure(model, 1, evento.id).length);
    fermo(r);
  });

  it('un cambio di servizio azzera tutto, senza eventi', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    avanza(r, 500);
    expect(r.d.isAnimating()).toBe(true);
    const pranzo = liveService(new Date(Date.parse(ora('12:00'))));
    const lunch = prenotazione({ table_id: 2, reservation_time: ora('12:00'), shift: Shift.LUNCH, arrival_status: ArrivalStatus.ARRIVED });
    aggiorna(r, scena([lunch], { service: pranzo, nowMs: Date.parse(ora('12:30')) }));
    expect(tipi(r.events)).toEqual(['escort-start']);
    fermo(r);
  });

  it('il movimento ridotto: nessuno cammina, gli eventi arrivano lo stesso', () => {
    const r = regista();
    r.d.configure({ reducedMotion: true });
    const fam = prenotazione({ table_id: 1 });
    const lobby = prenotazione({ table_id: undefined, guests: 2, reservation_time: ora('18:40') });
    aggiorna(r, scena([fam, lobby]), 'initial');
    aggiorna(r, scena([arrivata(fam), arrivata(lobby)]), 'reduced-motion');
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end', 'lobby']);
    expect(r.events[1]).toMatchObject({ seated: true, partyId: fam.id });
    fermo(r);
    avanza(r, 1000);
    fermo(r);
    // Anche un update senza motivo scatta, se il movimento ridotto è acceso.
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED }), arrivata(lobby)]));
    expect(tipi(r.events).slice(3)).toEqual(['leaving']);
    fermo(r);
  });

  it('accendere il movimento ridotto porta tutto in fondo subito', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    avanza(r, 800);
    r.d.configure({ reducedMotion: true });
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    fermo(r);
  });

  it('fastForward: accompagnamenti seduti, uscite concluse, hostess al leggio', () => {
    const r = regista();
    const a = prenotazione({ table_id: 1 });
    const b = prenotazione({ table_id: 2 });
    const via = prenotazione({ table_id: 3, arrival_status: ArrivalStatus.ARRIVED, reservation_time: ora('18:00') });
    aggiorna(r, scena([a, b, via]), 'initial');
    aggiorna(r, scena([arrivata(a), arrivata(b), con(via, { arrival_status: ArrivalStatus.DEPARTED })]));
    avanza(r, 3000);
    let notified = 0;
    const off = r.d.subscribe(() => notified++);
    r.d.fastForward();
    off();
    expect(notified).toBe(1);
    expect(tipi(r.events)).toEqual(['leaving', 'escort-start', 'escort-start', 'escort-end', 'escort-end']);
    expect(r.events.slice(3).every(e => e.kind === 'escort-end' && e.seated)).toBe(true);
    fermo(r);
  });
});

describe('determinismo e frame', () => {
  it('stesso seme e stessi ingressi: le stesse posizioni dopo N passi', () => {
    const giro = () => {
      const r = regista();
      const fam = prenotazione({ id: 4242, table_id: 7, guests: 3, notes: 'Cane' });
      const via = prenotazione({ id: 4243, table_id: 2, arrival_status: ArrivalStatus.ARRIVED, reservation_time: ora('18:00') });
      r.d.configure({ staff: [{ id: 'a', name: 'Marco', role: 'Cameriere' }, { id: 'b', name: 'Sara', role: null }], activeRoomId: 1 });
      aggiorna(r, scena([fam, via]), 'initial');
      aggiorna(r, scena([arrivata(fam), con(via, { arrival_status: ArrivalStatus.DEPARTED })]));
      const frames: string[] = [];
      for (let i = 0; i < 400; i++) {
        r.d.step(PASSO);
        frames.push(JSON.stringify(r.d.actorsIn(1)));
      }
      return frames;
    };
    const one = giro();
    const two = giro();
    expect(one.length).toBe(400);
    expect(one).toEqual(two);
  });

  it('frameNeed: attivo durante un passaggio, fermo dopo; step non avvisa, update sì', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1, guests: 1 });
    aggiorna(r, scena([fam]), 'initial');
    expect(r.d.frameNeed()).toBe('none');
    let notified = 0;
    r.d.subscribe(() => notified++);
    aggiorna(r, scena([arrivata(fam)]));
    expect(notified).toBe(1);
    expect(r.d.frameNeed()).toBe('active');
    r.d.step(PASSO);
    expect(notified).toBe(1);
    finoAFermo(r);
    expect(r.d.frameNeed()).toBe('none');
    expect(r.d.wakeInMs()).toBeNull();
  });

  it('un passo lungo dopo un sonno non fa saltare nessuno', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 1, guests: 1 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    r.d.step(PASSO);
    const before = r.d.actorsIn(1)[0];
    const x0 = before.x;
    const z0 = before.z;
    r.d.step(10_000);
    const after = r.d.actorsIn(1)[0];
    expect(dist({ x: x0, z: z0 }, after)).toBeLessThanOrEqual(DIRECTOR_TUNING.hostessSpeed * 0.1 + 1e-9);
  });

  it('un ascoltatore che si rompe non rompe il regista', () => {
    const r = regista();
    r.d.onEvent(() => {
      throw new Error('rotto');
    });
    const fam = prenotazione({ table_id: 1 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    expect(tipi(r.events)).toEqual(['escort-start']);
  });

  it('la rete di sicurezza: un passaggio più vecchio di 90 s va in fondo da sé', () => {
    const r = regista({ escortSpeed: 0.001, hostessSpeed: 0.001 });
    const fam = prenotazione({ table_id: 9 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    const t = finoAFermo(r, undefined, 200_000);
    expect(t).toBeGreaterThan(90_000);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    expect(r.events[1]).toMatchObject({ seated: true });
  });
});

describe('l\'ingresso, e i passaggi a metà', () => {
  it('in attesa → all\'ingresso: entrano dalla porta uno ogni 250 ms e vanno ai loro posti', () => {
    const r = regista();
    const fam = prenotazione({ table_id: undefined, guests: 3, reservation_time: ora('18:40') });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([arrivata(fam)]);
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'lobby', roomId: 1, party: { id: fam.id, adults: 3 } }]);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('LOBBY');
    const o = osserva(r);
    const door = ancore(model, 1).door;
    const firstAt = new Map<string, number>();
    let t = 0;
    finoAFermo(r, () => {
      t += PASSO;
      o.sample();
      for (const v of r.d.actorsIn(1)) if (v.partyId === fam.id && v.fade > 0 && !firstAt.has(v.key)) firstAt.set(v.key, t);
      expect(r.d.inspect(1)!.hostess.state).toBe('AT_STAND');
    });
    for (const f of figure(model, 1, fam.id)) expect(dist(o.firstSeen.get(f.key)!, door)).toBeLessThanOrEqual(DOOR_OUTSIDE + 0.06);
    const times = [...firstAt.values()].sort((a, b) => a - b);
    expect(times[2] - times[0]).toBeGreaterThanOrEqual(2 * DIRECTOR_TUNING.spawnStaggerMs - PASSO);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('dal tavolo all\'ingresso (il tavolo nascosto per il servizio): camminano fino ai posti dell\'ingresso', () => {
    const r = regista();
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 6, reservation_time: ora('18:40'), guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([fam], { hiddenTableIds: new Set([6]) });
    expect(model.partyStates.find(s => s.id === fam.id)).toMatchObject({ phase: 'lobby', roomId: 1 });
    aggiorna(r, model);
    expect(r.events).toMatchObject([{ kind: 'lobby', roomId: 1 }]);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('chi aspetta all\'ingresso e se ne va svanisce; chi è dietro avanza ai posti liberati, senza contare come cambio', () => {
    const r = regista();
    const prima = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: undefined, guests: 2, reservation_time: ora('18:30') });
    const dopo = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: undefined, guests: 2, reservation_time: ora('18:40') });
    const m0 = scena([prima, dopo]);
    aggiorna(r, m0, 'initial');
    const before = figure(m0, 1, dopo.id);
    const model = scena([con(prima, { arrival_status: ArrivalStatus.DEPARTED }), dopo]);
    const after = figure(model, 1, dopo.id);
    expect(after.map(f => [f.x, f.z])).not.toEqual(before.map(f => [f.x, f.z]));
    aggiorna(r, model);
    expect(r.events).toEqual([]);
    expect(r.d.inspect(1)!.scripts.get(prima.id)).toBe('FADE');
    expect(r.d.inspect(1)!.scripts.get(dopo.id)).toBe('LOBBY');
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(after.map(f => f.key).sort());
    fermo(r);
    // Solo l'uscita conta per la regola dei cambi in blocco: 4 arrivi subito
    // dopo si animano ancora (1 + 4 > 4 scatterebbe, 0 + 4 no).
    const four = [1, 2, 3, 5].map(t => prenotazione({ table_id: t }));
    const r2 = regista();
    aggiorna(r2, scena([prima, dopo, ...four]), 'initial');
    aggiorna(r2, scena([prima, con(dopo, { reservation_time: ora('18:20') }), ...four]));
    aggiorna(r2, scena([prima, con(dopo, { reservation_time: ora('18:20') }), ...four.map(x => arrivata(x))]), null, 500);
    expect(tipi(r2.events)).toEqual(['escort-start', 'escort-start', 'escort-start', 'escort-start']);
  });

  it('«Tavolo liberato» annullato a metà uscita: tornano a sedersi, senza un altro evento', () => {
    const r = regista();
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 9, reservation_time: ora('18:30'), guests: 3, notes: 'Cane' });
    const m0 = scena([fam]);
    aggiorna(r, m0, 'initial');
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]));
    avanza(r, 2500);
    expect(r.d.actorsIn(1).filter(v => v.partyId === fam.id).length).toBeGreaterThan(0);
    aggiorna(r, m0, null, 2500);
    expect(tipi(r.events)).toEqual(['leaving']);
    expect(r.d.inspect(1)!.scripts.get(fam.id)).toBe('RESEAT');
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(m0, 1, fam.id).map(f => f.key).sort());
    expect(tipi(r.events)).toEqual(['leaving']);
    fermo(r);
  });

  it('un accompagnamento in coda spostato in un\'altra sala: finisce qui e si rimette in coda là', () => {
    const r = regista();
    const a = prenotazione({ table_id: 1, guests: 2 });
    const b = prenotazione({ table_id: 2, guests: 2 });
    aggiorna(r, scena([a, b]), 'initial');
    aggiorna(r, scena([arrivata(a), b]));
    r.d.step(PASSO);
    aggiorna(r, scena([arrivata(a), arrivata(b)]));
    expect(r.d.inspect(1)!.queue).toEqual([b.id]);
    const model = scena([arrivata(a), arrivata(b, { table_id: 4 })]);
    aggiorna(r, model);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-start', 'escort-end', 'escort-start']);
    expect(r.events[2]).toMatchObject({ roomId: 1, partyId: b.id, tableId: 2, seated: false });
    expect(r.events[3]).toMatchObject({ roomId: 2, party: { id: b.id }, table: { id: 4 }, from: 'entrance' });
    expect(r.d.inspect(1)!.queue).toEqual([]);
    expect([...r.d.escortTargets(1)]).toEqual([1]);
    expect([...r.d.escortTargets(2)]).toEqual([4]);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released).toEqual(expect.arrayContaining(figure(model, 2, b.id).map(f => f.key)));
    expect(r.events.filter(e => e.kind === 'escort-end' && e.seated).length).toBe(2);
    fermo(r);
  });

  it('un accompagnamento rimandato all\'ingresso: finisce, e la famiglia va ai posti dell\'ingresso', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 3, guests: 2, reservation_time: ora('18:40') });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    finoA(r, 1, 'ESCORT');
    avanza(r, 2000);
    const model = scena([arrivata(fam, { table_id: undefined })]);
    expect(model.partyStates.find(s => s.id === fam.id)?.phase).toBe('lobby');
    aggiorna(r, model, null, 1000);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end', 'lobby']);
    expect(r.events[1]).toMatchObject({ seated: false });
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('arrivata e già «In uscita»: accompagnata ai posti in piedi', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 2, guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { arrival_status: ArrivalStatus.DEPARTING })]);
    expect(model.partyStates.find(s => s.id === fam.id)?.phase).toBe('standing');
    aggiorna(r, model);
    expect(tipi(r.events)).toEqual(['escort-start']);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    for (const f of figure(model, 1, fam.id)) expect(f.pose).toBe('standing');
    fermo(r);
  });

  it('il tavolo spostato in Sale & Tavoli mentre ci camminano: arrivano ai posti nuovi', () => {
    const r = regista();
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 1, reservation_time: ora('18:30'), guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { table_id: 7 })]));
    avanza(r, 2500);
    const moved = TAVOLI.map(t => (t.id === 7 ? { ...t, x: t.x + 60 } : t));
    const model = scena([con(fam, { table_id: 7 })], { tables: moved });
    aggiorna(r, model, null, 500);
    expect(tipi(r.events)).toEqual(['moved']);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released.sort()).toEqual(figure(model, 1, fam.id).map(f => f.key).sort());
    fermo(r);
  });

  it('una persona in più a metà accompagnamento compare al suo posto', () => {
    const r = regista();
    const fam = prenotazione({ table_id: 5, guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([arrivata(fam)]));
    finoA(r, 1, 'ESCORT');
    const model = scena([arrivata(fam, { guests: 3 })]);
    aggiorna(r, model, null, 500);
    const added = figure(model, 1, fam.id).map(f => f.key).find(k => !['a0', 'a1'].some(s => k.endsWith(`:${s}`)))!;
    expect(added).toBe(`r${fam.id}:a2`);
    expect(r.d.movingKeys(1).has(added)).toBe(true);
    const o = osserva(r);
    finoAFermo(r, o.sample);
    expect(o.released).toContain(added);
    expect(tipi(r.events)).toEqual(['escort-start', 'escort-end']);
    fermo(r);
  });
});

describe('i casi trovati dal servizio a caso', () => {
  it('un cambio di sala, poi lo stesso modello di nuovo mentre svaniscono: arrivano lo stesso nella sala nuova', () => {
    for (const guests of [2, 14]) {
      const r = regista();
      const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 7, reservation_time: ora('18:30'), guests });
      aggiorna(r, scena([fam]), 'initial');
      // Prima un cambio di tavolo nella sala: hanno già un posto d'arrivo.
      aggiorna(r, scena([con(fam, { table_id: 9 })]));
      avanza(r, 1500);
      const model = scena([con(fam, { table_id: 4 })]);
      aggiorna(r, model, null, 2500);
      avanza(r, 100);
      // Lo stesso modello ricalcolato (il minuto di App): nessun passaggio.
      aggiorna(r, scena([con(fam, { table_id: 4 })]), null, 500);
      const o = osserva(r);
      finoAFermo(r, o.sample);
      expect(o.released.sort(), `${guests} persone`).toEqual(figure(model, 2, fam.id).map(f => f.key).sort());
      fermo(r);
    }
  });

  it('il cane di chi aspetta all\'ingresso resta nascosto finché l\'hostess non arriva, poi compare sulla soglia', () => {
    const r = regista();
    const altri = prenotazione({ table_id: 1, guests: 2 });
    const fam = prenotazione({ table_id: undefined, guests: 2, notes: 'Cane', reservation_time: ora('18:40'), arrival_status: ArrivalStatus.ARRIVED });
    aggiorna(r, scena([altri, fam]), 'initial');
    // Prima un altro accompagnamento: quello dall'ingresso resta in coda.
    aggiorna(r, scena([arrivata(altri), fam]));
    r.d.step(PASSO);
    const model = scena([arrivata(altri), con(fam, { table_id: 8 })]);
    aggiorna(r, model, null, 2500);
    expect(r.d.inspect(1)!.queue).toEqual([fam.id]);
    const dog = `r${fam.id}:d0`;
    const inside = ancore(model, 1).inside;
    let first: { x: number; z: number } | null = null;
    finoAFermo(r, () => {
      const v = r.d.actorsIn(1).find(x => x.key === dog);
      if (!v) return;
      if (first === null) first = { x: v.x, z: v.z };
      // Mai visibile mentre l'accompagnamento è in coda.
      expect(r.d.inspect(1)!.queue).not.toContain(fam.id);
    });
    expect(first).not.toBeNull();
    expect(dist(first!, inside)).toBeLessThan(1e-9);
    fermo(r);
  });
});

describe('chi cammina non entra in nessuno', () => {
  // La distanza fra due che stanno in piedi e si vedono (pieni per metà).
  const inPiedi = (v: ActorView | undefined): v is ActorView => !!v && v.fade >= 0.5 && v.seat <= 0.05;

  it('il cane accompagnato sta dal suo lato: mai dentro l\'hostess, mai attraverso il padrone', () => {
    // Tre tavoli: la strada dalla porta piega da una parte, dall'altra, dritta.
    for (const table of [1, 6, 7]) {
      const r = regista();
      const fam = prenotazione({ table_id: table, guests: 3, notes: 'Cane' });
      aggiorna(r, scena([fam]), 'initial');
      aggiorna(r, scena([arrivata(fam)]));
      const dogKey = `r${fam.id}:d0`;
      const ownerKey = `r${fam.id}:a0`;
      let near = Infinity;
      let host = Infinity;
      let sides = new Set<number>();
      finoAFermo(r, () => {
        const st = r.d.inspect(1)!.hostess.state;
        const views = r.d.actorsIn(1);
        const dog = views.find(v => v.key === dogKey);
        const owner = views.find(v => v.key === ownerKey);
        const h = views[0];
        if (inPiedi(dog)) host = Math.min(host, dist(dog, h));
        // In fila (accoglienza e cammino): accanto al padrone, sempre dallo
        // stesso lato. La sinistra di chi guarda (sin ψ, cos ψ) è (cos ψ, −sin ψ).
        if ((st === 'GREET' || st === 'ESCORT') && inPiedi(dog) && inPiedi(owner)) {
          near = Math.min(near, dist(dog, owner));
          const lat = (dog.x - owner.x) * Math.cos(owner.yaw) - (dog.z - owner.z) * Math.sin(owner.yaw);
          if (Math.abs(lat) > 0.2) sides.add(Math.sign(lat));
        }
      });
      expect(host, `tavolo ${table}: cane ↔ hostess`).toBeGreaterThan(0.4);
      expect(near, `tavolo ${table}: cane ↔ padrone`).toBeGreaterThan(0.3);
      expect(sides.size, `tavolo ${table}: il cane cambia lato`).toBe(1);
      sides = new Set();
      fermo(r);
    }
  });

  it('chi esce va alla porta in fila, distanziato per strada: nessuno dentro l\'altro', () => {
    const r = regista();
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 7, reservation_time: ora('18:30'), guests: 4, children: 2 });
    aggiorna(r, scena([fam]), 'initial');
    aggiorna(r, scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]));
    let closest = Infinity;
    finoAFermo(r, () => {
      const ps = r.d.actorsIn(1).filter(v => v.partyId === fam.id && v.kind !== 'dog' && inPiedi(v));
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) closest = Math.min(closest, dist(ps[i], ps[j]));
    });
    // Un adulto e un bambino si toccano a 33 cm.
    expect(closest).toBeGreaterThanOrEqual(0.35);
    fermo(r);
  });

  it('chi esce resta del regista anche se nel modello non c\'è più: People non lo ridisegna fermo', () => {
    const r = regista();
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 2, reservation_time: ora('18:30'), guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { arrival_status: ArrivalStatus.DEPARTED })]);
    aggiorna(r, model);
    const keys = [`r${fam.id}:a0`, `r${fam.id}:a1`];
    expect(stanza(model, 1).figures.some(f => keys.includes(f.key))).toBe(false);
    for (const k of keys) expect(r.d.movingKeys(1).has(k), k).toBe(true);
    finoAFermo(r);
    fermo(r);
  });
});

describe('le reti di sicurezza', () => {
  it('scatta anche con un update al minuto (l\'orologio di App): un passaggio incastrato non resta acceso', () => {
    const r = regista({ guestSpeed: 0.0001 });
    const fam = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 1, reservation_time: ora('18:30'), guests: 2 });
    aggiorna(r, scena([fam]), 'initial');
    const model = scena([con(fam, { table_id: 9 })]);
    aggiorna(r, model);
    let t = 0;
    while (r.d.isAnimating() && t < 200_000) {
      r.d.step(PASSO);
      t += PASSO;
      // Lo stesso modello ricalcolato ogni minuto: nessun passaggio.
      if (t % 60_000 < PASSO) aggiorna(r, scena([con(fam, { table_id: 9 })]), null, 60_000);
    }
    expect(r.d.isAnimating()).toBe(false);
    expect(t).toBeGreaterThan(90_000);
    expect(t).toBeLessThan(95_000);
    // Portati al tavolo nuovo dalla rete: l'anello si spegne con loro.
    expect(r.events.filter(e => e.kind === 'moved-end')).toMatchObject([{ tableId: 9, seated: true }]);
    fermo(r);
  });

  it('un accompagnamento rimasto a lungo in coda non viene tagliato a metà: i 90 s contano da quando parte', () => {
    // Accompagnamenti lenti (~50 s l'uno): il secondo parte dopo un minuto
    // di coda e finisce oltre i 90 s dal suo arrivo, ma seduto per davvero.
    const r = regista({ escortSpeed: 0.3, hostessSpeed: 1.3 });
    const a = prenotazione({ table_id: 9, guests: 2 });
    const b = prenotazione({ table_id: 8, guests: 2 });
    aggiorna(r, scena([a, b]), 'initial');
    const model = scena([arrivata(a), arrivata(b)]);
    aggiorna(r, model);
    const o = osserva(r);
    let presents = 0;
    let last = '';
    const t = finoAFermo(r, () => {
      o.sample();
      const st = r.d.inspect(1)!.hostess.state;
      if (st === 'PRESENT' && last !== 'PRESENT') presents++;
      last = st;
    }, 300_000);
    expect(t).toBeGreaterThan(90_000);
    expect(presents).toBe(2);
    // Tutti tornati a People esatti, nessuno tolto di mezzo a metà strada.
    expect(o.released.sort()).toEqual([...figure(model, 1, a.id), ...figure(model, 1, b.id)].map(f => f.key).sort());
    expect(r.events.filter(e => e.kind === 'escort-end')).toMatchObject([{ seated: true }, { seated: true }]);
    fermo(r);
  });
});

describe('i cambi in blocco', () => {
  it('la riga conta i tavoli, non i passaggi: chi lascia e chi arriva sullo stesso tavolo sono uno; l\'ingresso nessuno', () => {
    const r = regista();
    const vecchi = prenotazione({ arrival_status: ArrivalStatus.ARRIVED, table_id: 3, reservation_time: ora('18:00'), guests: 2 });
    const nuovi = prenotazione({ table_id: 3, reservation_time: ora('18:50'), guests: 2 });
    const ingresso = prenotazione({ table_id: undefined, reservation_time: ora('18:40'), guests: 2 });
    aggiorna(r, scena([vecchi, nuovi, ingresso]), 'initial');
    // Mentre la scheda è nascosta: i nuovi seduti sul 3 spodestano i vecchi.
    aggiorna(r, scena([vecchi, arrivata(nuovi), ingresso]), 'hidden');
    expect(r.events).toMatchObject([{ kind: 'bulk', count: 1 }]);
    // Solo chi arriva all'ingresso: nessun tavolo, nessuna riga.
    aggiorna(r, scena([vecchi, arrivata(nuovi), arrivata(ingresso)]), 'hidden');
    expect(r.events.length).toBe(1);
    fermo(r);
  });
});

describe('il cambio di servizio delle 17:00', () => {
  it('il primo modello della cena arriva con le varianti della cena: azzera, senza eventi e senza animazioni', () => {
    // La pagina aspetta le unioni della cena prima di dare il modello al
    // regista (useSettledOverrides): con quelle del pranzo lui azzererebbe
    // su una sala sbagliata, e poi animerebbe come un cambio vero l'arrivo
    // delle unioni giuste (un RESEAT finto, un accompagnamento finto).
    const r = regista();
    const tardi = prenotazione({ reservation_time: ora('15:45'), shift: Shift.LUNCH, arrival_status: ArrivalStatus.ARRIVED, table_id: 2, guests: 2 });
    const pranzo = liveService(new Date(Date.parse(ora('16:59'))));
    const unione = [{ id: 1, date: pranzo.date, shift: Shift.LUNCH, primary_id: 1, merged_ids: [2] }];
    aggiorna(r, scena([tardi], { service: pranzo, nowMs: Date.parse(ora('16:59')), merges: unione }), 'initial');
    const cena = liveService(new Date(Date.parse(ora('17:00'))));
    aggiorna(r, scena([tardi], { service: cena, nowMs: Date.parse(ora('17:00')), merges: [] }));
    expect(r.events).toEqual([]);
    expect(r.d.isAnimating()).toBe(false);
    fermo(r);
  });
});

describe('un servizio a caso', () => {
  /* Arrivi, uscite, cambi di tavolo e di sala, «Arrivato» annullati,
   * comitive che crescono, tavoli nascosti, riallineamenti, interruttori:
   * a caso ma ripetibili (mulberry32). A ogni passo gli strati restano
   * giusti, chi torna a People ci torna esatto, nessuno visibile salta più
   * di quanto cammina in un passo, ogni anello «in arrivo» si accende e si
   * spegne col suo evento, e alla fine tutto si ferma, anelli compresi. */
  const TONDI = TAVOLI.map(t => (t.id === 2 ? { ...t, shape: TableShape.CIRCLE, seats: 6 } : t.id === 5 ? { ...t, rotation: 30 } : t));
  const ids = [1, 2, 3, 5, 6, 7, 8, 9, 4];

  const giro = (seme: number) => {
    const rnd = mulberry32(seme);
    const r = regista();
    r.d.configure({ staff: [persona('g', 'Giulia', 'Hostess'), persona('m', 'Marco'), persona('s', 'Sara')], activeRoomId: 1 });
    let res: Reservation[] = [];
    for (let i = 0; i < 7; i++) {
      res.push(prenotazione({
        reservation_time: ora(['18:00', '18:20', '18:40', '18:50'][i % 4]),
        guests: 1 + Math.floor(rnd() * 6),
        children: Math.floor(rnd() * 2),
        notes: rnd() < 0.3 ? 'Cane' : undefined,
        table_id: ids[Math.floor(rnd() * ids.length)],
        arrival_status: rnd() < 0.5 ? ArrivalStatus.ARRIVED : ArrivalStatus.WAITING,
      }));
    }
    let hidden = new Set<number>();
    const model = () => scena(res, { tables: TONDI, hiddenTableIds: hidden });
    aggiorna(r, model(), 'initial', 0);
    const o = osserva(r);
    const last = new Map<string, { x: number; z: number; room: number; fade: number }>();
    const salti = () => {
      const now = new Set<string>();
      for (const room of r.model!.rooms) {
        for (const v of r.d.actorsIn(room.id)) {
          now.add(v.key);
          const p = last.get(v.key);
          if (p && p.room === room.id && p.fade > 0.15 && v.fade > 0.15 && dist(p, v) > 0.35) {
            expect.fail(`${v.key} salta di ${dist(p, v).toFixed(3)} m`);
          }
          last.set(v.key, { x: v.x, z: v.z, room: room.id, fade: v.fade });
        }
      }
      for (const k of [...last.keys()]) if (!now.has(k)) last.delete(k);
    };
    for (let round = 0; round < 30; round++) {
      for (let n = 1 + Math.floor(rnd() * 3); n > 0; n--) {
        const i = Math.floor(rnd() * res.length);
        const x = res[i];
        const pick = rnd();
        if (pick < 0.25) res[i] = con(x, { arrival_status: ArrivalStatus.ARRIVED });
        else if (pick < 0.35) res[i] = con(x, { arrival_status: ArrivalStatus.WAITING });
        else if (pick < 0.45) res[i] = con(x, { arrival_status: ArrivalStatus.DEPARTING });
        else if (pick < 0.55) res[i] = con(x, { arrival_status: ArrivalStatus.DEPARTED });
        else if (pick < 0.7) res[i] = con(x, { table_id: ids[Math.floor(rnd() * ids.length)] });
        else if (pick < 0.78) res[i] = con(x, { table_id: undefined });
        else if (pick < 0.85) res[i] = con(x, { guests: 1 + Math.floor(rnd() * 14) });
        else if (pick < 0.9) hidden = new Set(rnd() < 0.5 ? [] : [ids[Math.floor(rnd() * ids.length)]]);
        else if (pick < 0.95) res[i] = con(x, { reservation_time: ora(['17:30', '18:10', '18:45', '18:55'][Math.floor(rnd() * 4)]) });
        else res = [...res, prenotazione({ table_id: x.table_id })];
      }
      if (rnd() < 0.08) {
        const c = rnd();
        if (c < 0.3) r.d.configure({ reducedMotion: rnd() < 0.5 });
        else if (c < 0.5) r.d.configure({ slowMode: rnd() < 0.5 });
        else if (c < 0.7) r.d.configure({ lightMode: rnd() < 0.5 });
        else r.d.configure({ activeRoomId: rnd() < 0.5 ? 1 : 2 });
        controlla(r);
        o.sample(false);
      }
      const reduced = (r.d as unknown as { settings: { reducedMotion: boolean } }).settings.reducedMotion;
      const reason = reduced ? 'reduced-motion' : rnd() < 0.08 ? 'refetch' : rnd() < 0.04 ? 'hidden' : null;
      aggiorna(r, model(), reason, Math.floor(rnd() * 4000));
      last.clear();
      o.sample(false);
      for (let s = Math.floor(rnd() * 150); s > 0; s--) {
        r.d.step(rnd() < 0.02 ? 500 : PASSO);
        controlla(r);
        o.sample();
        salti();
      }
    }
    finoAFermo(r, () => {
      o.sample();
      salti();
    }, 200_000);
    fermo(r);
    const starts = r.events.filter(e => e.kind === 'escort-start').length;
    expect(r.events.filter(e => e.kind === 'escort-end').length).toBe(starts);
    return {
      events: r.events.length,
      released: o.released.length,
      moves: r.events.filter(e => e.kind === 'moved-end').length,
    };
  };

  it('non rompe mai gli strati e si ferma sempre', () => {
    let events = 0;
    let released = 0;
    let moves = 0;
    for (let seme = 1; seme <= 6; seme++) {
      const out = giro(seme);
      events += out.events;
      released += out.released;
      moves += out.moves;
    }
    expect(events).toBeGreaterThan(50);
    expect(released).toBeGreaterThan(100);
    // Qualche cambio di tavolo a piedi c'è stato, e ognuno ha spento il suo
    // anello (controllaAnelli, a ogni passo).
    expect(moves).toBeGreaterThan(0);
  }, 20_000);
});
