import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cuboid, DoorClosed, Grid, Info, LocateFixed, MapPin, Maximize2, Minimize2, MonitorOff, Pin, PinOff, RotateCcw,
} from 'lucide-react';
import { Callout, EmptyState, LivePill, dsButton, dsIconButton } from '../ds';
import type { CalloutTone } from '../ds';
import { Loader } from '../Loader';
import { useToast } from '../../contexts/ToastContext';
import { useAppVersion } from '../../hooks/useAppVersion';
import { useFloorMarkers } from '../../hooks/useFloorMarkers';
import { useLinkRoutes } from '../../hooks/useLinkRoutes';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { useServiceOverrides } from '../../hooks/useServiceOverrides';
import { useWakeLock } from '../../hooks/useWakeLock';
import { reportClientError } from '../../services/clientErrorReporter';
import { liveService } from './model/service';
import { deriveSceneModel } from './model/sceneModel';
import { nextSettled, type SettledOverrides } from './model/overrides';
import { cachedWebglSupport, probeWebgl2, type WebglSupport } from './webglProbe';
import type { RoomModel, SalaVivoCanvasProps, SalaVivoPageProps, ServiceOverrides } from './types';

/* ── Sala dal vivo ────────────────────────────────────────────────────────
   La sala del servizio in corso in 3D, per il tablet all'ingresso o la TV.

   Questa pagina è il confine fra l'app e la scena: non importa mai three né
   la scena (tests/unit/boundaries.test.ts). Il canvas arriva a richiesta, e
   solo dopo che la sonda WebGL2 ha detto che il dispositivo lo sa disegnare:
   un tablet senza WebGL2 non scarica mai three.

   Il modello della sala (model/) si ricalcola sui dati e al minuto
   dell'orologio di App, mai a ogni fotogramma: alla scena arriva una sala
   già pronta, in metri. */

// Lette anche altrove: 'salaVivo.pinned' da App all'avvio (atterraggio).
const PINNED_KEY = 'salaVivo.pinned';
const ROOM_KEY = 'salaVivo.room';
const DEBUG_KEY = 'salaVivo.debug';
const RELOADED_FOR_KEY = 'salaVivo.reloadedFor';

// A schermo fissato i bottoni spariscono dopo 6 s senza tocchi né mouse, e
// tornano al primo gesto: su una TV restano solo la sala e l'orologio.
const CONTROLS_IDLE_MS = 6000;
// Nell'avviso delle sovrapposizioni: oltre, il conto di quelle che restano.
const MAX_OVERLAP_PAIRS = 3;
// Più di due avvisi spingerebbero la sala fuori dallo schermo di un tablet.
const MAX_CALLOUTS = 2;
// Uno schermo fissato non ha nessuno davanti che prema «Riavvia la vista» (una
// TV, la porta): dopo una perdita del contesto (driver riavviato, memoria
// dell'iPad, il chunk che non arriva) ci riprova da solo, qualche secondo
// dopo e di nuovo quando lo schermo torna acceso. Al più una volta al minuto
// e tre volte per caricamento: un dispositivo che il contesto non lo tiene
// non deve girare in tondo. Il bottone resta per chi c'è.
const AUTO_RESTART_DELAY_MS = 5000;
const AUTO_RESTART_GAP_MS = 60_000;
const AUTO_RESTART_MAX = 3;
let autoRestarts = 0;
let lastAutoRestartAt = -Infinity;

// Classi intere, mai composte: Tailwind le trova solo scritte per esteso. La
// radice fissata è un'alternativa completa, non un `p-3` in coda: fra due
// utility della stessa proprietà vince l'ordine in cui Tailwind le emette.
const ROOT = 'flex h-full min-h-0 flex-col gap-3 p-4 sm:p-6 lg:p-8';
const ROOT_PINNED = 'flex h-full min-h-0 flex-col gap-3 p-3';

// Le linguette delle sale, copiate da FloorPlan (ROOM_TAB_*): stessa sala,
// stessa linguetta. Una sala chiusa resta leggibile, barrata e con la porta;
// a riposo in --ds-text-muted e non in --ds-text-subtle come in FloorPlan:
// qui porta i coperti della sala, che altrove non ci sono, e il subtle sul
// grigio della linguetta non arriva al contrasto del testo (2,3:1).
const ROOM_TAB_BASE =
  'inline-flex h-11 flex-shrink-0 items-center gap-2 whitespace-nowrap rounded-[var(--ds-radius-control)] px-4 text-[15px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';
const ROOM_TAB_ACTIVE = 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]';
const ROOM_TAB_ACTIVE_CLOSED = 'bg-[var(--ds-text-muted)] text-[var(--ds-surface)] line-through';
const ROOM_TAB_IDLE =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]';
const ROOM_TAB_IDLE_CLOSED =
  'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)] hover:bg-[var(--ds-border)] line-through';

// Lo schermo fissato è una modalità che resta accesa: si legge «acceso» a
// colpo d'occhio col pieno, come «Sposta tavoli» in Sale & Tavoli. È la
// classe di dsIconButton per intero col fondo cambiato, non dsIconButton più
// un secondo bg-[…]: due utility arbitrarie sulla stessa proprietà escono in
// ordine alfabetico, e il fondo bianco vincerebbe.
const ICON_BUTTON_ON =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)] shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

// I bottoni della testata: svaniscono senza smettere di occupare il loro
// posto (la testata non salta), e da spenti non prendono il tocco, così il
// primo tocco li fa tornare invece di premerne uno alla cieca.
const CONTROLS_AWAKE = 'flex items-center gap-2 opacity-100 transition-opacity duration-150 motion-reduce:transition-none';
const CONTROLS_IDLE = 'pointer-events-none flex items-center gap-2 opacity-0 transition-opacity duration-150 motion-reduce:transition-none';

// ── localStorage, sempre in try/catch: modalità privata e quota piena
//    non devono rompere la pagina, solo dimenticare le preferenze. ─────────
const readStorage = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const writeStorage = (key: string, value: string | null): boolean => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
};
const readStoredRoomId = (): number | null => {
  const id = Number(readStorage(ROOM_KEY));
  return Number.isInteger(id) && id > 0 ? id : null;
};

// ── Schermo intero, con le varianti webkit (iPad). Si chiede su
//    documentElement e non sulla pagina: toast, avvisi e finestre dell'app
//    restano visibili sopra la sala. ──────────────────────────────────────
type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void;
};
type FullscreenRoot = HTMLElement & { webkitRequestFullscreen?: () => void };

const fullscreenDoc = (): FullscreenDocument => document as FullscreenDocument;
const fullscreenElement = (): Element | null =>
  fullscreenDoc().fullscreenElement ?? fullscreenDoc().webkitFullscreenElement ?? null;
// iPhone non ce l'ha per una pagina: lì il bottone non compare proprio.
const fullscreenAvailable = (): boolean => {
  if (typeof document === 'undefined') return false;
  const d = fullscreenDoc();
  const root = document.documentElement as FullscreenRoot;
  return (d.fullscreenEnabled === true && typeof root.requestFullscreen === 'function')
    || (d.webkitFullscreenEnabled === true && typeof root.webkitRequestFullscreen === 'function');
};
// Promise nei browser nuovi, niente nei Safari vecchi, a volte un'eccezione
// (gesto non valido): in ogni caso lo stato vero lo dice fullscreenchange.
const settleQuietly = (run: () => unknown): void => {
  try {
    const result = run();
    if (result instanceof Promise) result.catch(() => { /* resta com'era */ });
  } catch { /* resta com'era */ }
};
const exitFullscreen = (): void => settleQuietly(() => {
  const d = fullscreenDoc();
  return typeof d.exitFullscreen === 'function' ? d.exitFullscreen() : d.webkitExitFullscreen?.();
});
const enterFullscreen = (): void => settleQuietly(() => {
  const root = document.documentElement as FullscreenRoot;
  return typeof root.requestFullscreen === 'function' ? root.requestFullscreen() : root.webkitRequestFullscreen?.();
});

// ── Il canvas 3D, a richiesta ───────────────────────────────────────────
// Un chunk che non arriva (rete giù al primo avvio, hash sparito dopo un
// deploy) diventa il velo «La vista 3D si è interrotta.» con «Riavvia la
// vista», invece di far cadere la pagina intera. Un React.lazy rifiutato
// resta rifiutato: il riavvio ne crea uno nuovo, che riprova lo scaricamento.
const CanvasChunkFailed: React.FC<SalaVivoCanvasProps> = ({ onContextLost }) => {
  useEffect(() => { onContextLost(); }, [onContextLost]);
  return null;
};
let canvasChunkFailed = false;
const loadCanvas = () =>
  import('./SalaVivoCanvas').catch((err: unknown) => {
    console.error('[sala-dal-vivo] chunk 3D non caricato', err);
    canvasChunkFailed = true;
    return { default: CanvasChunkFailed };
  });
// Nel modulo e non nel componente: rientrando nella vista il canvas è già
// risolto e compare senza un altro giro di caricamento.
let SalaVivoCanvas = React.lazy<React.ComponentType<SalaVivoCanvasProps>>(loadCanvas);
const retryCanvasChunk = (): void => {
  if (!canvasChunkFailed) return;
  canvasChunkFailed = false;
  SalaVivoCanvas = React.lazy<React.ComponentType<SalaVivoCanvasProps>>(loadCanvas);
};

/** Un errore dentro la scena ferma la vista 3D, non la pagina: testata,
 *  linguette e orologio restano, e sopra la sala compare «Riavvia la vista». */
class SceneBoundary extends React.Component<{ onCrash: () => void; children: React.ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[sala-dal-vivo] scena 3D caduta', error);
    reportClientError(error, 'boundary', 'Sala dal vivo · 3D', info.componentStack ?? undefined);
    this.props.onCrash();
  }

  render() {
    return this.state.crashed ? null : this.props.children;
  }
}

/** Le varianti del servizio (unioni, tavoli nascosti, sale chiuse) con cui si
 *  disegna. Al primo caricamento si aspetta che ci siano; al cambio di
 *  servizio (le 17:00, le 05:00) si tengono le ultime buone finché quelle del
 *  servizio nuovo non arrivano: la sala resta disegnata invece di tornare al
 *  caricamento, e il canvas non si rismonta. La regola è nextSettled
 *  (model/overrides.ts), provata dai test. */
function useSettledOverrides(serviceKey: string, overrides: ServiceOverrides): SettledOverrides['value'] | null {
  const [settled, setSettled] = useState<SettledOverrides['value'] | null>(null);
  const lastRef = useRef<SettledOverrides | null>(null);
  const { ready, merges, hiddenTableIds, closedRoomIds } = overrides;
  useEffect(() => {
    const next = nextSettled(lastRef.current, serviceKey, { ready, merges, hiddenTableIds, closedRoomIds });
    if (next === null) return;
    lastRef.current = next;
    setSettled(next.value);
  }, [serviceKey, ready, merges, hiddenTableIds, closedRoomIds]);
  return settled;
}

interface PageCallout {
  id: string;
  tone: CalloutTone;
  icon: React.ComponentType<{ className?: string }>;
  text: string;
  action?: { label: string; onClick: () => void };
}

const SalaVivoPage: React.FC<SalaVivoPageProps> = ({
  rooms,
  tables,
  reservations,
  banquetMenus,
  isInitialLoading,
  isConnected,
  currentTime,
  canEditFloor,
  onImmersive,
  onOpenFloorPlan,
}) => {
  const { t, ready: i18nReady } = useTranslation('salavivo', { useSuspense: false });
  const { addToast } = useToast();
  // Lo stato della linea per la LivePill: la testata di App qui è nascosta.
  const linkRoutes = useLinkRoutes(isConnected);

  // ── Il servizio in corso e la sala che ne viene ─────────────────────────
  // Sempre il servizio di adesso nel fuso del ristorante, mai la data della
  // testata: alle 17:00 si passa alla cena insieme al resto dell'app.
  const service = useMemo(() => liveService(currentTime), [currentTime]);
  const overrides = useServiceOverrides(service.date, service.shift);
  const settledOverrides = useSettledOverrides(service.key, overrides);
  const { markers, loaded: markersLoaded } = useFloorMarkers(true);
  const nowMs = currentTime.getTime();
  const model = useMemo(() => (settledOverrides === null ? null : deriveSceneModel({
    rooms,
    tables,
    reservations,
    banquetMenus,
    merges: settledOverrides.merges,
    hiddenTableIds: settledOverrides.hiddenTableIds,
    closedRoomIds: settledOverrides.closedRoomIds,
    markers,
    service,
    nowMs,
  })), [rooms, tables, reservations, banquetMenus, settledOverrides, markers, service, nowMs]);

  // Le sale aperte, più una sala chiusa che ha ancora gente a tavola: chi è
  // seduto lì va visto comunque.
  const visibleRooms = useMemo<RoomModel[]>(
    () => (model ? model.rooms.filter(r => !r.closed || r.summary.seated > 0) : []),
    [model],
  );
  // La scelta resta sul dispositivo. Una sala sparita o chiusa per questo
  // turno ripiega sulla prima, senza cancellare la scelta: al turno dopo si
  // torna lì.
  const [storedRoomId, setStoredRoomId] = useState<number | null>(readStoredRoomId);
  const activeRoom = visibleRooms.find(r => r.id === storedRoomId) ?? visibleRooms[0] ?? null;
  const selectRoom = (id: number) => {
    setStoredRoomId(id);
    writeStorage(ROOM_KEY, String(id));
  };

  // ── La vista 3D ─────────────────────────────────────────────────────────
  // La sonda gira una volta per caricamento (in cache nel modulo): al primo
  // ingresso subito dopo il primo disegno, così testata e linguette non
  // aspettano la creazione dei contesti di prova.
  const [webgl, setWebgl] = useState<WebglSupport | null>(cachedWebglSupport);
  useEffect(() => {
    if (webgl === null) setWebgl(probeWebgl2());
  }, [webgl]);
  const reducedMotion = usePrefersReducedMotion();
  const [debug] = useState(() => readStorage(DEBUG_KEY) === '1');
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [canvasKey, setCanvasKey] = useState(0);
  const [contextLost, setContextLost] = useState(false);
  const handleContextLost = useCallback(() => setContextLost(true), []);
  const restart3d = useCallback(() => {
    retryCanvasChunk();
    setCanvasKey(k => k + 1);
    setContextLost(false);
  }, []);

  // ── Schermo fissato (chiosco) ───────────────────────────────────────────
  const [pinned, setPinned] = useState(() => readStorage(PINNED_KEY) === '1');
  // App nasconde barra laterale e barra in basso finché la pagina lo chiede;
  // smontata la pagina (anche per un crash) il chrome torna: uno schermo
  // fissato non resta mai senza navigazione.
  useEffect(() => {
    onImmersive(pinned);
    return () => onImmersive(false);
  }, [pinned, onImmersive]);
  const [controlsIdle, setControlsIdle] = useState(false);
  const togglePin = () => {
    const next = !pinned;
    const saved = writeStorage(PINNED_KEY, next ? '1' : null);
    setPinned(next);
    setControlsIdle(false);
    // Il messaggio promette l'avvio: senza salvataggio sarebbe falso.
    if (next && saved) addToast(t('pinnedToast'), 'success');
  };

  useEffect(() => {
    if (!pinned) return;
    let timer = window.setTimeout(() => setControlsIdle(true), CONTROLS_IDLE_MS);
    const wake = () => {
      setControlsIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setControlsIdle(true), CONTROLS_IDLE_MS);
    };
    // Sul documento e in cattura: un tocco sulla sala, che MapControls si
    // tiene, deve svegliare i bottoni lo stesso. Anche la tastiera: un
    // bottone che riceve il fuoco non può restare invisibile.
    const events = ['pointerdown', 'pointermove', 'keydown', 'focusin'] as const;
    events.forEach(name => document.addEventListener(name, wake, true));
    return () => {
      window.clearTimeout(timer);
      events.forEach(name => document.removeEventListener(name, wake, true));
    };
  }, [pinned]);

  // A schermo fissato la vista 3D interrotta riparte da sola (vedi
  // AUTO_RESTART_*). A schermo spento si aspetta: ci riprova il ritorno
  // visibile, che è anche quando un iPad senza wake lock si risveglia.
  useEffect(() => {
    if (!pinned || !contextLost) return;
    let timer: number | null = null;
    const attempt = () => {
      timer = null;
      if (document.visibilityState === 'hidden' || autoRestarts >= AUTO_RESTART_MAX) return;
      const wait = lastAutoRestartAt + AUTO_RESTART_GAP_MS - performance.now();
      if (wait > 0) {
        timer = window.setTimeout(attempt, wait);
        return;
      }
      autoRestarts += 1;
      lastAutoRestartAt = performance.now();
      restart3d();
    };
    const schedule = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(attempt, AUTO_RESTART_DELAY_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pinned, contextLost, restart3d]);

  const [canFullscreen] = useState(fullscreenAvailable);
  const [isFullscreen, setIsFullscreen] = useState(() => canFullscreen && fullscreenElement() !== null);
  const enteredFullscreenRef = useRef(false);
  useEffect(() => {
    if (!canFullscreen) return;
    const sync = () => setIsFullscreen(fullscreenElement() !== null);
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    return () => {
      document.removeEventListener('fullscreenchange', sync);
      document.removeEventListener('webkitfullscreenchange', sync);
      // Lo schermo intero chiesto da qui finisce con la pagina: nelle altre
      // viste non c'è il bottone per uscirne.
      if (enteredFullscreenRef.current && fullscreenElement() !== null) exitFullscreen();
    };
  }, [canFullscreen]);
  const toggleFullscreen = () => {
    if (fullscreenElement() !== null) {
      exitFullscreen();
      return;
    }
    enteredFullscreenRef.current = true;
    enterFullscreen();
  };

  // Lo schermo acceso finché la sala è fissata o a schermo intero.
  useWakeLock(pinned || isFullscreen);

  // A schermo fissato nessuno preme «Ricarica» sul banner della versione: a
  // ogni minuto, se il sito pubblicato è più nuovo, la pagina si ricarica da
  // sola. Una volta per versione (salaVivo.reloadedFor): se il deploy viene
  // ritirato e il sito resta indietro, il tablet non ricarica in loop.
  const { currentVersion, remoteVersion, reload } = useAppVersion();
  useEffect(() => {
    if (!pinned || !remoteVersion || remoteVersion === currentVersion) return;
    if (remoteVersion === 'dev' || currentVersion === 'dev') return;
    if (readStorage(RELOADED_FOR_KEY) === remoteVersion) return;
    // Senza la traccia salvata un ritiro del deploy farebbe ricaricare in
    // loop: meglio restare sulla versione vecchia.
    if (!writeStorage(RELOADED_FOR_KEY, remoteVersion)) return;
    reload();
  }, [pinned, remoteVersion, currentVersion, reload, nowMs]);

  // ── Avvisi ──────────────────────────────────────────────────────────────
  const canEditHere = canEditFloor && !pinned;
  const callouts: PageCallout[] = [];
  // Senza WebGL2 il palco resta vuoto: l'avviso dice perché, anche a schermo
  // fissato.
  if (webgl === 'none') callouts.push({ id: 'noWebgl', tone: 'critical', icon: MonitorOff, text: t('noWebgl') });
  // Gli avvisi sulla sala solo a chi la può sistemare, come quello delle
  // sovrapposizioni in Sale & Tavoli, e mai a schermo fissato: lo legge chi
  // aspetta all'ingresso.
  if (canEditHere && activeRoom) {
    const { audit } = activeRoom;
    const openRoom = () => onOpenFloorPlan({ roomId: activeRoom.id });
    if (audit.unset) {
      callouts.push({ id: 'layoutUnset', tone: 'pending', icon: Grid, text: t('layoutUnset'), action: { label: t('arrangeTables'), onClick: openRoom } });
    } else if (audit.overlaps.length > 0) {
      // Le coppie come nell'avviso della piantina («11 ↔ 12»), le prime tre.
      const pairs = audit.overlaps.slice(0, MAX_OVERLAP_PAIRS).map(([a, b]) => `${a} ↔ ${b}`).join(', ');
      const rest = audit.overlaps.length - MAX_OVERLAP_PAIRS;
      callouts.push({
        id: 'overlap',
        tone: 'pending',
        icon: Grid,
        text: t('overlap', { pairs: rest > 0 ? t('overlapMore', { pairs, count: rest }) : pairs }),
        action: { label: t('arrangeTables'), onClick: openRoom },
      });
    }
    // Solo a lista letta: prima, «nessun segnaposto» vuol dire «non lo so».
    if (markersLoaded && audit.missingMarkers.length > 0) {
      callouts.push({ id: 'markersMissing', tone: 'pending', icon: MapPin, text: t('markersMissing'), action: { label: t('placeMarkers'), onClick: openRoom } });
    }
  }
  // La vista semplificata è un'informazione e basta: dopo gli avvisi su cui
  // si può agire (i posti sono due), e mai a schermo fissato, dove resterebbe
  // sopra la sala tutto il servizio. Su una TV restano la sala e l'orologio.
  if (webgl === 'slow' && !pinned) callouts.push({ id: 'slowDevice', tone: 'info', icon: Info, text: t('slowDevice') });
  const shownCallouts = callouts.slice(0, MAX_CALLOUTS);

  // Le sale chiuse da Sale & Tavoli (rooms.is_closed) restano chiuse finché
  // qualcuno non le riapre: la linguetta non deve dire «per questo turno».
  const closedIndefinitely = useMemo(
    () => new Set((Array.isArray(rooms) ? rooms : []).filter(r => r?.is_closed === true).map(r => r.id)),
    [rooms],
  );

  // Durante il primo caricamento di App il modello c'è già, ma calcolato su
  // liste ancora vuote: niente numeri né «Centra» finché i dati non arrivano,
  // o la testata direbbe «0 a tavola» per un attimo e il bottone non
  // avrebbe una scena da centrare.
  const loading = isInitialLoading || model === null;
  const canvasOn = !loading && (webgl === 'ok' || webgl === 'slow') && !contextLost && activeRoom !== null;

  // Il dizionario della pagina arriva a richiesta: prima, le chiavi grezze.
  if (!i18nReady) return <Loader label={null} className="h-full" />;

  return (
    <div className={pinned ? ROOT_PINNED : ROOT}>
      <div className="flex flex-shrink-0 items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
            {t('title')}
          </h1>
          {/* La riga c'è anche prima dei numeri: quando arrivano la testata
              non cresce e la sala sotto non salta. */}
          <p className="mt-0.5 truncate text-[15px] tabular-nums text-[var(--ds-text-secondary)]">
            {model && !loading ? t('summary', { seated: model.summary.seated, arriving: model.summary.arriving }) : ' '}
          </p>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <div className={pinned && controlsIdle ? CONTROLS_IDLE : CONTROLS_AWAKE}>
            {canvasOn && (
              <button
                type="button"
                onClick={() => setRecenterSignal(n => n + 1)}
                className={dsIconButton}
                title={t('recenter')}
                aria-label={t('recenter')}
              >
                <LocateFixed className="h-5 w-5" aria-hidden />
              </button>
            )}
            {/* Un interruttore: il nome resta quello e lo stato lo dice
                aria-pressed; il title dice cosa fa il prossimo tocco. */}
            <button
              type="button"
              onClick={togglePin}
              aria-pressed={pinned}
              className={pinned ? ICON_BUTTON_ON : dsIconButton}
              title={pinned ? t('unpin') : t('pin')}
              aria-label={t('pin')}
            >
              {pinned ? <PinOff className="h-5 w-5" aria-hidden /> : <Pin className="h-5 w-5" aria-hidden />}
            </button>
            {canFullscreen && (
              <button
                type="button"
                onClick={toggleFullscreen}
                className={dsIconButton}
                title={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
                aria-label={isFullscreen ? t('exitFullscreen') : t('fullscreen')}
              >
                {isFullscreen ? <Minimize2 className="h-5 w-5" aria-hidden /> : <Maximize2 className="h-5 w-5" aria-hidden />}
              </button>
            )}
          </div>
          {/* L'orologio non svanisce con i bottoni: su una TV è quello che
              dice che la sala è viva. Pastiglia da md, pallino sotto; la
              pastiglia porta inline-flex, quindi si nasconde con max-md:. */}
          <LivePill connected={isConnected} time={currentTime} routes={linkRoutes} routesClassName="max-lg:hidden" className="max-md:hidden" />
          <LivePill connected={isConnected} time={currentTime} variant="dot" className="mx-1 md:hidden" />
        </div>
      </div>

      {loading ? (
        <Loader className="min-h-0 flex-1" />
      ) : visibleRooms.length === 0 || activeRoom === null ? (
        <EmptyState
          icon={Cuboid}
          action={canEditHere ? (
            <button type="button" onClick={() => onOpenFloorPlan()} className={dsButton.secondary}>
              {t('openFloorPlan')}
            </button>
          ) : undefined}
        >
          {t('noRooms')}
        </EmptyState>
      ) : (
        <>
          {/* Su una card bianca come la barra di Sale & Tavoli: il grigio
              delle linguette a riposo sul fondo della pagina non si vedrebbe. */}
          <div className="flex-shrink-0 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] p-2 shadow-[var(--ds-shadow-card)]">
            <div className="-m-1 flex items-center gap-2 overflow-x-auto p-1 scrollbar-hide">
              {visibleRooms.map(room => {
                const active = room.id === activeRoom.id;
                const closedLabel = !room.closed
                  ? null
                  : closedIndefinitely.has(room.id)
                    ? t('roomClosedIndefinitely', { room: room.name })
                    : t('roomClosed', { room: room.name });
                return (
                  <button
                    key={room.id}
                    type="button"
                    onClick={() => selectRoom(room.id)}
                    aria-pressed={active}
                    title={closedLabel ?? undefined}
                    // Il numero a video sono le persone a tavola adesso in
                    // quella sala (decisione di Tina, 4 ottobre): cambia
                    // durante il servizio, ed è quello che uno schermo
                    // all'ingresso deve dire. Per lo screen reader lo si dice.
                    aria-label={t('roomTab', { room: closedLabel ?? room.name, count: room.summary.seated })}
                    className={`${ROOM_TAB_BASE} ${
                      active
                        ? room.closed ? ROOM_TAB_ACTIVE_CLOSED : ROOM_TAB_ACTIVE
                        : room.closed ? ROOM_TAB_IDLE_CLOSED : ROOM_TAB_IDLE
                    }`}
                  >
                    {room.closed && <DoorClosed size={14} aria-hidden />}
                    <span className="tabular-nums">{room.name} · {room.summary.seated}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {shownCallouts.map(c => (
            <Callout
              key={c.id}
              tone={c.tone}
              icon={c.icon}
              className="flex-shrink-0"
              action={c.action ? (
                <button type="button" onClick={c.action.onClick} className={dsButton.secondary}>
                  {c.action.label}
                </button>
              ) : undefined}
            >
              {c.text}
            </Callout>
          ))}

          <div className="relative min-h-0 flex-1 overflow-hidden rounded-[var(--ds-radius)] bg-[var(--ds-canvas)]">
            {/* La sala per chi non la vede: i numeri della sala scelta, in
                un'immagine vuota ACCANTO al canvas. Un role="img" toglie allo
                screen reader tutto quello che contiene: il «Preparo la vista
                3D…» del caricamento, il velo e i loro bottoni stanno fuori. Il
                canvas, che non ha niente da leggere, è aria-hidden. */}
            <div
              role="img"
              aria-label={t('stageLabel', { room: activeRoom.name, seated: activeRoom.summary.seated, arriving: activeRoom.summary.arriving })}
              className="sr-only"
            />
            {canvasOn && (
              <div className="absolute inset-0">
                <SceneBoundary key={canvasKey} onCrash={handleContextLost}>
                  <React.Suspense fallback={<Loader label={t('loading3d')} className="h-full" />}>
                    <SalaVivoCanvas
                      room={activeRoom}
                      reducedMotion={reducedMotion}
                      slowMode={webgl === 'slow'}
                      debug={debug}
                      recenterSignal={recenterSignal}
                      onContextLost={handleContextLost}
                    />
                  </React.Suspense>
                </SceneBoundary>
              </div>
            )}

            {/* Sempre montata: uno screen reader annuncia di sicuro il testo
                che cambia dentro una regione viva che c'era già, non sempre
                una che compare insieme al suo testo. */}
            <p role="status" className="sr-only">{contextLost ? t('contextLost') : ''}</p>
            {contextLost && (
              <div className="absolute inset-0 flex items-center justify-center p-6">
                {/* Su una card come l'avviso «Nessun tavolo»: sul fondo del
                    palco il testo grigio non arriverebbe al contrasto. Il
                    testo lo legge la regione viva qui sopra. */}
                <div className="flex flex-col items-center gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-5 py-4 text-center shadow-[var(--ds-shadow-card)]">
                  <p aria-hidden="true" className="text-[15px] text-[var(--ds-text-secondary)]">{t('contextLost')}</p>
                  <button type="button" onClick={restart3d} className={dsButton.secondary}>
                    <RotateCcw className="h-4 w-4" aria-hidden />
                    {t('restart3d')}
                  </button>
                </div>
              </div>
            )}

            {/* Pavimento e segnaposto si disegnano lo stesso: l'avviso sta
                in alto e lascia vedere la sala vuota. */}
            {activeRoom.tables.length === 0 && !contextLost && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
                <div className="pointer-events-auto flex items-center gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)]">
                  <p className="text-[14px] text-[var(--ds-text-muted)]">{t('noTables')}</p>
                  {canEditHere && (
                    <button type="button" onClick={() => onOpenFloorPlan({ roomId: activeRoom.id })} className={dsButton.quiet}>
                      {t('openFloorPlan')}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default SalaVivoPage;
