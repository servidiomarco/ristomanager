import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ChevronRight, Loader2, Play, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { socketClient } from '../services/socketClient';
import {
  getKdsQueue, setKdsItemStatus, getMenuCatalogue,
  type KdsItem, type KdsCourseState, type MenuCatalogue,
} from '../services/ordersApiService';

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
// informazione: accanto c'è sempre il numero.
const timerTone = (min: number): string =>
  min >= 10 ? 'text-rose-600 dark:text-rose-400'
  : min >= 5 ? 'text-amber-600 dark:text-amber-400'
  : 'text-emerald-600 dark:text-emerald-400';

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

export const KitchenDisplay: React.FC = () => {
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

  useEffect(() => { getMenuCatalogue().then(setCatalogue).catch(() => {}); }, []);

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
    return <div className="p-10 flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={18} /> Caricamento coda…</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 shrink-0">
        <h1 className="text-xl font-bold tracking-wide uppercase">{stationName}</h1>
        <span className="text-sm text-slate-500">{todo.length} in lavorazione</span>
        {offline && (
          <span className="flex items-center gap-1 text-sm text-amber-600"><WifiOff size={15} /> riconnessione…</span>
        )}
        <button onClick={() => setPicking(true)}
                className="ml-auto text-sm px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600">
          Cambia partita
        </button>
      </header>

      <div className="flex-1 overflow-x-auto overflow-y-hidden p-4">
        {todo.length === 0 && upcoming.length === 0 ? (
          <p className="text-slate-400 text-lg">Nessuna comanda in coda.</p>
        ) : (
          <div className="flex gap-4 h-full items-start">
            {todo.map(col => (
              <CourseCard key={col.key} col={col} now={now} stationId={stationId} onAdvance={advance} />
            ))}
          </div>
        )}
      </div>

      {upcoming.length > 0 && (
        <div className="border-t border-slate-200 dark:border-slate-700 px-4 py-3 shrink-0">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">In arrivo</div>
          <div className="flex gap-3 overflow-x-auto">
            {upcoming.map(col => {
              const wait = minutesUntil(col.items[0]?.station_start_at ?? null, now);
              return (
                <div key={col.key}
                     className="shrink-0 px-3 py-2 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 opacity-70">
                  <div className="text-sm font-medium">
                    T{col.table_name} · {ORDINALS[col.course_no] ?? col.course_no} usc.
                  </div>
                  <div className="text-xs text-slate-500">
                    {col.items.map(i => `${i.qty} ${i.name_snapshot}`).join(', ')}
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs font-semibold">fra {Math.max(wait, 1)}′</span>
                    <button onClick={() => col.items.forEach(i => advance(i, 'PREPARING'))}
                            className="text-xs px-2 py-0.5 rounded-md border border-slate-300 dark:border-slate-600 flex items-center gap-1">
                      <Play size={11} /> inizia ora
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {picking && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
             onClick={() => setPicking(false)}>
          <div className="bg-white dark:bg-slate-900 rounded-2xl p-5 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <h2 className="font-semibold mb-1">Partita di questo schermo</h2>
            <p className="text-xs text-slate-500 mb-4">
              Resta impostata anche dopo un riavvio del tablet.
            </p>
            <div className="flex flex-col gap-2">
              {catalogue?.stations.map(s => (
                <button key={s.id} onClick={() => chooseStation(s.id)}
                        className={`px-4 py-3 rounded-xl border text-left font-medium
                          ${s.id === stationId ? 'border-slate-900 dark:border-white' : 'border-slate-300 dark:border-slate-600'}`}>
                  {s.name}
                  {s.id === stationId && <Check size={16} className="inline ml-2" />}
                </button>
              ))}
              <button onClick={() => chooseStation(null)}
                      className={`px-4 py-3 rounded-xl border text-left
                        ${stationId == null ? 'border-slate-900 dark:border-white' : 'border-slate-300 dark:border-slate-600'}`}>
                Senza partita
                <span className="block text-xs text-slate-500">piatti non ancora assegnati</span>
              </button>
            </div>
          </div>
        </div>
      )}
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
    <div className={`shrink-0 w-56 rounded-2xl border-2 flex flex-col max-h-full
      ${lampAlert ? 'border-rose-500 animate-pulse'
        : allReady ? 'border-emerald-500'
        : 'border-slate-300 dark:border-slate-600'}`}>
      <div className="px-3 py-2 border-b border-slate-200 dark:border-slate-700">
        <div className="flex items-baseline gap-2">
          <span className="text-lg font-bold">T{col.table_name ?? '—'}</span>
          <span className={`text-lg font-bold tabular-nums ml-auto ${timerTone(elapsed)}`}>{elapsed}′</span>
        </div>
        <div className="text-xs text-slate-500">
          {ORDINALS[col.course_no] ?? col.course_no} uscita
          {col.customer_name ? ` · ${col.customer_name}` : ''}
        </div>
      </div>

      {col.allergens && (
        <div className="px-3 py-1.5 bg-rose-50 dark:bg-rose-950/40 text-rose-800 dark:text-rose-200 text-xs flex items-start gap-1.5">
          <TriangleAlert size={13} className="mt-0.5 shrink-0" />
          <span>{col.allergens}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2">
        {col.items.map(i => (
          <div key={i.id} className={i.status === 'READY' ? 'opacity-40' : ''}>
            <div className="flex items-start gap-2">
              <span className="font-bold tabular-nums">{i.qty}</span>
              <span className="flex-1 leading-tight">{i.name_snapshot}</span>
              {i.status === 'PREPARING' && <ChevronRight size={14} className="text-sky-500 mt-0.5" />}
              {i.status === 'READY' && <Check size={14} className="text-emerald-600 mt-0.5" />}
            </div>
            {i.modifiers && i.modifiers.length > 0 && (
              <div className="text-xs text-amber-700 dark:text-amber-300 ml-6">
                ↳ {i.modifiers.map(m => m.name).join(', ')}
              </div>
            )}
            {i.note && <div className="text-xs text-slate-500 ml-6">↳ {i.note}</div>}
          </div>
        ))}
      </div>

      <div className="p-2 border-t border-slate-200 dark:border-slate-700">
        {allReady ? (
          <div className="text-center text-sm font-semibold text-emerald-700 dark:text-emerald-300 py-2">
            {col.waitingOthers ? `pronto · attende le altre partite (${readySince}′)` : 'pronto'}
          </div>
        ) : (
          <button
            onClick={() => col.items.filter(i => i.status !== 'READY').forEach(i => onAdvance(i, 'READY'))}
            className="w-full py-3 rounded-xl bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-bold tracking-wide">
            PRONTO
          </button>
        )}
      </div>
    </div>
  );
};
