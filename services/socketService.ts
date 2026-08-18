import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import type { Reservation, Table, Room, Dish, BanquetMenu, UserRole, TableMerge, TableHiddenOverride, RoomClosedOverride } from '../types.js';
import { AuthService, TokenPayload } from '../auth/authService.js';

// Extended socket type with user data
interface AuthenticatedSocket extends Socket {
  user?: TokenPayload;
}

export class SocketService {
  private io: SocketIOServer;

  constructor(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: (origin, callback) => {
          // Allow requests with no origin (mobile apps, Postman, etc.)
          if (!origin) return callback(null, true);

          // Allow localhost for development
          if (origin.includes('localhost')) return callback(null, true);

          // Allow all Vercel deployment URLs
          if (origin.includes('vercel.app')) return callback(null, true);

          // Allow Railway URLs
          if (origin.includes('railway.app')) return callback(null, true);

          // Allow custom production domain
          if (origin.includes('crm.vecchiofrantoio.com')) return callback(null, true);

          // Reject other origins
          callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupAuthMiddleware();
    this.setupEventHandlers();
  }

  private setupAuthMiddleware() {
    // Socket.IO authentication middleware
    this.io.use((socket: AuthenticatedSocket, next) => {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (!token) {
        return next(new Error('Authentication required'));
      }

      const payload = AuthService.verifyAccessToken(token as string);
      if (!payload) {
        return next(new Error('Invalid or expired token'));
      }

      // Attach user data to socket. Il tenant serve alla Fase B5 (room
      // per tenant); i token pre-B2 non hanno il claim → fallback 1.
      socket.user = {
        ...payload,
        tenantId: Number.isInteger(payload.tenantId) && payload.tenantId > 0 ? payload.tenantId : 1,
      };
      next();
    });
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket: AuthenticatedSocket) => {
      console.log(`[${new Date().toISOString()}] Client connected: ${socket.id} (User: ${socket.user?.email}, Role: ${socket.user?.role})`);

      socket.emit('connection:acknowledged', socket.id);

      // Room subscription for room-specific updates
      socket.on('subscribe:room', (roomId: number) => {
        socket.join(`room:${roomId}`);
        console.log(`[${socket.id}] Subscribed to room:${roomId}`);
      });

      socket.on('unsubscribe:room', (roomId: number) => {
        socket.leave(`room:${roomId}`);
        console.log(`[${socket.id}] Unsubscribed from room:${roomId}`);
      });

      // Monitor di cucina: ogni schermo ascolta solo la propria partita.
      // Con tre partite non è un'ottimizzazione ma una necessità — la
      // Griglia non deve ricevere il traffico degli Antipasti, altrimenti
      // il monitor diventa illeggibile proprio nel picco del servizio.
      socket.on('subscribe:station', (stationId: number) => {
        socket.join(`station:${stationId}`);
        console.log(`[${socket.id}] Subscribed to station:${stationId}`);
      });

      socket.on('unsubscribe:station', (stationId: number) => {
        socket.leave(`station:${stationId}`);
        console.log(`[${socket.id}] Unsubscribed from station:${stationId}`);
      });

      socket.on('disconnect', () => {
        console.log(`[${new Date().toISOString()}] Client disconnected: ${socket.id}`);
      });
    });
  }

  // Reservation broadcast methods - emit to ALL clients (duplicate prevention on client side)
  broadcastReservationCreated(reservation: Reservation, _excludeSocketId?: string) {
    this.io.emit('reservation:created', reservation);
    console.log(`Broadcasting reservation:created for ${reservation.customer_name}`);
  }

  broadcastReservationUpdated(reservation: Reservation, _excludeSocketId?: string) {
    this.io.emit('reservation:updated', reservation);
    console.log(`Broadcasting reservation:updated for ${reservation.customer_name}`);
  }

  broadcastReservationDeleted(id: number, _excludeSocketId?: string) {
    this.io.emit('reservation:deleted', id);
    console.log(`Broadcasting reservation:deleted for ID ${id}`);
  }

  // Silent variant: patch the reservation in clients' state WITHOUT a toast or
  // notification. Used when a non-reservation action denormalizes onto the
  // reservation row (e.g. a customer rename cascades customer_name) — the user
  // did that edit elsewhere and shouldn't get "Prenotazione aggiornata" spam,
  // one per affected booking.
  broadcastReservationSynced(reservation: Reservation) {
    this.io.emit('reservation:synced', reservation);
  }

  // Table broadcast methods
  broadcastTableCreated(table: Table, excludeSocketId?: string) {
    // Broadcast to all clients except the originating socket
    if (excludeSocketId) {
      this.io.except(excludeSocketId).emit('table:created', table);
    } else {
      this.io.emit('table:created', table);
    }
    console.log(`Broadcasting table:created for ${table.name}`);
  }

  broadcastTableUpdated(table: Table, excludeSocketId?: string) {
    // Broadcast to all clients except the originating socket
    if (excludeSocketId) {
      this.io.except(excludeSocketId).emit('table:updated', table);
      this.io.to(`room:${table.room_id}`).except(excludeSocketId).emit('table:updated', table);
    } else {
      this.io.emit('table:updated', table);
      this.io.to(`room:${table.room_id}`).emit('table:updated', table);
    }
    console.log(`Broadcasting table:updated for ${table.name}`);
  }

  broadcastTableDeleted(id: number) {
    this.io.emit('table:deleted', id);
    console.log(`Broadcasting table:deleted for ID ${id}`);
  }

  // Per-shift table merge events
  broadcastTableMergeCreated(merge: TableMerge, excludeSocketId?: string) {
    if (excludeSocketId) {
      this.io.except(excludeSocketId).emit('tableMerge:created', merge);
    } else {
      this.io.emit('tableMerge:created', merge);
    }
    console.log(`Broadcasting tableMerge:created for ${merge.date} ${merge.shift} primary=${merge.primary_id}`);
  }

  broadcastTableMergeDeleted(merge: TableMerge, excludeSocketId?: string) {
    if (excludeSocketId) {
      this.io.except(excludeSocketId).emit('tableMerge:deleted', merge);
    } else {
      this.io.emit('tableMerge:deleted', merge);
    }
    console.log(`Broadcasting tableMerge:deleted for ${merge.date} ${merge.shift} primary=${merge.primary_id}`);
  }

  // Per-shift hidden table events
  broadcastTableHiddenCreated(hidden: TableHiddenOverride) {
    this.io.emit('tableHidden:created', hidden);
    console.log(`Broadcasting tableHidden:created for ${hidden.date} ${hidden.shift} table=${hidden.table_id}`);
  }

  broadcastTableHiddenDeleted(hidden: TableHiddenOverride) {
    this.io.emit('tableHidden:deleted', hidden);
    console.log(`Broadcasting tableHidden:deleted for ${hidden.date} ${hidden.shift} table=${hidden.table_id}`);
  }

  // Per-shift room closure events
  broadcastRoomClosedCreated(closed: RoomClosedOverride) {
    this.io.emit('roomClosed:created', closed);
    console.log(`Broadcasting roomClosed:created for ${closed.date} ${closed.shift} room=${closed.room_id}`);
  }

  broadcastRoomClosedDeleted(closed: RoomClosedOverride) {
    this.io.emit('roomClosed:deleted', closed);
    console.log(`Broadcasting roomClosed:deleted for ${closed.date} ${closed.shift} room=${closed.room_id}`);
  }

  // Room broadcast methods
  broadcastRoomCreated(room: Room) {
    this.io.emit('room:created', room);
    console.log(`Broadcasting room:created for ${room.name}`);
  }

  broadcastRoomUpdated(room: Room) {
    this.io.emit('room:updated', room);
    console.log(`Broadcasting room:updated for ${room.name}`);
  }

  broadcastRoomDeleted(id: number) {
    this.io.emit('room:deleted', id);
    console.log(`Broadcasting room:deleted for ID ${id}`);
  }

  // Dish broadcast methods
  broadcastDishCreated(dish: Dish) {
    this.io.emit('dish:created', dish);
    console.log(`Broadcasting dish:created for ${dish.name}`);
  }

  broadcastDishUpdated(dish: Dish) {
    this.io.emit('dish:updated', dish);
    console.log(`Broadcasting dish:updated for ${dish.name}`);
  }

  broadcastDishDeleted(id: number) {
    this.io.emit('dish:deleted', id);
    console.log(`Broadcasting dish:deleted for ID ${id}`);
  }

  // Banquet Menu broadcast methods
  broadcastBanquetCreated(menu: BanquetMenu) {
    this.io.emit('banquet:created', menu);
    console.log(`Broadcasting banquet:created for ${menu.name}`);
  }

  broadcastBanquetUpdated(menu: BanquetMenu) {
    this.io.emit('banquet:updated', menu);
    console.log(`Broadcasting banquet:updated for ${menu.name}`);
  }

  broadcastBanquetDeleted(id: number) {
    this.io.emit('banquet:deleted', id);
    console.log(`Broadcasting banquet:deleted for ID ${id}`);
  }

  // Generic broadcast method for any event type
  // Emette alla sola partita indicata. Il passe (PR 5) si iscriverà a tutte.
  broadcastToStation(stationId: number | null, event: string, data: any) {
    // Le righe senza partita assegnata finiscono nel canale generico invece
    // di sparire: un piatto non ancora configurato resta visibile a qualcuno.
    const room = stationId == null ? 'station:none' : `station:${stationId}`;
    this.io.to(room).emit(event, data);
  }

  broadcastToAll(event: string, data: any, excludeSocketId?: string) {
    const connectedSockets = this.io.sockets.sockets.size;
    console.log(`📡 broadcastToAll: ${event} to ${connectedSockets} connected clients (excluding: ${excludeSocketId || 'none'})`);

    // TEMPORARY: Always emit to ALL clients to debug sync issues
    // The client already handles duplicates, so this is safe
    this.io.emit(event, data);

    console.log(`📡 Broadcast ${event} sent to all`);
  }

  // Get Socket.IO instance (for advanced usage if needed)
  getIO() {
    return this.io;
  }
}
