// Ponte fra il backend (Railway) e il nodo di sala del ristorante — tappa 3
// del piano ibrido (docs/brainstorming-installazione-ibrida.md nel repo
// marketing): il nodo è un relay Socket.IO + cache di lettura sulla LAN, così
// palmari e monitor di cucina restano vivi anche a linea caduta.
//
// Come per l'agente Passepartout, il nodo apre LUI la connessione in uscita
// verso questo server, sul namespace dedicato `/sala-node`, autenticandosi
// con il token per-tenant (tenants.sala_node_token). Il namespace è separato
// dal default "/" di proposito: il middleware JWT degli utenti resta intatto
// e il socket del nodo non entra nelle room dei tenant.
//
// Il cloud SPECCHIA qui ogni broadcast di dominio (vedi emitTo in
// socketService.ts): l'envelope `relay:event` porta i nomi-room già composti
// (`tenant:1`, `tenant:1:station:3`, …) e il nodo li riusa identici verso i
// propri client LAN — il filtro per destinatario è implicito nei nomi, il
// nodo non deve conoscere la semantica degli eventi. Quando la tappa 4
// sostituirà il mirror col pull-con-cursore su outbox_events, il canale
// resterà questo.
//
// Un solo nodo per tenant: una nuova connessione valida scalza la precedente
// (riavvio del nodo = riconnessione pulita, stesso contratto del pp-agent).

import type { Server as SocketIOServer, Socket } from 'socket.io';

interface NodeStats {
    clients: number;
    cache_entries: number;
    oldest_cache_age_s: number | null;
    version: string | null;
}

interface NodeConnection {
    socket: Socket;
    connectedAt: Date;
    lastSeen: number;
    stats: NodeStats | null;
}

const nodesByTenant = new Map<number, NodeConnection>();

// Il token risolve il tenant via tenants.sala_node_token; il resolver vive in
// server.ts (resolveTenantByTokenColumn, con la sua cache TTL) e arriva
// iniettato dal setup per non creare un ciclo di import server ↔ services.
type TokenResolver = (token: string) => Promise<number | null>;

export function setupSalaNodeBridge(io: SocketIOServer, resolveToken: TokenResolver) {
    const nsp = io.of('/sala-node');

    nsp.use((socket, next) => {
        const provided = String(socket.handshake.auth?.token || '');
        if (!provided) return next(new Error('Token nodo mancante'));
        resolveToken(provided)
            .then(tenantId => {
                if (tenantId == null) return next(new Error('Token nodo non valido'));
                (socket as any).salaNodeTenantId = tenantId;
                next();
            })
            .catch(() => next(new Error('Token nodo non verificabile')));
    });

    nsp.on('connection', (socket) => {
        const tenantId = Number((socket as any).salaNodeTenantId);
        const previous = nodesByTenant.get(tenantId);
        if (previous && previous.socket.id !== socket.id) {
            try { previous.socket.disconnect(true); } catch (_) {}
        }
        nodesByTenant.set(tenantId, {
            socket,
            connectedAt: new Date(),
            lastSeen: Date.now(),
            stats: null,
        });
        console.log(`[sala-node] nodo connesso per tenant ${tenantId}: ${socket.id}`);

        socket.on('node:stats', (stats: any) => {
            const entry = nodesByTenant.get(tenantId);
            if (!entry || entry.socket.id !== socket.id) return;
            entry.lastSeen = Date.now();
            entry.stats = {
                clients: Number(stats?.clients) || 0,
                cache_entries: Number(stats?.cache_entries) || 0,
                oldest_cache_age_s: Number.isFinite(Number(stats?.oldest_cache_age_s)) ? Number(stats.oldest_cache_age_s) : null,
                version: typeof stats?.version === 'string' ? stats.version : null,
            };
        });

        socket.on('disconnect', (reason) => {
            const entry = nodesByTenant.get(tenantId);
            if (entry?.socket.id === socket.id) {
                nodesByTenant.delete(tenantId);
            }
            console.log(`[sala-node] nodo disconnesso per tenant ${tenantId} (${reason})`);
        });
    });
}

/**
 * Specchia un broadcast di dominio sul nodo del tenant, se collegato.
 * Chiamata da socketService.emitTo per OGNI emissione: deve essere a prova di
 * eccezione e a costo ~zero quando il nodo non c'è (il caso normale per i
 * tenant senza add-on).
 */
export function mirrorToSalaNode(
    tenantId: number,
    rooms: string[],
    event: string,
    data: any,
    excludeSocketId?: string,
) {
    const entry = nodesByTenant.get(tenantId);
    if (!entry) return;
    try {
        entry.socket.emit('relay:event', {
            rooms,
            event,
            data,
            // L'esclusione del mittente vale solo per i socket collegati al
            // cloud; un client in LAN ha un id diverso e riceve comunque.
            // Si inoltra lo stesso per completezza dell'envelope.
            exclude_socket_id: excludeSocketId ?? null,
            ts: Date.now(),
        });
    } catch (err) {
        console.error('[sala-node] mirror fallito:', (err as any)?.message || err);
    }
}

const NODE_ONLINE_WINDOW_MS = 30_000;

export function getSalaNodeStatus(tenantId: number) {
    const entry = nodesByTenant.get(tenantId);
    if (!entry) {
        return { online: false, last_seen_seconds: null as number | null, connected_at: null as string | null, clients: null as number | null, cache_entries: null as number | null };
    }
    return {
        online: Date.now() - entry.lastSeen < NODE_ONLINE_WINDOW_MS,
        last_seen_seconds: Math.round((Date.now() - entry.lastSeen) / 1000),
        connected_at: entry.connectedAt.toISOString(),
        clients: entry.stats?.clients ?? null,
        cache_entries: entry.stats?.cache_entries ?? null,
    };
}
