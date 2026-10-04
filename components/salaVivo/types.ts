import type {
  BanquetMenu,
  FloorMarker,
  FloorMarkerKind,
  Reservation,
  Room,
  Shift,
  Table,
  TableMerge,
} from '../../types';
import type { TableDisplayStatus } from '../TableGlyph';

/* Il contratto della Sala dal vivo: i tipi che passano fra App, la pagina, il
 * modello puro e la scena 3D. SOLO TIPI, niente codice.
 *
 * Perché un file a sé: pagina, modello e scena li scrivono mani diverse e
 * finiscono in chunk diversi. La pagina (e con lei il modello) non importa mai
 * three né la scena, o il chunk 3D finirebbe su ogni palmare e su ogni schermo
 * di cucina: qui dentro non c'è niente di three, e un `import type` sparisce
 * dalla build. Lo controlla tests/unit/boundaries.test.ts.
 *
 * Le misure del modello sono in metri, nel mondo della scena: X verso destra,
 * Y in alto, Z verso il basso della piantina. Un px della tela della sala vale
 * 2 cm, quindi X = x·0,02 e Z = y·0,02 di tables.x/y: guardata dal bordo basso
 * della mappa, la sala in 3D ha la stessa destra e la stessa sinistra della 2D.
 */

// Ripreso da qui così la scena ha una porta sola per i tipi del contratto.
export type { TableDisplayStatus };

/** Le prop che App passa alla pagina, caricata a richiesta (React.lazy).
 *  Dati e orologio sono quelli di App, tenuti aggiornati dai suoi gestori
 *  socket: la pagina non ricarica sale, tavoli e prenotazioni per conto suo. */
export interface SalaVivoPageProps {
  rooms: Room[];
  tables: Table[];
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  /** Il primo caricamento di App è ancora in corso: senza, la sala
   *  comparirebbe vuota per un attimo e poi si riempirebbe. */
  isInitialLoading: boolean;
  /** Cresce di uno a ogni ricarica completa delle prenotazioni (fetchData di
   *  App: connessione e riconnessione del socket, ritorno in primo piano,
   *  pageshow, dopo lo svuotamento della coda offline), nello stesso commit
   *  di setReservations. Dice alla pagina che quel cambio è un riallineamento
   *  in blocco e non una cosa successa adesso: il regista lo mette in scena
   *  già concluso (SnapReason 'refetch'), invece di far entrare dalla porta
   *  tre comitive arrivate mentre il tablet era senza rete. Un arrivo vero
   *  dopo un buco del Wi-Fi arriva da un evento socket, senza epoca nuova, e
   *  si anima. */
  reservationsEpoch: number;
  /** Lo stato del socket: la LivePill della pagina, che qui non ha la
   *  testata di App sopra. */
  isConnected: boolean;
  /** L'orologio di App, allineato al minuto. Muove la LivePill e decide il
   *  servizio in corso: uno solo per tutta l'app, così alle 17:00 il cambio di
   *  servizio arriva qui nello stesso istante della testata. */
  currentTime: Date;
  /** hasPermission('floorplan:full'): mostra «Posizionali» e «Disponi i
   *  tavoli». Arriva da App per non legare la pagina all'AuthContext. */
  canEditFloor: boolean;
  /** Chiede ad App la modalità chiosco: true nasconde la barra laterale e
   *  quella in basso. La pagina la rimette a false quando si smonta, anche per
   *  un crash: uno schermo fissato non resta mai senza navigazione. */
  onImmersive: (on: boolean) => void;
  /** Apre Sale & Tavoli, sulla sala indicata se c'è. */
  onOpenFloorPlan: (focus?: FloorPlanFocus) => void;
}

/** Su quale sala aprire Sale & Tavoli. Dal #801 la piantina mostra sempre le
 *  posizioni salvate, segnaposto compresi: basta la sala, non c'è più una
 *  modalità da accendere. */
export interface FloorPlanFocus {
  roomId: number;
}

/** Il servizio che la pagina mostra: sempre quello in corso nel fuso del
 *  ristorante (currentService di utils/displayTime), mai la data scelta in
 *  testata, perché un tablet all'ingresso deve dire com'è la sala adesso. */
export interface LiveService {
  /** Il giorno di servizio, YYYY-MM-DD: alle 00:30 è ancora quello di ieri. */
  date: string;
  shift: Shift;
  /** `${date}:${shift}`: una stringa sola da mettere fra le dipendenze. */
  key: string;
}

/** Un punto sul pavimento, in metri. */
export interface Vec2 {
  x: number;
  z: number;
}

/** Una sedia, nel mondo. `chairs[i]` è la sedia `i` di getChairSlots, lo
 *  stesso ordine del glifo 2D: gli ospiti si siedono per indice. L'unica
 *  eccezione è il tondo che trabocca (vedi TableModel.chairs). */
export interface ChairModel {
  /** Il centro della sedia sul pavimento, in metri. */
  x: number;
  z: number;
  /** rotation.y di una sedia modellata col davanti verso +Z locale e lo
   *  schienale verso −Z: atan2(dx, dz) della direzione sedia → tavolo. Chi ci
   *  si siede guarda il tavolo. */
  yaw: number;
  /** Disegnata piena. A un tavolo dove non siede nessuno: le sedie che la
   *  piantina accende (litChairIndices), tutte per un tavolo libero, come in
   *  2D. A un tavolo con qualcuno seduto: esattamente le sedie occupate. Di
   *  norma le due regole danno le stesse sedie; cambiano quando il bambino
   *  del seggiolone lascia il suo posto per la testa del tavolo (quella
   *  sedia, vuota, resta spenta) e sui tavoli di un banchetto dove la
   *  comitiva trabocca (si accendono quelle usate). Spenta = più chiara,
   *  come l'opacità 0,25 della 2D. */
  lit: boolean;
  /** Un seggiolone: la seduta a HIGH_CHAIR_SEAT_HEIGHT (model/geometry.ts)
   *  invece di SEAT_HEIGHT, e il disegno della sedia alta. Solo per il
   *  bambino più piccolo di una comitiva con «Seggiolone» nelle note. */
  high: boolean;
}

/** La forma del piano in 3D. Il quadrato è un rettangolo, come nel glifo; la
 *  forma si confronta in modo esatto (=== TableShape.CIRCLE), quindi un
 *  'circle' ereditato dal seed esce rettangolare anche qui. */
export type TableShape3D = 'rect' | 'circle';

/** Un tavolo da disegnare: un tavolo vero, oppure il capofila di un'unione,
 *  che si disegna sempre alla maniera della 2D: un tavolo solo. */
export interface TableModel {
  id: number;
  /** Il nome sull'etichetta. Un'unione disegnata alla maniera della 2D porta
   *  il nome unito («11+12», come applyMerges). */
  name: string;
  roomId: number;
  shape: TableShape3D;
  /** Il centro del glifo, in metri: ((x + w/2)·M, (y + h/2)·M). È anche il
   *  centro di rotazione, come nella piantina. */
  center: Vec2;
  /** rotation.y del gruppo del tavolo = −rotation·π/180: è la rotazione
   *  oraria del CSS, con la y verso il basso, vista dall'alto. */
  rotY: number;
  /** Il lato lungo, sull'asse X locale, in metri (tondo: il diametro). */
  length: number;
  /** La profondità, sull'asse Z locale, in metri (tondo: il diametro). */
  depth: number;
  /** Lo stato del gruppo di unione (deriveTableDisplayStatus): una
   *  prenotazione su un tavolo secondario colora il tavolo unito. */
  status: TableDisplayStatus;
  /** Le sedie del tavolo: i posti della piantina, nell'ordine di
   *  getChairSlots. Un tondo con più persone sedute che posti ha invece
   *  l'anello ridistribuito per tutta la comitiva (quante sedie ci stanno a
   *  48 cm l'una, allo stesso raggio), sedia 0 a ore 12 e poi in senso
   *  orario, tutte occupate. */
  chairs: ChairModel[];
  /** Le sedie che la piantina non ha: alle teste libere di un rettangolo per
   *  chi non entra nei posti, e il seggiolone. Sempre occupate (lit) e
   *  rivolte al tavolo. Quasi sempre vuoto. */
  extraChairs: ChairModel[];
  /** L'anello che pulsa: status === 'inarrivo'. */
  pulse: boolean;
  /** Il cartellino sul piano (scene/Signs.tsx), solo a un tavolo dove non
   *  siede nessuno: 'event' per un banchetto del servizio, se no 'reserved'
   *  per la prossima prenotazione del turno, fra 120 minuti fa e 90 minuti da
   *  adesso. null: niente cartellino. */
  sign: TableSignKind | null;
  /** La seconda riga dell'etichetta, già tradotta e lunga al più 24
   *  caratteri, «…» compreso. Il testo del cartellino («Riservato · 20:30»,
   *  «Evento», o a nomi accesi il nome del banchetto), oppure, a nomi
   *  accesi, il nome della comitiva seduta. null: solo il nome del tavolo. A
   *  nomi spenti nessun nome di persona arriva fin qui. */
  caption: string | null;
}

/** Il cartellino su un tavolo libero: prenotato fra poco, o un banchetto. */
export type TableSignKind = 'reserved' | 'event';

/** Chi è una figura: un ospite adulto, un bambino (le stesse parti a scala
 *  ridotta), un cane, l'hostess. Mai un colore di stato: la tinta è del
 *  ruolo (vedi FigureSlot.tint). */
export type FigureKind = 'adult' | 'kid' | 'dog' | 'hostess';

/** Come sta una figura: seduta su una sedia, in piedi, sdraiata (il cane). */
export type FigurePose = 'seated' | 'standing' | 'lying';

/** Una figura da disegnare: dove sta, dove guarda, con che tinta. La scena ne
 *  compone le parti (scene/figures.ts); il modello non sa niente di gambe e
 *  braccia, e la scena niente di comitive e tavoli. */
export interface FigureSlot {
  /** Stabile da un ricalcolo all'altro: `r${id}:a${n}` per l'n-esimo adulto
   *  della prenotazione `id`, `r${id}:k${n}` per i bambini, `r${id}:d${n}`
   *  per i cani, `host:${roomId}` per l'hostess. La stessa persona ha la
   *  stessa chiave all'ingresso e al tavolo: PR3 la fa camminare dall'uno
   *  all'altro. */
  key: string;
  kind: FigureKind;
  pose: FigurePose;
  /** Seduta: il centro della sedia. In piedi: il punto del pavimento sotto il
   *  bacino. Il cane: il centro del corpo, a terra. In metri. */
  x: number;
  z: number;
  /** rotation.y di una figura modellata col davanti verso +Z locale: dove
   *  guarda. Seduta, lo yaw della sedia (guarda il tavolo); in piedi accanto
   *  a un tavolo, lo yaw della sedia dietro cui sta; all'ingresso, verso la
   *  sala; l'hostess, verso il leggio; il cane ha il muso lungo il bordo. */
  yaw: number;
  /** Seduta: l'altezza della seduta, SEAT_HEIGHT o HIGH_CHAIR_SEAT_HEIGHT
   *  (model/geometry.ts). 0 in piedi e sdraiata. */
  seatHeight: number;
  /** La prenotazione della comitiva; null per l'hostess. */
  partyId: number | null;
  /** Il tavolo disegnato a cui sta, seduta o in piedi accanto; null
   *  all'ingresso e per l'hostess. */
  tableId: number | null;
  /** Ospiti: quanto il corpo va da --ds-text-muted verso --ds-surface, fra 0
   *  e 1. Uguale per gli adulti di una comitiva (0–0,20, dall'id, sempre lo
   *  stesso), +0,15 per i bambini. La testa la schiarisce la scena, 35 %
   *  verso --ds-surface. Hostess e cane: 0, il colore è quello del ruolo. */
  tint: number;
}

/** Una comitiva in sala adesso: seduta a un tavolo, o all'ingresso perché
 *  è segnata arrivata senza un tavolo da disegnare. */
export interface PartyModel {
  /** reservations.id */
  id: number;
  /** Il tavolo disegnato (per un'unione, il capofila); null = all'ingresso. */
  tableId: number | null;
  /** Adulti + bambini = gli ospiti della prenotazione (almeno 1). */
  adults: number;
  kids: number;
  /** 0–2, dalle note («Cane», «2× Cane»). */
  dogs: number;
  /** Le note chiedono il seggiolone. Si disegna solo se c'è un bambino. */
  highChair: boolean;
  /** toTitleCase del nome, al più 24 caratteri: solo a nomi accesi, se no
   *  null. */
  name: string | null;
}

/** Un segnaposto di sala. C'è sempre, anche quando nessuno l'ha posato: lì
 *  vale la posizione di ripiego, perché ingresso e accoglienza servono alla
 *  scena (gli ospiti entrano dalla porta, l'hostess sta al leggio). */
export interface MarkerModel {
  kind: FloorMarkerKind;
  /** Il centro, in metri. */
  pos: Vec2;
  /** false = posizione di ripiego: il segnaposto non è sulla piantina. */
  placed: boolean;
  /** Il versore verso l'interno della sala: dal segnaposto al centro del
   *  pavimento, agganciato alla normale del bordo più vicino quando il
   *  segnaposto è «sul muro» (layout.ts, inwardAt). Orienta porta, banco del
   *  pass e leggio senza che la scena debba conoscere la sala.
   *
   *  «Sul muro» non è simmetrico. In alto e a sinistra vale entro 1 m dal
   *  bordo (50 px). In basso e a destra il bordo si misura da dove finirebbe
   *  il pavimento se il segnaposto fosse la cosa più esterna della sala: la
   *  piantina lo allarga fino a chip ed etichetta più il margine (60 + 60 px
   *  sotto, 40 + 60 a destra), quindi l'aggancio arriva fino a 3,4 m dal
   *  bordo basso e 3 m da quello destro. Senza, un ingresso posato in fondo
   *  alla piantina non sarebbe mai sul muro e guarderebbe in diagonale verso
   *  il centro. Per lo stesso motivo un segnaposto posato in basso o a destra
   *  non sta mai sul bordo del pavimento: almeno 2,4 m (sotto) o 2 m (a
   *  destra) più dentro. */
  inward: Vec2;
}

/** I controlli sulla sala: diventano avvisi per chi la può sistemare. */
export interface RoomAudit {
  /** Coppie di nomi di tavoli le cui sagome si sovrappongono: rettangoli del
   *  glifo orientati e cerchi come dischi, senza margine né fascia delle
   *  etichette, così due vicini ruotati non sono un falso allarme. I tavoli
   *  di una stessa unione si toccano apposta e non contano. */
  overlaps: Array<[string, string]>;
  /** Almeno 3 tavoli e la posizione più comune ne tiene almeno la metà: la
   *  sala non è mai stata disposta. Solo un avviso: la 3D disegna comunque le
   *  posizioni salvate, come la piantina, perché una griglia solo in 3D
   *  romperebbe l'accordo con la 2D. */
  unset: boolean;
  /** I segnaposto disegnati nella posizione di ripiego. */
  missingMarkers: FloorMarkerKind[];
}

/** Quante persone, per il riassunto in testata e le linguette. Persone, non
 *  comitive, e tutte dalla stessa regola di presenza (model/presence.ts) da
 *  cui nascono le figure: una linguetta non può dire 4 con 6 figure sedute. */
export interface ServiceSummary {
  /** Ospiti a tavola adesso: le comitive presenti, cioè la seduta più
   *  recente di ogni tavolo disegnato finché non passano 45 minuti dalla sua
   *  fine prevista, comprese le persone in piedi accanto a un tavolo pieno.
   *  È il numero delle figure di persona ai tavoli, una per una. */
  seated: number;
  /** Ospiti in arrivo: quelli dietro gli anelli che pulsano. */
  arriving: number;
  /** Ospiti all'ingresso: segnati arrivati senza un tavolo da disegnare, da
   *  meno di un'ora dall'ora prenotata. Tutti, anche oltre le 6 figure che
   *  l'ingresso disegna. */
  lobby: number;
}

export interface RoomSummary extends ServiceSummary {
  /** I coperti della sala nel senso di Sale & Tavoli: i posti dei tavoli
   *  disegnati, cioè la capienza, non le persone. */
  covers: number;
}

/** Una sala pronta da disegnare. */
export interface RoomModel {
  id: number;
  name: string;
  /** Chiusa per questo servizio (chiusura del turno o rooms.is_closed). La
   *  pagina la mostra lo stesso se c'è qualcuno seduto. */
  closed: boolean;
  /** rooms.location === 'OUTDOOR': il pavimento prende la tinta di categoria. */
  outdoor: boolean;
  /** Il pavimento, da (0, 0) a (width, depth), in metri. */
  floor: { width: number; depth: number };
  /** Il contenuto, in metri: tavoli, segnaposto, i posti dell'ingresso e
   *  quello dell'hostess (anche vuoti, così la camera non salta quando
   *  arriva qualcuno). È quello che la camera inquadra, non il pavimento
   *  intero. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  tables: TableModel[];
  markers: Record<FloorMarkerKind, MarkerModel>;
  audit: RoomAudit;
  summary: RoomSummary;
  /** Le comitive della sala: prima quelle ai tavoli, nell'ordine dei tavoli,
   *  poi quelle all'ingresso, per ora prenotata e poi id. */
  parties: PartyModel[];
  /** Le figure della sala, in ordine stabile: le comitive ai tavoli (le
   *  persone, poi i cani), quelle all'ingresso (al più 6 persone, niente
   *  cani), l'hostess all'accoglienza. */
  figures: FigureSlot[];
}

/** La sala dal vivo di un istante: si ricalcola sui dati e al minuto, mai a
 *  ogni frame. */
export interface SceneModel {
  service: LiveService;
  /** Tutte le sale nell'ordine di sortRooms, chiuse comprese: quali mostrare
   *  lo decide la pagina. */
  rooms: RoomModel[];
  /** La somma delle sale: il riassunto in testata. */
  summary: ServiceSummary;
  /** La sala principale: la prima di sortRooms aperta e con l'ingresso
   *  posato, se no la prima aperta, se no la prima. Lì aspetta chi è
   *  arrivato senza tavolo; da PR3 lì l'hostess ha un nome. null senza
   *  sale. */
  mainRoomId: number | null;
  /** Le comitive del servizio con la loro fase, per il regista (PR3): è il
   *  confronto fra due di queste liste, al commit di React, a dire che cosa
   *  è successo (un arrivo, un cambio di tavolo, un'uscita, un «Arrivato»
   *  annullato). Una comitiva che manca è «andata»: andata via, annullata,
   *  no-show, eliminata, o fuori dal servizio.
   *
   *  Viene dalla stessa presenza delle figure e dei numeri (presence.ts):
   *  il regista non decide mai DOVE sta qualcuno, solo come ci arriva.
   *  Ordine stabile: le presenti nell'ordine dei tavoli disegnati (sale come
   *  sortRooms), poi quelle all'ingresso nell'ordine di presence, poi le
   *  sedute senza figure e le attese, per ora prenotata e poi id. */
  partyStates: PartyState[];
}

/** La fase di una comitiva del servizio, letta dalla presenza.
 *
 * - 'waiting': viva e non ancora seduta (in attesa, da confermare). Un
 *   «Arrivato» annullato riporta qui: le figure svaniscono sul posto.
 * - 'lobby': seduta senza un tavolo da disegnare, all'ingresso
 *   (presence.lobby).
 * - 'seated': presente a un tavolo disegnato, arrivata.
 * - 'standing': presente a un tavolo disegnato, «In uscita» (DEPARTING): le
 *   figure stanno in piedi dietro le sedie (placement.standUp).
 * - 'hidden': seduta e viva ma senza figure: spodestata da una comitiva più
 *   recente sullo stesso tavolo, oltre la grazia di 45 minuti, o
 *   all'ingresso da più di un'ora. Per il regista è un'uscita; se torna
 *   presente (l'arrivo della comitiva nuova annullato, la durata allungata)
 *   ricompare sul posto, perché dalla sala non era mai andata via. */
export type PartyPhase = 'waiting' | 'lobby' | 'seated' | 'standing' | 'hidden';

/** Una comitiva del servizio vista dal regista. Solo quello che serve a
 *  riconoscere un passaggio: le persone, le sedie e i posti li dicono già
 *  RoomModel.parties e RoomModel.figures. */
export interface PartyState {
  /** reservations.id */
  id: number;
  phase: PartyPhase;
  /** 'seated' / 'standing': la sala del tavolo disegnato. 'lobby': la sala
   *  al cui ingresso aspetta. 'waiting' / 'hidden': null. */
  roomId: number | null;
  /** 'seated' / 'standing': TableModel.id del tavolo dove siede (per
   *  un'unione, il capofila); null nelle altre fasi. */
  tableId: number | null;
  /** Le persone (peopleOf: almeno 1, al più 150): oltre 12 una comitiva non
   *  si accompagna in fila, compare già seduta. */
  people: number;
  /** Legata a un banchetto (banquet_menu_id): compare già seduta come le
   *  comitive grandi, perché un evento non entra dalla porta a famiglie in
   *  fila dietro l'hostess. */
  banquet: boolean;
}

/** Di un preset delle note servono solo etichetta e icona: un sottoinsieme
 *  di ReservationNotePreset (services/apiService), che si passa com'è. */
export interface NotePresetRef {
  label: string;
  icon?: string | null;
}

/** I testi dei cartellini, già tradotti dalla pagina: il modello non
 *  conosce i18n, e i test li fissano. */
export interface SceneCopy {
  /** «Riservato · 20:30» per l'ora data (HH:MM nel fuso del ristorante):
   *  t('reserved', { time }). */
  reserved: (time: string) => string;
  /** «Evento»: t('event'). */
  event: string;
}

/** Tutto quello che serve a deriveSceneModel. Il modello non legge mai
 *  l'orologio né la rete da sé: con gli stessi ingressi dà la stessa sala, e i
 *  test fissano l'ora. */
export interface SceneInputs {
  rooms: Room[];
  tables: Table[];
  reservations: Reservation[];
  banquetMenus: BanquetMenu[];
  /** Le unioni del servizio in corso (useServiceOverrides). */
  merges: TableMerge[];
  /** I tavoli nascosti per questo servizio: non si disegnano, come in 2D. */
  hiddenTableIds: ReadonlySet<number>;
  /** Le sale chiuse per questo servizio (rooms.is_closed si legge dalla sala). */
  closedRoomIds: ReadonlySet<number>;
  markers: FloorMarker[];
  service: LiveService;
  /** L'istante del calcolo, in ms: il currentTime di App. */
  nowMs: number;
  /** I preset delle note (Impostazioni → Opzioni prenotazioni): le etichette
   *  con icona 'dog' dicono il cane, quelle con icona 'baby' il seggiolone.
   *  Vuoto finché non arrivano: valgono «Cane» e «Seggiolone». */
  notePresets: readonly NotePresetRef[];
  /** «Nomi degli ospiti», per dispositivo e spento di default. Spento,
   *  nessun nome di persona entra nel modello. */
  showNames: boolean;
  /** I testi dei cartellini. */
  copy: SceneCopy;
}

/** Quello che useServiceOverrides restituisce: le varianti della sala che
 *  valgono solo per un servizio (data e turno). */
export interface ServiceOverrides {
  merges: TableMerge[];
  hiddenTableIds: ReadonlySet<number>;
  closedRoomIds: ReadonlySet<number>;
  /** Il primo caricamento di questo servizio è concluso, riuscito o no.
   *  Torna false a ogni cambio di servizio: prima, un'unione appena letta
   *  farebbe saltare i tavoli da separati a uniti sotto gli occhi. */
  ready: boolean;
}

/** Le prop del canvas, caricato a richiesta dopo la sonda WebGL2. */
export interface SalaVivoCanvasProps {
  /** La sala sullo schermo. È un oggetto nuovo a ogni ricalcolo del modello:
   *  la scena reinquadra solo quando cambia `room.id` o arriva «Centra».
   *  Da PR3 è la sala che la pagina mostra (quella scelta, o quella dove
   *  «Segui il servizio» l'ha portata), coi tavoli verso cui qualcuno sta
   *  arrivando ancora «in arrivo» con l'anello (withArrivalTargets,
   *  model/director.ts): quello dove l'hostess accompagna una comitiva, e
   *  quello nuovo di una comitiva che cambia tavolo a piedi. Il tavolo
   *  diventa «arrivato» quando l'ultimo si siede, non quando Reception preme
   *  il bottone. */
  room: RoomModel;
  /** Il regista della scena, creato e aggiornato dalla pagina. Il canvas lo
   *  fa avanzare (step, in un solo useFrame) e ne disegna gli attori; non lo
   *  aggiorna mai col modello. Un'interfaccia e non la classe: il codice del
   *  regista resta nel chunk della pagina, qui arriva solo l'istanza. */
  director: SceneDirectorApi;
  /** Il testo dell'etichetta che segue la comitiva accompagnata, per id
   *  della prenotazione: «Tavolo 40 · 4 (2 bambini) + cane», o col nome della
   *  comitiva a nomi accesi. Già tradotto dalla pagina: nel canvas niente
   *  i18n, e a nomi spenti nessun nome di persona arriva fin qui. */
  partyTags: ReadonlyMap<number, string>;
  /** Qualcuno ha cominciato a trascinare o pizzicare la sala: «Segui il
   *  servizio» si mette in pausa per due minuti, così la camera non scappa
   *  di mano a chi la sta muovendo. */
  onUserCamera: () => void;
  /** prefers-reduced-motion: l'anello resta fermo e «Centra» non anima. */
  reducedMotion: boolean;
  /** Il WebGL2 c'è solo senza failIfMajorPerformanceCaveat: DPR 1 e al
   *  massimo 15 fps. */
  slowMode: boolean;
  /** localStorage salaVivo.debug === '1': fps, draw call, DPR sul canvas. */
  debug: boolean;
  /** Cresce di uno a ogni «Centra»: la scena torna all'inquadratura quando
   *  il numero cambia (il primo valore non conta). Un numero e non un
   *  handle, così la pagina non tocca niente della scena. */
  recenterSignal: number;
  /** Il contesto WebGL è andato perso: la pagina mostra «Riavvia la vista». */
  onContextLost: () => void;
}

/* ── PR3: il regista della scena ──────────────────────────────────────────
 *
 * Il modello qui sopra dice DOVE sta ognuno adesso; il regista
 * (model/director.ts) mette in scena il passaggio fra due modelli: l'hostess
 * che va alla porta e accompagna la famiglia al tavolo, chi si alza «In
 * uscita», chi esce dalla porta, chi cambia tavolo. Puro e deterministico:
 * orologio e seme arrivano da fuori, e con gli stessi aggiornamenti e gli
 * stessi passi dà le stesse posizioni (i test lo fissano). Alla fine di ogni
 * passaggio le persone tornano alle figure statiche del modello, nello stesso
 * punto: People le disegna da lì, e il regista smette di disegnarle.
 *
 * La pagina lo crea e lo aggiorna (update al commit dei dati); il canvas lo
 * fa avanzare (step) e ne disegna gli attori. Qui solo i tipi: il canvas
 * riceve l'istanza come SceneDirectorApi e non importa il codice del regista,
 * che resta nel chunk della pagina. */

/** Perché un aggiornamento va dritto allo stato finale invece di animarsi.
 *  La pagina lo calcola a ogni update; null = si anima.
 *
 * - 'initial': non c'è ancora una base (primo update dopo il caricamento):
 *   chi è già seduto è già seduto, nessuno entra dalla porta.
 * - 'refetch': reservationsEpoch è cambiata dall'ultimo update, cioè App ha
 *   ricaricato tutto (riconnessione, ritorno in primo piano): quei cambi
 *   sono successi mentre lo schermo non li vedeva.
 * - 'hidden': la scheda è nascosta, o la vista 3D non c'è (niente WebGL,
 *   contesto perso): nessuno guarderebbe l'animazione, e senza frame non
 *   finirebbe mai.
 * - 'reduced-motion': l'utente chiede meno movimento: niente cammino, mai.
 *
 * Un cambio di servizio (17:00, 05:00) non è un motivo: il regista lo vede
 * da model.service.key e riparte da zero. */
export type SnapReason = 'initial' | 'refetch' | 'hidden' | 'reduced-motion';

/** Quanti frame chiede il regista. 'active' (30 fps): un ospite o l'hostess
 *  si muovono, o un accompagnamento aspetta in coda. 'ambient' (20 fps): si
 *  muovono solo i camerieri della sala sullo schermo. 'none' (0 fps):
 *  fermi; allora wakeInMs() dice fra quanto qualcuno ripartirà, e il canvas
 *  si risveglia da sé invece di girare a vuoto. */
export type FrameNeed = 'none' | 'ambient' | 'active';

/** Una persona di sala di turno nel servizio, da GET /staff/presence (la
 *  lista sala del turno), letta in difesa da useStaffOnShift. La regola di
 *  chi è di turno è quella della pagina Personale. */
export interface StaffOnShift {
  /** staff_members.id (uuid) */
  id: string;
  /** staff_members.name: il nome di battesimo (il cognome sta a parte), già
   *  ripulito dagli spazi. Va sopra la figura così com'è. */
  name: string;
  /** staff_members.role, testo libero («Hostess», «Cameriere», «Maître»):
   *  chi l'ha da accoglienza dà il nome all'hostess della sala principale. */
  role: string | null;
}

/** Chi è un attore del regista: le stesse figure del modello, più il
 *  cameriere, che il modello statico non ha. */
export type ActorKind = 'adult' | 'kid' | 'dog' | 'hostess' | 'waiter';

/** Un attore in questo istante, come la scena lo disegna. Oggetti del
 *  regista, riscritti sul posto a ogni step: la scena li legge nel frame e
 *  non li tiene (niente allocazioni per frame, né da una parte né
 *  dall'altra). Metri e radianti, come FigureSlot. */
export interface ActorView {
  /** Per ospiti e hostess la chiave della figura statica (r12:a0, r12:k1,
   *  r12:d0, host:3): la stessa persona passa da People al regista e
   *  ritorno senza cambiare nome. I camerieri: waiter:<id del personale>, o
   *  waiter:anon<n> senza nomi. */
  key: string;
  kind: ActorKind;
  /** La prenotazione per gli ospiti e il cane; null per hostess e camerieri. */
  partyId: number | null;
  /** Il punto del pavimento sotto il bacino (seduto: il centro della sedia,
   *  come FigureSlot) e dove guarda (rotation.y, davanti verso +Z locale). */
  x: number;
  z: number;
  yaw: number;
  /** La posa statica più vicina: 'seated' da seat ≥ 0,5 per una persona,
   *  'lying' per il cane, altrimenti 'standing'. Decide l'ombra a macchia,
   *  come nelle figure statiche. */
  pose: FigurePose;
  /** 0 = in piedi, 1 = seduto (una persona) o sdraiato (il cane); in mezzo
   *  sta sedendosi o alzandosi. Con seat 1 e walk 0 la posa è esattamente
   *  quella della figura statica seduta: il passaggio a People non si vede. */
  seat: number;
  /** L'altezza della seduta verso cui scende (SEAT_HEIGHT, o
   *  HIGH_CHAIR_SEAT_HEIGHT per il seggiolone); 0 per chi non si siede. */
  seatHeight: number;
  /** Quanto cammina, da 0 (fermo) a 1 (passo pieno): sale e scende in un
   *  attimo, così le gambe non scattano quando parte o si ferma. */
  walk: number;
  /** La fase del passo, in [0, 1): gambe sin(2πφ)·28°, braccia in
   *  controfase ×0,8, dondolio |sin 2πφ|·0,025 m; il cane a coppie
   *  diagonali. Avanza di distanza / falcata (un ciclo, due passi: 1,4 m
   *  adulti, 0,9 bambini). */
  phase: number;
  /** L'opacità, da 0 a 1: chi entra dalla porta compare, chi esce svanisce,
   *  un «Arrivato» annullato si dissolve sul posto. */
  fade: number;
  /** Il braccio dell'hostess, da 0 a 1: verso la strada della fila alla
   *  fine dell'accoglienza (GREET, «prego, da questa parte») e verso il
   *  tavolo (PRESENT), sempre davanti a sé (+Z locale). 0 per gli altri. */
  arm: number;
  /** Il cameriere porta il vassoio. */
  tray: boolean;
  /** Gli ospiti: la tinta della figura statica (FigureSlot.tint). 0 per gli
   *  altri: il colore è del ruolo. */
  tint: number;
  /** Il nome di battesimo sopra la testa: l'hostess della sala principale e
   *  i camerieri con un nome. Mai il nome di un ospite (quello sta
   *  nell'etichetta della comitiva, e solo a nomi accesi). */
  label: string | null;
}

/** Dove sta, in questo istante, l'etichetta della comitiva accompagnata di
 *  una sala: sopra la testa di chi segue l'hostess, da quando entra dalla
 *  porta (o lascia l'ingresso) a quando i suoi vanno alle sedie, poi ferma lì
 *  mentre svanisce (400 ms). Una sola per sala; null quando nessuno è
 *  accompagnato. */
export interface ActorTag {
  partyId: number;
  /** Il punto, in metri, sopra la testa (y già compresa). */
  x: number;
  y: number;
  z: number;
  /** L'opacità di chi la porta: compare e svanisce con lui. */
  alpha: number;
}

/** La comitiva di un evento, fotografata quando succede: la striscia la
 *  racconta anche dopo che è uscita dal modello. */
export interface PartyRef {
  /** reservations.id */
  id: number;
  /** PartyModel.name: null a nomi spenti, e allora nessun nome arriva alla
   *  striscia. */
  name: string | null;
  adults: number;
  kids: number;
  dogs: number;
}

/** Un tavolo disegnato, col nome dell'etichetta («40», «11+12»). */
export interface TableRef {
  id: number;
  name: string;
}

/** Quello che il regista racconta, per la striscia delle attività e per
 *  «Segui il servizio». `at` è il suo orologio (DirectorOptions.now).
 *
 * Tutti tranne 'escort-end' e 'moved-end' nascono in update(), al confronto
 * dei modelli: non dipendono dai frame, quindi arrivano anche col movimento
 * ridotto, a scheda nascosta e senza vista 3D. 'escort-end' e 'moved-end'
 * arrivano quando l'accompagnamento o il cambio di tavolo finisce davvero
 * (da step, fastForward, configure o update). Ogni cambio di arrivalTargets
 * (e quindi di escortTargets) arriva insieme a un evento: la pagina
 * ridisegna i tavoli «in arrivo» a ogni evento e mai per frame. Fa
 * eccezione solo l'azzeramento (il primo modello, un cambio di servizio),
 * che svuota tutto senza raccontare niente: lì è la pagina, che sa di aver
 * dato un servizio nuovo, a ridisegnarli dopo l'update. Il render che
 * precede l'update li ha calcolati col regista di prima, e da solo
 * terrebbe un anello acceso fino al modello dopo. */
export type DirectorEvent =
  /** Una comitiva da accompagnare: dalla porta, o dall'ingresso se aspettava
   *  già lì. roomId è la sala del tavolo. Col movimento ridotto arriva
   *  subito seguito da 'escort-end'. */
  | { kind: 'escort-start'; at: number; roomId: number; party: PartyRef; table: TableRef; from: 'entrance' | 'lobby' }
  /** L'accompagnamento è uscito di scena: seated true quando l'ultimo si è
   *  seduto (o è stato fatto sedere da uno scatto), false quando è stato
   *  annullato o spostato in un'altra sala (che ne apre un altro). */
  | { kind: 'escort-end'; at: number; roomId: number; partyId: number; tableId: number; seated: boolean }
  /** Arrivata senza un tavolo da disegnare: aspetta all'ingresso. */
  | { kind: 'lobby'; at: number; roomId: number; party: PartyRef }
  /** Cambio di tavolo (anche mentre l'hostess la sta accompagnando). roomId
   *  è la sala del tavolo nuovo. Quando la comitiva ci va a piedi (RESEAT)
   *  il tavolo nuovo entra in arrivalTargets in questo stesso istante e ci
   *  resta fino a 'moved-end': da un altro tavolo, o tornando indietro mentre
   *  ne usciva (spodestata, «Tavolo liberato» o «Arrivato» tolti) verso un
   *  tavolo diverso da quello che lasciava, che è `from`. Senza anello
   *  quando nessuno ci cammina: un cambio scattato, o di una comitiva oltre
   *  12 persone o di un banchetto (compare seduta al tavolo nuovo); e
   *  durante un accompagnamento, il cui tavolo è già fra gli obiettivi. */
  | { kind: 'moved'; at: number; roomId: number; party: PartyRef; from: TableRef; to: TableRef }
  /** Il cambio di tavolo a piedi è uscito di scena, e il suo tavolo nuovo
   *  esce da arrivalTargets: seated true quando l'ultimo della comitiva è
   *  arrivato al suo posto (o ce l'ha messo uno scatto), false quando un
   *  altro passaggio l'ha sostituito (un altro tavolo, «Arrivato» annullato,
   *  un'uscita). Solo dopo un 'moved' che ha acceso l'anello, una volta.
   *  Non è la fine di un accompagnamento: «Segui il servizio» non ci aspetta
   *  sopra e la striscia non ne fa una riga. */
  | { kind: 'moved-end'; at: number; roomId: number; partyId: number; tableId: number; seated: boolean }
  /** Lascia il tavolo ed esce dalla porta: andata via, annullata, oltre la
   *  grazia, o spodestata da una comitiva più recente. */
  | { kind: 'leaving'; at: number; roomId: number; party: PartyRef; table: TableRef }
  /** Un riallineamento: `count` tavoli (disegnati) toccati dai cambi messi
   *  al loro posto senza animazione, perché l'epoca era cambiata, la scheda
   *  era nascosta, o sono arrivati più di 4 cambi in 2 s (i rigiochi della
   *  coda offline di un altro dispositivo). Chi lascia un tavolo e chi ci
   *  arriva al suo posto sono un tavolo; senza tavoli toccati (solo chi
   *  aspetta all'ingresso) non arriva. Mai per il primo caricamento né per un
   *  cambio di servizio. */
  | { kind: 'bulk'; at: number; count: number }
  /** Comitive fatte sedere senza accompagnamento: 'large' quelle oltre 12
   *  persone o legate a un banchetto (compaiono già sedute, una persona ogni
   *  80 ms), 'queue' le più vecchie di una coda oltre le 6. */
  | { kind: 'snapped'; at: number; roomId: number; reason: 'queue' | 'large'; parties: Array<{ party: PartyRef; table: TableRef }> };

/** Le condizioni in cui il regista lavora: le dicono la pagina e il canvas,
 *  e cambiano quando cambiano loro, mai a ogni frame. */
export interface DirectorSettings {
  /** prefers-reduced-motion: ogni aggiornamento va allo stato finale,
   *  l'hostess resta all'accoglienza, i camerieri fermi al pass. */
  reducedMotion: boolean;
  /** WebGL senza accelerazione: i camerieri fermi al pass (gli
   *  accompagnamenti si vedono lo stesso, a 15 fps). */
  slowMode: boolean;
  /** Modalità leggera, la chiede il canvas quando per 10 s i frame non
   *  tengono il ritmo (in media oltre 50 ms a 30 fps, oltre 75 a 20):
   *  niente camerieri, del tutto. Resta finché il canvas non si rimonta. */
  lightMode: boolean;
  /** Schermo fissato: i camerieri restano al pass 8–20 s invece di 2–6, così
   *  una TV accesa tutto il servizio disegna meno. */
  pinned: boolean;
  /** La sala sullo schermo: a ristorante vuoto il cameriere sta al suo pass,
   *  e i frame d'ambiente si chiedono solo per i camerieri di questa sala. */
  activeRoomId: number | null;
  /** Il personale di sala di turno (useStaffOnShift). undefined: non ancora
   *  letto, niente camerieri e hostess senza nome (meglio che comparire senza
   *  nome e poi cambiare); null: non disponibile, due camerieri senza nome
   *  se c'è qualcuno a tavola, se no uno. */
  staff: readonly StaffOnShift[] | null | undefined;
}

/** I numeri del regista, in metri, secondi al metro e millisecondi. Le
 *  costanti stanno in DIRECTOR_TUNING (model/director.ts); i test ne
 *  cambiano qualcuna con DirectorOptions.tuning. */
export interface DirectorTuning {
  /** Adulti e bambini a passo libero: 1,1 m/s. */
  guestSpeed: number;
  /** L'hostess senza nessuno dietro: 1,3 m/s. */
  hostessSpeed: number;
  /** L'hostess che accompagna, e la sua fila: 1,0 m/s. */
  escortSpeed: number;
  /** Chi nella fila è rimasto indietro, e il cane che raggiunge il padrone:
   *  1,5 m/s, finché non torna al suo posto. */
  catchUpSpeed: number;
  /** I camerieri: 1,3 m/s. */
  waiterSpeed: number;
  /** Sedersi 600 ms, alzarsi 500. */
  sitMs: number;
  standMs: number;
  /** Il passo fuori griglia fra il punto d'approccio e la sedia (0,55 m):
   *  500 ms; la rotazione verso il tavolo: 250 ms. */
  stepMs: number;
  turnMs: number;
  /** Il cane che si sdraia o si alza: 600 ms. */
  lieMs: number;
  /** Comparire e svanire: 400 ms. */
  fadeMs: number;
  /** L'hostess che accoglie alla porta (800 ms) e presenta il tavolo
   *  (1200 ms). */
  greetMs: number;
  presentMs: number;
  /** Oltre BULK_K (4) cambi in un update, o in BULK_WINDOW_MS (2000) di fila,
   *  si va dritti allo stato finale ('bulk'). */
  bulkK: number;
  bulkWindowMs: number;
  /** Con più di 3 accompagnamenti fra la coda e quello in corso (con
   *  quattro tavolate alla porta) l'hostess va al doppio; con più di 6 i più
   *  vecchi della coda si siedono subito ('snapped', reason 'queue'). */
  queueFastAbove: number;
  queueSnapAbove: number;
  /** Oltre 12 persone niente fila: compaiono sedute. */
  escortMaxParty: number;
  /** Chi compare seduto: uno ogni 80 ms. */
  largeStaggerMs: number;
  /** Chi entra dalla porta (250 ms l'uno dall'altro), chi lascia la fila per
   *  la sua sedia (150), chi esce (250). */
  spawnStaggerMs: number;
  peelStaggerMs: number;
  leaveStaggerMs: number;
  /** La fila dietro l'hostess, sul suo stesso percorso (le sue «briciole»):
   *  un adulto 0,8 m d'arco dietro chi lo precede, un bambino 0,7; il cane
   *  0,45 m di lato al padrone. */
  gapAdult: number;
  gapKid: number;
  dogBeside: number;
  /** La precedenza: chi cammina si ferma se un altro (non della sua fila) è
   *  entro 0,45 m davanti, al più 1,5 s. */
  yieldDistance: number;
  yieldMaxMs: number;
  /** Un passo di step non va oltre 100 ms quando qualcosa si muove: dopo un
   *  frame perso nessuno salta. Da fermi il tempo passa tutto (i camerieri
   *  in pausa al pass contano il tempo vero). */
  maxStepMs: number;
  /** La rotazione: al più 7 rad/s. */
  yawRate: number;
  /** La falcata, un ciclo intero del passo (due passi): 1,4 m adulti,
   *  hostess e camerieri; 0,9 bambini; 0,4 il cane. */
  strideAdult: number;
  strideKid: number;
  strideDog: number;
  /** Il cameriere al pass: 2–6 s, 8–20 a schermo fissato; al tavolo 3–8 s;
   *  di nuovo al pass, il vassoio posato, 1 s. */
  waiterIdleMinMs: number;
  waiterIdleMaxMs: number;
  waiterIdlePinnedMinMs: number;
  waiterIdlePinnedMaxMs: number;
  serveMinMs: number;
  serveMaxMs: number;
  passPauseMs: number;
  /** Al più 8 camerieri in giro per sala; gli altri aspettano al pass. */
  walkingWaitersMax: number;
  /** Dove l'hostess presenta il tavolo: il capo di un rettangolo a L/2 +
   *  0,45 m, il varco di un tondo a Dc/2 + 0,5; il cameriere serve a 0,5 m
   *  oltre il tavolo, dal lato del pass. */
  headGapRect: number;
  headGapCircle: number;
  serviceGap: number;
}

/** Come si crea il regista: nella pagina,
 *  useState(() => new SceneDirector({ now: () => performance.now(), seed }))[0]. */
export interface DirectorOptions {
  /** L'orologio, in ms e monotono: segna gli eventi e misura la finestra dei
   *  cambi in blocco. Nel modello mai Date.now(); i test passano un orologio
   *  finto. */
  now: () => number;
  /** Il seme di tutto il caso del regista (mulberry32): le comitive da
   *  hash(serviceKey + ':' + id), i camerieri da seed ^ hash(chiave). Con lo
   *  stesso seme due schermi, alla porta e sulla TV, girano uguali. */
  seed: number;
  /** Solo per i test: i numeri da cambiare rispetto a DIRECTOR_TUNING. */
  tuning?: Partial<DirectorTuning>;
}

/** Il regista visto da fuori: quello che la pagina e il canvas usano. La
 *  classe SceneDirector (model/director.ts) lo implementa. */
export interface SceneDirectorApi {
  /** Il nuovo modello, al commit di React (una volta, chiunque arrivi prima
   *  fra l'eco del socket e la risposta HTTP). Confronta model.partyStates
   *  con quelli dell'ultimo update e mette in scena i passaggi, o li porta
   *  dritti allo stato finale con `reason` (o col limite dei cambi in
   *  blocco). Il primo modello e un model.service.key diverso azzerano
   *  tutto, senza eventi: accompagnamenti, cambi di tavolo e i loro tavoli
   *  «in arrivo» spariscono, e chi li disegna li rilegge dopo l'update.
   *  Emette gli eventi qui dentro, prima di tornare. */
  update(model: SceneModel, reason: SnapReason | null): void;
  /** Avanza di `dtMs` (il delta del frame, in ms). Lo chiama il canvas, una
   *  volta per frame, prima di ogni altro useFrame. */
  step(dtMs: number): void;
  /** Tutto quello che è in corso arriva in fondo adesso: accompagnamenti
   *  (le code comprese) seduti, uscite concluse, hostess all'accoglienza,
   *  camerieri al pass. Al ritorno visibile della scheda, e quando la vista
   *  3D sparisce. */
  fastForward(): void;
  /** Cambia le condizioni (solo i campi dati). Si possono chiamare in
   *  qualunque ordine e quante volte si vuole: uguali, non cambia niente. */
  configure(patch: Partial<DirectorSettings>): void;
  /** Gli attori da disegnare nella sala: le persone in un passaggio,
   *  l'hostess (sempre: cammina, e il suo nome la segue) e i camerieri. Un
   *  array del regista, riusato: si legge nel frame e non si conserva. */
  actorsIn(roomId: number): readonly ActorView[];
  /** Le chiavi di room.figures (di questa sala, nell'ultimo modello) che il
   *  regista ha in mano adesso: People le salta. Quasi tutte le disegna lui,
   *  anche in un'altra sala (chi cambia sala svanisce da quella vecchia); le
   *  altre restano nascoste apposta: gli ospiti in coda per
   *  l'accompagnamento non si vedono ancora, né al tavolo né alla porta. Più
   *  host:<roomId>, sempre, e le chiavi di chi il regista tiene in questa
   *  sala anche se nel modello non c'è più (chi esce, chi svanisce): un
   *  People con la lista di prima non le ridisegna. Un Set del regista,
   *  riusato. */
  movingKeys(roomId: number): ReadonlySet<string>;
  /** L'etichetta della comitiva accompagnata in quella sala, o null. Un
   *  oggetto del regista, riusato. */
  tagIn(roomId: number): ActorTag | null;
  /** I tavoli disegnati della sala verso cui un accompagnamento è in coda o
   *  in corso, finché l'ultimo non si siede. Li legge «Segui il servizio»,
   *  per non tagliare via un accompagnamento a metà; l'anello lo decide
   *  arrivalTargets, che li comprende. Un Set del regista, riusato. */
  escortTargets(roomId: number): ReadonlySet<number>;
  /** I tavoli della sala da disegnare «in arrivo» con l'anello
   *  (withArrivalTargets): quelli di escortTargets, più il tavolo nuovo di
   *  una comitiva che ci sta andando a piedi da un altro tavolo (un cambio di
   *  tavolo, vedi 'moved'; anche da un'altra sala: il tavolo pulsa nella
   *  sua). Ognuno resta finché l'ultimo della comitiva non si siede, anche se
   *  Reception l'ha già segnata lì. Un Set del regista, riusato. */
  arrivalTargets(roomId: number): ReadonlySet<number>;
  /** Quanti frame servono adesso (vedi FrameNeed). */
  frameNeed(): FrameNeed;
  /** Con frameNeed() 'none': fra quanti ms qualcuno della sala sullo
   *  schermo ripartirà (un cameriere che finisce la pausa al pass). null:
   *  nessuno, finché non arriva un update. */
  wakeInMs(): number | null;
  /** Un ospite o l'hostess sono a metà di un passaggio, o c'è un
   *  accompagnamento in coda. I camerieri non contano: girano tutto il
   *  servizio. La ricarica automatica di uno schermo fissato aspetta che
   *  torni false. */
  isAnimating(): boolean;
  /** Cresce quando cambia chi disegna chi: un attore entra o esce, una
   *  chiave entra o esce da movingKeys, cambiano escortTargets,
   *  arrivalTargets o le etichette. People lo confronta a ogni frame (un
   *  numero) e si riscrive solo allora. */
  readonly revision: number;
  /** Gli eventi, per la striscia e «Segui il servizio». Restituisce lo
   *  stacco. */
  onEvent(cb: (event: DirectorEvent) => void): () => void;
  /** Avvisa dopo ogni update, fastForward e configure: il canvas rilegge
   *  frameNeed e wakeInMs e si risveglia. Durante step non avvisa: il canvas
   *  è già nel frame. Restituisce lo stacco. */
  subscribe(cb: () => void): () => void;
}
