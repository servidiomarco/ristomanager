import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Cuboid, DoorClosed, Footprints, Grid, Info, LocateFixed, MapPin, Maximize2, Minimize2, MonitorOff, Pin, PinOff, RotateCcw, Tag,
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
import { useStaffOnShift } from '../../hooks/useStaffOnShift';
import { useWakeLock } from '../../hooks/useWakeLock';
import { getReservationNotePresets, type ReservationNotePreset } from '../../services/apiService';
import { reportClientError } from '../../services/clientErrorReporter';
import { swrConfig } from '../../services/configCache';
import { sessionTimeZone } from '../../utils/displayTime';
import { liveService } from './model/service';
import { deriveSceneModel, roomsToShow } from './model/sceneModel';
import { nextSettled, type ReadOverrides, type SettledOverrides } from './model/overrides';
import { DIRECTOR_SEED, SceneDirector, withEscortTargets } from './model/director';
import { ActivityStrip } from './ActivityStrip';
import {
  STRIP_TTL_MS, addStripItems, peopleText, revealStripItems, stillTrue, stripItemsOf, stripLine, withoutEscort,
  type ActivityLine, type StripItem,
} from './model/activity';
import { cachedWebglSupport, probeWebgl2, type WebglSupport } from './webglProbe';
import type {
  DirectorEvent, NotePresetRef, RoomModel, SalaVivoCanvasProps, SalaVivoPageProps, SceneCopy,
  SceneDirectorApi, SnapReason,
} from './types';

/* ── Sala dal vivo ────────────────────────────────────────────────────────
   La sala del servizio in corso in 3D, per il tablet all'ingresso o la TV.

   Questa pagina è il confine fra l'app e la scena: non importa mai three né
   la scena (tests/unit/boundaries.test.ts). Il canvas arriva a richiesta, e
   solo dopo che la sonda WebGL2 ha detto che il dispositivo lo sa disegnare:
   un tablet senza WebGL2 non scarica mai three.

   Il modello della sala (model/) si ricalcola sui dati e al minuto
   dell'orologio di App, mai a ogni fotogramma: alla scena arriva una sala
   già pronta, in metri.

   Il regista (model/director.ts) mette in scena il passaggio fra due
   modelli: l'hostess che accompagna chi arriva, chi si alza, chi esce. Lo
   crea e lo aggiorna questa pagina, al commit dei dati; il canvas lo fa
   avanzare a ogni fotogramma. Il modello resta l'unica verità su DOVE sta
   ognuno: il regista decide solo come ci arriva. */

// Lette anche altrove: 'salaVivo.pinned' da App all'avvio (atterraggio).
const PINNED_KEY = 'salaVivo.pinned';
const ROOM_KEY = 'salaVivo.room';
const NAMES_KEY = 'salaVivo.names';
const DEBUG_KEY = 'salaVivo.debug';
const RELOADED_FOR_KEY = 'salaVivo.reloadedFor';
// «Segui il servizio», per dispositivo: '1' acceso, '0' spento. Senza una
// scelta vale lo schermo fissato: una TV segue il servizio da sola, un
// tablet in mano resta sulla sala dove lo si mette.
const FOLLOW_KEY = 'salaVivo.follow';

// «Segui il servizio». Il calo d'opacità (150 ms) copre il salto
// dell'inquadratura al cambio di sala; dopo un accompagnamento in un'altra
// sala, 20 s di calma riportano alla sala di casa; a schermo fissato e
// fermo, ogni 45 s la sala dopo fra quelle con qualcuno a tavola. Un tocco
// su una linguetta o un trascinamento della sala fermano i cambi per due
// minuti: la sala non scappa di mano a chi la sta usando.
const FOLLOW_DIP_MS = 150;
const FOLLOW_HOME_MS = 20_000;
const FOLLOW_HOME_POLL_MS = 2_000;
const FOLLOW_CYCLE_MS = 45_000;
const FOLLOW_CYCLE_POLL_MS = 5_000;
const FOLLOW_PAUSE_MS = 120_000;

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

// Lo schermo fissato e i nomi degli ospiti sono modalità che restano accese:
// si leggono «accese» a colpo d'occhio col pieno, come «Sposta tavoli» in
// Sale & Tavoli. È la classe di dsIconButton per intero col fondo cambiato,
// non dsIconButton più un secondo bg-[…]: due utility arbitrarie sulla
// stessa proprietà escono in ordine alfabetico, e il fondo bianco vincerebbe.
const ICON_BUTTON_ON =
  'inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-[var(--ds-radius-control)] bg-[var(--ds-arriving-solid)] text-[var(--ds-arriving-fg)] shadow-[var(--ds-shadow-card)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]';

// I bottoni della testata: svaniscono senza smettere di occupare il loro
// posto (la testata non salta), e da spenti non prendono il tocco, così il
// primo tocco li fa tornare invece di premerne uno alla cieca.
const CONTROLS_AWAKE = 'flex items-center gap-2 opacity-100 transition-opacity duration-150 motion-reduce:transition-none';
const CONTROLS_IDLE = 'pointer-events-none flex items-center gap-2 opacity-0 transition-opacity duration-150 motion-reduce:transition-none';

// La sala durante un cambio di «Segui il servizio»: svanisce, cambia,
// ricompare. Col movimento ridotto il cambio è secco: la pagina non mette il
// calo, e motion-reduce toglie comunque la transizione.
const STAGE_SHOWN = 'absolute inset-0 opacity-100 transition-opacity duration-150 motion-reduce:transition-none';
const STAGE_DIPPED = 'absolute inset-0 opacity-0 transition-opacity duration-150 motion-reduce:transition-none';

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

// ── I preset delle note (Impostazioni → Opzioni prenotazioni) ─────────────
// Al modello bastano etichetta e icona: le etichette con l'icona 'dog'
// dicono il cane, quelle con 'baby' il seggiolone. Finché non arrivano, o se
// non arrivano proprio (un server vecchio, un errore), la lista resta vuota e
// il modello ripiega su «Cane» e «Seggiolone».
const NO_PRESETS: readonly NotePresetRef[] = [];
const toPresetRefs = (rows: unknown): readonly NotePresetRef[] =>
  Array.isArray(rows)
    ? rows.map((row: Partial<ReservationNotePreset> | null | undefined) => ({
        label: String(row?.label ?? ''),
        icon: typeof row?.icon === 'string' ? row.icon : null,
      }))
    : NO_PRESETS;
// La cache risponde subito con l'ultima lista, il fetch poco dopo di solito
// con la stessa: uguale, si tiene quella che c'è e la sala non si ricalcola.
const samePresets = (a: readonly NotePresetRef[], b: readonly NotePresetRef[]): boolean =>
  a.length === b.length && a.every((p, i) => p.label === b[i].label && (p.icon ?? null) === (b[i].icon ?? null));

// I testi dei cartellini prima che il dizionario della pagina arrivi. Intanto
// la pagina mostra il caricamento e la scena non c'è, ma il modello si
// calcola lo stesso: t() chiamata così presto darebbe le chiavi grezze.
const FALLBACK_COPY: SceneCopy = { reserved: time => time, event: '' };

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
 *  disegna, il servizio a cui appartengono e la lettura da cui vengono. Al
 *  primo caricamento si aspetta che ci siano; al cambio di servizio (le
 *  17:00, le 05:00) si tengono le ultime buone finché quelle del servizio
 *  nuovo non arrivano: la sala resta disegnata invece di tornare al
 *  caricamento, e il canvas non si rismonta. Intanto la chiave resta quella
 *  vecchia, e la pagina non dà quei modelli al regista. La regola è
 *  nextSettled (model/overrides.ts), provata dai test. */
function useSettledOverrides(serviceKey: string, overrides: ReadOverrides): SettledOverrides | null {
  const [settled, setSettled] = useState<SettledOverrides | null>(null);
  const lastRef = useRef<SettledOverrides | null>(null);
  const { ready, merges, hiddenTableIds, closedRoomIds, reads } = overrides;
  useEffect(() => {
    const next = nextSettled(lastRef.current, serviceKey, { ready, merges, hiddenTableIds, closedRoomIds, reads });
    if (next === null) return;
    lastRef.current = next;
    setSettled(next);
  }, [serviceKey, ready, merges, hiddenTableIds, closedRoomIds, reads]);
  return settled;
}

// ── «Segui il servizio» ─────────────────────────────────────────────────
// Lo schermo va dove succede qualcosa: un accompagnamento che parte in
// un'altra sala la porta lì; 20 s di calma dopo, torna alla sala di casa
// (quella scelta con le linguette, che il cambio non tocca mai); a schermo
// fissato e fermo gira le sale con qualcuno a tavola. Timer ed eventi del
// regista arrivano fuori dal render: la logica sta in un oggetto creato una
// volta, che legge l'ultimo render da un ref.

interface FollowInputs {
  enabled: boolean;
  pinned: boolean;
  /** La sala di casa: quella scelta, o la prima. */
  homeRoomId: number | null;
  /** Le sale delle linguette. */
  rooms: readonly RoomModel[];
  reducedMotion: boolean;
}

interface FollowController {
  onEvent: (event: DirectorEvent) => void;
  pause: () => void;
  chooseHome: () => void;
  stop: () => void;
  startCycle: () => void;
  stopCycle: () => void;
  dispose: () => void;
}

const createFollowController = (
  live: { readonly current: FollowInputs },
  director: SceneDirectorApi,
  setRoomId: (id: number | null) => void,
  setDipped: (dipped: boolean) => void,
): FollowController => {
  // La sala dove il cambio ha portato lo schermo (null: casa), e quella
  // verso cui sta andando durante il calo d'opacità.
  let roomId: number | null = null;
  let heading: number | null = null;
  // Perché lo schermo è lontano da casa: un accompagnamento (torna dopo la
  // calma) o il giro delle sale (cambia ogni 45 s).
  let away: 'escort' | 'cycle' | null = null;
  // Un accompagnamento partito in un'altra sala mentre quello a video era
  // ancora in corso: ci si va quando questo finisce (se là è ancora in
  // corso). Prima ogni partenza tagliava via quello che si stava guardando, e
  // con due o tre arrivi di fila non se ne vedeva nessuno.
  let pending: number | null = null;
  let pausedUntil = 0;
  let lastEventAt = 0;
  let dipTimer: number | null = null;
  let homeTimer: number | null = null;
  let cycleTimer: number | null = null;

  const now = () => performance.now();
  const clearTimer = (id: number | null) => {
    if (id !== null) window.clearTimeout(id);
  };
  // La sala a video adesso: una sala sparita dalle linguette (chiusa e
  // vuota) vale casa.
  const shownId = (): number | null => {
    const s = live.current;
    return s.enabled && roomId !== null && s.rooms.some(r => r.id === roomId) ? roomId : s.homeRoomId;
  };
  const setRoom = (id: number | null) => {
    roomId = id;
    heading = id;
    setRoomId(id);
  };

  /** Lo schermo su `target` (null o la sala di casa: casa), col calo
   *  d'opacità quando la sala a video cambia davvero. */
  const goTo = (target: number | null, why: 'escort' | 'cycle') => {
    const s = live.current;
    const id = target === s.homeRoomId ? null : target;
    away = id === null ? null : why;
    if (id === heading) return;
    heading = id;
    clearTimer(dipTimer);
    dipTimer = null;
    if (shownId() === (id ?? s.homeRoomId) || s.reducedMotion) {
      setRoom(id);
      setDipped(false);
      return;
    }
    setDipped(true);
    dipTimer = window.setTimeout(() => {
      dipTimer = null;
      setRoom(heading);
      setDipped(false);
    }, FOLLOW_DIP_MS);
  };

  const armHome = (ms: number) => {
    clearTimer(homeTimer);
    homeTimer = window.setTimeout(checkHome, Math.max(0, ms));
  };
  function checkHome() {
    homeTimer = null;
    if (away !== 'escort' || !live.current.enabled) return;
    const t = now();
    if (t < pausedUntil) {
      armHome(pausedUntil - t);
      return;
    }
    // Qualcuno ancora in cammino, o un accompagnamento in coda: si resta, e
    // si riguarda fra poco. Il regista non resta acceso per sempre: oltre
    // 90 s chiude da sé qualunque passaggio.
    if (director.isAnimating()) {
      armHome(FOLLOW_HOME_POLL_MS);
      return;
    }
    goTo(null, 'escort');
  }

  const armCycle = (ms: number) => {
    clearTimer(cycleTimer);
    cycleTimer = window.setTimeout(checkCycle, Math.max(0, ms));
  };
  function checkCycle() {
    cycleTimer = null;
    const s = live.current;
    if (!s.enabled || !s.pinned) return;
    const t = now();
    const wait = Math.max(pausedUntil - t, lastEventAt + FOLLOW_CYCLE_MS - t);
    if (wait > 0) {
      armCycle(wait);
      return;
    }
    if (away === 'escort' || director.isAnimating()) {
      armCycle(FOLLOW_CYCLE_POLL_MS);
      return;
    }
    // La prossima sala con qualcuno a tavola dopo quella a video, nell'ordine
    // delle linguette; nessuna: casa.
    const at = s.rooms.findIndex(r => r.id === shownId());
    const order = at < 0 ? s.rooms : [...s.rooms.slice(at + 1), ...s.rooms.slice(0, at + 1)];
    const next = order.find(r => r.summary.seated > 0);
    goTo(next ? next.id : null, 'cycle');
    armCycle(FOLLOW_CYCLE_MS);
  }

  // La sala a video ha un accompagnamento in coda o in corso.
  const busy = (id: number | null): boolean => id !== null && director.escortTargets(id).size > 0;

  return {
    onEvent(event) {
      lastEventAt = now();
      const s = live.current;
      if (!s.enabled) return;
      if (event.kind === 'escort-start' && now() >= pausedUntil
        && event.roomId !== shownId() && s.rooms.some(r => r.id === event.roomId)) {
        if (busy(shownId())) {
          pending = event.roomId;
        } else {
          pending = null;
          goTo(event.roomId, 'escort');
        }
        armHome(FOLLOW_HOME_MS);
        return;
      }
      // Finito l'ultimo accompagnamento della sala a video: tocca a quello
      // rimasto in attesa, se è ancora in corso.
      if (event.kind === 'escort-end' && pending !== null && event.roomId === shownId() && !busy(event.roomId)) {
        const target = pending;
        pending = null;
        if (now() >= pausedUntil && target !== shownId() && s.rooms.some(r => r.id === target) && busy(target)) {
          goTo(target, 'escort');
          armHome(FOLLOW_HOME_MS);
          return;
        }
      }
      // Lontano da casa per un accompagnamento: ogni cosa che succede fa
      // ripartire i 20 s di calma.
      if (away === 'escort') armHome(FOLLOW_HOME_MS);
    },
    pause() {
      pausedUntil = now() + FOLLOW_PAUSE_MS;
      pending = null;
    },
    chooseHome() {
      pausedUntil = now() + FOLLOW_PAUSE_MS;
      pending = null;
      clearTimer(dipTimer);
      clearTimer(homeTimer);
      dipTimer = null;
      homeTimer = null;
      away = null;
      setRoom(null);
      setDipped(false);
    },
    stop() {
      clearTimer(dipTimer);
      clearTimer(homeTimer);
      clearTimer(cycleTimer);
      dipTimer = null;
      homeTimer = null;
      cycleTimer = null;
      away = null;
      pending = null;
      setRoom(null);
      setDipped(false);
    },
    startCycle() {
      armCycle(FOLLOW_CYCLE_MS);
    },
    stopCycle() {
      clearTimer(cycleTimer);
      cycleTimer = null;
      // Finito il giro (lo schermo non è più fissato), una sala del giro non
      // resta a video senza un perché: si torna a casa.
      if (away === 'cycle') goTo(null, 'cycle');
    },
    dispose() {
      clearTimer(dipTimer);
      clearTimer(homeTimer);
      clearTimer(cycleTimer);
      dipTimer = null;
      homeTimer = null;
      cycleTimer = null;
    },
  };
};

/** «Segui il servizio»: la sala dove lo schermo è stato portato (null =
 *  casa), il calo d'opacità in corso, e chi riceve gli eventi del regista,
 *  i trascinamenti e i tocchi sulle linguette. */
function useFollowService(inputs: FollowInputs, director: SceneDirectorApi) {
  const [roomId, setRoomId] = useState<number | null>(null);
  const [dipped, setDipped] = useState(false);
  const live = useRef(inputs);
  // Prima degli effetti della pagina che aggiornano il regista: un evento
  // emesso dentro quell'update deve già leggere le sale di questo render.
  useLayoutEffect(() => {
    live.current = inputs;
  });
  const [controller] = useState(() => createFollowController(live, director, setRoomId, setDipped));
  const { enabled, pinned } = inputs;

  // Spento: subito a casa, niente timer.
  useEffect(() => {
    if (!enabled) controller.stop();
  }, [enabled, controller]);
  // Il giro delle sale solo a schermo fissato.
  useEffect(() => {
    if (!enabled || !pinned) return;
    controller.startCycle();
    return () => controller.stopCycle();
  }, [enabled, pinned, controller]);
  useEffect(() => () => controller.dispose(), [controller]);

  return { roomId: enabled ? roomId : null, dipped, controller };
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
  reservationsEpoch,
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
  const settled = useSettledOverrides(service.key, overrides);
  const settledOverrides = settled?.value ?? null;
  const { markers, loaded: markersLoaded } = useFloorMarkers(true);
  const nowMs = currentTime.getTime();

  // ── Il regista della scena ──────────────────────────────────────────────
  // Uno per pagina, creato una volta (il costruttore non ha effetti: in
  // StrictMode può nascere due volte). Il suo orologio timbra gli eventi e
  // misura i cambi in blocco; il seme è lo stesso su ogni schermo del
  // ristorante, così la porta e la TV mettono in scena la stessa cosa.
  const [director] = useState<SceneDirectorApi>(
    () => new SceneDirector({ now: () => performance.now(), seed: DIRECTOR_SEED }),
  );
  // Il personale di sala di turno (le stesse persone di Personale): i
  // camerieri che girano e il nome dell'hostess. Finché la lista non arriva
  // il regista non mette camerieri, invece di farli comparire senza nome.
  const staff = useStaffOnShift(service, reservationsEpoch);
  useEffect(() => {
    director.configure({ staff });
  }, [director, staff]);

  // ── Gli ospiti: preset delle note, nomi, testi dei cartellini ───────────
  // La stessa chiave di cache di ReservationList, così le due viste si
  // dividono il fetch. Si rilegge a ogni servizio: uno schermo fissato non
  // si rismonta mai, e un'etichetta cambiata in Impostazioni arriva lo stesso.
  const [notePresets, setNotePresets] = useState<readonly NotePresetRef[]>(NO_PRESETS);
  useEffect(() => swrConfig('reservationNotePresets', getReservationNotePresets, rows => {
    const next = toPresetRefs(rows);
    setNotePresets(prev => (samePresets(prev, next) ? prev : next));
  }), [service.key]);
  // «Nomi degli ospiti»: per dispositivo e spenti di default, perché uno
  // schermo all'ingresso lo legge anche chi aspetta. Spenti, nel modello non
  // entra nessun nome di persona.
  const [showNames, setShowNames] = useState(() => readStorage(NAMES_KEY) === '1');
  const toggleNames = () => {
    const next = !showNames;
    // Senza salvataggio (modalità privata) la scelta vale finché la pagina
    // resta aperta.
    writeStorage(NAMES_KEY, next ? '1' : null);
    setShowNames(next);
  };
  // Il modello non conosce i18n: i testi dei cartellini glieli dà la pagina,
  // già tradotti, e cambiano con la lingua (t cambia con lei).
  const copy = useMemo<SceneCopy>(
    () => (i18nReady ? { reserved: time => t('reserved', { time }), event: t('event') } : FALLBACK_COPY),
    [t, i18nReady],
  );

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
    notePresets,
    showNames,
    copy,
  })), [rooms, tables, reservations, banquetMenus, settledOverrides, markers, service, nowMs, notePresets, showNames, copy]);

  // Le sale aperte, più una sala chiusa dove c'è ancora qualcuno, a tavola,
  // all'ingresso o in arrivo: chi la testata conta va visto comunque.
  const visibleRooms = useMemo<RoomModel[]>(() => (model ? roomsToShow(model.rooms) : []), [model]);
  // La scelta resta sul dispositivo. Una sala sparita o chiusa per questo
  // turno ripiega sulla prima, senza cancellare la scelta: al turno dopo si
  // torna lì.
  const [storedRoomId, setStoredRoomId] = useState<number | null>(readStoredRoomId);
  // La sala di casa. «Segui il servizio» può mostrarne un'altra per un po'
  // (shownRoom, più sotto), ma non tocca mai questa scelta.
  const activeRoom = visibleRooms.find(r => r.id === storedRoomId) ?? visibleRooms[0] ?? null;

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

  // Durante il primo caricamento di App il modello c'è già, ma calcolato su
  // liste ancora vuote: niente numeri né «Centra» finché i dati non arrivano,
  // o la testata direbbe «0 a tavola» per un attimo e il bottone non
  // avrebbe una scena da centrare.
  const loading = isInitialLoading || model === null;
  const canvasOn = !loading && (webgl === 'ok' || webgl === 'slow') && !contextLost && activeRoom !== null;

  // ── «Segui il servizio» ─────────────────────────────────────────────────
  const [followPref, setFollowPref] = useState<boolean | null>(() => {
    const stored = readStorage(FOLLOW_KEY);
    return stored === '1' ? true : stored === '0' ? false : null;
  });
  const followOn = followPref ?? pinned;
  const toggleFollow = () => {
    const next = !followOn;
    // Senza salvataggio la scelta vale finché la pagina resta aperta.
    writeStorage(FOLLOW_KEY, next ? '1' : '0');
    setFollowPref(next);
  };
  // Solo con la vista 3D: senza (niente WebGL, la vista interrotta) non c'è
  // nessun accompagnamento da seguire, e uno schermo fissato girerebbe le
  // sale ogni 45 s senza il bottone per fermarlo.
  const follow = useFollowService(
    { enabled: followOn && canvasOn, pinned, homeRoomId: activeRoom?.id ?? null, rooms: visibleRooms, reducedMotion },
    director,
  );
  const followController = follow.controller;
  // La sala a video: quella dove «Segui il servizio» ha portato lo schermo,
  // finché è fra le linguette, altrimenti quella di casa. Le linguette, i
  // numeri del palco e gli avvisi parlano di questa.
  const shownRoom = (follow.roomId !== null ? visibleRooms.find(r => r.id === follow.roomId) : undefined) ?? activeRoom;
  const shownRoomId = shownRoom?.id ?? null;
  const selectRoom = (id: number) => {
    setStoredRoomId(id);
    writeStorage(ROOM_KEY, String(id));
    // Un tocco su una linguetta è una scelta: lo schermo va lì e ci resta,
    // e per due minuti «Segui il servizio» non lo sposta.
    followController.chooseHome();
  };

  // Lo schermo portato su un'altra sala (o tornato a casa) da «Segui il
  // servizio»: la sua linguetta può stare fuori dalla barra (tante sale, un
  // telefono), e niente a video direbbe quale sala si guarda. La si porta in
  // vista; un tocco su una linguetta la porta tutta in vista, che non guasta.
  const tabRefs = useRef(new Map<number, HTMLButtonElement>());
  useEffect(() => {
    if (shownRoomId === null) return;
    const el = tabRefs.current.get(shownRoomId);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    }
  }, [shownRoomId, reducedMotion]);

  // ── Il regista: eventi, condizioni, modello ─────────────────────────────

  // Cresce a ogni evento: i tavoli «in arrivo» degli accompagnamenti si
  // ridisegnano allora (ogni loro cambio arriva con un evento), mai per
  // fotogramma.
  const [directorRev, setDirectorRev] = useState(0);
  const [stripItems, setStripItems] = useState<StripItem[]>([]);
  const stripIdRef = useRef(0);

  // Gli effetti del regista sono di layout, in quest'ordine: chi ascolta gli
  // eventi, le condizioni, il modello. Il canvas disegna al fotogramma dopo,
  // e un effetto passivo non è garantito prima di lui: una comitiva appena
  // arrivata comparirebbe seduta al tavolo per un fotogramma, prima di
  // entrare dalla porta.
  useLayoutEffect(() => director.onEvent(event => {
    setDirectorRev(n => n + 1);
    // A scheda nascosta (gli aggiornamenti arrivano lo stesso, già conclusi)
    // i 90 s della riga non partono: partono quando la si può leggere.
    const until = document.visibilityState === 'hidden' ? Infinity : performance.now() + STRIP_TTL_MS;
    const items = stripItemsOf(event, () => ++stripIdRef.current, until);
    if (items.length > 0) setStripItems(prev => addStripItems(prev, items));
    if (event.kind === 'escort-end' && !event.seated) {
      const { partyId } = event;
      setStripItems(prev => withoutEscort(prev, partyId));
    }
    followController.onEvent(event);
  }), [director, followController]);

  // Le righe che il modello nuovo smentisce se ne vanno: un annullamento non
  // sempre manda un evento («Arrivato» tolto dopo che si erano seduti, «Tavolo
  // liberato» tolto mentre uscivano).
  const partyStates = model?.partyStates;
  useEffect(() => {
    if (partyStates) setStripItems(prev => stillTrue(prev, partyStates));
  }, [partyStates]);

  useLayoutEffect(() => {
    director.configure({ reducedMotion, slowMode: webgl === 'slow', pinned, activeRoomId: shownRoomId });
  }, [director, reducedMotion, webgl, pinned, shownRoomId]);

  // Senza vista 3D non girano fotogrammi: quello che era a metà arriva in
  // fondo subito, o non finirebbe mai (e la ricarica automatica di uno
  // schermo fissato lo aspetterebbe per sempre).
  const canvasWasOnRef = useRef(canvasOn);
  useLayoutEffect(() => {
    if (canvasWasOnRef.current && !canvasOn) director.fastForward();
    canvasWasOnRef.current = canvasOn;
  }, [director, canvasOn]);

  // Il modello nuovo al regista, una volta per commit: qualunque arrivi
  // prima fra l'eco del socket e la risposta HTTP, il confronto è uno. Va
  // dritto allo stato finale, senza camminare, quando non c'è ancora una
  // base (il primo caricamento: chi è seduto è già seduto), quando App ha
  // appena ricaricato tutto (l'epoca: tre arrivi segnati mentre il tablet era
  // senza rete non entrano insieme dalla porta), quando nessuno lo vede
  // (scheda nascosta, niente vista 3D) e col movimento ridotto. Un arrivo
  // vero dopo un buco del Wi-Fi arriva da un evento socket, senza epoca
  // nuova, e si anima.
  const lastEpochRef = useRef<number | null>(null);
  const lastReadsRef = useRef<number | null>(null);
  const settledKey = settled?.key ?? null;
  const settledReads = settled?.reads ?? 0;
  useLayoutEffect(() => {
    if (!model || loading) return;
    // Alle 17:00 (e alle 05:00) il servizio cambia prima che arrivino le sue
    // unioni, e per un attimo la sala si disegna con quelle di prima. Il
    // regista quel modello non lo vede: azzererebbe su una sala sbagliata, e
    // poi metterebbe in scena come cose successe (un cambio di tavolo, un
    // accompagnamento) le unioni giuste quando arrivano. Aspetta il primo
    // modello con le varianti del servizio nuovo, e quello azzera.
    if (settledKey !== service.key) return;
    const hiddenNow = document.visibilityState === 'hidden' || !canvasOn;
    const reason: SnapReason | null =
      lastEpochRef.current === null ? 'initial'
      // Una ricarica di App (l'epoca) o una rilettura delle varianti (alla
      // riconnessione): cambi successi mentre lo schermo non li vedeva.
      : reservationsEpoch !== lastEpochRef.current || settledReads !== lastReadsRef.current ? 'refetch'
      : hiddenNow ? 'hidden'
      : reducedMotion ? 'reduced-motion'
      : null;
    lastEpochRef.current = reservationsEpoch;
    lastReadsRef.current = settledReads;
    director.update(model, reason);
  }, [director, model, loading, reservationsEpoch, reducedMotion, canvasOn, settledKey, settledReads, service.key]);

  // A scheda nascosta i fotogrammi si fermano: l'hostess resterebbe a metà
  // strada. Tornando visibile tutto quello che era in corso arriva in fondo,
  // e le righe arrivate intanto cominciano i loro 90 s.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      director.fastForward();
      const until = performance.now() + STRIP_TTL_MS;
      setStripItems(prev => revealStripItems(prev, until));
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [director]);

  // Ogni riga della striscia resta 90 s: un timer solo, sulla prima che
  // scade. Quelle ancora da leggere (scheda nascosta) non scadono.
  useEffect(() => {
    const first = Math.min(...stripItems.map(item => item.until));
    if (!Number.isFinite(first)) return;
    const timer = window.setTimeout(() => {
      // Un decimo di secondo di margine: un timer che scatta un attimo prima
      // non deve lasciare la riga a video per un altro giro.
      const cutoff = performance.now() + 100;
      setStripItems(prev => prev.filter(item => item.until > cutoff));
    }, Math.max(0, first - performance.now()));
    return () => window.clearTimeout(timer);
  }, [stripItems]);

  // La sala data al canvas: i tavoli verso cui l'hostess sta accompagnando
  // qualcuno restano «in arrivo» con l'anello finché l'ultimo non si siede,
  // anche se Reception ha già premuto «Arrivato». directorRev fra le
  // dipendenze: gli obiettivi del regista cambiano solo con un evento.
  const displayRoom = useMemo(
    () => (shownRoom ? withEscortTargets(shownRoom, director.escortTargets(shownRoom.id)) : null),
    [shownRoom, director, directorRev],
  );

  // L'etichetta che segue la comitiva accompagnata, per prenotazione:
  // «Tavolo 40 · 4 (2 bambini) + cane», o col nome della comitiva, che il
  // modello dà solo a nomi accesi. Il canvas la riceve già tradotta.
  const partyTags = useMemo(() => {
    const tags = new Map<number, string>();
    if (!shownRoom || !i18nReady) return tags;
    const tableNames = new Map(shownRoom.tables.map(table => [table.id, table.name]));
    for (const party of shownRoom.parties) {
      const tableName = party.tableId === null ? undefined : tableNames.get(party.tableId);
      if (tableName === undefined) continue;
      tags.set(party.id, t('strip.party', {
        name: party.name ?? t('strip.anonymous', { table: tableName }),
        people: peopleText(t, party),
      }));
    }
    return tags;
  }, [shownRoom, t, i18nReady]);

  const stripLines = useMemo<ActivityLine[]>(
    () => (i18nReady ? stripItems.map(item => stripLine(item, showNames, t)) : []),
    [stripItems, showNames, t, i18nReady],
  );

  // A schermo fissato nessuno preme «Ricarica» sul banner della versione: a
  // ogni minuto, se il sito pubblicato è più nuovo, la pagina si ricarica da
  // sola. Una volta per versione (salaVivo.reloadedFor): se il deploy viene
  // ritirato e il sito resta indietro, il tablet non ricarica in loop.
  const { currentVersion, remoteVersion, reload } = useAppVersion();
  useEffect(() => {
    if (!pinned || !remoteVersion || remoteVersion === currentVersion) return;
    if (remoteVersion === 'dev' || currentVersion === 'dev') return;
    if (readStorage(RELOADED_FOR_KEY) === remoteVersion) return;
    // Mai a metà di un accompagnamento: la ricarica lo taglierebbe sotto gli
    // occhi di chi entra. Si riguarda al minuto dopo (nowMs).
    if (director.isAnimating()) return;
    // Senza la traccia salvata un ritiro del deploy farebbe ricaricare in
    // loop: meglio restare sulla versione vecchia.
    if (!writeStorage(RELOADED_FOR_KEY, remoteVersion)) return;
    reload();
  }, [pinned, remoteVersion, currentVersion, reload, nowMs, director]);

  // ── Avvisi ──────────────────────────────────────────────────────────────
  const canEditHere = canEditFloor && !pinned;
  const callouts: PageCallout[] = [];
  // Senza WebGL2 il palco resta vuoto: l'avviso dice perché, anche a schermo
  // fissato.
  if (webgl === 'none') callouts.push({ id: 'noWebgl', tone: 'critical', icon: MonitorOff, text: t('noWebgl') });
  // Gli avvisi sulla sala solo a chi la può sistemare, come quello delle
  // sovrapposizioni in Sale & Tavoli, e mai a schermo fissato: lo legge chi
  // aspetta all'ingresso. Della sala a video, anche quando l'ha portata lì
  // «Segui il servizio».
  if (canEditHere && shownRoom) {
    const { audit } = shownRoom;
    const roomId = shownRoom.id;
    const openRoom = () => onOpenFloorPlan({ roomId });
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

  // Il dizionario della pagina arriva a richiesta: prima, le chiavi grezze.
  if (!i18nReady) return <Loader label={null} className="h-full" />;

  // La riga c'è anche prima dei numeri (uno spazio unificatore): quando
  // arrivano la testata non cresce e la sala sotto non salta. Chi aspetta
  // all'ingresso entra nel riassunto solo se c'è: «0 all'ingresso» per tutto
  // il servizio sarebbe rumore.
  let summaryText = '\u00A0';
  if (model && !loading) {
    const { seated, arriving, lobby } = model.summary;
    summaryText = t('summary', { seated, arriving });
    if (lobby > 0) summaryText += ` · ${t('summaryLobby', { count: lobby })}`;
  }

  return (
    <div className={pinned ? ROOT_PINNED : ROOT}>
      {/* Sul telefono due righe: titolo e riassunto sopra, a tutta
          larghezza, i bottoni sotto (decisione di Tina, 4 ottobre). Accanto
          ai bottoni il titolo finiva in «Sala dal v…» e il riassunto perdeva
          «in arrivo» e «all'ingresso». Da sm in su una riga sola. */}
      <div className="flex-shrink-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-[22px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)] sm:text-[26px]">
              {t('title')}
            </h1>
            <p className="mt-0.5 truncate text-[15px] tabular-nums text-[var(--ds-text-secondary)]">
              {summaryText}
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
              {/* «Segui il servizio», un interruttore come i nomi, accanto a
                  «Centra» perché anche lui decide che cosa si inquadra. Resta
                  a schermo fissato, dove è acceso di default: non mostra
                  niente di privato, ed è il modo di fermare il giro delle
                  sale su una TV. */}
              {canvasOn && (
                <button
                  type="button"
                  onClick={toggleFollow}
                  aria-pressed={followOn}
                  className={followOn ? ICON_BUTTON_ON : dsIconButton}
                  title={followOn ? t('unfollow') : t('follow')}
                  aria-label={t('follow')}
                >
                  <Footprints className="h-5 w-5" aria-hidden />
                </button>
              )}
              {/* «Nomi degli ospiti», un interruttore come la puntina: il nome
                  resta quello e lo stato lo dice aria-pressed; acceso, il title
                  dice come spegnerlo. Solo con la sala in 3D, come «Centra»: i
                  nomi stanno sulle etichette dei tavoli. A schermo fissato non
                  c'è (decisione di Tina, 4 ottobre): chi passa davanti allo
                  schermo dell'ingresso non deve poter accendere i nomi. Resta
                  quello che era impostato prima di fissare; per cambiarlo si
                  sblocca. */}
              {canvasOn && !pinned && (
                <button
                  type="button"
                  onClick={toggleNames}
                  aria-pressed={showNames}
                  className={showNames ? ICON_BUTTON_ON : dsIconButton}
                  title={showNames ? t('hideNames') : t('showNames')}
                  aria-label={t('showNames')}
                >
                  <Tag className="h-5 w-5" aria-hidden />
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
            <LivePill connected={isConnected} time={currentTime} timeZone={sessionTimeZone()} routes={linkRoutes} routesClassName="max-lg:hidden" className="max-md:hidden" />
            <LivePill connected={isConnected} time={currentTime} variant="dot" className="mx-1 md:hidden" />
          </div>
        </div>
      </div>

      {loading ? (
        <Loader className="min-h-0 flex-1" />
      ) : visibleRooms.length === 0 || shownRoom === null ? (
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
                // Premuta la sala a video: quella scelta, o quella dove
                // «Segui il servizio» ha portato lo schermo.
                const active = room.id === shownRoom.id;
                const closedLabel = !room.closed
                  ? null
                  : closedIndefinitely.has(room.id)
                    ? t('roomClosedIndefinitely', { room: room.name })
                    : t('roomClosed', { room: room.name });
                return (
                  <button
                    key={room.id}
                    ref={el => {
                      if (el) tabRefs.current.set(room.id, el);
                      else tabRefs.current.delete(room.id);
                    }}
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
            {/* La sala per chi non la vede: i numeri della sala a video, in
                un'immagine vuota ACCANTO al canvas. Un role="img" toglie allo
                screen reader tutto quello che contiene: il «Preparo la vista
                3D…» del caricamento, il velo e i loro bottoni stanno fuori. Il
                canvas, che non ha niente da leggere, è aria-hidden. Chi
                aspetta all'ingresso, come nel riassunto, solo se c'è. */}
            <div
              role="img"
              aria-label={shownRoom.summary.lobby > 0
                ? t('stageLabelLobby', {
                    room: shownRoom.name,
                    seated: shownRoom.summary.seated,
                    arriving: shownRoom.summary.arriving,
                    lobby: shownRoom.summary.lobby,
                  })
                : t('stageLabel', { room: shownRoom.name, seated: shownRoom.summary.seated, arriving: shownRoom.summary.arriving })}
              className="sr-only"
            />
            {canvasOn && (
              <div className={follow.dipped ? STAGE_DIPPED : STAGE_SHOWN}>
                <SceneBoundary key={canvasKey} onCrash={handleContextLost}>
                  <React.Suspense fallback={<Loader label={t('loading3d')} className="h-full" />}>
                    <SalaVivoCanvas
                      room={displayRoom ?? shownRoom}
                      director={director}
                      partyTags={partyTags}
                      onUserCamera={followController.pause}
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
            {shownRoom.tables.length === 0 && !contextLost && (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
                <div className="pointer-events-auto flex items-center gap-3 rounded-[var(--ds-radius)] bg-[var(--ds-surface)] px-4 py-3 shadow-[var(--ds-shadow-card)]">
                  <p className="text-[14px] text-[var(--ds-text-muted)]">{t('noTables')}</p>
                  {canEditHere && (
                    <button type="button" onClick={() => onOpenFloorPlan({ roomId: shownRoom.id })} className={dsButton.quiet}>
                      {t('openFloorPlan')}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Le ultime cose successe, in basso a sinistra sopra la sala:
                solo con la vista 3D, che è dove si vedono succedere. Senza,
                ogni cambio arriva già concluso e la striscia direbbe soltanto
                «1 tavolo aggiornato». */}
            {canvasOn && <ActivityStrip lines={stripLines} label={t('strip.title')} />}
          </div>
        </>
      )}
    </div>
  );
};

export default SalaVivoPage;
