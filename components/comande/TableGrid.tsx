import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, SlidersHorizontal, UtensilsCrossed } from 'lucide-react';
import type { Room } from '../../types';
import { DateNavigator } from '../DateNavigator';
import { EmptyState, SearchField, SegmentedControl } from '../ds';
import {
  TABLE_GROUPS, countByState, matchesQuery,
  type TableFilter, type TableRow,
} from './tablesView';
import { TableTiles } from './TableTiles';

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
  /** Variante a pagine (stile cassa): una sala alla volta, scelta dalla
   *  pista in basso — dove stavano le linguette sale di Passepartout. Le
   *  tessere perdono le sezioni per stato (il gruppo è la sala; lo stato lo
   *  dicono tinta e didascalia) e il filtro per stato non compare. */
  paged?: boolean;
  rooms?: Room[];
  /** Sala selezionata (variante a pagine). null = la prima con tavoli. */
  room?: number | null;
  onRoom?: (id: number) => void;
  /** Lo schermo largo: Comande si prende la pagina intera, quindi la testata
   *  della pagina È la chrome dell'app — marchio, ricerca, imbuto, Live. La
   *  griglia va piatta (ordine = numero di tavolo) con le sale in pista:
   *  chi cerca cerca IL SUO tavolo, non uno stato. Lo stato resta leggibile
   *  sulla tessera, e filtrarci sopra si fa dall'imbuto. */
  wide?: boolean;
  /** Il marchio a sinistra e la pastiglia Live a destra, montati da chi
   *  possiede la pagina: la griglia non conosce né il tenant né il socket. */
  brand?: React.ReactNode;
  live?: React.ReactNode;
  /** Giorno e turno del servizio, che sullo schermo largo non hanno più la
   *  barra globale: vivono nell'imbuto. Senza di loro non si riprende una
   *  comanda appesa di un servizio passato. */
  date?: string;
  onDate?: (isoDay: string) => void;
  shift?: 'ALL' | 'LUNCH' | 'DINNER';
  onShift?: (next: 'ALL' | 'LUNCH' | 'DINNER') => void;
}

export const TableGrid: React.FC<TableGridProps> = ({
  rows, filter, onFilter, query, onQuery, busy, onPick, notice,
  paged = false, rooms = [], room = null, onRoom,
  wide = false, brand, live, date, onDate, shift, onShift,
}) => {
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [funnelOpen, setFunnelOpen] = useState(false);

  const counts = useMemo(() => countByState(rows), [rows]);
  // Le sale in pista: solo quelle con almeno un tavolo in griglia.
  const roomTabs = useMemo(
    () => (paged || wide ? rooms.filter(rm => rows.some(r => r.table.room_id === rm.id)) : []),
    [paged, wide, rooms, rows]
  );
  // Due letture diverse dello stesso `room`: nella variante a pagine si sta
  // SEMPRE dentro una sala (null = la prima), sullo schermo largo «Tutte» è
  // una scelta legittima e anzi il default — la sala intera a colpo d'occhio
  // è il motivo per cui questa pagina esiste su un monitor.
  const activeRoom = paged
    ? (room != null && roomTabs.some(rm => rm.id === room) ? room : roomTabs[0]?.id ?? null)
    : wide
      ? (room != null && roomTabs.some(rm => rm.id === room) ? room : null)
      : null;
  // Cercando si cerca in tutta la sala — anzi, in tutte: il «33» va trovato
  // anche se la pista è ferma su un'altra sala (stessa regola del menu).
  const visible = useMemo(
    () => rows.filter(r =>
      (filter === 'ALL' || r.state === filter)
      && matchesQuery(r, query)
      && ((!paged && !wide) || query.trim() !== '' || activeRoom == null || r.table.room_id === activeRoom)),
    [rows, filter, query, paged, wide, activeRoom]
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
      <div className={`mx-auto w-full max-w-[1400px] flex-shrink-0 px-4 pb-3 lg:px-8 ${wide ? 'pt-4' : 'pt-4 lg:pt-8'}`}>
        {wide ? (
          <>
            {/* La chrome della pagina: marchio staccato a sinistra, poi una
                barra sola con la ricerca, l'imbuto e il Live. Sullo schermo
                largo Comande non ha più la testata dell'app sopra di sé, e
                questa riga ne fa le veci — senza il pettine di controlli che
                in servizio non si usano. */}
            <div className="flex items-center gap-3">
              {brand}
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[28px] bg-[var(--ds-surface)] px-3 py-2.5 shadow-[var(--ds-shadow-card)]">
                <SearchField
                  value={query}
                  onChange={onQuery}
                  inputRef={searchRef}
                  onKeyDown={onSearchKey}
                  placeholder="Vai al tavolo…"
                  ariaLabel="Cerca un tavolo"
                  className="min-w-0 flex-1"
                  recessed
                />
                {/* L'imbuto tiene ciò che non si tocca a ogni tavolo ma non può
                    sparire: lo stato, il giorno e il turno. Il giorno in
                    particolare è la strada per riprendere una comanda appesa
                    di un servizio passato. Il pallino dice che un filtro è
                    acceso — c'è o non c'è, il colore non porta il segnale da
                    solo (§4.3). */}
                <div className="relative flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => setFunnelOpen(o => !o)}
                    aria-haspopup="dialog"
                    aria-expanded={funnelOpen}
                    aria-label="Filtri, giorno e turno"
                    className="relative inline-flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
                  >
                    <SlidersHorizontal size={18} aria-hidden />
                    {filter !== 'ALL' && (
                      <span className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[var(--ds-action-bg)]" aria-hidden />
                    )}
                  </button>
                  {funnelOpen && (
                    <>
                      {/* Il velo prende il clic fuori e chiude: senza, il
                          pannello resta aperto sotto le dita di chi è già
                          passato a un tavolo. */}
                      <button
                        type="button"
                        aria-label="Chiudi i filtri"
                        className="fixed inset-0 z-40 cursor-default"
                        onClick={() => setFunnelOpen(false)}
                      />
                      <div
                        role="dialog"
                        aria-label="Filtri, giorno e turno"
                        className="absolute right-0 top-[52px] z-50 w-[320px] rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-raised)]"
                      >
                        <div className="text-[13px] font-semibold text-[var(--ds-text-muted)]">Stato</div>
                        <div className="mt-2">
                          <SegmentedControl<TableFilter>
                            value={filter}
                            onChange={onFilter}
                            options={filterOptions}
                            ariaLabel="Filtra i tavoli"
                            equalWidth={false}
                            overflow="scroll"
                            size="sm"
                          />
                        </div>
                        {date && onDate && (
                          <>
                            <div className="mt-4 text-[13px] font-semibold text-[var(--ds-text-muted)]">Giorno</div>
                            <div className="mt-2">
                              <DateNavigator value={date} onChange={onDate} widthClass="w-full" backToToday="below" />
                            </div>
                          </>
                        )}
                        {shift && onShift && (
                          <>
                            <div className="mt-4 text-[13px] font-semibold text-[var(--ds-text-muted)]">Turno</div>
                            <div className="mt-2">
                              <SegmentedControl<'ALL' | 'LUNCH' | 'DINNER'>
                                value={shift}
                                onChange={onShift}
                                options={[
                                  { value: 'LUNCH', label: 'Pranzo' },
                                  { value: 'DINNER', label: 'Cena' },
                                  { value: 'ALL', label: 'Tutti' },
                                ]}
                                ariaLabel="Turno"
                              />
                            </div>
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
                {live}
              </div>
            </div>

            {/* Le sale in pista, con quanti tavoli hanno. «Tutte» in testa
                perché su un monitor la sala intera è la vista di partenza. */}
            {roomTabs.length > 1 && (
              <div className="mt-3">
                <SegmentedControl<string>
                  value={activeRoom == null ? 'ALL' : String(activeRoom)}
                  onChange={(next) => onRoom?.(next === 'ALL' ? -1 : Number(next))}
                  options={[
                    { value: 'ALL', label: 'Tutte', badge: rows.length, badgeTone: 'neutral' as const },
                    ...roomTabs.map(rm => ({
                      value: String(rm.id),
                      label: rm.name,
                      badge: rows.filter(r => r.table.room_id === rm.id).length,
                      badgeTone: 'neutral' as const,
                    })),
                  ]}
                  ariaLabel="Scegli la sala"
                  equalWidth={false}
                  overflow="scroll"
                />
              </div>
            )}
          </>
        ) : (
          <>
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
                bianco e sollevato. Il nero pieno è dell'azione (§7.4). Nella
                variante a pagine non c'è: lì si sfoglia per sala, come in cassa. */}
            {!paged && (
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
            )}
          </>
        )}
      </div>

      {/* La zona che scorre. Lo scorrimento ritaglia su ogni lato, quindi il
          padding serve anche a dare aria alle ombre delle tessere (regola 11)
          — il pt compreso: senza, la prima riga esce col bordo alto mozzato. */}
      <div className="mx-auto w-full min-h-0 max-w-[1400px] flex-1 overflow-y-auto px-4 pb-6 pt-2 lg:px-8">
      {notice && <div className="mb-4">{notice}</div>}

      {visible.length === 0 ? (
        <div className="mt-2">
          <EmptyState icon={UtensilsCrossed}>
            {query.trim() ? 'Nessun tavolo con questo nome.' : 'Nessun tavolo in questo stato.'}
          </EmptyState>
        </div>
      ) : (
        <TableTiles
          rows={visible}
          onPick={onPick}
          busy={busy}
          grouped={!paged && !wide}
          variant={wide ? 'wide' : 'square'}
        />
      )}

      {busy && (
        <div className="mt-6 flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
          <Loader2 size={16} className="animate-spin" /> Apertura…
        </div>
      )}
      </div>

      {/* La pista delle sale, ancorata in basso come le linguette di
          Passepartout: pastiglia attiva piena, pallino sulle sale con
          qualcosa da fare (comanda aperta o conto da incassare) — c'è o non
          c'è, il colore non porta l'informazione da solo (§4.3). */}
      {paged && roomTabs.length > 1 && (
        <div className="mx-auto w-full max-w-[1400px] flex-shrink-0 px-4 pb-3 pt-2 lg:px-8">
          <div className="-my-1.5 flex gap-2 overflow-x-auto py-1.5 scrollbar-hide">
            {roomTabs.map(rm => {
              const active = rm.id === activeRoom;
              const marked = rows.some(r =>
                r.table.room_id === rm.id && (r.state === 'bill' || r.state === 'order'));
              return (
                <button
                  key={rm.id}
                  type="button"
                  onClick={() => onRoom?.(rm.id)}
                  aria-pressed={active}
                  className={`inline-flex h-11 flex-shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-4 text-[15px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                    active
                      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
                      : 'bg-[var(--ds-surface)] text-[var(--ds-text-primary)] shadow-[var(--ds-shadow-card)]'
                  }`}
                >
                  {rm.name}
                  {marked && (
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                        active ? 'bg-[var(--ds-action-fg)]' : 'bg-[var(--ds-text-muted)]'
                      }`}
                      aria-hidden
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
