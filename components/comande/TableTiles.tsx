import React from 'react';
import { getRomeTimePart } from '../../utils/reservationTime';
import { SectionHeader } from '../ds';
import { TABLE_CAPTION, TABLE_GROUPS, TABLE_TILE, type TableRow } from './tablesView';

/* ── I tavoli raggruppati per stato ───────────────────────────────────────
   Estratto da TableGrid perché Cassa mostra la stessa griglia dentro un'altra
   pagina (docs/cassa-plan.md §8): stesso ordine dei gruppi, stesse tinte,
   stesse tessere — cambia solo cosa c'è scritto sotto il nome del tavolo, che
   in Comande sono i coperti e in Cassa è quello che il tavolo deve.

   Il guscio della pagina resta di chi la possiede: titolo, ricerca, filtri e
   stato vuoto non sono qui. Questo componente sa una cosa sola — come si
   impagina un elenco di tavoli già filtrato.

   TableGrid continua a renderizzarlo con il meta di sempre: la griglia di
   Comande non cambia di un pixel. */

interface TableTilesProps {
  /** Righe GIÀ filtrate: filtrare è del chiamante, che sa con che criterio. */
  rows: TableRow[];
  onPick: (tableId: number) => void;
  busy?: boolean;
  /** Cosa va sotto il nome del tavolo. Il default è quello di Comande. */
  renderMeta?: (row: TableRow) => React.ReactNode;
}

/** Il meta di Comande: quanti coperti, in che stato, e per chi è tenuto. */
export const defaultTableMeta = (row: TableRow): React.ReactNode => {
  const { table, state, reservation } = row;
  const caption = TABLE_GROUPS.find(g => g.state === state)?.caption;
  return (
    <>
      <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
        {row.groupSeats ?? table.seats} cop.
      </span>
      {caption && (
        <span className={`text-[11px] font-semibold ${TABLE_CAPTION[state]}`}>
          {caption}
        </span>
      )}
      {state === 'booked' && reservation && (
        <span className={`max-w-full truncate px-1 text-[11px] font-medium ${TABLE_CAPTION.booked}`}>
          {getRomeTimePart(reservation.reservation_time)} · {reservation.customer_name}
        </span>
      )}
    </>
  );
};

export const TableTiles: React.FC<TableTilesProps> = ({
  rows, onPick, busy, renderMeta = defaultTableMeta,
}) => (
  <>
    {TABLE_GROUPS.map(group => {
      const group_rows = rows.filter(r => r.state === group.state);
      if (group_rows.length === 0) return null;
      return (
        <section key={group.state} className="mt-4 first:mt-0">
          <SectionHeader tone={group.tone} meta={String(group_rows.length)}>
            {group.label}
          </SectionHeader>
          <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-9">
            {group_rows.map(row => (
              <button
                key={row.table.id}
                type="button"
                onClick={() => onPick(row.pickId ?? row.table.id)}
                disabled={busy}
                className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[20px] p-1 shadow-[var(--ds-shadow-card)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${TABLE_TILE[row.state]}`}
              >
                <span className={`${row.groupLabel ? 'text-[18px]' : 'text-[24px]'} max-w-full truncate font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)]`}>
                  {row.groupLabel ?? row.table.name}
                </span>
                {renderMeta(row)}
              </button>
            ))}
          </div>
        </section>
      );
    })}
  </>
);
