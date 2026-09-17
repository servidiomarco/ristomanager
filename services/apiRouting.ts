// Routing verso il nodo di sala (modalità ibrida, tappa 3).
//
// Quando la modalità è attiva, le SOLE letture del dominio sala (la stessa
// whitelist di sala-node/readCache.ts) e il socket passano dal nodo in LAN;
// tutto il resto — e TUTTE le scritture — resta sul cloud. Il principio del
// piano ibrido: «il downgrade è il failover» — qualunque dubbio sul nodo e
// si torna al cloud, senza chiedere niente a nessuno.
//
// Il circuito: un errore di rete verso il nodo apre il circuito per 30s
// (tutto al cloud), poi il primo GET instradabile riprova il nodo — se
// fallisce ancora, il circuito si riapre da solo. Niente timer, niente
// stato da ripulire.
//
// Config da GET /sala-node/client-config, persistita in localStorage così il
// boot non aspetta la rete (e durante un outage il reload — se la shell è in
// cache — riparte già puntato al nodo).

import { authApiService } from './authApiService';

export const CLOUD_API_URL = import.meta.env.VITE_API_URL || 'https://ristomanager-production.up.railway.app';

const STORAGE_KEY = 'sala_node_config_v1';
const CIRCUIT_OPEN_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;

interface NodeConfig {
    enabled: boolean;
    node_url: string | null;
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
            return parsed;
        }
    } catch { /* config assente o corrotta: si parte spenti */ }
    return { enabled: false, node_url: null };
};

let config: NodeConfig = loadConfig();
let circuitOpenUntil = 0;
const changeCallbacks = new Set<RoutingChangeCallback>();

const nodeActive = (): boolean =>
    config.enabled && Boolean(config.node_url) && Date.now() >= circuitOpenUntil;

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

/** URL del socket: nodo se attivo, altrimenti cloud. */
export const serviceSocketUrl = (): string =>
    nodeActive() ? (config.node_url as string) : CLOUD_API_URL;

export const isNodeUrl = (url: string): boolean =>
    Boolean(config.node_url) && url.startsWith(config.node_url as string);

/** Il nodo non ha risposto (errore di rete): circuito aperto per 30s. */
export const noteNodeFailure = (): void => {
    circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    console.warn('[sala-node] nodo non raggiungibile: si torna al cloud per 30s');
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

/** Rilegge la config dal cloud (bootstrap e features:updated). Se la
 *  modalità si accende, un probe veloce su /healthz decide se partire dal
 *  nodo o col circuito già aperto — niente primo giro di fetch a vuoto. */
export const refreshNodeConfig = async (): Promise<void> => {
    const token = authApiService.getAccessToken();
    if (!token) return;
    let fresh: NodeConfig;
    try {
        const res = await fetch(`${CLOUD_API_URL}/sala-node/client-config`, {
            headers: { Authorization: `Bearer ${token}` },
            cache: 'no-store',
        });
        if (!res.ok) return; // il cloud ha risposto ma male: si tiene la config nota
        const body = await res.json();
        fresh = {
            enabled: body?.enabled === true,
            node_url: typeof body?.node_url === 'string' ? body.node_url.replace(/\/+$/, '') : null,
        };
    } catch {
        return; // cloud irraggiungibile: la config persistita resta valida
    }
    const changed = fresh.enabled !== config.enabled || fresh.node_url !== config.node_url;
    config = fresh;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config)); } catch { /* storage pieno */ }
    if (config.enabled && config.node_url) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
            const health = await fetch(`${config.node_url}/healthz`, { signal: controller.signal, cache: 'no-store' });
            clearTimeout(timer);
            if (!health.ok) noteNodeFailure();
        } catch {
            noteNodeFailure();
        }
    }
    if (changed) notifyChange();
};
