import type { Reservation, Table, TableMerge } from '../../types';
import { ArrivalStatus, ReservationStatus } from '../../types';
import { getRomeDatePart } from '../../utils/reservationTime';
import type { SectionTone } from '../ds';

// ---------------------------------------------------------------------------
// La griglia tavoli, ordinata per quello che chiede un'azione.
//
// Prima erano sessanta riquadri nell'ordine in cui il database li restituisce,
// e i due conti da incassare stavano in fondo fra i liberi. Qui i tavoli si
// raggruppano per stato, e i gruppi hanno l'ordine del servizio: chi deve
// pagare, chi sta mangiando, chi sta arrivando, chi non c'è.
// ---------------------------------------------------------------------------

/* Le quattro famiglie di stato del design system coprono esattamente i quattro
   casi, quindi non serve inventare tinte: una comanda aperta è servizio vivo,
   un conto da incassare chiede un'azione, una prenotazione è imminente, un
   tavolo libero non è uno stato. */
export type TableState = 'bill' | 'order' | 'booked' | 'free';

export interface TableRow {
  table: Table;
  state: TableState;
  reservation: Reservation | null;
  /** Unione per il turno: etichetta «11+12», coperti sommati, e il tavolo
   *  giusto da aprire (quello con la comanda o il conto, se c'è; sennò il
   *  capofila). Assenti sul tavolo singolo. */
  groupLabel?: string;
  groupSeats?: number;
  pickId?: number;
}

export type TableFilter = 'ALL' | TableState;

interface GroupSpec {
  state: TableState;
  /** Titolo del gruppo in griglia. Mai maiuscolo (§5.2). */
  label: string;
  /** Etichetta del chip filtro: dice cosa sono, non quanti sono. */
  chip: string;
  tone: SectionTone;
  /** Riga di stato stampata sul riquadro. I liberi non ne hanno una: essere
   *  liberi non è uno stato, è l'assenza di tutti gli altri. */
  caption: string | null;
}

/* L'ordine di questa lista è l'ordine della pagina, ed è deliberato: si legge
   dall'alto e la prima cosa che si incontra è quella che costa soldi se resta
   lì. */
export const TABLE_GROUPS: GroupSpec[] = [
  { state: 'bill',   label: 'Conto da incassare', chip: 'Da incassare',   tone: 'pending',  caption: 'da incassare' },
  { state: 'order',  label: 'Comande aperte',     chip: 'Comanda aperta', tone: 'positive', caption: 'comanda aperta' },
  { state: 'booked', label: 'In arrivo',          chip: 'In arrivo',      tone: 'info',     caption: null },
  { state: 'free',   label: 'Liberi',             chip: 'Liberi',         tone: 'muted',    caption: null },
];

/* Scritte per intero invece che composte: Tailwind estrae i nomi delle classi
   staticamente, quindi un `bg-[var(--ds-${state}-tint)]` non arriva mai nel
   foglio di stile. */
export const TABLE_TILE: Record<TableState, string> = {
  bill:   'bg-[var(--ds-pending-tint)] ring-2 ring-[var(--ds-pending-solid)]',
  order:  'bg-[var(--ds-seated-tint)] ring-2 ring-[var(--ds-seated-solid)]',
  booked: 'bg-[var(--ds-arriving-tint)] ring-1 ring-[var(--ds-arriving-solid)]',
  free:   'bg-[var(--ds-surface)]',
};

export const TABLE_CAPTION: Record<TableState, string> = {
  bill:   'text-[var(--ds-pending-text)]',
  order:  'text-[var(--ds-seated-text)]',
  booked: 'text-[var(--ds-arriving-text)]',
  free:   'text-[var(--ds-text-muted)]',
};

/** «10» prima di «9» è il difetto che rende la griglia inutilizzabile: si
 *  cerca un numero, non una stringa. Confronto naturale, con il pezzo non
 *  numerico a fare da spareggio per i tavoli tipo «Dehors 2». */
export const compareTableNames = (a: string, b: string): number => {
  const na = parseInt(a.replace(/\D+/g, ''), 10);
  const nb = parseInt(b.replace(/\D+/g, ''), 10);
  const aNum = Number.isFinite(na);
  const bNum = Number.isFinite(nb);
  if (aNum && bNum && na !== nb) return na - nb;
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a.localeCompare(b, 'it');
};

/* ── Chi è seduto a un tavolo ─────────────────────────────────────────────
   Estratte da OrderPad quando Cassa ha avuto bisogno della stessa risposta
   (docs/cassa-plan.md §8). È la parte che si sbaglia facilmente: un tavolo
   unito non ha una prenotazione sua, ce l'ha il capofila dell'unione, e
   cercarla solo sul tavolo esatto lascia metà sala senza nome.

   Funzioni pure: la fetch resta di chi possiede la schermata. */

/** Gruppo di unione per tavolo e turno: `${shift}:${tableId}` → tutti gli id
 *  del gruppo (capofila compreso). */
export const buildMergeGroups = (merges: TableMerge[]): Map<string, number[]> => {
  const map = new Map<string, number[]>();
  for (const m of merges) {
    const group = [m.primary_id, ...m.merged_ids];
    for (const id of group) map.set(`${m.shift}:${id}`, group);
  }
  return map;
};

/** La prenotazione viva su un tavolo, unioni comprese. `shiftFilter` 'ALL'
 *  non filtra: è il turno «Tutti» della barra globale. */
export const makeReservationForTable = (
  reservations: Reservation[],
  dateRome: string,
  shiftFilter: 'ALL' | 'LUNCH' | 'DINNER',
  mergeGroups: Map<string, number[]>,
) => (id: number): Reservation | null => {
  const isLive = (r: Reservation): boolean =>
    getRomeDatePart(r.reservation_time) === dateRome
    && (shiftFilter === 'ALL' || r.shift === shiftFilter)
    && r.reservation_status !== ReservationStatus.CANCELLED
    && r.arrival_status !== ArrivalStatus.DEPARTED;
  const exact = reservations.find(r => r.table_id === id && isLive(r));
  if (exact) return exact;
  // Nessuna prenotazione sul tavolo esatto: si cerca sugli altri tavoli
  // della sua unione (nel turno della prenotazione stessa).
  return reservations.find(r =>
    r.table_id != null
    && r.table_id !== id
    && isLive(r)
    && (mergeGroups.get(`${r.shift}:${id}`)?.includes(r.table_id) ?? false)
  ) ?? null;
};

export const buildRows = (
  tables: Table[],
  openTables: Set<number>,
  billTables: Set<number>,
  reservationForTable: (id: number) => Reservation | null,
  // I tavoli uniti per il turno sono UN tavolo per chi serve: senza questi
  // due argomenti la griglia mostrava la stessa prenotazione su due tessere
  // (regola del progetto: ogni superficie applica le unioni).
  mergeGroups?: Map<string, number[]>,
  shiftFilter?: 'ALL' | 'LUNCH' | 'DINNER',
): TableRow[] => {
  const byId = new Map(tables.map(t => [t.id, t]));
  const groupFor = (id: number): number[] | null => {
    if (!mergeGroups) return null;
    if (shiftFilter && shiftFilter !== 'ALL') return mergeGroups.get(`${shiftFilter}:${id}`) ?? null;
    // Turno «Tutti»: si prende l'unione di uno dei due turni. Lo stesso
    // tavolo unito diversamente a pranzo e a cena nello stesso giorno è un
    // caso limite che qui si accetta.
    return mergeGroups.get(`LUNCH:${id}`) ?? mergeGroups.get(`DINNER:${id}`) ?? null;
  };
  return tables
    .flatMap(table => {
      const group = groupFor(table.id);
      // I gregari dell'unione vivono dentro la tessera del capofila.
      if (group && table.id !== group[0] && byId.has(group[0])) return [];
      const members = group
        ? group.map(id => byId.get(id)).filter((t): t is Table => t != null)
        : [table];
      const reservation = members.map(m => reservationForTable(m.id)).find(r => r != null) ?? null;
      const orderOn = members.find(m => openTables.has(m.id));
      const billOn = members.find(m => billTables.has(m.id));
      // Una comanda aperta batte il conto: se il tavolo ha ricominciato a
      // ordinare, il conto vecchio non è più la cosa da fare.
      const state: TableState =
        orderOn ? 'order'
        : billOn ? 'bill'
        : reservation ? 'booked'
        : 'free';
      const row: TableRow = { table, state, reservation };
      if (members.length > 1) {
        row.groupLabel = members.map(m => m.name).sort(compareTableNames).join('+');
        row.groupSeats = members.reduce((sum, m) => sum + m.seats, 0);
        // Si apre il tavolo che ha già la comanda o il conto, mai un doppione.
        row.pickId = orderOn?.id ?? billOn?.id ?? table.id;
      }
      return [row];
    })
    .sort((a, b) => compareTableNames(a.groupLabel ?? a.table.name, b.groupLabel ?? b.table.name));
};

export const countByState = (rows: TableRow[]): Record<TableState, number> => {
  const out: Record<TableState, number> = { bill: 0, order: 0, booked: 0, free: 0 };
  for (const r of rows) out[r.state] += 1;
  return out;
};

/** Filtra su numero di tavolo e nome dell'ospite: chi cerca un tavolo spesso
 *  ricorda il nome e non il numero, e viceversa. */
export const matchesQuery = (row: TableRow, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  // groupLabel compreso: «109» deve trovare la tessera «108+109».
  if ((row.groupLabel ?? row.table.name).toLowerCase().includes(q)) return true;
  return (row.reservation?.customer_name ?? '').toLowerCase().includes(q);
};
