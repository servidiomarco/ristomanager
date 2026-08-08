import React, { useEffect, useMemo, useRef } from 'react';
import { Loader2, UtensilsCrossed } from 'lucide-react';
import { getRomeTimePart } from '../../utils/reservationTime';
import { EmptyState, SearchField, SectionHeader, SegmentedControl } from '../ds';
import {
  TABLE_CAPTION, TABLE_GROUPS, TABLE_TILE, countByState, matchesQuery,
  type TableFilter, type TableRow,
} from './tablesView';

interface TableGridProps {
  rows: TableRow[];
  filter: TableFilter;
  onFilter: (next: TableFilter) => void;
  query: string;
  onQuery: (next: string) => void;
  busy: boolean;
  onPick: (tableId: number) => void;
  /** Errori, conferme e fogli conto: la griglia li mostra, non li possiede. */
  notice?: React.ReactNode;
}

export const TableGrid: React.FC<TableGridProps> = ({
  rows, filter, onFilter, query, onQuery, busy, onPick, notice,
}) => {
  const searchRef = useRef<HTMLInputElement | null>(null);

  const counts = useMemo(() => countByState(rows), [rows]);
  const visible = useMemo(
    () => rows.filter(r => (filter === 'ALL' || r.state === filter) && matchesQuery(r, query)),
    [rows, filter, query]
  );

  // «/» porta il cursore nella ricerca, come ovunque nell'app. Ignorata mentre
  // si sta già scrivendo da qualche parte, altrimenti cercare un tavolo che si
  // chiama «1/2» diventa impossibile.
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

  // Invio apre il tavolo quando ne è rimasto uno solo. È il gesto per cui la
  // ricerca esiste: si digita 33 e si è dentro, senza staccare la mano.
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { onQuery(''); return; }
    if (e.key !== 'Enter' || visible.length !== 1) return;
    e.preventDefault();
    onPick(visible[0].table.id);
  };

  const filterOptions = [
    { value: 'ALL' as TableFilter, label: 'Tutti', badge: rows.length, badgeTone: 'neutral' as const },
    ...TABLE_GROUPS.map(g => ({
      value: g.state as TableFilter,
      label: g.chip,
      badge: counts[g.state],
      badgeTone: 'neutral' as const,
    })),
  ];

  return (
    // La pagina possiede il proprio scorrimento invece di lasciar scorrere il
    // contenitore dell'app. È quello che tiene i tavoli SOPRA la barra di
    // navigazione flottante: il contenitore dell'app riserva alla barra il suo
    // spazio (.pb-mobile-nav), quindi un riquadro alto quanto quel box finisce
    // già sopra la barra, e le tessere si tagliano lì invece di passarle
    // dietro e ricomparire sotto. È come stanno Attività e le altre pagine.
    <div className="flex h-full min-h-0 flex-col">
      {/* Testata ferma. Il padding in basso vive QUI, non sulla zona che
          scorre: sotto c'è una regione opaca che dipinge dopo, e con lo spazio
          dall'altra parte coprirebbe l'ombra dei chip tagliandola di netto
          (regola 10). */}
      <div className="mx-auto w-full max-w-[1400px] flex-shrink-0 px-4 pb-3 pt-4 lg:px-8 lg:pt-8">
        {/* Il titolo sparisce sul telefono: lo schermo è tutto per i tavoli, e
            dove sei lo dice già la navigazione in basso. Sul desktop resta —
            lì lo spazio verticale non è la risorsa scarsa. */}
        <h1 className="hidden text-[26px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)] lg:block">
          Comande
        </h1>

        {/* La ricerca per tutta la larghezza: è il primo gesto della pagina,
            non un accessorio del titolo. I conteggi non si ripetono in un
            sottotitolo — stanno già nei chip, e una riga in meno fra la
            testata e i tavoli è una riga in meno da saltare (§10). */}
        <SearchField
          value={query}
          onChange={onQuery}
          inputRef={searchRef}
          onKeyDown={onSearchKey}
          placeholder="Vai al tavolo…"
          ariaLabel="Cerca un tavolo"
          className="w-full lg:mt-3"
        />

        {/* Un filtro restringe un insieme che resta lo stesso insieme, quindi
            prende il trattamento del filtro: pista incassata, segmento attivo
            bianco e sollevato. Il nero pieno è dell'azione (§7.4). */}
        <div className="mt-3">
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

      {/* La zona che scorre. Lo scorrimento verticale ritaglia anche in
          orizzontale, quindi il padding laterale serve anche a dare aria alle
          ombre delle tessere (regola 11). */}
      <div className="mx-auto w-full min-h-0 max-w-[1400px] flex-1 overflow-y-auto px-4 pb-6 lg:px-8">
      {notice && <div className="mb-4">{notice}</div>}

      {visible.length === 0 ? (
        <div className="mt-2">
          <EmptyState icon={UtensilsCrossed}>
            {query.trim() ? 'Nessun tavolo con questo nome.' : 'Nessun tavolo in questo stato.'}
          </EmptyState>
        </div>
      ) : (
        TABLE_GROUPS.map(group => {
          const group_rows = visible.filter(r => r.state === group.state);
          if (group_rows.length === 0) return null;
          return (
            <section key={group.state} className="mt-4 first:mt-0">
              <SectionHeader tone={group.tone} meta={String(group_rows.length)}>
                {group.label}
              </SectionHeader>
              <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-7 xl:grid-cols-9">
                {group_rows.map(({ table, state, reservation }) => (
                  <button
                    key={table.id}
                    type="button"
                    onClick={() => onPick(table.id)}
                    disabled={busy}
                    className={`flex aspect-square flex-col items-center justify-center gap-0.5 rounded-[20px] p-1 shadow-[var(--ds-shadow-card)] transition-shadow disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${TABLE_TILE[state]}`}
                  >
                    <span className="text-[24px] font-semibold tracking-[-0.02em] text-[var(--ds-text-primary)]">
                      {table.name}
                    </span>
                    <span className="text-[12px] tabular-nums text-[var(--ds-text-muted)]">
                      {table.seats} cop.
                    </span>
                    {group.caption && (
                      <span className={`text-[11px] font-semibold ${TABLE_CAPTION[state]}`}>
                        {group.caption}
                      </span>
                    )}
                    {state === 'booked' && reservation && (
                      <span className={`max-w-full truncate px-1 text-[11px] font-medium ${TABLE_CAPTION.booked}`}>
                        {getRomeTimePart(reservation.reservation_time)} · {reservation.customer_name}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </section>
          );
        })
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
