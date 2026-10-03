import type { FloorMarkerKind, Reservation, Room, Table } from '../../../types';
import { getTableFootprint } from '../../../utils/tableOverlap';
import { sortRooms } from '../../../utils/roomOrder';
import type { MarkerModel, RoomModel, SceneInputs, SceneModel, TableModel } from '../types';
import { M_PER_PX, finiteOr, placeTable, pxToWorld } from './geometry';
import { MARKER_KINDS, buildRoomLayout, type LayoutUnit } from './layout';
import { inService } from './service';
import { groupStatusFor, litByTable, tableIdOf, type GroupStatus } from './tableStatus';

/* La Sala dal vivo di un istante: dai dati di App al modello che la scena
 * disegna. Puro e deterministico: con gli stessi ingressi la stessa sala, e
 * l'istante arriva da fuori (nowMs). La pagina lo chiama in un useMemo sui
 * commit dei dati e sul minuto di App, mai a ogni frame: per questo qui si
 * indicizza una volta per chiamata invece di cercare per tavolo. */

// Mezzo lato del quadrato che un segnaposto occupa nell'inquadratura: la
// porta, il banco del pass o il leggio devono entrare per intero.
const MARKER_HALF_M = 0.6;

const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

const asArray = <T>(v: readonly T[] | null | undefined): readonly T[] => (Array.isArray(v) ? v : []);

// Persone, non comitive: una prenotazione senza ospiti è comunque qualcuno.
const peopleOf = (r: Reservation | null): number => (r ? Math.max(1, Math.floor(finiteOr(r.guests, 0))) : 0);

// rooms.location è nel database (INDOOR / OUTDOOR / null) ma è arrivata sul
// tipo Room solo con questa pagina: si legge senza fidarsi né del tipo né
// del server.
const isOutdoor = (room: Room): boolean => (room as { location?: unknown }).location === 'OUTDOOR';

interface Bounds { minX: number; minZ: number; maxX: number; maxZ: number }

const growBounds = (b: Bounds | null, minX: number, minZ: number, maxX: number, maxZ: number): Bounds =>
  b
    ? { minX: Math.min(b.minX, minX), minZ: Math.min(b.minZ, minZ), maxX: Math.max(b.maxX, maxX), maxZ: Math.max(b.maxZ, maxZ) }
    : { minX, minZ, maxX, maxZ };

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

  const rooms = sortRooms(asArray(inputs.rooms).filter((r): r is Room => !!r)).map((room): RoomModel => {
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
    let seated = 0;
    let arriving = 0;
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
      if (gs.present) seated += peopleOf(gs.active);
      if (gs.status === 'inarrivo') arriving += peopleOf(gs.active);
    }

    let covers = 0;
    let bounds: Bounds | null = null;
    const tableModels: TableModel[] = [];
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
        chairs: placed.chairs,
        pulse: gs.pulse,
        mergePrimaryId: u.mergePrimaryId,
      });
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
      id: room.id,
      name: room.name,
      closed: room.is_closed === true || closedRoomIds.has(room.id),
      outdoor: isOutdoor(room),
      floor,
      // Senza tavoli né segnaposto si inquadra il pavimento intero (oggi non
      // succede: i segnaposto ci sono sempre, almeno di ripiego).
      bounds: bounds ?? { minX: 0, minZ: 0, maxX: floor.width, maxZ: floor.depth },
      tables: tableModels,
      markers: markerModels,
      audit: layout.audit,
      summary: { seated, arriving, covers },
    };
  });

  const summary = rooms.reduce(
    (acc, r) => ({ seated: acc.seated + r.summary.seated, arriving: acc.arriving + r.summary.arriving }),
    { seated: 0, arriving: 0 },
  );
  return { service, rooms, summary };
}
