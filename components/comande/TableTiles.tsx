import React from 'react';
import { useTranslation } from 'react-i18next';
import { timePart } from '../../utils/displayTime';
import { SectionHeader } from '../ds';
import {
  TABLE_CAPTION, TABLE_GROUPS, TABLE_TILE, TABLE_TILE_WIDE, TABLE_DOT,
  staleOrderLabel, tableNameLine, tableStatusLine, type TableRow,
} from './tablesView';

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
  /** false: niente sezioni per stato — una griglia sola nell'ordine dato.
   *  È la sala della variante a pagine: lì il gruppo è la sala, e lo stato
   *  lo dicono già la tinta e la didascalia della tessera. */
  grouped?: boolean;
  /** 'square' è la tessera storica (numero al centro, meta sotto) e resta il
   *  default: Cassa monta questo stesso componente e non deve cambiare.
   *  'wide' è la tessera di Comande — numero e pallino in testa, chi è al
   *  tavolo, quanto sta spendendo e a che punto è. `renderMeta` non vale per
   *  la wide: lì il contenuto È la riga di stato, non un'aggiunta. */
  variant?: 'square' | 'wide';
}

/** Il meta di Comande: quanti coperti, in che stato, e per chi è tenuto.
 *  È un componente e non una funzione perché le sue parole si traducono, e
 *  una funzione non può chiamare un hook. `renderMeta` resta però una
 *  `(row) => ReactNode`: Cassa ne passa una sua e non deve saperlo. */
const DefaultTableMeta: React.FC<{ row: TableRow }> = ({ row }) => {
  const { t } = useTranslation('comande', { useSuspense: false });
  const { table, state, reservation } = row;
  // La comanda appesa di un servizio passato si presenta per quello che è:
  // «appesa da ieri», non «comanda aperta» come se fosse servizio vivo.
  const gruppo = TABLE_GROUPS.find(g => g.state === state);
  const caption = state === 'order' && row.order?.stale
    ? staleOrderLabel(row.order, t)
    : (gruppo?.captionKey ? t(gruppo.captionKey, gruppo.caption ?? '') : gruppo?.caption);
  return (
    <>
      <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
        {t('tile.covers', { n: row.groupSeats ?? table.seats })}
      </span>
      {caption && (
        <span className={`text-[11px] font-semibold ${TABLE_CAPTION[state]}`}>
          {caption}
        </span>
      )}
      {state === 'booked' && reservation && (
        <span className={`max-w-full truncate px-1 text-[11px] font-medium ${TABLE_CAPTION.booked}`}>
          {timePart(reservation.reservation_time)} · {reservation.customer_name}
        </span>
      )}
    </>
  );
};

export const defaultTableMeta = (row: TableRow): React.ReactNode => <DefaultTableMeta row={row} />;

export const TableTiles: React.FC<TableTilesProps> = ({
  rows, onPick, busy, renderMeta = defaultTableMeta, grouped = true, variant = 'square',
}) => {
  const { t } = useTranslation('comande', { useSuspense: false });
  const squareTile = (row: TableRow) => (
    <button
      key={row.table.id}
      type="button"
      onClick={() => onPick(row.pickId ?? row.table.id)}
      disabled={busy}
      className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[var(--ds-radius)] p-1 shadow-[var(--ds-shadow-card)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${TABLE_TILE[row.state]}`}
    >
      <span className={`${row.groupLabel ? 'text-[18px]' : 'text-[24px]'} max-w-full truncate font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)]`}>
        {row.groupLabel ?? row.table.name}
      </span>
      {renderMeta(row)}
    </button>
  );

  /* La tessera di Comande. Quattro righe in ordine di quanto servono a chi
     guarda: quale tavolo, quanti sono, chi è, a che punto sta.

     La riga di stato VA A CAPO invece di troncare. «140,00 € da incass…» e
     «3ª in cuci…» erano tagliate già nel mockup, e sono esattamente le due
     tessere che qualcuno deve leggere di fretta: un conto grosso da riscuotere
     e un'uscita ancora in cucina. */
  const wideTile = (row: TableRow) => (
    <button
      key={row.table.id}
      type="button"
      onClick={() => onPick(row.pickId ?? row.table.id)}
      disabled={busy}
      className={`flex min-h-[132px] flex-col items-start gap-0.5 rounded-[var(--ds-radius)] px-3 py-2.5 text-left shadow-[var(--ds-shadow-card)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${TABLE_TILE_WIDE[row.state]}`}
    >
      <span className="flex w-full items-start justify-between gap-2">
        <span className={`${row.groupLabel ? 'text-[19px]' : 'text-[26px]'} min-w-0 truncate font-semibold leading-tight tracking-[-0.02em] ${TABLE_CAPTION[row.state]}`}>
          {row.groupLabel ?? row.table.name}
        </span>
        <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${TABLE_DOT[row.state]}`} aria-hidden />
      </span>
      <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
        {t('tile.covers', { n: row.groupSeats ?? row.table.seats })}
      </span>
      <span className="mt-auto w-full truncate pt-1 text-[13px] font-medium text-[var(--ds-text-primary)]">
        {tableNameLine(row)}
      </span>
      <span className={`w-full text-[11px] font-semibold leading-tight ${TABLE_CAPTION[row.state]}`}>
        {tableStatusLine(row, t)}
      </span>
    </button>
  );

  const tile = variant === 'wide' ? wideTile : squareTile;
  const gridClass = variant === 'wide'
    ? 'grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7'
    : 'grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-9';

  if (!grouped) {
    return (
      <div className={gridClass}>
        {rows.map(tile)}
      </div>
    );
  }

  return (
    <>
      {TABLE_GROUPS.map(group => {
        const group_rows = rows.filter(r => r.state === group.state);
        if (group_rows.length === 0) return null;
        return (
          <section key={group.state} className="mt-4 first:mt-0">
            <SectionHeader tone={group.tone} meta={String(group_rows.length)}>
              {t(group.labelKey, group.label)}
            </SectionHeader>
            <div className={`mt-2 ${gridClass}`}>
              {group_rows.map(tile)}
            </div>
          </section>
        );
      })}
    </>
  );
};
