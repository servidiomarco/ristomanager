import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isBarCourse, ordinal } from '../utils/courses';
import { BarChart3, Bell, BellOff, Check, Loader2, Play, RotateCcw, TriangleAlert, WifiOff } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { socketClient } from '../services/socketClient';
import {
  getExpediterBoard, fireCourse, refireCourse, callCourse, serveCourse, unserveCourse, getKitchenReport,
  type ExpediterBoard, type ExpediterCourse, type KitchenReport,
} from '../services/ordersApiService';
import { chime } from '../utils/chime';
import { SectionHeader, StatusPill, dsButton } from './ds';

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

// «1ª uscita» … e «Uscita Bar» (utils/courses): femminile di «uscita» salvo.
const courseName = (n: number): string => isBarCourse(n) ? 'Uscita Bar' : `${ordinal(n)} uscita`;
const SOUND_KEY = 'passe.sound';

const mmss = (seconds: number): string => {
  const m = Math.floor(Math.max(0, seconds) / 60);
  return `${m}′`;
};

/* I bersagli del passe restano a 44px: si preme in piedi, di fretta, guardando
   il piano e non lo schermo. */
const passeAction =
  'inline-flex h-11 flex-shrink-0 items-center gap-1.5 rounded-full px-4 text-[14px] font-semibold transition-colors disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

export const ExpediterDisplay: React.FC = () => {
  const now = useNow(10_000);
  const [board, setBoard] = useState<ExpediterBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [called, setCalled] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<KitchenReport | null>(null);
  const [showReport, setShowReport] = useState(false);
  // Avviso sonoro sull'uscita che diventa pronta. Nel ref oltre che nello
  // stato: il listener socket legge il valore corrente senza risottoscriversi.
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) !== 'off');
  const soundRef = useRef(sound);
  soundRef.current = sound;
  const toggleSound = () => {
    setSound(prev => {
      const next = !prev;
      localStorage.setItem(SOUND_KEY, next ? 'on' : 'off');
      // Suona subito all'accensione: conferma la scelta e, essendo dentro un
      // gesto dell'utente, sblocca l'AudioContext per gli avvisi futuri.
      if (next) chime();
      return next;
    });
  };

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
    // Suona solo l'uscita che diventa pronta: è il momento in cui il passe
    // deve alzare la testa e chiamare la sala; il resto è rumore.
    const onReady = () => { if (soundRef.current) chime(); reload(); };
    socket?.on('course:queued', onChange);
    socket?.on('course:fired', onChange);
    socket?.on('course:recalled', onChange);
    socket?.on('course:ready', onReady);
    socket?.on('course:served', onChange);
    socket?.on('course:unserved', onChange);
    socket?.on('orderItem:status', onChange);
    socket?.on('connect', onChange);
    const poll = setInterval(reload, 20_000);
    return () => {
      socket?.off('course:queued', onChange);
      socket?.off('course:fired', onChange);
      socket?.off('course:recalled', onChange);
      socket?.off('course:ready', onReady);
      socket?.off('course:served', onChange);
      socket?.off('course:unserved', onChange);
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
    return (
      <div className="flex h-full items-center justify-center gap-2 p-10 text-[15px] text-[var(--ds-text-muted)]">
        <Loader2 className="animate-spin" size={18} /> Caricamento passe…
      </div>
    );
  }

  const stations = board?.stations ?? [];
  const courses = board?.courses ?? [];
  const inCorso = courses.filter(c => c.status !== 'QUEUED');
  const inAttesa = courses.filter(c => c.status === 'QUEUED');

  const stationLabel = (id: number | null) =>
    id == null ? '—' : stations.find(s => s.id === id)?.name ?? `#${id}`;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)]">
      <div className="flex-shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 pl-4 shadow-[var(--ds-shadow-card)]">
          {/* Tondo, non maiuscolo (§5.2): il corpo e il peso bastano. */}
          <h1 className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">Passe</h1>
          <span className="text-[15px] text-[var(--ds-text-muted)] tabular-nums">
            {inCorso.length} in corso · {inAttesa.length} da lanciare
          </span>
          {offline && (
            <StatusPill tone="pending">
              <WifiOff size={13} aria-hidden /> riconnessione…
            </StatusPill>
          )}
          {/* Icona sola, 44px, incassata sulla card come i controlli quiet:
              il testo qui non aggiungerebbe nulla che la campana non dica. */}
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={sound}
            aria-label={sound ? 'Disattiva l\'avviso sonoro' : 'Attiva l\'avviso sonoro'}
            className="ml-auto inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {sound ? <Bell size={17} aria-hidden /> : <BellOff size={17} className="text-[var(--ds-text-muted)]" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !showReport;
              setShowReport(next);
              if (next) getKitchenReport().then(setReport).catch(() => setReport(null));
            }}
            aria-pressed={showReport}
            className={`flex-shrink-0 ${dsButton.quiet}`}
          >
            <BarChart3 size={15} aria-hidden /> Statistiche
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {showReport && <KitchenStats report={report} />}

        <section className="mb-5">
          <SectionHeader
            tone="muted"
            meta={inCorso.length === 1 ? '1 uscita' : `${inCorso.length} uscite`}
          >
            In corso
          </SectionHeader>
          {inCorso.length === 0 ? (
            <p className="px-2 py-2 text-[14px] text-[var(--ds-text-muted)]">Niente in preparazione.</p>
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
                  onServe={() => act(`${c.order_id}:${c.course_no}`, () => serveCourse(c.order_id, c.course_no))}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeader
            tone={inAttesa.some(c => c.stale_queued) ? 'attention' : 'muted'}
            meta={inAttesa.length === 1 ? '1 proposta' : `${inAttesa.length} proposte`}
          >
            In attesa di lancio
          </SectionHeader>
          {inAttesa.length === 0 ? (
            <p className="px-2 py-2 text-[14px] text-[var(--ds-text-muted)]">Nessuna proposta dalla sala.</p>
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

        {/* Il cestino del "Servita" toccato per errore: righe smorzate, in
            fondo, con la sola azione di riporto. Non uno storico — il server
            tiene una finestra breve apposta. */}
        {(board?.servite?.length ?? 0) > 0 && (
          <section className="mt-5">
            <SectionHeader tone="muted" meta={board!.servite.length === 1 ? '1 uscita' : `${board!.servite.length} uscite`}>
              Servite da poco
            </SectionHeader>
            <div className="space-y-1.5">
              {board!.servite.map(s => {
                const key = `${s.order_id}:${s.course_no}`;
                const agoS = Math.floor((now - new Date(s.served_at).getTime()) / 1000);
                return (
                  <div key={key} className="flex items-center gap-3 rounded-[14px] bg-[var(--ds-surface)] px-4 py-1.5 shadow-[var(--ds-shadow-card)]">
                    <span className="text-[15px] font-semibold text-[var(--ds-text-muted)]">
                      T{s.table_name ?? '—'}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ds-text-muted)]">
                      {courseName(s.course_no)} · servita da {mmss(agoS)}
                    </span>
                    <button
                      type="button"
                      onClick={() => act(key, () => unserveCourse(s.order_id, s.course_no))}
                      disabled={busyKey === key}
                      className={`${passeAction} bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]`}
                    >
                      <RotateCcw size={14} aria-hidden /> riporta
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        )}
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
  onServe?: () => void;
}> = ({ course: c, stations, stationLabel, busyKey, called, onFire, onRefire, onCall, onServe }) => {
  const key = `${c.order_id}:${c.course_no}`;
  const busy = busyKey === key;
  const allReady = c.status === 'READY';
  const alarm = c.lagging || c.stale_queued;

  // L'urgenza si legge dal fondo e dall'anello, ma il motivo è sempre scritto
  // accanto: il colore da solo non basta a due metri di distanza. È l'unico
  // posto della pagina in cui il rosso riempie una riga intera, ed è per una
  // riga che sta costando un tavolo.
  const tone = alarm
    ? 'bg-[var(--ds-critical-tint)] ring-2 ring-[var(--ds-critical-solid)]'
    : allReady
      ? 'bg-[var(--ds-seated-tint)] ring-2 ring-[var(--ds-seated-solid)]'
      : 'bg-[var(--ds-surface)]';

  return (
    <div className={`flex items-center gap-4 rounded-[18px] px-4 py-3 shadow-[var(--ds-shadow-card)] ${tone}`}>
      <div className="w-24 flex-shrink-0">
        <div className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
          T{c.table_name ?? '—'}
        </div>
        <div className="text-[13px] text-[var(--ds-text-muted)]">
          {courseName(c.course_no)}
        </div>
      </div>

      {/* Un pallino per partita: lo stato di sincronia in un colpo d'occhio. */}
      <div className="flex flex-shrink-0 items-center gap-3">
        {stations.map(s => {
          const st = c.stations.find(x => x.station_id === s.id);
          // Da quando la cucina spunta i piatti uno a uno, fra "niente" e
          // "tutto" c'è l'avanzamento: il conteggio 2/3 al posto del cerchio
          // vuoto dice quanto manca senza chiedere niente alla vista.
          const partial = st && !st.ready && st.ready_items > 0;
          return (
            <div key={s.id} className="flex w-14 flex-col items-center">
              {partial ? (
                <span className="text-[14px] font-semibold leading-[22px] tabular-nums text-[var(--ds-pending-text)]" aria-hidden>
                  {st.ready_items}/{st.items}
                </span>
              ) : (
                <span
                  className={`text-[22px] leading-none ${
                    !st ? 'text-[var(--ds-border-strong)]'
                    : st.ready ? 'text-[var(--ds-seated-solid)]'
                    : 'text-[var(--ds-text-subtle)]'
                  }`}
                  aria-hidden
                >
                  {!st ? '—' : st.ready ? '●' : '○'}
                </span>
              )}
              {/* Troncato a tre lettere, non messo in maiuscolo: la troncatura
                  è per lo spazio, il maiuscolo non aggiungeva nulla. */}
              <span className="mt-0.5 text-[11px] font-medium text-[var(--ds-text-muted)]">
                {s.name.slice(0, 3)}
              </span>
              <span className="sr-only">
                {s.name}: {!st ? 'non coinvolta'
                  : st.ready ? 'pronta'
                  : partial ? `${st.ready_items} piatti pronti su ${st.items}`
                  : 'in corso'}
              </span>
            </div>
          );
        })}
      </div>

      <div className="min-w-0 flex-1 text-[14px]">
        {c.status === 'QUEUED' ? (
          <span className={c.stale_queued ? 'font-semibold text-[var(--ds-critical-text)]' : 'text-[var(--ds-text-muted)]'}>
            {c.stale_queued && <TriangleAlert size={14} className="mr-1 -mt-0.5 inline" aria-hidden />}
            proposta da {mmss(c.age_seconds)}
          </span>
        ) : allReady ? (
          <span className="font-semibold text-[var(--ds-seated-text)]">pronta</span>
        ) : c.lagging ? (
          <span className="font-semibold text-[var(--ds-critical-text)]">
            <TriangleAlert size={14} className="mr-1 -mt-0.5 inline" aria-hidden />
            manca {c.waiting_station_ids.map(stationLabel).join(', ')} · {mmss(c.lamp_wait_seconds)} sotto la lampada
          </span>
        ) : (
          <span className="text-[var(--ds-text-muted)]">
            in corso {mmss(c.age_seconds)}
            {c.waiting_station_ids.length > 0 && ` · manca ${c.waiting_station_ids.map(stationLabel).join(', ')}`}
          </span>
        )}
        <div className={`truncate text-[13px] ${alarm || allReady ? 'opacity-80' : 'text-[var(--ds-text-muted)]'}`}>
          {c.items.map(i => `${i.qty} ${i.name_snapshot}`).join(', ')}
        </div>
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
        {onRefire && !allReady && (
          <button
            type="button"
            onClick={onRefire}
            disabled={busy}
            title="Ricalcola i tempi di partenza da adesso"
            className={`${passeAction} bg-[var(--ds-surface)] text-[var(--ds-text-primary)] ring-1 ring-inset ring-[var(--ds-border-strong)] hover:bg-[var(--ds-surface-row)]`}
          >
            <RotateCcw size={15} aria-hidden /> ri-lancia
          </button>
        )}
        {onCall && allReady && (
          <button
            type="button"
            onClick={onCall}
            disabled={busy || called}
            className={`${passeAction} bg-[var(--ds-seated-solid)] text-white hover:brightness-95`}
          >
            <Bell size={15} aria-hidden /> {called ? 'chiamata' : 'Chiama'}
          </button>
        )}
        {/* Chiude il giro: l'uscita lascia il passe e la riga sparisce dal
            monitor. Senza questo tocco le uscite pronte si accumulavano qui
            anche dopo essere arrivate al tavolo. */}
        {onServe && allReady && (
          <button
            type="button"
            onClick={onServe}
            disabled={busy}
            className={`${passeAction} bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]`}
          >
            <Check size={15} aria-hidden /> Servita
          </button>
        )}
        {onFire && (
          <button
            type="button"
            onClick={onFire}
            disabled={busy}
            className={`${passeAction} bg-[var(--ds-action-bg)] px-5 text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]`}
          >
            {busy ? <Loader2 size={15} className="animate-spin" aria-hidden /> : <Play size={15} aria-hidden />} Lancia
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
    return (
      <div className="mb-5 rounded-[20px] bg-[var(--ds-surface)] px-5 py-4 text-[14px] text-[var(--ds-text-muted)] shadow-[var(--ds-shadow-card)]">
        Caricamento statistiche…
      </div>
    );
  }
  const s = report.sincronia;
  return (
    <div className="mb-5 rounded-[20px] bg-[var(--ds-surface)] p-5 shadow-[var(--ds-shadow-card)]">
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Uscite completate" value={String(s?.uscite ?? 0)} />
        <Stat label="Delta di sincronia (mediano)" value={s?.delta_mediano_min != null ? `${s.delta_mediano_min}′` : '—'}
              hint="fra la prima riga pronta e l'ultima" />
        <Stat label="Delta peggiore" value={s?.delta_massimo_min != null ? `${s.delta_massimo_min}′` : '—'} />
        <Stat label="Attesa media al passe" value={report.passe?.attesa_media_min != null ? `${report.passe.attesa_media_min}′` : '—'}
              hint="fra proposta e lancio" />
        <Stat label="Attesa al ritiro" value={report.ritiro?.attesa_media_min != null ? `${report.ritiro.attesa_media_min}′` : '—'}
              hint="fra pronta e servita" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[14px]">
          <thead className="text-[13px] font-semibold text-[var(--ds-text-muted)]">
            <tr>
              <th className="py-1.5 text-left font-semibold">Partita</th>
              <th className="text-right font-semibold">Righe</th>
              <th className="text-right font-semibold">Media</th>
              <th className="text-right font-semibold">Mediana</th>
            </tr>
          </thead>
          <tbody>
            {report.partite.map(p => (
              <tr key={p.station_id ?? 'none'} className="border-t border-[var(--ds-border)]">
                <td className="py-2 text-[var(--ds-text-primary)]">{p.station_name ?? 'Senza partita'}</td>
                <td className="text-right tabular-nums text-[var(--ds-text-secondary)]">{p.righe}</td>
                <td className="text-right tabular-nums text-[var(--ds-text-secondary)]">{p.media_min ?? '—'}′</td>
                <td className="text-right font-semibold tabular-nums text-[var(--ds-text-primary)]">{p.mediana_min ?? '—'}′</td>
              </tr>
            ))}
            {report.partite.length === 0 && (
              <tr>
                <td colSpan={4} className="py-2 text-[var(--ds-text-muted)]">Nessun dato nel periodo.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {report.scarti.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-[13px] font-semibold text-[var(--ds-text-muted)]">Scarti</div>
          <ul className="space-y-1 text-[14px]">
            {report.scarti.map((sc, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="min-w-0 truncate text-[var(--ds-text-secondary)]">
                  {sc.motivo ?? 'senza motivazione'} · {sc.righe}
                </span>
                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-primary)]">
                  {(sc.valore_cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="min-w-0">
    <div className="text-[26px] font-semibold tabular-nums leading-tight tracking-[-0.015em] text-[var(--ds-text-primary)]">
      {value}
    </div>
    <div className="text-[13px] text-[var(--ds-text-muted)]">{label}</div>
    {hint && <div className="text-[12px] text-[var(--ds-text-subtle)]">{hint}</div>}
  </div>
);
