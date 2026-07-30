import React, { useCallback, useEffect, useState } from 'react';
import { BarChart3, Bell, Loader2, Play, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { socketClient } from '../services/socketClient';
import {
  getExpediterBoard, fireCourse, refireCourse, callCourse, getKitchenReport,
  type ExpediterBoard, type ExpediterCourse, type KitchenReport,
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
  const [report, setReport] = useState<KitchenReport | null>(null);
  const [showReport, setShowReport] = useState(false);

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
        <button
          onClick={() => {
            const next = !showReport;
            setShowReport(next);
            if (next) getKitchenReport().then(setReport).catch(() => setReport(null));
          }}
          className="ml-auto text-sm px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-600 flex items-center gap-1.5">
          <BarChart3 size={14} /> Statistiche
        </button>
      </header>

      {showReport && <KitchenStats report={report} />}

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

// Il numero che dice se la cucina è coordinata, invece delle impressioni del
// sabato sera. La mediana accanto alla media: una sola comanda dimenticata
// sposta la media e non la mediana.
const KitchenStats: React.FC<{ report: KitchenReport | null }> = ({ report }) => {
  if (!report) {
    return <div className="px-5 py-3 text-sm text-slate-500 border-b border-slate-200 dark:border-slate-700">Caricamento statistiche…</div>;
  }
  const s = report.sincronia;
  return (
    <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900/50">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <Stat label="Uscite completate" value={String(s?.uscite ?? 0)} />
        <Stat label="Delta di sincronia (mediano)" value={s?.delta_mediano_min != null ? `${s.delta_mediano_min}′` : '—'}
              hint="fra la prima riga pronta e l'ultima" />
        <Stat label="Delta peggiore" value={s?.delta_massimo_min != null ? `${s.delta_massimo_min}′` : '—'} />
        <Stat label="Attesa media al passe" value={report.passe?.attesa_media_min != null ? `${report.passe.attesa_media_min}′` : '—'}
              hint="fra proposta e lancio" />
      </div>

      <div className="overflow-x-auto">
        <table className="text-sm w-full">
          <thead className="text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="text-left py-1">Partita</th><th className="text-right">Righe</th>
                <th className="text-right">Media</th><th className="text-right">Mediana</th></tr>
          </thead>
          <tbody>
            {report.partite.map(p => (
              <tr key={p.station_id ?? 'none'} className="border-t border-slate-200 dark:border-slate-700">
                <td className="py-1.5">{p.station_name ?? 'Senza partita'}</td>
                <td className="text-right tabular-nums">{p.righe}</td>
                <td className="text-right tabular-nums">{p.media_min ?? '—'}′</td>
                <td className="text-right tabular-nums font-medium">{p.mediana_min ?? '—'}′</td>
              </tr>
            ))}
            {report.partite.length === 0 && (
              <tr><td colSpan={4} className="py-2 text-slate-400">Nessun dato nel periodo.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {report.scarti.length > 0 && (
        <div className="mt-4">
          <div className="text-xs uppercase tracking-wide text-slate-500 mb-1">Scarti</div>
          <ul className="text-sm space-y-0.5">
            {report.scarti.map((sc, i) => (
              <li key={i} className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-300">{sc.motivo ?? 'senza motivazione'} · {sc.righe}</span>
                <span className="tabular-nums">{(sc.valore_cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div>
    <div className="text-2xl font-bold tabular-nums">{value}</div>
    <div className="text-xs text-slate-500">{label}</div>
    {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
  </div>
);
