import type { Reservation } from '../../../types';
import { isSeated } from '../../reservationState';
import type { LiveService, RoomModel, ServiceSummary } from '../types';
import { finiteOr } from './geometry';
import { isLiveParty, reservationMs } from './service';
import { tableIdOf, type GroupStatus } from './tableStatus';

/* Chi è in sala adesso: la fonte UNICA delle figure e di ogni numero.
 *
 * Le figure sedute, quelle all'ingresso e i numeri del riassunto e delle
 * linguette nascono tutti da qui, dalla stessa regola: una linguetta non può
 * dire 4 con 6 figure sedute, e una comitiva che il riassunto non conta non
 * può comparire a un tavolo.
 *
 * - Presente: la comitiva che colora il tavolo disegnato (la seduta più
 *   recente del suo gruppo, groupStatusFor) finché è entro la grazia. Una
 *   seduta più vecchia sullo stesso tavolo non ha figure: DEPARTED spesso non
 *   lo segna nessuno, e senza questa regola sederebbe sotto quella nuova.
 * - All'ingresso: seduta senza un tavolo da disegnare (nessuno, nascosto, in
 *   una sala che non c'è), da meno di un'ora dall'ora prenotata. Chi ha il
 *   tavolo disegnato ma non è presente non va all'ingresso: è andato via
 *   senza che nessuno lo segnasse, e il tavolo resta «uscita».
 *
 * Puro: l'istante arriva da fuori. */

/** Dopo quanto dall'ora prenotata chi aspetta all'ingresso smette di
 *  esserci: è stato fatto sedere senza assegnargli il tavolo, o è andato via. */
export const LOBBY_WINDOW_MIN = 60;
/** Le figure che l'ingresso disegna (una griglia 2 × 3): oltre, si contano e
 *  basta. */
export const LOBBY_MAX_DRAWN = 6;
/** Un tetto alle persone di una comitiva, per le figure e per i numeri
 *  insieme (così la linguetta dice sempre quante figure siedono). Una
 *  prenotazione vera da più di 150 è un banchetto su più tavoli; un numero
 *  sbagliato (500, o 10000 al posto di 10) disegnerebbe una folla attorno a
 *  un tavolo: a ~690 triangoli a persona, 150 sono ~104k, il budget di una
 *  sala intera (150k), mentre 500 ne darebbero 344k. */
export const MAX_PARTY_PEOPLE = 150;

const MIN = 60_000;

/** Le persone di una comitiva: almeno 1 (una prenotazione senza ospiti è
 *  comunque qualcuno), al più MAX_PARTY_PEOPLE; 0 senza prenotazione. È anche
 *  quante figure ha (composeParty): riassunto e figure contano uguale. */
export function peopleOf(r: Reservation | null | undefined): number {
  if (!r) return 0;
  return Math.min(MAX_PARTY_PEOPLE, Math.max(1, Math.floor(finiteOr(r.guests, 0))));
}

/** Un tavolo disegnato, col suo stato. */
export interface DrawnTable {
  /** TableModel.id: per un'unione, il capofila. */
  tableId: number;
  roomId: number;
  /** LayoutUnit.groupIds: [capofila, ...uniti], o il tavolo da solo. */
  groupIds: readonly number[];
  /** groupStatusFor di quell'unità. */
  status: GroupStatus;
}

export interface PresentParty {
  reservation: Reservation;
  roomId: number;
  /** Il tavolo disegnato dove siede. */
  tableId: number;
}

export interface LobbyParty {
  reservation: Reservation;
  roomId: number;
}

export interface Presence {
  /** Le comitive a tavola, nell'ordine dei tavoli disegnati (sale come
   *  sortRooms, tavoli come la disposizione). */
  present: PresentParty[];
  /** Le comitive dietro gli anelli che pulsano, nello stesso ordine. */
  arriving: PresentParty[];
  /** Chi aspetta all'ingresso, per ora prenotata e poi id. */
  lobby: LobbyParty[];
}

/** Chi è in sala adesso. */
export function derivePresence(args: {
  drawn: readonly DrawnTable[];
  /** Ogni tavolo noto (la prima riga per id, nascosti compresi) la cui sala
   *  esiste → quella sala. */
  tableRoomIds: ReadonlyMap<number, number>;
  mainRoomId: number | null;
  /** TUTTE le prenotazioni di App: chi aspetta all'ingresso spesso non ha un
   *  tavolo, e non sta in nessun indice per tavolo. */
  reservations: readonly Reservation[];
  service: LiveService;
  nowMs: number;
}): Presence {
  const { tableRoomIds, mainRoomId, service, nowMs } = args;
  const drawn = Array.isArray(args.drawn) ? args.drawn : [];
  const reservations = Array.isArray(args.reservations) ? args.reservations : [];

  const present: PresentParty[] = [];
  const arriving: PresentParty[] = [];
  // Ogni tavolo che un tavolo disegnato porta con sé: chi siede su uno di
  // questi ha un posto in sala, presente o no.
  const drawnIds = new Set<number>();
  // Una comitiva si disegna una volta sola, anche se una riga ripetuta la
  // mettesse su due tavoli: chiavi doppie confonderebbero la scena.
  const placed = new Set<number>();
  const announced = new Set<number>();
  for (const d of drawn) {
    if (!d) continue;
    for (const id of Array.isArray(d.groupIds) ? d.groupIds : []) drawnIds.add(id);
    const active = d.status?.active ?? null;
    if (!active) continue;
    if (d.status.present && !placed.has(active.id)) {
      placed.add(active.id);
      present.push({ reservation: active, roomId: d.roomId, tableId: d.tableId });
    }
    if (d.status.pulse && !announced.has(active.id)) {
      announced.add(active.id);
      arriving.push({ reservation: active, roomId: d.roomId, tableId: d.tableId });
    }
  }

  const lobby: LobbyParty[] = [];
  const seen = new Set<number>();
  for (const r of reservations) {
    // La prima riga per id, come App.
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    if (placed.has(r.id) || !isSeated(r) || !isLiveParty(r, service, nowMs)) continue;
    const tid = tableIdOf(r);
    if (tid !== null && drawnIds.has(tid)) continue;
    const start = reservationMs(r);
    if (!Number.isFinite(start) || nowMs >= start + LOBBY_WINDOW_MIN * MIN) continue;
    // Il tavolo c'è ma non si disegna (nascosto, unito sotto un capofila
    // nascosto): l'ingresso della sua sala. Se no quello della sala
    // principale.
    const own = tid !== null ? tableRoomIds.get(tid) : undefined;
    const roomId = own ?? mainRoomId;
    if (roomId === null || roomId === undefined) continue;
    lobby.push({ reservation: r, roomId });
  }
  lobby.sort((a, b) =>
    reservationMs(a.reservation) - reservationMs(b.reservation) || a.reservation.id - b.reservation.id);

  return { present, arriving, lobby };
}

/** I numeri di una sala, tutti dalla stessa presenza: persone a tavola, in
 *  arrivo, all'ingresso (anche oltre le figure che l'ingresso disegna). */
export function summaryFor(presence: Presence, roomId: number): ServiceSummary {
  let seated = 0;
  let arriving = 0;
  let lobby = 0;
  for (const p of presence.present) if (p.roomId === roomId) seated += peopleOf(p.reservation);
  for (const p of presence.arriving) if (p.roomId === roomId) arriving += peopleOf(p.reservation);
  for (const p of presence.lobby) if (p.roomId === roomId) lobby += peopleOf(p.reservation);
  return { seated, arriving, lobby };
}

/** La sala principale, dove aspetta chi è arrivato senza tavolo: la prima
 *  aperta con l'ingresso POSATO, se no la prima aperta, se no la prima. Ogni
 *  sala ha un ingresso, almeno di ripiego, quindi «con l'ingresso» vuol dire
 *  qualcosa solo se è posato. `rooms` nell'ordine di sortRooms. */
export function mainRoomOf(rooms: readonly Pick<RoomModel, 'id' | 'closed' | 'markers'>[]): number | null {
  const list = (Array.isArray(rooms) ? rooms : []).filter(r => !!r);
  const room = list.find(r => !r.closed && r.markers?.ENTRANCE?.placed === true)
    ?? list.find(r => !r.closed)
    ?? list[0];
  return room ? room.id : null;
}
