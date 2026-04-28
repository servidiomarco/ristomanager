import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HTTPServer } from 'http';
import type { Reservation, Table, Room, Dish, BanquetMenu, UserRole } from '../types.js';
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

      // Attach user data to socket
      socket.user = payload;
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

  // Room broadcast methods
  broadcastRoomCreated(room: Room) {
    this.io.emit('room:created', room);
    console.log(`Broadcasting room:created for ${room.name}`);
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
  broadcastToAll(event: string, data: any, excludeSocketId?: string) {
    if (excludeSocketId) {
      this.io.except(excludeSocketId).emit(event, data);
    } else {
      this.io.emit(event, data);
    }
    console.log(`Broadcasting ${event}`);
  }

  // Get Socket.IO instance (for advanced usage if needed)
  getIO() {
    return this.io;
  }
}
