import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2, Play, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { socketClient } from '../services/socketClient';
import {
  getKdsQueue, setKdsItemStatus, getMenuCatalogue,
  type KdsItem, type KdsCourseState, type MenuCatalogue,
} from '../services/ordersApiService';
import { getKitchenServiceSummary, type KitchenServiceSummary } from '../services/apiService';
import { getRomeDatePart } from '../utils/reservationTime';
import { ModalShell, EmptyState, StatusPill, dsButton } from './ds';

// ---------------------------------------------------------------------------
// Monitor di partita — una istanza per postazione (Antipasti, Primi, Griglia).
//
// Si usa con le mani sporche, da un metro di distanza: bersagli grandi, niente
// interazioni fini, nessun menu a tendina durante il servizio.
//
// Due zone: "da fare" e "in arrivo". La seconda esiste per il lancio
// scaglionato — la Griglia parte subito e i Primi sei minuti dopo, così
// arrivano al passe insieme. Il cuoco vede cosa sta per arrivare senza
// iniziare troppo presto, e può sempre forzare con "inizia ora".
// ---------------------------------------------------------------------------

const STATION_KEY = 'kds.station_id';

// Oltre questa attesa la riga pronta sta morendo sotto la lampada mentre le
// altre partite finiscono: il bordo lampeggia.
const LAMP_ALERT_MIN = 4;

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];

// Mai negativo: `now` avanza a scatti di 15 secondi e può risultare indietro
// rispetto a un timestamp appena scritto dal server, che mostrerebbe "-1′".
const minutesSince = (iso: string | null, now: number): number =>
  iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000)) : 0;

const minutesUntil = (iso: string | null, now: number): number =>
  iso ? Math.ceil((new Date(iso).getTime() - now) / 60000) : 0;

// Verde fino a 5', ambra fino a 10', poi rosso. Il colore non è l'unica
// informazione: accanto c'è sempre il numero. Le famiglie del design system
// invertono già da sole fra tema chiaro e scuro.
const timerTone = (min: number): string =>
  min >= 10 ? 'text-[var(--ds-critical-text)]'
  : min >= 5 ? 'text-[var(--ds-pending-text)]'
  : 'text-[var(--ds-seated-text)]';

/* La scelta della partita: una riga per postazione, alta abbastanza da
   prenderla con il pollice. Il bordo pieno segna quella attiva. */
const stationOption = (active: boolean): string =>
  `flex min-h-[56px] w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left transition-colors ${
    active
      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
  }`;

interface Column {
  key: string;
  order_id: number;
  course_no: number;
  table_name: string | null;
  customer_name: string | null;
  allergens: string | null;
  items: KdsItem[];
  firedAt: string | null;
  waitingOthers: boolean;
}

interface KitchenDisplayProps {
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
}

// Turno "corrente" quando l'utente non ne ha scelto uno esplicito: prima delle
// 17 è pranzo, dopo è cena. Stessa soglia usata dal server per il default.
const DINNER_START_HOUR = 17;
const inferShift = (d: Date): 'LUNCH' | 'DINNER' =>
  d.getHours() < DINNER_START_HOUR ? 'LUNCH' : 'DINNER';

export const KitchenDisplay: React.FC<KitchenDisplayProps> = ({ globalDate, globalShiftFilter }) => {
  const now = useNow(15_000);
  const [stationId, setStationId] = useState<number | null>(() => {
    const saved = localStorage.getItem(STATION_KEY);
    const fromUrl = new URLSearchParams(window.location.search).get('station');
    const raw = fromUrl ?? saved;
    return raw != null && raw !== '' ? Number(raw) : null;
  });
  const [catalogue, setCatalogue] = useState<MenuCatalogue | null>(null);
  const [items, setItems] = useState<KdsItem[]>([]);
  const [courses, setCourses] = useState<KdsCourseState[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [picking, setPicking] = useState(false);
  // Riepilogo del servizio (aggregato lato server dalle note strutturate +
  // dalle dietary_notes clienti). Aggiornato all'apertura e ogni 60s: cambia
  // solo quando nuove prenotazioni entrano nel turno, non serve real-time.
  const [summary, setSummary] = useState<KitchenServiceSummary | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  useEffect(() => { getMenuCatalogue().then(setCatalogue).catch(() => {}); }, []);

  // Il banner segue la data/turno globale dell'header: se il cuoco naviga a
  // "Mar 18 Cena" vuole vedere il riepilogo di quel servizio, non di oggi.
  // Con turno "ALL" ripieghiamo sull'inferenza oraria del giorno selezionato.
  const summaryDate = globalDate ? getRomeDatePart(globalDate) : '';
  const summaryShift: 'LUNCH' | 'DINNER' =
    globalShiftFilter === 'LUNCH' || globalShiftFilter === 'DINNER'
      ? globalShiftFilter
      : inferShift(globalDate ?? new Date());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const params = summaryDate ? { date: summaryDate, shift: summaryShift } : undefined;
      getKitchenServiceSummary(params)
        .then(s => { if (!cancelled) setSummary(s); })
        .catch(() => { /* niente banner: solo dettaglio in meno */ });
    };
    load();
    const poll = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [summaryDate, summaryShift]);

  const reload = useCallback(async () => {
    try {
      const q = await getKdsQueue(stationId);
      setItems(q.items);
      setCourses(q.courses);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [stationId]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  // Un monitor che perde eventi durante un blip di rete e resta indietro è
  // peggio di nessun monitor: alla riconnessione si rilegge tutta la coda,
  // e c'è comunque un ricarico periodico come rete di sicurezza.
  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    if (stationId != null) socketClient.subscribeToStation(stationId);

    const onChange = () => reload();
    socket.on('kds:fired', onChange);
    socket.on('kds:item', onChange);
    socket.on('orderItem:voided', onChange);
    socket.on('connect', onChange);

    const poll = setInterval(reload, 60_000);
    return () => {
      socket.off('kds:fired', onChange);
      socket.off('kds:item', onChange);
      socket.off('orderItem:voided', onChange);
      socket.off('connect', onChange);
      clearInterval(poll);
      if (stationId != null) socketClient.unsubscribeFromStation(stationId);
    };
  }, [stationId, reload]);

  const chooseStation = (id: number | null) => {
    if (id == null) localStorage.removeItem(STATION_KEY);
    else localStorage.setItem(STATION_KEY, String(id));
    setStationId(id);
    setPicking(false);
  };

  const advance = async (item: KdsItem, status: 'PREPARING' | 'READY') => {
    // Aggiornamento ottimistico: in cucina il ritardo di mezzo secondo fra il
    // tocco e la reazione fa ripremere il tasto.
    setItems(prev => prev.map(i => (i.id === item.id ? { ...i, status } : i)));
    try {
      await setKdsItemStatus(item.id, status);
    } catch {
      // Rimettiamo lo stato del server: se la transizione non era ammessa
      // (qualcun altro l'ha già avanzata) il monitor deve dire il vero.
    } finally {
      reload();
    }
  };

  const columns: Column[] = useMemo(() => {
    const map = new Map<string, Column>();
    for (const it of items) {
      const key = `${it.order_id}:${it.course_no}`;
      if (!map.has(key)) {
        const st = courses.find(c => c.order_id === it.order_id && c.course_no === it.course_no);
        map.set(key, {
          key,
          order_id: it.order_id,
          course_no: it.course_no,
          table_name: it.table_name,
          customer_name: it.customer_name,
          allergens: it.customer_dietary_notes || it.reservation_notes,
          items: [],
          firedAt: it.fired_at,
          // L'uscita aspetta anche altre partite oltre alla mia?
          waitingOthers: !!st && st.waiting_station_ids.some(s => s !== stationId),
        });
      }
      map.get(key)!.items.push(it);
    }
    return [...map.values()].sort((a, b) => {
      const ta = a.items[0]?.station_start_at ?? a.firedAt ?? '';
      const tb = b.items[0]?.station_start_at ?? b.firedAt ?? '';
      return ta.localeCompare(tb);
    });
  }, [items, courses, stationId]);

  // "In arrivo" = lanciata ma la mia partita non deve ancora iniziare.
  const isUpcoming = (col: Column): boolean =>
    col.items.every(i => i.status === 'SENT')
    && col.items.every(i => i.station_start_at != null && new Date(i.station_start_at).getTime() > now);

  const todo = columns.filter(c => !isUpcoming(c));
  const upcoming = columns.filter(isUpcoming);

  const stationName = stationId == null
    ? 'Senza partita'
    : catalogue?.stations.find(s => s.id === stationId)?.name ?? `Partita ${stationId}`;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-10 text-[15px] text-[var(--ds-text-muted)]">
        <Loader2 className="animate-spin" size={18} /> Caricamento coda…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)]">
      {/* Una card che galleggia sulla tela, come le altre intestazioni di
          pagina — non una barra a filo con una linea sotto. */}
      <div className="flex-shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 pl-4 shadow-[var(--ds-shadow-card)]">
          {/* Il nome della partita in tondo, non in maiuscolo: a un metro di
              distanza conta il corpo, e le maiuscole cancellano la forma della
              parola invece di renderla più leggibile (§5.2). */}
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {stationName}
          </h1>
          <span className="flex-shrink-0 text-[15px] text-[var(--ds-text-muted)] tabular-nums">
            {todo.length} in lavorazione
          </span>
          {offline && (
            <StatusPill tone="pending">
              <WifiOff size={13} aria-hidden /> riconnessione…
            </StatusPill>
          )}
          <button
            type="button"
            onClick={() => setPicking(true)}
            className={`ml-auto flex-shrink-0 ${dsButton.quiet}`}
          >
            Cambia partita
          </button>
        </div>
      </div>

      {summary && (summary.dietary.length > 0 || summary.dietary_lines.length > 0) && (
        <ServiceSummaryBanner
          summary={summary}
          open={summaryOpen}
          onToggle={() => setSummaryOpen(o => !o)}
        />
      )}

      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 pb-4">
        {todo.length === 0 && upcoming.length === 0 ? (
          <EmptyState icon={Check}>Nessuna comanda in coda.</EmptyState>
        ) : (
          <div className="flex h-full items-start gap-4">
            {todo.map(col => (
              <CourseCard key={col.key} col={col} now={now} stationId={stationId} onAdvance={advance} />
            ))}
          </div>
        )}
      </div>

      {upcoming.length > 0 && (
        <div className="flex-shrink-0 px-4 pb-4">
          <div className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">In arrivo</div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {upcoming.map(col => {
              const wait = minutesUntil(col.items[0]?.station_start_at ?? null, now);
              return (
                // Bordo tratteggiato invece di un'opacità: l'opacità porta il
                // testo sotto il minimo di contrasto proprio sullo schermo che
                // si legge da lontano.
                <div
                  key={col.key}
                  className="flex-shrink-0 rounded-[16px] border-2 border-dashed border-[var(--ds-border-strong)] px-3 py-2"
                >
                  <div className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
                    T{col.table_name} · {ORDINALS[col.course_no] ?? col.course_no} usc.
                  </div>
                  <div className="text-[13px] text-[var(--ds-text-muted)]">
                    {col.items.map(i => `${i.qty} ${i.name_snapshot}`).join(', ')}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-[var(--ds-text-primary)] tabular-nums">
                      fra {Math.max(wait, 1)}′
                    </span>
                    {/* 44px: si preme con le mani sporche, non col mouse. */}
                    <button
                      type="button"
                      onClick={() => col.items.forEach(i => advance(i, 'PREPARING'))}
                      className="inline-flex h-11 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
                    >
                      <Play size={13} aria-hidden /> inizia ora
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ModalShell
        open={picking}
        onClose={() => setPicking(false)}
        title="Partita di questo schermo"
        subtitle="Resta impostata anche dopo un riavvio del tablet."
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
      >
        <div className="flex flex-col gap-2">
          {catalogue?.stations.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => chooseStation(s.id)}
              aria-pressed={s.id === stationId}
              className={stationOption(s.id === stationId)}
            >
              <span className="min-w-0 flex-1 text-[16px] font-semibold">{s.name}</span>
              {s.id === stationId && <Check size={18} className="flex-shrink-0" aria-hidden />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => chooseStation(null)}
            aria-pressed={stationId == null}
            className={stationOption(stationId == null)}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[16px] font-semibold">Senza partita</span>
              <span className={`block text-[13px] ${stationId == null ? 'opacity-80' : 'text-[var(--ds-text-muted)]'}`}>
                piatti non ancora assegnati
              </span>
            </span>
            {stationId == null && <Check size={18} className="flex-shrink-0" aria-hidden />}
          </button>
        </div>
      </ModalShell>
    </div>
  );
};

const CourseCard: React.FC<{
  col: Column;
  now: number;
  stationId: number | null;
  onAdvance: (item: KdsItem, status: 'PREPARING' | 'READY') => void;
}> = ({ col, now, onAdvance }) => {
  const start = col.items[0]?.station_start_at ?? col.firedAt;
  const elapsed = minutesSince(start, now);
  const allReady = col.items.every(i => i.status === 'READY');

  // Ho finito ma l'uscita no: da qui in poi il piatto peggiora sotto la
  // lampada, e il ritardo è di qualcun altro. Il bordo lampeggia per dirlo.
  const readySince = allReady
    ? Math.min(...col.items.map(i => minutesSince(i.ready_at, now)))
    : 0;
  const lampAlert = allReady && col.waitingOthers && readySince >= LAMP_ALERT_MIN;

  return (
    // Lo stato viaggia su un anello, non su un bordo: la card è una superficie
    // bianca sulla tela come tutte le altre, e l'anello si disegna fuori dal
    // riquadro senza spostare di due pixel il contenuto quando cambia stato.
    <div
      className={`flex max-h-full w-60 flex-shrink-0 flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] ${
        lampAlert
          ? 'animate-pulse ring-2 ring-[var(--ds-critical-solid)]'
          : allReady
          ? 'ring-2 ring-[var(--ds-seated-solid)]'
          : ''
      }`}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            T{col.table_name ?? '—'}
          </span>
          <span className={`ml-auto text-[20px] font-semibold tabular-nums ${timerTone(elapsed)}`}>
            {elapsed}′
          </span>
        </div>
        <div className="text-[13px] text-[var(--ds-text-muted)]">
          {ORDINALS[col.course_no] ?? col.course_no} uscita
          {col.customer_name ? ` · ${col.customer_name}` : ''}
        </div>
      </div>

      {col.allergens && (
        <div className="flex items-start gap-1.5 bg-[var(--ds-critical-tint)] px-3 py-2 text-[13px] font-medium text-[var(--ds-critical-text)]">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{col.allergens}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2.5">
        {col.items.map(i => (
          // Il fatto viene detto dal segno di spunta e dal testo attenuato, non
          // da un'opacità che porta sotto contrasto anche la quantità.
          <div key={i.id}>
            <div className="flex items-start gap-2">
              <span
                className={`font-semibold tabular-nums ${
                  i.status === 'READY' ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-primary)]'
                }`}
              >
                {i.qty}
              </span>
              <span
                className={`flex-1 text-[15px] leading-tight ${
                  i.status === 'READY'
                    ? 'text-[var(--ds-text-muted)] line-through'
                    : 'text-[var(--ds-text-primary)]'
                }`}
              >
                {i.name_snapshot}
              </span>
              {i.status === 'PREPARING' && (
                <ChevronRight size={15} className="mt-0.5 flex-shrink-0 text-[var(--ds-arriving-text)]" aria-hidden />
              )}
              {i.status === 'READY' && (
                <Check size={15} className="mt-0.5 flex-shrink-0 text-[var(--ds-seated-solid)]" aria-hidden />
              )}
            </div>
            {i.modifiers && i.modifiers.length > 0 && (
              <div className="ml-6 text-[13px] font-medium text-[var(--ds-pending-text)]">
                ↳ {i.modifiers.map(m => m.name).join(', ')}
              </div>
            )}
            {i.note && <div className="ml-6 text-[13px] text-[var(--ds-text-muted)]">↳ {i.note}</div>}
          </div>
        ))}
      </div>

      <div className="p-2">
        {allReady ? (
          <div className="py-2 text-center text-[14px] font-semibold text-[var(--ds-seated-text)]">
            {col.waitingOthers ? `pronto · attende le altre partite (${readySince}′)` : 'pronto'}
          </div>
        ) : (
          // Non "PRONTO": il maiuscolo non aggiunge nulla che il corpo e il
          // peso non dicano già, e a schermo lo si legge peggio (§5.2).
          <button
            type="button"
            onClick={() => col.items.filter(i => i.status !== 'READY').forEach(i => onAdvance(i, 'READY'))}
            className="w-full rounded-[16px] bg-[var(--ds-action-bg)] py-3.5 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            Pronto
          </button>
        )}
      </div>
    </div>
  );
};

// Riepilogo del servizio: piatti da preparare in totale (aggregati per label
// e variante) + un elenco delle allergie/diete registrate per prenotazione.
// La cucina lo legge a colpo d'occhio a inizio turno per attrezzarsi ("stasera
// 8 stinchi di maiale, 3 di vitello, 2 tavoli senza glutine"). Le allergie
// restano libere (customers.dietary_notes) — non le aggreghiamo per non
// suggerire falsi conteggi su testo non normalizzato.
const ServiceSummaryBanner: React.FC<{
  summary: KitchenServiceSummary;
  open: boolean;
  onToggle: () => void;
}> = ({ summary, open, onToggle }) => {
  const shift = summary.shift === 'LUNCH' ? 'Pranzo' : 'Cena';
  const total = summary.dietary.reduce((s, d) => s + d.quantity, 0);
  const hasDietary = summary.dietary.length > 0;
  const hasDiets = summary.dietary_lines.length > 0;
  return (
    <div className="flex-shrink-0 px-4 pb-3">
      <div className="rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] overflow-hidden">
        <button
          type="button"
          onClick={onToggle}
          className="w-full flex items-center gap-3 px-4 py-3 text-left"
          aria-expanded={open}
        >
          <span className="text-[13px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)]">
            {shift} · {summary.reservations} prenotazion{summary.reservations === 1 ? 'e' : 'i'}
          </span>
          <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
            {hasDietary
              ? summary.dietary.slice(0, 6).map(d => (
                <span
                  key={`${d.label}--${d.variant ?? ''}`}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2.5 py-1 text-[13px] font-semibold text-[var(--ds-text-primary)]"
                >
                  <span className="tabular-nums">{d.quantity}×</span>
                  <span className="truncate">
                    {d.label}{d.variant ? ` (${d.variant})` : ''}
                  </span>
                </span>
              ))
              : <span className="text-[13px] text-[var(--ds-text-muted)]">Nessuna nota strutturata</span>
            }
            {hasDietary && summary.dietary.length > 6 && (
              <span className="text-[13px] text-[var(--ds-text-muted)]">+{summary.dietary.length - 6}</span>
            )}
          </div>
          {hasDiets && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ds-critical-tint)] px-2.5 py-1 text-[13px] font-semibold text-[var(--ds-critical-text)]">
              <TriangleAlert size={13} aria-hidden />
              {summary.dietary_lines.length} allergi{summary.dietary_lines.length === 1 ? 'a' : 'e'}
            </span>
          )}
          <ChevronRight
            size={16}
            className={`flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        {open && (
          <div className="border-t border-[var(--ds-border)] px-4 py-3 space-y-3">
            {hasDietary && (
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ds-text-muted)] mb-1.5">
                  Piatti del turno ({total})
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {summary.dietary.map(d => (
                    <span
                      key={`row-${d.label}--${d.variant ?? ''}`}
                      className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2.5 py-1 text-[13px] font-semibold text-[var(--ds-text-primary)]"
                    >
                      <span className="tabular-nums">{d.quantity}×</span>
                      <span>{d.label}{d.variant ? ` (${d.variant})` : ''}</span>
                    </span>
                  ))}
                </div>
              </div>
            )}
            {hasDiets && (
              <div>
                <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ds-critical-text)] mb-1.5">
                  Allergie / diete
                </div>
                <ul className="space-y-1">
                  {summary.dietary_lines.map(l => (
                    <li key={l.reservation_id} className="flex items-start gap-2 text-[13px]">
                      <TriangleAlert size={13} className="mt-0.5 flex-shrink-0 text-[var(--ds-critical-text)]" aria-hidden />
                      <span className="text-[var(--ds-text-primary)]">
                        <span className="font-semibold">{l.customer_name || '—'}</span>
                        <span className="text-[var(--ds-text-muted)]"> · {l.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
