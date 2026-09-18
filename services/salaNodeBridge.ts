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
import { startNodeUpstream } from './salaNodeUpstream.js';

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
    /** Ferma il consumatore dello stream inverso (fase 4a). */
    stopUpstream: () => void;
}

const nodesByTenant = new Map<number, NodeConnection>();

// Il token risolve il tenant via tenants.sala_node_token; il resolver vive in
// server.ts (resolveTenantByTokenColumn, con la sua cache TTL) e arriva
// iniettato dal setup per non creare un ciclo di import server ↔ services.
type TokenResolver = (token: string) => Promise<number | null>;
// Secondo cancello, sempre iniettato da server.ts: tenant attivo (non
// sospeso) E con l'add-on 'sala_node' venduto. Il token da solo non basta —
// il nodo di un cliente sospeso non deve restare agganciato al flusso eventi
// fino alla scadenza dei JWT, deve morire subito.
type TenantAuthorized = (tenantId: number) => Promise<boolean>;

export function setupSalaNodeBridge(io: SocketIOServer, resolveToken: TokenResolver, isAuthorized: TenantAuthorized) {
    const nsp = io.of('/sala-node');

    nsp.use((socket, next) => {
        const provided = String(socket.handshake.auth?.token || '');
        if (!provided) return next(new Error('Token nodo mancante'));
        resolveToken(provided)
            .then(async tenantId => {
                if (tenantId == null) return next(new Error('Token nodo non valido'));
                if (!(await isAuthorized(tenantId))) return next(new Error('Tenant sospeso o add-on non attivo'));
                (socket as any).salaNodeTenantId = tenantId;
                next();
            })
            .catch(() => next(new Error('Token nodo non verificabile')));
    });

    nsp.on('connection', (socket) => {
        const tenantId = Number((socket as any).salaNodeTenantId);
        const previous = nodesByTenant.get(tenantId);
        if (previous && previous.socket.id !== socket.id) {
            previous.stopUpstream();
            try { previous.socket.disconnect(true); } catch (_) {}
        }
        nodesByTenant.set(tenantId, {
            socket,
            connectedAt: new Date(),
            lastSeen: Date.now(),
            stats: null,
            // Lo stream inverso parte con l'aggancio: il cloud tira gli
            // eventi locali del nodo finché il socket vive (fase 4a).
            stopUpstream: startNodeUpstream(tenantId, socket),
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
                entry.stopUpstream();
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

/**
 * Stacca il nodo di un tenant, se collegato. Chiamata quando la sospensione
 * o lo spegnimento dell'add-on devono valere SUBITO (il middleware sopra
 * ferma solo le connessioni nuove). L'auto-reconnect del nodo ritenterà e
 * verrà rifiutato dal middleware finché il tenant non torna in regola.
 */
export function disconnectSalaNode(tenantId: number): void {
    const entry = nodesByTenant.get(tenantId);
    if (!entry) return;
    entry.stopUpstream();
    try { entry.socket.disconnect(true); } catch (_) {}
    nodesByTenant.delete(tenantId);
    console.log(`[sala-node] nodo del tenant ${tenantId} staccato (sospensione o add-on spento)`);
}

/** Chiede al nodo (se agganciato) lo stato della sua replica — i numeri
 *  dei cancelli dell'interruttore autorità (4b). null = nodo non
 *  raggiungibile o risposta malformata. */
export async function askNodeStatus(tenantId: number): Promise<{ applied_cloud_seq: number; local_head: number } | null> {
    const entry = nodesByTenant.get(tenantId);
    if (!entry || !entry.socket.connected) return null;
    try {
        const res: any = await entry.socket.timeout(5_000).emitWithAck('node:status', {});
        if (res?.error || !Number.isFinite(Number(res?.applied_cloud_seq)) || !Number.isFinite(Number(res?.local_head))) return null;
        return { applied_cloud_seq: Number(res.applied_cloud_seq), local_head: Number(res.local_head) };
    } catch {
        return null;
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
