import { ArrivalStatus, ReservationStatus, type BanquetMenu, type Reservation, type Shift, type Table } from '../../../types';
import { deriveTableDisplayStatus, getEffectiveDurationMin, isSeated } from '../../reservationState';
import { litChairIndices } from '../../../utils/tableGeometry';
import type { LiveService, TableDisplayStatus } from '../types';
import { finiteOr, seatCount } from './geometry';
import { inService, isLiveParty, reservationMs } from './service';

/* Lo stato di un tavolo della Sala dal vivo: lo stesso colore della piantina.
 *
 * Il colore NON si ricalcola qui: lo dà deriveTableDisplayStatus di
 * reservationState, la fonte unica di ogni superficie. Qui si sceglie solo
 * QUALE prenotazione guardare, con le regole della 2D (FloorPlan,
 * getActiveReservation) e tre differenze dichiarate:
 *
 * - «oggi» è il giorno di servizio, non quello del calendario: alle 00:30 la
 *   piantina è già a domani, la sala dal vivo è ancora nella cena;
 * - un'unione è un tavolo solo: una comitiva su un secondario colora tutto il
 *   gruppo (la 2D guarda solo il tavolo del capofila);
 * - con due comitive sedute sullo stesso tavolo vince la più recente (la 2D
 *   prende la prima nell'ordine dell'array, che non vuol dire niente).
 *
 * Funzioni pure: l'istante arriva da fuori. */

/** La finestra della prossima prenotazione, come in 2D: da 30 minuti prima a
 *  120 dopo l'ora prenotata. */
export const UPCOMING_EARLY_MIN = 30;
export const UPCOMING_LATE_MIN = 120;
/** Quanto dopo la fine prevista una comitiva seduta conta ancora fra i
 *  presenti: DEPARTED spesso non lo segna nessuno, e senza una scadenza un
 *  pranzo resterebbe a tavola fino a sera. È la stessa grazia con cui PR2c
 *  smette di disegnare le persone, così il riassunto non cambia quando
 *  arrivano le figure. */
export const SEATED_GRACE_MIN = 45;

const MIN = 60_000;

/** Il gruppo di unione di un tavolo per il turno: [capofila, ...uniti], o il
 *  tavolo da solo. */
export function groupIdsOf(tableId: number, mergeGroups: Map<string, number[]>, shift: Shift): number[] {
  return mergeGroups.get(`${shift}:${tableId}`) ?? [tableId];
}

/** Il tavolo di una prenotazione come numero, null se non ne ha uno. */
export const tableIdOf = (r: Reservation): number | null => {
  const raw: unknown = r?.table_id;
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
};

// Le persone di una comitiva come intero non negativo.
const guestsOf = (v: unknown): number => Math.max(0, Math.floor(finiteOr(v, 0)));

// La scadenza di un blocco temporaneo in ms: è un numero (epoch ms) nel tipo,
// ma una riga passata da JSON o da un server diverso può portarla come
// stringa, numerica o ISO.
const lockExpiryMs = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
};

/** La prenotazione che colora il gruppo: la comitiva seduta più recente,
 *  altrimenti la prossima del turno.
 *
 * - Seduta: viva (isLiveParty) e a tavola (isSeated) su un tavolo qualunque
 *   del gruppo, senza guardare il turno: un pranzo che sconfina nella cena
 *   occupa il tavolo, e un walk-in delle 00:30 porta scritto LUNCH. Vince la
 *   più recente (ora prenotata, poi id).
 * - Prossima, come la 2D: non seduta, non annullata né rifiutata, non andata
 *   via, del servizio e del suo turno, con l'istante fra 30 minuti prima e 120
 *   dopo l'ora prenotata. PENDING (attesa) e NO_SHOW (noshow) contano come in
 *   2D; ma una NO_SHOW passa dopo le altre, perché il tavolo aspetta chi deve
 *   ancora arrivare. Poi la più vicina all'istante, in anticipo o in ritardo,
 *   poi l'id più basso: alle 19:00, fra una delle 17:30 mai arrivata e una
 *   delle 19:15, il tavolo aspetta quella delle 19:15, e se ne accendono le
 *   sedie. La 2D prende la prima dell'array, che dal server arriva in ordine
 *   d'ora decrescente: nel caso tipico la stessa. */
export function activeReservationFor(
  groupIds: readonly number[],
  reservations: readonly Reservation[],
  service: LiveService,
  nowMs: number,
): Reservation | null {
  const ids = new Set(groupIds);
  let seated: Reservation | null = null;
  let seatedAt = -Infinity;
  let next: Reservation | null = null;
  let nextGap = Infinity;
  let nextNoShow = true;

  for (const r of reservations) {
    if (!r) continue;
    const tid = tableIdOf(r);
    if (tid === null || !ids.has(tid)) continue;

    if (isSeated(r)) {
      if (!isLiveParty(r, service, nowMs)) continue;
      const t = reservationMs(r);
      if (seated === null || t > seatedAt || (t === seatedAt && r.id > seated.id)) {
        seated = r;
        seatedAt = t;
      }
      continue;
    }

    const status = r.reservation_status;
    if (status === ReservationStatus.CANCELLED || status === ReservationStatus.DECLINED) continue;
    if (r.arrival_status === ArrivalStatus.DEPARTED) continue;
    if (r.shift !== service.shift) continue;
    if (!inService(r, service, nowMs)) continue;
    const t = reservationMs(r);
    if (nowMs < t - UPCOMING_EARLY_MIN * MIN || nowMs > t + UPCOMING_LATE_MIN * MIN) continue;
    const noShow = status === ReservationStatus.NO_SHOW;
    const gap = Math.abs(t - nowMs);
    const better = next === null
      || (nextNoShow && !noShow)
      || (nextNoShow === noShow && (gap < nextGap || (gap === nextGap && r.id < next.id)));
    if (better) {
      next = r;
      nextGap = gap;
      nextNoShow = noShow;
    }
  }
  return seated ?? next;
}

export interface GroupStatus {
  /** Il colore del gruppo: tutti i tavoli di un'unione hanno lo stesso. */
  status: TableDisplayStatus;
  /** La prenotazione che lo decide (null: libero, banchetto o blocco). */
  active: Reservation | null;
  /** Il banchetto del servizio su un tavolo del gruppo. */
  banquet: BanquetMenu | null;
  /** Le persone per cui si accendono le sedie: come in 2D, gli ospiti della
   *  prenotazione (0 per un no-show), se no quelli del banchetto. 0 = tutte
   *  accese. */
  party: number;
  /** La comitiva è seduta e non ha superato la fine prevista più
   *  SEATED_GRACE_MIN: conta fra i presenti. */
  present: boolean;
  /** L'anello che pulsa: 'inarrivo'. */
  pulse: boolean;
}

/** Lo stato di un gruppo di tavoli (un tavolo solo, o un'unione). */
export function groupStatusFor(args: {
  groupIds: readonly number[];
  tablesById: ReadonlyMap<number, Table>;
  reservations: readonly Reservation[];
  banquetMenus: readonly BanquetMenu[];
  service: LiveService;
  nowMs: number;
}): GroupStatus {
  const { groupIds, tablesById, reservations, banquetMenus, service, nowMs } = args;
  const ids = new Set(groupIds);
  const active = activeReservationFor(groupIds, reservations, service, nowMs);

  // Il banchetto del servizio che occupa un tavolo del gruppo. Come in 2D
  // conta qualunque stato (preventivo o confermato): il tavolo è tenuto.
  let banquet: BanquetMenu | null = null;
  for (const b of banquetMenus) {
    if (!b || b.event_date !== service.date || b.shift !== service.shift) continue;
    const tableIds: unknown[] = Array.isArray(b.table_ids) ? b.table_ids : [];
    if (tableIds.some(id => ids.has(Number(id)))) {
      banquet = b;
      break;
    }
  }

  // Un tavolo bloccato da qualcuno che sta assegnando: in 2D è «attesa» col
  // timer, qui solo il colore.
  const tempLocked = groupIds.some(id => {
    const expiry = lockExpiryMs(tablesById.get(id)?.temp_lock_expires_at);
    return expiry !== null && expiry > nowMs;
  });

  const status = deriveTableDisplayStatus(active, { banquet: !!banquet, tempLocked, now: nowMs });
  const party = active
    ? (active.reservation_status === ReservationStatus.NO_SHOW ? 0 : guestsOf(active.guests))
    : banquet ? guestsOf(banquet.guests) : 0;
  const start = active ? reservationMs(active) : NaN;
  const present = !!active
    && isSeated(active)
    && Number.isFinite(start)
    && nowMs < start + (getEffectiveDurationMin(active) + SEATED_GRACE_MIN) * MIN;

  return { status, active, banquet, party, present, pulse: status === 'inarrivo' };
}

/** Le sedie accese di ogni tavolo di un gruppo, per id.
 *
 * `units` sono i tavoli disegnati del gruppo nell'ordine [capofila,
 * ...uniti], ciascuno coi posti con cui si disegna (un'unione alla maniera
 * della 2D è il capofila coi posti sommati). Un tavolo solo dà esattamente
 * le sedie della piantina, in tutti i casi.
 *
 * - Senza prenotazione (`firstTableId` null: libero, o banchetto) ogni tavolo
 *   accende `party` sedie, come in 2D: 0 le accende tutte.
 * - Con una prenotazione la comitiva si siede prima al suo tavolo, poi agli
 *   altri del gruppo nell'ordine dell'unione. Un tavolo dove non resta
 *   nessuno ha le sedie spente (è vuoto, in un gruppo occupato); con
 *   `party` 0 (un no-show) restano tutte accese, come in 2D. */
export function litByTable(units: readonly Table[], party: number, firstTableId: number | null): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const people = guestsOf(party);
  if (firstTableId === null) {
    for (const t of units) out.set(t.id, litChairIndices(t.shape, seatCount(t.seats), people));
    return out;
  }
  const first = units.find(t => t.id === firstTableId);
  const order = first ? [first, ...units.filter(t => t !== first)] : units;
  let left = people;
  for (const t of order) {
    const seats = seatCount(t.seats);
    const take = Math.min(left, seats);
    left -= take;
    out.set(
      t.id,
      take > 0 ? litChairIndices(t.shape, seats, take) : people > 0 ? [] : litChairIndices(t.shape, seats, 0),
    );
  }
  return out;
}
