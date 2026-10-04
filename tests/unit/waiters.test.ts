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
import type { DirectorEvent, DirectorTuning, SceneModel, StaffOnShift } from '../../components/salaVivo/types';
import { liveService } from '../../components/salaVivo/model/service';
import { deriveSceneModel } from '../../components/salaVivo/model/sceneModel';
import { buildNavGrid, passSlots, roomAnchors } from '../../components/salaVivo/model/navGrid';
import { mulberry32 } from '../../components/salaVivo/model/rng';
import { DIRECTOR_SEED, SceneDirector } from '../../components/salaVivo/model/director';
import {
  HOSTESS_ROLE,
  allocateWaiters,
  hostessName,
  pickVisit,
  splitStaff,
  staffLabel,
  type VisitCandidate,
  type WaiterSeed,
} from '../../components/salaVivo/model/waiters';

/* I camerieri della Sala dal vivo: chi sono (il personale di turno, come la
 * pagina Personale), dove stanno (le sale con persone a tavola, a resto
 * maggiore), quale tavolo servono (prima quelli appena seduti), e il loro
 * giro fra il pass e i tavoli, col tetto di 8 in giro per sala e fermi col
 * movimento ridotto. La cena del 4 ottobre 2026 a Roma, alle 19:00. */

beforeAll(() => {
  setSessionTimeZone('Europe/Rome');
});

const seed = (key: string, label: string | null = null): WaiterSeed => ({ key, label });
const persona = (id: string, name: string, role: string | null = null): StaffOnShift => ({ id, name, role });

describe('chi è di turno', () => {
  it('il ruolo da accoglienza', () => {
    for (const role of ['Hostess', 'host', 'Accoglienza', 'accoglienza sala', 'Maître', 'maitre', 'MAÎTRE']) {
      expect(HOSTESS_ROLE.test(role), role).toBe(true);
    }
    for (const role of ['Cameriere', 'Barman', 'Commis', '']) expect(HOSTESS_ROLE.test(role), role).toBe(false);
  });

  it('staffLabel: il nome com\'è, spazi compressi, al più 16 code point', () => {
    expect(staffLabel('  Anna   Maria ')).toBe('Anna Maria');
    expect(staffLabel('Giulia')).toBe('Giulia');
    expect(staffLabel('Bartolomeo Alessandro')).toBe('Bartolomeo Aless');
    expect(staffLabel('Maximilianusssss xyz')).toBe('Maximilianusssss');
    expect(Array.from(staffLabel('😀'.repeat(20))).length).toBe(16);
    expect(staffLabel(undefined as unknown as string)).toBe('');
  });

  it('splitStaff: l\'hostess è la prima con il ruolo, gli altri camerieri nell\'ordine dato', () => {
    const staff = [
      persona('1', 'Marco', 'Cameriere'),
      persona('2', 'Giulia', 'Hostess'),
      persona('3', 'Sara', null),
      persona('4', 'Lucia', 'Maître'),
    ];
    expect(splitStaff(staff, true)).toEqual({
      hostess: 'Giulia',
      waiters: [seed('waiter:1', 'Marco'), seed('waiter:3', 'Sara'), seed('waiter:4', 'Lucia')],
    });
    expect(hostessName(staff)).toBe('Giulia');
  });

  it('splitStaff: righe senza id o senza nome saltate, una persona ripetuta una volta', () => {
    const staff = [
      persona('', 'Nessuno'),
      persona('1', '   '),
      persona('2', 'Marco'),
      persona('2', 'Marco'),
      null as unknown as StaffOnShift,
    ];
    expect(splitStaff(staff, false).waiters).toEqual([seed('waiter:2', 'Marco')]);
  });

  it('il ripiego: niente camerieri di turno → due senza nome con qualcuno a tavola, se no uno', () => {
    expect(splitStaff(undefined, true)).toEqual({ hostess: null, waiters: [] });
    expect(splitStaff(null, true)).toEqual({ hostess: null, waiters: [seed('waiter:anon0'), seed('waiter:anon1')] });
    expect(splitStaff(null, false)).toEqual({ hostess: null, waiters: [seed('waiter:anon0')] });
    expect(splitStaff([], false).waiters).toEqual([seed('waiter:anon0')]);
    // Solo l'hostess: lei ha il nome, i camerieri sono di ripiego.
    expect(splitStaff([persona('9', 'Giulia', 'Hostess')], true)).toEqual({
      hostess: 'Giulia',
      waiters: [seed('waiter:anon0'), seed('waiter:anon1')],
    });
    expect(hostessName(undefined)).toBeNull();
    expect(hostessName([persona('1', 'Marco', 'Cameriere')])).toBeNull();
  });
});

describe('quanti camerieri per sala', () => {
  const w = (n: number) => Array.from({ length: n }, (_, i) => seed(`waiter:${i}`, `W${i}`));
  const keys = (m: Map<number, WaiterSeed[]>) => [...m].map(([room, list]) => [room, list.map(s => s.key)]);

  it('a ristorante vuoto uno solo, al pass della sala sullo schermo (o della prima)', () => {
    const rooms = [{ id: 1, covers: 0 }, { id: 2, covers: 0 }];
    expect(keys(allocateWaiters(w(3), rooms, 2))).toEqual([[2, ['waiter:0']]]);
    expect(keys(allocateWaiters(w(3), rooms, null))).toEqual([[1, ['waiter:0']]]);
    expect(keys(allocateWaiters(w(3), rooms, 99))).toEqual([[1, ['waiter:0']]]);
    expect(allocateWaiters([], rooms, 1).size).toBe(0);
    expect(allocateWaiters(w(2), [], 1).size).toBe(0);
  });

  it('con meno camerieri che sale piene: uno alle sale con più persone (pari: l\'ordine delle sale)', () => {
    const rooms = [{ id: 1, covers: 4 }, { id: 2, covers: 9 }, { id: 3, covers: 9 }];
    expect(keys(allocateWaiters(w(2), rooms, null))).toEqual([[2, ['waiter:0']], [3, ['waiter:1']]]);
    expect(keys(allocateWaiters(w(1), rooms, null))).toEqual([[2, ['waiter:0']]]);
  });

  it('con più camerieri: uno a testa, il resto a resto maggiore sulle persone', () => {
    // 7 camerieri, 3 sale: 4 in più su 10 + 6 + 4 persone = 2 + 1,2 + 0,8 →
    // 2, 1, 0 e il resto più grande (0,8) alla terza: 3, 2, 2.
    const rooms = [{ id: 1, covers: 10 }, { id: 2, covers: 6 }, { id: 3, covers: 4 }];
    const out = allocateWaiters(w(7), rooms, null);
    expect([...out].map(([id, list]) => [id, list.length])).toEqual([[1, 3], [2, 2], [3, 2]]);
    // I nomi in giro: ogni giro una sala ancora sotto il suo numero prende il prossimo.
    expect(keys(out)).toEqual([
      [1, ['waiter:0', 'waiter:3', 'waiter:6']],
      [2, ['waiter:1', 'waiter:4']],
      [3, ['waiter:2', 'waiter:5']],
    ]);
    // Le sale vuote non ne prendono.
    const withEmpty = allocateWaiters(w(4), [{ id: 1, covers: 3 }, { id: 2, covers: 0 }, { id: 3, covers: 3 }], null);
    expect([...withEmpty].map(([id, list]) => [id, list.length])).toEqual([[1, 2], [3, 2]]);
  });

  it('a pari resto vince l\'ordine delle sale, e il totale torna sempre', () => {
    const rooms = [{ id: 5, covers: 3 }, { id: 6, covers: 3 }, { id: 7, covers: 3 }];
    const out = allocateWaiters(w(4), rooms, null);
    expect([...out].map(([id, list]) => [id, list.length])).toEqual([[5, 2], [6, 1], [7, 1]]);
    for (let n = 1; n <= 12; n++) {
      const got = allocateWaiters(w(n), [{ id: 1, covers: 7 }, { id: 2, covers: 2 }, { id: 3, covers: 13 }], null);
      expect([...got.values()].reduce((s, l) => s + l.length, 0), String(n)).toBe(n);
    }
  });
});

describe('quale tavolo', () => {
  const c = (partyId: number, visits: number, seatedAt: number, lastVisitAt = 0): VisitCandidate =>
    ({ partyId, visits, seatedAt, lastVisitAt });

  it('prima i mai visitati, il più recente; poi l\'id più alto; mai uno già preso', () => {
    const list = [c(1, 0, 100), c(2, 3, 900), c(3, 0, 500), c(4, 0, 500)];
    const rng = () => 0.5;
    expect(pickVisit(list, new Set(), 10_000, rng)).toBe(4);
    expect(pickVisit(list, new Set([4]), 10_000, rng)).toBe(3);
    expect(pickVisit(list, new Set([3, 4]), 10_000, rng)).toBe(1);
    expect(pickVisit([], new Set(), 0, rng)).toBeNull();
    expect(pickVisit([c(1, 1, 0)], new Set([1]), 0, rng)).toBeNull();
  });

  it('fra i visitati, estrazione pesata da quanto non ci passa nessuno, ripetibile col seme', () => {
    const list = [c(1, 2, 0, 9_000), c(2, 1, 0, 0), c(3, 4, 0, 9_990)];
    // Pesi: 1000 (minimo), 10000, 1000 (minimo): il tavolo 2 vince 10 volte su 12.
    const rngA = mulberry32(7);
    const rngB = mulberry32(7);
    const a = Array.from({ length: 50 }, () => pickVisit(list, new Set(), 10_000, rngA));
    const b = Array.from({ length: 50 }, () => pickVisit(list, new Set(), 10_000, rngB));
    expect(a).toEqual(b);
    const counts = new Map<number, number>();
    const rng = mulberry32(123);
    for (let i = 0; i < 1200; i++) {
      const id = pickVisit(list, new Set(), 10_000, rng)!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    expect(counts.get(2)! / 1200).toBeGreaterThan(0.75);
    expect(counts.get(2)! / 1200).toBeLessThan(0.91);
    // Una sola estrazione per scelta, e solo per i visitati.
    let calls = 0;
    pickVisit([c(9, 0, 0)], new Set(), 0, () => {
      calls++;
      return 0;
    });
    expect(calls).toBe(0);
    // Un orario illeggibile vale il peso minimo, non un NaN.
    expect(pickVisit([c(1, 1, 0, NaN)], new Set(), 5, () => 0.99)).toBe(1);
  });
});

/* ── Il giro in sala, col regista ─────────────────────────────────────── */

const ora = (hhmm: string, giorno = '2026-10-04') => new Date(`${giorno}T${hhmm}:00+02:00`).toISOString();
const NOW = Date.parse(ora('19:00'));
const SERVIZIO = liveService(new Date(NOW));
const PASSO = 33;

const tavolo = (id: number, x: number, y: number, room_id = 1): Table => ({
  id,
  name: String(id),
  shape: TableShape.RECTANGLE,
  seats: 4,
  x,
  y,
  room_id,
  status: TableStatus.FREE,
  rotation: 0,
});
const VERANDA: Room = { id: 1, name: 'Veranda', width: 1000, height: 600 };
const FIUME: Room = { id: 2, name: 'Fiume', width: 800, height: 500 };
const TAVOLI = [
  tavolo(1, 250, 120), tavolo(2, 430, 120), tavolo(3, 610, 120), tavolo(5, 790, 120),
  tavolo(6, 250, 360), tavolo(7, 430, 360), tavolo(8, 610, 360), tavolo(9, 790, 360),
  tavolo(4, 300, 200, 2),
];
const SEGNAPOSTO: FloorMarker[] = [
  { id: 1, room_id: 1, kind: 'ENTRANCE', x: 0, y: 300 } as FloorMarker,
  { id: 2, room_id: 1, kind: 'HOST_STAND', x: 60, y: 380 } as FloorMarker,
  { id: 3, room_id: 1, kind: 'PASS', x: 980, y: 60 } as FloorMarker,
  { id: 4, room_id: 2, kind: 'ENTRANCE', x: 0, y: 250 } as FloorMarker,
];
let seq = 800;
const prenotazione = (over: Partial<Reservation> = {}): Reservation => ({
  id: seq++,
  customer_name: 'Bianchi',
  reservation_time: ora('18:30'),
  shift: Shift.DINNER,
  guests: 2,
  table_id: 1,
  payment_status: PaymentStatus.PENDING,
  arrival_status: ArrivalStatus.ARRIVED,
  reservation_status: ReservationStatus.CONFIRMED,
  ...over,
});
const scena = (reservations: Reservation[]): SceneModel =>
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
  });

// Pause brevi: un giro in pochi secondi di tempo finto.
const SVELTI: Partial<DirectorTuning> = {
  waiterIdleMinMs: 100,
  waiterIdleMaxMs: 300,
  serveMinMs: 300,
  serveMaxMs: 600,
  passPauseMs: 100,
};

const regista = (tuning?: Partial<DirectorTuning>) => {
  const clock = { t: 10_000 };
  const d = new SceneDirector({ now: () => clock.t, seed: DIRECTOR_SEED, tuning });
  const events: DirectorEvent[] = [];
  d.onEvent(e => events.push(e));
  return { d, clock, events };
};

const camerieri = (d: SceneDirector, roomId: number) => d.actorsIn(roomId).filter(v => v.kind === 'waiter');
const fuori = (d: SceneDirector, roomId: number) =>
  d.inspect(roomId)!.waiters.filter(w => w.state !== 'AT_PASS' && w.state !== 'PAUSE').length;

describe('il giro dei camerieri', () => {
  const tavolata = [1, 2, 3, 5].map(t => prenotazione({ table_id: t }));
  const staff = [
    persona('g', 'Giulia', 'Hostess'),
    persona('m', 'Marco', 'Cameriere'),
    persona('s', 'Sara', 'Cameriera'),
  ];

  it('con il personale: l\'hostess della sala principale ha il nome, i camerieri stanno al pass', () => {
    const { d } = regista();
    d.configure({ staff, activeRoomId: 1 });
    const model = scena(tavolata);
    d.update(model, 'initial');
    expect(d.actorsIn(1)[0]).toMatchObject({ key: 'host:1', kind: 'hostess', label: 'Giulia' });
    expect(d.actorsIn(2)[0]).toMatchObject({ key: 'host:2', label: null });
    const room = model.rooms[0];
    const grid = buildNavGrid(room);
    const spots = passSlots(room, roomAnchors(room, grid), grid, 2);
    const ws = camerieri(d, 1);
    expect(ws.map(w => [w.key, w.label, w.tray, w.partyId])).toEqual([
      ['waiter:m', 'Marco', false, null],
      ['waiter:s', 'Sara', false, null],
    ]);
    ws.forEach((w, i) => {
      expect([w.x, w.z, w.yaw]).toEqual([spots[i].x, spots[i].z, spots[i].yaw]);
    });
    // I camerieri non sono figure: movingKeys non li conosce.
    expect([...d.movingKeys(1)]).toEqual(['host:1']);
    // Fermi a ristorante pieno: zero frame, e il canvas sa quando svegliarsi.
    expect(d.frameNeed()).toBe('none');
    const wake = d.wakeInMs()!;
    expect(wake).toBeGreaterThan(0);
    expect(wake).toBeLessThanOrEqual(6000);
    expect(d.isAnimating()).toBe(false);
  });

  it('senza personale letto nessuno; senza personale disponibile due di ripiego, uno a sala vuota', () => {
    const a = regista();
    a.d.update(scena(tavolata), 'initial');
    expect(camerieri(a.d, 1)).toEqual([]);
    expect(a.d.actorsIn(1).map(v => [v.key, v.label])).toEqual([['host:1', null]]);
    a.d.configure({ staff: null });
    expect(camerieri(a.d, 1).map(w => [w.key, w.label])).toEqual([['waiter:anon0', null], ['waiter:anon1', null]]);

    const b = regista();
    b.d.configure({ staff: null, activeRoomId: 2 });
    b.d.update(scena([]), 'initial');
    expect(camerieri(b.d, 1)).toEqual([]);
    expect(camerieri(b.d, 2).map(w => w.key)).toEqual(['waiter:anon0']);
  });

  it('partono dopo la pausa verso un tavolo, servono col vassoio, tornano al pass; frame d\'ambiente solo mentre camminano', () => {
    const { d } = regista(SVELTI);
    d.configure({ staff, activeRoomId: 1 });
    d.update(scena(tavolata), 'initial');
    const seen = new Set<string>();
    let ambient = 0;
    let none = 0;
    for (let t = 0; t < 20_000; t += PASSO) {
      d.step(PASSO);
      for (const w of d.inspect(1)!.waiters) {
        seen.add(w.state);
        if (w.state === 'TO_TABLE' || w.state === 'SERVE') expect(w.partyId).not.toBeNull();
      }
      const need = d.frameNeed();
      expect(need).not.toBe('active');
      if (need === 'ambient') ambient++;
      else none++;
      for (const v of camerieri(d, 1)) {
        const st = d.inspect(1)!.waiters.find(x => x.key === v.key)!.state;
        if (st === 'SERVE') expect(v.tray).toBe(true);
        if (st === 'AT_PASS') expect(v.tray).toBe(false);
      }
    }
    expect([...seen].sort()).toEqual(['AT_PASS', 'PAUSE', 'SERVE', 'TO_PASS', 'TO_TABLE']);
    expect(ambient).toBeGreaterThan(0);
    expect(none).toBeGreaterThan(0);
    // I camerieri non tengono mai acceso il regista.
    expect(d.isAnimating()).toBe(false);
  });

  it('il primo tavolo visitato è quello appena seduto (dopo l\'accompagnamento), non i già presenti', () => {
    const { d, clock } = regista(SVELTI);
    d.configure({ staff: [persona('m', 'Marco')], activeRoomId: 1 });
    const nuovi = prenotazione({ table_id: 8, arrival_status: ArrivalStatus.WAITING, reservation_time: ora('18:55') });
    d.update(scena([...tavolata, nuovi]), 'initial');
    clock.t += 5000;
    d.update(scena([...tavolata, { ...nuovi, arrival_status: ArrivalStatus.ARRIVED }]), null);
    let ended = false;
    let firstAfter: number | null = null;
    d.onEvent(e => {
      if (e.kind === 'escort-end') ended = true;
    });
    for (let t = 0; t < 60_000 && firstAfter === null; t += PASSO) {
      const before = d.inspect(1)!.waiters[0];
      d.step(PASSO);
      const w = d.inspect(1)!.waiters[0];
      if (ended && before.state !== 'TO_TABLE' && w.state === 'TO_TABLE') firstAfter = w.partyId;
    }
    expect(ended).toBe(true);
    expect(firstAfter).toBe(nuovi.id);
  });

  it('al più 8 camerieri in giro per sala (e il tetto si cambia)', () => {
    const tante = [1, 2, 3, 5, 6, 7, 8, 9].map(t => prenotazione({ table_id: t }));
    const nove = Array.from({ length: 9 }, (_, i) => persona(String(i), `C${i}`));
    const { d } = regista(SVELTI);
    d.configure({ staff: nove, activeRoomId: 1 });
    d.update(scena(tante), 'initial');
    expect(camerieri(d, 1).length).toBe(9);
    let max = 0;
    for (let t = 0; t < 20_000; t += PASSO) {
      d.step(PASSO);
      max = Math.max(max, fuori(d, 1));
    }
    expect(max).toBeLessThanOrEqual(8);
    expect(max).toBeGreaterThan(4);

    const tre = regista({ ...SVELTI, walkingWaitersMax: 3 });
    tre.d.configure({ staff: nove.slice(0, 5), activeRoomId: 1 });
    tre.d.update(scena(tante), 'initial');
    let max3 = 0;
    for (let t = 0; t < 20_000; t += PASSO) {
      tre.d.step(PASSO);
      max3 = Math.max(max3, fuori(tre.d, 1));
    }
    expect(max3).toBe(3);
  });

  it('fermi col movimento ridotto e in modalità lenta; spariti in modalità leggera', () => {
    for (const mode of [{ reducedMotion: true }, { slowMode: true }]) {
      const { d } = regista(SVELTI);
      d.configure({ staff, activeRoomId: 1, ...mode });
      d.update(scena(tavolata), 'initial');
      const at = camerieri(d, 1).map(w => [w.key, w.x, w.z, w.yaw]);
      expect(at.length).toBe(2);
      for (let t = 0; t < 10_000; t += PASSO) d.step(PASSO);
      expect(camerieri(d, 1).map(w => [w.key, w.x, w.z, w.yaw])).toEqual(at);
      expect(d.frameNeed()).toBe('none');
      expect(d.wakeInMs()).toBeNull();
    }
    const { d } = regista(SVELTI);
    d.configure({ staff, activeRoomId: 1 });
    d.update(scena(tavolata), 'initial');
    for (let t = 0; t < 2000; t += PASSO) d.step(PASSO);
    d.configure({ lightMode: true });
    expect(camerieri(d, 1)).toEqual([]);
    expect(d.frameNeed()).toBe('none');
    d.configure({ lightMode: false });
    expect(camerieri(d, 1).length).toBe(2);
  });

  it('un cambio di turno vale fra un compito e l\'altro: chi esce svanisce al pass, chi entra compare', () => {
    const { d } = regista(SVELTI);
    d.configure({ staff, activeRoomId: 1 });
    d.update(scena(tavolata), 'initial');
    for (let t = 0; t < 1500; t += PASSO) d.step(PASSO);
    d.configure({ staff: [staff[0], staff[1], persona('l', 'Luca')] });
    const states = new Map<string, Set<string>>();
    for (let t = 0; t < 20_000; t += PASSO) {
      d.step(PASSO);
      for (const w of d.inspect(1)!.waiters) {
        if (!states.has(w.key)) states.set(w.key, new Set());
        states.get(w.key)!.add(w.state);
      }
    }
    expect(states.get('waiter:s')?.has('FADE_OUT')).toBe(true);
    expect(states.get('waiter:l')?.has('FADE_IN')).toBe(true);
    expect(camerieri(d, 1).map(w => w.key).sort()).toEqual(['waiter:l', 'waiter:m']);
    expect(camerieri(d, 1).find(w => w.key === 'waiter:l')!.label).toBe('Luca');
  });

  it('a fermo il tempo passa tutto: dopo un sonno lungo il cameriere riparte senza saltare', () => {
    const { d } = regista(SVELTI);
    d.configure({ staff: [persona('m', 'Marco')], activeRoomId: 1 });
    d.update(scena(tavolata), 'initial');
    expect(d.frameNeed()).toBe('none');
    const w0 = camerieri(d, 1)[0];
    const x0 = w0.x;
    const z0 = w0.z;
    d.step(60_000);
    const w1 = camerieri(d, 1)[0];
    expect(Math.hypot(w1.x - x0, w1.z - z0)).toBeLessThanOrEqual(1.3 * 0.1 + 1e-9);
    expect(d.inspect(1)!.waiters[0].state).toBe('TO_TABLE');
    expect(d.frameNeed()).toBe('ambient');
  });

  it('a schermo fermo (il canvas dorme fino a wakeInMs) il giro dura come a 30 fps: la pausa al pass non si conta due volte', () => {
    const giro = (dorme: boolean) => {
      const { d } = regista();
      d.configure({ staff: [persona('m', 'Marco')], activeRoomId: 1 });
      d.update(scena([prenotazione({ table_id: 2 })]), 'initial');
      // Gli istanti in cui parte dal pass verso un tavolo.
      const partenze: number[] = [];
      let t = 0;
      let last = '';
      for (let i = 0; i < 100_000 && partenze.length < 4; i++) {
        let dt = PASSO;
        if (dorme && d.frameNeed() === 'none') {
          const w = d.wakeInMs();
          dt = w === null ? 1000 : Math.max(1, w);
        }
        d.step(dt);
        t += dt;
        const st = d.inspect(1)!.waiters[0].state;
        if (st === 'TO_TABLE' && last !== 'TO_TABLE') partenze.push(t);
        last = st;
      }
      return partenze;
    };
    const svegli = giro(false);
    const dormienti = giro(true);
    expect(svegli.length).toBe(4);
    expect(dormienti.length).toBe(4);
    // Le stesse partenze, a meno di qualche passo per giro (svegli ogni
    // cambio di stato cade al frame dopo, e lo scarto si somma); con la pausa
    // contata due volte erano secondi.
    for (let k = 0; k < svegli.length; k++) expect(Math.abs(dormienti[k] - svegli[k]), `partenza ${k}`).toBeLessThanOrEqual((k + 1) * 4 * PASSO);
  });

  it('dopo la scheda nascosta (fastForward e un primo frame lunghissimo) i camerieri non partono tutti insieme', () => {
    const { d } = regista();
    d.configure({ staff: [persona('m', 'Marco'), persona('s', 'Sara'), persona('l', 'Luca')], activeRoomId: 1 });
    d.update(scena([1, 2, 3, 5, 6].map(t => prenotazione({ table_id: t }))), 'initial');
    d.fastForward();
    // Il primo frame al ritorno porta tutto il tempo passato nascosti.
    d.step(120_000);
    expect(fuori(d, 1)).toBeLessThanOrEqual(1);
    // E poi uno alla volta, ognuno alla fine della sua pausa.
    const partenze: number[] = [];
    let prima = fuori(d, 1);
    for (let t = 0; t < 10_000; t += PASSO) {
      d.step(PASSO);
      const ora = fuori(d, 1);
      if (ora > prima) partenze.push(t);
      prima = ora;
    }
    expect(partenze.length).toBeGreaterThanOrEqual(1);
    expect(new Set(partenze).size).toBe(partenze.length);
  });

  it('una comitiva che se ne va mentre il cameriere ci va: ne sceglie un\'altra, o torna al pass', () => {
    const { d, clock } = regista({ ...SVELTI, serveMinMs: 20_000, serveMaxMs: 20_000 });
    d.configure({ staff: [persona('m', 'Marco')], activeRoomId: 1 });
    const sola = [prenotazione({ table_id: 6 })];
    d.update(scena(sola), 'initial');
    for (let t = 0; t < 40_000 && d.inspect(1)!.waiters[0].state !== 'SERVE'; t += PASSO) d.step(PASSO);
    expect(d.inspect(1)!.waiters[0]).toMatchObject({ state: 'SERVE', partyId: sola[0].id });
    clock.t += 3000;
    d.update(scena([{ ...sola[0], arrival_status: ArrivalStatus.DEPARTED }]), null);
    expect(d.inspect(1)!.waiters[0]).toMatchObject({ state: 'TO_PASS', partyId: null });
  });

  it('quando un\'altra sala si riempie un cameriere ci va: svanisce al pass, ricompare all\'altro', () => {
    const { d, clock } = regista(SVELTI);
    d.configure({ staff: [persona('m', 'Marco'), persona('s', 'Sara')], activeRoomId: 1 });
    const a = prenotazione({ table_id: 1 });
    const b = prenotazione({ table_id: 4, arrival_status: ArrivalStatus.WAITING });
    d.update(scena([a, b]), 'initial');
    expect(camerieri(d, 1).map(w => w.key)).toEqual(['waiter:m', 'waiter:s']);
    clock.t += 3000;
    d.update(scena([a, { ...b, arrival_status: ArrivalStatus.ARRIVED }]), 'refetch');
    const seen: string[] = [];
    for (let t = 0; t < 30_000 && camerieri(d, 2).length === 0; t += PASSO) {
      d.step(PASSO);
      const s1 = d.inspect(1)!.waiters.find(w => w.key === 'waiter:s')?.state;
      if (s1 && seen[seen.length - 1] !== s1) seen.push(s1);
    }
    expect(seen).toContain('FADE_OUT');
    expect(camerieri(d, 2).map(w => [w.key, w.fade < 1])).toEqual([['waiter:s', true]]);
    expect(camerieri(d, 1).map(w => w.key)).toEqual(['waiter:m']);
    // E se la sala si svuota mentre svanisce, torna dov'era invece di sparire.
    const { d: d2, clock: c2 } = regista(SVELTI);
    d2.configure({ staff: [persona('m', 'Marco'), persona('s', 'Sara')], activeRoomId: 1 });
    d2.update(scena([a, b]), 'initial');
    c2.t += 3000;
    d2.update(scena([a, { ...b, arrival_status: ArrivalStatus.ARRIVED }]), 'refetch');
    for (let t = 0; t < 30_000 && d2.inspect(1)!.waiters.find(w => w.key === 'waiter:s')?.state !== 'FADE_OUT'; t += PASSO) d2.step(PASSO);
    c2.t += 3000;
    d2.update(scena([a, b]), 'refetch');
    for (let t = 0; t < 2000; t += PASSO) d2.step(PASSO);
    expect(camerieri(d2, 1).map(w => w.key).sort()).toEqual(['waiter:m', 'waiter:s']);
    expect(camerieri(d2, 2)).toEqual([]);
  });

  it('stesso seme e stesso personale: lo stesso giro', () => {
    const giro = () => {
      const { d } = regista(SVELTI);
      d.configure({ staff, activeRoomId: 1 });
      d.update(scena(tavolata), 'initial');
      const out: string[] = [];
      for (let i = 0; i < 300; i++) {
        d.step(PASSO);
        out.push(JSON.stringify(camerieri(d, 1)));
      }
      return out;
    };
    expect(giro()).toEqual(giro());
  });
});
