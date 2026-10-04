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
   *  la scena reinquadra solo quando cambia `room.id` o arriva «Centra». */
  room: RoomModel;
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
