import React, { useEffect, useMemo, useRef } from 'react';
import { ArrowLeft, Loader2, UtensilsCrossed } from 'lucide-react';
import type { Room } from '../../types';
import type { ServiceBill } from '../../services/ordersApiService';
import { EmptyState, SearchField, SegmentedControl } from '../ds';
import { TableTiles } from '../comande/TableTiles';
import {
  TABLE_CAPTION, TABLE_GROUPS, countByState, matchesQuery,
  type TableFilter, type TableRow,
} from '../comande/tablesView';
import { euro } from './cassaView';
import { Piantina } from './Piantina';

/* ── Passo 2 · seleziona tavolo ───────────────────────────────────────────
   Contesto obbligatorio per il dine-in.

   Due righe di controlli e non una: le sale sono uno SCOPE (cambiano cosa c'è
   sullo schermo), gli stati sono un FILTRO (restringono quello che c'è).
   Metterle sulla stessa riga le farebbe leggere come alternative fra loro.

   I conteggi degli stati si ricalcolano DENTRO la sala scelta: «Da incassare
   2» accanto a una sala che non ne ha è una bugia che si crede una volta sola
   (docs/cassa-plan.md §10). */

interface SelezionaTavoloProps {
  rows: TableRow[];
  rooms: Room[];
  /** Conti attivi per tavolo: la tessera dice quanto deve, non quanti posti ha. */
  billByTable: Map<number, ServiceBill>;
  /** Id della sala come stringa, o 'ALL'. Stringa perché SegmentedControl è
   *  tipizzato su `T extends string` — non vale la pena allargarlo per noi. */
  roomId: string;
  onRoom: (next: string) => void;
  filter: TableFilter;
  onFilter: (next: TableFilter) => void;
  query: string;
  onQuery: (next: string) => void;
  busy: boolean;
  onPick: (tableId: number) => void;
  onBack: () => void;
  /** Griglia o piantina: la stessa selezione letta in due modi. */
  view: 'griglia' | 'piantina';
  onView: (next: 'griglia' | 'piantina') => void;
}

export const SelezionaTavolo: React.FC<SelezionaTavoloProps> = ({
  rows, rooms, billByTable, roomId, onRoom, filter, onFilter,
  query, onQuery, busy, onPick, onBack, view, onView,
}) => {
  const searchRef = useRef<HTMLInputElement | null>(null);

  // «/» porta il cursore nella ricerca, come ovunque nell'app. Ignorata
  // mentre si sta già scrivendo, o cercare un tavolo «1/2» diventa impossibile.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const roomName = useMemo(
    () => new Map(rooms.map(r => [r.id, r.name])),
    [rooms]
  );

  // Lo scope si applica per primo: tutto quello che viene dopo — conteggi di
  // stato compresi — parla della sala scelta.
  const inRoom = useMemo(
    () => (roomId === 'ALL' ? rows : rows.filter(r => String(r.table.room_id) === roomId)),
    [rows, roomId]
  );
  const counts = useMemo(() => countByState(inRoom), [inRoom]);
  const visible = useMemo(
    () => inRoom.filter(r => (filter === 'ALL' || r.state === filter) && matchesQuery(r, query)),
    [inRoom, filter, query]
  );

  // Occupati su totali, per sala. Conta TAVOLI: un'unione pesa per due (§10).
  const roomCount = (id: string) => {
    const scoped = id === 'ALL' ? rows : rows.filter(r => String(r.table.room_id) === id);
    const busyCount = scoped.filter(r => r.state === 'bill' || r.state === 'order').length;
    return { busy: busyCount, total: scoped.length };
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onQuery(''); return; }
    if (e.key !== 'Enter' || visible.length !== 1) return;
    e.preventDefault();
    onPick(visible[0].table.id);
  };

  const filterOptions = [
    { value: 'ALL' as TableFilter, label: 'Tutti', badge: inRoom.length, badgeTone: 'neutral' as const },
    ...TABLE_GROUPS.map(g => ({
      value: g.state as TableFilter,
      label: g.chip,
      badge: counts[g.state],
      badgeTone: 'neutral' as const,
    })),
  ];

  // Una sala chiusa resta selezionabile e lo dichiara: SegmentedControl non
  // ha opzioni disabilitate, e non è questo il momento di aggiungergliele.
  // Sceglierla mostra lo stato vuoto, che dice la stessa cosa senza inventare
  // un trattamento nuovo.
  const roomOptions = [
    { value: 'ALL', label: `Tutte le sale · ${roomCount('ALL').busy}/${roomCount('ALL').total}` },
    ...rooms.map(r => {
      const c = roomCount(String(r.id));
      return {
        value: String(r.id),
        label: r.is_closed ? `${r.name} · chiusa` : `${r.name} · ${c.busy}/${c.total}`,
      };
    }),
  ];

  /** Il meta della tessera in Cassa: quanto deve il tavolo, e dove sta. In
   *  Comande sono i coperti — lì la domanda è un'altra. */
  const renderMeta = (row: TableRow) => {
    const bill = billByTable.get(row.table.id);
    const sala = roomName.get(row.table.room_id);
    return (
      <>
        {bill && bill.residual_cents > 0 ? (
          <span className={`text-[13px] font-semibold tabular-nums ${TABLE_CAPTION[row.state]}`}>
            {euro(bill.residual_cents)}
          </span>
        ) : (
          <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
            {row.table.seats} posti
          </span>
        )}
        {sala && (
          <span className="max-w-full truncate px-1 text-[11px] text-[var(--ds-text-muted)]">
            {sala}
          </span>
        )}
      </>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mx-auto w-full max-w-[1400px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8 lg:pt-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Torna alla coda"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface)] text-[var(--ds-text-secondary)] shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] hover:text-[var(--ds-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <h1 className="flex-1 text-[20px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:text-[26px]">
            Seleziona tavolo
          </h1>
          <SegmentedControl<'griglia' | 'piantina'>
            value={view}
            onChange={onView}
            options={[
              { value: 'griglia', label: 'Griglia' },
              { value: 'piantina', label: 'Piantina' },
            ]}
            ariaLabel="Griglia o piantina"
            equalWidth={false}
            size="sm"
          />
        </div>

        <SearchField
          value={query}
          onChange={onQuery}
          inputRef={searchRef}
          onKeyDown={onSearchKey}
          placeholder="Tavolo o nome ospite…"
          ariaLabel="Cerca un tavolo o un ospite"
          className="mt-3 w-full"
        />

        {/* Le sale stanno sopra perché si scelgono prima: cambiano l'insieme,
            non lo restringono. Stesso trattamento dei filtri qui sotto — il
            nero pieno nel design system è dell'azione, e usarlo qui farebbe
            leggere lo scope come un bottone (§7.4). */}
        <div className="mt-3">
          <SegmentedControl<string>
            value={roomId}
            onChange={onRoom}
            options={roomOptions}
            ariaLabel="Scegli la sala"
            equalWidth={false}
            overflow="scroll"
          />
        </div>

        <div className="mt-2">
          <SegmentedControl<TableFilter>
            value={filter}
            onChange={onFilter}
            options={filterOptions}
            ariaLabel="Filtra i tavoli"
            equalWidth={false}
            overflow="scroll"
          />
        </div>
      </div>

      <div className="mx-auto w-full min-h-0 max-w-[1400px] flex-1 overflow-y-auto px-4 pb-6 lg:px-8">
        {view === 'piantina' ? (
          <Piantina
            rows={visible}
            room={roomId === 'ALL' ? (rooms[0] ?? null) : rooms.find(r => String(r.id) === roomId) ?? null}
            billByTable={billByTable}
            busy={busy}
            onPick={onPick}
          />
        ) : visible.length === 0 ? (
          <div className="mt-2">
            <EmptyState icon={UtensilsCrossed}>
              {query.trim() ? 'Nessun tavolo con questo nome.' : 'Nessun tavolo in questo stato.'}
            </EmptyState>
          </div>
        ) : (
          <TableTiles rows={visible} onPick={onPick} busy={busy} renderMeta={renderMeta} />
        )}

        {busy && (
          <div className="mt-6 flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
            <Loader2 size={16} className="animate-spin" /> Apertura…
          </div>
        )}
      </div>
    </div>
  );
};
