import { describe, it, expect } from 'vitest';
import { Shift, type TableMerge } from '../../types';
import {
  OVERRIDES_EVENTS,
  applyEvent,
  applyFetch,
  emptyOverrides,
  fetchVerdict,
  nextSettled,
  overridesEvent,
  overridesFor,
  serviceKeyOf,
  type OverridesFetch,
  type OverridesSnapshot,
} from '../../components/salaVivo/model/overrides';

/* Le varianti del servizio (unioni, tavoli nascosti, sale chiuse) della Sala
 * dal vivo: i passaggi che useServiceOverrides e la pagina applicano. Sono i
 * punti dove una corsa fa danni senza rumore: la risposta del servizio di
 * prima che arriva dopo il cambio, un evento sotto una lettura più vecchia,
 * un evento di un altro turno. */

const PRANZO = { date: '2026-10-04', shift: Shift.LUNCH };
const CENA = { date: '2026-10-04', shift: Shift.DINNER };
const K_PRANZO = serviceKeyOf(PRANZO.date, PRANZO.shift);
const K_CENA = serviceKeyOf(CENA.date, CENA.shift);

const unione = (s: { date: string; shift: Shift }, primary_id: number, merged_ids: number[]): TableMerge =>
  ({ id: primary_id, date: s.date, shift: s.shift, primary_id, merged_ids });

const ok = (value: unknown): PromiseSettledResult<unknown> => ({ status: 'fulfilled', value });
const ko: PromiseSettledResult<unknown> = { status: 'rejected', reason: new Error('rete giù') };

const letture = (over: Partial<OverridesFetch> = {}): OverridesFetch => ({
  merges: ok([]),
  hidden: ok([]),
  closed: ok([]),
  ...over,
});

describe('le letture del servizio', () => {
  it('la risposta di un servizio già superato non si applica', () => {
    // Cena chiesta alle 16:59, e alle 17:00... no: pranzo chiesto, poi è
    // scattata la cena. L'effetto del pranzo è stato pulito.
    expect(fetchVerdict(true, 0, 0)).toBe('drop');
    expect(fetchVerdict(true, 0, 3)).toBe('drop');
  });

  it('anche applicata per sbaglio, quella del servizio di prima non si vede in quello nuovo', () => {
    const pranzo = applyFetch(emptyOverrides(K_CENA), K_PRANZO, letture({ merges: ok([unione(PRANZO, 1, [2])]) }));
    expect(pranzo.key).toBe(K_PRANZO);
    // Chi chiede la cena vede vuoto, e non ancora pronto.
    expect(overridesFor(pranzo, K_CENA)).toEqual({
      merges: [],
      hiddenTableIds: new Set(),
      closedRoomIds: new Set(),
      ready: false,
      reads: 0,
    });
    // E la lettura della cena non parte dalle unioni del pranzo.
    const cena = applyFetch(pranzo, K_CENA, letture({ hidden: ok([{ table_id: 7 }]) }));
    expect(cena.merges).toEqual([]);
    expect([...cena.hiddenTableIds]).toEqual([7]);
    expect(overridesFor(cena, K_CENA).ready).toBe(true);
  });

  it('un evento arrivato durante una lettura la fa rifare', () => {
    expect(fetchVerdict(false, 4, 5)).toBe('refetch');
    expect(fetchVerdict(false, 4, 4)).toBe('apply');
  });

  it('vale quello che arriva: una lettura fallita lascia quello che c\'era', () => {
    const prima = applyFetch(emptyOverrides(K_CENA), K_CENA, letture({
      merges: ok([unione(CENA, 1, [2])]),
      closed: ok([{ room_id: 3 }]),
    }));
    const rilettura = applyFetch(prima, K_CENA, letture({ merges: ko, closed: ko, hidden: ok([{ table_id: 9 }]) }));
    expect(rilettura.merges).toBe(prima.merges);
    expect(rilettura.closedRoomIds).toBe(prima.closedRoomIds);
    expect([...rilettura.hiddenTableIds]).toEqual([9]);
    // Al primo caricamento, tutto fallito: vuoto, ma il caricamento è finito.
    const fallita = applyFetch(emptyOverrides(K_CENA), K_CENA, letture({ merges: ko, hidden: ko, closed: ko }));
    expect(fallita.ready).toBe(true);
    expect(fallita.merges).toEqual([]);
  });

  it('una rilettura identica tiene le stesse istanze: la sala non si ricalcola', () => {
    const fetched = letture({ merges: ok([unione(CENA, 1, [2])]), hidden: ok([{ table_id: 4 }]), closed: ok([{ room_id: 2 }]) });
    const prima = applyFetch(emptyOverrides(K_CENA), K_CENA, fetched);
    const dopo = applyFetch(prima, K_CENA, letture({
      merges: ok([unione(CENA, 1, [2])]),
      hidden: ok([{ table_id: 4 }]),
      closed: ok([{ room_id: 2 }]),
    }));
    expect(dopo.merges).toBe(prima.merges);
    expect(dopo.hiddenTableIds).toBe(prima.hiddenTableIds);
    expect(dopo.closedRoomIds).toBe(prima.closedRoomIds);
  });

  it('righe rotte non fanno cadere niente', () => {
    const s = applyFetch(emptyOverrides(K_CENA), K_CENA, letture({
      merges: ok([null, { date: CENA.date, shift: CENA.shift, primary_id: 1, merged_ids: 'x' }, unione(CENA, 5, [6])]),
      hidden: ok('non è una lista'),
      closed: ok([{ room_id: 'x' }, null, { room_id: 8 }]),
    }));
    expect(s.merges.map(m => m.primary_id)).toEqual([5]);
    expect([...s.hiddenTableIds]).toEqual([]);
    expect([...s.closedRoomIds]).toEqual([8]);
  });
});

describe('gli eventi del socket', () => {
  const cena: OverridesSnapshot = { ...emptyOverrides(K_CENA), ready: true };

  it('un evento di un altro giorno o di un altro turno non conta', () => {
    for (const event of OVERRIDES_EVENTS) {
      const altroTurno = { ...unione(PRANZO, 1, [2]), table_id: 1, room_id: 1 };
      const altroGiorno = { ...unione({ date: '2026-10-05', shift: Shift.DINNER }, 1, [2]), table_id: 1, room_id: 1 };
      expect(overridesEvent(event, altroTurno, CENA.date, CENA.shift), event).toBeNull();
      expect(overridesEvent(event, altroGiorno, CENA.date, CENA.shift), event).toBeNull();
    }
  });

  it('un evento che non si legge non conta', () => {
    for (const payload of [null, undefined, 'x', { date: CENA.date }, { shift: CENA.shift, primary_id: 1 }]) {
      for (const event of OVERRIDES_EVENTS) expect(overridesEvent(event, payload, CENA.date, CENA.shift)).toBeNull();
    }
  });

  it('le unioni si sostituiscono per capofila e si tolgono', () => {
    const crea = overridesEvent('tableMerge:created', unione(CENA, 1, [2]), CENA.date, CENA.shift)!;
    const una = applyEvent(cena, K_CENA, crea);
    expect(una.merges.map(m => [m.primary_id, m.merged_ids])).toEqual([[1, [2]]]);
    const allarga = overridesEvent('tableMerge:created', unione(CENA, 1, [2, 3]), CENA.date, CENA.shift)!;
    expect(applyEvent(una, K_CENA, allarga).merges.map(m => [m.primary_id, m.merged_ids])).toEqual([[1, [2, 3]]]);
    const togli = overridesEvent('tableMerge:deleted', { date: CENA.date, shift: CENA.shift, primary_id: 1 }, CENA.date, CENA.shift)!;
    expect(applyEvent(una, K_CENA, togli).merges).toEqual([]);
  });

  it('nascosti e sale chiuse si aggiungono e si tolgono; un evento che non sposta niente lascia la stessa foto', () => {
    const nascondi = overridesEvent('tableHidden:created', { date: CENA.date, shift: CENA.shift, table_id: 7 }, CENA.date, CENA.shift)!;
    const nascosto = applyEvent(cena, K_CENA, nascondi);
    expect([...nascosto.hiddenTableIds]).toEqual([7]);
    // Lo stesso evento due volte (l'eco): stessa foto, nessun ricalcolo.
    expect(applyEvent(nascosto, K_CENA, nascondi)).toBe(nascosto);
    const mostra = overridesEvent('tableHidden:deleted', { date: CENA.date, shift: CENA.shift, table_id: 7 }, CENA.date, CENA.shift)!;
    expect([...applyEvent(nascosto, K_CENA, mostra).hiddenTableIds]).toEqual([]);
    const chiudi = overridesEvent('roomClosed:created', { date: CENA.date, shift: CENA.shift, room_id: 2 }, CENA.date, CENA.shift)!;
    expect([...applyEvent(cena, K_CENA, chiudi).closedRoomIds]).toEqual([2]);
    // Un evento del servizio che qui non sposta niente è comunque un
    // aggiornamento: conta come cambiamento per le letture in corso.
    const giàAperta = overridesEvent('roomClosed:deleted', { date: CENA.date, shift: CENA.shift, room_id: 5 }, CENA.date, CENA.shift);
    expect(giàAperta).not.toBeNull();
    expect(applyEvent(cena, K_CENA, giàAperta!)).toBe(cena);
  });

  it('un evento applicato mentre il servizio cambiava non sporca quello nuovo', () => {
    const nascondi = overridesEvent('tableHidden:created', { date: PRANZO.date, shift: PRANZO.shift, table_id: 7 }, PRANZO.date, PRANZO.shift)!;
    // L'aggiornamento è del pranzo, la foto è già della cena.
    expect(applyEvent(cena, K_PRANZO, nascondi)).toBe(cena);
  });
});

describe('con quali varianti disegna la pagina', () => {
  const vuote = { merges: [] as TableMerge[], hiddenTableIds: new Set<number>(), closedRoomIds: new Set<number>() };

  it('al primo caricamento si aspetta che siano pronte', () => {
    expect(nextSettled(null, K_PRANZO, { ...vuote, ready: false })).toBeNull();
    const primo = nextSettled(null, K_PRANZO, { ...vuote, ready: true, reads: 1 });
    expect(primo).toEqual({ key: K_PRANZO, value: vuote, reads: 1 });
  });

  it('al cambio di servizio le stesse istanze di prima vogliono dire «ancora il servizio di prima»', () => {
    const pranzo = { merges: [unione(PRANZO, 1, [2])], hiddenTableIds: new Set([4]), closedRoomIds: new Set<number>() };
    const disegnate = nextSettled(null, K_PRANZO, { ...pranzo, ready: true })!;
    // Nel giro del cambio l'hook ha ancora in mano le varianti del pranzo.
    expect(nextSettled(disegnate, K_CENA, { ...pranzo, ready: true })).toBeNull();
    // Mentre la cena si carica si tengono quelle disegnate.
    expect(nextSettled(disegnate, K_CENA, { ...vuote, ready: false })).toBeNull();
    // Arrivate quelle della cena, si passa.
    const cena = { merges: [] as TableMerge[], hiddenTableIds: new Set([9]), closedRoomIds: new Set<number>() };
    expect(nextSettled(disegnate, K_CENA, { ...cena, ready: true, reads: 1 })).toEqual({ key: K_CENA, value: cena, reads: 1 });
  });

  it('nello stesso servizio ogni cambiamento passa subito', () => {
    const prima = nextSettled(null, K_CENA, { ...vuote, ready: true })!;
    const unite = { ...vuote, merges: [unione(CENA, 1, [2])] };
    expect(nextSettled(prima, K_CENA, { ...unite, ready: true })).toEqual({ key: K_CENA, value: unite, reads: 0 });
  });

  it('le 17:00: finché non arrivano le varianti della cena la chiave resta il pranzo (la pagina non aggiorna il regista)', () => {
    // Il pranzo letto, con un'unione.
    const lettoPranzo = applyFetch(emptyOverrides(K_PRANZO), K_PRANZO, letture({ merges: ok([unione(PRANZO, 1, [2])]) }));
    const pranzo = nextSettled(null, K_PRANZO, overridesFor(lettoPranzo, K_PRANZO))!;
    expect(pranzo).toMatchObject({ key: K_PRANZO, reads: 1 });
    // 17:00: l'hook ha ancora la foto del pranzo, la cena non è pronta.
    expect(nextSettled(pranzo, K_CENA, overridesFor(lettoPranzo, K_CENA))).toBeNull();
    // Arrivate quelle della cena (nessuna unione): la chiave è la cena.
    const lettaCena = applyFetch(lettoPranzo, K_CENA, letture());
    const cena = nextSettled(pranzo, K_CENA, overridesFor(lettaCena, K_CENA))!;
    expect(cena.key).toBe(K_CENA);
    expect(cena.value.merges).toEqual([]);
  });

  it('le varianti vuote di sempre: la chiave passa al servizio nuovo con lo stesso valore, senza aspettare per sempre', () => {
    const lettoPranzo = applyFetch(emptyOverrides(K_PRANZO), K_PRANZO, letture());
    const pranzo = nextSettled(null, K_PRANZO, overridesFor(lettoPranzo, K_PRANZO))!;
    expect(nextSettled(pranzo, K_CENA, overridesFor(lettoPranzo, K_CENA))).toBeNull();
    const lettaCena = applyFetch(lettoPranzo, K_CENA, letture());
    // Le stesse istanze vuote del pranzo: niente da aspettare.
    expect(lettaCena.merges).toBe(lettoPranzo.merges);
    const cena = nextSettled(pranzo, K_CENA, overridesFor(lettaCena, K_CENA))!;
    expect(cena.key).toBe(K_CENA);
    // Lo stesso valore: il modello non si ricalcola.
    expect(cena.value).toBe(pranzo.value);
  });

  it('una rilettura conta (reads), un evento no: alla riconnessione la pagina la mette in scena già conclusa', () => {
    const prima = applyFetch(emptyOverrides(K_CENA), K_CENA, letture());
    expect(prima.reads).toBe(1);
    const nascondi = overridesEvent('tableHidden:created', { date: CENA.date, shift: CENA.shift, table_id: 7 }, CENA.date, CENA.shift)!;
    const dopoEvento = applyEvent(prima, K_CENA, nascondi);
    expect(dopoEvento.reads).toBe(1);
    const riletta = applyFetch(dopoEvento, K_CENA, letture({ hidden: ok([{ table_id: 7 }, { table_id: 8 }]) }));
    expect(riletta.reads).toBe(2);
    const a = nextSettled(null, K_CENA, overridesFor(dopoEvento, K_CENA))!;
    const b = nextSettled(a, K_CENA, overridesFor(riletta, K_CENA))!;
    expect([a.reads, b.reads]).toEqual([1, 2]);
  });
});
