import React, { useCallback, useEffect, useState } from 'react';
import { Bell, Loader2, Play, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { socketClient } from '../services/socketClient';
import {
  getExpediterBoard, fireCourse, refireCourse, callCourse,
  type ExpediterBoard, type ExpediterCourse,
} from '../services/ordersApiService';

// ---------------------------------------------------------------------------
// Passe — l'unico punto in cui qualcuno vede l'uscita intera.
//
// Con tre partite senza questa vista lavorano alla cieca l'una rispetto
// all'altra e la sincronizzazione torna a essere un fatto di urla.
//
// Due blocchi, perché sono due domande diverse: "cosa sta uscendo?" (sopra) e
// "cosa devo far partire?" (sotto). Le proposte in attesa invecchiano a vista:
// una proposta che nessuno lancia è un tavolo che non mangia, e il sistema non
// se ne accorgerebbe da solo.
// ---------------------------------------------------------------------------

const ORDINALS = ['', '1ª', '2ª', '3ª', '4ª', '5ª', '6ª'];

const mmss = (seconds: number): string => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${m}′`;
};

export const ExpediterDisplay: React.FC = () => {
  const now = useNow(10_000);
  const [board, setBoard] = useState<ExpediterBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [called, setCalled] = useState<Set<string>>(new Set());

  const reload = useCallback(async () => {
    try {
      setBoard(await getExpediterBoard());
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  // Il passe ascolta tutto: è l'unico che deve vedere l'insieme. Ricarico
  // periodico oltre agli eventi, perché gli allarmi (proposta invecchiata,
  // partita in ritardo) maturano col tempo e non con un evento.
  useEffect(() => {
    const socket = socketClient.getSocket();
    const onChange = () => reload();
    socket?.on('course:queued', onChange);
    socket?.on('course:fired', onChange);
    socket?.on('course:recalled', onChange);
    socket?.on('course:ready', onChange);
    socket?.on('orderItem:status', onChange);
    socket?.on('connect', onChange);
    const poll = setInterval(reload, 20_000);
    return () => {
      socket?.off('course:queued', onChange);
      socket?.off('course:fired', onChange);
      socket?.off('course:recalled', onChange);
      socket?.off('course:ready', onChange);
      socket?.off('orderItem:status', onChange);
      socket?.off('connect', onChange);
      clearInterval(poll);
    };
  }, [reload]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusyKey(key);
    try { await fn(); } catch { /* il ricarico dirà com'è andata */ }
    finally { setBusyKey(null); reload(); }
  };

  if (loading) {
    return <div className="p-10 flex items-center gap-2 text-slate-500"><Loader2 className="animate-spin" size={18} /> Caricamento passe…</div>;
  }

  const stations = board?.stations ?? [];
  const courses = board?.courses ?? [];
  const inCorso = courses.filter(c => c.status !== 'QUEUED');
  const inAttesa = courses.filter(c => c.status === 'QUEUED');

  const stationLabel = (id: number | null) =>
    id == null ? '—' : stations.find(s => s.id === id)?.name ?? `#${id}`;

  return (
    <div className="flex flex-col h-full">
      <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700 flex items-center gap-3 shrink-0">
        <h1 className="text-xl font-bold tracking-wide uppercase">Passe</h1>
        <span className="text-sm text-slate-500">
          {inCorso.length} in corso · {inAttesa.length} da lanciare
        </span>
        {offline && <span className="flex items-center gap-1 text-sm text-amber-600"><WifiOff size={15} /> riconnessione…</span>}
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <section>
          <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">In corso</h2>
          {inCorso.length === 0 ? (
            <p className="text-slate-400 text-sm py-2">Niente in preparazione.</p>
          ) : (
            <div className="space-y-2">
              {inCorso.map(c => (
                <CourseRow
                  key={`${c.order_id}:${c.course_no}`} course={c} stations={stations}
                  stationLabel={stationLabel} now={now} busyKey={busyKey}
                  called={called.has(`${c.order_id}:${c.course_no}`)}
                  onCall={() => {
                    const key = `${c.order_id}:${c.course_no}`;
                    setCalled(prev => new Set(prev).add(key));
                    act(key, () => callCourse(c.order_id, c.course_no));
                  }}
                  onRefire={() => act(`${c.order_id}:${c.course_no}`, () => refireCourse(c.order_id, c.course_no))}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wide text-slate-500 mb-2">In attesa di lancio</h2>
          {inAttesa.length === 0 ? (
            <p className="text-slate-400 text-sm py-2">Nessuna proposta dalla sala.</p>
          ) : (
            <div className="space-y-2">
              {inAttesa.map(c => (
                <CourseRow
                  key={`${c.order_id}:${c.course_no}`} course={c} stations={stations}
                  stationLabel={stationLabel} now={now} busyKey={busyKey} called={false}
                  onFire={() => act(`${c.order_id}:${c.course_no}`, () => fireCourse(c.order_id, c.course_no))}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const CourseRow: React.FC<{
  course: ExpediterCourse;
  stations: ExpediterBoard['stations'];
  stationLabel: (id: number | null) => string;
  now: number;
  busyKey: string | null;
  called: boolean;
  onFire?: () => void;
  onRefire?: () => void;
  onCall?: () => void;
}> = ({ course: c, stations, stationLabel, busyKey, called, onFire, onRefire, onCall }) => {
  const key = `${c.order_id}:${c.course_no}`;
  const busy = busyKey === key;
  const allReady = c.status === 'READY';

  // L'urgenza si legge dal bordo, ma il motivo è sempre scritto accanto:
  // il colore da solo non basta a due metri di distanza.
  const tone = c.lagging || c.stale_queued
    ? 'border-rose-500 bg-rose-50/60 dark:bg-rose-950/30'
    : allReady
      ? 'border-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30'
      : 'border-slate-200 dark:border-slate-700';

  return (
    <div className={`rounded-xl border-2 px-4 py-3 flex items-center gap-4 ${tone}`}>
      <div className="w-24 shrink-0">
        <div className="text-lg font-bold">T{c.table_name ?? '—'}</div>
        <div className="text-xs text-slate-500">{ORDINALS[c.course_no] ?? c.course_no} uscita</div>
      </div>

      {/* Un pallino per partita: lo stato di sincronia in un colpo d'occhio. */}
      <div className="flex items-center gap-3 shrink-0">
        {stations.map(s => {
          const st = c.stations.find(x => x.station_id === s.id);
          return (
            <div key={s.id} className="flex flex-col items-center w-14">
              <span className={`text-xl leading-none ${
                !st ? 'text-slate-300 dark:text-slate-700'
                : st.ready ? 'text-emerald-600'
                : 'text-slate-400'}`}>
                {!st ? '—' : st.ready ? '●' : '○'}
              </span>
              <span className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5">
                {s.name.slice(0, 3)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex-1 min-w-0 text-sm">
        {c.status === 'QUEUED' ? (
          <span className={c.stale_queued ? 'text-rose-700 dark:text-rose-300 font-medium' : 'text-slate-500'}>
            {c.stale_queued && <TriangleAlert size={14} className="inline mr-1 -mt-0.5" />}
            proposta da {mmss(c.age_seconds)}
          </span>
        ) : allReady ? (
          <span className="text-emerald-700 dark:text-emerald-300 font-medium">pronta</span>
        ) : c.lagging ? (
          <span className="text-rose-700 dark:text-rose-300 font-medium">
            <TriangleAlert size={14} className="inline mr-1 -mt-0.5" />
            manca {c.waiting_station_ids.map(stationLabel).join(', ')} · {mmss(c.lamp_wait_seconds)} sotto la lampada
          </span>
        ) : (
          <span className="text-slate-500">
            in corso {mmss(c.age_seconds)}
            {c.waiting_station_ids.length > 0 && ` · manca ${c.waiting_station_ids.map(stationLabel).join(', ')}`}
          </span>
        )}
        <div className="text-xs text-slate-400 truncate">
          {c.items.map(i => `${i.qty} ${i.name_snapshot}`).join(', ')}
        </div>
      </div>

      <div className="shrink-0 flex items-center gap-2">
        {onRefire && !allReady && (
          <button onClick={onRefire} disabled={busy} title="Ricalcola i tempi di partenza da adesso"
                  className="px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 text-sm flex items-center gap-1.5">
            <RotateCcw size={14} /> ri-lancia
          </button>
        )}
        {onCall && allReady && (
          <button onClick={onCall} disabled={busy || called}
                  className="px-4 py-2.5 rounded-lg bg-emerald-600 text-white font-semibold text-sm flex items-center gap-1.5 disabled:opacity-50">
            <Bell size={15} /> {called ? 'chiamata' : 'CHIAMA'}
          </button>
        )}
        {onFire && (
          <button onClick={onFire} disabled={busy}
                  className="px-5 py-2.5 rounded-lg bg-slate-900 text-white dark:bg-white dark:text-slate-900 font-semibold text-sm flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <Play size={15} />} LANCIA
          </button>
        )}
      </div>
    </div>
  );
};
