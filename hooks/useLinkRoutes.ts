// Da dove lavora il dispositivo, per la pastiglia Live: nodo di sala, cloud o
// tutti e due. Serve solo dove la modalità ibrida è accesa — senza nodo la
// pastiglia resta com'era.
//
// Il nodo è «in gioco» quando la modalità è accesa e il circuito è chiuso
// (apiRouting). Il cloud, invece, a socket sul nodo non si vede dal socket:
// lo dice una sonda leggera su /healthz del cloud, ogni 30s e solo finché il
// nodo è in gioco, più i segnali che arrivano gratis — X-Sala-Node stale/
// fresh sulle letture instradate e online/offline del browser. Lo stato vive
// nel modulo e non nel componente: la testata monta due pastiglie insieme
// (quella desktop e il pallino del telefono, una delle due nascosta dal CSS)
// e Comande una terza, e le sonde non devono moltiplicarsi.

import { useSyncExternalStore } from 'react';
import { CLOUD_API_URL, isHybridActive, isNodeInUse, onRoutingStatus } from '../services/apiRouting';

const CLOUD_PROBE_EVERY_MS = 30_000;
// Come il CLOUD_TIMEOUT_MS del nodo: a WAN staccata la sonda non deve restare
// appesa al timeout TCP di sistema.
const CLOUD_PROBE_TIMEOUT_MS = 5_000;

interface Snapshot {
    hybrid: boolean;
    nodeInUse: boolean;
    /** Esito dell'ultima sonda (o dell'ultimo segnale) verso il cloud. */
    cloudOk: boolean;
}

const initialOnline = (): boolean =>
    typeof navigator === 'undefined' || navigator.onLine !== false;

let snapshot: Snapshot = { hybrid: false, nodeInUse: false, cloudOk: initialOnline() };
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;
let probeTimer: ReturnType<typeof setInterval> | null = null;
let probeInFlight = false;

const setSnapshot = (next: Partial<Snapshot>): void => {
    const merged = { ...snapshot, ...next };
    if (merged.hybrid === snapshot.hybrid && merged.nodeInUse === snapshot.nodeInUse
        && merged.cloudOk === snapshot.cloudOk) return;
    snapshot = merged;
    listeners.forEach(l => l());
};

const probeCloud = (): void => {
    if (probeInFlight) return;
    probeInFlight = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLOUD_PROBE_TIMEOUT_MS);
    fetch(`${CLOUD_API_URL}/healthz`, { signal: controller.signal, cache: 'no-store' })
        .then(res => setSnapshot({ cloudOk: res.ok }))
        .catch(() => setSnapshot({ cloudOk: false }))
        .finally(() => { clearTimeout(timer); probeInFlight = false; });
};

/** La sonda gira solo col nodo in gioco: a socket sul cloud lo stato del
 *  cloud è il socket stesso, e una richiesta in più ogni 30s non serve. */
const syncProbe = (): void => {
    if (snapshot.nodeInUse && !probeTimer) {
        probeCloud();
        probeTimer = setInterval(probeCloud, CLOUD_PROBE_EVERY_MS);
    } else if (!snapshot.nodeInUse && probeTimer) {
        clearInterval(probeTimer);
        probeTimer = null;
    }
};

const readRouting = (): void => {
    setSnapshot({ hybrid: isHybridActive(), nodeInUse: isNodeInUse() });
    syncProbe();
};

const startWatching = (): (() => void) => {
    const onStale = () => setSnapshot({ cloudOk: false });
    const onFresh = () => setSnapshot({ cloudOk: true });
    const onOffline = () => setSnapshot({ cloudOk: false });
    const onOnline = () => { if (snapshot.nodeInUse) probeCloud(); else setSnapshot({ cloudOk: true }); };
    window.addEventListener('sala-node:stale', onStale);
    window.addEventListener('sala-node:fresh', onFresh);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    const unsubRouting = onRoutingStatus(readRouting);
    readRouting();
    return () => {
        window.removeEventListener('sala-node:stale', onStale);
        window.removeEventListener('sala-node:fresh', onFresh);
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('online', onOnline);
        unsubRouting();
        if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    };
};

const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (!stopWatching) stopWatching = startWatching();
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopWatching) {
            stopWatching();
            stopWatching = null;
        }
    };
};

const getSnapshot = (): Snapshot => snapshot;

export interface LinkRoutes {
    /** Il dispositivo lavora col nodo di sala. */
    node: boolean;
    /** Il dispositivo raggiunge il cloud. */
    cloud: boolean;
}

/** `connected` è lo stato del socket (useSocket): a nodo in gioco il socket è
 *  attaccato al nodo e dice del nodo, altrimenti è attaccato al cloud e dice
 *  del cloud. Null = modalità ibrida spenta, niente da mostrare. */
export function useLinkRoutes(connected: boolean): LinkRoutes | null {
    const s = useSyncExternalStore(subscribe, getSnapshot);
    if (!s.hybrid) return null;
    if (!s.nodeInUse) return { node: false, cloud: connected };
    return { node: connected, cloud: s.cloudOk };
}
