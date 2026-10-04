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
 *  stesso ordine del glifo 2D: PR2c ci fa sedere gli ospiti per indice. */
export interface ChairModel {
  /** Il centro della sedia sul pavimento, in metri. */
  x: number;
  z: number;
  /** rotation.y di una sedia modellata col davanti verso +Z locale e lo
   *  schienale verso −Z: atan2(dx, dz) della direzione sedia → tavolo. Chi ci
   *  si siede guarda il tavolo. */
  yaw: number;
  /** Disegnata piena: le stesse sedie che la piantina accende
   *  (litChairIndices). Spenta = posto vuoto di un tavolo occupato, che la
   *  scena schiarisce come l'opacità 0,25 della 2D. Un tavolo libero le ha
   *  tutte piene, come in 2D. */
  lit: boolean;
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
  chairs: ChairModel[];
  /** L'anello che pulsa: status === 'inarrivo'. */
  pulse: boolean;
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

/** Quante persone, per il riassunto in testata. Persone, non comitive. */
export interface ServiceSummary {
  /** Ospiti a tavola adesso: la comitiva seduta che colora ogni gruppo di
   *  tavoli, finché non passano 45 minuti dalla sua fine prevista (la stessa
   *  grazia con cui PR2c smette di disegnarli). */
  seated: number;
  /** Ospiti in arrivo: quelli dietro gli anelli che pulsano. */
  arriving: number;
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
  /** Il contenuto (tavoli e segnaposto), in metri: è quello che la camera
   *  inquadra, non il pavimento intero. */
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  tables: TableModel[];
  markers: Record<FloorMarkerKind, MarkerModel>;
  audit: RoomAudit;
  summary: RoomSummary;
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
