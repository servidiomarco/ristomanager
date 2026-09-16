// Socket.IO del nodo, lato LAN: i client (palmari, monitor cucina, passe) si
// collegano qui in modalità ibrida invece che al cloud, con lo STESSO
// contratto — auth JWT nel handshake, join automatici tenant/user/role,
// subscribe:station e subscribe:room. La semantica delle room DEVE combaciare
// con socketService.ts del cloud: i nomi che arrivano in relay:event sono
// composti là, e il nodo li rigioca senza interpretarli.

import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import { verifyClientToken, isOriginAllowed, type ClientTokenPayload } from './auth.js';

interface AuthedSocket extends Socket {
    user?: ClientTokenPayload;
}

interface Deps {
    tenantId(): number;
    jwtSecret(): string;
    allowedHostnames(): string[];
    nodeDomain(): string | null;
    cloudUp(): boolean;
}

export function createLocalSocket(httpServer: HTTPServer, deps: Deps): SocketIOServer {
    const io = new SocketIOServer(httpServer, {
        cors: {
            origin: (origin, callback) => {
                isOriginAllowed(origin, deps.allowedHostnames(), deps.nodeDomain())
                    ? callback(null, true)
                    : callback(new Error('Not allowed by CORS'));
            },
            methods: ['GET', 'POST'],
            credentials: true,
        },
        transports: ['websocket', 'polling'],
        pingTimeout: 60_000,
        pingInterval: 25_000,
    });

    io.use((socket: AuthedSocket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.query.token;
        if (!token) return next(new Error('Authentication required'));
        const payload = verifyClientToken(String(token), {
            secret: deps.jwtSecret(),
            tenantId: deps.tenantId(),
            cloudUp: deps.cloudUp(),
        });
        if (!payload) return next(new Error('Invalid or expired token'));
        socket.user = payload;
        next();
    });

    io.on('connection', (socket: AuthedSocket) => {
        const tenantId = socket.user!.tenantId;
        console.log(`[sala-node] client connesso: ${socket.id} (${socket.user?.email})`);

        // Join automatici identici al cloud. PLATFORM_ADMIN escluso per la
        // stessa ragione (sta sopra i tenant, non nella sala).
        if (String(socket.user!.role) !== 'PLATFORM_ADMIN') {
            socket.join(`tenant:${tenantId}`);
            socket.join(`tenant:${tenantId}:user:${socket.user!.userId}`);
            socket.join(`tenant:${tenantId}:role:${socket.user!.role}`);
        }

        socket.emit('connection:acknowledged', socket.id);

        socket.on('subscribe:room', (roomId: number) => {
            socket.join(`tenant:${tenantId}:room:${roomId}`);
        });
        socket.on('unsubscribe:room', (roomId: number) => {
            socket.leave(`tenant:${tenantId}:room:${roomId}`);
        });
        socket.on('subscribe:station', (stationId: number) => {
            socket.join(`tenant:${tenantId}:station:${stationId}`);
        });
        socket.on('unsubscribe:station', (stationId: number) => {
            socket.leave(`tenant:${tenantId}:station:${stationId}`);
        });

        socket.on('disconnect', () => {
            console.log(`[sala-node] client disconnesso: ${socket.id}`);
        });
    });

    return io;
}
