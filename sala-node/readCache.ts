// Proxy-with-cache delle letture del dominio sala.
//
// Il nodo NON è un'autorità (tappa 3): ogni GET viene inoltrato al cloud con
// il Bearer del client, e l'ultima risposta 200 resta in cache. A cloud
// irraggiungibile si serve la copia con `X-Sala-Node: stale` — ed è COERENTE,
// non solo "meglio di niente": durante l'outage anche le scritture falliscono
// o si accodano, quindi lo stato cloud è congelato all'istante della copia.
// La cache si scalda da sola col polling già esistente degli schermi (KDS
// 60s, passe 20s, pagamenti 30s): il nodo non ha credenziali utente proprie.
//
// REGOLA per la whitelist: solo endpoint la cui risposta NON varia per
// utente. Sono viste di servizio condivise (coda di cucina, passe, catalogo,
// conti aperti): la cache è per (path+query), un endpoint per-utente
// servirebbe a un cameriere la vista di un altro. Mai aggiungerne uno senza
// questa proprietà.

import type { IncomingMessage, ServerResponse } from 'node:http';

const WHITELIST_EXACT = new Set([
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
const WHITELIST_PATTERNS = [
    /^\/orders\/\d+$/,
    /^\/tables\/\d+\/order$/,
];

const MAX_ENTRIES = 500;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CLOUD_TIMEOUT_MS = 5_000;

interface CacheEntry {
    body: string;
    contentType: string;
    cachedAt: number;
}

export interface ReadCache {
    /** true se il path (senza query) è instradabile dal nodo. */
    isRoutable(path: string): boolean;
    handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
    invalidateAll(): void;
    stats(): { entries: number; oldestAgeSeconds: number | null };
}

interface Deps {
    cloudUrl: string;
    verifyBearer(authHeader: string | undefined): boolean;
    corsHeaders(origin: string | undefined): Record<string, string> | null;
}

export function createReadCache(deps: Deps): ReadCache {
    // Map come LRU: la delete+set a ogni hit riporta la chiave in coda,
    // l'eviction toglie dalla testa (l'entry meno usata di recente).
    const cache = new Map<string, CacheEntry>();

    const isRoutable = (path: string) =>
        WHITELIST_EXACT.has(path) || WHITELIST_PATTERNS.some(p => p.test(path));

    const send = (res: ServerResponse, status: number, headers: Record<string, string>, body: string) => {
        res.writeHead(status, headers);
        res.end(body);
    };

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://sala-node.local');
        const path = url.pathname;
        const origin = req.headers.origin as string | undefined;

        const cors = deps.corsHeaders(origin);
        if (cors == null) {
            return send(res, 403, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'origin_not_allowed' }));
        }
        if (req.method === 'OPTIONS') {
            return send(res, 204, cors, '');
        }
        if (req.method !== 'GET') {
            // Doppia cintura: il routing client manda al nodo solo GET della
            // whitelist; una scrittura arrivata qui è un bug da vedere.
            return send(res, 405, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'sala_node_read_only' }));
        }
        if (!isRoutable(path)) {
            return send(res, 502, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'sala_node_no_route' }));
        }
        // Mai un open proxy: senza un JWT valido la cache non risponde.
        if (!deps.verifyBearer(req.headers.authorization)) {
            return send(res, 401, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Unauthorized' }));
        }

        const key = `${path}${url.search}`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
        try {
            const upstream = await fetch(`${deps.cloudUrl}${key}`, {
                headers: {
                    authorization: req.headers.authorization as string,
                    accept: 'application/json',
                },
                signal: controller.signal,
            });
            const body = await upstream.text();
            const contentType = upstream.headers.get('content-type') || 'application/json';
            if (upstream.status === 200) {
                cache.delete(key);
                cache.set(key, { body, contentType, cachedAt: Date.now() });
                if (cache.size > MAX_ENTRIES) {
                    const oldest = cache.keys().next().value;
                    if (oldest !== undefined) cache.delete(oldest);
                }
            }
            // Risposta del cloud, buona o cattiva che sia: si passa com'è —
            // un 403/404 l'ha deciso il server, non è un problema di rete.
            return send(res, upstream.status, { ...cors, 'Content-Type': contentType, 'X-Sala-Node': 'proxy' }, body);
        } catch (_err) {
            // Errore DI RETE (timeout compreso): è il momento della cache.
            const entry = cache.get(key);
            if (entry && Date.now() - entry.cachedAt <= MAX_AGE_MS) {
                return send(res, 200, {
                    ...cors,
                    'Content-Type': entry.contentType,
                    'X-Sala-Node': 'stale',
                    'X-Sala-Node-Age': String(Math.round((Date.now() - entry.cachedAt) / 1000)),
                }, entry.body);
            }
            return send(res, 503, { ...cors, 'Content-Type': 'application/json' }, JSON.stringify({ error: 'cloud_unreachable' }));
        } finally {
            clearTimeout(timer);
        }
    };

    return {
        isRoutable,
        handle,
        invalidateAll() {
            // Al ritorno della linea la copia non è più "congelata": si
            // svuota, il prossimo poll degli schermi la ricostruisce fresca.
            cache.clear();
        },
        stats() {
            let oldest: number | null = null;
            for (const entry of cache.values()) {
                if (oldest == null || entry.cachedAt < oldest) oldest = entry.cachedAt;
            }
            return {
                entries: cache.size,
                oldestAgeSeconds: oldest != null ? Math.round((Date.now() - oldest) / 1000) : null,
            };
        },
    };
}
