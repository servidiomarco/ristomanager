import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, BellOff, BellRing, Check, ChevronRight, Loader2, MessagesSquare, Pencil, Play, Search, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useNow } from '../hooks/useNow';
import { useAuth } from '../contexts/AuthContext';
import { socketClient } from '../services/socketClient';
import { staffChatApiService } from '../services/staffChatApiService';
import { channelThreadKey, staffMessagePreview, type StaffMessage } from '../services/staffChat';
import {
  getKdsQueue, getKdsServed, setKdsItemStatus, getMenuCatalogue, getKdsRevisions, ackKdsRevision,
  callWaiterForCourse, serveCourse, getOrderTimeline,
  type KdsItem, type KdsCourseState, type KdsOtherItem, type KdsServedCourse, type MenuCatalogue, type OrderRevision,
  type OrderTimelineEvent,
} from '../services/ordersApiService';
import { getKitchenServiceSummary, type KitchenServiceSummary } from '../services/apiService';
import { getRomeDatePart, getRomeTimePart } from '../utils/reservationTime';
import { chime } from '../utils/chime';
import { ModalShell, EmptyState, SearchField, SegmentedControl, StatusPill, dsButton } from './ds';

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
const SOUND_KEY = 'kds.sound';

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
// informazione: accanto c'è sempre il numero. Le famiglie del design system
// invertono già da sole fra tema chiaro e scuro.
const timerTone = (min: number): string =>
  min >= 10 ? 'text-[var(--ds-critical-text)]'
  : min >= 5 ? 'text-[var(--ds-pending-text)]'
  : 'text-[var(--ds-seated-text)]';

/* La scelta della partita: una riga per postazione, alta abbastanza da
   prenderla con il pollice. Il bordo pieno segna quella attiva. */
const stationOption = (active: boolean): string =>
  `flex min-h-[56px] w-full items-center gap-3 rounded-[16px] px-4 py-3 text-left transition-colors ${
    active
      ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)]'
      : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
  }`;

interface Column {
  key: string;
  order_id: number;
  course_no: number;
  table_name: string | null;
  customer_name: string | null;
  /** Chi ha preso la comanda: in cucina serve sapere a chi chiedere
   *  («questo 12 senza glutine è di Luca?»). */
  openedBy: string | null;
  allergens: string | null;
  items: KdsItem[];
  firedAt: string | null;
  waitingOthers: boolean;
  /** Le righe delle altre partite sulla stessa uscita (sola lettura). */
  others: KdsOtherItem[];
}

interface KitchenDisplayProps {
  globalDate?: Date;
  globalShiftFilter?: 'ALL' | 'LUNCH' | 'DINNER';
  /** Passe spento (Impostazioni → Sala e cucina): chiama e servito passano
   *  alle card di questo monitor. */
  passeEnabled?: boolean;
}

// Turno "corrente" quando l'utente non ne ha scelto uno esplicito: prima delle
// 17 è pranzo, dopo è cena. Stessa soglia usata dal server per il default.
const DINNER_START_HOUR = 17;
const inferShift = (d: Date): 'LUNCH' | 'DINNER' =>
  d.getHours() < DINNER_START_HOUR ? 'LUNCH' : 'DINNER';

export const KitchenDisplay: React.FC<KitchenDisplayProps> = ({ globalDate, globalShiftFilter, passeEnabled = true }) => {
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
  const [others, setOthers] = useState<KdsOtherItem[]>([]);
  // «In lavorazione» è il lavoro; «Consegnate» è consultazione («il 12 dice
  // che manca il piatto: l'abbiamo mandato?») — sola lettura, mai un posto
  // dove le card si annidano prima del servito.
  const [view, setView] = useState<'lavoro' | 'consegnate'>('lavoro');
  const [served, setServed] = useState<KdsServedCourse[]>([]);
  // Ricerca comande: la lente accanto alla campana apre il campo, che filtra
  // sia il lavoro sia le Consegnate. Chiudere azzera: una ricerca dimenticata
  // aperta non deve nascondere le comande nuove del servizio.
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  // La vita della comanda, dal tocco su una card delle Consegnate:
  // consultazione — risponde alle dispute coi numeri, non coi ricordi.
  const [timelineFor, setTimelineFor] = useState<{ orderId: number; tableName: string | null; customerName: string | null } | null>(null);
  // Revisioni aperte: modifiche a comande già lanciate (storno, aggiunta,
  // riporta, trasferimento). La card mostra "modificata", il tocco apre il
  // dettaglio, Ok le spegne per tutti gli schermi.
  const [revisions, setRevisions] = useState<OrderRevision[]>([]);
  const [revisionsModalKey, setRevisionsModalKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [picking, setPicking] = useState(false);
  // Riepilogo del servizio (aggregato lato server dalle note strutturate +
  // dalle dietary_notes clienti). Aggiornato all'apertura e ogni 60s: cambia
  // solo quando nuove prenotazioni entrano nel turno, non serve real-time.
  const [summary, setSummary] = useState<KitchenServiceSummary | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Avviso sonoro sulla comanda nuova. Nel ref oltre che nello stato: il
  // listener socket deve leggere il valore corrente senza risottoscriversi.
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

  useEffect(() => { getMenuCatalogue().then(setCatalogue).catch(() => {}); }, []);

  // Striscia della chat staff: l'ultimo messaggio non letto del canale
  // cucina, così "finito il branzino" arriva sul monitor senza aprire la
  // chat. "Ok" marca letto col cursore e la striscia sparisce anche dagli
  // altri device dello stesso account (evento staffchat:read).
  const { user } = useAuth();
  const userIdRef = useRef<number | null>(null);
  userIdRef.current = user?.id ?? null;
  const [chatStrip, setChatStrip] = useState<{ message: StaffMessage; unread: number } | null>(null);
  const CUCINA_KEY = channelThreadKey('cucina');

  useEffect(() => {
    let cancelled = false;
    // Se il ruolo non ha staffchat:use la chiamata fallisce con 403 e la
    // striscia semplicemente non esiste.
    staffChatApiService.listThreads()
      .then(({ threads }) => {
        if (cancelled) return;
        const cucina = threads.find(t => t.threadKey === CUCINA_KEY);
        if (cucina?.lastMessage && cucina.unreadCount > 0) {
          setChatStrip({ message: cucina.lastMessage, unread: cucina.unreadCount });
        }
      })
      .catch(() => {});

    const onMessage = (msg: StaffMessage) => {
      if (msg.kind !== 'channel' || msg.channel !== 'cucina') return;
      if (msg.sender_user_id != null && msg.sender_user_id === userIdRef.current) return;
      setChatStrip(prev => ({ message: msg, unread: (prev?.unread ?? 0) + 1 }));
      // Stessa campana delle comande: in cucina un avviso muto non esiste.
      if (soundRef.current) chime();
    };
    const onRead = (data: { threadKey: string; lastReadMessageId: number }) => {
      if (data?.threadKey !== CUCINA_KEY) return;
      setChatStrip(prev => (prev && prev.message.id <= data.lastReadMessageId ? null : prev));
    };

    let attached: ReturnType<typeof socketClient.getSocket> = null;
    const attach = (s: ReturnType<typeof socketClient.getSocket>) => {
      if (attached === s) return;
      if (attached) {
        attached.off('staffchat:message', onMessage);
        attached.off('staffchat:read', onRead);
      }
      attached = s;
      if (attached) {
        attached.on('staffchat:message', onMessage);
        attached.on('staffchat:read', onRead);
      }
    };
    attach(socketClient.getSocket());
    const unsub = socketClient.onSocketChange((s) => attach(s));
    return () => { cancelled = true; unsub(); attach(null); };
  }, [CUCINA_KEY]);

  const dismissChatStrip = useCallback(() => {
    const current = chatStrip;
    if (!current) return;
    setChatStrip(null);
    staffChatApiService.markRead(CUCINA_KEY, current.message.id).catch(() => {});
  }, [chatStrip, CUCINA_KEY]);

  // Il banner segue la data/turno globale dell'header: se il cuoco naviga a
  // "Mar 18 Cena" vuole vedere il riepilogo di quel servizio, non di oggi.
  // Con turno "ALL" ripieghiamo sull'inferenza oraria del giorno selezionato.
  const summaryDate = globalDate ? getRomeDatePart(globalDate) : '';
  const summaryShift: 'LUNCH' | 'DINNER' =
    globalShiftFilter === 'LUNCH' || globalShiftFilter === 'DINNER'
      ? globalShiftFilter
      : inferShift(globalDate ?? new Date());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const params = summaryDate ? { date: summaryDate, shift: summaryShift } : undefined;
      getKitchenServiceSummary(params)
        .then(s => { if (!cancelled) setSummary(s); })
        .catch(() => { /* niente banner: solo dettaglio in meno */ });
    };
    load();
    const poll = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [summaryDate, summaryShift]);

  const reload = useCallback(async () => {
    try {
      const [q, rev] = await Promise.all([
        getKdsQueue(stationId),
        // Un errore sulle revisioni non deve accecare la coda.
        getKdsRevisions(stationId).catch(() => ({ revisions: [] as OrderRevision[] })),
      ]);
      setItems(q.items);
      setCourses(q.courses);
      setOthers(q.others ?? []);
      setRevisions(rev.revisions);
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
  // Le uscite a schermo: filtra gli eventi delle altre partite, così un
  // monitor non ricarica per ogni riga avanzata in tutta la cucina.
  const courseKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const socket = socketClient.getSocket();
    if (!socket) return;
    if (stationId != null) socketClient.subscribeToStation(stationId);

    const onChange = () => reload();
    // La comanda nuova suona, il resto no: in cucina l'unico evento che
    // richiede di alzare la testa è un lancio che arriva.
    const onFired = () => { if (soundRef.current) chime(); reload(); };
    socket.on('kds:fired', onFired);
    socket.on('kds:item', onChange);
    // Servita al passe: le righe escono dalla coda e la card verde sparisce
    // anche dal monitor di partita, non solo dal passe. Il riporta le fa
    // ricomparire.
    socket.on('course:served', onChange);
    socket.on('course:unserved', onChange);
    socket.on('orderItem:voided', onChange);
    socket.on('connect', onChange);
    // L'avanzamento di un'ALTRA partita: kds:item viaggia solo nella stanza
    // della partita della riga, quindi il piede «altre partite» e l'«attende
    // le altre» restavano fermi fino al poll dei 60s (visto dal vivo: i Primi
    // segnano pronto e gli Antipasti leggono ancora «in coda»). Questi due
    // eventi girano già broadcast: si ricarica solo se l'uscita è a schermo.
    const onSibling = (p: any) => {
      if (p?.order_id == null) return;
      // La mia partita è già coperta da kds:item: qui interessano gli altri.
      if (p.station_id !== undefined && p.station_id === stationId) return;
      if (courseKeysRef.current.has(`${p.order_id}:${p.course_no}`)) reload();
    };
    socket.on('orderItem:status', onSibling);
    socket.on('course:ready', onSibling);
    // Revisione nuova: suona come una comanda — è un cambio di piano, non
    // rumore di fondo. station_ids NULL = riguarda tutti gli schermi.
    const onRevised = (r: OrderRevision) => {
      const mine = stationId == null || r.station_ids == null || r.station_ids.includes(stationId);
      if (!mine) return;
      setRevisions(prev => (prev.some(x => x.id === r.id) ? prev : [...prev, r]));
      if (soundRef.current) chime();
      reload();
    };
    const onRevisionAcked = (data: { id: number }) => {
      setRevisions(prev => prev.filter(r => r.id !== data?.id));
    };
    socket.on('order:revised', onRevised);
    socket.on('order:revision-acked', onRevisionAcked);

    const poll = setInterval(reload, 60_000);
    return () => {
      socket.off('kds:fired', onFired);
      socket.off('kds:item', onChange);
      socket.off('course:served', onChange);
      socket.off('course:unserved', onChange);
      socket.off('orderItem:voided', onChange);
      socket.off('connect', onChange);
      socket.off('orderItem:status', onSibling);
      socket.off('course:ready', onSibling);
      socket.off('order:revised', onRevised);
      socket.off('order:revision-acked', onRevisionAcked);
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

  // Col passe spento questi due gesti vivono sulle card pronte: la campanella
  // AVVISA la sala che l'uscita è al passe (annuncio nel canale sala — non
  // muove lo stato: i tempi del servizio restano ai camerieri), la spunta
  // segna servita l'uscita (via dal monitor → Consegnate).
  const [waiterCalled, setWaiterCalled] = useState<Set<string>>(new Set());
  const callWaiter = async (col: Column) => {
    setWaiterCalled(prev => new Set(prev).add(col.key));
    try {
      await callWaiterForCourse(col.order_id, col.course_no);
    } catch {
      // Fallito: la campanella torna attiva, l'avviso non è mai partito.
      setWaiterCalled(prev => { const n = new Set(prev); n.delete(col.key); return n; });
    }
  };
  const serveColumn = async (col: Column) => {
    try { await serveCourse(col.order_id, col.course_no); } catch { /* 409 se nel frattempo non è più tutta pronta */ }
    reload();
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
          openedBy: it.opened_by_name,
          allergens: it.customer_dietary_notes || it.reservation_notes,
          items: [],
          firedAt: it.fired_at,
          // L'uscita aspetta anche altre partite oltre alla mia?
          waitingOthers: !!st && st.waiting_station_ids.some(s => s !== stationId),
          others: others.filter(o => o.order_id === it.order_id && o.course_no === it.course_no),
        });
      }
      map.get(key)!.items.push(it);
    }
    return [...map.values()].sort((a, b) => {
      const ta = a.items[0]?.station_start_at ?? a.firedAt ?? '';
      const tb = b.items[0]?.station_start_at ?? b.firedAt ?? '';
      return ta.localeCompare(tb);
    });
  }, [items, courses, others, stationId]);

  useEffect(() => {
    courseKeysRef.current = new Set(columns.map(c => c.key));
  }, [columns]);

  // I tablet in sala sospendono la pagina in background e il socket perde
  // eventi: un'uscita servita da un ALTRO monitor qui restava a schermo, e
  // il tocco sulla card fantasma sembrava «servire di nuovo» (in realtà
  // 409 silenzioso + reload). Il rientro in primo piano rilegge la coda.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  // La lista delle consegnate si carica solo quando la si guarda: è
  // consultazione, non deve pesare sul monitor che lavora.
  useEffect(() => {
    if (view !== 'consegnate') return;
    let cancelled = false;
    const load = () => {
      getKdsServed(stationId)
        .then(r => { if (!cancelled) setServed(r.courses); })
        .catch(() => {});
    };
    load();
    const socket = socketClient.getSocket();
    socket?.on('course:served', load);
    socket?.on('course:unserved', load);
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      socket?.off('course:served', load);
      socket?.off('course:unserved', load);
      clearInterval(t);
    };
  }, [view, stationId]);

  const stationNames = useMemo(
    () => new Map((catalogue?.stations ?? []).map(s => [s.id, s.name])),
    [catalogue],
  );

  // "In arrivo" = lanciata ma la mia partita non deve ancora iniziare.
  const isUpcoming = (col: Column): boolean =>
    col.items.every(i => i.status === 'SENT')
    && col.items.every(i => i.station_start_at != null && new Date(i.station_start_at).getTime() > now);

  const revisionsByKey = useMemo(() => {
    const map = new Map<string, OrderRevision[]>();
    for (const col of columns) {
      const list = revisions.filter(r =>
        r.order_id === col.order_id && (r.course_no == null || r.course_no === col.course_no));
      if (list.length > 0) map.set(col.key, list);
    }
    return map;
  }, [columns, revisions]);

  const ackRevisions = useCallback(async (list: OrderRevision[]) => {
    setRevisionsModalKey(null);
    // Ottimistico come advance(): la pill sparisce al tocco, il server segue.
    setRevisions(prev => prev.filter(r => !list.some(l => l.id === r.id)));
    await Promise.all(list.map(r => ackKdsRevision(r.id).catch(() => {})));
  }, []);

  // Il filtro guarda ovunque il cuoco potrebbe cercare: tavolo, cliente,
  // operatore, piatti (anche delle altre partite).
  const query = search.trim().toLowerCase();
  const colMatches = (c: Column): boolean => !query
    || (c.table_name ?? '').toLowerCase().includes(query)
    || (c.customer_name ?? '').toLowerCase().includes(query)
    || (c.openedBy ?? '').toLowerCase().includes(query)
    || c.items.some(i => i.name_snapshot.toLowerCase().includes(query))
    || c.others.some(o => o.name_snapshot.toLowerCase().includes(query));

  const todo = columns.filter(c => !isUpcoming(c) && colMatches(c));
  const upcoming = columns.filter(c => isUpcoming(c) && colMatches(c));
  const servedFiltered = served.filter(c => !query
    || (c.table_name ?? '').toLowerCase().includes(query)
    || (c.customer_name ?? '').toLowerCase().includes(query)
    || c.items.some(i => i.name.toLowerCase().includes(query)));

  // Totale vivo per piatto di tutta la coda ("5× tagliata"): il cuoco che
  // batch-a le cotture lo legge qui invece di sommare a mente fra le card.
  // Diverso dal banner del servizio, che è previsionale dalle prenotazioni:
  // questo conta solo ciò che è lanciato e non ancora pronto.
  const allDay = useMemo(() => {
    const totals = new Map<string, number>();
    for (const i of items) {
      if (i.status === 'READY') continue;
      totals.set(i.name_snapshot, (totals.get(i.name_snapshot) ?? 0) + i.qty);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);

  const stationName = stationId == null
    ? 'Senza partita'
    : catalogue?.stations.find(s => s.id === stationId)?.name ?? `Partita ${stationId}`;

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-10 text-[15px] text-[var(--ds-text-muted)]">
        <Loader2 className="animate-spin" size={18} /> Caricamento coda…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--ds-canvas)]">
      {/* Una card che galleggia sulla tela, come le altre intestazioni di
          pagina — non una barra a filo con una linea sotto. */}
      <div className="flex-shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center gap-3 rounded-[20px] bg-[var(--ds-surface)] p-3 pl-4 shadow-[var(--ds-shadow-card)]">
          {/* Il nome della partita in tondo, non in maiuscolo: a un metro di
              distanza conta il corpo, e le maiuscole cancellano la forma della
              parola invece di renderla più leggibile (§5.2). */}
          <h1 className="min-w-0 truncate text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            {stationName}
          </h1>
          {/* Il contatore è entrato nel tab: dice la stessa cosa di prima e
              in più apre l'archivio del servito. */}
          <div className="flex-shrink-0">
            <SegmentedControl<'lavoro' | 'consegnate'>
              value={view}
              onChange={setView}
              ariaLabel="In lavorazione o consegnate"
              options={[
                { value: 'lavoro', label: 'In lavorazione', badge: todo.length || undefined },
                { value: 'consegnate', label: 'Consegnate' },
              ]}
            />
          </div>
          {offline && (
            <StatusPill tone="pending">
              <WifiOff size={13} aria-hidden /> riconnessione…
            </StatusPill>
          )}
          {/* Icona sola, 44px: la lente apre il campo di ricerca sotto la
              testata; richiuderla azzera il filtro. */}
          <button
            type="button"
            onClick={() => setSearchOpen(o => { if (o) setSearch(''); return !o; })}
            aria-pressed={searchOpen}
            aria-label={searchOpen ? 'Chiudi la ricerca' : 'Cerca una comanda'}
            className={`ml-auto inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              searchOpen
                ? 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
                : 'bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] hover:bg-[var(--ds-border)]'
            }`}
          >
            <Search size={17} aria-hidden />
          </button>
          {/* Icona sola, 44px, incassata sulla card come i controlli quiet:
              il testo qui non aggiungerebbe nulla che la campana non dica. */}
          <button
            type="button"
            onClick={toggleSound}
            aria-pressed={sound}
            aria-label={sound ? 'Disattiva l\'avviso sonoro' : 'Attiva l\'avviso sonoro'}
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {sound ? <Bell size={17} aria-hidden /> : <BellOff size={17} className="text-[var(--ds-text-muted)]" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => setPicking(true)}
            className={`flex-shrink-0 ${dsButton.quiet}`}
          >
            Cambia partita
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="flex-shrink-0 px-4 pb-3">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Cerca tavolo, cliente o piatto…"
            ariaLabel="Cerca una comanda"
            inputRef={searchRef}
          />
        </div>
      )}

      {chatStrip && (
        <div className="flex-shrink-0 px-4 pb-3">
          {/* Corpi grandi come il resto del monitor: si legge da un metro.
              Il bordo nella famiglia arriving segnala "qualcuno ti parla"
              senza gridare critico. */}
          <div className="flex items-center gap-3 rounded-[20px] border-l-4 border-[var(--ds-arriving-solid)] bg-[var(--ds-surface)] p-3 pl-4 shadow-[var(--ds-shadow-card)]">
            <MessagesSquare size={18} className="flex-shrink-0 text-[var(--ds-text-secondary)]" aria-hidden />
            <p className="min-w-0 flex-1 text-[16px] text-[var(--ds-text-primary)]">
              <span className="font-semibold">{chatStrip.message.sender_name}</span>
              {' '}<span className="break-words">{staffMessagePreview(chatStrip.message)}</span>
              {chatStrip.unread > 1 && (
                <span className="ml-2 text-[14px] text-[var(--ds-text-muted)]">
                  +{chatStrip.unread - 1} non lett{chatStrip.unread - 1 === 1 ? 'o' : 'i'}
                </span>
              )}
            </p>
            <button
              type="button"
              onClick={dismissChatStrip}
              className="inline-flex h-11 flex-shrink-0 items-center rounded-full bg-[var(--ds-surface-row)] px-5 text-[15px] font-semibold text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              Ok
            </button>
          </div>
        </div>
      )}

      {summary && (
        <ServiceSummaryBanner
          summary={summary}
          open={summaryOpen}
          onToggle={() => setSummaryOpen(o => !o)}
        />
      )}

      {allDay.length > 0 && (
        <div className="flex-shrink-0 px-4 pb-3">
          <div className="flex items-center gap-2 overflow-x-auto rounded-[20px] bg-[var(--ds-surface)] px-3 py-2 shadow-[var(--ds-shadow-card)]">
            {allDay.map(([name, qty]) => (
              <span
                key={name}
                className="inline-flex flex-shrink-0 items-baseline gap-1 rounded-full bg-[var(--ds-surface-row)] px-2.5 py-1 text-[14px] font-semibold text-[var(--ds-text-primary)]"
              >
                <span className="tabular-nums">{qty}×</span>
                <span>{name}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {view === 'consegnate' ? (
        // Consultazione, non lavoro. Raggruppata PER COMANDA (chiesto dalla
        // brigata): una card per tavolo con dentro le sue uscite in ordine,
        // così i piatti consegnati allo stesso tavolo si leggono insieme.
        // Le comande ordinate per ultima uscita servita, la più recente in
        // alto — la domanda riguarda sempre gli ultimi minuti.
        // Il tocco su una comanda non copre la pagina: la lista scivola a
        // sinistra (max-width animato) e la storia si apre accanto — la
        // cucina continua a vedere l'archivio mentre legge la timeline.
        <div className="flex min-h-0 flex-1 gap-3 px-4 pb-4 pt-1">
          {/* p-1: l'anello della card selezionata sporge 2px fuori dal
              riquadro e senza respiro la colonna a scorrimento lo taglia
              (stesso male dell'anello «pronto» sulle card, stesso rimedio). */}
          <div className={`min-h-0 w-full overflow-y-auto p-1 transition-[max-width] duration-300 ease-out ${timelineFor ? 'mx-auto max-w-[340px] flex-shrink-0' : 'mx-auto max-w-[640px]'}`}>
          {servedFiltered.length === 0 ? (
            <EmptyState icon={Check}>
              {query ? 'Nessuna uscita servita per questa ricerca.' : 'Nessuna uscita servita in questo servizio.'}
            </EmptyState>
          ) : (
            <div className="space-y-2">
              {(() => {
                const byOrder = new Map<number, KdsServedCourse[]>();
                for (const c of servedFiltered) {
                  if (!byOrder.has(c.order_id)) byOrder.set(c.order_id, []);
                  byOrder.get(c.order_id)!.push(c);
                }
                const orders = [...byOrder.values()]
                  .map(list => [...list].sort((a, b) => a.course_no - b.course_no))
                  .sort((a, b) => {
                    const la = Math.max(...a.map(c => new Date(c.served_at).getTime()));
                    const lb = Math.max(...b.map(c => new Date(c.served_at).getTime()));
                    return lb - la;
                  });
                return orders.map(list => {
                  const head = list[0];
                  return (
                    // Il tocco apre la vita della comanda: qui la card è
                    // inerte (a differenza di quelle in lavorazione, dove le
                    // righe si toccano per segnare pronto), quindi può essere
                    // tutta bersaglio.
                    <button
                      type="button"
                      key={head.order_id}
                      onClick={() => setTimelineFor(prev => prev?.orderId === head.order_id
                        ? null
                        : { orderId: head.order_id, tableName: head.table_name, customerName: head.customer_name })}
                      aria-pressed={timelineFor?.orderId === head.order_id}
                      aria-label={`Storia della comanda del tavolo ${head.table_name ?? head.order_id}`}
                      className={`block w-full rounded-[16px] bg-[var(--ds-surface)] px-4 py-3 text-left shadow-[var(--ds-shadow-card)] transition-colors hover:bg-[var(--ds-surface-row)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
                        timelineFor?.orderId === head.order_id ? 'ring-2 ring-[var(--ds-action-bg)]' : ''
                      }`}
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="text-[16px] font-semibold text-[var(--ds-text-primary)]">
                          T{head.table_name ?? '—'}
                        </span>
                        {head.customer_name && (
                          <span className="min-w-0 truncate text-[13px] text-[var(--ds-text-muted)]">{head.customer_name}</span>
                        )}
                        <span className="ml-auto flex-shrink-0 text-[13px] tabular-nums text-[var(--ds-text-muted)]">
                          {list.length === 1 ? '1 uscita servita' : `${list.length} uscite servite`}
                        </span>
                      </div>
                      <div className="mt-2 space-y-1.5">
                        {list.map(c => {
                          // Le MIE righe in primo piano (peso e corpo pieni);
                          // quelle delle altre partite sotto, in corpo 12 e
                          // attenuate, col nome della partita davanti. Le
                          // quantità si SOMMANO per piatto («2× Amatriciana»
                          // invece di due righe uguali): è metà del rumore.
                          const aggregate = (its: typeof c.items): string => {
                            const byName = new Map<string, number>();
                            for (const i of its) byName.set(i.name, (byName.get(i.name) ?? 0) + i.qty);
                            return [...byName.entries()].map(([name, qty]) => `${qty}× ${name}`).join(' · ');
                          };
                          const mine = c.items.filter(i => stationId == null || i.station_id === stationId);
                          const othersByStation = new Map<number | null, typeof c.items>();
                          for (const i of c.items) {
                            if (stationId != null && i.station_id !== stationId) {
                              if (!othersByStation.has(i.station_id)) othersByStation.set(i.station_id, []);
                              othersByStation.get(i.station_id)!.push(i);
                            }
                          }
                          return (
                            <div key={c.course_no} className="text-[14px]">
                              <div className="flex items-baseline gap-2">
                                <span className="flex-shrink-0 font-medium text-[var(--ds-text-primary)]">
                                  {ORDINALS[c.course_no] ?? c.course_no}
                                </span>
                                <span className="min-w-0 flex-1 font-medium text-[var(--ds-text-primary)]">
                                  {aggregate(mine)}
                                </span>
                                <span className="flex-shrink-0 tabular-nums text-[var(--ds-text-muted)]">
                                  {getRomeTimePart(c.served_at)}
                                </span>
                              </div>
                              {[...othersByStation.entries()].map(([sid, its]) => (
                                <div key={sid ?? 'x'} className="ml-6 text-[12px] leading-snug text-[var(--ds-text-muted)]">
                                  {stationNames.get(sid ?? -1) ?? 'altra partita'} · {aggregate(its)}
                                </div>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </button>
                  );
                });
              })()}
            </div>
          )}
          </div>
          {timelineFor && (
            <div className="min-h-0 flex-1 overflow-y-auto" style={{ animation: 'tileIn 220ms ease-out both' }}>
              <TimelinePane
                orderId={timelineFor.orderId}
                tableName={timelineFor.tableName}
                customerName={timelineFor.customerName}
                onClose={() => setTimelineFor(null)}
              />
            </div>
          )}
        </div>
      ) : (
      /* pt-1: l'anello di stato delle card sporge 2px fuori dal riquadro, e
          senza un filo di padding l'overflow nascosto ne mangiava il lato alto. */
      <div className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 pb-4 pt-1">
        {todo.length === 0 && upcoming.length === 0 ? (
          <EmptyState icon={Check}>
            {query ? 'Nessuna comanda per questa ricerca.' : 'Nessuna comanda in coda.'}
          </EmptyState>
        ) : (
          <div className="flex h-full items-start gap-4">
            {todo.map(col => (
              <CourseCard
                key={col.key}
                col={col}
                now={now}
                stationId={stationId}
                stationNames={stationNames}
                onAdvance={advance}
                onCallWaiter={passeEnabled ? undefined : callWaiter}
                waiterCalled={waiterCalled.has(col.key)}
                onServeCourse={passeEnabled ? undefined : serveColumn}
                revisions={revisionsByKey.get(col.key)}
                onShowRevisions={() => setRevisionsModalKey(col.key)}
              />
            ))}
          </div>
        )}
      </div>
      )}

      {view === 'lavoro' && upcoming.length > 0 && (
        <div className="flex-shrink-0 px-4 pb-4">
          <div className="mb-2 text-[13px] font-semibold text-[var(--ds-text-muted)]">In arrivo</div>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {upcoming.map(col => {
              const wait = minutesUntil(col.items[0]?.station_start_at ?? null, now);
              return (
                // Bordo tratteggiato invece di un'opacità: l'opacità porta il
                // testo sotto il minimo di contrasto proprio sullo schermo che
                // si legge da lontano.
                <div
                  key={col.key}
                  className="flex-shrink-0 rounded-[16px] border-2 border-dashed border-[var(--ds-border-strong)] px-3 py-2"
                >
                  <div className="text-[15px] font-semibold text-[var(--ds-text-primary)]">
                    T{col.table_name} · {ORDINALS[col.course_no] ?? col.course_no} usc.
                  </div>
                  <div className="text-[13px] text-[var(--ds-text-muted)]">
                    {col.items.map(i => `${i.qty} ${i.name_snapshot}`).join(', ')}
                  </div>
                  <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[14px] font-semibold text-[var(--ds-text-primary)] tabular-nums">
                      fra {Math.max(wait, 1)}′
                    </span>
                    {/* 44px: si preme con le mani sporche, non col mouse. */}
                    <button
                      type="button"
                      onClick={() => col.items.forEach(i => advance(i, 'PREPARING'))}
                      className="inline-flex h-11 items-center gap-1.5 rounded-full bg-[var(--ds-surface-row)] px-3.5 text-[14px] font-medium text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)]"
                    >
                      <Play size={13} aria-hidden /> inizia ora
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <ModalShell
        open={revisionsModalKey != null && (revisionsByKey.get(revisionsModalKey)?.length ?? 0) > 0}
        onClose={() => setRevisionsModalKey(null)}
        title={`Modifiche · T${columns.find(c => c.key === revisionsModalKey)?.table_name ?? '—'}`}
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
      >
        <div className="space-y-3">
          {(revisionsByKey.get(revisionsModalKey ?? '') ?? []).map(r => (
            <div key={r.id} className="rounded-[14px] bg-[var(--ds-surface-row)] px-3.5 py-3">
              <p className="text-[16px] font-semibold text-[var(--ds-text-primary)]">{r.summary}</p>
              {(r.details ?? []).filter(d => d.note).map((d, i) => (
                <p key={i} className="mt-1 text-[14px] text-[var(--ds-text-secondary)]">{d.label} — {d.note}</p>
              ))}
              <p className="mt-1.5 text-[13px] text-[var(--ds-text-muted)]">
                {r.created_by_name} · {new Date(r.created_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          ))}
          <button
            type="button"
            onClick={() => ackRevisions(revisionsByKey.get(revisionsModalKey ?? '') ?? [])}
            className={`${dsButton.primary} w-full`}
          >
            Ok, visto
          </button>
        </div>
      </ModalShell>

      <ModalShell
        open={picking}
        onClose={() => setPicking(false)}
        title="Partita di questo schermo"
        subtitle="Resta impostata anche dopo un riavvio del tablet."
        size="sm"
        closeOnEscape
        bodyClassName="p-5 sm:p-6"
      >
        <div className="flex flex-col gap-2">
          {catalogue?.stations.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => chooseStation(s.id)}
              aria-pressed={s.id === stationId}
              className={stationOption(s.id === stationId)}
            >
              <span className="min-w-0 flex-1 text-[16px] font-semibold">{s.name}</span>
              {s.id === stationId && <Check size={18} className="flex-shrink-0" aria-hidden />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => chooseStation(null)}
            aria-pressed={stationId == null}
            className={stationOption(stationId == null)}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[16px] font-semibold">Senza partita</span>
              <span className={`block text-[13px] ${stationId == null ? 'opacity-80' : 'text-[var(--ds-text-muted)]'}`}>
                piatti non ancora assegnati
              </span>
            </span>
            {stationId == null && <Check size={18} className="flex-shrink-0" aria-hidden />}
          </button>
        </div>
      </ModalShell>
    </div>
  );
};

const CourseCard: React.FC<{
  col: Column;
  now: number;
  stationId: number | null;
  onAdvance: (item: KdsItem, status: 'PREPARING' | 'READY') => void;
  stationNames?: Map<number, string>;
  /** Presenti solo col passe spento: la campanella avvisa la sala che
   *  l'uscita è pronta (non muove lo stato), la spunta la segna servita. */
  onCallWaiter?: (col: Column) => void;
  waiterCalled?: boolean;
  onServeCourse?: (col: Column) => void;
  revisions?: OrderRevision[];
  onShowRevisions?: () => void;
}> = ({ col, now, onAdvance, stationNames, onCallWaiter, waiterCalled, onServeCourse, revisions, onShowRevisions }) => {
  const start = col.items[0]?.station_start_at ?? col.firedAt;
  const elapsed = minutesSince(start, now);
  const allReady = col.items.every(i => i.status === 'READY');

  // Le altre partite della stessa uscita, compresse in un pallino a testa:
  // il pacing («la griglia è indietro, aspetto a calare») si legge sempre,
  // il dettaglio si apre col tocco solo quando serve. Mai righe altrui in
  // mezzo alle mie: quelle si toccano per segnare pronto, queste no.
  const [othersOpen, setOthersOpen] = useState(false);
  const otherGroups = useMemo(() => {
    const map = new Map<number | null, KdsOtherItem[]>();
    for (const o of col.others) {
      if (!map.has(o.station_id)) map.set(o.station_id, []);
      map.get(o.station_id)!.push(o);
    }
    return [...map.entries()];
  }, [col.others]);

  // Ho finito ma l'uscita no: da qui in poi il piatto peggiora sotto la
  // lampada, e il ritardo è di qualcun altro. Il bordo lampeggia per dirlo.
  const readySince = allReady
    ? Math.min(...col.items.map(i => minutesSince(i.ready_at, now)))
    : 0;
  const lampAlert = allReady && col.waitingOthers && readySince >= LAMP_ALERT_MIN;

  return (
    // Lo stato viaggia su un anello, non su un bordo: la card è una superficie
    // bianca sulla tela come tutte le altre, e l'anello si disegna fuori dal
    // riquadro senza spostare di due pixel il contenuto quando cambia stato.
    <div
      className={`flex max-h-full w-60 flex-shrink-0 flex-col overflow-hidden rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] ${
        lampAlert
          ? 'animate-pulse ring-2 ring-[var(--ds-critical-solid)]'
          : allReady
          ? 'ring-2 ring-[var(--ds-seated-solid)]'
          : ''
      }`}
    >
      <div className="px-3 py-2.5">
        <div className="flex items-baseline gap-2">
          <span className="text-[20px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            T{col.table_name ?? '—'}
          </span>
          <span className={`ml-auto text-[20px] font-semibold tabular-nums ${timerTone(elapsed)}`}>
            {elapsed}′
          </span>
        </div>
        <div className="text-[13px] text-[var(--ds-text-muted)]">
          {ORDINALS[col.course_no] ?? col.course_no} uscita
          {col.customer_name ? ` · ${col.customer_name}` : ''}
        </div>
        {/* «di Luca», non un'etichetta lunga: in cucina serve solo sapere a
            chi chiedere. Sta su una riga sua per non confondersi col nome
            del CLIENTE qui sopra. */}
        {col.openedBy && (
          <div className="text-[12px] text-[var(--ds-text-muted)]">di {col.openedBy}</div>
        )}
        {/* Comanda cambiata dopo il lancio: rosso pieno per scelta di Marco
            (29/08) — l'ambra tinta annegava fra venti card nel picco, e qui
            la modifica È un'interruzione: continuare a cucinare un piatto
            stornato è spreco. 44px: si tocca con le mani in pasta. */}
        {revisions && revisions.length > 0 && onShowRevisions && (
          <button
            type="button"
            onClick={onShowRevisions}
            className="mt-2 flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-[12px] bg-[var(--ds-critical-solid)] px-3 text-[14px] font-semibold text-[var(--ds-critical-fg)] transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Pencil size={14} aria-hidden />
            modificata{revisions.length > 1 ? ` · ${revisions.length}` : ''}
          </button>
        )}
      </div>

      {col.allergens && (
        <div className="flex items-start gap-1.5 bg-[var(--ds-critical-tint)] px-3 py-2 text-[13px] font-medium text-[var(--ds-critical-text)]">
          <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
          <span>{col.allergens}</span>
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 py-2">
        {col.items.map(i => {
          // Il fatto viene detto dal segno di spunta e dal testo attenuato, non
          // da un'opacità che porta sotto contrasto anche la quantità.
          const body = (
            <>
              <div className="flex items-start gap-2">
                <span
                  className={`font-semibold tabular-nums ${
                    i.status === 'READY' ? 'text-[var(--ds-text-muted)]' : 'text-[var(--ds-text-primary)]'
                  }`}
                >
                  {i.qty}
                </span>
                <span
                  className={`flex-1 text-[15px] leading-tight ${
                    i.status === 'READY'
                      ? 'text-[var(--ds-text-muted)] line-through'
                      : 'text-[var(--ds-text-primary)]'
                  }`}
                >
                  {i.name_snapshot}
                </span>
                {i.status === 'PREPARING' && (
                  <ChevronRight size={15} className="mt-0.5 flex-shrink-0 text-[var(--ds-arriving-text)]" aria-hidden />
                )}
                {i.status === 'READY' && (
                  <Check size={15} className="mt-0.5 flex-shrink-0 text-[var(--ds-seated-solid)]" aria-hidden />
                )}
              </div>
              {i.modifiers && i.modifiers.length > 0 && (
                <div className="ml-6 text-[13px] font-medium text-[var(--ds-pending-text)]">
                  ↳ {i.modifiers.map(m => m.name).join(', ')}
                </div>
              )}
              {i.note && <div className="ml-6 text-[13px] text-[var(--ds-text-muted)]">↳ {i.note}</div>}
            </>
          );
          // Ogni riga si spunta da sola: i piatti veloci escono senza aspettare
          // il resto dell'uscita. Il server accetta anche SENT→READY diretto, e
          // avvisa il passe solo quando l'ultima riga dell'uscita è pronta.
          // Un tocco sulla riga spuntata la annulla (READY→PREPARING, ready_at
          // azzerato): l'errore di spunta si corregge con lo stesso gesto che
          // l'ha creato, finché l'uscita non è servita.
          const ready = i.status === 'READY';
          return (
            <button
              key={i.id}
              type="button"
              onClick={() => onAdvance(i, ready ? 'PREPARING' : 'READY')}
              aria-label={ready
                ? `Annulla pronto: ${i.qty} ${i.name_snapshot}`
                : `Segna pronto: ${i.qty} ${i.name_snapshot}`}
              className="block min-h-11 w-full rounded-[12px] px-1.5 py-1.5 text-left transition-colors hover:bg-[var(--ds-surface-row)] active:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
            >
              {body}
            </button>
          );
        })}
      </div>

      {otherGroups.length > 0 && (
        <div className="flex-shrink-0 border-t border-[var(--ds-border)] px-2">
          <button
            type="button"
            onClick={() => setOthersOpen(o => !o)}
            aria-expanded={othersOpen}
            className="flex min-h-[44px] w-full flex-wrap items-center gap-x-3 gap-y-1 px-1 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            {otherGroups.map(([sid, list]) => {
              const ready = list.every(o => o.status === 'READY');
              const working = list.some(o => o.status === 'PREPARING');
              return (
                <span key={sid ?? 'x'} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--ds-text-secondary)]">
                  <span
                    aria-hidden
                    className={`h-2 w-2 flex-shrink-0 rounded-full ${
                      ready ? 'bg-[var(--ds-seated-solid)]'
                      : working ? 'bg-[var(--ds-pending-solid)]'
                      : 'bg-[var(--ds-border-strong)]'
                    }`}
                  />
                  {stationNames?.get(sid ?? -1) ?? 'altra partita'}
                  <span className="tabular-nums text-[var(--ds-text-muted)]">{list.reduce((n, o) => n + o.qty, 0)}</span>
                </span>
              );
            })}
            <ChevronRight
              size={14}
              className={`ml-auto flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${othersOpen ? 'rotate-90' : ''}`}
              aria-hidden
            />
          </button>
          {othersOpen && (
            <div className="space-y-0.5 pb-2 pl-1">
              {col.others.map(o => (
                <div key={o.id} className="flex items-baseline gap-2 text-[13px] text-[var(--ds-text-muted)]">
                  <span className="tabular-nums">{o.qty}×</span>
                  <span className="min-w-0 truncate">{o.name_snapshot}</span>
                  <span className="ml-auto flex-shrink-0">
                    {o.status === 'READY' ? 'pronto' : o.status === 'PREPARING' ? 'in lavorazione' : 'in coda'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-2 p-2">
        {allReady ? (
          <div className="min-w-0 flex-1 py-2 text-center text-[14px] font-semibold text-[var(--ds-seated-text)]">
            {col.waitingOthers ? `pronto · attende le altre partite (${readySince}′)` : 'pronto'}
          </div>
        ) : (
          // Non "PRONTO": il maiuscolo non aggiunge nulla che il corpo e il
          // peso non dicano già, e a schermo lo si legge peggio (§5.2).
          // "Tutto": la spunta del singolo piatto sta sulla riga, questo
          // chiude in un colpo quello che resta.
          <button
            type="button"
            onClick={() => col.items.filter(i => i.status !== 'READY').forEach(i => onAdvance(i, 'READY'))}
            className="min-w-0 flex-1 rounded-[16px] bg-[var(--ds-action-bg)] py-3.5 text-[17px] font-semibold text-[var(--ds-action-fg)] transition-colors hover:bg-[var(--ds-action-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            Tutto pronto
          </button>
        )}
        {/* Col passe spento i due gesti dell'uscita pronta stanno qui, come
            icone: la campanella AVVISA la sala che l'uscita è al passe
            (annuncio nel canale sala — non muove lo stato, i tempi del
            servizio restano ai camerieri), la spunta la segna servita.
            Nome per esteso nel title e nell'aria-label. */}
        {/* Solo a uscita pronta PER INTERO: finché waitingOthers è vero le
            altre partite stanno ancora cucinando — avvisare la sala o servire
            adesso spaccherebbe l'uscita. */}
        {onCallWaiter && allReady && !col.waitingOthers && (
          <button
            type="button"
            onClick={() => onCallWaiter(col)}
            disabled={waiterCalled}
            title={waiterCalled ? 'Sala avvisata' : "Avvisa la sala: l'uscita è pronta al ritiro"}
            aria-label={waiterCalled ? 'Sala avvisata' : "Avvisa la sala: l'uscita è pronta al ritiro"}
            className={`inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)] ${
              waiterCalled
                ? 'bg-[var(--ds-surface-row)] text-[var(--ds-text-muted)]'
                : 'bg-[var(--ds-action-bg)] text-[var(--ds-action-fg)] hover:bg-[var(--ds-action-bg-hover)]'
            }`}
          >
            <BellRing size={18} aria-hidden />
          </button>
        )}
        {onServeCourse && allReady && !col.waitingOthers && (
          <button
            type="button"
            onClick={() => onServeCourse(col)}
            title="Segna l'uscita servita"
            aria-label="Segna l'uscita servita"
            className="inline-flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-seated-solid)] text-white transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
          >
            <Check size={18} aria-hidden />
          </button>
        )}
      </div>
    </div>
  );
};

// Riepilogo del servizio: piatti da preparare in totale (aggregati per label
// e variante) + un elenco delle allergie/diete registrate per prenotazione.
// La cucina lo legge a colpo d'occhio a inizio turno per attrezzarsi ("stasera
// 8 stinchi di maiale, 3 di vitello, 2 tavoli senza glutine"). Le allergie
// restano libere (customers.dietary_notes) — non le aggreghiamo per non
// suggerire falsi conteggi su testo non normalizzato.
const ServiceSummaryBanner: React.FC<{
  summary: KitchenServiceSummary;
  open: boolean;
  onToggle: () => void;
}> = ({ summary, open, onToggle }) => {
  const shift = summary.shift === 'LUNCH' ? 'Pranzo' : 'Cena';
  const total = summary.dietary.reduce((s, d) => s + d.quantity, 0);
  const hasDietary = summary.dietary.length > 0;
  const hasDiets = summary.dietary_lines.length > 0;
  return (
    <div className="flex-shrink-0 px-4 pb-3">
      <div className="rounded-[20px] bg-[var(--ds-surface)] shadow-[var(--ds-shadow-card)] overflow-hidden">
        <button
          type="button"
          onClick={onToggle}
          className="w-full flex items-center gap-3 px-4 py-3 text-left"
          aria-expanded={open}
        >
          <span className="text-[13px] font-semibold text-[var(--ds-text-muted)]">
            {shift} · {summary.reservations} prenotazion{summary.reservations === 1 ? 'e' : 'i'}
          </span>
          <div className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
            {hasDietary
              ? summary.dietary.slice(0, 6).map(d => (
                <span
                  key={`${d.label}--${d.variant ?? ''}`}
                  className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-2.5 py-1 text-[13px] font-semibold text-[var(--ds-text-primary)]"
                >
                  <span className="tabular-nums">{d.quantity}×</span>
                  <span className="truncate">
                    {d.label}{d.variant ? ` (${d.variant})` : ''}
                  </span>
                </span>
              ))
              : <span className="text-[13px] text-[var(--ds-text-muted)]">Nessuna nota strutturata</span>
            }
            {hasDietary && summary.dietary.length > 6 && (
              <span className="text-[13px] text-[var(--ds-text-muted)]">+{summary.dietary.length - 6}</span>
            )}
          </div>
          {hasDiets && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--ds-critical-tint)] px-2.5 py-1 text-[13px] font-semibold text-[var(--ds-critical-text)]">
              <TriangleAlert size={13} aria-hidden />
              {summary.dietary_lines.length} allergi{summary.dietary_lines.length === 1 ? 'a' : 'e'}
            </span>
          )}
          <ChevronRight
            size={16}
            className={`flex-shrink-0 text-[var(--ds-text-muted)] transition-transform ${open ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </button>
        {open && (
          <div className="border-t border-[var(--ds-border)] px-4 py-3 space-y-3">
            {hasDietary && (
              <div>
                <div className="text-[13px] font-semibold text-[var(--ds-text-muted)] mb-1.5">
                  Piatti del turno ({total})
                </div>
                {/* Una riga per piatto, tavoli come pill: si legge da lontano
                    con le mani in pasta, quindi corpi grandi e testo pieno —
                    niente muted sotto i 14px su questo schermo. */}
                <ul className="divide-y divide-[var(--ds-border)]">
                  {summary.dietary.map(d => (
                    <li
                      key={`row-${d.label}--${d.variant ?? ''}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5 first:pt-0 last:pb-0"
                    >
                      <span className="text-[16px] font-semibold text-[var(--ds-text-primary)]">
                        <span className="tabular-nums">{d.quantity}×</span>
                        {' '}{d.label}{d.variant ? ` (${d.variant})` : ''}
                      </span>
                      {(d.tables ?? []).length > 0 && (
                        <span className="flex flex-wrap items-center gap-1.5">
                          {d.tables.map((t, i) => (
                            <span
                              key={t.table ?? `c-${i}`}
                              className="inline-flex items-center gap-1 rounded-full bg-[var(--ds-surface-row)] px-3 py-1.5 text-[14px] font-semibold text-[var(--ds-text-primary)]"
                            >
                              <span className="tabular-nums">{t.quantity}×</span>
                              <span>{t.table ? `T${t.table}` : t.customer || '—'}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasDiets && (
              <div>
                <div className="text-[13px] font-semibold text-[var(--ds-critical-text)] mb-1.5">
                  Allergie / diete
                </div>
                <ul className="space-y-1">
                  {summary.dietary_lines.map(l => (
                    <li key={l.reservation_id} className="flex items-start gap-2 text-[13px]">
                      <TriangleAlert size={13} className="mt-0.5 flex-shrink-0 text-[var(--ds-critical-text)]" aria-hidden />
                      <span className="text-[var(--ds-text-primary)]">
                        <span className="font-semibold">{l.customer_name || '—'}</span>
                        <span className="text-[var(--ds-text-muted)]"> · {l.text}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ── La vita di una comanda ───────────────────────────────────────────────
   Pannello accanto alle Consegnate (non un velo sopra): gli eventi su un
   binario verticale, pallino per famiglia — neutro per i passaggi, verde
   per il servito, rosso per gli storni, ambra per aggiunte e riporti —
   ora in grande sulla card di ogni evento, ingressi scaglionati con la
   tileIn di casa. Consultazione: risponde alle dispute coi numeri
   («chiamata 12:41, pronta 12:58, servita 13:07»), non coi ricordi. */
const TimelinePane: React.FC<{
  orderId: number;
  tableName: string | null;
  customerName: string | null;
  onClose: () => void;
}> = ({ orderId, tableName, customerName, onClose }) => {
  const [events, setEvents] = useState<OrderTimelineEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setEvents(null);
    setFailed(false);
    let cancelled = false;
    getOrderTimeline(orderId)
      .then(r => { if (!cancelled) setEvents(r.events); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [orderId]);

  const mins = (s: number) => Math.round(s / 60);
  const label = (e: OrderTimelineEvent): string => {
    switch (e.kind) {
      case 'opened': return `comanda aperta${e.by ? ` · ${e.by}` : ''}`;
      case 'course_fired': return `${ORDINALS[e.course_no] ?? e.course_no} uscita chiamata`;
      case 'course_started': return `${ORDINALS[e.course_no] ?? e.course_no} uscita in lavorazione`;
      case 'course_ready': return `${ORDINALS[e.course_no] ?? e.course_no} uscita pronta${e.sync_delta_s >= 60 ? ` · sincronia ${mins(e.sync_delta_s)}′` : ''}`;
      case 'course_served': return `${ORDINALS[e.course_no] ?? e.course_no} uscita servita${e.lamp_s != null && e.lamp_s >= 60 ? ` · ${mins(e.lamp_s)}′ sotto la lampada` : ''}`;
      case 'revision': return `${e.summary} · ${e.by}`;
    }
  };
  const dot = (e: OrderTimelineEvent): string => {
    if (e.kind === 'course_served') return 'bg-[var(--ds-seated-solid)]';
    if (e.kind === 'revision') return e.revision_kind === 'void' ? 'bg-[var(--ds-critical-solid)]' : 'bg-[var(--ds-pending-solid)]';
    return 'bg-[var(--ds-border-strong)]';
  };

  return (
    <div className="rounded-[20px] bg-[var(--ds-surface)] p-4 shadow-[var(--ds-shadow-card)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[18px] font-semibold tracking-[-0.015em] text-[var(--ds-text-primary)]">
            T{tableName ?? '—'} · comanda
          </h2>
          {customerName && (
            <p className="text-[13px] text-[var(--ds-text-muted)]">{customerName}</p>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Chiudi la storia"
          className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-[var(--ds-surface-row)] text-[var(--ds-text-primary)] transition-colors hover:bg-[var(--ds-border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-border-focus)]"
        >
          <X size={16} aria-hidden />
        </button>
      </div>

      {failed ? (
        <p className="mt-4 text-[14px] text-[var(--ds-critical-text)]">Storia non caricata: riprova.</p>
      ) : events == null ? (
        <div className="mt-4 flex items-center gap-2 text-[14px] text-[var(--ds-text-muted)]">
          <Loader2 size={16} className="animate-spin" aria-hidden /> Carico la storia…
        </div>
      ) : (
        <ol className="relative mt-5 space-y-3 pl-7">
          {/* Il binario: parte dal primo pallino e finisce sull'ultimo. */}
          <span className="absolute bottom-4 left-[5px] top-4 w-px bg-[var(--ds-border)]" aria-hidden />
          {events.map((e, i) => (
            <li
              key={i}
              className="relative"
              style={{ animation: 'tileIn 260ms ease-out both', animationDelay: `${Math.min(i * 45, 450)}ms` }}
            >
              <span
                className={`absolute -left-7 top-1/2 h-[11px] w-[11px] -translate-y-1/2 rounded-full ring-4 ring-[var(--ds-surface)] ${dot(e)}`}
                aria-hidden
              />
              <div className="flex items-center gap-3 rounded-[14px] bg-[var(--ds-surface-row)] px-3.5 py-2.5">
                <span className="min-w-0 flex-1 text-[14px] leading-snug text-[var(--ds-text-primary)]">{label(e)}</span>
                <span className="flex-shrink-0 text-[16px] font-semibold tabular-nums tracking-[-0.01em] text-[var(--ds-text-primary)]">
                  {getRomeTimePart(e.at)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
};
