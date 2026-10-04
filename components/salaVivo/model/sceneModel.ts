import { ReservationStatus, type BanquetMenu, type FloorMarkerKind, type Reservation, type Room, type Table } from '../../../types';
import { isSeated } from '../../reservationState';
import { getTableFootprint } from '../../../utils/tableOverlap';
import { sortRooms } from '../../../utils/roomOrder';
import type {
  FigureSlot,
  MarkerModel,
  PartyModel,
  RoomModel,
  SceneInputs,
  SceneModel,
  ServiceSummary,
  TableModel,
} from '../types';
import { M_PER_PX, placeTable, pxToWorld } from './geometry';
import { MARKER_KINDS, buildRoomLayout, type LayoutUnit } from './layout';
import { composeParty, partyLabels } from './party';
import { hostSpot, hostessFigure, lobbyCells, lobbyFigures, seatParty, spillTableIds } from './placement';
import { derivePresence, mainRoomOf, summaryFor, type DrawnTable } from './presence';
import { inService, isLiveParty } from './service';
import { captionFor, guestName, signFor } from './signs';
import { groupStatusFor, litByTable, tableIdOf, type GroupStatus } from './tableStatus';

/* La Sala dal vivo di un istante: dai dati di App al modello che la scena
 * disegna. Puro e deterministico: con gli stessi ingressi la stessa sala, e
 * l'istante arriva da fuori (nowMs). La pagina lo chiama in un useMemo sui
 * commit dei dati e sul minuto di App, mai a ogni frame: per questo qui si
 * indicizza una volta per chiamata invece di cercare per tavolo.
 *
 * Due passate. La prima disegna ogni sala come la piantina (tavoli, colori,
 * sedie accese, segnaposto). In mezzo, presence.ts decide chi è in sala: la
 * sala principale dove aspetta chi non ha tavolo si conosce solo con tutte le
 * sale in mano. La seconda siede le comitive presenti, mette in fila chi
 * aspetta all'ingresso e l'hostess, e scrive cartellini e numeri: tutti dalla
 * stessa presenza, così una linguetta non dice mai 4 con 6 figure sedute. */

// Mezzo lato del quadrato che un segnaposto occupa nell'inquadratura: la
// porta, il banco del pass o il leggio devono entrare per intero.
const MARKER_HALF_M = 0.6;
// Lo stesso per un posto dell'ingresso o quello dell'hostess: una persona
// con le spalle e l'ombra.
const SPOT_HALF_M = 0.35;

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

const asArray = <T>(v: readonly T[] | null | undefined): readonly T[] => (Array.isArray(v) ? v : []);

// rooms.location è nel database (INDOOR / OUTDOOR / null) ma è arrivata sul
// tipo Room solo con questa pagina: si legge senza fidarsi né del tipo né
// del server.
const isOutdoor = (room: Room): boolean => (room as { location?: unknown }).location === 'OUTDOOR';

interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }

const growBounds = (b: Bounds | null, minX: number, minZ: number, maxX: number, maxZ: number): Bounds =>
  b
    ? { minX: Math.min(b.minX, minX), minZ: Math.min(b.minZ, minZ), maxX: Math.max(b.maxX, maxX), maxZ: Math.max(b.maxZ, maxZ) }
    : { minX, minZ, maxX, maxZ };

// Un posto di persona nell'inquadratura, tenuto sul pavimento: i posti
// dell'ingresso stanno a 30 cm dal bordo, e il loro margine non deve far
// inquadrare il buio oltre il muro.
const growBySpot = (b: Bounds | null, x: number, z: number, floor: RoomModel['floor']): Bounds => {
  const clampX = (v: number) => Math.min(floor.width, Math.max(0, v));
  const clampZ = (v: number) => Math.min(floor.depth, Math.max(0, v));
  return growBounds(b, clampX(x - SPOT_HALF_M), clampZ(z - SPOT_HALF_M), clampX(x + SPOT_HALF_M), clampZ(z + SPOT_HALF_M));
};

// Una sala dopo la prima passata: disegnata come la piantina, senza ancora
// persone, cartellini e numeri.
interface RoomDraft {
  model: RoomModel;
  drawn: DrawnTable[];
  tableById: Map<number, TableModel>;
  covers: number;
  bounds: Bounds | null;
}

export function deriveSceneModel(inputs: SceneInputs): SceneModel {
  const { service, nowMs } = inputs;
  const tables = asArray(inputs.tables).filter((t): t is Table => !!t);
  const reservations = asArray(inputs.reservations);
  // Solo i banchetti di questo servizio: App li tiene tutti, di ogni data, e
  // ogni gruppo di tavoli li scorrerebbe da capo.
  const banquetMenus = asArray(inputs.banquetMenus)
    .filter(b => !!b && b.event_date === service.date && b.shift === service.shift);
  const merges = asArray(inputs.merges);
  const markers = asArray(inputs.markers);
  const hiddenTableIds = inputs.hiddenTableIds ?? EMPTY_IDS;
  const closedRoomIds = inputs.closedRoomIds ?? EMPTY_IDS;
  // A nomi spenti nessun nome di persona entra nel modello: solo true li
  // accende, anche un valore strano arrivato da fuori.
  const showNames = inputs.showNames === true;
  const copy = inputs.copy;
  const labels = partyLabels(inputs.notePresets);

  // Il primo per id, come buildRoomLayout.
  const tablesById = new Map<number, Table>();
  for (const t of tables) if (!tablesById.has(t.id)) tablesById.set(t.id, t);

  // Le prenotazioni del servizio, per tavolo: App ne tiene in memoria anche
  // giorni interi d'archivio, e ogni gruppo deve guardare solo le sue.
  const byTable = new Map<number, Reservation[]>();
  for (const r of reservations) {
    if (!r) continue;
    const tid = tableIdOf(r);
    if (tid === null || !inService(r, service, nowMs)) continue;
    const list = byTable.get(tid);
    if (list) list.push(r);
    else byTable.set(tid, [r]);
  }

  // Una prenotazione che tiene il suo tavolo per tutto il turno, a qualunque
  // ora: del turno e non annullata né rifiutata (anche andata via o no-show:
  // resta il suo tavolo), o seduta e viva di un altro turno (un pranzo che
  // sconfina). Decide dove può traboccare un banchetto, e non dipende
  // dall'orologio: un tavolo prenotato per le 20:30 è preso anche alle
  // 19:59, quando la piantina non lo colora ancora, e chi trabocca non ci si
  // siede per alzarsi al minuto dopo.
  const holdsTable = (r: Reservation | null | undefined): boolean => {
    if (!r) return false;
    const status = r.reservation_status;
    if (status === ReservationStatus.CANCELLED || status === ReservationStatus.DECLINED) return false;
    return r.shift === service.shift || (isSeated(r) && isLiveParty(r, service, nowMs));
  };

  // Il banchetto di una comitiva, per il suo id.
  const banquetById = new Map<number, BanquetMenu>();
  for (const b of banquetMenus) {
    const id = Number(b.id);
    if (Number.isFinite(id) && !banquetById.has(id)) banquetById.set(id, b);
  }

  const roomList = sortRooms(asArray(inputs.rooms).filter((r): r is Room => !!r));
  const roomIds = new Set(roomList.map(r => r.id));
  // Ogni tavolo noto, nascosti compresi, nella sua sala se la sala c'è: chi
  // siede su un tavolo che non si disegna aspetta all'ingresso di quella sala.
  const tableRoomIds = new Map<number, number>();
  for (const t of tablesById.values()) if (roomIds.has(t.room_id)) tableRoomIds.set(t.id, t.room_id);

  // ── Prima passata: ogni sala come la piantina ──────────────────────────
  const drafts = roomList.map((room): RoomDraft => {
    const layout = buildRoomLayout({ room, tables, merges, hiddenTableIds, markers });

    // Uno stato per gruppo: i tavoli di un'unione hanno lo stesso colore, e
    // le sedie accese della comitiva si distribuiscono sul gruppo intero.
    const unitsByGroup = new Map<number, LayoutUnit[]>();
    for (const u of layout.units) {
      const list = unitsByGroup.get(u.groupIds[0]);
      if (list) list.push(u);
      else unitsByGroup.set(u.groupIds[0], [u]);
    }
    const statusByGroup = new Map<number, GroupStatus>();
    const litByTableId = new Map<number, number[]>();
    for (const [key, units] of unitsByGroup) {
      const { groupIds } = units[0];
      const candidates = groupIds.flatMap(id => byTable.get(id) ?? []);
      const gs = groupStatusFor({ groupIds, tablesById, reservations: candidates, banquetMenus, service, nowMs });
      statusByGroup.set(key, gs);
      // Le unità nell'ordine dell'unione, [capofila, ...uniti]: è l'ordine in
      // cui la comitiva si siede dopo il suo tavolo.
      const ordered = [...units].sort((a, b) => groupIds.indexOf(a.table.id) - groupIds.indexOf(b.table.id));
      const lit = litByTable(ordered.map(u => u.table), gs.party, gs.active ? tableIdOf(gs.active) : null);
      for (const [id, chairs] of lit) litByTableId.set(id, chairs);
    }

    let covers = 0;
    let bounds: Bounds | null = null;
    const tableModels: TableModel[] = [];
    const drawn: DrawnTable[] = [];
    for (const u of layout.units) {
      const gs = statusByGroup.get(u.groupIds[0]);
      if (!gs) continue;
      const placed = placeTable(u.table, u.table.seats, litByTableId.get(u.table.id) ?? []);
      covers += u.table.seats;
      // L'inquadratura prende il glifo ruotato intero, sedie comprese.
      const fp = getTableFootprint(u.table, u.table.x, u.table.y, 0, 0);
      bounds = growBounds(bounds, fp.x * M_PER_PX, fp.y * M_PER_PX, (fp.x + fp.w) * M_PER_PX, (fp.y + fp.h) * M_PER_PX);
      tableModels.push({
        id: u.table.id,
        name: u.table.name,
        roomId: room.id,
        shape: placed.shape,
        center: placed.center,
        rotY: placed.rotY,
        length: placed.length,
        depth: placed.depth,
        status: gs.status,
        // Le sedie della piantina; quelle di un tavolo dove siede qualcuno le
        // riscrive la seconda passata (accese = occupate).
        chairs: placed.chairs,
        extraChairs: [],
        pulse: gs.pulse,
        sign: null,
        caption: null,
      });
      drawn.push({ tableId: u.table.id, roomId: room.id, groupIds: u.groupIds, status: gs });
    }

    const markerModels = {} as Record<FloorMarkerKind, MarkerModel>;
    for (const kind of MARKER_KINDS) {
      const m = layout.markersPx[kind];
      const pos = pxToWorld(m.x, m.y);
      markerModels[kind] = { kind, pos, placed: m.placed, inward: m.inward };
      bounds = growBounds(bounds, pos.x - MARKER_HALF_M, pos.z - MARKER_HALF_M, pos.x + MARKER_HALF_M, pos.z + MARKER_HALF_M);
    }

    const floor = { width: layout.extentPx.width * M_PER_PX, depth: layout.extentPx.height * M_PER_PX };
    return {
      model: {
        id: room.id,
        name: room.name,
        closed: room.is_closed === true || closedRoomIds.has(room.id),
        outdoor: isOutdoor(room),
        floor,
        bounds: { minX: 0, minZ: 0, maxX: floor.width, maxZ: floor.depth },
        tables: tableModels,
        markers: markerModels,
        audit: layout.audit,
        summary: { seated: 0, arriving: 0, lobby: 0, covers },
        parties: [],
        figures: [],
      },
      drawn,
      tableById: new Map(tableModels.map(t => [t.id, t])),
      covers,
      bounds,
    };
  });

  // ── Chi è in sala: una regola sola per figure e numeri ─────────────────
  const mainRoomId = mainRoomOf(drafts.map(d => d.model));
  const presence = derivePresence({
    drawn: drafts.flatMap(d => d.drawn),
    tableRoomIds,
    mainRoomId,
    reservations,
    service,
    nowMs,
  });

  // ── Seconda passata: persone, cartellini, numeri ───────────────────────
  const rooms = drafts.map(({ model, drawn, tableById, covers, bounds: tableBounds }): RoomModel => {
    let bounds = tableBounds;
    const figures: FigureSlot[] = [];
    const parties: PartyModel[] = [];

    // Tavolo del gruppo → tavolo disegnato, in questa sala: un banchetto può
    // elencare il secondario di un'unione.
    const drawnTableOf = new Map<number, number>();
    for (const d of drawn) for (const id of d.groupIds) drawnTableOf.set(id, d.tableId);
    const here = presence.present.filter(p => p.roomId === model.id);
    const ownTables = new Set(here.map(p => p.tableId));
    // Dove può traboccare una comitiva di banchetto: i tavoli senza una
    // prenotazione loro in tutto il turno (liberi, o tenuti solo dal
    // banchetto). Non il colore, che c'è solo da 30 minuti prima dell'ora.
    const available = new Set(
      drawn
        .filter(d => !ownTables.has(d.tableId) && !d.groupIds.some(id => (byTable.get(id) ?? []).some(holdsTable)))
        .map(d => d.tableId),
    );
    // Chi siede a ogni tavolo toccato: la sua comitiva, o quella che ci
    // trabocca.
    const sittingAt = new Map<number, Reservation>();

    for (const p of here) {
      const own = tableById.get(p.tableId);
      if (!own) continue;
      const r = p.reservation;
      const composition = composeParty(r, labels);
      const rawBanquetId: unknown = r.banquet_menu_id;
      const banquet = rawBanquetId == null || rawBanquetId === ''
        ? null
        : banquetById.get(Number(rawBanquetId)) ?? null;
      const spill = spillTableIds({ ownTableId: own.id, banquet, drawnTableOf, available })
        .map(id => tableById.get(id))
        .filter((t): t is TableModel => !!t);
      const plan = seatParty({ partyId: r.id, composition, tables: [own, ...spill], floor: model.floor });
      for (const [id, seated] of plan.tables) {
        const t = tableById.get(id);
        if (!t) continue;
        t.chairs = seated.chairs;
        t.extraChairs = seated.extraChairs;
        available.delete(id);
        sittingAt.set(id, r);
      }
      figures.push(...plan.figures);
      parties.push({ id: r.id, tableId: own.id, ...composition, name: showNames ? guestName(r) : null });
    }

    // L'ingresso: chi aspetta (al più sei figure, gli altri si contano) e,
    // sempre, i suoi posti nell'inquadratura.
    const cells = lobbyCells(model);
    const inward = model.markers.ENTRANCE.inward;
    const waiting = presence.lobby
      .filter(l => l.roomId === model.id)
      .map(l => ({ reservation: l.reservation, composition: composeParty(l.reservation, labels) }));
    figures.push(...lobbyFigures(
      waiting.map(w => ({ id: w.reservation.id, composition: w.composition })),
      cells,
      Math.atan2(inward.x, inward.z),
    ));
    for (const w of waiting) {
      parties.push({
        id: w.reservation.id,
        tableId: null,
        ...w.composition,
        name: showNames ? guestName(w.reservation) : null,
      });
    }
    for (const c of cells) bounds = growBySpot(bounds, c.x, c.z, model.floor);

    // L'hostess all'accoglienza, una per sala, dietro il leggio per chi
    // entra dalla porta.
    const host = model.markers.HOST_STAND;
    figures.push(hostessFigure(model.id, host, model.markers.ENTRANCE, model.floor));
    const spot = hostSpot(host, model.markers.ENTRANCE, model.floor);
    bounds = growBySpot(bounds, spot.x, spot.z, model.floor);

    // Cartellino e seconda riga di ogni tavolo disegnato.
    for (const d of drawn) {
      const t = tableById.get(d.tableId);
      if (!t) continue;
      const seated = sittingAt.get(d.tableId) ?? null;
      const candidates = d.groupIds.flatMap(id => byTable.get(id) ?? []);
      const sign = signFor({ status: d.status, candidates, occupied: seated !== null, service, nowMs });
      t.sign = sign ? sign.kind : null;
      t.caption = captionFor({ sign, seated, showNames, copy });
    }

    return {
      ...model,
      // Senza tavoli né segnaposto si inquadra il pavimento intero (oggi non
      // succede: i segnaposto ci sono sempre, almeno di ripiego).
      bounds: bounds ?? model.bounds,
      summary: { ...summaryFor(presence, model.id), covers },
      parties,
      figures,
    };
  });

  const summary = rooms.reduce<ServiceSummary>(
    (acc, r) => ({
      seated: acc.seated + r.summary.seated,
      arriving: acc.arriving + r.summary.arriving,
      lobby: acc.lobby + r.summary.lobby,
    }),
    { seated: 0, arriving: 0, lobby: 0 },
  );
  return { service, rooms, summary, mainRoomId };
}

/** Le sale con la loro linguetta: le aperte, e una chiusa finché c'è ancora
 *  qualcuno, a tavola, all'ingresso o in arrivo. La testata somma tutte le
 *  sale: così ogni persona che conta sta in una sala che si può aprire (una
 *  terrazza chiusa per la pioggia con le prenotazioni ancora sopra dice «4 in
 *  arrivo» e si vede dove). */
export function roomsToShow(rooms: readonly RoomModel[] | null | undefined): RoomModel[] {
  return (Array.isArray(rooms) ? rooms : []).filter(r =>
    !!r && (!r.closed || r.summary.seated > 0 || r.summary.arriving > 0 || r.summary.lobby > 0));
}
