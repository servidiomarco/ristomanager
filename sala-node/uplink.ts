// Uplink del nodo verso il cloud: connessione socket.io in uscita sul
// namespace /sala-node (salaNodeBridge lato server), come fa l'agente
// Passepartout — sul router del ristorante non si apre nulla.
//
// Sul canale viaggiano:
//   cloud → nodo  `relay:event { rooms, event, data, exclude_socket_id }` —
//                 lo specchio di ogni broadcast di dominio, da rigiocare
//                 identico ai client LAN.
//   nodo → cloud  `node:stats` ogni 15s — heartbeat + numeri per la card
//                 Impostazioni (client connessi, voci in cache).

import { io, type Socket } from 'socket.io-client';

export interface RelayEnvelope {
    rooms: string[];
    event: string;
    data: any;
    exclude_socket_id: string | null;
}

interface Deps {
    cloudUrl: string;
    token: string;
    onRelay(envelope: RelayEnvelope): void;
    /** Chiamata a OGNI aggancio riuscito dopo un buco (non al primo). */
    onReconnect(): void;
    getStats(): { clients: number; cache_entries: number; oldest_cache_age_s: number | null; version: string | null };
}

export interface Uplink {
    isCloudUp(): boolean;
    close(): void;
}

const STATS_INTERVAL_MS = 15_000;

export function createUplink(deps: Deps): Uplink {
    let connected = false;
    let everConnected = false;

    const socket: Socket = io(`${deps.cloudUrl}/sala-node`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
        timeout: 20_000,
        auth: { token: deps.token },
    });

    socket.on('connect', () => {
        connected = true;
        console.log('[sala-node] uplink connesso al cloud');
        if (everConnected) {
            // Riconnessione dopo un buco: lo stato in cache non è più
            // "congelato" e i client LAN potrebbero aver perso eventi.
            deps.onReconnect();
        }
        everConnected = true;
    });

    socket.on('disconnect', (reason) => {
        connected = false;
        console.log(`[sala-node] uplink disconnesso (${reason})`);
    });

    // Log del primo errore per serie, non di tutti: a cloud giù la
    // riconnessione tenta all'infinito e il log diventerebbe solo rumore.
    let lastErrorLogged = 0;
    socket.on('connect_error', (err) => {
        if (Date.now() - lastErrorLogged > 60_000) {
            lastErrorLogged = Date.now();
            console.warn('[sala-node] uplink connect_error:', err?.message || err);
        }
    });

    socket.on('relay:event', (envelope: any) => {
        if (!envelope || !Array.isArray(envelope.rooms) || typeof envelope.event !== 'string') return;
        deps.onRelay({
            rooms: envelope.rooms,
            event: envelope.event,
            data: envelope.data,
            exclude_socket_id: typeof envelope.exclude_socket_id === 'string' ? envelope.exclude_socket_id : null,
        });
    });

    const statsTimer = setInterval(() => {
        if (connected) socket.emit('node:stats', deps.getStats());
    }, STATS_INTERVAL_MS);
    statsTimer.unref?.();

    return {
        isCloudUp: () => connected,
        close() {
            clearInterval(statsTimer);
            socket.close();
        },
    };
}
