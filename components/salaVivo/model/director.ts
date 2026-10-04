import type {
  ActorKind,
  ActorTag,
  ActorView,
  DirectorEvent,
  DirectorOptions,
  DirectorSettings,
  DirectorTuning,
  FigureSlot,
  FrameNeed,
  PartyModel,
  PartyPhase,
  PartyRef,
  PartyState,
  RoomModel,
  SceneDirectorApi,
  SceneModel,
  SnapReason,
  StaffOnShift,
  TableModel,
  TableRef,
  Vec2,
} from '../types';
import {
  advancePhase,
  appendTrack,
  easeWalk,
  isAhead,
  makeTrack,
  pointAt,
  turnToward,
  wrapAngle,
  type Track,
  type TrackPoint,
} from './motion';
import {
  AGENT_R,
  CELL,
  DOOR_OUTSIDE,
  PERSON_R,
  buildNavGrid,
  cellAt,
  findPath,
  isFree,
  lineOfSight,
  navKey,
  nearestFree,
  passSlots,
  roomAnchors,
  tableSidePoint,
  type NavGrid,
  type RoomAnchors,
  type Spot,
} from './navGrid';
import { approachPoint, hostSpot } from './placement';
import { partyRng, staffRng, uniform } from './rng';
import { allocateWaiters, hostessName, pickVisit, splitStaff, type VisitCandidate, type WaiterState } from './waiters';

/* Il regista della Sala dal vivo: come si passa da un modello al successivo.
 *
 * Il modello statico (sceneModel.ts) dice DOVE sta ognuno adesso, ed è la
 * fonte unica: le figure, i numeri delle linguette e le fasi delle comitive
 * (partyStates) nascono dalla stessa presenza. Il regista non decide mai dove
 * sta qualcuno: confronta le fasi dell'ultimo update con quelle nuove e mette
 * in scena il passaggio. L'hostess va alla porta e accompagna la famiglia al
 * tavolo, chi è «In uscita» si alza, chi se ne va esce dalla porta, chi
 * cambia tavolo ci cammina. Alla fine ognuno è ESATTAMENTE sulla sua figura
 * statica (stessa chiave, stessa posa), e People lo riprende senza un salto.
 *
 * Chi disegna chi: People disegna room.figures meno movingKeys(room.id), il
 * canvas disegna actorsIn(room.id). Una chiave passa al regista quando si
 * muove e torna a People solo quando l'attore coincide con la sua figura.
 *
 * Puro e deterministico: l'orologio (`now`) serve solo a datare gli eventi e
 * a misurare la finestra dei cambi in blocco; le animazioni corrono sul tempo
 * del regista (la somma dei dt di step), e il caso viene da mulberry32 col
 * seme della comitiva o del cameriere. Stessi update e stessi passi, stesse
 * posizioni: su ogni schermo del ristorante, e nei test.
 *
 * Il frame non alloca: step riscrive sul posto attori, viste e punti di
 * appoggio. Si alloca solo quando si pianifica (un percorso, un piano di
 * passi), cioè a un update o quando qualcuno parte. */

/** I numeri del regista (vedi DirectorTuning). */
export const DIRECTOR_TUNING: DirectorTuning = Object.freeze({
  guestSpeed: 1.1,
  hostessSpeed: 1.3,
  escortSpeed: 1.0,
  catchUpSpeed: 1.5,
  waiterSpeed: 1.3,
  sitMs: 600,
  standMs: 500,
  stepMs: 500,
  turnMs: 250,
  lieMs: 600,
  fadeMs: 400,
  greetMs: 800,
  presentMs: 1200,
  bulkK: 4,
  bulkWindowMs: 2000,
  queueFastAbove: 3,
  queueSnapAbove: 6,
  escortMaxParty: 12,
  largeStaggerMs: 80,
  spawnStaggerMs: 250,
  peelStaggerMs: 150,
  leaveStaggerMs: 250,
  gapAdult: 0.8,
  gapKid: 0.7,
  dogBeside: 0.45,
  yieldDistance: 0.45,
  yieldMaxMs: 1500,
  maxStepMs: 100,
  yawRate: 7,
  // Una falcata è un ciclo intero, due passi: con le gambe a ±28° (0,85 m
  // dall'anca alla caviglia) un passo è 0,8 m, il ciclo 1,6. A 0,7 m le
  // gambe giravano a tre passi al secondo e i piedi scivolavano di più del
  // doppio; a 1,4 e 0,9 (i bambini, a 0,62) il passo torna quello di chi
  // cammina, con un niente di scivolata.
  strideAdult: 1.4,
  strideKid: 0.9,
  strideDog: 0.4,
  waiterIdleMinMs: 2000,
  waiterIdleMaxMs: 6000,
  waiterIdlePinnedMinMs: 8000,
  waiterIdlePinnedMaxMs: 20000,
  serveMinMs: 3000,
  serveMaxMs: 8000,
  passPauseMs: 1000,
  walkingWaitersMax: 8,
  headGapRect: 0.45,
  headGapCircle: 0.5,
  serviceGap: 0.5,
});

/** Le condizioni di partenza: niente movimento ridotto, niente personale
 *  ancora letto. */
export const DIRECTOR_DEFAULTS: DirectorSettings = Object.freeze({
  reducedMotion: false,
  slowMode: false,
  lightMode: false,
  pinned: false,
  activeRoomId: null,
  staff: undefined,
});

/** Il seme della pagina («SALA»): uguale su ogni schermo del ristorante, così
 *  il tablet all'ingresso e la TV in sala mettono in scena la stessa
 *  coreografia. */
export const DIRECTOR_SEED = 0x53414c41;

/** La macchina a stati dell'hostess di una sala. */
export type HostessState = 'AT_STAND' | 'TO_ENTRANCE' | 'TO_LOBBY' | 'GREET' | 'ESCORT' | 'PRESENT' | 'RETURN';

/** Il passaggio che una comitiva sta recitando. */
export type PartyScript = 'ESCORT' | 'LOBBY' | 'RESEAT' | 'STAND' | 'SIT' | 'LEAVE' | 'FADE' | 'FADE_IN' | 'LARGE';

/** Lo stato di una sala, solo per i test (inspect alloca). */
export interface DirectorRoomInspection {
  hostess: {
    state: HostessState;
    x: number;
    z: number;
    speedFactor: number;
    partyId: number | null;
    path: readonly Vec2[] | null;
    /** Dove accoglie l'accompagnamento che ha in mano (null senza). */
    greet: Vec2 | null;
  };
  /** Gli accompagnamenti in coda, dal più vecchio (quello in corso escluso). */
  queue: readonly number[];
  /** L'accompagnamento in corso. */
  current: number | null;
  /** comitiva → passaggio in corso, per le comitive con attori o un
   *  accompagnamento in questa sala. */
  scripts: ReadonlyMap<number, PartyScript>;
  waiters: ReadonlyArray<{ key: string; state: WaiterState; partyId: number | null; label: string | null; x: number; z: number }>;
}

/** La sala da disegnare: i tavoli verso cui c'è un accompagnamento restano
 *  «in arrivo» con l'anello. La stessa sala (stesso oggetto) quando nessun
 *  suo tavolo è in `targets`: il canvas non rifà niente. */
export function withEscortTargets(room: RoomModel, targets: ReadonlySet<number>): RoomModel {
  if (!room || !targets || targets.size === 0 || !Array.isArray(room.tables)) return room;
  if (!room.tables.some(t => !!t && targets.has(t.id))) return room;
  return {
    ...room,
    tables: room.tables.map(t => (t && targets.has(t.id) ? { ...t, status: 'inarrivo', pulse: true } : t)),
  };
}

/* ── Costanti interne ─────────────────────────────────────────────────── */

// La rete di sicurezza: un passaggio o un accompagnamento più vecchio di così
// (tempo del regista) va dritto in fondo. Senza, un attore incastrato
// terrebbe isAnimating() vero per sempre, e uno schermo fissato non si
// ricaricherebbe più.
const SAFETY_MS = 90_000;
// L'hostess alla porta aspetta il primo della fila al più tanto: un membro
// che non arriva (un percorso impossibile) non deve fermare l'accoglienza.
const GREET_WAIT_MAX_MS = 4000;
// L'etichetta della comitiva sta sopra la testa di un adulto (1,7 m) più il
// suo mezzo pannello.
const TAG_Y = 2.05;
// L'hostess che va a prendere chi aspetta all'ingresso si ferma così oltre
// il loro centro, verso la sala: davanti a loro, non in mezzo.
const LOBBY_GREET_IN = 0.9;
// Chi arriva dalla porta l'hostess lo accoglie SULLA strada della fila,
// tanto oltre `inside`, rivolta alla porta. Prima stava accanto alla soglia,
// dalla parte del leggio, e la fila ci andava e poi tornava indietro verso un
// tavolo dall'altra parte: un tornante, la famiglia che si incrociava sulla
// soglia e il cane dentro l'hostess.
const GREET_ALONG = 0.6;
// L'accoglienza: la prima parte rivolta a chi arriva, il braccio giù (il
// saluto); poi verso la strada col braccio che sale, «prego, da questa
// parte». Teso verso chi arriva, a 0,8 m d'arco, gli finiva sulla testa.
const GREET_LOOK = 0.45;
// All'inizio di PRESENT l'etichetta della comitiva svanisce in tanto, ferma
// dov'era, mentre torna il nome dell'hostess (Walkers li incrocia): spenta di
// colpo, nel momento in cui si guarda, saltava.
const TAG_FADE_MS = 400;
// L'hostess resta a presentare finché chi è sceso dalla fila non è arrivato
// al suo posto, al più tanto oltre presentMs: tornando subito ripassava in
// mezzo alla sua comitiva ancora in cammino verso le sedie.
const PRESENT_WAIT_MAX_MS = 5000;
// La coda invisibile dietro la porta: 12 m bastano a 12 persone e 2 cani.
const TRAIL_BACK = 12;
// Ogni comitiva cammina un po' più svelta o più lenta (±5 %), sempre uguale:
// una sala dove tutti vanno alla stessa velocità sembra una sfilata.
const SPEED_JITTER = 0.05;
// Le comitive già sedute quando il regista le vede per la prima volta (uno
// scatto) contano come visitate da poco, ognuna in un momento diverso degli
// ultimi due minuti: i camerieri non partono tutti verso lo stesso tavolo.
const LAST_VISIT_SPREAD_MS = 120_000;
// Il cane cammina accanto al padrone solo se tutti e due vanno lontano: chi
// si alza dietro la sedia («In uscita») si alza e basta, il cane anche.
const FOLLOW_MIN = 0.3;
// Il braccio dell'hostess sale e scende così (al secondo): niente scatti.
const ARM_RATE = 5;
// Il lato del padrone su cui cammina il cane gira al più così (rad/s): a
// una svolta secca (la porta, una curva della strada) il posto accanto a lui
// non salta dall'altra parte in un attimo, e il cane non trotta di traverso.
const DOG_SIDE_TURN = 2.5;
// Più lontano di così dal suo posto accanto al padrone il cane lo rincorre
// guardando dove va; più vicino guarda dove guarda il padrone, e le piccole
// correzioni non lo girano di lato.
const DOG_CHASE = 0.25;
// Il cane non cambia mai lato mentre segue il padrone: per passare
// dall'altra parte attraversava lui (puntando dritto al posto opposto) o chi
// gli cammina dietro in fila (girandogli intorno). Se il suo posto di lato è
// occupato (una sedia, l'hostess) scivola indietro sullo stesso lato, in
// diagonale, e ci torna quando si libera: il posto gira attorno al padrone
// al più così (rad/s).
const DOG_SWAP_TURN = 3;
// Un posto accanto al padrone è buono se lì non c'è un mobile e nessun altro
// (l'hostess, un cameriere, un'altra comitiva) più vicino di così: all'
// accoglienza il cane finiva dentro l'hostess, marrone su marrone.
const DOG_CLEAR = 0.45;
// Dai suoi (il padrone, chi è in fila): il corpo di una persona e il suo.
const DOG_KEEP_OWN = 0.32;
const EPS = 1e-9;
// Quanti posti al pass si preparano per sala, prima di servirne di più: i
// camerieri in giro per sala sono al più 8.
const PASS_SPOTS = 9;
// L'hostess ferma (al leggio, mentre accoglie, mentre presenta il tavolo) è
// un ostacolo per chi cerca una strada, come chi aspetta in piedi: chi
// scendeva dalla fila verso la sua sedia le passava a 36 cm, dentro il suo
// braccio teso.
const HOSTESS_BLOCK_R = PERSON_R + AGENT_R;

// Dove sta un membro rispetto alla fila dell'accompagnamento.
const COL_HIDDEN = 0; // non ancora comparso
const COL_WAIT = 1; //   all'ingresso, aspetta il suo turno
const COL_STEER = 2; //  va verso il suo punto della fila
const COL_TRAIL = 3; //  sulla fila, a un arco

const NO_VIEWS: readonly ActorView[] = Object.freeze([]) as readonly ActorView[];
const NO_KEYS: ReadonlySet<string> = new Set<string>();
const NO_TABLES: ReadonlySet<number> = new Set<number>();
// Un punto d'appoggio per i calcoli del frame: mai trattenuto.
const SCRATCH: TrackPoint = { x: 0, z: 0, heading: 0, seg: 0 };

/* ── I piani: una sequenza di passi, pianificata una volta ─────────────── */

type Seg =
  | { k: 'wait'; ms: number }
  | { k: 'fade'; to: number; ms: number }
  | { k: 'rise'; ms: number }
  | { k: 'sit'; ms: number; h: number }
  | { k: 'step'; x: number; z: number; ms: number; face: boolean }
  | { k: 'turn'; yaw: number; ms: number }
  | { k: 'walk'; x: number; z: number; speed: number; path: Vec2[] | null; out: boolean }
  | { k: 'portal'; dir: 1 | -1; speed: number }
  | { k: 'place'; roomId: number; x: number; z: number; yaw: number; fade: number; seat: number; h: number }
  | { k: 'show' }
  | { k: 'hide' }
  | { k: 'follow'; speed: number; job: boolean }
  | { k: 'column' }
  | { k: 'mark' }
  | { k: 'goSlot'; speed: number; scale: number; delay: number }
  | { k: 'goOut'; speed: number; delay: number }
  | { k: 'gate'; dir: 1 | -1 }
  | { k: 'release' }
  | { k: 'remove' };

const sWait = (ms: number): Seg => ({ k: 'wait', ms });
const sFade = (to: number, ms: number): Seg => ({ k: 'fade', to, ms });
const sRise = (ms: number): Seg => ({ k: 'rise', ms });
const sSit = (ms: number, h: number): Seg => ({ k: 'sit', ms, h });
const sStep = (x: number, z: number, ms: number, face: boolean): Seg => ({ k: 'step', x, z, ms, face });
const sTurn = (yaw: number, ms: number): Seg => ({ k: 'turn', yaw, ms });
const sWalk = (x: number, z: number, speed: number, path: Vec2[] | null = null, out = false): Seg =>
  ({ k: 'walk', x, z, speed, path, out });
const sPortal = (dir: 1 | -1, speed: number): Seg => ({ k: 'portal', dir, speed });
const sPlace = (roomId: number, x: number, z: number, yaw: number, fade: number, seat: number, h: number): Seg =>
  ({ k: 'place', roomId, x, z, yaw, fade, seat, h });
const S_SHOW: Seg = { k: 'show' };
const S_HIDE: Seg = { k: 'hide' };
const S_COLUMN: Seg = { k: 'column' };
const S_MARK: Seg = { k: 'mark' };
const S_RELEASE: Seg = { k: 'release' };
const S_REMOVE: Seg = { k: 'remove' };
const sFollow = (speed: number, job: boolean): Seg => ({ k: 'follow', speed, job });
const sGoSlot = (speed: number, scale: number, delay: number): Seg => ({ k: 'goSlot', speed, scale, delay });
const sGoOut = (speed: number, delay: number): Seg => ({ k: 'goOut', speed, delay });
// La porta a senso unico: chi esce aspetta in piedi che la fila dell'hostess
// sia arrivata al tavolo (dir −1); chi entra aspetta, ancora invisibile
// dietro la porta, che chi esce sia uscito (dir +1).
const S_GATE_OUT: Seg = { k: 'gate', dir: -1 };
const S_GATE_IN: Seg = { k: 'gate', dir: 1 };

/* ── Lo stato interno ──────────────────────────────────────────────────── */

interface Actor {
  /** Quello che la scena legge: riscritto sul posto, mai sostituito. */
  readonly view: ActorView;
  roomId: number;
  /** In actorsIn. Un attore nascosto tiene comunque la sua chiave (People
   *  non la disegna): la famiglia in coda per l'accompagnamento non si vede
   *  né al tavolo né alla porta. */
  visible: boolean;
  dead: boolean;
  party: PartyRt | null;
  /** L'ordine della figura nella comitiva (persone alternate, poi cani). */
  order: number;
  isDog: boolean;
  isPerson: boolean;
  stride: number;
  plan: Seg[];
  pi: number;
  /** ms passati nel passo corrente. */
  t: number;
  started: boolean;
  replanned: boolean;
  sx: number;
  sz: number;
  syaw: number;
  ex: number;
  ez: number;
  track: Track | null;
  path: Vec2[] | null;
  s: number;
  s1: number;
  readonly pt: TrackPoint;
  /** Si è mosso in questo passo (o nel precedente, per chi viene dopo): solo
   *  chi cammina fa fermare gli altri. */
  moving: boolean;
  yieldWait: number;
  yieldImmune: number;
  /** Il padrone, per il cane che gli cammina accanto. */
  owner: Actor | null;
  /** Sta camminando verso la porta per uscire: in fila coi suoi (blocks). */
  outbound: boolean;
  /** Il padrone è arrivato al suo punto d'approccio: il cane va al suo. */
  arrived: boolean;
  /** Il cane: il lato del padrone dove cammina (−1 destra, +1 sinistra), il
   *  punto del mezzo cerchio dietro di lui dove sta adesso (da −1 destra a 0
   *  dietro a +1 sinistra), e per quale padrone valgono. */
  side: number;
  sideU: number;
  sideOwner: Actor | null;
  /** La figura statica verso cui va (e la sua sala, che può non essere
   *  ancora quella dove sta: chi cambia sala svanisce prima nella vecchia):
   *  ci torna a People solo se coincide. */
  slot: FigureSlot | null;
  slotRoom: number;
  job: Job | null;
  col: number;
  colMode: number;
  colS: number;
  peeled: boolean;
}

interface PartyRt {
  id: number;
  /** La comitiva com'era all'ultimo update che la conteneva: l'ordine delle
   *  figure (adulti e bambini alternati) e gli eventi. */
  ref: PartyRef;
  rng: () => number;
  /** Il fattore di velocità della comitiva, stabile. */
  jitter: number;
  script: PartyScript | null;
  /** Quando è cominciato il passaggio corrente (tempo del regista). */
  since: number;
  /** I suoi attori vivi e morti di questo passo, nell'ordine delle figure. */
  actors: Actor[];
  job: Job | null;
  /** Per i camerieri: quante visite, quando si è seduta, l'ultima visita. */
  visits: number;
  seatedAt: number;
  lastVisitAt: number;
}

interface Job {
  party: PartyRt;
  roomId: number;
  tableId: number;
  from: 'entrance' | 'lobby';
  /** La fila parte dall'ingresso (chi aspetta lì), non dalla porta. */
  lobby: boolean;
  /** queued → current (l'hostess ci lavora) → peel (dopo PRESENT: i membri
   *  vanno alle sedie). */
  phase: 'queued' | 'current' | 'peel';
  createdAt: number;
  /** Quando l'hostess l'ha preso (−1 in coda): la rete di sicurezza conta da
   *  qui per un accompagnamento in corso. Contando dall'arrivo in coda, una
   *  famiglia rimasta dietro altre cinque (o dietro un'uscita, la porta a
   *  senso unico) verrebbe tagliata a metà strada. */
  startedAt: number;
  f: number;
  trail: Track | null;
  trailEnd: number;
  greetArc: number;
  insideArc: number;
  /** L'arco di chi guida la fila: l'hostess, o la fine del binario dopo
   *  PRESENT. */
  lead: number;
  greet: Spot | null;
  head: Spot | null;
  /** Il centro di chi aspetta all'ingresso, per una fila che parte da lì. */
  centroid: Vec2 | null;
  presentAt: number;
  /** Dove stava l'etichetta all'inizio di PRESENT, e la sua opacità: da lì
   *  svanisce (TAG_FADE_MS). */
  tagX: number;
  tagZ: number;
  tagAlpha: number;
  persons: Actor[];
  dogs: Actor[];
}

interface Hostess {
  actor: Actor;
  state: HostessState;
  job: Job | null;
  path: Vec2[] | null;
  s: number;
  timer: number;
  waited: number;
  f: number;
  /** Il centro del tavolo che presenta: resta anche se l'accompagnamento è
   *  già finito mentre lei presenta. */
  faceX: number;
  faceZ: number;
}

interface Waiter {
  actor: Actor;
  key: string;
  rng: () => number;
  state: WaiterState;
  timer: number;
  nextIdle: number;
  partyId: number | null;
  tableId: number | null;
  slot: number;
  wantRoom: number | null;
  wantSlot: number;
  leaving: boolean;
  order: number;
}

interface RoomRt {
  id: number;
  model: RoomModel;
  navKey: string;
  grid: NavGrid;
  anchors: RoomAnchors;
  /** La normale della porta, verso la sala. */
  nx: number;
  nz: number;
  hostSlot: Spot;
  /** I posti dei camerieri al pass (passSlots), per la griglia `passKey`. */
  passSpots: Spot[];
  passKey: string;
  figByKey: Map<string, FigureSlot>;
  figsByParty: Map<number, FigureSlot[]>;
  tables: Map<number, TableModel>;
  hostess: Hostess;
  queue: Job[];
  active: Job[];
  views: ActorView[];
  viewsRev: number;
  moving: Set<string>;
  movingRev: number;
  targets: Set<number>;
  targetsRev: number;
  tag: ActorTag;
  candCount: number;
}

interface PartyMemo {
  state: PartyState;
  ref: PartyRef;
  table: TableRef | null;
  /** Le sue figure nella sua sala (al tavolo o all'ingresso), in ordine. */
  slots: FigureSlot[];
  large: boolean;
}

interface Transition {
  id: number;
  prev: PartyMemo | undefined;
  next: PartyMemo | undefined;
  row: number;
  counts: boolean;
  noop: boolean;
}

interface RetargetOpts {
  arrive: 'door' | 'fade';
  depart: 'leave' | 'fade';
  stagger: number;
  large: boolean;
  script: PartyScript;
}

type SnapMode = SnapReason | 'bulk';

/* ── Aiuti puri ───────────────────────────────────────────────────────── */

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const PHASES: readonly PartyPhase[] = ['waiting', 'lobby', 'seated', 'standing', 'hidden'];

type Phase = PartyPhase | 'absent';

const phaseOf = (m: PartyMemo | undefined): Phase => (m ? m.state.phase : 'absent');
const atTable = (p: Phase): boolean => p === 'seated' || p === 'standing';
const onFloor = (p: Phase): boolean => p === 'seated' || p === 'standing' || p === 'lobby';

// Seduto (persona) o sdraiato (cane) = 1, in piedi = 0.
const seatOf = (f: FigureSlot): number => (f.pose === 'seated' || f.pose === 'lying' ? 1 : 0);

const slotEqual = (a: FigureSlot | null | undefined, b: FigureSlot | null | undefined): boolean =>
  !!a && !!b && a.x === b.x && a.z === b.z && a.yaw === b.yaw && a.pose === b.pose && a.seatHeight === b.seatHeight;

const sameSlots = (a: readonly FigureSlot[], b: readonly FigureSlot[]): boolean =>
  a.length === b.length && a.every((f, i) => f.key === b[i].key && slotEqual(f, b[i]));

const KEY_RE = /^r(-?\d+):([akd])(\d+)$/;

// L'ordine di una chiave nella comitiva, quello di interleave e poi i cani:
// adulto n → n + min(n, bambini); bambino n → n + min(n, adulti) + (n <
// adulti); cane n → persone + n.
const figureOrder = (key: string, ref: PartyRef): number => {
  const m = KEY_RE.exec(key);
  if (!m) return 1e6;
  const n = Number(m[3]);
  const adults = Math.max(0, Math.floor(finite(ref.adults, 0)));
  const kids = Math.max(0, Math.floor(finite(ref.kids, 0)));
  if (m[2] === 'a') return n + Math.min(n, kids);
  if (m[2] === 'k') return n + Math.min(n, adults) + (n < adults ? 1 : 0);
  return adults + kids + n;
};

const isDogKey = (key: string): boolean => /:d\d+$/.test(key);

// Il padrone del cane k, con la regola di placement: l'adulto k, se no il
// primo adulto, se no la prima persona.
const ownerKeyOf = (dogKey: string, ref: PartyRef): string | null => {
  const m = KEY_RE.exec(dogKey);
  if (!m) return null;
  const k = Number(m[3]);
  const adults = Math.max(0, Math.floor(finite(ref.adults, 0)));
  const kids = Math.max(0, Math.floor(finite(ref.kids, 0)));
  if (k < adults) return `r${m[1]}:a${k}`;
  if (adults > 0) return `r${m[1]}:a0`;
  if (kids > 0) return `r${m[1]}:k0`;
  return null;
};

// Le fasi lette in difesa, copiate: il chiamante può riusare i suoi oggetti.
function readStates(raw: unknown): PartyState[] {
  if (!Array.isArray(raw)) return [];
  const out: PartyState[] = [];
  const seen = new Set<number>();
  for (const s of raw as unknown[]) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Partial<PartyState>;
    if (typeof r.id !== 'number' || !Number.isFinite(r.id) || seen.has(r.id)) continue;
    if (!PHASES.includes(r.phase as PartyPhase)) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      phase: r.phase as PartyPhase,
      roomId: typeof r.roomId === 'number' ? r.roomId : null,
      tableId: typeof r.tableId === 'number' ? r.tableId : null,
      people: Math.max(1, Math.floor(finite(r.people, 1))),
      banquet: r.banquet === true,
    });
  }
  return out;
}

const refOf = (p: PartyModel): PartyRef => ({
  id: p.id,
  name: typeof p.name === 'string' ? p.name : null,
  adults: Math.max(0, Math.floor(finite(p.adults, 0))),
  kids: Math.max(0, Math.floor(finite(p.kids, 0))),
  dogs: Math.max(0, Math.floor(finite(p.dogs, 0))),
});

/* ── Il regista ───────────────────────────────────────────────────────── */

export class SceneDirector implements SceneDirectorApi {
  private readonly clock: () => number;
  private readonly seed: number;
  private readonly T: DirectorTuning;
  private settings: DirectorSettings = { ...DIRECTOR_DEFAULTS };
  private rev = 0;
  private simT = 0;
  private model: SceneModel | null = null;
  private serviceKey: string | null = null;
  private mainRoomId: number | null = null;
  private memo: Map<number, PartyMemo> | null = null;
  private readonly rooms = new Map<number, RoomRt>();
  private roomList: RoomRt[] = [];
  private readonly parties = new Map<number, PartyRt>();
  private partyOrder: PartyRt[] = [];
  private readonly actors: Actor[] = [];
  private readonly owned = new Map<string, Actor>();
  private waiters: Waiter[] = [];
  private bulkLog: Array<{ at: number; count: number }> = [];
  private readonly listeners = new Set<(event: DirectorEvent) => void>();
  // Le celle chiuse per un attimo attorno all'hostess (pathAround): riusato.
  private readonly blockScratch: number[] = [];
  private readonly subscribers = new Set<() => void>();
  private candDirty = true;

  constructor(options: DirectorOptions) {
    // Niente effetti qui (StrictMode costruisce due volte): solo numeri.
    this.clock = typeof options?.now === 'function' ? options.now : () => 0;
    this.seed = finite(options?.seed, DIRECTOR_SEED) >>> 0;
    const tuning: DirectorTuning = { ...DIRECTOR_TUNING };
    const patch = options?.tuning;
    if (patch && typeof patch === 'object') {
      for (const key of Object.keys(DIRECTOR_TUNING) as Array<keyof DirectorTuning>) {
        const v = patch[key];
        if (typeof v === 'number' && Number.isFinite(v) && v >= 0) tuning[key] = v;
      }
    }
    this.T = tuning;
  }

  get revision(): number {
    return this.rev;
  }

  /* ── API: lettura ────────────────────────────────────────────────── */

  actorsIn(roomId: number): readonly ActorView[] {
    const room = this.rooms.get(roomId);
    if (!room) return NO_VIEWS;
    if (room.viewsRev !== this.rev) {
      room.viewsRev = this.rev;
      const out = room.views;
      out.length = 0;
      out.push(room.hostess.actor.view);
      for (const p of this.partyOrder) {
        for (const a of p.actors) if (!a.dead && a.visible && a.roomId === roomId) out.push(a.view);
      }
      for (const w of this.waiters) if (!w.actor.dead && w.actor.visible && w.actor.roomId === roomId) out.push(w.actor.view);
    }
    return room.views;
  }

  movingKeys(roomId: number): ReadonlySet<string> {
    const room = this.rooms.get(roomId);
    if (!room) return NO_KEYS;
    if (room.movingRev !== this.rev) {
      room.movingRev = this.rev;
      const set = room.moving;
      set.clear();
      set.add(room.hostess.actor.view.key);
      const figs = Array.isArray(room.model.figures) ? room.model.figures : [];
      for (const f of figs) if (f && this.owned.has(f.key)) set.add(f.key);
      // Anche chi il regista tiene in QUESTA sala e non sta più fra le sue
      // figure: chi esce, chi svanisce per un «Arrivato» annullato, chi passa
      // a un'altra sala. Il canvas fa il commit dopo la pagina: per un frame
      // People può riscrivere dalla sua lista vecchia, dove quelle chiavi ci
      // sono ancora, e le disegnerebbe ferme ai loro posti mentre il regista
      // le fa camminare (due volte la stessa persona). Una chiave in più qui
      // non costa niente a People: salta solo quelle che ha.
      for (let i = 0; i < this.actors.length; i++) {
        const a = this.actors[i];
        if (!a.dead && a.roomId === roomId && this.owned.get(a.view.key) === a) set.add(a.view.key);
      }
    }
    return room.moving;
  }

  tagIn(roomId: number): ActorTag | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const h = room.hostess;
    const job = h.job;
    if (!job) return null;
    const tag = room.tag;
    if (h.state === 'PRESENT' && job.presentAt >= 0) {
      // Svanisce dov'era, mentre il nome dell'hostess torna.
      const left = 1 - (this.simT - job.presentAt) / TAG_FADE_MS;
      if (left <= 0 || job.tagAlpha <= 0) return null;
      tag.partyId = job.party.id;
      tag.x = job.tagX;
      tag.y = TAG_Y;
      tag.z = job.tagZ;
      tag.alpha = job.tagAlpha * left;
      return tag;
    }
    if (job.phase !== 'current') return null;
    if (h.state !== 'TO_ENTRANCE' && h.state !== 'TO_LOBBY' && h.state !== 'GREET' && h.state !== 'ESCORT') return null;
    const lead = this.tagLead(job, roomId);
    if (!lead) return null;
    tag.partyId = job.party.id;
    tag.x = lead.view.x;
    tag.y = TAG_Y;
    tag.z = lead.view.z;
    tag.alpha = lead.view.fade;
    return tag;
  }

  // Chi porta l'etichetta: il primo della fila ancora in fila, se si vede in
  // questa sala.
  private tagLead(job: Job, roomId: number): Actor | null {
    for (let i = 0; i < job.persons.length; i++) {
      const a = job.persons[i];
      if (!a.dead && !a.peeled) return a.visible && a.roomId === roomId ? a : null;
    }
    return null;
  }

  escortTargets(roomId: number): ReadonlySet<number> {
    const room = this.rooms.get(roomId);
    if (!room) return NO_TABLES;
    if (room.targetsRev !== this.rev) {
      room.targetsRev = this.rev;
      room.targets.clear();
      for (const j of room.queue) room.targets.add(j.tableId);
      for (const j of room.active) room.targets.add(j.tableId);
    }
    return room.targets;
  }

  isAnimating(): boolean {
    for (let i = 0; i < this.roomList.length; i++) {
      const room = this.roomList[i];
      if (room.queue.length > 0 || room.active.length > 0 || room.hostess.state !== 'AT_STAND') return true;
    }
    for (let i = 0; i < this.actors.length; i++) if (!this.actors[i].dead) return true;
    return false;
  }

  frameNeed(): FrameNeed {
    if (this.isAnimating()) return 'active';
    const rid = this.settings.activeRoomId;
    if (rid === null || this.waiterStill()) return 'none';
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.actor.dead || w.actor.roomId !== rid) continue;
      if (w.state === 'TO_TABLE' || w.state === 'TO_PASS' || w.state === 'FADE_IN' || w.state === 'FADE_OUT') return 'ambient';
      if (w.actor.view.walk > 0) return 'ambient';
    }
    return 'none';
  }

  wakeInMs(): number | null {
    const rid = this.settings.activeRoomId;
    if (rid === null || this.waiterStill() || this.waiters.length === 0) return null;
    const room = this.rooms.get(rid);
    if (!room) return null;
    if (this.candDirty) this.refreshCandidates();
    const canGo = this.canDepart(room);
    let best = Infinity;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.actor.dead || w.actor.roomId !== rid) continue;
      if (w.state === 'AT_PASS') {
        if (w.leaving || w.wantRoom !== null) best = 0;
        else if (canGo) best = Math.min(best, Math.max(0, w.timer));
      } else if (w.state === 'SERVE') {
        best = Math.min(best, Math.max(0, w.timer));
      } else if (w.state === 'PAUSE') {
        if (w.leaving || w.wantRoom !== null) best = Math.min(best, Math.max(0, w.timer));
        else if (canGo) best = Math.min(best, Math.max(0, w.timer) + Math.max(0, w.nextIdle));
      }
    }
    return best === Infinity ? null : best;
  }

  onEvent(cb: (event: DirectorEvent) => void): () => void {
    if (typeof cb !== 'function') return () => {};
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  subscribe(cb: () => void): () => void {
    if (typeof cb !== 'function') return () => {};
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /** Solo per i test: lo stato di una sala (alloca: mai nel frame). */
  inspect(roomId: number): DirectorRoomInspection | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const h = room.hostess;
    const scripts = new Map<number, PartyScript>();
    for (const p of this.partyOrder) {
      const here = p.actors.some(a => !a.dead && a.roomId === roomId) || (p.job !== null && p.job.roomId === roomId);
      if (here && p.script) scripts.set(p.id, p.script);
    }
    return {
      hostess: {
        state: h.state,
        x: h.actor.view.x,
        z: h.actor.view.z,
        speedFactor: h.f,
        partyId: h.job ? h.job.party.id : null,
        path: h.path ? h.path.map(p => ({ x: p.x, z: p.z })) : null,
        greet: h.job && h.job.greet ? { x: h.job.greet.x, z: h.job.greet.z } : null,
      },
      queue: room.queue.map(j => j.party.id),
      current: h.job ? h.job.party.id : null,
      scripts,
      waiters: this.waiters
        .filter(w => !w.actor.dead && w.actor.roomId === roomId)
        .map(w => ({
          key: w.key,
          state: w.state,
          partyId: w.partyId,
          label: w.actor.view.label,
          x: w.actor.view.x,
          z: w.actor.view.z,
        })),
    };
  }

  /* ── API: comandi ────────────────────────────────────────────────── */

  update(model: SceneModel, reason: SnapReason | null): void {
    if (!model || typeof model !== 'object') return;
    const key = typeof model.service?.key === 'string' ? model.service.key : '';
    const states = readStates(model.partyStates);
    this.model = model;
    this.mainRoomId = typeof model.mainRoomId === 'number' ? model.mainRoomId : null;
    const vanished = this.indexRooms(model);
    const next = this.buildMemo(model, states);
    // Il movimento ridotto vale anche se la pagina dimentica il motivo: qui
    // nessuno deve camminare, mai.
    const r: SnapReason | null = reason ?? (this.settings.reducedMotion ? 'reduced-motion' : null);
    if (this.memo === null || r === 'initial' || key !== this.serviceKey) {
      this.reset(key, next);
    } else {
      this.diff(next, r);
    }
    for (const room of vanished) this.dropRoom(room);
    this.refreshLabels();
    this.syncWaiters(false);
    this.candDirty = true;
    this.revalidateWaiters();
    this.prune();
    this.dirty();
    this.notify();
  }

  step(dtMs: number): void {
    const raw = typeof dtMs === 'number' && Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0;
    // Da fermi passa il tempo vero (le pause dei camerieri lo contano), ma
    // solo fino alla prossima partenza più un passo: è fin lì che il canvas
    // dorme (wakeInMs). Un sonno più lungo del previsto, la scheda nascosta
    // (il primo frame al ritorno porta tutto il tempo passato, e fastForward
    // ha appena dato a ognuno la sua pausa nuova), farebbe scadere insieme le
    // pause di tutti, e partirebbero dal pass nello stesso frame. Se qualcosa
    // si muove, al più maxStepMs: dopo un frame perso nessuno salta.
    let dt: number;
    if (this.frameNeed() === 'none') {
      const wake = this.wakeInMs();
      dt = wake === null ? raw : Math.min(raw, wake + this.T.maxStepMs);
    } else {
      dt = Math.min(raw, this.T.maxStepMs);
    }
    const dtMove = Math.min(dt, this.T.maxStepMs);
    this.simT += dt;
    if (this.model === null) return;
    const rooms = this.roomList;
    for (let r = 0; r < rooms.length; r++) this.stepHostess(rooms[r], dtMove);
    for (let r = 0; r < rooms.length; r++) {
      const room = rooms[r];
      for (let i = 0; i < room.active.length; i++) this.stepColumn(room, room.active[i], dtMove);
    }
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.dead) this.stepActor(a, dtMove);
    }
    this.finishJobs();
    this.safetyNet();
    this.stepWaiters(dt, dtMove);
    this.compact();
  }

  fastForward(): void {
    this.completeAll();
    this.dirty();
    this.notify();
  }

  configure(patch: Partial<DirectorSettings>): void {
    if (!patch || typeof patch !== 'object') return;
    const s = this.settings;
    const before = { ...s };
    if (typeof patch.reducedMotion === 'boolean') s.reducedMotion = patch.reducedMotion;
    if (typeof patch.slowMode === 'boolean') s.slowMode = patch.slowMode;
    if (typeof patch.lightMode === 'boolean') s.lightMode = patch.lightMode;
    if (typeof patch.pinned === 'boolean') s.pinned = patch.pinned;
    if ('activeRoomId' in patch && (typeof patch.activeRoomId === 'number' || patch.activeRoomId === null)) {
      s.activeRoomId = patch.activeRoomId;
    }
    let staffChanged = false;
    if ('staff' in patch) {
      const v = patch.staff;
      const next = v === undefined || v === null ? v : Array.isArray(v) ? v : before.staff;
      staffChanged = !sameStaff(before.staff, next);
      if (staffChanged) s.staff = next === undefined || next === null ? next : next.map(copyStaff);
    }
    const stillBefore = before.reducedMotion || before.slowMode;
    const stillNow = s.reducedMotion || s.slowMode;
    const changed = staffChanged
      || before.reducedMotion !== s.reducedMotion
      || before.slowMode !== s.slowMode
      || before.lightMode !== s.lightMode
      || before.pinned !== s.pinned
      || before.activeRoomId !== s.activeRoomId;
    if (!changed) return;
    if (s.reducedMotion && !before.reducedMotion) this.completeAll();
    if (this.model !== null) {
      if (staffChanged) this.refreshLabels();
      if (staffChanged || before.lightMode !== s.lightMode || stillBefore !== stillNow || before.activeRoomId !== s.activeRoomId) {
        this.syncWaiters(false);
      }
      // Fuori dal movimento ridotto i camerieri ripartono con una pausa
      // nuova ciascuno: con tutti a zero partirebbero insieme.
      if (stillBefore && !stillNow) {
        for (const w of this.waiters) if (w.state === 'AT_PASS') w.timer = this.idleFor(w);
      }
    }
    this.dirty();
    this.notify();
  }

  /* ── update: indici, memo, confronto ─────────────────────────────── */

  private indexRooms(model: SceneModel): RoomRt[] {
    const list = Array.isArray(model.rooms) ? model.rooms : [];
    const seen = new Set<number>();
    const order: RoomRt[] = [];
    for (const rm of list) {
      if (!rm || typeof rm.id !== 'number' || seen.has(rm.id)) continue;
      seen.add(rm.id);
      const key = navKey(rm);
      let room = this.rooms.get(rm.id);
      if (!room) {
        room = this.createRoom(rm, key);
        this.rooms.set(rm.id, room);
      } else if (key !== room.navKey) {
        // La geometria è cambiata: griglia e punti nuovi. Chi cammina rifà il
        // percorso al prossimo punto in cui ne chiede uno.
        room.grid = buildNavGrid(rm);
        room.anchors = roomAnchors(rm, room.grid);
        room.navKey = key;
        room.nx = Math.sin(room.anchors.door.yaw);
        room.nz = Math.cos(room.anchors.door.yaw);
      }
      room.model = rm;
      room.figByKey = new Map();
      room.figsByParty = new Map();
      for (const f of Array.isArray(rm.figures) ? rm.figures : []) {
        if (!f || typeof f.key !== 'string' || room.figByKey.has(f.key)) continue;
        room.figByKey.set(f.key, f);
        if (typeof f.partyId === 'number') {
          const own = room.figsByParty.get(f.partyId);
          if (own) own.push(f);
          else room.figsByParty.set(f.partyId, [f]);
        }
      }
      room.tables = new Map();
      for (const t of Array.isArray(rm.tables) ? rm.tables : []) if (t && !room.tables.has(t.id)) room.tables.set(t.id, t);
      const slot = this.hostSlotOf(rm, room.figByKey);
      if (slot.x !== room.hostSlot.x || slot.z !== room.hostSlot.z || slot.yaw !== room.hostSlot.yaw) {
        room.hostSlot = slot;
        // Il leggio spostato in Sale & Tavoli: l'hostess ferma ci va.
        const h = room.hostess;
        if (h.state === 'AT_STAND') {
          if (this.settings.reducedMotion) this.hostessHome(room);
          else this.hostessReturn(room);
        }
      }
      order.push(room);
    }
    const vanished = this.roomList.filter(r => !seen.has(r.id));
    this.roomList = order;
    return vanished;
  }

  private hostSlotOf(rm: RoomModel, figs: Map<string, FigureSlot>): Spot {
    const f = figs.get(`host:${rm.id}`);
    if (f) return { x: f.x, z: f.z, yaw: f.yaw };
    const host = rm.markers?.HOST_STAND;
    if (!host) return { x: 0, z: 0, yaw: 0 };
    return hostSpot(host, rm.markers?.ENTRANCE ?? null, rm.floor);
  }

  private createRoom(rm: RoomModel, key: string): RoomRt {
    const grid = buildNavGrid(rm);
    const anchors = roomAnchors(rm, grid);
    const figs = new Map<string, FigureSlot>();
    for (const f of Array.isArray(rm.figures) ? rm.figures : []) if (f && typeof f.key === 'string') figs.set(f.key, f);
    const slot = this.hostSlotOf(rm, figs);
    const actor = this.makeActor(`host:${rm.id}`, 'hostess', null, rm.id, slot.x, slot.z, slot.yaw, 0, 0, 0);
    actor.visible = true;
    return {
      id: rm.id,
      model: rm,
      navKey: key,
      grid,
      anchors,
      nx: Math.sin(anchors.door.yaw),
      nz: Math.cos(anchors.door.yaw),
      hostSlot: slot,
      passSpots: [],
      passKey: '',
      figByKey: figs,
      figsByParty: new Map(),
      tables: new Map(),
      hostess: { actor, state: 'AT_STAND', job: null, path: null, s: 0, timer: 0, waited: 0, f: 1, faceX: 0, faceZ: 0 },
      queue: [],
      active: [],
      views: [],
      viewsRev: -1,
      moving: new Set(),
      movingRev: -1,
      targets: new Set(),
      targetsRev: -1,
      tag: { partyId: 0, x: 0, y: 0, z: 0, alpha: 0 },
      candCount: 0,
    };
  }

  private buildMemo(model: SceneModel, states: PartyState[]): Map<number, PartyMemo> {
    const models = new Map<number, PartyModel>();
    for (const rm of Array.isArray(model.rooms) ? model.rooms : []) {
      for (const p of Array.isArray(rm?.parties) ? rm.parties : []) if (p && !models.has(p.id)) models.set(p.id, p);
    }
    const out = new Map<number, PartyMemo>();
    for (const s of states) {
      const old = this.memo?.get(s.id);
      const pm = models.get(s.id);
      const ref: PartyRef = pm
        ? refOf(pm)
        : old?.ref ?? { id: s.id, name: null, adults: s.people, kids: 0, dogs: 0 };
      let table: TableRef | null = null;
      let slots: FigureSlot[] = [];
      const room = s.roomId !== null ? this.rooms.get(s.roomId) : undefined;
      if (room && atTable(s.phase) && s.tableId !== null) {
        const t = room.tables.get(s.tableId);
        if (t) table = { id: t.id, name: String(t.name ?? '') };
        slots = room.figsByParty.get(s.id) ?? [];
      } else if (room && s.phase === 'lobby') {
        slots = room.figsByParty.get(s.id) ?? [];
      }
      out.set(s.id, {
        state: s,
        ref,
        table,
        slots,
        large: s.people > this.T.escortMaxParty || s.banquet,
      });
    }
    return out;
  }

  private reset(key: string, next: Map<number, PartyMemo>): void {
    for (const a of this.actors) this.kill(a);
    this.actors.length = 0;
    this.owned.clear();
    this.parties.clear();
    this.partyOrder = [];
    for (const room of this.roomList) {
      room.queue.length = 0;
      room.active.length = 0;
      this.hostessHome(room);
    }
    this.serviceKey = key;
    this.memo = next;
    this.bulkLog = [];
    // I camerieri rinascono al pass col loro seme da capo: dopo il cambio di
    // servizio ogni schermo riparte dalla stessa coreografia.
    for (const w of this.waiters) w.actor.dead = true;
    this.waiters = [];
    for (const m of next.values()) {
      const p = this.ensureParty(m.state.id, m.ref);
      // Chi è già a tavola quando il regista la vede la prima volta conta come
      // visitato (dev. 15): «prima i tavoli appena seduti» vale per chi si è
      // visto arrivare.
      if (atTable(m.state.phase)) this.markSnapped(p);
    }
    this.syncWaiters(true);
  }

  private diff(next: Map<number, PartyMemo>, r: SnapReason | null): void {
    const prev = this.memo ?? new Map<number, PartyMemo>();
    const trs = this.classify(prev, next);
    let count = 0;
    for (const tr of trs) if (tr.counts) count++;
    const now = this.now();
    const windowSum = this.windowSum(now);
    const bulk = r === null && count > 0 && (count > this.T.bulkK || count + windowSum > this.T.bulkK);
    const mode: SnapMode | null = r !== null ? r : bulk ? 'bulk' : null;
    for (const tr of trs) {
      if (tr.row === 16) continue;
      if (tr.row === 17 || tr.noop) {
        this.reconcile(tr);
        continue;
      }
      if (mode === null) this.animate(tr);
      else this.snap(tr, mode);
    }
    this.memo = next;
    if (mode === null) {
      if (count > 0) this.bulkLog.push({ at: now, count });
    } else if (mode !== 'reduced-motion' && count > 0) {
      // La striscia dice «N tavoli aggiornati»: si contano i tavoli toccati,
      // non i passaggi. Chi lascia un tavolo e chi ci arriva al suo posto
      // sono un tavolo solo; chi aspetta all'ingresso non ne tocca nessuno
      // (e allora niente riga: «1 tavolo aggiornato» sarebbe falso).
      const tables = tablesTouched(trs);
      if (tables > 0) this.emit({ kind: 'bulk', at: now, count: tables });
    }
    this.queueOverflow();
    // L'ordine delle comitive per actorsIn: quello del modello, poi chi
    // esce e non c'è più.
    const order: PartyRt[] = [];
    const seen = new Set<number>();
    for (const id of next.keys()) {
      const p = this.parties.get(id);
      if (p) {
        order.push(p);
        seen.add(id);
      }
    }
    for (const p of this.partyOrder) if (!seen.has(p.id) && this.parties.has(p.id)) order.push(p);
    for (const p of this.parties.values()) if (!seen.has(p.id) && !order.includes(p)) order.push(p);
    this.partyOrder = order;
  }

  private classify(prev: Map<number, PartyMemo>, next: Map<number, PartyMemo>): Transition[] {
    const out: Transition[] = [];
    const seen = new Set<number>();
    const make = (id: number, pm: PartyMemo | undefined, nm: PartyMemo | undefined): Transition => {
      const row = rowOf(pm, nm);
      let counts = row !== 16 && row !== 17;
      let noop = false;
      if (row === 7 && pm && nm) {
        // Le celle dell'ingresso che si rifanno quando chi è davanti se ne va
        // non contano per la regola dei cambi in blocco.
        counts = pm.state.roomId !== nm.state.roomId;
        noop = !counts && sameSlots(pm.slots, nm.slots);
      }
      return { id, prev: pm, next: nm, row, counts, noop };
    };
    // Prima chi sparisce, nell'ordine di prima: la striscia racconta l'uscita
    // della famiglia vecchia prima dell'arrivo di quella nuova.
    for (const [id, pm] of prev) {
      const nm = next.get(id);
      if (onFloor(phaseOf(pm)) && !onFloor(phaseOf(nm))) {
        out.push(make(id, pm, nm));
        seen.add(id);
      }
    }
    for (const [id, nm] of next) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(make(id, prev.get(id), nm));
    }
    for (const [id, pm] of prev) if (!seen.has(id)) out.push(make(id, pm, undefined));
    return out;
  }

  private windowSum(now: number): number {
    const from = now - this.T.bulkWindowMs;
    this.bulkLog = this.bulkLog.filter(e => e.at >= from && e.at <= now);
    let sum = 0;
    for (const e of this.bulkLog) sum += e.count;
    return sum;
  }

  /* ── I passaggi animati (§5.4) ───────────────────────────────────── */

  private animate(tr: Transition): void {
    const p = this.ensureParty(tr.id, (tr.next ?? tr.prev)?.ref);
    const { prev, next, row } = tr;
    if (p.job) {
      this.jobInFlight(p, tr);
      return;
    }
    const T = this.T;
    const live = this.hasVisible(p);
    switch (row) {
      case 1:
      case 3: {
        if (live || row === 3) {
          // Un'uscita o una dissolvenza annullate (o una comitiva spodestata
          // che torna): chi è ancora in sala torna al suo posto, chi era già
          // uscito rientra dalla porta. Nessun accompagnamento, nessun
          // evento: è la stessa comitiva che non se n'era mai andata.
          this.retarget(p, prev, next, {
            arrive: live ? 'door' : 'fade',
            depart: 'fade',
            stagger: live ? T.peelStaggerMs : 0,
            large: false,
            script: live ? 'RESEAT' : 'FADE_IN',
          });
          return;
        }
        if (next!.large) {
          this.arriveLarge(p, prev, next!);
          return;
        }
        this.createJob(p, prev, next!, false, 'entrance');
        this.emitEscortStart(next!, 'entrance');
        return;
      }
      case 2:
      case 4: {
        const large = next!.large;
        this.retarget(p, prev, next, {
          arrive: live ? 'door' : row === 4 || large ? 'fade' : 'door',
          depart: 'fade',
          stagger: row === 4 ? 0 : large ? T.largeStaggerMs : T.spawnStaggerMs,
          large: false,
          script: row === 4 ? 'FADE_IN' : 'LOBBY',
        });
        if (row === 2 && !live) this.emit({ kind: 'lobby', at: this.now(), roomId: next!.state.roomId!, party: next!.ref });
        return;
      }
      case 5:
      case 6: {
        if (next!.large) {
          this.arriveLarge(p, prev, next!);
          return;
        }
        this.createJob(p, prev, next!, row === 5, 'lobby');
        this.emitEscortStart(next!, 'lobby');
        return;
      }
      case 7:
        this.retarget(p, prev, next, { arrive: 'door', depart: 'fade', stagger: T.spawnStaggerMs, large: false, script: 'LOBBY' });
        return;
      case 8:
      case 14:
        this.retarget(p, prev, next, { arrive: 'fade', depart: 'fade', stagger: 0, large: false, script: 'FADE' });
        return;
      case 9:
      case 10:
        this.retarget(p, prev, next, { arrive: 'fade', depart: 'fade', stagger: 0, large: false, script: row === 9 ? 'STAND' : 'SIT' });
        return;
      case 11:
      case 12: {
        const large = next!.large;
        this.retarget(p, prev, next, {
          arrive: 'door',
          depart: 'fade',
          stagger: large ? T.largeStaggerMs : row === 11 ? T.peelStaggerMs : T.spawnStaggerMs,
          large,
          script: large ? 'LARGE' : 'RESEAT',
        });
        this.emit({
          kind: 'moved',
          at: this.now(),
          roomId: next!.state.roomId!,
          party: next!.ref,
          from: prev!.table ?? { id: prev!.state.tableId ?? 0, name: '' },
          to: next!.table ?? { id: next!.state.tableId ?? 0, name: '' },
        });
        return;
      }
      case 13: {
        const large = prev!.large;
        this.retarget(p, prev, next, {
          arrive: 'fade',
          depart: 'leave',
          stagger: large ? T.largeStaggerMs : T.leaveStaggerMs,
          large,
          script: large ? 'LARGE' : 'LEAVE',
        });
        this.emit({
          kind: 'leaving',
          at: this.now(),
          roomId: prev!.state.roomId!,
          party: prev!.ref,
          table: prev!.table ?? { id: prev!.state.tableId ?? 0, name: '' },
        });
        return;
      }
      case 15:
        this.retarget(p, prev, next, { arrive: 'door', depart: 'fade', stagger: T.spawnStaggerMs, large: false, script: 'LOBBY' });
        this.emit({ kind: 'lobby', at: this.now(), roomId: next!.state.roomId!, party: next!.ref });
        return;
      default:
        return;
    }
  }

  // Una comitiva che ha già un accompagnamento (in coda o in corso) e cambia
  // ancora: il nuovo stato finale sostituisce il vecchio, da dove sono gli
  // attori.
  private jobInFlight(p: PartyRt, tr: Transition): void {
    const job = p.job!;
    const { prev, next } = tr;
    const nPh = phaseOf(next);
    if (atTable(nPh) && next) {
      if (next.state.roomId === job.roomId) {
        if (next.state.tableId === job.tableId) {
          this.reconcile(tr);
          return;
        }
        const from = this.tableRefIn(job.roomId, job.tableId, prev?.table ?? null);
        this.retargetJob(job, next, prev);
        this.emit({ kind: 'moved', at: this.now(), roomId: job.roomId, party: next.ref, from, to: next.table ?? { id: next.state.tableId ?? 0, name: '' } });
        return;
      }
      // Il tavolo è in un'altra sala: qui finisce, là si mette in coda
      // dalla porta.
      this.cancelJob(job, false);
      this.emitEscortEnd(job, false);
      this.createJob(p, prev, next, false, 'entrance');
      this.emitEscortStart(next, 'entrance');
      return;
    }
    this.cancelJob(job, false);
    this.emitEscortEnd(job, false);
    if (nPh === 'lobby' && next) {
      this.retarget(p, prev, next, { arrive: 'door', depart: 'fade', stagger: this.T.spawnStaggerMs, large: false, script: 'LOBBY' });
      this.emit({ kind: 'lobby', at: this.now(), roomId: next.state.roomId!, party: next.ref });
      return;
    }
    // «Arrivato» annullato, spodestata, eliminata: svaniscono dove sono.
    this.retarget(p, prev, next, { arrive: 'fade', depart: 'fade', stagger: 0, large: false, script: 'FADE' });
  }

  private tableRefIn(roomId: number, tableId: number, fallback: TableRef | null): TableRef {
    const t = this.rooms.get(roomId)?.tables.get(tableId);
    if (t) return { id: t.id, name: String(t.name ?? '') };
    return fallback ?? { id: tableId, name: '' };
  }

  // Le comitive grandi (oltre 12, o di un banchetto) non camminano: compaiono
  // sedute una persona ogni 80 ms.
  private arriveLarge(p: PartyRt, prev: PartyMemo | undefined, next: PartyMemo): void {
    this.retarget(p, prev, next, { arrive: 'fade', depart: 'fade', stagger: this.T.largeStaggerMs, large: true, script: 'LARGE' });
    p.visits = 0;
    p.seatedAt = this.simT;
    p.lastVisitAt = this.simT;
    const table = next.table ?? { id: next.state.tableId ?? 0, name: '' };
    this.emit({ kind: 'snapped', at: this.now(), roomId: next.state.roomId!, reason: 'large', parties: [{ party: next.ref, table }] });
  }

  /* ── Scatti (lo stato finale, subito) ────────────────────────────── */

  private snap(tr: Transition, mode: SnapMode): void {
    const p = this.ensureParty(tr.id, (tr.next ?? tr.prev)?.ref);
    const { next, row } = tr;
    // Per un motivo della pagina l'hostess torna al leggio di colpo (nessuno
    // guarda, o nessuno deve camminare); con la regola dei cambi in blocco
    // lo schermo è guardato e lei ci torna a piedi.
    const instant = mode !== 'bulk';
    if (p.job) {
      const job = p.job;
      const seated = !!next && atTable(next.state.phase) && next.state.roomId === job.roomId && next.state.tableId === job.tableId;
      this.cancelJob(job, instant);
      this.emitEscortEnd(job, seated);
    }
    for (const a of p.actors) this.kill(a);
    p.script = null;
    if (mode === 'reduced-motion') this.emitAsAnimated(tr);
    const arrival = row === 1 || row === 5 || row === 6;
    if (arrival) {
      if (mode === 'reduced-motion') {
        p.visits = 0;
        p.seatedAt = this.simT;
        p.lastVisitAt = this.simT;
      } else {
        this.markSnapped(p);
      }
    }
  }

  // Gli eventi di un passaggio come se si fosse animato: col movimento ridotto
  // la striscia e «Segui il servizio» li vogliono lo stesso.
  private emitAsAnimated(tr: Transition): void {
    const { prev, next, row } = tr;
    const at = this.now();
    if ((row === 1 || row === 5 || row === 6) && next) {
      const table = next.table ?? { id: next.state.tableId ?? 0, name: '' };
      if (next.large) {
        this.emit({ kind: 'snapped', at, roomId: next.state.roomId!, reason: 'large', parties: [{ party: next.ref, table }] });
        return;
      }
      this.emit({ kind: 'escort-start', at, roomId: next.state.roomId!, party: next.ref, table, from: row === 1 ? 'entrance' : 'lobby' });
      this.emit({ kind: 'escort-end', at, roomId: next.state.roomId!, partyId: next.state.id, tableId: table.id, seated: true });
      return;
    }
    if ((row === 2 || row === 15) && next) {
      this.emit({ kind: 'lobby', at, roomId: next.state.roomId!, party: next.ref });
      return;
    }
    if ((row === 11 || row === 12) && prev && next) {
      this.emit({
        kind: 'moved',
        at,
        roomId: next.state.roomId!,
        party: next.ref,
        from: prev.table ?? { id: prev.state.tableId ?? 0, name: '' },
        to: next.table ?? { id: next.state.tableId ?? 0, name: '' },
      });
      return;
    }
    if (row === 13 && prev) {
      this.emit({ kind: 'leaving', at, roomId: prev.state.roomId!, party: prev.ref, table: prev.table ?? { id: prev.state.tableId ?? 0, name: '' } });
    }
  }

  private markSnapped(p: PartyRt): void {
    p.visits = 1;
    p.seatedAt = this.simT;
    p.lastVisitAt = this.simT - uniform(p.rng, 0, LAST_VISIT_SPREAD_MS);
  }

  /* ── Ritocchi senza passaggio: la geometria (§5.2 punto 6) ───────── */

  private reconcile(tr: Transition): void {
    const p = this.parties.get(tr.id);
    if (!p) return;
    const ref = (tr.next ?? tr.prev)?.ref;
    if (ref) p.ref = ref;
    const owns = p.job !== null || this.hasLive(p);
    // Non in mano al regista: People disegna le figure nuove.
    if (!owns) return;
    // L'orologio della rete di sicurezza riparte solo se qui si rifà davvero
    // un piano. Questo ritocco passa a ogni update, e la pagina ne fa almeno
    // uno al minuto (l'orologio di App): rimesso a ogni giro, un passaggio
    // incastrato non arriverebbe mai ai 90 s, e isAnimating() resterebbe vero
    // per sempre (niente ricarica dello schermo fissato).
    const next = tr.next;
    const roomId = next?.state.roomId ?? null;
    for (const a of p.actors) {
      // Chi è ancora in fila (o nascosto in coda) legge il suo posto quando
      // scende: non c'è niente da rifare. `slot` c'è solo per chi ha già il
      // punto d'arrivo nel piano.
      if (a.dead || !a.visible || !a.slot || (a.job !== null && !a.peeled)) continue;
      const room = this.rooms.get(a.slotRoom);
      const latest = room?.figByKey.get(a.view.key);
      if (!latest || latest.partyId !== p.id) {
        // La chiave non c'è più (una persona in meno): svanisce dov'è.
        this.setPlan(a, [sFade(0, this.T.fadeMs), S_REMOVE]);
        p.since = this.simT;
      } else if (!slotEqual(latest, a.slot)) {
        if (a.roomId === a.slotRoom) {
          this.setPlan(a, [...this.comeBack(a), sGoSlot(this.guestSpeed(p, a), 1, 0)]);
        } else {
          // Ancora nella sala vecchia (svanisce per cambiare sala): ricompare
          // al posto nuovo.
          this.setPlan(a, this.largeMove(latest, a.slotRoom, 0));
          this.aim(a, latest, a.slotRoom);
        }
        p.since = this.simT;
      }
    }
    // Una persona in più a metà passaggio compare al suo posto finale.
    if (roomId === null || !this.rooms.has(roomId) || !next) return;
    const was = new Set((tr.prev?.slots ?? []).map(f => f.key));
    for (const f of next.slots) {
      if (this.owned.has(f.key) || was.has(f.key)) continue;
      const a = this.newActor(p, f.key, f, roomId);
      a.view.fade = 0;
      this.setPlan(a, [S_SHOW, sFade(1, this.T.fadeMs), S_RELEASE]);
      this.aim(a, f, roomId);
      p.since = this.simT;
    }
  }

  /* ── Il passaggio generico: ogni membro dal suo stato al suo posto ── */

  private retarget(p: PartyRt, prev: PartyMemo | undefined, next: PartyMemo | undefined, o: RetargetOpts): void {
    const T = this.T;
    const endPhase = phaseOf(next);
    const endRoomId = next && onFloor(endPhase) ? next.state.roomId : null;
    const endRoom = endRoomId !== null ? this.rooms.get(endRoomId) ?? null : null;
    const ends = new Map<string, FigureSlot>();
    if (endRoom && next) for (const f of next.slots) ends.set(f.key, f);
    const prevRoomId = prev && onFloor(phaseOf(prev)) ? prev.state.roomId : null;
    const prevRoom = prevRoomId !== null ? this.rooms.get(prevRoomId) ?? null : null;
    const was = new Map<string, FigureSlot>();
    if (prevRoom && prev) for (const f of prev.slots) was.set(f.key, f);
    const ref = next?.ref ?? prev?.ref ?? { id: p.id, name: null, adults: 1, kids: 0, dogs: 0 };

    const keys = new Set<string>();
    for (const a of p.actors) if (!a.dead) keys.add(a.view.key);
    for (const k of was.keys()) keys.add(k);
    for (const k of ends.keys()) keys.add(k);
    const ordered = [...keys].sort((x, y) => figureOrder(x, ref) - figureOrder(y, ref) || (x < y ? -1 : x > y ? 1 : 0));

    p.script = o.script;
    p.since = this.simT;
    const speed = this.guestSpeed(p, null);
    const travels = new Map<string, boolean>();
    const leavers: Array<{ a: Actor; head: Seg[] }> = [];
    let k = 0;

    for (const pass of [0, 1]) {
      for (const key of ordered) {
        const dog = isDogKey(key);
        if ((pass === 0) === dog) continue;
        let a = this.owned.get(key) ?? null;
        if (a && a.party !== p) a = null;
        // Chi era nascosto (in coda per l'accompagnamento, o fra una sala e
        // l'altra) riparte da capo: non si vedeva, nessuna continuità da
        // tenere. E non si vedeva nemmeno al suo posto statico (People lo
        // saltava): niente comparsa al tavolo per poi svanire.
        const unseen = !!a && !a.visible;
        if (a && unseen) {
          this.kill(a);
          a = null;
        }
        if (a) this.detach(a);
        const end = ends.get(key) ?? null;
        const w = unseen ? null : was.get(key) ?? null;
        if (!a && w && prevRoomId !== null) {
          if (end && prevRoomId === endRoomId && slotEqual(w, end)) {
            travels.set(key, false);
            continue;
          }
          a = this.spawnAt(p, key, w, prevRoomId);
        }

        // Il cane cammina accanto al padrone quando tutti e due vanno lontano.
        let owner: Actor | null = null;
        if (dog) {
          const ok = ownerKeyOf(key, ref);
          const cand = ok ? this.owned.get(ok) ?? null : null;
          if (cand && cand.party === p && !cand.dead && ok && travels.get(ok) === true) owner = cand;
        }

        if (a) {
          if (end && endRoomId !== null) {
            const far = a.roomId !== endRoomId || Math.hypot(a.view.x - end.x, a.view.z - end.z) > FOLLOW_MIN;
            if (o.large) {
              this.setPlan(a, this.largeMove(end, endRoomId, k++ * T.largeStaggerMs));
              this.aim(a, end, endRoomId);
              travels.set(key, false);
            } else if (dog && owner && far) {
              a.owner = owner;
              const segs: Seg[] = a.roomId === endRoomId ? [...this.comeBack(a)] : [sFade(0, T.fadeMs), S_HIDE];
              if (a.view.seat > EPS && a.roomId === endRoomId) segs.push(sRise(T.lieMs));
              segs.push(sFollow(T.catchUpSpeed, false), sGoSlot(speed, 1, 0));
              this.setPlan(a, segs);
            } else if (a.roomId === endRoomId) {
              this.setPlan(a, [...this.comeBack(a), sGoSlot(speed, 1, (dog ? 0 : k) * o.stagger)]);
              if (!dog) k++;
              travels.set(key, far);
            } else {
              const out = endRoom!.anchors.outside;
              this.setPlan(a, [
                sFade(0, T.fadeMs),
                S_HIDE,
                sPlace(endRoomId, out.x, out.z, endRoom!.anchors.door.yaw, 0, 0, 0),
                S_GATE_IN,
                sWait((dog ? 0 : k) * T.spawnStaggerMs),
                S_SHOW,
                sPortal(1, speed),
                sGoSlot(speed, 1, 0),
              ]);
              if (!dog) k++;
              travels.set(key, true);
            }
          } else if (o.depart === 'leave') {
            if (o.large) {
              this.setPlan(a, [sWait(k++ * T.largeStaggerMs), sFade(0, T.fadeMs), S_REMOVE]);
            } else if (dog && owner) {
              a.owner = owner;
              const segs: Seg[] = [...this.comeBack(a)];
              if (a.view.seat > EPS) segs.push(sRise(T.lieMs));
              segs.push(sFollow(T.catchUpSpeed, false), S_REMOVE);
              this.setPlan(a, segs);
            } else if (dog) {
              this.setPlan(a, [...this.comeBack(a), sGoOut(speed, 0)]);
            } else {
              // Il turno lo decide la strada, dopo (spaceLeavers).
              leavers.push({ a, head: this.comeBack(a) });
              travels.set(key, true);
            }
          } else {
            this.setPlan(a, [sFade(0, T.fadeMs), S_REMOVE]);
          }
          continue;
        }

        if (!end || endRoomId === null || !endRoom) continue;
        // Non disegnato prima: entra dalla porta, o compare al suo posto.
        a = this.newActor(p, key, end, endRoomId);
        if (o.large || o.arrive === 'fade') {
          a.view.fade = 0;
          this.setPlan(a, [sWait(k++ * (o.large ? T.largeStaggerMs : o.stagger)), S_SHOW, sFade(1, T.fadeMs), S_RELEASE]);
          this.aim(a, end, endRoomId);
        } else if (dog && owner) {
          a.owner = owner;
          this.setPlan(a, [sFollow(T.catchUpSpeed, false), sGoSlot(speed, 1, 0)]);
        } else {
          const out = endRoom.anchors.outside;
          this.setPlan(a, [
            sPlace(endRoomId, out.x, out.z, endRoom.anchors.door.yaw, 0, 0, 0),
            S_GATE_IN,
            sWait((dog ? 0 : k) * o.stagger),
            S_SHOW,
            sPortal(1, speed),
            sGoSlot(speed, 1, 0),
          ]);
          if (!dog) k++;
          travels.set(key, true);
        }
      }
    }
    if (leavers.length > 0) this.spaceLeavers(leavers, speed);
  }

  // Chi esce va alla porta in fila, distanziato per strada e non per tempo:
  // parte prima chi ha meno strada, e ognuno arriva a `inside` una distanza di
  // fila (gapAdult, gapKid) dopo chi lo precede. Partendo a 250 ms l'uno
  // dall'altro, alla stessa velocità e sulla stessa strada, stavano a 27 cm:
  // il bambino dentro le gambe del padre fino alla porta.
  private spaceLeavers(list: ReadonlyArray<{ a: Actor; head: Seg[] }>, speed: number): void {
    const rows = list.map((it, order) => {
      const v = it.a.view;
      const room = this.rooms.get(it.a.roomId);
      // Da dove partirà: dietro la sedia se è seduto (expandGoOut), se no da lì.
      const from = v.seat > EPS ? approachPoint({ x: v.x, z: v.z, yaw: v.yaw }) : { x: v.x, z: v.z };
      const len = room ? pathLength(findPath(room.grid, from, room.anchors.inside)) : 0;
      return { a: it.a, head: it.head, len, order };
    });
    rows.sort((x, y) => x.len - y.len || x.order - y.order);
    const v0 = speed > 0 ? speed : this.T.guestSpeed;
    let prevDelay = 0;
    let prevLen = 0;
    rows.forEach((r, i) => {
      const delay = i === 0 ? 0 : Math.max(0, prevDelay + (1000 * (this.gapOf(r.a) - (r.len - prevLen))) / v0);
      this.setPlan(r.a, [...r.head, sGoOut(speed, delay)]);
      prevDelay = delay;
      prevLen = r.len;
    });
  }

  // Chi stava uscendo dalla porta rientra dallo stesso varco; chi stava
  // svanendo torna visibile prima di muoversi.
  private comeBack(a: Actor): Seg[] {
    const seg = a.plan[a.pi];
    if (seg && seg.k === 'portal' && seg.dir < 0) return [sPortal(1, seg.speed)];
    if (a.view.fade < 1) return [sFade(1, this.T.fadeMs)];
    return [];
  }

  private largeMove(end: FigureSlot, roomId: number, delay: number): Seg[] {
    const T = this.T;
    const segs: Seg[] = [];
    if (delay > 0) segs.push(sWait(delay));
    segs.push(
      sFade(0, T.fadeMs),
      S_HIDE,
      sPlace(roomId, end.x, end.z, end.yaw, 0, seatOf(end), end.seatHeight),
      S_SHOW,
      sFade(1, T.fadeMs),
      S_RELEASE,
    );
    return segs;
  }

  /* ── L'accompagnamento: la coda, l'hostess, la fila ──────────────── */

  // Un accompagnamento nuovo, in coda nella sala del tavolo. `fromLobby`: la
  // fila parte da chi aspetta all'ingresso della stessa sala; se no dalla
  // porta (chi aspettava all'ingresso di un'altra sala svanisce lì).
  private createJob(p: PartyRt, prev: PartyMemo | undefined, next: PartyMemo, fromLobby: boolean, from: 'entrance' | 'lobby'): Job {
    const T = this.T;
    const roomId = next.state.roomId!;
    const room = this.rooms.get(roomId)!;
    const job: Job = {
      party: p,
      roomId,
      tableId: next.state.tableId!,
      from,
      lobby: fromLobby,
      phase: 'queued',
      createdAt: this.simT,
      startedAt: -1,
      f: 1,
      trail: null,
      trailEnd: 0,
      greetArc: 0,
      insideArc: 0,
      lead: 0,
      greet: null,
      head: null,
      centroid: null,
      presentAt: -1,
      tagX: 0,
      tagZ: 0,
      tagAlpha: 0,
      persons: [],
      dogs: [],
    };
    const prevRoomId = prev && onFloor(phaseOf(prev)) ? prev.state.roomId : null;
    const was = new Map<string, FigureSlot>();
    if (prev && prevRoomId !== null && this.rooms.has(prevRoomId)) for (const f of prev.slots) was.set(f.key, f);
    const ref = next.ref;
    const inJob = new Set<string>();
    let cx = 0;
    let cz = 0;
    let cn = 0;
    for (const slot of next.slots) {
      const key = slot.key;
      inJob.add(key);
      let a = this.owned.get(key) ?? null;
      if (a && a.party !== p) a = null;
      const unseen = !!a && !a.visible;
      if (a && unseen) {
        this.kill(a);
        a = null;
      }
      if (a) this.detach(a);
      const w = unseen ? null : was.get(key) ?? null;
      if (slot.kind === 'dog') {
        // Il cane non ha un posto all'ingresso: in una fila che parte da lì
        // resta nascosto finché l'hostess non arriva (poi compare sulla
        // soglia, startNextJob); dalla porta entra accanto al padrone.
        const wait: Seg[] = fromLobby
          ? [S_COLUMN]
          : [sFollow(T.catchUpSpeed, true), sGoSlot(this.guestSpeed(p, null), 1, 0)];
        if (!a) {
          a = this.newActor(p, key, slot, roomId);
          this.setPlan(a, wait);
        } else {
          this.setPlan(a, [sFade(0, T.fadeMs), S_HIDE, ...wait]);
        }
        a.job = job;
        job.dogs.push(a);
        continue;
      }
      if (fromLobby) {
        if (!a && w && prevRoomId !== null) a = this.spawnAt(p, key, w, prevRoomId);
        if (a && a.visible) {
          cx += a.view.x;
          cz += a.view.z;
          cn++;
          this.setPlan(a, [...(a.view.fade < 1 ? [sFade(1, T.fadeMs)] : []), S_COLUMN]);
          a.colMode = COL_WAIT;
        } else {
          a = this.newActor(p, key, slot, roomId);
          this.setPlan(a, [S_COLUMN]);
          a.colMode = COL_HIDDEN;
        }
      } else {
        if (!a && w && prevRoomId !== null) a = this.spawnAt(p, key, w, prevRoomId);
        if (a) {
          this.setPlan(a, [sFade(0, T.fadeMs), S_HIDE, S_COLUMN]);
        } else {
          a = this.newActor(p, key, slot, roomId);
          this.setPlan(a, [S_COLUMN]);
        }
        a.colMode = COL_HIDDEN;
      }
      a.job = job;
      a.col = job.persons.length;
      a.peeled = false;
      a.colS = 0;
      a.slot = null;
      job.persons.push(a);
    }
    for (const a of job.dogs) {
      const ok = ownerKeyOf(a.view.key, ref);
      const owner = ok ? job.persons.find(m => m.view.key === ok) ?? null : null;
      a.owner = owner ?? job.persons[0] ?? null;
    }
    // Chi aveva un attore e non sta nell'accompagnamento (una persona in
    // meno) svanisce dov'è.
    for (const a of p.actors) {
      if (!a.dead && !inJob.has(a.view.key)) {
        if (a.visible) this.setPlan(a, [sFade(0, T.fadeMs), S_REMOVE]);
        else this.kill(a);
      }
    }
    if (cn > 0) job.centroid = { x: cx / cn, z: cz / cn };
    room.queue.push(job);
    p.job = job;
    p.script = 'ESCORT';
    p.since = this.simT;
    this.dirty();
    return job;
  }

  // L'hostess prende il prossimo accompagnamento della coda, da dove sta.
  private startNextJob(room: RoomRt): void {
    const job = room.queue.shift();
    if (!job) return;
    const T = this.T;
    const h = room.hostess;
    // La coda da cui prende, lui compreso (spec: «coda > 3»): con quattro
    // comitive alla porta l'hostess va già al doppio.
    h.f = room.queue.length + 1 > T.queueFastAbove ? 2 : 1;
    job.f = h.f;
    job.phase = 'current';
    job.startedAt = this.simT;
    room.active.push(job);
    h.job = job;
    h.waited = 0;
    h.actor.job = job;
    const table = room.tables.get(job.tableId);
    const a = room.anchors;
    const grid = room.grid;
    const head: Spot = table
      ? tableSidePoint(table, a.inside, grid, T.headGapRect, T.headGapCircle)
      : { x: a.inside.x, z: a.inside.z, yaw: a.door.yaw };
    job.head = head;
    const v = h.actor.view;
    if (!job.lobby) {
      // La strada della fila: dalla coda invisibile dietro la porta fino a
      // `inside`, poi dritta verso il tavolo. L'hostess accoglie su questa
      // strada, GREET_ALONG oltre `inside` (o al tavolo, se è più vicino),
      // rivolta alla porta: niente deviazione verso di lei e ritorno.
      const pts: Vec2[] = [
        { x: a.outside.x - room.nx * TRAIL_BACK, z: a.outside.z - room.nz * TRAIL_BACK },
        { x: a.outside.x, z: a.outside.z },
        { x: a.inside.x, z: a.inside.z },
        ...findPath(grid, a.inside, head).slice(1),
      ];
      const trail = makeTrack(pts, -TRAIL_BACK);
      job.trail = trail;
      job.insideArc = trail.cum[2];
      job.trailEnd = trail.start + trail.length;
      job.greetArc = Math.min(job.trailEnd, job.insideArc + GREET_ALONG);
      pointAt(trail, job.greetArc, SCRATCH, 0);
      const greet: Spot = { x: SCRATCH.x, z: SCRATCH.z, yaw: wrapAngle(SCRATCH.heading + Math.PI) };
      job.greet = greet;
      job.lead = job.greetArc;
      const path = findPath(grid, { x: v.x, z: v.z }, greet);
      h.path = path;
      h.state = 'TO_ENTRANCE';
      this.setPlan(h.actor, [sWalk(greet.x, greet.z, T.hostessSpeed * h.f, path)]);
    } else {
      // Davanti a chi aspetta, verso la sala, rivolta a loro.
      const c = job.centroid ?? a.inside;
      let gx = c.x + room.nx * LOBBY_GREET_IN;
      let gz = c.z + room.nz * LOBBY_GREET_IN;
      if (!isFree(grid, gx, gz)) {
        const free = nearestFree(grid, { x: gx, z: gz });
        if (free) {
          gx = free.x;
          gz = free.z;
        }
      }
      const yaw = Math.hypot(c.x - gx, c.z - gz) > EPS ? Math.atan2(c.x - gx, c.z - gz) : a.door.yaw + Math.PI;
      const greet: Spot = { x: gx, z: gz, yaw };
      job.greet = greet;
      const trail = makeTrack([{ x: gx, z: gz }, ...findPath(grid, greet, head).slice(1)], 0);
      job.trail = trail;
      job.insideArc = -Infinity;
      job.greetArc = 0;
      job.trailEnd = trail.start + trail.length;
      job.lead = 0;
      const path = findPath(grid, { x: v.x, z: v.z }, greet);
      h.path = path;
      h.state = 'TO_LOBBY';
      this.setPlan(h.actor, [sWalk(gx, gz, T.hostessSpeed * h.f, path)]);
      // Chi non aveva un posto all'ingresso (oltre i sei disegnati) e il cane
      // compaiono sulla soglia e raggiungono la fila.
      const inside = a.inside;
      for (const m of job.persons) {
        if (m.dead || m.colMode !== COL_HIDDEN) continue;
        this.setPlan(m, [sPlace(room.id, inside.x, inside.z, a.door.yaw, 0, 0, 0), S_SHOW, sFade(1, T.fadeMs), S_COLUMN]);
      }
      for (const d of job.dogs) {
        if (d.dead) continue;
        this.setPlan(d, [
          sPlace(room.id, inside.x, inside.z, a.door.yaw, 0, 0, 0),
          S_SHOW,
          sFade(1, T.fadeMs),
          sFollow(T.catchUpSpeed, false),
          sGoSlot(this.guestSpeed(job.party, null), 1, 0),
        ]);
      }
    }
    this.dirty();
  }

  // Cambio di tavolo nella stessa sala mentre l'accompagnamento è in coda o in
  // corso (RETARGET).
  private retargetJob(job: Job, next: PartyMemo, prev: PartyMemo | undefined): void {
    const T = this.T;
    const room = this.rooms.get(job.roomId)!;
    job.tableId = next.state.tableId!;
    job.party.since = this.simT;
    this.dirty();
    if (job.phase === 'queued') return;
    // Una strada nuova: i 90 s ripartono da qui.
    job.startedAt = this.simT;
    const table = room.tables.get(job.tableId);
    const a = room.anchors;
    const head: Spot = table
      ? tableSidePoint(table, a.inside, room.grid, T.headGapRect, T.headGapCircle)
      : { x: a.inside.x, z: a.inside.z, yaw: a.door.yaw };
    const h = room.hostess;
    if (job.phase === 'current' && job.trail && job.greet) {
      job.head = head;
      if (h.state === 'ESCORT' && h.job === job) {
        // Da dove è lei: la fila continua sulle briciole già posate, poi
        // prende la strada nuova.
        const path = findPath(room.grid, { x: h.actor.view.x, z: h.actor.view.z }, head);
        h.path = path;
        job.trail = appendTrack(job.trail, path, h.s);
        job.trailEnd = job.trail.start + job.trail.length;
      } else {
        // Ancora alla porta (o all'ingresso): cambia solo la strada dopo il
        // punto d'accoglienza, dove lei sta andando o già aspetta; chi è in
        // fila resta dov'è (al più si accosta: il punto può essere un filo
        // più vicino in linea d'aria che lungo la strada vecchia).
        const g = job.greet;
        const tail = findPath(room.grid, g, head).slice(1);
        if (!job.lobby) {
          const pts: Vec2[] = [];
          for (let i = 0; i <= 2; i++) pts.push({ x: job.trail.xs[i], z: job.trail.zs[i] });
          job.trail = makeTrack([...pts, { x: g.x, z: g.z }, ...tail], -TRAIL_BACK);
          job.greetArc = job.trail.cum[3];
          job.lead = job.greetArc;
        } else {
          job.trail = makeTrack([{ x: g.x, z: g.z }, ...tail], 0);
        }
        job.trailEnd = job.trail.start + job.trail.length;
      }
      return;
    }
    // Dopo PRESENT: chi è già sceso dalla fila va alle sedie nuove; chi era
    // già seduto si rialza e le raggiunge.
    const speed = this.guestSpeed(job.party, null) * job.f;
    for (const m of job.persons) {
      if (!m.dead && m.peeled && m.visible) this.setPlan(m, [...this.comeBack(m), sGoSlot(speed, 1 / job.f, 0)]);
    }
    // Il cane che andava già da solo al suo posto vecchio ci va di nuovo, al
    // nuovo; quello che segue ancora il padrone lo segue e basta.
    for (const d of job.dogs) {
      if (!d.dead && d.visible && d.slot !== null) this.setPlan(d, [...this.comeBack(d), sGoSlot(this.guestSpeed(job.party, d), 1, 0)]);
    }
    const prevRoomId = prev?.state.roomId ?? null;
    if (prev && prevRoomId === job.roomId) {
      for (const f of prev.slots) {
        if (this.owned.has(f.key)) continue;
        const m = this.spawnAt(job.party, f.key, f, job.roomId);
        m.job = job;
        m.peeled = true;
        m.col = -1;
        this.setPlan(m, [sGoSlot(speed, 1, 0)]);
        if (m.isDog) job.dogs.push(m);
        else job.persons.push(m);
      }
    }
  }

  // Toglie un accompagnamento dalla sala; l'hostess, se era il suo, prende
  // il prossimo o torna al leggio (di colpo solo per uno scatto di un
  // motivo: nessuno guarda, o nessuno deve camminare).
  private cancelJob(job: Job, instant: boolean): void {
    const room = this.rooms.get(job.roomId);
    if (room) {
      const qi = room.queue.indexOf(job);
      if (qi >= 0) room.queue.splice(qi, 1);
      const ai = room.active.indexOf(job);
      if (ai >= 0) room.active.splice(ai, 1);
      const h = room.hostess;
      if (h.job === job) {
        h.job = null;
        h.actor.job = null;
        if (h.state !== 'PRESENT' && h.state !== 'RETURN' && h.state !== 'AT_STAND') {
          if (room.queue.length > 0 && this.doorClear(room)) this.startNextJob(room);
          else if (instant) this.hostessHome(room);
          else this.hostessReturn(room);
        }
      }
    }
    for (const m of job.persons) if (m.job === job) m.job = null;
    for (const m of job.dogs) if (m.job === job) m.job = null;
    if (job.party.job === job) job.party.job = null;
    this.candDirty = true;
    this.dirty();
  }

  private emitEscortStart(next: PartyMemo, from: 'entrance' | 'lobby'): void {
    const table = next.table ?? { id: next.state.tableId ?? 0, name: '' };
    this.emit({ kind: 'escort-start', at: this.now(), roomId: next.state.roomId!, party: next.ref, table, from });
  }

  private emitEscortEnd(job: Job, seated: boolean): void {
    this.emit({ kind: 'escort-end', at: this.now(), roomId: job.roomId, partyId: job.party.id, tableId: job.tableId, seated });
  }

  // Più di 6 accompagnamenti fra la coda e quello in corso: i più vecchi
  // della coda si siedono subito (quello in corso no: è già in sala).
  private queueOverflow(): void {
    for (const room of this.roomList) {
      const cur = room.hostess.job;
      const busy = cur !== null && cur.phase === 'current' ? 1 : 0;
      if (room.queue.length + busy <= this.T.queueSnapAbove) continue;
      const snapped: Job[] = [];
      while (room.queue.length > 0 && room.queue.length + busy > this.T.queueSnapAbove) snapped.push(room.queue.shift()!);
      for (const job of snapped) {
        const p = job.party;
        for (const a of p.actors) this.kill(a);
        p.job = null;
        p.script = null;
        p.visits = 0;
        p.seatedAt = this.simT;
        p.lastVisitAt = this.simT;
      }
      const parties = snapped.map(job => ({
        party: this.memo?.get(job.party.id)?.ref ?? { id: job.party.id, name: null, adults: 1, kids: 0, dogs: 0 },
        table: this.tableRefIn(room.id, job.tableId, null),
      }));
      this.emit({ kind: 'snapped', at: this.now(), roomId: room.id, reason: 'queue', parties });
      for (const job of snapped) this.emitEscortEnd(job, true);
      this.candDirty = true;
      this.dirty();
    }
  }

  /* ── step: l'hostess ─────────────────────────────────────────────── */

  private stepHostess(room: RoomRt, dt: number): void {
    const h = room.hostess;
    const a = h.actor;
    const v = a.view;
    const T = this.T;
    const dtS = dt / 1000;
    a.moving = false;
    switch (h.state) {
      case 'AT_STAND':
        if (room.queue.length > 0 && this.doorClear(room)) this.startNextJob(room);
        break;
      case 'TO_ENTRANCE':
      case 'TO_LOBBY': {
        const job = h.job;
        if (!job) {
          this.hostessReturn(room);
          break;
        }
        if (a.pi < a.plan.length) {
          this.runPlan(a, dt);
          if (a.pi < a.plan.length) break;
        }
        const g = job.greet;
        if (g) v.yaw = turnToward(v.yaw, g.yaw, T.yawRate * dtS);
        h.waited += dt;
        if (h.state === 'TO_LOBBY' || this.firstReady(job) || h.waited >= GREET_WAIT_MAX_MS) this.hostessTo(room, 'GREET');
        break;
      }
      case 'GREET': {
        const job = h.job;
        if (!job) {
          this.hostessReturn(room);
          break;
        }
        h.timer -= dt;
        const total = T.greetMs / h.f;
        const t = total > 0 ? Math.min(1, Math.max(0, 1 - h.timer / total)) : 1;
        if (t < GREET_LOOK) {
          // Il saluto: rivolta a chi arriva, il braccio giù.
          v.arm = Math.max(0, v.arm - ARM_RATE * dtS);
          let first: Actor | null = null;
          for (let i = 0; i < job.persons.length && first === null; i++) {
            const m = job.persons[i];
            if (!m.dead && m.visible) first = m;
          }
          if (first) {
            const dx = first.view.x - v.x;
            const dz = first.view.z - v.z;
            if (dx * dx + dz * dz > EPS) v.yaw = turnToward(v.yaw, Math.atan2(dx, dz), T.yawRate * dtS);
          }
        } else {
          // «Prego, da questa parte»: verso la strada, il braccio che sale
          // (morbido agli estremi), e si parte col braccio ancora alzato.
          if (job.trail) {
            pointAt(job.trail, job.greetArc, SCRATCH, 0);
            v.yaw = turnToward(v.yaw, SCRATCH.heading, T.yawRate * dtS);
          }
          const u = (t - GREET_LOOK) / (1 - GREET_LOOK);
          v.arm = u * u * (3 - 2 * u);
        }
        if (h.timer <= 0) this.hostessTo(room, 'ESCORT');
        break;
      }
      case 'ESCORT': {
        const job = h.job;
        if (!job || !job.trail) {
          this.hostessReturn(room);
          break;
        }
        const from = h.s;
        const to = Math.min(job.trailEnd, from + T.escortSpeed * h.f * dtS);
        h.s = to;
        pointAt(job.trail, to, a.pt, a.pt.seg);
        v.x = a.pt.x;
        v.z = a.pt.z;
        const moved = to - from;
        if (moved > EPS) {
          v.yaw = turnToward(v.yaw, a.pt.heading, T.yawRate * dtS);
          v.phase = advancePhase(v.phase, moved, a.stride);
          v.walk = easeWalk(v.walk, 1, dtS);
          a.moving = true;
        }
        job.lead = to;
        if (to >= job.trailEnd - EPS) this.hostessTo(room, 'PRESENT');
        break;
      }
      case 'PRESENT': {
        h.timer -= dt;
        // Il braccio verso il tavolo per presentMs, poi giù mentre aspetta.
        v.arm = h.timer > 0 ? Math.min(1, v.arm + ARM_RATE * dtS) : Math.max(0, v.arm - ARM_RATE * dtS);
        const dx = h.faceX - v.x;
        const dz = h.faceZ - v.z;
        if (dx * dx + dz * dz > EPS) v.yaw = turnToward(v.yaw, Math.atan2(dx, dz), T.yawRate * dtS);
        // Finita la presentazione resta lì finché la sua comitiva non è ai
        // posti (al più PRESENT_WAIT_MAX_MS): voltandosi subito tornava
        // indietro per il corridoio dove gli ultimi della fila stavano ancora
        // andando alle sedie, in mezzo a loro.
        if (h.timer <= 0 && (h.timer <= -PRESENT_WAIT_MAX_MS || this.peeledHome(h.job))) {
          h.job = null;
          a.job = null;
          if (room.queue.length > 0 && this.doorClear(room)) this.startNextJob(room);
          else this.hostessReturn(room);
        }
        break;
      }
      case 'RETURN': {
        if (a.pi < a.plan.length) this.runPlan(a, dt);
        if (a.pi >= a.plan.length && v.walk === 0 && v.arm === 0) {
          h.state = 'AT_STAND';
          h.path = null;
          v.x = room.hostSlot.x;
          v.z = room.hostSlot.z;
          v.yaw = room.hostSlot.yaw;
        }
        if (room.queue.length > 0 && this.doorClear(room)) this.startNextJob(room);
        break;
      }
    }
    if (h.state !== 'GREET' && h.state !== 'PRESENT') v.arm = Math.max(0, v.arm - ARM_RATE * dtS);
    if (!a.moving) v.walk = easeWalk(v.walk, 0, dtS);
  }

  private hostessTo(room: RoomRt, state: 'GREET' | 'ESCORT' | 'PRESENT'): void {
    const h = room.hostess;
    const job = h.job!;
    const T = this.T;
    // La velocità si rilegge a ogni cambio di stato: la coda può essere
    // cresciuta mentre lei camminava. Conta anche chi sta accompagnando.
    h.f = room.queue.length + 1 > T.queueFastAbove ? 2 : 1;
    job.f = h.f;
    h.state = state;
    if (state === 'GREET') {
      h.timer = T.greetMs / h.f;
    } else if (state === 'ESCORT') {
      h.s = job.greetArc;
      h.actor.pt.seg = 0;
    } else {
      h.timer = T.presentMs / h.f;
      // L'etichetta resta dov'era, sopra chi guidava la fila, e da lì svanisce.
      const lead = this.tagLead(job, room.id);
      job.tagX = lead ? lead.view.x : h.actor.view.x;
      job.tagZ = lead ? lead.view.z : h.actor.view.z;
      job.tagAlpha = lead ? lead.view.fade : 0;
      job.phase = 'peel';
      job.presentAt = this.simT;
      job.lead = job.trailEnd;
      const table = room.tables.get(job.tableId);
      h.faceX = table ? table.center.x : h.actor.view.x;
      h.faceZ = table ? table.center.z : h.actor.view.z;
      if (!table && job.head) {
        h.faceX = h.actor.view.x + Math.sin(job.head.yaw);
        h.faceZ = h.actor.view.z + Math.cos(job.head.yaw);
      }
      this.dirty();
    }
  }

  private hostessReturn(room: RoomRt): void {
    const h = room.hostess;
    h.state = 'RETURN';
    h.job = null;
    h.actor.job = null;
    const s = room.hostSlot;
    const v = h.actor.view;
    const path = findPath(room.grid, { x: v.x, z: v.z }, { x: s.x, z: s.z });
    h.path = path;
    this.setPlan(h.actor, [sWalk(s.x, s.z, this.T.hostessSpeed, path), sTurn(s.yaw, this.T.turnMs)]);
  }

  private hostessHome(room: RoomRt): void {
    const h = room.hostess;
    const v = h.actor.view;
    h.state = 'AT_STAND';
    h.job = null;
    h.path = null;
    h.actor.job = null;
    h.f = 1;
    v.x = room.hostSlot.x;
    v.z = room.hostSlot.z;
    v.yaw = room.hostSlot.yaw;
    v.walk = 0;
    v.arm = 0;
    v.seat = 0;
    v.fade = 1;
    this.setPlan(h.actor, []);
  }

  // La porta è libera quando nessuno di questa sala sta uscendo (una
  // comitiva in LEAVE ancora in scena, in cammino o in attesa del suo turno).
  // Finché non lo è l'hostess non va a prendere nessuno: la famiglia che
  // entra e quella che esce si incrocerebbero nell'ingresso, attraverso
  // l'una l'altra (la fila segue il suo binario e non si scansa). Chi aspetta
  // resta in coda, col tavolo «in arrivo»: prima esce chi lascia il tavolo,
  // poi l'hostess accompagna chi arriva, come in sala.
  private doorClear(room: RoomRt): boolean {
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.dead && a.roomId === room.id && a.party !== null && a.party.script === 'LEAVE') return false;
    }
    return true;
  }

  // L'hostess sta portando una fila (va a prenderla, accoglie, accompagna):
  // chi esce aspetta in piedi al suo tavolo finché lei non presenta il
  // tavolo, invece di andarle incontro nel corridoio.
  private escortUnderway(room: RoomRt): boolean {
    const job = room.hostess.job;
    return job !== null && job.phase === 'current';
  }

  // Chi l'hostess ha presentato è arrivato: al suo punto d'approccio (o già
  // seduto e tornato a People), cani compresi. Un accompagnamento tolto di
  // mezzo (annullato mentre presentava) non ha più nessuno da aspettare.
  private peeledHome(job: Job | null): boolean {
    if (!job) return true;
    for (let i = 0; i < job.persons.length; i++) {
      const m = job.persons[i];
      if (m.dead || m.job !== job) continue;
      if (!m.peeled || !m.arrived) return false;
    }
    for (let i = 0; i < job.dogs.length; i++) {
      const d = job.dogs[i];
      if (d.dead || d.job !== job) continue;
      if (!d.arrived) return false;
    }
    return true;
  }

  private firstReady(job: Job): boolean {
    for (const m of job.persons) {
      if (m.dead || m.peeled) continue;
      if (m.colMode !== COL_TRAIL) return false;
      return job.lead - this.gapOf(m) - m.colS < 1e-6;
    }
    return true;
  }

  /* ── step: la fila ───────────────────────────────────────────────── */

  private gapOf(a: Actor): number {
    return a.view.kind === 'kid' ? this.T.gapKid : this.T.gapAdult;
  }

  private stepColumn(room: RoomRt, job: Job, dt: number): void {
    const trail = job.trail;
    if (!trail) return;
    const T = this.T;
    const f = job.f;
    const dtS = dt / 1000;
    let acc = 0;
    let peelOpen = job.presentAt >= 0;
    for (let k = 0; k < job.persons.length; k++) {
      const a = job.persons[k];
      if (a.dead || a.peeled || a.col < 0) continue;
      acc += this.gapOf(a);
      const seg = a.plan[a.pi];
      const inColumn = !!seg && seg.k === 'column';
      const target = job.lead - acc;
      if (inColumn) {
        if (job.lobby) this.stepLobbyMember(job, a, target, dtS);
        else this.stepTrailMember(room, job, a, target, acc, dtS);
      }
      if (!peelOpen) continue;
      // Si scende dalla fila in ordine, uno ogni peelStaggerMs (÷f), e chi
      // entra dalla porta solo una volta dentro la sala: oltre `inside`, o
      // fermo al suo posto della fila ma già oltre la soglia (un tavolo
      // attaccato alla porta: la fila non arriva fino a `inside`).
      const due = job.presentAt + (a.col * T.peelStaggerMs) / f;
      const inside = a.colMode === COL_TRAIL && (a.colS >= job.insideArc - EPS || (a.colS >= target - EPS && a.view.fade >= 1));
      const ready = inColumn && (job.lobby || inside);
      if (this.simT + EPS >= due && ready) {
        a.peeled = true;
        this.setPlan(a, [sGoSlot(this.guestSpeed(job.party, a) * f, 1 / f, 0)]);
        acc -= this.gapOf(a);
      } else {
        peelOpen = false;
      }
    }
  }

  private stepTrailMember(room: RoomRt, job: Job, a: Actor, target: number, acc: number, dtS: number): void {
    const trail = job.trail!;
    const v = a.view;
    const T = this.T;
    if (a.colMode === COL_HIDDEN) {
      // Compare sul binario dietro la porta, invisibile: la coda aspetta lì.
      a.colMode = COL_TRAIL;
      a.colS = Math.min(-acc, target);
      a.roomId = job.roomId;
      a.visible = true;
      pointAt(trail, a.colS, a.pt, 0);
      v.x = a.pt.x;
      v.z = a.pt.z;
      v.yaw = a.pt.heading;
      v.seat = 0;
      v.seatHeight = 0;
      v.walk = 0;
      v.fade = 0;
      this.dirty();
    }
    const from = a.colS;
    let to = from + T.catchUpSpeed * job.f * dtS;
    if (to > target) to = target;
    if (to < from) to = from;
    a.colS = to;
    pointAt(trail, to, a.pt, a.pt.seg);
    v.x = a.pt.x;
    v.z = a.pt.z;
    const moved = to - from;
    a.moving = moved > EPS;
    if (a.moving) {
      v.yaw = turnToward(v.yaw, a.pt.heading, T.yawRate * dtS);
      v.phase = advancePhase(v.phase, moved, a.stride);
    }
    v.walk = easeWalk(v.walk, a.moving ? 1 : 0, dtS);
    v.fade = to >= job.insideArc ? 1 : this.portalFade(room, v.x, v.z);
    v.pose = 'standing';
  }

  private stepLobbyMember(job: Job, a: Actor, target: number, dtS: number): void {
    const trail = job.trail!;
    const v = a.view;
    const T = this.T;
    if (a.colMode === COL_HIDDEN) a.colMode = COL_WAIT;
    a.moving = false;
    if (a.colMode === COL_WAIT) {
      // Aspetta al suo posto finché nella fila c'è spazio per lui. Il suo
      // punto d'arco negativo starebbe sul prolungamento all'indietro del
      // primo tratto, che dall'ingresso può finire nel muro: meglio restare
      // fermi e agganciarsi quando l'hostess si è avviata. L'aggancio è
      // esatto (si arriva sul punto nel frame in cui lo si raggiunge), senza
      // lo scatto di 10 cm.
      if (target < 0) {
        v.walk = easeWalk(v.walk, 0, dtS);
        return;
      }
      a.colMode = COL_STEER;
    }
    if (a.colMode === COL_STEER) {
      pointAt(trail, target, SCRATCH, 0);
      const dx = SCRATCH.x - v.x;
      const dz = SCRATCH.z - v.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      const stepLen = T.catchUpSpeed * job.f * dtS;
      if (d <= stepLen) {
        v.x = SCRATCH.x;
        v.z = SCRATCH.z;
        a.colS = target;
        a.colMode = COL_TRAIL;
        a.pt.seg = SCRATCH.seg;
        if (d > EPS) {
          v.phase = advancePhase(v.phase, d, a.stride);
          a.moving = true;
        }
      } else {
        v.x += (dx / d) * stepLen;
        v.z += (dz / d) * stepLen;
        v.yaw = turnToward(v.yaw, Math.atan2(dx, dz), T.yawRate * dtS);
        v.phase = advancePhase(v.phase, stepLen, a.stride);
        a.moving = true;
      }
      v.walk = easeWalk(v.walk, a.moving ? 1 : 0, dtS);
      return;
    }
    const from = a.colS;
    let to = from + T.catchUpSpeed * job.f * dtS;
    if (to > target) to = target;
    if (to < from) to = from;
    a.colS = to;
    pointAt(trail, to, a.pt, a.pt.seg);
    v.x = a.pt.x;
    v.z = a.pt.z;
    const moved = to - from;
    a.moving = moved > EPS;
    if (a.moving) {
      v.yaw = turnToward(v.yaw, a.pt.heading, T.yawRate * dtS);
      v.phase = advancePhase(v.phase, moved, a.stride);
    }
    v.walk = easeWalk(v.walk, a.moving ? 1 : 0, dtS);
  }

  // La dissolvenza della soglia: 0 a `outside`, 1 sulla porta.
  private portalFade(room: RoomRt, x: number, z: number): number {
    const o = room.anchors.outside;
    const d = ((x - o.x) * room.nx + (z - o.z) * room.nz) / DOOR_OUTSIDE;
    return d <= 0 ? 0 : d >= 1 ? 1 : d;
  }

  // Gli accompagnamenti finiti (tutti seduti): escono di scena.
  private finishJobs(): void {
    for (let r = 0; r < this.roomList.length; r++) {
      const room = this.roomList[r];
      for (let i = room.active.length - 1; i >= 0; i--) {
        const job = room.active[i];
        if (job.phase !== 'peel') continue;
        let alive = false;
        for (let j = 0; j < job.persons.length && !alive; j++) alive = !job.persons[j].dead && job.persons[j].job === job;
        for (let j = 0; j < job.dogs.length && !alive; j++) alive = !job.dogs[j].dead && job.dogs[j].job === job;
        if (alive) continue;
        room.active.splice(i, 1);
        const p = job.party;
        if (p.job === job) {
          p.job = null;
          if (!this.hasLive(p)) p.script = null;
        }
        p.visits = 0;
        p.seatedAt = this.simT;
        p.lastVisitAt = this.simT;
        this.candDirty = true;
        this.dirty();
        this.emitEscortEnd(job, true);
      }
    }
  }

  private safetyNet(): void {
    const limit = this.simT - SAFETY_MS;
    for (let r = 0; r < this.roomList.length; r++) {
      const room = this.roomList[r];
      this.expireJobs(room.queue, limit, false);
      this.expireJobs(room.active, limit, true);
    }
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const p = a.party;
      if (a.dead || !p || p.job || p.since > limit) continue;
      for (let j = 0; j < p.actors.length; j++) this.kill(p.actors[j]);
      p.script = null;
    }
  }

  private expireJobs(list: Job[], limit: number, active: boolean): void {
    for (let i = list.length - 1; i >= 0; i--) {
      const job = list[i];
      if ((active && job.startedAt >= 0 ? job.startedAt : job.createdAt) > limit) continue;
      const p = job.party;
      for (let j = 0; j < p.actors.length; j++) this.kill(p.actors[j]);
      this.cancelJob(job, false);
      p.script = null;
      p.visits = 0;
      p.seatedAt = this.simT;
      p.lastVisitAt = this.simT;
      this.emitEscortEnd(job, true);
    }
  }

  /* ── step: gli attori ────────────────────────────────────────────── */

  private stepActor(a: Actor, dt: number): void {
    const seg = a.plan[a.pi];
    if (seg && seg.k === 'column') {
      // La fila la muove stepColumn; in coda si sta fermi.
      if (!a.job || a.job.phase === 'queued') {
        a.moving = false;
        a.view.walk = easeWalk(a.view.walk, 0, dt / 1000);
      }
      return;
    }
    this.runPlan(a, dt);
  }

  private runPlan(a: Actor, dt: number): void {
    const v = a.view;
    a.moving = false;
    // `replanned` dice solo che un passo ha appena cambiato il piano, qui
    // dentro; un piano dato da update arriva già pronto dall'inizio.
    a.replanned = false;
    let left = dt;
    let guard = 0;
    while (!a.dead && a.pi < a.plan.length && guard++ < 32) {
      const r = this.runSeg(a, a.plan[a.pi], left);
      if (r < 0) break;
      left = r;
      if (a.replanned) {
        a.replanned = false;
        continue;
      }
      a.pi++;
      a.t = 0;
      a.started = false;
    }
    if (!a.moving) v.walk = easeWalk(v.walk, 0, dt / 1000);
    v.pose = a.isDog ? (v.seat >= 0.5 ? 'lying' : 'standing') : a.isPerson && v.seat >= 0.5 ? 'seated' : 'standing';
  }

  // Un piano nuovo. `slot` si azzera: lo rimette solo chi ha il punto
  // d'arrivo scritto nel piano (expandGoSlot, le comparse), dopo. Un `slot`
  // rimasto da un piano vecchio farebbe credere a reconcile che chi sta
  // cambiando sala vada ancora al tavolo di prima.
  private setPlan(a: Actor, plan: Seg[]): void {
    a.plan = plan;
    a.pi = 0;
    a.t = 0;
    a.started = false;
    a.track = null;
    a.arrived = false;
    a.outbound = false;
    a.replanned = true;
    a.slot = null;
  }

  private aim(a: Actor, slot: FigureSlot, roomId: number): void {
    a.slot = slot;
    a.slotRoom = roomId;
  }

  // Un passo del piano. Restituisce i ms avanzati se è finito, −1 se continua.
  private runSeg(a: Actor, seg: Seg, left: number): number {
    const v = a.view;
    const T = this.T;
    switch (seg.k) {
      case 'wait':
        a.t += left;
        return a.t >= seg.ms ? a.t - seg.ms : -1;
      case 'fade': {
        const ms = Math.max(1, seg.ms);
        const need = Math.abs(seg.to - v.fade) * ms;
        if (left >= need) {
          v.fade = seg.to;
          return left - need;
        }
        v.fade += ((seg.to > v.fade ? 1 : -1) * left) / ms;
        return -1;
      }
      case 'rise': {
        const ms = Math.max(1, seg.ms);
        const need = v.seat * ms;
        if (left >= need) {
          v.seat = 0;
          if (a.isPerson) v.seatHeight = 0;
          return left - need;
        }
        v.seat -= left / ms;
        return -1;
      }
      case 'sit': {
        if (!a.started) {
          a.started = true;
          if (a.isPerson) v.seatHeight = seg.h;
        }
        const ms = Math.max(1, seg.ms);
        const need = (1 - v.seat) * ms;
        if (left >= need) {
          v.seat = 1;
          return left - need;
        }
        v.seat += left / ms;
        return -1;
      }
      case 'step': {
        if (!a.started) {
          a.started = true;
          a.sx = v.x;
          a.sz = v.z;
          a.t = 0;
        }
        const ms = Math.max(1, seg.ms);
        const t0 = a.t;
        a.t = Math.min(ms, a.t + left);
        const used = a.t - t0;
        const r = a.t / ms;
        const nx = a.sx + (seg.x - a.sx) * r;
        const nz = a.sz + (seg.z - a.sz) * r;
        const dx = nx - v.x;
        const dz = nz - v.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d > EPS) {
          const dtS = used / 1000;
          if (seg.face) v.yaw = turnToward(v.yaw, Math.atan2(seg.x - a.sx, seg.z - a.sz), T.yawRate * dtS);
          v.phase = advancePhase(v.phase, d, a.stride);
          v.walk = easeWalk(v.walk, 1, dtS);
          a.moving = true;
        }
        v.x = nx;
        v.z = nz;
        if (a.t >= ms) {
          v.x = seg.x;
          v.z = seg.z;
          return left - used;
        }
        return -1;
      }
      case 'turn': {
        if (!a.started) {
          a.started = true;
          a.syaw = v.yaw;
          a.t = 0;
          if (Math.abs(wrapAngle(seg.yaw - v.yaw)) < 1e-6) {
            v.yaw = seg.yaw;
            return left;
          }
        }
        const ms = Math.max(1, seg.ms);
        const t0 = a.t;
        a.t = Math.min(ms, a.t + left);
        if (a.t >= ms) {
          v.yaw = seg.yaw;
          return left - (ms - t0);
        }
        v.yaw = wrapAngle(a.syaw + wrapAngle(seg.yaw - a.syaw) * (a.t / ms));
        return -1;
      }
      case 'walk':
        return this.runWalk(a, seg, left);
      case 'portal':
        return this.runPortal(a, seg, left);
      case 'place':
        a.roomId = seg.roomId;
        v.x = seg.x;
        v.z = seg.z;
        v.yaw = seg.yaw;
        v.fade = seg.fade;
        v.seat = seg.seat;
        v.seatHeight = seg.h;
        v.walk = 0;
        this.dirty();
        return left;
      case 'show':
        if (!a.visible) {
          a.visible = true;
          this.dirty();
        }
        return left;
      case 'hide':
        if (a.visible) {
          a.visible = false;
          this.dirty();
        }
        return left;
      case 'follow':
        return this.runFollow(a, seg, left);
      case 'column':
        return -1;
      case 'mark':
        a.arrived = true;
        return left;
      case 'goSlot':
        this.expandGoSlot(a, seg);
        return left;
      case 'goOut':
        this.expandGoOut(a, seg);
        return left;
      case 'gate': {
        const room = this.rooms.get(a.roomId);
        if (!room) return left;
        return (seg.dir < 0 ? this.escortUnderway(room) : !this.doorClear(room)) ? -1 : left;
      }
      case 'release':
        return this.runRelease(a, left);
      case 'remove':
        this.kill(a);
        return left;
    }
  }

  // Verso la figura statica più recente della sua chiave, da dove è adesso:
  // si alza se è seduto, va al punto d'approccio, l'ultimo passo, si gira, si
  // siede (il cane si sdraia).
  private expandGoSlot(a: Actor, seg: Extract<Seg, { k: 'goSlot' }>): void {
    const T = this.T;
    const room = this.rooms.get(a.roomId);
    const fig = room?.figByKey.get(a.view.key);
    if (!room || !fig || (a.party && fig.partyId !== a.party.id)) {
      this.setPlan(a, [sFade(0, T.fadeMs), S_REMOVE]);
      return;
    }
    const v = a.view;
    const sc = seg.scale > 0 ? seg.scale : 1;
    const segs: Seg[] = [];
    const atSlot = Math.abs(v.x - fig.x) < 1e-6 && Math.abs(v.z - fig.z) < 1e-6;
    if (a.isPerson) {
      if (v.seat > EPS) {
        if (atSlot && fig.pose === 'seated') {
          segs.push(sTurn(fig.yaw, T.turnMs * sc), sSit(T.sitMs * sc, fig.seatHeight), S_RELEASE);
          this.setPlan(a, segs);
          this.aim(a, fig, room.id);
          return;
        }
        segs.push(sRise(T.standMs * sc));
        const back = approachPoint({ x: v.x, z: v.z, yaw: v.yaw });
        segs.push(sStep(back.x, back.z, T.stepMs * sc, false));
      }
      if (seg.delay > 0) segs.push(sWait(seg.delay));
      if (fig.pose === 'seated') {
        const ap = approachPoint(fig);
        segs.push(sWalk(ap.x, ap.z, seg.speed), S_MARK, sStep(fig.x, fig.z, T.stepMs * sc, true), sTurn(fig.yaw, T.turnMs * sc));
        segs.push(sSit(T.sitMs * sc, fig.seatHeight));
      } else {
        segs.push(sWalk(fig.x, fig.z, seg.speed), S_MARK, sTurn(fig.yaw, T.turnMs * sc));
      }
    } else {
      if (v.seat > EPS && !(atSlot && fig.pose === 'lying')) segs.push(sRise(T.lieMs * sc));
      if (seg.delay > 0) segs.push(sWait(seg.delay));
      segs.push(sWalk(fig.x, fig.z, seg.speed), S_MARK, sTurn(fig.yaw, T.turnMs * sc));
      if (fig.pose === 'lying') segs.push(sSit(T.lieMs * sc, 0));
    }
    segs.push(S_RELEASE);
    this.setPlan(a, segs);
    this.aim(a, fig, room.id);
  }

  // Fuori dalla sala: si alza, va alla soglia, esce dalla porta svanendo.
  private expandGoOut(a: Actor, seg: Extract<Seg, { k: 'goOut' }>): void {
    const T = this.T;
    const room = this.rooms.get(a.roomId);
    if (!room) {
      this.setPlan(a, [sFade(0, T.fadeMs), S_REMOVE]);
      return;
    }
    const v = a.view;
    const segs: Seg[] = [];
    if (v.seat > EPS) {
      if (a.isPerson) {
        segs.push(sRise(T.standMs));
        const back = approachPoint({ x: v.x, z: v.z, yaw: v.yaw });
        segs.push(sStep(back.x, back.z, T.stepMs, false));
      } else {
        segs.push(sRise(T.lieMs));
      }
    }
    // Prima del turno, così alla porta libera si riparte coi propri intervalli.
    segs.push(S_GATE_OUT);
    if (seg.delay > 0) segs.push(sWait(seg.delay));
    segs.push(sWalk(room.anchors.inside.x, room.anchors.inside.z, seg.speed, null, true), sPortal(-1, seg.speed), S_REMOVE);
    this.setPlan(a, segs);
  }

  private runWalk(a: Actor, seg: Extract<Seg, { k: 'walk' }>, left: number): number {
    const v = a.view;
    const T = this.T;
    if (!a.started) {
      a.started = true;
      const dx = seg.x - v.x;
      const dz = seg.z - v.z;
      if (dx * dx + dz * dz < 1e-12) {
        v.x = seg.x;
        v.z = seg.z;
        return left;
      }
      const room = this.rooms.get(a.roomId);
      const path = seg.path ?? (room
        ? this.pathAround(room, a, { x: v.x, z: v.z }, { x: seg.x, z: seg.z })
        : [{ x: v.x, z: v.z }, { x: seg.x, z: seg.z }]);
      a.path = path;
      a.track = makeTrack(path);
      a.s = a.track.start;
      a.s1 = a.track.start + a.track.length;
      a.pt.seg = 0;
      a.yieldWait = 0;
      if (seg.out) a.outbound = true;
    }
    const track = a.track;
    if (!track) return left;
    if (left <= 0) return -1;
    if (this.mustYield(a, left)) return -1;
    const speed = seg.speed > 0 ? seg.speed : T.guestSpeed;
    const remaining = a.s1 - a.s;
    const adv = (speed * left) / 1000;
    if (adv >= remaining) {
      const used = (remaining / speed) * 1000;
      pointAt(track, a.s1, a.pt, a.pt.seg);
      if (remaining > EPS) {
        v.yaw = turnToward(v.yaw, a.pt.heading, (T.yawRate * used) / 1000);
        v.phase = advancePhase(v.phase, remaining, a.stride);
        v.walk = easeWalk(v.walk, 1, used / 1000);
        a.moving = true;
      }
      v.x = seg.x;
      v.z = seg.z;
      a.track = null;
      return Math.max(0, left - used);
    }
    a.s += adv;
    pointAt(track, a.s, a.pt, a.pt.seg);
    v.x = a.pt.x;
    v.z = a.pt.z;
    const dtS = left / 1000;
    v.yaw = turnToward(v.yaw, a.pt.heading, T.yawRate * dtS);
    v.phase = advancePhase(v.phase, adv, a.stride);
    v.walk = easeWalk(v.walk, 1, dtS);
    a.moving = true;
    return -1;
  }

  // Il percorso di chi non è l'hostess, girando attorno a lei se sta ferma.
  // La griglia è di tutta la sala: le sue celle si chiudono solo per questa
  // ricerca e si riaprono subito (si pianifica, non si è nel frame).
  private pathAround(room: RoomRt, a: Actor, from: Vec2, to: Vec2): Vec2[] {
    const h = room.hostess;
    const still = a !== h.actor && (h.state === 'AT_STAND' || h.state === 'GREET' || h.state === 'PRESENT');
    if (!still) return findPath(room.grid, from, to);
    const g = room.grid;
    const hx = h.actor.view.x;
    const hz = h.actor.view.z;
    const r = HOSTESS_BLOCK_R;
    const opened = this.blockScratch;
    opened.length = 0;
    const i0 = Math.max(0, Math.floor((hx - r) / CELL));
    const i1 = Math.min(g.cols - 1, Math.floor((hx + r) / CELL));
    const j0 = Math.max(0, Math.floor((hz - r) / CELL));
    const j1 = Math.min(g.rows - 1, Math.floor((hz + r) / CELL));
    for (let j = j0; j <= j1; j++) {
      const dz = (j + 0.5) * CELL - hz;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * CELL - hx;
        const idx = j * g.cols + i;
        if (dx * dx + dz * dz < r * r && g.blocked[idx] === 0) {
          g.blocked[idx] = 1;
          opened.push(idx);
        }
      }
    }
    let path: Vec2[];
    let walledIn = false;
    try {
      path = findPath(g, from, to);
      // Senza strada (lei chiude l'unico passaggio fra due tavoli) findPath
      // dà la retta, attraverso i mobili: meglio passarle accanto.
      walledIn = path.length === 2 && !lineOfSight(g, from, to);
    } finally {
      for (let k = 0; k < opened.length; k++) g.blocked[opened[k]] = 0;
      opened.length = 0;
    }
    return walledIn ? findPath(g, from, to) : path;
  }

  // La precedenza: chi cammina un percorso si ferma se un altro che cammina
  // (non della sua comitiva né della sua fila) gli è davanti, al più
  // yieldMaxMs; poi va comunque, e per altrettanto non si ferma più.
  private mustYield(a: Actor, left: number): boolean {
    if (a.yieldImmune > 0) {
      a.yieldImmune = Math.max(0, a.yieldImmune - left);
      return false;
    }
    if (!this.blockerAhead(a)) {
      a.yieldWait = 0;
      return false;
    }
    a.yieldWait += left;
    if (a.yieldWait >= this.T.yieldMaxMs) {
      a.yieldWait = 0;
      a.yieldImmune = this.T.yieldMaxMs;
      return false;
    }
    return true;
  }

  private blockerAhead(a: Actor): boolean {
    for (let i = 0; i < this.actors.length; i++) if (this.blocks(a, this.actors[i])) return true;
    for (let i = 0; i < this.roomList.length; i++) if (this.blocks(a, this.roomList[i].hostess.actor)) return true;
    for (let i = 0; i < this.waiters.length; i++) if (this.blocks(a, this.waiters[i].actor)) return true;
    return false;
  }

  private blocks(a: Actor, b: Actor): boolean {
    // La propria comitiva non ferma, tranne verso la porta: lì si va in fila,
    // e chi è davanti si aspetta anche fermo (se si è fermato per qualcun
    // altro, chi lo segue non gli finisce addosso).
    const sameOut = a.party !== null && b.party === a.party && a.outbound && b.outbound;
    if (b === a || b.dead || !b.visible || (!b.moving && !sameOut) || b.roomId !== a.roomId) return false;
    if (!sameOut && a.party !== null && b.party === a.party) return false;
    if (a.job !== null && b.job === a.job) return false;
    const v = a.view;
    return isAhead(v.x, v.z, v.yaw, b.view.x, b.view.z, this.T.yieldDistance);
  }

  private runPortal(a: Actor, seg: Extract<Seg, { k: 'portal' }>, left: number): number {
    const v = a.view;
    const T = this.T;
    const room = this.rooms.get(a.roomId);
    if (!room) {
      v.fade = seg.dir > 0 ? 1 : 0;
      return left;
    }
    if (!a.started) {
      a.started = true;
      const target = seg.dir > 0 ? room.anchors.inside : room.anchors.outside;
      a.ex = target.x;
      a.ez = target.z;
    }
    const dx = a.ex - v.x;
    const dz = a.ez - v.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const speed = seg.speed > 0 ? seg.speed : T.guestSpeed;
    const adv = (speed * left) / 1000;
    const dtS = left / 1000;
    if (d > EPS) v.yaw = turnToward(v.yaw, Math.atan2(dx, dz), T.yawRate * dtS);
    if (adv >= d) {
      v.x = a.ex;
      v.z = a.ez;
      v.fade = seg.dir > 0 ? 1 : 0;
      if (d > EPS) {
        v.phase = advancePhase(v.phase, d, a.stride);
        a.moving = true;
      }
      return Math.max(0, left - (d / speed) * 1000);
    }
    v.x += (dx / d) * adv;
    v.z += (dz / d) * adv;
    v.fade = this.portalFade(room, v.x, v.z);
    v.phase = advancePhase(v.phase, adv, a.stride);
    v.walk = easeWalk(v.walk, 1, dtS);
    a.moving = true;
    return -1;
  }

  // Il cane accanto al padrone, con la sua stessa opacità: dal lato dove già
  // sta (comparendo, la destra), finché lì c'è posto; finisce quando il
  // padrone arriva al suo punto d'approccio, si siede o esce.
  private runFollow(a: Actor, seg: Extract<Seg, { k: 'follow' }>, left: number): number {
    const o = a.owner;
    if (!o || o.dead || o.arrived) return left;
    const v = a.view;
    const ov = o.view;
    const T = this.T;
    const shown = o.visible && (!seg.job || o.peeled || o.colMode !== COL_HIDDEN);
    if (!shown) {
      if (a.visible) {
        a.visible = false;
        this.dirty();
      }
      a.roomId = o.roomId;
      v.x = ov.x;
      v.z = ov.z;
      return -1;
    }
    const room = this.rooms.get(o.roomId);
    const dtS0 = left / 1000;
    // La direzione del padrone, smorzata (syaw: il passo 'follow' non usa
    // 'turn'): alle svolte secche il posto accanto a lui gira con calma.
    if (!a.started) {
      a.started = true;
      a.syaw = ov.yaw;
    }
    a.syaw = turnToward(a.syaw, ov.yaw, DOG_SIDE_TURN * dtS0);
    if (a.sideOwner !== o) {
      // Un padrone nuovo: il lato dove il cane gli sta già; comparendo, la
      // destra se c'è posto. La sinistra di chi guarda verso (sin ψ, cos ψ)
      // è (cos ψ, −sin ψ).
      a.sideOwner = o;
      const dx0 = v.x - ov.x;
      const dz0 = v.z - ov.z;
      let start = -1;
      if (a.visible && dx0 * dx0 + dz0 * dz0 > 0.01) start = dx0 * Math.cos(a.syaw) - dz0 * Math.sin(a.syaw) > 0 ? 1 : -1;
      else if (!this.dogSpotClear(a, o, room, -1) && this.dogSpotClear(a, o, room, 1)) start = 1;
      a.side = start;
      a.sideU = start;
    }
    // Di lato se lì c'è posto; se no in diagonale dietro, sullo stesso lato
    // (fra lui e chi lo segue in fila, che sta 0,7–0,8 m dietro, c'è
    // spazio); se no ancora più dietro. Mai dall'altra parte.
    let goal = a.side;
    if (!this.dogSpotClear(a, o, room, a.side)) {
      goal = this.dogSpotClear(a, o, room, a.side * 0.5) ? a.side * 0.5 : a.side * 0.25;
    }
    const du = (DOG_SWAP_TURN * dtS0) / (Math.PI / 2);
    a.sideU = a.sideU < goal ? Math.min(goal, a.sideU + du) : Math.max(goal, a.sideU - du);
    const beta = dogAngle(a.syaw, a.sideU);
    const tx = ov.x + Math.sin(beta) * T.dogBeside;
    const tz = ov.z + Math.cos(beta) * T.dogBeside;
    if (!a.visible) {
      a.visible = true;
      a.roomId = o.roomId;
      v.x = tx;
      v.z = tz;
      v.yaw = ov.yaw;
      v.fade = ov.fade;
      v.seat = 0;
      this.dirty();
      return -1;
    }
    if (a.roomId !== o.roomId) {
      a.roomId = o.roomId;
      this.dirty();
    }
    const dx = tx - v.x;
    const dz = tz - v.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const dtS = left / 1000;
    // Al passo della fila che segue (×f), anche quando rincorre.
    const stepLen = (seg.speed > 0 ? seg.speed : T.catchUpSpeed) * (a.job ? a.job.f : 1) * dtS;
    if (d > 1e-4 && stepLen > 0) {
      const k = Math.min(1, stepLen / d);
      const px = v.x;
      const pz = v.z;
      v.x += dx * k;
      v.z += dz * k;
      this.keepDogClear(a, room, px, pz);
      const mx = v.x - px;
      const mz = v.z - pz;
      const moved = Math.sqrt(mx * mx + mz * mz);
      v.yaw = turnToward(v.yaw, d > DOG_CHASE ? Math.atan2(dx, dz) : a.syaw, T.yawRate * dtS);
      if (moved > 1e-6) {
        v.phase = advancePhase(v.phase, moved, a.stride);
        v.walk = easeWalk(v.walk, 1, dtS);
        a.moving = true;
      }
    } else {
      v.yaw = turnToward(v.yaw, a.syaw, T.yawRate * dtS);
    }
    v.fade = ov.fade;
    return -1;
  }

  // Il cane rincorre il suo posto in linea retta: se così finirebbe addosso a
  // qualcuno (l'hostess che presenta il tavolo, un cameriere, chi lo segue in
  // fila) scivola sul bordo del suo spazio e lo aggira; se questo lo porta su
  // un mobile, aspetta un passo dov'era. Il padrone gli passava a 36 cm
  // dall'hostess, e il cane, dal suo lato, le finiva dentro.
  private keepDogClear(a: Actor, room: RoomRt | null | undefined, px: number, pz: number): void {
    let pushed = false;
    for (let i = 0; i < this.actors.length; i++) {
      const b = this.actors[i];
      pushed = this.pushOff(a, b, b.party !== null && b.party === a.party ? DOG_KEEP_OWN : DOG_CLEAR) || pushed;
    }
    if (room) pushed = this.pushOff(a, room.hostess.actor, DOG_CLEAR) || pushed;
    for (let i = 0; i < this.waiters.length; i++) pushed = this.pushOff(a, this.waiters[i].actor, DOG_CLEAR) || pushed;
    // E chi sta fermo in piedi (all'ingresso, «In uscita») o un altro cane,
    // disegnati da People.
    const figs = room && Array.isArray(room.model.figures) ? room.model.figures : null;
    if (figs) {
      for (let i = 0; i < figs.length; i++) {
        const f = figs[i];
        if (!f || f.key === a.view.key || this.owned.has(f.key)) continue;
        const standing = (f.kind === 'adult' || f.kind === 'kid') && f.pose === 'standing';
        if (standing || f.kind === 'dog') pushed = pushPoint(a.view, f.x, f.z, DOG_CLEAR) || pushed;
      }
    }
    const v = a.view;
    if (pushed && room && cellAt(room.grid, v.x, v.z) >= 0 && !isFree(room.grid, v.x, v.z)) {
      v.x = px;
      v.z = pz;
    }
  }

  // Sposta il cane `a` fuori dal disco di raggio `min` attorno a `b` (in
  // piedi e visibile nella sua sala), lungo la loro congiungente.
  private pushOff(a: Actor, b: Actor, min: number): boolean {
    if (b === a || b.dead || !b.visible || b.roomId !== a.roomId) return false;
    if (b.isPerson && b.view.seat >= 0.5) return false;
    return pushPoint(a.view, b.view.x, b.view.z, min);
  }

  // Il posto `u` accanto al padrone (−1 destra, 0 dietro, +1 sinistra) è
  // buono: non su un mobile (fuori dalla griglia, sulla soglia, sì) e nessuno
  // a meno di DOG_CLEAR, tranne la sua comitiva (in fila sta davanti e dietro,
  // non di lato, e contarla lo farebbe cambiare lato a ogni curva).
  private dogSpotClear(a: Actor, o: Actor, room: RoomRt | null | undefined, u: number): boolean {
    const beta = dogAngle(a.syaw, u);
    const x = o.view.x + Math.sin(beta) * this.T.dogBeside;
    const z = o.view.z + Math.cos(beta) * this.T.dogBeside;
    if (room && cellAt(room.grid, x, z) >= 0 && !isFree(room.grid, x, z)) return false;
    for (let i = 0; i < this.actors.length; i++) {
      const b = this.actors[i];
      if (b.party !== null && b.party === a.party) continue;
      if (crowds(b, a, o, x, z)) return false;
    }
    if (room && crowds(room.hostess.actor, a, o, x, z)) return false;
    for (let i = 0; i < this.waiters.length; i++) if (crowds(this.waiters[i].actor, a, o, x, z)) return false;
    return true;
  }

  // Torna a People solo se coincide con la figura statica più recente: stessa
  // sala, stesso punto, stessa posa, le gambe ferme.
  private runRelease(a: Actor, left: number): number {
    const v = a.view;
    const room = this.rooms.get(a.roomId);
    const fig = room?.figByKey.get(v.key);
    if (!fig || (a.party && fig.partyId !== a.party.id)) {
      this.setPlan(a, [sFade(0, this.T.fadeMs), S_REMOVE]);
      return left;
    }
    if (a.slot && !slotEqual(fig, a.slot)) {
      this.setPlan(a, [...this.comeBack(a), sGoSlot(this.guestSpeed(a.party, a), 1, 0)]);
      return left;
    }
    if (v.walk > 0) return -1;
    v.x = fig.x;
    v.z = fig.z;
    v.yaw = fig.yaw;
    v.seatHeight = fig.seatHeight;
    v.seat = seatOf(fig);
    v.pose = fig.pose;
    v.fade = 1;
    v.walk = 0;
    this.kill(a);
    return left;
  }

  /* ── I camerieri (§5.8) ──────────────────────────────────────────── */

  private waiterStill(): boolean {
    const s = this.settings;
    return s.reducedMotion || s.slowMode || s.lightMode;
  }

  private idleFor(w: Waiter): number {
    const T = this.T;
    return this.settings.pinned
      ? uniform(w.rng, T.waiterIdlePinnedMinMs, T.waiterIdlePinnedMaxMs)
      : uniform(w.rng, T.waiterIdleMinMs, T.waiterIdleMaxMs);
  }

  // Chi c'è e dove: dal personale di turno e dalle persone a tavola. Un
  // cambio vale fra un compito e l'altro (al pass), salvo a un azzeramento o
  // da fermi, dove vale subito.
  private syncWaiters(reset: boolean): void {
    const s = this.settings;
    if (s.lightMode || this.model === null) {
      if (this.waiters.length > 0) {
        for (const w of this.waiters) w.actor.dead = true;
        this.waiters = [];
        this.dirty();
      }
      return;
    }
    const anyPresent = this.roomList.some(r => finite(r.model.summary?.seated, 0) > 0);
    const { waiters: seeds } = splitStaff(s.staff, anyPresent);
    const alloc = allocateWaiters(
      seeds,
      this.roomList.map(r => ({ id: r.id, covers: finite(r.model.summary?.seated, 0) })),
      s.activeRoomId,
    );
    const desired = new Map<string, { roomId: number; slot: number; label: string | null; order: number }>();
    for (const [roomId, list] of alloc) {
      list.forEach((seed, i) => desired.set(seed.key, { roomId, slot: i, label: seed.label, order: seeds.indexOf(seed) }));
    }
    const still = s.reducedMotion || s.slowMode;
    const keep: Waiter[] = [];
    let changed = false;
    for (const w of this.waiters) {
      const d = desired.get(w.key);
      const home = this.rooms.has(w.actor.roomId);
      if (!d) {
        if (reset || still || !home) {
          w.actor.dead = true;
          changed = true;
          continue;
        }
        w.leaving = true;
        w.wantRoom = null;
        keep.push(w);
        continue;
      }
      desired.delete(w.key);
      w.leaving = false;
      w.order = d.order;
      if (w.actor.view.label !== d.label) {
        w.actor.view.label = d.label;
        changed = true;
      }
      if (reset || still || !home) {
        this.placeWaiter(w, d.roomId, d.slot, still ? 0 : this.idleFor(w));
        changed = true;
      } else if (w.actor.roomId !== d.roomId || w.slot !== d.slot) {
        w.wantRoom = d.roomId;
        w.wantSlot = d.slot;
      } else {
        w.wantRoom = null;
      }
      keep.push(w);
    }
    for (const [key, d] of desired) {
      const actor = this.makeActor(key, 'waiter', null, d.roomId, 0, 0, 0, 0, 0, 0);
      actor.visible = true;
      actor.view.label = d.label;
      const w: Waiter = {
        actor,
        key,
        rng: staffRng(this.seed, key),
        state: 'AT_PASS',
        timer: 0,
        nextIdle: 0,
        partyId: null,
        tableId: null,
        slot: d.slot,
        wantRoom: null,
        wantSlot: 0,
        leaving: false,
        order: d.order,
      };
      if (reset || still) {
        this.placeWaiter(w, d.roomId, d.slot, still ? 0 : this.idleFor(w));
      } else {
        this.placeWaiter(w, d.roomId, d.slot, 0);
        w.state = 'FADE_IN';
        actor.view.fade = 0;
      }
      keep.push(w);
      changed = true;
    }
    keep.sort((x, y) => x.order - y.order);
    this.waiters = keep;
    if (changed) this.dirty();
  }

  private placeWaiter(w: Waiter, roomId: number, slot: number, timer: number): void {
    const room = this.rooms.get(roomId);
    const v = w.actor.view;
    w.actor.roomId = roomId;
    w.slot = slot;
    w.state = 'AT_PASS';
    w.timer = timer;
    w.partyId = null;
    w.tableId = null;
    w.wantRoom = null;
    v.walk = 0;
    v.fade = 1;
    v.tray = false;
    v.seat = 0;
    if (room) {
      const spot = this.passSpot(room, slot);
      v.x = spot.x;
      v.z = spot.z;
      v.yaw = spot.yaw;
    }
    this.setPlan(w.actor, []);
  }

  // Il posto i-esimo al pass, sulle celle libere della griglia di adesso: si
  // ricalcola quando la griglia cambia (un tavolo spostato, chi aspetta in
  // piedi), mai nel frame.
  private passSpot(room: RoomRt, i: number): Spot {
    if (room.passKey !== room.navKey || room.passSpots.length <= i) {
      room.passSpots = passSlots(room.model, room.anchors, room.grid, Math.max(i + 1, PASS_SPOTS));
      room.passKey = room.navKey;
    }
    return room.passSpots[i];
  }

  private refreshCandidates(): void {
    this.candDirty = false;
    for (const room of this.roomList) room.candCount = 0;
    if (!this.memo) return;
    for (const m of this.memo.values()) {
      if (!atTable(m.state.phase) || m.state.roomId === null) continue;
      const p = this.parties.get(m.state.id);
      if (p && p.job) continue;
      const room = this.rooms.get(m.state.roomId);
      if (room) room.candCount++;
    }
  }

  private candidatesIn(room: RoomRt): VisitCandidate[] {
    const out: VisitCandidate[] = [];
    if (!this.memo) return out;
    for (const m of this.memo.values()) {
      if (!atTable(m.state.phase) || m.state.roomId !== room.id || m.state.tableId === null) continue;
      if (!room.tables.has(m.state.tableId)) continue;
      const p = this.parties.get(m.state.id);
      if (!p || p.job) continue;
      out.push({ partyId: p.id, visits: p.visits, seatedAt: p.seatedAt, lastVisitAt: p.lastVisitAt });
    }
    return out;
  }

  private walkingIn(roomId: number): number {
    let n = 0;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.actor.dead || w.actor.roomId !== roomId) continue;
      if (w.state === 'TO_TABLE' || w.state === 'SERVE' || w.state === 'TO_PASS') n++;
    }
    return n;
  }

  private canDepart(room: RoomRt): boolean {
    if (this.walkingIn(room.id) >= this.T.walkingWaitersMax) return false;
    let taken = 0;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      if (w.actor.dead || w.actor.roomId !== room.id || w.partyId === null) continue;
      if (w.state !== 'TO_TABLE' && w.state !== 'SERVE') continue;
      let dup = false;
      for (let j = 0; j < i; j++) {
        const o = this.waiters[j];
        if (o.partyId === w.partyId && o.actor.roomId === room.id && (o.state === 'TO_TABLE' || o.state === 'SERVE')) dup = true;
      }
      if (!dup) taken++;
    }
    return room.candCount > taken;
  }

  private tryDepart(w: Waiter): boolean {
    const room = this.rooms.get(w.actor.roomId);
    if (!room) return false;
    if (this.candDirty) this.refreshCandidates();
    if (!this.canDepart(room)) return false;
    const taken = new Set<number>();
    for (const o of this.waiters) {
      if (o !== w && !o.actor.dead && o.actor.roomId === room.id && o.partyId !== null && (o.state === 'TO_TABLE' || o.state === 'SERVE')) {
        taken.add(o.partyId);
      }
    }
    const pid = pickVisit(this.candidatesIn(room), taken, this.simT, w.rng);
    if (pid === null) return false;
    return this.sendWaiter(w, room, pid);
  }

  private sendWaiter(w: Waiter, room: RoomRt, partyId: number): boolean {
    const m = this.memo?.get(partyId);
    const table = m && m.state.tableId !== null ? room.tables.get(m.state.tableId) : undefined;
    if (!table) return false;
    const T = this.T;
    const spot = tableSidePoint(table, room.anchors.passFront, room.grid, T.serviceGap, T.serviceGap);
    w.partyId = partyId;
    w.tableId = table.id;
    w.state = 'TO_TABLE';
    w.actor.view.tray = true;
    this.setPlan(w.actor, [sWalk(spot.x, spot.z, T.waiterSpeed), sTurn(spot.yaw, T.turnMs)]);
    return true;
  }

  private waiterToPass(w: Waiter): void {
    const room = this.rooms.get(w.actor.roomId);
    w.state = 'TO_PASS';
    w.partyId = null;
    w.tableId = null;
    w.actor.view.tray = false;
    if (!room) return;
    const spot = this.passSpot(room, w.slot);
    this.setPlan(w.actor, [sWalk(spot.x, spot.z, this.T.waiterSpeed), sTurn(spot.yaw, this.T.turnMs)]);
  }

  // Al pass (o in pausa) un cambio di sala, di posto o di turno si applica.
  private applyWant(w: Waiter): void {
    if (w.leaving || (w.wantRoom !== null && w.wantRoom !== w.actor.roomId)) {
      w.state = 'FADE_OUT';
      return;
    }
    if (w.wantRoom !== null) {
      w.slot = w.wantSlot;
      w.wantRoom = null;
      this.waiterToPass(w);
    }
  }

  private stepWaiters(dtT: number, dtM: number): void {
    if (this.waiterStill() || this.waiters.length === 0) return;
    const T = this.T;
    const dtS = dtM / 1000;
    let removed = false;
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const a = w.actor;
      const v = a.view;
      if (a.dead) {
        removed = true;
        continue;
      }
      switch (w.state) {
        case 'AT_PASS':
          a.moving = false;
          if (w.leaving || w.wantRoom !== null) {
            this.applyWant(w);
            break;
          }
          w.timer -= dtT;
          if (w.timer <= 0) {
            w.timer = 0;
            this.tryDepart(w);
          }
          break;
        case 'TO_TABLE':
          this.runPlan(a, dtM);
          if (a.pi >= a.plan.length && v.walk === 0) {
            w.state = 'SERVE';
            w.timer = uniform(w.rng, T.serveMinMs, T.serveMaxMs);
            const p = w.partyId !== null ? this.parties.get(w.partyId) : undefined;
            if (p) {
              p.visits += 1;
              p.lastVisitAt = this.simT;
            }
          }
          break;
        case 'SERVE':
          a.moving = false;
          v.walk = easeWalk(v.walk, 0, dtS);
          w.timer -= dtT;
          if (w.timer <= 0) this.waiterToPass(w);
          break;
        case 'TO_PASS':
          this.runPlan(a, dtM);
          if (a.pi >= a.plan.length && v.walk === 0) {
            w.state = 'PAUSE';
            w.timer = T.passPauseMs;
            w.nextIdle = this.idleFor(w);
          }
          break;
        case 'PAUSE':
          a.moving = false;
          if (w.leaving || w.wantRoom !== null) {
            this.applyWant(w);
            break;
          }
          w.timer -= dtT;
          if (w.timer <= 0) {
            // Il tempo passato oltre la pausa vale già per l'attesa al pass:
            // wakeInMs sveglia il canvas a pausa + attesa, e buttarlo via
            // farebbe aspettare il cameriere due volte (uno schermo fermo
            // girerebbe diverso da uno che disegna).
            w.state = 'AT_PASS';
            w.timer += w.nextIdle;
            if (w.timer <= 0) {
              w.timer = 0;
              this.tryDepart(w);
            }
          }
          break;
        case 'FADE_OUT':
          v.fade = Math.max(0, v.fade - dtM / Math.max(1, T.fadeMs));
          if (v.fade <= 0) {
            if (w.leaving) {
              a.dead = true;
              removed = true;
            } else {
              // Verso la sala nuova; o di nuovo qui, se nel frattempo la
              // divisione è tornata com'era.
              const to = w.wantRoom !== null && this.rooms.has(w.wantRoom) ? w.wantRoom : a.roomId;
              this.placeWaiter(w, to, to === w.wantRoom ? w.wantSlot : w.slot, 0);
              v.fade = 0;
              w.state = 'FADE_IN';
            }
            this.dirty();
          }
          break;
        case 'FADE_IN':
          v.fade = Math.min(1, v.fade + dtM / Math.max(1, T.fadeMs));
          if (v.fade >= 1) {
            w.state = 'AT_PASS';
            w.timer = this.idleFor(w);
          }
          break;
      }
      if (w.state !== 'TO_TABLE' && w.state !== 'TO_PASS') {
        v.walk = easeWalk(v.walk, 0, dtS);
      }
    }
    if (removed) {
      let j = 0;
      for (let i = 0; i < this.waiters.length; i++) {
        const w = this.waiters[i];
        if (!w.actor.dead) this.waiters[j++] = w;
      }
      this.waiters.length = j;
      this.dirty();
    }
  }

  // Dopo un update: chi va verso una comitiva che non c'è più (o ha cambiato
  // tavolo) ne sceglie un'altra, o torna al pass.
  private revalidateWaiters(): void {
    if (this.waiterStill()) return;
    for (const w of this.waiters) {
      if (w.actor.dead || (w.state !== 'TO_TABLE' && w.state !== 'SERVE') || w.partyId === null) continue;
      const m = this.memo?.get(w.partyId);
      const p = this.parties.get(w.partyId);
      const ok = !!m && atTable(m.state.phase) && m.state.roomId === w.actor.roomId && m.state.tableId === w.tableId && !!p && !p.job;
      if (ok) continue;
      const room = this.rooms.get(w.actor.roomId);
      w.partyId = null;
      w.tableId = null;
      if (room && this.tryRepick(w, room)) continue;
      this.waiterToPass(w);
    }
  }

  private tryRepick(w: Waiter, room: RoomRt): boolean {
    const taken = new Set<number>();
    for (const o of this.waiters) {
      if (o !== w && !o.actor.dead && o.actor.roomId === room.id && o.partyId !== null && (o.state === 'TO_TABLE' || o.state === 'SERVE')) {
        taken.add(o.partyId);
      }
    }
    const pid = pickVisit(this.candidatesIn(room), taken, this.simT, w.rng);
    return pid !== null && this.sendWaiter(w, room, pid);
  }

  /* ── Tutto in fondo, subito ──────────────────────────────────────── */

  private completeAll(): void {
    for (const room of this.roomList) {
      const jobs = [...room.queue, ...room.active];
      room.queue.length = 0;
      room.active.length = 0;
      for (const job of jobs) {
        const p = job.party;
        if (p.job === job) p.job = null;
        p.visits = 0;
        p.seatedAt = this.simT;
        p.lastVisitAt = this.simT;
      }
      this.hostessHome(room);
      for (const job of jobs) this.emitEscortEnd(job, true);
    }
    for (const a of this.actors) this.kill(a);
    for (const p of this.parties.values()) {
      p.script = null;
      p.job = null;
    }
    for (const w of this.waiters) {
      if (w.actor.dead) continue;
      if (w.leaving) {
        w.actor.dead = true;
        continue;
      }
      const roomId = w.wantRoom !== null && this.rooms.has(w.wantRoom) ? w.wantRoom : w.actor.roomId;
      const slot = w.wantRoom !== null ? w.wantSlot : w.slot;
      this.placeWaiter(w, roomId, slot, this.waiterStill() ? 0 : this.idleFor(w));
    }
    this.waiters = this.waiters.filter(w => !w.actor.dead);
    this.candDirty = true;
    this.compact();
  }

  /* ── Aiuti dello stato ───────────────────────────────────────────── */

  private ensureParty(id: number, ref?: PartyRef): PartyRt {
    let p = this.parties.get(id);
    if (p) {
      if (ref) p.ref = ref;
    } else {
      const rng = partyRng(this.serviceKey ?? '', id);
      const jitter = uniform(rng, 1 - SPEED_JITTER, 1 + SPEED_JITTER);
      p = {
        id,
        ref: ref ?? { id, name: null, adults: 1, kids: 0, dogs: 0 },
        rng,
        jitter,
        script: null,
        since: this.simT,
        actors: [],
        job: null,
        visits: 0,
        seatedAt: this.simT,
        lastVisitAt: this.simT,
      };
      this.parties.set(id, p);
    }
    return p;
  }

  private guestSpeed(p: PartyRt | null, a: Actor | null): number {
    const base = this.T.guestSpeed * (p ? p.jitter : 1);
    return a && a.isDog ? Math.max(base, this.T.guestSpeed) : base;
  }

  private hasVisible(p: PartyRt): boolean {
    for (const a of p.actors) if (!a.dead && a.visible) return true;
    return false;
  }

  private hasLive(p: PartyRt): boolean {
    for (const a of p.actors) if (!a.dead) return true;
    return false;
  }

  private makeActor(
    key: string,
    kind: ActorKind,
    party: PartyRt | null,
    roomId: number,
    x: number,
    z: number,
    yaw: number,
    seat: number,
    seatHeight: number,
    tint: number,
  ): Actor {
    const T = this.T;
    const isDog = kind === 'dog';
    const isPerson = kind === 'adult' || kind === 'kid';
    return {
      view: {
        key,
        kind,
        partyId: party ? party.id : null,
        x,
        z,
        yaw,
        pose: isDog ? (seat >= 0.5 ? 'lying' : 'standing') : isPerson && seat >= 0.5 ? 'seated' : 'standing',
        seat,
        seatHeight,
        walk: 0,
        phase: 0,
        fade: 1,
        arm: 0,
        tray: false,
        tint,
        label: null,
      },
      roomId,
      visible: false,
      dead: false,
      party,
      order: 0,
      isDog,
      isPerson,
      stride: kind === 'kid' ? T.strideKid : isDog ? T.strideDog : T.strideAdult,
      plan: [],
      pi: 0,
      t: 0,
      started: false,
      replanned: false,
      sx: 0,
      sz: 0,
      syaw: 0,
      ex: 0,
      ez: 0,
      track: null,
      path: null,
      s: 0,
      s1: 0,
      pt: { x: 0, z: 0, heading: 0, seg: 0 },
      moving: false,
      yieldWait: 0,
      yieldImmune: 0,
      owner: null,
      outbound: false,
      arrived: false,
      side: -1,
      sideU: -1,
      sideOwner: null,
      slot: null,
      slotRoom: roomId,
      job: null,
      col: 0,
      colMode: COL_HIDDEN,
      colS: 0,
      peeled: false,
    };
  }

  // Un attore della comitiva per una figura, nascosto: compare quando il suo
  // piano lo dice.
  private newActor(p: PartyRt, key: string, slot: FigureSlot, roomId: number): Actor {
    const old = this.owned.get(key);
    if (old) this.kill(old);
    const kind: ActorKind = slot.kind === 'hostess' ? 'adult' : slot.kind;
    const a = this.makeActor(key, kind, p, roomId, slot.x, slot.z, slot.yaw, seatOf(slot), slot.seatHeight, finite(slot.tint, 0));
    a.order = figureOrder(key, p.ref);
    this.adopt(p, a);
    return a;
  }

  // Un attore che parte da una figura statica che People disegnava: visibile,
  // nello stesso punto e nella stessa posa.
  private spawnAt(p: PartyRt, key: string, slot: FigureSlot, roomId: number): Actor {
    const a = this.newActor(p, key, slot, roomId);
    a.visible = true;
    return a;
  }

  private adopt(p: PartyRt, a: Actor): void {
    let i = p.actors.length;
    while (i > 0 && p.actors[i - 1].order > a.order) i--;
    p.actors.splice(i, 0, a);
    this.actors.push(a);
    this.owned.set(a.view.key, a);
    this.dirty();
  }

  private detach(a: Actor): void {
    a.job = null;
    a.peeled = false;
    a.colMode = COL_HIDDEN;
    a.owner = null;
  }

  private kill(a: Actor): void {
    if (a.dead) return;
    a.dead = true;
    a.visible = false;
    if (this.owned.get(a.view.key) === a) this.owned.delete(a.view.key);
    this.dirty();
  }

  private compact(): void {
    let j = 0;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      if (!a.dead) this.actors[j++] = a;
    }
    if (j === this.actors.length) return;
    this.actors.length = j;
    for (const p of this.partyOrder) {
      let k = 0;
      for (let i = 0; i < p.actors.length; i++) {
        const a = p.actors[i];
        if (!a.dead) p.actors[k++] = a;
      }
      p.actors.length = k;
      if (k === 0 && !p.job && p.script !== null) p.script = null;
    }
  }

  // Le comitive uscite dal memo e senza più niente in scena si dimenticano.
  private prune(): void {
    this.compact();
    for (const [id, p] of this.parties) {
      if (this.memo?.has(id)) continue;
      if (p.job || this.hasLive(p)) continue;
      this.parties.delete(id);
    }
    this.partyOrder = this.partyOrder.filter(p => this.parties.get(p.id) === p);
    for (const p of this.parties.values()) if (!this.partyOrder.includes(p)) this.partyOrder.push(p);
  }

  private dropRoom(room: RoomRt): void {
    for (const job of [...room.queue, ...room.active]) {
      for (const m of job.party.actors) if (m.roomId === room.id) this.kill(m);
      this.cancelJob(job, true);
      this.emitEscortEnd(job, false);
    }
    for (const a of this.actors) if (a.roomId === room.id) this.kill(a);
    this.rooms.delete(room.id);
  }

  private refreshLabels(): void {
    const name = hostessName(this.settings.staff);
    for (const room of this.roomList) {
      const label = room.id === this.mainRoomId ? name : null;
      const v = room.hostess.actor.view;
      if (v.label !== label) {
        v.label = label;
        this.dirty();
      }
    }
  }

  private dirty(): void {
    this.rev++;
  }

  private now(): number {
    const t = this.clock();
    return typeof t === 'number' && Number.isFinite(t) ? t : 0;
  }

  private emit(event: DirectorEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(event);
      } catch {
        // Un ascoltatore che si rompe non deve rompere il regista.
      }
    }
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch {
        // Come sopra.
      }
    }
  }
}

/* ── La tabella dei passaggi (§5.4) ───────────────────────────────────── */

function rowOf(prev: PartyMemo | undefined, next: PartyMemo | undefined): number {
  const a = phaseOf(prev);
  const b = phaseOf(next);
  const aOff = !onFloor(a);
  const bOff = !onFloor(b);
  if (aOff && bOff) return 16;
  if ((a === 'absent' || a === 'waiting') && atTable(b)) return 1;
  if ((a === 'absent' || a === 'waiting') && b === 'lobby') return 2;
  if (a === 'hidden' && atTable(b)) return 3;
  if (a === 'hidden' && b === 'lobby') return 4;
  if (a === 'lobby' && atTable(b)) return prev!.state.roomId === next!.state.roomId ? 5 : 6;
  if (a === 'lobby' && b === 'lobby') return 7;
  if (a === 'lobby' && bOff) return 8;
  if (atTable(a) && atTable(b)) {
    if (prev!.state.tableId === next!.state.tableId && prev!.state.roomId === next!.state.roomId) {
      if (a === b) return 17;
      return a === 'seated' ? 9 : 10;
    }
    return prev!.state.roomId === next!.state.roomId ? 11 : 12;
  }
  if (atTable(a) && (b === 'absent' || b === 'hidden')) return 13;
  if (atTable(a) && b === 'waiting') return 14;
  if (atTable(a) && b === 'lobby') return 15;
  return 16;
}

// Sposta la vista fuori dal disco di raggio `min` attorno a (x, z), lungo la
// congiungente; false se ne era già fuori (o ci stava esattamente sopra).
function pushPoint(v: ActorView, x: number, z: number, min: number): boolean {
  const dx = v.x - x;
  const dz = v.z - z;
  const d2 = dx * dx + dz * dz;
  if (d2 >= min * min || d2 < 1e-12) return false;
  const d = Math.sqrt(d2);
  v.x = x + (dx / d) * min;
  v.z = z + (dz / d) * min;
  return true;
}

// `b` sta a meno di DOG_CLEAR dal punto (x, z), nella sala del padrone: né il
// cane né il padrone stesso. Una funzione e non una chiusura: si chiama a ogni
// frame per ogni cane in cammino.
function crowds(b: Actor, dog: Actor, owner: Actor, x: number, z: number): boolean {
  if (b === dog || b === owner || b.dead || !b.visible || b.roomId !== owner.roomId) return false;
  const dx = b.view.x - x;
  const dz = b.view.z - z;
  return dx * dx + dz * dz < DOG_CLEAR * DOG_CLEAR;
}

// La lunghezza di una spezzata (Math.sqrt come makeTrack: gli stessi numeri
// su ogni schermo).
function pathLength(path: readonly Vec2[]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const dx = path[i].x - path[i - 1].x;
    const dz = path[i].z - path[i - 1].z;
    len += Math.sqrt(dx * dx + dz * dz);
  }
  return len;
}

// La direzione (come uno yaw) del posto del cane accanto a chi guarda verso
// `yaw`: u −1 a destra, 0 dietro, +1 a sinistra, passando sempre da dietro.
function dogAngle(yaw: number, u: number): number {
  return yaw - (Math.PI / 2) * (u + 2);
}

// I tavoli disegnati toccati dai passaggi che contano: quello che si lascia
// e quello dove si arriva, una volta ciascuno.
function tablesTouched(trs: readonly Transition[]): number {
  const seen = new Set<string>();
  for (const tr of trs) {
    if (!tr.counts) continue;
    for (const m of [tr.prev, tr.next]) {
      if (m && atTable(m.state.phase) && m.state.roomId !== null && m.state.tableId !== null) {
        seen.add(`${m.state.roomId}:${m.state.tableId}`);
      }
    }
  }
  return seen.size;
}

/* ── Il personale, confrontato e copiato ──────────────────────────────── */

const copyStaff = (s: StaffOnShift): StaffOnShift => ({
  id: typeof s?.id === 'string' ? s.id : String(s?.id ?? ''),
  name: typeof s?.name === 'string' ? s.name : '',
  role: typeof s?.role === 'string' ? s.role : null,
});

function sameStaff(a: readonly StaffOnShift[] | null | undefined, b: readonly StaffOnShift[] | null | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (!x || !y || x.id !== y.id || x.name !== y.name || (x.role ?? null) !== (y.role ?? null)) return false;
  }
  return true;
}
