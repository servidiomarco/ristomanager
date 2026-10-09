// Routing verso il nodo di sala (modalità ibrida, tappa 3).
//
// Quando la modalità è attiva, le SOLE letture del dominio sala (la stessa
// whitelist di sala-node/readCache.ts) e il socket passano dal nodo in LAN;
// tutto il resto — e TUTTE le scritture — resta sul cloud. Il principio del
// piano ibrido: «il downgrade è il failover» — qualunque dubbio sul nodo e
// si torna al cloud, senza chiedere niente a nessuno.
//
// Il circuito: un errore di rete verso il nodo lo apre (tutto al cloud) e a
// richiuderlo è SOLO un probe /healthz riuscito, tentato in background al
// più ogni 30s dal primo GET instradabile che passa. Mai più il traffico
// vero a fare da probe: al collaudo del 17/09 il PC del nodo inghiottiva i
// SYN senza rifiutarli (blackhole: firewall/standby) e ogni «riprova» reale
// appendeva lo schermo per il timeout TCP del sistema — l'app sembrava
// piantata e il reload, ripartendo dalla config persistita, ripiombava nel
// buco. Stessa ragione del timeout esplicito in fetchNodeAware qui sotto.
//
// Config da GET /sala-node/client-config, persistita in localStorage così il
// boot non aspetta la rete (e durante un outage il reload — se la shell è in
// cache — riparte già puntato al nodo).

import { authApiService } from './authApiService';
import { isServiceWrite } from './serviceWrites';

export const CLOUD_API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

const STORAGE_KEY = 'sala_node_config_v1';
const PROBE_EVERY_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
// Sopra i 5s di CLOUD_TIMEOUT_MS del nodo (readCache): a cloud giù il nodo
// risponde stale solo DOPO il suo timeout verso il cloud — un limite client
// più stretto aborterebbe proprio le risposte che l'ibrido esiste per dare.
const NODE_FETCH_TIMEOUT_MS = 8_000;
// Anche le LETTURE verso il cloud hanno un guinzaglio: a WAN staccata una
// GET al cloud (config nodo non attiva su quel dispositivo, o circuito
// aperto) restava appesa per il timeout TCP di sistema — minuti — e la
// pagina KDS moriva su «Caricamento coda…» (scoperto al collaudo del
// 24/09). Le SCRITTURE restano senza guinzaglio: possono durare
// legittimamente, e la coda offline le protegge.

interface NodeConfig {
    enabled: boolean;
    node_url: string | null;
    /** Fase 4: l'autorità delle battiture di sala è sul nodo — le SCRITTURE
     *  whitelisted vanno lì. Deciso dal cloud (interruttore in card, coi
     *  suoi cancelli), il client esegue e basta. */
    authority_enabled: boolean;
}

type RoutingChangeCallback = () => void;

// Stessa whitelist del nodo (sala-node/readCache.ts): un path fuori lista
// mandato al nodo riceverebbe 502 sala_node_no_route.
const ROUTABLE_EXACT = new Set([
    '/kds/queue',
    '/kds/expediter',
    '/kds/revisions',
    '/menu/catalogue',
    '/sala/config',
    '/kitchen/service-summary',
    '/bills/open',
    '/orders/open',
    '/sala/profiles',
]);
const ROUTABLE_PATTERNS = [
    /^\/orders\/\d+$/,
    /^\/tables\/\d+\/order$/,
];

const loadConfig = (): NodeConfig => {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '');
        if (typeof parsed?.enabled === 'boolean' && (parsed.node_url === null || typeof parsed.node_url === 'string')) {
            return { ...parsed, authority_enabled: parsed.authority_enabled === true };
        }
    } catch { /* config assente o corrotta: si parte spenti */ }
    return { enabled: false, node_url: null, authority_enabled: false };
};

let config: NodeConfig = loadConfig();
let circuitOpen = false;
let nextProbeAt = 0;
let probeInFlight = false;
const changeCallbacks = new Set<RoutingChangeCallback>();

/** Circuito chiuso (se era aperto): il nodo torna in gioco e il socket si
 *  riattacca in LAN via onRoutingChange. */
const closeCircuit = (): void => {
    if (!circuitOpen) return;
    circuitOpen = false;
    console.info('[sala-node] nodo di nuovo raggiungibile: si torna a instradare in LAN');
    notifyChange();
    notifyStatus();
};

/** Probe di salute in background: l'unica cosa che richiude il circuito.
 *  Fallisce → si riproverà fra 30s; il traffico vero intanto resta al cloud. */
const probeNode = (): void => {
    if (probeInFlight || !config.node_url) return;
    probeInFlight = true;
    nextProbeAt = Date.now() + PROBE_EVERY_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    fetch(`${config.node_url}/healthz`, { signal: controller.signal, cache: 'no-store' })
        .then(res => { if (res.ok) closeCircuit(); })
        .catch(() => { /* nodo ancora giù: nextProbeAt è già avanti */ })
        .finally(() => { clearTimeout(timer); probeInFlight = false; });
};

const nodeActive = (): boolean => {
    if (!config.enabled || !config.node_url) return false;
    if (!circuitOpen) return true;
    if (Date.now() >= nextProbeAt) probeNode();
    return false;
};

const isRoutablePath = (pathname: string): boolean =>
    ROUTABLE_EXACT.has(pathname) || ROUTABLE_PATTERNS.some(p => p.test(pathname));

/** URL per una GET del dominio sala: nodo se attivo e path instradabile,
 *  altrimenti cloud. `path` include l'eventuale querystring. */
export const routedGetUrl = (path: string): string => {
    const pathname = path.split('?')[0];
    if (nodeActive() && isRoutablePath(pathname)) {
        return `${config.node_url}${path}`;
    }
    return `${CLOUD_API_URL}${path}`;
};

// --- Le SCRITTURE del dominio sala (fase 4c) --------------------------------
// Con l'autorità sul nodo (interruttore 4b), le scritture whitelisted
// nascono LÌ — sempre, non solo offline: il percorso critico si esercita a
// ogni servizio. Tutto il resto (conti, cassa, prenotazioni, CRM) resta al
// cloud finché le fasi 5+ non li sdoppiano. Il fallback è lo stesso delle
// letture: nodo che non risponde → cloudFallbackUrl ritenta sul cloud e il
// circuito si apre — «il downgrade è il failover», e resta convergente
// perché anche la scrittura sul cloud riscende in replica.
// L'elenco vive in services/serviceWrites.ts: lo stesso che il cloud usa
// per il suo recinto (fase B1), così i due lati non possono divergere.
/** Riscrive un URL di SCRITTURA verso il nodo quando l'autorità è in sala.
 *  Chiamata in testa ai fetchWithAuth dei servizi: per le URL del cloud non
 *  whitelisted (o a autorità spenta) è un no-op puro. */
export const routeWriteUrl = (url: string, method?: string): string => {
    if (!config.authority_enabled || !nodeActive()) return url;
    if (!url.startsWith(CLOUD_API_URL)) return url;
    const rest = url.slice(CLOUD_API_URL.length);
    const pathname = rest.split('?')[0];
    return isServiceWrite(method || 'GET', pathname) ? `${config.node_url}${rest}` : url;
};

// --- Le LETTURE del dominio servizio con l'autorità in sala (fase B3) -----
// Conti, cassa e comande nascono sul nodo: chi li rilegge dal cloud vede
// una copia che arriva in replica qualche istante dopo (e, a linea giù, non
// arriva affatto). Con l'autorità in sala anche le letture di questi
// domini vanno al nodo. Il resto (CRM, report, fiscalità di back-office)
// resta al cloud.
const AUTHORITY_READS: RegExp[] = [
    /^\/bills(\/.*)?$/,
    /^\/cash(\/.*)?$/,
    /^\/tables\/\d+\/bill$/,
    /^\/reservations\/\d+\/bill$/,
    /^\/orders(\/.*)?$/,
    /^\/kds(\/.*)?$/,
    // Lo stato degli ordini nella comanda in cassa: lo tiene chi li scrive.
    /^\/passepartout\/comande-vive\/ordini$/,
    // Fase B4: quello che l'app carica all'avvio per la sala. A linea giù
    // un ricaricamento chiedeva tutto al cloud e apriva una pianta vuota,
    // col nodo acceso a due metri. Il nodo li ha tutti: pianta e menu dalla
    // sincronizzazione della configurazione, unioni e stati del giorno
    // perché nascono lì, prenotazioni dalla replica.
    /^\/tables$/,
    /^\/rooms$/,
    /^\/dishes$/,
    /^\/menus$/,
    /^\/banquet-menus$/,
    /^\/table-merges$/,
    /^\/table-hidden$/,
    /^\/room-closed$/,
    /^\/takeaway\/orders$/,
];

// Le prenotazioni solo a finestra: il nodo ne tiene 60 giorni (snapshot +
// replica), l'archivio resta una lettura del cloud.
const NODE_RESERVATIONS_DAYS = 55;
const isNodeReservationsWindow = (pathname: string, query: string): boolean => {
    if (pathname !== '/reservations') return false;
    const params = new URLSearchParams(query);
    const from = params.get('from');
    if (!from || params.has('to')) return false;
    const since = Date.parse(`${from}T00:00:00Z`);
    return Number.isFinite(since) && Date.now() - since <= NODE_RESERVATIONS_DAYS * 86_400_000;
};

/** Instradamento di una richiesta del dominio servizio: le scritture come
 *  routeWriteUrl, le letture dei conti, della cassa, delle comande e della
 *  sala al nodo quando l'autorità è in sala. No-op per tutto il resto. */
export const routeServiceUrl = (url: string, method?: string): string => {
    const m = (method || 'GET').toUpperCase();
    if (m !== 'GET' && m !== 'HEAD') return routeWriteUrl(url, m);
    if (!config.authority_enabled || !nodeActive()) return url;
    if (!url.startsWith(CLOUD_API_URL)) return url;
    const rest = url.slice(CLOUD_API_URL.length);
    const [pathname, query = ''] = rest.split('?');
    return AUTHORITY_READS.some(r => r.test(pathname)) || isNodeReservationsWindow(pathname, query)
        ? `${config.node_url}${rest}`
        : url;
};

/** Il cloud ha risposto che l'autorità è sul nodo: questo dispositivo non
 *  raggiunge il nodo (Wi-Fi caduto, telefono sul 4G, circuito aperto) e la
 *  battitura non è stata registrata da nessuna parte. */
export const isAuthorityOnNodeRefusal = (status: number, body: any): boolean =>
    status === 409 && body?.error === 'authority_on_node';

/** URL del socket: nodo se attivo, altrimenti cloud. */
export const serviceSocketUrl = (): string =>
    nodeActive() ? (config.node_url as string) : CLOUD_API_URL;

export const isNodeUrl = (url: string): boolean =>
    Boolean(config.node_url) && url.startsWith(config.node_url as string);

// A circuito aperto il probe parte anche da solo. Prima lo innescava solo
// una lettura instradata: con l'app ferma su una schermata senza polling il
// nodo poteva tornare e il dispositivo restare sul cloud — e la coda
// offline, che si svuota al riattacco del socket, restava piena (visto
// nella verifica della fase B4).
let probeTimer: ReturnType<typeof setInterval> | null = null;
const ensureProbeTimer = (): void => {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
        if (!circuitOpen || !config.enabled) {
            if (probeTimer) clearInterval(probeTimer);
            probeTimer = null;
            return;
        }
        if (Date.now() >= nextProbeAt) probeNode();
    }, 5_000);
};

/** Il nodo non ha risposto (errore di rete o timeout): circuito aperto,
 *  tutto al cloud finché un probe /healthz non lo richiude. */
export const noteNodeFailure = (): void => {
    if (circuitOpen) return;
    circuitOpen = true;
    nextProbeAt = Date.now() + PROBE_EVERY_MS;
    console.warn('[sala-node] nodo non raggiungibile: si torna al cloud (probe fra 30s)');
    ensureProbeTimer();
    notifyStatus();
};

/** Il socket si è appena collegato al nodo: è una prova di vita migliore
 *  del probe. Si richiude il circuito senza notifyChange — il socket è già
 *  dalla parte giusta, riattaccarlo sarebbe un giro a vuoto. */
export const noteNodeReachable = (): void => {
    if (!circuitOpen) return;
    circuitOpen = false;
    console.info('[sala-node] socket collegato al nodo: si torna a instradare in LAN');
    notifyStatus();
};

/** fetch con guinzaglio per gli URL del nodo: un nodo che inghiotte i
 *  pacchetti senza rispondere (PC in standby, firewall che droppa) non deve
 *  appendere lo schermo per il timeout TCP del sistema. Verso il cloud è un
 *  fetch qualunque. L'abort arriva nel catch del chiamante come un errore di
 *  rete → cloudFallbackUrl apre il circuito e dà l'URL gemello per il retry. */
export const fetchNodeAware = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const method = ((options.method as string) || 'GET').toUpperCase();
    const isRead = method === 'GET' || method === 'HEAD';
    // Guinzaglio: sempre verso il nodo; verso il cloud solo per le letture.
    if (!isNodeUrl(url) && !isRead) return fetch(url, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NODE_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        if (response.status === 401 && isNodeUrl(url)) void noteNodeUnauthorized(response.clone());
        return response;
    } finally {
        clearTimeout(timer);
    }
};

/** Il nodo ha rifiutato il token perché la proroga a linea giù è finita
 *  (fase A2): il refresh col cloud non può riuscire, e senza un avviso
 *  l'app sembrerebbe collegata con ogni azione che fallisce. Lo dice a
 *  chi ascolta (AuthContext) con un evento globale. */
const noteNodeUnauthorized = async (response: Response): Promise<void> => {
    try {
        const body = await response.json();
        if (body?.error === 'session_expired_offline') signalOfflineSessionExpired();
    } catch { /* corpo non JSON: un 401 qualunque */ }
};

export const signalOfflineSessionExpired = (): void => {
    window.dispatchEvent(new CustomEvent('sala-node:session-expired-offline'));
};

/** Da chiamare nel catch di un fetch: se l'URL era del nodo, segna il
 *  guasto e ritorna l'URL gemello sul cloud per il retry; altrimenti null
 *  (il guasto è di rete vera, non del nodo). */
export const cloudFallbackUrl = (url: string): string | null => {
    if (!isNodeUrl(url)) return null;
    noteNodeFailure();
    return `${CLOUD_API_URL}${url.slice((config.node_url as string).length)}`;
};

/** Da chiamare su ogni risposta di una GET instradata: propaga lo stato
 *  staleness agli schermi via evento globale — zero firme cambiate nei
 *  servizi. `X-Sala-Node: stale` = copia servita dal nodo a cloud giù. */
export const noteRoutedResponse = (url: string, response: Response): void => {
    if (!isNodeUrl(url)) return;
    const mark = response.headers.get('X-Sala-Node');
    if (mark === 'stale') {
        const age = Number(response.headers.get('X-Sala-Node-Age'));
        window.dispatchEvent(new CustomEvent('sala-node:stale', {
            detail: { ageSeconds: Number.isFinite(age) ? age : null },
        }));
    } else if (mark === 'proxy') {
        window.dispatchEvent(new CustomEvent('sala-node:fresh'));
    }
};

export const onRoutingChange = (cb: RoutingChangeCallback): (() => void) => {
    changeCallbacks.add(cb);
    return () => changeCallbacks.delete(cb);
};

const notifyChange = () => changeCallbacks.forEach(cb => cb());

export const isHybridActive = (): boolean => config.enabled && Boolean(config.node_url);

// --- Lo stato del nodo visto dal nodo (fase A3) ----------------------------
// GET /sala-node/local-status vive solo sul nodo e risponde in LAN anche a
// linea giù: uplink, ritardi nei due versi, battiture che il cloud non ha.
export interface SalaNodeLocalStatus {
    version: string;
    uplink_connected: boolean;
    uplink_down_since: string | null;
    lag_down_s: number | null;
    lag_up_s: number;
    pending_up: number;
}

const LOCAL_STATUS_TIMEOUT_MS = 3_000;

/** null = nodo non configurato, irraggiungibile o risposta inattesa. */
export const fetchNodeLocalStatus = async (): Promise<SalaNodeLocalStatus | null> => {
    if (!config.enabled || !config.node_url) return null;
    const token = authApiService.getAccessToken();
    if (!token) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_STATUS_TIMEOUT_MS);
    try {
        const res = await fetch(`${config.node_url}/sala-node/local-status`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
            cache: 'no-store',
        });
        if (!res.ok) return null;
        const body = await res.json();
        return typeof body?.uplink_connected === 'boolean' ? body as SalaNodeLocalStatus : null;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
};

/** Il nodo per l'accesso col PIN di sala (fase A2): solo con l'autorità in
 *  sala, perché una sessione del PIN vale solo sul nodo e le scritture
 *  devono andare lì. null = niente PIN su questo dispositivo. */
export const pinLoginNodeUrl = (): string | null =>
    config.enabled && config.authority_enabled && config.node_url ? config.node_url : null;

// --- Stato per la pastiglia Live --------------------------------------------
// Chi deve solo MOSTRARE da dove lavora il dispositivo (nodo, cloud o tutti e
// due) si abbona qui. Canale separato da onRoutingChange di proposito: quello
// riattacca il socket, e l'apertura del circuito non deve farlo — dopo due
// connect_error ci pensa già socketClient, e un secondo riaggancio in corsa
// da qui lo raddoppierebbe.
const statusCallbacks = new Set<RoutingChangeCallback>();
const notifyStatus = () => statusCallbacks.forEach(cb => cb());

export const onRoutingStatus = (cb: RoutingChangeCallback): (() => void) => {
    statusCallbacks.add(cb);
    return () => statusCallbacks.delete(cb);
};

/** Il nodo è in gioco su questo dispositivo: modalità accesa e circuito
 *  chiuso. Senza effetti collaterali, a differenza di nodeActive (che a
 *  circuito aperto lancia il probe). */
export const isNodeInUse = (): boolean => isHybridActive() && !circuitOpen;

/** Rilegge la config dal cloud (bootstrap e features:updated). Se la
 *  modalità si accende, un probe veloce su /healthz decide se partire dal
 *  nodo o col circuito già aperto — niente primo giro di fetch a vuoto. */
export const refreshNodeConfig = async (): Promise<void> => {
    const token = authApiService.getAccessToken();
    if (!token) return;
    let fresh: NodeConfig;
    try {
        // Timeout come il probe: a WAN staccata questa non deve appendere.
        const cfgController = new AbortController();
        const cfgTimer = setTimeout(() => cfgController.abort(), PROBE_TIMEOUT_MS);
        let res: Response;
        try {
            res = await fetch(`${CLOUD_API_URL}/sala-node/client-config`, {
                headers: { Authorization: `Bearer ${token}` },
                cache: 'no-store',
                signal: cfgController.signal,
            });
        } finally {
            clearTimeout(cfgTimer);
        }
        if (!res.ok) return; // il cloud ha risposto ma male: si tiene la config nota
        const body = await res.json();
        fresh = {
            enabled: body?.enabled === true,
            node_url: typeof body?.node_url === 'string' ? body.node_url.replace(/\/+$/, '') : null,
            authority_enabled: body?.authority_enabled === true,
        };
    } catch {
        return; // cloud irraggiungibile: la config persistita resta valida
    }
    const changed = fresh.enabled !== config.enabled || fresh.node_url !== config.node_url
        || fresh.authority_enabled !== config.authority_enabled;
    config = fresh;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* storage pieno */ }
    if (config.enabled && config.node_url) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            const health = await fetch(`${config.node_url}/healthz`, { signal: controller.signal, cache: 'no-store' });
            clearTimeout(timer);
            if (health.ok) closeCircuit(); else noteNodeFailure();
        } catch {
            noteNodeFailure();
        }
    }
    if (changed) notifyChange();
    notifyStatus();
};
