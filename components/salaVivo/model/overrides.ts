import type { TableMerge } from '../../../types';
import type { ServiceOverrides } from '../types';

/* Le varianti di un servizio (unioni, tavoli nascosti, sale chiuse) come
 * passaggi puri: useServiceOverrides li applica coi dati della rete e degli
 * eventi, la pagina con useSettledOverrides. Qui, fuori dagli hook, perché
 * sono i punti dove una corsa fa danni senza far rumore (una risposta del
 * servizio di prima applicata a quello nuovo, un evento perso sotto una
 * lettura più vecchia) e i test li devono poter provare uno per uno.
 *
 * Niente React, niente rete: la pagina lo importa, e finisce nel suo chunk. */

/** Le varianti di un servizio, con la chiave del servizio a cui appartengono. */
export interface OverridesSnapshot extends ServiceOverrides {
  /** `${date}:${shift}`. */
  key: string;
  /** Quante letture complete del servizio sono arrivate (applyFetch; gli
   *  eventi socket no). Una rilettura è un riallineamento, come l'epoca
   *  delle prenotazioni: alla riconnessione la pagina la mette in scena già
   *  conclusa invece di animare le unioni fatte mentre era senza rete. */
  reads: number;
}

/** Quello che l'hook restituisce: le varianti, e quante letture complete. */
export interface ReadOverrides extends ServiceOverrides {
  reads: number;
}

const EMPTY_MERGES: TableMerge[] = [];
const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

export const serviceKeyOf = (date: string, shift: string): string => `${date}:${shift}`;

/** Un servizio appena scelto: niente varianti, e ancora da leggere. Sempre le
 *  stesse istanze vuote: la pagina riconosce «niente di nuovo» dall'identità. */
export const emptyOverrides = (key: string): OverridesSnapshot => ({
  key,
  merges: EMPTY_MERGES,
  hiddenTableIds: EMPTY_IDS,
  closedRoomIds: EMPTY_IDS,
  ready: false,
  reads: 0,
});

/** Quello che l'hook restituisce per il servizio `key`: la foto solo se è di
 *  quel servizio. Nel render in cui il servizio cambia la foto è ancora del
 *  precedente, e le sue unioni non devono comparire nemmeno per un attimo. */
export function overridesFor(snap: OverridesSnapshot, key: string): ReadOverrides {
  const current = snap.key === key ? snap : emptyOverrides(key);
  return {
    merges: current.merges,
    hiddenTableIds: current.hiddenTableIds,
    closedRoomIds: current.closedRoomIds,
    ready: current.ready,
    reads: current.reads,
  };
}

// Lettura difensiva: rotte ed eventi arrivano da un server che può essere di
// un deploy diverso, e un merged_ids che non è un array farebbe cadere la
// pagina nel modello.
const toMerge = (v: unknown): TableMerge | null => {
  const m = v as Partial<TableMerge> | null;
  if (!m || typeof m.date !== 'string' || typeof m.shift !== 'string') return null;
  const primary = Number(m.primary_id);
  if (!Number.isInteger(primary) || !Array.isArray(m.merged_ids)) return null;
  return {
    id: Number(m.id),
    date: m.date,
    shift: m.shift as TableMerge['shift'],
    primary_id: primary,
    merged_ids: m.merged_ids.map(Number).filter(Number.isInteger),
  };
};

// Una riga di tavolo nascosto o sala chiusa: data, turno e l'id che conta.
const toOverride = (v: unknown, field: 'table_id' | 'room_id'): { date: string; shift: string; id: number } | null => {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r.date !== 'string' || typeof r.shift !== 'string') return null;
  const id = Number(r[field]);
  return Number.isInteger(id) ? { date: r.date, shift: r.shift, id } : null;
};

const mergesFrom = (list: unknown): TableMerge[] =>
  Array.isArray(list) ? list.map(toMerge).filter((m): m is TableMerge => m !== null) : [];

const idsFrom = (list: unknown, field: 'table_id' | 'room_id'): Set<number> => {
  const ids = new Set<number>();
  if (!Array.isArray(list)) return ids;
  for (const row of list) {
    const id = Number((row as Record<string, unknown> | null)?.[field]);
    if (Number.isInteger(id)) ids.add(id);
  }
  return ids;
};

// Un insieme nuovo solo se è cambiato davvero: il modello della sala si
// ricalcola sulle identità, e una ricarica identica non deve ridisegnarla.
const sameIds = (a: ReadonlySet<number>, b: ReadonlySet<number>): boolean =>
  a.size === b.size && [...a].every(id => b.has(id));

const mergeSig = (merges: readonly TableMerge[]): string =>
  merges.map(m => `${m.primary_id}:${m.merged_ids.join(',')}`).sort().join('|');

/** Che fare della risposta di una lettura.
 *
 * - 'drop': la lettura è di un servizio già superato (l'effetto che l'ha
 *   lanciata è stato pulito): non si applica.
 * - 'refetch': dopo il suo avvio è arrivato un evento del servizio. La
 *   risposta è una foto più vecchia di quello che si vede, e applicarla
 *   cancellerebbe l'evento: si rilegge.
 * - 'apply': si applica. */
export type FetchVerdict = 'drop' | 'refetch' | 'apply';

export function fetchVerdict(cancelled: boolean, changesAtStart: number, changesNow: number): FetchVerdict {
  if (cancelled) return 'drop';
  return changesNow !== changesAtStart ? 'refetch' : 'apply';
}

/** Le tre letture del servizio, com'escono da Promise.allSettled. */
export interface OverridesFetch {
  merges: PromiseSettledResult<unknown>;
  hidden: PromiseSettledResult<unknown>;
  closed: PromiseSettledResult<unknown>;
}

/** La foto dopo le letture del servizio `key`. Vale quello che è arrivato: una
 *  lettura fallita lascia vuoto, o in una rilettura quello che c'era. Le
 *  istanze restano le stesse quando il contenuto non cambia. `ready` diventa
 *  vero anche se tutte e tre sono fallite: il primo caricamento è concluso. */
export function applyFetch(prev: OverridesSnapshot, key: string, fetched: OverridesFetch): OverridesSnapshot {
  // Una foto di un altro servizio non fa da base: le sue unioni non sono
  // di questo.
  const base = prev.key === key ? prev : emptyOverrides(key);
  const nextMerges = fetched.merges.status === 'fulfilled' ? mergesFrom(fetched.merges.value) : base.merges;
  const nextHidden = fetched.hidden.status === 'fulfilled' ? idsFrom(fetched.hidden.value, 'table_id') : base.hiddenTableIds;
  const nextClosed = fetched.closed.status === 'fulfilled' ? idsFrom(fetched.closed.value, 'room_id') : base.closedRoomIds;
  return {
    key,
    merges: mergeSig(nextMerges) === mergeSig(base.merges) ? base.merges : nextMerges,
    hiddenTableIds: sameIds(nextHidden, base.hiddenTableIds) ? base.hiddenTableIds : nextHidden,
    closedRoomIds: sameIds(nextClosed, base.closedRoomIds) ? base.closedRoomIds : nextClosed,
    ready: true,
    reads: base.reads + 1,
  };
}

/** Gli eventi socket che toccano le varianti di un servizio. */
export const OVERRIDES_EVENTS = [
  'tableMerge:created',
  'tableMerge:deleted',
  'tableHidden:created',
  'tableHidden:deleted',
  'roomClosed:created',
  'roomClosed:deleted',
] as const;
export type OverridesEvent = (typeof OVERRIDES_EVENTS)[number];

export type OverridesUpdate = (prev: OverridesSnapshot) => OverridesSnapshot;

const toggleId = (target: 'hiddenTableIds' | 'closedRoomIds', id: number, add: boolean): OverridesUpdate =>
  prev => {
    const current = prev[target];
    if (current.has(id) === add) return prev;
    const next = new Set(current);
    if (add) next.add(id);
    else next.delete(id);
    return target === 'hiddenTableIds' ? { ...prev, hiddenTableIds: next } : { ...prev, closedRoomIds: next };
  };

/** Un evento socket letto per il servizio (date, shift): l'aggiornamento da
 *  applicare, o null se non è di questo servizio o non si legge. Un evento
 *  del servizio che qui non sposta niente dà comunque un aggiornamento (che
 *  restituisce la foto com'è): conta come cambiamento, perché una lettura
 *  partita prima potrebbe non contenerlo. La logica è quella di FloorPlan:
 *  un'unione si sostituisce per capofila, gli id si aggiungono e si tolgono. */
export function overridesEvent(event: OverridesEvent, payload: unknown, date: string, shift: string): OverridesUpdate | null {
  const ofService = (p: { date: string; shift: string }) => p.date === date && p.shift === shift;
  switch (event) {
    case 'tableMerge:created': {
      const m = toMerge(payload);
      if (!m || !ofService(m)) return null;
      return prev => {
        const i = prev.merges.findIndex(p => p.primary_id === m.primary_id);
        if (i < 0) return { ...prev, merges: [...prev.merges, m] };
        const next = [...prev.merges];
        next[i] = m;
        return { ...prev, merges: next };
      };
    }
    case 'tableMerge:deleted': {
      const m = payload as { date?: unknown; shift?: unknown; primary_id?: unknown } | null;
      const primary = Number(m?.primary_id);
      if (!m || typeof m.date !== 'string' || typeof m.shift !== 'string' || !Number.isInteger(primary)) return null;
      if (!ofService({ date: m.date, shift: m.shift })) return null;
      return prev => {
        const next = prev.merges.filter(p => p.primary_id !== primary);
        return next.length === prev.merges.length ? prev : { ...prev, merges: next };
      };
    }
    case 'tableHidden:created':
    case 'tableHidden:deleted': {
      const o = toOverride(payload, 'table_id');
      if (!o || !ofService(o)) return null;
      return toggleId('hiddenTableIds', o.id, event === 'tableHidden:created');
    }
    case 'roomClosed:created':
    case 'roomClosed:deleted': {
      const o = toOverride(payload, 'room_id');
      if (!o || !ofService(o)) return null;
      return toggleId('closedRoomIds', o.id, event === 'roomClosed:created');
    }
    default:
      return null;
  }
}

/** Applica un aggiornamento solo alla foto del servizio `key`: un evento
 *  arrivato mentre il servizio cambiava non sporca quello nuovo. */
export function applyEvent(prev: OverridesSnapshot, key: string, update: OverridesUpdate): OverridesSnapshot {
  return prev.key === key ? update(prev) : prev;
}

/** Le varianti con cui la pagina disegna, il servizio a cui appartengono, e
 *  la lettura completa da cui vengono. */
export interface SettledOverrides {
  key: string;
  value: Omit<ServiceOverrides, 'ready'>;
  reads: number;
}

/** Il prossimo valore con cui la pagina disegna, o null per tenere quello che
 *  ha.
 *
 * Al primo caricamento si aspetta `ready`: senza, un'unione appena letta
 * farebbe saltare i tavoli da separati a uniti sotto gli occhi. Al cambio di
 * servizio (le 17:00, le 05:00) si tengono le ultime buone finché quelle del
 * servizio nuovo non arrivano: la sala resta disegnata invece di tornare al
 * caricamento. Le stesse istanze già disegnate sotto una chiave nuova vogliono
 * dire «ancora le varianti di prima» (l'hook le azzera subito dopo), e si
 * aspetta. Tranne le istanze vuote di sempre: un servizio letto senza
 * varianti, uguale a quello di prima. Lì non c'è niente da aspettare, e la
 * chiave passa a quella nuova con lo stesso valore (il modello non si
 * ricalcola): la pagina dà il modello al regista solo quando la chiave è
 * quella del servizio, e senza questo aspetterebbe per sempre. */
export function nextSettled(
  last: SettledOverrides | null,
  key: string,
  overrides: ServiceOverrides & { reads?: number },
): SettledOverrides | null {
  if (!overrides.ready) return null;
  const { merges, hiddenTableIds, closedRoomIds } = overrides;
  const reads = typeof overrides.reads === 'number' && Number.isFinite(overrides.reads) ? overrides.reads : 0;
  if (
    last !== null && last.key !== key
    && last.value.merges === merges
    && last.value.hiddenTableIds === hiddenTableIds
    && last.value.closedRoomIds === closedRoomIds
  ) {
    const empty = merges === EMPTY_MERGES && hiddenTableIds === EMPTY_IDS && closedRoomIds === EMPTY_IDS;
    return empty ? { key, value: last.value, reads } : null;
  }
  return { key, value: { merges, hiddenTableIds, closedRoomIds }, reads };
}
