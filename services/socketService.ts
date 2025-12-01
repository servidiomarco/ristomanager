import { Server as SocketIOServer } from 'socket.io';
import { Server as HTTPServer } from 'http';
import type { Reservation, Table, Room, Dish, BanquetMenu } from '../types.js';

export class SocketService {
  private io: SocketIOServer;

  constructor(httpServer: HTTPServer) {
    this.io = new SocketIOServer(httpServer, {
      cors: {
        origin: [
          'http://localhost:5173',
          'https://ristomanager-production.up.railway.app',
          'https://ristomanager-phi.vercel.app'
        ],
        methods: ['GET', 'POST'],
        credentials: true
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 60000,
      pingInterval: 25000
    });

    this.setupEventHandlers();
  }

  private setupEventHandlers() {
    this.io.on('connection', (socket) => {
      console.log(`[${new Date().toISOString()}] Client connected: ${socket.id}`);

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

  // Reservation broadcast methods
  broadcastReservationCreated(reservation: Reservation) {
    this.io.emit('reservation:created', reservation);
    console.log(`Broadcasting reservation:created for ${reservation.customer_name}`);
  }

  broadcastReservationUpdated(reservation: Reservation) {
    this.io.emit('reservation:updated', reservation);
    console.log(`Broadcasting reservation:updated for ${reservation.customer_name}`);
  }

  broadcastReservationDeleted(id: number) {
    this.io.emit('reservation:deleted', id);
    console.log(`Broadcasting reservation:deleted for ID ${id}`);
  }

  // Table broadcast methods
  broadcastTableCreated(table: Table) {
    this.io.emit('table:created', table);
    console.log(`Broadcasting table:created for ${table.name}`);
  }

  broadcastTableUpdated(table: Table) {
    // Broadcast to all clients and to specific room
    this.io.emit('table:updated', table);
    this.io.to(`room:${table.room_id}`).emit('table:updated', table);
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

  // Get Socket.IO instance (for advanced usage if needed)
  getIO() {
    return this.io;
  }
}
